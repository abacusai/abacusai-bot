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
| 8, major | Fixed | Lazy children use bounded query-cache entries per checkout/directory/root revision, replace results on invalidation and are removed when unused. Hook regression covers replacement, root refresh, A/B isolation and the 50-directory limit. |
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

Removed safeguards temporarily, ran their targeted tests, and restored each source in a finally block. All 25 mutation checks fail by assertion, covering findings 1–21, additional lazy-cache identity and native-owner cases, joined readiness and exec events. The extra lazy-cache identity mutant initially survived an immediate empty-data assertion; the strengthened test now checks that no query is created for the old directory after root/checkout changes and detects it. Both original file-tree tests also fail against the pre-fix component. No mutated code remains.
