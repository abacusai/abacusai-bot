# Phase 5 implementation

Branch: `codex-phase5`, base `33301dc9`. Spec: `05-routines-artifacts-library-settings.md` r3, including both review tables and §31. Main requirements were consumed from the merged implementation; no main, shared, agent, chat, bots, sessions, dock, terminal, browser-surface, file-tree, diff-view or device source was edited.

**Status: partial implementation, not full phase-5 acceptance.** All four areas now have functional renderer surfaces. Dedicated acceptance scenarios and some parity details remain. The inventory below distinguishes implemented consumers from complete acceptance evidence.

## Delivered

- Routines: own collection preloads, searchable sidebar, local-day stats, auto-reply grants from `messaging.snapshot.autoReplies`, Pause/Resume/Revoke, masked 640 px create/edit dialogs, shared cron parser and Next preview, typed schedule errors, parsed writes and dirty patches, discard/template replacement dialogs, attempt history joined to sessions, sessionless outcomes and timeout folding, 420 px read-only run report through the chat kit public API, connector requests with MCP refresh before response, editor chat, global routine attention, event-only fire cues with attempt-id dedupe.
- Artifacts: validated type/from/item/view/sort search, independently searchable session labels, bot/routine/workspace provenance separated from the display label, typed file probes and openPath fallback, shared file preview, lazy image thumbnails, grid/list and bounded 400-card window with spacers.
- Library: registry category tabs including Abacus.AI; shared connect flow with navigate/defer pairing, persisted deferred queue, gateway-first enabling, sheet-close settlement and cancellation; messaging setup, people/grants and QR linking; MCP add/edit/import, scope, logs and management; disk-backed installed skills, marketplace and tools.
- Settings: Personal/Models/Environment/App navigation, Library link, Settings identity, remembered Back to the app target; General, Appearance, Language, Notifications, Keyboard, Memory, Usage, Account, Models, Environment, Browser, Devices, About and Changelog. Preferences use `updatePrefs(patch)`. Density/login item consume typed procedures; models support stored credential removal and local install/use for existing session targets; credits use tier/TTL/fresh-counter guards. Keymaps resolve window/terminal contexts and action metadata conflicts. Critical updates use failedPhase, pause the countdown on failure, reset rejected installs and stand down on installStalled.
- Shared additions: registry checkbox installed through the write-gated add; form-kit additions, sound previews, keymap editor, per-transport completion fanout, locale keys, gallery fixtures and screenshot script coverage. Shell amendments are separate commits.

## Remaining work and change requests

1. **Chat kit public API (other owner):** provide `onUseLocalModel()` on both real entry points and a public draft-adoption API. `for=session:<id>` works through route composition; `for=draft:<key>` validates but deliberately reports that adoption is unavailable. Also expose the query-backed slash-command disk baseline and nonempty-live override. Library disk loading and the fallback selector exist; the kit cannot consume them without an allowed public API amendment. No chat or sessions source was changed.
2. **Foundation global action slot (other owner):** expose a global end slot in title-bar actions so UpdatePill can render and fold into ⋯ without competing with route action registration. About and the critical/stalled globals exist; the ambient UpdatePill remains unimplemented. The current public `useTopBarActions` replaces the complete route action array. This task's shell exception only authorizes the back button, hotkeys and listed needs-you composition.
3. **Main notification metadata (other owner):** the current typed `NotificationMetadata` contains only sessionId/workspaceId, not the spec's kind/bot/routine fields. Routine notifications use the centralized notifyAttention gates and dedupe; routine clicks resolve sessionId through the live routine join. Full kind-based cross-owner click routing requires a contract amendment.
4. **Phase 6 sound owner:** consolidate the existing bots player, routine player and preview player into the one shared audio engine. The API/gates and preview behavior are available; routine-fired synthesis and one-context acceptance are not claimed here.
5. **Registry foundation discrepancy:** check:ui-registry fails for 13 pre-existing UI files: alert-dialog, collapsible, combobox, command, dialog, field, input-group, message-scroller, questionnaire, select, sheet, toast and toggle-group. They have no diff against this worktree's base. The added checkbox matches its recorded registry snapshot. Resolve the original registry/source disagreement in the foundation rather than hand-editing registry parts in this slice.
6. **Unused foundation component:** check:knip-next flags the now-unused public `components/route-sheet/RouteSheet`, after phase-5 dialogs moved to the required registry compositions. Retire or classify that foundation export in its owning slice; there are no new phase-5 unused export findings.
7. **Renderer parity still partial:** artifact list day grouping and full card context menus; exhaustive settings row search indexing; memory loading/error states and full empty-state copy; complete usage empty/error charts; dormant messaging credentials and Chrome-warning copy; MCP untouched-field remote refresh; model/referral validation edge cases; activity/resizable report states and the full motion choreography. Log saving now sends a bounded renderer log dump and tees batches to main.
8. **Acceptance work:** no claim of R5-T31 performance, R5-T36 real provider workflow, or R5-T39 real transition scenario completion. Full §27 state galleries, locale-retired/dynamic-key accounting and non-English translations of new fallback copy remain. New keys are present in all eleven locales with English fallback, preserving existing translations.

## Validation

- Desktop `tsc -b`: passed.
- renderer-next: **89 files, 1,054 tests passed**.
- main + shared + main-serial: **279 files passed, 2 skipped; 3,058 passed, 10 skipped, 7 todo**. Packages/connectors, packages/agent runtime package and updater were built before these dist-dependent suites.
- Root oxlint: passed (existing legacy React hook warnings only).
- Root oxfmt and oxfmt --check: passed.
- check:i18n, check:locales and check:legacy-diff: passed. All 2,739 locale leaves are synchronized; no new bare UI literals.
- Production Electron/Vite screenshot build: passed. React Compiler remains on; its existing skips are confined to the registry toast defaults and the unchanged bots delete dialog.
- check:ui-registry and check:knip-next: failed for the findings above. This is **not** a fully green gate report.

## R5 test status

“Partial” means passing evidence covers only part of that spec row; it does not mean the whole requested scenario passed. Inherited main requirements are marked separately from renderer work.

| ID | Status | Evidence / gap |
|---|---|---|
| R5-T1 | Partial | Partial route snapshot, redirects and existing masked-route harness; not every new mask reload/background case. |
| R5-T2 | Partial | Partial foundation navigation tests; new ranks/boundaries/search-only rules wired. |
| R5-T3 | Partial | Partial own preloads and enter-only hydration; no complete delayed/preload matrix. |
| R5-T4 | Not run / incomplete | Not dedicated: gone states implemented, no complete deletion-batch harness. |
| R5-T5 | Partial | Partial notice invalidation/folding wired; no one-source-at-a-time matrix. |
| R5-T6 | Partial | Partial routine data unit tests for state precedence and midnight/future-fire counts. |
| R5-T7 | Not run / incomplete | Not dedicated: real collection mutation paths implemented; complete failure matrix absent. |
| R5-T8 | Partial | Partial schema/dirty-patch tests plus two real TanStack dialog tests (whitespace and discard). |
| R5-T9 | Partial | Partial inherited parser suites and renderer schedule tests; every CronParseError.code family not verified. |
| R5-T10 | Partial | Partial attempt joining/timeout tests and real ChatView screenshot; full request/stream harness absent. |
| R5-T11 | Partial | Partial existing architecture guards; no dedicated phase-5 AST matrix. |
| R5-T12 | Not run / incomplete | Not dedicated: editor-chat implementation persists ten exchanges and typed failures. |
| R5-T13 | Partial | Partial sidebar screenshot and needs-you/grant implementation; exhaustive states not tested. |
| R5-T14 | Partial | Partial provenance/session-label/filter/target unit tests; day grouping missing. |
| R5-T15 | Partial | Partial five typed probe tests; real filesRouter/directory integration not added. |
| R5-T16 | Partial | Partial shared connect-flow tests for persisted defer and exact-once close; watchdog/real card matrix absent. |
| R5-T17 | Partial | Partial real registry bundle/connectors screenshot; all catalogue states not tested. |
| R5-T18 | Partial | Partial gateway-before-platform connect-flow assertion; dormant credentials remain. |
| R5-T19 | Not run / incomplete | Not dedicated: MCP scope/status/logs and mutations implemented. |
| R5-T20 | Not run / incomplete | Not dedicated: MCP form implemented; complete validation/remote-change matrix absent. |
| R5-T21 | Partial | Partial disk/nonempty-live selector tests; kit slash baseline integration remains a change request. |
| R5-T22 | Partial | Partial real app navigation test proves Back to the app skips Settings history. |
| R5-T23 | Partial | Partial credits tier/TTL/fresh-counter tests and appearance/source integration; not every page action. |
| R5-T24 | Partial | Static cue/terminal index, accent matching and dynamic row target tests pass; complete rendered row/index bijection absent. |
| R5-T25 | Partial | Partial context resolution/conflict unit tests and existing live shell hotkey tests. |
| R5-T26 | Partial | Partial existing sound/notify gates plus routine live-event attempt dedupe tests; synthesis unverified. |
| R5-T27 | Partial | Partial typed update phase/stall tests; complete countdown/pill UI matrix absent. |
| R5-T28 | Inherited pass | Inherited main requirements passed in main/shared/main-serial run. |
| R5-T29 | Inherited pass | Inherited prefs contracts/provenance passed in shared/main run. |
| R5-T30 | Partial | Partial real Electron axe/contrast captures; not every state token. |
| R5-T31 | Not run / incomplete | Not run in Electron. Four 2,000-row window arithmetic tests pass; FPS/paint/image budget unmeasured. |
| R5-T32 | Partial | Partial real Electron axe for captured surfaces; not every §27 overlay/state. |
| R5-T33 | Partial | Partial production registry-containing renderer bundle builds; no isolated Node-built-in probe. |
| R5-T34 | Partial | Partial type-check and reduced-motion cut behavior; choreography tests absent. |
| R5-T35 | Partial | Partial static key/locales guards and unchanged template prompts; full retired/dynamic-key gate absent. |
| R5-T36 | Not run / incomplete | Not run: complete real-main fake-provider workflow remains. |
| R5-T37 | Partial | Partial existing import guards and ownership diff checks; dedicated phase-5 folder matrix absent. |
| R5-T38 | Pass | Passed: 89 inventory rows name existing consumers and an explicit status. |
| R5-T39 | Not run / incomplete | Not run: dedicated Electron typed transition scenario remains. |
| R5-T40 | Partial | Partial existing notifier gates and routine ownership/cancel tests; kind metadata is a contract gap. |
| R5-T41 | Inherited pass | Inherited migration/cron attempt requirements passed in main run; renderer attempt folding tested. |

## Per-item parity inventory

These are the §2 rows, also stored in each owned feature's parity.ts. “Implemented” identifies the implemented consumer, not an assertion that the full end-to-end acceptance row above passed. Partial rows are subject to the remaining work listed above.

| Item | Status | Consumer |
|---|---|---|
| RT1 | partial | `features/routines/index.tsx` |
| RT2 | partial | `features/routines/index.tsx` |
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
| AR13 | partial | `features/artifacts/index.tsx` |
| AR14 | partial | `features/artifacts/index.tsx` |
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
| LB15 | partial | `features/library/index.tsx` |
| LB16 | partial | `features/library/index.tsx` |
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
| ST18 | retired | `features/settings/index.tsx` |
| ST19 | implemented | `features/settings/index.tsx` |
| ST20 | implemented | `features/settings/index.tsx` |
| ST21 | partial | `features/settings/index.tsx` |
| ST22 | partial | `features/settings/index.tsx` |
| ST23 | implemented | `features/settings/index.tsx` |
| ST24 | implemented | `features/settings/index.tsx` |
| ST25 | implemented | `features/settings/index.tsx` |
| ST26 | partial | `features/settings/index.tsx` |
| ST27 | partial | `features/settings/index.tsx` |

## Screenshots

1280 px, light and dark: routines sidebar, 640 px create dialog, run report through the public ChatView fixture API, populated artifact grid through the gallery's injected fixture rows, Library connectors, Settings General and Models. The isolated main database has no artifact outputs, so the populated grid uses gallery data rather than claiming a real routine artifact was generated.

Final capture paths and review notes are appended below after the last capture completes. The script also records collapsed/floating/compact/fullscreen foundation probes. A too-early floating spring measurement was corrected by waiting for the intended left edge before stability measurement; geometry assertions were kept.

## Commits

```text
22f52731 feat(renderer): add phase-5 form composition and keymap context helpers
d9588773 feat(routines): implement attempt history and masked create and edit forms
e680d107 feat(shell): remember the settings exit target and leave in one click
5c9ba083 feat(shell): register live keymap bindings with action metadata
0cc9e322 feat(renderer): add phase-5 controls, completion fanout and locale keys
ee1fb6e7 feat(artifacts): derive source provenance and bound the card window
63e715df feat(library): implement connector pairing, messaging, MCP and skills management
f8e2853e feat(routines): wire read-only reports, connector requests and live attention
b2957df2 feat(shell): merge routine attention into the needs-you slot
0795861e feat(settings): add account, models, environment, updates and preferences pages
198ba813 feat(renderer): mount phase-5 globals and add gallery and screenshot coverage
2830f6c5 fix(renderer): complete memory composition, search targets and screenshot readiness
```

## Final screenshot record

The final Electron run produced **25 captures, exit status 0**, with no serious/critical axe violations. The fourteen requested light/dark surface captures, axe results and geometry manifest are retained in [05-screenshots](05-screenshots/index.html). The manifest's 198ba813 label is the checkout HEAD at capture time; the working tree included the final audit fixes subsequently committed as 2830f6c5.

| Surface | Light | Dark |
|---|---|---|
| routines | [PNG](05-screenshots/routines@1280-light.png) | [PNG](05-screenshots/routines@1280-dark.png) |
| routines-new | [PNG](05-screenshots/routines-new@1280-light.png) | [PNG](05-screenshots/routines-new@1280-dark.png) |
| -ui-fixture-routine-report | [PNG](05-screenshots/-ui-fixture-routine-report@1280-light.png) | [PNG](05-screenshots/-ui-fixture-routine-report@1280-dark.png) |
| -ui-fixture-artifacts-grid | [PNG](05-screenshots/-ui-fixture-artifacts-grid@1280-light.png) | [PNG](05-screenshots/-ui-fixture-artifacts-grid@1280-dark.png) |
| library-connectors | [PNG](05-screenshots/library-connectors@1280-light.png) | [PNG](05-screenshots/library-connectors@1280-dark.png) |
| settings-general | [PNG](05-screenshots/settings-general@1280-light.png) | [PNG](05-screenshots/settings-general@1280-dark.png) |
| settings-models | [PNG](05-screenshots/settings-models@1280-light.png) | [PNG](05-screenshots/settings-models@1280-dark.png) |

The artifact grid and report use explicitly documented gallery fixtures; other captures use the real Electron shell and main transport with isolated fixture tables. Native Linux framing was skipped on this macOS host. The broader §30 width/state matrix is not claimed.
