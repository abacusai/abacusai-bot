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
| 7, major | Fixed | Files paths are memoized; equal topology skips reset; changed topology passes expanded directory paths to the installed reset API. Regression covers equal paths and added children without collapse. |

Both file-tree tests fail against the pre-fix component and pass with the fixes. Typecheck passes.

Further findings and final gates will be recorded as they complete. The R4 acceptance matrix remains partial until its entire stated scenario is exercised.

Agent targeted checks: 6 tests pass; typecheck passes.
