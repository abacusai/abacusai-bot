# Spec 00: `packages/agent` AG-UI host and emitter (rev 2)

Phase 0, slice 1 of `docs/rewrite/PLAN.md` ("Protocol: AG-UI straight from pi"). This is a spec, not code; the only code in it is type declarations.

Rev 2 resolves every finding in `docs/rewrite/specs/reviews/00-agent-agui.codex-r1.md`. §9 maps each finding to its change. It also applies these orchestrator decisions:

- **Zero behaviour change for main's taps.** A compatibility stream carries today's exact NDJSON to main (§2.4).
- **No permission batching.** Each permission resolves on its own through an explicit control command. It is not a TanStack batch interrupt (§3.5).

Sources read: the rev-1 list, plus the following.

- TanStack `ai-client/src/interrupt-manager.ts`:
  - `hydrate()` replaces the whole pending set.
  - `maybeSubmit()` submits all-or-nothing.
- `ai-client/src/ui/selectors.ts:100-138`: only `kind:"tool-approval"` joins tools.
- `ai/src/activities/chat/stream/processor.ts`:
  - `handleToolCallResultEvent` reads `metadata.tanstack.state` / `toolResultOutcome`.
  - `routeToChild` routes child events to their subagent.
- `@ag-ui/core@1.0.0`: the `EventType` enum and `Attributable`. Its main entry has no zod import.
- `apps/desktop/src/main/services/session/cli-manager-service.ts:542` spawns with three stdio pipes.

---

## 1. Scope and non-goals

### In scope

1. **A second wire for the renderer.** With `--wire agui`:
   - stdout carries one AG-UI event per line;
   - fd 3 carries the **compatibility stream**, today's NDJSON `DesktopEvent` lines byte for byte (§2.4).

   Both come from one `emit()` call.
2. **stdin.** It accepts today's `DesktopCommand` set unchanged, so every existing main producer keeps working. It adds four commands: `run`, `cancel`, `permission.respond`, `sync` (§2.2).
3. **`packages/agent/src/agui/`.** Wire types, the translator (emitter), the run controller, the host, permission descriptors, ids, and the vendored pi-acp helpers.
4. **The `--wire ndjson|agui` flag**, defaulting to `ndjson` until cut-over. Both hosts drive the same `AbacusBotSession` / `BotSession` through one shared queue module.
5. **Minimal session plumbing** for facts NDJSON never carried:
   - message boundaries;
   - streamed tool-call arguments;
   - sub-agent tags;
   - failure origin;
   - gate blocks;
   - a turn-owned settle callback;
   - hidden-turn markers;
   - plan snapshots.

   All of these are internal-only. They are stripped before a compat or NDJSON line is written, so both remain byte-identical to today.

### Non-goals (behaviour unchanged)

- **Session and host logic.** None of these change:
  - session, bot loop, permission gate, allowances and audit lines;
  - sandbox asks, delegation and component tasks, continuations, OpenLLM rotation, retries;
  - heartbeat timings, host services, MCP, skills;
  - queue semantics, mode and model semantics, sanitiser, `NO_REPLY`.
- **Main's taps.** None change:
  - turn state and watchdog, messaging gateway, artifacts, `settleRoutineRun`, `feedTurnWaiter`;
  - `AgentCommunicationService` (including browser auto-allow), host-service answering, MCP and skills handling, usage log, `recordAgentSession`.

  They read the compat stream and write the same stdin commands as today. Only the renderer consumes AG-UI.
- **No new abort or timeout policy.** Watchdogs stay in main (finding 22).
- **No agent-side UI history.** Main owns the transcript and replay (§5).
- **No `CUSTOM bot.reply`.** The messaging relay keeps reading `text_delta` from the compat stream (§4). This supersedes PLAN.md's wording.
- **No TanStack native interrupts.** No `RUN_FINISHED{outcome:"interrupt"}` is emitted and no `approval-requested` either (§3.5). PLAN.md's interrupt wording is superseded.
- **The pi 0.85 → 0.99 bump** is a separate commit (§8.2).

---

## 2. Wire format

### 2.1 Channels and framing

| Channel | Direction | Content |
|---|---|---|
| stdin | main → agent | One JSON `AgentCommand` per line (§2.2). U+2028/2029 are escaped as `serializeCommand` does (`cli-manager-service.ts:178-182`). |
| stdout | agent → main | One AG-UI event per line (§2.3). Nothing else. |
| fd 3 (compat) | agent → main | One legacy `DesktopEvent` per line, byte-identical to what `--wire ndjson` writes to stdout for the same session (§2.4). |
| stderr | agent → main | Diagnostics, as today. |

**Process flags** (`main.ts`):

- `--wire ndjson|agui` (default `ndjson`).
- With `agui`:
  - `--thread-id <id>` (required);
  - `--compat-fd <n>` (main passes `3`), or `--compat-pipe <path>` as the fallback (§2.4).
- `--model`, `--permission-mode` and `--sandbox-probe` are unchanged.

**Error handling:**

- A malformed stdin line never kills the process. It produces `error {code:"malformed_command"}` on compat (as `host.ts:109-119`) and `CUSTOM agent.error` on AG-UI.
- A throwing handler behaves as `host.ts:127-131` on compat. On AG-UI it becomes a `RUN_ERROR` for the command's own run if that run is still open, otherwise `CUSTOM agent.error`.

**Scope:**

- **Run-scoped** AG-UI events (`TEXT_MESSAGE_*`, `REASONING_*`, `TOOL_CALL_*`, `SUBAGENT_*`, and the `CUSTOM` names marked *run* in §2.3) appear only inside an open run.
- **Session-scoped** events (`STATE_*` and the `CUSTOM` names marked *session*) may appear any time.

### 2.2 Commands (stdin)

`packages/agent/src/agui/wire.ts`:

```ts
import type { RunAgentInput as AguiRunAgentInput } from "@ag-ui/core";
import type { DesktopCommand, PermissionDecision } from "../protocol.js";

/** Everything stdin accepts under --wire agui. */
export type AgentCommand = DesktopCommand | AguiControlCommand;

export type AguiControlCommand =
  /** A turn from the renderer's chat client. */
  | { type: "run"; input: RunInput }
  /** Stop the reply in flight. Same handler as the legacy `stop`. */
  | { type: "cancel"; runId?: string }
  /** Answer one permission, independently of any other (§3.5). */
  | { type: "permission.respond"; lineage: PermissionLineage; decision: PermissionDecision }
  /** Ask for an authoritative snapshot (§5.3). Answered with CUSTOM session.sync. */
  | { type: "sync" };

/** AG-UI RunAgentInput as the SubscribeConnectionAdapter sends it. `resume` must be absent or empty (§3.5). */
export type RunInput = Omit<AguiRunAgentInput, "forwardedProps"> & {
  forwardedProps?: {
    /** Applied before the prompt when it differs; same path as set_mode. Main omits it for bots. */
    mode?: string;
    /** Applied (awaited) before the prompt when it differs; same path as set_model. */
    model?: string;
    /** Accepted and ignored: host.ts:156 drops send.activeSkills today. */
    activeSkills?: string[];
    /** Accepted and ignored; must equal threadId when present. */
    conversationId?: string;
    /** "regenerate": explicit request to answer the newest user message again (§3.1.4). */
    intent?: "send" | "regenerate";
  };
};

/** Identifies the exact pending permission an answer is for (§3.5.3). */
export interface PermissionLineage {
  threadId: string;
  /** From session.ready / the descriptor; new per agent process. */
  incarnation: string;
  /** The run the permission was raised in. */
  runId: string;
  /** perm-N from the descriptor. */
  permissionId: string;
}
```

**The legacy commands are accepted verbatim** (`protocol.ts:417-453`), and each has exactly today's handler (`host.ts:147-327`). The legacy commands that start turns (`send`, `enqueue` while idle, `dequeue`), which main's messaging gateway, routines and routine editor use, open **server-initiated** AG-UI runs (§3.1.3). The rev-1 aliases (`queue.*`, `mcp.*`, `providers.refresh`, `client_tool_result`) are dropped. Main already speaks the legacy names, and one spelling per operation keeps the two hosts identical.

| Command | Handler |
|---|---|
| `run` | Admission (§3.1.1); `runTurn(text)` under a client run |
| `cancel` | The `stop` handler (`host.ts:160-182`) plus run closure (§3.8) |
| `permission.respond` | Lineage check (§3.5.3), then `session.respondPermission` + `releaseParked()`, i.e. the same two calls as `host.ts:199-205` |
| `permission_response` (legacy) | Unchanged. Main's browser auto-allow uses it (§3.5.6). |
| `host_service_response` (legacy) | Unchanged (`settleHostService`). Host services never appear on AG-UI (§3.7). |
| `sync` | Emits `CUSTOM session.sync` (§5.3) |
| every other legacy command | Unchanged handler |

### 2.3 Events (stdout)

The types come from `@ag-ui/core@1.0.0`. It becomes a runtime dependency of the agent: the ESM entry is 28 KB and does not load `./schemas` or zod. Events are built with the `EventType` enum through one checked constructor, so they are assignable to `@ag-ui/core`'s `Event` and TanStack's `StreamChunk` without casts (finding 24).

```ts
import {
  EventType,
  type Event as AguiCoreEvent,
  type Interrupt as AguiInterrupt,
  type TokenUsage as SpecTokenUsage,
} from "@ag-ui/core";
import type {
  AgentMode, AgentStatus, CliMcpLogEntry, CliMcpServerSnapshot, NotificationAction,
  PermissionRequest, QueueEntry, SkillMetadata, ToolDisplayData,
} from "../protocol.js";
import type { TurnUsage } from "../turn-usage.js";

/** The event types this agent emits. */
export type EmittedType =
  | EventType.RUN_STARTED | EventType.RUN_FINISHED | EventType.RUN_ERROR
  | EventType.TEXT_MESSAGE_START | EventType.TEXT_MESSAGE_CONTENT | EventType.TEXT_MESSAGE_END
  | EventType.REASONING_START | EventType.REASONING_MESSAGE_START | EventType.REASONING_MESSAGE_CONTENT
  | EventType.REASONING_MESSAGE_END | EventType.REASONING_END
  | EventType.TOOL_CALL_START | EventType.TOOL_CALL_ARGS | EventType.TOOL_CALL_END | EventType.TOOL_CALL_RESULT
  | EventType.STATE_SNAPSHOT | EventType.STATE_DELTA | EventType.CUSTOM
  | EventType.SUBAGENT_STARTED | EventType.SUBAGENT_FINISHED | EventType.SUBAGENT_ERROR;

/** Every stdout line: a canonical @ag-ui/core event of an emitted type. */
export type AguiEvent = Extract<AguiCoreEvent, { type: EmittedType }>;

/** The only way events are built (agui/event.ts). Payload types come from @ag-ui/core's EventPayloadOf. */
export declare function aguiEvent<T extends EmittedType>(
  type: T,
  payload: import("@ag-ui/core").EventPayloadOf<T>,
): Extract<AguiCoreEvent, { type: T }>;
```

The agent's conventions are layered on top: which fields it sets, and the typed shapes of `metadata` and `value`.

```ts
/** RUN_FINISHED: outcome is "success" or "cancelled"; never "interrupt" (§3.5). */
export interface RunFinishedMeta {
  tanstack?: { model?: string; finishReason?: "stop" | "length" | "tool_calls" | null };
  abacus?: { turnUsage?: TurnUsage; stopReason?: PiStopReason; serverInitiated?: true };
}
/** RUN_ERROR: threadId/runId ride in metadata.tanstack (TanStack's RunErrorEvent convention). */
export interface RunErrorMeta {
  tanstack: { threadId: string; runId: string; model?: string };
  abacus: { error: AgentErrorPayload; turnUsage?: TurnUsage };
}
export type PiStopReason = "pending" | "stop" | "length" | "toolUse" | "error" | "aborted" | "deferred";

/** Today's AgentEvent error payload, verbatim (protocol.ts:200-214). */
export interface AgentErrorPayload {
  message?: string;
  code?: string;
  name?: string;
  segmentData?: { message?: string; type?: string; [k: string]: unknown };
  detail?: string;
  actions?: NotificationAction[];
}

/** TOOL_CALL_START metadata. Only facts that never change after START (finding 25). */
export interface ToolCallStartMeta {
  abacus: {
    /** pi's own tool name before TOOL_NAME_ALIASES; toolCallName is the display name, as today. */
    rawName: string;
    /** The legacy id when it differs from the AG-UI id (child calls, §3.3.7). */
    legacyToolCallId?: string;
  };
}
/** TOOL_CALL_END metadata: canonical parsed input (spec END has no top-level input). */
export interface ToolCallEndMeta {
  tanstack: { input: Record<string, unknown> };
}
/** TOOL_CALL_RESULT metadata. The recognised error fields make StreamProcessor mark the part as an error (finding 10). */
export interface ToolCallResultMeta {
  tanstack?: { state: "output-error"; toolResultOutcome?: "denied" | "cancelled" };
}
/** TOOL_CALL_RESULT content is JSON.stringify(ToolResultContent). */
export interface ToolResultContent {
  /** Byte-identical to today's ToolResult.content. */
  text: string;
  /** Today's ToolResult.rejected (event.isError). */
  rejected: boolean;
  /** Set only when rejected, equal to `text`, so TanStack's toolResultErrorText shows it. */
  error?: string;
  display?: ToolDisplayData;
  terminal?: { output: string };
  /** vendored formatToolContent() markdown. */
  formatted?: string;
  /** The run closed the call without a result (§3.1.5). */
  unfinished?: true;
}

export interface AgentState {
  mode: AgentMode;
  modeSource: "startup" | "user" | "approval" | "bot";
  model: string;
  agentSessionId?: string;
  agentSessionFile?: string;
  incarnation: string;
  /** Present only after the first successful `todo` set; normalized as stored (readTodos()). */
  plan?: Array<{ content: string; status: "pending" | "in_progress" | "completed" }>;
}

/** Permission descriptor: an AG-UI Interrupt object carried in CUSTOM, never in a RUN_FINISHED outcome. */
export interface PermissionDescriptor extends AguiInterrupt {
  id: string; // perm-N
  reason: "abacus:permission" | "abacus:question";
  message: string; // request.displayName
  toolCallId?: string; // AG-UI tool call id (§3.5.4)
  subagentRunId?: string;
  expiresAt?: string;
  metadata: {
    abacus: {
      lineage: PermissionLineage;
      kind: PermissionRequest["type"];
      request: PermissionRequest; // verbatim
      attachedBy: "gate" | "command-match" | "sole-running" | "none";
      /** Decisions the widget may send for this kind (§3.5.2). */
      allowed: DecisionKind[];
    };
  };
}
export type DecisionKind =
  | "accept" | "reject" | "background" | "allowAlways" | "allowYolo"
  | "accept_with_message" | "reject_with_message" | "question_answers"
  | "allow_always_with_rule" | "allow_always_with_rules";
```

`CUSTOM` names are the complete list; nothing else is emitted. *S* marks session-scoped names, *R* run-scoped ones.

| Name | Scope | Value |
|---|---|---|
| `session.ready` | S | `{model, mode, agentSessionId?, agentSessionFile?, incarnation}` |
| `session.cleared` | S | `{}` |
| `session.sync` | S | `SessionSync` (§5.3) |
| `agent.status` | S | `{status: AgentStatus}` |
| `agent.heartbeat` | S | `{runningTools}` |
| `agent.error` | S | `AgentErrorPayload` (non-terminal errors) |
| `agent.notification` | S | `{message, severity, actions?, notificationKey?, …}` (verbatim) |
| `agent.retry` | R | `{attempt, maxAttempts, delayMs, isNetworkError}` |
| `run.ack` | S | `{runId, status: "started" \| "queued" \| "duplicate" \| "rejected", entryId?, waitingFor?, reason?: "regenerate_unsupported" \| "busy_regenerate" \| "empty" \| "resume_unsupported"}` |
| `permission.requested` | S | `PermissionDescriptor` |
| `permission.resolved` | S | `{permissionId, decisionKind: DecisionKind, source: "respond" \| "legacy_response"}` |
| `permission.cleared` | S | `{permissionId, reason: "expired" \| "stopped" \| "reset"}` |
| `permission.response_rejected` | S | `{lineage, reason: "incarnation" \| "thread" \| "run" \| "not_pending" \| "invalid_decision" \| "decision_not_allowed"}` |
| `permission.pending` | S | `{incarnation, items: PermissionDescriptor[]}`: the authoritative set, after every change |
| `tool.output` | R | `{toolCallId, output}` |
| `tool.display` | R | `{toolCallId, data: ToolDisplayData}` |
| `queue.updated` | S | `{messages: QueueEntry[], dequeued: string \| null}` |
| `queue.steered` | R | `{content}` |
| `queue.dequeued` | R | `{content}` |
| `skills.loaded` | S | `{skills: SkillMetadata[]}` |
| `mcp.servers` | S | `{servers: CliMcpServerSnapshot[]}` |
| `mcp.server_logs` | S | `{serverId, entries: CliMcpLogEntry[]}` |

`credits`, `network_status`, `conversation_loaded`, `segment_updated`, `tool_requested`, `tool_user_message`, `mcp_server_status`, `mcp_server_log`, `mcp_refresh_failed` and `mcp_restart_failed` have no producer in the agent (§3.3.9). If one ever appears, it goes to compat verbatim and gets no AG-UI mapping.

### 2.4 The compatibility stream

**Mechanism.** Main spawns the agent with `stdio: ["pipe","pipe","pipe","pipe"]`. Today it passes three pipes (`cli-manager-service.ts:542`). It also passes `--compat-fd 3`. The agent opens `new net.Socket({ fd: 3, readable: false, writable: true })`:

- It is a Node-created pipe, so this works on POSIX and on Windows (libuv passes extra stdio pipes through).
- If the socket cannot be constructed, the agent falls back to `fs.createWriteStream("", { fd: 3 })`.

**Fallback.** If fd 3 is unusable (constructor throws, or the first write fails `EBADF`), main may instead pass `--compat-pipe <path>`: a `\\.\pipe\abacusai-bot-<uuid>` named pipe on Windows, or a unix socket in the profile's run dir on POSIX. Main listens on it; the agent connects before writing anything. If neither channel opens within 5 s:

1. The agent writes one stderr line.
2. It exits with code 78 (`EX_CONFIG`) **before any stdout output**.
3. Main then respawns the conversation with `--wire ndjson` (the old host), so behaviour is never degraded.

`--wire agui` without either compat flag is valid only for standalone/test use. The compat stream is then disabled.

**Production: one `emit()`, two writers.** Both hosts share `agui/queue.ts` (the queue and turn logic extracted from `NdjsonHost`). Every `DesktopEvent` a session or the host produces goes through one `HostSink.emit(event)`, which does two things in order:

1. **`compat.write(toNdjsonWire(event))`.** `toNdjsonWire` drops the internal-only types (§6.3), strips the internal fields, and returns `JSON.stringify(stripped) + "\n"`. This is exactly the line `NdjsonHost.emit` writes today (`host.ts:482-484`). Under `--wire ndjson` the same function writes to stdout, so the two bytes are the same by construction.
2. **`agui.accept(event)`.** The emitter's AG-UI lines go to stdout.

**Guarantees:**

- The compat stream is in the same order as today's stdout. It includes host-originated lines (`queue_updated`, `idle`, `user_message_dequeued`, errors), heartbeats, `ready`, `host_service_request`, `permission_needed` and MCP events.
- Commands that only exist in AG-UI mode produce the same compat lines as their legacy equivalents (§7.2):

  | AG-UI command | Legacy equivalent |
  |---|---|
  | `run` | `send`, preceded by `set_mode` / `set_model` when `forwardedProps` differ |
  | `cancel` | `stop` |
  | `permission.respond` | `permission_response` |
  | `sync` | nothing |

  Rejected or duplicate `run`s produce no compat line.
- Main must not assume any ordering *between* stdout and fd 3. Each channel is ordered on its own.
- Backpressure and EPIPE on fd 3 are handled like stdout today: buffered, and a write error is logged once. `canReachUser()` (`session.ts:2758`) keeps checking stdout only.

**What main does.** In AG-UI mode main reads fd 3 with the existing `handleStdout` pipeline (`cli-manager-service.ts:851-966`) and sends every compat line through the existing `emitNdjson` fan-out (`service-host.ts:1181-1263`) unchanged. It relays stdout (AG-UI) to the renderer's chat stream. The old renderer, if still mounted, keeps receiving `local-cli-ndjson` from compat.

---

## 3. Semantics and complete mapping

### 3.1 Runs

#### 3.1.1 Admission (finding 2)

Admission is **synchronous**. The host decides before any `await`, and records the outcome in `run.ack` immediately:

1. **Duplicate check.** If `input.runId` is already in this incarnation's `seenRunIds`, the result is `run.ack {status:"duplicate"}` and nothing else happens. This covers transport retries (finding 14).
2. **Unsupported resume.** A non-empty `resume` gets `run.ack {status:"rejected", reason:"resume_unsupported"}`. No run opens.
3. **Text.** Extract the newest `role:"user"` message's text:
   - UIMessage: the `parts[type=text].content` values joined with `"\n"`;
   - ModelMessage: string `content`, or the joined text parts.

   Empty or whitespace-only text gets `run.ack {status:"rejected", reason:"empty"}`, matching `isPrompt` (`host.ts:152`).
4. **Regenerate** (§3.1.4) is decided next.
5. **Busy.** If `busy || reserved`, this is today's send-while-busy: `admit(text)` runs unchanged. It steers the message, parks it behind a permission, or holds it for the next turn. The result is `run.ack {status:"queued", entryId, waitingFor}`. **No run opens** and no `RUN_STARTED` is written. The client's adapter must resolve its send from the ack (§5.2). If admission lands in the reservation window, while `forwardedProps` are still being applied, the entry is queued with `waitingFor:"turn"`, the same rule as the `stopping` window (`host.ts:388-392`). Steering before a prompt exists would be meaningless.
6. **Otherwise:**
   - set `reserved = true` synchronously;
   - `run.ack {status:"started"}`;
   - `RUN_STARTED {threadId, runId, parentRunId?}`;
   - apply `forwardedProps.mode`, then `await` `forwardedProps.model`, when they differ. These go through the same `setMode` / `setModel` paths as the legacy commands, and failures are non-terminal (§3.2);
   - `runTurn(text, token)`, which sets `busy` exactly as today; clear `reserved`.

#### 3.1.2 Turn tokens (finding 12)

Every `session.send()` call the host makes is owned by an immutable `TurnToken {seq, runId}`. Only the owner of the open run can settle it.

- `session.send(text, { settled: () => runs.settle(token) })` gains an optional second parameter. The session calls `settled()` once, at the end of the user-visible turn (§3.1.5), which replaces rev 1's `turn_settled` event.
- The host also calls `runs.settle(token)` in the `finally` around `session.send`.
- `runs.settle(token)` is a no-op unless `token.seq` equals the open run's token. A superseded `send` that finishes after Stop, while a newer run is open, cannot settle the newer run.
- `cancel` calls `runs.markCancelling(token)` **synchronously, before** `await session.stop()`. A `settled()` callback that fires during the abort then closes the run as `cancelled`, not `success`.

#### 3.1.3 Server-initiated runs

A legacy `send`, a queue drain (`host.ts:353-368`), `runAfterStop` (`host.ts:407-421`), and `dequeue` while idle (`host.ts:230-246`) each open a run with:

- `runId = "srv-" + randomUUID()`;
- `metadata.abacus.serverInitiated`.

Each one opens with `CUSTOM queue.dequeued {content}` plus a **user** text message (`TEXT_MESSAGE_START {role:"user", messageId: runId+":user"}` + `CONTENT` + `END`), unless the entry was echoed (`!echoed.delete(id)`, the same rule that suppresses `user_message_dequeued`).

- A legacy `send` from main (messaging, routine) also carries its user text message.
- Each drained `session.send()` gets its own run and token. The previous run settles before the next `RUN_STARTED`.

#### 3.1.4 Regeneration and retries (finding 14)

A new `runId` whose newest user message id equals the last user message id this incarnation prompted is resolved as follows:

- **The previous run for that message ended in `RUN_ERROR` or `cancelled`.** This is a retry. It is admitted as a normal new prompt with the same text, which is exactly today's "try again": the renderer re-sends the text.
- **The previous run ended in `success` and `forwardedProps.intent === "regenerate"`.** The result is `run.ack {status:"rejected", reason:"regenerate_unsupported"}`. Regenerating an answer means branching pi's transcript, which is a behaviour change outside this slice. The chat kit must not offer `reload()` on successful turns until a later slice specifies branching.
- **The previous run ended in `success` without `intent`.** This is treated as a new prompt, as today when a user sends the same text twice.

Deduplication is by `runId` only (§3.1.1). A reused message id is never proof of redundancy.

#### 3.1.5 Settle

Settle happens on the first owner-valid trigger:

- the session's `settled()` callback, called:
  - in `AbacusBotSession.send` after `reportTurnFailure()` (`session.ts:1243`) and at the end of its `catch` (`:1249-1258`);
  - in `BotSession.send` after `reportTurnFailure()` and **before** `runMemoryMaintenance()` (`bot-session.ts:537-538`), in the `catch` (`:540`), and after the no-model error (`:508`);
- the `finally` around `session.send`;
- `cancel` (after `session.stop()` resolves);
- `reset_conversation` (after `resetConversation()` resolves).

Closing order (finding 11):

1. Close the open reasoning, then the open text message.
2. **For each open subagent, innermost first:**
   - close its open child text message;
   - emit tagged `TOOL_CALL_RESULT {unfinished, rejected:true}` with `metadata.tanstack {state:"output-error", toolResultOutcome:"cancelled"}` for its announced but unresolved calls;
   - **then** `SUBAGENT_ERROR {code:"unfinished"}`.

   `StreamProcessor.routeToChild` drops events after a child's terminal, so the child's parts must come first.
3. Emit `TOOL_CALL_RESULT` the same way for the parent's unresolved calls. This mirrors the transport forgetting unfinished tools at the turn boundary (`transport-bridge.test.ts:833`).
4. Emit exactly one terminal:
   - `RUN_ERROR`, if a terminal failure was recorded for this token (§3.2);
   - `RUN_FINISHED {outcome:{type:"cancelled"}}`, if cancelling;
   - otherwise `RUN_FINISHED {outcome:{type:"success"}}`.

   `usage` is the last `turn_complete.usage`, converted per §3.3.8, plus `metadata.abacus.turnUsage` (raw), `stopReason`, `metadata.tanstack.finishReason` and `model`.

After a cancel or reset closes a run, run-scoped AG-UI events from the superseded pi turn are dropped until the next `RUN_STARTED`. The compat stream is **not** filtered: it carries them exactly as today, and main's own post-Stop suppression applies (`session-turn-state-service.ts:129-141`).

### 3.2 Failure classification by producing operation (finding 13)

Every `emitAgentEvent({type:"error"})` site gains an internal `origin`, stripped from compat:

| Origin | Sites | AG-UI |
|---|---|---|
| `turn` | `session.ts:1249` (thrown in send), `:1275` (budget), `:1296` (reportTurnFailure), `:1553` (stall), `:1653` (compaction), `:1737` (pool exhausted in rotation); `bot-session.ts:508` (no model in send), `:540`, `:721`, `:761`; `host.ts:128` when the throwing command was `run`/`send` | **Terminal** for the owning token. The first one becomes the run's `RUN_ERROR` at settle (`message` = `error.message ?? segmentData.message ?? "The agent reported an error."`, `code`, `metadata.abacus.error` verbatim). Later ones in the same run go out as `CUSTOM agent.error`. |
| `command` | `session.ts:2096`, `:2157`, `:2172`, `:2214` (set_model paths, including `forwardedProps.model`); `bot-session.ts:942` | `CUSTOM agent.error`, never terminal |
| `startup` | `host.ts:79`, `session.ts:1069`, `bot-session.ts:441` | `CUSTOM agent.error` |
| `host` | `host.ts:109` (malformed), `host.ts:128` for other commands | `CUSTOM agent.error` |

On compat, errors keep today's exact order, including idle-then-error. `MessagingGatewayService` ignores a provider failure that arrives after idle (`messaging-gateway-service.ts:1209-1241`), and `feedTurnWaiter` resolves on idle first (`service-host.ts:3449-3465`). Both keep doing so because they read compat (finding 15). The renderer gets one terminal per run, and that divergence is intended and confined to the chat UI.

### 3.3 Mapping table: every current emit site

Notation: every row also writes its legacy line to compat unchanged, unless it is marked "internal". The AG-UI column is stdout only.

#### 3.3.1 `host.ts` (shared via `agui/queue.ts`)

| Site | Legacy (compat) | AG-UI |
|---|---|---|
| `:79-85` | `error startup_failed` | `CUSTOM agent.error`. Exit as today. |
| `:109-119` | `error malformed_command` | `CUSTOM agent.error` |
| `:127-131` | `error` (handler threw) | Per origin (§3.2) |
| `:176-179` | `status_changed idle` after stop | `RUN_FINISHED cancelled` (settle), then `CUSTOM agent.status {idle}` |
| `:306-310` | `mcp_server_logs` | `CUSTOM mcp.server_logs` |
| `:362-365`, `:415-418` | `user_message_dequeued` | Opens a server run: `queue.dequeued` + user `TEXT_MESSAGE_*` (§3.1.3) |
| `:372-375` | `status_changed idle` (runTurn finally) | `CUSTOM agent.status {idle}`; settle via `finally` if not already settled |
| `:468` | re-emitted `user_message_steered` | See `session.ts:1998` |
| `:479` | `queue_updated` | `CUSTOM queue.updated` |

#### 3.3.2 `session.ts`

| Site | Legacy (compat) | AG-UI |
|---|---|---|
| `:610-615` | `host_service_request` | **None** (§3.7) |
| `:640-642` → `tool-heartbeat.ts:67` | `heartbeat` | `CUSTOM agent.heartbeat` |
| `:1060`, `:1092-1101`, `:2347` | `ready` | `CUSTOM session.ready` (+ `incarnation`), then `STATE_SNAPSHOT`. The startup `applyMode` (`:2648`) folds into the snapshot. |
| `:1069-1072` | `error model_unavailable` | `CUSTOM agent.error` (origin startup) |
| `:1076-1080`, `:1454-1459`, `:1478-1483`, `:2033-2037` | `notification` | `CUSTOM agent.notification` |
| `:1083`, `:3277-3288` | `skills_loaded` | `CUSTOM skills.loaded` |
| `:749`, `:1084`, `:1104-1117`, `:1126`, `:1129` | `mcp_servers` | `CUSTOM mcp.servers` |
| `:1235-1238`, `:2366-2371`, `:2453-2456`, `:2739-2742`, `:2863-2872`, `:2928-2938`, `:1967-1970`, `:2351` | `status_changed` | `CUSTOM agent.status`. The run stays open while waiting for a permission (§3.5). |
| `:1249`, `:1275`, `:1296`, `:1553`, `:1653`, `:1737` | `error` (turn) | Terminal (§3.2) |
| `:2096`, `:2157`, `:2172`, `:2214` | `error model_unavailable` (command) | `CUSTOM agent.error` |
| `:1767-1770`, `:2184-2187`, `:2233-2236` | `model_changed` | `STATE_DELTA [{op:"replace", path:"/model"}]` |
| `:2038-2042`, `:2078` | `mode_changed {mode, source}` | `STATE_DELTA [{replace /mode}, {replace /modeSource}]` |
| `:1952-1956` | `subtask_end failed` (components in `finishTurn`) | Per §3.1.5 ordering: `SUBAGENT_ERROR {code:"unfinished"}` |
| `:1962-1965` | `turn_complete {usage}` | None; the usage is recorded for the terminal |
| `:1998` | `user_message_steered` | `CUSTOM queue.steered` + **user** `TEXT_MESSAGE_START {role:"user", messageId:"steer-<n>"}` / `CONTENT` / `END`, then `queue.updated`. This covers the steers from `accept_with_message` (`:3085-3087`) and `question_answers` (`:3107-3110`). |
| `:2350` | `segments_cleared` | Close the open run as `cancelled` (settle), then `CUSTOM session.cleared` |
| `:2374-2381` `message_start` | none | internal `message_open {key:"msg-N", messageId}` → `TEXT_MESSAGE_START {role:"assistant"}` |
| `:2389-2420` `message_end` | `text_delta` remainder | `TEXT_MESSAGE_CONTENT`; internal `message_close {key, stopReason}` → `TEXT_MESSAGE_END` |
| `:2601-2612` | `text_delta` | `TEXT_MESSAGE_CONTENT` (an open reasoning block closes first) |
| `:2614-2627` | `thinking_delta` / `thinking_complete` | `REASONING_START` + `REASONING_MESSAGE_START {messageId: <msg>:think:<n>}` / `REASONING_MESSAGE_CONTENT` / `REASONING_MESSAGE_END` + `REASONING_END` |
| `:2440-2445` | `subtask_start` (component) | `SUBAGENT_STARTED {subagentRunId:"component-"+toolCallId, name:"component", description, parentToolCallId, parentMessageId}` |
| `:2457` | `tool_execution_start` | Announce, if not already announced (§3.3.5) |
| `:2467-2471` | `tool_output_update` | `CUSTOM tool.output` |
| `:2487-2495` | `tool_execution_complete` | `TOOL_CALL_RESULT` (§3.3.6) |
| `:2502-2506` | `subtask_end` (component) | `SUBAGENT_FINISHED {outcome:{type:"success"}}`, or `SUBAGENT_ERROR {code:"failed"}` |
| `:2582-2595` | `retry` | `CUSTOM agent.retry` |
| `:2650` gate entry (new) | internal `tool_call_start {toolCallId, toolName, input}` | Announce (§3.3.5) |
| gate block returns (`:2680-2687` plan decline, `:2689-2691` refuse, `:2709-2724` no answerer, `applyDecision` blocks) (new) | internal `tool_blocked {toolCallId, cause: "rejected" \| "refused" \| "expired" \| "stopped"}` | Sets that call's `toolResultOutcome` (§3.3.6) |
| `:2697-2704` | `tool_display_data` | `CUSTOM tool.display` |
| `:2734-2738`, `:2862`, `:2927` | `permission_needed` | `CUSTOM permission.requested` + `permission.pending` (§3.5) |
| `:2777`, `:3192` | `permission_cleared` | `CUSTOM permission.cleared {reason: expired \| stopped/reset}` + `permission.pending` |
| todo `tool_execution_end` (new; `session.ts:2477`) | internal `plan_changed {todos: readTodos()}` after a non-error `todo` call | `STATE_DELTA [{op:"add", path:"/plan", value}]`. `add` sets or replaces, so it is valid when absent (finding 19). |

#### 3.3.3 `bot/bot-session.ts`

Same mapping as `session.ts` for these sites:

- `:217`, `:438`, `:441`, `:448`, `:449`, `:529`, `:796`, `:836-851`, `:886`, `:957`, `:1010`, `:1013-1014`, `:1024`, `:1061`;
- `:1098`, `:1129-1145`, `:1165-1199`, `:1224-1271`, `:1323`, `:1369-1374`, `:1418`, `:1428-1436`, `:1443`, `:1481`, `:1553`, `:1560`.

The origins are:

- `:508`, `:540`, `:721` and `:761` are turn origin;
- `:942` is command origin;
- `:441` is startup origin.

The gate entry (`:1382`) and its block returns emit the same internals. Hidden turns are covered in §4.

#### 3.3.4 Sub-agents and component tools

| Site | Legacy (compat, unchanged) | AG-UI |
|---|---|---|
| `delegate-tool.ts:100`, `document-tool.ts:112`, `deck-tool.ts:120`, `design-tool.ts:133`, `browser-task-tool.ts:244` | `subtask_start` | `SUBAGENT_STARTED {subagentRunId: id, name: kind ?? "delegate", description, parentToolCallId: execute's toolCallId, parentMessageId}` |
| `delegate-tool.ts:123`, `document-tool.ts:137`, `deck-tool.ts:145`, `design-tool.ts:165` | `text_delta {content}`, **no messageId** (unchanged on compat) | Child message `messageId = subagentRunId+":final"`, tagged. It is also carried as `SUBAGENT_FINISHED.result`. |
| `browser-task.ts:536-540` | `text_delta {messageId:"web-N"}` (unchanged on compat) | Child message `messageId = subagentRunId+":web-N"`, tagged. A new N closes the previous one. |
| `subagent-events.ts:89-97`, `:113-121`, `:131-144` | `tool_execution_start/complete` with prefixed ids | Tagged `TOOL_CALL_*`. AG-UI `toolCallId = subagentRunId+":"+legacyId` (§3.3.7). |
| `delegate-tool.ts:125`, `document-tool.ts:139`, `deck-tool.ts:147`, `design-tool.ts:167`, `browser-task-tool.ts:273-278` | `subtask_end {status, outcome?}` | After the child's open message is closed: `SUBAGENT_FINISHED {result?, outcome:{type:"success"}, metadata.abacus.outcome?}`, or `SUBAGENT_ERROR {code:"failed", message: result text \|\| "The sub-agent did not finish."}`. The forwarders' `settle()` (inside `run*Task`'s finally) always precedes `subtask_end`, so child tool results already precede the terminal. |

Attribution is explicit. `scopeEmit(emit, subagentRunId)` (`agui/scope.ts`) stamps an internal `subagentRunId` on everything forwarded for a child. The five tools pass it into `run*Task`, and add `parentToolCallId` to their `subtask_start` (`delegate-tool.ts:74/100/112`, `document-tool.ts:73/112/122`, `deck-tool.ts:77/120/135`, `design-tool.ts:90/133/155`, `browser-task-tool.ts:185/244/258`). Both fields are stripped from compat.

#### 3.3.5 Tool-call announcement (finding 21)

`AssistantMessageEvent` shapes are the same on pi 0.85.1 and 0.99.1:

| Event | Fields | Handling |
|---|---|---|
| `toolcall_start` | `{contentIndex, partial}` | Read `block = partial.content[contentIndex]`. If `block?.type === "toolCall"` and `block.id` is a non-empty string, emit internal `tool_call_start {toolCallId: block.id, toolName: display(block.name), input: block.arguments if object}`. If the id is missing, defer: remember `contentIndex` and announce at the first delta or the end that has one. |
| `toolcall_delta` | `{contentIndex, delta, partial}` | Resolve the id the same way, then emit internal `tool_call_delta {toolCallId, argumentsDelta: delta}` |
| `toolcall_end` | `{contentIndex, toolCall, partial}` | Emit internal `tool_call_stop {toolCallId: toolCall.id, toolName, arguments: JSON.stringify(toolCall.arguments)}` |

The session forwards these from `onStreamEvent` (`session.ts:2599`) and the bot's stream branch (`bot-session.ts:1115`, not in hidden turns). They are internal because `messaging-gateway-service.ts:1199-1204` resets on `tool_call_start`, so they never reach compat.

Emitter bookkeeping is keyed by `(subagentRunId ?? "", toolCallId)` (finding 18):

- `TOOL_CALL_START` goes out once, at the first of: stream start, gate entry, or `tool_execution_start`.
  - It carries the display name and `metadata.abacus.rawName`.
  - `parentMessageId` is the current assistant message.
- `TOOL_CALL_ARGS` carries the streamed deltas. If none were streamed, a single `ARGS` carries `JSON.stringify(input)`.
- `TOOL_CALL_END` goes out once, with `metadata.tanstack.input`.
- The order is `START < ARGS* < END < RESULT`, with `RESULT` at most once.
- Title and kind are **not** sent as updatable metadata (finding 25). The chat kit computes them at render time from `part.name` + `part.input` using the vendored helpers, which the agent package exports as `@abacus-ai/agent/tool-display`. So they always reflect the final input.

#### 3.3.6 Tool results (finding 10)

`tool_execution_end` produces `TOOL_CALL_RESULT {messageId: toolCallId+":result", toolCallId, role:"tool", content: JSON(ToolResultContent)}`:

- `text` = today's `resultText(result)`.
- `rejected` = `event.isError === true`.
- When `rejected`, `metadata.tanstack.state = "output-error"`, `error = text`, and `toolResultOutcome` is:
  - `"denied"` if a `tool_blocked {cause: rejected | refused | expired}` was recorded for the call;
  - `"cancelled"` for `stopped`, or for a synthetic unfinished result;
  - absent otherwise (a plain tool failure).

A processor probe must render these as `state:"error"` with the text as the error (§7.6).

#### 3.3.7 Ids

| Id | Value |
|---|---|
| Assistant message | `${agentSessionId}:${partial.timestamp}` (pi `AssistantMessage.timestamp`, persisted in the pi file). A collision gets a `:2` suffix; a missing timestamp falls back to `${agentSessionId}:msg-N`. |
| Tool call | pi's id |
| Child tool call | `${subagentRunId}:${legacyPrefixedId}`, with the legacy id in `metadata.abacus.legacyToolCallId`. This makes child ids unique across parallel children that reuse provider ids. |
| Child message | `${subagentRunId}:final` or `${subagentRunId}:web-N`. Unique per invocation, routed by `subagentRunId`. Compat keeps the legacy absence or `web-N` exactly (finding 17). |
| Result message | `${toolCallId}:result` |
| Reasoning | `${messageId}:think:${n}` |
| User message | `${runId}:user`, or `steer-${n}` |
| Permission | `perm-N` (with `incarnation` in the lineage) |
| Subagent run | today's subtask id |

#### 3.3.8 Usage

`TurnUsage` maps to:

```
usage: [{model, inputTokens: input, outputTokens: output, cachedInputTokens: cacheRead,
         cacheWriteInputTokens: cacheWrite, totalTokens: input + output + cacheRead + cacheWrite}]
```

The raw value is also kept in `metadata.abacus.turnUsage`. When several land in one run, the last wins.

#### 3.3.9 Declared, never produced

`credits`, `network_status`, `conversation_loaded`, `segment_updated`, `tool_requested`, `tool_user_message`, `mcp_server_status`, `mcp_server_log`, `mcp_refresh_failed` and `mcp_restart_failed` have no producer in `packages/agent/src`. No AG-UI mapping is defined for them.

### 3.4 Roles (finding 16)

- **`TEXT_MESSAGE_START.role`** is set on every message:
  - `assistant` for the agent's and children's text;
  - `user` for dequeued and steered input.

  `CONTENT` and `END` inherit it through `messageId`. No main tap reads AG-UI text; they read compat. The renderer and main's transcript builder keep roles from `START`.
- **`agent.status`** is kept for avatar mood, the notch and diagnostics. Run state is derived from `RUN_*` only.

### 3.5 Permissions: independent descriptors plus a control command (findings 3–9)

**Why not native interrupts.** TanStack's `InterruptManager.hydrate()` replaces the pending set on every interrupt terminal, and `maybeSubmit()` submits only when every item is staged. Today each `permission_response` releases its own waiter at once, and several cards can be up together (parallel tools, sandbox asks). Independent resolution cannot go through ChatClient's native interrupt path, so the agent does not use it.

- No `RUN_FINISHED{interrupt}` and no `approval-requested` are emitted.
- A permission does **not** end the run. The run stays open while the pi turn waits, exactly as the turn stays busy today.
- ChatClient's `interrupts` stays empty. The chat kit renders permissions from the descriptor store (§3.5.5).

#### 3.5.1 Emission

A `permission_needed {permissionId, request}` event is handled as follows:

1. The legacy line goes to compat unchanged. Main's taps, including auto-allow, see it exactly as today.
2. Build the `PermissionDescriptor`:
   - `id` = permissionId;
   - `reason` = `abacus:question` for `ask_user_question`, else `abacus:permission`;
   - `message` = `request.displayName`;
   - `toolCallId` and `subagentRunId` per §3.5.4;
   - `expiresAt` = the deadline when `approvalTimeoutMs()` is finite;
   - `metadata.abacus` = `{lineage, kind, request, attachedBy, allowed}`.
3. Emit `CUSTOM permission.requested {descriptor}`, then `CUSTOM permission.pending {incarnation, items}`, the authoritative set.

The run, messages and siblings are untouched. Other tools' events keep streaming **immediately** (finding 9: no buffering anywhere). A sibling's `TOOL_CALL_RESULT` reaches the renderer at once, and its compat line reaches artifact extraction at once, as today. Stop during the permission discards nothing that was already emitted.

#### 3.5.2 The decision envelope (finding 7)

The renderer sends `permission.respond {lineage, decision}`. `decision` is exactly one `PermissionDecision` (`protocol.ts:256-266`), the same value today's `permission_response` carries. The descriptor's `allowed` lists the kinds a widget may send; the host rejects others with `decision_not_allowed`.

| `request.type` | Allowed decisions | Meaning (unchanged `applyDecision*`) |
|---|---|---|
| `edit_file`, `write_file`, `delete`, `notebook_edit`, `generic`, `browser_action`, `fetch_url` | `"accept"`, `"reject"`, `"allowAlways"`, `"allowYolo"`, `{type:"accept_with_message", message}`, `{type:"reject_with_message", message}` | `session.ts:3029-3123` |
| `run_terminal` | Everything above, plus `"background"`, `{type:"allow_always_with_rule", rule}`, `{type:"allow_always_with_rules", rules}` | Rules append to `sessionAllowedCommands`. The credential unhide is `:3038-3048`. |
| `read_outside_directory`, `write_outside_directory`, `edit_outside_directory`, `notebook_edit_outside_directory` | `"accept"`, `"reject"`, `"allowAlways"`, `"allowYolo"`, `accept_with_message`, `reject_with_message` | `allowAlways` scopes to `deducedDirectory` |
| `exit_plan_mode` | `"accept"`, `accept_with_message` (→ Normal), `"allowAlways"` (→ AcceptEdits), `"allowYolo"` (→ Yolo), `"reject"` / `reject_with_message` (decline) | `applyPlanDecision` (`:2995-3027`) |
| `ask_user_question` | `{type:"question_answers", answers: Record<string,string>}`, `"reject"` | Answers are steered as JSON |
| `sandbox_denied` | `"accept"` / `accept_with_message` / `"background"` (once), `"allowAlways"` / `allow_always_with_rule(s)` / `"allowYolo"` (session), `"reject"` / `reject_with_message` (refuse) | `askDenials` (`:2878-2896`) |
| `network_host` | Same as `sandbox_denied` | `askNetworkHost` (`:2944-2960`) |

**Validation.** Structural validation against the `PermissionDecision` union is strict. Anything else, including booleans and `{approved}`, is `invalid_decision`. It is **never** coerced to reject.

PLAN.md's `resolveInterrupt(approved, {payload})` is superseded. The chat-kit widgets call the renderer's `respondPermission(descriptor, decision)`, which forwards to main's procedure and on to this command.

#### 3.5.3 Lineage, stale and invalid answers (findings 3, 4)

A `permission.respond` is applied **only if all** of these hold:

- `lineage.incarnation` equals this process's incarnation. It is a `randomUUID()` minted at start and carried in `session.ready`, `AgentState` and every descriptor.
- `lineage.threadId` equals `--thread-id`.
- `lineage.permissionId` is in the session's pending map.
- `lineage.runId` equals the run that permission was raised in.

The decision must also be valid and allowed.

**Otherwise nothing is answered:**

- The host emits `CUSTOM permission.response_rejected {lineage, reason}` followed by `CUSTOM permission.pending`, the authoritative current set.
- A pending permission that happens to share the id keeps waiting, and its card stays up.
- An answer is never reported as success unless a waiter was released.
- The compat stream gets **no** line. Nothing reached the session.

**On success:**

1. `session.respondPermission(id, decision)`.
2. `awaitingPermission = false` and `releaseParked()`, identical to `host.ts:199-205`.
3. `CUSTOM permission.resolved {permissionId, decisionKind, source:"respond"}`, then `permission.pending`.

The legacy `permission_response` keeps today's semantics exactly (`respondPermission` ignores unknown ids). It is trusted without lineage: only main writes it, and main reads this process's own compat stream under its ownership guard (`cli-manager-service.ts:640-646`). If it released a waiter, the host emits `permission.resolved {source:"legacy_response"}` and `permission.pending`.

#### 3.5.4 Attaching to a tool call (finding 6)

| Request source | `toolCallId` | `subagentRunId` | `attachedBy` |
|---|---|---|---|
| Gate (`session.ts:2650`, `bot-session.ts:1382`) | `request.tool.id` | none (the gate runs only in the parent) | `gate` |
| `askDenials` (`session.ts:2830`) | The most recently started, still-running call (parent or child) whose `input.command === request.command`. Its AG-UI id. | that call's | `command-match` |
| `askNetworkHost` (`session.ts:2900`), or `askDenials` with no match | The single running `bash`-kind call, if exactly one | its | `sole-running` |
| otherwise | none | none | `none` |

**The join is explicit and ours.** The chat kit's tool widget looks up the descriptor store by `(subagentRunId ?? "", toolCallId)` and renders the approval inline. Descriptors with no `toolCallId`, or whose tool part is not mounted, render in the Interrupts slot. TanStack's `selectChatUI` join (`selectors.ts:100-138`, `tool-approval` only) is not relied on.

#### 3.5.5 Expiry, stop, reset, reload (finding 8)

- **Expiry** (`session.ts:2777`, `bot-session.ts:1443`):
  - `CUSTOM permission.cleared {reason:"expired"}` + `permission.pending`;
  - `tool_blocked {cause:"expired"}` for gate-attached calls.

  The turn continues with today's rejection text inside the same open run. Nothing is reconciled against a ChatClient batch because none exists. The descriptor store removes exactly the expired item, and the other cards stay actionable.
- **Stop and reset** (`rejectAllPending`, `session.ts:3188`, `bot-session.ts:1550`): `permission.cleared {reason:"stopped" | "reset"}` for each, then `permission.pending {items: []}`.
- **Reload, second window, ring eviction.** The store is rebuilt from `session.sync` (§5.3), which carries the pending descriptors.

#### 3.5.6 Browser auto-allow (finding 1)

Browser auto-allow stays in main, unchanged:

1. `AgentCommunicationService.handleDesktopEvent` sees `permission_needed` on compat.
2. It returns `autoAllowDecision` for `browser_navigate` / `browser_snapshot` (`cli-communication-service.ts:38-41`).
3. `service-host.ts:1231-1238` writes the legacy `permission_response`.

The answer crosses two pipes, so it always arrives after the waiter is registered, as today. The post-Stop suppression (`service-host.ts:1222-1228`) is preserved.

Rev 1's agent-side `--auto-allow` flag is removed. It would have answered before `awaitDecision` registered the waiter (`session.ts:2734` vs `:2768`; `bot-session.ts:1428` vs the promise below it) and lost the answer.

On AG-UI the renderer sees `permission.requested` followed shortly by `permission.resolved {source:"legacy_response"}`. Main's renderer relay may suppress `permission.requested` for the two auto-allowed tool names, since it holds that list.

### 3.6 Sub-agents

- **Stop from a card** (`SubagentHandle.stop()`) sends `cancel`, which is today's Stop.
- **pi 0.99's `parentToolCallId`** on session events is not used.
- **Nested scopes** set `parentSubagentRunId`. None exist today.

### 3.7 Host services (finding 20)

Host services stay entirely on the legacy path:

1. `host_service_request` goes out on compat.
2. `AgentManagerService.answerHostService` (`cli-manager-service.ts:935-942`, `:1106-1131`) answers.
3. The answer is the legacy `host_service_response` on stdin.

Nothing is emitted on AG-UI, so there is nothing for main to filter, and no payload leaks into the renderer or the replay ring. The renderer never needs them: the owning tool's own `TOOL_CALL_*` and its component subagent events already show progress. Rev 1's `client_tool_result` command and `host.*` client-tool encoding are removed.

### 3.8 Cancel, reset, exit: the abort path and "always a terminal"

- **`cancel`** runs `host.ts:160-182` verbatim, with the queue entries set to `"turn"` and `queue_updated`. The steps are:
  1. `turn += 1`, `stopping = true`.
  2. **`runs.markCancelling(token)`** (synchronous).
  3. `await session.stop()`.
  4. `stopping = false`, `busy = false`.
  5. Settle `cancelled` (`stopReason:"aborted"`).
  6. `agent.status idle`.
  7. `runAfterStop()`.
- **`reset_conversation`** follows `host.ts:207-218`. It marks the run cancelling and settles it cancelled. `session.ready` (new pi session id and file, same incarnation), `STATE_SNAPSHOT`, `session.cleared` and `agent.status idle` follow.
- **stdin EOF.** After in-flight commands settle (`host.ts:138-145`), an open run gets `RUN_ERROR {code:"agent_exit"}`.
- **Crash.** In `main.ts:18-29` and `process.on("exit")`, `host.emergencyClose(code)` writes `RUN_ERROR {agent_crashed | agent_exit}` for an open run with `fs.writeSync(1, …)`. It is idempotent. The compat stream gets nothing extra: today's crash writes nothing either.
- **Structural guarantee.**
  - `RUN_STARTED` is written only by `runs.open(token)`, which throws when a run is open.
  - Every `session.send` is wrapped in a token-owned `try/finally` settle.
  - For every `RUN_STARTED{runId}` there is exactly one terminal before the next `RUN_STARTED` and before exit. The one exception is SIGKILL, for which main synthesizes a terminal (main slice).
- **No agent-side watchdog** (finding 22).
  - Main's inactivity watchdog keeps reading compat and sends `stop` exactly as today (`service-host.ts:1463-1488`). That produces the `cancelled` terminal on AG-UI.
  - Main additionally emits its own `RUN_ERROR {code:"inactivity_timeout"}` to the renderer, and the first terminal per `runId` wins (main slice).
  - A standalone watchdog is a separately authorised change and not part of this slice.

---

## 4. Bot loop

- **Hidden turns are never emitted on AG-UI.**
  - `runHiddenTurn` (`bot-session.ts:587-608`) brackets `sendCustomMessage` with the internal `hidden_turn {phase:"start" | "end"}`.
  - Between them the emitter drops every run-scoped event plus `agent.status`, `agent.retry` and `agent.heartbeat`.
  - Hidden-turn usage is logged to stderr: `[usage] housekeeping <customType> <json>`.
  - A permission raised in a hidden turn still produces `permission.requested`, so it can be answered, as today's card could be.
  - **The compat stream is unchanged:** it still carries the lines the bot leaks today (`:1098`, `:1323`, `:1369-1374`, `:217`), so main's turn state behaves exactly as before.
- **The user's run settles before housekeeping.** The `settled()` callback fires before `runMemoryMaintenance()` (§3.1.5). `busy` stays true until `send()` resolves, as today. That keeps today's quirk that a message sent during a housekeeping turn is steered into it (§8.3).
- **Sanitiser first.** The only inputs are the `text_delta` / `thinking_delta` events the bot emits after `BotOutputSanitizer.push/flush` and `tidyBotText` (`bot-session.ts:1126`, `:1159-1160`, `:1179-1182`). The emitter never subscribes to pi directly, so every bot `TEXT_MESSAGE_CONTENT` is post-sanitiser, and `<think>` content becomes `REASONING_*`.
- **No `CUSTOM bot.reply`.** The messaging relay keeps parsing `text_delta` from **compat**: the per-`messageId` buffer, the last `<reply>`, `NO_REPLY`, `DEFERRAL`, ending on `idle` and ignoring errors after idle. `NO_REPLY` also travels as plain AG-UI text.

---

## 5. Replay, hydration, and what main needs

### 5.1 Unchanged, via compat

Main's taps consume compat unchanged:

- `recordAgentSession` from `ready` (`service-host.ts:1184-1190`), so the thread ↔ pi session file mapping is unchanged;
- turn state and watchdog;
- messaging;
- artifacts;
- routine settle;
- turn waiter;
- state patch;
- auto-allow;
- skills and MCP;
- host services;
- usage log.

The `health-check.ts` ready probe keeps spawning `--wire ndjson` until cut-over.

### 5.2 New, for the renderer (main slice)

- **`ai.send`** writes `run` and resolves from the synchronous `run.ack`:
  - `started`: the client awaits the run's events;
  - `queued`: the adapter settles the client-side send without awaiting a run, and the chat kit shows the entry in the queue slot from `queue.updated`;
  - `duplicate` / `rejected`: the adapter settles with an error for `rejected`, and does nothing for `duplicate`.
- **Main's ring** holds the AG-UI stdout. The first terminal per `runId` is authoritative.
- **The descriptor store** is built from `permission.pending`, which replaces the store's content wholesale.
- **The permission procedure** is `ai.respondPermission(lineage, decision)`, which writes `permission.respond`.

### 5.3 Authoritative hydration and the replay-gap protocol (finding 23)

The agent keeps no transcript. It provides a snapshot of **live** state on demand:

```ts
export interface SessionSync {
  incarnation: string;
  state: AgentState;
  queue: { messages: QueueEntry[] };
  pendingPermissions: PermissionDescriptor[];
  run: null | {
    runId: string;
    threadId: string;
    parentRunId?: string;
    serverInitiated: boolean;
    openMessage?: { messageId: string; role: "assistant" | "user"; subagentRunId?: string };
    openReasoning?: { messageId: string };
    /** Announced, unresolved calls: enough to re-announce START/ARGS/END. */
    openToolCalls: Array<{ toolCallId: string; toolCallName: string; rawName: string; input: Record<string, unknown>; subagentRunId?: string; parentMessageId?: string }>;
    /** Open subagents, outermost first: enough to re-announce SUBAGENT_STARTED. */
    openSubagents: Array<{ subagentRunId: string; name: string; description?: string; parentToolCallId?: string; parentMessageId?: string; parentSubagentRunId?: string }>;
  };
}
```

`sync` is answered at once, while a run is open too, with `CUSTOM session.sync`. It writes no compat line.

**Protocol (implemented in main; the agent's part is `sync` and its correctness):**

1. **Main's persisted transcript.** Main keeps an authoritative per-thread transcript of *completed* runs. It is built by running the AG-UI stream through TanStack's `StreamProcessor` in main and persisted at each terminal. This is the source of `MESSAGES_SNAPSHOT` for a fresh client.
2. **Fresh attach** (reload, second window) or a **gap** (`lastEventId` older than the ring's start):
   1. Main sends `MESSAGES_SNAPSHOT` from the persisted transcript.
   2. Main issues `sync`.
   3. If `run` is non-null, main replays a synthetic prefix for the live run:
      - `RUN_STARTED`;
      - `SUBAGENT_STARTED` for each open subagent (outermost first);
      - `TOOL_CALL_START/ARGS/END` for each open call;
      - `TEXT_MESSAGE_START` for the open message;
      - `REASONING_START` + `REASONING_MESSAGE_START` for open reasoning.
   4. Main switches to live events after the sync point.
   5. Main loads the descriptor store from `pendingPermissions` and the queue from `queue`.

   This fixes the two failures the review found: a tool result needs its tool part, and a tagged child event needs its subagent card.
3. **In-ring resume** (`lastEventId` within the ring) replays from the ring as before.
4. **Descriptors for a dead incarnation.** When the stored descriptors' `incarnation` ≠ the live `session.ready.incarnation`, main drops them. They cannot be answered (§3.5.3).

---

## 6. Files

### 6.1 Add (`packages/agent/src/agui/`)

| File | Contents |
|---|---|
| `wire.ts` | The §2 types (built on `@ag-ui/core`). Types only. |
| `event.ts` | `aguiEvent()`, the single checked constructor using `EventType`, plus `timestamp`. |
| `emit.ts` | `AguiEmitter`: a pure, synchronous translator from `DesktopEvent` + internal events to `AguiEvent[]`. State: open message/reasoning (with role), tool bookkeeping keyed by `(subagentRunId, toolCallId)`, merged display/output, blocked causes, open subagents, pre-ready state, hidden depth. |
| `runs.ts` | `RunController`: tokens, `open` / `settle` / `markCancelling` / `emergencyClose`, the closing order (§3.1.5), terminal recording by origin. |
| `sink.ts` | `HostSink`: one `emit()` feeding `toNdjsonWire` → compat (or stdout under `ndjson`) and `AguiEmitter` → stdout (§2.4). Opens the compat channel. |
| `queue.ts` | Queue and turn logic extracted verbatim from `host.ts:28-485` (`runTurn`, `admit`, `runAfterStop`, `releaseParked`, `resyncSteers`, `onSessionEvent`, `echoed`, `stopping`, `awaitingPermission`, `turn`), plus the synchronous `reserved` flag. Both hosts use it. |
| `host.ts` | `AguiHost`: the stdin loop (`host.ts:90-145`), the legacy command table, `run` / `cancel` / `permission.respond` / `sync`. |
| `permissions.ts` | `toDescriptor`, `allowedDecisions(kind)`, `isPermissionDecision`, `validateLineage`, `attachToolCall`, the pending map mirror. |
| `ids.ts` | Id helpers (§3.3.7) and `incarnation`. |
| `scope.ts` | `scopeEmit`. |
| `vendor/pi-acp/` | §6.2, with the MIT `LICENSE` and the source commit in a header comment. |
| `__fixtures__/`, `*.test.ts` | §7 |

The agent package also adds the export `./tool-display` (`buildToolTitle`, `toToolKind`, `formatToolContent`) for the chat kit.

### 6.2 Vendored from pi-acp (MIT)

| Helper | Source | Lands in | Changes |
|---|---|---|---|
| `buildToolTitle` | `pi-acp/src/acp/session.ts:92-149` | `vendor/pi-acp/tool-title.ts` | Keep `read` / `write` / `edit` / `bash` and the 80-char truncation. Add our tools (`grep`, `find`/`glob`, `ls`, `web_fetch`, `web_search`, `delegate_task`, `browser_task`, `ast_edit`, `batch_edit`, `batch_file_read`, `todo`, `memory`, `document`/`pdf`/`ppt`/`design`/`app`). Drop `lsp` / `tmux` / `context_*` / `claudemon`. |
| `toToolKind` | `:57-72` | `vendor/pi-acp/tool-kind.ts` | Extended mapping: read (`read`, `batch_file_read`, `ls`), edit (`write`, `edit`, `ast_edit`, `batch_edit`), execute (`bash`), search (`grep`, `find`/`glob`, `web_search`), fetch (`web_fetch`), think (`delegate_task`), switch_mode (`exit_plan_mode`), else other |
| `formatToolContent` + extractors | `translate/tool-content.ts:57-300` | `vendor/pi-acp/tool-content.ts` | Returns a markdown string, used for `ToolResultContent.formatted` only |
| `mapPiStopReason` | `session.ts:151-170` | `vendor/pi-acp/stop-reason.ts` | Kept as `toAcpStopReason`. Adds `toFinishReason`: stop → `"stop"`, length → `"length"`, toolUse → `"tool_calls"`, deferred → `"stop"`, else `null`. |

### 6.3 Change

| File | Change |
|---|---|
| `protocol.ts` | Add `InternalAgentEvent`: `message_open`, `message_close`, `tool_call_start` / `tool_call_delta` / `tool_call_stop` (the existing producer-less shapes at `:126-133`), `tool_blocked`, `plan_changed`, `hidden_turn`. Add optional internal fields: `origin` on `error`, `subagentRunId` on every `AgentEvent`, `parentToolCallId` on `subtask_start`. `DesktopEvent` / `DesktopCommand` are unchanged. |
| `host.ts` (`NdjsonHost`) | Becomes `queue.ts` + `HostSink` with the compat writer = stdout and no AG-UI emitter. Output is byte-identical (§7.2). `ABACUSAI_BOT_WIRE_RECORD=<path>` records stdin plus pre-strip events for fixtures. |
| `main.ts` | Parse `--wire`, `--thread-id`, `--compat-fd`, `--compat-pipe`. Exit with code 78 when the compat channel fails. Wire `emergencyClose` into `:18-29` and `exit`. |
| `index.ts` | Export `AguiHost` and the wire types; keep `NdjsonHost`. |
| `session.ts` | Emit internal `message_open` / `message_close` (`:2374`, `:2389`) and `tool_call_*` (`:2599`, extracted per §3.3.5). The gate emits `tool_call_start` at entry (`:2650`) and `tool_blocked` at its block returns. Add `origin` at the error sites in §3.2. Emit `plan_changed` on a successful `todo` end (`:2477`). `send(text, turn?)` calls `turn.settled()` per §3.1.5. No logic change. |
| `bot/bot-session.ts` | The same internals (suppressed in hidden turns), `origin`, `send(text, turn?)`, `settled()` at `:537` / `:540` / `:508`, and `hidden_turn` at `:595` / `:605`. |
| `delegate-tool.ts`, `document-tool.ts`, `deck-tool.ts`, `design-tool.ts`, `browser-task-tool.ts` | `scopeEmit` and `parentToolCallId` (§3.3.4) |
| `package.json` | `dependencies`: `@ag-ui/core@1.0.0`. `devDependencies`: `@tanstack/ai@0.63.x` and `@tanstack/ai-client@0.36.x`, for the conformance, processor and ChatClient tests (finding 24). |

These are **not** changed: `tool-heartbeat.ts`, `host-services.ts`, `subagent-events.ts`, `delegation.ts`, `*-task.ts`, `permissions.ts`, and all of main.

### 6.4 Delete

Nothing in this slice. At cut-over (phase 7), the NDJSON-only host path and the `--wire` flag go. The compat stream stays until main's taps are ported to AG-UI in a later, separately specified slice.

---

## 7. Test plan

### 7.1 Golden fixtures

1. **Record.** Run `NdjsonHost` with `ABACUSAI_BOT_WIRE_RECORD` against scripted `@abacus-ai/test-support/fake-provider` replies, one per scenario. This produces `__fixtures__/<scenario>.jsonl` (commands plus pre-strip internal events). The ids and times are deterministic under the in-process harness (§7.2).
2. **AG-UI golden.** Replay through `HostSink` + `AguiEmitter` + `RunController`, driving the commands through a fake session that replays the recorded internal events. Compare with `toMatchFileSnapshot("<scenario>.agui.jsonl")`.

**Scenarios:**

- **Messages:**
  - plain text;
  - thinking + text;
  - two messages with a tool between them.
- **Tools:**
  - bash with streamed output;
  - a `toolcall_start` with no id until the first delta;
  - `todo` set, empty, and whitespace-normalised.
- **Permissions:**
  - edit approved, with the diff before the result;
  - edit rejected with a message (`denied`);
  - `allowAlways`;
  - `run_terminal` with rules and `credentialPaths`;
  - `exit_plan_mode` with each yes and a decline;
  - `ask_user_question`;
  - `sandbox_denied` with a command match;
  - `network_host` with a sole running call;
  - two parallel permissions resolved in reverse order;
  - one expiry while another permission stays pending;
  - auto-allowed `browser_navigate` through the legacy response.
- **Stop and queue:**
  - stop mid-stream;
  - stop during a permission while a sibling finished;
  - stop then an immediate message (`runAfterStop`, echoed);
  - steer, a steer parked behind a permission, dequeue / remove / update / clear, drain.
- **Runs:**
  - `run` while busy (queued ack);
  - `run` during `forwardedProps.model` application;
  - a duplicate `runId`;
  - regenerate after success (rejected);
  - retry after error (re-prompted).
- **Sub-agents:**
  - `delegate_task` with parallel parent bash;
  - two parallel delegates reusing a provider id;
  - `browser_task` child text;
  - a `ppt` component, and an unfinished one.
- **Model and failures:**
  - a `document` render (host service: compat only);
  - OpenLLM rotation;
  - compaction continuation;
  - malformed continuation;
  - `turn_failed` with actions;
  - out of credits;
  - stall;
  - `set_model` failing mid-run (non-terminal);
  - startup `model_unavailable`;
  - invalid `set_mode`;
  - `reset_conversation`.
- **Bot:**
  - `<think>` + `<reply>` + `NO_REPLY`;
  - a bot flush hidden turn;
  - bot no-model.
- **Permission answers:**
  - `permission.respond` with the wrong incarnation, run, or id;
  - an invalid decision;
  - a disallowed decision.

### 7.2 Compat stream is byte-identical (new)

**Harness.** In-process, with:

- `vi.useFakeTimers({ now: FIXED })`;
- a seeded `crypto.randomUUID` spy (so pi session ids and `srv-` ids are deterministic);
- the fake provider;
- injected stdin, stdout and fd-3 streams.

For every §7.1 scenario:

1. Run `--wire ndjson` with the scenario's legacy command script, and capture stdout bytes **B**.
2. Run `--wire agui` with the equivalent script (the AG-UI command → legacy mapping in §2.4, or the same legacy commands for main-originated ones), and capture fd-3 bytes **C**.
3. Assert `C === B`, **byte for byte**, with no normalisation.
4. Assert that **B** equals the checked-in baseline `__fixtures__/<scenario>.ndjson`, recorded from the pre-change build (`git stash` baseline). This proves `--wire ndjson` itself is unchanged.
5. Assert that rejected, duplicate and invalid AG-UI commands (`run.ack rejected/duplicate`, `permission.response_rejected`, `sync`) add **no** bytes to **C**.

**Spawned-process check.** Run `dist/main.js --wire agui --compat-fd 3` against `dist/main.js --wire ndjson` for three scenarios on macOS, Linux and Windows CI. Compare with only the pi session id, `ts` fields and `Date.now()`-derived subtask ids masked. This proves fd 3 works across platforms.

**Fallback check.** With `--compat-pipe` in place of fd 3, run the same comparison. With an unopenable channel, assert exit code 78 and empty stdout.

### 7.3 Porting `transport-bridge.test.ts`

Each of its 16 top-level `describe` groups becomes an emitter test in `agui/emit.test.ts`:

- **Refusals, tool translation, display-before-tool, streaming output:** as rev 1.
- **Sub-agent attribution:** rewritten to explicit tags. It includes parallel brackets and colliding child ids.
- **Stop:** a `cancelled` terminal, with child parts ordered before the subagent terminal.
- **Permission side-channel:**
  - becomes descriptors and `permission.pending`;
  - an answer applies once;
  - a second answer is `not_pending`;
  - expiry removes only its own item;
  - an unknown id changes nothing.
- **Queue:** as rev 1.

The renderer-only groups (`:874-925`, `:1023-1105`) move to the chat-kit spec.

### 7.4 Properties

A seeded generator, 10,000 sequences:

1. **Bracketing.** Exactly one terminal per `RUN_STARTED`, before the next start or the end. No run-scoped event outside a run. No `RUN_STARTED` for a `queued`, `duplicate` or `rejected` ack.
2. **Tokens.** A superseded token's settle never closes a newer run (interleave Stop with delayed `send` resolution).
3. **Admission.** Concurrent `run`s during `forwardedProps` application and during streaming open at most one run. Every other `run` is acked `queued` with the same queue effect as the legacy `send`.
4. **Messages.** `START`/`END` are balanced per id, with a role on every `START`.
5. **Tools.** Per `(subagentRunId, toolCallId)`: `START < ARGS* < END < RESULT`. Exactly one `RESULT` by run end. A rejected result carries `output-error`.
6. **Sub-agents.** Every child event is tagged. The child's results and message ends precede its terminal. One terminal per id.
7. **State.** `STATE_DELTA` applies cleanly (RFC 6902) from the snapshot, including the first `/plan`.
8. **Permissions.** `permission.pending` always equals the session's pending map. A lineage mismatch never releases a waiter.
9. **Hidden turns.** No AG-UI event originates in a hidden turn except `permission.*`. Compat is unaffected.

### 7.5 Permission independence and lineage (findings 1, 3–8)

Spawned `--wire agui` with the fake provider:

- **Independence.** With two parallel edits pending, `permission.respond` for the second: its tool runs and its `TOOL_CALL_RESULT` arrives while the first is still pending. Then answer the first.
- **Lineage.**
  - A replacement process (new incarnation) receives the old process's `perm-1` answer: it is rejected and nothing is released, even though its own `perm-1` is pending.
  - A wrong `runId` or `threadId` is rejected the same way.
- **Envelope.** Every allowed decision in §3.5.2's table, through the renderer's `respondPermission`, produces the same compat lines and session effects as today's `permission_response` with that decision: the mode change, allowances, rule append, question steer, sandbox once/session. Also, `true` and `{approved:true}` are rejected as `invalid_decision`.
- **Expiry.** With `ABACUSAI_BOT_APPROVAL_TIMEOUT_MS=50`, one of two expires. The other remains answerable and its answer applies.
- **Auto-allow.** Main's unchanged `AgentCommunicationService` reads fd 3 and writes `permission_response`. The browser tool runs without waiting for the timeout, and the AG-UI stream shows `requested` → `resolved{legacy_response}`.
- **Sibling artifact.** A sibling `write` finishes, then Stop lands during another permission. The compat stream has its `tool_execution_complete` before the stop, and main's artifact extractor records it. The AG-UI stream has its `TOOL_CALL_RESULT`.

### 7.6 TanStack conformance (findings 10, 11, 24, 25)

- **Types.** `wire.ts` compiles against `@ag-ui/core@1.0.0` and `@tanstack/ai`'s `StreamChunk` with **no casts**: `expectTypeOf<AguiEvent>().toMatchTypeOf<StreamChunk>()`.
- **Processor.** Feed recorded AG-UI through `@tanstack/ai`'s `StreamProcessor`. Assert the resulting parts:
  - text and thinking;
  - a tool-call with output;
  - a rejected result in `state:"error"` with the error text and the `denied` / `cancelled` outcome;
  - a `subagent` part holding the child's tool results and final text **before** its error status;
  - children with colliding legacy ids kept apart.
- **Title and kind.** The rendered title and kind equal `buildToolTitle` / `toToolKind` of the **final** input, asserted through the chat kit's helper (finding 25).
- **ChatClient.** Over a fake `SubscribeConnectionAdapter`:
  - `interrupts` stays empty;
  - a `queued` ack does not hang `send`;
  - a run with a permission stays loading until the answer, then completes.

### 7.7 Bot sanitiser and hidden turns

- A `BotSession` with the fake provider streaming `<think>` / `<reply>` / stray tags: no `TEXT_MESSAGE_CONTENT` contains `<think>`, `<thinking>` or `<reasoning>`, and the concatenated content equals the compat `text_delta` concatenation.
- The flush and consolidation turns add zero AG-UI lines apart from `permission.*`, and the compat lines are unchanged.
- The user's run terminal precedes the hidden turn's first pi event.

### 7.8 Hydration (finding 23)

In-process with a ring of size 50:

- `sync` mid-run with an open child, an open tool call and a pending permission.
- A fresh `ChatClient` fed `MESSAGES_SNAPSHOT` (from main's transcript fixture) + the synthetic prefix + the live tail:
  - renders the child card with its later tool results;
  - renders the parent tool result on its part;
  - rebuilds the descriptor store.
- Repeat after ring eviction, and for a second window attached mid-run.

---

## 8. Acceptance and risks

### 8.1 Acceptance checklist

- [ ] `--wire ndjson` stdout equals the pre-change baselines for every scenario (§7.2 step 4). The existing agent suites pass unchanged.
- [ ] `--wire agui` fd-3 output equals `--wire ndjson` stdout byte for byte for every scenario (§7.2). This holds on three OSes in the spawned check, and for the `--compat-pipe` fallback.
- [ ] Main runs its taps from fd 3 with **zero** code changes to the taps.
- [ ] The AG-UI goldens (§7.1), the transport-bridge ports (§7.3) and the properties (§7.4) pass.
- [ ] Permission independence, lineage, envelope, expiry, auto-allow and sibling-artifact tests (§7.5) pass.
- [ ] TanStack conformance (§7.6) passes with no casts, and the processor parts are correct.
- [ ] The bot tests (§7.7) and hydration tests (§7.8) pass.
- [ ] No behaviour-bearing logic changed beyond §6.3. `queue.ts` is a pure extraction, and the session changes are emit-only plus the optional `send` callback.
- [ ] `typecheck` and `test` are green. The bundle adds only `@ag-ui/core` at runtime.
- [ ] PLAN.md is amended:
  - no `bot.reply`;
  - no native interrupts for permissions (a descriptor store plus `permission.respond`);
  - host services stay on compat;
  - the compat stream feeds main's taps.

### 8.2 pi 0.85.1 → 0.99.x verification

These are unchanged from rev 1:

- event shapes, including `WithParentToolCallId`, the new events falling to `default:`, and `toolcall_*` on `{contentIndex, partial}`;
- `partialResult` type for bash streaming;
- `StopReason` `deferred` / `pending`;
- the extension and session API surface;
- persistence and resume of 0.85 files;
- built-in tool definitions and the system prompt diff;
- features not adopted: `builtin:mcp`, `executeTool`, virtual models, RPC/Chord, telemetry;
- build and packaged smoke.

**Gate:** §7.2 steps 3 and 4 are unchanged on the bumped build.

### 8.3 Risks

| Risk | Mitigation |
|---|---|
| fd 3 behaves differently on Windows. | Tested on three OSes (§7.2). Fallback to `--compat-pipe`. Exit code 78 leads main to respawn with `--wire ndjson`. |
| The two channels drift (a line on compat with no AG-UI counterpart, or the reverse). | Both come from one `HostSink.emit`. The §7.2 byte test and the §7.1 goldens cover both. |
| A long-open run while a permission waits: the client shows loading for up to 15 minutes. | This is today's UX (the busy status). The queue slot stays usable via the `queued` ack. |
| The regenerate restriction: `reload()` after success is rejected. | Explicit ack. The chat kit hides it. Branching is specified in a later slice. |
| Command-match attachment picks the wrong call when two running calls share a command. | Most-recent wins. Only placement is affected; the answer is keyed by `permissionId`. |
| Hidden-turn usage no longer reaches the renderer. | The compat stream still carries it to main's usage log, exactly as today. |
| Pre-existing: a message sent during a bot housekeeping turn is steered into it. | Unchanged; logged for the bots slice. |
| `@ag-ui/core` evolves the `EventType` or `Interrupt` shapes. | Pinned at 1.0.0, and the no-cast conformance test fails loudly. |

---

## 9. Review responses (`reviews/00-agent-agui.codex-r1.md`)

| # | Finding | Resolution | Where |
|---|---|---|---|
| 1 | Auto-allow answered before the waiter registered | Auto-allow stays in main and reads compat. It answers via the legacy `permission_response`, which arrives asynchronously after registration. The agent-side `--auto-allow` is removed. Round-trip test added. | §3.5.6, §7.5 |
| 2 | Zero-length run overlapping the open run; admission race | Synchronous admission with a `reserved` flag. Busy input is acked `run.ack {queued}` without a run. Reservation-window input is queued `waitingFor:"turn"`. Concurrency property test. | §3.1.1, §7.4 |
| 3 | Resume lineage; ids restart per process | `permission.respond` carries a lineage of thread, incarnation, run and permission id. Everything is validated before any session call, and a mismatch releases nothing. | §3.5.3, §7.5 |
| 4 | Unmatched resume closed with success | There is no resume path. A stale or invalid answer gets `permission.response_rejected` plus the authoritative `permission.pending`. A pause is never reported as finished. | §3.5.3 |
| 5 | All-or-nothing batches change timing | No batching and no native interrupts. Each permission is its own descriptor, answered independently, and the run stays open. Independence test. | §3.5, §7.5 |
| 6 | Generic interrupts do not join tool widgets | An explicit join: the chat kit's descriptor store is keyed by `(subagentRunId, toolCallId)`. The Interrupts slot is the fallback. `selectChatUI` is not relied on. | §3.5.4 |
| 7 | Resolve envelope undefined | Exactly one `PermissionDecision` per answer, with an allowed-decision table per kind. Strict validation, no coercion. PLAN wording superseded. | §3.5.2, §7.5 |
| 8 | `approval.cleared` does not retire client items | The descriptor store is ours. `permission.cleared` plus the authoritative `permission.pending` after every change. One expiry leaves the others actionable. | §3.5.5, §7.5 |
| 9 | Sibling events buffered, then discarded on Stop | No buffering. Siblings stream immediately on AG-UI, and compat delivers them to the taps as today. Sibling-artifact test. | §3.5.1, §7.5 |
| 10 | Tool errors not recognised by StreamProcessor | `metadata.tanstack.state:"output-error"`, `toolResultOutcome` `denied`/`cancelled` from `tool_blocked`, and `error` text in the content. Processor test. | §3.3.6, §7.6 |
| 11 | Subagent terminal before its tool results | Closing order: child message end, then child results, then the subagent terminal. Processor-part assertions. | §3.1.5, §7.6 |
| 12 | Settlement not owned by a turn | `TurnToken`, a `send(text, {settled})` callback, owner-checked `settle`, and `markCancelling` before abort. Property test. | §3.1.2, §7.4 |
| 13 | Terminal inferred from streaming status | An internal `origin` at every error site. Only `turn` origin is terminal. | §3.2 |
| 14 | Deduplication by user message id breaks reload and retry | Deduplication by `runId`. Retry after error or cancel re-prompts. Regenerate after success is explicitly rejected pending branching. | §3.1.1, §3.1.4 |
| 15 | Idle-then-error semantics lost for taps | The taps read compat, which is byte-identical and so keeps idle-then-error. AG-UI's single terminal is confined to the renderer. | §2.4, §3.2 |
| 16 | Taps would append user text | The taps read compat. The AG-UI `START` carries a correct role for every message (user for steer and dequeue). | §3.4 |
| 17 | Child message-boundary semantics | Compat keeps the legacy absence and `web-N` exactly. AG-UI child ids are unique per invocation and routed by `subagentRunId`. | §3.3.4, §3.3.7 |
| 18 | Global tool bookkeeping collides across children | Keyed by `(subagentRunId, toolCallId)`. The AG-UI child id is `subagentRunId:legacyId`. Collision test. | §3.3.5, §3.3.7 |
| 19 | `replace /plan` when absent; unnormalized todos | `add /plan` with `readTodos()` after a successful call. Tests for absent, empty and whitespace plans. | §3.3.2, §7.4 |
| 20 | Host-service filtering by name leaks args | Host services stay on compat plus the legacy response. Nothing on AG-UI. | §3.7 |
| 21 | Wrong pi streaming shapes | Extract from `partial.content[contentIndex]`, defer until the id is known, and read `toolCall` only on end. Tested with real shapes. | §3.3.5, §7.1 |
| 22 | The agent watchdog adds an abort policy | Removed. Main's watchdog is unchanged. | §3.8 |
| 23 | Hydration conditional and incomplete | `sync` → `session.sync` live snapshot. Main keeps an authoritative transcript. The replay-gap protocol re-announces open subagents, tools and messages. Reload, second-window and eviction tests. | §5.3, §7.8 |
| 24 | String literals not assignable; missing client dep | Built on `@ag-ui/core` `EventType` via the checked `aguiEvent()`. `@tanstack/ai-client` is a devDependency. No-cast conformance. | §2.3, §6.3, §7.6 |
| 25 | END metadata updates ignored | START carries only immutable facts. Title and kind are computed at render time from the final input with exported helpers. Rendered-value test. | §3.3.5, §7.6 |
