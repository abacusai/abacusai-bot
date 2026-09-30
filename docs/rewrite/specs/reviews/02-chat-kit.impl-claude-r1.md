# 02 — Chat kit, implementation review (Claude, r1)

Scope: `git diff 4c1591c0..8b1c9d16 -- apps/desktop/src/renderer-next` (excluding `components/ui`, `__fixtures__`, `goldens`), plus the locale additions under `src/renderer`. Checked against spec 02 r4 (the r1–r3 review tables and §14, including §14.12), foundation 01 r4, and bots 03 §24.2. TanStack claims were checked against the installed `@tanstack/ai-client` 0.36.0 and `@tanstack/ai` 0.63.0 sources, and the ai-react 0.29.3 clone (identical to the installed copy). Relay claims were checked against `src/shared/contract/ai*.ts`, `src/main/services/agui/relay-service.ts` and `src/main/rpc/procedures/ai.ts`. The tree under `renderer-next` is unchanged between 8b1c9d16 and HEAD, so line numbers hold for both.

Paths are relative to `apps/desktop/src/renderer-next/features/chat/` unless they start with `apps/` or `packages/`.

Test run: `npx vitest run --project renderer-next src/renderer-next/features/chat` passes 181 of 183 tests.
- `scroller/transcript.test.tsx:103` times out on every run, including when run alone (about 15 s against a 5 s limit).
- `gallery/a11y.test.tsx:33` [session-migrated] times out only in the full run, so it is flaky under load.

## Findings

### Runtime (session, admission, pump, dispatcher, store)

1. **Major: a recovery turns a live admission into `stale`, drops it and restores the draft.**
   - Where: `runtime/admission.ts:111-114, 124-127`; `composer/composer.tsx:347-348`; `runtime/session.ts:559`.
   - Issue: `stale()` compares `gen`, which `#start` bumps on every recovery (a resync, a join failure, the NOT_FOUND paging path), not only on a reset. So an `ai.send` that is in flight while any recovery starts behaves as follows:
     - An `started` ack returns `stale`. The entry is removed and the composer restores the draft, although the run is running. The user sees the text both in the transcript (via replay) and back in the composer, and is invited to send it twice.
     - An uncertain failure (`TIMEOUT` or a transport error, which is exactly what a reconnect produces) is classified `stale` before `isDefinitive`. Reconciliation is skipped and the draft is restored. This contradicts r3-5: "the draft is never restored while an entry might still be running".
   - Fix: the outbox lives in the host store across generations, so only `rev` (a reset) should make an admission stale. On a generation change alone:
     - ignore the stale check;
     - still apply `queued` / `rejected` / definitive outcomes;
     - keep `unconfirmed` entries reconciling;
     - never restore the draft on `started`, `duplicate` or `unconfirmed`.

     Add an R2-T35 case with a resync during the send.

2. **Major: the recovery back-off never engages, so repeated resyncs or join failures loop with a 0 ms delay.**
   - Where: `runtime/session.ts:683-689`; `runtime/pump.ts:113-116`; `apps/desktop/src/main/services/agui/relay-service.ts:686-690`.
   - Issue: `#recoveries` resets to 0 on any `onConnection("connected")`. The pump reports `connected` in two places:
     - on the first `joinRun` event;
     - on `abacus.subscribed`, which the relay always yields **before** `abacus.resync`.

     So each new generation resets the streak before it fails again, and `RECOVERY_DELAYS_MS[0] = 0` is used every time. The comment at `session.ts:685` ("one answered with resync again keeps counting") is false against the relay.
   - Fix: reset `#recoveries` only once the generation is reconstructed and live, meaning `appliedSeq ≥ checkpoint` **and** a subscription is open with no resync following. For example, reset in `#checkReady` after the swap, or in the pump on the first sequenced event after `subscribed`. Add a test where the relay answers resync three times and assert the delays.

3. **Major: one throwing event kills the generation silently, and the pump keeps filling an unconsumed queue.**
   - Where: `runtime/dispatcher.ts:49-58`; `runtime/session.ts:629-635, 668-670`.
   - Issue: an exception in `pre` (`applyEvent`), in `post` (`recordTerminal`), or in the client's `processIncomingChunk` does the following:
     - It propagates out of `stream()` and ends `consumeSubscription` (`chat-client.ts:1908-1922`, then `setConnectionStatus('error')`).
     - `onError` only logs.
     - The pump still reports `connected` and keeps calling `dispatcher.push`, so the queue grows without bound and nobody reads it.
     - Readiness falls back to the 5 s partial cap. After that, nothing streams again until the user navigates away.

     Plausible triggers: a malformed `permission.pending` item (`apply.ts:112` dereferences `item.metadata.abacus.lineage`), or an unexpected chunk shape in the processor.
   - Fix:
     - wrap `hooks.pre` and `hooks.post` in try/catch (log, continue);
     - have the client's `onError` for a subscription failure call `#recover()`;
     - close the dispatcher (and abort the pump) when the consumer exits.

4. **Major: `session.retry()` bypasses admission.**
   - Where: `runtime/session.ts:293-313`; caller `kit/status/status.tsx:239`.
   - Issue: §3.7 says a retry is "an `admit` with a **new** run id and the last user message's id and text". The implementation calls `ai.send` directly, with no outbox entry. As a result:
     - Busy (§4.4) and Stop (§4.5, "the newest outbox entry's runId") are empty until `RUN_STARTED`, so a second click on Retry or a composer submit can start another run.
     - A `TIMEOUT` or transport error is thrown instead of reconciled.
     - A definitive error rejects into `void session.retry()`, which is an unhandled rejection.
     - `abacus.duplicate_echo` (§14.12), which exists precisely for retries, has nothing to clear. It happens to be harmless only because there is no entry.
   - Fix: route retry through `admission.ts`, with an entry `{ id: last.id, runId: new, text }` rendered hidden (the message already exists), so busy, Stop, reconcile and the `duplicate_echo` clearing all apply. Catch the result in the ErrorCard.

5. **Major: processor retention (§10, `MAX_MESSAGES = 300`) never runs.**
   - Where: `runtime/session.ts:529-554`.
   - Issue: `retain()` has no caller anywhere. It also does not exclude the active run's messages (§10: "never the active run's"). If one of those becomes `olderCursor`, the next page is `NOT_FOUND` (`main/rpc/procedures/ai.ts:47-54`) and triggers a rebuild.
   - Fix: call `retain()` after `loadOlder` prepends while the viewer is at the end, and when the end snaps back. Keep messages from the active run's first message onward. Test it; R2-T31 gates it.

6. **Minor: "N steps" undercounts any run that was steered.**
   - Where: `store/apply.ts:418-434`.
   - Issue: `stepsOf` looks for `${runId}:user` or `metadata.abacus.runId`. Live echoes carry the client id (`u-…`) and steers `steer-…`, and the emitter sets no run metadata (`packages/agent/src/agui/emit.ts:863-868`). So the fallback "last user message" is the last steer, and tools before it are not counted.
   - Fix: record the message count (or the last message id) at `RUN_STARTED` in the pre-hook, and count assistant tool-call parts after that point.

7. **Minor: the permission 10 s timeout is not tied to the attempt.**
   - Where: `runtime/session.ts:360-388`.
   - Issue: after a `response_rejected`, a second answer within 10 s is flipped to "No response from the agent" by the first attempt's timer, because `noResponse` checks only `state === "sending"`. The queue path already compares `since` (`:440`).
   - Fix: capture `since` and compare it, as the queue command does.

8. **Minor: `cancelling` can stick or be cleared early.**
   - Where: `runtime/session.ts:323-338, 719, 758-785`.
   - Issue:
     - A terminal processed before the swap (replay during recovery) does not clear `cancelling`, and `#swap` doesn't reset it. Stop then shows a spinner until the 15 s timer.
     - That timer is not tied to the press, so an earlier press's timer can clear a later press's state.
   - Fix: clear `cancelling` on swap when `runs.active` is null. Tie the timer to a token.

9. **Minor: hydrate-side gaps in recovery and readiness.**
   - Where: `runtime/session.ts:595-606, 704-710, 787-799`.
   - Issue:
     - A hydrate failure during a recovery sets `connection = "error"` at once, with no back-off retry, unlike the subscribe path.
     - The 5 s readiness cap is armed only after hydrate returns, so a hung `ai.hydrate` hangs the route loader. §3.2 bounds only `joinRun` explicitly, but the intent ("never hangs navigation") covers it.
   - Fix: send hydrate failures on a ready session through `#recover()`. Arm the cap in `#start`.

10. **Minor: replayed messages are marked fresh after a partial swap.**
    - Where: `runtime/session.ts:632`.
    - Issue: after the 5 s partial swap, `live: gen.swapped` is true for the remaining replay, so replayed messages get `data-fresh` entry motion. The same holds for "live" announcements (see 21).
    - Fix: mark live only for `seq > checkpoint`.

11. **Minor: reconciliation re-sends can fire after `retire()`.**
    - Where: `runtime/admission.ts:152`; `runtime/session.ts:256-271`.
    - Issue: `retire()` clears the timers, but an in-flight `ai.send` that fails afterwards calls `schedule`, which arms a new timer and re-sends for a retired thread. `token()` has no retired flag.
    - Fix: make `schedule` and `admit` no-ops once retired.

12. **Minor: composer admission outcomes.**
    - Where: `composer/composer.tsx:338-361`.
    - Issue:
      - `restore` overwrites the draft with the snapshot, which clobbers anything typed since the send.
      - The `CONFLICT` path's `runtime.queue.enqueue` rejection is dropped, with no error and no draft back.
      - `NOT_FOUND` from `ai.send` shows a message but does not turn the composer read-only (§4.6; `notFound` is set only by the pump and hydrate).
    - Fix: restore only when the draft is still empty. Surface enqueue failure. Set the host's `notFound` on a send `NOT_FOUND {entity: thread|session}`.

13. **Minor: Stop hotkey (`Mod+.`).**
    - Where: `composer/composer.tsx:368-375`; `kit/layout.tsx:215-239`.
    - Issue: it is registered in `ThreadComposer` with raw `useHotkey` rather than one registration per mounted `ChatView` through the app's hotkey wrapper (§8.4, foundation §7.9). In sessions the permission tray replaces `ThreadComposer`, so while a permission is pending (a prime moment to stop) neither the hotkey nor a Stop button exists.
    - Fix: register the hotkey in `ChatView` or the layout. Keep a Stop control visible while the tray is up.

14. **Minor: unhandled rejection in the host's `stop`.**
    - Where: `runtime/host.ts:64`.
    - Issue: `stop: () => void session.cancel()` turns a failed cancel into an unhandled rejection.
    - Fix: add `.catch(log)`.

15. **Minor: the runtime does not validate decisions.**
    - Where: `runtime/session.ts:342-389`.
    - Issue: §6.3 step 1 says to validate the decision against `descriptor.metadata.abacus.allowed` in `runtime.respondPermission`. Only the presenters filter, and `decision as never` hides the type.
    - Fix: validate with `decisions.ts`'s `isAllowed` and reject in dev. Remove the cast by typing through the contract's `PermissionDecision`.

16. **Minor: unbounded per-session sets.**
    - Where: `store/apply.ts:385-393`; `runtime/session.ts:176`.
    - Issue: `fresh` in the store grows with every live message of a generation, and `#echoed` grows for the session's lifetime.
    - Fix: prune `fresh` when the message is first rendered or on a terminal. Clear `#echoed` entries once no outbox entry references them.

17. **Minor: `ChatView` creates and evicts sessions during render.**
    - Where: `kit/view.tsx:109, 115`.
    - Issue: `runtime.session(threadId)` runs during render, and it inserts into the LRU and may `retire()` another session. `pin()` only runs in an effect, so a render that evicts can retire a session whose view is about to mount. That view then waits on `LoadingRows` forever, because `session.load().catch(() => {})` swallows `ThreadRetiredError`.
    - Fix: get the session in the loader (already done) and look it up without eviction during render. Or re-acquire on `retired` in the effect.

18. **Minor: attach "Files or images" copies every file's bytes into the renderer.**
    - Where: `runtime/host-actions.ts:34-43`.
    - Issue: `system.dialog.openFiles` returns `PickedFile.data: Uint8Array` (`apps/desktop/src/shared/contract/system.ts:32-37`). The kit reads whole files across IPC only to show a size, and a multi-GB video blocks the renderer.
    - Fix: add a path-only variant (or `stat`) in main, or stop showing the size for picked files.

19. **Minor (needs a bundle check): fixtures probably ship in production.**
    - Where: `routes/_shell/(bots)/bots.$botId.tsx:10, 24-27`; `fixtures/goldens.ts:10-27`.
    - Issue: the production route statically imports `fixtureRuntime` from the feature's public API. `goldens.ts` eagerly globs every `*.agui.jsonl` as raw strings and computes `GOLDEN_NAMES` at module level (a side effect Rollup keeps). Unless tree-shaking proves the modules pure, every golden and scenario lands in the prod renderer bundle.
    - Fix: load the fixture runtime with `import.meta.env.VITE_NEXT_DB_FIXTURES === "1" ? await import(...)`, or put it behind a separate entry. Check `vite build` output for a golden string.

20. **Nit: pump retry delays differ from §3.3.**
    - Where: `runtime/pump.ts:53`.
    - Issue: the delays are `[250, 1000]` and the third failure sets `error`. §3.3 lists 250 ms, 1 s and 4 s.
    - Fix: pick one and align the spec text or the constant.

### UI layer (kit, markdown, scroller, motion, gallery, routes)

21. **Major: history pages announce old runs.**
    - Where: `kit/layout.tsx:85-126`, with `runtime/session.ts:844-853`.
    - Issue: the announcer treats any unseen `runId` in `runs.outcomes` as a new milestone, and `loadOlder` merges each page's outcomes. So every page announces "Reply finished" or "Error: …" for old runs. The "{n} new messages" milestone (§12.1) is also missing.
    - Fix: announce only terminals recorded by the live post-hook (for example a `live` flag on the record).

22. **Major: the window does not bound mounted rows (§10, r3-3).**
    - Where: `scroller/window.ts:7-56`; `scroller/transcript.tsx:231-346`; `kit/message.tsx:266-297`.
    - Issue:
      - `MAX_ROWS` counts messages only, not tool or sub-agent rows.
      - `StepList` grows by 100 per click with no cap or eviction.
      - `showLater` evicts rows above the viewport without a `scrollTop` correction.
      - Placeholders are buttons, not sized by last measured height (or 64 px per row), and scrolling them into view does nothing.
    - Fix: one row model over messages, tool rows and cards. Capture the first visible row and its offset before each change, and correct `scrollTop` in a layout effect.

23. **Major: registry prepend preservation never runs.**
    - Where: `scroller/transcript.tsx:325-333`.
    - Issue: `@shadcn/react`'s `handleContentChange` restores the offset only when the previous first child moved to index > 0. The first child here is always `slots.header`, `OlderRow` or `Placeholder`, which stays at index 0. So paging and "Show earlier" jump the viewport, and the registry may take its "appended" branch and scroll to an older anchor.
    - Fix: render these outside `MessageScrollerContent`, or capture and restore as in 22.

24. **Major: in-page Markdown links navigate the router.**
    - Where: `markdown/markdown.tsx:44-66`.
    - Issue: only `#abacus-file=` and http/mailto links are `preventDefault`ed, and the router uses hash history (`router.tsx:79`).
      - Footnote links (`#user-content-fn-N`) navigate the app.
      - Reference-definition targets (`[x]: /abs/path`) are not rewritten by the pre-pass and navigate the window.
    - Fix: always `preventDefault`; scroll to `#…` ids within the transcript; rewrite reference definitions in `prepass.ts`.

25. **Major: math rendered before temml loads never updates.**
    - Where: `markdown/markdown.tsx:192-207`.
    - Issue: the React Compiler is on (`apps/desktop/vite.config.ts:70`). `useMathVersion()`'s return value is unused, so the memoised `<TextPart>` element is reused and finished messages keep showing raw TeX.
    - Fix: `const v = useMathVersion()` and `<TextPart key={v} …>`. Test that the module loads after the first render.

26. **Major: the "Thinking" shimmer stays on for the whole run.**
    - Where: `kit/parts.tsx:193, 225-238`.
    - Issue: `markLiveThinking` writes a module WeakSet during render and never removes entries. The processor keeps the same thinking-part object after text starts, so `isLive` stays true while the run streams.
    - Fix: put `lastPart` in `MessageScope`; `live = scope.streaming && part === scope.lastPart`.

27. **Major (perf, R2-T31(d)): every message re-renders and re-parses Markdown per chunk.**
    - Where: `runtime/host.ts:53-55`; `kit/view.tsx:121-136`; the routes' `composer={{…}}`.
    - Issue:
      - The fresh `interrupts: []` and `pendingInterrupts: []` defeat `MessageView` and `AutomaticParts` memoisation (`create-ui.tsx:655-669`).
      - The routes pass a new `composer` object on every row change, which rebuilds the `ChatViewContext` value.
    - Fix: frozen module-level empty arrays. Memoise the composer config, or split the stable and volatile context fields.

28. **Major: tool groups (§5.3) are not implemented.**
    - Where: `kit/message.tsx:354-362`.
    - Issue: only `data-grouped` is set. There is no `groupId` header with `summary`, collapsed in bots and expanded in sessions. R2-T11 lists this case but no test covers it.
    - Fix: implement the grouping and test it.

29. **Major (safety): the credentials card focuses "Allow once".**
    - Where: `kit/permissions/permission-card.tsx:290-293`, with `presenters.ts:125-138`.
    - Issue: autofocus goes to `leading[0]`, which for `credentialPaths` is the secondary Allow once, not the primary Deny. A stray Enter allows a credential read.
    - Fix: focus the `primaryAction`.

30. **Minor: the tray moves on before the answer resolves.**
    - Where: `kit/permissions/permission-card.tsx:190-197`; `permission-list.tsx:90-92`.
    - Issue: `onAnswered` fires on click, so the `response_rejected` text, the 10 s timeout text and the spinner appear on a card that is now behind a chip.
    - Fix: advance the selection when the descriptor leaves `permission.pending`, or while `answering[id]` is `sending` or `error`, keep that card selected.

31. **Minor: sub-agent durations come from a stale clock and module maps written during render.**
    - Where: `kit/subagents/subagent-card.tsx:26-27, 62-66`; `kit/clock.ts:7-31`.
    - Issue: replayed or finished cards read "0.0s" or an inflated time. The maps are keyed by `subagent.id` only, so legacy ids collide (R2-T14).
    - Fix: use SUBAGENT_* event timestamps.

32. **Minor: `runActive` is thread-wide.**
    - Where: `kit/tools/tool-line.tsx:133`; `kit/tools/normalize.ts:118-124`.
    - Issue: an older result-less call shows "runs" whenever any run is active. A result-less `call.state === "error"` maps to "running".
    - Fix: tie the status to the call's own run. Map an error state to failed or stopped.

33. **Minor: the in-app reduce-motion preference doesn't reach CSS.**
    - Where: `chat.css:191-196`.
    - Issue: nothing sets `:root[data-motion]`. Typing dots, `data-fresh`, the last-block fade and `shimmer` follow only the OS media query, and `shimmer-none` is never applied (§9.1). The `motion/react` paths are correct.
    - Fix: set `data-motion` on the root from `useMotionPreference`, or apply the classes from JS.

34. **Minor: invisible messages still mount a scroller row.**
    - Where: `scroller/transcript.tsx:297-306`.
    - Issue: the `<runId>:error` anchor and hidden routine-fire user messages still mount a `MessageScrollerItem`, which adds a 12 px gap. The hidden user row is `scrollAnchor`.
    - Fix: skip the item but keep outcomes keyed to it; set `scrollAnchor` only on visible user rows.

35. **Minor: "composer had focus" is set on focus and never cleared.**
    - Where: `kit/layout.tsx:205-213`.
    - Issue: a click in the transcript doesn't clear the flag.
    - Fix: read `document.activeElement` when the tray mounts.

36. **Minor: queue row editing.**
    - Where: `kit/queue-slot.tsx:53, 104-122, 128-141`.
    - Issue: the edit draft is initialised once, so text edited in another window opens stale. Ghost (rejected, gone) rows still show Edit and Remove.
    - Fix: reset the draft when the editor opens; ghost rows show no actions.

37. **Minor: ErrorCard and notice gaps (§5.6).**
    - Where: `kit/status/status.tsx:310-319, 411-422`; `scroller/transcript.tsx:67`; `kit/parts.tsx:108, 155-165`.
    - Issue:
      - `switch-model` without a model has no handler (it should open the picker).
      - `tier` is never passed, so top-up always opens the plan URL.
      - Notices render only `link` actions.
      - Dismiss on a migrated notification does nothing.
      - `feature_limit` lacks the upgrade CTA.
    - Fix: implement each per §5.6.

38. **Minor: diff colours in code blocks never apply.**
    - Where: `chat.css:123-124`.
    - Issue: the rule targets `.token.inserted` / `.token.deleted`, but `@tanstack/highlight` emits `.th-inserted` / `.th-deleted`.
    - Fix: use the `.th-*` selectors.

39. **Minor: `PermissionList` cannot render outside a `ChatView`.**
    - Where: `kit/permissions/permission-list.tsx:99-100`.
    - Issue: it is exported for the notch but calls `useChatView()`, which throws outside a `ChatView`.
    - Fix: give it props or a standalone provider.

40. **Minor: the runtime is not on the router context.**
    - Where: `routes/_shell/(bots)/bots.$botId.tsx:118`; `routes/_shell/(sessions)/sessions.$sessionId.tsx:118`.
    - Issue: the loaders use `chatRuntimeFor(context.transport)`, not `context.chat` (§2, §14.8). It works through the WeakMap, but it is not the specified member.
    - Fix: add `chat: ChatRuntime` in `createAppRouter` and read it from the context.

41. **Minor: pre-pass edge cases.**
    - Where: `markdown/prepass.ts:36-39, 235-247`.
    - Issue:
      - Display math inside a blockquote or list becomes a top-level fence, which breaks the structure.
      - A 4-space list continuation after a blank line is treated as indented code, so math and links in it aren't rewritten.
      - A backslash-escaped `\(` or `\[` is still treated as math.
    - Fix: handle each of the three cases in `prepass.ts`.

42. **Minor: gallery gaps.**
    - Where: `gallery/sections.tsx:17-68, 174-176`.
    - Issue:
      - No `chat-markdown` section.
      - The composer-attachment, mention, dictating, Pickers and dictation boards have no scenarios.
      - `View` never retires its fixture runtime, which leaks timers and streams (dev only).
    - Fix: add the section and scenarios; retire the runtime on unmount.

43. **Minor (a11y): transcript attachment chips.**
    - Where: `kit/message.tsx:81-120`.
    - Issue: the chip is a clickable div with no button role and no keyboard handler. Thumbnails load eagerly (the spec says lazily, only in view) and never in bots, because `workspaceRoot` is null there.
    - Fix: use a button; load thumbnails lazily and not only when `workspaceRoot` is set.

44. **Minor: "Show" on a "needs you" row does nothing in bots.**
    - Where: `kit/tools/tool-line.tsx:471-479`.
    - Issue: `selectPermission` drives only the sessions tray.
    - Fix: hide the button in bots, or scroll to the inline card.

45. **Nit.**
    - `ThinkingView`'s Marker lacks `role="status"` (§5.3).
    - The CodeBlock Copy `setTimeout` is not cleared on unmount.
    - `firstSeenOf` (`tool-line.tsx:85-94`) mutates a module map during render and ignores the sub-agent scope.

### Tests, guards and repo rules

46. **Blocker: whole R2 rows have no test.**
    - Issue: R2-T6 (user echo, real host), R2-T28 (Electron transitions), R2-T31 (perf gate), R2-T32 (real-session gate), R2-T33 (steer ids across a respawn), and the Electron half of R2-T16. The named files (`user-echo.test.ts`, `steer-ids.test.ts`, `e2e/chat-*.mjs`, `perf/transcript.bench.test.tsx`) do not exist. T31 and T32 are phase-gate items (§1.3, §15).
    - Fix: add them.

47. **Major: the wrong harness for "memory transport" and "real host" rows.**
    - Where: `fixtures/relay.ts` (whole file; cast `as unknown as AiClient` around :502).
    - Issue:
      - R2-T4, T20, T21 and T35 run on a hand-written `FakeRelay`, not `createMemoryTransport` with the real `RPCHandler`/`RPCLink`, and not `AguiHost`.
      - The fake builds its hydrate snapshot with the kit's own `applyEvent`/`recordTerminal` (`#fold`, about :160-225), so R2-T8's "session slices from the snapshot" check is circular.
    - Fix: run these rows over the memory transport with the real relay and host, or at minimum type the fake against the contract with no casts.

48. **Major: failing and weak scroller test.**
    - Where: `scroller/transcript.test.tsx:103-133`.
    - Issue:
      - It times out.
      - It does only 3 "Show earlier" activations; §13 requires 10, plus 10 expansions of a 3,000-tool message.
      - It has no ±1 px anchor assertion.
      - Line 111 expects 520 client messages, which contradicts the retention cap (see 5).
    - Fix: reduce the fixture or raise the timeout, and add the missing assertions.

49. **Major: R2-T35 (a) doesn't prove echo-before-rejection.**
    - Where: `runtime/admission-uncertain.test.ts:57-62`.
    - Issue: it accepts `started` **or** `unconfirmed`, and allows up to 2 sends. It never asserts that the draft is not restored, the Retry path of (e), or that the agent sees one run.
    - Fix: make the echo deterministic (await the host store seeing it before rejecting), then assert `started` and exactly one send.

50. **Major: R2-T22 is incomplete.**
    - Where: `kit/view.test.tsx`.
    - Issue: the bots case has one descriptor, not two answered in reverse order. There are no rendered `response_rejected`, 10 s timeout, answered-elsewhere or expiry cases.
    - Fix: add them.

51. **Major: R2-T10 is not tested through the real busy source.**
    - Where: `runtime/queue.test.ts:197-243`.
    - Issue: it hard-codes `turnBusy: false`. The turn column arriving before or after `RUN_STARTED` and the permission wait are untested.
    - Fix: test through the composer with `turnBusy` toggled.

52. **Major: R2-T12 does not use the spec's cases.**
    - Where: `kit/view.test.tsx`.
    - Issue: there is no `mcp__linear__create_issue` tool, no unknown sub-agent name (the §5.2 throw case), and no nested `<Parts/>` check.
    - Fix: add an MCP tool and an unknown sub-agent kind to a scenario.

53. **Major: R2-T16 jsdom gaps.**
    - Issue: no tests for the "{n} new" marker (`transcript.tsx:131-156`), prepend preservation, or `data-pending-scroll`.
    - Fix: add them.

54. **Major: R2-T2 is incomplete.**
    - Where: `runtime/host.test.tsx`.
    - Issue: it does not render the host through the real `createChatUI`, and it does not assert that the old client's `unsubscribe`/`dispose` notifications leave the new binding alone.
    - Fix: spy on the old client's callbacks after the swap.

55. **Minor: weak assertions across several rows.**
    - R2-T1 (`positions.test.ts:58, 118`) never asserts that the starting positions are `startSeq − 1`, or that `RUN_STARTED` was replayed; `runs.active` is seeded from the snapshot anyway, so skipping it would pass.
    - R2-T3 compares only the final messages, so a duplicated `RUN_STARTED` or CUSTOM event would pass. Record the processed seqs.
    - R2-T24 (`presenters.test.tsx:378`) never asserts "Skip all" sends reject; letter shortcuts and `Mod+Enter` are untested.
    - R2-T25 does not cover `Mod+.` in the focused view, the `@` menu, picked-path attachments, the error chip, the disabled state without `attachmentsBase`, or mini geometry.
    - R2-T11 renders only the session skin; web_search_results, unknown, document parts and tool groups are untested.
    - R2-T26 checks only "Reply finished", with no "once" or 500 ms debounce assertion.
    - R2-T29 checks events against hand-written string sets, not the agent's `AguiEvent`.
    - R2-T23 copies the decision sets by hand instead of importing `allowedDecisions` (`packages/agent/src/agui/permissions.ts:37`).
    - R2-T13's `kit/tool-line.test.tsx` is absent.
    - `runtime/queue.test.ts:6` cites a nonexistent `kit/queue.test.tsx`.

56. **Minor: R2-T30 is a name heuristic.**
    - Where: `guards.test.ts:126, 151`.
    - Issue: the global check needs the receiver to match `/client|chat|host|handle|subagent/i`, and the runtime check needs it to be named exactly `client`. It misses aliases, destructuring and computed keys.
    - Fix: also flag destructuring and computed access of request-method names in `features/chat`.

57. **Minor: locales.**
    - Where: `scripts/locale-keymap.json`.
    - Issue: all 217 new `chat.*` keys in the 10 non-English locales are English copies. §15 requires reusing existing strings through the keymap, and the keymap has no `chat.*` entries. Examples: `chat.composer.attach` ← `workspace.attach.menuLabel`, `chat.permission.action.alwaysAllowThese` ← `permissions.sandboxDeniedAlways`, `chat.permission.sandboxRunsAgain` ← `permissions.sandboxDeniedRerun`.
    - Fix: add the mappings and run `sync-locales --apply-keymap`.

## Confirmed correct

**Receive-only client.** No `ChatClient` method that reaches `streamResponse` is called anywhere in renderer-next. The client is ephemeral (no persistence or history), and its adapter's `send` throws. `queue: throwWhenBusy` is a `QueueStrategy` (`types.ts:487-494`), and admission is `ai.send` plus the outbox (`admission.ts`). The kit uses only `subscribe`, `unsubscribe`, `dispose`, `getMessages`, `getSubagents` and `setMessagesManually`. The `ChatClientOptions` field names (`queue`, `initialMessages`, `onSessionGeneratingChange`, …) match `types.ts:974-1102`.

**Pump.** The pump owns the subscription, epoch, resync and NOT_FOUND:
- It runs `joinRun` then `subscribe` with `lastEventId = receivedSeq` and the snapshot's `epoch`.
- `abacus.subscribed` sets `connected` and nothing else; `abacus.resync` starts a new generation.
- NOT_FOUND gives `error` plus `notFound`.
- A join that fails or ends before the checkpoint gives a new generation, never a `subscribe` at N.

Deciding "before reconstructed" by `receivedSeq` rather than `appliedSeq` is equivalent here, because received-but-unapplied items stay in the same dispatcher and client.

**Dispatcher.** `push`, `close` and abort resolve a single wake. The post-hook of item k runs when the generator is resumed for k+1, which is right after `processIncomingChunk(k)`. That holds across the 8 ms yield (`chat-client.ts:1942-1956`), so terminal records, `appliedSeq` and readiness follow the consumer.

**Inclusive reconstruction.** `receivedSeq` and `appliedSeq` start at `startSeq − 1` with an active run, and at the cursor without one. `runs.active` and `sessionGenerating` are seeded from the snapshot. Session-scoped slices skip `seq ≤ sessionCursor`, and run-scoped ones always apply.

**Generation guards.** Guards are on every client callback, the post-hook, pump callbacks, the `submit` and `retry` ack paths (`gen` and `rev`), and `loadOlder` (`gen`, `rev` and the client identity). The swap is one host `setState`, followed by teardown of the old client (`unsubscribe` then `dispose`).

**Readiness chains.** A superseded pending generation resolves with the replacement's promise. `retire()` rejects with `ThreadRetiredError` and catches it. A failed hydrate rejects unless it was superseded. `load()` returns the in-flight promise and restarts only when none exists or the last one failed. There is a 5 s partial cap.

**Admission classification.** `BAD_REQUEST`, `NOT_FOUND`, `CONFLICT` and `UNAVAILABLE` are definitive; everything else is uncertain. Re-sends use the same run id and message id after 1 s and 3 s, then the entry becomes `failed`, with Retry and Discard. A late RPC outcome is ignored once the echo has been processed. Stale-generation handling is wrong; see finding 1.

**`duplicate_echo` and resets.** `abacus.duplicate_echo` clears the outbox entry and marks the id as echoed (§14.12). `session.cleared` above the checkpoint bumps `rev`, clears the outbox and starts a new generation. Paging `NOT_FOUND` stops paging and rebuilds.

**The `<runId>:error` anchor.** Main's empty `<runId>:error` assistant message is hidden (the processor creates it with `parts: []`, and message widgets render nothing). It serves as `afterMessageId` because `recordTerminal` takes the last transcript message.

**Queue commands.** Commands carry `incarnation` and `entryId`. They are `pending` until `queue.updated` shows the effect. `command_rejected` is honoured only for the store's incarnation. There is a 10 s timeout, and a new generation starts with no command state.

**Permissions.** Each descriptor is independently answerable. `answering` is keyed by descriptor id. `permission.pending` is authoritative and filtered by incarnation. `response_rejected` reasons map to the §6.3 messages.

**C.3 rendering.** Text parts dispatch on `metadata.abacus.kind` for every C.3 kind, and video is registered. `normalizeTool` decides live vs migrated from `segmentId` before any result, and reads migrated data through `expandToolResultData`. `userText` tags drive hidden routine-fire messages, reminder stripping and migrated attachment chips. Runs and messages use native ids only (`#` and `%` are reserved; main enforces this with `BAD_REQUEST`).

**`createChatUI` usage.** Usage matches ai-react 0.29.3: both kits are created once at module scope, there is no `interruptsComponents` and no `queue` component, and the Proxy tool and sub-agent maps are never spread. `useThreadHost` `satisfies UseChatReturn`, and `sendMessage`/`reload` return `Promise<void>`.

**Motion.** `motion/react` transitions go through `motionFor`. Reduced motion is a layout cut plus a 120 ms fade, and the children's delay equals `durations.layout - durations.childFade` (foundation §7.8).

**a11y.**
- The transcript is `role="log"` with `aria-relevant="additions"` and `aria-busy` while a run is active.
- The status region is debounced to 500 ms.
- Icon buttons are labelled.
- Cards are `role="group"` with `aria-labelledby`, and tray chips use `aria-pressed`.
- Tool expanders carry `aria-expanded` and `aria-controls`.

**Math and links.** temml is imported only as a lazy default, with `trust: false` and a bounded cache. File links become `#abacus-file=`.

**03-bots §24.2.** `useComposerExpanded`, `slots.header`, `composer.fixedMode` (sent on every admission by `routeSubmit`) and the nullable `ModelChipBinding` exist, and the bot skin renders no RunMarker.

**Old renderer and dependencies.**
- The old-renderer diff is locale JSON only: 217 `chat.*` keys added per locale, with 0 removed, 0 changed and full parity.
- Outside renderer-next, only `package.json` and the lockfile changed, plus the new `scripts/sync-chat-fixtures.mjs`. `@tanstack/ai-react` is pinned to 0.29.3 and `temml` to 0.13.5, both exact, and `@shadcn/react` is `^0.3.1` (0.3.1 installed).
- The R2-T30 guard is AST-based and covers `agent.respondPermission`, `agent.queue.*`, `useChat` imports, named `temml` imports and cross-feature imports.
- R2-T3 (2,000 seeds), R2-T4 (chaining and retire), R2-T5, R2-T7 (iterator count back to 0), R2-T34, R2-T20 (isolation) and R2-T35 (b)–(f) do what their rows require.
