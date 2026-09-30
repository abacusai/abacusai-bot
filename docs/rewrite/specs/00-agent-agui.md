# Spec 00: `packages/agent` AG-UI host and emitter

Phase 0, slice 1 of `docs/rewrite/PLAN.md` ("Protocol: AG-UI straight from pi"). This is a spec, not code. The only code in it is type declarations.

Sources read for this spec:

- `packages/agent/src`: `host.ts`, `protocol.ts`, `session.ts`, `bot/bot-session.ts`, `delegation.ts`, `delegate-tool.ts`, `document-tool.ts`, `deck-tool.ts`, `design-tool.ts`, `browser-task-tool.ts`, `browser-task.ts`, `subagent-events.ts`, `tool-heartbeat.ts`, `host-services.ts`, `permissions.ts`, `main.ts`, `turn-usage.ts`, `todo-tool.ts`.
- `apps/desktop/src/main`: `services/session/cli-manager-service.ts`, `service-host.ts` (`emitNdjson`, `settleRoutineRun`, `feedTurnWaiter`), `services/session/session-turn-state-service.ts`, `services/session/cli-communication-service.ts`, `services/messaging/messaging-gateway-service.ts`, `services/session/session-artifacts*.ts`, `services/session/agent-session-manager-service.ts`, `services/diagnostics/agent-event-log.ts`.
- TanStack AI (ai 0.63 / ai-client 0.36): `packages/ai/src/types.ts` (the `AGUIEvent` union, `RunFinishedEvent`, `RunErrorEvent`, `CustomEvent`, `ApprovalRequestedEvent`, `TanStackRunMetadata`), `interrupts.ts`, `interrupt-serialization.ts`, `interrupt-resume.ts`, `activities/chat/agents/spawn.ts`, `ai-client/src/connection-adapters.ts`, `ai-client/src/chat-client.ts`, `docs/interrupts/*`, `docs/chat/stream-events.md`, `docs/chat/subagents.md`.
- pi-acp 0.17.1 (MIT): `src/acp/session.ts`, `src/acp/translate/tool-content.ts`.
- pi 0.85.1 (installed) and 0.99.1 (reference clone): `AgentSessionEvent`, `AssistantMessageEvent`, `AssistantMessage`, `StopReason`.

---

## 1. Scope and non-goals

### In scope

1. A new AG-UI wire for the agent child process.
   - stdout carries one AG-UI event per line.
   - stdin carries a small JSON-line command set whose central command is an AG-UI `RunAgentInput`.
2. `packages/agent/src/agui/`: the wire types, the emitter (a pure translator plus the run controller), the host, interrupt helpers, id helpers, the vendored pi-acp helpers, and a legacy view that main's taps can use during migration.
3. A process flag, `--wire ndjson|agui`, defaulting to `ndjson` until cut-over (phase 7). Both hosts drive the same `AbacusBotSession` / `BotSession`.
4. The minimum plumbing in the session layer for facts the NDJSON vocabulary never carried:
   - message boundaries with pi-derived ids;
   - streamed tool-call arguments;
   - explicit sub-agent attribution;
   - an explicit "the user-visible turn has settled" signal;
   - hidden-turn markers.

   All of it goes out as internal-only events and fields. The NDJSON host strips them, so NDJSON output stays byte-identical (§6.3).

### Non-goals (behaviour unchanged)

- None of these change: `AbacusBotSession` / `BotSession` logic, the permission gate (`gateToolCall`, `applyDecision`, allowances, audit lines), the sandbox (`askDenials`, `askNetworkHost`, `SandboxApprovals`), delegation and component tasks, continuations (malformed, compaction, OpenLLM rotation, language repair, tool arrival, stall), OpenLLM rotation, retries, the heartbeat timings, host services, MCP, skills, the queue semantics (steer, park behind a permission, run after stop), mode and model semantics, the `BotOutputSanitizer`, or `NO_REPLY` handling.
- No agent-side conversation history for the UI. Main keeps the replay ring (§5).
- No ACP presenter. The pi-acp helpers are vendored so that one can be added later.
- No changes to main or the renderer. §5 and §9.3 state what main's taps need from this wire. They are implemented in the "main oRPC contract + taps" slice.
- `CUSTOM bot.reply` is **not** added (§4). This supersedes the `CUSTOM bot.reply` wording in PLAN.md's protocol table and paragraph.
- The pi 0.85 to 0.99 bump is not part of this slice's diff. §8.2 lists what the bump must verify. It lands as its own commit, gated on the NDJSON goldens being unchanged.

---

## 2. Wire format

### 2.1 Framing

- **stdout**: one JSON object per line, UTF-8, `\n`-terminated.
  - Every line is an `AguiEvent` (§2.3). Nothing else is written to stdout. Diagnostics go to stderr, as today.
  - Every event carries `timestamp` (ms since epoch). Main assigns the replay sequence number (`lastEventId`). The agent does not.
- **stdin**: one JSON `AguiCommand` per line (§2.2). U+2028/U+2029 are escaped by the writer, as `serializeCommand` does today (`cli-manager-service.ts:178-182`).
  - A malformed line never kills the process. It produces `CUSTOM agent.error {code:"malformed_command"}` with today's text (`host.ts:109-119`).
  - A handler that throws produces `RUN_ERROR` if the command was a `run` whose run is still open. Otherwise it produces `CUSTOM agent.error` (`host.ts:127-131`).
- **Process flags** (`main.ts`):
  - `--wire ndjson|agui` (default `ndjson`).
  - `--thread-id <id>`, required with `agui`. It is used for server-initiated runs; client runs carry their own `threadId`.
  - `--auto-allow <tool,tool>`, optional with `agui` (§3.5.6).
  - `--model` and `--permission-mode` are unchanged.
  - `--sandbox-probe` is unchanged and not affected by `--wire`.
- **Run-scoped vs session-scoped events.**
  - Run-scoped: `TEXT_MESSAGE_*`, `REASONING_*`, `TOOL_CALL_*`, `SUBAGENT_*`, `STATE_DELTA` inside a turn, and the `CUSTOM` names marked *run* in §3.4. These appear only between a `RUN_STARTED` and its terminal event.
  - Session-scoped: `STATE_SNAPSHOT` and the `CUSTOM` names marked *session*. These may appear at any time, including outside a run. Main routes them to its non-chat consumers and may also relay them.

### 2.2 Commands (stdin)

`packages/agent/src/agui/wire.ts`:

```ts
import type {
  AgentMode,
  PermissionDecision,
  PermissionRequest,
  QueueEntry,
  SkillMetadata,
  CliMcpServerSnapshot,
  CliMcpLogEntry,
  CliMcpStatusEvent,
  NotificationAction,
  ToolDisplayData,
  AgentStatus,
  HostService,
} from "../protocol.js";
import type { TurnUsage } from "../turn-usage.js";

/** AG-UI RunAgentInput, as the TanStack SubscribeConnectionAdapter sends it (runContext + messages). */
export interface RunAgentInput {
  threadId: string;
  runId: string;
  parentRunId?: string;
  /** Full client history (UIMessage or ModelMessage shape). The agent reads only the newest user message (§3.1). */
  messages: WireMessage[];
  /** `clientTools` from the run context. Accepted and recorded; no agent tool is dispatched to them in this slice. */
  tools?: ClientToolDeclaration[];
  context?: unknown[];
  state?: unknown;
  forwardedProps?: RunForwardedProps;
  /** AG-UI interrupt resume entries for a continuation run (parentRunId = interrupted run). */
  resume?: ResumeEntry[];
}

export interface RunForwardedProps {
  /** Applied before the turn if it differs from the current mode (same path as `set_mode`). Omitted by main for bots. */
  mode?: string;
  /** Applied (awaited) before the turn if it differs (same path as `set_model`). */
  model?: string;
  /** Accepted, ignored: today's host drops `send.activeSkills` too (host.ts:156). */
  activeSkills?: string[];
  /** Accepted, ignored: one process owns one conversation; must equal threadId when present. */
  conversationId?: string;
}

export interface ClientToolDeclaration {
  name: string;
  description: string;
  parameters: unknown;
}

/** Either TanStack UIMessage (parts) or ModelMessage (content) shape. */
export interface WireMessage {
  id?: string;
  role: "user" | "assistant" | "system" | "developer" | "tool" | "reasoning";
  content?: string | Array<{ type: string; text?: string; content?: string }>;
  parts?: Array<{ type: string; content?: string; text?: string }>;
}

/** AG-UI ResumeEntry (TanStack RunAgentResumeItem). */
export type ResumeEntry =
  | { interruptId: string; status: "resolved"; payload?: unknown; metadata?: Record<string, unknown> }
  | { interruptId: string; status: "cancelled"; metadata?: Record<string, unknown> };

/** What a resolved permission interrupt's `payload` may be (§3.5.3). */
export type PermissionResolution =
  | { decision: PermissionDecision }
  | { approved: boolean; message?: string }
  | { answers: Record<string, string> };

export type AguiCommand =
  | { type: "run"; input: RunAgentInput }
  /** Stop the reply in flight (today's `stop`). `runId` is advisory; the host stops whatever is running. */
  | { type: "cancel"; runId?: string }
  | { type: "set_mode"; mode: string }
  | { type: "set_model"; model: string }
  | { type: "switch_conversation"; conversationId: string }
  | { type: "reset_conversation" }
  | { type: "list_skills" }
  | { type: "providers.refresh" }
  | { type: "queue.enqueue"; message: string; hidden?: boolean }
  | { type: "queue.dequeue" }
  | { type: "queue.get" }
  | { type: "queue.clear" }
  | { type: "queue.remove"; index: number }
  | { type: "queue.update"; index: number; message: string }
  | { type: "mcp.list_servers" }
  | { type: "mcp.refresh" }
  | { type: "mcp.restart_server"; serverId: string }
  | { type: "mcp.get_server_logs"; serverId: string }
  /** Main's answer to a host-service client-tool call (§3.7). toolCallId is the request id. */
  | { type: "client_tool_result"; toolCallId: string; ok: boolean; result?: unknown; error?: string };
```

Each command maps 1:1 to today's host (`host.ts:147-327`):

| AG-UI command | Today (`DesktopCommand`) | Host behaviour |
|---|---|---|
| `run` (no `resume`) | `send` | `runTurn(text)`, bracketed (§3.1) |
| `run` (with `resume`) | `permission_response` × n | `respondPermission` per entry, then `releaseParked()` (§3.5) |
| `cancel` | `stop` | `host.ts:160-182` unchanged, plus run closure (§3.8) |
| `set_mode` / `set_model` | same | `session.setMode` / `await session.setModel` |
| `switch_conversation`, `list_skills` | same | no-op, as today (`host.ts:283-287`) |
| `reset_conversation` | same | `host.ts:207-218`, plus closing any open run as `cancelled` (§3.8) |
| `providers.refresh` | `refresh_providers` | `session.refreshProviders()` |
| `queue.enqueue` | `enqueue` | `runTurn(message)`, which calls `admit` when busy (`host.ts:220-228`) |
| `queue.dequeue` / `queue.get` / `queue.clear` / `queue.remove` / `queue.update` | `dequeue` / `get_queue` / `clear_queue` / `remove_from_queue` / `update_queue_item` | `host.ts:230-281` unchanged |
| `mcp.list_servers` / `mcp.refresh` / `mcp.restart_server` / `mcp.get_server_logs` | `mcp_*` | `host.ts:289-312` unchanged |
| `client_tool_result` | `host_service_response` | `session.settleHostService(toolCallId, ok, result, error)` |

### 2.3 Events (stdout)

The event `type` names are the TanStack `AGUIEvent` union's names, verbatim (`packages/ai/src/types.ts:1759-1790`). They are declared locally so the agent does not depend on `@tanstack/ai` at runtime. A type-level conformance test (§7.6) asserts they stay assignable to `@tanstack/ai`'s `StreamChunk` and `@ag-ui/core@1.0.0`.

```ts
/** Every event the agent writes. A strict subset of TanStack's AGUIEvent union. */
export type AguiEvent =
  | RunStartedEvent
  | RunFinishedEvent
  | RunErrorEvent
  | TextMessageStartEvent
  | TextMessageContentEvent
  | TextMessageEndEvent
  | ReasoningStartEvent
  | ReasoningMessageStartEvent
  | ReasoningMessageContentEvent
  | ReasoningMessageEndEvent
  | ReasoningEndEvent
  | ToolCallStartEvent
  | ToolCallArgsEvent
  | ToolCallEndEvent
  | ToolCallResultEvent
  | StateSnapshotEvent
  | StateDeltaEvent
  | CustomEvent
  | SubagentStartedEvent
  | SubagentFinishedEvent
  | SubagentErrorEvent;
// Not emitted by the agent: STEP_STARTED/STEP_FINISHED, MESSAGES_SNAPSHOT, ACTIVITY_*, RAW,
// *_CHUNK, REASONING_ENCRYPTED_VALUE.

interface BaseEvent {
  timestamp: number;
  metadata?: Record<string, unknown>;
}

/** Events a sub-agent's work can carry, per AG-UI (TanStack attributes the same set). */
interface Attributable {
  subagentRunId?: string;
}

export interface RunStartedEvent extends BaseEvent {
  type: "RUN_STARTED";
  threadId: string;
  runId: string;
  parentRunId?: string;
  metadata?: { abacus?: { serverInitiated?: true; housekeeping?: true } };
}

/** @ag-ui/core RunFinishedOutcome, as TanStack uses it: success | interrupt | cancelled. */
export type RunFinishedOutcome =
  | { type: "success" }
  | { type: "interrupt"; interrupts: Interrupt[] }
  | { type: "cancelled" };

/** AG-UI spec usage[] item (@ag-ui/core TokenUsage). */
export interface SpecTokenUsage {
  provider?: string;
  model?: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
  reasoningTokens?: number;
}

/** pi StopReason (0.85 and 0.99). */
export type PiStopReason = "pending" | "stop" | "length" | "toolUse" | "error" | "aborted" | "deferred";
/** TanStackRunMetadata.finishReason. */
export type FinishReason = "stop" | "length" | "content_filter" | "tool_calls" | null;

export interface RunFinishedEvent extends BaseEvent {
  type: "RUN_FINISHED";
  threadId: string;
  runId: string;
  outcome: RunFinishedOutcome;
  result?: { stopReason?: PiStopReason; queued?: { entryId: string; waitingFor: QueueEntry["waitingFor"] } };
  usage?: SpecTokenUsage[];
  metadata?: {
    tanstack?: { model?: string; finishReason?: FinishReason };
    abacus?: { turnUsage?: TurnUsage; serverInitiated?: true; housekeeping?: true };
  };
}

export interface RunErrorEvent extends BaseEvent {
  type: "RUN_ERROR";
  message: string;
  code?: string;
  usage?: SpecTokenUsage[];
  /** threadId/runId ride in metadata.tanstack on the wire (TanStack RunErrorEvent convention). */
  metadata: {
    tanstack: { threadId: string; runId: string; model?: string };
    abacus: { error: AgentErrorPayload; turnUsage?: TurnUsage };
  };
}

/** Today's AgentEvent `error.error` payload, verbatim (protocol.ts:200-214). */
export interface AgentErrorPayload {
  message?: string;
  code?: string;
  name?: string;
  segmentData?: { message?: string; type?: string; [k: string]: unknown };
  detail?: string;
  actions?: NotificationAction[];
}

export interface TextMessageStartEvent extends BaseEvent, Attributable {
  type: "TEXT_MESSAGE_START";
  messageId: string;
  role: "assistant" | "user";
}
export interface TextMessageContentEvent extends BaseEvent, Attributable {
  type: "TEXT_MESSAGE_CONTENT";
  messageId: string;
  delta: string;
}
export interface TextMessageEndEvent extends BaseEvent, Attributable {
  type: "TEXT_MESSAGE_END";
  messageId: string;
}

export interface ReasoningStartEvent extends BaseEvent, Attributable {
  type: "REASONING_START";
  messageId: string;
}
export interface ReasoningMessageStartEvent extends BaseEvent, Attributable {
  type: "REASONING_MESSAGE_START";
  messageId: string;
  role: "reasoning";
}
export interface ReasoningMessageContentEvent extends BaseEvent, Attributable {
  type: "REASONING_MESSAGE_CONTENT";
  messageId: string;
  delta: string;
}
export interface ReasoningMessageEndEvent extends BaseEvent, Attributable {
  type: "REASONING_MESSAGE_END";
  messageId: string;
}
export interface ReasoningEndEvent extends BaseEvent, Attributable {
  type: "REASONING_END";
  messageId: string;
}

/** ACP ToolKind, as pi-acp's toToolKind returns it (extended in §6.2). */
export type ToolKind =
  | "read" | "edit" | "delete" | "move" | "search" | "execute" | "think" | "fetch" | "switch_mode" | "other";

export interface ToolCallMeta {
  /** pi's own tool name before TOOL_NAME_ALIASES (toolCallName carries the display name, as today). */
  rawName: string;
  kind: ToolKind;
  /** buildToolTitle(rawName, args); on START it is computed from whatever args are known. */
  title: string;
  /** Present on host-service client tools only (§3.7). */
  hostService?: HostService;
}

export interface ToolCallStartEvent extends BaseEvent, Attributable {
  type: "TOOL_CALL_START";
  toolCallId: string;
  /** Display name (TOOL_NAME_ALIASES / subagent-events DISPLAY_NAMES), identical to today's ToolRequest.name. */
  toolCallName: string;
  parentMessageId?: string;
  metadata?: { abacus: ToolCallMeta };
}
export interface ToolCallArgsEvent extends BaseEvent, Attributable {
  type: "TOOL_CALL_ARGS";
  toolCallId: string;
  delta: string;
}
export interface ToolCallEndEvent extends BaseEvent, Attributable {
  type: "TOOL_CALL_END";
  toolCallId: string;
  /** Parsed input rides in metadata.tanstack.input (spec TOOL_CALL_END has no top-level input). */
  metadata: { tanstack: { input: Record<string, unknown> }; abacus: ToolCallMeta };
}
export interface ToolCallResultEvent extends BaseEvent, Attributable {
  type: "TOOL_CALL_RESULT";
  /** `${toolCallId}:result` */
  messageId: string;
  toolCallId: string;
  role: "tool";
  /** JSON.stringify(ToolResultContent) */
  content: string;
}

/** The parsed TOOL_CALL_RESULT content. `text` is byte-identical to today's ToolResult.content. */
export interface ToolResultContent {
  text: string;
  isError: boolean;
  kind: ToolKind;
  title: string;
  /** Merged tool.display payloads for this call (diff before/after, additions, lineCount…). */
  display?: ToolDisplayData;
  /** Last streamed output for shell-like tools (tool.output). */
  terminal?: { output: string };
  /** pi-acp formatToolContent() rendering (markdown text) for renderers that want it. */
  formatted?: string;
  /** Set when the call never reported a result and the run closed it (§3.3.6). */
  unfinished?: true;
}

export interface AgentState {
  mode: AgentMode;
  modeSource: "startup" | "user" | "approval" | "bot";
  model: string;
  agentSessionId?: string;
  agentSessionFile?: string;
  /** Last successful `todo` set (todo-tool.ts); absent until one happens. */
  plan?: Array<{ content: string; status: "pending" | "in_progress" | "completed" }>;
}
export interface StateSnapshotEvent extends BaseEvent {
  type: "STATE_SNAPSHOT";
  snapshot: AgentState;
}
export type JsonPatchOp =
  | { op: "replace" | "add"; path: string; value: unknown }
  | { op: "remove"; path: string };
export interface StateDeltaEvent extends BaseEvent {
  type: "STATE_DELTA";
  delta: JsonPatchOp[];
}

export interface CustomEvent<N extends string = string, V = unknown> extends BaseEvent, Attributable {
  type: "CUSTOM";
  name: N;
  value: V;
}

export interface SubagentStartedEvent extends BaseEvent {
  type: "SUBAGENT_STARTED";
  subagentRunId: string;
  /** Today's subtask `kind` ("delegate" | "browser" | "component"), or "delegate" when absent. */
  name: string;
  description?: string;
  parentSubagentRunId?: string;
  parentToolCallId?: string;
  parentMessageId?: string;
  metadata?: { abacus: { kind?: string } };
}
export interface SubagentFinishedEvent extends BaseEvent {
  type: "SUBAGENT_FINISHED";
  subagentRunId: string;
  /** The child's final text when the tool emitted one (delegate/document/deck/design). */
  result?: string;
  outcome?: { type: "success" } | { type: "suspended"; interruptIds: string[] };
  /** Today's subtask_end.outcome ("needs-user" | "limit" | "budget"). */
  metadata?: { abacus: { outcome?: "needs-user" | "limit" | "budget" } };
}
export interface SubagentErrorEvent extends BaseEvent {
  type: "SUBAGENT_ERROR";
  subagentRunId: string;
  message: string;
  code?: "failed" | "unfinished" | "stopped";
}

/** AG-UI Interrupt (@ag-ui/core 1.0), fields as TanStack builds them (activities/chat/index.ts:2894-2915). */
export interface Interrupt {
  id: string;
  reason: string;
  message?: string;
  toolCallId?: string;
  responseSchema?: Record<string, unknown>;
  expiresAt?: string;
  subagentRunId?: string;
  metadata: PermissionInterruptMetadata;
}

export const INTERRUPT_BINDING_METADATA_KEY = "tanstack:interruptBinding";

/** TanStack InterruptBinding, generic variant (interrupts.ts). Emitted opened: run id and generation stamped. */
export interface GenericInterruptBinding {
  v: 1;
  kind: "generic";
  interruptId: string;
  interruptedRunId: string;
  generation: 0;
  expiresAt?: string;
  /** Present only when responseSchema is (ask_user_question); `sha256:` + hex of canonical JSON. */
  responseSchemaHash?: string;
}

export interface PermissionInterruptMetadata {
  [INTERRUPT_BINDING_METADATA_KEY]: GenericInterruptBinding;
  abacus: {
    kind: PermissionRequest["type"];
    /** Today's PermissionRequest, verbatim (protocol.ts:273-387). */
    request: PermissionRequest;
    /** How toolCallId was chosen (§3.5.4). */
    attachedBy: "gate" | "command-match" | "sole-running" | "none";
  };
}
```

`CUSTOM` names and payloads. The complete list; nothing else is emitted.

```ts
export type AbacusCustomEvent =
  // ── session-scoped ──────────────────────────────────────────────
  | CustomEvent<"session.ready", { model: string; mode: string; agentSessionId?: string; agentSessionFile?: string }>
  | CustomEvent<"session.cleared", Record<string, never>>
  | CustomEvent<"agent.status", { status: AgentStatus }>
  | CustomEvent<"agent.heartbeat", { runningTools: number }>
  | CustomEvent<"agent.error", AgentErrorPayload>
  | CustomEvent<"agent.notification", {
      message: string;
      severity: "info" | "warning" | "error" | "success";
      actions?: NotificationAction[];
      notificationKey?: string;
      [key: string]: unknown;
    }>
  /** Reserved: protocol.ts declares `credits`; nothing in the agent produces it today. */
  | CustomEvent<"agent.credits", { creditsUsed: number; counter?: number; messageId?: string }>
  | CustomEvent<"approval.cleared", { interruptId: string }>
  | CustomEvent<"approval.stale", { interruptIds: string[] }>
  | CustomEvent<"queue.updated", { messages: QueueEntry[]; dequeued: string | null }>
  | CustomEvent<"skills.loaded", { skills: SkillMetadata[] }>
  | CustomEvent<"mcp.servers", { servers: CliMcpServerSnapshot[] }>
  | CustomEvent<"mcp.server_logs", { serverId: string; entries: CliMcpLogEntry[] }>
  /** Reserved: declared in protocol.ts, no producer in the agent today. */
  | CustomEvent<"mcp.server_status", CliMcpStatusEvent>
  | CustomEvent<"mcp.server_log", CliMcpLogEntry>
  | CustomEvent<"mcp.refresh_failed", { error: string }>
  | CustomEvent<"mcp.restart_failed", { serverId: string; error: string }>
  // ── run-scoped ──────────────────────────────────────────────────
  | CustomEvent<"agent.retry", { attempt: number; maxAttempts: number; delayMs: number; isNetworkError: boolean }>
  | CustomEvent<"tool.output", { toolCallId: string; output: string }>
  | CustomEvent<"tool.display", { toolCallId: string; data: ToolDisplayData }>
  | CustomEvent<"queue.steered", { content: string }>
  | CustomEvent<"queue.dequeued", { content: string }>
  /** TanStack's own name (ApprovalRequestedEvent), emitted only for gate-attached requests (§3.5.2). */
  | CustomEvent<"approval-requested", {
      toolCallId: string;
      toolName: string;
      input: unknown;
      approval: { id: string; needsApproval: true };
    }>;
```

---

## 3. Semantics and complete mapping

### 3.1 Runs

**Run controller** (`agui/runs.ts`, owned by the host). At most one AG-UI run is open at a time. Its state machine:

```
idle ──run──▶ open ──settle──────────────▶ idle
               │ └─cancel/reset──────────▶ idle            (RUN_FINISHED cancelled)
               └─permission(s)─▶ interrupted ─run{resume}─▶ open (new runId, parentRunId = interrupted)
                                     │ └─expiry of last pending──▶ open (server run, parentRunId = interrupted)
                                     └─cancel──▶ server run opened and immediately closed cancelled
```

**Opening a client run.** A `run` arrives while the controller is `idle` and the host is not `busy`. The host then:

1. Emits `RUN_STARTED {threadId, runId, parentRunId?}` using the input's ids.
2. Applies `forwardedProps.mode` / `.model` if they differ. These are the same calls as the `set_mode` / `set_model` commands. The resulting `mode_changed` / `model_changed` become `STATE_DELTA` inside the run.
3. Extracts the newest `role:"user"` message's text:
   - UIMessage: the `parts[type=text].content` values joined with `"\n"`.
   - ModelMessage: `content` if it is a string, otherwise the joined `text` parts.

   If that message's `id` equals the last id this process ran, it is a replay: the host closes the run as `RUN_FINISHED success` without prompting.
4. Calls `runTurn(text)`.

An empty or whitespace-only text is dropped, as `isPrompt` does today (`host.ts:152`). The run then closes `success`.

**`run` while busy.** This is today's send-while-busy. `host.admit()` is unchanged and puts the message in the queue (steer, park, or next turn). AG-UI still needs the client's `runId` bracketed, or the client waits forever for its terminal. So the host emits a zero-length run:

```
RUN_STARTED{runId} → RUN_FINISHED{runId, outcome success, result.queued {entryId, waitingFor}}
```

The `CUSTOM queue.updated` between them comes from `emitQueue`. The renderer should use `queue.enqueue` while busy, which opens no run. This fallback exists only so that nothing hangs.

**`run` while interrupted, without `resume`.** Today this is a send during a permission prompt. The message is parked (`waitingFor:"permission"`), and the host emits the same zero-length run with `parentRunId` untouched. The pending interrupts stay pending.

**Server-initiated runs** have `runId = "srv-" + randomUUID()` and `metadata.abacus.serverInitiated = true`. They are opened by the host for:

- each message the queue drains after a turn (`host.ts:353-368`);
- `runAfterStop` (`host.ts:407-421`);
- `queue.dequeue` while idle (`host.ts:230-246`);
- continuations after an interrupt expired or was cancelled (§3.5.5);
- permissions raised in a bot housekeeping turn (§4).

When the run carries a user message that was not echoed (`!echoed.delete(id)`), it opens with:

```
CUSTOM queue.dequeued {content}
TEXT_MESSAGE_START {role:"user", messageId: `${runId}:user`} + TEXT_MESSAGE_CONTENT + TEXT_MESSAGE_END
```

Each drained `session.send()` gets its own run. The previous run is settled (terminal emitted) before the next `RUN_STARTED`.

**Settle.** This is how a run gets its terminal event. The run settles on the first of:

- (a) the internal `turn_settled` event, which the session emits at the end of the user-visible turn (§6.3);
- (b) the `session.send()` promise resolving or rejecting (the host wraps every `session.send` in `try/finally`);
- (c) `cancel`, once `session.stop()` resolves;
- (d) `reset_conversation`, once `session.resetConversation()` resolves.

At settle the controller:

1. Closes the open reasoning or text message, if any.
2. Closes still-open subagents (`SUBAGENT_ERROR code:"unfinished"`).
3. Emits `TOOL_CALL_RESULT {unfinished:true, isError:true, text:""}` for every announced call with no result. This mirrors the transport's "forget a tool that never reported a result at the turn boundary" (`transport-bridge.test.ts:833`).
4. Emits exactly one terminal:
   - `RUN_ERROR`, if a terminal-class error was recorded during the run (§3.2);
   - `RUN_FINISHED {outcome:{type:"cancelled"}}`, if the run is being cancelled;
   - otherwise `RUN_FINISHED {outcome:{type:"success"}}`.

   Both terminals carry:
   - `usage`: the last `turn_complete.usage`, if any, converted per §3.3.8;
   - `metadata.abacus.turnUsage`: the raw `TurnUsage`;
   - `result.stopReason`: the last assistant `stopReason` seen;
   - `metadata.tanstack.finishReason`: `toFinishReason(stopReason)` (§6.2);
   - `metadata.tanstack.model`: `currentModelReference()` as last reported.

**Superseded events.** After a `cancel` or `reset` closes a run, events from the superseded pi turn (`turn_complete`, a late `status`, a late `text_delta`) are dropped until the next `RUN_STARTED`. This is the same "superseded turn" rule as `host.ts:53-58` and main's post-Stop suppression (`session-turn-state-service.ts:129-141`). Session-scoped events are never dropped.

### 3.2 Errors: terminal or not

Today every turn failure is an `event: error`. Main ends the turn on the first `error` or on `status_changed: idle` (`session-turn-state-service.ts:160-167`, `messaging-gateway-service.ts:1209-1245`, `service-host.ts:3353-3358`).

Classification, applied by the emitter while a run is open:

| `error.code` | Class |
|---|---|
| `turn_failed` | terminal |
| absent (thrown in `send`, `session.ts:1249`, `bot-session.ts:540`; thrown in a handler, `host.ts:128`) | terminal |
| `startup_failed` (`host.ts:79`) | terminal if a run is open, otherwise `CUSTOM agent.error`; the process exits either way |
| `model_unavailable` | terminal **only if** no `agent_start` status (`agent.status: streaming`) has been seen in this run. This is the bot no-model path, `bot-session.ts:508`. Otherwise it is non-terminal (a `set_model` failure during a run). |
| `malformed_command` | never terminal |

- The **first** terminal-class error in a run becomes the run's `RUN_ERROR` at settle:
  - `message`: `error.message ?? error.segmentData?.message ?? "The agent reported an error."`
  - `code`: `error.code`
  - `metadata.abacus.error`: the full payload, including `actions` and `detail`
  - `metadata.tanstack`: `{threadId, runId}`

  It is **not** also emitted as `CUSTOM agent.error`, so there is one card, not two.
- Later terminal-class errors in the same run, and all non-terminal errors, are emitted immediately as `CUSTOM agent.error` with the verbatim payload. For example, `compactAndRetry` failing and then `reportTurnFailure` reading the same state.
- Errors outside a run are always `CUSTOM agent.error`.

Why this is at settle and not at emit time: `reportTurnFailure()` (`session.ts:1266`, `bot-session.ts:752`) runs **after** `finishTurn()` has already emitted `turn_complete` + `idle`. The failure is only known once `prompt()` resolves. The terminal must wait for it. Settle trigger (a) exists so a bot's hidden housekeeping turns (§4) do not delay the terminal.

### 3.3 Mapping table: every current emit site

Notation: `E` is the emitter. "drop" means nothing is written. "session" / "run" means the event's scope (§2.1). Every row cites the current emit site. The internal events added by this slice are listed in §6.3.

#### 3.3.1 `host.ts` (NdjsonHost; mirrored by `agui/host.ts`)

| Site | Today | AG-UI |
|---|---|---|
| `host.ts:79-85` | `error {code:"startup_failed"}` | `CUSTOM agent.error` (session). The process then exits non-zero as today. |
| `host.ts:109-119` | `error {code:"malformed_command"}` | `CUSTOM agent.error` (session), same text |
| `host.ts:127-131` | `error {message}` from a handler throw | `run` with its run still open: that run's terminal `RUN_ERROR` (first terminal). Otherwise `CUSTOM agent.error`. |
| `host.ts:176-179` | `status_changed: idle` after stop lands | `CUSTOM agent.status {status:"idle"}`, **preceded by** `RUN_FINISHED {outcome:{type:"cancelled"}}` for the open run (settle trigger (c)) |
| `host.ts:306-310` | `mcp_server_logs {serverId, entries:[]}` | `CUSTOM mcp.server_logs` (session) |
| `host.ts:362-365`, `host.ts:415-418` | `user_message_dequeued {content}` | Opens a server-initiated run: `CUSTOM queue.dequeued {content}` + user `TEXT_MESSAGE_*` (§3.1) |
| `host.ts:372-375` | `status_changed: idle` in `runTurn`'s finally | `CUSTOM agent.status {status:"idle"}` (session). Settle trigger (b) fires here first if nothing else settled the run. |
| `host.ts:468` | re-emit of `user_message_steered` | See `session.ts:1998` |
| `host.ts:479` | `queue_updated {messages, dequeued}` | `CUSTOM queue.updated {messages, dequeued}` (session) |
| `host.ts:452-457` (listener) | `permission_needed` / waiting status set `awaitingPermission` | Unchanged. The AG-UI host keeps the same listener on the internal stream, so parking behaviour is identical. |

#### 3.3.2 `session.ts` (AbacusBotSession)

| Site | Today | AG-UI |
|---|---|---|
| `:610-615` `HostServiceClient` emit | `host_service_request {requestId, service, payload}` | Client-tool call (§3.7): `TOOL_CALL_START {toolCallId: requestId, toolCallName: "host." + service, metadata.abacus.hostService}` → `TOOL_CALL_ARGS {delta: JSON(payload)}` → `TOOL_CALL_END`. No `TOOL_CALL_RESULT`. Emitted even with no open run (session-scoped exception). |
| `:640-642` `ToolHeartbeat` emit (`tool-heartbeat.ts:67`) | `heartbeat {runningTools}` | `CUSTOM agent.heartbeat {runningTools}` (session) |
| `:1024` roster `emit` | forwards tool events (delegate/document/design/deck/browser) | See §3.6 and the tool rows below |
| `:1060` → `:1092-1101` `emitReady` | `ready {model, mode, agentSessionId, agentSessionFile}` | `CUSTOM session.ready {…same}` then `STATE_SNAPSHOT {mode, modeSource, model, agentSessionId, agentSessionFile}` (session). Mode changes before ready (the startup `applyMode` at `:2648`) fold into the snapshot. |
| `:1069-1072` | `error {code:"model_unavailable"}` at startup | `CUSTOM agent.error` (session) |
| `:1076-1080` | `notification {severity:"warning"}` at startup | `CUSTOM agent.notification` (session) |
| `:1083` → `:3277-3288` `emitSkills` | `skills_loaded {skills}` | `CUSTOM skills.loaded {skills}` (session) |
| `:1084`, `:1104-1117`, `:1126`, `:1129`, `:749` | `mcp_servers {servers}` | `CUSTOM mcp.servers {servers}` (session) |
| `:1235-1238` | `status_changed: submitted` | `CUSTOM agent.status {status:"submitted"}` (run) |
| `:1249-1258` | `error` (thrown in `prompt`) | Terminal-class, becomes `RUN_ERROR` at settle (§3.2) |
| `:1275-1279` | `error {code:"turn_failed"}` (budget stop) | Terminal-class |
| `:1296-1309` | `error {code:"turn_failed", actions?, detail?}` (`reportTurnFailure`) | Terminal-class. `actions` (upgrade-abacus, free-pool-out, switch-model) ride in `metadata.abacus.error.actions`. |
| `:1454-1459` | `notification` (language repair) | `CUSTOM agent.notification` (run) |
| `:1478-1483` | `notification` (malformed tool call retry) | `CUSTOM agent.notification` (run) |
| `:1553-1560` | `error {code:"turn_failed", actions:[switch-model]}` (stall) | Terminal-class |
| `:1653-1659` | `error {code:"turn_failed"}` (compaction failed) | Terminal-class |
| `:1737-1746` | `error {code:"turn_failed", actions}` (pool exhausted during rotation) | Terminal-class |
| `:1767-1770`, `:2184-2187`, `:2233-2236` | `model_changed {model}` | `STATE_DELTA [{op:"replace", path:"/model", value}]` (run if one is open, else session) |
| `:1952-1956` (`finishTurn`) | `subtask_end {status:"failed"}` for component brackets still open | `SUBAGENT_ERROR {subagentRunId, code:"unfinished", message:"The component did not finish."}` |
| `:1962-1965` (`finishTurn`) | `turn_complete {usage?}` | No event. The controller records `usage` for the terminal (§3.3.8). |
| `:1967-1970` (`finishTurn`) | `status_changed: idle` | `CUSTOM agent.status {status:"idle"}` (run) |
| `:1998` (`noteSteerLanded`) | `user_message_steered {content}` (+ host re-emit and `queue_updated`) | `CUSTOM queue.steered {content}` + user `TEXT_MESSAGE_START/CONTENT/END` (`messageId: steer-<n>`) in the open run, then `CUSTOM queue.updated`. This also covers the steers produced by `accept_with_message` (`:3085-3087`) and `question_answers` (`:3107-3110`). |
| `:2033-2037` | `notification` (unknown mode) | `CUSTOM agent.notification` |
| `:2038-2042`, `:2078` (`applyMode`) | `mode_changed {mode, source}` | `STATE_DELTA [{replace /mode}, {replace /modeSource}]` (run if open, else session) |
| `:2096-2104` | `error {code:"model_unavailable"}` (setModel threw) | Non-terminal, so `CUSTOM agent.error` |
| `:2157-2163`, `:2172-2178` | `error {code:"model_unavailable"}` (`applyModel`) | Non-terminal, so `CUSTOM agent.error` |
| `:2214-2226` | `error {code:"model_unavailable", actions}` (`activateOpenLlm`) | Non-terminal, so `CUSTOM agent.error` |
| `:2347` (`resetConversation` → `emitReady`) | `ready` (new pi session id and file) | `CUSTOM session.ready` + `STATE_SNAPSHOT` (session) |
| `:2350` | `segments_cleared` | `CUSTOM session.cleared` (session), preceded by closing any open run as `cancelled` |
| `:2351` | `status_changed: idle` | `CUSTOM agent.status {status:"idle"}` |
| `:2366-2371` `agent_start` | `status_changed: streaming` | `CUSTOM agent.status {status:"streaming"}` (run). Marks "turn began" for §3.2. |
| `:2374-2381` `message_start` | (no event; assigns `msg-N`) | New internal `message_open` (§6.3), which becomes `TEXT_MESSAGE_START {messageId: piMessageId, role:"assistant"}` |
| `:2389-2420` `message_end` remainder | `text_delta {content: remainder, messageId}` | `TEXT_MESSAGE_CONTENT {messageId: piMessageId, delta}`. Then the internal `message_close` becomes `TEXT_MESSAGE_END` (after closing any open reasoning). |
| `:2422-2460` `tool_execution_start` | `subtask_start {id:"component-"+toolCallId, description, kind:"component"}` (`:2440-2445`) | `SUBAGENT_STARTED {subagentRunId: "component-"+toolCallId, name:"component", description, parentToolCallId: toolCallId, parentMessageId}` |
| same | `status_changed: executing-tool` (`:2453-2456`) | `CUSTOM agent.status {status:"executing-tool"}` |
| same | `tool_execution_start {tool}` (`:2457`) | If the call was not already announced: `TOOL_CALL_START` + `TOOL_CALL_ARGS {delta: JSON(input)}` + `TOOL_CALL_END {metadata.tanstack.input}`. If announced but not ended, `TOOL_CALL_END` only. Otherwise nothing. |
| `:2462-2475` `tool_execution_update` | `tool_output_update {toolCallId, output}` | `CUSTOM tool.output {toolCallId, output}` (run). The last value is kept for `ToolResultContent.terminal`. |
| `:2477-2510` `tool_execution_end` | `tool_execution_complete {tool, result:{id, content, rejected}}` (`:2487-2495`) | `TOOL_CALL_RESULT {messageId: toolCallId+":result", toolCallId, role:"tool", content: JSON(ToolResultContent)}`, where `text = resultText(result)` and `isError = event.isError === true`. For a successful `todo` call with `action:"set"`, `STATE_DELTA [{op:"replace", path:"/plan", value: todos}]` also follows. |
| same | `subtask_end {id, status}` (`:2502-2506`) | `completed`: `SUBAGENT_FINISHED {subagentRunId, outcome:{type:"success"}}`. `failed`: `SUBAGENT_ERROR {code:"failed", message:"The component failed."}`. |
| `:2512-2569` `agent_end` | (via `finishTurn`) | See the `finishTurn` rows |
| `:2572-2596` `auto_retry_start` | `retry {attempt, maxAttempts, delayMs, isNetworkError}` | `CUSTOM agent.retry {…}` (run). `STEP_*` is not used. |
| `:2601-2612` `text_delta` | `text_delta {content, messageId}` | `TEXT_MESSAGE_CONTENT {messageId: piMessageId, delta}`. An open reasoning block is closed first (`REASONING_MESSAGE_END` + `REASONING_END`). |
| `:2614-2623` `thinking_delta` | `thinking_delta {content}` | If no reasoning block is open: `REASONING_START` + `REASONING_MESSAGE_START {messageId: piMessageId+":think:"+n, role:"reasoning"}`. Then `REASONING_MESSAGE_CONTENT {delta}`. |
| `:2625-2627` `thinking_end` | `thinking_complete` | `REASONING_MESSAGE_END` + `REASONING_END` for the open block |
| `:2650` `tool_call` hook entry (new) | none | Internal `tool_call_start` with the display name and input. `E` announces the call: `TOOL_CALL_START {parentMessageId: last assistant message}` + `ARGS` + `END` if not already streamed (§3.3.5). |
| `:2697-2704` (gate, edit_file) | `tool_display_data {toolCallId, data:{originalContent, newContent}}` | `CUSTOM tool.display {toolCallId, data}` (run). Merged into `ToolResultContent.display`. |
| `:2734-2742` (gate) | `permission_needed {permissionId, request}` + `status_changed: waiting-for-tool-permission` | §3.5. Adds the interrupt to the open batch, `approval-requested` CUSTOM, then `RUN_FINISHED {outcome: interrupt}`. The status goes out as `CUSTOM agent.status` **before** the terminal. |
| `:2777` (`awaitDecision` timeout) | `permission_cleared {permissionId}` | `CUSTOM approval.cleared {interruptId}` (session), then the expiry continuation (§3.5.5) |
| `:2862-2867` (`askDenials`) | `permission_needed {sandbox_denied}` + waiting status | §3.5, with `toolCallId` attached per §3.5.4 |
| `:2869-2872` | `status_changed: executing-tool` after the decision | `CUSTOM agent.status` in the resumed run |
| `:2927-2932`, `:2935-2938` (`askNetworkHost`) | `permission_needed {network_host}` + statuses | Same as `askDenials` |
| `:3192` (`rejectAllPending`) | `permission_cleared {permissionId}` | `CUSTOM approval.cleared {interruptId}` (session) |
| `:3290-3292` `emitAgentEvent` | `{type:"event", event}` wrapper | Replaced by the internal sink (§6.3) |

#### 3.3.3 `bot/bot-session.ts` (BotSession)

The bot rows map the same way as the session rows. Rows marked **H** are suppressed while a hidden housekeeping turn runs (§4).

| Site | Today | AG-UI |
|---|---|---|
| `:217` heartbeat | `heartbeat` | `CUSTOM agent.heartbeat` (H: dropped) |
| `:403` browser task `emit` | subtask events and child tools | §3.6 |
| `:438`, `:1010`, `:1560-1571` `emitReady` | `ready` | `CUSTOM session.ready` + `STATE_SNAPSHOT` (`modeSource:"bot"`) |
| `:441-446` | `error {model_unavailable}` at startup | `CUSTOM agent.error` |
| `:448` | `skills_loaded {skills:[]}` | `CUSTOM skills.loaded {skills:[]}` |
| `:449`, `:1024`, `:1061-1072` | `mcp_servers` | `CUSTOM mcp.servers` |
| `:508-511` | `error {model_unavailable}` (no usable model, before any turn) | Terminal (no `agent_start` in the run), so `RUN_ERROR {code:"model_unavailable"}` |
| `:529-532` | `status_changed: submitted` | `CUSTOM agent.status` |
| `:540-546` | `error` (thrown, with upgrade actions) | Terminal |
| `:721-729`, `:761-768` | `error {turn_failed}` | Terminal |
| `:796` | `user_message_steered` | As `session.ts:1998` |
| `:836-845`, `:851`, `:1481-1485` | `notification` / `mode_changed {source:"bot"}` | `CUSTOM agent.notification` / `STATE_DELTA` (`modeSource:"bot"`) |
| `:886-889`, `:957-960` | `model_changed` | `STATE_DELTA /model` |
| `:942-948` | `error {model_unavailable}` (setModel) | Non-terminal, so `CUSTOM agent.error` |
| `:1013-1014` | `segments_cleared`, `idle` | `CUSTOM session.cleared`, `CUSTOM agent.status` |
| `:1098-1101` `agent_start` | `status_changed: streaming` (**not** hidden-guarded today) | `CUSTOM agent.status` (H: dropped) |
| `:1105-1113` `message_start` | none (`msg-N`, sanitizer reset) | Internal `message_open`, **skipped when `hiddenTurn`** |
| `:1129-1134` | `text_delta` (sanitized `text`) | `TEXT_MESSAGE_CONTENT`. The content is already sanitized (§4). |
| `:1137`, `:1140-1143` | `thinking_delta` (sanitizer-extracted `<think>` and native thinking) | `REASONING_*` as in the session rows |
| `:1145` | `thinking_complete` | `REASONING_MESSAGE_END` + `REASONING_END` |
| `:1165-1176`, `:1187-1199` `message_end` | tail `thinking_delta` / `text_delta` (sanitized) | `REASONING_*` / `TEXT_MESSAGE_CONTENT`, then internal `message_close` → `TEXT_MESSAGE_END` |
| `:1224-1228` | `executing-tool` + `tool_execution_start` | As `session.ts:2453-2457` |
| `:1242-1246` | `tool_output_update` | `CUSTOM tool.output` |
| `:1263-1271` | `tool_execution_complete` | `TOOL_CALL_RESULT` |
| `:1323-1331` `auto_retry_start` | `retry` (not hidden-guarded today) | `CUSTOM agent.retry` (H: dropped) |
| `:1369-1374` `finishTurn` | `turn_complete`, `idle` (not hidden-guarded today) | Usage recorded; `CUSTOM agent.status` (H: dropped; hidden usage goes to stderr, §4) |
| `:1382` `tool_call` hook entry (new) | none | Internal `tool_call_start` (H: skipped) |
| `:1418-1425` | `tool_display_data` | `CUSTOM tool.display` |
| `:1428-1436` | `permission_needed` + waiting status | §3.5 (in H: a housekeeping server run, §4) |
| `:1443` | `permission_cleared` (timeout) | `CUSTOM approval.cleared` + expiry continuation |
| `:1553` | `permission_cleared` (`rejectAllPending`) | `CUSTOM approval.cleared` |

#### 3.3.4 Sub-agents and component tools

| Site | Today | AG-UI |
|---|---|---|
| `delegate-tool.ts:100-105` | `subtask_start {id:"delegate-…", description, kind:"delegate"}` | `SUBAGENT_STARTED {subagentRunId: id, name:"delegate", description, parentToolCallId: execute's toolCallId, parentMessageId}` |
| `delegate-tool.ts:123` | `text_delta {content: result.text}` (no messageId, inside the bracket) | Child text message `TEXT_MESSAGE_START/CONTENT/END {messageId: id+":final", subagentRunId}`. The text is also kept as `SUBAGENT_FINISHED.result`. |
| `delegate-tool.ts:125` | `subtask_end {id, status}` | `completed`: `SUBAGENT_FINISHED {subagentRunId, result, outcome:{type:"success"}}`. `failed`: `SUBAGENT_ERROR {code:"failed", message: result text \|\| "The sub-agent did not finish."}`. |
| `document-tool.ts:112-117 / :137 / :139` | same trio, `kind:"delegate"` | Same mapping. `name` is `"delegate"`, as today's kind. |
| `deck-tool.ts:120-125 / :145 / :147` | same trio | Same mapping |
| `design-tool.ts:133-138 / :165 / :167` | same trio | Same mapping |
| `browser-task-tool.ts:244-249` | `subtask_start {kind:"browser"}` | `SUBAGENT_STARTED {name:"browser"}` |
| `browser-task-tool.ts:273-278` | `subtask_end {status, outcome?}` | `SUBAGENT_FINISHED {outcome:{type:"success"}, metadata.abacus.outcome}` or `SUBAGENT_ERROR {code:"failed"}`. `"needs-user"` / `"limit"` / `"budget"` stay in `metadata.abacus.outcome`; they are not AG-UI `suspended` (no interrupt is involved). |
| `browser-task.ts:536-540` | child `text_delta {content, messageId:"web-N"}` | `TEXT_MESSAGE_START/CONTENT/END {messageId: subagentRunId+":web-N", subagentRunId}`. Each new `web-N` closes the previous child message. |
| `subagent-events.ts:89-97` (`forwardChildToolEvents` start; prefixes `sub`/`doc`/`deck`/`des`/`web`) | `tool_execution_start {tool:{id: prefix+"-"+id}}` | `TOOL_CALL_START/ARGS/END {toolCallId: prefixed id, subagentRunId}` |
| `subagent-events.ts:113-121` | `tool_execution_complete` | `TOOL_CALL_RESULT {subagentRunId}` |
| `subagent-events.ts:131-144` (`settle`) | synthetic `tool_execution_complete {rejected:true, "The sub-agent stopped before this finished."}` | `TOOL_CALL_RESULT {isError:true, text: same}` (tagged) |
| `delegation.ts:74`, `document-task.ts:431`, `deck-task.ts:406`, `design-task.ts:292`, `browser-task.ts:439` | construct the forwarders | Receive the **scoped** emit (§3.6), so every event they forward carries `subagentRunId` |

#### 3.3.5 Tool-call streaming (new facts, additive)

pi's `AssistantMessageEvent` carries `toolcall_start` / `toolcall_delta` / `toolcall_end {toolCall}`. Today `onStreamEvent` (`session.ts:2599`) and the bot stream branch (`bot-session.ts:1115`) ignore them. In AG-UI mode the session emits them as the internal events `tool_call_start` / `tool_call_delta` / `tool_call_stop`. Those names already exist in `protocol.ts:126-133`, but nothing produced them. The NDJSON host strips them.

The strip matters: main's messaging gateway resets its reply buffer on `tool_call_start` (`messaging-gateway-service.ts:1199-1204`). Letting them reach NDJSON would change reply extraction.

Emitter rules per `toolCallId`:

- `TOOL_CALL_START` is emitted once, at the first of: stream `toolcall_start`, the gate's internal `tool_call_start`, or `tool_execution_start`.
- `TOOL_CALL_ARGS` streams the `toolcall_delta` deltas. If no delta was streamed, one `ARGS` carries `JSON.stringify(input)` at the first sighting that has the input.
- `TOOL_CALL_END` is emitted once, at the first of `toolcall_end`, the gate hook, or `tool_execution_start`. It carries `metadata.tanstack.input` (the parsed args) and `metadata.abacus` (`rawName`, `kind`, `title` recomputed with full args).
- The order `START < ARGS* < END < RESULT` is guaranteed. `RESULT` is emitted at most once.

#### 3.3.6 Tool calls that never finish

pi may block a call at the gate (`{block:true, reason}`). Its result then arrives as a normal `tool_execution_end {isError:true}`; §7 asserts this on pi 0.85 and 0.99. Anything still unresolved at settle is closed with `TOOL_CALL_RESULT {unfinished:true, isError:true}`.

#### 3.3.7 Ids

- **Assistant `messageId`** is `${agentSessionId}:${message.timestamp}`. The timestamp is the pi `AssistantMessage.timestamp` present on the `message_start` partial. The same message is persisted in the pi session file with the same `timestamp`, and the file header carries the session id, so the id can be re-derived from the file (migration, §5). A collision within one process gets the suffix `:2`, `:3`, and so on. The legacy `msg-N` stays on the NDJSON wire; the internal `message_open` carries both, and `E` rewrites.
- **Tool call ids** are pi's (provider ids), unchanged. Child calls keep today's prefixed ids.
- **Tool result message id** is `${toolCallId}:result`.
- **Reasoning id** is `${messageId}:think:${n}`.
- **User message ids** are `${runId}:user` for dequeued messages and `steer-${n}` for steers.
- **Interrupt id** is today's `permissionId` (`perm-N`).
- **Subagent run id** is today's subtask id (`delegate-…`, `browser-…`, `document-…`, `deck-…`, `design-…`, `component-<toolCallId>`).

#### 3.3.8 Usage

`turn_complete.usage` (`TurnUsage {input, output, cacheRead, cacheWrite, requests, model}`, `turn-usage.ts`) becomes:

```
usage: [{ model: usage.model ?? undefined,
          inputTokens: input, outputTokens: output,
          cachedInputTokens: cacheRead, cacheWriteInputTokens: cacheWrite,
          totalTokens: input + output + cacheRead + cacheWrite }]
metadata.abacus.turnUsage: <TurnUsage verbatim>
```

The raw value is kept because main's cache-miss logger reads exactly these fields (`agent-event-log.ts:66-89`). If several `turn_complete` events land in one run, for example a continuation that ended and restarted, the last one wins, as main's logger does today.

### 3.4 Status

`agent.status` stays a `CUSTOM` event so that avatar mood, the notch and diagnostics keep the exact `AgentStatus` vocabulary. Run state is **not** derived from it: runs are derived from `RUN_*` only.

- It is run-scoped in content but emitted even when no run is open. For example, the `idle` from `host.ts:176` goes out after the cancelled terminal.
- Main may drop it from the chat stream.

### 3.5 Permissions: interrupts

#### 3.5.1 Emission

When `permission_needed {permissionId, request}` arrives while a run is open:

1. Build the `Interrupt`:
   - `id`: `permissionId`
   - `reason`:
     - `"abacus:permission"` for every kind except `ask_user_question`;
     - `"abacus:question"` for `ask_user_question`.
   - `message`: `request.displayName`
   - `toolCallId`: per §3.5.4
   - `expiresAt`: the ISO time of the approval deadline when `approvalTimeoutMs()` is finite (`session.ts:458`, `bot-session.ts:153`)
   - `metadata`:
     - `abacus`: `{kind: request.type, request, attachedBy}`
     - `tanstack:interruptBinding`: `{v:1, kind:"generic", interruptId, interruptedRunId: <this runId>, generation:0, expiresAt}`
   - `responseSchema`: only for `ask_user_question`, where it is:

     ```
     {type:"object", properties:{answers:{type:"object", additionalProperties:{type:"string"}}}, required:["answers"]}
     ```

     The binding then carries `responseSchemaHash = "sha256:" + hex(sha256(canonicalJson(schema)))`, identical to TanStack's `digestInterruptJson(canonicalInterruptJson(schema))`. Other kinds carry no schema, so they resolve as an unvalidated generic.
2. If the request is gate-attached (§3.5.4, `attachedBy:"gate"`), also emit:

   ```
   CUSTOM approval-requested {toolCallId, toolName: request.tool.name, input: request.tool.input,
                              approval: {id: permissionId, needsApproval: true}}
   ```

   This flips the tool part to `approval-requested` state inline (`processor.ts:2559-2590`). The native interrupt stays the source of truth. There is a risk that the client pairs legacy and native items (§8.3).
3. Emit `CUSTOM agent.status {status:"waiting-for-tool-permission"}`. It is on the internal stream anyway.
4. Open a **batch window** of `INTERRUPT_BATCH_MS = 25` ms. Parallel tool calls can raise several prompts at once, and TanStack batches are all-or-nothing. Every further `permission_needed` inside the window joins the batch.
5. When the window closes:
   - close open text and reasoning;
   - emit `RUN_FINISHED {outcome:{type:"interrupt", interrupts:[…batch]}, result.stopReason:"toolUse"}`.

   The controller goes to `interrupted`. The pi turn is still suspended in-process on `awaitDecision`, and nothing is aborted. No usage is attached, because the turn has not ended.

A `permission_needed` that arrives while `interrupted` goes into `nextBatch`. It is emitted as the interrupt outcome of the next run: the resume run or the expiry continuation. It closes that run right after its `RUN_STARTED`, following steps 4 and 5.

A `permission_needed` that arrives with no run open and not `interrupted` has two cases:

- A bot housekeeping turn, or a late sandbox ask after settle, opens a server-initiated run (`metadata.abacus.housekeeping` when it is hidden) and proceeds as above. Today such a card would appear too.

#### 3.5.2 Buffering while interrupted

Between the interrupt terminal and the next `RUN_STARTED`, the turn may keep producing run-scoped events. A sibling tool may finish, or a browser sub-agent may keep streaming.

These events are **buffered in order**. They are flushed right after the next `RUN_STARTED`:

- the resume run,
- the expiry continuation (§3.5.5), or
- a server run opened at settle.

Session-scoped events pass through while interrupted: `agent.heartbeat`, `agent.status`, `approval.cleared`, `queue.updated`, `mcp.*`, `skills.loaded`, `STATE_*`, and host-service calls. The buffer is capped at 5,000 events. Past the cap, the oldest `tool.output` updates are coalesced (only the latest per `toolCallId` is kept); nothing else is dropped.

#### 3.5.3 Resume

A `run` arrives with `resume[]`, `parentRunId` equal to the interrupted run, and a fresh `runId`. The host:

1. Emits `RUN_STARTED {runId, parentRunId}`.
2. For each `ResumeEntry`, in array order, converts it to a `PermissionDecision` and calls `session.respondPermission(interruptId, decision)`:

   | Entry | Decision |
   |---|---|
   | `status:"resolved", payload:{decision}` | `decision`, validated against the `PermissionDecision` union; an invalid value becomes `"reject"` |
   | `payload:{approved:true}` | `"accept"`; with `message`, `{type:"accept_with_message", message}` |
   | `payload:{approved:false}` | `"reject"`; with `message`, `{type:"reject_with_message", message}` |
   | `payload:{answers}` | `{type:"question_answers", answers}` |
   | `status:"cancelled"` | `"reject"`. This matches TanStack's "cancel abandons the pause"; the gate reads it as a rejection, the same as a card nobody answers except that it is immediate. |

3. Sets `awaitingPermission = false` and runs `releaseParked()`, which is exactly `host.ts:199-205`.
4. Flushes the buffer (§3.5.2).
5. If `nextBatch` is non-empty, closes this run with it (§3.5.1).

Ids behave as follows:

- **Unknown ids**, meaning expired, from a previous process, or already answered, are ignored. If *no* entry matched a pending permission, the host emits `CUSTOM approval.stale {interruptIds}` and closes the run `RUN_FINISHED success`. A continuation that ends without an interrupt clears the client's pending items.
- **Pending ids missing** from `resume` stay pending and are re-emitted as this run's interrupt outcome (§3.5.1 steps 4 and 5).

Messages in a resume `run` are ignored. The client resends history; the agent does not use it.

#### 3.5.4 Which tool call an interrupt attaches to

| Request source | `toolCallId` | `attachedBy` |
|---|---|---|
| Gate (`session.ts:2650`, `bot-session.ts:1382`), all kinds except `sandbox_denied` / `network_host` | `request.tool.id` (pi's `event.toolCallId`) | `gate` |
| `askDenials` (`session.ts:2830`), `sandbox_denied` | The most recently started, still-running call whose `input.command === request.command`. This covers main-thread and child calls (child ids are prefixed). The interrupt also gets that call's `subagentRunId`. | `command-match` |
| `askNetworkHost` (`session.ts:2900`), or `askDenials` with no command match | The single running `bash` call, if exactly one is running | `sole-running` |
| otherwise | none. It renders in the Interrupts slot. | `none` |

The request's own synthetic `tool` (`{id: permissionId, name:"sandbox"|"network"}`) is left untouched inside `metadata.abacus.request`.

#### 3.5.5 Expiry, reject-all, cancel while interrupted

- **Expiry** (`awaitDecision` timer, `session.ts:2777`; `bot-session.ts:1443`):
  - `CUSTOM approval.cleared {interruptId}` is emitted immediately.
  - When the *last* pending interrupt of the interrupted run clears, the host opens a server-initiated continuation right away: `RUN_STARTED {runId: srv-…, parentRunId: interruptedRunId}`. It then flushes the buffer. That run then settles normally, and the turn continues with today's rejection text.
- **`rejectAllPending`** (`session.ts:3188`, `bot-session.ts:1550`, from stop and reset) emits `CUSTOM approval.cleared` per id.
- **`cancel` while interrupted**:
  - `session.stop()` runs, exactly as today.
  - The buffered events are discarded, because they belong to the superseded turn.
  - The host opens and immediately closes a server continuation `{parentRunId: interruptedRunId}` with `RUN_FINISHED {outcome:{type:"cancelled"}}`. This clears the client's pending interrupts.
  - `runAfterStop` then proceeds.

#### 3.5.6 Browser auto-allow

Today main auto-accepts `browser_navigate` and `browser_snapshot` (`cli-communication-service.ts:38-41`, `service-host.ts:1231-1238`), after the card was already forwarded.

In `agui` mode main passes `--auto-allow browser_navigate,browser_snapshot`. The AG-UI host then answers any `permission_needed` whose `request.tool.name` is in that list:

- It calls `session.respondPermission(id, "accept")` synchronously. This is the same call and the same audit lines (`recordApproval` asked/decided) as today.
- It emits nothing for that request: no interrupt and no `approval-requested`. The waiting status is swallowed too, so the next status is `executing-tool`.

This is the only place the host answers a permission itself. It exists because answering from main would mean main starting a continuation run behind the client's back. Main's `autoAllowDecision` stays for `ndjson` mode.

### 3.6 Sub-agent attribution

Today, attribution is positional: events between `subtask_start` and `subtask_end` "belong to the card". Parallel tool calls make this ambiguous (`transport-bridge.test.ts:710-848`). AG-UI needs an explicit `subagentRunId`, so:

- **`scopeEmit(emit, subagentRunId)`** (`agui/scope.ts`, pure): returns an emit function that stamps `subagentRunId` on every event it forwards. If an inner `subtask_start` passes through a scope, that scope becomes `parentSubagentRunId`. Nested delegation does not exist today (sub-agents cannot delegate), but the path is covered.
- The five subtask-opening tools pass `scopeEmit(emit, subtaskId)` into `runDelegatedTask` / `runDocumentTask` / `runDeckTask` / `runDesignTask` / `runBrowserTask`. They also add `parentToolCallId: _toolCallId` (from `execute`'s first argument) to their `subtask_start`:
  - `delegate-tool.ts:74`, `:100`, `:112`
  - `document-tool.ts:73`, `:112`, `:122-128`
  - `deck-tool.ts:77`, `:120`, `:135`
  - `design-tool.ts:90`, `:133`, `:155`
  - `browser-task-tool.ts:185`, `:244`, `:258`

  Their own final `text_delta` and `subtask_end` also go through the scope, and `E` treats them as described in §3.3.4.
- Component subtasks (`session.ts:2440`) have no child events. `parentToolCallId` is the tool call itself.
- `E` keeps `open subagents: Map<subagentRunId, {parentToolCallId, finalText?}>`. At settle, any still open are closed with `SUBAGENT_ERROR {code:"unfinished"}`.
- **Stop from a card.** TanStack `SubagentHandle.stop()` aborts the current parent run (`docs/chat/subagents.md:417`). The renderer sends `cancel`. That is today's Stop, which aborts the whole turn, so the behaviour is equal.
- Child events never carry a pi `parentToolCallId`. pi 0.99's `WithParentToolCallId` on `AgentSessionEvent` is not used: child sessions are subscribed separately and their events are forwarded explicitly.

### 3.7 Host services as client tools

`HostServiceClient.request` (`host-services.ts:39-60`) becomes a client-tool call. Its emit callback is rewired in `session.ts:607-616`:

```
TOOL_CALL_START {toolCallId: requestId ("host-N"), toolCallName: "host." + service,
                 metadata.abacus: {rawName: service, kind:"other", title: service, hostService: service}}
TOOL_CALL_ARGS  {toolCallId, delta: JSON.stringify(payload)}
TOOL_CALL_END   {toolCallId, metadata.tanstack.input: payload}
```

- The answer is the stdin command `client_tool_result {toolCallId, ok, result?, error?}`, which calls `settleHostService`. Timeout (120 s) and `failAll` on stop are unchanged.
- No `TOOL_CALL_RESULT` is emitted.
- These calls are emitted whether or not a run is open, and they bypass the §3.5.2 buffer, because the render must proceed while a sibling permission is pending, as today.
- **Main contract.** Main's host-service tap answers them. Today's `runHostService` handles `render_document`, `document_templates`, `design_catalog`, `render_design`, `deck_templates`, `deck_slots`, `render_deck` (`service-host.ts:1360-1379`). Main **strips** every `TOOL_CALL_*` whose `toolCallName` starts with `host.` from the renderer stream and the replay ring, because the payloads are large. `run.tools` (client tools declared by the renderer) is not consulted for them.

### 3.8 Cancel, reset, exit: the abort path and the "always a terminal" guarantee

- **`cancel`**: exactly `host.ts:160-182`, in this order:
  1. The queue entries' `waitingFor` becomes `"turn"`, and `CUSTOM queue.updated` is emitted.
  2. `turn += 1`, `stopping = true`, then `await session.stop()`.
     - `rejectAllPending` → `approval.cleared`
     - `hostServices.failAll`
     - steer queue cleared
     - `abort`
  3. `stopping = false`, `busy = false`.
  4. The controller closes the open run: `RUN_FINISHED {outcome:{type:"cancelled"}, result.stopReason:"aborted", usage?}`. If `interrupted`, it uses §3.5.5 instead.
  5. `CUSTOM agent.status {status:"idle"}`.
  6. `runAfterStop()`, which may open a server run.
- **`reset_conversation`**: `host.ts:207-218`.
  - An open run closes `cancelled`, and a pending interrupt batch is cleared as in §3.5.5.
  - Then come `CUSTOM session.ready` (new `agentSessionId` / `agentSessionFile`), `STATE_SNAPSHOT`, `CUSTOM session.cleared`, and `CUSTOM agent.status {idle}`.
- **stdin EOF**: `host.ts:138-145`.
  - The host waits for in-flight commands.
  - Any run still open is closed with `RUN_ERROR {code:"agent_exit", message:"The agent stopped before the reply finished."}`.
  - Then `dispose()` and `shutdownRuntime()` run.
- **Crash**: the `uncaughtException` handler in `main.ts:18-29`, before `process.exit(1)`, and `process.on("exit")`. `host.emergencyClose(reason)` writes the terminal for an open run with `fs.writeSync(1, …)` (synchronous; the stdout stream may not flush):
  - `RUN_ERROR {code:"agent_crashed"}` from the exception handler;
  - `RUN_ERROR {code:"agent_exit"}` on exit.

  It is idempotent.
- **Settle guard** (structural): every path that opens a run registers it with the controller, and the host wraps every `session.send()` in `try/finally { runs.settle() }`. `settle()` on an already-closed run is a no-op. `RUN_STARTED` is emitted only through `runs.open()`, which throws if a run is already open. A test asserts this.
- **Run watchdog** (backstop; main's watchdog stays primary):
  - `agui/watchdog.ts` arms while a run is `open`. It is not armed while interrupted, matching main, which does not arm during `waiting_permission` (`session-turn-state-service.ts:193-199`).
  - It resets on every emitted event, heartbeats included.
  - After `ABACUSAI_BOT_RUN_SILENCE_MS` (default 11 min, one minute after main's 10-minute `INACTIVITY_TIMEOUT_MS`, `session-turn-state-service.ts:14`), it does what main's timeout does today (`service-host.ts:1463-1488`):
    1. `session.stop()`.
    2. `RUN_ERROR {code:"inactivity_timeout", message:"Agent timed out: nothing came back for 11 minutes."}` instead of `cancelled`.
    3. The superseded events are dropped.
  - With main attached it never fires first. It exists for a headless host (the future `abacusai-bot web`) and for a main whose watchdog failed. `0` disables it.
- **Guarantee** (tested, §7.3): for every `RUN_STARTED{runId}` on stdout there is exactly one later `RUN_FINISHED{runId}` or `RUN_ERROR{metadata.tanstack.runId}`, before any other `RUN_STARTED` and before the process exits. The only exception is SIGKILL, which main covers by synthesizing `RUN_ERROR {code:"agent_exited"}` on child close (`emitSessionClosed`, `service-host.ts:1272-1299`).

---

## 4. Bot loop

- **Hidden turns are never emitted.**
  - `runHiddenTurn` (`bot-session.ts:587-608`) wraps `sendCustomMessage` in the internal `hidden_turn {phase:"start"}` … `{phase:"end"}` markers (§6.3).
  - `E` drops every run-scoped event and every `agent.status`, `agent.retry` and `agent.heartbeat` between them, **including the ones the bot loop leaks today**:
    - `agent_start` → streaming (`:1098`)
    - `auto_retry_start` (`:1323`)
    - `finishTurn`'s `turn_complete`/`idle` (`:1369-1374`)
    - heartbeat (`:217`)
  - Hidden-turn usage is written to stderr as one `[usage] housekeeping <customType> <TurnUsage JSON>` line, so it is not lost from the logs.
  - The one exception is a permission request raised inside a hidden turn. It opens a housekeeping server run (§3.5.1) so it can be answered, as today's card could be.
- **The terminal is not delayed by housekeeping.** `BotSession.send` emits `turn_settled` after `reportTurnFailure()` and **before** `runMemoryMaintenance()` (`bot-session.ts:537-538`), and also in its `catch` (`:540`) and after the no-model error (`:508`). The user's run therefore closes when the user-visible reply ends, not after the flush and consolidation turns. The host stays `busy` until `send()` resolves, exactly as today, so queueing and steering behaviour is unchanged. This includes today's quirk that a message sent during a housekeeping turn is steered into it (§8.3).
- **Sanitiser first.** `BotOutputSanitizer.push/flush` and `tidyBotText` are applied inside `bot-session.ts` (`:1126`, `:1159-1160`, `:1179-1182`) **before** any `text_delta` / `thinking_delta` is emitted.
  - `E` consumes only those internal events and never subscribes to pi directly. So every `TEXT_MESSAGE_CONTENT` of a bot is post-sanitiser, and `<think>` scaffolding goes out as `REASONING_*`.
  - A unit test feeds raw `<think>…</think>` / `<reply>` / stray-tag deltas through a `BotSession` with the fake provider. It asserts that no `TEXT_MESSAGE_CONTENT` contains a `<think>`, `<thinking>` or `<reasoning>` tag, and that the concatenated content equals what today's NDJSON `text_delta`s concatenate to.
- **No `CUSTOM bot.reply`.** It is explicitly **not** added.
  - The messaging relay keeps parsing text. It reads `TEXT_MESSAGE_CONTENT` (buffer per `messageId`, the last `<reply>` block, the `NO_REPLY` sentinel, `DEFERRAL`) and treats `RUN_FINISHED` (outcome ≠ `interrupt`) / `RUN_ERROR` as the end of the turn (§5).
  - `NO_REPLY` travels as ordinary text, as today.
  - This deliberately differs from PLAN.md's "`CUSTOM bot.reply` for the messaging relay"; PLAN.md should be amended when this spec is accepted.

---

## 5. Replay and what main needs

The agent keeps **no** UI history and emits no `MESSAGES_SNAPSHOT`. Main owns the per-thread replay ring (`ai.subscribe(threadId, lastEventId)`), assigns event ids, and persists transcripts.

What main needs from the agent:

1. **The thread ↔ pi session mapping is unchanged.** `CUSTOM session.ready {agentSessionId, agentSessionFile}` replaces `ready`. `recordAgentSession` (`service-host.ts:1184-1190`, `agent-session-manager-service.ts:420-437`) reads it instead. It is emitted at start and after every reset. The process still resumes the conversation from the pi file (`conversationSessionManager`, `session-file.ts`).
   - The `health-check.ts` ready probe (`services/updates/experience/health-check.ts:~62-80`) must look for `CUSTOM session.ready` when it spawns with `--wire agui`. It keeps `ndjson` until cut-over.
2. **Stable ids.**
   - `threadId` is on every `RUN_*`. Server runs use `--thread-id`.
   - Assistant message ids can be re-derived from the pi file (§3.3.7). The one-time transcript migration and any hydrate-from-pi fallback produce the same ids as the live stream.
   - Tool call ids are pi's.
3. **Runs are the unit of the ring.** Main's ring and `lastEventId` resume work on the stdout order. Main must treat:
   - `RUN_FINISHED {outcome.type:"interrupt"}` as **waiting**, not ended. This matters for routine settle, the messaging `finishTurn`, the turn waiter, and the busy phase. The turn ends at the terminal of the last run in the `parentRunId` chain whose outcome is not `interrupt`.
   - The **first** terminal per `runId` as authoritative, dropping later ones. Main's own synthetic terminals (inactivity timeout, child exit) can race the agent's.
4. **Pending interrupts do not survive a process.** A new agent process never resumes a previous process's interrupts; a resume naming them produces `approval.stale` (§3.5.3). On child exit main should close any `interrupted` chain in the ring with a synthetic continuation `RUN_FINISHED cancelled` so the client clears its pending items.
5. **Tap inputs, in AG-UI terms.** These rows are for the main slice. They keep today's tap behaviour identical.

| Tap | Today reads | Reads from AG-UI |
|---|---|---|
| Turn state / watchdog (`session-turn-state-service.ts:105-171`) | `heartbeat`, statuses, `error`, `tool_execution_start` summary | `CUSTOM agent.heartbeat`; `RUN_STARTED` → streaming; `RUN_FINISHED` interrupt → waiting_permission; other terminals → idle / error; `TOOL_CALL_END.metadata.tanstack.input` for the summary |
| Messaging relay (`messaging-gateway-service.ts:1176-1246`) | `text_delta{messageId, content}`, `error`, `idle` | `TEXT_MESSAGE_CONTENT` (per `messageId`, main thread **and** subagent-tagged, as today's text_delta did); `RUN_ERROR` → error text + flush; terminal → `finishTurn`. It must **not** reset on `TOOL_CALL_START`: today `tool_call_start` never reached it. |
| Artifacts (`session-artifacts.utils.ts:122-158, 377-442`) | `tool_execution_complete{tool.name, args/input, result.rejected, result.content}` | `TOOL_CALL_START.toolCallName` (display name, as today) + `TOOL_CALL_END.metadata.tanstack.input` + `TOOL_CALL_RESULT` content (`text`, `isError`) |
| Routine settle (`service-host.ts:3343-3380`), turn waiter (`:3449-3465`) | `text_delta` (all), `error`, `idle` | All `TEXT_MESSAGE_CONTENT`, including subagent-tagged; `RUN_ERROR.metadata.abacus.error` (for `ranOutOfAbacusCredits`); terminal |
| State patch (`cli-communication-service.ts:150-192`) | `status_changed`, `mode_changed`, `model_changed`, `turn_complete`, `error` | `CUSTOM agent.status`, `STATE_SNAPSHOT/DELTA`, terminals |
| Skills / MCP (`cli-manager-service.ts:926-963`) | `skills_loaded`, `mcp_*` | `CUSTOM skills.loaded`, `mcp.*` |
| Host services (`cli-manager-service.ts:1106-1131`) | `host_service_request` | `TOOL_CALL_*` named `host.*` → `client_tool_result` |
| Usage log (`agent-event-log.ts:66-89`) | `turn_complete.usage` | `RUN_FINISHED/RUN_ERROR.metadata.abacus.turnUsage` |

To make the port mechanical, the agent package exports `toLegacyEvents(events: AguiEvent[]): AgentEvent[]` (`agui/legacy-view.ts`, pure). It reconstructs `text_delta{messageId}` (preserving messageId equality classes), `tool_execution_start/complete`, `error`, `status_changed`, and `turn_complete` from the AG-UI stream. Main's taps can keep their current logic, fed through this view, during the migration. The round trip is tested (§7.1).

---

## 6. Files

### 6.1 Add (`packages/agent/src/agui/`)

| File | Contents |
|---|---|
| `wire.ts` | The types in §2 (commands, events, custom names, interrupt metadata, `AgentState`, `ToolResultContent`). Types only. |
| `emit.ts` | `AguiEmitter`: a pure, synchronous translator from the internal event stream (`DesktopEvent` + internal events, §6.3) to `AguiEvent[]`. It holds the translation state: open message and reasoning, announced tool calls and their args, merged display/output per call, open subagents, the terminal-class error and usage for the run, the last stopReason, hidden-turn depth, and the pre-ready state. It never does I/O. |
| `runs.ts` | `RunController`: the state machine in §3.1. `open()`, `settle()`, `cancel()`, interrupt batching (`INTERRUPT_BATCH_MS`), `nextBatch`, the buffer (§3.5.2), superseded-event dropping, `emergencyClose()`. |
| `host.ts` | `AguiHost`: the stdin reader (same loop and in-flight handling as `host.ts:90-145`), the command dispatch (§2.2), the queue logic moved from `NdjsonHost`, auto-allow (§3.5.6), and the watchdog wiring. |
| `queue.ts` | The queue state and algorithms extracted from `NdjsonHost` (`admit`, `runAfterStop`, `releaseParked`, `resyncSteers`, drain loop, `echoed`, `stopping`, `awaitingPermission`, `turn`), shared by both hosts so behaviour cannot drift. It is a refactor of `host.ts:28-485` with no behaviour change. `NdjsonHost` becomes a thin wrapper over it. |
| `interrupts.ts` | `toInterrupt(permissionId, request, runId, attach)`, `bindingFor(...)`, `canonicalJson`, `digest` (`node:crypto` sha256, `"sha256:"` prefix), `resumeToDecision(entry)`, `attachToolCall(request, runningCalls)`. |
| `ids.ts` | `assistantMessageId(sessionId, timestamp)` with collision suffix, `resultMessageId`, `reasoningId`, `serverRunId`. |
| `scope.ts` | `scopeEmit(emit, subagentRunId, parentToolCallId?)` (§3.6). |
| `watchdog.ts` | The run silence watchdog (§3.8). |
| `legacy-view.ts` | `toLegacyEvents` (§5). |
| `vendor/pi-acp/` | Vendored helpers (§6.2) with `LICENSE` (MIT, Copyright 2025 Victor Software House) and a header comment naming the source commit. |
| `__fixtures__/*.jsonl`, `*.test.ts` | §7 |

### 6.2 Vendored from pi-acp (MIT)

| Helper | Source | Lands in | Changes |
|---|---|---|---|
| `buildToolTitle(toolName, args)` | `pi-acp/src/acp/session.ts:92-149` | `vendor/pi-acp/tool-title.ts` | Keep the `read`/`write`/`edit`/`bash` cases and `truncateTitle` (80 chars). Add ours: `grep` ("Search <pattern>"), `find`/`glob` ("Find <pattern>"), `ls` ("List <path>"), `web_fetch` ("Fetch <url>"), `web_search` ("Search the web: <query>"), `delegate_task` ("Delegate: <task>"), `browser_task` ("Browser: <task>"), `ast_edit`/`batch_edit` ("Edit <n> files"), `batch_file_read` ("Read <n> files"), `todo` ("Update plan"), `memory`, `document`/`pdf`/`ppt`/`design`/`app` ("Build a …"). Drop `lsp`/`tmux`/`context_*`/`claudemon`: we have no such tools. |
| `toToolKind(toolName)` | `pi-acp/src/acp/session.ts:57-72` | `vendor/pi-acp/tool-kind.ts` | `read`, `batch_file_read`, `ls` → read. `write`, `edit`, `ast_edit`, `batch_edit` → edit. `bash` → execute. `grep`, `find`/`glob`, `web_search` → search. `web_fetch` → fetch. `delegate_task` → think. `exit_plan_mode` → switch_mode. Else other. |
| `formatToolContent`, `extractBashOutput`, `extractTextContent`, `extractContentBlocks`, `markdownEscape`, `wrapStreamingBashOutput` | `pi-acp/src/acp/translate/tool-content.ts:57-300` | `vendor/pi-acp/tool-content.ts` | Return a markdown `string` (the joined text of the ACP content blocks) instead of `ToolCallContent[]`. It is used for `ToolResultContent.formatted` only. `text` stays today's `resultText()`. |
| `mapPiStopReason` | `pi-acp/src/acp/session.ts:151-170` | `vendor/pi-acp/stop-reason.ts` | Kept as `toAcpStopReason` for a future ACP presenter. Add `toFinishReason(pi)`: stop → `"stop"`, length → `"length"`, toolUse → `"tool_calls"`, deferred → `"stop"`, error / aborted / pending → `null`. `aborted` maps the outcome to `cancelled` (§3.8). |

### 6.3 Change

| File | Change |
|---|---|
| `protocol.ts` | Add `InternalAgentEvent` (internal only, never on the NDJSON wire): `message_open {key: string /* msg-N */, messageId: string /* pi-derived */}`, `message_close {key, stopReason?: PiStopReason}`, `tool_call_start {toolCallId, toolName, input?}`, `tool_call_delta {toolCallId, argumentsDelta}`, `tool_call_stop {toolCallId, toolName, arguments}` (reusing the existing, producer-less shapes at `:126-133`), `turn_settled {}`, `hidden_turn {phase:"start"\|"end", customType}`. Add optional `subagentRunId?: string` to `AgentEvent` members and `parentToolCallId?: string` to `subtask_start`. `DesktopEvent` / `DesktopCommand` are unchanged. |
| `host.ts` (`NdjsonHost`) | Uses `agui/queue.ts`. `emit()` passes each event through `toNdjsonWire()`, which drops `InternalAgentEvent` types and strips `subagentRunId` / `parentToolCallId`. The output is byte-identical to today (§7.1). Optional `ABACUSAI_BOT_WIRE_RECORD=<path>` records stdin lines and **pre-strip** events as JSONL, for fixtures. |
| `main.ts` | Parse `--wire`, `--thread-id`, `--auto-allow`. Choose `NdjsonHost` or `AguiHost`. Wire `emergencyClose` into the `uncaughtException` handler (`:18-29`) and `process.on("exit")`. |
| `index.ts` | Export `AguiHost`, `agui/wire` types, `toLegacyEvents`. Keep the `NdjsonHost` export. |
| `session.ts` | `message_start` (`:2374`) emits `message_open`. `message_end` (`:2389`) emits `message_close` with `event.message.stopReason`. `onStreamEvent` (`:2599`) forwards `toolcall_start/delta/end` as internal `tool_call_*`. The gate hook (`:2650`) emits internal `tool_call_start` first. `send()` emits `turn_settled` after `reportTurnFailure()` (`:1243`) and at the end of its `catch` (`:1249-1258`). The `HostServiceClient` callback (`:608-616`) is unchanged; the emitter maps `host_service_request`. No logic changes. |
| `bot/bot-session.ts` | Same `message_open` / `message_close` / `tool_call_*` (skipped when `hiddenTurn`). `turn_settled` at `:537` (before `runMemoryMaintenance`), in the catch (`:540`), and after `:508`. `hidden_turn` start and end in `runHiddenTurn` (`:595`, `:605`). |
| `delegate-tool.ts`, `document-tool.ts`, `deck-tool.ts`, `design-tool.ts`, `browser-task-tool.ts` | `scopeEmit` for the child run; `parentToolCallId` on `subtask_start` (§3.6). |
| `package.json` | devDependencies `@ag-ui/core@1.0.0` (type conformance) and `@tanstack/ai@0.63.x` (binding, digest and processor conformance tests only). No runtime dependency is added. |

`tool-heartbeat.ts`, `host-services.ts`, `subagent-events.ts`, `delegation.ts`, `*-task.ts` and `permissions.ts` are **not** changed. They receive scoped emits, or are consumed as-is.

### 6.4 Delete

Nothing in this slice. At cut-over (phase 7):

- `NdjsonHost`, `toNdjsonWire`, `ABACUSAI_BOT_WIRE_RECORD` and the `--wire` flag;
- `DesktopEvent` / `DesktopCommand` from `protocol.ts` (the internal `AgentEvent` stays as the emitter's input);
- `apps/desktop/src/shared/agent-types.ts`'s NDJSON half;
- `host.e2e.test.ts`'s NDJSON cases, after they are ported.

---

## 7. Test plan

All tests run under `vitest` in `packages/agent`. Recordings use `@abacus-ai/test-support/fake-provider` (as `host.e2e.test.ts` does), so they are deterministic.

### 7.1 Golden fixtures

1. **Record.** Run `NdjsonHost` with `ABACUSAI_BOT_WIRE_RECORD` against scripted fake-provider replies for each scenario below. That yields `__fixtures__/<scenario>.jsonl`: stdin commands, plus the pre-strip internal events with ids and timestamps normalised.
2. **NDJSON unchanged.** `toNdjsonWire(recording)` equals a second recording taken from the pre-change build (`git stash` baseline, checked in as `__fixtures__/<scenario>.ndjson`). This proves byte-identity on the old wire.
3. **AG-UI golden.** Replay the recording through `AguiEmitter` + `RunController` (driving the commands through a fake session that replays the recorded internal events). Compare with `toMatchFileSnapshot("__fixtures__/<scenario>.agui.jsonl")`.
4. **Legacy round trip.** `toLegacyEvents(agui)` equals the NDJSON `event` stream, restricted to the tap-relevant types (`text_delta`, `tool_execution_*`, `error`, `status_changed: idle`, `turn_complete`), with messageId equality classes preserved.

Scenarios:

- plain text
- thinking + text
- two assistant messages with a tool between them
- bash with streamed output
- edit_file approved (the display diff arrives before the result)
- edit rejected with message
- `allowAlways`
- `run_terminal` with `credentialPaths`
- `exit_plan_mode`: each of the three yeses (mode → approval source) and a decline
- `sandbox_denied` mid-command, command-matched
- `network_host`, sole-running
- two parallel permissions (one batch)
- a permission while interrupted (`nextBatch`)
- permission expiry (`ABACUSAI_BOT_APPROVAL_TIMEOUT_MS=50`)
- stop mid-stream
- stop while interrupted
- stop then an immediate message (`runAfterStop`, echoed)
- steer mid-turn
- a steer parked behind a permission
- dequeue, remove, update, clear
- drain after the turn
- `delegate_task`
- `browser_task` with child text
- `ppt` component bracket
- a component left unfinished (stop)
- `document` host-service render
- OpenLLM rotation (`model_changed` mid-run)
- context compaction continuation
- malformed tool call continuation
- `turn_failed` with `switch-model` actions
- out of credits (`upgrade-abacus`)
- stall error
- a bot turn with `<think>`, `<reply>` and `NO_REPLY`
- a bot flush hidden turn
- bot no-model
- `reset_conversation`
- invalid `set_mode`
- startup `model_unavailable`
- a `todo` set

### 7.2 Porting `transport-bridge.test.ts`

The 1,185-line `apps/desktop/src/renderer/conversation/transport-bridge.test.ts` has 16 top-level `describe` groups. Each becomes an emitter test in `agui/emit.test.ts` with the AG-UI-equivalent assertion:

- Refusals (`:75-115`): unknown, malformed or id-less input produces no output and no throw.
- Tool translation (`:327-492`): `input`/`args` fallback, id-less drop, start args kept at result, rejected → `isError`, missing content → `""`, forgetting after the result.
- Display data before the tool (`:494-630`): `tool.display` merges; `newContent` beats `finalContent`; placeholders never create a call.
- Streaming output (`:632-708`): `tool.output` only for tracked calls; string output only.
- Sub-agent attribution (`:710-848`), rewritten to explicit `subagentRunId`. It covers parallel brackets, which positional attribution got wrong, and the turn boundary closing brackets and unfinished tools.
- Stop (`:851-872`): `cancelled` terminal; the bracket closed.
- Permission side-channel (`:142-256`), which becomes interrupts: a raise, one answer only (a second resume is stale), expiry retires the item, an older expiry leaves the newer pending, a clear for an unknown id is a no-op.
- Queue (`:258-325`, `:927-1021`): `queue.updated` snapshots; hidden entries are not echoed; index and id removal.

The renderer-only groups (`:874-925`, `:1023-1105`: session registry, titles, model/mode broadcast) belong to the chat-kit slice. They are listed there, not ported here.

### 7.3 Properties

A seeded random sequence generator (no new dependency) over the internal event and command alphabet. 10,000 sequences per CI run, with the seed printed on failure. It asserts:

1. **Bracketing.** Every `RUN_STARTED` is followed by exactly one terminal for its `runId`, before the next `RUN_STARTED` and before end-of-stream (`emergencyClose` at the end). No run-scoped event appears outside an open run.
2. **Messages.** `TEXT_MESSAGE_START/END` and `REASONING_*` are balanced per `messageId`, and none is left open at a terminal.
3. **Tools.** Per `toolCallId`: `START < ARGS* < END < RESULT`. `RESULT` appears at most once, and exactly once by the end of the run, counting `unfinished`. Host-service calls are exempt from `RESULT`.
4. **Interrupts.**
   - The ids in `RUN_FINISHED{interrupt}` are exactly the permissions pending and unanswered at that moment, not yet emitted.
   - The next run for them has `parentRunId` equal to that run.
   - Each binding's `interruptedRunId` equals its run.
5. **Subagents.**
   - Every event forwarded through a scope carries that `subagentRunId`.
   - `SUBAGENT_STARTED` precedes those events.
   - Exactly one `SUBAGENT_FINISHED` or `SUBAGENT_ERROR` per id by run end.
6. **State.** Every `STATE_DELTA` applies cleanly (RFC 6902) to the last `STATE_SNAPSHOT` plus the prior deltas.
7. **Hidden.** No event originates between `hidden_turn` start and end except a housekeeping-run permission.

### 7.4 Interrupt round trip (end to end)

Spawn `dist/main.js --wire agui` (as `host.e2e.test.ts` spawns the NDJSON host) with a fake provider that asks for `edit` in Normal mode. Assert:

- `RUN_STARTED` → `TOOL_CALL_START/ARGS/END` → `tool.display` → `approval-requested` → `agent.status waiting` → `RUN_FINISHED{interrupt:[perm-1]}`.
- `run{resume:[{interruptId:"perm-1", status:"resolved", payload:{decision:"accept"}}], parentRunId}` → `RUN_STARTED{parentRunId}` → `TOOL_CALL_RESULT` → text → `RUN_FINISHED success`, with the file edited.

Repeat with:

- `{approved:false}`: a rejection result, and the model replies;
- `cancelled`: reject;
- an unknown id: `approval.stale` + success;
- two parallel edits: one batch, and a partial resume re-emits the remainder;
- expiry;
- `cancel` while interrupted.

Then feed the same stdout into TanStack's `ChatClient` over a fake `SubscribeConnectionAdapter`. Assert that `interrupts` holds one `kind:"generic"` resolvable item per permission, and that `interrupt.resolveInterrupt({decision:"accept"})` produces a `send()` runContext whose `resume` the host accepts.

### 7.5 Sub-agent tagging

Use the fake provider to script:

- `delegate_task` with two child tool calls, while the parent runs `bash` in parallel;
- `browser_task` streaming `web-1`/`web-2`.

Assert that:

- the tagging is exact;
- the parent's bash is untagged;
- `SUBAGENT_FINISHED.result` equals the delegate's final text;
- a stop mid-delegate yields `SUBAGENT_ERROR{code:"unfinished"}`, and the child's pending tools get `isError` results through `forwardTools.settle()`.

### 7.6 Conformance

- `wire.ts` types are assignable to `@tanstack/ai`'s `StreamChunk` (`expectTypeOf`) and to `@ag-ui/core@1.0.0` event types.
- `bindingFor()` deep-equals TanStack's `withInterruptBinding(descriptor, {...})` metadata.
- `digest(canonicalJson(schema))` equals `digestInterruptJson(canonicalInterruptJson(schema))`.
- A recorded AG-UI stream fed through `@tanstack/ai`'s `StreamProcessor` produces the expected `UIMessage` parts: text, thinking, tool-call with its `approval-requested` state, and a `subagent` part.

### 7.7 Bot sanitiser

See §4. It also asserts:

- A hidden flush or consolidation turn produces zero stdout lines except stderr usage.
- The user's run terminal precedes the hidden turn's first pi event.

---

## 8. Acceptance and risks

### 8.1 Acceptance checklist

- [ ] `--wire ndjson` (default) output is byte-identical to the pre-change build on every §7.1 scenario. `host.e2e.test.ts`, `session*.test.ts` and `delegation.integration.test.ts` pass unchanged.
- [ ] `--wire agui` goldens (§7.1) are checked in and pass. The legacy round trip (§7.1 step 4) passes.
- [ ] All ported transport-bridge groups (§7.2) pass. The renderer-only groups are listed in the chat-kit spec.
- [ ] The §7.3 properties are green over 10,000 seeds. The bracketing property holds under `emergencyClose` and stdin EOF mid-run.
- [ ] Interrupt round trips (§7.4) pass, including through TanStack `ChatClient`.
- [ ] Sub-agent tagging (§7.5) passes with parallel parent tools.
- [ ] Bot sanitiser and hidden-turn tests (§7.7) pass.
- [ ] Type and binding conformance (§7.6) passes against `@tanstack/ai` 0.63.x and `@ag-ui/core` 1.0.0.
- [ ] No behaviour-bearing file changed beyond §6.3, verified by review of the diff. Nothing changes in the permission gate, sandbox, continuations, OpenLLM, delegation logic or queue algorithms, and `queue.ts` is a pure extraction.
- [ ] `pnpm --filter @abacus-ai/agent typecheck test` is green, and the agent bundle builds (`tsdown`) with no new runtime dependency.
- [ ] PLAN.md's `CUSTOM bot.reply` wording is amended to match §4.

### 8.2 pi 0.85.1 to 0.99.x: what the bump must verify

The bump is a separate commit. The gate is that §7.1 NDJSON goldens are unchanged on `--wire ndjson`, and that the full agent suite passes.

**Session events.**

- `AgentSessionEvent`: `agent_end {messages, willRetry}` semantics and `agent_settled` timing are relied on by `finishTurn` gating, delegation (`delegation.ts:219`), the task runners and the `background`/`verify-loop` extensions.
- 0.99 adds `parentToolCallId` (`WithParentToolCallId`) to events. Make sure nothing keys on its absence.
- New or changed events that must fall into `default:` harmlessly:
  - `compaction_start {reason}`
  - `compaction_end {…, willRetry, errorMessage}`
  - `auto_retry_end`
  - `summarization_retry_*`
  - `entry_appended`
  - `thinking_level_changed`
  - `session_info_changed`
- `AssistantMessageEvent` `toolcall_start/delta/end {toolCall}` shapes, used newly (§3.3.5).
- `message_start`'s partial carries `timestamp`, which the ids depend on (§3.3.7).
- `tool_execution_update.partialResult` is an `AgentToolResult` object in pi's types. `session.ts:2466` forwards only strings. Confirm the confined bash (`backends.ts` operations) still yields string partials on 0.99, or bash output stops streaming silently.
- `StopReason` includes `"deferred"` and `"pending"`. Check `endedOnProviderError` / `endedOnMalformedToolCall` and `reportFailedCall` (`stopReason === "error"`).

**Extension and session API** used by `session.ts` / `bot-session.ts`:

- `pi.on("tool_call")` hook: event fields `toolCallId`, `toolName`, `input`, `ctx.cwd`, and the `{block, reason}` return. Also whether a blocked call still emits `tool_execution_start` / `end` (§3.3.6).
- `pi.appendEntry`, `pi.registerTool` mid-session.
- `session.prompt`, `steer`, `clearQueue`, `abort`, `compact`, `sendCustomMessage(msg, {triggerTurn})`, `setModel`, `setActiveToolsByName` / `getActiveToolNames`, `state.errorMessage`, `sessionId`, `sessionFile`, `sessionManager`, `subscribe`, `dispose`.
- `createAgentSession` options: `customTools`, `excludeTools`, `sessionManager`, `resourceLoader`, `settingsManager`, `modelRuntime`, `model`.
- `DefaultResourceLoader`: `reload`, `getSkills`, `additionalSkillPaths`, `appendSystemPrompt`, `extensionFactories`.
- `SettingsManager.create` and the retry settings (`getRetrySettings` / the retry-budget holder).
- `ModelRegistry`, `createModelRuntime`, `setRuntimeApiKey`, `hasConfiguredAuth`, `getAvailable`; the `providers.ts` registrations (abacus, custom, gemini, openrouter live).

**Persistence.**

- 0.99 must read session JSONL files written by 0.85, so chats resume.
- `compaction-anchor.ts` reads the entries it expects.
- `session-search.ts` reads `agentSessionIds` files.
- The `abacusai-bot-mode` / `abacusai-bot-approval` custom entries stay excluded from context.

**Model-visible surface.** Diff pi's built-in tool definitions (`read`, `write`, `edit`, `grep`, `find`, `ls`), their descriptions and schemas, and the default system prompt between 0.85 and 0.99. Any change alters model behaviour and the prompt cache. If they differ, pin today's text through our overrides before the bump, or accept the change explicitly in the bump PR.

**Features not to adopt**, since each would change behaviour:

- `builtin:mcp`: keep our MCP client (`mcp/`).
- `ctx.executeTool`
- virtual models
- pi's own RPC and Chord protocols
- telemetry (`pi-telemetry`): make sure nothing phones home by default

**Build and runtime.** Node engine (`>=22`), `tsdown` bundling of the three `@earendil-works/*` packages, `scripts/write-runtime-package.js`, and the packaged-app smoke (`packaged-startup.test.ts`, `health-check.ts`).

### 8.3 Risks

| Risk | Mitigation |
|---|---|
| TanStack treats `approval-requested` (legacy) and the native generic interrupt as two pending items, or refuses a mixed batch ("native and legacy items cannot mix", `docs/interrupts/migration.md`). | §7.4 runs the real `ChatClient`. If it misbehaves, drop the `approval-requested` CUSTOM behind a constant (`EMIT_LEGACY_APPROVAL_EVENT`) and render inline approval from `interrupt.toolCallId` in the chat kit. |
| The client expects `MESSAGES_SNAPSHOT` before an interrupt terminal (the native server order in `migration.md`). The agent keeps no history. | §7.4 verifies with `ChatClient`. If it is required, main (which has the ring) injects a snapshot before relaying the interrupt terminal. The agent is unchanged. |
| An interrupt ends the AG-UI run while the pi turn is still live. A client that sends an unrelated `run` in that window gets the parked-message path, not a new turn. | This is identical to today (the message is parked behind the prompt). The renderer should resolve or cancel interrupts, or use `queue.enqueue`. It is documented in the chat-kit spec. |
| Events buffered while interrupted delay a sibling tool's or sub-agent's visible progress until the user answers. | Session-scoped status and heartbeat still flow. Expiry opens a continuation. If UX needs live sibling progress, a later slice can relay those events out-of-run as `CUSTOM` without breaking bracketing. |
| Settling at `turn_settled` rather than at `send()` resolution changes when the bot's "turn over" is seen. Today main sees `idle` from `finishTurn` (`bot-session.ts:1374`) and the error after it. | The terminal now carries both: the error, if any, as `RUN_ERROR`. The relay flushes at the same moment it would have seen that error. The §7.1 bot scenarios compare the legacy view. |
| The pi-derived message id depends on `AssistantMessage.timestamp` at `message_start`. | The collision suffix and a fallback to `msg-N` when the timestamp is absent keep ids unique. The migration slice verifies derivation against real pi files. |
| Command-match attachment of `sandbox_denied` picks the wrong call when two running calls share a command string. | It chooses the most recent. A wrong pick only affects where the card renders; the decision still reaches the right waiter (keyed by `permissionId`). |
| Hidden-turn usage no longer reaches main's usage log. | It goes to a stderr line (§4), which main's log capture keeps. |
| Pre-existing quirk: a user message sent during a bot housekeeping turn is steered into the hidden turn and its reply stays hidden. | This is unchanged behaviour, deliberately not fixed in this slice. It is logged for the bots slice. |
| The watchdog backstop fires in a headless host during a legitimately long, silent phase. | The heartbeat covers running tools, and the model-stall timer covers silent model calls (`session.ts:1596-1623`). The default of 11 minutes exceeds both. `0` disables it. |
