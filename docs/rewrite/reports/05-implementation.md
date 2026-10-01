# Phase 5 implementation

Branch: `codex-phase5`. Continuation base: `505d04bf`; spec: `05-routines-artifacts-library-settings.md` r3, including the review tables and §31.

**Status: substantially advanced, still partial acceptance.** Registry and Knip gates now pass. The real native workflow, artifact performance and sound synthesis have recorded evidence. The complete R5-T1…T41 matrix is not green, and one required main-serial foundation test still fails.

## Merge resolution

`b4b04cc4` merges `rewrite/renderer`, including the chat-kit and bots fix passes through `9fca5314`. The shell hotkey conflict keeps the renderer's shared `lib/hotkeys` integration and phase-5 action IDs. The route tree was regenerated through the router plugin, preserving both slices' routes. `PROGRESS.md` uses the incoming renderer version; only its phase-5 row is changed in the final report commit.

The removed chat fixture export was adapted to public `loadFixtureRuntime`. A subsequent fixture build found that router splitting cannot reassign a shared imported fixture binding; `b29662b5` corrects that merge adaptation with an object-held value. This is a narrow correction in the merged bots route, not a bots feature change. No post-merge commit changes `features/chat`, `features/bots`, `features/sessions`, main implementation or agent source. Existing separate shell back-button/hotkey commits are preserved.

## Completed in this continuation

- Registry: canonical write-gated additions restore all 42 snapshot files. Knip declares public feature/component API entries and passes with two existing configuration hints.
- Routines: successive remote form refresh without losing edits, deleted editor handling, real editor chat/error/history tests, readiness buffering for owned notices, retained/resizable report width, 56 px state identities, shared row context/ellipsis actions, expandable instruction, pending webhook copy and readable paused rows.
- Artifacts: local-day list headings, shared preview/card/context actions, clear-search action, a 2,000-row fixture and viewport-sized card budget. The original 400-card initial window missed the FPS budget; the measured window now mounts 44 cards at 1280 px.
- Library: persisted deferred-pairing banner with navigation/dismiss, all-flow watchdog, Chrome warning after a successful required connector, running-session refresh guards, scoped MCP logs/runtime, dormant masked credentials, visible-field validation and successive untouched-field refresh.
- Settings: logical shortcut recording, terminal binding IDs, per-binding unbind/reset, live context/sequence conflicts; sounds preview through the shared engine; memory loading/error/retry; usage empty/refresh behavior; invite validation and channel isolation; credits tier/TTL/counter resets; install-and-use return/adoption for existing bot/session targets with late-result guards.
- Updates: public `UpdatePill`, failedPhase state labels, retry after a rejected install, paused/stopped critical countdown and installStalled stand-down. The 300-second countdown is tested with fake timers. The root now registers the ambient pill through the global end-action API, with route-persistence regression coverage.
- i18n/architecture: 196 mappings reuse existing translations; three new validation messages translated in all shipped locales; static/dynamic/retired accounting, browser registry build probe and dedicated AST dependency/error-text guards.

## Round 1 fix pass

The renderer follow-ups were merged in `f6e671fd`. Only `PROGRESS.md` conflicted; the resolution retained both progress records. Route generation produced no route-tree change. The per-finding record is [the implementation fixes log](../specs/reviews/05-routines-artifacts-library-settings.impl-fixes-r1.md).

All 18 review findings have behavioral regression coverage. Four repairs were already present in the continuation: editor remounting, MCP scope cleanup, the 190 px aligned artifact window, and side-panel action metadata. Removal checks failed for each. New repairs cover stored-key sign-out, parsed form resets, failed connector responses, retained global routine subscriptions, direct setup settlement, remote unlink, MCP outcomes, counter freshness, install retries, appearance consumers, Stop bindings, affected-context conflicts, late artifact observation and explicit global skills scope.

The cross-owner API requests are closed. The root consumes the global end-action API; routine producers use typed kind metadata and the shell owns click routing; Models consumes public draft adoption and returns to its requester; backend events invalidate backend/sandbox queries. Incoming chat tests verify the public local-model entry callbacks and disk skills baseline fallback. Bot/session route owners still need to supply those props at their excluded composition sites; this pass does not claim those call sites changed.

Required Electron computed-style coverage verifies transcript/composer text size and bubble tint using real preferences. The test failed in a build without the new stylesheet and passed with it. The obsolete main-serial artifact filter expectation now uses `type=file`; only test source changed in main.

## Remaining acceptance work

1. **Acceptance coverage still incomplete:** one-source invalidation counts; collection failure/rollback matrix; every schedule/template field state; report switching and connector ask lifecycle; all platform/import/OAuth/skills mutations; rendered settings-search bijection; complete shortcut/quiet-hours tables; full motion choreography and §27 state galleries. Auto-reply grants without a conversation still use inline actions rather than the specified row-menu entry.
2. **Native gate remainder:** preference restart and legacy theme/language parity, artifact reveal, scheduled-no-fire assertion, update fake-feed progression, explicit Sheet transition case and Windows launch-at-login/density hardware run.
3. **Translations:** keymap reuse is complete for existing matching copy, but new phase-5 copy remains largely English fallback. Of 503 phase5 leaves, 422–431 are byte-identical to English in each non-English locale (includes labels/proper names). Do not treat locale synchronization as completed translation.
4. **Phase 6:** Replay tour remains deferred to its owner. Sound's one-context consolidation is now implemented here; it is no longer an outstanding phase-5 sound-engine request.

## Round 1 validation

- Desktop direct TypeScript, route generation and production gallery build passed. Route generation left the generated tree unchanged.
- Final full renderer-next/main/shared run: **403 files passed, one skipped; 4,058 tests passed, seven todo, no unhandled errors**. The initial full run exposed a Messaging cleanup rejection; the repair passed 12 targeted tests before full confirmation.
- Required main-serial full run: **nine files passed, one failed; 293 tests passed, one failed**. The failure was test isolation: appearance coverage left the shared app on the gallery route before reconnection coverage expected the shell. Restoring the route made the entire corrected file pass **11/11**. Combined evidence covers all **294 tests across ten files**, with no full second main-serial run claimed. The obsolete deck-filter expectation is fixed.
- All 18 review findings have tests that fail without their fixes. Four were already repaired and received removal checks. Required native appearance coverage failed with its stylesheet removed and passed after restoration.
- Root lint and formatting passed. Lint retains seven legacy warnings. Registry matches 42 files; legacy-diff, knip, i18n and locale checks passed, with two existing knip hints and all 2,735 locale leaves synchronized.
- Ownership audit since `f6e671fd` found no chat/bots/sessions/agent/main implementation edits. Main changes are test-only. Historical screenshot, axe and performance evidence below was not rerun in this fix pass.

## Prior continuation validation

- `pnpm install --pm-on-fail=ignore` passed despite installed 12.8.1 versus pinned 12.6.0. Connectors, agent runtime package and updater were built before dist-dependent suites.
- Desktop direct `tsc -b`: passed, including the final source changes.
- Full direct renderer-next/main/shared run, once: **388 files passed, 1 skipped; 3,993 tests passed, 7 todo**.
- Full required main-serial run, once with `ABACUSBOT_REQUIRE_ELECTRON_SUITES=1`: **8 files passed, 2 failed; 291 tests passed, 2 failed**. Targeted retry: **10 passed, 1 failed**; only the obsolete deck-filter case persists.
- Subsequent source changes were checked with targeted runs: routine/library/keymap/accounting **36 tests**, final route/routine/keymap/accounting **33 tests**, routine/structure/accounting **23 tests**, row/parity **90 tests**, and expanded AST/accounting **2 tests**. These overlap; they are not added to the full-run total.
- Root `oxlint .`, `oxfmt .` and `oxfmt --check .`: passed. Later source edits were formatted/linted by targeted file paths.
- Registry: **42 files match**. Knip passes (two configuration hints). i18n/locale/legacy-diff gates pass; all **2,735** locale leaves synchronized. Retired-key file contains **1,140** reasoned retained leaves; dynamic families have source references.
- Production gallery build and DB-fixture gallery build pass with React Compiler enabled. Fixture route test filenames use the router ignore prefix.

## Native evidence

`apps/desktop/e2e/phase5-real.mjs` runs real main against an isolated profile and loopback fake provider, with no fixture DB. It covers ten workflow/budget/sound checks and axe on 18 real layouts. Raw output is `.build/phase5-real.json`; run with `node --experimental-transform-types` after a `VITE_UI_GALLERY=1` production build.

Final native run at `b51797f9`: **10 checks passed; 18 layouts with no serious/critical axe violations**. Recorded in [05-native.json](05-native.json):

| Measurement | Result | Budget |
|---|---|---|
| First artifact paint | 352.80 ms; three-run median 42.82 ms | < 400 ms |
| Median scrolling | 59.88 FPS | ≥ 50 FPS |
| Mounted cards | 44 maximum | ≤ 400 |
| Thumbnail gate | 16 near / 44 mounted; real images decoded | near viewport only |
| Routine-fired synthesis | RMS 0.0052985 | audible, nonzero |

The native AudioContext spy proves two oscillators; exact cue frequencies are covered by synthesis unit tests rather than inferred from the oscillator's initial frequency value.

## R5 test status

“Partial” means evidence covers part of the requested row. “Pass” is reserved for the stated gate. Inherited passes identify main/shared work rather than new renderer implementation.

| ID | Status | Evidence / remaining gap |
|---|---|---|
| R5-T1 | Partial | Seven real-router cases cover new masks, reload, Back, background identity and cold preload. Full route snapshot, background component state/scroll and no-history matrix remain. |
| R5-T2 | Partial | Foundation classifier and native Settings enter/out/lateral pass; complete phase-5 search-key matrix and changelog back case remain. |
| R5-T3 | Partial | Delayed owned snapshots, 22 preload paths with no mutation/hydration, and no premature gone view pass. Run-entry hydration and foreign-run matrix remain. |
| R5-T4 | Partial | Remote deletion closes an open routine editor without an error boundary. Complete run/artifact/MCP deletion-batch matrix remains. |
| R5-T5 | Partial | Owned subscriptions and scope guards are wired; the new exec-backend event invalidates only backend/sandbox query families. The full one-source-at-a-time refetch-count matrix remains. |
| R5-T6 | Partial | State precedence and local-day/future-fire unit coverage pass. Dedicated minute-clock rerender coverage remains. |
| R5-T7 | Partial | Real form writes and row Pause/Resume/confirm pass. Create CONFLICT, BAD_REQUEST field mapping, mutation rollback and all failure toasts remain unproved. |
| R5-T8 | Partial | Real create/edit whitespace saves now navigate without a dirty blocker; discard, two successive remote updates and edited-only save pass. Every preset, template replacement and field blur matrix remain. |
| R5-T9 | Partial | Inherited shared/main parser tests pass. Contract currently exposes CronParseError detail/message, not the requested code-family API; complete round-trip matrix remains. |
| R5-T10 | Partial | Native streamed read-only report, hidden first envelope, timeout folding, retained Activity and resized width are implemented. Failed connector hops, thrown hops and unsuccessful refreshes respond failed with errors. Run-switch hydration and the complete response matrix remain. |
| R5-T11 | Pass | Dedicated AST guard scans owned features/molecules for feature/data boundaries, forbidden imports, window.api and error-text branches; typed file-result discriminants are explicit exceptions. |
| R5-T12 | Pass | Real-memory-transport cases cover trimmed exact-once send, pending disable, restored ten-exchange history and NOT_FOUND/TIMEOUT/INTERNAL_SERVER_ERROR; routine navigation isolates history and drafts, with a failing key-removal check. |
| R5-T13 | Partial | 56 px state identities, shared context/ellipsis actions, real Pause/Resume and delete cancel pass. Exhaustive sidebar states and grant-without-session menu remain. |
| R5-T14 | Partial | Provenance, session-label filters, local-midnight grouping and navigation target tests pass. Full rendered filter/window/source matrix remains. |
| R5-T15 | Partial | Five typed probe cases and native generated-file preview pass. Real directory/reveal/filesRouter matrix remains. |
| R5-T16 | Partial | Deferred banner/dismiss, exact-once settlement, three-minute watchdog and real credential connect pass. Catalogue-wide failure/cancel/Chrome-warning matrix remains. |
| R5-T17 | Partial | Native connector states plus direct Connect closure on Escape, Done and navigation; shared unlink precedes disable and preserves activation on failure. Complete platform pairing/QR/approval/revoke matrix remains. |
| R5-T18 | Partial | Gateway-before-platform flow, dormant credentials, translated field validation and ownership writes are implemented. All platform settings/cancel branches remain unproved. |
| R5-T19 | Partial | Native STDIO MCP lifecycle plus scope loss and stale-server response guards pass. Refresh/restart/OAuth failure and cancellation outcomes are checked. Full rollback/import/OAuth success matrix remains. |
| R5-T20 | Partial | Real untouched-field refresh twice, preserved edit, HTTP(S) validation, visible-transport required fields and unsuccessful operation outcomes pass. Complete args/env and successful OAuth/import matrices remain. |
| R5-T21 | Partial | Merged chat public tests cover disk baseline fallback for absent/empty live skills. Library install invalidation exists; caller-populated baseline and live install-refresh matrix remain. |
| R5-T22 | Partial | Back to the app skips Settings history and returns to the remembered requester. Full nav group/default-target matrix remains. |
| R5-T23 | Partial | Fresh-counter requests are isolated by exhaustion mark; old positive counters cannot clear a later warning. Stored-key sign-out, memory/invite states, installed/downloaded session/bot adoption and draft adoption/return pass. Full page rollback and real picker-to-Settings caller matrix remain. |
| R5-T24 | Partial | Actual mode/device labels, accent folding, dynamic targets and key existence pass. Complete rendered-row/index bijection remains. |
| R5-T25 | Partial | Real recorder/cancel, terminal unbind/reset, all affected conflict contexts and self-registration exclusion pass. Mounted chat Stop honors unbinding/rebinding and focus. Full platform/restart/reserved/conflict-theft matrix remains. |
| R5-T26 | Partial | One shared native AudioContext, preview gate bypass, live attempt dedupe and nonzero OfflineAudioContext routine-fired synthesis pass. Exhaustive kind × level × quiet-boundary table remains. |
| R5-T27 | Partial | Global pill persists across route actions; critical countdown, rejected install, historical-error retry event sequence and installStalled stand-down pass. Complete seed/event/About matrix remains. |
| R5-T28 | Inherited pass | Merged main requirements passed in the full main/shared run. No main implementation was changed in this continuation. |
| R5-T29 | Inherited pass | Merged prefs contracts/provenance passed in the full main/shared run. |
| R5-T30 | Partial | Real light/dark width captures detected and verified the repaired routine row contrast. Full state-token computed ratio table remains. |
| R5-T31 | Pass | Historical native 2,000-row/300-image budget evidence remains; new rendered eviction anchors use the 190 px full-row stride, and an initially empty list observes later resizes. No new performance capture is claimed. |
| R5-T32 | Partial | 18 production real-layout axe checks and width/theme capture matrix; routine contrast fix rechecked in 35 clean captures. Every §27 overlay/state remains unbuilt or untested. |
| R5-T33 | Partial | Isolated Vite browser registry probe rejects Node built-ins; every catalogue entry returns a known connectUi enum. Exact per-entry §12.4 expected-table assertion remains. |
| R5-T34 | Partial | Reduced-motion cuts and existing typed motion imports remain green. Full report/preview choreography and all dedicated motion assertions remain. |
| R5-T35 | Pass | All 2,735 leaves synchronized; static/dynamic/keymap/retained-leaf accounting passes, template/keymap guards pass. This is key accounting, not full translation completion. |
| R5-T36 | Partial | Real-main fake-provider create/run/report/chat edit/pause/artifact preview, credential connect and live-session MCP lifecycle pass. Reveal, scheduled-no-fire proof, preference restart/legacy parity, fake update feed and Windows hardware run remain. |
| R5-T37 | Pass | Dedicated AST feature/molecule boundary guard and post-merge ownership diff audit pass; no chat/bots/sessions/main/agent implementation edits. |
| R5-T38 | Pass | All 89 parity inventory rows name existing consumers and explicit status; ST18 now names a mounted global update action. |
| R5-T39 | Partial | Native one typed transition for Settings in/out/lateral, pane+sidebar groups; none for report, preview and dialogs. Explicit connector Sheet case remains. |
| R5-T40 | Partial | Cold Settings buffers early fires/completions and retains global routines; routine metadata is typed by kind and shell click routing needs no session join. Exhaustive gating/reconnect table remains. |
| R5-T41 | Inherited pass | Merged migration/cron attempt requirements passed in the main run; renderer attempt folding tests pass. |

## Per-item parity inventory

These are the §2 rows, also stored in each owned feature's parity.ts. “Implemented” identifies the implemented consumer, not an assertion that the full end-to-end acceptance row above passed. Partial rows are subject to the remaining work listed above.

| Item | Status | Consumer |
|---|---|---|
| RT1 | partial | `features/routines/index.tsx` |
| RT2 | implemented | `features/routines/index.tsx` |
| RT3 | partial | `features/routines/index.tsx` |
| RT4 | implemented | `features/routines/index.tsx` |
| RT5 | partial | `features/routines/index.tsx` |
| RT6 | partial | `features/routines/index.tsx` |
| RT7 | implemented | `features/routines/index.tsx` |
| RT8 | implemented | `features/routines/index.tsx` |
| RT9 | implemented | `features/routines/index.tsx` |
| RT10 | implemented | `features/routines/index.tsx` |
| RT11 | implemented | `features/routines/index.tsx` |
| RT12 | implemented | `features/routines/index.tsx` |
| RT13 | partial | `features/routines/index.tsx` |
| RT14 | partial | `features/routines/index.tsx` |
| RT15 | implemented | `features/routines/index.tsx` |
| RT16 | implemented | `features/routines/index.tsx` |
| RT17 | partial | `features/routines/index.tsx` |
| RT18 | implemented | `features/routines/index.tsx` |
| RT19 | retired | `features/routines/index.tsx` |
| RT20 | implemented | `features/routines/index.tsx` |
| RT21 | partial | `features/routines/index.tsx` |
| RT22 | implemented | `features/routines/index.tsx` |
| RT23 | partial | `features/routines/index.tsx` |
| RT24 | partial | `features/routines/index.tsx` |
| RT25 | partial | `features/routines/index.tsx` |
| RT26 | retired | `features/routines/index.tsx` |
| AR1 | partial | `features/artifacts/index.tsx` |
| AR2 | implemented | `features/artifacts/index.tsx` |
| AR3 | implemented | `features/artifacts/index.tsx` |
| AR4 | implemented | `features/artifacts/index.tsx` |
| AR5 | implemented | `features/artifacts/index.tsx` |
| AR6 | retired | `features/artifacts/index.tsx` |
| AR7 | partial | `features/artifacts/index.tsx` |
| AR8 | implemented | `features/artifacts/index.tsx` |
| AR9 | partial | `features/artifacts/index.tsx` |
| AR10 | partial | `features/artifacts/index.tsx` |
| AR11 | partial | `features/artifacts/index.tsx` |
| AR12 | partial | `features/artifacts/index.tsx` |
| AR13 | implemented | `features/artifacts/index.tsx` |
| AR14 | implemented | `features/artifacts/index.tsx` |
| AR15 | partial | `features/artifacts/index.tsx` |
| LB1 | implemented | `features/library/index.tsx` |
| LB2 | implemented | `features/library/index.tsx` |
| LB3 | partial | `features/library/index.tsx` |
| LB4 | implemented | `features/library/index.tsx` |
| LB5 | implemented | `features/library/index.tsx` |
| LB6 | implemented | `features/library/index.tsx` |
| LB7 | implemented | `features/library/index.tsx` |
| LB8 | implemented | `features/library/index.tsx` |
| LB9 | partial | `features/library/index.tsx` |
| LB10 | partial | `features/library/index.tsx` |
| LB11 | partial | `features/library/index.tsx` |
| LB12 | partial | `features/library/index.tsx` |
| LB13 | partial | `features/library/index.tsx` |
| LB14 | partial | `features/library/index.tsx` |
| LB15 | implemented | `features/library/index.tsx` |
| LB16 | implemented | `features/library/index.tsx` |
| LB17 | partial | `features/library/index.tsx` |
| LB18 | partial | `features/library/index.tsx` |
| LB19 | implemented | `features/library/index.tsx` |
| LB20 | implemented | `features/library/index.tsx` |
| LB21 | retired | `features/library/index.tsx` |
| ST1 | partial | `features/settings/index.tsx` |
| ST2 | implemented | `features/settings/index.tsx` |
| ST3 | partial | `features/settings/index.tsx` |
| ST4 | implemented | `features/settings/index.tsx` |
| ST5 | implemented | `features/settings/index.tsx` |
| ST6 | partial | `features/settings/index.tsx` |
| ST7 | partial | `features/settings/index.tsx` |
| ST8 | partial | `features/settings/index.tsx` |
| ST9 | implemented | `features/settings/index.tsx` |
| ST10 | partial | `features/settings/index.tsx` |
| ST11 | implemented | `features/settings/index.tsx` |
| ST12 | partial | `features/settings/index.tsx` |
| ST13 | implemented | `features/settings/index.tsx` |
| ST14 | implemented | `features/settings/index.tsx` |
| ST15 | implemented | `features/settings/index.tsx` |
| ST16 | partial | `features/settings/index.tsx` |
| ST17 | implemented | `features/settings/index.tsx` |
| ST18 | implemented | `features/settings/index.tsx` |
| ST19 | implemented | `features/settings/index.tsx` |
| ST20 | implemented | `features/settings/index.tsx` |
| ST21 | implemented | `features/settings/index.tsx` |
| ST22 | partial | `features/settings/index.tsx` |
| ST23 | implemented | `features/settings/index.tsx` |
| ST24 | implemented | `features/settings/index.tsx` |
| ST25 | implemented | `features/settings/index.tsx` |
| ST26 | partial | `features/settings/index.tsx` |
| ST27 | partial | `features/settings/index.tsx` |

## Screenshots

The continuation produced **203 captures** over 23 owned surfaces at 1280/1000/900/800 px, light and dark, plus foundation probes. That first run found 16 routine-text contrast findings and one transient 800 px alignment failure. After the contrast correction, a targeted run produced **35 captures, exit 0**, with zero serious/critical axe findings and passing geometry at all four widths. Other owned surfaces passed in the broader run. This is combined evidence, not a claim that the first 203-capture invocation passed.

- Broad capture record: [HTML](../../../.build/screenshots/f87d0b05/index.html) and [manifest](../../../.build/screenshots/f87d0b05/shots.json).
- Corrected routine capture record: [HTML](../../../.build/screenshots/70d05d03/index.html) and [manifest](../../../.build/screenshots/70d05d03/shots.json).
- These use the real Electron layout with explicitly enabled fixture tables; populated artifact and report gallery data are identified fixtures. Linux native framing is skipped on this macOS host. The full §27 state/overlay gallery and Windows hardware runs are not claimed.
- The earlier 25-capture baseline remains in [05-screenshots](05-screenshots/index.html); it is historical evidence, not the continuation's latest screenshots.

## Continuation commits

First-parent commits after `505d04bf` (incoming renderer fix-pass commits are preserved by the merge, not counted again):

```text
b4b04cc4 merge: integrate renderer chat-kit and bots fixes into phase 5
c2c30209 fix(renderer): restore registry sources and declare public API entries
f1749668 fix(renderer): replay registry additions in canonical order
10c68221 fix(routines): close deleted editors and verify remote form updates
843886db feat(artifacts): group list days and expose consistent card menus
fe3ec652 fix(library): finish deferred pairing and synchronize scoped MCP forms
14525cce fix(sound): share the native audio engine across players and previews
02ffc485 fix(routines): buffer owned notices until collection snapshots are ready
9864598a fix(settings): record logical shortcuts and support per-context unbind
2a622645 fix(settings): complete data states and test update and credits recovery
e072efb9 test(routines): exercise editor chat through the real memory transport
a7e710d8 test(artifacts): add a 2000-card native performance fixture
5a68f748 fix(i18n): reuse existing translations for phase five copy
d061a946 fix(settings): search the actual mode and device labels
538eb168 fix(artifacts): size the card window to the native viewport
e6fb0f4f fix(settings): guard pending installs and verify session adoption
dcb8213a refactor(settings): keep keymap data ownership in the feature
f483497a test(i18n): account for runtime families and retained locale leaves
1567953f feat(routines): retain the last report and persist its resized width
ad69b4ae feat(i18n): add translated server and invite validation copy
8335c844 fix(library): validate visible MCP fields and translate runtime states
d6dfb54b fix(settings): validate invite recipients and isolate channel selections
031cca6a test(routes): cover phase five masks, reloads and cold preloads
0b9ebf3f feat(settings): expose update pill states and verify critical countdown
1fb61b3d test(phase5): record real-main workflows, layout axe and native budgets
7cc3e624 fix(keymap): respect terminal context and fixed live sequence conflicts
c1c4bd68 feat(routines): add state identities, row menus and expandable instructions
09798f12 fix(routines): reuse valid expansion labels and show pending webhook state
b29662b5 fix(renderer): retain merge fixture state across router splitting
f87d0b05 fix(gallery): use the valid phase five fixture search in captures
70d05d03 fix(routines): preserve row contrast and distinguish owned folders
b51797f9 test(phase5): guard error-text branches and renderer import boundaries
```
