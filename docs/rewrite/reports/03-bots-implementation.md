# Phase 3 bots implementation

1 October 2026. Worktree branch `worktree-agent-a2f588ede14ebf525`. Specification: [03-bots.md, r3](../specs/03-bots.md), including all three review-response tables and §24.

The renderer implementation is committed and its executed checks pass. Phase 3 is **not accepted as complete**: accessory storage, the shared-library migration, the phase-4 browser surface and several acceptance variants remain. The tables below distinguish implementation from acceptance coverage.

## Commits

| Commit | Change |
|---|---|
| `937ab9c6` | Merge `rewrite/renderer` before continuing implementation. |
| `4aea214f` | Review and retain the interrupted implementer's sound data, sidebar, notices and turn-decoration work. |
| `5155961b` | Setup, staged persistence, routes, check-ins, sender chats and side panels. |
| `d962fa81` | Separate chat fix: legible bot gap stamps on inset surfaces. |
| `5291aec6` | Separate chat addition: composer expansion includes focus. |
| `f927daa1` | Separate chat addition: model-popover focus keeps the composer expanded. |
| `8adc7936` | Collection recovery, connector notices, model interactions, accessibility, memory/files, parity inventory and tests. |
| `c8f33682` | Native keyboard row-menu fix and two regression cases. |
| `ffd8217b` | Real-main acceptance driver and dev-only transport/navigation hooks. |
| `084d571b` | Product copy for unavailable accessory choices. |

The interrupted implementer's earlier commits `fe821e9e` and `46618cca` supply the avatar/look/connector marks and immutable template/check-in/schedule ports. Its separate chat decoration fix is `9307bad2`.

## Implementation status

| Requested item | Status and consumer |
|---|---|
| Routes (§5) | Implemented under `routes/_shell/(bots)`: one bots parent; index redirect; start/setup; bot chat; `?tab=details/memory/files`; unnested editor and sender/run chats; masked check-in; legacy Details redirect. |
| Sidebar | One keyed row parent across groups, needs-you aggregation, pins, search, strip, shared context/dropdown actions, unread and status text. Navigation lets the foundation infer the transition. |
| Data and loaders | Loaders preload their dependencies, block stale reloads and avoid opening/hydrating on intent preload. Concurrent opens are deduplicated. Parent collection errors have an in-shell Retry. Creation records persistence stages. Delete navigates first and treats remote NOT_FOUND and local DeleteKeyNotFoundError as success. |
| Form | Real TanStack Form 1.33.5 with valibot; parsed submit output; blur-gated errors; remote updates use all three suppression options and preserve edited fields. Compact setup uses a 72 px avatar and look popover. Typed errors use code/data. |
| Templates and model-facing strings | 44 templates and renderer-next helper ports, checked against captured immutable legacy fixtures. Shared migration remains outstanding. |
| Avatar/accent | 24 shapes, 18 moods, accessories rendered by the molecule, unsigned hash shift, fixed legacy maps, WCAG foreground choice, custom colours and light-theme boundary. Persistence of accessories remains blocked; unavailable accessory choices are disabled with explanatory copy. |
| Models | Nullable bot model from form, Details and composer; configured fallback resolver; per-provider groups, search, favourites via prefs patch, fixedMode, a single layoutId and reduced-motion cut. Both chip and Details write the bot row. |
| Check-ins | Oldest exact-prompt routine; ownerless run sessions joined by routineId; enabled independent of schedule; pause-only writes enabled only; staged retry reuses persisted routine; announcements only for relevant changes. |
| Chat ports (§11) | Bot decorations supply turn-level deliverables, reactions, silent-turn suppression, gap stamps and account-gated feedback. File previews and contextual Reveal use the session workspace. Connector request flow refreshes MCP before answering, restores snapshots after reopening and aggregates asks per session. |
| Read-only chats | Channel, sender, check-in run and deleted-workspace states. Sender Pause/Resume is disabled without userId. Retained chats of a deleted bot render BotGone. |
| Notifications | `features/bots/notify.ts` consumes authoritative ai.runFinished; no completion inference from row diffs. Ephemeral unread, per-bot and quiet-hours gates, visible/focused suppression, needs-you cues, shared sound player and 600 ms reactions. |
| Identity | useSharedElementName on setup/create and editor/save; scroll docking fades and exposes one accessible identity. Bot-to-bot navigation uses the foundation's ordinary transition. |
| i18n | Additive locale keys only, keymap sources verified across all 11 locales, 2,222 keys in each locale. New copy without existing translations currently uses English fallback text. |
| Accessibility/gallery | Named controls, in-tree Retry, dialog descriptions, one accessible identity, stronger selected-row text, compact row sizing. Gallery includes sidebar, avatars, connector marks, start/setup, details/memory/files/check-in and golden bot chat. |
| Parity | `features/bots/parity.ts` records all 73 destinations. P32/P36 shared migration, P38 accessory storage and P53 URL surface are partial; P46 deferred to phase 6; P8/P9/P26 retired by the spec. Destination/status checks do not constitute a manual demonstration of every row. |

## Checks executed

- Desktop `tsc -b` passes; React Compiler remains enabled. No manual memoization was added.
- Root oxlint passes with seven existing legacy-renderer warnings and zero errors. Root formatting and renderer-next Knip pass. Knip treats the chat, bots and transport public indexes as entry points; deliberately reusable schedule exports carry `@public`. Internal unused exports were removed rather than broadly suppressed.
- i18n guard, locale sync, legacy-diff and UI-registry checks pass. All 41 registry files match the write-gated snapshot. No UI-registry source was edited.
- All 24 tracked NDJSON goldens are byte-identical to merge baseline `937ab9c6`.
- Built connectors, agent distribution/runtime package and updater before distribution-dependent tests. Agent/main test environments unset ABACUS_API_KEY and ROUTELLM_API_KEY.
- Full requested Vitest run, with `ABACUSBOT_REQUIRE_ELECTRON_SUITES=1`, ran once: **351 files, 3,898 tests; 3,877 passed, 14 failed, 7 todo, one file skipped**. Failures were stale shell placeholder assertions, plural base keys, bot collection failure escaping the pane, and a forced lateral sidebar transition. All were fixed. Affected reruns passed **34 shell/i18n tests** and **10 required Electron tests**, so all 3,891 runnable tests have passed across that full run and the affected reruns. This is not a claim that the initial full run was green.
- Final targeted renderer run passes **202 tests in 20 files**. After the explicit keyboard-menu fix, its affected interaction file passes **8 tests**, including two new keyboard cases.
- Real-main smoke uses Electron 44, an isolated temporary profile, real DB/transport and a loopback fake provider. It verifies template creation, weekday routine persistence, shared identity on create/save, single model value on composer expansion, model change reaching the next provider request, App default after stopping/restarting the agent, ownerless check-in attention/Details/read-only routing, memory deletion and bot deletion preserving the routine. The final run passes **11 checks**, including native ContextMenu and Shift+F10. Results are saved under `.build/bots-real.json`.

## R3 acceptance coverage

Consolidated files replace some filenames proposed by the spec. “Partial” means the executed tests cover the listed behavior but do not prove every variant in the spec's row.

| ID | Runs where / actual tests | Coverage |
|---|---|---|
| T1 | renderer-next `router.test.tsx`, shell tests; typecheck | Generated route snapshot, boundaries, mask/background identity and redirects pass. Bot-specific reload/draft/scroll assertions are partial. |
| T2 | renderer-next navigation transition tests; main-serial renderer Electron test | Foundation transition rules and actual new→bot forward transition pass. |
| T3 | renderer-next bots `data/data.test.ts`; foundation transition tests | Preload avoids open/hydrate; concurrent opens deduplicate. Exact delayed snapshot/hydrate matrix and routed Retry variants are partial. |
| T4 | renderer-next data + interactions | Unknown/retained sender guards, navigate-before-delete, live BotGone pass. |
| T5 | renderer-next `data/invalidation.test.ts` | Real collections and memory transport exercise derived invalidation sources, including rename/session insert. |
| T6 | renderer-next `data/data.test.ts` | Forever/sender and ownerless routine join pass. Exhaustive live memory/files mutation matrix is partial. |
| T7 | renderer-next data + form tests | Collection echoes, equal patch, delete idempotency, duplicate naming, staged persistence pass. Every typed error/rollback variant is partial. |
| T8 | renderer-next avatar + `lib/theme.bots.test.ts`; screenshots | High-bit hashes, legacy maps, custom colours and contrast calculations pass. Theme calculations plus screenshot contrast checks cover boundaries; every requested composited control is not individually asserted in jsdom. |
| T9 | renderer-next `lib/bots/{templates,check-in,schedule}.test.ts` | Immutable fixtures and cron ports pass. Shared helpers and legacy re-export half cannot run until the shared migration. |
| T10 | renderer-next `form/form.test.tsx` | Actual FormApi dynamic-validation timing, suppressed remote updates, trim output, custom colour and mapped legacy patch pass. Full routed leave-prompt and all successive edited/blurred-field variants are partial. |
| T11 | renderer-next `structure.test.ts`, existing guards | AST import boundaries, no forbidden avatar deps and no error-message branching pass. |
| T12 | renderer-next data + notify tests | Per-session attention and ownerless routine cases pass. Full precedence-pair and sidebar/avatar rendering table is partial. |
| T13 | renderer-next interactions + shell tests | Actual row DOM identity survives pinning and needs-you group moves. All search/strip/order/stamp variants and animation recording are partial. |
| T14 | renderer-next interactions; Electron real-main driver | Context and dropdown actions match; focused-row contextmenu, native ContextMenu and Shift+F10 open the menu. An explicit row keyboard handler fixes the macOS native path. Channel menu and pause variants remain partial. |
| T15 | renderer-next notify + data tests | Terminal notice without busy row, resync interval, focused/visible suppression, clear and ephemeral store pass. |
| T16 | renderer-next form tests and routed start/gallery | Stable draft ID, template replacement and prefill pass. Connector/category ordering is unit-tested in template helpers; complete Back/Enter UI matrix is partial. |
| T17 | renderer-next form tests | Stages prevent repeat insert; pause/schedule preserve enabled; edit mission announcement/trim output pass. Complete conflict/readiness/resume/announcement matrix is partial. |
| T18 | renderer-next form tests and check-in gallery axe | Field and draft semantics are exercised. Full dialog keyboard/save/custom-preservation matrix is partial. |
| T19 | renderer-next bot-turns + decorations tests; main feedback suites | Live/migrated turn derivation, reactions, presentation precedence, one card per turn, delegation-only visibility and feedback IDs pass. Full DOM feedback-click matrix is partial. |
| T20 | renderer-next interactions/data/preview; real-main smoke | Channel readonly/model, deleted bot, ownerless check-in, workspace path routing pass. Full sender banner/pairing/root matrix is partial. |
| T21 | renderer-next structure/i18n keys; locale scripts | English keys and all 11 keymap sources pass. |
| T22 | renderer-next gallery `a11y.test.tsx`; screenshot accessibility checks | 15 pages/sections plus identity exclusivity pass. jsdom axe disables contrast; browser screenshots run contrast. Every open-overlay permutation is partial. |
| T23 | renderer-next `notify.test.ts` | Completion and gate tables, burst throttling and synthesis scheduling pass. OfflineAudioContext audible-output assertion remains unimplemented. |
| T24 | renderer-next model groups/interactions; typecheck; real-main smoke | Nullable binding, four model locations, open-popover stability, provider groups and real next-provider request pass. Complete favourite/default-with-missing-credentials UI matrix is partial. |
| T25 | Electron `e2e/bots-real.mjs` | Single model value at 1280 is asserted. 1000 drawer, animation recording and native reduced-motion variants remain. |
| T26 | Electron `e2e/bots-real.mjs`; navigation tests | Shared identity groups on create and save pass. Delayed-start/hydrate 1 s and all negative-group native variants remain. |
| T27 | renderer-next BotAvatar/notify tests; `tsc -b` | All shapes/moods/accessories render, 600 ms reaction reset and pinned motion types pass. |
| T28 | existing main bot-model/errors/run-finished suites in full run | Main-owned changes are inherited and tested, never edited here. Accessory round-trip remains unavailable. |
| T29 | renderer-next `structure.test.ts` | AST feature/molecule boundary checks pass. |
| T30 | renderer-next `structure.test.ts` | All 73 ordered IDs have existing destinations and explicit statuses. Partial statuses remain visible. |
| T31 | Electron real-main driver | Template/routine, provider models, restart/default, run attention/Details/readonly, forget and delete provenance pass. Connector-resume and legacy-generation roundtrip remain. |
| T32 | renderer-next `chat/connector-requests.test.tsx` | Snapshot/live/cleared/reopen, conversation scoping, fields, MCP-before-respond, failed refresh and stopped-agent behavior pass. Native fake-MCP next-tool case remains. |
| T33 | renderer-next file-preview + bot preview tests | Workspace resolution/guest containment/type classification and scoped preview-open pass. Browser URL display awaits phase 4. |

## Remaining work and limits

1. **Accessory storage (§24.3).** Main and shared types omit avatarAccessory; main's field filter discards it. The user forbids changes to these directories. Renderer support cannot make it round-trip. The picker disables the unavailable values so saving does not silently discard a selection.
2. **Shared migration (§24.9).** The user restricts shared and legacy renderer edits. The renderer-next libraries and immutable fixture oracle are in place, but shared modules and old-file re-export shims remain for a separately authorized slice.
3. **URL preview (§24.13/P53).** Links select the browser tab, but phase 4 owns its browser runtime surface and URL handoff. File previews work now.
4. **Acceptance variants above.** Consolidated automated tests cover the core paths; the entire R3-T1…T33 matrix has not been implemented. Native drawer/reduced-motion/animation recordings, delayed hydrate identity, native MCP next-tool continuation, OfflineAudioContext output, every parity row demonstrated manually and the legacy-generation roundtrip remain. These are verification gaps, not green results.
5. **Translations.** Existing translated keys were reused through the keymap. New English copy needs translation review in the ten other locales.
6. **Screenshots.** The requested 1280 light/dark views are captured: **25 captures**, zero screenshot/accessibility failures, in `.build/screenshots/084d571b`. The spec's broader 1000/900/800 canvas matrix remains. Generated captures live under `.build/screenshots`; they are artifacts, not tracked source.

No main, shared or agent source changed. The only chat edits made while continuing this task are the three separate commits listed above. The previous implementer's required decoration fix remains in its original separate commit.

## Renderer consumers for PARITY.md

`PARITY.md` is generated from a shared legacy map and is left byte-identical. Its phase-3 consumers are recorded here rather than editing generated/shared content.

| Rows | renderer-next consumer |
|---|---|
| 46, 49–51 | `features/bots/data/bot-actions.ts`, `data/db` and bots loaders/sidebar |
| 47–48 | `features/bots/data/queries.ts`, `data/live.ts`, sidebar and Details sender rows |
| 52–53 | `features/bots/form/submit.ts`, check-in dialog and `data/open-chat.ts` |
| 155, 158, 160–162 | `features/bots/data/queries.ts`, `panel/bot-side-panel.tsx`, presentational `components/bot-memory-list` |
| 156–157, 159 | Global instructions and global Forget all belong to phase 5 Settings; bot memory does not consume these procedures. |


## Fix pass against spec r3 — 2026-10-01

This section supersedes the earlier limits and acceptance statuses above. Started by fast-forward merging `rewrite/renderer` to `2beb2583` from the main checkout; persisted `Bot.avatarAccessory` support was available before any fixes. All 16 review findings and the title-bar/shared-migration extras are addressed. Per-finding changes, failing-without-fix evidence and commits are in [03-bots.impl-fixes-r1.md](../specs/reviews/03-bots.impl-fixes-r1.md).

### Validation

- Targeted bots/helper/preview run: 21 files, 194 tests passed before the final host-URL guard; the final preview suite passes 12 tests, including that guard. The activity stream test additionally verifies the sidebar running-tool caption.
- Unchanged legacy helper suites: 3 files, 27 tests passed.
- Shared immutable oracle and renderer guards follow-up: 3 files, 25 tests passed.
- Final `vitest run --project renderer-next --project main --project shared --maxWorkers=4`: **352 files / 3,733 tests passed; 1 failed, 1 skipped file, 7 TODOs**. The sole failure is `src/main/dev/legacy-diff.test.ts:185`, which hardcodes `a79707f6` for every allow-list entry. New authorized shim pins use `42612382`; the actual legacy-diff gate passes. Main tests were left untouched under the ownership rule. Initial run also caught a renderer import-guard violation in a migration test; relocating that check to the shared project removed it. Logs: `.build/bots-full-vitest-final.log`, `.build/bots-main-serial.log`.
- `ABACUSBOT_REQUIRE_ELECTRON_SUITES=1 vitest run --project main-serial`: 8 files, **281 tests passed**, no Electron suite skipped. Migration kill-point matrix, filesystem watcher, MessagePort handshake and renderer-next native suite ran.
- Real-main/fake-provider Electron driver: **13 checks at 1280**, **12 at 1000**. `.build/bots-real-1280.json`, `.build/bots-real-1000.json`; native model recordings in `.build/bots-model-morph` (23 frames per width), composited styles in `.build/bots-boundaries.json`.
- Each fix for findings 1–14 and 16 and the title duplication was temporarily removed independently: all 16 regression runs failed. Source restored. `.build/bots-regression-mutations.json` and `.build/bots-mutations/*.log`. Finding 15's native test measures settled computed styles and confirms removing the border rules fails its requirement.
- `pnpm install --pm-on-fail=ignore`, connectors/agent/updater builds, desktop real renderer build, `tsc -b`, root `oxlint .`, root `oxfmt .`, `check:ui-registry`, `check:legacy-diff`, `check:knip-next`, i18n and locale checks completed. Lint has inherited legacy hook warnings and no errors. Knip has two inherited configuration hints and no unused exports. Final formatting/check evidence is under `.build/bots-*.log`.

### R3-T1…T33 execution and remaining gaps

The full project runs execute the available matrix tests, including foundation equivalents where the spec's proposed filenames differ. A passing suite does not certify unimplemented variants listed below.

| ID | Evidence | Result / remaining gap |
|---|---|---|
| T1 | renderer-next `router.test.tsx`, shell tests; typecheck | Generated route snapshot, boundaries, mask/background identity and redirects pass. Bot-specific reload/draft/scroll assertions are partial. |
| T2 | renderer-next navigation transition tests; main-serial renderer Electron test | Foundation transition rules and actual new→bot forward transition pass. |
| T3 | cold `data/data.test.ts` + mounted `readiness.test.tsx` | Cold bots/sessions/routines snapshots block lookup/open/hydration; routed hover-then-click cannot mount the preload result. Concurrent opens deduplicate. Full routed Retry and exact 1 s delay variants remain gaps. |
| T4 | renderer-next data + interactions | Unknown/retained sender guards, navigate-before-delete, live BotGone pass. |
| T5 | renderer-next `data/invalidation.test.ts` | Real collections and memory transport exercise derived invalidation sources, including rename/session insert. |
| T6 | renderer-next `data/data.test.ts` | Forever/sender and ownerless routine join pass. Exhaustive live memory/files mutation matrix is partial. |
| T7 | renderer-next data + form tests | Collection echoes, equal patch, delete idempotency, duplicate naming, staged persistence pass. Every typed error/rollback variant is partial. |
| T8 | avatar/theme units + Electron `bots-real.mjs` | All colour/hash/mapping units pass. 26 actual boundaries measured (13 per theme): dots, selected shape, ten swatches and Create bot. Minimum light contrast 4.58:1, dark fill contrast 6.13:1. Removing borders breaks the native assertion. |
| T9 | shared `bots/check-in.test.ts`, next helper suites, unchanged legacy helper suites | Shared model strings and both describe signatures equal immutable fixture bytes; old shim wiring checked. The three unchanged legacy suites pass 27 tests through the re-exports. Cron cases run through the shared schedule module. |
| T10 | form units + mounted `form/editor.test.tsx` | Successive remote updates, blurred untouched fields, preserved local persona, outgoing patch and Off-after-invalid-time are exercised in the actual editor. Complete routed leave-prompt matrix remains a gap. |
| T11 | renderer-next `structure.test.ts`, existing guards | AST import boundaries, no forbidden avatar deps and no error-message branching pass. |
| T12 | renderer-next data + notify tests | Per-session attention and ownerless routine cases pass. Full precedence-pair and sidebar/avatar rendering table is partial. |
| T13 | renderer-next interactions + shell tests | Actual row DOM identity survives pinning and needs-you group moves. All search/strip/order/stamp variants and animation recording are partial. |
| T14 | renderer-next interactions; Electron real-main driver | Context and dropdown actions match; focused-row contextmenu, native ContextMenu and Shift+F10 open the menu. An explicit row keyboard handler fixes the macOS native path. Channel menu and pause variants remain partial. |
| T15 | notify/data + mounted delayed watcher | Readiness buffering retains terminal notices until bots/routines snapshots exist; last-event resume advances after delivery. Existing interval/resync/focus/ephemeral cases pass. |
| T16 | renderer-next form tests and routed start/gallery | Stable draft ID, template replacement and prefill pass. Connector/category ordering is unit-tested in template helpers; complete Back/Enter UI matrix is partial. |
| T17 | form units + mounted editor + real-main driver | Independently edited schedule/enabled leaves merge with the current routine; accessory create/update round-trips and picker saving pass. Existing staging/announcements pass. Complete typed conflict/recovery matrix remains partial. |
| T18 | renderer-next form tests and check-in gallery axe | Field and draft semantics are exercised. Full dialog keyboard/save/custom-preservation matrix is partial. |
| T19 | actual `ChatView` transcript, bot-turns/decorations + main feedback suites | Bot spoken whitelist applied to the actual transcript; tool permission scaffolding retained. Per-part reaction suppression/streaming hold tested for live and migrated parts; turn-level derivations and main feedback pass. Complete DOM feedback-click matrix remains a gap. |
| T20 | renderer-next interactions/data/preview; real-main smoke | Channel readonly/model, deleted bot, ownerless check-in, workspace path routing pass. Full sender banner/pairing/root matrix is partial. |
| T21 | renderer-next structure/i18n keys; locale scripts | English keys and all 11 keymap sources pass. |
| T22 | renderer-next gallery `a11y.test.tsx`; screenshot accessibility checks | 15 pages/sections plus identity exclusivity pass. jsdom axe disables contrast; browser screenshots run contrast. Every open-overlay permutation is partial. |
| T23 | renderer-next `notify.test.ts` | Completion and gate tables, burst throttling and synthesis scheduling pass. OfflineAudioContext audible-output assertion remains unimplemented. |
| T24 | renderer-next model groups/interactions; typecheck; real-main smoke | Nullable binding, four model locations, open-popover stability, provider groups and real next-provider request pass. Complete favourite/default-with-missing-credentials UI matrix is partial. |
| T25 | four-state jsdom model DOM + Electron at 1280/1000 | Both actual model-value nodes marked in tests; one value asserted before/after focus in all panel/expanded cases. 23 native screencast frames recorded at each width. Native reduced-motion cut verification remains a gap. |
| T26 | readiness routing tests + Electron driver at both widths | Shared identity group on create/save passes; mounted router blocks while open/hydration are held. Exact native 1 s delayed-start/hydrate identity and every negative-group variant remain gaps. |
| T27 | renderer-next BotAvatar/notify tests; `tsc -b` | All shapes/moods/accessories render, 600 ms reaction reset and pinned motion types pass. |
| T28 | inherited main bots/model/errors/relay/feedback suites | Main accessory contract/store/table support merged first; main and renderer round-trip coverage pass. No main source edited. One foundation allow-list test fails because it hardcodes a79707f6 for every entry, including the newly authorized migration pins. |
| T29 | renderer-next `structure.test.ts` | AST feature/molecule boundary checks pass. |
| T30 | renderer-next `structure.test.ts` | All 73 ordered IDs have existing destinations and explicit statuses. Partial statuses remain visible. |
| T31 | Electron real-main driver | Template/routine, provider models, restart/default, run attention/Details/readonly, forget and delete provenance pass. Connector-resume and legacy-generation roundtrip remain. |
| T32 | renderer-next `chat/connector-requests.test.tsx` | Snapshot/live/cleared/reopen, conversation scoping, fields, MCP-before-respond, failed refresh and stopped-agent behavior pass. Native fake-MCP next-tool case remains. |
| T33 | preview units + actual routed PDF/HTML/URL tests | Guest PDF/HTML go through browser.runtime.materializeFile with the viewed session key and hostRoot; local viewer accepts only host file URLs. PPTX renders visual slide geometry and image-only slides. Session URL registry retains destination; placeholder shows it and opens externally. Phase-4 embedded browser surface remains deferred. |

### Screenshots and remaining verification limits

Foundation `screenshots-next.mjs` captured **99 images**, **zero failures**, at **1280/1000/900/800**, light and dark, under `.build/screenshots/02399ff7`. Ten bots routes/gallery fixtures per theme/width plus foundation geometry/window probes. `shots.json`, `axe.json` and `index.html` are the manifest, accessibility results and contact sheet. Initial run sampled an unset band during 800-width startup; unchanged-script retry passed all probes. Original manifest retained at `.build/bots-screenshots-first-shots.json`.

Representative paths:

- `.build/screenshots/02399ff7/bots-chief-of-staff-tab-details@1280-light.png`
- `.build/screenshots/02399ff7/bots-chief-of-staff-tab-details@1280-dark.png`
- `.build/screenshots/02399ff7/bots-chief-of-staff-tab-details@1000-light.png`
- `.build/screenshots/02399ff7/bots-chief-of-staff@900-dark.png`
- `.build/screenshots/02399ff7/bots-new-step-setup-template-chief-of-staff@800-light.png`

Command: `node apps/desktop/scripts/screenshots-next.mjs --widths 1280,1000,900,800 --port 9438 --routes '/bots/new,/bots/new?step=setup&template=chief-of-staff,/bots/chief-of-staff,/bots/chief-of-staff?tab=details,/bots/chief-of-staff?tab=memory,/bots/chief-of-staff?tab=files,/bots/chief-of-staff/edit,/bots/chief-of-staff/check-in,/__ui?fixture=bots-sidebar,/__ui?fixture=bots-chat' --no-overlays`; retry adds `--no-build`. Linux native-frame probe records skipped on macOS; it was not required.

The title-bar capture now has one Details/Memory/Files strip without the extra Details action. Visual spot checks cover the 1280 light/dark Details views and the responsive bands. These fixture captures and native recordings are generated artifacts under `.build`, not tracked application source.

Remaining verification gaps: exact native delayed identity transitions and all negative identity cases (T26), native reduced-motion model cuts (T25), OfflineAudioContext audible output (T23), native fake-MCP next-tool continuation and legacy-generation roundtrip (T31/T32), every typed rollback and overlay variant, complete sender/check-in Markdown root matrix, and manual demonstration of every parity row against every canvas board. Translation review of new English fallback copy remains. These gaps are not reported as passing.

The phase-4 browser surface is intentionally represented by a shell-owned session registry and URL placeholder now; its destination and external action work. P53 remains partial only for the future embedded surface. Legacy edits are exactly the three §24.9 helper shims pinned by the foundation allow-list. No main or agent source changed; the one chat filtering change and both shell changes have separate commits.
