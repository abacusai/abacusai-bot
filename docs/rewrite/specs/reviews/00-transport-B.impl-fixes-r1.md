# Spec 00 sub-slice B: fixes after implementation review r1

Sources: `00-transport-B.impl-codex-r1.md` (C1–C12) and `00-transport-B.impl-claude-r1.md` (A1–A15g). Overlapping findings are fixed once and listed together. "Red" means the new test was run against the pre-fix code and failed there.

Commits (on `rewrite/renderer`, after `6939d200`):

1. `706c0fec` DB adapter: one snapshot loop per connection, covering echo resync
2. `4fd805c4` Prefs: per-leaf provenance, staged writes, explicit-choice action
3. `b88f455e` DB tables (main): complete triggers, lazy watchers, no stale git rows
4. `50306685` Startup theme: resolved background last, opaque without a backdrop
5. (docs) Spec B notes and this log

## Renderer adapter (`renderer-next/data/db/ipc-collection-options.ts`)

| Finding | Fix | Test (B-T1, `ipc-collection-options.test.ts`) | Red |
|---|---|---|---|
| C1, A1 (collection freeze after a nested `loadSnapshot`) | The snapshot is one loop per connection with one `finally`. A reset or gap met in the flush, or a resync asked for during a pass, sets `again`, and the loop runs another pass. Nothing reassigns `connection.loading`. A batch whose `seq <= received` is dropped before its kind is checked, a reset included. | (1b) two resets during the first load, then a later reset, a change and a resync; (1c) a gap buffered during the load, then a reset; (1e) a covered reset is dropped | yes |
| C2 (resync hangs right after preload) | The loop clears `loading` in the same turn that settles its waiters, and a resync waiter records the passes already started. Only a later pass can answer it. | (1d) `await preload(); await resync()` settles, with 2 snapshots | yes |
| C3 (echo timeout settled by an older snapshot) | After a timeout the handler requests a resync that starts after the call, and waits for `pos` itself to be *received*, which is a coverage check. | (10b) timeout while an older snapshot (seq 0) is held; the handler resolves only when `received >= 1`, after 3 snapshots | yes |
| A2 (echo wait can hang: idle collection, wedged connection, no session) | Both waits (echo, then the covering resync) are bounded, then the handler resolves. A handler starts the sync of an `idle` collection (`startSyncImmediate`). `utils.resync()` rejects with `AbortError` when no session exists. | (10c) mutating an idle lazy collection echoes in under 2 s; (10d) the echo never comes and the handler still resolves; (10e) resync without a session rejects | yes |
| A9 (throw between `begin` and `commit`) | Writes run inside `transaction()`. On a throw it cancels the pending sync transaction (`commit` with an aborted signal), logs, and resyncs. A failed snapshot write is handled like a failed fetch. | (9b) a batch whose row breaks `getKey`; later batches still become visible | yes |
| A13 (backoff reset on every hello) | `attempt = 0` only after a snapshot has applied. | (14) three failing snapshots give delays 0, 1, 2; a good one resets to 0 | yes |
| A14 (dead connection current during the sleep) | The `finally` clears `current`. | (15) a resync during the reopen delay makes no snapshot call on the dead connection | yes |
| A15a (no upsert regression test) | Test only. | (8d) delete then re-create of one key behind a persisting transaction | passes on old code, as expected (coverage) |
| A15b (no reset/gap during a load) | Tests (1b), (1c), (1e) above. | | |
| A15c (overflow modelled as reset + clean EOF) | Test only. | (12b) `reset`, then the stream fails with `RESYNC_REQUIRED`; reopen, re-snapshot, mutation echo | passes on old code (coverage) |

## Prefs (`main/services/config/prefs-store.ts`, `shared/contract/{rows,db}.ts`, `renderer-next/data/db/tables.ts`)

| Finding | Fix | Test | Red |
|---|---|---|---|
| C4 (equal-value choice never reaches main) | `updatePrefs(patch)` (`createUpdatePrefs`, exported singleton in `data/db/index.ts`) sends every leaf it names. A visible change is applied optimistically through a TanStack transaction. When nothing visible changes, TanStack would not run the mutation (0.9.2 `commit()` returns early with zero mutations), so the action sends the RPC itself and awaits the echo. | B-T4 `collections.e2e.test.ts`: `collection.update(theme = "system")` sends nothing (provenance stays `default`); `updatePrefs({ theme: "system" })` marks it `user`, and a later legacy import keeps it | yes |
| C10 (row and provenance changed before persistence) | `#apply` stages a new row and provenance, persists them, and only then assigns and notifies. | `prefs-store.test.ts`: a write into a read-only directory throws; nothing changes; a legacy import still applies; the same patch then persists and reloads | yes |
| A5 (provenance per top-level field, C.4 needs leaves) | Provenance is `Record<PrefsLeaf, …>`. `PrefsPatch`/`PrefsPatchSchema` groups take any subset of their leaves (`v.partial(v.strictObject)`). Stored values are validated per leaf, and a group-level mark from the earlier format applies to its leaves. `importLegacy` works per leaf. `PREFS_LEAVES` and `getPrefsLeaf` are exported for C. A collection update sends only the leaves that differ from `mutation.original`. The shape is documented in the spec's B notes ("Prefs provenance is per leaf"). | `prefs-store.test.ts`: a user `sidebar.pinned` survives while a legacy `sidebar.openSection` flows; one dismissal does not invent its sibling; an invalid leaf is counted and its sibling kept; group marks are read. e2e: a collection update of `sidebar.openSection` marks only that leaf | yes |
| A6 (`pickDefined` hides FORBIDDEN) | `writablePatch` throws `ReadOnlyFieldError` (`code: "FORBIDDEN"`) for any changed key outside the table's writable set (sessions, bots, routines, workspaces, prefs). The handler rejects and the optimistic change rolls back. | e2e: `sessions.update(runOutcome)` rejects with `FORBIDDEN`, and the row is unchanged | yes |

C's live legacy sync also edits `prefs-store.ts`. The changes here stay inside `#apply`/`#load`/`importLegacy` and the leaf helpers. `update`, `importLegacy(patch) → { row, invalid }`, `onChanged` and `provenance()` keep their signatures. The only change C sees is that `provenance()` is keyed by leaf.

## Main tables (`main/rpc/tables/**`, `event-bus.ts`, stores)

| Finding | Fix | Test (`tables.test.ts`) | Red |
|---|---|---|---|
| C5 (`routineRuns` fed only by sessions batches) | The session events, `sessions-reloaded` and the session hook notify `routineRuns` directly. The `onPublish` chain stays for `notifyNow`. | a reader on `routineRuns` alone sees a run inserted, settled and deleted | yes |
| C6 (git state published under the wrong workspace) | `readGitStateRows` publishes no row until `TableSources.gitStateWorkspacePath()` (new, `ServiceHost` → the runtime snapshot's `workspacePath`, one forwarding method) equals the active workspace's local path. | real `WorkspaceService` + `WorkspaceRuntimeService` with a deferred git read: A's refresh is in flight, B is added, A's read resolves. No row, and no batch has A's file under B. Then B's refresh gives B's row | yes |
| C7, A10 (watcher identity; missing home) | Each watcher keeps the `dev:ino` of its directory. Reconcile re-arms on a mismatch. A missing home is watched from its parent, filtered to its name. | a directory replaced inside one debounce, then a later write is seen; a home created later is picked up and watched | yes |
| C8 (artifact existence changes unseen) | `artifacts` is re-diffed every 2 s (`ARTIFACTS_POLL_MS`) while it has a reader. Watching up to 2,000 files, or their parent directories, across every workspace, was judged costlier and less reliable (parent deletion, inotify limits) than a bounded poll gated on a reader. | real `SessionArtifactsService.list()`: an external delete gives a delete batch, a recreate gives an insert | yes |
| C9 (frozen-clock id collision) | `createBot`/`createJob` mint again while the candidate is already stored. | `bot-store.test.ts`, `cron-store.test.ts` with `Date` frozen: a caller takes the next minted id, then an ordinary create; 3 distinct ids | yes |
| C12 (bot rename does not invalidate `memory.bots`) | The bot-store hook compares `listBotMemories()` with the last view published (kept while the memory demand is armed), and publishes `memory.events` when it differs. | rename → 1 notice; a description-only update → none; a new bot → another | yes |
| A11 (legacy generation pays for watchers and the clock) | `TableFeed.whileSubscribed` and `MainEventBus.whileListened` arm on the first reader or listener and disarm on the last. The watchers are refcounted over `memories` readers plus `memory.events` listeners. The routines clock and the artifacts poll are gated on their table's readers. | `fs.watch` and the 60 s `setInterval` are not called until a reader appears; watchers close only after both the reader and the listener leave | yes |
| A12 (`bots-updated` re-diffs three tables per transcript save) | `bots-updated` notifies `bots` only. The bot-store hook notifies bots, routines and memories. | after `bots-updated`, neither `listRoutines` nor `listMemories` runs; a `bots.json` write runs both | yes |
| A8 (overflow reset reuses the seq) | Kept, and documented in the feed and the spec. The seq is the position every lost batch sits at or below, which is what the client's new "drop a covered reset" rule needs. `seq + 1` would name a batch that never exists. | B-T1 (12b), (1e) | n/a |
| A15e (direct hooks never exercised) | Added store-level cases: `createJob` → routines batch through `onCronStoreWrite`; `WorkspaceService.switchWorkspace` → workspaces and gitState batches through `onChanged`. The gitState case (C6) also runs the real `WorkspaceRuntimeService`. **Not done:** `ServiceHost` itself as `TableSources`. No test in the repo constructs `ServiceHost`, which pulls in Electron-bound services. Its table methods are one-line forwards (`service-host.ts` `onSessionsChanged` … `gitStateWorkspacePath`), and the type checker holds them to `TableSources`. | yes (coverage) |
| A15g (misleading test name) | Renamed to "a bot's memory directory and daily notes fire memory.events". Bot removal is the next test. | | |

The existing watcher tests' re-arm waits are now 8 s under a 20 s test timeout. Under a full parallel run, FSEvents latency made them flake at 1 s, and that failure appeared in the baseline too. The 500 ms delivery assertion is unchanged.

## Startup theme (`main/startup-theme.ts`, `main/index.ts`)

| Finding | Fix | Test (`startup-theme.test.ts`) | Red |
|---|---|---|---|
| C11, A3 (Linux background overridden by `...chromeOptions`, then reset to `#2a2a28`) | `mainWindowOptions` builds everything `createWindow` passes to `new BaseWindow`, with the background last. `refreshWindowChrome` then applies `applyThemedBackground` to the window and to `RendererHost`, so reloads and swap candidates use the current surface. `window-chrome-options.ts` is untouched: it belongs to the window-chrome spec. | Linux overlay and native frame, stored theme opposite to the OS: the resolved surface | yes (the old order simulated inside the function: 4 fail) |
| C11, A4 (transparent with reduced transparency) | `themedBackground`: transparent only while vibrancy or mica is active, otherwise the surface. | darwin and win32 with reduced transparency → surface; without → transparent plus vibrancy/mica | yes |
| A15d (test did not see `createWindow`'s assembly) | The assembly is now the tested function. The theme is applied before the chrome input is read (asserted). The legacy options are asserted equal to the old object on each platform. | | |

## Rebuttals

- **A7 (deleting a live workspace brings the row back).** Not a defect: the server intends this outcome. `removeWorkspace` is two-stage in the legacy app (`service-host.ts:1702-1716`). The first delete tombstones (`status: "deleted"`, sessions stay readable), and only a tombstone is erased. The DB mutation must keep that behaviour (PLAN: old behaviour identical). An `update` to a tombstone would make a second, divergent path to the same store call. Resolution: this is documented in the spec's B notes ("Workspace delete is two-stage"), the shell filters `status !== "deleted"`, and a second delete erases.
- **A15f (race test reimplements `ServiceHost.forgetMemory`).** Kept as is. The fake's body is exactly the ServiceHost glue: `failIfNotDone(await forgetEntryAt(target, index, entry, occurrences)); return listMemories()` (`service-host.ts:2429-2447`). The real `forgetEntryAt`, store lock, `ConflictError` and `CONFLICT` mapping all run. The test cannot import `ServiceHost` for the reason given under A15e, and extracting the glue would have touched `service-host.ts` for test purposes only.

## Verification

- `tsc -b`: clean. `oxlint`, `oxfmt` on the touched files: clean.
- `vitest --project main --project main-serial --project preload --project shared --project renderer-next`: all green, except the pre-existing failures that are unrelated and also failed on `6939d200`: `packaged-startup.test.ts` (needs a packaged bundle), `updates/experience/integrity.test.ts`, and `local-models/model-store.test.ts` (download resume).
