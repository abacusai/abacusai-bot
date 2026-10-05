# Review: main requirements from specs 3–6 (Claude r1)

Scope: `git diff c46e77d9..0ab59029 -- apps/desktop/src/main apps/desktop/src/shared packages/agent/src/agui docs/rewrite/PARITY.md`, excluding the step-1 files (`__fixtures__`, `001*`, `thread-store.ts`, `stream-v1.ts`). I checked it against 03-bots r3 §24, 04-sessions r3 §26.4, 05 r3 §31.5, 06 r4 §23, cut-over review 07 r1 #9/#10/#11, and "Implementation notes (main requirements from specs 3–6)" in 00-transport-db-migration.md.

How it was checked:
- I read the code only and changed nothing. Line numbers are from 0ab59029; the working tree has the same content for these paths.
- The discard findings (1–3) were reproduced with real git in throwaway repos.
- For PARITY.md, I regenerated the file from a scratchpad copy of `parity.test.ts`. It matched the committed file byte for byte.
- I read the code again myself to confirm findings 1, 2, 3 (activation), 5 (routines) and 9 (model-switch).

Numbering is by severity.

---

## Findings

### 1. High: `git.discard` in a checkout that is a subfolder of a repo deletes tracked files and stages the deletion

`services/workspace/git-service.ts:1020-1036` (`existsInHead`), `:1105-1150` (`discard`).

Git resolves `git -C <checkout> cat-file -e HEAD:<path>` from the **repository top level**, but it resolves `rm` and `restore` pathspecs from the `-C` folder. Take a workspace `repo/sub` with a modified `sub/f.txt`:

- **Entry `f.txt`:** `HEAD:f.txt` is not found, so the file goes down the "new file" branch. It is moved to the Trash, then `git rm --cached -- f.txt` removes `sub/f.txt` from the index. A tracked file is deleted and its deletion is staged. This is the opposite of a discard, and it is reported as `discarded`.
- **Entry `sub/f.txt`** (the spelling git status uses): `#inside` resolves it to `sub/sub/f.txt`. Nothing happens, yet it is reported as `discarded`.
- **Worktree folder whose `.git` file is missing:** `git -C` walks up to a parent repo (for example a dotfiles repo in `$HOME`) and acts there.

**Fix:**
- Before a discard, check that the realpath of `git rev-parse --show-toplevel` equals the checkout's realpath, or apply `--show-prefix` everywhere.
- In `existsInHead`, use `HEAD:./<path>` or `git ls-tree HEAD -- <path>`.
- Best option: accept only entries found in a fresh `git status --porcelain -z` of the checkout, and run each operation on git's canonical path.
- Add tests for a subfolder checkout and for a worktree with a missing `.git` file.

### 2. High: experience activation still commits a candidate that was never ready (#9 is not fixed for the shipped barrier)

`main/index.ts:433-445`, `shared/experience.ts:11` (`FOUNDATION_API = 1`), `renderer-host.ts:193-196, 216-234, 413-418`.

- **The shipped barrier never fails.** Because `FOUNDATION_API = 1`, the barrier is `first-commit`: `Promise.race([ready.promise, delay(READY_TIMEOUT_MS)])`. A candidate that never sends `renderer-ready` still flips after 5 s and resolves `true`. The outcome is `"swapped"`, and `commitActivation` writes `active.json`. `SwapNotReady` is thrown only on the `subscriptions` path, so `gave-up`, `abandonActivation` and `rejected.json` cannot be reached in production.
- **The test does not cover it.** `experience-activation.test.ts:102` passes `barrier: "subscriptions"` with a mocked swap that throws, so it passes whichever barrier ships.
- **Every non-`gave-up` outcome commits, including `"skipped"`.** `"skipped"` covers:
  - no host (the macOS window is closed and the app stays in the dock, or an update lands before the first window);
  - `swap()` returning `false` because the window was destroyed mid-swap.
  
  In those cases the candidate is persisted without ever passing readiness, and the next launch boots it.
- **A generic swap error settles nothing.** For example, the 30 s load timeout or a `loadURL` rejection (`renderer-host.ts:233`) is only logged. The candidate stays in memory as `#active`, which also stops the updater. It is neither committed nor rejected, so it is downloaded and activated again on every launch.

**Fix:**
- For the commit decision, make `first-commit` throw `SwapNotReady("timeout")` when `ready.promise` did not win the race.
- Only the `disabled` (dev) skip should commit. "No host" and "destroyed" should return a `"deferred"` outcome that the next window's load settles: commit on ready, abandon on failure.
- Treat load failures like `SwapNotReady`, counted against the budget.
- Add a test that drives `RendererHost.swap` with `first-commit` and a contents that never sends `renderer-ready`.

### 3. Medium: a second release while an activation is pending can commit a renderer that was never ready, or leave the newer one pending forever

`services/updates/experience/experience-updater.ts:257-264`, `experience-store.ts:191-193, 259-264`, `renderer-host.ts:223-226`, `index.ts:420-424`.

- **Wrong comparison.** `rendererChanged` is compared with `store.rendererVersion`, which already reflects the uncommitted candidate. Suppose v2 has the same renderer as a pending v1 but a different agent. v2 gets `commit: true`, and `commitActivation(v2)` then persists v1's renderer, which never passed readiness. v1's later `gave-up` does nothing because the version no longer matches.
- **This is likely to happen.** A pending activation easily outlives the 15-minute check interval, because the swap waits while any terminal is live or an agent turn is running.
- **The wrong release gets rescheduled.** When a v1 swap in flight throws `SwapNotReady`, it reschedules v1 and cancels v2's timer. `target()` ignores the version, so the swap loads v2's URL but the outcome is labelled v1. Both settle calls then do nothing, and v2 stays pending forever.

**Fix:**
- Compare with the committed manifest (`#committed ?? #active`), or force `commit: false` while `#pending` is set.
- Have the scheduler target the version it is swapping to, and ignore stale in-flight results.

### 4. Medium: discarding a directory permanently deletes staged new files inside it

`git-service.ts:1114-1115, 1162-1180`; `shared/contract/checkout.ts:48-52`.

`#inside` accepts a directory. `git restore --source=HEAD --staged --worktree -- dir` runs without overlay, so files that are in the index but not in HEAD are removed from disk. They do not go to the Trash. Reproduced: a staged `dir/new.txt` is gone and is not in the Trash. This breaks §26.4 c ("recoverable").

**Fix:** refuse directory entries, where the HEAD object is a `tree` or the path is a directory on disk. Or expand a directory into its changed files from `git status` and discard each file separately.

### 5. Medium: a malformed routine history entry empties the routine list, and the next write erases every routine

`services/agent-tools/cron-store.ts:82-87`; `routine-attempts.ts:75-76, 136-141`.

- `read()` now passes `job.runs` to `classifyLegacyRuns` without validating it. A `null` entry throws at `run.sessionId`, and an entry without `result` throws at `result.startsWith`.
- The outer `catch { return []; }` swallows the error, so `listJobs` returns empty.
- The next `createJob`, `recordRun` or `updateJob` writes `[newJob]`, which erases every routine on disk.
- The old code passed `runs` through untouched, so this failure is new. Step 5 filters such entries out (`005:121-127`), but the read path does not.

**Fix:** classify only the entries that pass step 5's guard, and keep the other entries unchanged. Also consider having `read()` refuse to report `[]` on a parse or classify error for a non-empty file (throw, so no write follows).

### 6. Medium: if step 5 has not run, the first cron write loses its session recovery for good

`cron-store.ts:79-84`; `migrations/runner.ts:437-444`; `005-routine-attempt-ids.ts:129`.

Step 5 can fail to run in a launch: a failure in step 1, 2 or 5 stops the runner (see finding 14). The read path then derives ids with `records = []`. The next cron write saves those ids with `sessionId: null`, and unknown or timeout entries are left unlinked. On the next launch step 5 sees that every entry already has an id and plans nothing, so the recovery from run records never happens.

**Fix:**
- Step 5 (and `classifyLegacyRuns`) should also treat an entry as legacy when `run.id === legacyAttemptId(routineId, run, ordinal)`, filling only a `sessionId`/`attemptId` that is null.
- Also see finding 12.
- Test: the fallback write happens first, then step 5 runs, and the test expects the sessions recovered.

### 7. Medium: a stale bot re-pin can overwrite a newer bot model

`services/bots/bot-service.ts:275, 335-358`.

- `repinBot` is fire-and-forget on every update. `pinSession` reads `getBot()` and then awaits `effectiveModel()`, which calls `listAvailableModels()`, a network call.
- Suppose the model changes quickly from A to B, and A's catalog read resolves last. Every owned session is then pinned to A, and running agents are switched to A, while `bot.model` is B.
- `settled()` waits for re-pins but does not order them.

**Fix:** serialise re-pins per bot with a `Map<botId, Promise>` chain. Also re-read the bot after the await and bail out if its model changed.

### 8. Medium: the effective model downgrades on an empty or degraded catalog

`bot-service.ts:353-358`, `effective-model.ts:17-25`, `shared/models.ts:413-432`.

- **Empty catalog.** It resolves to `null`, so a new bot or sender chat is created unpinned. Before, it fell back to `bot.model ?? settings.defaultModel ?? cachedRecommendedModelId()`, and the comment at `bot-service.ts:430-431` guards against exactly this case.
- **Offline.** `fetchAbacusAccount()` returns null, so `payingTier` is false and paid rows are dropped. A bot's explicit model then resolves to a different configured model. That model is persisted on its sessions and applied live, and it flips back when the network returns.
- **Latency.** Every `openChat`/`openSenderChat` and every AG-UI admission on a bot session now waits for this read, which can take up to the 8 s account fetch.

**Fix:**
- When the catalog read fails or lacks the provider data, keep the stored pin.
- Downgrade only on an authoritative "credential gone".
- For a brand-new session, fall back to the old synchronous default when the resolver returns `null`.

### 9. Medium: `agent.setModel` settles its waiters on answers that belong to another request

`services/session/model-switch.ts:75-90`.

`feed` resolves every waiter for the session on any `model_changed`, and rejects every waiter on any `error {model_unavailable}`. The agent also emits these events unprompted:
- OpenLLM rotation emits `model_changed` mid-turn (`packages/agent/src/session.ts:1808`).
- A startup failure emits `model_unavailable` (`:1087-1091`).
- The bot re-pin sends its own `set_model`.

So two concurrent `setModel` calls settle each other: X's `model_changed` resolves Y, and Y's later refusal is lost, or it is raised on X. When the agent has no `modelRuntime`, `applyModel` returns without any answer (`session.ts:2155`), so the RPC call hangs the full 10 s.

**Fix:**
- Store the requested model on each waiter, and resolve a waiter only when `event.model` matches.
- Settle refusals oldest-first: the agent handles `set_model` one at a time.
- Have the agent answer a no-op `set_model`.

### 10. Medium: `browser.runtime.materializeFile` trusts a `hostRoot` sent by the renderer

`rpc/procedures/browser.ts:105-124`, `services/browser/local-preview-file.ts:25-35`, `electron-browser-runtime.ts:783`.

§12.8 requires `hostRoot` to be the session's checkout or an app artifact folder. Nothing enforces that, so `hostRoot: "/"` loads any pdf or html file on the disk. It also widens the view's allowed `file:` sub-resources to the whole disk.

**Fix:** take a `CheckoutRef` (resolved with `checkouts.resolve`) or an artifact-folder id, and derive the root in main.

### 11. Medium: keep-awake can stay held forever because of a stale legacy report, and it misses the current busy value at registration

`main/keep-awake.ts:29-32, 55-58`; `main/index.ts:1819-1821`; `relay-service.ts:426-429`.

- **Stale legacy report.** The legacy renderer's `agentBusy` is cleared only from an effect cleanup (`renderer/hooks/use-keep-awake.ts:41`). A crash, reload or wco swap while it reports busy leaves the flag `true`. Keep-awake ORs that stale flag with main's busy, so the power blocker is never released.
- **Registration gap.** `onBusyChange` does not replay the current value, and it is registered after `workspaceServiceHost.start()` and `startCronScheduler()`. A busy transition before registration is missed until the next change. Nothing starts a run synchronously in that window today.

**Fix:**
- Key the legacy report by the sender's webContents id, and clear it on `destroyed`, `render-process-gone` and navigation.
- Call `setMainAgentBusy(workspaceServiceHost.aguiRelay.busy)` right after registering, or register before `start()`.

### 12. Low-Medium: cron-store ignores the migration write block, although `cronjobs.json` is now a step-5 destination

`cron-store.ts:104-118`.

With an unresolved step-5 attempt, the scheduler keeps writing the file. Rollback then sees the hash changed and keeps the file (`journal.ts:450-455`), which leads to the state in finding 6. The thread store and the transcript service both honour the block (`thread-store.ts:354`, `transcript-service.ts:74`).

**Fix:** check `isMigrationWriteBlocked(FILE())` in `write()`, and hold or skip the write the way those stores do.

### 13. Low: a checkout path that differs in case, or runs through a symlink inside the checkout, trashes a tracked, modified file

`checkout-service.ts:189-202, 300-303`; `git-service.ts:1064-1066`.

`#inside` returns the path as typed, not the real path. Two reproduced cases:
- **Case:** on macOS with `core.ignorecase`, an entry `F.TXT` for a modified `f.txt` misses `HEAD:F.TXT`. The real `f.txt` is trashed, `rm --cached -- F.TXT` matches nothing, and the entry is reported `discarded`.
- **Symlink:** an entry `link/f.txt`, where `link` points to `real/`, trashes the tracked `real/f.txt`.

The same spelling mismatch makes `git.diff` report `none` instead of `untracked` (`:1064`).

**Fix:** canonicalise the path: the realpath of the parent plus the basename, made relative to the checkout's realpath. The status-membership check from finding 1 also covers this.

### 14. Low: `listJsonFiles` is now stricter, so step 1 fails on every launch and step 5 never runs

`migrations/steps/transcript-files.ts:51-58`, used by step 1 at `001-transcripts-v2.ts:52`.

`listJsonFiles` now throws on any `readdir` error other than ENOENT, for example ENOTDIR (when `transcripts` is a file) or EACCES. Step 1 then fails on every launch, and the runner never reaches steps 2 and 5. This feeds finding 6.

**Fix:** make the strict mode opt-in for step 4, or have step 1 treat ENOTDIR as an empty folder.

### 15. Low: `#awaitingStart` can outlive its process, so `busy` stays true

`services/agui/relay-service.ts:382, 419, 1085-1090`.

`runtimeExited` clears `#awaitingStart` only for the current runtime, and the entries are keyed by run id with no process attached. Consider an old process that acks `started` and dies before `RUN_STARTED`, with its `close` arriving after the replacement's `wire.hello`. Its entry is never removed. `busy` then stays true, which holds keep-awake, blocks the renderer swap and the update restart, and makes `cancel` treat the dead run as current.

**Fix:** record which process acked each entry, and drop that process's entries on its exit or on a new `wire.hello`.

### 16. Low: gaps in the cue arbiter

`notch/cue-arbiter.ts:116, 176-192, 203-214`.

- (a) `forgetWindow` is never called in production, so `#visible` grows by one entry per renderer generation.
- (b) `#fallback` rechecks `canPlay` but not focused-thread suppression. If the main window focuses the thread during the 1 s wait, the cue still plays. This cannot happen under `mainOnlyCueWindows`.
- (c) `#prune` deletes entries that were already decided. The same `cueId` claimed after 10 minutes, or after more than 1,000 entries, can be granted again.

**Fix:** call `forgetWindow` on the webContents `destroyed` event; recheck suppression in `#fallback`; keep tombstones for decided ids for the TTL.

### 17. Low: a rejection is permanent, and rejected experience trees are never deleted

`experience-store.ts:287-311, 339`; `experience-updater.ts:230-233`.

- A rejection is keyed on `(version, sha)` with no expiry, so a transient readiness failure (a slow machine) blocks that release on this machine forever.
- The rejected candidate's `experiences/<version>/` folder is never removed.

**Fix:** store the app version with each rejection and drop it on an app update, or after a TTL. Delete the candidate's folder on abandon when it is neither the active nor the previous experience.

### 18. Low: partial discards are reported `failed` while the contract says a failed entry changes nothing

`git-service.ts:1117-1156`; `shared/contract/git.ts` (discard doc).

Two cases break that promise:
- The Trash succeeds, then `git rm --cached` throws.
- For a rename, the destination is trashed and unstaged, then restoring `origPath` fails.

**Fix:** add a `partial` reason, or weaken the doc.

### 19. Low: a backslash in a file name is treated as a separator on POSIX

`checkout-service.ts:191`, `git-service.ts:1112`.

A file named `a\b.txt` (a legal name) is discarded as `a/b.txt`. Nothing happens, yet it is reported `discarded`.

**Fix:** convert `\` only when `path.sep === "\\"`.

### 20. Low: a watched checkout keeps its old path after the workspace is relocated

`checkout-service.ts:370-387, 458-479`.

The `ws:primary` key survives `relocateWorkspace`. The watchers and `entry.target.path` stay on the old folder, so `treeRoot`/`treeChildren` show the old folder's changes, and the `gitState` row publishes the old `checkoutPath`.

**Fix:** in `watch()` and `refresh()`, re-resolve the checkout and restart the entry when its path changed.

### 21. Low: `materializeFile` keeps a wider root lock from an earlier call

`electron-browser-runtime.ts:380`.

The view is replaced only when `file` changes. Materializing the same file again with a narrower `root` keeps the old view and its wider root lock.

**Fix:** include `root` in the comparison.

### 22. Low: step 5 drops malformed entries silently, and only in some jobs

`005-routine-attempt-ids.ts:121-127, 152`.

A job with at least one entry without an id gets the filtered list, so its malformed entries are removed. A job whose valid entries all have ids keeps its malformed entries.

**Fix:** map over `job.runs` and replace only the entries that pass the guard.

### 23. Low: problems matching legacy timeouts and start failures to sessions

`routine-attempts.ts:92, 162-166`.

- **Duplicate claims.** Timeouts match records by `endedAt` with an empty exclusion set. Two timeouts within 2 s of one record can both claim it, and a timeout can claim a run that finished normally.
- **Unlinked start failures.** Legacy `session failed to start: …` entries never get a session, although their sessions exist in `local-code.json`.

**Fix:**
- Keep a set of sessions already claimed by timeouts, and prefer records whose `Outcome` is `failed`.
- Match start failures against `localCode.agentSessions` by `routineId` and `createdAt`.

### 24. Low: renderer-next `DEFAULT_PREFS` lacks every new leaf, and nothing compares it with main

`renderer-next/data/db/prefs.ts:16-35` compared with `services/config/prefs-store.ts:70-90`.

Main's values match the specs:

| Leaf | Main's default |
|---|---|
| `sounds.perBot` | `{}` |
| `sounds.quietHours` | `{false, "22:00", "08:00"}` |
| `keymap` | `{}` |
| `appearance` | `{14, true}` |
| `notch` | `{true, true, true, false, true}` |
| `onboardingFlow` | `null` |
| `onboardingExit` | `null` |
| `onboardingPairing` | `[]` |
| `tour` | `{unseen, null}` (no spec default) |

The renderer has only `sounds {enabled, perEvent}`. This is a documented deferral (departure 1), but no test asserts that `DEFAULT_PREFS` equals `{id, ...PREFS_DEFAULTS, updatedAt}`, so it can drift silently.

**Fix:** add the leaves to `DEFAULT_PREFS`, make them required in `PrefsRow`, and add that equality test.

### 25. Low: nothing checks the committed PARITY.md

`preload/parity.test.ts:302-309`.

The test writes the file only under `UPDATE_PARITY=1`, and never compares the committed file with the generated output. The file is byte-identical today (263 procedures), but future drift would pass CI.

**Fix:** when `UPDATE_PARITY` is unset, assert that the file equals the generated output.

### 26. Low: the legacy `git.diff` RPC no longer shares a body with its IPC handler

`rpc/procedures/git.ts:50-55`, `service-host.ts:1057-1064` compared with `handler.ts:624`.

The RPC without `checkout` now goes through `checkouts.diff`, which returns the typed result and throws `FORBIDDEN outside` where it used to return `""`. The IPC handler still returns a string. This is intended by §26.4 h (departure 3), and it has no effect on the old renderer, which uses IPC only. It should still be listed explicitly as an exception to "IPC and RPC share handler bodies", next to departure 5.

### 27. Low: the `#` reservation has two small gaps

- **Claim before validation.** `ai.send` adds the thread to `#claimed` (`relay-service.ts:754`) before the `#`/`%` check (`:764`). A refused send still switches the thread's next spawn to agui. Nothing is written, but the order is wrong. **Fix:** claim after validation.
- **User message id not encoded.** The agent's `userInput` passes the client `messageId` through without `nativeId` (`packages/agent/src/agui/host.ts:466-468` → `emit.ts:418`). Only main's refusal protects it. **Fix:** wrap it in `nativeId`; plain ids are unchanged, so the goldens stay the same.

### 28. Low: debug sync now converts v1 transcripts as a side effect

`service-host.ts:544-548`, `debug-sync/debug-sync-service.ts:84-92`.

`readThread` is `threadStore.readCurrentFile`. It flushes, reads v1 (up to 64 MB), and may write a converted twin file. This now runs on every debug-sync read and for every file in the startup sweep, which now also lists `threads/`. Only files whose source kind is `agui` contribute anything.

**Fix:** use a cheap reader of `threads/<id>.json` that returns a result only for `source.kind === "agui"`.

### 29. Low: `permission.pending` is applied from any incarnation

`services/agui/thread-relay.ts:1273`.

The event replaces `#permissions` whatever incarnation it carries. This cannot happen today, because `cli-manager-service.ts:701` drops lines from a process that no longer owns the session. As defence in depth, ignore the event when `this.incarnation != null` and the event's incarnation differs.

### 30. Low: legacy-visible changes that the spec asks for

`update-service.ts:393-397`. The `installUpdate` catch now sets `status.error`, including for the pre-check "No update downloaded to install", which used to return quietly. The old renderer will now show it. Spec 05 §31.5 h mandates this. Listed so you know about it.

### 31. Low: step 1 now treats more v1 files as cleared

`transcript-files.ts:169-173`.

A clear marker without `savedAfterClear` now counts any v1 bytes as cleared. Before, only bytes matching `v1Fingerprint` did. The failure mode is safe: history is hidden, not deleted. Note it in the implementation notes if it is intended.

### 32. Low: the run-row join recomputes every routine's derived fields on each read

`rpc/tables/routine-runs.ts:13-15`, `service-host.ts:3922-3934`.

The join goes through `listRoutines()`, which recomputes each routine's next fire time, bot name and webhook URL. For an impossible schedule the next-fire search walks about 527k minutes. The table also re-reads on every cron write.

**Fix:** join against a runs-only source such as `listJobs`.

### 33. Tests that pass without the fix

- `experience-activation.test.ts:102`: forces `barrier: "subscriptions"` with a mocked swap (finding 2).
- `git.discard.test.ts`: every case runs at the repo root with exact-case paths. There is no subfolder checkout, case variant, internal symlink, directory with a staged new file, plain untracked file, or name with a leading `-` or a space (findings 1, 4, 13, 19).
- `bot-errors.test.ts:66-77`: builds its own `serviceHost` that calls `assertNotChannelBot`, so it would pass if `service-host.ts:2500/2509` dropped the guard.
- `phase5-procedures.test.ts:108-115`: the fake `createRoutine` calls `parseCron` itself, so the test does not prove `createJob` lets `CronParseError` through (it does today, at `cron-store.ts:158, 222`).
- `cli-manager-taps.test.ts:127-148`: compat lines and the exit marker go into separate arrays, so the "fd 3's last line before the exit" ordering is not asserted. **Fix:** use one ordered log.
- `ai-attention.test.ts:251`: covers a late list from a dead incarnation only when it arrives before the new incarnation's list (finding 29).
- No test covers finding 6's order of events (fallback write first, then step 5).

---

## Confirmed correct

- **Checkout containment:**
  - `..`, absolute paths, and symlinks that point outside (directory, file and dangling) are refused through the realpath check (`isInsideWorkspace`/`realPathOf`), and the FORBIDDEN test really exercises it.
  - Sibling folders with a shared prefix are handled by `path.relative`.
  - The empty path and `.` are refused for mutations.
  - The macOS containment check lowercases both paths.
  - Every git call that takes a path passes `--` and `GIT_LITERAL_PATHSPECS=1` and uses `execFile`.
- **Worktree isolation:**
  - `resolve` uses `session.worktreePath` and requires the session to belong to the named workspace.
  - `worktreeId`/`worktreePath` are always set together, so a worktree session never falls back to the primary checkout. A deleted worktree gives FORBIDDEN or `none`, never the primary.
  - R4-T33 hashes the primary's status.
- **Discard ordering:** the Trash runs before the index change, and a Trash failure skips the index change. A rename source must also be inside the checkout.
- **Legacy IPC is unchanged:**
  - `handler.ts` and the legacy ServiceHost methods have no diff.
  - Legacy relocate keeps the tombstone.
  - Legacy materialize without `operationId` is unchanged.
  - `setAgentModel` is still fire-and-forget.
  - The bot, routine and timeout error messages are byte-identical to c46e77d9, and the typed errors set no `name`.
  - `worktreeOperationId` is not writable through `db.sessions.update`.
- **Shared handler bodies:** `window.setDensity`/`settings:set-titlebar-density` and `system.loginItem` share their bodies with IPC. The login item is refused on Linux without calling Electron.
- **LineSplitter (#11):**
  - Characters of 2 to 4 bytes split across chunks are joined.
  - `\r\n` split across chunks is handled, and a lone `\r` is kept.
  - Overflow is counted in UTF-16 units, as before.
  - EOF flushes the decoder (an incomplete character becomes U+FFFD), and a line being discarded is not delivered.
  - `end()` is idempotent, so the fd 3 `end` and `close` handlers do not deliver twice.
  - Node's `close` waits for fd 3, so the last compat line precedes `emitAguiExit`.
  - The decoder's BOM strip differs from `Buffer.toString`, but it is harmless: `handleNdjsonLine` already `trim()`s, and the preamble check uses `includes`.
  - Well-formed input gives identical lines.
- **`ai.runFinished`:**
  - Published once per run from `#finishRun`, and the first terminal wins.
  - `clearByMain` retires the run as `cancelled`. A crash goes through `synthesizeTerminal`, and a respawn without an exit is closed at `wire.hello`.
  - A retried run id is answered `duplicate`.
  - The replay (`seq > afterSeq`) and the listener registration happen in one synchronous step.
- **`ai.attention`:**
  - Snapshot and registration happen together, and the revision is monotonic.
  - A new incarnation (hello, `STATE_SNAPSHOT`, `session.ready`) resets the list, and an exit clears it through the synthesized `permission.pending []`.
  - `forgetThread` removes the row, and an unchanged set of ids publishes nothing.
- **Relay busy (#10):** `#busyCheck` runs after every change to `#waiting`, `#awaitingStart` or an active run. `agentTurnBusy` leaves agui sessions out of the compat turn-state count.
- **Native ids:**
  - The encoding is reversible, including inputs such as `%23`, `%2#` and `#25`. Encoded ids contain `%` and never `#`, so they cannot collide.
  - The agent and desktop encoders match. Tool, child, fallback and gate ids all go through `nativeId`.
- **sync-log:** keys are ids, not positions, and migrated messages keep their v1 segment keys. `id#n` part keys cannot collide with native ids.
- **HeldFiles:** replay before write, a destination check against hash collisions, memory fallback, and delete after replay.
- **Step-5 id stability:**
  - `legacyAttemptId` hashes `routineId`, `at`, `trigger`, `result` and an ordinal joined by `\0`. These fields are immutable, and no JSON serialisation is involved.
  - The ordinal counts identical entries from the oldest, so prepending runs never moves an id.
  - The migration and the cron-store read call the same function.
- **Step-5 journal and kill harness:**
  - The plan writes only to staging, and the write is `replace-user` with its backup checked.
  - A re-run writes nothing, and a missing or corrupt file is left alone.
  - The harness kills at every mutation, and the next launch always ends committed.
- **Cron parser:** the logic and error messages are the same as the old cron-store parser. `CronParseError` and `TimeoutError` map to `BAD_REQUEST {field: "schedule"}` and `TIMEOUT {ms}`.
- **Step 2:**
  - The onboarding canonicalisation matches §23.
  - The sound opt-out never overrides a `user` value and resets when the opt-out is lifted. The live sync covers installs that already applied step 2.
- **Activation crash safety:**
  - `activate({commit: false})` writes nothing, so a crash before commit boots the committed experience.
  - `commitActivation`'s two writes are ordered safely.
  - `rejected.json` is bounded at 20 entries and deduplicated.
- **`pinSession`:** writes only when the stored model differs, and non-bot sessions return before the catalog read.
- **Update `failedPhase`:** it is read before the state is cleared, and a new check clears both `error` and `failedPhase`.
- **PARITY.md:** regenerating it gives byte-identical output.
