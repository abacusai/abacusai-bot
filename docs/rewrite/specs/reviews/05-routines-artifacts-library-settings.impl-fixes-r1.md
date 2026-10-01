# Phase 5 implementation fixes, round 1

Review source: `05-routines-artifacts-library-settings.impl-codex-r1.md`. Target: spec r3. Branch: `codex-phase5`. Incoming renderer APIs were merged in `f6e671fd`; the only conflict was the phase-5 progress row, resolved with both sides' evidence. Prerequisite package builds, route generation, desktop TypeScript and 437 targeted tests passed for the merge.

The rows below distinguish new repairs from repairs already present in the continuation. Regression tests exercise behavior. Existing repairs also receive removal checks before final validation. Full R5 acceptance remains separate from closing a review finding.

| Finding | Status | Repair and regression evidence |
|---|---|---|
| 1 | Fixed | Account queries settings and gates both sign-out and other-key deletion with `canSignOutOfAbacus`. Stored Abacus key, other stored key, and no stored key cases in `settings/pages.test.tsx`. |
| 2 | Fixed | Create and edit reset the form to parsed values after persistence. Whitespace create and remote-edit tests assert navigation, and failed before the repair. |
| 3 | Present, regression added | `EditorChat` already has `key={row.id}`. Navigation test checks distinct stored histories and a cleared draft. Removal check pending. |
| 4 | Fixed | Failed connector hops, thrown hops, and unsuccessful MCP refresh settle the tool request with its error. Three rendered request-card tests failed without the repair and passed with it. |
| 5 | Fixed | Global routine and session subscriptions retain collections; readiness buffers events through hydration. Cold Settings test holds the routine snapshot, checks fire/completion delivery, subscription count and subsequent live updates. Subscription-count assertion failed before repair. |
| 6 | Fixed | Direct setup registers with the shared flow and settles after setup completes. Escape, Done and navigation each disable an unfinished WhatsApp setup exactly once. All three tests failed before repair. |
| 7 | Fixed | Remote shared unlink precedes local disable and updates the snapshot. Failure leaves activation intact and appears in the confirmation. Both tests failed before repair. |
| 8 | Present, regression added | Scope disappearance clears runtime/logs; obsolete snapshot requests are guarded by abort and log requests by lifetime. Rendered two-session test checks late server response and scope loss. Removal check pending. |
| 9 | Fixed | Refresh and restart inspect unsuccessful outcomes; OAuth skips refresh on cancellation/failure. Rendered operation tests check error versus success notices and refresh counts. Removal checks pending. |
| 10 | Fixed | Account counter requests force `refresh: true`, key each exhaustion mark separately, and compare the response timestamp with the mark. A mounted-page test prevents old positive counters clearing a later mark, then releases the fresh response. Failed before repair. |
| 11 | Fixed | Installing events discard historical failure fields; retry clears historical failure at the transition. The critical-dialog event test retains its disabled Restarting state and removes the old error. Failed before repair. |
| 12 | Pending | Chat appearance consumers. |
| 13 | Pending | Stop action binding consumer. |
| 14 | Pending | Conflict checks in all affected contexts. |
| 15 | Present, regression pending | Grid stride is already 190 px and the window aligns complete rows. |
| 16 | Pending | Resize observer after an initially empty list. |
| 17 | Pending | Explicit global skills scope. |
| 18 | Present, regression pending | Toggle side panel already registers `actionId`. |

Cross-owner API wiring, the obsolete deck-filter test correction, final checks and test totals are pending.
