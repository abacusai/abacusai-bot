# Phase 6 implementation fixes, r1

Fixed the 17 findings in `06-onboarding-tour-notch.impl-codex-r1.md` against spec 06 r4, plus the duplicate approval label. The phase acceptance gate remains open. This pass does not claim the missing hardware recordings, fresh-install transcript, Whisper/CSP memory run or human cue review.

## Merge and scope

`169c21bb` merged `rewrite/renderer` at `68929470`, which contains the requested phase-5 `e761fe2f` update. The only conflict was `docs/rewrite/PROGRESS.md`. Its resolution keeps phase 5's completed r2 status and phase 6's implementation evidence and open acceptance gaps. `generate-routes.mjs` regenerated the main route tree without changing its contents. Dependencies installed with `pnpm install --pm-on-fail=ignore`; connectors, agent distribution and updater built before the desktop checks. No agent source changed.

Fixes stay in the phase-6 ownership paths. Two separate amendments carry the visibility epoch through main RPC (`b51b6206`) and expose the oldest descriptor lineage through the attention relay/contract (`6406a35c`). The latter is needed to distinguish replacement permissions in the same millisecond without hydrating every snoozed thread. No chat, bots, sessions, routines, artifacts, library or settings feature source changed in this pass. Pre-existing untracked `.build` artifacts were preserved under `/tmp/codex-phase6-build-artifacts-20261001`; this pass's generated artifacts are in its `fix-pass` directory.

## Per-finding log

Each regression below failed on the old implementation or with the specified fix removed, then passed after restoration. Finding 15 replaces a weak test; its negative check removes the production director's retirement calls.

| # | Status | Change and commit | Regression and observed failure without the fix |
| --- | --- | --- | --- |
| 1 | Fixed | `c0fdbf9b`: main focus, blur, show, hide and closed events call `appChanged()`. Closed publication follows main-window cleanup. The controller regression also verifies each event publishes its current state to the companion. | `main/notch/main-events.test.ts` and `controller.test.ts` drive the production event-registration function through all five events and verifies its call site in `main/index.ts`. The old entry has no registration. |
| 2 | Fixed | `d2ace526`: acknowledge through the matching command ID in Map insertion order. | `controller.test.ts` acknowledges A before B with equal timestamps and a 1 s clock rollback. Old code deletes B in both cases. |
| 3 | Fixed | `d9415311`: immediate exceptions clear queued work; unlock checks the latest route, quiet policy and descriptor against the latest queue. | `director.test.ts` covers A, queued B, calm, unlock, and a queued identity absent from the latest queue. Old code restores B after calm. Inverting the unlock queue validation also fails after the test drains queued async work. |
| 4 | Fixed | `d9415311`: race hydration, envelope IPC, navigation, settling and final IPC against one 8 s deadline. Retire both held threads and commit compact recovery without awaiting stalled recovery IPC. Background prefetch has its own bounded lifetime. | Five stalled-stage cases in `director.test.ts` complete at 8 s, retire both threads and commit a compact wing. All five remain unresolved on the old code. |
| 5 | Fixed | `50bf084b`: listening has a 132 px body allowance and shared mounted `ListeningControls`. | `notch.electron.test.ts` measures End/Cancel bounds with shipped CSS/fonts in plain, notch and capsule modes across en/de/ja. All nine pass. Restoring the old shape fails on the first plain specimen, whose 78 px shape clips the controls. |
| 6 | Fixed | `2c670170`: cache only fully completed onboarding tails; evict incomplete tails after settlement. | `onboarding/complete.test.ts` fails step cleanup, recovers and retries with the same database. Old code performs no retry and never clears the exit. |
| 7 | Fixed | `c122bf7a`, `b51b6206`, `50bf084b`: Space changes invalidate visibility and request a fresh active-document report with an epoch. Reject stale epochs. | `controller.test.ts` covers invalidation, stale report rejection and recovery across two Space changes. `inputs.visibility.test.tsx` drives the real visibility effect and re-reports an unchanged visible document with the requested epoch. |
| 8 | Fixed | `08632546`: resize fits current child views instead of a captured original view. | `window.test.ts` replaces the original child and emits resize. Old code never fits the replacement. The native test now removes all manual `fitView()` calls and includes a promoted replacement. |
| 9 | Fixed | `d2ace526`: discard superseded standbys before promotion and reconcile after promotion. | `controller.test.ts` changes the desired base twice during readiness. Old code promotes the obsolete view and never creates the newest one. |
| 10 | Fixed | `09ea248b`: each tour run gets a distinct token, checked after persistence and telemetry. Sign-out clears the active token. | `tour/completion.test.ts` signs out and starts a replacement during each await. Removing the checks navigates to the old origin and clears the replacement. |
| 11 | Fixed | `3b6f19a5`, `6406a35c`, `50bf084b`: store full permission lineage and expiry; expire after ten minutes; retain snoozed attention in the queue/count. Derive snoozes from the hook's clock and relay lineage. | `snooze.test.ts` covers unchanged expiry, replacement lineage and retained count. Old presenter reports zero attention. `ai-attention.test.ts` replaces a descriptor at the same timestamp; the old relay exposes no distinct descriptor key. |
| 12 | Fixed | `50bf084b`, `da4497cb`: current quiet policy takes precedence over manual reply/listening. Cancel pending message work, collapse and release native focus. | Two mounted `shell.test.tsx` cases start manual reply/listening, then enable quiet hours. Both stay expanded on the old component. Native focus rejection also retires the manual view, so ending quiet hours cannot restore it. |
| 13 | Fixed | `50bf084b`: started/queued submission clears manual state and draft, acknowledges the run, collapses, unlocks, releases focus and triggers the bot's wink. | Mounted shell cases cover both outcomes, native focus release, cleared textbox and reaction; a third keeps the automatic notice unchanged and verifies run acknowledgement prevents re-expansion. Old component retains the reply/focus lock. |
| 14 | Fixed | `21e430f6`: track committed navigation separately from successful acknowledgement; deduplicate in-flight work. | `open-target.test.ts` fails the first acknowledgement and replays twice. Moving acknowledgement state before `ack()` yields only one acknowledgement attempt. Navigation remains exactly once with the fix. |
| 15 | Fixed | `d9415311`: R6-T19 drives the production director with real ChatRuntime/FakeRelay. The test never calls `forget()` or retires threads itself. | `threads.test.ts` measures twenty queue changes, supersession/cancellation and disposal; checks actual director retirement, peak two iterators and return to zero. Removing director retirement fails the production-retirement assertion and cleanup expectations. |
| 16 | Fixed | `50bf084b`: pointer leave disables native interactivity immediately. The 300 ms timer delays visual collapse only. | Mounted `shell.test.tsx` asserts `setInteractive(false)` immediately after pointer leave. Old code has no call until the timer. |
| 17 | Fixed | `24ee07ce`, `6058c683`: distinguish validation errors from save/refresh failures, retain the valid key and show localized retry copy. | Two mounted `provider-key.test.tsx` cases fail persistence/refresh, retain the entered key and retry successfully. Old copy labels the key invalid. Locale checks also caught and corrected the retry-copy namespace. |
| Extra | Fixed | `50bf084b`: expanded approval wings name the bot; the body owns the attention label. Gallery specimens follow the same rule. | Mounted production shell plus real `PermissionList` has one "Needs you" label. The old shell has two. |

## Validation

The full unit and main-serial suites ran once with two unit workers to reduce shared-machine contention. A later defensive quiet-hours change and stronger existing assertions received targeted renderer/main reruns; the test count is unchanged. Targeted negative checks and reruns are regression evidence, not extra distinct passing tests.

| Check | Result |
| --- | --- |
| Full renderer-next + main + shared | 439 files / 4,223 tests passed; seven todo cases and one skipped file. [Log](../../reports/06-assets/logs/r1-unit-final.txt). |
| Required main-serial | First run: 294 passed and one existing real `fs.watch` timeout. The isolated required rerun passed that test, so all 295 distinct cases have passing evidence. No Electron suites skipped. [Full run](../../reports/06-assets/logs/r1-main-serial-final.txt), [isolated rerun](../../reports/06-assets/logs/r1-main-serial-retry.txt). |
| Native notch | Full main-serial includes automatic resize after replacement, 20 disposal cycles, 51 permission/question samples, nine mounted listening specimens and six synthesized cues. Restoring the old listening height fails the bounds test. |
| Final targeted additions/refinements | Controller + real event wiring: 12 passed. Mounted shell: seven passed. Real director/runtime retirement: one passed after the negative mutation. Provider save/refresh: two passed after correcting the localized key. These repeat full-suite cases. |
| Preload | Six files / 15 tests passed. [Log](../../reports/06-assets/logs/r1-preload.txt). |
| Desktop TypeScript and WCO production build | Passed with distribution prerequisites built. [Build log](../../reports/06-assets/logs/r1-build.txt). |
| Root oxlint / oxfmt | Passed; lint retains seven existing legacy hook warnings. |
| UI registry / legacy diff / JSX i18n / locale schemas / knip-next | Passed. Registry matches all 42 files. Locale schemas have 2,849 keys each and every translation call resolves. Knip retains three configuration hints. |

[Saved negative regression summaries](../../reports/06-assets/logs/r1-negative-regressions.txt). Successful reruns restore the production source; no mutation remains in the worktree.

[Code/test commit sequence](../../reports/06-assets/commits-fixes-r1.txt).

## Remaining acceptance work

The report's R6 table keeps partial and unrun cases explicit. In particular, this pass adds native mounted listening control bounds, automatic resize after child replacement, and logic-level Space recovery. It does not prove ordinary/full-screen Space compositor behavior, real OS click-through, Windows activation/switcher behavior, external-display changes, a recorded fresh install, Whisper under the notch CSP, or three-person cue recognition. Banner suppression remains disabled.
