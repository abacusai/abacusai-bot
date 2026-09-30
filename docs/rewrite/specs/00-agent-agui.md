# Spec 00: `packages/agent` AG-UI host and emitter (rev 3)

Phase 0, slice 1 of `docs/rewrite/PLAN.md` ("Protocol: AG-UI straight from pi"). This is a spec, not code. The only code in it is type declarations.

Rev 2 resolved the findings in `docs/rewrite/specs/reviews/00-agent-agui.codex-r1.md`. Rev 3 resolves every item in `…codex-r2.md`. §9 maps both rounds to their changes.

**Amended after implementation review round 1** (`reviews/00-agent-agui.impl-codex-r1.md`, `…impl-claude-r1.md`; fix log `…impl-fixes-r1.md`). The amendments are marked *(impl r1)* where they land: §2.1, §2.2, §2.3, §2.4, §3.1.1-§3.1.6, §3.2, §3.3.7, §3.5.3, §3.8, §4, §5.2, §6.3, §7.1, §7.2, §8.1. **PLAN.md needs a matching amendment:** busy input goes to the host queue, and ChatClient's guard is a queue strategy function that throws, not `whenBusy: "error"`, which ai-client 0.36 does not have (§3.1.6). PLAN.md's `queue` row (`whenBusy: "queue"`, fifo) is superseded.

Orchestrator decisions that still apply:

- **Zero behaviour change for main's taps.** They read a compatibility stream of today's exact NDJSON (§2.4).
- **No permission batching.** Each permission is answered on its own through an explicit control command (§3.5).

Rev 3 adds three design points:

- **Input while a run is busy never goes through ChatClient's `send()`.** It goes to the host's queue through a separate procedure (§3.1.6).
- **Reload uses TanStack's own hydration.** Main owns it through `hydrate()` + `joinRun()`, backed by main's `StreamProcessor` transcript and a complete per-run event log (§5.3).
- **The compat channel is negotiated with a synchronous handshake before the session starts.** If fd 3 is unusable, compat falls back to inline framing on stdout, with no respawn (§2.4).

Sources read, beyond rev 1 and rev 2:

- TanStack `ai-client/src/chat-client.ts`:
  - `isIntermediateToolTurn()` (`:190-198`) skips `resolveProcessing` when `finishReason === "tool_calls"`;
  - `streamResponse()` awaits `connection.send()`, then `processingComplete` (`:2557`, `:2625`).
- `ai-client/src/connection-adapters.ts:963-994`: `ChatHydrationResult {messages: UIMessage[], activeRun, interrupts}`, plus `SubscribeConnectionAdapter.hydrate` / `joinRun`.
- `ai-react/src/chat-ui/create-ui.tsx:818`: the Interrupts slot reads `chat.interrupts` only.
- `@ag-ui/core@1.0.0` `TokenUsage`: `inputTokens` includes cache reads and writes, and `totalTokens` equals `inputTokens + outputTokens`.
- `packages/agent/tsdown.config.ts:23-40`: build entries are enumerated explicitly.

---

## 1. Scope and non-goals

### In scope

1. **A second wire for the renderer.** With `--wire agui`:
   - stdout carries one AG-UI event per line;
   - the **compatibility stream** carries today's NDJSON `DesktopEvent` lines byte for byte. It goes on fd 3, or inline on stdout behind a one-byte prefix when fd 3 fails the startup preflight (§2.4).

   Both come from one `emit()` call.
2. **stdin.** It accepts today's `DesktopCommand` set unchanged, so every existing main producer keeps working. It adds three commands: `run`, `cancel`, `permission.respond` (§2.2).
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
- **No agent-side UI history.** Main owns the transcript, the active-run log and hydration (§5).
- **No `CUSTOM bot.reply`.** The messaging relay keeps reading `text_delta` from the compat stream (§4). This supersedes PLAN.md's wording.
- **No TanStack native interrupts.** No `RUN_FINISHED{outcome:"interrupt"}` is emitted and no `approval-requested` either (§3.5). PLAN.md's interrupt wording is superseded.
- **The pi 0.85 → 0.99 bump** is a separate commit (§8.2).

---

## 2. Wire format

### 2.1 Channels and framing

| Channel | Direction | Content |
|---|---|---|
| stdin | main → agent | One JSON `AgentCommand` per line (§2.2). U+2028/2029 are escaped as `serializeCommand` does (`cli-manager-service.ts:178-182`). |
| stdout | agent → main | Line 1 is always `CUSTOM wire.hello` (§2.4). After that, one AG-UI event per line (§2.3). In **inline compat mode** only, compat lines also appear here, each prefixed with one `\u001e` byte (§2.4). |
| fd 3 (compat, preferred) | agent → main | One legacy `DesktopEvent` per line, byte-identical to what `--wire ndjson` writes to stdout for the same session (§2.4). |
| stderr | agent → main | Diagnostics, as today. |

**Process flags** (`main.ts`):

- `--wire ndjson|agui` (default `ndjson`).
- With `agui`:
  - `--thread-id <id>` (required);
  - `--compat-fd <n>` (main passes `3`).

  The rev-2 `--compat-pipe` and the exit-78 respawn are removed.
- `--model`, `--permission-mode` and `--sandbox-probe` are unchanged.

**Error handling:**

- A malformed stdin line never kills the process. It produces `error {code:"malformed_command"}` on compat (as `host.ts:109-119`) and `CUSTOM agent.error` on AG-UI.
- A throwing handler behaves as `host.ts:127-131` on compat. On AG-UI:
  - if the command's own run is still open, it becomes a `RUN_ERROR` for that run;
  - otherwise it becomes `CUSTOM agent.error`.

  *(impl r1)* "Its own run" is decided by the token, never by the command's type. A `session.send()` that throws is recorded against the token that owns it, before the `finally` settles that token's run, so the run ends in `RUN_ERROR` and never in `RUN_FINISHED success` followed by a stray error. The compat line the command's catch then writes is marked as already reported and adds nothing to AG-UI. A throw that belongs to no open run of its own (a queued `send`'s failed steer, a run that already settled) is `CUSTOM agent.error`, and never fails another command's run.
- *(impl r1)* A stdin line that parses as JSON but is not a command (`null`, a number) is handed to the handler like any other and fails there, exactly as the legacy host did: its `error` line goes to compat and `CUSTOM agent.error` to AG-UI. Nothing about the parsed value is read before dispatch.

**Scope:**

- **Run-scoped** AG-UI events (`TEXT_MESSAGE_*`, `REASONING_*`, `TOOL_CALL_*`, `SUBAGENT_*`, and the `CUSTOM` names marked *R*) appear only inside an open run.
- **Session-scoped** events (`STATE_*` and the names marked *S*) may appear at any time.

**One renderer protocol per runtime.** A `--wire agui` runtime serves only the new renderer. Old-renderer windows keep `--wire ndjson` runtimes, and main never forwards an agui runtime's compat lines to an old renderer (finding r2-9).

### 2.2 Commands (stdin)

`packages/agent/src/agui/wire.ts`:

```ts
import type { RunAgentInput as AguiRunAgentInput } from "@ag-ui/core";
import type { DesktopCommand, PermissionDecision } from "../protocol.js";

/** Everything stdin accepts under --wire agui. */
export type AgentCommand = DesktopCommand | AguiControlCommand;

export type AguiControlCommand =
  /** A turn from the renderer's chat client. Sent only when the thread is idle (§3.1.6). */
  | { type: "run"; input: RunInput }
  /**
   * Stop the reply in flight. With `runId`: applied only if that run, or the
   * admission that will open it, is current; otherwise ignored (finding r2-12).
   * Without it: unconditional, like the legacy `stop`.
   */
  | { type: "cancel"; runId?: string }
  /** Answer one permission, independently of any other (§3.5). */
  | { type: "permission.respond"; lineage: PermissionLineage; decision: PermissionDecision };

/** AG-UI RunAgentInput as the SubscribeConnectionAdapter sends it. `resume` must be absent or empty (§3.5). */
export type RunInput = Omit<AguiRunAgentInput, "forwardedProps"> & {
  forwardedProps?: {
    /** Applied during turn preparation when it differs; same path as set_mode. Main omits it for bots. */
    mode?: string;
    /** Applied (awaited) during turn preparation when it differs; same path as set_model. */
    model?: string;
    /** Accepted and ignored: host.ts:156 drops send.activeSkills today. */
    activeSkills?: string[];
    /** Accepted and ignored; must equal threadId when present. */
    conversationId?: string;
    /** "regenerate": an explicit request to answer the newest user message again (§3.1.4). */
    intent?: "send" | "regenerate";
  };
};

/** Identifies the exact pending permission an answer is for (§3.5.3). */
export interface PermissionLineage {
  threadId: string;
  /** From wire.hello / session.ready / the descriptor; new per agent process. */
  incarnation: string;
  /**
   * The host turn that owned the permission when it was raised: the TurnToken
   * seq of the send still in flight. It survives into bot housekeeping, where
   * no run is open (finding r2-13).
   */
  turnSeq: number;
  /** The run open when it was raised, if any. Informational; not validated. */
  runId?: string;
  /** perm-N from the descriptor. */
  permissionId: string;
}
```

**The legacy commands are accepted verbatim** (`protocol.ts:417-453`), with today's handlers (`host.ts:147-327`). Every command that can start a turn passes through **one** admission guard (§3.1.1):

- legacy `send` (messaging gateway, routines, routine editor);
- `enqueue`, which the new renderer's queue uses too (§3.1.6);
- `dequeue`;
- queue drains;
- `runAfterStop`.

The rev-1 aliases (`queue.*`, `mcp.*`, `providers.refresh`, `client_tool_result`) and the rev-2 `sync` command are dropped. Hydration is main's (§5.3).

| Command | Handler |
|---|---|
| `run` | *(impl r1)* The envelope first: `input.threadId` must equal `--thread-id`, `forwardedProps.conversationId` (when present) must too, and `resume` must be absent or an empty array; otherwise `run.ack {rejected, thread_mismatch \| resume_unsupported}`, and nothing else happens: the run id is not recorded, nothing is queued, the session's mode and model are untouched, and compat gets no byte. Then admission (§3.1.1). If idle, a client run is opened. If busy (a race, §3.1.6), the input is queued with `run.ack {queued}` and no run is opened. |
| `cancel` | Run-id check (above), then the `stop` handler (`host.ts:160-182`) with `markCancelling` first (§3.8) |
| `permission.respond` | Lineage check (§3.5.3), then `session.respondPermission` + `releaseParked()`: the same two calls as `host.ts:199-205`. *(impl r1)* `permission.resolved` + `permission.pending` go out between the two (§3.5.3). |
| `permission_response` (legacy) | Unchanged semantics. Written only by main's browser auto-allow, bound to the runtime that raised the request (§3.5.6). |
| `enqueue`, `dequeue`, `get_queue`, `clear_queue`, `remove_from_queue`, `update_queue_item` (legacy) | Unchanged. These are the host queue, which is authoritative for the new renderer too (§3.1.6). |
| `host_service_response` (legacy) | Unchanged. Host services never appear on AG-UI (§3.7). |
| `stop` (legacy) | Unconditional, as today |
| every other legacy command | Unchanged handler |

### 2.3 Events (stdout)

The types come from `@ag-ui/core@1.0.0`. It becomes a runtime dependency of the agent: the ESM entry is 28 KB and does not load `./schemas` or zod. Events are built with the `EventType` enum through one constructor, so they are assignable to `@ag-ui/core`'s `Event` and TanStack's `StreamChunk`, and no call site needs a cast (finding 24).

*(impl r1)* The constructor itself holds the package's one type assertion on its output: TypeScript cannot prove `{type, ...payload, timestamp}` is `Extract<Event, {type: T}>` for a generic `T`. It is verified instead of trusted: every event of every golden is parsed by `@ag-ui/core/schemas`' `EventSchemas` (a test-only import), and a unit test builds every emitted type through the emitter and parses it the same way.

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
  tanstack?: { model?: string; finishReason?: "stop" | "length" | null /* never "tool_calls" on a final terminal (finding r2-16) */ };
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
| `wire.hello` | S | `{protocol: 1, wire: "agui", compat: "fd" \| "inline" \| "none", incarnation}`: always stdout line 1 (§2.4) |
| `wire.compat_lost` | S | `{error}`: then the process exits with 75 (§2.4) |
| `agent.status` | S | `{status: AgentStatus}` |
| `agent.heartbeat` | S | `{runningTools}` |
| `agent.error` | S | `AgentErrorPayload` (non-terminal errors) |
| `agent.notification` | S | `{message, severity, actions?, notificationKey?, …}` (verbatim) |
| `agent.retry` | R | `{attempt, maxAttempts, delayMs, isNetworkError}` |
| `run.ack` | S | `{runId, status: "started" \| "queued" \| "duplicate" \| "rejected", entryId?, waitingFor?, reason?: "regenerate_unsupported" \| "empty" \| "resume_unsupported" \| "thread_mismatch"}` *(impl r1: `thread_mismatch`)* |
| `permission.requested` | S | `PermissionDescriptor` |
| `permission.resolved` | S | `{permissionId, decisionKind: DecisionKind, source: "respond" \| "legacy_response"}` |
| `permission.cleared` | S | `{permissionId, reason: "expired" \| "stopped" \| "reset"}` |
| `permission.response_rejected` | S | `{lineage, reason: "incarnation" \| "thread" \| "turn" \| "not_pending" \| "invalid_decision" \| "decision_not_allowed"}` |
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

**Handshake (findings r2-14, r2-15).** Main spawns the agent with `stdio: ["pipe","pipe","pipe","pipe"]` (today it passes three, `cli-manager-service.ts:542`) and `--compat-fd 3`. **Before** the session is constructed, and before either writer is enabled, `main.ts` preflights the channel synchronously:

1. Build `hello = {"type":"CUSTOM","name":"wire.hello","value":{"protocol":1,"wire":"agui","compat":?,"incarnation":<uuid>},"timestamp":…}`.
2. Try `fs.fstatSync(3)`, then `fs.writeSync(3, "")` (zero bytes), then `fs.writeSync(3, JSON.stringify({type:"compat.hello", incarnation}) + "\n")`. These are synchronous calls, so `EBADF`/`EPIPE`/`EAGAIN` are thrown here and not reported later. `EAGAIN` is retried for up to 1 s. *(impl r1)* On POSIX the `fstat` must also report a FIFO or a socket: without main's pipe, fd 3 can still be open for the runtime's own use (libuv's kqueue, an inherited file), and a successful write there would send compat nowhere. Anything else is inline. (On Windows a CRT descriptor the runtime did not open is simply not open.)
   - **Success:** `compat = "fd"`.
   - **Any throw:** `compat = "inline"`.
3. `fs.writeSync(1, JSON.stringify(hello) + "\n")`. This is always stdout line 1.
4. Only now start the session and enable both writers.

Main's read loop reads line 1 of stdout (the `wire.hello` handshake). It **must** then do two things:

- in fd mode, discard the one `compat.hello` line on fd 3;
- route compat from wherever `hello.compat` says.

There is no exit-78 path and no respawn. Startup failure and closure handling (`cli-manager-service.ts:613-630`, `:684-740`) stay exactly as they are. The renderer protocol is always AG-UI for an agui runtime, whichever compat mode was negotiated (finding r2-14).

**Modes:**

- **fd:** after the preflight, compat lines go to `new net.Socket({ fd: 3, readable: false, writable: true })`, falling back to `fs.createWriteStream("", { fd: 3 })` if the socket cannot be built. This is a Node-created pipe, so it works on POSIX and on Windows.
- **inline:** each compat line is written to stdout as `"\u001e" + <exact legacy line>`. AG-UI lines always start with `{`, so the prefix is unambiguous. Main strips the one byte and passes the remainder to the unchanged compat pipeline. In this mode compat and AG-UI are also totally ordered relative to each other.
- **none:** `--wire agui` without `--compat-fd`, for standalone and test use. `hello.compat = "none"` and no compat is written.

**Channel loss after the handshake (finding r2-15).** An asynchronous error on the fd-3 writer means main's taps have stopped receiving. That must never be silent, so the agent:

1. writes `CUSTOM wire.compat_lost {error}` to stdout;
2. writes `RUN_ERROR {code:"compat_lost"}` for an open run;
3. writes one stderr line;
4. exits with code 75.

*(impl r1)* Lines 1 and 2 go out as one stdout write queued behind everything already written, and the exit waits for that write's callback (or 5 s, for a reader that has gone), so neither they nor the earlier lines are lost to an asynchronous pipe under backpressure. A spawned test holds ~400 KB unread on stdout when fd 3 goes away.

Main sees an ordinary child exit, which is today's crash path: session closed, turn stopped. It never keeps running with taps detached. Backpressure (writes buffered in-process) is handled as stdout is today.

**Production: one `emit()`, two writers.** Both hosts share `agui/queue.ts`, the queue and turn logic extracted from `NdjsonHost`. Every `DesktopEvent` goes through one `HostSink.emit(event)`, which does two things in order:

1. `compat.write(toNdjsonWire(event))`. `toNdjsonWire` drops internal-only types, strips internal fields, and returns `JSON.stringify(stripped) + "\n"`, exactly the line `NdjsonHost.emit` writes (`host.ts:482-484`).
2. `agui.accept(event)` (stdout).

Under `--wire ndjson` the same `toNdjsonWire` writes to stdout, so the compat bytes are identical by construction.

**Guarantees:**

- **Same content and order as today.** Compat carries exactly today's stdout content and order. The one extra fd-mode `compat.hello` preamble is consumed by main's read loop before the unchanged pipeline.
- **AG-UI-only commands map to their legacy equivalents** (§7.2):

  | AG-UI command | Legacy equivalent | Compat lines |
  |---|---|---|
  | `run` | `send`, preceded by `set_mode`/`set_model` when `forwardedProps` differ | same as the legacy equivalent |
  | `cancel` | `stop` | same as the legacy equivalent |
  | `permission.respond` | `permission_response` | same as the legacy equivalent |
  | rejected, duplicate or ignored commands | — | none |
- **Ordering.** In fd mode, main must not assume any ordering between stdout and fd 3.

**What main does.** Compat lines go through the existing `handleStdout` pipeline (`cli-manager-service.ts:851-966`) and `emitNdjson` fan-out (`service-host.ts:1181-1263`) unchanged. AG-UI lines go to main's AG-UI relay (§5).

---

## 3. Semantics and complete mapping

### 3.1 Runs

#### 3.1.1 Admission: one synchronous guard for every turn starter (findings 2, r2-10, r2-11)

Every command that can start a turn goes through `admission.request(source, text, prep?)` in `agui/queue.ts`. The sources are:

- `run`;
- legacy `send`, `enqueue`, `dequeue`;
- queue drains;
- `runAfterStop`.

The function runs its decision **synchronously**:

1. **`run` only.**
   - A duplicate `runId` in `seenRunIds` gets `run.ack {duplicate}`.
   - A non-empty `resume` gets `run.ack {rejected, resume_unsupported}`.
   - Empty text gets `run.ack {rejected, empty}`, as `isPrompt` does (`host.ts:152`).
   - Regenerate is decided per §3.1.4.
2. **If `busy`**: today's send-while-busy.
   - `admit(text)` runs unchanged: it steers, parks behind a permission, or holds for the next turn.
   - While `preparing` (step 3) or `stopping`, the entry gets `waitingFor:"turn"`. This is the existing `stopping` rule (`host.ts:388-392`), extended to preparation, because steering before a prompt exists is meaningless.
   - Legacy sources behave exactly as today.
   - A `run` additionally gets `run.ack {queued, entryId, waitingFor}` and **no run opens**. That only happens in the race described in §3.1.6.
3. **Otherwise, acquire:**
   - `busy = true` and `preparing = true`, synchronously, **before any await**;
   - `gen = ++admissionGen`;
   - the token is `{seq, runId}`.

   A `run` then gets `run.ack {started}`, and `RUN_STARTED` is written (server runs: §3.1.3). This single `busy` flag is what every source checks, so a legacy `send` arriving while a `run` is preparing is queued, not started (finding r2-10).
4. **Preparation** is `run` only: `setMode` when `forwardedProps.mode` differs, then `await setModel` when `.model` differs. Failures are non-terminal (§3.2). *(impl r1)* A throw from either is reported as a `command`-origin error (compat: the legacy thrown-handler line a failed `set_model` writes; AG-UI: `CUSTOM agent.error`) and the prompt still runs, as `set_model` failing before `send` does today. Anything else that throws before the prompt ends the run in `RUN_ERROR` and releases `busy` and `preparing` (then drains the queue) unless a Stop or reset has taken admission over. **After every await**, the host checks `gen === admissionGen && !token.cancelling && turn === capturedTurn`. If any check fails, preparation stops:
   - the prompt is **not** sent;
   - `preparing = false`;
   - the run has already been closed `cancelled` by the Stop or reset that intervened (§3.8).

   A stopped or reset turn therefore never prompts, and never prompts into the reset conversation (finding r2-11).
5. **Prompt.** `preparing = false`, then `runTurn(text, token)` (the existing body, with `busy` already held).

For legacy sources the NDJSON behaviour is unchanged. They have no preparation step, so `preparing` is never observed and the compat bytes stay identical (§7.2).

*(impl r1)* **Stop and reset hold admission too** (`--wire agui` only). From the moment a Stop or reset starts until it has landed, `busy` is held, so every turn starter queues behind it (`waitingFor:"turn"`) instead of prompting a session that is being aborted or replaced; once it lands, `runAfterStop()` runs what arrived (after a reset: in the new conversation). Only the newest Stop or reset releases admission, so an older one finishing late never frees a guard a newer one, or the turn it started, holds. Under `--wire ndjson` the legacy host's behaviour, including that race, is kept byte for byte; the compat stream of an agui runtime differs from ndjson only in that race (the message is queued, not sent into the aborting session).

#### 3.1.2 Turn tokens (finding 12)

Every `session.send()` the host makes is owned by an immutable `TurnToken {seq, runId?}`.

- `session.send(text, { settled: () => runs.settle(token) })` gains an optional second parameter. The session calls `settled()` once, at the end of the user-visible turn (§3.1.5).
- The host also calls `runs.settle(token)` in the `finally` around `session.send`.
- `runs.settle(token)` is a no-op unless `token.seq` equals the open run's token.
- `cancel` / `stop` / `reset` call `runs.markCancelling(currentToken)` **synchronously, before** awaiting the abort.
- The host keeps `currentToken` set until `send()` resolves, including through bot housekeeping. That is what permission lineage binds to (§3.5.3).
- *(impl r1)* When a `send()` resolves, only its own token is released: an aborted send can resolve after `runAfterStop` started a newer one, and clearing the newer token would bind that send's permissions to turn 0.

#### 3.1.3 Server-initiated runs

A legacy `send`, a queue drain (`host.ts:353-368`), `runAfterStop` (`host.ts:407-421`), and `dequeue` while idle (`host.ts:230-246`) each open a run with:

- `runId = "srv-" + randomUUID()`;
- `metadata.abacus.serverInitiated`.

Each one opens with `CUSTOM queue.dequeued {content}` (for dequeued input) plus a **user** text message (`TEXT_MESSAGE_START {role:"user", messageId: runId+":user"}` + `CONTENT` + `END`).

*(impl r1)* **Always, echoed or not.** `echoed` (`!echoed.delete(id)`) only suppresses the compat `user_message_dequeued`, which exists so the old renderer does not draw a second bubble for text it drew itself when it showed idle. On an agui runtime nothing has drawn it: a `run` raced into a Stop is acked `queued`, main injects `RUN_ERROR {queued}`, and the renderer removes its optimistic message. The run that finally carries the text must carry it on AG-UI too, or it is missing from the transcript, main's processor and `hydrate`.

- A legacy `send` from main (messaging, routine) also carries its user text message.
- Each drained `session.send()` gets its own run and token. The previous run settles before the next `RUN_STARTED`.
- *(impl r1)* `RUN_STARTED` never carries `input`. A client run's `RunAgentInput` holds the whole history on every turn, attachments included; echoing it put O(transcript) bytes per run into stdout, main's active-run log and its ring, and could pass main's 16 MB line cap (the `RUN_STARTED` would then be dropped and the run never start). A client run's newest user message goes out as `TEXT_MESSAGE_*` under the client's own id right after `RUN_STARTED`, which is all main's transcript and `joinRun` need.

#### 3.1.4 Regeneration and retries (finding 14)

A new `runId` whose newest user message id equals the last user message id this incarnation prompted is resolved as follows:

- **The previous run for that message ended in `RUN_ERROR` or `cancelled`.** This is a retry. It is admitted as a normal new prompt with the same text, which is exactly today's "try again": the renderer re-sends the text.
- **The previous run ended in `success` and `forwardedProps.intent === "regenerate"`.** The result is `run.ack {status:"rejected", reason:"regenerate_unsupported"}`. Regenerating an answer means branching pi's transcript, which is a behaviour change outside this slice. The chat kit must not offer `reload()` on successful turns until a later slice specifies branching.
- **The previous run ended in `success` without `intent`.** This is treated as a new prompt, as today when a user sends the same text twice.

Deduplication is by `runId` only (§3.1.1). A reused message id is never proof of redundancy.

*(impl r1)* A retry reuses its message id, and `StreamProcessor` keeps one message per id and appends a second `CONTENT` to it (a continuous processor that saw both runs held `"questionquestion"`). So a client message id already echoed in this incarnation is not echoed again; the retry's run carries no user `TEXT_MESSAGE_*`. Across incarnations the agent cannot know: main's transcript processor must skip a user `TEXT_MESSAGE_*` whose id it already holds (main slice, §5.2).

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

   `finishReason` is always final-turn: `"stop"`, `"length"` or `null`, and never `"tool_calls"`. ChatClient's `isIntermediateToolTurn()` (`chat-client.ts:190-198`) would otherwise skip `resolveProcessing` (finding r2-16).

After a cancel or reset closes a run, run-scoped AG-UI events from the superseded pi turn are dropped until the next `RUN_STARTED`. The compat stream is **not** filtered: it carries them exactly as today, and main's own post-Stop suppression applies (`session-turn-state-service.ts:129-141`).

#### 3.1.6 Input while a run is busy: the host queue, outside ChatClient's send (findings r2-1, r2-2)

ChatClient's `streamResponse()` awaits `connection.send()` and then its own `processingComplete`, which only a terminal for that request's run resolves (`chat-client.ts:2557`, `:2625`). ChatClient's default busy handling also queues locally, so the message could neither steer the current turn nor survive Stop. The rule is therefore:

- **The composer never calls `sendMessage()` while the thread is busy.** "Busy" means main's turn-state phase for the thread, which main derives from compat (`streaming` / `waiting_permission` / `pending`) and publishes to every window. The composer's submit handler branches:
  - **idle**: `chat.sendMessage(text)`, which sends `run`;
  - **busy**: the `ai.queue.enqueue({threadId, message})` procedure, which writes the legacy `enqueue {message, hidden:false}`. The host's authoritative queue (`admit`) steers it, parks it behind a permission, or holds it. Nothing enters ChatClient's lifecycle.
- **The queue slot is the host queue.** It renders from `CUSTOM queue.updated`. Edit, remove, clear and "send now" map to the legacy commands:

  | Action | Command |
  |---|---|
  | edit | `update_queue_item` |
  | remove | `remove_from_queue` |
  | clear | `clear_queue` |
  | send now | `dequeue` |

  Queued messages survive Stop exactly as today (`host.ts:164`, `runAfterStop`). *(impl r1)* ChatClient's busy guard fails loudly instead of queueing locally. `whenBusy: "error"` does not exist in ai-client 0.36 (`WhenBusy` is `"queue" | "drop" | "interrupt"`; `drop` returns silently, and `maxSize: 0` with `onOverflow: "reject"` is silent too). The guard is a queue **strategy function that throws**: `decideWhenBusy` calls it synchronously inside `sendMessage` (`chat-client.ts:2355-2376`), so an accidental busy `sendMessage` rejects, and nothing is queued locally or sent. A per-call `sendOptions.whenBusy` bypasses a strategy, so the chat kit never passes one. The agent's tests use `failLoudlyWhenBusy` (`agui/__tests__/chat-adapter.ts`).
- **The race.** If a `run` still arrives while the host is busy (another window started a turn between the check and the send), the host queues the text and emits `run.ack {queued}` (§3.1.1). Main's `ai.send` procedure sees that ack for its own request and **injects into that requesting subscription only** a terminal:

  ```
  RUN_ERROR {code:"queued", message:"Queued behind the running reply.", metadata.tanstack:{threadId, runId}}
  ```

  That resolves ChatClient's `processingComplete` for this run id at once, well before the other run ends. The terminal is not written to the ring or to other windows. The renderer's `onError` for `code:"queued"` removes the optimistic user message, which now appears in the queue slot. §7.5 tests settlement before the running turn ends.

### 3.2 Failure classification by producing operation (finding 13)

Every `emitAgentEvent({type:"error"})` site gains an internal `origin`, stripped from compat:

| Origin | Sites | AG-UI |
|---|---|---|
| `turn` | `session.ts:1249` (thrown in send), `:1275` (budget), `:1296` (reportTurnFailure), `:1553` (stall), `:1653` (compaction), `:1737` (pool exhausted in rotation); `bot-session.ts:508` (no model in send), `:540`, `:721`, `:761`; `host.ts:128` when a `session.send()` threw while its own token's run was open (*impl r1*: recorded against that token before its settle; the compat line adds nothing on AG-UI) | **Terminal** for the owning token. The first one becomes the run's `RUN_ERROR` at settle (`message` = `error.message ?? segmentData.message ?? "The agent reported an error."`, `code`, `metadata.abacus.error` verbatim). Later ones in the same run go out as `CUSTOM agent.error`. |
| `command` | `session.ts:2096`, `:2157`, `:2172`, `:2214` (set_model paths, including `forwardedProps.model`); `bot-session.ts:942` | `CUSTOM agent.error`, never terminal |
| `startup` | `host.ts:79`, `session.ts:1069`, `bot-session.ts:441` | `CUSTOM agent.error` |
| `host` | `host.ts:109` (malformed), `host.ts:128` for every other throw (*impl r1*: including a `run`/`send` whose throw has no open run of its own) | `CUSTOM agent.error` |

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
- Title and kind are **not** sent as updatable metadata (finding 25). The chat kit computes them at render time from `part.name` + `part.input` using the vendored helpers, which the agent package exports as `@abacus-ai/agent/tool-display`, a dedicated browser-safe build entry (§6.1, finding r2-18). So they always reflect the final input.

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
| Assistant message | `${agentSessionId}:${partial.timestamp}` (pi `AssistantMessage.timestamp`, persisted in the pi file). A collision gets a `:2` suffix; a missing timestamp falls back to `${agentSessionId}:${incarnation}:msg-N` (*impl r1*: `msg-N` restarts in every process and a resumed pi session keeps its id, while main keeps one transcript per thread across respawns). |
| Tool call | pi's id |
| Child tool call | `${subagentRunId}:${legacyPrefixedId}`, with the legacy id in `metadata.abacus.legacyToolCallId`. This makes child ids unique across parallel children that reuse provider ids. |
| Child message | `${subagentRunId}:final` or `${subagentRunId}:web-N`. Unique per invocation, routed by `subagentRunId`. Compat keeps the legacy absence or `web-N` exactly (finding 17). |
| Result message | `${toolCallId}:result` |
| Reasoning | `${messageId}:think:${n}` |
| User message | `${runId}:user`, the client's own id for a client run, or `steer-${incarnation}-${n}` (*impl r1*: `steer-${n}` restarted per process and overwrote the previous process's `steer-1` in main's transcript) |
| Permission | `perm-N` (with `incarnation` in the lineage) |
| Subagent run | today's subtask id |

#### 3.3.8 Usage

`TurnUsage` maps to:

```
usage: [{ ...(model != null ? { model } : {}),
          inputTokens: input + cacheRead + cacheWrite,
          cachedInputTokens: cacheRead, cacheWriteInputTokens: cacheWrite,
          outputTokens: output,
          totalTokens: input + cacheRead + cacheWrite + output }]
```

This follows `@ag-ui/core@1.0.0`'s accounting: `inputTokens` is the total, and the cache fields are parts of it. A null `TurnUsage.model` is omitted (finding r2-17). The raw value is also kept in `metadata.abacus.turnUsage`, and main's cache-miss logger reads compat anyway. When several land in one run, the last wins.

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

#### 3.5.3 Lineage, stale and invalid answers (findings 3, 4, r2-9, r2-13)

**Owner.** When `permission_needed` arrives, the host records that permission's owner as `{turnSeq: currentToken.seq, runId: openRun?.runId}`. `currentToken` stays set until `send()` resolves, so a permission raised in bot housekeeping or in a late sandbox ask, after the user's run has settled, still has an owning turn. Its lineage has no `runId`.

**Checks.** A `permission.respond` is applied **only if all** of these hold:

- `lineage.incarnation` equals this process's incarnation, minted at start and carried in `wire.hello`, `session.ready`, `AgentState` and every descriptor;
- `lineage.threadId` equals `--thread-id`;
- `lineage.permissionId` is pending;
- `lineage.turnSeq` equals that permission's recorded owner `turnSeq`;
- the decision is valid and allowed for the kind (§3.5.2).

**On failure** nothing is answered:

- the host emits `CUSTOM permission.response_rejected {lineage, reason: incarnation | thread | turn | not_pending | invalid_decision | decision_not_allowed}` followed by the authoritative `permission.pending`;
- a pending permission that happens to share the id keeps waiting;
- no compat line is written;
- no answer is ever reported as success unless a waiter was released.

**On success:**

1. `session.respondPermission(id, decision)`;
2. `awaitingPermission = false`;
3. `permission.resolved {source:"respond"}` + `permission.pending`, synchronously;
4. `releaseParked()` (`host.ts:199-205`).

*(impl r1)* The resolution goes out before anything the released waiter or the parked steers cause (the approved tool's `TOOL_CALL_*`, a sibling's new `permission.requested`), as on the legacy path, so the authoritative set never shows an answered card.

**Legacy `permission_response`.** Its semantics are unchanged. In an agui runtime its only writer is main's browser auto-allow (§3.5.6). The old renderer never talks to agui runtimes (§2.1), so an old window's delayed `perm-1` can never reach a replacement process (finding r2-9). Auto-allow is bound to the exact runtime that produced the request (§3.5.6). If it releases a waiter, the host emits `permission.resolved {source:"legacy_response"}` + `permission.pending`.

#### 3.5.4 Attaching to a tool call (finding 6)

| Request source | `toolCallId` | `subagentRunId` | `attachedBy` |
|---|---|---|---|
| Gate (`session.ts:2650`, `bot-session.ts:1382`) | `request.tool.id` | none (the gate runs only in the parent) | `gate` |
| `askDenials` (`session.ts:2830`) | The most recently started, still-running call (parent or child) whose `input.command === request.command`. Its AG-UI id. | that call's | `command-match` |
| `askNetworkHost` (`session.ts:2900`), or `askDenials` with no match | The single running `bash`-kind call, if exactly one | its | `sole-running` |
| otherwise | none | none | `none` |

**The join is explicit and ours.** The chat kit's tool widget looks up the descriptor store by `(subagentRunId ?? "", toolCallId)` and renders the approval inline. Descriptors with no `toolCallId`, or whose tool part is not mounted, render in the application-owned `PermissionList` (§3.5.5), not the kit's Interrupts slot. TanStack's `selectChatUI` join (`selectors.ts:100-138`, `tool-approval` only) is not relied on.

#### 3.5.5 Rendering, expiry, stop, reset, reload (findings 8, r2-3)

**Application-owned permission list.** The kit's Interrupts slot reads `chat.interrupts` only (`create-ui.tsx:818`), which stays empty. So the layout and the notch each mount an application-owned `PermissionList`, subscribed directly to the descriptor store:

- it renders every descriptor that has no mounted tool widget: unattached `sandbox_denied`/`network_host` requests, housekeeping permissions, and requests whose tool part is not in view;
- the same component renders inline in tool widgets through the `(subagentRunId, toolCallId)` join (§3.5.4);
- its controls call `respondPermission(descriptor, decision)` with the descriptor's lineage.

A test mounts the real `createChatUI` layout with an unattached request and answers it (§7.5).

**Lifecycle:**

- **Expiry** (`session.ts:2777`, `bot-session.ts:1443`): `permission.cleared {reason:"expired"}` + `permission.pending`, plus `tool_blocked {cause:"expired"}` for gate-attached calls. The turn continues inside the same run. Only the expired item leaves the store.
- **Stop and reset** (`rejectAllPending`, `session.ts:3188`, `bot-session.ts:1550`): `permission.cleared {reason:"stopped" | "reset"}` each, then `permission.pending {items: []}`.
- **Reload or second window:** the store is hydrated from main's copy of the latest `permission.pending` (§5.3). Descriptors from a dead incarnation are dropped.

#### 3.5.6 Browser auto-allow (findings 1, r2-9)

Browser auto-allow stays in main:

1. `AgentCommunicationService.handleDesktopEvent` sees `permission_needed` on compat.
2. It returns `autoAllowDecision` for `browser_navigate` / `browser_snapshot` (`cli-communication-service.ts:38-41`).
3. `service-host.ts:1231-1238` writes the legacy `permission_response`.

The answer crosses two pipes, so it arrives after the waiter is registered, as today. The post-Stop suppression (`service-host.ts:1222-1228`) is kept.

**One main-side guard** is required for agui runtimes: the auto-allow write must go to the runtime object that emitted that `permission_needed`, not to whichever runtime currently owns the session id. This is main's slice. In the normal case it changes nothing; it only drops an answer when the runtime was replaced in between.

Rev 1's agent-side `--auto-allow` stays removed: it would have answered before `awaitDecision` registered the waiter (`session.ts:2734` vs `:2768`).

On AG-UI the renderer sees `permission.requested` followed by `permission.resolved {legacy_response}`. Main's relay may suppress the request for those two tool names.

### 3.6 Sub-agents (finding r2-4)

- **Stop from a card is application-owned.** ChatClient's `stopSubagent()` only aborts a request controller, and a client that is merely subscribed, or hydrated into a server-initiated run, has none. So the sub-agent card's Stop calls `ai.cancel({threadId, runId: <the parent run that owns the card>})`, which writes `cancel {runId}`. That is today's Stop, which ends the whole turn, from any window and from a restored card. `SubagentHandle.stop()` is not used.
- **pi 0.99's `parentToolCallId`** on session events is not used.
- **Nested scopes** set `parentSubagentRunId`. None exist today.

### 3.7 Host services (finding 20)

Host services stay entirely on the legacy path:

1. `host_service_request` goes out on compat.
2. `AgentManagerService.answerHostService` (`cli-manager-service.ts:935-942`, `:1106-1131`) answers.
3. The answer is the legacy `host_service_response` on stdin.

Nothing is emitted on AG-UI, so there is nothing for main to filter, and no payload leaks into the renderer or the replay ring. The renderer never needs them: the owning tool's own `TOOL_CALL_*` and its component subagent events already show progress. Rev 1's `client_tool_result` command and `host.*` client-tool encoding are removed.

### 3.8 Cancel, reset, exit: the abort path and "always a terminal"

- **`cancel {runId?}`** (finding r2-12):
  - **Stale id.** If `runId` is given and names neither the open run nor the run whose admission is preparing, it is ignored: `CUSTOM agent.notification` is not emitted, only a stderr line is logged, and nothing is stopped.
  - **Otherwise** it runs `host.ts:160-182` with one change in order:
    1. queue entries → `"turn"`, then `queue_updated`;
    2. `turn += 1`, `stopping = true`;
    3. **`runs.markCancelling(currentToken)`** and `admissionGen += 1`, synchronously;
    4. `await session.stop()`;
    5. `stopping = false`, `busy = false`, `preparing = false`;
    6. settle `cancelled` (`stopReason:"aborted"`);
    7. `agent.status idle`;
    8. `runAfterStop()`.

    A preparation still awaiting `setModel` sees the bumped generation and never prompts (§3.1.1).
  - Legacy `stop` is the same, without the `runId` check.
- **`reset_conversation`** follows `host.ts:207-218`, including `markCancelling`, the `admissionGen` bump and the cancelled settle. After that: `session.ready` (new pi session id and file, same incarnation), `STATE_SNAPSHOT`, `session.cleared` and `agent.status idle`. *(impl r1)* The session emits `ready` before `segments_cleared`, so the cancelled terminal is written when the replacement session's `ready` arrives during a reset, before `session.ready`; the old run's unwinding events then fall outside any run and are dropped (golden `reset-mid-run`).
- **stdin EOF.** After in-flight commands settle (`host.ts:138-145`), an open run gets `RUN_ERROR {code:"agent_exit"}`.
- **Crash.** `host.emergencyClose(code)` runs in `main.ts:18-29` and `process.on("exit")`. It writes `RUN_ERROR {agent_crashed | agent_exit}` for an open run with `fs.writeSync(1, …)`. It is idempotent, and compat gets nothing extra. *(impl r1)* Only when `process.stdout.writableLength === 0`: with earlier lines still queued in-process (a pipe under backpressure on macOS or Windows), a synchronous write would overtake them or land inside a half-written line, and they die with the process anyway; the agent then writes nothing and main synthesizes the terminal.
- *(impl r1)* **Signals.** A signal exit runs no `exit` handler: `background-processes.ts:264-275` re-raises SIGTERM (and the others it handles) with the default action after its cleanup. SIGTERM is how the desktop stops an agent, so no last words are written for it either. For **any** signal exit, not only SIGKILL, main synthesizes the open run's terminal (main slice).
- **Compat loss** is handled as in §2.4 (`RUN_ERROR {compat_lost}`, then exit 75).
- **Structural guarantee.** `RUN_STARTED` is written only by `runs.open(token)`, which throws when a run is open. Every `session.send` has a token-owned `try/finally` settle. So every `RUN_STARTED` gets exactly one terminal before the next `RUN_STARTED` and before exit; for a signal exit (*impl r1*: any signal, SIGTERM included) and for last words skipped under backpressure, main synthesizes it. The only terminal ever written without a `RUN_STARTED` is main's per-subscription `RUN_ERROR {queued}` (§3.1.6). The agent never writes one.
- **No agent-side watchdog** (finding 22). Main's inactivity watchdog keeps reading compat and sends `stop`. Main's own `RUN_ERROR {inactivity_timeout}` to the renderer follows the first-terminal-wins rule (main slice).

---

## 4. Bot loop

- **Hidden turns are never emitted on AG-UI.**
  - `runHiddenTurn` (`bot-session.ts:587-608`) brackets `sendCustomMessage` with the internal `hidden_turn {phase:"start" | "end"}`.
  - Between them the emitter drops every run-scoped event plus `agent.status`, `agent.retry` and `agent.heartbeat`.
  - Hidden-turn usage is logged to stderr: `[usage] housekeeping <customType> <json>`.
  - *(impl r1)* A run opening forgets any hidden-turn depth: housekeeping runs inside `send()` with admission held, so a run opens only after it ended or was aborted, and an aborted one's closing bracket (its `finally`) can land after the new `RUN_STARTED`.
  - A permission raised in a hidden turn still produces `permission.requested`, so it can be answered, as today's card could be. Its lineage is bound to the still-current `turnSeq` and carries no `runId` (§3.5.3). It renders in the `PermissionList` (§3.5.5).
  - **The compat stream is unchanged:** it still carries the lines the bot leaks today (`:1098`, `:1323`, `:1369-1374`, `:217`), so main's turn state behaves exactly as before.
- **The user's run settles before housekeeping.** The `settled()` callback fires before `runMemoryMaintenance()` (§3.1.5). `busy` stays true until `send()` resolves, as today. That keeps today's quirk that a message sent during a housekeeping turn is steered into it (§8.3).
- **Sanitiser first.** The only inputs are the `text_delta` / `thinking_delta` events the bot emits after `BotOutputSanitizer.push/flush` and `tidyBotText` (`bot-session.ts:1126`, `:1159-1160`, `:1179-1182`). The emitter never subscribes to pi directly, so every bot `TEXT_MESSAGE_CONTENT` is post-sanitiser, and `<think>` content becomes `REASONING_*`.
- **No `CUSTOM bot.reply`.** The messaging relay keeps parsing `text_delta` from **compat**: the per-`messageId` buffer, the last `<reply>`, `NO_REPLY`, `DEFERRAL`, ending on `idle` and ignoring errors after idle. `NO_REPLY` also travels as plain AG-UI text.

---

## 5. Replay, hydration, and what main needs

### 5.1 Unchanged, via compat

Main's taps consume compat unchanged:

- `recordAgentSession` from `ready` (`service-host.ts:1184-1190`), so the thread ↔ pi file mapping is unchanged;
- turn state and watchdog;
- messaging;
- artifacts;
- routine settle and the turn waiter;
- state patch;
- auto-allow (plus the runtime binding in §3.5.6);
- skills and MCP;
- host services;
- usage log.

The `health-check.ts` ready probe keeps spawning `--wire ndjson` until cut-over.

### 5.2 New, for the renderer (main slice)

- **`ai.send`** writes `run`:
  - on `run.ack {started}` the client follows the run;
  - on `queued` it injects the per-subscription `RUN_ERROR {queued}` (§3.1.6);
  - on `rejected` it injects a per-subscription `RUN_ERROR {code:"rejected", message: reason}`;
  - on `duplicate` it does nothing, because the original run's events are already in the log.
- **Other procedures:**
  - `ai.queue.*` → legacy queue commands;
  - `ai.cancel({threadId, runId})` → `cancel`;
  - `ai.respondPermission(lineage, decision)` → `permission.respond`.
- **Turn-state phase** per thread (from compat) is published to every window. The composer uses it (§3.1.6).
- *(impl r1)* **Across incarnations** the agent's `runId` dedupe starts empty: `ai.send` must dedupe a retried `runId` against its own log before writing `run`, and the transcript processor must skip a user `TEXT_MESSAGE_*` whose id it already holds (§3.1.4).
- *(impl r1)* **Production wiring** of `resolveWire`/`emitAgui`, the relay and the `ai.*` procedures is this main slice; the agent slice ships the runtime and test-only adapters (`agui/__tests__/relay.ts`, `chat-adapter.ts`).
- **The descriptor store** (latest `permission.pending`) and the **queue** (latest `queue.updated`) are kept per thread and exposed for hydration.

### 5.3 Hydration through TanStack's own contract (findings 23, r2-5 to r2-8)

The agent keeps no transcript and exposes no snapshot command (rev 2's `sync` is removed). Recovery uses `SubscribeConnectionAdapter.hydrate(threadId)` → `ChatHydrationResult {messages: UIMessage[], activeRun, interrupts}` and `joinRun(runId)` (`connection-adapters.ts:963-994`, `:1043-1056`). Both are backed by main's relay, which is single-threaded and applies each stdout line to every structure below before relaying it:

1. **Transcript.** A per-thread TanStack `StreamProcessor`, fed every AG-UI event in order. At each terminal, main persists `processor.getMessages()` (UIMessage[]) as the thread's transcript. `UIMessage[]` is exactly what `hydrate` returns, so no AG-UI message conversion is needed. `MESSAGES_SNAPSHOT` is not used (finding r2-8).
2. **Run log.** For the **active** run, main keeps its complete event list from `RUN_STARTED`, with no eviction until the terminal. It is capped at 200k events; past the cap only `tool.output` is coalesced to the latest per call. Completed runs are covered by the transcript, so the bounded ring applies only to completed runs' events.
3. **Checkpoint.** `hydrate(threadId)` is computed synchronously in one relay turn:
   - `messages` = the transcript as of the last terminal, i.e. excluding the active run;
   - `activeRun` = `{runId}` of the active run, or `null`;
   - `interrupts: null`;
   - a cursor, the relay sequence number `N` at that instant.

   The store snapshot (descriptors, queue, turn phase) is taken in the same turn. `joinRun(runId)` replays the active run's log **from its `RUN_STARTED`** up to `N`, then streams live events with sequence `> N`. Because both reads happen in the same synchronous relay turn, nothing can fall between them (finding r2-6):
   - a run that ends is either in the transcript (terminal ≤ N) or in the log;
   - a permission change is either in the store snapshot or after `N`.
4. **Replaying real events** means already-streamed text, reasoning, finished tools, finished children and the run's user input are all restored (finding r2-5). A call whose arguments are still streaming is replayed as the original `START` + the `ARGS` so far, with **no** `END`. The real `END` arrives live with the canonical input (finding r2-7). No synthetic re-announcement exists.
5. **In-ring resume** (`lastEventId` within the retained log) replays from it as before.
6. **Dead incarnation.** Stored descriptors whose `incarnation` differs from the live `wire.hello.incarnation` are dropped at hydrate.

The agent's contract for all of this: stdout is complete and self-describing; every event needed to rebuild state is on it, and nothing depends on hidden agent state. The §7.8 tests prove it.

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
| `queue.ts` | Queue and turn logic extracted verbatim from `host.ts:28-485` (`runTurn`, `admit`, `runAfterStop`, `releaseParked`, `resyncSteers`, `onSessionEvent`, `echoed`, `stopping`, `awaitingPermission`, `turn`), plus the single synchronous admission guard (`busy`, `preparing`, `admissionGen`; §3.1.1) used by every turn starter. Both hosts use it. |
| `host.ts` | `AguiHost`: the stdin loop (`host.ts:90-145`), the legacy command table, `run` / `cancel` / `permission.respond`, and the `wire.hello` preflight hand-off. |
| `permissions.ts` | `toDescriptor`, `allowedDecisions(kind)`, `isPermissionDecision`, `validateLineage`, `attachToolCall`, the pending map mirror. |
| `ids.ts` | Id helpers (§3.3.7) and `incarnation`. |
| `scope.ts` | `scopeEmit`. |
| `vendor/pi-acp/` | §6.2, with the MIT `LICENSE` and the source commit in a header comment. |
| `__fixtures__/`, `*.test.ts` | §7 |

**`src/tool-display.ts`** (new, finding r2-18) is a browser-safe entry that re-exports only `vendor/pi-acp` `buildToolTitle`, `toToolKind` and `formatToolContent`, with no `node:` or pi imports (enforced by a lint rule). It gets a new `tsdown.config.ts` entry (`:23-40`) and the package export `"./tool-display": {types: "./dist/tool-display.d.ts", default: "./dist/tool-display.js"}`.

### 6.2 Vendored from pi-acp (MIT)

| Helper | Source | Lands in | Changes |
|---|---|---|---|
| `buildToolTitle` | `pi-acp/src/acp/session.ts:92-149` | `vendor/pi-acp/tool-title.ts` | Keep `read` / `write` / `edit` / `bash` and the 80-char truncation. Add our tools (`grep`, `find`/`glob`, `ls`, `web_fetch`, `web_search`, `delegate_task`, `browser_task`, `ast_edit`, `batch_edit`, `batch_file_read`, `todo`, `memory`, `document`/`pdf`/`ppt`/`design`/`app`). Drop `lsp` / `tmux` / `context_*` / `claudemon`. |
| `toToolKind` | `:57-72` | `vendor/pi-acp/tool-kind.ts` | Extended mapping: read (`read`, `batch_file_read`, `ls`), edit (`write`, `edit`, `ast_edit`, `batch_edit`), execute (`bash`), search (`grep`, `find`/`glob`, `web_search`), fetch (`web_fetch`), think (`delegate_task`), switch_mode (`exit_plan_mode`), else other |
| `formatToolContent` + extractors | `translate/tool-content.ts:57-300` | `vendor/pi-acp/tool-content.ts` | Returns a markdown string, used for `ToolResultContent.formatted` only |
| `mapPiStopReason` | `session.ts:151-170` | `vendor/pi-acp/stop-reason.ts` | Kept as `toAcpStopReason`. Adds `toFinishReason`: stop → `"stop"`, length → `"length"`, toolUse → `"stop"` (a settled run is final; `"tool_calls"` would make ChatClient treat it as an intermediate hand-off, finding r2-16), deferred → `"stop"`, else `null`. |

### 6.3 Change

| File | Change |
|---|---|
| `protocol.ts` | Add `InternalAgentEvent`: `message_open`, `message_close`, `tool_call_start` / `tool_call_delta` / `tool_call_stop` (the existing producer-less shapes at `:126-133`), `tool_blocked`, `plan_changed`, `hidden_turn`. Add optional internal fields: `origin` on `error`, `subagentRunId` on every `AgentEvent`, `parentToolCallId` on `subtask_start`. `DesktopEvent` / `DesktopCommand` are unchanged. *(As built: `InternalAgentEvent` lives in `internal-events.ts`, since `protocol.ts` is the mirrored wire; the internal fields live in a WeakMap side table, `event-meta.ts`, invisible to `JSON.stringify`, including impl r1's `attributed` and `unfinished`. `message_open.messageId` is optional: absent when pi gave no timestamp, §3.3.7.)* |
| `host.ts` (`NdjsonHost`) | Becomes `queue.ts` + `HostSink` with the compat writer = stdout and no AG-UI emitter. Output is byte-identical (§7.2). `ABACUSAI_BOT_WIRE_RECORD=<path>` records stdin plus pre-strip events for fixtures. *(impl r1)* `agui/record.ts`: one JSON line each, in order: `{dir:"in", line}`, `{dir:"out", event, meta?}` (the legacy event and its internal facts: `origin`, `subagentRunId`, `parentToolCallId`, …), `{dir:"internal", event}`. Only when recording does `NdjsonHost` give the session `emitInternal`. |
| `main.ts` | Parse `--wire`, `--thread-id`, `--compat-fd`. Run the synchronous compat preflight and write `wire.hello` before constructing the session (§2.4). Wire `emergencyClose` into `:18-29` and `exit`. |
| `tsdown.config.ts` | Add the `src/tool-display.ts` entry. |
| `index.ts` | ~~Export `AguiHost` and the wire types~~ *(impl r1)* Export the wire types; keep `NdjsonHost`. `AguiHost` is not exported, for the reason `openllm.ts` is not: the `BotSession` in its signature drags pi's declaration tree into the dts bundle and breaks the build. `dist/main.js` (`--wire agui`) is its entry, and nothing else runs it. |
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

*(impl r1, as built)* The AG-UI goldens are produced **live**: the real `AguiHost` with the real session runs the scenario against the fake provider, its compat bytes are asserted equal to the pre-change `.ndjson` baseline in the same run, and its stdout is normalised and compared with `<scenario>.agui.jsonl`. That is equivalent to replaying a recording, and stronger (the host-session interplay is real, not re-enacted): `wire-record.integration.test.ts` shows, per scenario, that the recording's `out` events serialise to exactly the baseline stdout and that the internal events the agui host's session feeds the emitter are exactly the recorded ones. So the recording and the live run feed the emitter the same stream. Normalisation drops `timestamp`, numbers `srv-…` and `<session>:<timestamp>` ids in order, masks the pi session id/file, the root and the port, keeps the incarnation (the golden host's is fixed), and keeps each `expiresAt` as its offset from its event (`<now+900s>`). Every event is also parsed by `@ag-ui/core/schemas`.

*(impl r1)* Scenarios the fake provider cannot drive, and what covers them instead:

- **Two permissions pending at once** (reverse order, one expiring): pi 0.85 prepares sibling tool calls one after another (`agent-loop.js` `executeToolCallsParallel` awaits each `prepareToolCall`, gate included, before any executes), so two gate cards never coexist; concurrent cards come from sandbox asks of commands already running, which need an OS sandbox. Covered on the real `AguiHost` over a scripted session (`host-scripted.test.ts`), including byte-equal compat for `permission.respond` and `permission_response`.
- **`browser_task` child text** and **`sandbox_denied` / `network_host` attach**: need a browser, an OS sandbox and a network proxy. Covered by synthetic events through the real host and main's relay into a fresh processor (`host-scripted.test.ts`), and by the emitter tests.
- **Housekeeping permission**: a bot's hidden turn raising a card needs a scripted flush; covered in `host-scripted.test.ts` (lineage, hydrate, answer, expiry).
- **`ppt`/`document` components**: need main's host services; their compat is unchanged by construction and the emitter tests cover the brackets, including `unfinished`.

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
4. Assert that **B** equals the checked-in baseline `__fixtures__/<scenario>.ndjson`, recorded from the pre-change build (`git stash` baseline). This proves `--wire ndjson` itself is unchanged. *(impl r1)* Every baseline is recorded on `d9cf445e`, the last commit before any `src` change, with the current harness copied in; the golden test only reads them (`RECORD_NDJSON_BASELINE=1` writes a missing one and never overwrites).
5. Assert that rejected, duplicate and invalid AG-UI commands (`run.ack rejected/duplicate`, `permission.response_rejected`, a stale `cancel {runId}`) add **no** bytes to **C**.

**Spawned-process check.** Run `dist/main.js --wire agui --compat-fd 3` against `dist/main.js --wire ndjson` for three scenarios on macOS, Linux and Windows CI. Mask only the pi session id, the `ts` fields and the `Date.now()`-derived subtask ids, and drop the single fd-mode `compat.hello` preamble. This proves fd 3 works across platforms.

**Handshake and loss checks** (findings r2-14, r2-15):

- **fd 3 closed before spawn:** `wire.hello.compat === "inline"`, and the RS-prefixed lines, stripped, equal **B** byte for byte.
- **Asynchronous first-write failure:** simulate a writable fd whose first async write errors.
  - The preflight's synchronous write catches it and chooses inline.
  - If the preflight passes but a later async write fails, stdout carries `wire.compat_lost` and the open run's `RUN_ERROR {compat_lost}`, and the process exits with 75.
  - No AG-UI line is written after the failure, apart from those two.
- **Real `AgentManagerService`:** it reads `wire.hello` and routes compat for both modes, driving the unchanged taps and the new ChatClient end to end.

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


- **Busy input, round 2** (findings r2-1, r2-2):
  - During streaming, during a permission wait, and while stopping, a composer submission goes through `ai.queue.enqueue` and never through `sendMessage`. It steers the current turn, or parks behind the permission, exactly as legacy `enqueue` does. It survives Stop (it runs next), and an error does not drop it.
  - Edit, remove and clear reach the host queue.
  - **Race:** two windows; window B's `run` lands while A's run streams. B's `sendMessage()` promise resolves with the injected `RUN_ERROR {queued}` **before** A's run ends. The text appears in the queue slot and runs next.
- **Admission races** (findings r2-10, r2-11):
  - A `run` with a delayed `forwardedProps.model`, followed by a legacy `send` / `enqueue` / `dequeue` while it prepares: exactly one turn runs, and the others are queued with `waitingFor:"turn"`.
  - The same delayed preparation followed by Stop: no prompt reaches pi, and the run closes `cancelled`.
  - Followed by reset: no prompt reaches the new conversation.
- **Late cancel** (finding r2-12): `cancel {runId: A}` arrives after A settled and B was admitted. B keeps running.
- **Card Stop** (finding r2-4): the sub-agent card's Stop in a second window, and in a window restored by `hydrate` + `joinRun`, stops the owning run.
- **Unattached permission** (finding r2-3): a `network_host` request with no running bash renders in the real `createChatUI` layout's `PermissionList` and in the notch, and can be answered.
- **Housekeeping permission** (finding r2-13): a permission raised in a bot flush turn after the user's run settled carries a lineage with `turnSeq` and no `runId`. It hydrates into a fresh window, its answer validates and releases the waiter, and its expiry clears it.
- **Old-window answer** (finding r2-9): an ndjson-runtime renderer window cannot address an agui runtime (§2.1). Auto-allow bound to runtime A does not reach runtime B after a respawn (main slice test).

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
  - a raced `run` settles via the injected `RUN_ERROR {queued}` (§3.1.6);
  - a run with a permission stays loading until the answer, then completes.

- **Final-turn finish reason** (finding r2-16): a run whose last assistant `stopReason` is `toolUse` (e.g. a budget stop after a tool round) settles with `finishReason` `"stop"`. ChatClient's `sendMessage()` resolves and the processor finalises.
- **Usage** (finding r2-17): `inputTokens = input + cacheRead + cacheWrite`, `totalTokens = inputTokens + outputTokens`, the cache fields are parts of `inputTokens`, and a null `TurnUsage.model` produces no `model` key. Validated against `@ag-ui/core`'s documented accounting.
- **`tool-display` entry** (finding r2-18): `import { buildToolTitle } from "@abacus-ai/agent/tool-display"` builds in the renderer's Vite bundle and resolves in the packaged app. A lint rule forbids `node:` imports and pi imports in `src/tool-display.ts` and its closure.

### 7.7 Bot sanitiser and hidden turns

- A `BotSession` with the fake provider streaming `<think>` / `<reply>` / stray tags: no `TEXT_MESSAGE_CONTENT` contains `<think>`, `<thinking>` or `<reasoning>`, and the concatenated content equals the compat `text_delta` concatenation.
- The flush and consolidation turns add zero AG-UI lines apart from `permission.*`, and the compat lines are unchanged.
- The user's run terminal precedes the hidden turn's first pi event.

### 7.8 Hydration (findings 23, r2-5 to r2-8)

These run in-process, with main's relay (transcript processor, run log and store) driven from recorded AG-UI:

- **Reload mid-run:**
  - after a tool finished and a child finished;
  - with 5 KB of text already streamed;
  - with a call halfway through its arguments.

  In each case `hydrate` + `joinRun` into a fresh `ChatClient` produces exactly the parts of a client that watched live: the partial text, the finished tool with its output, the child card with its results, and the streaming call finishing with the real canonical input.
- **Atomic checkpoint:** a terminal and a permission resolution are injected between the start of `hydrate` and the first `joinRun` event. Neither is lost or duplicated.
- **Transcript round trip:** `processor.getMessages()` of a completed thread → `hydrate` → a fresh processor fed the next run yields the same messages as a single continuous processor.
- **Second window** attached mid-run, and **completed-run eviction** from the bounded ring: the transcript covers the evicted runs.

---

## 8. Acceptance and risks

### 8.1 Acceptance checklist

- [ ] `--wire ndjson` stdout equals the pre-change baselines for every scenario (§7.2 step 4). The existing agent suites pass unchanged.
- [ ] `--wire agui` compat equals `--wire ndjson` stdout byte for byte for every scenario, in fd and inline modes. This holds on three OSes in the spawned check. The handshake and loss checks pass (§7.2).
- [ ] Main runs its taps from compat with **zero** tap-logic changes. The only main additions are the hello router and the auto-allow runtime binding.
- [ ] The goldens (§7.1), transport-bridge ports (§7.3) and properties (§7.4) pass.
- [ ] Every §7.5 test passes: independence, lineage, envelope, expiry, auto-allow, sibling artifact, busy input and race, admission races, late cancel, card Stop, unattached and housekeeping permissions.
- [ ] Conformance (§7.6) passes, including the finish reason, usage and the `tool-display` entry. The bot tests (§7.7) and hydration tests (§7.8) pass.
- [ ] No behaviour-bearing logic changed beyond §6.3.
- [ ] `typecheck` and `test` are green, and the runtime adds only `@ag-ui/core`.
- [ ] PLAN.md is amended:
  - no `bot.reply`;
  - no native interrupts; permissions use the descriptor store, `permission.respond` and the `PermissionList`;
  - busy input goes to the host queue via `ai.queue.enqueue`, and ChatClient's busy guard is a queue strategy function that throws (*impl r1*: `whenBusy: "error"` does not exist in ai-client 0.36);
  - hydration uses `hydrate` + `joinRun` over main's processor transcript and run log;
  - host services stay on compat;
  - compat feeds main's taps.

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
| fd 3 behaves differently on Windows. | The synchronous preflight chooses inline mode. Tested on three OSes. |
| The channels drift. | One `HostSink.emit`. The byte test and the goldens cover both. |
| A run stays open while a permission waits (up to 15 minutes). | This is today's busy UX. Input goes to the host queue (§3.1.6). |
| The two-window race produces a `queued` terminal that belongs to no run. | Per-subscription only. It never enters the ring or other windows. The renderer treats `code:"queued"` as "moved to queue". |
| Run-log memory for very long runs. | 200k-event cap, with `tool.output` coalescing past it. Completed runs move to the transcript. |
| The regenerate restriction. | Explicit rejection ack. `reload()` is hidden. Branching is a later slice. |
| Command-match attaches to the wrong call. | Most recent wins. Placement only. |
| Pre-existing quirk: a message sent during bot housekeeping is steered into it. | Unchanged; logged for the bots slice. |
| `@ag-ui/core` or TanStack drift. | Pinned. The no-cast conformance and ChatClient tests fail loudly. |

---

## 9. Review responses

### Round 1 (`reviews/00-agent-agui.codex-r1.md`)

| # | Finding | Resolution | Where |
|---|---|---|---|
| 1 | Auto-allow answered before the waiter registered | Auto-allow stays in main and reads compat. It answers via the legacy `permission_response`, which arrives asynchronously after registration. The agent-side `--auto-allow` is removed. Round-trip test added. | §3.5.6, §7.5 |
| 2 | Zero-length run overlapping the open run; admission race | Synchronous admission; busy input is acked `run.ack {queued}` without a run. Refined in round 2: see r2-1, r2-10, r2-11. | §3.1.1, §7.4 |
| 3 | Resume lineage; ids restart per process | `permission.respond` carries a lineage of thread, incarnation, run and permission id. Everything is validated before any session call, and a mismatch releases nothing. | §3.5.3, §7.5 |
| 4 | Unmatched resume closed with success | There is no resume path. A stale or invalid answer gets `permission.response_rejected` plus the authoritative `permission.pending`. A pause is never reported as finished. | §3.5.3 |
| 5 | All-or-nothing batches change timing | No batching and no native interrupts. Each permission is its own descriptor, answered independently, and the run stays open. Independence test. | §3.5, §7.5 |
| 6 | Generic interrupts do not join tool widgets | An explicit join: the chat kit's descriptor store is keyed by `(subagentRunId, toolCallId)`. The fallback is the application-owned `PermissionList` (r2-3). `selectChatUI` is not relied on. | §3.5.4 |
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
| 23 | Hydration conditional and incomplete | Superseded in round 2 by `hydrate` + `joinRun` over main's processor transcript and complete active-run log (r2-5 to r2-8). | §5.3, §7.8 |
| 24 | String literals not assignable; missing client dep | Built on `@ag-ui/core` `EventType` via the checked `aguiEvent()`. `@tanstack/ai-client` is a devDependency. No-cast conformance. | §2.3, §6.3, §7.6 |
| 25 | END metadata updates ignored | START carries only immutable facts. Title and kind are computed at render time from the final input with exported helpers. Rendered-value test. | §3.3.5, §7.6 |

### Round 2 (`reviews/00-agent-agui.codex-r2.md`)

| # | Finding | Resolution | Where |
|---|---|---|---|
| r2-1 | A queued ack cannot settle ChatClient's `send` (`streamResponse` awaits `processingComplete`) | Busy input never calls `sendMessage`: the composer routes it to `ai.queue.enqueue`. In the two-window race, main injects a per-subscription `RUN_ERROR {queued}` for that run id, which resolves `processingComplete`. Tested before the other run ends. | §3.1.6, §5.2, §7.5 |
| r2-2 | ChatClient's local busy queue cannot steer and is cleared by Stop | The host queue is authoritative. Composer, edit, remove, clear and send-now map to the legacy queue commands. `whenBusy:"error"`. Tested during streaming, permission, Stop and error. | §3.1.6, §7.5 |
| r2-3 | The Interrupts slot reads only `chat.interrupts` | An application-owned `PermissionList` in the layout and the notch, subscribed to the descriptor store. Tested with the real `createChatUI` layout. | §3.5.5, §7.5 |
| r2-4 | `SubagentHandle.stop()` only aborts a local controller | The card's Stop calls `ai.cancel({threadId, runId})`. Tested from a second window and a restored card. | §3.6, §7.5 |
| r2-5 | Sync lost already-emitted content of the active run | Main keeps the active run's complete event log. `joinRun` replays it from `RUN_STARTED`. The transcript is main's processor output. | §5.3, §7.8 |
| r2-6 | No atomic recovery boundary | The checkpoint (transcript, active run, store, cursor N) is computed in one synchronous relay turn, and replay is ≤ N followed by live > N. Race test. | §5.3, §7.8 |
| r2-7 | Re-announcing with END broke streaming arguments | No synthetic re-announcement. The real `START`/`ARGS` are replayed, and the real `END` arrives live. | §5.3, §7.8 |
| r2-8 | The UIMessage → `MESSAGES_SNAPSHOT` conversion was unspecified | Not needed: `hydrate` returns `UIMessage[]` straight from `StreamProcessor`. Round-trip test. | §5.3, §7.8 |
| r2-9 | The legacy `permission_response` was exempt from lineage (old-window answers) | Agui runtimes serve only the new renderer. The old renderer uses ndjson runtimes. The auto-allow write is bound to the emitting runtime (main guard). Renderer answers always carry lineage. | §2.1, §3.5.3, §3.5.6 |
| r2-10 | Admission was reserved only for `run` | One synchronous `busy` acquisition for every turn starter (legacy `send`, `enqueue`, `dequeue`, drains, `runAfterStop`). `preparing` queues with `waitingFor:"turn"`. Mixed-concurrency tests. | §3.1.1, §7.5 |
| r2-11 | Stop or reset during model preparation still prompted | `admissionGen` plus cancelling and turn checks after every preparation await. A failed check never prompts. Tested for Stop and reset. | §3.1.1, §3.8, §7.5 |
| r2-12 | A stale `cancel.runId` stopped an unrelated run | `cancel {runId}` is applied only if that run or its preparing admission is current. Legacy `stop` stays unconditional. Late-cancel test. | §2.2, §3.8, §7.5 |
| r2-13 | Housekeeping permissions had no owning run | Lineage binds to `turnSeq` (the `TurnToken` that survives into housekeeping). `runId` is informational. Tested through hydrate, answer and expiry. | §2.2, §3.5.3, §7.5 |
| r2-14 | Exit-78 fallback published a failure and broke the new renderer | Removed. A synchronous preflight negotiates fd versus inline compat before startup, and `wire.hello` tells main. The renderer is always AG-UI. There is no respawn. | §2.4, §7.2 |
| r2-15 | Asynchronous write errors versus "exit before stdout"; silent tap loss | The preflight uses `writeSync`, so errors are synchronous. Loss after the handshake produces `wire.compat_lost`, `RUN_ERROR {compat_lost}` and exit 75, never silent. Tested. | §2.4, §3.8, §7.2 |
| r2-16 | `finishReason:"tool_calls"` on a final terminal skips completion | Final terminals only use `stop`, `length` or `null`, and `toolUse` maps to `"stop"`. `tool_calls` is reserved for a future continuation protocol. Tested. | §3.1.5, §6.2, §7.6 |
| r2-17 | Cache accounting | `inputTokens = input + cacheRead + cacheWrite`, cache fields as parts, `totalTokens = in + out`, and a null model is omitted. Tested. | §3.3.8, §7.6 |
| r2-18 | The `tool-display` export had no build entry | A dedicated browser-safe `src/tool-display.ts`, a tsdown entry and a package export. A lint rule bans node and pi imports. The renderer bundle and packaged app are checked. | §6.1, §6.3, §7.6 |

### Implementation review round 1 (`reviews/00-agent-agui.impl-codex-r1.md`, `…impl-claude-r1.md`)

The per-finding status, commits, tests and rebuttals are in `reviews/00-agent-agui.impl-fixes-r1.md`. The spec amendments are marked *(impl r1)* in place. Codex #9 (production wiring of `resolveWire`/`emitAgui`, main's relay and the `ai.*` procedures) is the main slice (§5.2) and out of this slice's scope.

---

## Implementation notes (main relay)

The main slice of §5.2 (Codex impl r1 #9): production wiring of `resolveWire`/`emitAgui`, main's AG-UI relay, the `ai.*` procedures, and transcript persistence. It follows this spec, spec 00 A.3/A.4.3 and spec 02 §3 and §14. Where those disagree, spec 02 §14 (the consumer's contract) wins, and the differences are listed here.

**Files.**

- `apps/desktop/src/main/services/agui/thread-relay.ts`: `ThreadRelay`, one thread's relay. It holds a TanStack `StreamProcessor` transcript, a bounded ring, the active run's log, the logs of the last finished runs, and the session-scoped snapshot. All of them are updated in one synchronous turn per event, before any subscriber sees it.
- `…/agui/relay-service.ts`: `AguiRelayService`, which implements the procedures' `AguiSource`. `ServiceHost.aguiRelay` holds it, and `main/index.ts` mounts it as `deps.ai` in place of `UnavailableAguiSource`.
- `…/agui/json-patch.ts`: the RFC 6902 subset `STATE_DELTA` uses.
- `main/rpc/ai/source.ts` (the interface), `main/rpc/procedures/ai.ts` (thin procedures, and `hydrate` paging), `shared/contract/ai.ts` + `ai-thread.ts` (the contract and the snapshot types).
- `services/session/cli-manager-service.ts`: `emitAgui` now carries the runtime's identity. `emitAguiExit` is new: it fires after the last stdout line, with `code`, `signal`, and whether main asked the process to stop. `getRuntimeInfo` is new. The compat pipeline (`handleNdjsonLine`, `handleCompatFd`, the inline prefix) is untouched, so the taps read the same bytes as before.
- `services/session/thread-store.ts`: `writeAgui`.
- `service-host.ts`: the relay's host adapter; `resolveWire`, `emitAgui` and `emitAguiExit`; the inactivity watchdog's terminal; `markTurnStopped`, extracted from `stopAgentTurn` so `ai.cancel` shares it. The relay is told about resets and session deletion.

**Wire selection.** One protocol per runtime (§2.1). In the new-renderer build (`RENDERER_GENERATION = "wco"`) every spawn is `agui`: a routine, a bot reply or a restored session spawned before the renderer's first `ai.*` call must be drivable from it (review r1, Claude 3). In the legacy build `wireFor(threadId)` is `agui` once an `ai.*` procedure has named the thread, or for every spawn when `ABACUSAI_BOT_AGENT_WIRE=agui` is set **in an unpackaged app** (a packaged legacy app ignores it, with a log line: its renderer could not show the turn; review r1, Claude 9). Otherwise it is `ndjson`, so the shipped app (old renderer, `RENDERER_GENERATION = "legacy"`) spawns exactly as before (`defaultWire` in `relay-service.ts`). A claimed thread whose agent is already running `--wire ndjson` (started earlier by the old renderer or a routine) is not restarted: `ai.send` and the other commands answer `UNAVAILABLE` until that process ends. When no agent runs, `ai.send` starts one itself (with the session's own model and mode, as `sendAgentMessage` restarts one) and waits for `running`.

**Event ids.** Seqs come from one counter per main process. It is shared by every thread and never reused, so a resume point is never ambiguous across threads or relay evictions. The event id is `String(seq)` (spec 02 §14.3-§14.4). The `{epoch, seq}` pair is the relay's `epoch` plus that seq. The epoch is a UUID per main process, returned in `hydrate`'s `abacus.epoch` and in the `abacus.subscribed` / `abacus.resync` values, and `ai.subscribe` takes it back as `epoch` beside `lastEventId` (spec 02 §14.12). These resume points yield `abacus.resync`:

- one carrying another `epoch` (a seq from another main process, even one inside this ring);
- one beyond the head (from another main process);
- one below the thread's floor (evicted from the ring, or the thread was reloaded);
- anything that is not a non-negative integer.

`hydrate`'s `abacus.cursor` is the **thread's own** last seq, not the global clock: every event up to it is in the snapshot or in the active run's `joinRun` replay, so the kit's reconstruction (`appliedSeq ≥ N`) completes however much other threads said meanwhile.

The two control yields carry no event id, so the retry plugin's `last-event-id` never moves past what the client saw.

**Delivery.**

- `ai.subscribe` and `ai.joinRun` queue per subscriber as lossless-actionable: 10,000 events, then `RESYNC_REQUIRED`. A queue that overflows detaches its listener at once, whether or not the consumer reads again.
- The listener is registered and the replay computed in the same turn. The listener is released on abort, even when the stream was never read.
- The ring holds 4,000 events per thread.
- The active run's log is complete up to 200,000 events. Once it reached that, every later `tool.output` replaces all earlier ones of its call (an index per call; the log stays in seq order).
- Finished runs stay joinable for 2 minutes, at most the last 4, and within 20,000 events across them (the newest whatever its size). `joinRun` of any other run returns at once, and the kit then starts a new generation. The run-to-thread index for `joinRun` is pruned with the logs.

**`ai.hydrate`.** `AguiSource.hydrate(threadId)` replaces transport A.3's composition of `liveState` and `ThreadReader`: the checkpoint must be one relay turn (§5.3 item 3), which two independent owners cannot give. It returns:

- `messages`: the transcript as of the last terminal, with the active run excluded (spec 02 §14.1);
- `activeRun`;
- `interrupts: null`;
- `abacus`: spec 02's `ThreadSnapshot`, plus `epoch`.

The procedure pages `messages`, and keeps the `runOutcomes` whose `afterMessageId` is in the returned window. Outcomes with a null one go with the newest page. A `before` the transcript does not hold is `NOT_FOUND`, and so are `hydrate` and `subscribe` for a session main does not know (claimed and loaded only after that check). A thread's history is loaded from `ThreadStore.readCurrentFile`: an `agui` file as it is, or the v1-derived repair. A v1-derived baseline is re-read at each checkpoint and before each `RUN_STARTED` until the thread's first AG-UI terminal has persisted, so turns the legacy renderer adds meanwhile are not overwritten. So migrated history is both served and continued.

**Persistence.**

- At each terminal, the relay writes the processor's messages and the run outcomes as a `source.kind: "agui"` thread file (`ThreadStore.writeAgui`). The write is atomic, and synchronous so that a later removal cannot be overtaken by it. `migratedFrom` is set when the history began from a v1 transcript.
- `RunOutcomeRecord` is spec 02 §14.7's, and the last 1,000 are kept. `steps` counts the run's parent `TOOL_CALL_START`s, `usage` is `RUN_FINISHED.usage[0]`, and `error` is `metadata.abacus.error` plus the event's `code` and `message`.
- `session.cleared` clears the relay and removes the file.
- The legacy reset (`resetAgentConversation`, which also removes both files) puts a main-synthesized `CUSTOM session.cleared` on the stream, which clears the relay at once and tells every window (spec 02 §3.1 `rev`). A run that was open across the clear persists nothing.
- The v1 dual-write never replaces an `agui` file, including one the store has just written itself (its own-write cache records the kind).
- Session and workspace deletion forget the thread.

**Cross-incarnation duties** (PLAN amendment; §3.1.4, §3.8, §5.2).

- **`ai.send` is idempotent by run id across respawns.**
  - The messages are converted first: a conversion failure is `BAD_REQUEST` and reserves nothing.
  - The duplicate check and the reservation of the run id are one synchronous step; everything after (starting the runtime, one start at a time per thread, and the write) is covered by cleanup: an admission that never reached the agent rejects any waiting repeat with the same definitive error and undoes `markSent`.
  - The first ack of every run id is recorded (the last 10,000 over all threads). A repeat answers `{status: "duplicate", original}` without writing `run`.
  - A repeat that arrives during the first attempt waits for its ack.
  - A run id main saw start, without seeing its ack, is a `duplicate` of `started` (a bounded set of such run ids, separate from the replay index).
  - An agent `duplicate` for a run main has no record of answers `{status: "duplicate"}` with no `original`, rather than a guessed `started`.
  - `thread_mismatch` is not recorded, since it means main built a bad envelope.
  - No ack within 30 s is `TIMEOUT`, which is uncertain for the kit. The admission itself is rejected, so a waiting repeat gets the same answer, and a late ack is still recorded.
  - A runtime that exits while an admission it was written to waits rejects it the same way, and the retry writes `run` to the new process. An obsolete process's exit leaves admissions waiting for a runtime, or written to its replacement, alone.
- **Echo dedupe.** A user `TEXT_MESSAGE_*` whose id the transcript already holds is dropped from the processor and the ring. That is a retry reusing its message id after a respawn; without the drop, `StreamProcessor` appends its content, in main and in every client. In its place main puts `CUSTOM abacus.duplicate_echo {runId, messageId}` on the stream, and it does the same right after a `RUN_STARTED` whose `ai.send` carried a user message the transcript already holds (a retry in the same process, which the agent does not echo again), so the kit's outbox entry is released (spec 02 §14.12).
- **Before every `RUN_ERROR` it applies** (the agent's or its own), main closes the run's open parts in the agent's `closeOpenParts` order (reasoning, text, children with their tools and `SUBAGENT_ERROR`, then tools with `TOOL_CALL_END` and an unfinished `TOOL_CALL_RESULT`), and gives a run with no parent assistant message an empty one (`TEXT_MESSAGE_START/END {messageId: "<runId>:error", role: "assistant"}`). A receive-only `StreamProcessor` does neither on `RUN_ERROR`: it leaves tool calls streaming, and without an assistant message it creates a pending one that the next `TEXT_MESSAGE_START`, the next run's user echo, is renamed into. The agent's own close paths (`close()` with a failure, `emergencyClose`) now write the same anchor, so main adds nothing to a current agent's terminal. The run's outcome then has `afterMessageId: "<runId>:error"`.
- **Parity with `ChatClient`.** Each chunk reaches main's processor through `restoreInboundChunk` (on a shallow copy; the ring keeps the agent's event), as `ChatClient.processIncomingChunk` does. A terminal's run id is read as `getChunkRunId` reads it (top-level `runId` first).
- **Main writes the open run's terminal itself**, and the first terminal wins: the rest of that run's stream, its own terminal included, is dropped until the next `RUN_STARTED`. Main writes it:
  - on the runtime's exit: `agent_crashed` for a signal or a non-zero exit main did not ask for, otherwise `agent_exit` (so SIGTERM from Stop session is `agent_exit`);
  - on the inactivity watchdog: `inactivity_timeout`, before the watchdog's `stop`;
  - on a `wire.hello` from a new runtime while a run is open;
  - on a `RUN_STARTED` while a run is open.

  An exit also puts `permission.pending {items: []}`, `queue.updated {messages: []}`, `agent.status idle` and `agent.heartbeat {runningTools: 0}` on the stream, since the process's cards, queue and running tools died with it. A final stdout line without its newline is still delivered before the exit, and an over-long line is logged when truncated.
- **Incarnation** is tracked from `wire.hello`, `session.ready` and `STATE_SNAPSHOT`. Descriptors and queue ids of another incarnation are dropped.

**`ai.send` and the other commands.**

- **No injected terminal.** Main injects no per-subscription `RUN_ERROR {queued}`: spec 02 F6 and §14.5 supersede §3.1.6's injection and §5.2's first bullet. The ack is `ai.send`'s answer.
- **Conversion.** UIMessages become AG-UI wire messages through `uiMessagesToWire`, which keeps the client's ids. `forwardedProps.whenBusy` is dropped. `resume` is passed through for the agent to reject. `clientTools` is ignored (`tools: []`).
- **Turn state.** As the legacy `sendAgentMessage` does, `ai.send` marks the turn sent in main's turn state before writing `run`, so a Stop's post-stop suppression cannot hide the new turn from the taps. A `rejected` ack with no run open marks it stopped again.
- **Not applied.** The legacy path's environment notice and "remember" hook are not applied to `ai.send`. They rewrite or inspect the user's text, and that is left for the chat-kit slice to decide.
- **`ai.cancel`** writes `cancel {runId}`. It marks main's turn stopped (with the connector-gate release, as `stopAgentTurn` does) only when the id is the open run, an admission main is still waiting on, or one acked `started` whose `RUN_STARTED` has not come yet (tracked explicitly, and dropped at that `RUN_STARTED` or the runtime's exit). A stale id is forwarded, and the agent ignores it, without suppressing the running turn's compat events.
- **`ai.respondPermission`** validates the decision strictly in the contract (a boolean is `BAD_REQUEST`, never a rejection) and checks the lineage's thread, then writes `permission.respond`.
- **`ai.queue.update` / `ai.queue.remove`** go to the agent as `queue.update {incarnation, entryId, message}` / `queue.remove {incarnation, entryId}` (spec 02 §14.6, review r1). `AguiHost` checks the incarnation and finds the entry **by id** in the same synchronous step as the legacy handler's mutation, so a drain in between can never shift the target; the accepted path is today's `update_queue_item` / `remove_from_queue` for that entry's index (same compat lines), and a refusal is `queue.command_rejected {incarnation, entryId, command, reason}` plus the authoritative `queue.updated`, on AG-UI only. Main refuses only an incarnation that is not the live one (a process that is gone), on the stream in the same shape, and sends nothing then; it no longer checks entry ids or translates them to indexes.

**Packaging.** Transport A.3.1 says `@tanstack/ai` moves to `dependencies` once used at run time. Main inlines it instead (`vite.config.ts` `bundleDeps.include`, with `@tanstack/ai-event-client`, `@tanstack/devtools-event-client`, `@tanstack/ai-utils`, `@ag-ui/core` and `partial-json`, closed transitively), so it stays a `devDependency` and the asar gains no `node_modules` tree for it. `packaged-startup.test.ts` checks every bare import of the built bundles against the packaged dependency tree, and rebuilds when `dist` is older than the main, preload or shared sources, so the check always reads bundles built from the code under test.

  The window between main's last `queue.updated` and the agent reading the command (a drain in between) can still shift the index. The atomic agent commands close it.
- **`ai.queue.enqueue`, `.clear` and `.dequeue`** are the legacy `enqueue {hidden: false}`, `clear_queue` and `dequeue`.
- Every command answers `UNAVAILABLE` unless an agui runtime runs the thread. `ai.cancel` with nothing running is a no-op.

**Packaging.** The relay runs `StreamProcessor` and `uiMessagesToWire` in main, so `@tanstack/ai` and the packages it imports at run time are inlined into the main bundle (`vite.config.ts`, `bundleDeps.include`). `packaged-startup.test.ts` no longer reads a JSDoc usage example in an inlined package as an import. The desktop declares `@abacus-ai/test-support` (the fake provider) as a devDependency.

**Tests** (`apps/desktop/src/main/services/agui/`, 35):

- **`thread-relay.test.ts` (15)**, driven with the agent's goldens:
  - the persisted transcript equals a live processor's;
  - the session snapshot, and permissions of the live incarnation only;
  - checkpoint + `joinRun` mid-run equal a live client;
  - ring resume and resync, and ring eviction with the transcript covering the evicted runs;
  - echo dedupe across a respawn;
  - exit synthesis with first-terminal-wins, and the inactivity terminal;
  - a stale runtime's exit is ignored, and stray run-scoped events are dropped;
  - clear semantics and `session.cleared`;
  - refused queue commands, notices and state deltas, and the JSON-patch subset.
- **`relay-service.test.ts` (15)**: every procedure through the real router and oRPC adapters, over a scripted agent:
  - send: start, conversion and ack;
  - idempotency during the first ack, after it, and across a respawn; queued and rejected acks;
  - `NOT_FOUND` and `UNAVAILABLE` before writing; an ack timeout with a late ack; an exit before the ack;
  - cancel of the current run versus a stale id; respondPermission validation; queue identity checks;
  - subscribe ids, resume and resync; hydrate paging with outcomes; joinRun;
  - listeners released on a closed port; the agui file served by a new relay.
- **`relay.e2e.test.ts` (5)**: the real `dist/main.js --wire agui --compat-fd 3` against the fake provider, spawned by the real `AgentManagerService`, through the relay and the router, into a real `ChatClient` bound as the chat kit binds it (hydrate, `joinRun` from `startSeq`, `subscribe` from the last seq, admission through `ai.send`):
  - send → `permission.requested` → `ai.respondPermission` → `RUN_FINISHED`, with compat still feeding the taps and the agui file written;
  - a window that reconnects with its last event id, and one hydrated mid-run, both end equal to the live one, with one terminal each;
  - across a respawn, a repeated run id is `duplicate` and a retry's echo is not doubled;
  - text, multi-line and attachment-only messages keep their ids (spec 02 §14.2);
  - a SIGKILL mid-run ends in main's `RUN_ERROR {agent_crashed}`.
- **Updated**: `thread-store.test.ts` (C-T7 hydrates through the real relay), `lib-imports.types.test.ts` (the agent's wire types), `layout.test.ts` (the `agui` group). The existing session, messaging, artifacts, routine, turn-waiter and auto-allow suites are unchanged and pass.

**Not done, and why.**

- The atomic agent commands `queue.update` / `queue.remove` (spec 02 §14.6) are an agent-slice change. Main's check narrows the index race but does not close it.
- A running `ndjson` agent is not switched to `agui` automatically when the new renderer claims its thread: that would kill a turn the old renderer may be showing. The caller gets `UNAVAILABLE`.
- The spawned test covers fd-mode compat. Inline mode (fd 3 unusable) reaches the relay through the same `handleAguiStdout`, and is covered by `cli-manager-wire.test.ts` with a stand-in process, not with a `ChatClient`.
- `tool.output` coalescing past 200,000 events in one run is implemented but not tested; the processor would need that many events.
- Transport A.3's `liveState` / `hydrate.ts` composition is superseded, as described above. `PLAN.md` needs no further amendment for this slice.
