# Phase 4 implementation fixes, round 1

Against `04-sessions.md` r3 and `04-sessions.impl-codex-r1.md`. Ownership stays in sessions, its components and shell dock rules. Main source and agent source are unchanged by this pass.

## Integration

Merged `rewrite/renderer` at `5ca86069` into `ad345ea0` as `8a699b21`. The requested renderer branch had advanced beyond `a1c4f7f7`. Kept both PermissionDescriptor and SkillMetadata imports, and the incoming cross-slice progress rows. Regenerated the route tree. Corrected the merge's Node MessagePort type in a main test only. Built connectors, agent/runtime package and updater. Typecheck and 71 targeted tests passed. Existing untracked `.build/` is untouched.

## Findings

| Review # | Status | Change and regression evidence |
|---|---|---|
| 1, blocker | Fixed | FileTreeView recreates its model on checkout identity and retained handlers read current committed props. Mounted router navigates A to B then invokes the retained rename callback. The tree UI is adapted for jsdom; the installed useFileTree and model are real. |
| 2, major | Fixed | Controller identity is an input to its memoized factory, with disposal on navigation. A stopped A to stopped B hook regression starts B and cancels A retries, including under the React compiler. |
| 3, major | Fixed | Restoration records success after switchConversation resolves; Retry repeats restoration; stale completions cannot report or mark success. Rejection, Retry and late rejection tests pass. |
| Main joined readiness | Wired | Auto-start awaits main's joined readiness before restoring the relay incarnation. Test delays the joined promise while the ready relay arrives first. |
| 4, major | Fixed | Created drafts retain the read-only envelope and checkout tray with workspace locked. Mounted app test selects No worktree even without a branch result; stage regression proves explicit detach and no duplicate insert/materialization. |
| 5, major | Fixed | Git watch is scoped to effective checkout key and path; hook test proves old iterator abort and replacement subscription under the same session ID. |
| 6, major | Fixed | Status, root, children, search, branch list/current, PR and diffs carry effective checkout identity. Session/relocation notices invalidate checkout sources and file events invalidate search/children too. Key regression compares attach, detach and relocated paths for every query family. |
| 8, major | Fixed | Lazy children use bounded query-cache entries per checkout/directory/root revision, replace results on invalidation and expire after 60 seconds unused. Hook regression covers replacement, root refresh, A/B isolation and the 50-directory limit. |
| 9, major | Fixed | URL selection dispatches focus and persists last. Mounted dock test navigates to another tab and asserts both values. |
| 10, major | Fixed | Local transition state is tied to the source URL/session and cleared when navigation settles. Mounted dock test toggles full then navigates back to split. |
| 11, minor | Fixed | A vertical root can contain only leaves; regression rejects successive bottom moves that would create three rows. |
| 12, major | Fixed | Preview eviction closes the dock reference in the same store update; empty leaves and active/last references are repaired. A 51st preview regression evicts a sole-leaf active preview. |
| 13, minor | Fixed | Terminal reconciliation repairs the tree/last references and missing URL terminals are normalized once the initial snapshot arrives. Mounted app regression supplies an empty snapshot. |
| 7, major | Fixed | Files paths are memoized; equal topology skips reset; changed topology passes expanded directory paths to the installed reset API. Regression covers equal paths and added children without collapse. |

Both file-tree tests fail against the pre-fix component and pass with the fixes. Typecheck passes.

Further findings and final gates will be recorded as they complete. The R4 acceptance matrix remains partial until its entire stated scenario is exercised.

Agent targeted checks: 6 tests pass; typecheck passes.
