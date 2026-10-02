# Review: main-process AG-UI relay (Claude r1)

Scope: `git diff 81066a43..HEAD` over `main/services/agui/*`, `session/cli-manager-service.ts`, `service-host.ts` (relay wiring), `rpc/ai/source.ts`, `rpc/procedures/ai.ts`, `shared/contract/{ai,ai-thread,legacy-map}.ts`, `vite.config.ts`, `main/index.ts`, plus the outside-ownership edits (`packaged-startup.test.ts`, `services/layout.test.ts`) and `thread-store.ts`'s `writeAgui`. I checked the code against 00-agent-agui (incl. "Implementation notes (main relay)"), 00-transport A.3/A.4, 02-chat-kit §3/§14 and the PLAN amendments. I checked StreamProcessor / ChatClient behaviour against the installed `@tanstack/ai` 0.63.0 / `@tanstack/ai-client` 0.36.0 sources. For findings 1 and 2, I also ran the real `StreamProcessor` in a throwaway vitest file, which I deleted afterwards.

Numbering is by severity.

---

## Findings

### 1. High: a run that fails before any assistant output corrupts the next run's user message (the persisted transcript too)

`thread-relay.ts:524-533` (`#apply` → `processor.processChunk`), `:593-605` (persist). Root cause: `@tanstack/ai` `processor.ts:2260-2270` (`handleRunErrorEvent` → `ensureAssistantMessage()`), `:914-927` and `:1233-1270`.

When `RUN_ERROR` arrives and the processor has no assistant message state, `ensureAssistantMessage()` does two things:

- it auto-creates an empty assistant message (`parts: []`, random `msg-…` id);
- it sets `pendingManualMessageId`.

Only `resetStreamState()` (via `prepareAssistantMessage()`) or `clearMessages()` clears that pending id. A receive-only processor never calls either between runs, and that covers main's processor and the kit's `ChatClient`. So the next `TEXT_MESSAGE_START` takes "Case 1" and renames the empty assistant message to the incoming id. The next `TEXT_MESSAGE_START` is the next run's **user echo**, so the user's prompt becomes an `assistant`-role message.

Reproduced with the installed processor:

```
after error: [{u1,user,"hello"}, {msg-…,assistant,[]}]
after r2:    [{u1,user,"hello"}, {u2,ASSISTANT,"second"}, {a2,assistant,"reply"}]
```

**When it triggers:** a freshly loaded relay (history from file, so no `messageStates`) whose run ends in `RUN_ERROR` with only the user echo streamed. That covers provider/auth errors before the first token, a crash, and main's own `agent_exit` / `inactivity_timeout` terminal (the relay unit test's `run-2` hits exactly this path but asserts only outcomes).

**Effects:**

- The corruption is persisted by `writeAgui` and served by every later `hydrate`.
- `RunOutcomeRecord.afterMessageId` points at the random empty message.
- Live `ChatClient`s run the same state machine, so they corrupt the same way. Main and clients stay "consistent", but both are wrong.

**Fix:** decide jointly with the kit, because main and client must stay identical. The simplest option that keeps them identical is to never let `RUN_ERROR` be the first assistant-side event of a run:

- main's synthesized terminal emits `TEXT_MESSAGE_START/END {role: assistant}` for a fresh id before `RUN_ERROR`, when the run has no assistant message;
- the agent's `RunController.close()` / `emergencyClose` do the same.

Otherwise, add the equivalent of `prepareAssistantMessage()` at `RUN_STARTED` on both sides. The kit cannot reach `ChatClient`'s processor, so that option needs a kit-side design.

Add a regression test: a hydrated relay plus a `ChatClient`, run 1 errors after the echo only, run 2 succeeds, and both transcripts are asserted.

### 2. High: main's synthesized terminal leaves open parts streaming in the persisted transcript

`thread-relay.ts:486-501` (`#synthesizeTerminal`). The agent closes open parts before its terminal (`packages/agent/src/agui/runs.ts` `close()` → `closeOpenParts`). Main's synthesized `RUN_ERROR` does not, and `handleRunErrorEvent` does not finalize the stream: no `completeAllToolCalls`, no `finalizeStream`.

Reproduced: `TOOL_CALL_START` + partial `TOOL_CALL_ARGS`, then a synthesized `RUN_ERROR`, persists `{type: "tool-call", state: "input-streaming", arguments: "{\"cmd\":"}`. Every SIGKILL, crash or watchdog timeout mid-tool therefore leaves a hydrated tool row that spins forever. Text and reasoning segments are also never ended.

**Fix:** before the synthesized `RUN_ERROR`, emit the closing events for the run's open parts. They can be derived from the active log: `TOOL_CALL_END` for started-but-unended calls, then `TEXT_MESSAGE_END` and `REASONING_END`, mirroring `closeOpenParts`. Add the case to the SIGKILL e2e test by killing inside a tool call and asserting the hydrated tool part's state.

### 3. High: in the new-renderer build, anything spawned before the renderer's first `ai.*` call is `ndjson`, and the new UI cannot drive or even stop it

`relay-service.ts:206-210` (`wireFor`), `:652-668`, `:686-695`.

A claim exists only after an `ai.*` call and lives in memory, so every main restart forgets it. Several spawns can happen before the new renderer touches a thread: a routine, the messaging gateway, a bot reply, a legacy-bridged `agent.start`, or a session restored at launch. Each of those spawns `--wire ndjson`. Then, until that process exits:

- `ai.send`, `ai.cancel`, `ai.respondPermission` and `ai.queue.*` answer `UNAVAILABLE` (Stop does nothing);
- `hydrate` shows no `activeRun`;
- `subscribe` is silent while the agent visibly works;
- a permission it raises cannot be answered from the new UI.

The claim mechanism only exists for the new renderer. The legacy build never calls `ai.*` (verified: no callers under `src/renderer`), so claims never happen there and the mechanism only hurts.

**Fix:** `wireFor` returns `agui` whenever `RENDERER_GENERATION === "wco"`, and keeps `ndjson` for the legacy build. Optionally, `#ensureAguiRuntime` also recycles an idle `ndjson` runtime (no turn in flight) instead of answering `UNAVAILABLE`.

### 4. High: the queue index-shift race can silently edit or remove the wrong entry

Known and admitted. `relay-service.ts:480-489`, `:707-725`.

Main checks `entryId` against its last `queue.updated`, then sends a bare index. A drain in between (the agent dequeues at run end, or `dequeue` from another window) shifts the index. The legacy `update_queue_item` / `remove_from_queue` then hits a different entry: data loss with no signal.

**Fix:** treat the agent's atomic `queue.update` / `queue.remove` (spec 02 §14.6) as a blocker for shipping queue edit/remove in the kit, and track it in PROGRESS. Until then, the kit should not expose edit/remove, or main should refuse them (`queue.command_rejected`) while a run is open, which is when drains happen.

### 5. Medium-High: a conversion throw in `ai.send` strands the admission, and the kit's re-send then hangs forever

`relay-service.ts:403-409`. The order is:

1. the waiter is registered;
2. `markSent` runs;
3. `#runCommand(input)`, which calls `uiMessagesToWire`, is evaluated inside the `host.send(...)` argument.

If the conversion throws, the error propagates:

- The waiter stays in `#waiting` with no timer (the timeout is armed only after the write), so it can never settle. The loose schema admits parts `uiMessagesToWire` does not expect, so a throw is reachable.
- The error reaches the kit as `INTERNAL`, which is **uncertain**, so the kit re-sends the same run id.
- `#repeatOf` finds the in-flight waiter and awaits it forever.
- The thread also becomes un-evictable (`waiting.size > 0`), and `markSent` is never undone.

The `host.send(...) === false` path has the same problem: it deletes the waiter but leaves `markSent`'s pending turn and watchdog armed.

**Fix:**

- Build the command first, and map a conversion error to `BAD_REQUEST` (definitive, raised before anything is written).
- Register the waiter and call `markSent` only immediately before the write.
- On `send === false`, also call `markStopped`.

### 6. Medium: a stale runtime's exit rejects admissions that belong to its replacement

`relay-service.ts:255-262`. `ThreadRelay.runtimeExited` ignores an exit from a runtime that is no longer the thread's (`thread-relay.ts:291`), but the service-level loop rejects every waiter of the thread unconditionally.

This is reachable when an old child is still dying (startup-timeout `killWithEscalation`, or a runtime replaced after an `error` state) while the new one is already running and has an admission awaiting its ack:

- that admission gets a spurious `TIMEOUT`;
- `#waiting` is cleared, so the kit's re-send writes `run` a second time to the live process. The agent's in-incarnation dedupe saves it, but the duplicate is avoidable.

**Fix:** reject waiters only when `exit.origin.runtime` is the thread's current runtime (check before `thread.runtimeExited` nulls it), or tag each waiter with the runtime it was written to.

### 7. Medium: a main-side reset is invisible on the stream

`relay-service.ts:273-276` → `thread-relay.ts:342-350`; `service-host.ts:2805`.

`clearThread` (from `resetAgentConversation`) empties the relay's history and finished logs, but emits nothing. As a result:

- open windows keep the old transcript;
- the kit's `rev` never bumps (§3.1: `rev` is bumped by `session.cleared`);
- the ring still replays pre-clear events on a resume.

With the agent running, its own `session.cleared` eventually fixes this. With no agui runtime, nothing ever does.

**Fix:** have `clearThread` `#apply` a main-synthesized `CUSTOM session.cleared`. Make the file removal in `#applySessionState` idempotent, since the file is already gone.

### 8. Medium: `writeAgui` defeats the dual-write guard, and a v1 dual-write can overwrite the relay's `agui` file

`thread-store.ts:151-158` (`writeFromV1`: `if (!this.isOwnWrite(...)) { …skip over agui… }`) together with `write()` recording `written` for `"agui"` writes (`:215-233`).

After the relay writes an `agui` file, `isOwnWrite` returns true, so the next `writeFromV1` skips the `source.kind === "agui"` check and replaces the file with a v1-derived one. That breaks the migration step 1 rule that the dual-write and repair "never overwrite" an agui file. It is reachable in the legacy build with the env flag (item 9) and through anything else that calls `writeTranscript`.

**Fix:** record the write kind in `written`, and never bypass the check when the own write was `"agui"`.

### 9. Medium: `ABACUSAI_BOT_AGENT_WIRE=agui` turns the shipped legacy app's chat dark

`relay-service.ts:193-195`; `service-host.ts:1264` (`toOldRenderer = origin?.wire !== "agui"`).

The flag is read from `process.env` in production builds. With it set in a legacy build:

- every spawn is `agui`;
- the old renderer's `local-cli-ndjson` stream is suppressed;
- the only consumer that could show the turn is a renderer that does not exist in that build.

**Fix:** honour the flag only when `!app.isPackaged` or `RENDERER_GENERATION === "wco"`, and log once when it is ignored.

### 10. Medium: echo dedupe versus the kit's outbox on `session.retry()`

`thread-relay.ts:464-484`. `session.retry()` re-sends the last user message's id with a new run id, and main correctly drops the echo so the text is not doubled. But spec 02 §3.7 removes an outbox entry only "when the agent's echo of that message is processed". For a retry, that echo never reaches the client, so:

- the entry stays;
- `isLoading` (`outbox.length > 0`) stays true, and so does busy (§4.4 `outbox.length > 0`).

This is cross-slice. **Fix:** the kit treats an id already present in the client's transcript as echoed (amend §3.7), or main emits a marker (for example `CUSTOM abacus.echo_suppressed {messageId}`) in place of the dropped echo.

### 11. Medium: run-log memory and coalescing cost

`thread-relay.ts:56-60`, `:541-575`, `:582-584`.

- `#finished` keeps the last 4 **complete** run logs per loaded thread. Each can be up to 200k events plus coalesced output, often multi-KB `tool.output` values. That is multiplied by 16 idle threads plus every thread with listeners or a run, and held until eviction. A few long agentic runs can pin hundreds of MB.
- Past the cap, each `tool.output` does a linear `findIndex` over 200k entries, which is quadratic in the tail. It also removes the *oldest* entry for the call, not all but the latest, so the log keeps its pre-cap per-call count rather than coalescing.

**Fix:**

- Bound finished logs by bytes or by time (a late `joinRun` only needs a short grace; after it, `hydrate` has the transcript).
- Keep a `Map<callKey, index>` for coalescing.
- Make coalescing actually replace in place.

### 12. Low-Medium: any thread id is claimed and loaded, and a deleted thread hydrates as empty

`relay-service.ts:294-300`, `:338-342`, `:376-381`.

- `subscribe`, `hydrate` and `joinRun` claim and construct a relay for any `SessionId` without `workspaceOf`. Construction runs `readCurrentFile`, which may write a repair.
- `#claimed` only shrinks on `forgetThread`.
- `hydrate` of a deleted session returns an empty thread. The kit's recovery table (§3.3) expects `NOT_FOUND` for a vanished row.

**Fix:** answer `NOT_FOUND` from `hydrate` and `subscribe` for an unknown session, and claim only after that check.

### 13. Low: `restoreInboundChunk` parity is an unasserted invariant

`thread-relay.ts:525`. `ChatClient.processIncomingChunk` runs `restoreInboundChunk` before `processChunk` (`chat-client.ts:2089`); main feeds raw chunks. Today the processor's own fallbacks (`toolCallName`, `metadata.tanstack.input`, `finishReason`) keep the transcripts equal, but nothing guarantees they stay equal.

Two related details:

- `restoreInboundChunk` mutates in place, and ring/log entries are shared objects, so do not add it naively.
- `terminalRunId` (`thread-relay.ts:90-97`) ignores a top-level `runId` on `RUN_ERROR`, unlike TanStack's `getChunkRunId`.

**Fix:** apply `restoreInboundChunk` to a clone before `processChunk`, or add a goldens-wide test that asserts main's persisted transcript equals a `ChatClient` fed the same stream. Align `terminalRunId` with `getChunkRunId`.

### 14. Low: the epoch is not part of the resume point

`procedures/ai.ts:14-18`, `thread-relay.ts:399-416`. `lastEventId` is a bare seq and `SeqClock` restarts at 0 each main process. A seq from another process that is ≤ head and ≥ the thread's floor would replay the wrong events. The `floor = clock.current` at relay creation mitigates most of this, and renderers do not outlive main today, but the WebSocket transport (A.8) and swap paths make the assumption fragile.

**Fix:** use `${epoch}:${seq}` event ids, or resync when the epoch differs.

### 15. Low: AG-UI stdout edge cases in `handleAguiStdout`

`cli-manager-service.ts:1018-1022`.

- A final line without a trailing newline is never drained at `close`.
- An over-cap line is head-truncated with no log, unlike the ndjson path at `:998-1005`.

**Fix:** flush `stdoutBuffer` on `close` for agui runtimes, and log truncation.

### 16. Low: the packaging checks prove less than they appear to

`vite.config.ts:111-126`; `packaged-startup.test.ts:41-42`, `:117-124`.

- The `include` list is not transitively closed. `@tanstack/ai-event-client` imports `@tanstack/devtools-event-client` at the top level, and it is not listed. It is dropped only because of `sideEffects: false` tree-shaking.
- `buildIfNeeded` reuses any existing `dist`. The checked-out `dist/main/index.js` here contains no `StreamProcessor`, so it predates the relay, and a local pass proves nothing. The scanner's comment-skip heuristic (lines starting with `*` or `//`) is fine.
- Transport A.3.1 said `@tanstack/ai` moves to `dependencies` once used at runtime. Inlining is a reasonable alternative, but record the deviation.

**Fix:** list `@tanstack/devtools-event-client` or assert it is absent from the bundle, rebuild when `dist` is older than the sources (or always in CI), and note the A.3.1 deviation.

### 17. Low: JSON-patch prototype keys

`json-patch.ts:43-69`. The tokens `__proto__`, `constructor` and `prototype` are not refused, so `add /__proto__/x` from agent stdout pollutes `Object.prototype` in main. The paths are agent-generated, so the risk is low. **Fix:** refuse those tokens.

### 18. Low: bookkeeping that only grows

- `#runThreads` is pruned only on eviction (`relay-service.ts:184`, `:553-557`).
- `#acks` keeps up to 2,000 entries for every thread ever sent to, forever.
- `#skippedUserIds` leaks an id when a run is closed between the echo's START and END (`thread-relay.ts:170`).
- `#settleAck` answers an agent `duplicate` with no record as `started`, even if the original was `queued`.

**Fix:** prune `#runThreads` with `#finished` and `#runs`; cap `#acks` globally; clear `#skippedUserIds` at run end.

### 19. Low: paging with an unknown `before` cursor

`procedures/ai.ts:44-47`. An unknown `before` (for example after a clear) serves the newest page as if it were an older one, with a `truncated`/`cursor` that restarts the chain. **Fix:** return an empty page with `truncated: false` for an unknown cursor.

### 20. Low (verify): two concurrent first `ai.send`s can both start the agent

Two concurrent first `ai.send`s on a cold thread (different run ids) can each call `host.start`. `AgentManagerService.startSession` checks for an existing runtime only after awaits (`resolveAdditionalConfigEnv`), so the spawn race predates this slice, and `ai.send` makes it reachable from the renderer.

**Fix:** serialize `#ensureAguiRuntime` per thread (one in-flight start promise).

### Test gaps

The goldens drive `thread-relay.test.ts` well, and the e2e test is a real spawn into a real `ChatClient`. These cases are missing:

- error before output, then a second run (item 1);
- a kill inside a tool call, with the hydrated part state asserted (item 2);
- a stale exit during a live admission (item 6);
- a conversion throw, then a re-send (item 5);
- a main-side reset seen by a subscribed window (item 7);
- `writeFromV1` after `writeAgui` (item 8);
- the wco-build wire default (item 3).

---

## Confirmed correct

- **Compat bytes unchanged.** The cli-manager diff only adds `origin` to `emitAgui`, adds `emitAguiExit` and `getRuntimeInfo`. `handleNdjsonLine`, `handleCompatFd` and the inline prefix are untouched, so the taps read the same bytes. `emitNdjson` withholds agui compat only from the old renderer's stream.
- **Wire selection has one path.** Every spawn goes through `startSession` → `resolveWire` (no other `AgentManagerService`). The shipped legacy build never calls `ai.*`, so without the env flag it always spawns `ndjson`. A running `ndjson` agent keeps its wire: `#ensureAguiRuntime` refuses with `UNAVAILABLE` before writing, which is definitive for the kit.
- **Subscribe, joinRun and hydrate have no gap or double.**
  - `subscribe` and `joinRun` register the listener and compute the replay in one synchronous turn.
  - The abort listener releases streams that were never read.
  - Control yields carry no event id.
  - `checkpoint` is one turn: `cursor`, `activeRun.startSeq` (inclusive replay from `RUN_STARTED`), transcript without the active run, and session slices.
  - The finished-run logs cover a `joinRun` that arrives after the terminal.
- **The ring is sound.** The floor, the resync for evicted or future points, and the global seq clock (no cross-thread ambiguity) are correct.
- **First terminal wins.** The agent's own `emergencyClose` line is delivered before `close` (stdout drains first), so main's synthesis is a no-op then. A synthesized terminal drops that run's tail, including its late terminal (run-id check). A `wire.hello` or `RUN_STARTED` with an open run closes it. The runtime identity check in `ThreadRelay.runtimeExited` is correct. `requested` from `"stopping"` maps Stop session / quit to `agent_exit`, and signals and non-zero exits to `agent_crashed`.
- **`ai.send` is idempotent.**
  - A repeat during the first attempt awaits the same waiter.
  - The recorded first ack answers `duplicate` + `original`.
  - A `RUN_STARTED` seen without an ack answers `duplicate`/`started`.
  - `thread_mismatch` is not recorded.
  - A timeout rejects the admission itself, and a late ack is still recorded.
  - The re-check after `#ensureAguiRuntime` closes the same-run-id race.
- **Conversion keeps the client ids** through `uiMessagesToWire` (checked in `ag-ui-wire.ts`). `whenBusy` is dropped and `resume` is passed through.
- **Permissions are lossless.** `permission.*` events are session-scoped, so they are never dropped as stray run-scoped events. The snapshot keeps the live incarnation only. An exit clears the store with `permission.pending {items: []}`. Decisions are validated strictly, and the lineage's thread is checked.
- **`queue.command_rejected`** carries the emitting incarnation and is followed by the authoritative `queue.updated`.
- **Persistence is consistent with migration step 1.** `writeAgui` is atomic and synchronous, with `source.kind: "agui"`, `runs`, and `migratedFrom` carried from v1-derived history. `readCurrentFile` prefers an `agui` file, so it is continued. A run open across a clear persists nothing. `session.cleared` removes the file.
- **Outcome records** match spec 02 §14.7 (`steps` counts parent `TOOL_CALL_START`s, `usage[0]`, `error` merge), and paging keeps the outcomes of the returned window.
- **Outside-ownership edits.** The new `agui` group in `layout.test.ts`, the root-file additions, `index.ts` mounting `aguiRelay` and `threads`, `markTurnStopped` extracted from `stopAgentTurn` with the connector-gate release preserved, and the watchdog's terminal before `stopAgentTurn` are all sound.
