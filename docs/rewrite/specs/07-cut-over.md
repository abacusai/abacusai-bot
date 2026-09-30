# 07 — Cut-over (phase 7)

Status: spec **r2** (no code). r1 was reviewed by Codex round 1 (`reviews/07-cut-over.codex-r1.md`, 25 items, 3 blockers) against `HEAD c46e77d9`; r2 answers it with the coordinator's decisions, and the responses are at the end. Branch `rewrite/renderer`, `HEAD 5a3a4242`, whose code is `c46e77d9`. It implements the "Cut-over" phase of `docs/rewrite/PLAN.md` (§Phases and PR stack, phase 7: "Delete the old renderer, conversation layer, NDJSON host, `window.api`, zustand stores, unused patches; knip clean; size-limit set; PARITY.md all green; migration runs on real data from a backup. Gate: `pnpm check` green; release build smoke on macOS and Windows"). This is where the new renderer becomes the shipped one and the old tree is deleted. It builds on:

- `00-transport-db-migration.md` **r2** and its implementation notes, plus the 1 Oct C.3 amendment (the step-1 id grammar). Relevant parts: A (contract, both paths mounted, `emitIpcEvent`), B (tables, per-leaf provenance), C (runner, journal v2, steps 1–2, the reserved C.5 steps 3–4, the live legacy sync, downgrade safety).
- The migration fix logs:
  - `reviews/00-transport-C.impl-fixes-r1.md` (runner);
  - `reviews/00-transport-C1.impl-fixes-r1.md` (step 1, thread store and step 4; commits `c78b0285`, `cf83b4cd`, merged `41e0dd92`). That log brought source fingerprints, `threads/<id>.cleared` markers with tokens, the 64 MB `MAX_TRANSCRIPT_BYTES` cap, `tooLarge`/`unreadable`/`foreign` statuses, the write-block overlay, the deferred dual-write, step 4's orphan and cleared-history archiving, and `ThreadStore`'s `v1Archived` option.
- `00-window-chrome.md` **r2**, with the two low items due before the wco switch, §7 (deletion list) and §12 (acceptance).
- `00-agent-agui.md` **r3**, with the impl r1 amendments and the main-relay notes, plus `reviews/00-main-relay.impl-fixes-r1.md` (r1 fixes `5d5dc433`, r2 fixes `c07479f7`). Among them:
  - `defaultWire`: agui for every spawn in the wco build;
  - the env override honoured only unpackaged;
  - error anchors and closure of open parts at every terminal;
  - `session.cleared`;
  - the stdout final-line drain.
- `01-renderer-foundation.md` **r4** with `reviews/01-renderer-foundation.impl-fixes-r1.md` (r1 fixes `8acc0ebb`, r2 fixes `e14f845d`, which added the Linux `screenshots-next` CI job). Also `02-chat-kit.md` **r4**, `03-bots.md` **r3**, `04-sessions.md` **r3**, `05-routines-artifacts-library-settings.md` **r3**, cited by section, and `06-onboarding-tour-notch.md` **r4** (final: one-shot haptics, no notch inference).
- Every review and fix log under `specs/reviews/`. §3 lists every item in them that is "deferred to cut-over" or held "until cut-over", with its source and its state at `c46e77d9`.

Paths are relative to `apps/desktop/` unless noted. Line numbers are at `c46e77d9`.

**Sources read for this spec (30 Sep 2026; rebased 1 Oct 2026)**

| Source | Where |
|---|---|
| Generation and entry | `src/main/renderer-generation.ts:7-27`, `src/main/renderer-entry.ts:11-73`, `src/main/index.ts:115,396-425,453-465,580-633,780-800,850-915,1580-1595,1700-1760,1795-2090,2131` |
| Renderer host and readiness | `src/main/renderer-host.ts` (all 484 lines), `src/main/rpc/readiness.ts`, `src/renderer-next/features/shell/readiness.tsx` |
| Experience / updater | `src/shared/experience.ts:1-11`, `src/main/services/updates/experience/{integrity,experience-updater,health-check}.ts`, `integrity.test.ts`, `apps/updater/src/{manifest,experience,classify}.ts`, `apps/updater/README.md`, `scripts/build-experience.js`, `src/main/services/updates/update-service.ts` |
| Preload | `src/preload/index.ts` (300 lines: `window.api`, `abacusHost`, `durableState` `sendSync`), `rpc-port.ts`, `bridge.ts` (1090 lines), `preload-exposure.test.ts`, `parity.test.ts` |
| Legacy IPC | `src/shared/channels.ts` (`IpcChannels`, 197 lines), `src/main/handler.ts:155-490` (`createHostOperations`, `registerIpcHandlers`), `src/main/rpc/emit.ts:14-38`, the 232 `ipcMain.handle|on` call sites in `src/main` (tests excluded) |
| Migration | `src/main/migrations/{runner,journal,record,backup,startup,write-block}.ts`, `steps/{index,001,002,004,transcript-files}.ts`, `__fixtures__/legacy-home/`, `legacy-home.test.ts`; `src/main/services/session/{thread-store,transcript-service}.ts` (`MAX_TRANSCRIPT_BYTES` :60, the `.cleared` marker :150, `v1Archived` :168,280), `src/shared/transcript/thread-file.ts:45-80` (`ClearMarker`); `src/main/services/config/{renderer-state,legacy-prefs,prefs-store}.ts` |
| Wire | `packages/agent/src/main.ts:73-142`, `host.ts`, `agui/{sink,channel,queue,record}.ts`, `agui/__fixtures__/` (48 files), `src/main/services/session/cli-manager-service.ts:47-55,129,596-626,727-755,985-1180`, `src/main/services/agui/relay-service.ts:1-15,108-141,271`, `service-host.ts:455-470,1252-1361,1520-1522` |
| Build and CI | `vite.config.ts`, `vite.shared.ts`, `vitest.config.ts`, `tsconfig*.json`, `knip.json`, `oxlint.config.ts`, `pnpm-workspace.yaml`, `patches/`, `package.json` (root and desktop), `electron-builder.yml`, `build/entitlements.mac.plist`, `build/licenses/`, `scripts/{check-legacy-renderer-diff.mjs,legacy-renderer-allow.json,check-packaged-resources.js,generate-notices.js,sync-locales.js,check-jsx-i18n.js,screenshots-next.mjs,locale-keymap.json}`, `.github/workflows/{ci,codeql,dependency-review}.yml` (`ci.yml` at `c46e77d9`: `check` :65-96, the NDJSON step :200, `screenshots-next` :223-254, `package` :256-368, smoke :306-368) |
| Dev-only code | `src/main/dev/{mutation-harness,renderer-next.electron.test,screenshots-gate.test,legacy-diff.test}.ts`, `src/renderer-next/{main.tsx,lib/dev/dev-hooks.ts,lib/devtools.tsx,features/gallery/search.ts,data/fixture-db/}` |
| Parity | `docs/rewrite/PARITY.md` (587 lines, generated from `src/shared/contract/legacy-map.ts` by `preload/parity.test.ts`) and the parity tables of specs 03–06 |
| Releases | tags up to `v1.0.85` (an ancestor of this branch), `CHANGELOG.md`, `scripts/sync-changelog.js` |

## 0. Findings that change the brief (read first)

Rebased to `c46e77d9`. Rows marked *(r2)* are new or changed since r1.

| # | Brief / earlier specs say | The repo says | Consequence here |
|---|---|---|---|
| F1 *(r2)* | "every spawn becomes agui in the wco generation" | **Implemented.** `defaultWire({ generation, isPackaged, env })` (`relay-service.ts:120-141`) is true for `generation === "wco"`. `ABACUSAI_BOT_AGENT_WIRE=agui` counts only in an unpackaged app, and a packaged legacy app logs that it ignores it. `ServiceHost` passes it (`service-host.ts:463-468`); see relay fix log, Claude 3 and 9. The selection plumbing remains: `wireFor` (`relay-service.ts:271`), `resolveWire` with `?? "ndjson"` (`cli-manager-service.ts:129,601`), and `service-host.ts:1252`. | C5 needs no wire change: the generation flip carries it. C10 deletes the plumbing. |
| F2 | PLAN phase 7: "Delete … NDJSON host" | Spec 00-agent-agui §6.4 (:999-1001) and the PLAN amendment (:366) keep the **compat stream** (legacy NDJSON on fd 3), because main's taps read it. Only the NDJSON-only **host path** and the `--wire` default go. | §5.4: `protocol.ts` `DesktopEvent`, `agui/sink.ts`, `agui/channel.ts`, `handleCompatFd`/`handleNdjsonLine` and `shared/agent-types.ts` stay. |
| F3 *(r2)* | The FOUNDATION_API bump gates published experiences | The manifest is bound to the **exact foundation version** (`integrity.ts:51-55`) *and* to `FOUNDATION_API` (`:57`). There is one TUF target for every foundation (`experience-updater.ts:23`). The bump chooses the swap barrier (`index.ts:425`). `buildManifest` stamps the **builder's** API and the supplied version onto any tree it is given (`apps/updater/src/manifest.ts:73-108`), so neither number says when or from what the tree was built (review #14). | §6: the bump selects the barrier. Build-time provenance inside the artifacts (C4) is what catches a stale tree. |
| F4 | Experiences keep working after the flip | renderer-next ports none of the old boot services (`renderer/main.tsx:8-21`). It never calls `window.activity` (`shared/contract/window.ts:37`) and has no `__captureUiContinuity`. `RendererHost` waits for readiness **before** it restores continuity (`renderer-host.ts:380-395`, then `:429-432`). | C3 ports both, and the barrier has two stages (D11, review #13). |
| F5 | `experience` release units are renderer and agent source | `apps/updater/src/classify.ts:11-15` lists `apps/desktop/index.html`, `apps/desktop/src/renderer/` and `packages/agent/src/`. It does not list `src/renderer-next/`, `index-next.html` or `notch.html`. | C5 adds them; C7 restores the single prefix. |
| F6 *(r2)* | Keep-awake follows agent runs | `power:set-agent-busy` is still renderer IPC (`keep-awake.ts:43`). `hasActiveAgentTurn()` reads the compat-fed turn state (`service-host.ts:1520-1522`). Re-evaluating it on AG-UI terminals races fd 3 against stdout (review #10). | Prerequisite **P4** (routed to implementation; §2). R7-T27 verifies it. |
| F7 | The health check proves an agent bundle | `health-check.ts:52-80` spawns the candidate with **no flags** and waits for the NDJSON `{"type":"ready"}`. Under agui, stdout line 1 is `CUSTOM wire.hello` and readiness is `CUSTOM session.ready`. | C2 adds an agui mode; C10 makes it the only one. |
| F8 *(r2)* | Step 4 and the rule removal ship "in the cut-over build" (spec 00 C.5) | **Rebased.** Step 4 (`cf83b4cd`) archives v1 files proven by fingerprint, orphaned v1-derived twins, and history held by a clear marker. It keeps `tooLarge` (> 64 MB), `unreadable`, `foreign` and `failed` sources, and never quarantines them. `ThreadStore({ v1Archived })` replaces "no v1 means cleared" with "the twin stands on its own" (`thread-store.ts:276-280`). Four gaps remain: (a) step 4 can commit **partially**, and nothing on disk tells N whether a thread's missing v1 was archived or cleared (review #1); (b) kept sources have no accessible replacement once runtime v1 reads go (#3); (c) each partial commit backs up into its own directory, and `migrations.json` keeps one partial entry per step, replaced each time (`record.ts:55-59`), so there is no index of committed removals (#6); (d) a directory-listing error reads as an empty directory (`transcript-files.ts:45-51`, #2). | D2 (revised): N ships per-thread archive provenance, the removal index and the fallback reader before N+1 removes anything. (d) is prerequisite P1. |
| F9 | `window.api` removal is one deletion | `registerIpcHandlers` (`handler.ts:471-490`) both builds the operations object oRPC uses (`index.ts:1738-1740`) **and** registers the handlers. It also installs `serviceHost.setEventDispatcher(emitIpcEvent)`. | C8 splits it: `createHostOperations` and the dispatcher wiring stay, and the `ipcMain.handle` block goes. |
| F10 | The experience verifier accepts the new renderer | `integrity.ts:196-200` refuses a tree without `renderer/index.html`. | C6 renames `index-next.html` to `index.html` in the same commit that deletes the legacy one. |
| F11 | Tests that read the old tree | `legacy-prefs.test.ts:215-235` reads two old-renderer files as oracles. R3-T9's legacy half runs through old shims (03:1036). `ToolResultData` lives in `renderer/conversation/agent-types.ts:273-322`. The C1 fix log moved the migrated normalisation to `expandToolResultData` (§14 request, item 5). | C6 freezes the oracles and moves any remaining type into `shared/` first. |
| F12 *(r2)* | `pnpm check` gates the cut-over (PLAN) | CI runs `format:check`, `lint`, `typecheck:tools`, `typecheck`, `check:i18n`, `check:locales` and `check:audit` separately (`ci.yml:65-96`). `check:knip-next`, `check:ui-registry` and `check:legacy-diff` are only in the root `check`. A Linux `screenshots-next` job exists (`ci.yml:223-254`). | C4 adds knip and the registry check to CI; C6 removes the legacy diff. |
| F13 *(r2)* | Release smoke on macOS and Windows | CI packages unsigned builds and starts them on all three OSes (`ci.yml:256-368`). It waits for `[smoke] main process ready` (`:344`; `index.ts:219,2132`), which comes before any renderer is ready. Signed builds come from a private repo (`ci.yml:3-9`). | R7-T16 adds renderer and notch markers; R7-T17 is the signed run. |
| F14 | Nuked dependencies need knip | `@tsparticles/{engine,react,slim}` and `uuid` have zero importers. `framer-motion@13.4.6` stays in the lockfile under `motion@13.4.6`, so `pnpm-workspace.yaml:69` stays. The r1 grep pattern missed scoped names and side-effect imports (review #17). | §5.6 uses parsed module specifiers. |
| F15 *(r2)* | node-mac-notch packaging | The package does not exist (06 F1). Spec 06 r4 has no inference: when the one-shot JXA probe fails, an internal display gets **no** companion (06:651-655). Haptics are one-shot `osascript` per attention, deduplicated by key, and default off when R6-T31's median latency exceeds 150 ms (06 §10.7, :724-730). | §10 and §3 follow r4. |
| F16 *(r2)* | Gallery and fixture builds cannot ship | They are gated by `import.meta.env.DEV \|\| VITE_UI_GALLERY === "1"` (`main.tsx:52-53,175`; `features/gallery/search.ts:106`) and `VITE_NEXT_DB_FIXTURES=1` (`main.tsx:115-118`). The screenshot and acceptance runs build into the same `dist/renderer` as a release. | C4 adds a release-build guard. |
| F17 | Window-chrome §7 grep "returns nothing" | The bare `isFullScreen` matches Electron's `BaseWindow.isFullScreen()` in main, so that grep is never empty. | §5.3 corrects the pattern. |
| F18 | Multiple homes | `profile-home.ts` keeps one home per account (`profiles.json`, `profiles/<key>/`). Each is migrated when it is first active, and its `userData` is `<home>/electron` (`index.ts:210-216`). | R7-T12, and restore per profile (§12.4). |
| F19 *(r2)* | A write the migration holds is deferred | `ThreadStore` keeps a held change in a process-local overlay (`thread-store.ts:20-23`), which is gone at quit (review #7). | Prerequisite **P2**. |
| F20 *(r2)* | A failed candidate is discarded | `experience-updater.ts:255` persists activation before the swap is asked for. `SwapNotReady` discards the view but not the pointer, so a relaunch boots the rejected bundle (review #9). | Prerequisite **P3**. |
| F21 *(r2)* | Byte-identical compat means identical tap input | Each stdout and fd-3 chunk is decoded on its own (`cli-manager-service.ts:731,754`), so a UTF-8 character split across chunks is corrupted. fd 3 has no final-line drain, and overflow is handled differently from stdout (review #11). | Prerequisite **P5**. §8.2 states what byte identity covers. |
| F22 *(r2)* | Restore from `…/userData/…` | `backupPathFor` checks `home` first (`backup.ts:83-87`), and `userData` is inside the home, so a step-3 backup is `<backup>/home/electron/renderer-state.json`. Secondary profiles have their own home and backups (review #5). | §12.4 derives restore paths from the recorded roots, per profile. |
| F23 *(r2)* | Freezing `stagingPercentage` halts a rollout | electron-updater admits every client whose persisted staging id falls below the percentage (`AppUpdater.isStagingMatch`), so clients that had not checked yet keep entering. A downloaded build installs on quit (`update-service.ts:233-236`). A shipped client (≥ `v1.0.85`) already drops a downloaded build the feed stops offering on two consecutive checks (`update-service.ts:153-175`, `notOfferedStrikes`), 10 minutes apart (`:46`). | §12.2: halting means percentage 0 or withdrawal. |

## 1. Scope and decisions

**In scope.** The ordered stack that makes renderer-next the shipped renderer and removes what only the old renderer needed: the generation flip, the FOUNDATION_API bump with the updater, the wire flip, deleting the old tree, `window.api`, legacy IPC and transition-only data paths, the dependency purge, the locale purge, notch/capsule packaging checks, the release, its notes, the staged rollout and the rollback plan. Also the release that follows (N+1), which retires the legacy files.

**Out of scope.** Porting main's taps from the compat stream to AG-UI. That is a later, separately specified slice (agent spec :1001), and the compat stream stays here. Also out: the `i18next` 26 / `react-i18next` 17 majors (01 F9, now a single-renderer PR after the cut-over), the features the specs defer to later slices (the `deferred` rows of §11), and a web mode.

**Decisions**

- **D1. One behaviour flip.** Exactly one PR (C5) changes what a packaged user runs: the generation default, and with it every spawn on agui (F1), plus `FOUNDATION_API`. Every earlier PR leaves the legacy build's user-visible behaviour as it is (`check:legacy-diff` and the goldens still hold); C2's refused-target memo and C4's build guards are housekeeping no user sees. Every later PR deletes code the flipped build no longer reaches, and must leave the R7 gate as it was.
- **D2. Two releases, with N carrying what N+1 relies on (r2).** Release **N** ships the flip and the deletions. It never mutates a file an older build reads: `transcripts/`, `renderer-state.json`, and the stores' existing fields. It also ships the machinery N+1 depends on, so N is a safe floor after any N+1 commit, partial ones included:
  - (a) **durable per-thread archive provenance**: `threads/<id>.archived`, written by step 4 in the same journaled commit as the removal and read by N's `ThreadStore` (review #1);
  - (b) an **index of every committed removal** in each home (`backups/migrations/removals.jsonl`, review #6);
  - (c) the **read-only, provenance-aware startup import** of `renderer-state.json` (review #8);
  - (d) HEAD's clear-marker and token protocol, unchanged (review #4).

  Release **N+1**, once N is at 100 % with no trigger hit, registers steps 3–4 and sets `v1Archived`. It keeps a **fallback v1 reader** until every retained source has an accessible replacement (review #3). This amends spec 00 C.5.
- **D3. `FOUNDATION_API = 2`** in `src/shared/experience.ts` and `apps/updater/src/manifest.ts` in one commit, guarded by a test that imports both. From API 2 the verifier also requires `renderer/notch.html` and **build provenance** in the tree: `renderer/build.json` and `agent/build.json`, written by the build, not by the packager (review #14).
- **D4. `--wire` stays as a flag for skew safety.** Main keeps passing `--wire agui --thread-id <id> --compat-fd 3`. After C10 the agent treats an absent `--wire` as `agui` and rejects `--wire ndjson` with a typed error.
- **D5. PARITY.md is frozen as the sign-off record.** At C5 it gains a "renderer consumer" column, validated against the **exact** expected row set with every `file#symbol` resolved (review #25). Its generator is deleted in C8.
- **D6. Locales stay at `src/renderer/locales/`.** After C7 they sit inside the new `src/renderer`, and `#locales/*` keeps resolving.
- **D7. Synthetic data on real layouts, with immutable fixtures (r2).** The upgrade tests use homes **produced by real shipped builds** from synthetic inputs (§13).
  - There is one immutable, versioned fixture per source layout: pre-rewrite and dormant, each with its own producer manifest and source-binary hash. A new release **adds** a fixture and never replaces one (review #21).
  - Migration fixtures and the performance fixture are separate (review #20).
  - Team members may run the RC on copies of their own homes, locally; nothing from those runs is collected.
- **D8. Linux is in the packaged smoke.** The notch and capsule are macOS and Windows only.
- **D9. Staged rollout with a real halt (r2).** Stages are set with `stagingPercentage` in `latest*.yml`. To halt, the percentage is set to **0**, or the release is withdrawn by republishing N−1's feed files. Freezing the percentage is not a halt (F23, review #15). From the RC cut, experiences are published for N only (§6.4).
- **D10. Two Vite inputs after C6 (r2).** `main: index.html` and `notch: notch.html` (review #12).
- **D11. Two-stage swap barrier (r2).** Stage 1 is readiness: `window.ready({ barrier: "subscriptions" })`. Stage 2 is restoration: main calls `__restoreUiContinuity`, which resolves once the restored state is committed, bounded by `RESTORE_TIMEOUT_MS`. The flip comes only after both. The candidate never makes readiness wait on restoration (review #13).

## 2. Entry criteria (before C1 opens)

1. **Phases 0–6 are merged with their gates green.** At `c46e77d9`:
   - the relay is done (`5d5dc433`, r2 `c07479f7`);
   - the foundation is done (`8acc0ebb`, r2 `e14f845d`);
   - the step-1, thread-store and step-4 fixes are merged (`41e0dd92`), with Codex r2 running;
   - phase 2 is implementing, and phases 3–6 are final specs;
   - "main requirements from specs 3–6" is implementing (PROGRESS.md).
2. **Prerequisite defects on HEAD** are fixed and merged. The coordinator routed them to implementation agents on 1 Oct 2026. They are not cut-over PR work, but the cut-over gates re-verify them:

   | Id | Defect (review item) | Where on `c46e77d9` | Owner | Verified by |
   |---|---|---|---|---|
   | P1 | A directory-listing error reads as empty, so step 4 can take every twin for an orphan (#2). Only absence may read as empty; an unlistable `transcripts/` or `threads/` stops orphan removal and completion. | `transcript-files.ts:45-51` | Implementation agent (migration) | Injected `EACCES`/`EIO` C-T9 cases; R7-T14 |
   | P2 | Held writes live in a process-local overlay and are lost at quit (#7). History-changing operations on a held thread are either refused or journaled durably outside the held destinations. | `thread-store.ts:20-23` | Implementation agent (thread store) | Send, reset and quit while a commit is unresolved; R7-T14 |
   | P3 | Activation is persisted before the swap; a rejected candidate boots after relaunch (#9). Activation becomes transactional with readiness, or the previous pointer is restored on `SwapNotReady`. | `experience-updater.ts:255`; `renderer-host.ts:392-393` | Implementation agent (updater) | R7-T3, including a full restart after a failed swap |
   | P4 | Keep-awake's busy source races compat against stdout (#10). It follows authoritative turn-state transitions, or an AG-UI busy aggregate. | `keep-awake.ts:43`; `service-host.ts:1520-1522` | Implementation agent (main requirements) | R7-T27, both pipe orderings |
   | P5 | Compat and stdout chunks are decoded one at a time; fd 3 lacks the final-line drain and matching overflow handling (#11). Incremental UTF-8 decoding and a specified overflow and EOF policy on both pipes. | `cli-manager-service.ts:731,754` and `handleCompatFd` | Implementation agent (relay) | R7-T7's fragmented-Unicode, long-line and unterminated-tail cases through the manager |

   Also still open, from the fix logs:
   - the runner's "stop after a deferred step (`break`)", which C1 takes (C1 fix log, "Handed over");
   - `threadStore.flush()` on `before-quit` (same log);
   - any finding of the step-1 Codex r2 review.
3. **Earlier phases' deferred parity rows are green:**
   - P46 (phase 6), the P53 URL row (phase 4), P61 Revoke (phase 5) and ST22 (phase 6);
   - the 06 blocker `sessions.events { run-finished }`;
   - `PARITY.md` regenerated with the `notch.*`, `sessions.events` and `ai.runFinished` procedures.
4. **Dormant release (recommended).** `rewrite/renderer` has merged into `main` in dormant form (legacy default), and at least one release has shipped from it. That release:
   - runs steps 1–2 on real homes;
   - becomes the dormant source layout of §13.

   Shipped builds (≥ `v1.0.85`) already drop a pulled build (F23), so the rollout needs nothing more from them.
5. A release manager owns the rollout (§12) and its triggers.

## 3. Register of items deferred to the cut-over

Every "until cut-over", "at cut-over", "phase 7" and "before the wco switch" item in the specs, reviews and code, with its state at `c46e77d9`. The last column names the PR that handles it (§4). **Done** means it is fixed on HEAD and only re-verified here. **P1–P5** are the routed prerequisites of §2.

| # | Item | Source | Disposition |
|---|---|---|---|
| 1 | `--wire ndjson\|agui`, default `ndjson` until cut-over | 00-agent-agui:43; PLAN:336 | C5 (main passes agui for every spawn); C10 (agent default agui, D4) |
| 2 | The health-check probe keeps spawning `--wire ndjson` until cut-over | 00-agent-agui:912; `health-check.ts:52-80` | C2 (agui mode added); C10 (agui only) |
| 3 | The NDJSON-only host path and the flag go; the compat stream stays until the taps are ported | 00-agent-agui:999-1001; PLAN:366 | C10 (§8) |
| 4 | "Add at least delegate, bot and rotation `.ndjson` baselines before cut-over" | reviews/00-agent-agui.impl-claude-r1.md:115 | Done (`impl-fixes-r1.md:29`: 10 new scenarios; 24 in `agui/__fixtures__/`). Re-verified by R7-T6 |
| 5 | `wireFor` returns agui for every spawn in the wco generation | reviews/00-main-relay.impl-claude-r1.md #3; 03:1117 | **Done** (`defaultWire`, `relay-service.ts:120-141`; relay fix log Claude 3). C5 flips the generation; C10 deletes the selection plumbing (F1). |
| 6 | `ABACUSAI_BOT_AGENT_WIRE=agui` honoured in packaged legacy builds | main-relay Claude r1 #9 | **Done** (unpackaged only; relay fix log Claude 9). Deleted in C10. |
| 7 | `window.api` and every `ipcMain.handle` stay until the Phase 7 cut-over; `emitIpcEvent` feeds both paths | 00-transport:15, :562, :720, :1242; `rpc/emit.ts:14-18` | C8 |
| 8 | Kind **R** rows: "its legacy handler stays until the cut-over" (19 rows in code, 18 in spec 00; `recreateMainWindow` added by window chrome) | PARITY.md:9; 00-transport:83, :343; `legacy-map.ts:372-374` | C8 |
| 9 | `writeTranscript` dual-write of v2 "until cut-over" | 00-transport:252, :1128, :1131, :1224; PARITY.md:178; `transcript-service.ts`; `thread-store.ts:10-13` (now deferred and coalesced, C1 fix log L5) | C11 (no writer after C8) |
| 10 | The repair in `readCurrent` and "a v1-derived twin without v1 is cleared" go with step 4 | 00-transport:1127, :1249, :1388; C1 fix log L2 (`v1Archived`, `thread-store.ts:276-280`) | N: the rule consults archive provenance (C1, D2 a). N+1: `v1Archived` set with step 4 registered (C15); the fallback reader stays (D2). |
| 11 | The live legacy prefs sync is "transition only … Removed with the old renderer" | 00-transport:1146, :1248; `index.ts:1734-1737`; `legacy-prefs.ts:420-449` | C11 removes the `onSet` listener. The read-only, provenance-aware startup import stays through N (D2 c, review #8). N+1 step 3. |
| 12 | Step 3 `final-legacy-prefs-import-and-drop` at cut-over | 00-transport:955, :1147, :1174 (no code) | C1 (written and tested, not registered); C15 (registered) |
| 13 | C.5 steps are registered only in the cut-over build | 00-transport:1170, C-T9 :1208; `steps/index.ts:1-8`; `004-…ts:1-5` | C15, D2 |
| 14 | Downgrade safety: nothing an older build reads is mutated "until the cut-over build" | 00-transport:1021, :1168, :1308 | Kept through release N (D2) |
| 15 | **High (cut-over):** orphaned v1-derived twins come back once the rule goes | reviews/00-transport-C1.impl-claude-r1.md:21-31 | **Done** (step 4 `orphanTwins`, `cf83b4cd`; C-T9) |
| 16 | A large transcript is read as corrupt, quarantined and pruned | C1 Claude #7 | **Done** (the 64 MB cap; `tooLarge` and `unreadable` kept and never quarantined). An accessible replacement for kept sources: the fallback reader (D2, C15). |
| 17 | The dual-write cost: "or drop it until the cut-over and rely on the repair" | C1 Claude #5 (:55-65) | Moot at C11 |
| 18 | EXDEV window on `renderer-state.json`: "Medium (High once step 3 lands)" | reviews/00-transport-C.impl-claude-r1.md:40-50 | Fixed (`impl-fixes-r1.md:25`); re-proved by R7-T14 kill points for step 3 |
| 19 | `ThreadStore`/`TranscriptService` ignore the migration write-block | Codex C r2 #1 | **Done** (`c78b0285`), but held changes are not durable: **P2** |
| 20 | Stop after a deferred step, or document that no later step depends on step 4 | C1 Claude #15; C1 fix log "Handed over" | Open. C1 (runner `break` after `pending`) |
| 21 | Cleared-history protection excludes AG-UI twins | C1 Codex #3 | **Done** as `threads/<id>.cleared` with tokens and `afterClear` (`thread-file.ts:45-80`). C1 adds step 4's marker-retirement rule (review #4). |
| 22 | Any v1 read error is taken as "cleared" | C1 Claude #14 | **Done** (`readTextChecked`: only `ENOENT`/`ENOTDIR` mean missing) |
| 23 | The manual rollback procedure "documented in `PARITY.md`" | 00-transport:1022, :1332 | §12.4: generated from each home's removal index and recorded roots (D2 b); C14 publishes it |
| 24 | `FOUNDATION_API` bump: "a release decision", needs `apps/updater` in the same release | 00-transport:676, :713, :1264 | C5 (§6) |
| 25 | Swap-retry finding "dormant until FOUNDATION_API>=2" | reviews/00-transport-A.impl-claude-r1.md:10; `impl-fixes-r1.md:40` | Exercised by R7-T3 |
| 26 | `setAgentBusy` moves into main | 00-transport:320, :343; `legacy-map.ts:398-400`; `keep-awake.ts:43` | **P4** (routed), verified by R7-T27 |
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
| 52 | Notch probe records and the haptics default (r1 said "inference constants", which spec 06 r4 removed) | 06:651-655, §10.7 | C14: R6-T31's recorded probe JSON is in `metrics.fixtures.json`, and the haptics default follows the 150 ms rule |
| 53 | `PARITY.md` rows must name their renderer-next consumer | 06:1089; 03:1090 | C5 (sign-off column, D5) |
| 54 | Stale comment: "main's db.* answers UNAVAILABLE" | `renderer-next/env.d.ts:30-33` | C7 |
| 55 | `i18next`/`react-i18next` majors "in a separate PR that tests both renderers" | 01:23 (F9) | After the cut-over (one renderer) |
| 56 | Directory-listing errors read as empty | review #2; `transcript-files.ts:45-51` | **P1** |
| 57 | Held writes lost at quit | review #7; `thread-store.ts:20-23` | **P2** |
| 58 | Non-transactional experience activation | review #9; `experience-updater.ts:255` | **P3** |
| 59 | Keep-awake busy source | review #10 | **P4** |
| 60 | Incremental decoding, overflow and EOF on the compat and stdout pipes | review #11 | **P5** |
| 61 | `threadStore.flush()` on `before-quit` | C1 fix log "Handed over" | Before C5 (owner: main requirements agent) |
| 62 | `ai.hydrate` with an unknown `before` cursor | C1 fix log "Handed over" | **Done** (relay decision e: `NOT_FOUND`) |

## 4. The cut-over sequence (stacked PRs)

The stack is 14 PRs for release N plus 1 for release N+1. Each targets the previous one; they land in order on the branch the release is cut from (`main`, §2 item 4). Every PR runs the standing CI (`check`, `test` ×3, `package` ×3) plus its own gate. **Gate** means the PR does not merge until the gate is green and its evidence is linked in the PR. "Legacy unchanged" means `check:legacy-diff` passes, the 24 `.ndjson` goldens are byte-identical, and the old renderer suites pass unchanged.

```
C1 migration completion ┐
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

### C1 — Migration completion for N (main; legacy unchanged)

HEAD already covers the r1 C1 list: the write block, read errors, `tooLarge`, orphans, and clear markers with tokens. What N still needs, so it stays a safe floor for any N+1 commit, is below. P1 and P2 are prerequisites, not part of this PR.

- **Per-thread archive provenance** (D2 a, review #1).
  - For every v1 file step 4 removes, whether archived, orphan-archived or cleared, its plan adds a `create` of `threads/<id>.archived`:

    ```ts
    interface ArchiveRecord {
      version: 1;
      kind: "archived" | "orphan" | "cleared";
      v1Fingerprint?: string;   // the removed v1 bytes, if a v1 file was removed
      twinFingerprint?: string; // the twin's source.fingerprint at the removal
      attempt: string;          // the commit attempt id (journal)
      backup: string;           // backup path, relative to the home
      at: string;
    }
    ```

  - The record is a planned write of the same commit, so the journal's rollback removes it together with the move-back. A partial commit leaves exactly the records of what it removed.
  - `ThreadStore.readCurrentFile`, in N, when v1 is `missing`:
    - an `archived` or `orphan` record whose `twinFingerprint` equals the twin's `source.fingerprint` serves the twin as it is. Pre-fingerprint twins match on the record alone.
    - A `cleared` record, or no record, keeps today's rule: no v1 means cleared.
  - This replaces r1's "switch the rule off once step 4 is applied", which was wrong after a partial commit.
- **Removal index** (D2 b, review #6).
  - At commit, the runner appends one line per removal to `<home>/backups/migrations/removals.jsonl`:

    ```
    { step, attempt, stamp, root: "home" | "userData", source (relative to root), backup (relative to home), sha256 }
    ```

  - The lines are written after the moves and before the record. Recovery rebuilds or trims them from `commit.log`, so a torn tail never names a file that was not moved.
  - Pruning never removes a backup directory the index still references inside the rollback window: 30 days after the step is **applied**, not after each partial commit.
- **Clear markers under step 4** (review #4). Step 4 keeps HEAD's `threads/<id>.cleared` and token protocol. It retires a marker, by moving it into the backup, only when both are proven:
  - no v1 file remains whose fingerprint equals `marker.v1Fingerprint`;
  - no twin remains without `source.afterClear === marker.token`.

  A failed AG-UI deletion leaves the marker in place. The cleared thread therefore stays cleared across N+1, a downgrade to N and a re-upgrade.
- **Runner `break`** after a step returns `pending`, with a log line (C1 Claude #15, still open).
- **Step 3** `final-legacy-prefs-import-and-drop` is written and tested but **not registered**:
  - the whole-file provenance-aware import, then the drop of every `LEGACY_PREFS_KEYS` key from `renderer-state.json`;
  - both are `replace-user` writes, with backups;
  - `invalid` keys are dropped too; their raw values stay in the backup and are counted.
- **Gate:**
  - C-T1…C-T9, and the crash suite with step 3 and 4 kill points in the test registry;
  - `legacy-home.test.ts` still expects `[1, 2]` (plus 5 once phase 5 registers it);
  - R7-T14;
  - R7-T15's "N after every partial commit" leg;
  - legacy unchanged.

### C2 — Main parity for the new generation (main; legacy unchanged)

- **Window-chrome item (A).** In `probeAfterShow`, a hidden window waits on `mainWindow.once("show", …)`. Only a `retry-later` from a visible window re-arms the timer. `index.ts:897-904` still re-arms for hidden windows (`setTimeout(probeAfterShow, 250)` at :901).
- **Window-chrome item (B).** `ipcMain.handle("window:recreate", …)` (`index.ts:1881`) is registered only when `RENDERER_GENERATION === "wco"`. The preload member goes in C8.
- **Health check, agui mode (F7).** `checkAgentBundle(candidateRoot, { wire })`:
  - With `wire: "agui"` it spawns `[entry, "--wire", "agui", "--thread-id", "health-check"]`, without `--compat-fd` (compat `none`).
  - It resolves on the first stdout line that parses as `{ type: "CUSTOM", name: "session.ready" }`, and fails on `RUN_ERROR` or on exit before that.
  - The caller passes `"agui"` whenever `defaultWire(…)` is true.
- **Refused-target memo.** `ExperienceUpdater` records a target hash whose verification failed on foundation, API, protocol or provenance grounds, and skips it until relaunch (§6.4).
- **Window-chrome Electron integration test.** The 7 todos in `src/main/window-chrome.electron.test.ts` are implemented.
- **Coupling test.** `src/main/services/updates/experience/foundation-api.test.ts` asserts that the desktop and updater `FOUNDATION_API` and protocol are equal.
- **Not here:** keep-awake (P4) and activation (P3) are prerequisites; the wire default is done (F1).
- **Gate:**
  - R7-T28 and R7-T29 on three OSes;
  - R7-T8 in both modes;
  - legacy unchanged.

### C3 — Renderer-next boot services and the two-stage barrier

- **Activity beacon.** `lib/activity.ts`:
  - listens to `pointerdown`, `keydown` and `wheel` in the capture phase, and calls `transport.client.window.activity()` at most once per 5 s (the old `THROTTLE_MS`, `renderer/lib/activity-beacon.ts:6`);
  - is installed after `bootstrap()`, never in the notch entry.
- **UI continuity.** `lib/continuity.ts` defines `window.__captureUiContinuity()` and `window.__restoreUiContinuity(snapshot)`, the globals `renderer-host.ts:252-281` calls.
  - The snapshot: the focused `data-continuity-id`, the composer caret or selection and its text, and each `data-continuity-scroll` viewport's anchored message id and offset. The old caps apply (`ui-continuity.ts:31-33`: 20 scrollers, 20 fields, 4,096 characters).
  - The route travels in the hash (`renderer-host.ts:362-368`).
- **Two-stage barrier** (D11, review #13). The host order stays as it is:
  1. load the candidate;
  2. **stage 1**: readiness (`window.ready({ barrier: "subscriptions" })`, `renderer-host.ts:392-393`);
  3. capture the continuity of the live view;
  4. **stage 2**: `__restoreUiContinuity(snapshot)` returns a promise, which the candidate resolves after React commits the restored state and the scroll positions are applied. `restoreContinuity` awaits it for up to `RESTORE_TIMEOUT_MS` (2 s);
  5. settle, then flip.

  The candidate reports readiness from its data alone and never waits on restoration. Restoration completes before exposure, because the candidate stays beneath the live view until the flip. `restoreContinuity` becomes `Promise<"restored" | "timeout" | "none">` and is logged. A timeout still flips, as a plain swap.
- **Log collector.** Phase 5's `lib/log-ring.ts` (05 §21.4) is installed at boot in both entries.
- **Gate:** R7-T3 asserts the real host and candidate sequence (stage 1, capture, stage 2, flip) against a candidate that delays each stage. R1-T20 is unchanged.

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
- **Build provenance** (D3, review #14).
  - `vite build` writes `dist/renderer/build.json`, and the agent build writes `packages/agent/dist/build.json`. Each holds `{ commit, dirty, foundationApi, protocol, generation, builtAt }`, taken from the **source** constants at build time: `FOUNDATION_API` and `EXPERIENCE_PROTOCOL` from `src/shared/experience.ts`, and `generation` from `DEFAULT_RENDERER_GENERATION`.
  - `apps/updater` `buildManifest` reads both files and refuses when either is missing, when they disagree on `commit`, `foundationApi` or `protocol`, or when their `foundationApi` differs from the builder's own. The manifest records the renderer's `commit`.
  - `integrity.ts` checks the same agreement at install.
  - An old tree packaged by a new builder therefore fails at build time, and again at install.
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
- `FOUNDATION_API = 2` in `src/shared/experience.ts:11` and `apps/updater/src/manifest.ts:10` (D3). The swap barrier becomes `subscriptions` (`index.ts:425`), and stage 2 follows it (D11). From API 2 the verifier requires `renderer/notch.html` and consistent build provenance.
- Every spawn is agui, because `defaultWire` follows the generation (F1). The health check runs in agui mode.
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
  - R7-T1 … R7-T8, **R7-T9a**, R7-T10 … R7-T13, R7-T16, R7-T18 (pre-deletion form), R7-T23 (report only), R7-T24, R7-T25, R7-T30 (review #19: R7-T9b belongs to C10);
  - the parity sign-off checklist (§11) is complete, with evidence links;
  - the performance budgets (§14) are met on the reference machines.

  The last legacy-generation build and this flip build are both packaged from CI artifacts for comparison.

### C6 — Delete the old renderer tree, rename the entry

- First commit: move what the new code still needs out of `src/renderer`:
  - `ToolResultData` and its siblings from `renderer/conversation/agent-types.ts:273-322` go to `src/shared/transcript/tool-result.ts` (F11);
  - the oracles in `legacy-prefs.test.ts:215-235` become literal expectations (`LEGACY_ONBOARDING_STEPS = ["auth","welcome","connectors","models","explainer"]` and the homepage regex), each commented with the commit they were read from.
- Delete `src/renderer/**` **except** `src/renderer/locales/**` (D6). That is 436 files, about 84.8k lines of TS/TSX outside locales, including `conversation/` (about 6.9k non-test lines), `stores/` (zustand) and every re-export shim of §3 row 41.
- Delete `apps/desktop/index.html` (legacy) and `git mv index-next.html index.html` in the **same** commit (F10).
- `vite.config.ts`: **two** inputs, `main: index.html` and `notch: notch.html` (D10, review #12). `renderer-entry.ts`: `NEXT_ENTRY` and `LEGACY_ENTRY` collapse into `ENTRY = "index.html"`; `rendererEntry` and `experienceEntryUrl` lose the generation parameter; `notchEntry` (06:634) is unchanged.
- Delete `tsconfig.renderer.json` and its reference, the `renderer` vitest project, the old-renderer oxlint override (`oxlint.config.ts:31-67`), `check:legacy-diff` (script, allow list, `src/main/dev/legacy-diff.test.ts`, root `check` entry) and the old `matchSupportedLanguage` copy.
- `package.json` scripts: `dev:next` → `dev`, `dev:next:fixtures` → `dev:fixtures`. The old `dev` goes.
- **Gate:**
  - `pnpm run build` and `typecheck` pass, and every remaining suite passes;
  - the R7-T16 packaged smoke passes on three OSes;
  - R7-T4, because `classify` must still say `experience` for `index.html` (§6.3);
  - `integrity.test.ts` passes;
  - the packaged app and the experience built after C6 both contain `renderer/index.html` and `renderer/notch.html` (R7-T18);
  - the screenshot gate shows 0 changed pixels against C5's run (same routes, same fixtures).

### C7 — Move `src/renderer-next` to `src/renderer` (F12; pure move)

- `git mv src/renderer-next/* src/renderer/`. `locales/` is already there.
- Codemod `#next/` → `#renderer/` in every import. `package.json` `imports` drops `#next/*` and repoints `#renderer/*`. `vite.shared.ts`: `NEXT_SRC`/`NEXT_MODULES` → `RENDERER_SRC`/`RENDERER_MODULES`, and the plain `react()` instance goes, since there is one tree.
- Both router plugin instances: the main tree (`vite.config.ts:57-64`) and the notch tree (06 R6-T1, "the second router plugin"). `notch.html`'s `<script src>` moves from `/src/renderer-next/notch.tsx` to `/src/renderer/notch.tsx`. `tsconfig.renderer-next.json` → `tsconfig.renderer.json`. The vitest `renderer-next` project → `renderer`. `components.json` aliases.
- `knip.json` (review #24):
  - **`project`** becomes `["src/**/*.{ts,tsx}", "scripts/**/*.{js,mjs,cjs}", "*.config.ts", "vite.shared.ts"]`;
  - **`ignore`** is only `src/renderer/routeTree.gen.ts`, the notch route tree and `src/renderer/ui/**`;
  - **entries** are `src/renderer/{main,notch}.tsx`, `src/renderer/routes/**`, the notch routes, `src/main/index.ts`, `src/preload/index.ts`, `scripts/*.{js,mjs}` and every test file.
  - R7-T22's canaries prove each area is covered. Dependencies follow in C12.
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
- **Other main files.** `keep-awake.ts` IPC (the service stays, fed by P4), `update-handler.ts` (the whole file), `renderer-state.ts` `registerRendererState` IPC (`:196-215`) and `browser-runtime-handler.ts`.
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
  - a swap test (R7-T3) proving the two-stage barrier with `first-commit` gone.

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
- **Gate:** R7-T5, R7-T6, R7-T7, R7-T8 and **R7-T9b** on three OSes; `rg -n 'NdjsonHost|resolveWire|wireFor|aguiForEverySpawn|ABACUSAI_BOT_AGENT_WIRE' apps packages` returns nothing (the agent's own refusal of `--wire ndjson`, D4, is the one place the word stays).

### C11 — Transition data paths that are safe to remove in N

- `installLegacyPrefsSync` (`index.ts:1737`, `legacy-prefs.ts:427-449`) loses its live half: the `onSet` listener, the IPC and `RendererStateStore`'s mutation paths. Its **startup whole-file import stays** through N (review #8): read-only, provenance-aware, run once per launch after the runner.
  - It catches drift after a dormant → pre-rewrite → N path: step 2 is already applied, but a pre-rewrite build changed `renderer-state.json` after it.
  - `legacy` provenance never overrides a `user` leaf, so choices made in N win.
  - The import is renamed `importLegacyPrefsAtStartup` and keeps only `readRendererStateFile`. Step 3 in N+1 is its last run.
- Delete the dual-write: `TranscriptService.write` (no caller after C8), `ThreadStore.writeFromV1`, and the `dual-write` own-write cache kind.
- **Kept until N+1 (D2):**
  - the repair in `readCurrentFile`, still needed while step 1 may be pending or blocked;
  - the cleared-history rule;
  - `TranscriptService.remove`'s v1 removal (the dual-remove), so a thread cleared in N stays cleared if the old build is reinstalled and N is then reinstalled.
- **Forward compatibility with N+1** comes from C1's archive provenance, not from a step-4-applied switch (review #1). A home N+1 migrated only partly still reads correctly in N.
- **Gate:**
  - C-T* green;
  - R7-T13 (downgrade) passes against a home N has run on, including the dormant → pre-rewrite → N leg (R7-T11b);
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

1. **Apply the keymap first** (review #18): `sync-locales --apply-keymap` copies every mapped old translation into its new key in all 11 locales, and the result is committed.
2. **Compute the final consumer set** over `src/renderer` (outside `locales/`):
   - `t("…")` literals, with CLDR plural stems (`sync-locales.js` `PLURAL_SUFFIXES`);
   - every string literal equal to a full leaf (keys held in data, e.g. `titleKey: "…"`);
   - `i18nKey` props;
   - for template keys (``t(`a.b.${x}`)``, which `checkKeyUsage` allows by static prefix), either the enumerated values declared in `scripts/i18n-dynamic-keys.json` (`{ prefix, values }`, taken from the typed union the template interpolates) or, when undeclared, every leaf under the static prefix.
3. **Delete** every `en-US` leaf outside that set, whether keymap source, retired (`scripts/locale-retired.json`) or unused, and the same leaves in the 10 other locales.
4. Then delete `--apply-keymap`, `locale-keymap.json` and `locale-retired.json`, and R1-T16's keymap half.

- **Gate:** R7-T26 (no leaf outside the consumer set; every template key's prefix declared or covered; 11 locales with equal key sets).

### C14 — Packaging and release notes (release N is cut here)

- `electron-builder.yml`: remove the duplicate `NSMicrophoneUsageDescription` line (`:145-146`). §10 lists everything else that was checked and needs no change.
- R6-T31's recorded probe JSON is committed to `metrics.fixtures.json`, and the haptics default follows 06 §10.7's 150 ms rule. There are no inference constants (06 r4).
- `CHANGELOG.md` `## Unreleased` gets the user-facing notes (§12.1). The version bump is a foundation release.
- `docs/rewrite/PLAN.md` phase 7 is amended as in §16, and `PROGRESS.md` is updated.
- Support article: "Going back to the previous version", with the text of §12.3 (from N) and §12.4 (from N+1: `--restore-legacy-files` and its manual appendix).
- **Gate:** R7-T16 and R7-T18 on the final tree; R7-T17 on the signed RC in the private pipeline; R7-T24 re-run on the signed RC; the release manager's go.

### C15 — Retire the legacy files (release N+1)

- **Entry:**
  - N at 100 % for ≥ 14 days;
  - no rollback trigger (§12.2) hit;
  - no open P0 or P1 against migrated data.
- Register steps 3 and 4 in `MIGRATION_STEPS` (`[1, 2, 3, 4, 5]`; step 5 `routine-attempt-ids` is registered by phase 5, 05 §31.5 f). In the same commit, construct `ThreadStore({ v1Archived: true })` (C1 fix log, "Handed over"), and remove the repair, the dual-remove and the startup prefs import.
- **`--restore-legacy-files`** (§12.4) is implemented in main: it reads the removal index for each profile, restores with collision handling, and writes a report.
- **The fallback v1 reader stays** (D2, review #3). When a thread has no usable twin and `transcripts/<id>.json` still exists, `ai.hydrate` converts the file in memory, read-only. Step 4 kept such a file because it was `tooLarge`, `unreadable`, `failed`, `foreign`-twinned or "Keep"-agui.
  - Above `MAX_TRANSCRIPT_BYTES` the fallback parses the file as a stream (no string cap), up to 512 MB. Beyond that the thread shows "This conversation is too large to show here" with **Show in folder**, so the bytes stay reachable.
  - An `unreadable` file is retried on each hydrate.
  - The fallback is removed only in a later release, and only after field logs show no home with retained sources: step 4 records `kept`, `tooLarge`, `unreadable` and `failed` in `migrations.json` stats. Its removal is out of scope here.
- **Gate:**
  - R7-T14 on the real registry, including the fallback reader for an oversized, a temporarily unreadable and a `failed` file;
  - R7-T15;
  - R7-T10 and R7-T11 re-run with N+1 as the target.

## 5. Deletion inventory

Each row has a proof: a grep or a test that must come back empty or green after the named PR. R7-T21 runs every grep in this section as one test (§15).

### 5.1 The old renderer tree (C6)

| What | Size (unchanged from r1's `24b02486` to `c46e77d9`) | Notes |
|---|---|---|
| `src/renderer/**` except `locales/` | 436 files. About 84.8k lines of TS/TSX outside `locales/`. | Includes `conversation/` (about 6.9k non-test lines, the PLAN's "conversation layer"), `stores/` (the zustand stores), `providers/`, `terminals/`, `voice/`, `hooks/`, `lib/` (`activity-beacon.ts`, `ui-continuity.ts`, `durable-storage.ts`, `window-chrome.ts`, `i18n.ts`), the legacy dialog wrapper, the hand-rolled tabs, menus and listboxes, the `?view=` redirects and `staticData.titleKey/backTo` (all PLAN "Nuked"). |
| `apps/desktop/index.html` (legacy entry) | 16 lines | Replaced by the renamed `index-next.html` in the same commit (F10). |
| `tsconfig.renderer.json`, vitest project `renderer` (`vitest.config.ts:64-75`), oxlint override `oxlint.config.ts:31-67` | — | The new tree takes over these names in C7. |
| `scripts/check-legacy-renderer-diff.mjs`, `scripts/legacy-renderer-allow.json`, `src/main/dev/legacy-diff.test.ts`, `check:legacy-diff` in both `package.json`s | — | Their only purpose was guarding the old tree. |
| Re-export shims and wrappers (§3 row 41), `components/browser/pptx-viewer.tsx` (row 39) | — | The `shared/` modules they point at stay. |

**Kept:** `src/renderer/locales/*.json` (11 files, D6), and every `src/shared/**` module the specs moved out of the old tree.

**Proof** (r2, review #16; checked against inventories, not path patterns):

- **Inventory.** C5 commits `scripts/cutover/legacy-renderer-inventory.json`: every path under `src/renderer/` except `locales/`, with its git blob sha, at the C5 commit. The legacy entry `index.html` is included.
- **R7-T21, part 1.** No inventory path exists with its legacy blob. A path may exist again only if its file came from renderer-next (C7), which `git log --follow --diff-filter=R` shows. For example, `src/renderer/main.tsx` exists in both trees.
- **R7-T21, part 2.**
  - Every module specifier under `apps/desktop/src` is parsed (`ts.preProcessFile`: static, side-effect, dynamic `import()`, `require`, `export … from`; CSS `@import` from a CSS tokenizer) and resolved through the package `imports` and Vite aliases.
  - No specifier may resolve to an inventory path whose current blob is the legacy one, or to a path that no longer exists.
- **Negative control.** A fixture importing `#renderer/components/bot-avatar` (a migrated molecule) passes, and a fixture importing a deleted legacy module fails.

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
| N (C11) | Nobody in N writes it. The IPC is gone (C8), and the file is what the last legacy build left, which is what a downgraded build reads (§12.3). Step 2 reads it for a user upgrading from a pre-rewrite build. The **read-only startup import** reads it on every launch (review #8). | Authoritative. The startup import merges `legacy` leaves only, and never overrides `user`. |
| N+1 (C15) | Step 3 runs the final whole-file import, then drops the mapped keys. Both files are backed up. The startup import is deleted in the same commit. | Authoritative. |

The `renderer-state:*` IPC, `durableState` and the `onSet` listener (`renderer-state.ts:90-176`) go in C8 and C11. `RendererStateStore` shrinks to the file reader that step 2, step 3, the startup import and `progressWindowDark` use.

### 5.6 Dependencies (C12)

Importer counts at r1 (`24b02486`). The old tree and `package.json` are unchanged at `c46e77d9`, and renderer-next's imports are unchanged. They count files whose `import`, `import()`, `require()` or CSS `@import` names the package, under `src/renderer` ("old"), `src/renderer-next` ("next"), and `src/{main,shared,preload}` plus `scripts/` and the Vite configs ("other").

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

**Proof (R7-T22, r2, review #17).** r1's regular expression missed scoped names (`@tsparticles/engine`) and side-effect imports (`import "sonner"`). It is replaced by `scripts/cutover/check-removed-deps.mjs`:

1. It walks `apps/**` and `packages/**` (not `node_modules`, not `docs`).
2. It extracts every module specifier with `ts.preProcessFile` (`import … from`, `import "x"`, `import()`, `require()`, `export … from`, triple-slash types) and every CSS `@import`/`@plugin`/`@source` string.
3. It reduces each specifier to its package name: `@scope/name` for scoped, the first segment otherwise; relative and `#` specifiers are skipped.
4. It fails on any removed name (the table above, scoped names spelled out).
5. It also fails when a removed name is a key of `dependencies`, `devDependencies`, `optionalDependencies` or `peerDependencies` in any workspace `package.json`, or appears in `pnpm-workspace.yaml` `patchedDependencies`/`allowBuilds`. The one listed exception is `minimumReleaseAgeExclude`'s `framer-motion@13.4.6` (F14).

Its test feeds every import form with each scoped and unscoped name, and must detect all of them. `knip` (dependencies, unlisted) must also be clean.

The oxlint ban list keeps every removed name so they cannot come back (C7 renames it).

### 5.7 Transcript v1 path, step 4 and the rule removal

These are split across releases (D2); §9 has the full plan.

| Piece | Release N | Release N+1 |
|---|---|---|
| `TranscriptService.write` + `ThreadStore.writeFromV1` (dual-write) | Deleted (C11). There is no v1 writer after C8. | — |
| `readCurrentFile` repair | Kept | Deleted (C15) |
| The "no v1 means cleared" rule | Kept, but an `archived`/`orphan` record with a matching fingerprint serves the twin (C1) | Replaced by `v1Archived: true` (C15) |
| `TranscriptService.remove` removing v1 (dual-remove) | Kept | Deleted (C15) |
| Clear markers (`threads/<id>.cleared`, tokens) | Kept (HEAD) | Kept; step 4 retires a marker only when proven (C1) |
| Fallback v1 reader (`ai.hydrate` converts a retained v1 file in memory) | Is the repair path | Kept, read-only (C15, review #3) |
| `threads/<id>.archived`, `removals.jsonl` | Reader (N) and runner index (C1) | Written by step 4 (C15) |
| Startup prefs import (read-only) | Kept (C11) | Deleted with step 3 registered (C15) |
| Step 3 | Code and tests only (C1) | Registered (C15) |
| Step 4 | Code and tests only (HEAD + C1) | Registered (C15) |

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

1. **Admission.** A foundation at API 2 refuses every manifest with `foundationApi: 1`, and the reverse holds too. The exact-version check already enforces this between releases (F3).
   - The manifest's number alone cannot catch a stale tree, because `buildManifest` stamps whatever tree it is given (review #14).
   - The guard is **build provenance** (C4): `renderer/build.json` and `agent/build.json` are written by the builds from the source constants. The builder refuses inconsistent inputs, and the verifier checks again at install.
   - A pre-C5 tree carries `foundationApi: 1` and `generation: "legacy"` in its own `build.json`, so the new builder refuses it.
2. **Barrier.** `index.ts:425` selects `subscriptions`. A swap flips only after the candidate's `window.ready({ barrier: "subscriptions" })` reports `ready`: transport, shell tables and visible thread live (spec 00 A.4.6, R1-T20). `failed` or a 10 s timeout raises `SwapNotReady`, and the retry budget applies. After C8 the `first-commit` path (`renderer-ready`, `READY_TIMEOUT_MS`) is deleted.
3. **Entry points.** From API 2 the verifier also requires `renderer/notch.html` (D3). A bundle without the notch entry would leave the notch window unable to reload on a swap (06:578, R6-T30).
4. **Contract.** `system.info.foundationApi` reports 2 (`rpc/procedures/system.ts:48`). The renderer does not branch on it, since there is one renderer.

### 6.3 Coordination steps

| Step | Where | Check |
|---|---|---|
| Both constants to 2 in one commit | `src/shared/experience.ts:11`, `apps/updater/src/manifest.ts:10` | `foundation-api.test.ts` (C2) plus `integrity.test.ts`, which builds with `@abacus-ai/updater/experience` and verifies with the desktop verifier, so a mismatch fails "accepts a built experience" |
| Classifier prefixes | `apps/updater/src/classify.ts:11-15` | `classify.test.ts`: `index.html`, `notch.html` and the renderer tree are `experience`; `src/shared/`, `src/preload/` and `package.json` are `foundation` |
| Required entries | `integrity.ts:196-200` | R7-T2: a tree without `renderer/notch.html` is refused at API 2 |
| Build provenance | `vite build` and the agent build write `build.json`; `buildManifest` and `integrity.ts` check it (C4) | R7-T2: an old tree packaged by the new builder is refused by the builder, and the same tree hand-signed is refused by the verifier; mismatched renderer and agent commits are refused |
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
- **Keep-awake.** Follows turn state in main (P4).

### 7.2 The two low items due before `RENDERER_GENERATION = "wco"`

| Item | State at `c46e77d9` | Fix (C2) | Test |
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
4. **What byte identity covers** (review #11). The goldens compare what the agent **writes**. The taps read what main **decodes**. On `c46e77d9` each chunk is decoded on its own, and fd 3 lacks the final-line drain, so a UTF-8 character split across chunks or an unterminated last compat line could still differ at the tap. Prerequisite P5 fixes the decoding. R7-T7 then drives the taps **through `AgentManagerService`** with fragmented multibyte text, an over-long line and an unterminated tail on both pipes, so the guarantee holds at the tap's input, not only at the producer.
5. **The one documented divergence.** Under agui, Stop and reset hold admission (`reserveDuringAbort`, agent spec :455): a message that races an idle Stop or reset is queued and runs after it. Under ndjson it was sent into the session being aborted. No golden covers that race, and the turn-state tap sees the queued turn start after the Stop's `turn_complete`, which is the intended outcome. The release notes do not mention it.
6. **After C10 the baselines are frozen.** Nothing can record a new independent oracle once `NdjsonHost` is gone. A new compat scenario is recorded from `AguiHost` with `RECORD_COMPAT_BASELINE=1`, marked `derived: true` in `__fixtures__/index.json`, and reviewed by diff against the nearest independent scenario. R7-T6 refuses to count a derived baseline as an oracle in its report.

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
- An unresolved attempt does not block launch (`startup.ts:84-92`, `write-block.ts`). `ThreadStore` and `TranscriptService` honour the write block on HEAD. Durability of a held change is P2.
- After the runner, the read-only startup prefs import runs (C11, review #8).

### 9.3 The cleared-history rule, per thread (r2)

On HEAD, a v1-derived twin whose v1 file is missing reads as cleared (`thread-store.ts:276-280`), unless the store was built with `v1Archived`. Step 4 archives v1 files thread by thread, and it can commit **partially**: some threads archived, others converted first and left for the next launch. A global "step 4 applied" switch (r1) is therefore wrong in between. A thread archived by a partial commit would read as cleared in N (review #1).

So the rule is decided **per thread**, from durable evidence. It applies to v1-derived twins. An `agui` twin is served as it is unless a clear marker hides it (HEAD).

| On disk for thread *id* | N (and N+1 before `v1Archived`) | N+1 (`v1Archived`) |
|---|---|---|
| v1 present | the repair, or the twin by fingerprint | the twin; the fallback reader if the twin is unusable |
| v1 missing, `threads/<id>.archived` of kind `archived`/`orphan` whose `twinFingerprint` matches | the twin, as is | the twin |
| v1 missing, a `cleared` record, or a `threads/<id>.cleared` marker whose token the twin lacks | cleared | cleared |
| v1 missing, no record, no marker | cleared (the transition rule) | the twin (step 4 always writes a record, so this is a v1 file removed outside step 4) |

- The record is committed in the same journaled commit as the move. A rollback of that commit removes both, and the journal's recovery covers every kill point (R7-T14).
- The marker protocol is HEAD's, unchanged (review #4). Step 4 retires a marker only under C1's proof. A failed AG-UI deletion keeps both the marker and the cleared state.

C15's tests (R7-T14):
- after **every** partial commit, N serves each archived thread and hides each cleared one;
- after the final commit, N+1 does the same;
- a thread cleared before step 4 stays cleared, whether it had an orphan twin or a marker with a leftover AG-UI twin;
- an `agui` twin whose `migratedFrom.updatedAt` is older than its v1 file keeps that v1 file (step 4 "Keep"), and the fallback reader shows it if the twin becomes unusable.

### 9.4 Backups, the removal index and retention

- Step 3 backs up `renderer-state.json` and `prefs.json` (`replace-user`, hash-checked). Because `userData` is `<home>/electron`, `backupPathFor` files them under `home/electron/…`, not `userData/…` (F22).
- Each step-4 commit moves its v1 files, and the twins and markers it retires, into **its own** `backups/migrations/<stamp>_<attempt>-4-archive-transcripts-v1/home/…`. Quarantine copies go to `backups/quarantine/transcripts/` (90 days).
- `backups/migrations/removals.jsonl` (C1) lists every removal of every committed attempt, partial ones included, with its root, source and backup path. It is the only input restore needs (§12.4).
- Pruning keeps what the index references for 30 days after the step is **applied**. Other backups follow the existing rule: the newest 3 per step, 30 days (`backup.ts:252-323`). N+1's rollback window is therefore 30 days from the last attempt.

## 10. Notch and capsule packaging

Spec 06 r4 adds no packages and no native module: `node-mac-notch` does not exist (06 F1). The notch is built from:

- **Metrics:** a one-shot JXA probe. When it fails, or no screen matches, an internal display gets **no** companion; there is no inference (06:651-655).
- **Haptics:** a **one-shot** `osascript` per attention, deduplicated by key through `notch.haptic`. They ship off by default when R6-T31's median latency exceeds 150 ms (06 §10.7, :724-730).
- **Windows:** Electron `BaseWindow`s, `type: "panel"` on macOS and `type: "toolbar"` on Windows, with an active and a standby view across renderer swaps (06 §10.6).

r1's "long-lived stdin haptics process" and "aspect-ratio fallback" are withdrawn (review #22).

| Concern | Finding | Action |
|---|---|---|
| Vite output | `notch.html` is a third input at the root of `dist/renderer` (06:736). `electron-builder.yml` `files: dist/**` carries it (`:8-13`). The experience carries it because `renderer/` is `dist/renderer`. | R7-T18 asserts that the asar and the experience tree both contain `renderer/index.html` and `renderer/notch.html` (§6.2 item 3). |
| CSP | `notch.html` copies the `<meta>` verbatim (06:735). `rendererCspHeaders` covers every `app://` main frame (`renderer-csp.ts:18-35`), the notch included. | R7-T18 compares the three `<meta>` strings with `RENDERER_CSP` (C12 may narrow `'unsafe-eval'` everywhere at once). |
| macOS entitlements | `build/entitlements.mac.plist` already has: JIT, unsigned executable memory, library-validation off, audio input, network client, user-selected files, virtualization. A `panel` window needs no entitlement. `osascript` runs as its own Apple-signed process, outside the app's entitlements. The JXA scripts use the ObjC bridge on `NSScreen` and `NSHapticFeedbackManager` in that process and send no Apple Events to other apps. | No entitlement change. R7-T17 verifies on the **signed, notarized** RC that the probe returns metrics and that no TCC or Automation prompt appears. If one does, `NSAppleEventsUsageDescription` is added and the finding recorded. A probe that fails on the signed build disables the companion on that display (06 r4); it never guesses. |
| `Info.plist` | `NSMicrophoneUsageDescription` covers notch dictation too (06 NT6). It is listed twice in `extendInfo` (`electron-builder.yml:145-146`). | Remove the duplicate (C14). |
| Windows manifest | electron-builder's defaults (no `requestedExecutionLevel` override in `win:`); the capsule is `alwaysOnTop` at `"pop-up-menu"` level and click-through, which needs no `uiAccess` | No custom manifest. R6-T33 on hardware, extended in R7-T17 to 100 %, 125 %, 150 % and 200 % display scaling and a taskbar on each edge: the capsule sits by the clock and never shows in Alt+Tab. |
| Linux | No notch or capsule (06:82, :649) | R7-T16 asserts that no notch window is created on Linux. |
| Global shortcut | `CommandOrControl+Shift+Space`, registered only while enabled (06:644) | R7-T16 asserts it is unregistered at quit (no leaked registration across relaunch). |
| Quit and update restart | The notch/capsule is destroyed on quit and on main close on win32, and a running haptic `osascript` is killed (R6-T25; 06 §10.6) | R7-T16 plus an update-restart case in R7-T33 (the capsule must not hold the NSIS installer's file lock). |

## 11. Parity sign-off checklist

**Rule.**
- Every row of every parity table has a status in its `features/<area>/parity.ts` (`PARITY.md` for the bridge):
  - **green**, with evidence (a test id, or a manual check recorded on the packaged RC);
  - **retired**, with its reason; user-visible retirements go into the release notes (§12.1);
  - **deferred**, naming an owner and the PLAN later-slice it belongs to; user-visible deferrals go into the release notes as "not in this version".
- No row is `todo`.
- **The row set is exact** (review #25).
  - `scripts/cutover/parity-ids.json` lists every id each spec's table defines: P1–P73, S1–S111, RT1–RT26, AR1–AR15, LB1–LB21, ST1–ST27, OB1–OB17, FB1–FB7, TR1–TR9 and NT1–NT7.
  - For `PARITY.md`, the set is every `window.api` member enumerated from `preload/bridge.ts` and `preload/index.ts` (249), every `IpcEvent` type (46) and the 5 other push channels. It is computed before C8 deletes the bridge.
  - A missing id, an extra id or a duplicate fails R7-T25.
- **Consumers resolve.** Every `consumer: "file#symbol"` must name an existing file under `src/renderer` (or `src/main` for main-only rows) that exports or declares that symbol, checked with the TypeScript program. A `retired: <reason>` needs a reason of at least one sentence.
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

- **RC.** The signed RC goes to the team for ≥ 3 days, on their own machines and, if they choose, on copies of their own homes (D7). R7-T17 and the §11 manual checks are done on it.
- **Stages** (`stagingPercentage` in `latest*.yml`, D9): 5 % for 48 h, then 25 % for 72 h, then 50 % for 72 h, then 100 %. Each step needs the release manager's go against the triggers.
- **Triggers:**
  - any report of lost data (history, bots, routines, settings);
  - a migration `lastFailure` or unresolved attempt in any synced log (the log sync the app already has, where the user enabled it);
  - a rise in renderer BootFailure or error-screen reports above the last release;
  - agent spawn failures with `compat_lost` (exit 75) or `wire_unsupported`;
  - a notch/capsule click-through failure.
- **Halting (r2, review #15).** Freezing the percentage does not halt, because a client that has not checked yet is still admitted when its persisted staging id falls below the threshold (F23). The rollout is halted by one of:
  1. **percentage 0** in every `latest*.yml`: no client is admitted;
  2. **withdrawal**: republishing N−1's feed files, so no client is offered N.

  Clients that already **downloaded** N answer `update-not-available` on their next checks. Shipped clients (≥ `v1.0.85`) drop the downloaded build on the second consecutive such answer, and install-on-quit comes off with it (`update-service.ts:153-175,227-236`). Checks run every 10 minutes (`:46`).
  - A client that quits within that window, or on macOS where Squirrel already staged the update ("best-effort", `:230-231`), may still install N.
  - Those users are the downgrade population of §12.3.

  R7-T33 covers a newly checking client at 0 %, a withdrawn feed, and a downloaded client that drops the build after two checks.
- **Levers, fastest first:**
  1. **Halt** (above). electron-updater does not downgrade (`allowDowngrade` is not set), so users on N stay on N.
  2. **Experience hotfix** for N: TUF, no relaunch, swapped at idle behind the two-stage barrier (§6.2, D11).
  3. **Foundation N.1**, rolled out again from the current stage.
  4. **User-level downgrade** (§12.3), through support.
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
   - `prefs.json` is authoritative. The read-only startup import (C11) merges any `renderer-state.json` change N−1 made into leaves still marked `legacy`, and never over a `user` choice;
   - v1 files that N−1 wrote after the downgrade are newer than their v1-derived twins, and `readCurrentFile`'s repair (kept in N) converts them on open.

   A thread N already owned (`agui` twin) keeps its AG-UI history: turns added to it under N−1 are not shown by N, but the model context has them. That is a known limitation (§18 R7).

   N−1's store writers may drop fields N added. N treats every such field as optional with a default (R7-T13, re-upgrade leg).

### 12.4 Rollback after N+1 (r2, reviews #5, #6)

N+1 runs steps 3 and 4, which change what N−1 reads.

**Back to N needs no restore.** N reads `threads/` and `prefs.json`, and it decides each thread from its archive record (§9.3), whether step 4 finished or stopped partway.

**Back to a legacy build (N−1) needs the legacy files restored,** from every committed attempt, in every profile. The support article (C14) gives one command, not hand-typed paths:

1. Quit the app.
2. Run the installed N+1 once with `--restore-legacy-files`. This is a packaged-allowed flag, handled in main before the runner and before any window; it prints a report and exits. For each profile home listed in `profiles.json` (the base home included), it reads `<home>/backups/migrations/removals.jsonl`, and for each removal of steps 3 and 4, oldest attempt first:
   - The destination is `<recorded root>/<source>`: `root` is `home` or `userData`, resolved for **that** profile (`userData` = `<home>/electron`, F18, F22). The backup path comes from the index, never recomputed.
   - If the destination does not exist, the backup file is moved back.
   - If it exists with the same sha256, the backup is left in place.
   - If it exists with different content, the restored file is written beside it as `<name>.restored-<stamp><ext>`, and the report lists it. For `renderer-state.json` the backup wins, and the current file is kept as `.before-restore`.
   - `threads/<id>.archived` records whose removals were restored are deleted, and `migrations.json` marks steps 3 and 4 `restoredAt`. A later launch of N+1 (or newer) treats a restored step as not applied and runs it again, as a new attempt with new backups.
3. Install N−1.

The article also carries a manual appendix for when the app cannot start. It is generated from the index format, not from assumed paths: for each profile, for each line of `removals.jsonl`, move `<home>/<backup>` to `<root>/<source>`.

R7-T15 runs the published command and the published appendix **verbatim**, against a two-profile home migrated by N+1 through two partial commits and a final one, with one interrupted recovery. N−1 then shows every conversation and the preferences.

## 13. Upgrade tests: real layouts, synthetic data (r2)

### 13.1 Why the committed fixture is not enough

`__fixtures__/legacy-home/` is hand-made "as a shipped build leaves it" (`legacy-home.test.ts:1-9`). The cut-over needs the layout **shipped builds actually write**: file names, electron-store shapes, zustand `persist` envelopes in `renderer-state.json`, `window-state.json` and `profiles.json`. It must be produced without anyone's data.

### 13.2 Fixtures: immutable, versioned, one per purpose (reviews #20, #21)

| Fixture | Source build | State | Used by |
|---|---|---|---|
| `legacy-home-pre-rewrite-v<ver>` | The last pre-rewrite release (`v1.0.85` or later), from `downloads.abacus.ai/abacusai-bot/releases/<ver>/` or CI's unsigned `package:dir` of that tag | Onboarding stopped at `models`; the migration content of §13.3 | R7-T10, R7-T12, R7-T13, R7-T32 |
| `legacy-home-dormant-v<ver>` | The dormant release (§2 item 4), if one shipped | The same script, run on the dormant build, so `threads/`, `prefs.json` and `migrations.json` are real | R7-T11 |
| `legacy-home-dormant-then-pre-rewrite-v<ver>` | The dormant fixture, then the pre-rewrite build launched on it, changing theme and pins | Drift in `renderer-state.json` after step 2 | R7-T11b (review #8) |
| `perf-home-v<ver>` | The pre-rewrite release | **Onboarding completed** through the source build, so both builds open straight into the shell | R7-T24 (M1–M5) |

- Each fixture is committed under `apps/desktop/src/main/migrations/__fixtures__/<name>.tar.zst` with a `producer.json`: source version, the sha256 of the source binary, generator commit, OS, and a sha256 per file.
- Fixtures are **immutable**. A new release adds a new versioned fixture and never replaces an old one, so both source layouts stay available for as long as upgrades from them are supported.
- `electron/` Chromium state is excluded, apart from the two JSON files the app owns.
- The 30 MB transcript is regenerated from a seed at test time.

### 13.3 The generator (`scripts/cutover/make-legacy-home.mjs`)

1. **Launch** the source build with `ABACUSAI_BOT_BASE`/`ABACUSAI_BOT_HOME` at a fresh temp directory and `--remote-debugging-port`. The network goes through a proxy env pointing at a closed port.
2. **Migration content,** created through the source build's own `window.api` over CDP `Runtime.evaluate`:
   - 12 bots from templates with custom looks (3 pinned);
   - 3 workspaces (temp git repos, 2 worktrees);
   - 40 sessions (5 pinned, 3 with a missing workspace);
   - 2,000 transcripts through `agent.writeTranscript` (text, tool calls, a diff, one of 30 MB, and 3 over 64 MB for the fallback reader);
   - 6 routines with 120 runs;
   - 20 memories;
   - an auto-reply grant;
   - `durableState.set` for every key in `LEGACY_PREFS_KEYS`, with onboarding step `models`;
   - a 1280×800 `window-state.json`.

   After the app quits, the generator adds an unparseable file and one with a `version` the steps do not know. They are the only files the app does not write itself, because `writeTranscript` always writes version 1 (`transcript-service.ts`).
3. **Completed onboarding (perf fixture only).** The source build's gate is `!onboarded || !hasAbacusCredential` (06:51).
   - The generator calls `window.api.skipAccountOnboarding()` and saves a synthetic Abacus key through the source build's own key-save path, with the account endpoints answered by a local stub server that the source build is pointed at through its proxy settings.
   - `producer.json` records which calls and stubs were used.
   - If the source build cannot reach its shell this way, the perf fixture is not produced, and C5's gate names the blocker. The perf run never uses the onboarding fixture.
4. **Second profile.** A second profile directory is built from the `profiles.json` format (`profile-home.ts:12-19`), because a real profile switch needs a real sign-in.

### 13.4 What the runs assert (R7-T10…R7-T15)

- **Upgrade to N (pre-rewrite fixture).**
  - The packaged RC starts on a copy and prints every smoke marker.
  - `migrations.json` records steps 1, 2 and 5 with the expected stats: every good transcript converted; the unparseable one `corrupt` and the unknown-version one `notV1`; the three over 64 MB `tooLarge` and kept; nothing quarantined.
  - Over CDP, the UI shows:
    - onboarding resuming at `models` (the legacy step id, 06 R6-T5);
    - once onboarding is completed in-test: 12 bots (3 pinned, in order), 40 sessions grouped by workspace, 6 routines;
    - 5 sampled histories matching `v1-to-ui-messages`;
    - an over-64 MB thread shown through the fallback path.
  - Every legacy file's sha256 is unchanged.
- **Dormant layouts.** No step re-runs, and prefs are right. With the drift fixture, the drift reaches `prefs.json` through the startup import, and `user` leaves win.
- **Downgrade.**
  - After N has run and created 2 bots and 3 conversations, N−1 starts on the same home and prints its smoke marker. Its `window.api` lists every bot and session.
  - Pre-update history is intact.
  - No store parse error appears in its log.
- **Re-upgrade.** No step re-runs; the conversations N created are intact; N tolerates fields N−1 dropped.
- **N+1.**
  - Steps 3 and 4 run over two partial commits and a final one, with a kill point in each.
  - After each commit, N reads the home correctly (§9.3).
  - The §12.4 command and appendix, run verbatim, bring back N−1's view in both profiles.

## 14. Performance budgets

### 14.1 Method (`scripts/cutover/perf-compare.mjs`, C5)

- **Builds.** Both builds are packaged with the same flags:
  - **old** = the last shipped legacy build;
  - **new** = the RC.

  Each run uses a fresh copy of **`perf-home-v<ver>`** (onboarding completed, §13.2), already migrated for the new build, so migration is not timed here (R7-T32 times it on the migration fixture). The window is 1280×800 through the fixture's `window-state.json`, because the dev content-size override is ignored when packaged.
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

- **Workload.** Steps 1, 2 and 5 on the pre-rewrite fixture: 2,000 transcripts, 200 MB total, one of them 30 MB, plus three over 64 MB that step 1 only `stat`s and keeps.
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
| R7-T2 | `services/updates/experience/foundation-api.test.ts`, `integrity.test.ts`, `apps/updater/src/manifest.test.ts` | main + unit | The desktop and updater `FOUNDATION_API` and protocol are equal. A tree built at API 1 is refused by a 2 shell, and vice versa. A tree without `renderer/notch.html` is refused at 2. **Provenance** (review #14): an old tree (its `build.json` at API 1, `generation: "legacy"`) given to the new builder is refused by `buildManifest`; the same tree signed by hand is refused by the verifier; renderer and agent `build.json` with different commits are refused. |
| R7-T3 | `src/main/dev/experience-swap.electron.test.ts` | Electron | Two renderer builds served as installed experiences at API 2:<br>- stage 1 waits for `window.ready`;<br>- stage 2 awaits the candidate's restore promise, and the observed order is ready → capture → restore → flip, with a candidate that delays each stage (D11, review #13);<br>- a restore timeout still flips;<br>- `window.activity` defers the swap by 15 s;<br>- continuity restores focus, caret, composer text and scroll;<br>- a candidate reporting `failed` is discarded, and **after a full restart the previous experience boots** (P3, review #9);<br>- 3 failures stop swaps until relaunch;<br>- on an N−1 shell the N target is refused once and then memoised. |
| R7-T4 | `apps/updater/src/classify.test.ts` | unit | C5: `src/renderer-next/**`, `index-next.html` and `notch.html` are `experience`. C7: `src/renderer/**`, `index.html` and `notch.html` are `experience`, and `src/shared/**`, `src/preload/**`, `package.json` and `pnpm-lock.yaml` are `foundation`. |
| R7-T5 | `cli-manager-wire.test.ts`, `relay-service.test.ts` | main | Every spawn's argv has `--wire agui --thread-id <sessionId> --compat-fd 3` and 4 stdio pipes. No code path yields `ndjson` (C5 through `defaultWire`; C10 by construction). The env flag is ignored when packaged (on HEAD, relay fix log Claude 9). |
| R7-T6 | `packages/agent/src/agui/agui-golden.integration.test.ts`, `agui-spawn.e2e.test.ts` | agent, 3 OSes | All 24 scenarios: compat bytes equal the `.ndjson` baselines. Spawned `plain-text`, `permission-accept` and `tool-bash` in fd and inline modes match (§8.2 masks). The report lists derived baselines separately. |
| R7-T7 | `src/main/services/agui/taps.e2e.test.ts` | main (spawned agent, fake provider) | Every tap in §8.3 fires with every spawn agui: artifacts recorded, a `<reply>` relayed, a routine settled, the turn waiter resolved, browser auto-allow answered on the emitting runtime, a host service answered, the inactivity watchdog writes one relay terminal. **Through `AgentManagerService`** (P5, review #11): multibyte text split across chunk boundaries on stdout and on fd 3, an over-long line on each, and an unterminated final line on each at exit, with tap inputs equal to the unfragmented run. |
| R7-T8 | `health-check.test.ts` | main | Agui mode:<br>- resolves on `CUSTOM session.ready`;<br>- refuses a candidate that exits, prints `RUN_ERROR`, or only prints NDJSON `ready`;<br>- the argv equals main's spawn minus `--compat-fd`.<br>NDJSON mode still passes before C10. |
| R7-T9a | `packages/agent/src/main.test.ts` + the CI AG-UI step | agent | **C5 gate.** `--wire agui --thread-id` works with fd 3, inline and none compat; an absent `--wire` is still `ndjson`; the sandbox probe is unaffected; the CI AG-UI step passes beside the NDJSON step (review #19). |
| R7-T9b | same | agent | **C10 gate.** An absent `--wire` means agui; `--wire ndjson` exits 64 with `wire_unsupported`; `--thread-id` is required; the CI NDJSON step is gone. |
| R7-T10 | `src/main/migrations/upgrade.packaged.test.ts` | packaged, 3 OSes | §13.4 "Upgrade to N" from the pre-rewrite source layout. |
| R7-T11 | same | packaged | The dormant fixture: no step re-runs; prefs are right. |
| R7-T11b | same | packaged | The dormant-then-pre-rewrite fixture: the drift reaches `prefs.json` through the read-only startup import, `user` leaves win, and `renderer-state.json` is byte-unchanged (review #8). |
| R7-T12 | same | packaged | Two profiles: each migrates on its first activation, and the inactive one is untouched until then. |
| R7-T13 | `downgrade.packaged.test.ts` | packaged, macOS + Windows + Linux | §13.4 "Downgrade" and "Re-upgrade": N−1 opens a home N ran on; N tolerates records N−1 rewrote (fields dropped). |
| R7-T14 | `steps/003-final-legacy-prefs.test.ts`, `004-archive-transcripts-v1.test.ts`, `runner.crash.test.ts`, `thread-store.cutover.test.ts` | main | Step 3: import, drop, backups (under `home/electron/…`, F22), invalid keys counted. Step 4: `threads/<id>.archived` in the same commit as each removal; `removals.jsonl` lines per commit, rebuilt after a torn tail; a marker retired only under C1's proof, kept after a failed AG-UI deletion (review #4). The runner `break`s after `pending`. **After every partial commit and every kill point, N's `ThreadStore` serves archived threads and hides cleared ones** (review #1). N+1: `v1Archived` plus the fallback reader for an oversized, a temporarily unreadable and a `failed` source (review #3). P1's injected `EACCES`/`EIO` on either directory stops removal and completion. P2's held send, reset and quit. |
| R7-T15 | `rollback.packaged.test.ts` | packaged | The published `--restore-legacy-files` command and its manual appendix, run verbatim, on a two-profile home that N+1 migrated through two partial commits and a final one, with one interrupted recovery. Destinations are derived from the recorded roots (F22). Collisions give `.restored-<stamp>` files. N−1 then shows every conversation and the preferences in both profiles. N started without any restore shows every archived conversation. (Reviews #5, #6.) |
| R7-T16 | `ci.yml` "The packaged app actually starts" (extended) | packaged, 3 OSes | `[smoke] main process ready`, `[smoke] renderer ready` (readiness `ready` against real tables on an empty home), and on darwin and win32 `[smoke] notch ready`. No fatal pattern. On Linux there is no notch window. Global shortcut unregistered at quit. |
| R7-T17 | Private pipeline checklist (signed RC) | manual + scripted, hardware | macOS: `spctl -a -vv` accepts the notarized app; launch; notch on a notched MacBook (R6-T31), external display (R6-T32); haptics; no TCC or Automation prompt from the JXA probe; mic prompt text once. Windows 11: signed installer installs over N−1; capsule at 100/125/150/200 % scaling with the taskbar on each edge (R6-T33); uninstall. Linux: AppImage and `.deb` start. |
| R7-T18 | `scripts/check-packaged-resources.js` (extended) + `packaged-asar.test.ts` | packaged | The asar holds `dist/renderer/{index,notch}.html` and `build.json`, and no `index-next.html` after C6 (review #12). The three CSP `<meta>` strings equal `RENDERER_CSP`. No `__abacusDev`, fixture DB, devtools, `monaco`, `katex` or `sonner` asset. The experience tree built from the same dist passes `verifyExperience`. |
| R7-T19 | `src/preload/preload-exposure.test.ts` | preload | For the main and notch windows: exposed globals = `{ abacusHost }`; the port handshake is installed before any page script; no `sendSync`. |
| R7-T20 | `src/main/ipc-surface.test.ts` | main (static) | `ipcMain.handle`/`ipcMain.on` appear only in the allow-listed files (the transport). No `webContents.send` outside `rpc/`. `IpcChannels` does not exist. |
| R7-T21 | `src/main/dev/cutover-greps.test.ts` | repo | The §5.1 inventory and resolved-specifier checks, with the negative control (review #16). The other §5 checks: `window.api`, IPC names, the window-chrome pattern of F17, `renderer-next`/`#next`, `RENDERER_GENERATION`, `NdjsonHost`/`wireFor`/`resolveWire`. |
| R7-T22 | `pnpm check:knip`, `scripts/cutover/check-removed-deps.test.mjs` | repo | knip is clean: files, exports, types, duplicates, dependencies, unlisted. A temporary unused file in each of `src/main`, `src/shared`, `src/preload`, `src/renderer` and `scripts` **is reported**, which proves the project scope (review #24). The removed-dependency check detects every import form for every scoped and unscoped name, and every manifest key (review #17). |
| R7-T23 | `size-limit` | build | §14.4. |
| R7-T24 | `scripts/cutover/perf-compare.mjs` | packaged, reference machines | §14.1 M1–M6 against the last shipped build; numbers in the C5 and C14 PRs. |
| R7-T25 | `src/renderer/features/parity.test.ts` (aggregate) + `preload/parity.test.ts` before C8 | renderer, preload | The ids equal `parity-ids.json` exactly (no missing, extra or duplicate id). Every consumer `file#symbol` resolves in the TypeScript program. No `todo`. Every `deferred` row names an owner and a PLAN anchor. Every `visible` retired or deferred row is in the release-note list. `PARITY.md` rows equal the enumerated bridge, event and channel sets (review #25). |
| R7-T26 | `check:i18n`, `check:locales`, `src/shared/contract/languages.test.ts`, `scripts/i18n-dynamic-keys.test.mjs` | repo | After C13: every `en-US` leaf is in the final consumer set; every template key's prefix is declared or covered; no leaf that was a keymap source or retired remains; all 11 locales have the same key set (review #18). |
| R7-T27 | `src/main/keep-awake.test.ts` | main | P4's source: the blocker follows authoritative turn-state transitions, held while any turn is busy and released on the last finish, runtime exit or crash. Both orders of AG-UI terminal vs compat `turn_complete` give the same result, with no renderer call (review #10). |
| R7-T28 | `src/main/window-chrome-probe.lifecycle.test.ts` | main | (A) No timer is armed while hidden; the probe runs once on `show`. (B) `window:recreate` is not registered in legacy (C2) and not at all (C8). |
| R7-T29 | `src/main/window-chrome.electron.test.ts` (the 7 todos) | Electron, 3 OSes | 00-window-chrome §10's integration cases, run on the packaged RC once in C14. |
| R7-T30 | The phase Electron suites | Electron against the packaged RC | R1-T11b, R1-T22, R2-T16, R2-T32, R3-T31, R4-T29, R4-T30, R4-T34, R5-T36, R6-T30, R6-T36: green on the RC, not only in dev. |
| R7-T31 | `scripts/check-release-build.test.mjs` | build | A `VITE_UI_GALLERY=1` or `VITE_NEXT_DB_FIXTURES=1` dist is refused by `package` and `experience`. A release dist passes. The harness is absent from `dist/main`. Each unpackaged-only env override is ignored in a packaged launch. |
| R7-T32 | `src/main/migrations/first-launch.perf.test.ts` | packaged, macOS reference | §14.3. |
| R7-T33 | `src/main/services/updates/update-e2e.packaged.test.ts` | packaged, Windows + Linux CI; macOS in the private pipeline (Squirrel needs a signature) | N−1 updates to N through a local generic feed with `stagingPercentage`, and the relaunch runs the migration. **Halt** (review #15): at 0 % a newly checking client is offered nothing; with the feed withdrawn to N−1 likewise; a client that had downloaded N drops it after two consecutive checks and does not install on quit. The capsule does not hold the installer's lock. |

## 16. Amendments this spec requires elsewhere

1. **PLAN.md phase 7:**
   - "NDJSON host" → "the NDJSON-only host path; the compat stream stays (taps)";
   - "migration runs on real data from a backup" → "migration runs on real layouts with synthetic data (§13), plus optional local dogfood runs";
   - "release build smoke on macOS and Windows" → "macOS, Windows and Linux, plus the signed RC in the private pipeline";
   - add "two releases (N, N+1)".

   PLAN "Libraries" row `node-mac-notch` → "does not exist; JXA probe" (also 06:1113).
2. **Spec 00 C.5.** Steps 3 and 4 are registered in N+1, not in "the cut-over build" (D2).
   - Step 4 also writes `threads/<id>.archived` in the same commit as each removal.
   - The runner keeps `backups/migrations/removals.jsonl`, and pruning honours it within the rollback window.
   - C.1's "manual procedure documented in `PARITY.md`" → this spec §12.4 (`--restore-legacy-files`).
   - C.3: "a v1-derived twin whose v1 is gone is cleared" is decided per thread from archive records and clear markers (§9.3).
   - C.9: the 64 MB cap, as the C1 fix log asks.
3. **Spec 00-agent-agui §6.4.** "The `--wire` flag goes" → the flag stays, accepting `agui` and refusing `ndjson` (D4). The spawned-process check compares against baselines after C10 (§8.2).
4. **Spec 00-window-chrome §7.** The completion grep drops the bare `isFullScreen` (F17).
5. **Spec 01 §13 risk "Old boot services not yet ported".** Resolved by C3.
6. **Spec 06 r4.** R6-T33 is extended by R7-T17's scaling matrix. `integrity.ts` requires `notch.html` from API 2 (D3). At C7, `notch.html`'s script path and the notch router plugin move with the tree. Nothing in this spec reintroduces inference or a long-lived haptics process (review #22).
7. **Updater (`apps/updater`).** `buildManifest` requires and cross-checks `renderer/build.json` and `agent/build.json` (D3, C4).

## 17. Acceptance

**Release N (after C14):**

- [ ] §2 entry criteria met, including P1–P5 merged and re-verified; every §3 row closed or carried to N+1 by name.
- [ ] Legacy behaviour was unchanged through C4. C5 is the only behaviour change (D1), and its PR carries the full release-candidate evidence.
- [ ] `DEFAULT_RENDERER_GENERATION` is gone, and the app has one renderer at `src/renderer` loaded from `index.html`, plus `notch.html`.
- [ ] `FOUNDATION_API = 2` in both places; an API-1 experience and a stale tree with a new stamp are both refused (provenance); swaps use the two-stage barrier; a failed candidate never boots after a restart (P3); the activity beacon and continuity work (R7-T2, R7-T3).
- [ ] Every agent spawn is agui. Compat is byte-identical on the 24 goldens and on 3 spawned scenarios × 3 OSes, and tap input matches under fragmented, long and unterminated input (P5). Every tap fires (R7-T5 … R7-T8, R7-T9a; R7-T9b at C10).
- [ ] The §5 greps are empty (R7-T21). knip is clean with dependencies (R7-T22). size-limit is set (R7-T23).
- [ ] Preload exposes `{ abacusHost }` only; the IPC surface is the transport (R7-T19, R7-T20).
- [ ] The window-chrome acceptance (00-window-chrome §12) passes on the packaged RC, including items (A) and (B) (R7-T28, R7-T29).
- [ ] Parity sign-off (§11): every row green, retired or deferred with an owner; each "Parity" row demonstrated on the packaged RC (R7-T25, R7-T30).
- [ ] Upgrade from every retained source-layout fixture, drift, multi-profile, downgrade and re-upgrade all pass (R7-T10 … R7-T13, R7-T11b). First-launch migration is within budget (R7-T32). N reads a home after any partial N+1 commit (R7-T14).
- [ ] Performance: M1–M6 within budget on both reference machines; the phase budgets hold (R7-T24, §14.2).
- [ ] Packaged smoke on 3 OSes with renderer and notch markers (R7-T16). Asar contents are right (R7-T18). No gallery, fixture or harness in the release (R7-T31). The update path N−1 → N works (R7-T33).
- [ ] The signed RC checklist is done on macOS, Windows and Linux hardware (R7-T17). R6-T31's probe records are committed, and the haptics default follows 06 §10.7.
- [ ] `CHANGELOG.md` notes, the support article, and the PLAN, PROGRESS and spec 00 amendments (§16) are merged.
- [ ] `pnpm check` is green, and CI now includes knip, registry and size-limit.

**Release N+1 (after C15):**

- [ ] N at 100 % for ≥ 14 days, with no trigger hit.
- [ ] Steps 3 and 4 registered together with `v1Archived: true`. The repair, the dual-remove and the startup import deleted in the same commit. The fallback reader kept. `--restore-legacy-files` shipped. R7-T14 and R7-T15 green. R7-T10/T11 re-run with N+1.

## 18. Risks

| # | Risk | Mitigation |
|---|---|---|
| R1 | A tap depends on NDJSON ordering relative to something agui changes. Stop and reset now hold admission, a documented divergence. | §8.2 item 5; R7-T7 drives every tap through spawned agents; the goldens cover stop and reset scenarios. |
| R2 | The frozen `.ndjson` oracles cannot grow after C10. New compat scenarios lose independence. | §8.2 item 6: derived baselines are labelled and reviewed. The later taps-to-AG-UI slice removes the need. |
| R3 | The downgrade path breaks because N−1's store readers choke on a field phases 3–5 added (05 attempt ids, 04 checkout fields, 03 looks). | R7-T13 on every RC. Any non-additive schema change needs its own migration step, and the field stays optional. |
| R4 | First-launch migration on a very large home (many GB of transcripts) takes minutes. The runner blocks the main window while it runs. | R7-T32 reports the 50 MB, 200 MB and 1 GB points. If 1 GB exceeds 3 min, step 1 becomes incremental: convert on hydrate, and let the runner do only the index. That decision is made before C14. |
| R5 | The shared experience target (`latest.zip`) makes N−1 clients refuse N experiences at every check for the whole rollout. | §6.4. The cost is measured in R7-T3. Staged rollout keeps the window short. |
| R6 | The JXA probe or haptics trigger a TCC prompt on a notarized build. | R7-T17 on the signed RC. Per 06 r4, a failed probe disables the companion on that display (no inference), and haptics default off beyond 150 ms latency. |
| R7 | Turns added under N−1 to a thread N already owned are not shown after re-upgrading. The model context has them. | Documented (§12.3). A later relay change can append v1-newer segments to an `agui` thread on hydrate if support sees it. |
| R8 | Cleared or archived history is misread across partial commits, downgrades and failed AG-UI deletions. | Orphans and markers are on HEAD. C1 adds per-thread archive records and marker-retirement proof. N decides each thread from them. R7-T14 checks after every partial commit and kill point (§9.3). |
| R9 | A gallery or fixture dist reaches a release because the screenshot and acceptance runs share `dist/renderer`. | C4's guard in `beforePack` and `build-experience.js` (R7-T31). |
| R10 | A prerequisite (P1–P5) slips, and the flip ships with it open. | §2 item 2 makes each an entry criterion with an owner. The C5 gate re-runs their tests (R7-T3, R7-T7, R7-T14, R7-T27). The relay findings are fixed on HEAD (relay fix log r1 and r2). |
| R11 | A user on a slow link is mid-download of the N−1 experience when N arrives. | Experiences are version-pinned; the N−1 bundle is refused on N and the N target replaces it. Nothing to do. |
| R12 | Removing `'unsafe-eval'` breaks transformers.js (dictation) in some path. | C12 narrows it only if R7-T16/T30 pass with `'wasm-unsafe-eval'`, including a dictation run; otherwise it is kept. |
| R13 | A `framer-motion` removal attempt also drops `motion`'s own copy. | F14: only the direct dependency is removed; `pnpm-workspace.yaml:69` stays; knip keeps `motion`. |
| R15 | The perf fixture cannot reach the shell offline on the source build (§13.3 step 3). | The generator fails loudly, and C5's gate names the blocker. M1–M5 are never measured on the onboarding fixture (review #20). |
| R16 | A user misses the 30-day window after N+1 and then needs N−1. | Backups the index references are kept 30 days after the step is applied. Beyond that, N (no restore needed) is the floor. The support article says so. |
| R14 | Windows `--compat-fd 3` behaves differently on some machines (AV hooks on pipes). | Inline mode exists (agent spec :373-377); R7-T6 runs both modes on Windows; `compat_lost` is a rollout trigger. |

## 19. Open questions for the coordinator

1. §2 item 4: will `rewrite/renderer` ship in a dormant release before the flip? That makes steps 1–2 field-proven and gives §13 its dormant fixtures.
2. §14 budgets are relative to the last shipped build, because the repo records no absolute cold-start or memory numbers. Should absolute caps be set after the first C5 measurement?
3. The 150 MB notch renderer RSS cap is a proposal pending R6-T27's measurement.
4. The rollout stages and the N+1 soak (≥ 14 days at 100 %) are proposals for the release manager.
5. The fallback reader's 512 MB streaming ceiling and its "too large" notice (C15) need a design owner for the copy.

## Review responses (r1)

Source: `docs/rewrite/specs/reviews/07-cut-over.codex-r1.md` (25 items: 3 blockers, 18 major, 4 minor), reviewed against `c46e77d9`. The coordinator's decisions:
- #1: durable per-thread archive provenance in N;
- #3: keep a fallback v1 reader;
- #4: adopt HEAD's marker and token protocol;
- #5, #6: restore paths from recorded roots, plus an index of every committed removal;
- #8: keep the read-only startup import through N;
- #12: two Vite inputs;
- #13: a two-stage barrier;
- #14: build-time provenance;
- #15: withdraw, or percentage 0;
- #16, #17: the legacy inventory and parsed specifiers;
- #18: keymap, then delete;
- #19: split R7-T9;
- #20, #21: separate, immutable fixtures;
- #22: follow 06 r4;
- #24: knip project scope;
- #25: exact ids and resolved consumers.

Items #2, #7, #9, #10 and #11 are code defects on HEAD, routed to implementation agents. They are recorded here as prerequisites P1–P5 with their owners, not as cut-over PR work.

| # | Sev. | Verdict | What changed |
|---|---|---|---|
| 1 | Blocker | **Accepted** | D2 (a); C1 `threads/<id>.archived`, committed with each removal; §9.3's per-thread rule replaces r1's "step 4 applied" switch; R7-T14 checks N after every partial commit and kill point; R7-T15 checks N without a restore. |
| 2 | Blocker | **Accepted, routed** | Prerequisite **P1** (§2, register row 56): only absence reads as empty, and an unlistable directory stops orphan removal and completion; injected `EACCES`/`EIO` in R7-T14. |
| 3 | Blocker | **Accepted** | D2; C15 keeps a read-only fallback v1 reader: streaming above 64 MB up to 512 MB, then a notice with Show in folder; unreadable files retried; removal deferred until field logs show no retained sources. R7-T14 covers oversized, unreadable and failed sources. |
| 4 | Major | **Accepted** | C1 keeps HEAD's `threads/<id>.cleared` and token protocol. The r1 `.cleared/<id>` and mtime prescription is withdrawn. Step 4 retires a marker only when neither pre-clear file remains; a failed AG-UI deletion keeps it (§9.3, R7-T14). |
| 5 | Major | **Accepted** | F22; §12.4 derives destinations from each removal's recorded root, per profile (`userData` = `<home>/electron`). R7-T15 runs the published command and appendix verbatim on two profiles. |
| 6 | Major | **Accepted** | D2 (b); C1 `removals.jsonl`, rebuilt from `commit.log` after a torn tail; pruning honours it; §12.4 restores every attempt oldest-first with collision handling; R7-T15 covers partial commits and an interrupted recovery. |
| 7 | Major | **Accepted, routed** | Prerequisite **P2**: refuse or durably journal history changes on held threads; R7-T14 covers send, reset and quit while unresolved. r1's "defers until the next launch" is removed from C1. |
| 8 | Major | **Accepted** | D2 (c); C11 keeps the read-only, provenance-aware startup import through N and removes only the live listener; §5.5; new drift fixture and R7-T11b. |
| 9 | Major | **Accepted, routed** | Prerequisite **P3** (transactional activation, or restore on `SwapNotReady`); R7-T3 adds a full restart after a failed swap. |
| 10 | Major | **Accepted, routed** | Prerequisite **P4** (authoritative turn-state source); keep-awake is removed from C2; R7-T27 checks both pipe orderings. |
| 11 | Major | **Accepted, routed** | Prerequisite **P5** (incremental decoding, overflow and EOF on both pipes); §8.2 item 4 states what byte identity covers; R7-T7 drives taps through the manager with fragmented, long and unterminated input. |
| 12 | Major | **Accepted** | D10; C6 keeps `main` and `notch` inputs; its gate and R7-T18 require both HTML files in the packaged app and the experience. |
| 13 | Major | **Accepted** | D11; C3 defines stage 1 (readiness), then capture, then stage 2 (the restore promise, bounded), then the flip; readiness never waits on restoration; R7-T3 asserts the observed order. |
| 14 | Major | **Accepted** | D3; C4 writes `build.json` from the source constants in both builds; `buildManifest` and `integrity.ts` check it; §6.2 item 1 no longer claims the API number catches a restamped tree; R7-T2 packages an old tree with the new builder. |
| 15 | Major | **Accepted** | F23, D9; §12.2 halts with percentage 0 or withdrawal, never a freeze; downloaded builds are dropped by shipped clients after two not-offered checks (`update-service.ts:153-175`), with the residual (quit inside the window, macOS staged) named; R7-T33 covers it. |
| 16 | Major | **Accepted** | §5.1 proof: a legacy inventory with blob shas, resolved module specifiers, and a negative control; R7-T21. |
| 17 | Major | **Accepted** | §5.6: `check-removed-deps.mjs` over parsed specifiers (every import form, CSS) and manifests, with a test of every form; the regular expression is removed. |
| 18 | Major | **Accepted** | C13 is reordered: apply the keymap, compute the final consumer set (literals, plural stems, data-held keys, `i18nKey`, declared or prefix-covered templates), then delete, then remove the lists; R7-T26. |
| 19 | Major | **Accepted** | R7-T9a (C5: absent `--wire` is still ndjson, agui works, CI AG-UI step) and R7-T9b (C10: absent means agui, ndjson exits 64). |
| 20 | Major | **Accepted** | §13.2: a separate `perf-home-v<ver>` with onboarding completed through the source build (§13.3 step 3); M1–M5 never use the onboarding fixture; R15. |
| 21 | Minor | **Accepted** | D7, §13.2: immutable, versioned fixtures per source layout (pre-rewrite, dormant, drift, perf), each with its producer manifest and source-binary hash; new releases add and never replace. |
| 22 | Major | **Accepted** | F15, §10, register row 52, §17 and R6 follow 06 r4: one-shot haptics with the 150 ms default rule, no inference, the companion disabled on a failed probe; the long-lived process and aspect-ratio fallback are withdrawn. |
| 23 | Minor | **Accepted** | Rebased to `c46e77d9`: F1, F3, F6, F8, F12, F13, F15, F16 and new F19–F23; §2 lists the merged fixes; register rows 5, 6, 9–11, 15, 16, 19–22, 26 and 52 marked **Done** or re-pointed, with rows 56–62 added; C1 and C2 no longer prescribe work HEAD has done; the relay and C1 fix logs are cited in the header. |
| 24 | Minor | **Accepted** | C7 replaces `project` and `ignore`, not only entries; R7-T22 plants an unused file in each of main, shared, preload, renderer and scripts and requires knip to report it. |
| 25 | Minor | **Accepted** | D5 and §11: `parity-ids.json` gives the exact expected set; the `PARITY.md` set is enumerated from the bridge before C8; every `file#symbol` resolves through the TypeScript program; R7-T25. |
