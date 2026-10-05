# Phase 4 implementation fixes, round 1

Against `04-sessions.md` r3 and `04-sessions.impl-codex-r1.md`. Ownership stays in sessions, its components and shell dock rules. Main source and agent source are unchanged by this pass.

## Integration

Merged `rewrite/renderer` at `5ca86069` into `ad345ea0` as `8a699b21`. The requested renderer branch had advanced beyond `a1c4f7f7`. Kept both PermissionDescriptor and SkillMetadata imports, and the incoming cross-slice progress rows. Regenerated the route tree. Corrected the merge's Node MessagePort type in a main test only. Built connectors, agent/runtime package and updater. Typecheck and 71 targeted tests passed. Existing untracked `.build/` is untouched.

## Findings

| Review # | Status | Change and regression evidence |
|---|---|---|
| 1, blocker | Fixed | FileTreeView recreates its model on checkout identity and retained handlers read current committed props. Mounted production router navigates A to B then invokes the retained rename callback through real FilesTab and oRPC. It asserts files.rename receives only B's checkout. The tree UI is adapted for jsdom; the installed useFileTree and model are real. |
| 2, major | Fixed | Controller identity is an input to its memoized factory, with disposal on navigation. A stopped A to stopped B hook regression starts B and cancels A retries, including under the React compiler. |
| 3, major | Fixed | Restoration records success after switchConversation resolves; Retry repeats restoration; stale completions cannot report or mark success. Rejection, Retry and late rejection tests pass. |
| 4, major | Fixed | Created drafts retain the read-only envelope and checkout tray with workspace locked. Mounted app test selects No worktree after creation; stage regression proves explicit detach and no duplicate insert/materialization. |
| 5, major | Fixed | Git watch is scoped to effective checkout key and path; hook test proves old iterator abort and replacement subscription under the same session ID. |
| 6, major | Fixed | Status, root, children, search, branch list/current, PR and diffs carry effective checkout identity. Session/relocation notices invalidate checkout sources and file events invalidate search/children too. Key regression compares attach, detach and relocated paths for every query family. |
| 7, major | Fixed | Files paths are memoized; equal topology skips reset; changed topology passes expanded directory paths to the installed reset API. Regression covers equal paths and added children without collapse. |
| 8, major | Fixed | Lazy children use bounded query-cache entries per checkout/directory, replace results on invalidation and are removed when unused. Root refresh invalidates children without dropping open directories during refetch; errors exclude stale descendants. Hook regression covers replacement, retained expansion topology, A/B isolation and the 50-directory/cache limit. |
| 9, major | Fixed | URL selection dispatches focus and persists last. Mounted dock test navigates to another tab and asserts both values. |
| 10, major | Fixed | Local transition state is tied to the source URL/session and cleared when navigation settles. Mounted dock test toggles full then navigates back to split. |
| 11, minor | Fixed | A vertical root can contain only leaves; regression rejects successive bottom moves that would create three rows. |
| 12, major | Fixed | Preview eviction closes the dock reference in the same store update; empty leaves and active/last references are repaired. A 51st preview regression evicts a sole-leaf active preview. |
| 13, minor | Fixed | Terminal reconciliation repairs the tree/last references and missing URL terminals are normalized once the initial snapshot arrives. Mounted app regression supplies an empty snapshot. |
| 14, major | Fixed | Post-start cancellation guard was already present at merge. Added cleanup as each initialization resource is installed, guarded element ownership and stale error reporting. Deferred-start unmount and partial key-handler failure regressions pass. |
| 15, major | Fixed before this pass; regression added | Merged tree already resolves CSS colors through canvas to RGB hex in the shared Ghostty adapter. Added light/dark token conversion regression; native ANSI/pixel acceptance remains partial. |
| 16, major | Fixed | Local resource IDs include their stable dock owner, with checkout-scoped React keys. File runtimes close on owner cleanup, including late materialization. Mounted workspace regression asserts three distinct stable IDs; browser test asserts separate materialization/close leases. |
| 17, major | Fixed | Surface effect already depended on lease fields at merge. Added equivalent serialized lease regression and made equivalent presenter re-registration retain desired ownership. Presenter regression selects A then updates B without stealing presentation. |
| 18, major | Fixed | FullDiffDialog receives toolKey from the route and keys historical patches on it. Mounted dialog switches edits on the same path and renders the second patch. |
| 19, major | Fixed | Session route passes starting/running state separately from turn busy; trigger and mutation handler both guard it. Open-picker regression locks on an idle running agent and allows mutation after stop. |
| 20, major | Fixed | Fatal player callback already entered the once-only fallback at merge. Added a separate stream abort before disposal/fallback, stopped-stream cleanup, and an actual-player/mounted-device regression for unsupported decoder configuration. |
| 21, minor | Fixed | Key-frame barrier test configures a decoder, resets the barrier, proves a delta is blocked, then proves a key frame resumes decoding. Removing the barrier now fails the test. |
| Main joined readiness | Wired | Auto-start awaits main's joined readiness before restoring the relay incarnation. Test delays the joined promise while the ready relay arrives first. |
| Main exec-backend event | Wired | Shared invalidation bridge invalidates settings.execBackend.get and sandboxSupport on the now-present event. Context tray and its picker share that query. Event-to-key regression passes. |

Both file-tree tests fail against the pre-fix component and pass with the fixes. Typecheck passes.

All 21 findings are addressed. The R4 acceptance matrix remains partial until its entire stated scenario is exercised.

Agent targeted checks: 6 tests pass; typecheck passes.

## Regression failure checks

Removed safeguards temporarily, ran their targeted tests, and restored each source in a finally block. All 26 mutation checks fail by assertion, covering findings 1–21, additional lazy-cache identity and native-owner cases, joined readiness and exec events. The extra lazy-cache identity mutant initially survived an immediate empty-data assertion; the strengthened test now checks that no query is created for the old directory after checkout changes; a further mutant proves root refresh invalidates children while retaining open directories and detects it. Both original file-tree tests also fail against the pre-fix component. No mutated code remains.

The first full suite found one AST guard failure because the terminal element variable was named host. Renamed it to containerElement; the unchanged chat guard and terminal/lazy-cache targeted regressions pass. Root-refresh coverage also caught a usability gap during final inspection, so loaded directories now stay open while their child queries refetch.

## Commits

| Commit | Change |
|---|---|
| `8a699b21` | Merge rewrite/renderer contracts and cross-slice follow-ups |
| `90855f22` | fix(sessions): scope file tree models and preserve expansion |
| `b08a2004` | fix(sessions): scope agent lifecycle and retry restoration after readiness |
| `59ac55a2` | fix(sessions): keep checkout recovery available after materialization fails |
| `d4a0e36c` | fix(sessions): scope checkout queries and bound lazy directory cache |
| `c7b2e411` | fix(sessions): repair dock focus eviction and URL view state |
| `04c32133` | fix(sessions): clean up partial terminal initialization and test RGB themes |
| `3098ed14` | fix(sessions): isolate local viewers and preserve native presentation ownership |
| `86164e64` | fix(sessions): key historical diffs and lock backend changes while running |
| `5d83d9cf` | fix(renderer): invalidate shared exec picker state on backend events |
| `b6f2ae1c` | fix(sessions): abort fatal device streams and strengthen keyframe regression |
| `709de07c` | test(sessions): verify production checkout rename and bounded cache eviction |
| `b79c2e9e` | fix(renderer): refresh sandbox support with backend changes |
| `377d35e2` | fix(sessions): retain open directories while child queries refresh |

## Final validation

- Install with `pnpm install --pm-on-fail=ignore`; connectors, agent/runtime package and updater built through the direct binaries.
- Desktop `tsc -b` passes. Fresh WCO gallery build without fixtures passes.
- Final renderer-next/main/shared run: 3,926 passed, seven existing TODOs; 405 passed files and one skipped file. Four workers limited contention on the shared machine.
- Main-serial with `ABACUSBOT_REQUIRE_ELECTRON_SUITES=1`: all 293 tests and 10 files pass. Total final tests: 4,219 passed, seven existing TODOs.
- Root `oxfmt .` and `oxlint .` pass. Seven legacy renderer hook warnings remain unchanged.
- UI registry: 41 files match. Legacy diff, i18n, locale sync and knip-next pass. Knip has three existing configuration hints.
- All 26 mutation checks detect removed safeguards. No mutations remain in source.
- No main or agent source changes were authored; the only main edit is the merge's MessagePort test type correction. No new chat/bots amendments were needed.
- Existing untracked `.build/` remains outside commits. The full R4 matrix remains partial as recorded in the implementation report.

## r2

Addressed both majors in `04-sessions.impl-codex-r2.md`.

Merged `rewrite/renderer` at `68929470` into `a63ebf31` as `1c8001c9`. The only conflict was `docs/rewrite/PROGRESS.md`. Kept the sessions r1 fix status and the incoming phase-5 r2 completion and phase-6 progress. The route tree was untouched. Install with `pnpm install --pm-on-fail=ignore` completed using the installed pnpm 12.8.1. Desktop typecheck, root formatting and lint passed. All 35 tests in the five changed phase-5 test files passed with two workers.

| Review # | Status | Change and regression evidence |
|---|---|---|
| 1, major | Fixed in `ae36ea19` | Local-file viewers share materialization and lease ownership per transport, conversation, resource, file and root. A pending lease remains available across remounts; the runtime closes only after its final owner releases. Deferred mounted regressions move the same resource between keyed dock leaves, both before and after materialization settles. They also mount a concurrent owner and prove releasing one viewer does not close the shared lease. |
| 2, major | Fixed in `9a1bcd2e` | New terminal tabs register their pending starts before publishing the dock reference. Initializers retain that registration through adapter setup and terminal.start, then release it on success, failure or cancellation before start. Snapshot reconciliation exempts these registrations. They are not persisted, so stale restored terminals still reconcile away. Mounted app regressions open through the dock menu, deliver empty snapshots before adapter readiness and during terminal.start, then settle the start with success or failure. They assert the restored reference disappears, the new tab and URL survive, successful output attaches, and a later snapshot removes the reference after the pending start settles. |

Restored the pre-fix BrowserTab and temporarily removed the pending-terminal reconciliation exemption. All four new regression cases failed by assertion: the preview runtime closed while a replacement owned it, and the new terminal disappeared during initialization. Both production sources were restored in a finally block. No mutations remain.

Final focused validation used the direct binaries. All 12 tests across local-file, local-owners, terminal-pending, panel-tabs, session-dock and terminal-tab passed with two workers. Desktop `tsc -b`, root `oxfmt .`, root `oxlint .` and `git diff --check` passed. Lint reports the same seven legacy renderer hook warnings. Existing untracked `.build/` remains outside commits. The R4 acceptance matrix remains partial.
