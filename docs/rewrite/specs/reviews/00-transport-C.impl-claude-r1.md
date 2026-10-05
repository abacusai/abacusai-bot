# Spec 00 sub-slice C (runner, prefs step 2, live sync, progress window): implementation review, claude r1

Scope: `git diff 6aca10c1..70a3ec36 -- apps/desktop/src/main/migrations apps/desktop/src/main/services/config apps/desktop/src/main/index.ts`, checked against spec 00 §C.1, §C.2, §C.4, §C.5, §C.7–C.9, "Deferred additions" (language), "Implementation notes (sub-slice C)" and PLAN.md. Step 1 (`transcripts-v2`) is intentionally absent and not reviewed. The old renderer's stores (`code-store.ts`, `sidebar-accordion-store.ts`, `language-store.ts`, `credits-store.ts`, `code-folder-context.ts`, `use-theme.ts`, `browser-homepage.ts`, `referral-card.tsx`, `credits-exhausted-card.tsx`, `onboarding-flow.tsx`, `i18n.ts`) were read to check the mapping. Findings come from reading the code. Nothing was executed, and no repo files were changed apart from this one.

## Crash-window table (commit and recovery protocol)

This table lists every point where a `SIGKILL` can land, in protocol order, and what the next launch does as the code stands. "OK" means the next launch reaches a consistent state and finishes.

| # | Kill point | Next launch | Verdict |
|---|---|---|---|
| W0 | During `plan()`: staging is partly written and there is no journal | Staging is discarded, then the step reruns | OK |
| W1 | During step 1 backups (`copyFileAtomic(dest, backup)`), before the journal | Staging is discarded. The partial `backups/migrations/<stamp>-…` directory is orphaned: it counts toward "newest 3" and is later pruned | OK (leak, harmless copies) |
| W2 | Right after `writeJournal` (atomic), before the first rename | Undo runs with `done: []`. Every staged file still exists, so nothing counts as renamed. Then backupDir and staging are deleted | OK, but see finding 1 for the deletion order |
| W3a | Between a **same-volume** `renameSync(staged, dest)` and the journal update | Heuristic: the staged file is gone, so the write counts as renamed and is undone | OK |
| W3b | Inside the **EXDEV** fallback, after `copyFileAtomic(staged, dest)` renamed into place but before `rmSync(staged)` | The staged file still exists and `done` lacks it, so recovery treats it as **not renamed**. The dest keeps the new content, and the backup is then deleted | **Broken**, finding 2 |
| W3c | EXDEV, after `rmSync(staged)`, before the journal update | Heuristic catches it | OK |
| W4 | Between a journal update and the next rename | Normal undo | OK |
| W5 | A removal's move (rename, or copy+rm) before or after its journal update | `exists(path) \|\| !exists(backup)` covers every ordering | OK |
| W6 | All renames and removals done, before `writeRecord` | Journal found and the commit is not recorded, so it is undone and the step reruns | OK |
| W7 | After `writeRecord`, before `removeStaging` deletes the journal | The commit stamp is recorded, so the result is `finished` (staging deleted, nothing undone) | OK. Finding 9 covers the stamp-collision caveat |
| W8 | Between the journal `rm` and the staging `rm -r` | Staging without a journal is discarded | OK |
| W9 | Recovery, part way through `undoCommit` | Undo is idempotent (restores copy from the backup again, `rm` uses force, removals use existence checks) | OK |
| W10 | Recovery, after `undoCommit` and during or after `rm -r backupDir`, **before** the journal is deleted (`runner.ts:188-189`) | The journal is still unrecorded, so undo runs again. A `replace-user` write in `done` finds its backup gone and throws. This repeats on **every** later launch | **Broken**, finding 1 |
| W11 | In-launch commit failure, same gap (`runner.ts:326-328`) | Same as W10 | **Broken**, finding 1 |
| W12 | During the undo restore (`copyFileAtomic(backup, dest)`) | Leaves `<dest>.<pid>.migrating-tmp` next to the user's file (for example `~/.abacusai-bot/prefs.json.1234.migrating-tmp`) | Nit, finding 18 |
| W13 | During `pruneBackups`' `rm -r` of a backup directory | A partial backup directory is left under a valid stamp name. PARITY.md's manual rollback would then copy back an incomplete set | Low, finding 18 |
| W14 | `--rerun-migration` with a finished-but-undeleted staging (W7 state) | The rerun removes the entry and writes the record **before** recovery. Recovery then undoes a commit that completed | Low (dev only), finding 10 |

## Findings

### 1. High: deleting backupDir before the journal can wedge recovery on every later launch
`runner.ts:184-190` (launch recovery) and `runner.ts:325-328` (in-launch undo); `journal.ts:111-119`.

Both paths run `undoCommit`, then `fs.rmSync(journal.backupDir, …)`, then `removeStaging(staging)`, which deletes the journal. A kill (or an `rmSync` error, such as EBUSY or EPERM on Windows under AV) after the backup directory is gone but before the journal is deleted leaves an unrecorded journal whose `replace-user` backups no longer exist. On the next launch, `undoCommit` throws "backup … is missing; not undoing", and the runner records `lastFailure`, keeps the journal and runs **no** step. That repeats on every launch with no way out: step 1, and later the cut-over steps 3 and 4, never run. The C-T3 test "stops, keeping the journal, when recovery cannot restore a backup" asserts this dead end as the desired behaviour.

**Fix:**
- Order the cleanup as: undo, then delete the journal (or first rewrite it with `undone: true`), then `rm` backupDir, then `rm` staging. Once the journal is gone, a leftover backupDir is only an orphan that pruning removes.
- Make the missing-backup refusal recoverable. Record `sha256` of each staged file and of each original `dest` in the journal. If the backup is missing but the dest hash equals the original hash (already restored) or the staged hash does not match (never renamed), treat that write as done rather than throwing.

### 2. Medium (High once step 3 lands): the rename-done heuristic has a false negative on the EXDEV path, and the backup is then deleted
`backup.ts:87-96` (`moveFile`), `journal.ts:105`, `runner.ts:188`.

`moveFile` falls back to `copyFileAtomic(source, dest)` followed by `rmSync(source)`. A kill between those two leaves the dest replaced while the staged file still exists. `undoCommit` decides the write was not renamed, leaves the dest with the new content, and the runner then deletes `journal.backupDir`, which holds the only copy of the original. For step 3 (`replace-user` of `userData/renderer-state.json`, with keys dropped), that means the legacy keys are gone and their backup is deleted. The rerun then finds nothing to import, and `resetLegacy` puts the `legacy` prefs fields back to their defaults. This path only occurs when userData and home are on different volumes (for example `ABACUSAI_BOT_HOME` on another disk), which is exactly the case the EXDEV fallback exists for.

**Fix:** the done/not-done question does not need answering for writes. Undoing *every* planned write unconditionally is safe:
- A `replace-user` write with a backup is restored from that backup, which equals the pre-commit content.
- A `create` write, or a `replace-user` write with no backup, did not exist at backup time, and nothing else writes it, so deleting it is correct.
- A `replace-derived` write is kept.

False positives are already harmless, and this also removes the false negative. If `done` is kept for logging, also journal an "attempting `<dest>`" entry before each move.

### 3. Medium: a corrupt or unreadable journal discards staging without undoing a possibly half-applied commit
`journal.ts:65-80`, `runner.ts:171-176`.

- `readJournal` returns `"missing"` for **any** read error (EACCES, EMFILE, EISDIR, a transient Windows lock), not only ENOENT. `removeStaging` then deletes the journal it could not read, so a commit that was mid-flight is silently kept half-applied.
- A `"corrupt"` journal takes the same discard path. The journal is written atomically, so corruption means disk-level damage, and the commit state is unknown: the dests may be replaced, and the only copy of the originals sits in a backupDir the runner no longer knows about, which pruning later removes. That contradicts the notes' own policy of "recovery refuses to guess".

**Fix:**
- Return `"missing"` only for ENOENT. Rethrow other errors into the recovery `catch`, which records `lastFailure` and leaves the staging alone.
- For `"corrupt"`, refuse the same way (record, keep the staging, run no step), or locate the backupDir by the step name prefix and restore it. Do not discard.

### 4. Medium: undo can clobber later provenance writes, including new-UI `"user"` choices
`journal.ts:111-115`; `runner.ts:325-333` (undo failure → "left for the next launch"); `index.ts:1704`.

When an in-launch undo fails, or launch recovery fails, the app keeps running. Disk-full is the realistic case: the rename succeeds, `writeJournal` hits ENOSPC, and the undo's copy hits ENOSPC too. `installLegacyPrefsSync` and `db.prefs.update` then write `prefs.json` directly, outside the journal. A later launch's recovery copies the pre-step-2 backup over that file unconditionally. The session's legacy-sync results are lost, and so are any fields the new UI marked `"user"`, which breaks the rule that new-UI choices are never overwritten.

**Fix:** only restore a `replace-user` dest whose current hash equals the staged hash recorded in the journal (see 1). If it differs, the file has moved on since the commit: keep it and log. Alternatively, skip `installLegacyPrefsSync`'s write path while a step-2 journal is unresolved.

### 5. Medium (latent, step 1 and step 4): the journal is rewritten in full after every rename, and the commit never yields
`runner.ts:287-299`, `journal.ts:47-49`.

Each rename rewrites the whole journal (all `writes`, `removals` and `done`) through `writeFileAtomicSync`. For step 1 at about 2k transcripts (a 2k-entry `writes` array of roughly 300 B per entry, so about 600 KB), that is about 2k × 600 KB ≈ 1.2 GB written, with 4k extra renames. The commit loop is also fully synchronous, so:
- the progress window gets no updates during the commit;
- on Windows, the blocked browser-process message pump makes the frameless window, and the app, show "Not Responding" after 5 s.

C.9 promises "yields to the event loop every 20 files", but that only holds inside `plan()`.

**Fix:** write the plan once, then append one line per completed move to a `done.log` (`appendFileSync`, parsed tolerantly), or drop `done` entirely per finding 2. Make the commit loop `async` and yield (`await setImmediate`) every N moves, reporting progress for the commit phase too.

### 6. Medium: the progress window can be closed by the user, which quits the app mid-migration on Windows and Linux; a failed launch chain leaks it
`progress-window.ts:149-162`, `startup.ts:53-56`, `index.ts:2073-2075`, `index.ts:2102`.

- The window is frameless but still closable and focusable, so Alt+F4 works on Windows and Linux (Cmd+W depends on the menu). Closing it fires `window-all-closed` → `app.quit()` while `runMigrations` is between awaits. `before-quit` then runs `workspaceServiceHost.dispose()` and `disposeLocalModels()` on a host that was never initialised. The result is crash-safe (a W0 or W6 state), but the app disappears on first launch of the upgrade.
- `disposeMigrationProgress()` is only in the success `.then` after `createWindow()`. If `workspaceServiceHost.initialize()`, `initializeExperienceRuntime`'s chain or `createWindow` rejects, the hidden `BrowserWindow` lives forever, and on Windows and Linux the process can outlive every visible window.

**Fix:**
- Construct the window with `closable: false, minimizable: false, maximizable: false, skipTaskbar: true`, and add `window.on("close", e => { if (!disposing) e.preventDefault(); })`.
- Call `disposeMigrationProgress()` from a `.finally` on the chain, or on the main window's first `show`/`ready-to-show`, and also from `before-quit`.

### 7. Medium (latent, step 4): quarantine pruning uses mtime, which a rename preserves
`backup.ts:151-168`.

Step 4 is specified to move skipped v1 files into `backups/quarantine/transcripts/` and keep them 90 days. `pruneBackups` ages each entry by `statSync(target).mtimeMs`. `renameSync` (and `copyFileSync` on some platforms) keeps the source mtime, so a transcript last touched 91+ days ago is quarantined and then **deleted at the end of the same run**. The C-T3 prune test hides this because it sets the quarantine mtime with `utimesSync`.

**Fix:** quarantine into stamped subdirectories (`quarantine/transcripts/<stamp>/…`) and prune by the directory stamp, as for migrations backups. Alternatively, `utimesSync` each file at quarantine time, but a stamped directory also survives copies.

### 8. Low: pruning never runs once every step is applied
`runner.ts:206`.

`if (pending.length === 0) return result;` returns before `pruneBackups`, so the 30-day and 90-day retention only applies on a launch that migrates something. After the last step, backups and quarantine are kept forever. It is safe, but it is not the retention C.1 describes. The C-T3 prune test only passes because it registers a pending step (`fileStep(9, "z")`).

**Fix:** prune on every launch that reaches the end without failure. Pruning is cheap: one `readdir` of `backups/migrations` and one of `quarantine`. Also run `rmdirSync(.migrating)` there, since it is currently skipped too, which leaves an empty `.migrating/` after a W7 or W8 recovery.

### 9. Low: the `finished` check matches on the stamp alone
`runner.ts:178`, `runner.ts:244`.

`record.applied.some(a => a.commit === journal.commit)` ignores `id`, and the stamp has millisecond resolution from `now()`. Two steps committed in the same millisecond (fast steps, or a clock step) would make an unrecorded journal look finished, so it would not be undone.

**Fix:** match `a.id === journal.id && a.commit === journal.commit`, and add a random suffix to the commit stamp (the backup-directory name already carries the id).

### 10. Low (dev only): `--rerun-migration` is applied before recovery
`runner.ts:124-132` precedes `runner.ts:160-200`.

With a W7 leftover (recorded commit, staging not deleted), the rerun first removes the id from `applied` and writes the record. Recovery then sees an unrecorded journal and undoes a commit that completed.

**Fix:** run recovery first, then apply `rerun`.

### 11. Low: step 2 records success when `renderer-state.json` exists but cannot be read
`002-prefs-from-renderer-state.ts:46`, `renderer-state.ts:24-41`.

`readRendererStateFile` maps every error (EACCES, EBUSY) to an empty map. Step 2 then plans nothing and is recorded as applied with `keys: 0`, so it never runs again. The install-time import in `installLegacyPrefsSync` makes this recoverable, which is why it is Low, but the migration record then reports something that did not happen.

**Fix:** in the step, `statSync` the source first. If it exists and cannot be read or parsed, throw, so the step is retried next launch. A corrupt file can still count as empty if that is the chosen rule, but it should appear in `stats`.

### 12. Low: an invalid member invalidates the whole member field, so a valid key's part is lost
`legacy-prefs.ts:286-289` with `:222-227`.

`composeLegacyPrefs` marks the whole field invalid when any contributing key is invalid. Two cases:
- `referral-card.dismissed-until = "abc"` (the old UI reads `Number(...)` as NaN, so the card shows) also blocks `local-code:upsell-dismissed`, which the old UI honours as dismissed.
- A corrupt `local-code-ui-store` blocks `sidebar.openSection` from a valid `sidebar-accordion` key.

In both cases the field stays frozen at its previous value while the old UI shows something else.

**Fix:** track invalidity per member for the `MEMBER_FIELDS`, compose the valid members over `legacyBase`, and count the invalid ones in `stats.invalid`. Keep whole-field invalidity for scalar fields.

### 13. Low: `onboarding.step` and `browser.homepage` are copied raw, without the old UI's validation
`legacy-prefs.ts:215-221`.

The old UI reads `onboarding.step` through `isOnboardingStep` (anything else means `null`), and `browser.homepage` through `normalizeBrowserHomepage` (a non-http(s) value falls back to the default). The mapping copies any string, so `prefs.json` can hold a step or homepage the old UI would ignore. That breaks "starting from what the old renderer shows".

**Fix:** apply the same predicates. Move `isOnboardingStep` and `normalizeBrowserHomepage` to `shared/`, or duplicate them with a parity test.

### 14. Low: sidebar "absent" disagrees with the old UI
`legacy-prefs.ts:255-258`, `:282-285`.

With only `local-code-ui-store` present, `openSection` composes to `"bots"` (the old default), which is correct. With **neither** key present (fresh old UI, sidebar never toggled), the field is absent and ends up `openSection: null` (via `resetLegacy` or the default), while the old UI shows Bots. The notes state the rule "what the old renderer shows for a missing member", and this case breaks it.

**Fix:** either treat the absent `sidebar` as `legacyBase("sidebar")` for an import, or document that "absent" deliberately means the new default.

### 15. Low: a missing zustand `version` is treated as matching
`legacy-prefs.ts:109-114`.

zustand compares `deserialized.version !== options.version`, so `undefined !== 0` means the value is discarded (the stores have no `migrate`). The mapper treats a missing `version` as present. zustand always writes `version`, so this is a nit.

**Fix:** use `parsed.version !== storeVersion` when `storeVersion !== null`.

### 16. Low: the record's `version` is ignored on read and forced to 1 on write
`record.ts:60-80`.

A future record format (`version: 2`) read by this build after a downgrade is parsed as v1 and rewritten by `fail()` or `rerun`, which loses the newer build's fields.

**Fix:** if `version > 1`, run no steps and never write the record (log it). The journal has the same issue: `isJournal` ignores `version`.

### 17. Low: the progress window's colours follow the OS, not the user's theme
`startup.ts:30`.

`dark` is read from `nativeTheme.shouldUseDarkColors` before `applyStartupTheme` or `theme:set` has applied the stored theme. A user who chose dark on a light OS sees a light progress window.

**Fix:** read the legacy `theme` key from `readRendererStateFile` (or `prefs.theme`) and resolve it. This is cosmetic.

### 18. Nits
- `copyFileAtomic`'s temp file sits next to the dest (`backup.ts:77`), so W12 leaves `prefs.json.<pid>.migrating-tmp` in the home. Put the temp under staging when on the same volume, or sweep `*.migrating-tmp` on recovery.
- A prune kill (W13) leaves a partial backup directory with a valid name. Rename it to `.pruning-<name>` first, then `rm -r`, and sweep `.pruning-*` at start.
- `validatePlan` does not reject two writes that share one `staged` path, or dests outside `home`/`userData` (`runner.ts:365-386`).
- `moveFile` and `copyFileAtomic` use a bare `renameSync`, without the EPERM/EBUSY retry that `writeFileAtomicSync` has, so a Windows AV lock turns into a commit failure and undo. That is safe but noisy.
- The live sync does a synchronous compose, validate and atomic write on the main thread for each change to `local-code-ui-store`. That is fine at the current write rates. Note it if `code-store` ever persists anything per keystroke.

### 19. Tests that don't prove their claim
- **C-T3 "stops, keeping the journal, when recovery cannot restore a backup"** asserts the permanent dead end of finding 1 as correct. It also deletes the backups by hand, while the runner reaches that same state itself through W10 and W11. Add: a crash between `rm backupDir` and the journal deletion, then the next launch completes the step.
- **C-T3 "finishes a recorded commit whose staging survived"** fabricates the journal (`backupDir: "nope"`, `backup: null`) instead of driving the real W7 window. `CommitHooks` has no `afterRecord` seam. Add one and crash there.
- **C-T3 "undoes a rename the journal missed"** only checks the `replace-user` file. It does not check that `create` and `replace-derived` are handled by their rules in that state. No test covers the EXDEV path (finding 2). Inject a `moveFile` that throws EXDEV, then crash between the copy and the `rm`.
- **C-T3 prune test** hides findings 7 and 8: the quarantine age is set with `utimesSync` (not by a real move), and pruning only runs because a pending step is registered.
- **C-T6 "never created when the runner finishes in under 400 ms"** runs a no-op step under fake timers. It proves the 400 ms delay, not the spec's claim. The real commit never yields (finding 5), so for a slow synchronous step the window opens late or not at all, and never updates during the commit. `startup.test.ts` mocks the runner and asserts nothing about `finish()`/`dispose()` ordering relative to `createWindow`, which is the Windows and Linux quit hazard the notes cite. Add a test that `disposeMigrationProgress` runs only after the main window exists, and runs on a rejected chain.
- **C-T8 "ignores unmapped keys and never writes renderer-state.json"** checks `existsSync(stateFile)` synchronously, before the store's own 500 ms debounce, and only for unmapped keys. It cannot fail for a mapped-key write path. The real guarantee is the `LegacyStateSource` type, which has only `get`/`onSet`. Say that in the test, or assert on a spy `fs.writeFileSync` over a mapped-key `set` with the timers advanced.
- **C-T5** has no case for "absent" member fields (finding 14) or a partly invalid `dismissals` (finding 12).

## Confirmed correct
- **Startup ordering.** `runStartupMigrations` runs only after the single-instance lock is held (the lost-lock path returns before it). It runs before `registerUpdateHandlers`, `workspaceServiceHost.initialize()` (`index.ts:1685` → `:1688`), `registerRendererState()`, `installLegacyPrefsSync` and `installRpc`/`createTables`. The module-level `PrefsStore` (`index.ts:519`) loads lazily, and nothing reads it before the migration, so it never holds a stale cached row over the migrated `prefs.json`. The install-time sync import runs before `createTables`, so there are no missed feed batches (the feed's baseline is read later), and `followPrefsTheme` only needs later changes (`applyStartupTheme` reads prefs in `createWindow`, and the legacy UI applies `theme:set` itself).
- **`renderer-state.json` is never written by new code.** Step 2 only reads it (`readRendererStateFile`). The sync is typed against `LegacyStateSource` (`get`/`onSet`), which has no write path. The C-T5 goldens check the source is byte-identical. `legacy-home.test.ts` checks that every legacy file is byte-identical.
- **The old renderer's behaviour is unchanged.** `RendererStateStore` parses and budgets the same way (the constructor refactor keeps the totals). Listeners run after the change, never on a no-op or dropped write, and exceptions are contained. `clear()` notifies after the state is empty, so every per-key re-import sees the fully cleared state. The IPC stays fire-and-forget.
- **Provenance.** `importLegacy` never touches `"user"`. `resetLegacy` touches only `"legacy"` (back to `"default"`). There is no default-equality merge. Every per-key sync recomposes the field from **all** keys, so `sidebar` (from `local-code-ui-store` + `sidebar-accordion`) and `dismissals` (from two keys) stay correct when one key changes or is removed. The C-T8 test covers the sidebar case.
- **Language.** The mapping mirrors `i18n.ts` `storedLanguage` exactly: the version is ignored; an explicit supported code maps to itself; corrupt, empty, `null` or unsupported values map to `"system"`; with no key the field is absent, so it is reset only if `"legacy"`. The shared `SUPPORTED_LANGUAGES` matches the renderer's loader list.
- **Other mappings.** `local-code-ui-store` below v4 needs no deletions (the deleted fields map to nothing). The defaults match the stores (`isSidebarVisible: true`, Yolo, empty lists). `exhaustedAt` is a number. Upsell presence semantics and `referral-card` `Number()` match the old UI.
- **Commit protocol.** The record is written only after every move. The `commit` stamp correctly tells W7 (finished) from W6 (undo). The "staged gone ⇒ renamed" heuristic is correct for same-volume renames, and its false positives are harmless. Removal recovery is correct in every ordering, EXDEV included. A `create` whose dest has appeared is upgraded to a backed-up `replace-user`. `removeStaging` deletes the journal first, so a partly deleted staging is only ever discarded. A plan failure deletes staging and records `lastFailure`, which is cleared on success. `runMigrations` never throws, and `runStartupMigrations` also catches.
- **Step 2.** The import runs through the store's own provenance rule on a staged copy. There is no write when nothing changed, so a rerun makes no backup. The write is `replace-user` (backed up) when `prefs.json` exists, including a corrupt one. No `prefs.json` is created when there is nothing to import, which keeps downgrade safety.
- **Progress window.** It is hidden, not destroyed, on finish, and destroyed only after `createWindow`, which avoids a `window-all-closed` quit on Windows and Linux in the normal path. A `ready-to-show` after close does not show it. The page is sandboxed, contextIsolated and loaded from `data:` with no external resources. The app name is HTML-escaped, and the label goes through `JSON.stringify` into `executeJavaScript`. Throttling keeps the latest value and a trailing push.
- **Pruning.** It only runs after a fully successful run, so it never deletes the backupDir of an unresolved journal. Unrecognised directory names are left alone.
