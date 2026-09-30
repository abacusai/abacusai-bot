# Review: implementation of spec 00-agent-agui r3 (Claude, round 1)

Scope: `git diff b7982412..e8f898e7 -- packages/agent apps/desktop`. I checked it against `docs/rewrite/specs/00-agent-agui.md` r3, including §9, and against the codex r1 and r2 reviews. TanStack semantics were verified in `node_modules/@tanstack/ai@0.63.0` (`activities/chat/stream/processor.ts`) and `@tanstack/ai-client@0.36.0` (`chat-client.ts`, `connection-adapters.ts`). `@ag-ui/core@1.0.0` was checked from its `dist` types.

`npx vitest run src/agui src/tool-display.test.ts`: 10 files, 87 tests, all green.

A throwaway probe using a fake session with a throwing `setModel` reproduced finding 1.

## Findings

1. **High: a throwing `setModel` during `run` preparation wedges the host.** `packages/agent/src/agui/host.ts:347-364`.
   - **Issue.** `await this.core.session.setModel(...)` has no `try`/`finally`. `BotSession.setModel` does not catch pi's `session.setModel` throw (`bot/bot-session.ts:984`), for example a missing key.
   - **What happens.** When it throws:
     - `onRun` rejects;
     - `readCommands` tags the error `turn`;
     - the emitter records it as the open run's failure, but nothing ever settles that run;
     - `busy` and `preparing` stay `true` forever.
   - **Probe result.** The run got no terminal. A later legacy `send` and a second `run` were both queued with `waitingFor:"turn"` and never drained. No `status_changed idle` was sent, and no prompt reached pi.
   - **Compat divergence.** Compat also drifts from the legacy equivalent, where `set_model` fails and `send` still runs.
   - **Fix.** Wrap preparation in `try`/`catch`. On a throw:
     - if still admitted, record a `command`-origin `agent.error` and continue to prompt, which matches legacy `set_model` + `send`;
     - otherwise release `busy`/`preparing` only when `gen === admissionGen`, and settle the token.
   - **Test.** Add one with a fake session whose `setModel` rejects.

2. **High (spec and implementation): input queued while a Stop is landing never appears on AG-UI.** `agui/queue.ts:541`, `agui/queue.ts:563-570`, `agui/host.ts:433-439`.
   - **Issue.** `admitNow` adds every entry admitted while `stopping` to `echoed`. When `runAfterStop` then opens a server run with `echoed=true`, it emits neither `queue.dequeued` nor the user `TEXT_MESSAGE_*`.
   - **Why it breaks now.** The echoed rule exists because the old renderer drew the bubble itself. On an agui runtime nothing has drawn it:
     - a `run` raced into `stopping` is acked `queued`;
     - main injects `RUN_ERROR{queued}`;
     - the renderer removes its optimistic bubble.
   - **Scope.** The same happens for `ai.queue.enqueue` and gateway `send` during a stop.
   - **Result.** The user's text vanishes from the transcript, main's processor, and `hydrate`. The checked-in golden encodes the bug: in `__fixtures__/stop-then-message.agui.jsonl`, run `srv-<3>` has no user message for "again".
   - **Fix.** Keep `echoed` for the compat line only (`user_message_dequeued`). On AG-UI, always emit the user message for the run's input. Amend spec §3.1.3.

3. **Medium: `steer-N` ids collide across incarnations.** `agui/ids.ts:15`, `agui/emit.ts:523`.
   - **Issue.** `steerCount` restarts at 0 in every process. Main keeps one `StreamProcessor` transcript per thread across respawns (§5.3). A new process's `steer-1` therefore hits `handleTextMessageStartEvent` Case 2 (dedup by id), and `updateTextPart` rewrites the **old** `steer-1` message's text. No new bubble appears.
   - **Same flaw elsewhere.** The fallback assistant id `${sid}:msg-x${n}` (`emit.ts:729`) and `aguiMessageId`'s `${sid}:${msg-N}` fallback (`session.ts:3334`, `bot-session.ts:1708`) collide when a pi session is resumed.
   - **Fix.** Scope the ids by run or incarnation, for example `${runId}:steer:${n}`, or `steer-${incarnation}-${n}`.

4. **Medium: `whenBusy:"error"` does not exist in ai-client 0.36.** `agui/agui-host.integration.test.ts:429,481,486`; spec §3.1.6 and §8.1.
   - **Issue.** `WhenBusy = 'queue' | 'drop' | 'interrupt'` (`types.ts:430`). `drop` returns silently (`chat-client.ts:2278`). `maxSize:0` / `onOverflow:'reject'` is also silent (`:2387`).
   - **Why it matters.** An accidental busy `sendMessage` loses the user's text without a trace, the opposite of "fail loudly".
   - **Fix.** Configure `queue` as a strategy function that throws (`decideWhenBusy` calls it synchronously, `:2365`), so `sendMessage` rejects. Amend the spec wording.

5. **Medium: the client run's `RUN_STARTED` echoes the entire `RunAgentInput`.** `agui/host.ts:324`, `agui/runs.ts:148`.
   - **Issue.** ChatClient sends the whole history, including attachments, on every turn. Echoing it:
     - puts O(transcript) bytes on stdout per run;
     - pushes the same bytes into main's active-run log and ring;
     - can exceed main's 16 MB line cap (`cli-manager-service.ts:181`, `trimBuffer`). The `RUN_STARTED` is then dropped as undecodable and the renderer's run never starts.
   - **Fix.** Omit `input`, or send only `{threadId, runId, forwardedProps}`. The newest user message already goes out as `TEXT_MESSAGE_*`.

6. **Medium: last words can be lost or reordered at exit.**
   - **Where.**
     - `agui/host.ts:200-210`: `compatLost` writes `wire.compat_lost` and `RUN_ERROR` with async `process.stdout.write`, then calls `process.exit(75)` synchronously.
     - `main.ts:49-51` and `host.ts:181-194`: `emergencyClose` uses `writeSync(1)`.
   - **Why.** On macOS, pipe stdout is asynchronous. Under backpressure the two compat-loss lines are lost. The `writeSync` RUN_ERROR can also land ahead of still-buffered content lines, which are then dropped at exit.
   - **Fix.**
     - For compat loss: `process.stdout.write(last, () => exit(75))`, with a short fallback timer.
     - For `exit`: use `writeSync` only when `process.stdout.writableLength === 0`; otherwise accept that main synthesizes the terminal.
   - **Test gap.** The loss test uses an injected `exit` and in-memory stdout, so it cannot see this.

7. **Medium: a superseded send clears the current token of a newer send.** `agui/queue.ts:503-511`.
   - **Issue.** `sendOwned`'s `finally` always calls `hooks.sending(undefined)`. After a Stop, `runAfterStop` can start a new send before the aborted send's promise resolves. The old `finally` then nulls `current`, and permissions in the new run get `turnSeq: 0` (`emit.ts` `permissionNeeded`). That weakens the §3.5.3 turn check that r2-13 relies on.
   - **Fix.** Clear only when the current token is this one: `if (runs.currentToken()?.seq === token?.seq) setCurrent(null)`.

8. **Medium: a turn-origin error from a thrown handler can fail an unrelated run.** `agui/queue.ts:184-194`, `agui/emit.ts` (the `error` case).
   - **Issue.** A throwing `run`/`send` handler is tagged `turn` with no owner. The emitter records it as the failure of **whatever** run is open. `sendOwned`'s `finally` has already settled the command's own run, as success.
   - **Result.** The command's run reads success, and a newer run (drain or after-stop) is marked `RUN_ERROR`. Spec §2.1 requires `RUN_ERROR` only "if the command's own run is still open".
   - **Fix.** Carry the token or runId in the tag and record the failure only on a match. Otherwise emit `agent.error`.

9. **Low-Medium: `permission.resolved` is written after `await releaseParked()`.** `agui/host.ts:409-418`.
   - **Issue.** The waiter is already released, so the approved tool's `TOOL_CALL_*`, or a sibling's new `permission.requested` with its `permission.pending`, can go out while the resolved item is still in the authoritative set.
   - **Result.** The UI briefly shows a stale card, and `pending` snapshots are wrong. The legacy path (`queue.ts:254-260`) emits before `releaseParked`.
   - **Fix.** Emit `resolved` + `pending` synchronously right after `respondPermission`.

10. **Low-Medium: on a mid-run reset, `session.ready`/`STATE_SNAPSHOT` precede the run's cancelled terminal.** `session.ts:2394-2397`, `agui/sink.ts:50-52`.
    - **Issue.** `resetConversation` emits `ready` before `segments_cleared`, and the sink settles on `segments_cleared`. Spec §3.8 orders the cancelled terminal first. In between, the old run's unwinding events can also pick up the new `agentSessionId`.
    - **Test gap.** The golden only resets while idle.
    - **Fix.** Settle on `beforeAbort("reset")` completion, before the session emits `ready`. For example, settle in the sink when `ready` arrives while `runs.isOpen()` and the run is cancelling. Add a mid-run reset scenario.

11. **Low-Medium: user text is extracted only from AG-UI-shaped messages.** `agui/host.ts:62-99`.
    - **Issue.** Only `content: string` or `content[].{type:"text", text}` is read. `SubscribeConnectionAdapter.send` receives `UIMessage[] | ModelMessage[]` (`connection-adapters.ts:1032`). A UIMessage has `parts[].content` and no `content`, so passing it through unconverted yields `rejected{empty}`. Image-only messages are rejected as empty.
    - **Test gap.** The test adapter pre-converts to a string, so nothing covers this.
    - **Fix.** Either accept `parts[].content` as well, or pin main's conversion in the main-slice spec and test it.

12. **Low: `run.input.threadId` and `forwardedProps.conversationId` are not validated against `--thread-id`.** `agui/host.ts:253-301`. A misrouted `run` is accepted. Reject it with `run.ack{rejected}`.

13. **Low: run-id dedupe is per incarnation.** `agui/host.ts:268`, `runs.ts:77`. A client that retries its `runId` against a respawned process gets a second `RUN_STARTED` with the same id in main's log and transcript. Main's `ai.send` must dedupe across incarnations. Say so in the main slice.

14. **Low: SIGTERM, the desktop's stop mechanism, gets no last words.** `background-processes.ts:264-275`. It re-raises the default action, so `process.on("exit")` never runs and no `RUN_ERROR` is written. Spec §3.8 only mentions main synthesizing for SIGKILL; extend that to any signal exit.

15. **Low: the preflight accepts any writable fd 3.** `agui/channel.ts:88-104`. If main did not pass fd 3, Node or libuv may have opened fd 3 for its own use, and a successful `writeSync` would write compat into it. Also require `fstatSync(fd).isFIFO() || isSocket()`.

16. **Low: a component's unfinished `subtask_end` maps to the wrong code.** `session.ts:1993-1998` → `emit.ts:1098`. `subtask_end failed` from `finishTurn` maps to `SUBAGENT_ERROR{code:"failed"}`. Spec §3.3.2 says `code:"unfinished"`. Tag it internally, or map by call site.

17. **Low: the housekeeping usage log omits `customType`.** `emit.ts:490`. Spec §4 says `[usage] housekeeping <customType> <json>`.

18. **Test: "expires one permission while the other stays answerable" has only one permission.** `agui/agui-host.integration.test.ts:375-393`. Independence under expiry, the §7.5 promise, is unproven. Use two sibling calls; pi gates them one after another, so use a sandbox ask or delegate children instead. Answer the survivor after the other expires.

19. **Test: AG-UI → legacy compat equivalence is golden-checked only for `run`, in one scenario.** `__tests__/scenarios.ts:66`.
    - **Issue.** Every other scenario replays legacy commands under agui. The permission scenarios use `permission_response`, not `permission.respond`; stop scenarios use `stop`, not `cancel`.
    - **Existing coverage.** The `respond` integration test only checks `toContain('"type":"queue_updated"')`.
    - **Fix.** Add `aguiSteps` for `permission.respond` and `cancel`, compared byte for byte with the `.ndjson` baseline.

20. **Test: many paths the diff touches have no golden or spawned coverage.**
    - **Paths with no golden:**
      - delegate and browser `scopeEmit` wrappers;
      - `BotSession` (`hidden_turn`, sanitised text);
      - error-origin tagging at the rotation, compaction and stall sites;
      - `forwardedProps` preparation;
      - parallel permissions;
      - `sandbox_denied` / `network_host` attach;
      - `ppt`/`document` components.
    - **Parity is currently by construction.** The WeakMap side-table and identity-preserving `scopeEmit` add no bytes, and all 14 ndjson baselines were recorded at `d9cf445e` with no `src` change, so they are genuine.
    - **Fix.** Add at least delegate, bot and rotation `.ndjson` baselines before cut-over.
    - **Property coverage.** The property test drives only sink, emitter and runs, never `HostCore` admission (§7.4.3).

21. **Nit: an unchecked cast defeats the "no casts" goal.** `agui/event.ts:33` uses `as unknown as` in `aguiEvent`. `runs.ts:148` uses `as never`. The payload is typed, but the returned type is not checked. Prefer a typed overload map, or at least a `satisfies` on the payload.

## Judging the reported deviations

- **WeakMap side-table for internal fields.** Acceptable. Tagging preserves identity, all emit paths pass the same object (`roster.ts:248`, `bot-session.ts:403`, `session.ts:1043`), and `JSON.stringify` cannot see it.
- **Client runs echo the user message.** Acceptable for the sender: processor Case 2 dedups by id, and `updateTextPart` replaces the text rather than appending. Main needs it for its transcript. It must, however, not carry the full `input` (finding 5).
- **Orphan child events dropped.** Acceptable. `routeToChild` would drop them anyway. They only occur after the child's or the run's terminal.
- **Goldens produced live, not via `ABACUSAI_BOT_WIRE_RECORD`.** Acceptable. The ndjson baselines are genuinely pre-change (`d9cf445e`). The shared mask replaces only literal session ids and files from `ready`, the root, the port, and the 13-digit time inside subtask ids, so it cannot hide structural drift. Stop scenarios carry a small timing risk, because their `aguiUntil` wait is a no-op under ndjson.
- **`whenBusy:"error"` absent.** Real (finding 4). `drop` is not an acceptable substitute in the product.
- **`AguiHost` not exported.** Acceptable given the dts constraint. `main.js` is the only entry. Amend spec §6.3.
- **Main hooks unwired.** Acceptable for this slice, since nothing selects agui. The spawn, hello router, fd-3 reader and auto-allow runtime binding (`sendCommandToRuntime`) are present.
- **Uncovered scenarios.** See findings 18 to 20. Parallel permissions and the sandbox and network attach are the riskiest untested paths.

## Confirmed correct

- **`--wire ndjson` parity.**
  - `HostCore` is a faithful extraction of the old host. It keeps the same emit order, the same `admit` steer timing (steer invoked synchronously after `emitQueue`), the same `stop` and `reset` order, and the same `dequeue`-while-busy no-op.
  - `NdjsonHost` writes through `process.stdout.write` looked up per call.
  - The harness drives the real `NdjsonHost.run()` through patched process stdio.
- **Compat and stdout writers.**
  - Compat bytes come from one `HostSink.emit` → `JSON.stringify(event)+"\n"`, with nothing stripped because nothing internal is on the object. Internal events never reach compat.
  - No stray stdout writers exist in the agent.
  - `run`, `permission.respond` and `cancel` produce the same compat sequence as `send`, `permission_response` and `stop`. Rejected, duplicate and stale commands write no compat bytes (tested).
- **Handshake.**
  - The synchronous preflight writes `wire.hello` as stdout line 1 before the session exists, and retries `EAGAIN`.
  - The fd socket does not keep the loop alive (the spawn test exits 0).
  - Main discards `compat.hello`, and routes RS-prefixed compat lines inline.
- **Admission.**
  - The acquisition is synchronous for every starter (`busy` is checked before any await, and `preparing` → `waitingFor:"turn"`).
  - The `gen`/`turn`/cancelling/open-run checks after preparation work: Stop and reset during `setModel` never prompt (tested).
  - A stale `cancel{runId}` is ignored.
- **Runs.**
  - Only `RunController.open` writes `RUN_STARTED`, and it throws if a run is open.
  - Settle is owner-checked by `seq`.
  - The §3.1.5 closing order is right: child message, then child unfinished results, then `SUBAGENT_ERROR`, then parent results, then the terminal.
  - `finishReason` is never `tool_calls` (`toolUse` → `stop`), and the TanStack `isIntermediateToolTurn` check was verified.
  - Usage accounting matches `@ag-ui/core` (`inputTokens` includes the cache; a null `model` is omitted).
- **Permissions.**
  - Descriptors carry the full lineage.
  - Validation order is incarnation, then thread, then pending, then turn, then decision.
  - Validation is strict and structural, with no coercion (`true`/`{approved}` → `invalid_decision`).
  - The allowed-decision tables match §3.5.2.
  - The session's `hasPendingPermission` double-check prevents reporting success without a released waiter.
  - Stop and reset clear with `stopped`/`reset`.
  - A tool blocked by expiry or stop gets `denied`/`cancelled`, and TanStack's processor reads `metadata.tanstack.state`/`toolResultOutcome` (verified, `processor.ts:2065-2072`).
  - Auto-allow is bound to the emitting runtime in main.
- **Sub-agents.**
  - Every child event carries `subagentRunId`, and child tool ids are `${subagentRunId}:${legacyId}`.
  - The delegate's `SUBAGENT_FINISHED` precedes the parent's `TOOL_CALL_RESULT`.
  - `routeToChild` semantics were verified.
- **Hidden turns.** Only `permission.*`, session-scope `STATE_*` and `queue`/`skills`/`mcp` pass. `settled()` fires before `runMemoryMaintenance`.
- **Streamed tool calls.** They follow pi's `{contentIndex, partial}` shapes, with deferred-id buffering.
- **The `tool-display` entry.** It has a tsdown entry and a package export, and no node or pi imports.
