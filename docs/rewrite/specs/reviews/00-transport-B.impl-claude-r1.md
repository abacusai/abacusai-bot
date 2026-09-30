# Spec 00 sub-slice B (DB tables): implementation review, claude r1

Scope: `git diff 73caf359..6aca10c1 -- apps/desktop`, checked against spec 00 §B, "Deferred additions", "Implementation notes (sub-slice B)", §C.4 (prefs provenance) and PLAN.md. TanStack DB semantics were read from the installed `node_modules/@tanstack/db` **0.9.2** (`dist/esm/collection/sync.js`, `state.js`, `lifecycle.js`, `mutations.js`). Findings 1, 2 and the delete-then-recreate check were reproduced with the real `ipcCollectionOptions` + `FakeTable` + `createCollection`, run from a scratchpad copy (`node --experimental-strip-types`). No repo files were changed.

## Findings

### 1. High: a resync started during a snapshot flush wedges the connection for good
`renderer-next/data/db/ipc-collection-options.ts:405-407` with `:418-427`.

`resync()` stores `loading = loadSnapshot(c).finally(() => { if (c.loading === loading) c.loading = null })`. When the post-snapshot flush hits `"resync"`, `loadSnapshot` reassigns `connection.loading = loadSnapshot(connection)` directly. The outer `finally` then sees a different promise and does not clear it, and nothing ever clears the nested one. From then on, every `resync(connection)` returns that settled promise and loads nothing:
- A later `reset` is ignored. `reset` never advances `receivedSeq`, so the next `changes` batch is a gap, and the gap "resync" is also a no-op. **The collection freezes until the stream happens to reconnect.**
- `utils.resync()` never resolves, so a mutation whose echo times out hangs forever (see 2).

The trigger is ordinary. Any `reset` buffered while a snapshot is in flight causes it, for example `sessions-reloaded` during the startup load, or two resets close together. `applyBatch` checks `kind === "reset"` before `seq <= receivedSeq` (`:326`), so even a reset the snapshot already covers takes this path.

Reproduced: hold a snapshot, broadcast `reset` twice (the second is buffered), release. After that, a third `reset` does not re-snapshot (`snapshotCalls` stays at 3). A following change is not applied (`receivedSeq` 3 while the server is at 5), and `utils.resync()` does not settle within 300 ms.

**Fix:** keep the single flight in one place. Make `loadSnapshot` loop internally (`for (;;) { …snapshot…; flush; if (next === "resync") continue; break; }`) instead of reassigning `connection.loading`. Also drop a `reset` whose `seq <= receivedSeq` during the flush: the snapshot already covers it. An overflow reset carries the feed's current seq, which is above anything the client lost, so it is still honoured. Add a B-T1 case "reset arrives while the snapshot is loading, then another reset and a change".

### 2. Medium: the echo-timeout path can hang the mutation handler forever
`ipc-collection-options.ts:253-269` (`awaitEcho`), `:238-242` (`utils.resync`), `:429-431`.

On timeout the handler runs `await utils.resync()` with no bound. That promise resolves only when a future snapshot completes on a live session. It never does in three cases:
- (a) `requestResync` is null because the collection's sync never started. Lazy tables such as `bots` and `routines` are not synced until `preload()`, and TanStack 0.9.2 does **not** start sync on a mutation of an `idle` collection: `lifecycle.js:72-79` only restarts from `cleaned-up`.
- (b) The connection is wedged (1).
- (c) The session was cleaned up after the call. Waiters added after cleanup are never rejected.

The write has reached main, but the transaction never settles and the optimistic row stays forever.

**Fix:**
- Bound the resync wait. After it, resolve and let the next snapshot reconcile.
- Start sync on a mutation when no session is live: keep the `collection` from `sync()` or use `mutation.collection.startSyncImmediate()`.
- Reject `snapshotWaiters` created while no session exists.

### 3. Medium: the Linux startup background is overridden, and later reset to `#2a2a28`
`main/index.ts:600-611`; `window-chrome-options.ts:117`, `:150-156`.

`new BaseWindow({ backgroundColor, …, ...chromeOptions })` spreads `chromeOptions` **after** the computed `backgroundColor`. In the Linux overlay mode (wco), `chromeOptions.backgroundColor` is `"#2a2a28"`, so `startupBackgroundColor(...)` is discarded for the window. Then every `nativeTheme` "updated" (via `subscribeWindowChromeTheme`, and via `followPrefsTheme` → `refreshWindowChrome`) runs `applyWindowChrome`. That call sets both the window **and** `RendererHost` (`host.setBackgroundColor`) to `#2a2a28`, so later reloads and swap candidates (`renderer-host.ts:344,446`) paint dark grey in light mode. These are exactly the wrong-first-frame cases the deferred addition was meant to remove.

**Fix:** spread `chromeOptions` first (or omit its `backgroundColor`). Have `windowChromeOptions`/`applyWindowChrome` use `WINDOW_SURFACE[dark]` for the wco Linux overlay instead of the fixed `#2a2a28`.

### 4. Low: a transparent startup backdrop is kept even when nothing paints it
`startup-theme.ts:37-45`; `index.ts:590-594`.

On darwin and win32, `chromeOptions.backgroundColor` is undefined, so the fallback is `#00000000` and `startupBackgroundColor` keeps it transparent. That is fine with vibrancy or mica. With `prefersReducedTransparency`, however, `windowChromeOptions` drops vibrancy (darwin) or sets `backgroundMaterial: "none"` (win32). Nothing paints the backdrop, and the first frame is not in the stored scheme.

**Fix:** stay transparent only when vibrancy or mica is active. Otherwise use `WINDOW_SURFACE[dark]`.

### 5. Medium: prefs provenance works per top-level field, but C.4 maps legacy keys to nested leaves
`services/config/prefs-store.ts:27-31, 129-146, 156-193`; `shared/contract/db.ts:93-130`.

Provenance is `Record<PrefsField, …>` over top-level fields, and the patch schema requires whole sub-objects. C.4 maps **two** legacy keys into `sidebar` (`sidebar.pinned` ← `local-code-ui-store`, `sidebar.openSection` ← `sidebar-accordion`) and two into `dismissals` (`referral-card.dismissed-until`, `local-code:upsell-dismissed`). Consequences:
- A user toggle of `sidebar.pinned` in the new UI marks the whole `sidebar` as `"user"`, so the legacy `openSection` never flows again.
- A legacy import of one key must invent the sibling's value and marks both `"legacy"`.
- C.4's "a removed key resets its fields to default if `legacy`" cannot be expressed per leaf.

This deviates from the spec's per-field rule as C will need it.

**Fix:** key provenance by leaf path (`"sidebar.pinned"`, `"dismissals.upsell"`, `"models.perWorkspace"`, …) and merge nested patches in `importLegacy`. Alternatively, flatten those rows. Settle this before C lands.

### 6. Low-Medium: `pickDefined` hides FORBIDDEN and silently reverts edits
`renderer-next/data/db/tables.ts:70`, `:113`, `:152`, `:270`.

`toUpdateInput` keeps only the writable keys. A collection update that touches only a read-only session field (`runOutcome`, `workspaceId`, `turn`, …) sends `patch: {}`. Main echoes the current position, the handler resolves, and the optimistic change quietly disappears. The spec's `FORBIDDEN` ("read-only field", B.2; `procedures/db.ts:65-69`) is unreachable from the collection, and the caller gets success for a write that did nothing.

**Fix:** forward every changed key and let main refuse, or throw client-side when a non-writable key changed.

### 7. Low: deleting a live workspace from the collection brings the row back
`procedures/db.ts:178-184`, `service-host.ts:1702-1716`.

The first `removeWorkspace` only tombstones the workspace (`status: "deleted"`). The optimistic delete is dropped when the handler resolves, and the row reappears with `status: "deleted"`. This is a legitimate server outcome, but a UI that trusts `collection.delete` sees an undelete.

**Fix:** either filter tombstones in the shell and note this in B.2, or expose "tombstone" as an `update` and keep `delete` for erase.

### 8. Low: the overflow `reset` reuses the current seq
`main/rpc/tables/table-feed.ts:153`.

B.1 says seq advances by exactly 1 per `changes`/`reset` batch. The per-subscriber overflow reset is sent with `seq: this.#seq`, a value some earlier batch already used. The client handles `reset` before the seq checks, so nothing breaks today. It does interact with the fix in 1: a reset with `seq <= receivedSeq` must still be honoured when a backlog was dropped. With the current value it is, because the dropped batches were all at or below `#seq` and above `receivedSeq`.

**Fix:** document the reuse in the implementation notes, or send `seq: this.#seq + 1` without advancing the feed seq (it is subscriber-local).

### 9. Low: a throw between `begin()` and `commit()` leaves a dangling sync transaction
`ipc-collection-options.ts:330-343`, `:384-387`.

If `write` throws (for example a `DuplicateKeySyncError` from a server bug), the pending synced transaction stays uncommitted in `state.pendingSyncedTransactions` forever. Inside `loadSnapshot` the throw also becomes an unhandled rejection through `void resync(...)`.

**Fix:** wrap the write loop, and on a throw call `commit()` then reopen, or cancel. Catch in `resync`.

### 10. Low: memory watchers only compare paths
`main/rpc/tables/memories.ts:162-186`.

`#reconcile` keeps any watcher whose path still exists. A watched directory that is deleted and recreated between two reconciles, such as `memories/` inside one 150 ms debounce, keeps a watcher on the dead inode, and later writes go unseen. If `~/.abacusai-bot` itself does not exist at start, nothing is watched and nothing ever re-arms.

**Fix:** record `stat.ino` per watcher and re-arm on a mismatch. Re-arm when a watcher reports `rename` for itself. Watch the home's parent, or poll once, until the home exists.

### 11. Low: the legacy generation pays for watchers and the routines clock
`main/index.ts:1602-1606` (`createTables` in `installRpc`).

`MemoryWatchers` (`fs.watch` on the home, `memories/`, `bots/`, and every `bots/<id>/` and `…/memory/`) and the 60 s `setInterval` are created in every generation. The implementation notes say "the legacy-only app pays nothing".

**Fix:** arm the watchers on the first `memories` snapshot or subscriber and disarm on the last. The clock can be skipped while `routines` has no baseline.

### 12. Low: `bots-updated` re-diffs three tables on every bot transcript save
`main/rpc/tables/index.ts:81`.

`bots-updated` also fires on every bot-chat transcript persist (R13). Once they have baselines, each one re-reads `bots.json` and `cronjobs.json` (with cron parsing) and re-hashes every global and bot memory entry. This is coalesced per tick, but it runs on every turn.

**Fix:** notify `routines`/`memories` from the bot-store write hook only (names change only there), and keep `bots-updated` for `bots` + `previews-changed`.

### 13. Low: the retry backoff resets on every `hello`
`ipc-collection-options.ts:440`.

A snapshot that fails deterministically after `hello` (a throwing `read`) therefore retries every 500 ms forever. This follows the spec text, but it never backs off.

**Fix:** reset `attempt` after a snapshot has been applied, not on `hello`.

### 14. Low: `current` still points at a dead connection during the retry sleep
`ipc-collection-options.ts:502-509`.

After a stream ends, `current` stays set to the dead connection until the next loop iteration. During that window, `isCurrent` accepts a late snapshot from it, and `requestResync` targets it: the `loadSnapshot` then fails on its aborted signal. This is harmless today but confusing.

**Fix:** set `current = null` in the `finally`.

### 15. Tests that do not prove their claim
- **15a. No regression test for the upsert deviation.** "Writes of changes are upserts" exists because of the delete-then-recreate `DuplicateKeySyncError`, and no B-T1 case covers it. I verified it with a scratch run: an update on `a` persisting, then server `delete k` and re-`insert k` → no throw, `k` = new value. **Fix:** add that case.
- **15b. No case for a `reset` or gap arriving while a snapshot loads.** Such a case would have caught 1.
- **15c. B-T1 (12) models the overflow as `reset` followed by a clean EOF.** The real feed sends `reset` and then throws `RESYNC_REQUIRED` (`table-feed.ts:153-154`). The reset-triggered resync racing the error path is not exercised on the client.
- **15d. `startup-theme.test.ts` "before the window exists" does not test `createWindow`.** It pushes into a local closure, so it proves nothing about the ordering in `createWindow` and cannot see 3. **Fix:** extract the options assembly (`backgroundColor` + `chromeOptions` merge) into a pure function and test the merged object.
- **15e. The direct hooks are never exercised.** B-T3 "routines" uses an in-memory list with `onRoutinesWritten: noHook`, so `onCronStoreWrite` is never run. `WorkspaceService.onChanged` is never run either (B-T4 uses fake hooks). `ServiceHost` as a `TableSources` (`listSessionTurnStates` join, `onSessionsChanged` via the real manager) has no test. **Fix:** add store-level cases like the bots one: `createJob` → routines batch, `switchWorkspace` → workspaces + gitState batch.
- **15f. The duplicate-entry race test reimplements `ServiceHost.forgetMemory`** in its fake. It proves `forgetEntryAt` and the `ConflictError` → `CONFLICT` mapping, not the real `failIfNotDone` glue.
- **15g. A test name promises more than it checks.** "memories: a bot's daily notes fire memory.events; a removed bot drops its watchers" does not remove a bot (the next test does).

## Confirmed correct

- **TanStack DB 0.9.2 semantics match the notes.**
  - A sync `insert` is checked against `syncedData` (applied rows). It is exempt only for a same-transaction delete or a truncate transaction (`sync.js` write, ~l. 85-105).
  - Committed synced transactions apply at once only when no user transaction is `persisting`, or when a truncate or immediate transaction is among them (`state.js:631`). `commit()` returns `true` or the `applied` receipt.
  - In `rowUpdateMode: "full"`, `update` is `syncedData.set` (a full upsert), so writing change inserts as updates is safe, and change events are derived from visible state.
  - `error → ready` is valid, and `applyReadyTransition` clears `syncError` (`lifecycle.js:37-43, 95-100`).
  - `cleanup()` rejects pending receipts with `SyncTransactionAbortedError`, which `trackApplied` swallows.
  - The delete-then-recreate case applies cleanly with the upsert writes (scratch repro).
- **Received vs applied.** Handlers wait for *received*, so they cannot deadlock. B-T4's wrapper shows `appliedSeq < pos.seq` inside the handler and `awaitApplied` after it. `collection.utils` is the options' own object (no sync factory), so the wrapper really intercepts.
- **Epoch before seq everywhere.**
  - A foreign-epoch batch reopens and is never dropped.
  - Connection generations discard stale batches and snapshots.
  - Old-epoch waiters settle only after the new epoch's snapshot (`snapshotReceivedEpoch`/`snapshotAppliedEpoch`).
  - Sync restarts reset the positions.
- **`TableFeed`.**
  - It registers the subscriber before `hello`.
  - A no-op diff publishes nothing.
  - Equal-but-not-identical rows keep the baseline, so the `gitState` stamp is not a change.
  - `snapshot()` re-diffs, so its rows and seq agree.
  - `notifyNow()` returns a seq at or above the batch holding the change, including for async mutations (`removeRoutine`, workspace ops) where a coalesced `notify` may publish it first.
  - `reset` re-baselines and chains `routineRuns` via `onPublish`.
- **Flow control and delivery class.** Each subscriber gets A's `SubscriberQueue` (`lossless-actionable`, 5,000). A failed queue is removed from `#subscribers` at once, and the generator ends with `reset` then `RESYNC_REQUIRED`. The client consumes `changes()` without awaiting inside the loop, so acknowledgements keep flowing. B-T4 runs over a real `MessageChannel` with main's flow control.
- **Writers vs hooks.**
  - `bots.json` is written only by `bot-store.write` (hooked).
  - `cronjobs.json` is written only by `cron-store.write` (hooked). Nothing in `packages/agent` writes either file.
  - The workspace store keys are written only in `WorkspaceService.persist` (hooked; `dispose` notifies too).
  - Every session-record mutator goes through `persist`/`schedulePersist` (hooked), except `initialize` at startup.
  - The memory files, written by the agent child (`packages/agent/src/memory-store.ts`, `bot/bot-memory.ts`) and by main's forget paths, are covered by the watchers.
  - `prefs.json` is written only by `PrefsStore.update`/`importLegacy`.
- **Profile homes.** A profile switch relaunches (`profile-home.ts` header), so the captured `botHome()` and the prefs file path are stable for the life of the process.
- **gitState on a workspace switch.** The hook's `notify` runs on `setImmediate`, after `noteWorkspaceSwitched` has swapped the runtime snapshot, so no row carries the old workspace's git state under the new id.
- **Prefs store.**
  - It is lazy, and writes no file until a change.
  - Stored fields are validated one by one (an invalid field reverts to its default and its provenance to `"default"`).
  - An explicit choice equal to the default is `"user"` and survives a legacy import.
  - Provenance never reaches the row.
  - `onChanged` fires only on a row change, so `followPrefsTheme` does not refresh on unrelated fields.
  - TanStack's nested change tracking sends whole sub-objects (verified), which matches the strict patch schema.
- **Mutations and errors.**
  - Caller ids are honoured, and a taken id is `ConflictError` → `CONFLICT` for sessions, bots and routines.
  - "No bot/job" is `EntityNotFoundError` → `NOT_FOUND`, with legacy messages unchanged.
  - Memory deletes send `mutation.original` with `occurrences`, and the check runs under the store lock.
- **Listener hygiene.**
  - `createTables().dispose` removes the bus listener, every hook, the watchers and the clock.
  - The `subscribe` `finally` removes the subscriber.
  - `SubscriberQueue.next` and the client's `sleep`/`onSessionAbort` remove their abort listeners.
  - `subscribeWindowChromeTheme` is removed on window `closed`.
- **Startup theme.** In the wco generation, `applyStartupTheme` sets `themeSource` before `windowChromeOptions(currentChromeInput())` reads `shouldUseDarkColors`, so the overlay colours and the renderer view's initial background are already in the stored scheme (the window itself is item 3). The legacy generation is untouched.
