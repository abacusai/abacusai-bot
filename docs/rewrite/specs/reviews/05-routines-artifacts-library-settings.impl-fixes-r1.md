# Phase 5 implementation fixes, round 1

Review source: `05-routines-artifacts-library-settings.impl-codex-r1.md`. Target: spec r3. Branch: `codex-phase5`. Incoming renderer APIs were merged in `f6e671fd`; the only conflict was the phase-5 progress row, resolved with both sides' evidence. Prerequisite package builds, route generation, desktop TypeScript and 437 targeted tests passed for the merge.

The rows below distinguish new repairs from repairs already present in the continuation. Regression tests exercise behavior. Existing repairs also receive removal checks before final validation. Full R5 acceptance remains separate from closing a review finding.

| Finding | Status | Repair and regression evidence |
|---|---|---|
| 1 | Fixed | Account queries settings and gates both sign-out and other-key deletion with `canSignOutOfAbacus`. Stored Abacus key, other stored key, and no stored key cases in `settings/pages.test.tsx`. |
| 2 | Fixed | Create and edit reset the form to parsed values after persistence. Whitespace create and remote-edit tests assert navigation, and failed before the repair. |
| 3 | Fixed before this pass | `EditorChat` already has `key={row.id}`. Navigation test checks distinct stored histories and a cleared draft. Removing the key failed the navigation test. |
| 4 | Fixed | Failed connector hops, thrown hops, and unsuccessful MCP refresh settle the tool request with its error. Three rendered request-card tests failed without the repair and passed with it. |
| 5 | Fixed | Global routine and session subscriptions retain collections; readiness buffers events through hydration. Cold Settings test holds the routine snapshot, checks fire/completion delivery, subscription count and subsequent live updates. Subscription-count assertion failed before repair. |
| 6 | Fixed | Direct setup registers with the shared flow and settles after setup completes. Escape, Done and navigation each disable an unfinished WhatsApp setup exactly once. All three tests failed before repair. |
| 7 | Fixed | Remote shared unlink precedes local disable and updates the snapshot. Failure leaves activation intact and appears in the confirmation. Both tests failed before repair. |
| 8 | Fixed before this pass | Scope disappearance clears runtime/logs; obsolete snapshot requests are guarded by abort and log requests by lifetime. Rendered two-session test checks late server response and scope loss. Removing the cleanup/guard failed the test. |
| 9 | Fixed | Refresh and restart inspect unsuccessful outcomes; OAuth skips refresh on cancellation/failure. Rendered operation tests check error versus success notices and refresh counts. Removing the outcome handling failed all four operation tests. |
| 10 | Fixed | Account counter requests force `refresh: true`, key each exhaustion mark separately, and compare the response timestamp with the mark. A mounted-page test prevents old positive counters clearing a later mark, then releases the fresh response. Failed before repair. |
| 11 | Fixed | Installing events discard historical failure fields; retry clears historical failure at the transition. The critical-dialog event test retains its disabled Restarting state and removes the old error. Failed before repair. |
| 12 | Fixed | Scoped CSS consumes chat text size and bubble tint for transcripts and composers without chat-source edits. Required Electron test writes real prefs and checks computed font sizes and the user bubble color. The test failed on text size in a build with the stylesheet removed, then passed after rebuilding with it. |
| 13 | Fixed | The shared hotkey wrapper resolves the kit's legacy Stop chord to the `stop-run` action through root-provided live bindings. It retains the kit's busy/focus guard and one handler. Actual key-event tests check null, rebound, old chord, and unfocused views. The focused test failed without the wrapper repair. |
| 14 | Fixed | Shared window actions check terminal defaults and reserved keys too. The collision and reserved-key tests fail with the old validator. |
| 15 | Fixed before this pass | Rendered eviction test checks the first complete row and its spacer with the 190 px stride. Changing the stride to 180 px failed the test. |
| 16 | Fixed | Observation follows viewport appearance. The initially empty snapshot test inserts an artifact, resizes twice and checks rendered column counts. Restoring the one-shot effect failed the test. |
| 17 | Fixed | Explicit `workspace=global` survives navigation and bypasses the remembered workspace. The test inspects actual `listInstalled` input. Restoring the missing scope failed the test. |
| 18 | Fixed before this pass | Recorder test saves the action's existing chord without a self-conflict. Removing its action metadata failed the test. |

## Cross-owner integration

- The root registers the update action through `useTopBarEndActions`. Its regression navigates across route-owned actions and installs through the surviving global control.
- Routine producers send typed `kind: "routine"`, `routineId`, and `sessionId`. The shell's merged kind router owns clicks; the duplicate routine click subscriber is removed. Tests inspect producer metadata and navigation without a session join.
- The Models route calls public `adoptDraftModel` and returns to the remembered requester. Its test preserves text/mode and verifies the adopted model and return location. Existing session/bot adoption tests remain.
- Library globals invalidate backend and sandbox queries on the new exec-backend event. The test checks query families and excludes model invalidation.
- Merged chat public tests cover `onUseLocalModel` in both entry widgets and disk `skillsBaseline` fallback. The missing-API requests are closed. Bot/session owners still need to pass these props in their own route composition; this pass does not claim those excluded call sites were changed.
- The obsolete main-serial `type=deck` expectation now uses `type=file`. Only test source changed in main.

## Validation

- Merge: route generation, prerequisite builds, desktop TypeScript and 437 targeted tests passed.
- Ten removal-check failures across eight files prove the already-present repairs and the final context fixes. All four MCP outcome tests failed with the old handling restored. The separate create/edit, connector request, messaging, credit/update, Stop and required Electron appearance checks also failed without their repairs.
- Latest focused checks: 33 regressions, followed by 21 pre-commit tests and 16 final library/Stop/cross-API tests, all passed. These overlapping runs are not added into a total.
- Full suites, gates and final counts pending.

