# Main requirements review r1 fixes

This pass covers `00-main-requirements.impl-codex-r1.md` (18 findings),
`00-main-requirements.impl-claude-r1.md` (32 findings and its test audit), and
cut-over review #9, #10 and #11. Overlaps are fixed once below.

`rewrite/renderer` was merged as `46ecd70b`; the merge at the start of this
continuation returned "Already up to date". All work stayed on
`worktree-agent-a868bb80d389a52b1`. The stopped fixer's hunks were reviewed and
finished. Its model/preview, checkout and routine edits were retained. Cron
history preservation and unknown-destination write blocks needed further work:
malformed entries now retain their positions, and a write whose journal is also
blocked is refused rather than acknowledged with only an in-memory copy.

## Dispositions

C refers to Codex r1; L refers to Claude r1. Tests below exercise the named
failure, with real routers, stores, parsers or repositories where relevant.

| Findings | Status and change | Regression tests |
|---|---|---|
| C1; L1, L4, L13, L18, L19 | Fixed. Discard uses fresh exact-path git status membership, HEAD objects and canonical repository-root pathspecs. Primary subfolder paths are prefixed; checkout-aware rows are made relative to the checkout. Worktrees must have their own git top level. A rename with new content at its source is refused before trashing its destination. Directories, case aliases and internal symlink aliases are refused. Literal POSIX backslashes survive. New files reach Trash before index removal. A later failure is explicitly `partial`. | `rpc/procedures/git.discard.test.ts`: subfolder with mixed-case/space paths and a rename to a leading-dash name; occupied source; directory containing a staged addition; directory replacing a tracked file; internal symlink; wrong case; literal backslash alongside a nested path; missing worktree `.git`; index lock after Trash. Original staged-addition and Trash-failure tests retained. |
| C2 | Fixed together with L19. Checkout containment no longer rewrites literal POSIX backslashes. | The backslash case drives both checkout diff and discard with distinct files. |
| C3; L10, L21 | Fixed. Main derives preview roots from the conversation checkout and recorded workspace artifact folders; requested roots must be contained by an allowed real root. A worktree session cannot name the primary checkout as its root. The native view is replaced when its root lock changes, even for the same file. | `browser.materialize-file.test.ts` calls the real `ServiceHost.localPreviewRoots` and router, refusing `/`, the primary for a worktree, sibling/foreign roots and symlink widening. `electron-browser-runtime.test.ts` checks the narrower root replacement. |
| C4 | Fixed. Both discard destination and rename source honor explicit and unknown migration blocks before any mutation. | `git.discard.test.ts` covers destination, origin and unknown destinations; status and Trash remain unchanged. |
| C5; L12 | Fixed. Cron writes use the shared held-file journal for an explicit blocked destination. Reads see held changes; recovery or the next read replays them. When all destinations are unknown and the journal cannot be written, edits throw before changing the file. | `cron-store.test.ts` performs `recordRun` and `updateJob` against the real block, verifies original bytes and held reads, then lifts the block and verifies replay; unknown blocks refuse the write. |
| C6, C7, C8, C9; L2, L3, L17; cut-over #9 | Fixed by `2f7e6e54`, retained and extended here. The shipped first-commit barrier rejects a renderer that never signals. No host or a destroyed window defers instead of committing. The next window's initial readiness settles the pending activation. Rejected loads and load timeouts consume a bounded retry budget and abandon on exhaustion. Renderer comparisons use the committed version and pending state. Stale swap results are ignored. Activation mutations are serialized. Rejections expire with a new app version or after seven days; unreferenced rejected trees are deleted. | `experience-activation.test.ts` drives the real host with the shipped barrier, restart/rollback, absent/destroyed windows, initial readiness, rejected and never-resolving loads, a second release, late stale results, concurrent commit/activate, expiry and tree deletion. `renderer-host.test.ts` retains the subscriptions barrier cases. |
| C10; L9 | Fixed. Checked RPC, legacy switches and bot repins share a per-session FIFO. Only the head is sent; a model change must match its requested model. A refusal settles that head, leaving other callers pending until their own answers. | `model-switch.test.ts`: concurrent available A/unavailable B, unsolicited rotation, bare/qualified ids, legacy refusal before a checked request, independent sessions, timeout and throwing writes. |
| C11; L7 | Fixed. Pins are serialized per session. Bot and session state are re-read after catalog resolution; stale bot choices are resolved again, and deleted sessions receive no update. | `bot-model.test.ts`: quick edits with reverse-resolution pressure, a bot edit during an awaited resolution, and a session deleted during that await. |
| C12 | Fixed. The real `agent.start` RPC resolves the effective bot model before reading its model/mode and spawning. Explicit overrides retain their documented behavior. | `bot-model.test.ts` calls the real RPC handler with a moved app default and a stale stored pin. Its fake spawn does no repinning. |
| L8 | Fixed. Empty, failed or degraded catalogs keep the stored pin; an authoritative unconfigured row permits fallback. New sessions take the bot/default/cached recommendation when the catalog cannot judge. | `bot-model.test.ts`: empty, thrown and missing-provider catalogs, authoritative credential removal, and new explicit/default/recommended chats. |
| C13 | Fixed. Forgotten or missing sessions reject ingress before thread creation. Deletion retires the identity and clears attention and busy state; buffered output cannot restore it. | `relay-service.test.ts` deletes the session, feeds late permission and run-start output, then verifies an empty attention snapshot and no busy run. |
| C14 | Fixed. Run-finished retention records the last evicted notice's sequence. Older cursors get `RESYNC_REQUIRED`; replay never silently returns an incomplete suffix. | `relay-service.test.ts` emits 1,002 completions and checks cursors before the retained floor, including a gap in the global sequence. Existing run-finished replay/ownership tests retained. |
| C15; L16 | Fixed by `c3713368` and `875ff2a7`. Fallback rechecks focused-thread suppression; early count-bound evictions retain decision tombstones for the cue TTL. Production forgets destroyed webContents. | `notch/cue-arbiter.test.ts` covers focus during the fallback wait, eviction and window removal. The deduplication guarantee is bounded by the documented ten-minute TTL; claiming an expired cue is allowed. An indefinite tombstone for every cue was not adopted. |
| C16 | Fixed. Duplicate ordinals count all identical entries, and existing ids are reserved before deriving missing ids. | `routine-attempts.test.ts` mixes an id-less entry with an identical migrated entry and verifies unique, stable ids. |
| C17; L6 | Fixed. Step 5 recognizes fallback-derived ids and fills only missing session/attempt links without changing ids. A fallback write no longer makes recovery permanently skip those entries. | `005-routine-attempt-ids.test.ts` calls real `recordRun` first, verifies incomplete links persisted, then runs step 5 and checks recovered sessions, timeout links and unchanged ids. |
| C18; cut-over #11 | Fixed by `cc87b6bb`. Completed and incomplete lines share the same size limit regardless of chunk boundaries; incremental UTF-8 decoding and EOF drain remain intact. | `line-splitter.test.ts` checks identical oversized bytes with different chunkings. `cli-manager-taps.test.ts` uses real children and one ordered log to assert fd 3's last line and stdout's last line precede exit. |
| L5, L22 | Fixed. Invalid history entries do not enter classification. Valid routines remain visible. Store writes preserve invalid history values in position; corrupt nonempty job files refuse writes. Step 5 maps only valid entries and leaves others unchanged in every job. | `cron-store.test.ts`: null/missing-result/numeric entries alongside valid history and another routine, edits and new runs without erasure, corrupt-file refusal. Step-5 tests retain malformed entries in migrated and already-migrated jobs. |
| L11; cut-over #10 | Fixed by `fc077346` and `875ff2a7`. Legacy reports are per sender and cleared on destruction, crash and document navigation; main busy is replayed at registration. | `keep-awake.test.ts` covers crash/reload/destroy, multiple reporters and registration while already busy; `agent-busy.test.ts` covers both pipe orderings. |
| L14 | Fixed. Step 1 opts into non-strict enumeration, preserving its prior skip behavior. Step 4 stays strict so unreadable directories cannot authorize orphan archival. | `001-transcripts-v2.test.ts` uses a non-directory transcripts path; existing step-4 EACCES/EIO tests retain strict failure behavior. |
| L15 | Fixed. An acknowledged start is keyed to its process. A new hello retires prior-process starts, and a late exit clears only starts belonging to that process. | `relay-service.test.ts` acknowledges an old run, boots a replacement, acknowledges a new run, and delivers old then new exits while checking busy at each step. |
| L20 | Fixed. Watch and refresh re-resolve the checkout and restart its watcher when the path changes. | `git.discard.test.ts` relocates a watched primary folder, edits the new folder, refreshes, and verifies the new path and change in the row. |
| L23 | Fixed. Timeout matches reserve one session per timeout and prefer failed records. Known completed records are excluded. Start failures recover from the routine's non-editor session records by creation time. | `routine-attempts.test.ts` places failed/completed records together and verifies the second timeout remains unlinked; step-5 tests recover start failures from `local-code.json` and exclude editor sessions. |
| L24 | Fixed for runtime defaults. Every added preference leaf is present, and renderer loading defaults equal main's defaults, including `YOLO` mode. The default literal has a required type for all leaves and sound fields. | `prefs-defaults.test.ts` compares the complete values across the two projects. The shared row's optional added fields remain compatible with the older fixture DB, outside the permitted `renderer-next/data/db` defaults edit. This replaces the former deferral to phase 5/6; it is not a missing runtime leaf. |
| L25 | Fixed by `b0080ac2`, retained. Without `UPDATE_PARITY`, the test compares the committed file with generated output. | `preload/parity.test.ts` runs in the final preload gate. No procedure map changed in this pass, so regeneration is unnecessary. |
| L26 | Documented exception. Checkout-aware `git.diff` has the typed RPC result and containment errors required by §26.4 h; legacy IPC keeps its string result. | Existing checkout diff and FORBIDDEN tests retain both behavior contracts. Implementation notes now explicitly exempt this and checked model switching from shared handler bodies. |
| L27 | Fixed. Conversation/id/conversion validation happens before claiming a thread. Agent `userInput` encodes client message ids with `nativeId`, preserving plain ids and compat bytes. | `relay-service.test.ts` verifies rejected sends leave `wireFor` as NDJSON. `emit.test.ts` checks an id containing both `#` and `%`. All NDJSON and AG-UI golden tests pass without changing fixture bytes. |
| L28 | Fixed. Debug sync reads only an existing AG-UI twin through `readAguiFile`; it does not call the v1 conversion reader or flush pending v1 dual writes. Clear markers still suppress stale AG-UI twins. | `debug-sync/agui-sync.test.ts` uploads AG-UI parts and reads v1 history while asserting no twin is created and original bytes stay unchanged. |
| L29 | Fixed. `permission.pending` from an incarnation differing from the current one leaves the live permission set unchanged. | `rpc/ai-attention.test.ts` installs a new list, then feeds a late old list, and verifies the new incarnation/title in the snapshot. |
| L30 | Rebuttal: the changed error display is required by spec 05 §31.5 h, as the review itself says. It is retained. | Existing `update-failed-phase.test.ts` covers failure status and phase. |
| L31 | Documented intentional behavior. Without `savedAfterClear` proof, a marker hides all v1 bytes; a differing fingerprint alone cannot prove a post-clear save. Source bytes remain intact. This matches the runtime clear protocol. | `001-transcripts-v2.test.ts` uses a different marker fingerprint and verifies hidden history, the cleared count, and preserved source bytes. |
| L32 | Fixed. Main exposes a runs-only history source; the run-row join uses it without computing next fire times, bot names or webhook URLs. | `rpc/tables/routine-runs.test.ts` makes the display source throw and verifies the attempt/result join succeeds without calling it. |
| L33 test audit | Fixed. Shipped activation barrier, real subfolder/collision discard, real ServiceHost bot guard, real cron-store parser, ordered tap log, late old-incarnation list after a new list, and fallback-write-before-step-5 all have direct regression coverage. | The tests cited in the corresponding rows above. |

The suggested agent no-model-runtime acknowledgment in L9 would require editing
`packages/agent/src/session.ts`, outside this slice's ownership. The specified
main behavior remains a bounded ten-second wait when a runtime sends no answer;
it does not settle other callers from a model change naming another model.

## Commits

Inherited review fixes retained: `b0080ac2`, `c3713368`, `cc87b6bb`, `2f7e6e54`,
`fc077346`, `875ff2a7`.

Continuation commits:

- `3e612789` constrains local previews and serializes effective model changes.
- `1fdfba2d` preserves damaged routine history and recovers fallback links.
- `bbf2d889` rejects unsafe discards and retargets relocated watches.
- `983c66b0` retires deleted threads/process admissions and checks retained cursors.
- `e2dd4bfc` refuses undurable blocked writes and excludes completed timeout matches.
- `086df474` publishes subfolder-relative changes and refuses directory replacements.
- `be6893ac` tests abandonment after a renderer load timeout.
- `3890731c` restores step-1 enumeration behavior while retaining strict archival.
- `0e4b5b91` removes conversion and schedule work from debug/history reads.
- `0018645c` tests real error guards and aligns preference defaults.
- `8c3c414b` adds the retained keep-awake test to the module inventory.

## Verification

Tests used targeted files during implementation, then one complete desktop run
and one required Electron run. Dependencies were installed with
`pnpm install --pm-on-fail=ignore`; connectors, agent and updater were built with
the direct tsdown binaries before dist-dependent tests. Agent test commands
unset both API-key variables.

| Gate | Result |
|---|---|
| Desktop renderer-next/main/shared/preload | 329 files passed, one skipped; 3,494 tests passed, seven todo. Three tests failed in the first full run: the main module inventory and two local-model proxy timing cases. |
| Failed desktop files, isolated rerun after the inventory fix | Both files passed, all 13 tests passed. The local-model tests use a 60 ms idle timer; they passed without changes to their source or tests. The full run was not repeated, respecting the shared-machine constraint. |
| Required main-serial (`ABACUSBOT_REQUIRE_ELECTRON_SUITES=1`) | Eight files, all 281 tests passed, no skipped tests. |
| Agent AG-UI, API keys unset | 14 files, all 177 tests passed, including NDJSON and AG-UI goldens. Fixture bytes unchanged. |
| TypeScript | `tsc -b` passed. A forced rebuild was also used during development; its cross-project test import error was fixed by keeping the values comparison dynamic, and the subsequent build passed. |
| Root oxlint | Exit 0, no errors. Seven existing legacy-renderer hook warnings. |
| Root oxfmt and `oxfmt --check .` | Applied; final check passed for 1,782 files. |
| `check:legacy-diff` | Passed against `main`; this continuation changed no legacy-renderer files. |
| `check:ui-registry` | All 41 registry files match the write-gated snapshot. |
| Committed parity | Passed in the preload suite. No map change and no PARITY regeneration needed. |
| Ownership | No edits in renderer-next features/routes, legacy renderer, or main/dev. Renderer changes are confined to the permitted DB defaults. Agent implementation changes are confined to `agui/emit.ts`, with its regression test. |

The three initial desktop failures are reported above instead of describing the
first full run as green. Every failure passed its final targeted rerun. No
runtime finding in this slice remains unresolved. The suggested shared-row type
migration and no-model-runtime producer acknowledgment have the compatibility
and ownership dispositions recorded above.

## r2

This pass fixes all five majors in `00-main-requirements.impl-codex-r2.md` on
`codex-mainreq-r2`, based on `rewrite/renderer`. Changes are confined to
`apps/desktop/src/main/**` and this log.

| Finding | Change | Regression evidence |
|---|---|---|
| 1 | Rename-source checks use `lstat` before any Trash operation. An occupied source qualifies as already restored only when it is a regular file, HEAD has a regular-file mode, and the content hash matches. Symlinks, including dangling links, cannot pass through a target-content hash. | `git.discard.test.ts` creates a source symlink to the renamed destination, whose bytes match HEAD. Discard must report `occupied`, leave the symlink and index intact, and never call Trash. The new test failed on the original implementation. All 16 file tests pass with the fix. |
| 2 | A scheduled swap's abort predicate checks the outstanding version and current target URL as well as busy state. The real host checks it before the flip, including after continuity restoration. | `experience-activation.test.ts` lets v2 pass readiness in the real serialized host, schedules v3 during its hidden settle interval, then exhausts v3's failing loads. Both the store and displayed renderer must remain v1. `renderer-host.test.ts` also changes the target without scheduling another version. Both tests failed on the original implementation. |
| 3 | Initial readiness returns a deferred result when the window or contents is destroyed. Each adoption has an identity; previous hosts' readiness results cannot settle a replacement's activation. Adoption remains pending until readiness settles. | The activation test closes a silent adopted window, opens a replacement before the old deadline, and commits only the replacement's readiness. A separate scheduler test rejects the previous adoption after the replacement opens. Both tests failed on the original implementation. Renderer-host and activation suites pass all 31 tests. |
| 4 | The caller deadline resolves its promise while retaining the outstanding command. The next command waits for that command's response. Process startup or a state with no live PID invalidates retained and queued switches without sending stale commands; stored pins apply on the next start. A runtime that sends no response holds subsequent commands until invalidation. | `model-switch.test.ts` extends the timeout case with A's late anonymous refusal while B waits, then verifies B resolves only from its own model change. It also tests invalidation after a deadline. The late-refusal test failed on the original implementation. All seven waiter tests pass; the waiter, bot-model and model/RPC suites pass all 21 tests. The old RPC timeout assertion now checks retention followed by invalidation. |
| 5 | Cron's shared held-file instance requires a successful journal write. Journal I/O errors propagate before any memory fallback or success notification. Other held-file users retain their existing fallback behavior. | `cron-store.test.ts` injects journal `EACCES` and `ENOSPC` for edits and run history. Calls must throw, notify no listeners, preserve the previous journal and visible state, and replay only the last durable edit when the block lifts. Both parameterized cases failed on the original implementation. All 20 cron tests pass; cron, model-switch and thread-store suites pass all 61 tests. |

Commits:

- `13bfa976` rejects rename-source type collisions before discard.
- `38dbdf2d` aborts superseded renderer swaps and defers closed adoptions.
- `6cbb6ce0` retains model commands after caller deadlines.
- `916be898` requires durable holding for blocked cron writes.
- `a5226873` updates the model RPC deadline assertion for retained commands.

Dependencies were installed with `pnpm install --pm-on-fail=ignore`, using the
installed pnpm 12.8.1 despite the 12.6.0 pin. Connectors, agent and updater were
built with the direct tsdown binaries first; the agent runtime package script
also ran. Test and TypeScript commands used the direct binaries.

Final verification:

| Gate | Result |
|---|---|
| Main/shared | Final full run passed 271 files and 2,764 tests, with one skipped file and seven todo tests. The first full run passed 2,763 tests and failed only the old model RPC timeout assertion; after updating it, the targeted 21 tests and final full run both passed. |
| Required main-serial | `ABACUSBOT_REQUIRE_ELECTRON_SUITES=1`: all eight files and 281 tests passed, with no skips. The Electron acceptance suite built its required desktop bundle. |
| TypeScript | Direct `tsc -b` passed after implementation and again after the RPC assertion update. |
| Root oxlint | Exit 0, no errors; seven existing legacy-renderer hook warnings. |
| Root oxfmt | Applied to the root; `oxfmt --check .` passed for all 1,782 files. |
| Ownership | Diff from starting commit `5e1f66a4` contains only `apps/desktop/src/main/**` and this log. |

No r2 major remains unresolved. Retaining a model command after its caller
resolves is intentional: sending another anonymous command before the first
response would reintroduce finding 4.
