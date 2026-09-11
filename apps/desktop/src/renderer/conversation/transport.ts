import {
  AgentMode,
  type ToolDisplayData,
  type ToolRequest as LegacyToolRequest,
  type ToolResult as LegacyToolResult,
} from "#shared/agent-types";

/**
 * Bridges the local CLI's NDJSON IPC onto the vendored `conversation` package.
 * Most messages are only wrapped in the reducer's envelope; the one real
 * translation is tool activity, which the host announces in a legacy
 * vocabulary (see `adaptLoopEvent`). `conversationId` here is the session id.
 */
import type {
  ConversationAttachment,
  ConversationEvent,
  ConversationPermissionMode,
  ConversationTransport,
  DequeueOptions,
  QueueOptions,
  SendMessageOptions,
  StopProcessingResult,
  UserAttachment,
} from ".";
import type {
  AgentLoopEvent,
  MessageQueueEntry,
  PermissionDecision,
  PermissionRequest,
  ToolCall,
  ToolResult,
  ToolResultData,
} from "./agent-types";

type Subscriber = (conversationId: string, event: ConversationEvent) => void;

/** The NDJSON messages this bridge cares about. */
type NdjsonMessage =
  | { type: "event"; event: AgentLoopEvent }
  | {
      type: "permission_needed";
      permissionId: string;
      request: PermissionRequest;
    }
  | { type: "queue_updated"; messages: MessageQueueEntry[] };

/**
 * The host's entire legacy tool surface (packages/agent/src/session.ts); this
 * union is the complete translation contract.
 */
type LegacyToolEvent =
  | { type: "tool_execution_start"; tool: LegacyToolRequest }
  | {
      type: "tool_execution_complete";
      tool: LegacyToolRequest;
      result: LegacyToolResult;
    }
  | { type: "tool_display_data"; toolCallId: string; data: ToolDisplayData }
  | { type: "tool_output_update"; toolCallId: string; output: string };

const LEGACY_TOOL_EVENT_TYPES = new Set<string>([
  "tool_execution_start",
  "tool_execution_complete",
  "tool_display_data",
  "tool_output_update",
]);

/**
 * Event types scoped to the open sub-agent bracket. Status, errors and
 * notifications stay on the main surface, where a failure is seen.
 */
const SUBTASK_SCOPED_TYPES = new Set<string>([
  "text_delta",
  "thinking_delta",
  "collapsible",
]);

/** What the translator carries from a tool's start event to its result. */
interface LiveToolState {
  call: ToolCall;
  displayData?: ToolDisplayData;
}

// The two types are the same four wire strings, so this is a widening cast;
// guarded so an unknown mode cannot reach the CLI.
const KNOWN_MODES = new Set<string>(Object.values(AgentMode));

const MAX_TITLE_CHARS = 48;

/**
 * A sidebar-sized title from the first message: mentions keep their filename,
 * slash prefixes drop, fences collapse, and the cut lands on a word boundary.
 */
export const deriveSessionTitle = (text: string): string => {
  const flat = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/^\s*\/(\S+)/, "$1")
    .replace(/@([\w./-]+)/g, (_m, p: string) => p.split("/").pop() ?? p)
    .replace(/\s+/g, " ")
    .trim();

  if (flat.length === 0) return "";
  if (flat.length <= MAX_TITLE_CHARS) return flat;

  // slice() counts UTF-16 code units, so a cut can split a surrogate pair and
  // leave a `�`.
  const clipped = flat
    .slice(0, MAX_TITLE_CHARS)
    .replace(/[\uD800-\uDBFF]$/, "");
  const lastSpace = clipped.lastIndexOf(" ");

  return `${(lastSpace > 20 ? clipped.slice(0, lastSpace) : clipped).trimEnd()}…`;
};

export class WorkspaceConversationTransport implements ConversationTransport {
  private readonly subscribers = new Set<Subscriber>();

  /** sessionId -> workspaceId; every agent IPC call is addressed by the pair. */
  private readonly workspaceBySession = new Map<string, string>();

  /**
   * sessionId -> toolCallId -> permissionId: the CLI answers by permissionId,
   * the conversation package by `tool.id`.
   */
  private readonly permissionIds = new Map<string, Map<string, string>>();

  /**
   * sessionId -> the permissionId on screen. The UI holds one prompt slot, so
   * retiring an expired request must not blank a different, live card.
   */
  private readonly activePermissionId = new Map<string, string>();

  /**
   * sessionId -> toolCallId -> what the start event announced. The completion
   * event carries empty args, so without this join a finished card loses its
   * command line. Cleared per result and on `turn_complete`.
   */
  private readonly liveTools = new Map<string, Map<string, LiveToolState>>();

  /**
   * sessionId -> open sub-agent brackets, oldest first. A stack, since the
   * host runs simultaneous brackets; events are stamped with the innermost.
   */
  private readonly activeSubtaskIds = new Map<string, string[]>();

  /**
   * sessionId -> latest `queue_updated` snapshot, so "send now" can recover an
   * entry's text and index (see sendQueuedMessage).
   */
  private readonly queuedEntries = new Map<string, MessageQueueEntry[]>();

  registerSession(sessionId: string, workspaceId: string): void {
    this.workspaceBySession.set(sessionId, workspaceId);
  }

  forgetSession(sessionId: string): void {
    this.workspaceBySession.delete(sessionId);
    this.permissionIds.delete(sessionId);
    this.activePermissionId.delete(sessionId);
    this.liveTools.delete(sessionId);
    this.activeSubtaskIds.delete(sessionId);
    this.queuedEntries.delete(sessionId);
  }

  subscribe(cb: Subscriber): () => void {
    this.subscribers.add(cb);
    return () => {
      this.subscribers.delete(cb);
    };
  }

  /** Also used for local echoes and hydration. */
  emit(sessionId: string, event: ConversationEvent): void {
    for (const cb of this.subscribers) cb(sessionId, event);
  }

  /** Feed one raw NDJSON line; unknown message types are dropped. */
  ingest(workspaceId: string, sessionId: string, payload: unknown): void {
    if (typeof payload !== "object" || payload == null) return;
    const message = payload as NdjsonMessage;
    this.workspaceBySession.set(sessionId, workspaceId);

    switch (message.type) {
      case "event": {
        if (message.event == null) return;
        // Permission events travel on the side-channel below.
        const loopType = (message.event as { type?: string }).type;
        if (loopType === "permission_cleared") {
          // A request nobody answered (expired, or the turn was interrupted):
          // retire the card, or it stays attached to a call already rejected.
          const permissionId = (message.event as { permissionId?: string })
            .permissionId;
          if (permissionId == null) return;
          const bySession = this.permissionIds.get(sessionId);
          if (bySession != null) {
            for (const [toolCallId, id] of bySession) {
              if (id === permissionId) bySession.delete(toolCallId);
            }
          }
          // Only this request's card: a second approval may own the slot now.
          if (this.activePermissionId.get(sessionId) === permissionId) {
            this.activePermissionId.delete(sessionId);
            this.emit(sessionId, { kind: "permission", prompt: null });
          }
          return;
        }
        if (loopType === "permission_request") return;
        for (const event of this.adaptLoopEvent(sessionId, message.event)) {
          this.emit(sessionId, { kind: "event", event: event as never });
        }
        return;
      }
      case "permission_needed": {
        if (message.request == null) return;
        const toolCallId = message.request.tool?.id;
        if (toolCallId != null) {
          let bySession = this.permissionIds.get(sessionId);
          if (bySession == null) {
            bySession = new Map();
            this.permissionIds.set(sessionId, bySession);
          }
          bySession.set(toolCallId, message.permissionId);
        }
        this.activePermissionId.set(sessionId, message.permissionId);
        this.emit(sessionId, {
          kind: "permission",
          prompt: { request: message.request },
        });
        return;
      }
      case "queue_updated": {
        this.queuedEntries.set(sessionId, message.messages ?? []);
        this.emit(sessionId, {
          kind: "queue",
          entries: message.messages ?? [],
        });
        return;
      }
    }
  }

  /** Open a bracket. Repeated starts for one id do not stack it twice. */
  private pushSubtask(sessionId: string, id: string): void {
    const open = this.activeSubtaskIds.get(sessionId) ?? [];
    if (open.includes(id)) return;
    this.activeSubtaskIds.set(sessionId, [...open, id]);
  }

  /** Close one bracket by id; a still-running sibling stays scoped. */
  private popSubtask(sessionId: string, id: string): void {
    const open = this.activeSubtaskIds.get(sessionId);
    if (open == null) return;
    const remaining = open.filter((openId) => openId !== id);
    if (remaining.length === 0) this.activeSubtaskIds.delete(sessionId);
    else this.activeSubtaskIds.set(sessionId, remaining);
  }

  /** The bracket streamed content belongs to: the most recently opened one. */
  private innermostSubtaskId(sessionId: string): string | undefined {
    const open = this.activeSubtaskIds.get(sessionId);
    return open != null && open.length > 0 ? open[open.length - 1] : undefined;
  }

  /**
   * Drop the per-turn joins: a bracket id kept past its turn stamps the next
   * turn's events and scopes them out of every view.
   */
  private clearTurnState(sessionId: string): void {
    this.activeSubtaskIds.delete(sessionId);
    this.liveTools.delete(sessionId);
  }

  /**
   * Adapt one loop event into what the reducer speaks: translate legacy tool
   * events and stamp `subtaskId` while a bracket is open. May return nothing
   * (`tool_display_data` is bookkeeping until its result arrives).
   */
  private adaptLoopEvent(
    sessionId: string,
    raw: AgentLoopEvent
  ): AgentLoopEvent[] {
    const event = raw as { type?: string } & Record<string, unknown>;

    switch (event.type) {
      case "subtask_start": {
        if (typeof event.id === "string") this.pushSubtask(sessionId, event.id);
        return [raw];
      }
      case "subtask_end": {
        if (typeof event.id === "string") this.popSubtask(sessionId, event.id);
        return [raw];
      }
      case "turn_complete": {
        // A bracket cannot outlive its turn; a tool with no result never gets one.
        this.clearTurnState(sessionId);
        return [raw];
      }
    }

    if (event.type != null && LEGACY_TOOL_EVENT_TYPES.has(event.type)) {
      return this.translateLegacyToolEvent(
        sessionId,
        raw as unknown as LegacyToolEvent
      );
    }

    const subtaskId = this.innermostSubtaskId(sessionId);
    if (
      subtaskId != null &&
      event.type != null &&
      SUBTASK_SCOPED_TYPES.has(event.type) &&
      event.subtaskId === undefined
    ) {
      return [{ ...event, subtaskId } as unknown as AgentLoopEvent];
    }

    return [raw];
  }

  private translateLegacyToolEvent(
    sessionId: string,
    event: LegacyToolEvent
  ): AgentLoopEvent[] {
    let tools = this.liveTools.get(sessionId);
    if (tools == null) {
      tools = new Map();
      this.liveTools.set(sessionId, tools);
    }
    const subtaskId = this.innermostSubtaskId(sessionId);

    switch (event.type) {
      case "tool_execution_start": {
        const call = toCanonicalToolCall(event.tool);
        if (call.id.length === 0) return [];
        // Keep display data that arrived ahead of the start event, or edit
        // cards lose their diff.
        const existing = tools.get(call.id);
        tools.set(call.id, {
          call,
          ...(existing?.displayData != null && {
            displayData: existing.displayData,
          }),
        });
        return [
          {
            type: "tool_call",
            toolCall: call,
            ...(subtaskId != null && { subtaskId }),
          },
        ];
      }

      case "tool_display_data": {
        // Edit diff, usually sent before `tool_execution_start`; hold it in a
        // placeholder entry until the result's `file_mutation`.
        if (
          typeof event.toolCallId !== "string" ||
          event.toolCallId.length === 0
        )
          return [];
        let tracked = tools.get(event.toolCallId);
        if (tracked == null) {
          // Replaced by the real call, which keeps this displayData.
          tracked = {
            call: {
              id: event.toolCallId,
              name: "",
              args: {},
              status: "executing",
            },
          };
          tools.set(event.toolCallId, tracked);
        }
        tracked.displayData = { ...tracked.displayData, ...event.data };
        return [];
      }

      case "tool_output_update": {
        // Live output for a running command; `streaming` says this is not a
        // result, so the card keeps rendering as running until completion.
        const tracked = tools.get(event.toolCallId);
        const command = tracked != null ? bashCommandOf(tracked.call) : null;
        if (command == null || typeof event.output !== "string") return [];
        return [
          {
            type: "terminal_command",
            cmdline: command,
            output: event.output,
            toolCallId: event.toolCallId,
            streaming: true,
            ...(subtaskId != null && { subtaskId }),
          },
        ];
      }

      case "tool_execution_complete": {
        const id = event.tool?.id ?? "";
        if (id.length === 0) return [];
        const tracked = tools.get(id);
        tools.delete(id);
        // The completion's args are always `{}`; the start event's call is
        // the real one. A display-data placeholder has no name and is no better.
        const call =
          tracked != null && tracked.call.name.length > 0
            ? tracked.call
            : toCanonicalToolCall(event.tool);
        const output =
          typeof event.result?.content === "string" ? event.result.content : "";
        const failed = event.result?.rejected === true;
        const data = toResultData(call, output, tracked?.displayData);
        const result: ToolResult = {
          toolCallId: id,
          output,
          // The legacy wire folds errors and rejections into one flag; `error`
          // is the honest default and a real rejection's text still reads right.
          ...(failed && {
            error: output.length > 0 ? output : "The tool call failed.",
          }),
          ...(data != null && { data }),
        };
        return [{ type: "tool_result", toolCall: call, result }];
      }
    }

    return [];
  }

  /** Optimistic local echo before the CLI replies. */
  echoUserMessage(
    sessionId: string,
    content: string,
    attachments?: UserAttachment[]
  ): void {
    this.emit(sessionId, {
      kind: "user_message",
      content,
      ...(attachments != null && attachments.length > 0 ? { attachments } : {}),
    });
  }

  echoAgentMessage(sessionId: string, content: string): void {
    this.emit(sessionId, { kind: "agent_message", content });
  }

  /** Undo the most recent local echo. */
  retractUserMessage(sessionId: string): void {
    this.emit(sessionId, { kind: "retract_user_message" });
  }

  reset(sessionId: string): void {
    this.emit(sessionId, { kind: "reset" });
  }

  /**
   * Force idle and drop any open prompt on Stop: main suppresses the stopped
   * session's in-flight events, so neither `status_changed: idle` nor the
   * `turn_complete` that retires the joins will arrive.
   */
  markIdle(sessionId: string): void {
    this.clearTurnState(sessionId);
    this.emit(sessionId, { kind: "permission", prompt: null });
    this.emit(sessionId, {
      kind: "event",
      event: { type: "status_changed", status: "idle" },
    });
  }

  // Commands are addressed by (workspaceId, sessionId). An unregistered
  // session is a no-op, not a throw: the UI can race a teardown.

  private target(
    conversationId: string | null
  ): { workspaceId: string; sessionId: string } | null {
    if (conversationId == null) return null;
    const workspaceId = this.workspaceBySession.get(conversationId);
    if (workspaceId == null) return null;
    return { workspaceId, sessionId: conversationId };
  }

  async sendMessage(
    conversationId: string | null,
    text: string,
    _attachments?: ConversationAttachment[],
    _options?: SendMessageOptions
  ): Promise<void> {
    const target = this.target(conversationId);
    if (target == null) return;
    void this.autoNameSession(target, text);
    await window.api.agent.sendAgentMessage({
      ...target,
      message: text,
    });
  }

  /**
   * Name a session from its first message, locally and instantly rather than
   * via the model. Only a session still carrying the placeholder is renamed.
   */
  private async autoNameSession(
    target: { workspaceId: string; sessionId: string },
    text: string
  ): Promise<void> {
    try {
      const sessions = await window.api.agent.listAgentSessions(
        target.workspaceId
      );
      const session = sessions.find((s) => s.id === target.sessionId);
      if (
        session == null ||
        (session.label !== "Untitled" && session.label.trim().length > 0)
      )
        return;

      const title = deriveSessionTitle(text);
      if (title.length === 0) return;

      await window.api.agent.updateAgentSessionLabel(
        target.workspaceId,
        target.sessionId,
        title
      );
    } catch {
      // A title is a nicety; never let it interfere with sending the message.
    }
  }

  async stopProcessing(
    conversationId: string | null
  ): Promise<StopProcessingResult> {
    const target = this.target(conversationId);
    if (target != null) await window.api.agent.stopAgentTurn(target);
    return { dequeuedMessage: null };
  }

  async respondToPermission(
    conversationId: string | null,
    toolCallId: string,
    decision: PermissionDecision
  ): Promise<void> {
    const target = this.target(conversationId);
    if (target == null) return;
    const permissionId = this.permissionIds
      .get(target.sessionId)
      ?.get(toolCallId);
    if (permissionId == null) return;
    this.permissionIds.get(target.sessionId)?.delete(toolCallId);
    if (this.activePermissionId.get(target.sessionId) === permissionId) {
      this.activePermissionId.delete(target.sessionId);
    }
    await window.api.agent.respondAgentPermission({
      ...target,
      permissionId,
      decision,
    });
    // The host emits no `permission_cleared` on answer; retire the prompt here.
    this.emit(target.sessionId, { kind: "permission", prompt: null });
  }

  async enqueueMessage(
    conversationId: string | null,
    text: string,
    options?: { hidden?: boolean }
  ): Promise<void> {
    const target = this.target(conversationId);
    if (target == null) return;
    await window.api.agent.enqueueAgentMessage({
      ...target,
      message: text,
      ...(options?.hidden != null ? { hidden: options.hidden } : {}),
    });
  }

  async dequeueMessages(
    conversationId: string | null,
    _options?: DequeueOptions
  ): Promise<void> {
    const target = this.target(conversationId);
    if (target == null) return;
    await window.api.agent.dequeueAgentMessage(target);
  }

  async sendQueuedMessage(
    conversationId: string | null,
    id: string
  ): Promise<void> {
    // The host has no "send now"; dequeue and re-send is the equivalent.
    const target = this.target(conversationId);
    if (target == null) return;
    const entries = this.queuedEntries.get(target.sessionId) ?? [];
    const entryIndex = entries.findIndex((entry) => entry.id === id);
    // The host's queue commands are index-addressed; entry ids double as
    // indices when no snapshot has arrived yet.
    const index = entryIndex !== -1 ? entryIndex : Number(id);
    const entry = entries[index] ?? null;
    await window.api.agent.removeAgentQueueMessage({ ...target, index });
    if (entry == null) return;
    // Through the normal send path, echoing first the way the composer does.
    if (entry.hidden !== true)
      this.echoUserMessage(target.sessionId, entry.message);
    await this.sendMessage(conversationId, entry.message);
  }

  async removeQueuedMessage(
    conversationId: string | null,
    id: string,
    _options?: QueueOptions
  ): Promise<void> {
    const target = this.target(conversationId);
    if (target == null) return;
    const entries = this.queuedEntries.get(target.sessionId) ?? [];
    const entryIndex = entries.findIndex((entry) => entry.id === id);
    // The host's queue commands are index-addressed; entry ids double as
    // indices when no snapshot has arrived yet.
    const index = entryIndex !== -1 ? entryIndex : Number(id);
    await window.api.agent.removeAgentQueueMessage({ ...target, index });
  }

  async updateQueuedMessage(
    conversationId: string | null,
    id: string,
    text: string
  ): Promise<void> {
    const target = this.target(conversationId);
    if (target == null) return;
    const entries = this.queuedEntries.get(target.sessionId) ?? [];
    const entryIndex = entries.findIndex((entry) => entry.id === id);
    const index = entryIndex !== -1 ? entryIndex : Number(id);
    await window.api.agent.updateAgentQueueMessage({
      ...target,
      index,
      message: text,
    });
  }

  async clearQueue(
    conversationId: string | null,
    _options?: QueueOptions
  ): Promise<void> {
    const target = this.target(conversationId);
    if (target == null) return;
    await window.api.agent.clearAgentQueue(target);
  }

  async selectConversation(conversationId: string | null): Promise<void> {
    const target = this.target(conversationId);
    if (target == null) return;
    await window.api.agent.getAgentQueue(target);
  }

  // Conversation lifecycle is owned by the chat panel; these are inert here.
  async createConversation(): Promise<string> {
    throw new Error("Conversation creation is owned by the chat panel");
  }
  async deleteConversation(): Promise<void> {
    return;
  }
  async renameConversation(): Promise<void> {
    return;
  }
  async loadMoreConversations(): Promise<void> {
    return;
  }
  async refreshConversations(): Promise<void> {
    return;
  }

  private activeTargets(): { workspaceId: string; sessionId: string }[] {
    return [...this.workspaceBySession].map(([sessionId, workspaceId]) => ({
      workspaceId,
      sessionId,
    }));
  }

  async setModel(model: string): Promise<void> {
    await Promise.all(
      this.activeTargets().map((target) =>
        window.api.agent.setAgentModel({ ...target, model })
      )
    );
  }

  async setPermissionMode(mode: ConversationPermissionMode): Promise<void> {
    const agentMode = (
      KNOWN_MODES.has(mode) ? mode : AgentMode.Normal
    ) as AgentMode;
    await Promise.all(
      this.activeTargets().map((target) =>
        window.api.agent.setAgentMode({ ...target, mode: agentMode })
      )
    );
  }

  async clearConversation(conversationId: string | null): Promise<void> {
    const target = this.target(conversationId);
    if (target == null) return;
    await window.api.agent.resetAgentConversation(target);
    // Stale joins would stamp the fresh conversation with an old bracket.
    this.clearTurnState(target.sessionId);
    this.reset(target.sessionId);
  }
}

/**
 * A legacy `ToolRequest` as a canonical `ToolCall`. Arguments arrive under
 * either `input` or `args`; the status is a placeholder the reducer recomputes.
 */
function toCanonicalToolCall(tool: LegacyToolRequest | undefined): ToolCall {
  const args = (tool?.input ?? tool?.args ?? {}) as Record<string, unknown>;
  return {
    id: tool?.id ?? "",
    name: tool?.name ?? "",
    args,
    status: "executing",
  };
}

/** The bash command of a call, or null for other tools. */
function bashCommandOf(call: ToolCall): string | null {
  if (call.name !== "bash") return null;
  const command = call.args["command"];
  return typeof command === "string" && command.length > 0 ? command : null;
}

/**
 * Typed payload for cards that render more than text: bash wants its command,
 * write/edit the before/after content. Everything else renders `result.output`.
 */
function toResultData(
  call: ToolCall,
  output: string,
  displayData: ToolDisplayData | undefined
): ToolResultData | null {
  if (call.name === "bash") {
    return { type: "bash", command: bashCommandOf(call) ?? "", output };
  }

  if ((call.name === "write" || call.name === "edit") && displayData != null) {
    const finalContent = displayData.newContent ?? displayData.finalContent;
    return {
      type: "file_mutation",
      ...(displayData.originalContent != null && {
        originalContent: displayData.originalContent,
      }),
      ...(finalContent != null && { finalContent }),
      ...(displayData.isNewFile != null && {
        isNewFile: displayData.isNewFile,
      }),
      ...(displayData.additions != null && {
        additions: displayData.additions,
      }),
      ...(displayData.deletions != null && {
        deletions: displayData.deletions,
      }),
    };
  }

  return null;
}

export const workspaceConversationTransport =
  new WorkspaceConversationTransport();
