# Phase 6 implementation

Implemented on `codex-phase6` from `rewrite/renderer`, against spec 06 r4 including the three review-response tables and §23. The 17 Codex implementation r1 findings and the duplicate approval label are fixed. Per-finding changes and negative regression checks are recorded in [the r1 fix log](../specs/reviews/06-onboarding-tour-notch.impl-fixes-r1.md). **The PLAN phase-6 acceptance gate remains open.** Cross-slice integration and the recorded hardware/end-to-end cases below must finish before marking the phase done.

## Delivered scope

| Spec area | Result | Evidence / limits |
| --- | --- | --- |
| §2 parity | Every OB/FB/TR/NT row is accounted for in the two parity modules; transport legacy map and generated PARITY updated. | R6-T40 locates consumers; explicit phase-5 ownership remains for Settings. Accounting is not a claim that every behavioral test below is complete. |
| §3–5 entries, routes, bootstrap | Three Vite HTML outputs, independent notch memory router with seven routes, `_bare` onboarding routes and shell account gate. Loaders await their own data and do not initiate user actions. | Build, route snapshots, readiness tests. Dev Fast Refresh of both router plugins has not been recorded. |
| §6 onboarding | Pure step machine, canonical resume, attempt tokens, failed-attempt retention, cancellation, configured/stored provider union, single-flight completion tail with exit saved before account commit. Resume clears exit only after the destination and optional tour commit. | Machine, token, completion and actual-router tests. Process kill/relaunch at every boundary remains unrecorded. Main legacy canonicalization predates this slice. |
| §7 pages and deferred pairing | Seven pages, profile chooser, key entry, local-model controls, registry onboarding grid and more platforms; messaging pairing persists a deduplicated queue. Shell banner resolves connected entries or dismisses; route departure cancels handshakes. | No-model actual-router run passes through models, connectors, first bot and done into the shell. Credential-provider browser flows have not been exercised against a fake auth server. |
| §8 first bot | Public template creation seam, exactly one pending creation across remounts, weekday 08:00 check-in, routine failure leaves the bot usable, persistence-only routine-then-bot deletion, absent/deleted rows treated as complete. BotAvatar egg hatch and own transient confetti. | Persistence tests, route walkthrough, gallery. No ownership changes in routines. |
| §9 tour | Own spotlight/card, 12 stops (11 if notch unavailable), prepare/late anchor wait, focus trap and inert shell, completion/skip prefs, origin return, replay and sign-out hooks. | Geometry and spotlight tests. Phase-4/5 owner anchors and Settings/command-menu replay wiring remain to integrate; fixtures are not proof of those owner placements. |
| §10 native companion | Typed procedures; one BaseWindow + transparent WebContentsView per target display; view fitted on creation and every bounds change. Strict JXA NSScreen selector probe and no inference fallback. Active/standby promotion; readiness/crash retry budget and retry API; all disposal paths close contents; open-command ids/replay/acks; visibility reports and active-Space observer; central haptic lineage dedupe; Windows taskbar capsule placement; Linux disabled. | Main tests, real macOS view/disposal test, physical probe and haptic measurements. Windows OS behavior and Mac compositor/Space behavior remain unverified. |
| §11 priority/runtime | Revisioned atomic attention consumer, shared run-finished feed, routine attribution, pure priority presenter, hidden dwell pause, pointer/focus lock, 8 s presentation deadline, stale-generation checks, explicit retirement with a two-thread budget. | Presenter/director/20-thread tests. Shared feed is exposed for sessions; sessions adoption belongs to phase 4. |
| §12 views | Approval safety table, full sandbox note, layout-gated inline responses, question step encoding, connector asks, draft-preserving reply, bounded click-only chat creation, dictation operation tokens, working/done/failed views and reactions. | Real Electron fit test uses shipped Inter/notch CSS, 51 cases across English/German/Japanese. Fit tracks ResizeObserver changes during width animation; hidden control measurement also checks button text. Oversized request details remain in hidden measurement so Review stays reachable; question state is keyed by full lineage. Coverage is not the full per-variant boundary matrix requested by R6-T41. |
| §13 notifications | `system.notify` kind/dedupeKey, silent attention routing, 1.5 s presentation hold, bounded dedupe, per-document visibility. | Suppression flag remains **off**, including background-task suppression, until R6-T30 proves visibility across Spaces. Banners therefore continue to show. |
| §14 sound/haptics | Six original synthesized cues, duration bounds, WebAudio engine, shared notice mapping, per-bot level/quiet hours, preview API and central `window.claimCue` ownership. Haptics use one-shot osascript and central lineage/step dedupe. | Six OfflineAudioContext cues have positive energy within bounds. Physical haptic median 51.388 ms / p95 55.429 ms (20 warm samples; first cold sample 235 ms). Three-person perceptual tuning is pending. |
| §15 Settings seams | Public preview/replay hooks and typed notch status/retry/prefs contract. | Settings UI is phase-5-owned and was not edited. Integration required. |
| §16 motion | Own tokens/CSS mirrors, shared element names, hatch/reduced-motion paths, envelope-before-navigation/final-after-settle with cancellation/deadline paths. | Unit/type/native viewport checks. Full route-transition overlap and platform screenshot sequence remain pending. |
| §17–19 locale, accessibility, gallery | Additive locale keys only in the legacy tree, all 11 locale schemas aligned, focused-only notch announcements, spotlight dialog, fixtures for all seven steps, twelve tour stops and fifteen notch specimens in plain/notch/capsule modes. | 128 captures at 1280, light/dark, zero axe violations in the capture run. Dedicated numeric contrast assertions and human translation review remain pending. |
| §23 amendments | Minimal separate commits add bots template creation/shared cue adoption, chat permission/cancellable load seams and BotAvatar hatch API, shell anchors/banner/sound owner, main wiring and legacy contract map. | No files under features sessions/routines/artifacts/library/settings or packages/agent were edited. React Compiler remains enabled; UI registry snapshot unchanged. |

## Validation

The original delivery results below are historical. Current r1 fix-pass results are recorded in the fix log and the validation update below. The r1 regressions include the production director/runtime retirement test, every awaited presentation stage, main event wiring, same-database cleanup retry, descriptor expiry, mounted reply/quiet-hours behavior and native listening control bounds.

Dependencies installed with `pnpm install --pm-on-fail=ignore`. Connectors, agent runtime and updater distribution outputs were built before distribution-dependent tests; no agent source was edited. `rewrite/renderer` was merged at the start, during implementation, and checked again immediately before the final suite.

The first broad renderer-next/main/shared run had 3,963 passing, 13 failing and seven todo cases. The failures exposed integration assumptions (onboarding gate in harnesses, notify optional metadata call shape, new feed names, CSS tokens, retained load-promise identity and startup import scan); these were corrected. A later run had 3,979 passing and one failing new walkthrough timing test. That test now waits for the committed heading and enabled control. A subsequent broad run hit existing shell-unmount/transcript timing checks (3,978 passing / two failing); both passed in a 30-test targeted rerun, and the shell now explicitly awaits React unmount. The final aggregate uses four workers and a 15-second test timeout to reduce shared-machine contention; the shell cleanup test now unmounts the shell directly instead of depending on gallery imports. The final aggregate result is recorded below and in the attached log.

| Check | Result |
| --- | --- |
| Final renderer-next + main + shared | **396 files / 3,980 tests passed**, seven todo, one skipped file. Post-fix question-lineage/safety rerun: **23 tests passed** (one new test; the other 22 repeat broad-suite cases). |
| Full main-serial with `ABACUSBOT_REQUIRE_ELECTRON_SUITES=1` | **11 files / 294 tests passed**, no Electron suites skipped. |
| Corrected native fit/viewport rerun | **1 test passed**; 51 layout samples, 20 grow/shrink/disposal cycles, six audio cues. This reruns one of the 294 tests rather than adding a distinct 295th test. |
| Actual-router no-model/sign-in/gate file | **3 tests passed** after correcting disabled-button timing. |
| Preload project with `UPDATE_PARITY=1` | **6 files / 15 tests passed**. |
| Desktop `tsc -b` | Passed. |
| Root oxlint | Passed; seven existing legacy React hook warnings. |
| Root oxfmt | Final check recorded with delivery logs. |
| UI registry / legacy diff / JSX i18n / locale schemas / knip-next | Passed; knip has three configuration hints. Legacy edits are additive locale keys only. |
| Screenshots | **128 captured / zero capture failures / zero axe violations**, 1280 light and dark. |

[Capture index](06-assets/screenshots/index.html), [capture manifest](06-assets/screenshots/shots.json), [axe results](06-assets/screenshots/axe.json), [native results](06-assets/native-result.json), [raw NSScreen probe](06-assets/metrics-probe.json), [haptic samples](06-assets/haptics-latency.json). Captures use gallery fixtures, not fake-provider hardware transcripts. The screenshot source commit is `49f7bb4e`; subsequent code changes affect fit safety and tests, not those gallery specimens.

## R6 acceptance matrix

“Partial” means implemented behavior has passing evidence but the complete specified assertion set or required environment has not been demonstrated. It must not be read as a passed acceptance case. Test filenames follow repository conventions rather than every proposed filename in §20.

| ID | Status | Environment and evidence / remaining work |
| --- | --- | --- |
| R6-T1 | Partial | jsdom route snapshots and notch router; production build emits all three HTML entries. Dual-router dev Fast Refresh unrecorded. |
| R6-T2 | Partial | Real jsdom router verifies fresh-account gate and signed-out onboarded access. Exhaustive bootstrap-failure/direct-step matrix not separately asserted. |
| R6-T3 | Partial | Loaders and readiness tests, once completion funnel and no done-entry report. No dedicated full mutation-spy matrix across every cold step. |
| R6-T4 | Partial | Machine tests cover transitions/guards; not exhaustive Cartesian facts and every ignored pair. |
| R6-T5 | Partial | Machine resume tests and existing main migration/preferences tests pass in broad suite; dedicated combined legacy-vs-live provenance scenario not added here. |
| R6-T6 | Partial | jsdom persistence failure boundaries, completion single flight and same-database retry after failed cleanup pass. No Electron process-kill/relaunch matrix. |
| R6-T7 | Partial | Token/store and actual-router retained failure/cancellation tests pass. Not every specified restart/double-click/error-code case has a real-router assertion. |
| R6-T8 | Partial | Deferred messaging test and real no-model walkthrough pass. Registry filtering/provider union implemented; complete key/local-model/browser cancellation/banner matrix unrecorded. |
| R6-T9 | Partial | First-bot persistence tests pass, including held deletion and missing rows; weekday template and no-model route verified. Full Strict Mode/funnel/removal matrix not all rendered. |
| R6-T10 | Partial | Entry guard and typed funnel names implemented; no dedicated once-per-entry test for every step. |
| R6-T11 | Passed | Seven jsdom card-placement cases. |
| R6-T12 | Partial | Spotlight portal/inert/focus/escape behavior test passes; no explicit 40 ms timing/reduced-motion assertion for every stop. |
| R6-T13 | Partial | Tour store and completion token checks pass, including sign-out/replacement during persistence and telemetry; full host navigation/completion/replay matrix and other-owner integrations pending. |
| R6-T14 | Pending integration | Shell/bots/composer anchors added. Phase-4/5 placement tests and exact owner anchors require their merge. |
| R6-T15 | Partial | Shared feed test verifies one iterator/duplicate suppression/last-consumer close; notch inputs implemented. Sessions feed adoption is phase-4-owned. |
| R6-T16 | Partial | Pure presenter and ten-minute descriptor snooze/count tests pass, including replacement lineage at equal timestamps. Full every-kind/dwell/quiet/hidden Cartesian matrix not exhaustive. |
| R6-T17 | Partial | Director tests bound hydration, both shape IPC calls, navigation and settling by 8 s; clear stale queued work and revalidate on unlock. Mounted quiet-hours and immediate click-through regressions pass. Real chat cancellable load tests pass. Complete lock/hover/invalid-item scenario matrix pending. |
| R6-T18 | Partial | Chat per-type safety tests and native question/permission specimens pass. Question progress/answers reset on lineage change (one additional regression passed). Full mounted response rejection/keyboard/connector-ask matrix pending. |
| R6-T19 | Passed | Production NotchDirector with real ChatRuntime/FakeRelay drives twenty queue changes, cancellation and disposal; peak two iterators, explicit production retirement and return to zero. This replaces the original test that manually enforced its own limit. |
| R6-T20 | Partial | Mounted manual reply/listening quiet-hours tests, started/queued submission, run acknowledgement, focus release and wink pass. Native listening controls fit all nine mode/locale specimens. Full routine-toggle/call-draft interaction matrix remains incomplete. |
| R6-T21 | Partial | Voice operation tests pass for normal End, late media/transcript and disposal. Full view timer and ported recorder/Whisper suite not complete. |
| R6-T22 | Partial | Main arbiter/shared mapping tests pass; six real OfflineAudioContext cues pass energy/duration checks. Full three-notch shuffled-delivery integration not exercised with native documents. |
| R6-T23 | Partial | Geometry tests cover platform placements, unknown metrics and bounds. Physical mixed-scale/taskbar/above-left arrangements not exercised. |
| R6-T24 | Partial | Parser/cache failure tests plus real notched-Mac fixture pass. Additional physical empty-rect/non-notched selector fixtures unavailable. |
| R6-T25 | Partial | Main lifecycle/standby/retry tests, superseded standby base test, automatic resize after child replacement and 20 real child-viewport/disposal cycles pass without manual fit calls. Five forced readiness failures/live RPC baseline and Windows close native case not recorded. |
| R6-T26 | Partial | Interaction and central lineage/step haptic dedupe tests pass. Exhaustive multi-display shortcut selection native runs pending. |
| R6-T27 | Not run | Fake-microphone WAV transcription under notch CSP and before/during/two-minute memory sampling not implemented/run. |
| R6-T28 | Partial | Controller/provenance/open stream/notification tests pass. Main focus/blur/show/hide/close wiring, insertion-order command acknowledgement under equal/rollback clocks, failed-ack replay and Space epoch request/report recovery now have regressions. Complete live main transport contract/publish exclusion/wink/latency matrix not exercised. |
| R6-T29 | Passed | Production AST enumeration/trust audit plus dispatcher/preload tests pass. |
| R6-T30 | Partial | Real macOS viewport/grow/shrink/disposal passes. Activation, OS click-through, menu exclusion, compositor full-screen/occlusion/Space recording **not run**. Suppression remains off. |
| R6-T31 | Partial, hardware | Available host Mac15,13, macOS 26.6.2: strict probe gives 1710×1107 frame, top 33, left 763, right 762 (185×33 cut-out), 201 ms. Twenty haptic samples recorded. Top-150-pixel native state captures and fake-provider approval/reply not recorded. |
| R6-T32 | Hardware gap | External display unavailable; unplug/replug/lid/menu-bar-primary run not performed. |
| R6-T33 | Hardware/runner gap | Windows machine/runner unavailable; only geometry/fake-main logic and gallery capsule specimens tested. |
| R6-T34 | Passed | JSX key scan, locale schema check and keymap/retirement guard pass. Human translation quality not certified. |
| R6-T35 | Partial | 128 real-Electron fixture axe passes and dialog semantics. Dedicated computed numeric contrast assertions not added. |
| R6-T36 | Not run | Recorded fake-auth/fake-provider fresh-install flow on macOS/Windows and restart/inline approval transcript missing. jsdom walkthrough is not this gate. |
| R6-T37 | Partial | Motion/type/CSS mirror tests pass; foundation transition tests pass in full main-serial. Exact every-phase-6-route/reduced-motion single-transition matrix not recorded. |
| R6-T38 | Passed | Source AST structure guard plus foundation import boundaries pass. |
| R6-T39 | Passed | AST forbidden import/API guards pass. |
| R6-T40 | Passed (accounting) | Every parity row has a status and existing consumer or explicit other-phase owner. Behavioral completion is governed by this matrix. |
| R6-T41 | Partial | Real shipped fonts/CSS, 51 request/question samples across en/de/ja, narrow/short/long, no visible inline Allow when body overflows; nine mounted listening specimens keep End/Cancel inside the shape. Complete 19-variant just-below/at/above both-dimension matrix missing. |
| R6-T42 | Partial | Director envelope/settle unit tests, real child grow/shrink/mixed-origin viewport. Native interrupted/reduced/unchanged screenshot sequence and Windows upward sequence not recorded. |
| R6-T43 | Human review gap | Three people with laptop speakers/headphones unavailable. Own cue parameters are provisional pending listening sign-off. |
| R6-T44 | Partial | Main relay atomic attention tests in broad suite; client stale-revision reducer tests and presenter question priority pass. Full overflow/reconnect/incarnation race integration matrix not all added here. |

## Cross-slice change requests and handoff

1. **Phase 4:** use `lib/run-finished.ts` and `lib/attention/cues.ts` for session notices; register session-start, preview terminal, changes and memory tour anchors at §9.2 owners. Tour preparation uses the terminal tab explicitly. Add owner-placement coverage after merging.
2. **Phase 5:** wire `useStartTour` and `tourSignedOut` into Settings/command menu; adopt `previewCue` for all six cues, notch status/retry and reserved preferences rows. Register connectors/artifacts/workspaces anchors. Compose onboarding provider/local-model/connection controls from phase-5 public APIs once available; this worktree has own controls because those exports were absent on its base.
3. **Coordinator / acceptance owner:** add or run R6-T27, T30–33, T36, T42–43 and the missing matrix assertions above. Keep `NOTCH_BANNER_SUPPRESSION` false until compositor/Space visibility evidence is approved. Do not mark PLAN gate complete from the fixtures.
4. **Visual follow-up:** compare the shell rail spotlight bounds against the exact bots/sessions target; current minimal registration uses the rail owner. Validate motion and done-page decorative details against the canvas in the final integrated UI.

## Provenance and design choices

Native options and lifetime behavior derive from [Electron BaseWindow](https://www.electronjs.org/docs/latest/api/base-window), [WebContentsView](https://www.electronjs.org/docs/latest/api/web-contents-view), [BrowserWindow options](https://www.electronjs.org/docs/latest/api/browser-window) and the local Electron 44 typings. Metrics derive from [Apple NSScreen safeAreaInsets](https://developer.apple.com/documentation/appkit/nsscreen/safeareainsets), auxiliary-area selectors and the captured JXA output. Haptic execution derives from [Apple NSHapticFeedbackManager](https://developer.apple.com/documentation/appkit/nshapticfeedbackmanager) and the measured spawn latency. Layout/motion intent comes from the design canvas and spec; text fit comes from real Electron measurement. The six cue oscillator/envelope recipes are our own, within spec duration bounds. No recipe or constant was taken from the PolyForm-NC openbot.run project.

## Commits

Implementation and minimal adjacent feature seams are committed separately. The attached commit list contains only phase-6 branch commits relative to the current `rewrite/renderer`, including synchronization merges. Screenshot evidence and this report are delivered in the final documentation commit.

[Commit list](06-assets/commits.txt). [Final unit log](06-assets/logs/full-unit-final.txt), [full Electron log](06-assets/logs/full-electron.txt), [native fit rerun](06-assets/logs/native-delivery.txt), [post-fix regression/safety tests](06-assets/logs/lineage-final.txt).

## Implementation r1 validation update

The r1 pass merged renderer history at `169c21bb`, resolved only the progress-table conflict, and regenerated the route tree. All 17 review findings and the duplicate label have fixes and negative regression evidence in the [fix log](../specs/reviews/06-onboarding-tour-notch.impl-fixes-r1.md). The final full unit projects passed **439 files / 4,223 tests**, with seven todo cases and one skipped file. Required main-serial initially passed **294 tests** with one real `fs.watch` timeout; its isolated required rerun passed, giving passing evidence for all **295 distinct cases**, with no Electron skips. Preload passed **15 tests**. Subsequent quiet-hours failure recovery and stronger event assertions passed targeted reruns without adding distinct cases.

Desktop TypeScript, WCO build, root oxlint/oxfmt and UI registry, legacy diff, JSX i18n, locale-schema and knip checks pass. Seven legacy hook warnings and three knip hints remain. This pass adds nine native listening control bounds cases and automatic child resize after replacement; those are assertions within the existing native test, not nine extra Vitest cases. The complete R6 hardware/end-to-end acceptance gate remains open.

[Unit log](06-assets/logs/r1-unit-final.txt), [main-serial log](06-assets/logs/r1-main-serial-final.txt), [watcher rerun](06-assets/logs/r1-main-serial-retry.txt), [negative regression summaries](06-assets/logs/r1-negative-regressions.txt).
