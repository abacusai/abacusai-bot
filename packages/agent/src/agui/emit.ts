/**
 * `AguiEmitter`: a pure, synchronous translator from the legacy
 * `DesktopEvent` stream (plus the internal facts sessions report through
 * `emitInternal`) to AG-UI events (spec §3.3).
 *
 * It never reads pi and never writes anything itself: `accept` returns the
 * events to write, and the RunController owns RUN_STARTED and the terminals.
 * Run-scoped input that arrives while no run is open (a superseded pi turn
 * after Stop, a bot housekeeping turn) changes nothing, so no bookkeeping
 * leaks into the next run.
 */
import { EventType } from "@ag-ui/core";

import { eventMeta } from "../event-meta.js";
import type { InternalAgentEvent } from "../internal-events.js";
import type {
  AgentEvent,
  DesktopEvent,
  PermissionRequest,
  ToolDisplayData,
} from "../protocol.js";
import { BoundedMap, BoundedSet, MESSAGE_IDS_KEPT } from "./bounded.js";
import { aguiEvent, custom } from "./event.js";
import {
  childMessageId,
  childToolCallId,
  reasoningMessageId,
  resultMessageId,
  steerMessageId,
  nativeId,
  toolKey,
  userMessageId,
} from "./ids.js";
import {
  attachToolCall,
  toDescriptor,
  type PendingPermission,
  type RunningCall,
} from "./permissions.js";
import type { RunController } from "./runs.js";
import { formatToolContent } from "./vendor/pi-acp/tool-content.js";
import type {
  AgentErrorPayload,
  AgentState,
  AguiEvent,
  PermissionDescriptor,
  ToolCallEndMeta,
  ToolCallResultMeta,
  ToolCallStartMeta,
  ToolResultContent,
} from "./wire.js";

export interface EmitterContext {
  threadId: string;
  incarnation: string;
  runs: RunController;
  /** The approval budget in ms (Infinity when there is none). */
  approvalTimeoutMs: () => number;
  now: () => number;
  /** stderr, for what the spec logs rather than emits. */
  log: (line: string) => void;
}

type BlockCause = "rejected" | "refused" | "expired" | "stopped";

interface ToolState {
  aguiId: string;
  legacyId: string;
  subagentRunId?: string;
  name: string;
  rawName: string;
  parentMessageId?: string;
  started: boolean;
  argsSent: boolean;
  ended: boolean;
  resulted: boolean;
  executing: boolean;
  input: Record<string, unknown>;
  display?: ToolDisplayData;
  output?: string;
  blocked?: BlockCause;
  order: number;
}

interface ChildState {
  id: string;
  parentSubagentRunId?: string;
  /** The AG-UI id of the child's open text message. */
  openMessageId?: string;
  /** The child's final text, for SUBAGENT_FINISHED.result. */
  finalText: string;
}

/** Reasoning block open inside an assistant message. */
interface OpenReasoning {
  id: string;
}

const REASONING_ROLE = "reasoning" as const;

export class AguiEmitter {
  // ------------------------------------------------------------ message state
  /** The parent's open assistant message. */
  private assistant: { key: string | undefined; id: string } | null = null;
  /** The last assistant message id, for tool calls announced after it closed. */
  private lastAssistantId: string | undefined;
  /** Legacy `msg-N` → AG-UI id, from `message_open`. Bounded (bounded.ts). */
  private readonly messageIds = new BoundedMap<string, string>(
    MESSAGE_IDS_KEPT
  );
  /** AG-UI message ids handed out, the newest `MESSAGE_IDS_KEPT`. */
  private readonly usedMessageIds = new BoundedSet<string>(MESSAGE_IDS_KEPT);
  private reasoning: OpenReasoning | null = null;
  private reasoningCount = 0;
  /** The open run has had a parent assistant message (see `errorAnchor`). */
  private runHadAssistant = false;
  private fallbackCount = 0;
  private steerCount = 0;

  // -------------------------------------------------------------- tool state
  private readonly tools = new Map<string, ToolState>();
  private toolOrder = 0;
  private readonly children = new Map<string, ChildState>();

  // ------------------------------------------------------------ session state
  private hiddenDepth = 0;
  /** The customType of each open hidden turn, innermost last (for the usage log). */
  private readonly hiddenTypes: string[] = [];
  /** No STATE_DELTA before the first snapshot: pre-ready changes fold into it. */
  private snapshotted = false;
  private readonly state: AgentState;
  private readonly pending = new Map<string, PendingPermission>();
  /** Why the next `permission_cleared` happens; set by the host around stop/reset. */
  private clearReason: "expired" | "stopped" | "reset" = "expired";
  /** Gate permission → the tool it blocks, for the result's outcome. */
  private readonly permissionTool = new Map<string, string>();

  constructor(private readonly ctx: EmitterContext) {
    this.state = {
      mode: "DEFAULT" as AgentState["mode"],
      modeSource: "startup",
      model: "",
      incarnation: ctx.incarnation,
    };
  }

  // ----------------------------------------------------------------- queries

  pendingPermissions(): ReadonlyMap<string, PendingPermission> {
    return this.pending;
  }

  pendingItems(): PermissionDescriptor[] {
    return [...this.pending.values()].map((entry) => entry.descriptor);
  }

  agentState(): AgentState {
    return this.state;
  }

  model(): string {
    return this.state.model;
  }

  isHidden(): boolean {
    return this.hiddenDepth > 0;
  }

  /**
   * A run opened. No hidden turn can be in progress now: housekeeping runs
   * inside `send()` with admission held, so a run opens only after it ended
   * or was aborted. An aborted one's closing bracket can land after the new
   * RUN_STARTED; forgetting the depth here keeps it from hiding that run.
   */
  runOpened(): void {
    this.hiddenDepth = 0;
    this.hiddenTypes.length = 0;
    this.runHadAssistant = false;
  }

  /**
   * Before a `RUN_ERROR`: an empty assistant message for a run that opened
   * none. A receive-only `StreamProcessor` (main's transcript, the chat kit's
   * client) meets a `RUN_ERROR` with no assistant message by creating one and
   * marking it pending, and then renames it to the next `TEXT_MESSAGE_START`
   * it sees: the next run's user echo, which becomes an assistant message.
   * With an assistant message of the run's own, nothing is pending.
   */
  errorAnchor(runId: string): AguiEvent[] {
    if (this.runHadAssistant) return [];
    this.runHadAssistant = true;
    const id = this.uniqueMessageId(nativeId(`${runId}:error`));

    return [
      aguiEvent(EventType.TEXT_MESSAGE_START, {
        messageId: id,
        role: "assistant",
      }),
      aguiEvent(EventType.TEXT_MESSAGE_END, { messageId: id }),
    ];
  }

  /** Set by the host before `session.stop()` / `resetConversation()`. */
  setClearReason(reason: "expired" | "stopped" | "reset"): void {
    this.clearReason = reason;
  }

  // ------------------------------------------------------------------ inputs

  accept(event: DesktopEvent): AguiEvent[] {
    switch (event.type) {
      case "ready": {
        this.state.model = event.model;
        this.state.mode = event.mode as AgentState["mode"];
        if (event.agentSessionId != null) {
          this.state.agentSessionId = event.agentSessionId;
        } else {
          delete this.state.agentSessionId;
        }
        if (event.agentSessionFile != null) {
          this.state.agentSessionFile = event.agentSessionFile;
        } else {
          delete this.state.agentSessionFile;
        }

        return [
          custom("session.ready", {
            model: event.model,
            mode: event.mode,
            ...(event.agentSessionId != null
              ? { agentSessionId: event.agentSessionId }
              : {}),
            ...(event.agentSessionFile != null
              ? { agentSessionFile: event.agentSessionFile }
              : {}),
            incarnation: this.ctx.incarnation,
          }),
          this.snapshot(),
        ];
      }

      case "event":
        return this.agentEvent(event.event);

      case "heartbeat":
        return this.hiddenDepth > 0
          ? []
          : [custom("agent.heartbeat", { runningTools: event.runningTools })];

      case "host_service_request":
        // Host services stay on compat (§3.7).
        return [];

      case "permission_needed":
        return this.permissionNeeded(event.permissionId, event.request);

      case "skills_loaded":
        return [custom("skills.loaded", { skills: event.skills })];

      case "queue_updated":
        return [
          custom("queue.updated", {
            messages: event.messages,
            dequeued: event.dequeued ?? null,
          }),
        ];

      case "mcp_servers":
        return [custom("mcp.servers", { servers: event.servers })];

      case "mcp_server_logs":
        return [
          custom("mcp.server_logs", {
            serverId: event.serverId,
            entries: event.entries,
          }),
        ];

      default:
        // Declared, never produced (§3.3.9): compat only.
        return [];
    }
  }

  acceptInternal(event: InternalAgentEvent): AguiEvent[] {
    if (event.type === "hidden_turn") {
      this.hiddenDepth = Math.max(
        0,
        this.hiddenDepth + (event.phase === "start" ? 1 : -1)
      );
      if (event.phase === "start") this.hiddenTypes.push(event.customType);
      else this.hiddenTypes.pop();

      return [];
    }

    if (event.type === "plan_changed") {
      const plan = event.todos.map((item) => ({ ...item }));

      this.state.plan = plan;

      return this.delta([{ op: "add", path: "/plan", value: plan }]);
    }

    if (!this.runActive()) return [];

    switch (event.type) {
      case "message_open":
        return this.messageOpen(
          event.key,
          event.messageId != null
            ? nativeId(event.messageId)
            : this.fallbackMessageId(event.key)
        );

      case "message_close": {
        this.ctx.runs.recordStopReason(event.stopReason);
        const out = this.closeReasoning();

        if (this.assistant != null && this.assistant.key === event.key) {
          out.push(
            aguiEvent(EventType.TEXT_MESSAGE_END, {
              messageId: this.assistant.id,
            })
          );
          this.assistant = null;
        }

        return out;
      }

      case "tool_call_start": {
        const tool = this.tool(
          undefined,
          event.toolCallId,
          event.toolName,
          event.rawName
        );

        if (event.input != null && !tool.argsSent) tool.input = event.input;

        return this.announce(tool);
      }

      case "tool_call_delta": {
        const tool = this.tools.get(toolKey(undefined, event.toolCallId));
        const out: AguiEvent[] = [];
        const known = tool ?? this.tool(undefined, event.toolCallId, "", "");

        out.push(...this.announce(known));
        if (known.ended || event.argumentsDelta.length === 0) return out;
        known.argsSent = true;
        out.push(
          aguiEvent(EventType.TOOL_CALL_ARGS, {
            toolCallId: known.aguiId,
            delta: event.argumentsDelta,
          })
        );

        return out;
      }

      case "tool_call_stop": {
        const tool = this.tool(
          undefined,
          event.toolCallId,
          event.toolName,
          event.toolName
        );

        try {
          const parsed = JSON.parse(event.arguments) as unknown;

          if (
            parsed != null &&
            typeof parsed === "object" &&
            !Array.isArray(parsed)
          ) {
            tool.input = parsed as Record<string, unknown>;
          }
        } catch {
          // Unparseable streamed arguments: keep what the gate or start saw.
        }

        return [...this.announce(tool), ...this.endTool(tool)];
      }

      case "tool_blocked": {
        const tool = this.tools.get(toolKey(undefined, event.toolCallId));

        if (tool != null && tool.blocked == null) tool.blocked = event.cause;

        return [];
      }

      default:
        return [];
    }
  }

  /**
   * Called by the host right after RUN_STARTED for the run's user input: a
   * server run's dequeued entry or legacy send (§3.1.3), and a client run's
   * newest user message under the client's own id. The sending client already
   * holds that message (StreamProcessor keeps one message per id), but every
   * other reader of stdout (main's transcript processor, `joinRun` replay, a
   * second window) learns the run's input only from here (finding r2-5).
   */
  userInput(
    runId: string,
    content: string,
    options: { dequeued: boolean; messageId?: string }
  ): AguiEvent[] {
    const out: AguiEvent[] = [];

    if (options.dequeued) out.push(custom("queue.dequeued", { content }));
    out.push(
      ...this.userMessage(
        nativeId(options.messageId ?? userMessageId(runId)),
        content
      )
    );

    return out;
  }

  /**
   * The open parts, closed in §3.1.5 order, before a terminal. Resets all
   * per-run bookkeeping.
   */
  closeOpenParts(): AguiEvent[] {
    const out: AguiEvent[] = [...this.closeReasoning()];

    if (this.assistant != null) {
      out.push(
        aguiEvent(EventType.TEXT_MESSAGE_END, { messageId: this.assistant.id })
      );
      this.assistant = null;
    }

    // Innermost (latest started) child first: its parts, then its terminal.
    for (const child of [...this.children.values()].reverse()) {
      out.push(...this.closeChildMessage(child));
      for (const tool of this.tools.values()) {
        if (tool.subagentRunId === child.id && !tool.resulted) {
          out.push(...this.unfinishedResult(tool));
        }
      }
      out.push(
        aguiEvent(EventType.SUBAGENT_ERROR, {
          subagentRunId: child.id,
          message: "The sub-agent did not finish.",
          code: "unfinished",
        })
      );
    }

    for (const tool of this.tools.values()) {
      if (tool.subagentRunId == null && !tool.resulted) {
        out.push(...this.unfinishedResult(tool));
      }
    }

    this.children.clear();
    this.tools.clear();
    this.reasoningCount = 0;

    return out;
  }

  // --------------------------------------------------------------- internals

  private snapshot(): AguiEvent {
    this.snapshotted = true;

    return aguiEvent(EventType.STATE_SNAPSHOT, {
      snapshot: structuredClone(this.state),
    });
  }

  private delta(
    ops: Array<{ op: "add" | "replace"; path: string; value: unknown }>
  ): AguiEvent[] {
    return this.snapshotted
      ? [aguiEvent(EventType.STATE_DELTA, { delta: ops })]
      : [];
  }

  private runActive(): boolean {
    return this.ctx.runs.isOpen() && this.hiddenDepth === 0;
  }

  private agentEvent(event: AgentEvent): AguiEvent[] {
    const meta = eventMeta(event);
    const subagentRunId = meta.subagentRunId;

    switch (event.type) {
      case "status_changed":
        return this.hiddenDepth > 0
          ? []
          : [custom("agent.status", { status: event.status })];

      case "retry":
        if (!this.runActive()) return [];

        return [
          custom("agent.retry", {
            attempt: event.attempt,
            maxAttempts: event.maxAttempts,
            delayMs: event.delayMs,
            isNetworkError: event.isNetworkError,
          }),
        ];

      case "error":
        // Already this run's terminal (a thrown send, recorded by its token).
        if (meta.attributed === true) return [];

        return this.error(event.error, meta.origin);

      case "notification": {
        const { type: _type, ...value } = event;

        return [custom("agent.notification", value)];
      }

      case "mode_changed":
        this.state.mode = event.mode;
        this.state.modeSource = event.source;

        return this.delta([
          { op: "replace", path: "/mode", value: event.mode },
          { op: "replace", path: "/modeSource", value: event.source },
        ]);

      case "model_changed":
        this.state.model = event.model;

        return this.delta([
          { op: "replace", path: "/model", value: event.model },
        ]);

      case "turn_complete":
        if (event.usage == null) return [];
        if (this.hiddenDepth > 0) {
          this.ctx.log(
            `[usage] housekeeping ${this.hiddenTypes.at(-1) ?? "unknown"} ${JSON.stringify(event.usage)}\n`
          );

          return [];
        }
        this.ctx.runs.recordUsage(event.usage);

        return [];

      case "segments_cleared":
        // The reset's cancelled terminal is written by the host before this
        // line reaches us (it settles on the way in); only the notice is left.
        return [custom("session.cleared", {})];

      case "permission_cleared":
        return this.permissionCleared(event.permissionId);

      case "user_message_dequeued":
        // Carried by the run the host opens for it (§3.1.3).
        return [];

      case "user_message_steered": {
        if (!this.runActive()) return [];
        const out = [...this.closeReasoning()];

        if (this.assistant != null) {
          out.push(
            aguiEvent(EventType.TEXT_MESSAGE_END, {
              messageId: this.assistant.id,
            })
          );
          this.assistant = null;
        }
        out.push(custom("queue.steered", { content: event.content }));
        this.steerCount += 1;
        out.push(
          ...this.userMessage(
            steerMessageId(this.ctx.incarnation, this.steerCount),
            event.content
          )
        );

        return out;
      }

      default:
        break;
    }

    if (!this.runActive()) return [];

    // A child that is not open in this run (it ended, or a stopped turn's
    // child is still unwinding into the next run): its events have no card
    // to land on, and StreamProcessor would drop them anyway.
    if (
      subagentRunId != null &&
      event.type !== "subtask_start" &&
      !this.children.has(subagentRunId)
    ) {
      return [];
    }

    switch (event.type) {
      case "text_delta":
        return subagentRunId != null
          ? this.childText(subagentRunId, event.content, event.messageId)
          : this.parentText(event.content, event.messageId);

      case "thinking_delta":
        if (subagentRunId != null) return [];

        return this.thinking(event.content);

      case "thinking_complete":
        return subagentRunId != null ? [] : this.closeReasoning();

      case "tool_execution_start": {
        const tool = this.tool(
          subagentRunId,
          event.tool.id,
          event.tool.name,
          event.tool.name
        );

        tool.executing = true;
        if (!tool.argsSent) tool.input = event.tool.input ?? tool.input;

        return [...this.announce(tool), ...this.endTool(tool)];
      }

      case "tool_output_update": {
        const tool = this.tools.get(toolKey(subagentRunId, event.toolCallId));

        if (tool != null) tool.output = event.output;

        return [
          this.tagged(
            custom("tool.output", {
              toolCallId:
                tool?.aguiId ??
                this.aguiToolId(subagentRunId, event.toolCallId),
              output: event.output,
            }),
            subagentRunId
          ),
        ];
      }

      case "tool_display_data": {
        const tool = this.tools.get(toolKey(subagentRunId, event.toolCallId));

        if (tool != null) tool.display = { ...tool.display, ...event.data };

        return [
          this.tagged(
            custom("tool.display", {
              toolCallId:
                tool?.aguiId ??
                this.aguiToolId(subagentRunId, event.toolCallId),
              data: event.data,
            }),
            subagentRunId
          ),
        ];
      }

      case "tool_execution_complete": {
        const tool = this.tool(
          subagentRunId,
          event.tool.id,
          event.tool.name,
          event.tool.name
        );

        if (!tool.argsSent && event.tool.input != null)
          tool.input = event.tool.input;

        return [
          ...this.announce(tool),
          ...this.endTool(tool),
          ...this.result(
            tool,
            event.result.content,
            event.result.rejected === true
          ),
        ];
      }

      case "subtask_start":
        return this.subtaskStart(event, subagentRunId, meta.parentToolCallId);

      case "subtask_end":
        return this.subtaskEnd(event, meta.unfinished === true);

      default:
        return [];
    }
  }

  // ------------------------------------------------------------------- errors

  private error(
    error: AgentErrorPayload,
    origin: "turn" | "command" | "startup" | "host" | undefined
  ): AguiEvent[] {
    if (
      origin === "turn" &&
      this.hiddenDepth === 0 &&
      this.ctx.runs.recordFailure(error)
    ) {
      return [];
    }

    return [custom("agent.error", error)];
  }

  // ------------------------------------------------------------------ text

  private messageOpen(key: string, requested: string): AguiEvent[] {
    const out = [...this.closeReasoning()];

    if (this.assistant != null) {
      out.push(
        aguiEvent(EventType.TEXT_MESSAGE_END, { messageId: this.assistant.id })
      );
      this.assistant = null;
    }

    const id = this.uniqueMessageId(requested);

    this.messageIds.set(key, id);
    out.push(...this.startAssistant(key, id));

    return out;
  }

  /**
   * An assistant message id with no pi timestamp to anchor it. The legacy
   * `msg-N` counter restarts in every process, and a resumed pi session keeps
   * its id, while main keeps one transcript per thread across respawns: the
   * incarnation keeps a new process's `msg-1` from landing on an old one.
   */
  private fallbackMessageId(key: string): string {
    const base =
      this.state.agentSessionId ?? this.ctx.runs.openRunId() ?? "run";

    return nativeId(`${base}:${this.ctx.incarnation}:${key}`);
  }

  private uniqueMessageId(requested: string): string {
    let id = requested;
    let n = 1;

    while (this.usedMessageIds.has(id)) {
      n += 1;
      id = `${requested}:${n}`;
    }
    this.usedMessageIds.add(id);

    return id;
  }

  private startAssistant(key: string | undefined, id: string): AguiEvent[] {
    this.assistant = { key, id };
    this.lastAssistantId = id;
    this.reasoningCount = 0;
    this.runHadAssistant = true;

    return [
      aguiEvent(EventType.TEXT_MESSAGE_START, {
        messageId: id,
        role: "assistant",
      }),
    ];
  }

  /** The open assistant message for `key`, opening (and closing another) as needed. */
  private ensureAssistant(key: string | undefined): AguiEvent[] {
    if (this.assistant != null && (key == null || this.assistant.key === key)) {
      return [];
    }

    const out: AguiEvent[] = [];

    if (this.assistant != null) {
      out.push(...this.closeReasoning());
      out.push(
        aguiEvent(EventType.TEXT_MESSAGE_END, { messageId: this.assistant.id })
      );
      this.assistant = null;
    }

    const known = key != null ? this.messageIds.get(key) : undefined;
    const id =
      known ??
      this.uniqueMessageId(
        this.fallbackMessageId(key ?? `msg-x${++this.fallbackCount}`)
      );

    if (key != null && known == null) this.messageIds.set(key, id);
    out.push(...this.startAssistant(key, id));

    return out;
  }

  private parentText(content: string, key: string | undefined): AguiEvent[] {
    const out = [...this.closeReasoning(), ...this.ensureAssistant(key)];

    out.push(
      aguiEvent(EventType.TEXT_MESSAGE_CONTENT, {
        messageId: this.assistant!.id,
        delta: content,
      })
    );

    return out;
  }

  private thinking(content: string): AguiEvent[] {
    const out: AguiEvent[] = [];

    if (this.reasoning == null) {
      out.push(...this.ensureAssistant(this.assistant?.key));
      this.reasoningCount += 1;
      const id = reasoningMessageId(this.assistant!.id, this.reasoningCount);

      this.reasoning = { id };
      out.push(
        aguiEvent(EventType.REASONING_START, { messageId: id }),
        aguiEvent(EventType.REASONING_MESSAGE_START, {
          messageId: id,
          role: REASONING_ROLE,
        })
      );
    }

    out.push(
      aguiEvent(EventType.REASONING_MESSAGE_CONTENT, {
        messageId: this.reasoning!.id,
        delta: content,
      })
    );

    return out;
  }

  private closeReasoning(): AguiEvent[] {
    if (this.reasoning == null) return [];

    const id = this.reasoning.id;

    this.reasoning = null;

    return [
      aguiEvent(EventType.REASONING_MESSAGE_END, { messageId: id }),
      aguiEvent(EventType.REASONING_END, { messageId: id }),
    ];
  }

  private userMessage(messageId: string, content: string): AguiEvent[] {
    return [
      aguiEvent(EventType.TEXT_MESSAGE_START, { messageId, role: "user" }),
      aguiEvent(EventType.TEXT_MESSAGE_CONTENT, { messageId, delta: content }),
      aguiEvent(EventType.TEXT_MESSAGE_END, { messageId }),
    ];
  }

  // ------------------------------------------------------------------ tools

  private aguiToolId(
    subagentRunId: string | undefined,
    legacyId: string
  ): string {
    // A provider's tool call id passes through, under the reservation.
    return subagentRunId != null
      ? childToolCallId(subagentRunId, legacyId)
      : nativeId(legacyId);
  }

  private tool(
    subagentRunId: string | undefined,
    legacyId: string,
    name: string,
    rawName: string
  ): ToolState {
    const key = toolKey(subagentRunId, legacyId);
    const existing = this.tools.get(key);

    if (existing != null) {
      if (existing.name.length === 0 && name.length > 0) existing.name = name;
      if (existing.rawName.length === 0 && rawName.length > 0)
        existing.rawName = rawName;

      return existing;
    }

    const created: ToolState = {
      aguiId: this.aguiToolId(subagentRunId, legacyId),
      legacyId,
      ...(subagentRunId != null ? { subagentRunId } : {}),
      name,
      rawName,
      ...(subagentRunId == null && this.lastAssistantId != null
        ? { parentMessageId: this.lastAssistantId }
        : {}),
      started: false,
      argsSent: false,
      ended: false,
      resulted: false,
      executing: false,
      input: {},
      order: ++this.toolOrder,
    };

    this.tools.set(key, created);

    return created;
  }

  private tagged<E extends AguiEvent>(
    event: E,
    subagentRunId: string | undefined
  ): E {
    return subagentRunId != null ? { ...event, subagentRunId } : event;
  }

  private announce(tool: ToolState): AguiEvent[] {
    if (tool.started) return [];
    tool.started = true;

    const meta: ToolCallStartMeta = {
      abacus: {
        rawName: tool.rawName.length > 0 ? tool.rawName : tool.name,
        ...(tool.aguiId !== tool.legacyId
          ? { legacyToolCallId: tool.legacyId }
          : {}),
      },
    };

    return [
      this.tagged(
        aguiEvent(EventType.TOOL_CALL_START, {
          toolCallId: tool.aguiId,
          toolCallName: tool.name,
          ...(tool.parentMessageId != null
            ? { parentMessageId: tool.parentMessageId }
            : {}),
          metadata: meta,
        }),
        tool.subagentRunId
      ),
    ];
  }

  private endTool(tool: ToolState): AguiEvent[] {
    if (tool.ended) return [];
    tool.ended = true;

    const out: AguiEvent[] = [];

    if (!tool.argsSent) {
      tool.argsSent = true;
      out.push(
        this.tagged(
          aguiEvent(EventType.TOOL_CALL_ARGS, {
            toolCallId: tool.aguiId,
            delta: JSON.stringify(tool.input),
          }),
          tool.subagentRunId
        )
      );
    }

    const meta: ToolCallEndMeta = { tanstack: { input: tool.input } };

    out.push(
      this.tagged(
        aguiEvent(EventType.TOOL_CALL_END, {
          toolCallId: tool.aguiId,
          metadata: meta,
        }),
        tool.subagentRunId
      )
    );

    return out;
  }

  private result(
    tool: ToolState,
    text: string,
    rejected: boolean
  ): AguiEvent[] {
    if (tool.resulted) return [];
    tool.resulted = true;
    tool.executing = false;

    const formatted = formatToolContent(
      tool.rawName.length > 0 ? tool.rawName : tool.name,
      { content: [{ type: "text", text }] },
      rejected
    );
    const content: ToolResultContent = {
      text,
      rejected,
      ...(rejected ? { error: text } : {}),
      ...(tool.display != null ? { display: tool.display } : {}),
      ...(tool.output != null ? { terminal: { output: tool.output } } : {}),
      ...(formatted.length > 0 ? { formatted } : {}),
    };
    const outcome =
      tool.blocked === "stopped"
        ? "cancelled"
        : tool.blocked != null
          ? "denied"
          : undefined;
    const meta: ToolCallResultMeta | undefined = rejected
      ? {
          tanstack: {
            state: "output-error",
            ...(outcome != null ? { toolResultOutcome: outcome } : {}),
          },
        }
      : undefined;

    return [
      this.tagged(
        aguiEvent(EventType.TOOL_CALL_RESULT, {
          messageId: resultMessageId(tool.aguiId),
          toolCallId: tool.aguiId,
          role: "tool",
          content: JSON.stringify(content),
          ...(meta != null ? { metadata: meta } : {}),
        }),
        tool.subagentRunId
      ),
    ];
  }

  /** A synthetic result for a call the run closed without one (§3.1.5). */
  private unfinishedResult(tool: ToolState): AguiEvent[] {
    const out = [...this.announce(tool), ...this.endTool(tool)];
    const text = "The run ended before this finished.";
    const content: ToolResultContent = {
      text,
      rejected: true,
      error: text,
      unfinished: true,
      ...(tool.display != null ? { display: tool.display } : {}),
      ...(tool.output != null ? { terminal: { output: tool.output } } : {}),
    };
    const meta: ToolCallResultMeta = {
      tanstack: { state: "output-error", toolResultOutcome: "cancelled" },
    };

    tool.resulted = true;
    out.push(
      this.tagged(
        aguiEvent(EventType.TOOL_CALL_RESULT, {
          messageId: resultMessageId(tool.aguiId),
          toolCallId: tool.aguiId,
          role: "tool",
          content: JSON.stringify(content),
          metadata: meta,
        }),
        tool.subagentRunId
      )
    );

    return out;
  }

  // -------------------------------------------------------------- sub-agents

  private subtaskStart(
    event: Extract<AgentEvent, { type: "subtask_start" }>,
    parentSubagentRunId: string | undefined,
    parentToolCallId: string | undefined
  ): AguiEvent[] {
    if (this.children.has(event.id)) return [];

    this.children.set(event.id, {
      id: event.id,
      ...(parentSubagentRunId != null ? { parentSubagentRunId } : {}),
      finalText: "",
    });

    const parentTool =
      parentToolCallId != null
        ? this.tools.get(toolKey(parentSubagentRunId, parentToolCallId))
        : undefined;

    return [
      aguiEvent(EventType.SUBAGENT_STARTED, {
        subagentRunId: event.id,
        name: event.kind ?? "delegate",
        ...(event.description != null
          ? { description: event.description }
          : {}),
        ...(parentSubagentRunId != null ? { parentSubagentRunId } : {}),
        ...(parentToolCallId != null
          ? { parentToolCallId: parentTool?.aguiId ?? parentToolCallId }
          : {}),
        ...(parentSubagentRunId == null && this.lastAssistantId != null
          ? { parentMessageId: this.lastAssistantId }
          : {}),
      }),
    ];
  }

  private childText(
    subagentRunId: string,
    content: string,
    legacyMessageId: string | undefined
  ): AguiEvent[] {
    const child = this.children.get(subagentRunId);

    if (child == null) return [];

    const id = childMessageId(subagentRunId, legacyMessageId);
    const out: AguiEvent[] = [];

    if (child.openMessageId !== id) {
      out.push(...this.closeChildMessage(child));
      child.openMessageId = id;
      child.finalText = "";
      out.push(
        this.tagged(
          aguiEvent(EventType.TEXT_MESSAGE_START, {
            messageId: id,
            role: "assistant",
          }),
          subagentRunId
        )
      );
    }

    child.finalText += content;
    out.push(
      this.tagged(
        aguiEvent(EventType.TEXT_MESSAGE_CONTENT, {
          messageId: id,
          delta: content,
        }),
        subagentRunId
      )
    );

    return out;
  }

  private closeChildMessage(child: ChildState): AguiEvent[] {
    if (child.openMessageId == null) return [];

    const id = child.openMessageId;

    delete child.openMessageId;

    return [
      this.tagged(
        aguiEvent(EventType.TEXT_MESSAGE_END, { messageId: id }),
        child.id
      ),
    ];
  }

  private subtaskEnd(
    event: Extract<AgentEvent, { type: "subtask_end" }>,
    unfinished: boolean
  ): AguiEvent[] {
    const child = this.children.get(event.id);

    if (child == null) return [];

    const out = [...this.closeChildMessage(child)];

    // Anything of the child's still unresolved gets its result first:
    // StreamProcessor drops a child's events after its terminal.
    for (const tool of this.tools.values()) {
      if (tool.subagentRunId === child.id && !tool.resulted) {
        out.push(...this.unfinishedResult(tool));
      }
    }

    this.children.delete(event.id);

    if (event.status === "failed") {
      // A component bracket the turn closed because its tool never ended
      // (`finishTurn`) is unfinished, not a failure the component reported.
      out.push(
        aguiEvent(EventType.SUBAGENT_ERROR, {
          subagentRunId: event.id,
          message:
            child.finalText.trim().length > 0
              ? child.finalText
              : "The sub-agent did not finish.",
          code: unfinished ? "unfinished" : "failed",
        })
      );
    } else {
      out.push(
        aguiEvent(EventType.SUBAGENT_FINISHED, {
          subagentRunId: event.id,
          ...(child.finalText.length > 0 ? { result: child.finalText } : {}),
          outcome: { type: "success" },
          ...(event.outcome != null
            ? { metadata: { abacus: { outcome: event.outcome } } }
            : {}),
        })
      );
    }

    return out;
  }

  // ------------------------------------------------------------- permissions

  /** Running (announced, unresolved) calls, for attaching sandbox asks. */
  private runningCalls(): RunningCall[] {
    return [...this.tools.values()]
      .filter((tool) => tool.executing && !tool.resulted)
      .map((tool) => ({
        toolCallId: tool.aguiId,
        ...(tool.subagentRunId != null
          ? { subagentRunId: tool.subagentRunId }
          : {}),
        toolName: tool.name,
        input: tool.input,
        order: tool.order,
      }));
  }

  private permissionNeeded(
    permissionId: string,
    request: PermissionRequest
  ): AguiEvent[] {
    const token = this.ctx.runs.currentToken();
    const runId = this.ctx.runs.openRunId();
    const fromGate =
      request.type !== "sandbox_denied" && request.type !== "network_host";
    const attach = attachToolCall(request, fromGate, this.runningCalls());
    const budget = this.ctx.approvalTimeoutMs();
    const descriptor = toDescriptor({
      permissionId,
      request,
      lineage: {
        threadId: this.ctx.threadId,
        incarnation: this.ctx.incarnation,
        turnSeq: token?.seq ?? 0,
        ...(runId != null ? { runId } : {}),
        permissionId,
      },
      attach,
      ...(Number.isFinite(budget)
        ? { expiresAt: new Date(this.ctx.now() + budget).toISOString() }
        : {}),
    });

    this.pending.set(permissionId, { descriptor, turnSeq: token?.seq ?? 0 });
    if (fromGate)
      this.permissionTool.set(
        permissionId,
        toolKey(undefined, request.tool.id)
      );

    return [custom("permission.requested", descriptor), this.pendingEvent()];
  }

  private permissionCleared(permissionId: string): AguiEvent[] {
    if (!this.pending.delete(permissionId)) return [];

    const reason = this.clearReason;
    const key = this.permissionTool.get(permissionId);

    this.permissionTool.delete(permissionId);
    if (key != null) {
      const tool = this.tools.get(key);

      if (tool != null)
        tool.blocked = reason === "expired" ? "expired" : "stopped";
    }

    return [
      custom("permission.cleared", { permissionId, reason }),
      this.pendingEvent(),
    ];
  }

  /** An answer released a waiter (`permission.respond` or legacy). */
  resolved(
    permissionId: string,
    decisionKind: import("./wire.js").DecisionKind,
    source: "respond" | "legacy_response"
  ): AguiEvent[] {
    if (!this.pending.delete(permissionId)) return [];
    this.permissionTool.delete(permissionId);

    return [
      custom("permission.resolved", { permissionId, decisionKind, source }),
      this.pendingEvent(),
    ];
  }

  pendingEvent(): AguiEvent {
    return custom("permission.pending", {
      incarnation: this.ctx.incarnation,
      items: this.pendingItems(),
    });
  }
}
