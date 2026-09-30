# 07 — Cut-over (phase 7)

Status: draft spec **r1** (no code; the Codex review comes next). Branch `rewrite/renderer`, `HEAD 24b02486`. It implements the "Cut-over" phase of `docs/rewrite/PLAN.md` (§Phases and PR stack, phase 7: "Delete the old renderer, conversation layer, NDJSON host, `window.api`, zustand stores, unused patches; knip clean; size-limit set; PARITY.md all green; migration runs on real data from a backup. Gate: `pnpm check` green; release build smoke on macOS and Windows"). This is where the new renderer becomes the shipped one and the old tree is deleted. It builds on:

- `00-transport-db-migration.md` **r2** and its implementation notes. Relevant parts: A (contract, both paths mounted, `emitIpcEvent`), B (tables, per-leaf provenance), C (runner, journal v2, steps 1–2, the reserved C.5 steps 3–4, the live legacy sync, downgrade safety, "cleared history stays cleared").
- `00-window-chrome.md` **r2**, with its two low items that must land before the wco switch, and §7 (deletion list) and §12 (acceptance).
- `00-agent-agui.md` **r3**, with the impl r1 amendments and the main-relay notes. Relevant parts: `--wire`, the compat stream, the 24 goldens, `wireFor`, and the health check.
- `01-renderer-foundation.md` **r4** plus its impl fix log (F12 move, lint and knip scope, boot services not yet ported, gallery, dev hooks, screenshot gate), `02-chat-kit.md` **r4**, `03-bots.md` **r3**, `04-sessions.md` **r3**, `05-routines-artifacts-library-settings.md` **r3** (the working copy answering Codex r2; line numbers shift, so its items are cited by section) and `06-onboarding-tour-notch.md` **r1**.
- Every review and fix log under `specs/reviews/`. §3 lists every item in them that is "deferred to cut-over" or held "until cut-over", with its source.

Paths are relative to `apps/desktop/` unless noted. Line numbers are at `HEAD 24b02486`.

**Sources read for this spec (30 Sep 2026)**

| Source | Where |
|---|---|
| Generation and entry | `src/main/renderer-generation.ts:7-27`, `src/main/renderer-entry.ts:11-73`, `src/main/index.ts:115,396-425,453-465,580-633,780-800,850-915,1580-1595,1700-1760,1795-2090,2131` |
| Renderer host and readiness | `src/main/renderer-host.ts` (all 484 lines), `src/main/rpc/readiness.ts`, `src/renderer-next/features/shell/readiness.tsx` |
| Experience / updater | `src/shared/experience.ts:1-11`, `src/main/services/updates/experience/{integrity,experience-updater,health-check}.ts`, `integrity.test.ts`, `apps/updater/src/{manifest,experience,classify}.ts`, `apps/updater/README.md`, `scripts/build-experience.js`, `src/main/services/updates/update-service.ts` |
| Preload | `src/preload/index.ts` (300 lines: `window.api`, `abacusHost`, `durableState` `sendSync`), `rpc-port.ts`, `bridge.ts` (1090 lines), `preload-exposure.test.ts`, `parity.test.ts` |
| Legacy IPC | `src/shared/channels.ts` (`IpcChannels`, 197 lines), `src/main/handler.ts:155-490` (`createHostOperations`, `registerIpcHandlers`), `src/main/rpc/emit.ts:14-38`, the 232 `ipcMain.handle|on` call sites in `src/main` (tests excluded) |
| Migration | `src/main/migrations/{runner,journal,record,backup,startup,write-block}.ts`, `steps/{index,001,002,004,transcript-files}.ts`, `__fixtures__/legacy-home/`, `legacy-home.test.ts`; `src/main/services/session/{thread-store,transcript-service}.ts`; `src/main/services/config/{renderer-state,legacy-prefs,prefs-store}.ts` |
| Wire | `packages/agent/src/main.ts:73-142`, `host.ts`, `agui/{sink,channel,queue,record}.ts`, `agui/__fixtures__/` (48 files), `src/main/services/session/cli-manager-service.ts:47-55,129,596-626,727-755,985-1180`, `src/main/services/agui/relay-service.ts:1-15,182-212`, `service-host.ts:1253-1361` |
| Build and CI | `vite.config.ts`, `vite.shared.ts`, `vitest.config.ts`, `tsconfig*.json`, `knip.json`, `oxlint.config.ts`, `pnpm-workspace.yaml`, `patches/`, `package.json` (root and desktop), `electron-builder.yml`, `build/entitlements.mac.plist`, `build/licenses/`, `scripts/{check-legacy-renderer-diff.mjs,legacy-renderer-allow.json,check-packaged-resources.js,generate-notices.js,sync-locales.js,check-jsx-i18n.js,screenshots-next.mjs,locale-keymap.json}`, `.github/workflows/{ci,codeql,dependency-review}.yml` |
| Dev-only code | `src/main/dev/{mutation-harness,renderer-next.electron.test,screenshots-gate.test,legacy-diff.test}.ts`, `src/renderer-next/{main.tsx,lib/dev/dev-hooks.ts,lib/devtools.tsx,features/gallery/search.ts,data/fixture-db/}` |
| Parity | `docs/rewrite/PARITY.md` (587 lines, generated from `src/shared/contract/legacy-map.ts` by `preload/parity.test.ts`) and the parity tables of specs 03–06 |
| Releases | tags up to `v1.0.85` (an ancestor of this branch), `CHANGELOG.md`, `scripts/sync-changelog.js` |

## 0. Findings that change the brief (read first)

| # | Brief / earlier specs say | The repo says | Consequence here |
|---|---|---|---|
| F1 | "every spawn becomes agui in the wco generation" (`wireFor` rule) | That rule is only a review fix: `reviews/00-main-relay.impl-claude-r1.md` #3 (:54-67), repeated in 03 §24 (03:1117). The code does not have it. `relay-service.ts:206-210` returns `agui` for a claimed thread or when `ABACUSAI_BOT_AGENT_WIRE=agui` (read unconditionally at :193-195, which is finding #9), and `ndjson` otherwise. `cli-manager-service.ts:600-601` also defaults to `ndjson`. | The flip PR (§4, C5) makes it true. It is a precondition of the flip, not a cleanup. |
| F2 | PLAN phase 7: "Delete … NDJSON host" | Spec 00-agent-agui §6.4 (:999-1001) and the PLAN amendment (:366) keep the **compat stream** (legacy NDJSON on fd 3) because main's taps read it. Only the NDJSON-only **host path** and the `--wire` default go. | §5.4: `protocol.ts` `DesktopEvent`, `agui/sink.ts`, `agui/channel.ts`, `handleCompatFd`/`handleNdjsonLine` and `shared/agent-types.ts` all stay. |
| F3 | The FOUNDATION_API bump gates published experiences | The experience manifest is bound to the **exact foundation version** (`integrity.ts:51-55`) *and* to `FOUNDATION_API` (`:57`). Every foundation release already refuses older experiences. There is one TUF target for every foundation (`experience-updater.ts:23` `experience/latest.zip`). The bump to 2 also chooses the swap barrier (`index.ts:423-425`: `FOUNDATION_API >= 2 ? "subscriptions" : "first-commit"`). | §6: the bump is needed for the barrier, and as a guard against a mislabelled build. It does not decide compatibility. The one shared target decides the publishing rule during the staged rollout (§6.4). |
| F4 | Experiences keep working after the flip | renderer-next ports none of the old boot services. `renderer/main.tsx:8-21` installs the activity beacon and UI continuity; renderer-next has no caller of `window.activity` (the contract has it: `shared/contract/window.ts:37`, `rpc/procedures/window.ts:43`) and no `__captureUiContinuity`. Spec 01 §13 (:984, :1135) says swaps "need the activity beacon's replacement first". | After the flip, main's swap `busy()` would never see user input and continuity would degrade to a plain swap. PR C3 ports both before the flip. |
| F5 | `experience` release units are renderer and agent source | `apps/updater/src/classify.ts:11-15` lists `apps/desktop/index.html`, `apps/desktop/src/renderer/` and `packages/agent/src/`. It does not list `src/renderer-next/`, `index-next.html` or `notch.html`, so today every renderer-next change is classified as a `foundation` release. | C5 adds them; C7 (the move) restores the single prefix. |
| F6 | Keep-awake follows agent runs | `power:set-agent-busy` is still an IPC call from the old renderer (`keep-awake.ts:43-46`, preload `index.ts:181`). Spec 00 (:343) and `legacy-map.ts:398-400` say "main derives busy from AG-UI run state", but nothing does. | C2 implements it. Otherwise the new renderer silently loses keep-awake during a turn. |
| F7 | The health check proves an agent bundle | `health-check.ts:52-80` spawns the candidate with **no flags** and waits for the NDJSON `{"type":"ready"}` line. Under agui, the first stdout line is `CUSTOM wire.hello`, readiness is `CUSTOM session.ready`, and the legacy `ready` exists only on compat (agent spec §2.1). | C2 adds an agui probe mode; C10 makes it the only one. The probe must match how main spawns (§8.1, §8.4). |
| F8 | Migration step 4 and the rule removal ship "in the cut-over build" (spec 00 C.5) | Step 4 **moves** v1 files into `backups/migrations/…` (`004-archive-transcripts-v1.ts:1-20`), and step 3 (no code yet) drops the mapped keys from `renderer-state.json` (spec 00 :1174). Either one breaks what an older build reads after a downgrade. Two High review findings on step 4 are still open in code: orphan v1-derived twins (`reviews/00-transport-C1.impl-claude-r1.md` #2) and `ERR_STRING_TOO_LONG` read as corrupt then quarantined (#7). | Decision D2: release **N** (the flip) keeps every legacy file intact, and steps 3–4 plus the rule removal ship in **N+1**, once N has soaked. This amends spec 00 C.5 (§9). |
| F9 | `window.api` removal is one deletion | `registerIpcHandlers` (`handler.ts:471-490`) both builds the operations object that oRPC uses (`index.ts:1738-1740`: `installRpc(hostOperations, …)`) **and** registers the handlers, and it also installs `serviceHost.setEventDispatcher(emitIpcEvent)`. | C8 splits it: `createHostOperations` and the dispatcher wiring stay, and the `ipcMain.handle` block goes. |
| F10 | The experience verifier accepts the new renderer | `integrity.ts:196-200` refuses a tree without `renderer/index.html`. Deleting the legacy `index.html` before `index-next.html` is renamed to it would make every experience fail verification. | The rename and the deletion of the legacy entry ship in one PR (C6). |
| F11 | Tests that read the old tree | `legacy-prefs.test.ts:215-235` reads `renderer/components/onboarding/onboarding-steps.ts` and `renderer/lib/browser-homepage.ts` as oracles. R3-T9's legacy half runs through old re-export shims (03:1036). The `ToolResultData` shape for migrated history comes from `renderer/conversation/agent-types.ts:273-322` (02:606). | C6 freezes those oracles as literals and moves the type into `shared/` before deleting anything. |
| F12 | `pnpm check` gates the cut-over (PLAN) | CI runs `format:check`, `lint`, `typecheck:tools`, `typecheck`, `check:i18n`, `check:locales` and `check:audit` separately (`ci.yml:76-96`). `check:knip-next`, `check:ui-registry` and `check:legacy-diff` are in the root `check` (`package.json:13`) but **not in CI**. | C4 adds knip and the registry check to CI; C6 removes the legacy diff. |
| F13 | Release smoke on macOS and Windows | CI already packages unsigned builds and starts them on all three OSes (`ci.yml:218-330`). The smoke waits for `[smoke] main process ready` (`index.ts:219,2131`), which fires before any renderer is ready. Signed builds come from a separate private repo (`ci.yml:3-9`, `electron-builder.yml:172-174`). | R7-T16 adds a renderer and notch readiness marker and covers Linux too. R7-T17 is the signed-build run in the private pipeline. |
| F14 | Nuked dependencies need knip to prove no consumer | Some are already dead today. `@tsparticles/{engine,react,slim}` and `uuid` have **zero** importers anywhere. `framer-motion` stays in the lockfile as `motion@13.4.6`'s own dependency (`node_modules/motion/package.json`: `framer-motion ^13.4.6`), so its `minimumReleaseAgeExclude` entry (`pnpm-workspace.yaml:69`) stays. | §5.6 lists every dependency with today's importer counts and the grep that must return nothing. |
| F15 | node-mac-notch packaging (PLAN library table) | Spec 06 F-row (06:30, :43): the package does not exist, and metrics come from a one-shot JXA probe via `/usr/bin/osascript`. There is no native module and no ABI concern. | §10 has no native-module step. |
| F16 | Gallery and fixture builds cannot ship | The gallery, dev hooks and fixture DB are gated by `import.meta.env.DEV \|\| VITE_UI_GALLERY === "1"` (`main.tsx:51,170-177`; `features/gallery/search.ts:106`), and `VITE_NEXT_DB_FIXTURES=1` (`main.tsx:114-117`). The acceptance and screenshot runs build into the **same** `dist/renderer` as a release (`screenshots-next.mjs:289-294`, `renderer-next.electron.test.ts:48-62`). Nothing in packaging checks which build it got. | C4 adds a release-build guard that `package` and `experience` both run. |
| F17 | Window-chrome §7 grep "returns nothing" | That grep includes the bare `isFullScreen`, which Electron's own `BaseWindow.isFullScreen()` matches in main (`index.ts:486,520,731,868,…`; `bring-to-front.ts:48`). It can never be empty. | R7-T21 uses the corrected pattern (§5.3). |
| F18 | Multiple homes | `profile-home.ts` keeps one home per account (`profiles.json`, `profiles/<key>/`), and each is migrated when it is first active (the runner runs against `abacusBotHome()`). | The upgrade tests cover a multi-profile layout (R7-T12). |

## 1. Scope and decisions

**In scope.** The ordered stack that makes renderer-next the shipped renderer and removes what only the old renderer needed: the generation flip, the FOUNDATION_API bump with the updater, the wire flip, deleting the old tree, `window.api`, legacy IPC and transition-only data paths, the dependency purge, the locale purge, notch/capsule packaging checks, the release, its notes, the staged rollout and the rollback plan. Also the release that follows (N+1), which retires the legacy files.

**Out of scope.** Porting main's taps from the compat stream to AG-UI. That is a later, separately specified slice (agent spec :1001), and the compat stream stays here. Also out: the `i18next` 26 / `react-i18next` 17 majors (01 F9, now a single-renderer PR after the cut-over), the features the specs defer to later slices (the `deferred` rows of §11), and a web mode.

**Decisions**

- **D1. One behaviour flip.** Exactly one PR (C5) changes what a packaged user runs: the generation default, `FOUNDATION_API`, and every spawn on agui. Every earlier PR leaves the legacy build's user-visible behaviour as it is (`check:legacy-diff` and the goldens still hold). C2's refused-target memo and C4's build guards are housekeeping that no user sees. Every later PR deletes code the flipped build no longer reaches, and must leave the R7 gate as it was.
- **D2. Two releases.** Release **N** ships the flip and the deletions and never mutates a file an older build reads: `transcripts/`, `renderer-state.json`, and the stores' existing fields. It stops *updating* them (no old renderer writes them any more), so a downgrade to the last legacy build still opens with its data (§12.3). Release **N+1**, after N reaches 100 % of the rollout with no rollback trigger, registers steps 3–4 and removes the repair, the cleared-history rule and the dual-remove. This amends spec 00 C.5, which put them in "the cut-over build".
- **D3. `FOUNDATION_API = 2`** in `src/shared/experience.ts` and `apps/updater/src/manifest.ts` in the same commit, guarded by a test that imports both. The verifier additionally requires `renderer/notch.html` from API 2 on.
- **D4. `--wire` stays as a flag for skew safety.** Main keeps passing `--wire agui --thread-id <id> --compat-fd 3`. After C10 the agent treats an absent `--wire` as `agui` and rejects `--wire ndjson` with a typed error. The flag is not deleted outright: an agent bundle arrives by experience for the same foundation, so main and agent must keep agreeing without lockstep edits.
- **D5. PARITY.md is frozen as the sign-off record.** It gains a final "renderer consumer" column at C5 (06:1089, 03:1090 asked for it). Its generator (`legacy-map.ts`, `preload/parity.test.ts`) is deleted in C8 with the bridge it compares against.
- **D6. Locales stay at `src/renderer/locales/`.** After the move (C7) they sit inside the new `src/renderer`, and `#locales/*` keeps resolving. No 11-file churn.
- **D7. Synthetic data on real layouts.** PLAN says "migration runs on real data from a backup". Here the upgrade tests use homes **produced by the real last shipped build** from synthetic inputs (§13.2). Team members may also run the RC on copies of their own homes, locally and voluntarily. Nothing from those runs is collected or committed.
- **D8. Linux is in the packaged smoke** (PLAN said macOS and Windows). The notch and capsule are macOS/Windows only (06:82).
- **D9. Staged rollout** through `stagingPercentage` in the electron-updater feed files, which the release pipeline already rewrites (`electron-builder.yml:166-170`). From the RC cut, experiences are published for N only; nothing more is published for N−1 (§6.4).

## 2. Entry criteria (before C1 opens)

1. Phases 0–6 are merged with their own gates green (PROGRESS.md "done" for every slice). At `HEAD 24b02486` that is not yet true: phase 0 step 1 fixes, phase 1 fixes and the main relay fixes are "fixing", and phases 2–6 are specs.
2. Open review findings that block the cut-over are closed or explicitly carried here (§3):
   - main relay Claude r1 #1–#9 and Codex r1 #1–#13 (no fix log exists at this HEAD);
   - migration C1 Codex #1–#3 and Claude #2, #3, #4, #7, #14, #15;
   - Codex C r2 #1 (the write-block in `ThreadStore`/`TranscriptService`).
3. The deferred parity rows of earlier phases are green:
   - P46 (phase 6), the P53 URL row (phase 4), P61 Revoke (phase 5) and ST22 (phase 6);
   - the 06 blocker `sessions.events { run-finished }` (06:46, :1110);
   - `PARITY.md`'s missing `notch.*`, `sessions.events` and `ai.runFinished` procedures, regenerated after 04/06.
4. `rewrite/renderer` has merged into `main` in its dormant form (legacy default), and at least one release has shipped from it. This is recommended, not required. That release runs steps 1–2 and the live sync on real homes before any UI changes (C-T8's field test), and it becomes "the last shipped version" of §13.2. If the branch instead lands on `main` together with this stack, the upgrade tests use the last pre-rewrite release (`v1.0.85` or later) as their only source layout.
5. A release manager owns the rollout (§12) and the rollback triggers.

## 3. Register of items deferred to the cut-over

Every "until cut-over", "at cut-over", "phase 7" and "before the wco switch" item in the specs, reviews and code. The last column names the PR that handles each (§4).

| # | Item | Source | Disposition |
|---|---|---|---|
| 1 | `--wire ndjson\|agui`, default `ndjson` until cut-over | 00-agent-agui:43; PLAN:336 | C5 (main passes agui for every spawn); C10 (agent default agui, D4) |
| 2 | The health-check probe keeps spawning `--wire ndjson` until cut-over | 00-agent-agui:912; `health-check.ts:52-80` | C2 (agui mode added); C10 (agui only) |
| 3 | The NDJSON-only host path and the flag go; the compat stream stays until the taps are ported | 00-agent-agui:999-1001; PLAN:366 | C10 (§8) |
| 4 | "Add at least delegate, bot and rotation `.ndjson` baselines before cut-over" | reviews/00-agent-agui.impl-claude-r1.md:115 | Done (`impl-fixes-r1.md:29`: 10 new scenarios; 24 in `agui/__fixtures__/`). Re-verified by R7-T6 |
| 5 | `wireFor` returns agui for every spawn in the wco generation | reviews/00-main-relay.impl-claude-r1.md #3 (:54-67); 03:1117, :1139 | C2 (conditional on generation), C5 (the flip makes it universal), C10 (selection deleted) |
| 6 | `ABACUSAI_BOT_AGENT_WIRE=agui` honoured in packaged legacy builds | main-relay Claude r1 #9 (:133-143) | C2 (unpackaged only); C10 (deleted) |
| 7 | `window.api` and every `ipcMain.handle` stay until the Phase 7 cut-over; `emitIpcEvent` feeds both paths | 00-transport:15, :562, :720, :1242; `rpc/emit.ts:14-18` | C8 |
| 8 | Kind **R** rows: "its legacy handler stays until the cut-over" (19 rows in code, 18 in spec 00; `recreateMainWindow` added by window chrome) | PARITY.md:9; 00-transport:83, :343; `legacy-map.ts:372-374` | C8 |
| 9 | `writeTranscript` dual-write of v2 "until cut-over" | 00-transport:252, :1128, :1131, :1224; PARITY.md:178; `transcript-service.ts:86-91`; `thread-store.ts:15-16,148-164` | C11 (the writer is gone once the bridge is gone) |
| 10 | The repair in `readCurrent` and the "cleared history stays cleared" rule go together with step 4 | 00-transport:1127, :1249, :1388; `thread-store.ts:109-142` | N+1 (C15), D2 |
| 11 | The live legacy prefs sync is "transition only … Removed with the old renderer" | 00-transport:1146, :1248; `index.ts:1734-1737`; `legacy-prefs.ts:420-449`; `renderer-state.ts:54-55,90` | C11 |
| 12 | Step 3 `final-legacy-prefs-import-and-drop` at cut-over | 00-transport:955, :1147, :1174 (no code) | C1 (written and tested, not registered); C15 (registered) |
| 13 | C.5 steps are registered only in the cut-over build | 00-transport:1170, C-T9 :1208; `steps/index.ts:1-8`; `004-…ts:1-5` | C15, D2 |
| 14 | Downgrade safety: nothing an older build reads is mutated "until the cut-over build" | 00-transport:1021, :1168, :1308 | Kept through release N (D2) |
| 15 | **High (cut-over):** orphaned v1-derived twins come back once the rule goes | reviews/00-transport-C1.impl-claude-r1.md:21-31 | C1 (step 4 lists `threads/` and archives such twins) |
| 16 | A large transcript (`ERR_STRING_TOO_LONG`) is classified as corrupt, then quarantined by step 4 and pruned at 90 days | C1 Claude #7 (:84-93); `transcript-files.ts:72-78`; `004-…ts:68-88`; `backup.ts:323` | C1 |
| 17 | The dual-write cost: "or drop it until the cut-over and rely on the repair" | C1 Claude #5 (:55-65) | Moot at C11 |
| 18 | EXDEV window on `renderer-state.json`: "Medium (High once step 3 lands)" | reviews/00-transport-C.impl-claude-r1.md:40-50 | Fixed (`impl-fixes-r1.md:25`); re-proved by R7-T14 kill points for step 3 |
| 19 | `ThreadStore`/`TranscriptService` ignore the migration write-block | 00-transport-C.impl-codex-r2.md:1; `impl-fixes-r1.md:85` (handed off, not done); spec :1335 | C1 |
| 20 | Stop after a deferred step, or document that no later step depends on step 4 | C1 Claude #15 (:162) | C1 (runner `break` after `pending`, tested) |
| 21 | Cleared-history protection excludes AG-UI twins (reset tombstone) | C1 Codex #3 | C1 |
| 22 | Any v1 read error is taken as "cleared" | C1 Claude #14 (:144-149); `thread-store.ts:45-51` | C1 (only `ENOENT` means cleared) |
| 23 | The manual rollback procedure "documented in `PARITY.md`" | 00-transport:1022, :1332 (PARITY.md has none) | §12.3–12.4 of this spec, and C14 publishes it as a support article |
| 24 | `FOUNDATION_API` bump: "a release decision", needs `apps/updater` in the same release | 00-transport:676, :713, :1264 | C5 (§6) |
| 25 | Swap-retry finding "dormant until FOUNDATION_API>=2" | reviews/00-transport-A.impl-claude-r1.md:10; `impl-fixes-r1.md:40` | Exercised by R7-T3 |
| 26 | `setAgentBusy` moves into main | 00-transport:320, :343; `legacy-map.ts:398-400`; `keep-awake.ts:43` | C2 (F6) |
| 27 | "Window chrome ships in legacy mode until the new renderer lands" | PLAN:369; 01:1135 | C5 |
| 28 | Before `RENDERER_GENERATION = "wco"`: (A) the probe reschedules every 250 ms while hidden; (B) `window:recreate` is exposed in legacy mode | reviews/00-window-chrome.impl-claude-r1.md:14; PROGRESS.md:13. (A) is half done: `index.ts:869-876` waits on `leave-full-screen`/`restore`, but a hidden window still re-arms `setTimeout(…, 250)` at :897-904. (B) is open: `index.ts:1881`, preload `index.ts:110-111` | C2 |
| 29 | Window-chrome items deferred to the renderer switch: the integration test (7 `it.todo`s in `src/main/window-chrome.electron.test.ts:3-26`, "Deferred … until renderer cut-over"), the §7 deletions, popup no-drag, browser-view zoom and translation | reviews/00-window-chrome.impl-claude-r1.md:11 | C2 (tests implemented); C9 (deletions) |
| 30 | "The old renderer keeps its constants until cut-over" | 01:1182; `shared/window-chrome.ts`; `window-chrome-options.ts:11-12,85-107,192-206` | C9 |
| 31 | `src/renderer-next` moves with `data/**` at cut-over (F12) | 01:26 | C7 |
| 32 | Legacy deps "removed at cut-over (phase 7), when knip confirms no consumers" | 01:114; `oxlint.config.ts:5` comment | C12 |
| 33 | knip scoped to renderer-next "until cut-over"; dependencies excluded | 01:229, :243; `knip.json` | C7 (scope), C12 (dependencies) |
| 34 | `matchSupportedLanguage`'s old copy stays until cut-over | 01:996 | C6 |
| 35 | Old locale keys deleted only at cut-over, when `check:i18n` and the keymap show no consumer | 01:1004; 02:1100; 03:987; `scripts/locale-keymap.json:2` | C13 |
| 36 | Old boot services not ported (log collector, activity beacon, UI continuity) | 01:984, :1135 | C3 (F4) |
| 37 | `renderer-state.json` read-only until cut-over; no reverse sync | 01:1137, :1203 | Kept read-only through N (D2); step 3 in N+1 |
| 38 | `check:legacy-diff` and `legacy-renderer-allow.json` | PLAN:382; `scripts/check-legacy-renderer-diff.mjs` | C6 (deleted) |
| 39 | `components/browser/pptx-viewer.tsx` "untouched until cut-over" | 04:1256 | C6 |
| 40 | The raw `settings:set-titlebar-density` handler "stays for tests until cut-over" | 05 §31.5 (b); `index.ts:1882-1893` | C8 |
| 41 | Old-renderer re-export shims into `shared/`: bot templates and check-in constants (03 §24.9), terminal keys/mouse wrappers, starters, `normalizeAddress` (04 §26.9), routine templates, credits URLs, homepage, changelog, `injected-text` (05 §31.7) | 03:1115; 04:1256; 05 §31.7 | C6 (shims deleted, `shared/` modules kept) |
| 42 | The legacy half of R3-T9 | 03:1036 | C6 |
| 43 | `agent.respondPermission` and `agent.queue.*` "stay for the old renderer only"; the agent's `queue.update`/`remove` must produce the same compat lines as `update_queue_item`/`remove_from_queue` | 02:1088; PARITY.md:102-109 | C8 (bridge rows); the compat-line rule stays while taps read compat (C10 keeps it) |
| 44 | The legacy IPC keeps its plain `Error` messages | 03:1110; 05 §31.5 (e) | C8 |
| 45 | Cross-generation acceptance ("the legacy generation shows the same bots / sessions / routines", the dev generation switch) | 03:1058, :1097; 04:1180, :1231; 05 R5-T36 | C9 (the legacy halves of R3-T31, R4-T34, R5-T36 are removed) |
| 46 | Legacy-generation notifications `silent: !prefs.sound` and "Task still running" | 05 §31.5 (d); 06:146-147, :888, :891 | C9 |
| 47 | The main branch of the preload stays byte-identical (moved to `main-preload.ts`) | 06:580, :1085 | C8 |
| 48 | `firstBot.title` kept for the old renderer; `scripts/locale-retired.json` | 06:976, :982 | C13 |
| 49 | `ToolResultData` must be in `shared/` before deletion | 02:606 (`renderer/conversation/agent-types.ts:273-322`) | C6, first commit |
| 50 | `<webview>` tag and its hardening in main (old preview panel) | 04:32 (F8), S80 | C9 (after `rg "<webview"` over `src` is empty) |
| 51 | The `local-cli-ndjson` stream to the old renderer | `service-host.ts:1264,1284-1295` | C8 |
| 52 | Notch inference constants "updated from those records before release" (R6-T31) | 06:595 | C14 |
| 53 | `PARITY.md` rows must name their renderer-next consumer | 06:1089; 03:1090 | C5 (sign-off column, D5) |
| 54 | Stale comment: "main's db.* answers UNAVAILABLE" | `renderer-next/env.d.ts:30-33` | C7 |
| 55 | `i18next`/`react-i18next` majors "in a separate PR that tests both renderers" | 01:23 (F9) | After the cut-over (one renderer) |

## 4. The cut-over sequence (stacked PRs)

The stack is 14 PRs for release N plus 1 for release N+1. Each targets the previous one; they land in order on the branch the release is cut from (`main`, §2 item 4). Every PR runs the standing CI (`check`, `test` ×3, `package` ×3) plus its own gate. **Gate** means the PR does not merge until the gate is green and its evidence is linked in the PR. "Legacy unchanged" means `check:legacy-diff` passes, the 24 `.ndjson` goldens are byte-identical, and the old renderer suites pass unchanged.

```
C1 migration hardening ─┐
C2 main parity          ├─ prepare (legacy build unchanged)
C3 renderer boot svcs   │
C4 release hygiene     ─┘
C5 THE FLIP ──────────── the one behaviour change (D1)
C6 delete old tree + entry rename ─┐
C7 move renderer-next → renderer   │
C8 delete window.api + legacy IPC  │
C9 collapse generation + chrome    ├─ delete (R7 gate must stay as it was)
C10 wire cleanup                   │
C11 transition data paths (N-safe) │
C12 dependencies + tooling         │
C13 locales                       ─┘
C14 packaging + release notes ─── cut release N
C15 retire legacy files ────────── release N+1 (after soak)
```

### C1 — Migration hardening (main; legacy unchanged)

- `ThreadStore` and `TranscriptService` honour `isMigrationWriteBlocked` (Codex C r2 #1): a blocked `threads/<id>.json` is served read-only and never written, and `writeAgui` defers until the next launch settles it.
- `transcript-files.ts` `inspectTranscript`:
  - `ERR_STRING_TOO_LONG` and other read failures become `tooLarge` or `unreadable`, never `corrupt`.
  - Step 1 converts large files by streaming the parse from a `Buffer`, or skips them with `stats.tooLarge`.
  - Step 4 never quarantines `tooLarge` or `unreadable` (C1 Claude #7).
- Step 4 lists `threads/` too: a `transcript-v1` twin with no v1 file is archived into the step's backup (C1 Claude #2). This adds a C-T9 case.
- `ThreadStore.readText` treats only `ENOENT` as "cleared". `EACCES`, `EBUSY` and other errors surface as `unreadable` and never hide or repair (C1 Claude #14).
- Reset tombstone for AG-UI threads (C1 Codex #3):
  - `resetAgentConversation` and session deletion write `threads/.cleared/<id>` (an empty marker, mtime = clear time) before removing the twin.
  - `readCurrentFile` returns null for an id with a marker newer than the twin.
  - Step 4 archives the markers with the rest.
- Step 3 `final-legacy-prefs-import-and-drop` is written and tested but **not registered**:
  - it runs the whole-file provenance-aware import (C.4), then drops every key in `LEGACY_PREFS_KEYS` from `renderer-state.json`;
  - both are `replace-user` writes, with backups by the commit protocol;
  - a key the import marks `invalid` is still dropped, but its raw value is kept in the step's backup and counted.
- Runner: after a step returns `pending`, stop instead of running later steps (`break`), and log it (C1 Claude #15).
- **Gate:**
  - C-T1…C-T9 green, and the runner crash suite (`runner.crash.test.ts`, about 4,460 kill points) green with step 3 and the new step 4 cases registered in the test registry;
  - `legacy-home.test.ts` still expects `[1, 2]`;
  - R7-T14 and R7-T15 pass against the test registry;
  - legacy unchanged.

### C2 — Main parity for the new generation (main; legacy unchanged)

- **Keep-awake from run state (F6).**
  - `keep-awake.ts` gains `setAgentBusySource(() => workspaceServiceHost.hasActiveAgentTurn())`, re-evaluated on the relay's `RUN_STARTED`/`RUN_FINISHED`/`RUN_ERROR` and on runtime exit. `ServiceHost.hasActiveAgentTurn` already exists; the updater uses it at `index.ts:388-391`.
  - In the wco generation the `power:set-agent-busy` handler becomes a no-op.
  - In legacy it keeps today's behaviour.
- **Window-chrome item (A).** In `probeAfterShow`, a hidden window waits on `mainWindow.once("show", …)`. Only a `retry-later` from a visible window re-arms the timer. `index.ts:897-904` today also re-arms for hidden and minimized windows.
- **Window-chrome item (B).** `ipcMain.handle("window:recreate", …)` (`index.ts:1881`) is registered only when `RENDERER_GENERATION === "wco"`. The preload member is removed in C8.
- **Wire, the relay fixes:**
  - `wireFor` returns `agui` when `RENDERER_GENERATION === "wco"` (main-relay #3);
  - `ABACUSAI_BOT_AGENT_WIRE` is honoured only when `!app.isPackaged` (#9);
  - main-relay #1, #2 and #6 are fixed if the relay fix agent has not landed them: an early `RUN_ERROR` corrupts the next message, the synthesized terminal leaves open parts, and a stale exit clears the replacement's waiters. These are §2 item 2, repeated here because the flip makes every thread agui.
- **Health check, agui mode (F7).** `checkAgentBundle(candidateRoot, { wire })`:
  - With `wire: "agui"` it spawns `[entry, "--wire", "agui", "--thread-id", "health-check"]` without `--compat-fd` (compat `none`, agent spec :377).
  - It resolves on the first stdout line that parses as `{ type: "CUSTOM", name: "session.ready" }`, and fails on `RUN_ERROR` or exit before it.
  - The caller passes `"agui"` when `RENDERER_GENERATION === "wco"`.
- **Window-chrome Electron integration test.** The 7 todos are implemented on the Node-spawns-Electron harness, and the test is registered in `CONTENDS_FOR_THE_MACHINE`.
- **Refused-target memo.** `ExperienceUpdater` records a target hash whose verification failed on foundation, API or protocol grounds, and skips it until relaunch (§6.4).
- **Coupling test.** `src/main/services/updates/experience/foundation-api.test.ts` asserts `FOUNDATION_API` (desktop) === `FOUNDATION_API` (`@abacus-ai/updater/manifest`) and `EXPERIENCE_PROTOCOL === PROTOCOL`.
- **Gate:**
  - R7-T27, R7-T28 and R7-T29 on macOS, Windows and Linux CI;
  - R7-T8 in both modes;
  - the relay suite plus `cli-manager-wire.test.ts`;
  - legacy unchanged (the density IPC and `window:recreate` behaviour in legacy is covered by existing tests).

### C3 — Renderer-next boot services (renderer-next only)

- **Activity beacon.** `lib/activity.ts`:
  - `pointerdown`, `keydown` and `wheel` in capture phase, throttled to one `transport.client.window.activity()` per 5 s (the old beacon's `THROTTLE_MS`, `renderer/lib/activity-beacon.ts:6`);
  - installed after `bootstrap()`, never in the notch entry;
  - main's `RENDERER_ACTIVITY_HOLD_MS` (15 s, `index.ts:398`) already reads `markRendererActivity` through the contract.
- **UI continuity.** `lib/continuity.ts` defines `window.__captureUiContinuity()` and `__restoreUiContinuity(snapshot)` with the old names, because `renderer-host.ts:252-281` calls those globals.
  - Snapshot: the route is carried by the hash (`renderer-host.ts:362-368`); plus the focused element's `data-continuity-id`, the caret or selection of a composer field, and each `data-continuity-scroll` viewport's anchored message id and offset.
  - The composer draft itself lives in TanStack Store, which is per document. Its text travels in the snapshot with the old module's caps (`renderer/lib/ui-continuity.ts:31-33`: 20 scrollers, 20 fields, 4,096 characters per field; a longer draft is not carried).
  - Restore runs before readiness is reported.
- **Log collector.** Phase 5 adds `lib/log-ring.ts` for Save logs (05 §21.4). C3 verifies that it installs at boot in both entries and that `system.logs.save` includes it. There is nothing new if phase 5 did it.
- **Gate:**
  - R7-T3, an experience swap between two renderer-next builds with `FOUNDATION_API` forced to 2 in the test build: busy defers, continuity restores, `SwapNotReady` keeps the old view, and the retry budget holds;
  - R1-T20 unchanged.

### C4 — Release hygiene (tooling; no runtime change)

- **`scripts/check-release-build.mjs` (F16).** It fails when `dist/renderer` or `dist/main` contains any of:
  - `__abacusDev` or the `dev-hooks` chunk;
  - `memory-source`, the fixture DB;
  - `VITE_UI_GALLERY` or `VITE_NEXT_DB_FIXTURES` set truthy (read from Vite's `define` output, which the build writes);
  - `TanStackDevtools`, `ReactQueryDevtools` or `TanStackRouterDevtools`;
  - `guardSingleViewTransition` active code;
  - `mutation-harness` source.

  The harness moves behind `import.meta.env.DEV`-style dead-code elimination in main. `vite-plugin-electron` main builds get `define: { "import.meta.env.ABACUS_DEV_HARNESS": JSON.stringify(!isRelease) }`, so the module is not in the packaged `dist/main` at all instead of being inert.

  `scripts/build-experience.js` and electron-builder's `beforePack` (`scripts/before-pack.cjs`) both run it.
- **CI** gains `check:knip-next` and `check:ui-registry` in the `check` job (F12).
- **`size-limit`.** `size-limit` and `@size-limit/file` go into root devDependencies, with `.size-limit.json` entries measured against `dist/renderer/assets`:
  - the initial JS and CSS of `index-next.html`;
  - the initial JS and CSS of `notch.html`;
  - the largest lazy route chunk;
  - `temml`'s lazy chunk.

  This PR records a baseline with no limits enforced. C12 sets them (§14.4).
- **Smoke markers.**
  - Under `ABACUSAI_BOT_SMOKE_TEST=1`, main logs `[smoke] renderer ready` when `rendererReadiness` reports `ready` for the main window.
  - It logs `[smoke] notch ready` for the notch/capsule window on darwin and win32.
  - The CI step waits for all the markers the platform should print. In legacy, `renderer-ready` stands in for the first.
- **Gate:** CI green; `check-release-build` fails on a `VITE_UI_GALLERY=1` build and passes on `pnpm run build` (R7-T31).

### C5 — The flip (the one behaviour change)

- `renderer-generation.ts:7`: `DEFAULT_RENDERER_GENERATION = "wco"`. `resolveRendererGeneration` gains the reverse dev override: `ABACUSBOT_RENDERER_GENERATION=legacy` works only when unpackaged, and only until C6 deletes the tree it would load. After C6 the generation is always `wco`, and C9 removes the dead branches.
- `FOUNDATION_API = 2` in `src/shared/experience.ts:11` and `apps/updater/src/manifest.ts:10` (D3). The swap barrier becomes `subscriptions` (`index.ts:425`). The verifier requires `renderer/notch.html` when `FOUNDATION_API >= 2`.
- Every spawn is agui (C2's `wireFor` rule now applies to packaged builds). The health check runs in agui mode.
- `classify.ts` `EXPERIENCE_PREFIXES` gains `apps/desktop/src/renderer-next/`, `apps/desktop/index-next.html` and `apps/desktop/notch.html` (F5). `classify.test.ts` covers each.
- CI step "The desktop entry still speaks NDJSON" (`ci.yml:197-216`) becomes "The agent speaks AG-UI with a compat stream":
  - it runs `dist/main.js --wire agui --thread-id ci --compat-fd 3 3>compat.ndjson` with the `plain-text` input the spawn e2e uses;
  - it asserts stdout line 1 is `CUSTOM wire.hello` and `compat.ndjson` holds `compat.hello` then `{"type":"ready"…}`.
  - The NDJSON variant stays alongside until C10.
- `PARITY.md` sign-off (D5):
  - `legacy-map.ts` rows gain `consumer: "<renderer file>#<symbol>" | "retired: <reason>"`;
  - `parity.test.ts` fails on an empty consumer;
  - the generated file gains the column and a "Signed off at <sha>" line.
- **Gate (the full release-candidate gate, §15):**
  - R7-T1 … R7-T13, R7-T16, R7-T18 (pre-deletion form), R7-T23 (report only), R7-T24, R7-T25, R7-T30;
  - the parity sign-off checklist (§11) is complete, with evidence links;
  - the performance budgets (§14) are met on the reference machines.

  The last legacy-generation build and this flip build are both packaged from CI artifacts for comparison.

### C6 — Delete the old renderer tree, rename the entry

- First commit: move what the new code still needs out of `src/renderer`:
  - `ToolResultData` and its siblings from `renderer/conversation/agent-types.ts:273-322` go to `src/shared/transcript/tool-result.ts` (F11);
  - the oracles in `legacy-prefs.test.ts:215-235` become literal expectations (`LEGACY_ONBOARDING_STEPS = ["auth","welcome","connectors","models","explainer"]` and the homepage regex), each commented with the commit they were read from.
- Delete `src/renderer/**` **except** `src/renderer/locales/**` (D6). That is 436 files, about 84.8k lines of TS/TSX outside locales, including `conversation/` (about 6.9k non-test lines), `stores/` (zustand) and every re-export shim of §3 row 41.
- Delete `apps/desktop/index.html` (legacy) and `git mv index-next.html index.html` in the **same** commit (F10).
- `vite.config.ts`: one input, `main: index.html`. `renderer-entry.ts`: `NEXT_ENTRY` and `LEGACY_ENTRY` collapse into `ENTRY = "index.html"`; `rendererEntry` and `experienceEntryUrl` lose the generation parameter and keep `NOTCH_ENTRY`.
- Delete `tsconfig.renderer.json` and its reference, the `renderer` vitest project, the old-renderer oxlint override (`oxlint.config.ts:31-67`), `check:legacy-diff` (script, allow list, `src/main/dev/legacy-diff.test.ts`, root `check` entry) and the old `matchSupportedLanguage` copy.
- `package.json` scripts: `dev:next` → `dev`, `dev:next:fixtures` → `dev:fixtures`. The old `dev` goes.
- **Gate:**
  - `pnpm run build` and `typecheck` pass, and every remaining suite passes;
  - the R7-T16 packaged smoke passes on three OSes;
  - R7-T4, because `classify` must still say `experience` for `index.html` (§6.3);
  - `integrity.test.ts` passes;
  - the screenshot gate shows 0 changed pixels against C5's run (same routes, same fixtures).

### C7 — Move `src/renderer-next` to `src/renderer` (F12; pure move)

- `git mv src/renderer-next/* src/renderer/`. `locales/` is already there.
- Codemod `#next/` → `#renderer/` in every import. `package.json` `imports` drops `#next/*` and repoints `#renderer/*`. `vite.shared.ts`: `NEXT_SRC`/`NEXT_MODULES` → `RENDERER_SRC`/`RENDERER_MODULES`, and the plain `react()` instance goes, since there is one tree.
- Router plugin `routesDirectory`/`generatedRouteTree` (`vite.config.ts:57-64`). `tsconfig.renderer-next.json` → `tsconfig.renderer.json`. The vitest `renderer-next` project → `renderer`. `components.json` aliases.
- `knip.json` entries: `src/renderer/main.tsx`, `src/renderer/notch.tsx`, routes and tests, plus `src/main/index.ts`, `src/preload/index.ts` and `scripts/*`, so the whole workspace is covered (dependencies follow in C12).
- The oxlint renderer-next override moves to `src/renderer/**`. `RENDERER_NEXT_BANNED_PACKAGES` → `RENDERER_BANNED_PACKAGES`, and the ban stays so none of them comes back.
- Scripts:
  - `screenshots-next.mjs` → `screenshots.mjs`, and `shadcn-next*.mjs` → `shadcn*.mjs`;
  - `check-jsx-i18n.js` `SCAN_DIRS = ["src/renderer"]`, ignoring `src/renderer/ui` and `features/gallery`;
  - `sync-locales.js` scan dirs;
  - `guards.test.ts` paths.
- `classify.ts` prefixes return to `apps/desktop/src/renderer/`, `apps/desktop/index.html` and `apps/desktop/notch.html`. Stale comments go, e.g. `env.d.ts:30-33`.
- **Gate:**
  - no behaviour change: the screenshot gate shows 0 changed pixels against C6, and every suite passes;
  - `rg -n "renderer-next|#next/" apps packages .github knip.json oxlint.config.ts` returns nothing (`docs/` keeps its history).

### C8 — Delete `window.api` and the legacy IPC

- **Preload** keeps `installRpcPortHandshake` and `abacusHost.getPathForFile`, plus the notch dispatcher (06:550-581).
  - It deletes `bridge.ts`, the `api` object, the `durableState` `sendSync` (`index.ts:30-41`), `index.d.ts` `api` types, `browser-runtime-bridge`, `terminal-runtime-bridge`, `worktree-bridge` and their tests.
  - `preload-exposure.test.ts` asserts `exposed.keys() == {"abacusHost"}`.
- **`handler.ts`.** `registerIpcHandlers` becomes `wireHostEvents(serviceHost)`: the dispatcher, the bus and the credential saver (`:475-490`), returning `createHostOperations(…)`. Every `ipcMain.handle(IpcChannels.*)` goes (`:493-…`).
- **`index.ts` raw handlers go:**
  - `renderer-activity` and the `renderer-ready` barrier: `SwapBarrier` narrows to `subscriptions`, and `READY_TIMEOUT_MS` and `rendererReady()` are deleted from `renderer-host.ts`;
  - `open-external`, `show-item-in-folder`, `get-app-version`, `window:show-about`, `restart-app`, `get-home-dir`, `has-google-chrome`;
  - `window:chrome`, `window:recreate`, `settings:set-titlebar-density`, `append-logs`, `save-logs`;
  - `account:*`, `funnel:step`, the dialogs, `read-clipboard-image`, `fetch-url-attachment`, `skills-*`;
  - the rest of `:1802-2090`.

  Each is already a contract procedure; `PARITY.md` names it.
- **Other main files.** `keep-awake.ts` IPC (the service stays, fed by C2), `update-handler.ts` (the whole file), `renderer-state.ts` `registerRendererState` IPC (`:196-215`) and `browser-runtime-handler.ts`.
- **`emit.ts`.** `emitIpcEvent` becomes the bus dispatch only (renamed `emitHostEvent`); `sendToRenderer(IpcChannels.Event, …)` goes. `publishToWindowViews` stays. The legacy `window:chrome-changed` (`index.ts:1589-1590`) and `window:full-screen-changed` (`:645`) sends go.
- **Removed next:**
  - `IpcChannels` (`shared/channels.ts`), deleted when `rg IpcChannels src` is empty; the browser-runtime channel names move to local constants if main still needs them;
  - `service-host.ts:1264,1284-1295`, the `local-cli-ndjson` emission;
  - the legacy-only `agent.respondPermission`/`agent.queue.*` host operations with no contract caller (02:1088);
  - the legacy plain-`Error` message branches (03:1110; 05 §31.5 e).
- **Parity generator.** `legacy-map.ts`, `preload/parity.test.ts` and `shared/contract/legacy-map*.ts` are deleted. `PARITY.md` stays as the frozen sign-off record (D5), with a header line pointing to this spec.
- **Gate:**
  - R7-T19, R7-T20 and R7-T21 (IPC and preload rows);
  - every `rpc/**` suite; R1-T15 and R1-T22; the packaged smoke;
  - a swap test (R7-T3) proving the `subscriptions`-only barrier.

### C9 — Collapse the generation and the legacy chrome

- Delete `renderer-generation.ts` and its test. `WindowChromeMode` and every `RENDERER_GENERATION === …` branch in `index.ts` (`:455-460,588-598,604-633,789,856-915,1589,1886-1891`) and `window-chrome-options.ts` (`:85-107,192-206`) collapse to the wco path.
- `shared/window-chrome.ts` and its test are deleted, along with `shared/window-chrome-state.ts` if `window.chrome` no longer imports it. `startup-theme.ts` loses its generation parameter.
- The legacy-generation notification branch (`silent: !prefs.sound`) and "Task still running" go (§3 row 46).
- The `<webview>` tag and its hardening go (§3 row 50), once `rg "<webview|webviewTag" src` finds only main's own guard.
- Tests: R1-T17 is rewritten (entry and experience URL only, already single-entry since C6); R1-T19 is reduced to "`prefs.json` is authoritative; `renderer-state.json` is read by the migration only". The legacy halves of R3-T31, R4-T34 and R5-T36 are removed.
- **Gate:**
  - R7-T21 (chrome rows, F17's pattern);
  - window-chrome acceptance (00-window-chrome §12) re-run in the packaged build on three OSes;
  - the screenshot gate unchanged.

### C10 — Wire cleanup (agent and main)

- **Agent.**
  - `host.ts` (`NdjsonHost`) and its export at `index.ts:45-46` are deleted.
  - `main.ts`: `--wire` absent means `agui`, and `--wire ndjson` exits 64 with `{"type":"error","code":"wire_unsupported"}` on stderr (D4). `--thread-id` stays required.
  - `agui/record.ts` moves to `AguiHost` behind the same `ABACUSAI_BOT_WIRE_RECORD`: it records AG-UI out, compat out and stdin.
  - `agui/queue.ts`: the non-reserving legacy branch of `reserveDuringAbort` (`:77-83,475-490`) goes.
  - Tests: `ndjson-golden.integration.test.ts`, `ndjsonDriver` (`agui/__tests__/harness.ts:402-405`) and the `--wire ndjson` spawn case go. The header comment of `main.ts:4-7` is updated.
- **Main.**
  - `cli-manager-service.ts`: `resolveWire`, the `?? "ndjson"` default (`:129,:601`), the 3-pipe branch (`:623`) and `handleStdout` (`:985-1010`) go.
  - `relay-service.ts`: `wireFor`, `#claimed`, `aguiForEverySpawn` and the "speaks the legacy protocol" `UNAVAILABLE` paths (`:652-693`) go.
  - `service-host.ts`: `:1253` and the ndjson auto-allow branch (`:1329-1336`) go.
  - The health check is agui only.
- **Kept (F2):**
  - `protocol.ts`, `agui/sink.ts`, `agui/channel.ts`, `HostCore`, `internal-events.ts` and `event-meta.ts`;
  - main's `handleCompatFd`, the inline branch of `handleAguiStdout`, `handleNdjsonLine`, `answerHostService` and the `emitNdjson` tap fan-out;
  - `shared/agent-types.ts` and `protocol-mirror.test.ts`;
  - **all 24 `.ndjson` baselines**, as frozen oracles (§8.2).
- CI: the NDJSON smoke step goes, and the AG-UI step stays.
- **Gate:** R7-T5, R7-T6, R7-T7, R7-T8 and R7-T9 on three OSes; `rg -n 'NdjsonHost|resolveWire|wireFor|aguiForEverySpawn|ABACUSAI_BOT_AGENT_WIRE' apps packages` returns nothing (the agent's own refusal of `--wire ndjson`, D4, is the one place the word stays).

### C11 — Transition data paths that are safe to remove in N

- Delete `installLegacyPrefsSync` and its call (`index.ts:1734-1737`). `RendererStateStore` keeps only `readRendererStateFile`, which step 2, step 3 and `progressWindowDark` (`startup.ts`) use; the `onSet` listener goes.
- Delete the dual-write: `TranscriptService.write` (no caller after C8), `ThreadStore.writeFromV1`, and the `dual-write` own-write cache kind.
- **Kept until N+1 (D2):**
  - the repair in `readCurrentFile`, still needed while step 1 may be pending or blocked;
  - the cleared-history rule;
  - `TranscriptService.remove`'s v1 removal (the dual-remove), so a thread cleared in N stays cleared if the old build is reinstalled and N is then reinstalled.
- **Forward compatibility with N+1.** `ThreadStore` reads `migrations.json` once at startup. When step 4 is recorded as applied, the cleared-history rule and the repair are off, the twin is authoritative, and tombstones still apply. Without this, a user who reinstalls N after N+1 would see every migrated conversation as empty, because every migrated twin is then "v1-derived with no v1" (§9.3).
- **Gate:**
  - C-T* green;
  - R7-T13 (downgrade) passes against a home N has run on;
  - R2-T11/T13 (migrated history) green.

### C12 — Dependencies and tooling

- Remove the dependencies in §5.6 whose grep returns nothing. Also:
  - the `react-tourlight` patch (`patches/react-tourlight@0.3.0.patch` and `pnpm-workspace.yaml:75`);
  - `allowBuilds."@tsparticles/engine"` (`:36`).
- `knip.json` covers the whole desktop app with `dependencies` and `unlisted` included. The script `check:knip-next` → `check:knip`, with root `check` and CI updated.
- `.size-limit.json` limits set from the C5 measurements (§14.4); CI runs `size-limit` in the `package` job after `build`.
- `ci.yml:25-29` `NODE_OPTIONS` comment: "monaco, shiki, katex" are gone. Measure the build's peak heap and keep 4096 only if still needed.
- `build/licenses/lobe-icons-LICENSE`/`sources.json` stay only if `ConnectorMark` (03 §14) still carries the Exa/Firecrawl/Tavily paths; the same for `devicon-LICENSE`. Decided by `rg` over `src/renderer/components/connector-mark`.
- CSP: `'unsafe-eval'` (`renderer-csp.ts:5`, `index.html`, `notch.html`) is re-evaluated. If the packaged app passes R7-T16/T30 with `script-src 'self' 'wasm-unsafe-eval'` (transformers.js WASM), it is narrowed; otherwise it is kept and the reason is recorded.
- **Gate:** R7-T22 and R7-T23; `pnpm install --frozen-lockfile` in a clean checkout; `check:audit`.

### C13 — Locales

- Delete every `en-US.json` leaf that is used by no file under `src/renderer` (outside `locales/`), is not a keymap target, and is not in `scripts/locale-retired.json`. Delete the same leaves in the 10 other locales.
- `sync-locales --apply-keymap`, `scripts/locale-keymap.json` and `locale-retired.json` then have nothing left to do: the mapped keys have been copied, and the retired keys deleted. They go, together with R1-T16's keymap half.
- **Gate:** R7-T26.

### C14 — Packaging and release notes (release N is cut here)

- `electron-builder.yml`: remove the duplicate `NSMicrophoneUsageDescription` line (`:145-146`). §10 lists everything else that was checked and needs no change.
- Notch inference constants updated from the R6-T31 records (06:595).
- `CHANGELOG.md` `## Unreleased` gets the user-facing notes (§12.1). The version bump is a foundation release.
- `docs/rewrite/PLAN.md` phase 7 is amended as in §16, and `PROGRESS.md` is updated.
- Support article: "Going back to the previous version", with the text of §12.3.
- **Gate:** R7-T16 and R7-T18 on the final tree; R7-T17 on the signed RC in the private pipeline; R7-T24 re-run on the signed RC; the release manager's go.

### C15 — Retire the legacy files (release N+1)

- **Entry:**
  - N at 100 % for ≥ 14 days;
  - rollback triggers (§12.2) not hit;
  - no open P0/P1 against migrated data.
- Register steps 3 and 4 in `MIGRATION_STEPS` (`[1, 2, 3, 4, 5]`; step 5 `routine-attempt-ids` is registered by phase 5, 05 §31.5 f).
- Delete from `ThreadStore`: the repair, the cleared-history rule and `readText`'s v1 read, and from `TranscriptService.remove`: the v1 path. `ai.hydrate` reads `threads/` only. Step 4's own reader stays in `steps/transcript-files.ts`.
- `legacy-home.test.ts` expects every registered id. A cut-over-build test asserts that `ai.hydrate` serves a thread whose v1 was archived (the C1 Claude #2 request).
- **Gate:** R7-T14 on the real registry, R7-T15, and R7-T10/T11 re-run with N+1 as the target.

## 5. Deletion inventory

Each row has a proof: a grep or a test that must come back empty or green after the named PR. R7-T21 runs every grep in this section as one test (§15).

### 5.1 The old renderer tree (C6)

| What | Size at `HEAD 24b02486` | Notes |
|---|---|---|
| `src/renderer/**` except `locales/` | 436 files. About 84.8k lines of TS/TSX outside `locales/`. | Includes `conversation/` (about 6.9k non-test lines, the PLAN's "conversation layer"), `stores/` (the zustand stores), `providers/`, `terminals/`, `voice/`, `hooks/`, `lib/` (`activity-beacon.ts`, `ui-continuity.ts`, `durable-storage.ts`, `window-chrome.ts`, `i18n.ts`), the legacy dialog wrapper, the hand-rolled tabs, menus and listboxes, the `?view=` redirects and `staticData.titleKey/backTo` (all PLAN "Nuked"). |
| `apps/desktop/index.html` (legacy entry) | 16 lines | Replaced by the renamed `index-next.html` in the same commit (F10). |
| `tsconfig.renderer.json`, vitest project `renderer` (`vitest.config.ts:64-75`), oxlint override `oxlint.config.ts:31-67` | — | The new tree takes over these names in C7. |
| `scripts/check-legacy-renderer-diff.mjs`, `scripts/legacy-renderer-allow.json`, `src/main/dev/legacy-diff.test.ts`, `check:legacy-diff` in both `package.json`s | — | Their only purpose was guarding the old tree. |
| Re-export shims and wrappers (§3 row 41), `components/browser/pptx-viewer.tsx` (row 39) | — | The `shared/` modules they point at stay. |

**Kept:** `src/renderer/locales/*.json` (11 files, D6), and every `src/shared/**` module the specs moved out of the old tree.

**Proof:**
- `test ! -e apps/desktop/src/renderer/app.tsx`;
- `rg -l . apps/desktop/src/renderer --glob '!locales/**'` lists only files that came from renderer-next (checked in C7 against `git log --follow`);
- `rg -n "renderer/(components|conversation|stores|hooks|providers|terminals|voice)/" apps/desktop/src` returns nothing.

### 5.2 `window.api`, the preload and the legacy bridge (C8)

| What | Where | Replaced by |
|---|---|---|
| `window.api` (249 members: 62 Q, 137 M, 6 S, 25 T, 19 R; `PARITY.md:11-268`) | `preload/index.ts:49-279`, `preload/bridge.ts` (1090 lines), `preload/index.d.ts` (197 lines) | The oRPC contract through the MessagePort (`preload/rpc-port.ts`). Every member has a destination in `PARITY.md`, and the 19 R rows have a reason. None is empty (verified by script). |
| `durableState` and the synchronous `renderer-state:snapshot` read | `preload/index.ts:30-41,252-264` | `db.prefs` (spec 00 B) |
| `reportUiActivity` (`renderer-activity`), `signalRendererReady` (`renderer-ready`) | `preload/index.ts:266-276` | `window.activity`, `window.ready` (C3, spec 00 A.4.6) |
| `recreateMainWindow`, `isFullScreen`, `onFullScreenChange`, `getWindowChrome`, `onWindowChromeChange` | `preload/index.ts:87-111` | `window.state`, `window.events`, `window.chrome`; recreate is main-only |
| Bridge sub-modules and tests | `preload/{browser-runtime,terminal-runtime,worktree}-bridge.test.ts`, `preload/parity.test.ts` | — |

**Kept:**
- `installRpcPortHandshake` (`preload/rpc-port.ts`);
- `window.abacusHost.getPathForFile` (`PARITY.md:268`, "the only non-port preload export");
- the notch dispatcher of 06:550-581.

**Proof:**
- `rg -n "window\.api|exposeInMainWorld\(\"api\"" apps/desktop/src` returns nothing;
- `preload-exposure.test.ts` sees exactly `{ abacusHost }` for both `--abacus-window` kinds.

### 5.3 Legacy IPC channels no longer used (C8, C9)

**`IpcChannels`** (`shared/channels.ts`, 195 members) is deleted whole. Its users are:
- `handler.ts:493-…` (every `ipcMain.handle(IpcChannels.*)`);
- `rpc/emit.ts:16`;
- `services/browser/browser-runtime-handler.ts:47-…` (the `handle()` helper) and `electron-browser-runtime.ts:751` (a legacy `IpcChannels.Event` send to the browser runtime's own window, beside `publishIpcEvent`);
- `preload/bridge.ts`;
- tests.

The browser runtime keeps only its bus path. The preload no longer registers the invoke-style device-stream channels (`StartDeviceStream`, `StreamDeviceTouch`, `StreamDeviceKey`; `channels.ts:140-148`); their contract procedures stay.

**Raw string channels registered in main** (`ipcMain.handle|on`, tests excluded) that go:

| File | Channels |
|---|---|
| `index.ts:401` | `renderer-activity` |
| `index.ts:1795-2090` | `open-external`, `open-file-path`, `show-item-in-folder`, `get-app-version`, `window:show-about`, `window:is-full-screen`, `restart-app`, `get-home-dir`, `has-google-chrome`, `theme:set`, `show-notification`, `window:chrome`, `window:recreate`, `settings:set-titlebar-density`, `append-logs`, `save-logs`, `account:get`, `account:skip`, `account:sign-out`, `account:forget`, `funnel:step`, `open-folder-dialog`, `open-files-dialog`, `save-pasted-temp-files`, `read-clipboard-image`, `fetch-url-attachment`, `files:read-image-as-data-url`, `files:read-file-as-text`, `files:read-pptx`, `skills-list-installed`, `skills-search-marketplace`, `skills-install`, `skills-remove`, `skills-import-local`, `skills-open-file` |
| `keep-awake.ts:35-46` | `power:get-keep-awake`, `power:set-keep-awake`, `power:set-agent-busy` |
| `services/config/renderer-state.ts:201-213` | `renderer-state:snapshot`, `renderer-state:set`, `renderer-state:clear` |
| `services/updates/update-handler.ts:6-14` | `update:check`, `update:install`, `update:get-status` |
| `services/browser/browser-runtime-handler.ts` | the browser-runtime invoke channels |

**Main → renderer pushes that go** (the bus path next to each stays):
- `sendToRenderer(IpcChannels.Event)` (`rpc/emit.ts:16`);
- `update-status` (`update-service.ts:450`);
- `notification-clicked` (`index.ts:1398`);
- `window:full-screen-changed` (`index.ts:644-647`);
- `window:chrome-changed` (`index.ts:1589-1590`);
- `agent:device-stream-chunk`: the `wc.send` in `device-stream-service.ts:233`, `ios-stream-service.ts:186` and `android-scrcpy-service.ts:339`. The services take the `publish("device-chunk", …)` sink instead of a `WebContents`, and `rpc/device-chunks.ts`'s proxy goes.
- `local-cli-ndjson`, the `IpcEvent` the old renderer read (`service-host.ts:1264,1284-1295`).

**Kept:**
- `rpc:connect` (`rpc/transports/message-port.ts:169`);
- the notch window's `--abacus-window` argument (06);
- the browser runtime's own preload channels, if 04 kept any for the WebContentsView content (those are not app IPC);
- internal `ipc-message` listeners that are not renderer API (none left after C8).

**Proof (R7-T20, static):** `ipcMain.handle` and `ipcMain.on` appear only in `rpc/transports/message-port.ts` and in files listed in `ALLOWED_IPC_FILES` inside the test. The list starts empty apart from that transport.

**Window-chrome §7 grep, corrected (F17):**

```
rg -n "TITLEBAR_|workspace-topbar-height|titlebar-start-inset|WebkitAppRegion|windowChromeMetrics|onFullScreenChange|window:is-full-screen|window:full-screen-changed|useWindowFullScreen|MACOS_TRAFFIC_LIGHT_POSITION" apps/desktop/src
```

It must return nothing, and `src/shared/window-chrome.ts` must be gone (00-window-chrome §12). The bare `isFullScreen` is dropped from the pattern because `BaseWindow.isFullScreen()` is Electron API.

### 5.4 Compat-only code that stays (and why)

| Kept | Where | Why |
|---|---|---|
| The compat stream: agent `HostSink` compat half, `toNdjsonWire`, `agui/channel.ts` (`preflightCompat`, `openFdWriter`, `inlineWriter`, `noCompat`, `INLINE_COMPAT_PREFIX`, `classifyStdoutLine`) | `packages/agent/src/agui/{sink,channel}.ts` | Main's taps read legacy `DesktopEvent` lines on fd 3 (PLAN amendment :366; agent spec :1001). |
| `DesktopEvent`, `AgentEvent`, `DesktopCommand` | `packages/agent/src/protocol.ts:119,417,523` | The compat writer and every tap type against them, and stdin still accepts the legacy commands (agent spec §2.2). |
| `shared/agent-types.ts` + `protocol-mirror.test.ts` | `src/shared/` | Main's mirror of the above. |
| `handleCompatFd`, the inline branch of `handleAguiStdout`, `handleNdjsonLine`, `answerHostService` | `cli-manager-service.ts:739-755,1017-1180,1338` | The compat reader and host services (these stay on compat, PLAN amendment :368). |
| The `emitNdjson` tap fan-out, minus the old-renderer emission | `service-host.ts:1260-1361` | `recordAgentSession`, turn state and watchdog, artifacts, messaging relay, routine settle, turn waiter, browser auto-allow, state patch, skills. |
| The 24 `.ndjson` baselines | `packages/agent/src/agui/__fixtures__/*.ndjson` | Frozen oracles for compat byte-identity (§8.2). |
| The agent's `queue.update`/`remove` producing the legacy `update_queue_item`/`remove_from_queue` compat lines | 02:1088 | The turn-state tap reads them. |
| `legacy-prefs.ts` (`mapLegacyKey`, `composeLegacyPrefs`, the zustand-format parser) | `src/main/services/config/legacy-prefs.ts` | Step 2 runs for any user upgrading from a pre-rewrite build, and step 3 in N+1. Migration steps are permanent. |
| `readRendererStateFile` | `renderer-state.ts:26` | Read by steps 2 and 3 and by the progress window's theme (`startup.ts` `progressWindowDark`). |
| `shared/transcript/v1-to-ui-messages.ts`, `thread-file.ts` | `src/shared/transcript/` | Steps 1 and 4 and the migrated-history renderers (02 §8, R2-T11/T13). |
| `v1`-derived thread files' debug-sync and feedback path | 03:1118 | Migrated threads keep today's path. |

### 5.5 The legacy prefs sync and `renderer-state.json`

| Release | `renderer-state.json` | `prefs.json` |
|---|---|---|
| Transition (today) | Written by the old renderer, read-only for new code (01:1137). | Live legacy sync plus provenance (`installLegacyPrefsSync`, `index.ts:1737`). |
| N (C11) | Nobody writes it. The IPC is gone (C8) and the file is left exactly as the last legacy build left it, which is what a downgraded build reads (§12.3). Step 2 still reads it for a user upgrading straight from a pre-rewrite build. | Authoritative. No live sync. |
| N+1 (C15) | Step 3 runs the final whole-file import (a no-op for anyone who ran N, since nothing changed the file since), then drops the mapped keys. Both files are backed up. | Authoritative. |

The `renderer-state:*` IPC, `durableState` and the `onSet` listener (`renderer-state.ts:90-176`) go in C8 and C11. `RendererStateStore` shrinks to the file reader.

### 5.6 Dependencies (C12)

Importer counts at `HEAD 24b02486`. They count files whose `import`, `import()`, `require()` or CSS `@import` names the package, under `src/renderer` ("old"), `src/renderer-next` ("next"), and `src/{main,shared,preload}` plus `scripts/` and the Vite configs ("other").

| Package (desktop `package.json`) | Old | Next | Other | Disposition |
|---|---|---|---|---|
| `zustand` | 13 | 0 | 0 | Remove (PLAN Nuked). `legacy-prefs.ts` parses zustand's *format* and does not import the package. |
| `framer-motion` (direct `^12.29.0`) | 4 | 0 | 0 | Remove. `motion@13.4.6` brings `framer-motion@13.4.6` transitively, so `pnpm-workspace.yaml:69` stays (F14). |
| `react-tourlight` | 4 | 0 | 0 | Remove, plus `patches/react-tourlight@0.3.0.patch` and `pnpm-workspace.yaml:75`. |
| `@tsparticles/engine`, `@tsparticles/react`, `@tsparticles/slim` | 0 | 0 | 0 | Remove (dead today), plus `allowBuilds."@tsparticles/engine"` (`pnpm-workspace.yaml:36`). |
| `uuid` | 0 | 0 | 0 | Remove (dead today; 03 uses `crypto.randomUUID()`). |
| `@dicebear/core`, `@dicebear/styles` | 1 | 0 | 0 | Remove (P71, `BotAvatar`). |
| `@monaco-editor/react`, `monaco-editor` | 1 each | 0 | 0 | Remove (S78, `@tanstack/highlight`). |
| `katex` | 2 (plus the two CSS `@import`s in `assets/{base,main}.css`) | 0 | 0 | Remove (`temml`, 02 §7.3). |
| `@lobehub/icons-static-svg` | 1 | 0 | 0 | Remove (`ConnectorMark`, 03 §14). The licence file follows C12's rule. |
| `sonner` | 18 | 0 | 0 | Remove (registry `toast`, 01 F6). |
| `clsx`, `tailwind-merge` | 1 each | 0 | 0 | Remove (the registry's `cn`, 01:98). |
| `@tanstack/highlight`, `@tanstack/markdown` | 1 each | 0 | 0 | Keep. Phase 2 imports them (02 §7). C12 re-counts and removes any with zero importers. |
| `@tanstack/react-form` | 1 | 0 | 0 | Keep (phase 3 forms, 03:183-192); re-count. |
| `ghostty-web`, `@pierre/trees`, `diff` | 2 / 1 / 1 | 0 | 0 | Keep (phase 4: terminal, file tree, diffs); re-count. `ghostty-web`'s patch stays. |
| `@huggingface/transformers` | 1 | 0 | 0 | Keep (06 `lib/voice/`, R6-T27); re-count. |
| `@fontsource-variable/jetbrains-mono` | 1 | 0 | 0 | Keep if the code font is used by 02/04, else remove; re-count. |
| `@abacus-ai/connectors` | 1 | 0 | 8 | Keep (main). The renderer import depends on R5-T33 (browser-safe registry). |
| `@testing-library/dom` | 0 | 0 | 0 | Keep (a peer of `@testing-library/react`); add to knip `ignoreDependencies` with that reason. |
| `@aceternity` registry | — | — | — | Nothing left: no importer and no `components.json` registry entry. |

**Proof (R7-T22):**

```
rg -n --glob '*.{ts,tsx,js,mjs,cjs,css}' \
  "(from |import\(|@import |require\()['\"](zustand|framer-motion|react-tourlight|@tsparticles/|uuid|@dicebear/|@monaco-editor/react|monaco-editor|katex|@lobehub/icons-static-svg|sonner|clsx|tailwind-merge)(['\"/])" \
  apps packages -g '!**/node_modules/**'
```

It must return nothing. `knip` with `dependencies` and `unlisted` must be clean for `apps/desktop`. `node -e` over `apps/desktop/package.json` asserts none of these names remains.

The oxlint ban list keeps every removed name so they cannot come back (C7 renames it).

### 5.7 Transcript v1 path, step 4 and the rule removal

These are split across releases (D2); §9 has the full plan.

| Piece | Release N | Release N+1 |
|---|---|---|
| `TranscriptService.write` + `ThreadStore.writeFromV1` (dual-write) | Deleted (C11). There is no v1 writer after C8. | — |
| `readCurrentFile` repair and the cleared-history rule | Kept | Deleted (C15) |
| `TranscriptService.remove` removing v1 (dual-remove) | Kept | Deleted (C15) |
| Step 3 | Code and tests only (C1) | Registered (C15) |
| Step 4 (with orphan twins, `tooLarge` and the tombstone) | Code and tests only (C1) | Registered (C15) |

### 5.8 Development-only code that must not ship

| Code | Guard today | At cut-over |
|---|---|---|
| Mutation harness (`src/main/dev/mutation-harness.ts`) | Inert unless `!isPackaged && ABACUSBOT_DEV_HARNESS=1` (`:161-178`), but bundled into `dist/main` | Compiled out of release builds (C4). `check-release-build` asserts it is absent. |
| Dev hooks (`window.__abacusDev`, `lib/dev/dev-hooks.ts`) | Dynamic import only when `VITE_UI_GALLERY === "1"` (`main.tsx:170-177`) | Absent from release `dist/renderer` (C4). |
| Fixture DB (`data/fixture-db/`) | `VITE_NEXT_DB_FIXTURES=1` (`main.tsx:114-117`) | Absent from release `dist/renderer`. |
| `/__ui` gallery route | `notFound()` unless `DEV \|\| VITE_UI_GALLERY` (`features/gallery/search.ts:106`). The route chunk ships. | Stays gated. C4 also asserts that the gallery's fixture and scenario modules are not in the release chunk graph; only the gated route stub remains. |
| Devtools (`lib/devtools.tsx`) | `import.meta.env.DEV && MODE !== "test"` (`routes/__root.tsx:11-15`) | Asserted absent by string (01:1119). |
| Single-transition guard, dev error details, the `overlay-unavailable` badge | `DEV \|\| VITE_UI_GALLERY` | Stay dev-only. |
| Env overrides `ABACUSBOT_RENDERER_GENERATION`, `ABACUSBOT_DEV_CONTENT_SIZE`, `ABACUSBOT_NOTCH_METRICS`, `ABACUS_TEST_HANDSHAKE_DELAY_MS`, `--rerun-migration` | Honoured only when unpackaged | `ABACUSBOT_RENDERER_GENERATION` is deleted (C9); the rest stay unpackaged-only (R7-T31 checks each). |

### 5.9 Scripts and configuration touched

`vite.config.ts`, `vite.shared.ts`, `vitest.config.ts`, `tsconfig.json` references, `tsconfig.renderer*.json`, `knip.json`, `oxlint.config.ts`, `components.json`, root and desktop `package.json` scripts (`dev:next*`, `check:legacy-diff`, `check:knip-next`, `screenshots:next`), `scripts/{screenshots-next,shadcn-next,shadcn-next-init,sync-locales,check-jsx-i18n,build-experience,before-pack}.*`, `apps/updater/src/classify.ts` and its test, `.github/workflows/ci.yml` (the check job, the NDJSON step, the smoke markers, size-limit), `pnpm-workspace.yaml`, `patches/`, `electron-builder.yml` (§10).

## 6. FOUNDATION_API bump and updater coordination

### 6.1 What an experience bundle is

- **Delivery.** The app has two release units (`apps/updater/README.md`; `classify.ts`):
  - the **foundation**: the signed installer, updated by electron-updater from `downloads.abacus.ai/abacusai-bot/latest`;
  - the **experience**: a TUF-signed zip, `experience/latest.zip` (`experience-updater.ts:23-29`), holding `renderer/` (= `dist/renderer`, today both HTML entries) and `agent/` (= `packages/agent/dist` without maps, declarations or stamps; `scripts/build-experience.js:44-59`), plus `manifest.json`.
- **Manifest.** `{ agentVersion, experienceVersion, files{sha256,size}, foundation, foundationApi, protocol, rendererVersion }` (`apps/updater/src/manifest.ts:73-108`).
  - `foundation` is the exact `package.json` version the bundle was built for.
  - `experienceVersion` hashes the file table together with `foundation`, `foundationApi` and `protocol`.
- **Verification** (`integrity.ts`). After TUF verification, the verifier recomputes every digest and refuses a bundle when any of these holds:
  - `foundation !== app.getVersion()` (`:51-55`);
  - `foundationApi !== FOUNDATION_API` (`:57-59`);
  - `protocol !== EXPERIENCE_PROTOCOL` (`:61-63`);
  - `agent/main.js` or `renderer/index.html` is missing (`:196-200`).

  The candidate's agent must then pass the health check (`health-check.ts`) before it is installed.
- **Swap.** `RendererSwapScheduler` (`renderer-host.ts:133-209`) swaps the live renderer to the new bundle at the first quiet moment:
  - "quiet" means no agent turn, no live terminal and no input for 15 s (`index.ts:410-426`);
  - the candidate must pass the barrier;
  - a candidate that never becomes ready is retried at most 3 times per bundle URL.

### 6.2 What the bump to 2 changes

1. **Admission.** A foundation at API 2 refuses every manifest with `foundationApi: 1`, and a foundation at API 1 refuses every manifest with 2. The exact-version check already enforces this between releases (F3). The bump adds a guard when the version check cannot tell the difference: a pipeline that stamps N's version on a tree built before C5.
2. **Barrier.** `index.ts:425` selects `subscriptions`. A swap flips only after the candidate's `window.ready({ barrier: "subscriptions" })` reports `ready`: transport, shell tables and visible thread live (spec 00 A.4.6, R1-T20). `failed` or a 10 s timeout raises `SwapNotReady`, and the retry budget applies. After C8 the `first-commit` path (`renderer-ready`, `READY_TIMEOUT_MS`) is deleted.
3. **Entry points.** From API 2 the verifier also requires `renderer/notch.html` (D3). A bundle without the notch entry would leave the notch window unable to reload on a swap (06:578, R6-T30).
4. **Contract.** `system.info.foundationApi` reports 2 (`rpc/procedures/system.ts:48`). The renderer does not branch on it, since there is one renderer.

### 6.3 Coordination steps

| Step | Where | Check |
|---|---|---|
| Both constants to 2 in one commit | `src/shared/experience.ts:11`, `apps/updater/src/manifest.ts:10` | `foundation-api.test.ts` (C2) plus `integrity.test.ts`, which builds with `@abacus-ai/updater/experience` and verifies with the desktop verifier, so a mismatch fails "accepts a built experience" |
| Classifier prefixes | `apps/updater/src/classify.ts:11-15` | `classify.test.ts`: `index.html`, `notch.html` and the renderer tree are `experience`; `src/shared/`, `src/preload/` and `package.json` are `foundation` |
| Required entries | `integrity.ts:196-200` | R7-T2: a tree without `renderer/notch.html` is refused at API 2 |
| The build refuses a gallery or fixture renderer | `scripts/build-experience.js` runs `check-release-build` (C4) | R7-T31 |
| Release pipeline (private repo) | Builds the foundation and its first experience from the same pinned commit ≥ C14. It publishes `experience/latest.zip` for N only once N's installers are live at any rollout percentage. | Checklist item in §17 |
| The health check matches the spawn | `health-check.ts` agui mode (C2, C10) | R7-T8 |

### 6.4 Publishing during the staged rollout

There is one experience target for every foundation (`experience/latest.zip`). A client on N−1 therefore downloads an experience built for N, refuses it (foundation mismatch), and keeps its installed one. The reverse also holds: an experience published for N−1 would stall N's clients. So:

- From the RC cut, experiences are built and published for N only. Nothing more is published for N−1.
- Clients on N−1 keep their active experience and reach N through the staged foundation update.
- A renderer or agent fix for N during the rollout ships as an experience. It is the fastest lever (§12.2), because it swaps without a relaunch once the user is idle.
- A client still on N−1 retries the N target at every check and refuses it again, because `#target` is set only on success (`experience-updater.ts:186-190`). Each retry costs a TUF metadata refresh, plus extracting and hashing the cached archive (`:191-221`); there is no re-download, since `findCachedTarget` hits. R7-T3 measures that cost once. C2 also makes the updater remember a refused target hash for the rest of the process, so a foundation that ships it (the dormant release, if any, and every release after N) stops paying it.

## 7. The generation flip and the deferred wco items

### 7.1 What flips at C5 for a packaged user

All of these are already implemented behind `RENDERER_GENERATION === "wco"`, and the release notes cover them (§12.1).

- **Entry.** `rendererEntry` loads `index-next.html` (`renderer-entry.ts:26-48`), which is `index.html` after C6. Experience swaps target the same entry (`experienceEntryUrl`, `:51-57`).
- **Chrome.** Window Controls Overlay on macOS, Windows and allow-listed Linux DEs, with the Linux native-frame fallback and startup probe (`index.ts:588-598,856-915`). The stored theme is applied before the window exists (`startup-theme.ts`). Density is honoured, and a density change recreates the window on macOS (`index.ts:1886-1891`).
- **Chrome state events.** `window:chrome-changed` (legacy) is no longer the path; `window.events` is.
- **Notch and capsule.** The controller exists only in wco (06:648). macOS gets the notch window and Windows the capsule, with their global shortcut and settings rows.
- **OS notifications.** Always `silent: true`, because sound is owned by `lib/sound.ts` (05 §31.5 d; 06 NT2). "Task still running" is suppressed while a notch window is ready (06 NT3).
- **Wire.** Every agent is spawned `--wire agui` (§8).
- **Keep-awake.** Follows run state in main (C2).

### 7.2 The two low items due before `RENDERER_GENERATION = "wco"`

| Item | State at `HEAD 24b02486` | Fix (C2) | Test |
|---|---|---|---|
| (A) The probe reschedules every 250 ms while the window is hidden or minimized | Full screen and minimized already wait on `leave-full-screen`/`restore` (`index.ts:869-876`). A hidden window, e.g. `startHiddenAfterUpdate`, still loops on `setTimeout(probeAfterShow, 250)` (`:897-904`). | `!isVisible()` → `mainWindow.once("show", probeAfterShow)`. The timer is only for a `retry-later` from a visible, restored, windowed state. | R7-T28: fake timers plus a fake window. No timer is armed while hidden, and the probe runs once on `show`. |
| (B) `window:recreate` is exposed in legacy mode | `ipcMain.handle("window:recreate")` is unconditional (`index.ts:1881`); preload member `recreateMainWindow` (`preload/index.ts:110-111`) | Registered only in wco (C2). Deleted with the preload member in C8, where recreate stays main-only (`recreate-main-window.ts`). | R7-T28 (C2); R7-T20 (C8) |

The review also deferred the Electron integration test, the §7 deletions, popup no-drag and the browser-view zoom and translation fixes to "the renderer switch" (`00-window-chrome.impl-claude-r1.md:11`). The integration test is implemented in C2 (R7-T29). The deletions are C9, with the corrected grep of §5.3. Popup no-drag and the browser-view fixes were phase 1 and phase 4 deliverables, and are re-verified in R7-T29 and R4-T30.

## 8. The wire flip

### 8.1 What changes

- **C5.** For every spawn, `wireFor` returns `agui`. `cli-manager-service.ts:600-624` passes `--wire agui --thread-id <sessionId> --compat-fd 3` with four stdio pipes.
  - Nothing can still be running `--wire ndjson`, since the flip arrives with a foundation update, which relaunches the app.
  - The relay's "speaks the legacy protocol" `UNAVAILABLE` paths become unreachable, and C10 deletes them.
- **C10.**
  - The agent: an absent `--wire` means agui, and `ndjson` is refused (D4).
  - Main: wire selection is deleted, and the spawn always passes the flags.
  - The health check spawns exactly like main, minus `--compat-fd`.
- **Unaffected.** The sandbox probe (`--sandbox-probe`, handled before `--wire` at `main.ts:73-78`) and the host-service round-trips on compat.

### 8.2 The byte-identity guarantee for the taps

Main's taps read compat, never AG-UI. The flip is therefore safe for them exactly when compat under `--wire agui` is byte-identical to what `--wire ndjson` wrote on stdout.

1. **Oracles.** 24 scenarios, each `<scenario>.ndjson` plus `<scenario>.agui.jsonl` in `packages/agent/src/agui/__fixtures__/` (48 files).
   - 14 were recorded on `d9cf445e`, the last commit before any agent `src` change, with the pre-change `NdjsonHost`: dequeue-idle, malformed-command, permission-accept, permission-reject-message, permission-two-calls, plain-text, queue-remove-clear, reset-conversation, steer-and-queue, stop-mid-stream, stop-then-message, todo-plan, tool-bash, turn-failed.
   - 10 were added in impl r1: null-line, stop-after-text, reset-mid-run, openllm-rotation, openllm-exhausted, stall-recovery, stall-twice, bot-housekeeping, bot-no-model, delegate-colliding-ids.
   - `RECORD_NDJSON_BASELINE=1` only writes a missing file and never overwrites one (agent spec :1094).
2. **In-process proof.** `agui-golden.integration.test.ts` drives `AguiHost` through every scenario and asserts that its compat bytes equal the `.ndjson` baseline (`:64`), and that the AG-UI stream parses and equals `.agui.jsonl`. It also asserts that rejected, duplicate and invalid AG-UI commands add no compat bytes (agent spec §7.2 item 5).
3. **Spawned proof.** The spec asks for three scenarios on three OSes (agent spec :1097). Today only `plain-text` is spawned (`agui-spawn.e2e.test.ts:122,161,196`). R7-T6 runs `plain-text`, `permission-accept` and `tool-bash` on macOS, Linux and Windows CI, in fd mode and in inline mode.
   - Before C10 it compares against a live `--wire ndjson` process.
   - After C10 it compares against the `.ndjson` baseline, with the masks the spec names (pi session id, `ts`, `Date.now()`-derived subtask ids, the fd-mode `compat.hello` preamble).
4. **The one documented divergence.** Under agui, Stop and reset hold admission (`reserveDuringAbort`, agent spec :455): a message that races an idle Stop or reset is queued and runs after it. Under ndjson it was sent into the session being aborted. No golden covers that race, and the turn-state tap sees the queued turn start after the Stop's `turn_complete`, which is the intended outcome. The release notes do not mention it.
5. **After C10 the baselines are frozen.** Nothing can record a new independent oracle once `NdjsonHost` is gone. A new compat scenario is recorded from `AguiHost` with `RECORD_COMPAT_BASELINE=1`, marked `derived: true` in `__fixtures__/index.json`, and reviewed by diff against the nearest independent scenario. R7-T6 refuses to count a derived baseline as an oracle in its report.

### 8.3 The taps and their tests under agui

| Tap | Reads | Test that must run with every spawn agui (R7-T7) |
|---|---|---|
| Session record (`recordAgentSession`), turn state, post-Stop suppression | compat | `session-turn-state` suites plus a spawned stop-mid-stream |
| Artifacts (`recordFromNdjson`) | compat | artifacts service tests plus a spawned `tool-bash` writing a file |
| Messaging relay reply extraction (`handleAgentEvent`, `<reply>`) | compat | messaging gateway tests plus the `bot-housekeeping` scenario spawned |
| Routine settle (`settleRoutineRun`), turn waiter (`feedTurnWaiter`) | compat | routine run tests with a spawned agent; R5-T41 attempt ids |
| Browser auto-allow | compat → `sendCommandToRuntime` (agui path, `service-host.ts:1316-1328`) | auto-allow test bound to the emitting runtime |
| State patch, skills/MCP | compat | existing suites |
| Host services (`host_service_request` → `answerHostService`) | compat | render_document and render_deck round-trips spawned |
| Inactivity watchdog → `aguiRelay.failActiveRun("inactivity_timeout")` → stop | compat and relay | `stall-twice` spawned; the relay's terminal is written once |
| `local-cli-ndjson` to the old renderer | — | Deleted (C8) |

### 8.4 Version skew

- An agent bundle comes from the foundation's `extraResources` or from an experience for the **same** foundation version, so main and agent change together release by release.
- D4 keeps them compatible across experience updates inside one foundation: main always passes `--wire agui`, and the agent accepts it indefinitely.
- An agent that no longer speaks agui cannot become active, because the health check (agui mode) refuses it (R7-T8).

## 9. Migration at the cut-over

### 9.1 Steps by release

| Id | Name | Registered | Mutates what an older build reads? |
|---|---|---|---|
| 1 | `transcripts-v2` | Transition (today) | No: it writes `threads/` |
| 2 | `prefs-from-renderer-state` | Transition (today) | No: it writes `prefs.json` |
| 5 | `routine-attempt-ids` | Phase 5 (05 §31.5 f, R5-T41) | Additive fields in `cronjobs.json`. The old build must tolerate them (R7-T13 proves it). |
| 3 | `final-legacy-prefs-import-and-drop` | **N+1** (C15) | **Yes**: it drops keys from `renderer-state.json` |
| 4 | `archive-transcripts-v1` | **N+1** (C15) | **Yes**: it moves `transcripts/*.json` into the backup |

Ids are never reused or renumbered (`steps/index.ts:2-3`). The runner orders by id, so a user jumping from a pre-rewrite build straight to N+1 runs 1, 2, 3, 4, 5 in one launch.
- Step 4's "convert first" sees step 1's fresh twins, so everything is archived in the same run.
- Step 4 is `pending` only when it had to convert a v1 file first because no qualifying twin exists, for example a v1 file that N−1 wrote after a downgrade, newer than its twin. Files step 1 skipped are quarantined, not converted. With C1's `break` rule, the runner then commits and stops, and the next launch finishes (at most two launches; `MAX_STALLED_PARTIALS = 2`, `runner.ts:173`).

### 9.2 First launch of N

- The runner runs inside `whenReady`, before the services read their files (`index.ts:1712`). The progress window opens only if the run is still going after 400 ms (`progress-window.ts:22,61-70`), and its theme follows the old UI's stored `theme` (`startup.ts:47-58` `progressWindowDark`).
- For a user who shipped through the dormant release (§2 item 4), steps 1, 2 and 5 are already applied and N runs none of them.
- For a user coming from a pre-rewrite build, N runs 1, 2 and 5. Step 1's cost is the only large one: it scales with transcript bytes. R7-T32 bounds it.
- An unresolved attempt does not block launch (`startup.ts:84-92`, `write-block.ts`). After C1 that also holds for `ThreadStore`/`TranscriptService`.

### 9.3 Removing the cleared-history rule (N+1)

The rule (`thread-store.ts:119-129`: a v1-derived twin with no v1 file reads as empty) protects a cleared conversation from coming back through a failed v2 removal. Step 4 removes every v1 file, so after it every migrated twin is "v1-derived with no v1". The rule and the repair must therefore go **in the same commit that registers step 4**, and step 4 must first archive the orphan twins (C1). Otherwise:
- with the rule kept, all migrated history reads as empty;
- with the rule removed and orphans kept, cleared conversations come back (C1 Claude #2).

Release N must already cope with a home N+1 has migrated, because a user can reinstall N: C11's forward-compatibility switch turns the rule and the repair off once `migrations.json` records step 4.

The AG-UI tombstone (C1) keeps "cleared stays cleared" for threads cleared under N. C15's tests (R7-T14):
- hydrate serves a thread whose v1 was archived;
- a thread cleared before step 4 stays cleared, whether it had an orphan twin or a tombstone;
- an `agui` twin whose `migratedFrom.updatedAt` is older than its v1 file keeps that v1 file (step 4 "Keep").

### 9.4 Backups and retention

- Step 3 backs up `renderer-state.json` and `prefs.json` (`replace-user`, hash-checked).
- Step 4 moves v1 files into `backups/migrations/<stamp>_<attempt>-4-archive-transcripts-v1/`, and copies quarantined files to `backups/quarantine/transcripts/` (kept 90 days).
- Pruning keeps the newest 3 backups per step for 30 days (`backup.ts:252-323`). N+1's rollback window (§12.4) is therefore 30 days.

## 10. Notch and capsule packaging

Spec 06 adds no packages and no native module: `node-mac-notch` does not exist (06:30, :43, :157). Metrics come from a one-shot JXA probe, haptics from one long-lived `/usr/bin/osascript -l JavaScript` child (06:585-597, :661), and the windows are Electron `BaseWindow`s (`type: "panel"` on macOS, `type: "toolbar"` on Windows; 06:550-581, :666-670).

| Concern | Finding | Action |
|---|---|---|
| Vite output | `notch.html` is a third input at the root of `dist/renderer` (06:736). `electron-builder.yml` `files: dist/**` carries it (`:8-13`). The experience carries it because `renderer/` is `dist/renderer`. | R7-T18 asserts that the asar and the experience tree both contain `renderer/index.html` and `renderer/notch.html` (§6.2 item 3). |
| CSP | `notch.html` copies the `<meta>` verbatim (06:735). `rendererCspHeaders` covers every `app://` main frame (`renderer-csp.ts:18-35`), the notch included. | R7-T18 compares the three `<meta>` strings with `RENDERER_CSP` (C12 may narrow `'unsafe-eval'` everywhere at once). |
| macOS entitlements | `build/entitlements.mac.plist` already has: JIT, unsigned executable memory, library-validation off, audio input, network client, user-selected files, virtualization. A `panel` window needs no entitlement. `osascript` runs as its own Apple-signed process, outside the app's entitlements. The JXA scripts use the ObjC bridge on `NSScreen` and `NSHapticFeedbackManager` in that process and send no Apple Events to other apps. | No entitlement change. R7-T17 verifies on the **signed, notarized** RC that the probe returns metrics and that no TCC or Automation prompt appears. If one does, `NSAppleEventsUsageDescription` is added and the finding recorded. |
| `Info.plist` | `NSMicrophoneUsageDescription` covers notch dictation too (06 NT6). It is listed twice in `extendInfo` (`electron-builder.yml:145-146`). | Remove the duplicate (C14). |
| Windows manifest | electron-builder's defaults (no `requestedExecutionLevel` override in `win:`); the capsule is `alwaysOnTop` at `"pop-up-menu"` level and click-through, which needs no `uiAccess` | No custom manifest. R6-T33 on hardware, extended in R7-T17 to 100 %, 125 %, 150 % and 200 % display scaling and a taskbar on each edge: the capsule sits by the clock and never shows in Alt+Tab. |
| Linux | No notch or capsule (06:82, :649) | R7-T16 asserts that no notch window is created on Linux. |
| Global shortcut | `CommandOrControl+Shift+Space`, registered only while enabled (06:644) | R7-T16 asserts it is unregistered at quit (no leaked registration across relaunch). |
| Quit and update restart | The notch/capsule is destroyed on quit and on main close on win32 (R6-T25) | R7-T16 plus an update-restart case in R7-T33 (the capsule must not hold the NSIS installer's file lock). |

## 11. Parity sign-off checklist

**Rule.**
- Every row of every parity table has a status in its `features/<area>/parity.ts` (`PARITY.md` for the bridge):
  - **green**, with evidence (a test id, or a manual check recorded on the packaged RC);
  - **retired**, with its reason; user-visible retirements go into the release notes (§12.1);
  - **deferred**, naming an owner and the PLAN later-slice it belongs to; user-visible deferrals go into the release notes as "not in this version".
- No row is `todo`.
- Each row whose kind is "Parity" is demonstrated once in the **packaged** RC, not in dev, with the check id linked in the C5 PR.
- R7-T25 enforces the static part.

| Area (spec) | Ids | Retired (must be in notes if visible) | Deferred rows that must be green by now | Evidence the gate needs |
|---|---|---|---|---|
| Transport / bridge (00) | `PARITY.md` rows: 249 `window.api` members (62 Q, 137 M, 6 S, 25 T, 19 R), 46 `IpcEvent` types, 5 other push channels | The 19 R rows (`PARITY.md:41,44,45,112-115,122,124,132,133,178,195,218,219,229,245-247`) | The `notch.*`, `sessions.events` and `ai.runFinished` procedures present in the regenerated file | A-T6 generator green with the consumer column (D5); R7-T20 |
| Window chrome (00-wc) | §12 acceptance, 16 items | Legacy constants | — | R7-T29 on 3 OSes; the density and full-screen screenshots |
| Agent wire (00-agui) | 24 golden scenarios | — | — | R7-T6, R7-T7 |
| Foundation (01) | R1-T1…R1-T24 and R1-T11b; decisions A–D (PLAN:377-381) | Code-based router, `?view=` redirects, `staticData.titleKey/backTo` | — | The screenshot gate (1280/1100/1000/900/800 × light/dark, collapsed, floating, compact, full screen; axe serious/critical = 0); R1-T11b, T20, T22 in the packaged build |
| Chat kit (02) | Canvas coverage (`canvas-map.ts`, R2-T29); R2-T1…R2-T35 | Client-side `whenBusy: "queue"` (superseded, PLAN:370) | — | R2-T31 numbers on the reference Mac; R2-T32 real session with an approval round-trip |
| Bots (03) | P1–P73 | P8, P9, P26; the P2 workspace switch; the P13 count | P46 (phase 6), the P53 URL row (phase 4), P61 Revoke (phase 5) | R3-T30; R3-T31 on macOS (its legacy half is removed in C9) |
| Sessions (04) | S1–S111 | S5, S101; the S2 workspace switch; the S35 Compact toggle; the S41 terminal toggle; S48 retraction; S63 dismissal; S72 empty panel | S102 Take over / I'm done stays deferred (04 §27.3, owner: browser slice) | R4-T31; R4-T29 and R4-T30 in the packaged RC on macOS and Windows; R4-T34 |
| Routines (05) | RT1–RT26 | RT19; RT26 (`/settings/jobs`, `/routines/chat:<id>`) | — | R5-T38; R5-T36 on macOS and Windows; R5-T41 |
| Artifacts (05) | AR1–AR15 | AR6 Refresh | AR15 Remove (05 §32.3) | R5-T31 (2,000 artifacts) |
| Library (05) | LB1–LB21 | LB21 (`?view=` redirects) | — | R5-T36 |
| Settings (05) | ST1–ST27 | ST3; the ST18 composer strip and home banner | ST22 Replay tour (phase 6) | R5-T27 (updates, all states); R5-T36 |
| Onboarding (06) | OB1–OB17 | OB13 workspace switch, OB16 tour reset | — | R6-T36 fresh install recorded on macOS and Windows; R6-T5 (resume from legacy step ids) |
| First bot, tour (06) | FB1–FB7, TR1–TR9 | — | — | R6-T36 |
| Notifications, notch, sound (06) | NT1–NT7 | — | The features deferred at 06 §24.3 (calls, take-over, retry, extra-display capsule, Linux notch…) stay deferred | R6-T30 (CI), R6-T31, R6-T32, R6-T33 (hardware), R6-T40 |
| Migration (00 C, this spec) | C-T1…C-T9, R7-T10…R7-T15 | — | — | The upgrade and downgrade runs of §13 |

## 12. Release notes, rollout and rollback

### 12.1 Release notes (`CHANGELOG.md` `## Unreleased`, C14)

User-facing text, written in the file's voice (prose, no ticket numbers):

> **A new AbacusAI Bot.** The whole app is rebuilt. A rail on the left takes you to Bots, Sessions, Routines, Artifacts and the new Library, where connectors, messaging apps, MCP servers, skills and tools now live. Settings has its own pages, including Appearance, Notifications and Keyboard, and a search.
>
> The title bar is drawn by your system: traffic lights on a Mac, caption buttons and Snap layouts on Windows, and your desktop's own controls on Linux. You can choose a compact title bar. Light, dark and system themes apply before the window appears.
>
> On a Mac with a notch, a small companion lives around it. It shows when a bot is working, asks you to approve things, and lets you reply without opening the window. On Windows it is a capsule by the clock. You can turn either off in Settings › General.
>
> Sounds are the app's own: sent, received, needs you, done and failed, with per-bot levels and quiet hours. System notifications no longer play a sound of their own.
>
> Bots have new avatars. Your bots keep the look they had, drawn in the new style. Math in replies renders as the model writes it. The tour can be replayed from Settings.
>
> **What changed or went away.**
> - The built-in code editor is replaced by "Open in editor".
> - Sessions are grouped by folder instead of by date.
> - Update notices moved from the composer and the home page to a pill in the title bar.
> - Old `/settings/jobs` links open Routines.
>
> **The first launch** after updating may show "Updating your data" for a moment while your conversations are converted. Nothing is deleted: the previous version's files are left where they are.
>
> **Going back.** If you install the previous version again, it opens your bots, sessions, routines and settings as you left them before this update. Conversations and preference changes made in this version do not appear there.

The final list of changed and removed items is generated from the `retired` and `deferred` rows with `visible: true` in the parity files (R7-T25 prints it). The text above is the frame.

**Internal notes for the release PR:**
- the §7.1 flips;
- the FOUNDATION_API bump and the experience publishing rule (§6.4);
- the wire flip (§8);
- steps 1, 2 and 5 registered, 3 and 4 not (D2);
- the compat stream kept;
- the rollback levers below.

### 12.2 Rollout and triggers

- **RC.** The signed RC goes to the team for ≥ 3 days, on their own machines and, if they choose, on their own homes (D7). R7-T17 and the §11 manual checks are done on it.
- **Stages** (`stagingPercentage` in `latest*.yml`, D9): 5 % for 48 h, then 25 % for 72 h, then 50 % for 72 h, then 100 %. Each step needs the release manager's go against the triggers.
- **Triggers that halt the rollout** (freeze `stagingPercentage` at its current value):
  - any report of lost data (history, bots, routines, settings);
  - a migration `lastFailure` or unresolved attempt in any synced log (the log sync the app already has, where the user enabled it);
  - a rise in renderer BootFailure or error-screen reports (port lost twice, readiness `failed`) above the last release;
  - agent spawn failures with `compat_lost` (exit 75) or `wire_unsupported`;
  - a notch/capsule defect that blocks input to other apps (click-through failure).
- **Levers, fastest first:**
  1. **Halt** the rollout. electron-updater does not downgrade: `allowDowngrade` is not set in `update-service.ts`. So users already on N stay on N, and nobody new gets it.
  2. **Experience hotfix** for N (renderer or agent): TUF, no relaunch, swapped at idle behind the `subscriptions` barrier (§6.2).
  3. **Foundation N.1**, rolled out again from the current stage.
  4. **User-level downgrade** (§12.3), through support, for a user blocked on N.
  5. **Hold N+1** until the trigger is closed.

### 12.3 What a user on N can do if it fails (downgrade to N−1)

1. Quit the app. Reinstall the previous version from `https://downloads.abacus.ai/abacusai-bot/releases/<N−1>/`:
   - macOS: replace the app;
   - Windows: run the previous `-setup.exe`, which installs over N;
   - Linux: the previous AppImage or `.deb`.
2. The previous build reads the same home. After N it finds:

| Data | What N−1 sees | Why |
|---|---|---|
| Bots, sessions and workspaces, routines and runs, memories, connectors, messaging, settings (`bots.json`, `local-code.json`, `cronjobs.json`, `routines/`, `memories/`, `config.json`, electron-store files) | As N left them | Shared stores. N's schema additions are additive and must be tolerated by N−1's readers; R7-T13 proves it. New bot looks fall back to the old renderer's `blob` shape (03:876-890). |
| Conversation history before the update (`transcripts/<id>.json`) | Intact | N never writes or removes a v1 file, except the dual-remove when the user clears or deletes a conversation, which the old build would also do (D2). |
| Conversations or turns started in N | Not shown in the old UI | They live in `threads/<id>.json` (v2), which N−1 does not read. The model context is intact, because pi's `agent/sessions/desktop/<id>.jsonl` is unchanged and shared. |
| Theme, language, pins, sidebar and other preferences | As they were before the update | `renderer-state.json` is untouched in N. Changes made in N live in `prefs.json`. |

3. **Updating to N again later** is safe:
   - the record already lists steps 1, 2 and 5, so none of them re-run;
   - `prefs.json` is authoritative, and there is no live sync in N;
   - v1 files that N−1 wrote after the downgrade are newer than their v1-derived twins, and `readCurrentFile`'s repair (kept in N) converts them on open.

   A thread N already owned (`agui` twin) keeps its AG-UI history: turns added to it under N−1 are not shown by N, but the model context has them. That is a known limitation (§18 R7).

   N−1's store writers may drop fields N added. N treats every such field as optional with a default (R7-T13, re-upgrade leg).

### 12.4 Rollback after N+1

N+1 runs steps 3 and 4, which change what N−1 reads. A user who must go back to a legacy build after N+1 restores two sets of files by hand; a support article gives the exact steps (C14). Both sets stay in the backup directories for 30 days (§9.4).

1. Quit the app.
2. **Transcripts.** Move `~/.abacusai-bot/backups/migrations/<stamp>_<attempt>-4-archive-transcripts-v1/home/transcripts/*.json` back to `~/.abacusai-bot/transcripts/`. The layout comes from `backupPathFor`, `backup.ts:78-92`: `home/<relative path>`.
3. **Preferences.** Copy `…-3-final-legacy-prefs-import-and-drop/userData/renderer-state.json` back to `~/.abacusai-bot/electron/renderer-state.json`.
4. Install N−1.

R7-T15 runs this procedure against a home N+1 has migrated and proves that N−1 then shows the history.

N stays the safe floor: going from N+1 back to N needs no restore. N reads `threads/` and `prefs.json`, and it switches the rule and the repair off once step 4 is recorded (C11, forward compatibility).

## 13. Upgrade tests: real layouts, synthetic data

### 13.1 Why the committed fixture is not enough

`__fixtures__/legacy-home/` is hand-made "as a shipped build leaves it" (`legacy-home.test.ts:1-9`). The cut-over needs the layout **the last shipped build actually writes**: file names, electron-store shapes, zustand `persist` envelopes in `renderer-state.json`, `window-state.json`, `profiles.json`. It must be produced without anyone's data.

### 13.2 The generator (`scripts/cutover/make-legacy-home.mjs`, C5)

1. **Inputs.** The packaged app of the source release (§2 item 4), either downloaded from `downloads.abacus.ai/abacusai-bot/releases/<v>/` or taken from CI's unsigned `package:dir` of that tag. Plus a script of synthetic operations.
2. **Launch.** The app starts with `ABACUSAI_BOT_BASE`/`ABACUSAI_BOT_HOME` pointing at a fresh temp directory, `--remote-debugging-port`, and no network. The proxy env points at a closed port, so no sign-in, no model and no connector can be reached.
3. **Synthetic content,** created through the old build's own `window.api` over CDP `Runtime.evaluate`, so every file is written by the real code:
   - 12 bots from templates with custom looks (3 pinned);
   - 3 workspaces, which are temp git repos with 2 worktrees;
   - 40 sessions (5 pinned, 3 with a missing workspace);
   - 2,000 transcripts through `agent.writeTranscript` with generated segments (text, tool calls, a diff, a 30 MB one). After the app quits, the generator adds an unparseable file and one with a `version` the steps do not know. These two are the only files the app does not write itself, because `writeTranscript` always writes version 1 (`transcript-service.ts:67-79`);
   - 6 routines with 120 runs;
   - 20 memories;
   - a messaging auto-reply grant;
   - `durableState.set` for every key in `LEGACY_PREFS_KEYS` (theme, language, pins, sidebar, onboarding step `models`, the credits notice);
   - a `window-state.json` at 1280×800.
4. **Second profile.** A second profile directory built from the `profiles.json` format (`profile-home.ts:12-19`), because a profile switch needs a real sign-in.
5. **Output.**
   - `apps/desktop/src/main/migrations/__fixtures__/legacy-home-v<version>.tar.zst`, plus `manifest.json` listing every file with its sha256 and producer;
   - `electron/` Chromium state is excluded, apart from the two JSON files the app owns;
   - the 30 MB transcript is regenerated at test time from a seed, so the archive stays small.
6. **Re-run.** The generator is re-run for every release candidate against the then-latest shipped release. The committed fixture is replaced in the RC PR.

### 13.3 What the upgrade and downgrade runs assert (R7-T10…R7-T15)

- **Upgrade to N.**
  - The packaged RC starts on a copy of the fixture home and prints every smoke marker.
  - `migrations.json` records steps 1, 2 and 5 with the expected stats: every good transcript converted; the unparseable one counted as `corrupt` and the unknown-version one as `notV1`; the 30 MB one converted or `tooLarge`, never `corrupt`.
  - Over CDP, the UI shows 12 bots (3 pinned, in order), 40 sessions grouped by workspace with the pins, 6 routines, and the migrated history of 5 sampled sessions matching `v1-to-ui-messages` output.
  - The prefs match the legacy keys (theme, language, onboarding resumes at `models`).
  - Every legacy file's sha256 is unchanged.
- **Downgrade.**
  - After N has run and created 2 bots and 3 conversations, N−1 starts on the same home, prints its smoke marker, and its `window.api` lists every bot and session.
  - Pre-update history is intact.
  - No store parse error appears in its log.
- **Re-upgrade.** N starts again: no step re-runs, and the conversations N created are intact.
- **N+1.** Steps 3 and 4 run; the §9.3 cases hold; the kill-point suite passes for 3 and 4; the §12.4 restore brings N−1's view back.

## 14. Performance budgets

### 14.1 Method (`scripts/cutover/perf-compare.mjs`, C5)

- **Builds.** Both builds are packaged with the same flags:
  - **old** = the last shipped legacy build;
  - **new** = the RC.

  Each run uses a fresh copy of the §13 fixture home, already migrated for the new build, so migration is not timed here (R7-T32 times it). The window is 1280×800 through the fixture's `window-state.json`, because the dev content-size override is ignored when packaged.
- **Runs.** 7 per build, alternating old and new, on a warm OS cache and a cold process. Report median and p90; the first pair is discarded.
- **Machines.**
  - Reference: macOS arm64 (the M-series class R2-T31 uses) and Windows 11 x64.
  - Linux x64 under Xvfb is reported, not gated.
- **Probes,** identical for both builds. A script injected with CDP `Page.addScriptToEvaluateOnNewDocument` records `performance.timeOrigin + performance.now()` when the probe condition is first met. Node records the spawn time.

| Metric | Definition | Budget (gate at C5, re-checked on the signed RC at C14) |
|---|---|---|
| M1 Cold start to interactive | Spawn → the first fixture bot's name is in the sidebar and the composer can take focus | New median ≤ old median × 1.10 |
| M2 First paint | Spawn → `first-contentful-paint` of the main window's document; no frame whose background differs from the resolved theme (the 01:829 screencast check) | New median ≤ old median × 1.10; zero wrong-theme frames |
| M3 Idle memory | 60 s after M1, the summed RSS of the app's process tree without agent children (`ps` by process group on macOS and Linux, `Win32_Process` parentage on Windows), broken down per process | Main window's tree ≤ old × 1.10. The notch/capsule renderer is reported separately, ≤ 150 MB RSS (to be confirmed by R6-T27's measurement). |
| M4 Renderer JS heap | CDP `HeapProfiler.collectGarbage`, then `Runtime.getHeapUsage` on the main window, at the M3 point | ≤ old × 1.10 |
| M5 Open a long thread | Click the fixture's 1,000-message session → its last message is visible | ≤ old × 1.10 and < 600 ms (R2-T31 (a)) |
| M6 Initial bundle | JS + CSS loaded before first paint by `index.html` (size-limit, gzip) | ≤ old's initial JS + CSS. The C12 size-limit is then set to the RC value + 5 %. |

### 14.2 Phase budgets that must still hold on the RC

- R2-T31 (a)–(e): transcript first paint, replay readiness, 3,000 tools, streaming p95, expansions.
- R5-T31: 2,000 artifacts, first paint < 400 ms, ≥ 50 fps.
- 04's terminal and device caps: a 2 MB tail, a 40 ms resize debounce, and the device decode-queue drop.

The new budgets do not replace them.

### 14.3 Migration on first launch (R7-T32)

- **Workload.** Steps 1, 2 and 5 on the fixture: 2,000 transcripts, 200 MB total, one of them 30 MB.
- **Budget.** ≤ 60 s wall time on the macOS reference, with the progress window visible after 400 ms.
- **Checks.** The main window appears after the runner finishes. The step writes happen off the progress window's frames, through the runner's yield every 20 moves and `YIELD_EVERY` in `transcript-files.ts`, so the window never shows "not responding".
- **Report.** The time for 50 MB, 200 MB and 1 GB homes, to decide whether the runner needs to become incremental before N ships. It is a risk, not a gate (§18 R4).

### 14.4 Bundle budgets (C12)

- `.size-limit.json` holds, gzip, the values measured on the RC + 5 %:
  - `index.html` initial JS and CSS;
  - `notch.html` initial JS and CSS;
  - the largest lazy route chunk;
  - `temml`'s chunk, which must stay lazy (02:747).
- CI fails a PR that exceeds them. Raising a limit needs a reason in the PR.

## 15. Tests

"Electron" means the Node-spawns-Electron harness (`renderer-next.electron.test.ts` style, isolated profile and CDP). "Packaged" means it runs against `release/*-unpacked` or the installed signed build, never dev. Every Electron and packaged test fails instead of skipping under `CI` or `ABACUSBOT_REQUIRE_ELECTRON_SUITES=1`, as R1-T11b already does.

| Id | File | Kind | Proves |
|---|---|---|---|
| R7-T1 | `src/main/renderer-generation.test.ts` (C5) → `renderer-entry.test.ts` (C6, C9) | main | At C5: the default is `wco`, a packaged build ignores the env var, and `legacy` is honoured only unpackaged. From C6: one entry, `index.html`, for the dev, experience and file bases, with `NOTCH_ENTRY` beside it. At C9: the generation module is gone. |
| R7-T2 | `services/updates/experience/foundation-api.test.ts`, `integrity.test.ts` | main | The desktop and updater `FOUNDATION_API` and protocol are equal. A tree built at API 1 is refused by a 2 shell, and vice versa. A tree without `renderer/notch.html` is refused at 2. `index.ts`'s barrier choice is `subscriptions`. |
| R7-T3 | `src/main/dev/experience-swap.electron.test.ts` | Electron | Two renderer builds served as installed experiences at API 2:<br>- the swap waits for `window.ready`;<br>- `window.activity` defers it by 15 s;<br>- continuity restores focus, the caret, the composer text and the transcript scroll;<br>- a candidate reporting `failed` is discarded, and the old view keeps its port;<br>- 3 failures stop swaps until relaunch;<br>- on an N−1 shell the N target is refused (metadata fetch and hash counted). |
| R7-T4 | `apps/updater/src/classify.test.ts` | unit | C5: `src/renderer-next/**`, `index-next.html` and `notch.html` are `experience`. C7: `src/renderer/**`, `index.html` and `notch.html` are `experience`, and `src/shared/**`, `src/preload/**`, `package.json` and `pnpm-lock.yaml` are `foundation`. |
| R7-T5 | `cli-manager-wire.test.ts`, `relay-service.test.ts` | main | Every spawn's argv has `--wire agui --thread-id <sessionId> --compat-fd 3` and 4 stdio pipes. No code path yields `ndjson` (C5 by generation; C10 by construction). The env flag is ignored when packaged (C2). |
| R7-T6 | `packages/agent/src/agui/agui-golden.integration.test.ts`, `agui-spawn.e2e.test.ts` | agent, 3 OSes | All 24 scenarios: compat bytes equal the `.ndjson` baselines. Spawned `plain-text`, `permission-accept` and `tool-bash` in fd and inline modes match (§8.2 masks). The report lists derived baselines separately. |
| R7-T7 | `src/main/services/agui/taps.e2e.test.ts` | main (spawned agent, fake provider) | Every tap in §8.3 fires with every spawn agui: artifacts recorded, a `<reply>` relayed, a routine settled, the turn waiter resolved, browser auto-allow answered on the emitting runtime, a host service answered, the inactivity watchdog writes one relay terminal. |
| R7-T8 | `health-check.test.ts` | main | Agui mode:<br>- resolves on `CUSTOM session.ready`;<br>- refuses a candidate that exits, prints `RUN_ERROR`, or only prints NDJSON `ready`;<br>- the argv equals main's spawn minus `--compat-fd`.<br>NDJSON mode still passes before C10. |
| R7-T9 | `packages/agent/src/main.test.ts` + the CI step | agent | Absent `--wire` means agui; `--wire ndjson` exits 64 with `wire_unsupported`; `--thread-id` is required; the sandbox probe is unaffected. |
| R7-T10 | `src/main/migrations/upgrade.packaged.test.ts` | packaged, 3 OSes | §13.3 "Upgrade to N" from the pre-rewrite source layout. |
| R7-T11 | same | packaged | The same from the dormant-release layout (threads, prefs and record present): no step re-runs; prefs drift since the live sync is correct. |
| R7-T12 | same | packaged | Two profiles: each migrates on its first activation, and the inactive one is untouched until then. |
| R7-T13 | `downgrade.packaged.test.ts` | packaged, macOS + Windows + Linux | §13.3 "Downgrade" and "Re-upgrade": N−1 opens a home N ran on; N tolerates records N−1 rewrote (fields dropped). |
| R7-T14 | `steps/003-final-legacy-prefs.test.ts`, `004-archive-transcripts-v1.test.ts`, `runner.crash.test.ts`, `thread-store.cutover.test.ts` | main | Step 3: import, drop, backups, invalid keys counted. Step 4: orphan twins archived; `tooLarge`/`unreadable` never quarantined; tombstones honoured; "Keep" for an older-migrated `agui` twin; at most two launches. Hydrate after archive serves the thread. Cleared stays cleared. Kill points across 3 and 4. |
| R7-T15 | `rollback.packaged.test.ts` | packaged | The §12.4 restore on a home N+1 migrated; N−1 then shows the history and the preferences. N started on an N+1-migrated home, with no restore, shows every migrated conversation. |
| R7-T16 | `ci.yml` "The packaged app actually starts" (extended) | packaged, 3 OSes | `[smoke] main process ready`, `[smoke] renderer ready` (readiness `ready` against real tables on an empty home), and on darwin and win32 `[smoke] notch ready`. No fatal pattern. On Linux there is no notch window. Global shortcut unregistered at quit. |
| R7-T17 | Private pipeline checklist (signed RC) | manual + scripted, hardware | macOS: `spctl -a -vv` accepts the notarized app; launch; notch on a notched MacBook (R6-T31), external display (R6-T32); haptics; no TCC or Automation prompt from the JXA probe; mic prompt text once. Windows 11: signed installer installs over N−1; capsule at 100/125/150/200 % scaling with the taskbar on each edge (R6-T33); uninstall. Linux: AppImage and `.deb` start. |
| R7-T18 | `scripts/check-packaged-resources.js` (extended) + `packaged-asar.test.ts` | packaged | The asar holds `dist/renderer/{index,notch}.html` and no `index-next.html` (after C6). The three CSP `<meta>` strings equal `RENDERER_CSP`. No `__abacusDev`, fixture DB, devtools, `monaco`, `katex` or `sonner` asset. The experience tree built from the same dist passes `verifyExperience`. |
| R7-T19 | `src/preload/preload-exposure.test.ts` | preload | For the main and notch windows: exposed globals = `{ abacusHost }`; the port handshake is installed before any page script; no `sendSync`. |
| R7-T20 | `src/main/ipc-surface.test.ts` | main (static) | `ipcMain.handle`/`ipcMain.on` appear only in the allow-listed files (the transport). No `webContents.send` outside `rpc/`. `IpcChannels` does not exist. |
| R7-T21 | `src/main/dev/cutover-greps.test.ts` | repo | Runs every grep of §5 (old tree, `window.api`, IPC names, window-chrome with F17's pattern, `renderer-next`/`#next`, `RENDERER_GENERATION`, `NdjsonHost`/`wireFor`/`resolveWire`, nuked dependencies) and expects nothing. |
| R7-T22 | `pnpm check:knip` | repo | Files, exports, types, duplicates, dependencies and unlisted are clean for `apps/desktop`. |
| R7-T23 | `size-limit` | build | §14.4. |
| R7-T24 | `scripts/cutover/perf-compare.mjs` | packaged, reference machines | §14.1 M1–M6 against the last shipped build; numbers in the C5 and C14 PRs. |
| R7-T25 | `src/renderer/features/parity.test.ts` (aggregate) | renderer | Every area's `parity.ts` has unique ids and no `todo`; every `deferred` row names an owner and a PLAN anchor; every `visible` retired or deferred row appears in the generated release-note list; `PARITY.md` has a consumer or a retirement reason on every row. |
| R7-T26 | `check:i18n`, `check:locales`, `src/shared/contract/languages.test.ts` | repo | After C13: every `en-US` leaf is used under `src/renderer`; all 11 locales have the same key set; no keymap or retired-list file remains. |
| R7-T27 | `src/main/keep-awake.test.ts` | main | The power blocker is held from `RUN_STARTED` to `RUN_FINISHED`/`RUN_ERROR`, released on runtime exit and crash, with no renderer call; the user's keep-awake setting is honoured. |
| R7-T28 | `src/main/window-chrome-probe.lifecycle.test.ts` | main | (A) No timer is armed while hidden; the probe runs once on `show`. (B) `window:recreate` is not registered in legacy (C2) and not at all (C8). |
| R7-T29 | `src/main/window-chrome.electron.test.ts` (the 7 todos) | Electron, 3 OSes | 00-window-chrome §10's integration cases, run on the packaged RC once in C14. |
| R7-T30 | The phase Electron suites | Electron against the packaged RC | R1-T11b, R1-T22, R2-T16, R2-T32, R3-T31, R4-T29, R4-T30, R4-T34, R5-T36, R6-T30, R6-T36: green on the RC, not only in dev. |
| R7-T31 | `scripts/check-release-build.test.mjs` | build | A `VITE_UI_GALLERY=1` or `VITE_NEXT_DB_FIXTURES=1` dist is refused by `package` and `experience`. A release dist passes. The harness is absent from `dist/main`. Each unpackaged-only env override is ignored in a packaged launch. |
| R7-T32 | `src/main/migrations/first-launch.perf.test.ts` | packaged, macOS reference | §14.3. |
| R7-T33 | `src/main/services/updates/update-e2e.packaged.test.ts` | packaged, Windows + Linux CI; macOS in the private pipeline (Squirrel needs a signature) | N−1 updates to N through a local generic feed with `stagingPercentage`. The relaunch runs the migration. The capsule does not hold the installer's lock. The feed at 0 % offers nothing. |

## 16. Amendments this spec requires elsewhere

1. **PLAN.md phase 7:**
   - "NDJSON host" → "the NDJSON-only host path; the compat stream stays (taps)";
   - "migration runs on real data from a backup" → "migration runs on real layouts with synthetic data (§13), plus optional local dogfood runs";
   - "release build smoke on macOS and Windows" → "macOS, Windows and Linux, plus the signed RC in the private pipeline";
   - add "two releases (N, N+1)".

   PLAN "Libraries" row `node-mac-notch` → "does not exist; JXA probe" (also 06:1113).
2. **Spec 00 C.5.** Steps 3 and 4 are registered in N+1, not in "the cut-over build" (D2). C.1's "manual procedure documented in `PARITY.md`" → this spec §12.3–12.4.
3. **Spec 00-agent-agui §6.4.** "The `--wire` flag goes" → the flag stays, accepting `agui` and refusing `ndjson` (D4). The spawned-process check compares against baselines after C10 (§8.2).
4. **Spec 00-window-chrome §7.** The completion grep drops the bare `isFullScreen` (F17).
5. **Spec 01 §13 risk "Old boot services not yet ported".** Resolved by C3.
6. **Spec 06.** R6-T33 is extended by R7-T17's scaling matrix. `integrity.ts` requires `notch.html` from API 2 (D3).

## 17. Acceptance

**Release N (after C14):**

- [ ] §2 entry criteria met; every §3 row closed or carried to N+1 by name.
- [ ] Legacy behaviour was unchanged through C4. C5 is the only behaviour change (D1), and its PR carries the full release-candidate evidence.
- [ ] `DEFAULT_RENDERER_GENERATION` is gone, and the app has one renderer at `src/renderer` loaded from `index.html`, plus `notch.html`.
- [ ] `FOUNDATION_API = 2` in both places; an API-1 experience is refused; swaps use the `subscriptions` barrier; the activity beacon and continuity work (R7-T2, R7-T3).
- [ ] Every agent spawn is agui. Compat is byte-identical on the 24 goldens and on 3 spawned scenarios × 3 OSes. Every tap fires (R7-T5 … R7-T9).
- [ ] The §5 greps are empty (R7-T21). knip is clean with dependencies (R7-T22). size-limit is set (R7-T23).
- [ ] Preload exposes `{ abacusHost }` only; the IPC surface is the transport (R7-T19, R7-T20).
- [ ] The window-chrome acceptance (00-window-chrome §12) passes on the packaged RC, including items (A) and (B) (R7-T28, R7-T29).
- [ ] Parity sign-off (§11): every row green, retired or deferred with an owner; each "Parity" row demonstrated on the packaged RC (R7-T25, R7-T30).
- [ ] Upgrade from both source layouts, multi-profile, downgrade and re-upgrade all pass (R7-T10 … R7-T13). First-launch migration is within budget (R7-T32).
- [ ] Performance: M1–M6 within budget on both reference machines; the phase budgets hold (R7-T24, §14.2).
- [ ] Packaged smoke on 3 OSes with renderer and notch markers (R7-T16). Asar contents are right (R7-T18). No gallery, fixture or harness in the release (R7-T31). The update path N−1 → N works (R7-T33).
- [ ] The signed RC checklist is done on macOS, Windows and Linux hardware (R7-T17). Notch constants are updated from R6-T31.
- [ ] `CHANGELOG.md` notes, the support article, and the PLAN, PROGRESS and spec 00 amendments (§16) are merged.
- [ ] `pnpm check` is green, and CI now includes knip, registry and size-limit.

**Release N+1 (after C15):**

- [ ] N at 100 % for ≥ 14 days, with no trigger hit.
- [ ] Steps 3 and 4 registered. The repair, the rule and the dual-remove deleted in the same commit. R7-T14 and R7-T15 green. R7-T10/T11 re-run with N+1.

## 18. Risks

| # | Risk | Mitigation |
|---|---|---|
| R1 | A tap depends on NDJSON ordering relative to something agui changes. Stop and reset now hold admission, a documented divergence. | §8.2 item 4; R7-T7 drives every tap through spawned agents; the goldens cover stop and reset scenarios. |
| R2 | The frozen `.ndjson` oracles cannot grow after C10. New compat scenarios lose independence. | §8.2 item 5: derived baselines are labelled and reviewed. The later taps-to-AG-UI slice removes the need. |
| R3 | The downgrade path breaks because N−1's store readers choke on a field phases 3–5 added (05 attempt ids, 04 checkout fields, 03 looks). | R7-T13 on every RC. Any non-additive schema change needs its own migration step, and the field stays optional. |
| R4 | First-launch migration on a very large home (many GB of transcripts) takes minutes. The runner blocks the main window while it runs. | R7-T32 reports the 50 MB, 200 MB and 1 GB points. If 1 GB exceeds 3 min, step 1 becomes incremental: convert on hydrate, and let the runner do only the index. That decision is made before C14. |
| R5 | The shared experience target (`latest.zip`) makes N−1 clients refuse N experiences at every check for the whole rollout. | §6.4. The cost is measured in R7-T3. Staged rollout keeps the window short. |
| R6 | The JXA probe or haptics trigger a TCC prompt on a notarized build. | R7-T17 on the signed RC; fallback to aspect-ratio inference (06:595) without the probe, and haptics off by default if needed. |
| R7 | Turns added under N−1 to a thread N already owned are not shown after re-upgrading. The model context has them. | Documented (§12.3). A later relay change can append v1-newer segments to an `agui` thread on hydrate if support sees it. |
| R8 | Orphans or tombstones are mishandled when the rule goes in N+1, and cleared history comes back. | C1 lands the step-4 orphan handling and tombstones in N, tested; C15 removes the rule in the same commit that registers step 4 (§9.3). |
| R9 | A gallery or fixture dist reaches a release because the screenshot and acceptance runs share `dist/renderer`. | C4's guard in `beforePack` and `build-experience.js` (R7-T31). |
| R10 | The relay review findings (no fix log at this HEAD) are unfixed when every thread becomes agui: an early `RUN_ERROR` corrupts the next message, the synthesized terminal leaves parts open, a stale exit rejects waiters. | §2 item 2 makes them entry criteria; C2 repeats the three that matter most. |
| R11 | A user on a slow link is mid-download of the N−1 experience when N arrives. | Experiences are version-pinned; the N−1 bundle is refused on N and the N target replaces it. Nothing to do. |
| R12 | Removing `'unsafe-eval'` breaks transformers.js (dictation) in some path. | C12 narrows it only if R7-T16/T30 pass with `'wasm-unsafe-eval'`, including a dictation run; otherwise it is kept. |
| R13 | A `framer-motion` removal attempt also drops `motion`'s own copy. | F14: only the direct dependency is removed; `pnpm-workspace.yaml:69` stays; knip keeps `motion`. |
| R14 | Windows `--compat-fd 3` behaves differently on some machines (AV hooks on pipes). | Inline mode exists (agent spec :373-377); R7-T6 runs both modes on Windows; `compat_lost` is a rollout trigger. |

## 19. Open questions for the coordinator

1. D2 splits the migration across N and N+1, against spec 00 C.5's "the cut-over build". Accept, or ship steps 3–4 in N and rely on the §12.4 restore for downgrades?
2. §2 item 4: will `rewrite/renderer` ship in a dormant release before the flip? That makes steps 1–2 field-proven and gives §13 its second source layout.
3. §14 budgets are relative to the last shipped build because the repo records no absolute cold-start or memory numbers. Should absolute caps be set after the first C5 measurement?
4. The 150 MB notch renderer RSS cap is a proposal pending R6-T27's measurement.
5. The rollout stages and the N+1 soak (≥ 14 days at 100 %) are proposals for the release manager.
