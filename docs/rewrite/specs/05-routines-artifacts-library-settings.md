# 05 — Routines, Artifacts, Library, Settings (phase 5)

Status: draft spec **r2** (no code). r2 answers Codex round 1 (`reviews/05-routines-artifacts-library-settings.codex-r1.md`, 19 items) with the coordinator's decisions; responses at the end. Branch `rewrite/renderer`. It implements the "Routines, Artifacts, Library, Settings" phase of `docs/rewrite/PLAN.md` (§Decisions "Library vs Settings", "Sound", "Math", "Editing / sound"; §Where state lives; §Route tree; §Motion system; §Sound; §Areas and parity "Routines", "Artifacts", "Library", "Settings"; §Phases 5; and the Amendments), on top of:

- `00-transport-db-migration.md` **r2** with its implementation notes: sub-slice A (the contract: `routines.*`, `connectors.*`, `messaging.*`, `mcp.*`, `skills.*`, `settings.*`, `update.*`, `localModels.*`, `account.*`, `auth.*`, `referrals.*`, `voice.*`, `memory.*`, `models.*`, `browser.*`, `devices.*`, `terminal.shell.*`, `system.*`, `window.*`; the error model A.5 and the delivery classes A.4.3), sub-slice B (the `routines`, `routineRuns`, `artifacts`, `prefs`, `workspaces`, `memories`, `sessions`, `bots` tables, `ipcCollectionOptions`, prefs provenance per leaf, `updatePrefs(patch)`, read-only fields, caller ids, the 2 s artifact re-diff, the 60 s routine re-diff), sub-slice C (the live legacy prefs sync);
- `01-renderer-foundation.md` **r4** as implemented (phase 1 is merged: `src/renderer-next/routes/_shell/{(routines),(artifacts),(library),settings.*}` placeholders, `features/{routines,artifacts,library,settings}` stubs, `lib/sound.ts` gating, `lib/navigation/search.ts`): folder rules (§4), routes, masks, `PANE_BOUNDARIES`, navigation types and the `settings-in`/`settings-out` transitions (§6), shell, sidebar slot and title bar (§7), sound and motion modules (§7.8), hotkeys (§7.9), data layer (§8), i18n (§9), gallery and screenshots (§10), tests (§11);
- `02-chat-kit.md` **r4**: `ChatView` read-only (`composer.readOnly`), `slots.header`, the bot skin (for routine run reports);
- `03-bots.md` **r2**: its structure and decisions (side-panel content as `?tab=`, un-nested editor routes, TanStack Form 1.33.5 + valibot with parse-on-submit and remote sync without validation side effects, loaders await their own collection preload, `updatePrefs(patch)`, typed errors only, `shared/*` helpers with one-line re-exports from the old tree, `NavList` rows, one item list for context menu and ⋯ menu), and specifically §6.2 and §24 (check-in runs are sessions with `routineId` and `owner: null`), §10 (`shared/bots/schedule.ts` presets, `CHECK_IN_PROMPT`), §11.5 (sender chats and auto-replies at `/bots/$botId/chats/$sessionId`), §12.2 (`components/bot-memory-list`), §15 (`components/connector-mark`), §17 (cue synthesis), §25.3 (per-bot sound levels deferred to here);
- `04-sessions.md` **r1**: `components/file-preview` (artifact previews), the OSI-licence small-library rule (04 F2, §26.8), `features/sessions/notify.ts`, the settings pages it deferred (browser, devices, terminal shell, notifications; 04 §27.3), and the session read-only route for runs (04 S64, §17.3).

Paths are relative to `apps/desktop/` unless noted. Code in this spec is type declarations and short sketches only.

**Sources read for this spec** (versions are what is installed, checked on 30 Sep 2026):

| Source | Version / commit | Where |
|---|---|---|
| Old renderer, routines | `HEAD 4859cf03` | `src/renderer/router.tsx:215-231,425-430`, `components/routines/{routine-page,routine-runs-rail,routines-tree}.tsx`, `components/settings/{routines-panel,routine-schedule,routine-templates}.ts(x)`, `hooks/use-routines.ts`, `components/chat/{injected-text,chat-panel}.tsx` (read-only runs), `locales/en-US.json` (`routines.*` from `:1379`), their tests; main `services/agent-tools/{cron-store,cron-scheduler,routine-guards,routine-prompt}.ts`, `service-host.ts:3596-3803` |
| Old renderer, artifacts | same | `components/workspace/artifacts-panel.tsx` (the only artifacts surface, routed at `/settings/artifacts`, `router.tsx:432-442`), `utils/preview-utils.ts:127-190`, `utils/open-local-file.ts`, `hooks/use-workspace-queries.ts:117-129`; main `services/session/{session-artifacts-service,session-artifacts.utils}.ts`, `rpc/tables/index.ts:71-77,152-156,275-279` |
| Old renderer, capabilities | same | `components/settings/{connectors-panel,messaging-connectors,capabilities-panel}.tsx`, `components/connectors/connect-flow.tsx`, `components/chat/connector-request-card.tsx`, `components/mcp/{mcp-management-panel,mcp-server-form,abacus-connectors-summary}.tsx`, `components/skills/skills-management-panel.tsx`, `components/layout/in-pane-settings.tsx`, `hooks/{use-connector-statuses,use-mcp-runtime}.ts`, `packages/connectors/src/registry.ts` |
| Old renderer, settings | same | `components/settings/{settings-menu,profile-panel,models-panel,provider-key-dialog,notification-settings-dialog,memory-panel,usage-panel,referrals-panel,changelog-panel}.tsx`, `components/local-models/*`, `components/browser/browser-settings-dialog.tsx`, `components/device/device-settings-dialog.tsx`, `components/common/{update-pill,critical-update-dialog,update-stalled-banner,home-update-banner,use-update-status}.ts(x)`, `hooks/{use-theme,use-sandbox,use-abacus-account,use-local-models,use-model-providers,use-notifications}.ts`, `stores/{language-store,account-store}.ts`, `lib/{abacus-credits,browser-homepage,changelog,settings-query-keys}.ts` |
| Shared and main | same | `shared/{routines,settings,update,local-models,account,exec-backends,messaging,toolsets,skills-types,voice}.ts`, `shared/contracts.ts` (`SessionArtifact:480-493`, `RoutineRunItem:321-328`, `BotSenderChat:304-316`, `ConnectorStatus:787-802`, `McpServerEntry:855-867`, `AgentMcpServer:1281`, `UsageSnapshot:1529-1658`, `AbacusAccountInfo:1577-1593`, `ExecBackendState:2110`), `main/index.ts:370-380,1385-1395` (notification sound), `main/window-chrome-settings.ts` (titlebar density), `main/index.ts:1884-1892` (`settings:set-titlebar-density`, raw IPC, not in the contract) |
| Contract (implemented) | same | `shared/contract/{routines,connectors,messaging,mcp,skills,settings,update,local-models,account,auth,referrals,voice,memory,models,system,window,db,rows,ids}.ts` |
| renderer-next (implemented, phase 1) | same | `routes/_shell/{(routines),(artifacts),(library)}/*`, `routes/_shell/settings*.tsx`, `features/{routines,artifacts,library,settings}/index.tsx`, `lib/{sound,navigation/search,navigation/areas}.ts`, `data/{db,collections}/*` |
| `@tanstack/react-form` / `valibot` | 1.33.5 / 1.5.0 installed | as 03 F1 |
| `@tanstack/react-hotkeys` / `@tanstack/hotkeys` | 0.12.1 / 0.10.1 installed | `react-hotkeys/dist/useHotkeyRecorder.d.ts:3-53` (`useHotkeyRecorder` → `{ isRecording, recordedHotkey, startRecording, stopRecording, cancelRecording }`), `hotkeys/dist/conflicts.d.ts:5-35` (`findHotkeyConflicts`), `validate.d.ts:23-56` (`validateHotkey`), `format.d.ts` (`formatForDisplay`), all re-exported (`react-hotkeys/dist/index.d.ts`: `export * from "@tanstack/hotkeys"`) |
| `motion` | **13.4.6 installed** (depends on its own `framer-motion` 13.x under `node_modules/motion/node_modules/`) | `LayoutGroup`, `AnimatePresence`, `useReducedMotion` |
| `react` | **19.3.0 installed** | `ViewTransition`, `addTransitionType`, `Activity` |
| `qrcode` | 1.5.4 (MIT), main only | `main/services/messaging/abacus-channels-connector.ts:2,204` builds the Telegram QR as a data URL; the renderer draws an `<img>` |
| `@abacus-ai/connectors` | `workspace:*` | `packages/connectors/src/registry.ts` (kinds, `ConnectorCategory` `:22-32`, `connectUi`), exported as `./registry` (`packages/connectors/package.json:7-11`) |
| Electron | 44.4.5 installed | `electron.d.ts:1791` `app.setLoginItemSettings` (`@platform darwin,win32`), `:1282` `getLoginItemSettings`, `:1700` `app.setBadgeCount` (`@platform linux,darwin`), `Notification` `silent?: boolean` |
| Design canvas | artifact `XpL2PgWae6rUjXDTWyUqYX`, version `1790747894-aeaf` | page 1 (`Routines`, `RoutineCreate`, `RoutineStates`), page 9 (`Artifacts`, `ArtifactsPreview`, `ArtifactsStates`), page 7 (`SettingsInPlace`, `SettingsGeneral`, `SettingsAppearance`, `SettingsNotifications`, `SettingsMemory`, `SettingsUsage`, `SettingsAccount`, `SettingsSignedOut`, `SettingsModels`, `SettingsEnvironment`, `SettingsAbout`, `SettingsConnectors`, `ConnectorStates`, `SettingsMessaging`, `SettingsMCP`, `SettingsSkills`), page 8 (`ConnectorIcon`, `BotAvatar`, `Rail`, `TopBar`) |
| Reference screenshots | `scratchpad/refs/gpt-13-settings.png`, `gpt-14-back.png` | the ChatGPT app: settings nav replaces the sidebar (rail stays), the page sits in the main pane, back in the title bar |
| Reviews | all 34 files | `docs/rewrite/specs/reviews/*` (defect classes applied in §32.4) |

---

## 0. Findings that change the brief (read first)

Each was checked against source. The ones that change another spec are repeated in §31.

| # | Brief / plan / earlier spec says | Verified fact | Consequence here |
|---|---|---|---|
| F1 | "schedule editor (cron/natural language as today)" | There is **no natural-language schedule parser and no cron library** anywhere (no `cronstrue`, `croner`, `cron-parser`, `chrono` in `apps/desktop/package.json`). The form is presets over five-field cron (`composeCron`/`decomposeCron`, now `shared/bots/schedule.ts`, 03 §10) plus "Custom" (a raw cron) and "Once" (`runAt`); main validates with its own `parseCron` (`main/services/agent-tools/cron-store.ts:116-259`: `*`, ranges, lists, steps; weekday 7 = 0; both day fields restricted → OR) and throws plain `Error`s ("Expected five fields…", "Names like MON or JAN are not supported…"). The only natural-language path is **edit-by-chat** (`routines.editByChat`, an LLM turn restricted to the cronjob tool on that routine, `service-host.ts:3596-3666`). | No library. `parseCron`/`nextRun` move to `shared/routines/cron.ts` (pure, main re-exports it) so the form validates exactly as main does and previews "Next: Tomorrow, 8:00" (§8.3). Natural language stays edit-by-chat (§7.6). Main maps cron parse failures to `BAD_REQUEST { field: "schedule", detail }` (§31.5); the UI never parses the message. |
| F2 | Foundation §6.1: `routines._list.new` is a masked **Sheet** | Canvas `RoutineCreate` draws a **centred 640 px dialog** (radius 16) over the routine page, with Cancel / Create. | The create pop-up is a registry `Dialog` (masked route kept). Edit is the same form in a second masked dialog, `/routines/$routineId/edit` (§5.1). |
| F3 | Canvas `RoutineCreate`: "Run by {bot}" picker and "Deliver to Slack #me" toggle; `Routines` "Delivers to" card | `Routine.botId` is **provenance, not a target** (`shared/routines.ts:26-27`: "The bot that made this routine… Provenance, not a target"); main runs every routine as a fresh session with `owner: null` (`service-host.ts:3846-3851`). No routine field describes delivery: delivering to Slack is words in the prompt. | "Run by" and "Deliver to" are **not built** (§32.3); the page shows "made by {bot}" read-only (parity) and the instruction text. Building them would change what a routine is. |
| F4 | PLAN route tree `routines.$routineId (search: { run?: id })`; brief "run history joined to sessions by routineId (per 03-bots §24)" | Runs are sessions (`db.routineRuns` rows keyed by `sessionId`, `routineId`, `outcome`, `trigger`, `startedAt`; derived from `sessions`, spec 00 B.2). `RoutineRow.recentRuns` (≤ 20, `{ at, trigger, result }`) holds the one-line result but **no session id**, so the two lists cannot be joined reliably; the old page showed only outcome + trigger from runs. The old run view is the run's session rendered read-only in `ChatPanel` (`chat-panel.tsx:878-879, 2168-2290`), with "A run of this routine. It's a report, not a conversation." | The runs list reads `routineRuns` where `routineId` (the join 03 §6.2 uses); `?run=<sessionId>` opens the **run report** beside the routine (canvas: a 420 px panel) as a read-only `ChatView` of that session (§7.4). Attempts that never made a session (an overlapping fire "skipped: the previous run is still going", "no workspace to run in", `service-host.ts:3874-3914`) exist only in `recentRuns`. So the list is built from attempts: main gives each `CronRun` a stable `id` and a nullable `sessionId`, and notifies `routineRuns` on cron writes (§31.5 f); an attempt with a session opens its report, one without shows its result only. |
| F5 | Foundation `ArtifactsSearch.type ∈ document|deck|image|code|other`, `from ∈ bots|sessions` | The data has only `kind: "file" | "image" | "link"` (`contracts.ts:478`) and **no bot/source field**; the canvas sidebar filters **Type: All / Files / Images / Links** (with counts) and **From: each bot, each workspace** (`Artifacts`). | `ArtifactsSearch` becomes `{ type?: "file"|"image"|"link", from?: "bot:<id>"|"workspace:<id>", q?, item?, view?, sort? }` (§5.2, amendment §31.1). "From a bot" is derived by joining `sessionId` → `SessionRow.owner.botId`, and routine runs → `RoutineRow.botId`. |
| F6 | Canvas `ArtifactsStates`: "Missing file … This file is no longer on disk. [Remove]"; row menu "Remove from artifacts"; card sub-lines "PDF · 412 KB", "1440 × 900" | Main **filters missing files out** of the ledger (`session-artifacts-service.ts:56-71`, `existsSync`), and the table re-diffs every 2 s while read (`rpc/tables/index.ts:71-77`), so a deleted file's row disappears by itself; there is **no remove procedure** (`db.artifacts` is read-only, `shared/contract/db.ts:207-208`); rows carry no size, MIME or dimensions. | The missing state appears only when opening races a deletion (the old probe: `files.readText({ maxBytes: 1 })` → `not-found`, parity) as an inline notice. "Remove" and "Remove from artifacts" are not built (§32.3). Sub-lines show a format label from the extension ("PDF", "Markdown", "Spreadsheet", "Image", "Web page"), never a size. |
| F7 | PLAN: Library = connectors, messaging, MCP, skills, tools; canvas settings boards draw those pages under **Settings › Capabilities** (`SettingsConnectors`, `SettingsMCP`, `SettingsMessaging`, `SettingsSkills`) | PLAN rev 6 and the user decision are newer than the boards. Today Messaging has **no page**: it is a section plus dialogs inside Connectors (`connectors-panel.tsx:400-475`, `messaging-connectors.tsx`). Tools live at `/settings/tools` with the **execution backend and terminal shell** inside the terminal toolset's page (`capabilities-panel.tsx:299,325-513`). | The boards' page contents are used under the **Library** rail item with the `LibrarySidebar` (§12–§16). Messaging becomes its own page `/library/messaging` (§13). The execution backend and terminal shell move to Settings › Execution backend (§20.1), with a link from the terminal toolset's page. |
| F8 | Brief: settings "replace the sidebar with a settings nav and show the page in the main pane with back in the title bar" | Canvas `SettingsGeneral` etc.: the sidebar slot holds "Search settings" and groups Personal / Capabilities / Environment / App; the rail stays with no top item active; `SettingsInPlace` shows "Back to the app" in the title bar. The ChatGPT reference (`gpt-13-settings.png`) is the same shape. Foundation already routes `/settings/*` with `staticData.sidebar: "settings"` and `settings-in`/`settings-out` transitions (01 §6.7). | The settings nav is **Personal** (General, Appearance, Notifications, Memory, Usage, Account), **Models**, **Environment** (Execution backend, Browser, Devices), **App** (Language, Keyboard, About); Capabilities is a single link row "Library" (F7). The title bar's leading back button becomes **Back to the app**, returning to the last location outside Settings (§17.2). No floating window. |
| F9 | Brief: "settings pages (appearance, models incl. local models, account, updates, sandbox/network, notifications/sounds, keymap, language, memory, usage, about, environment)" | The old renderer has **no** General, Appearance, Environment, Updates, Keymap or About page: theme and language are account-menu submenus (`settings-menu.tsx:218-266`); the default permission mode is on Profile (`profile-panel.tsx:55-102`); updates are ambient surfaces only (pill, composer strip, home banner, critical dialog, stalled banner); "About…" opens the native panel (`window:show-about`). There is **no settings UI for a network allowlist or environment variables** (network hosts are per-session "Always allow this host" answers, 02 §6.4). | Those pages are **New** (canvas). Parity rows keep every old behaviour and say where it moved (§2.4). No network-allowlist page is invented (§32.3); Environment shows the sandbox status line. |
| F10 | Canvas `SettingsAppearance`: Density, Accent, Text size, Reduce motion, "Bot colour in bubbles" | Density exists in main (`main/window-chrome-settings.ts`, `setTitlebarDensity`, electron-store `settings.json`) behind a **raw** `ipcMain.handle("settings:set-titlebar-density")` that is **not in the contract** and has no renderer caller (`main/index.ts:1884-1892`). `PrefsRow` has `motion.reduce` but no accent, text size or bubble-tint field (`shared/contract/rows.ts`). A global accent would hand-tune the registry's neutral tokens, which foundation §5.3 forbids. | Density → new procedure `window.setDensity` (§31.5). Text size and bubble tint → new prefs leaves `appearance.textSize`, `appearance.bubbleTint` (§31.5). Reduce motion → `prefs.motion.reduce`. Accent → **not built** (§32.3). |
| F11 | Canvas `SettingsGeneral`: "Launch at login", "Keep running in the menu bar", "Notch companion"; `SettingsNotifications`: "Show in the notch", "Badge the dock icon" | Nothing in main sets a login item, creates a `Tray`, or sets a badge (`grep` of `src/main`: no `setLoginItemSettings`, no `new Tray`, no `setBadgeCount`). Electron provides `app.setLoginItemSettings` on macOS and Windows only and `app.setBadgeCount` on Linux and macOS (`electron.d.ts:1791,1700`). The notch is phase 6. | "Launch at login" → new `system.loginItem.get/set` (§31.5), hidden on Linux. Menu bar, dock badge → not built (§32.3). Notch rows → phase 6 (the rows are reserved, not rendered). |
| F12 | PLAN Sound: "per-event switches, per-bot level (all / needs-me / nothing), quiet hours shared with the notch; OS notifications carry no sound of their own"; canvas `SettingsNotifications` per bot: "All / Digest only / Mentions" | `PrefsRow.sounds = { enabled, perEvent }` only. Main's notifications play the OS sound unless `settings.notifications.sound` is false (`main/index.ts:1389-1394`, `silent: !prefs.sound`); the old "Play a sound" switch means that OS sound. Canvas's "Digest only / Mentions" have no producer (there are no digests or mentions). | Levels are PLAN's three. New prefs leaves `sounds.perBot` and `sounds.quietHours` (§31.5); `lib/sound.ts` and the notification helpers gate on them (§23). In the new generation main sends every notification `silent` (the renderer's cue is the sound) (§31.5). "Play sounds" writes `prefs.sounds.enabled`. |
| F13 | Brief: "keymap … prefs with provenance" | There is no keymap today; shortcuts are fixed in foundation §7.9 (`Mod+K`, `Mod+N`, `Mod+B`, `Mod+Alt+B`, `Mod+,`, `Mod+.`). Provenance is **per leaf** and a record is **one leaf** (spec 00 B notes: `workspaceExpanded`, `panes`, `sounds.perEvent` are whole leaves). `@tanstack/react-hotkeys` 0.12.1 ships `useHotkeyRecorder`, and `@tanstack/hotkeys` 0.10.1 `findHotkeyConflicts` and `validateHotkey` (typings cited in the sources table). | New leaf `keymap: Record<ActionId, string | null>` (a record of overrides; absent = default, `null` = unbound). Provenance therefore covers the whole map: once any shortcut is changed in the new UI, the map is `user` and a legacy import can never touch it (there is no legacy keymap, so nothing is lost). The Keyboard page records with `useHotkeyRecorder` and checks conflicts against the app's own action table (§21.3). |
| F14 | Canvas `SettingsUsage`: "Daily activity" stacked by provider; "By bot and session" | `UsageSnapshot.daily` is one series per day (`requests`, `errors`, `tokens`, `cost`); `models[]` is per model; nothing is per provider-per-day or per bot/session (`contracts.ts:1529-1658`). The old page draws hand-rolled div bars; no chart library is installed. | The chart is one series (requests) with errors overlaid, drawn in SVG by a molecule (no dependency); the breakdown is **by model** (parity). "By bot and session" is not built (§32.3). |
| F15 | Canvas `SettingsModels`: "Rate limited", "Check" (verify a key) | No procedure reports a provider's rate-limit state or verifies a key; the old dialog shows "Saved, not checked" with the tooltip "The app checks this key when you send a message." (`models-panel.tsx`). | Rows show Connected / Saved, not checked / Add key (parity). "Rate limited" and "Check" are not built (§32.3). |
| F16 | Canvas `SettingsSkills` "Update available", "Installing…"; `ConnectorStates` "Used by", scope toggles, toast "Undo" | No skill update information exists (`InstalledSkill` has no version, `skills-types.ts:7-15`); no per-bot connector list (03 §25.3); connector scopes are not per-user toggles (the registry's `PlatformConnector.tools` is a fixed list); disconnect has no undo. | Skills show Installed / Installing (the install mutation's pending state). The connector sheet lists the connector's tools read-only under "What it can do". "Used by", scope toggles, "Update available" and toast Undo are not built (§32.3). |
| F17 | Library › MCP "Status updates live" | MCP runtime state is **per session**: `mcp.runtime.servers({ workspaceId, sessionId })`, `mcp.refresh`, `mcp.restart` need a running session (`shared/contract/mcp.ts`); the old panel used the active session and disabled Refresh without one (`mcp-management-panel.tsx`, "Start a session to refresh MCP servers."). | The page picks a **runtime scope**: the most recently active running session (from `sessionsCollection`), switchable in a menu; with none running, statuses read "Not connected" and Refresh/Restart are disabled with the old copy (§14.2). |
| F18 | Two data layers in renderer-next | Phase 1 implemented `data/collections/` (context-provided collections, a **recipe** `updatePrefs`, `data/collections/prefs.ts`), while sub-slice B implemented `data/db/` with `updatePrefs(patch: PrefsPatch)` (`data/db/tables.ts:385-420`), which is the only writer that records provenance for same-value choices. 03 and 04 import `#next/data/db`. | This spec imports `#next/data/db` and uses `updatePrefs(patch)` everywhere; phase 1's `AppearanceTheme` moves to it (it currently writes a recipe). Retiring `data/collections/` is foundation's item (03 §24.1), restated in §31.1. |
| F19 | "connector auth flows (the sign-in windows main owns)" | Platform connectors open the **system browser** (`abacus-connector-service.ts:410`, `shell.openExternal`, main waits 20 min); MCP OAuth also uses the system browser with a loopback listener on 33418 (`mcp-oauth-service.ts:24,390`); messaging logins open the platform's own web login **in an app window** (`messaging.showLogin`), with main polling login every 1.5 s; Abacus sign-in opens an app window or the browser (`auth.abacus.start`, `openInBrowser`). The old renderer watches a browser hop for 3 min (`CONNECT_WATCHDOG_MS`, `connectors-panel.tsx:84`). | The renderer never opens those windows; it calls the procedure, shows a waiting state with Cancel (`connectors.cancelConnect`, `auth.*.cancel`), and keeps the 3 min watchdog (§12.4). |
| F20 | Old routine sidebar section and `/settings/jobs` | The routines area today is a sidebar accordion section plus a settings page with stats tiles, cards, an auto-replies section and a template shelf (`routines-panel.tsx`), and a routine page with a runs rail (`routine-page.tsx`, `routine-runs-rail.tsx`). | One sidebar for the Routines rail item (canvas `Routines`: search, stats line, routine rows, Auto-replies group, New routine), and the routine page with runs and the run report (§6, §7). The template shelf moves into the create dialog (canvas "Or start from a template"). |

---

## 1. Scope

### 1.1 In scope

- **Routes** (§5): `/routines` (index, masked create, `$routineId` with `?run=`, masked edit), `/artifacts` (with `?item=` preview), `/library/{connectors,messaging,mcp,skills,tools,tools/$toolsetId}` (with their search-driven sheets and dialogs), `/settings/*` (thirteen pages plus What's new), with loaders, preload guards, search schemas, masks, pane boundaries, navigation types, not-found and deleted-while-open behaviour.
- **Data** (§9, §10.3, §12.2, §13.1, §14.1 and each settings page's source column): collections and queries, every mutation with its optimistic row, echo and failure, conflict and `NOT_FOUND` handling, invalidation sources.
- **Routines** (§6–§9): sidebar with stats and auto-replies, routine page, runs joined to sessions, run report, edit-by-chat, create/edit form with the schedule editor, webhook URLs.
- **Artifacts** (§10–§11): ledger grid/list, filters, search, preview beside the list, open/reveal/copy, go to session, empty/no-match/missing.
- **Library** (§12–§16): connectors with the sheet and every auth flow, messaging channel setup, MCP server management with live runtime status, skills, tools.
- **Settings** (§17–§21): the settings shell (nav, search, back), and every page including theme/language/keymap prefs, local models, updates, sound settings with a preview.
- **Cross-cutting**: the connector request card's remaining uses (§12.7), sound cues and gating (§23), motion (§24), i18n (§25), a11y (§26), gallery (§27), tests (§28), scaffold order (§29), acceptance (§30).

### 1.2 Out of scope

The notch and its settings rows (phase 6), onboarding and the tour ("Replay the tour" is phase 6), sessions and bots routes (phases 3–4; this phase only links to them), the chat kit (phase 2; only the amendments of §31.2), and everything listed in §32.3 (canvas elements without data or backend).

### 1.3 Gate (PLAN phase 5)

"All as routes; connector sheet masked; update states; account/credits; sounds and notification prefs. Gate: parity for the remaining IPC groups; every locale key accounted for." Concretely: every §2 row is green in `parity.ts` (R5-T38); `PARITY.md` rows for `routines.*`, `connectors.*`, `messaging.*`, `mcp.*`, `skills.*`, `settings.*`, `update.*`, `localModels.*`, `account.*`, `auth.*`, `referrals.*`, `memory.*` (global), `browser.*` settings rows, `devices.setEnabled/setApproval`, `system.logs.save`, `window.showAbout` name their renderer-next consumer or retirement; `check:locales` shows every `en-US` key either used by renderer-next, mapped by the keymap, or listed as retired (R5-T35); before/after screenshots of every board in §30 at the foundation widths and both themes.

---

## 2. Parity table

Every behaviour of today's routines, artifacts, capabilities and settings surfaces, where it lands, and its status. "New" rows are canvas behaviours that did not exist; "Changed" rows are intended changes with their owner (PLAN, canvas, user decision, or a named finding); "Retired" rows have a reason. The table is also `features/{routines,artifacts,library,settings}/parity.ts` as data, which R5-T38 checks: every row names an existing route, component or test id. Citations are against `HEAD 4859cf03`, paths under `src/renderer/` unless noted.

### 2.1 Routines

| # | Today (file:line) | New route / component | Status |
|---|---|---|---|
| RT1 | Sidebar accordion section "Routines" with count, "+" → `/settings/jobs`, hidden when empty, opens itself on a routine route (`routines-tree.tsx:43-136`, `workspace-sidebar.tsx:62,133-136`) | `RoutinesSidebar` for the Routines rail item: "Search routines", stats line, rows, Auto-replies group, "New routine" (canvas `Routines`) (§6) | Changed (user decision "one sidebar per rail item") |
| RT2 | Routine row: CalendarClock icon + name, paused at 60% opacity with title "Paused", active highlighted and scrolled into view (`routines-tree.tsx:138-165`) | 56 px row: avatar or routine tile with a state mood, name, schedule/state line, state dot (§6.3) | Parity + New (states) |
| RT3 | Auto-reply row "sender · platform", pulsing while busy, paused dimmed, title "{{bot}} auto-replies to {{sender}} on {{platform}}", opens `/routines/chat:<sessionId>` (`routines-tree.tsx:37-41,167-207`) | Auto-replies group rows "{bot} → {sender}", "on {App} · On/Paused", `ConnectorMark`; link to `/bots/$botId/chats/$sessionId` (03 F8, §11.5) (§6.4) | Changed (03 F8: the sender-chat view is the bots route) |
| RT4 | Stats tiles Active / Paused / Fires today (runs since local midnight) (`routines-panel.tsx:194-239,340-357`) | stats line under search: "{n} active · {n} fire today · {n} paused" (canvas); "fire today" = routines with a run since local midnight **or** a `nextRunAt` before the next midnight (§6.2) | Changed (canvas; counts future fires too) |
| RT5 | Empty: "No routines yet. Create one, or ask a bot to schedule something." (`routines-panel.tsx:241-245`) | canvas `RoutineStates` empty: asleep avatar, "No routines yet", "Create one, or ask a bot to schedule something: “every weekday at 9, summarise my inbox.”", New routine (§7.1) | Parity (canvas copy) |
| RT6 | Routine card: name, bot badge, webhook globe, prompt clamp, schedule, Next, Last, Run now, Edit, Delete, enabled Switch (`routines-panel.tsx:416-581`) | routine page header (avatar 40, name, "{schedule} · runs in {folder} · made by {bot}", Run now, Edit, Switch) + Next / Last / Trigger cards + Instruction (§7.2) | Parity (canvas layout) |
| RT7 | Webhook URL in `<code>` with copy; pending "Creating your public webhook link…"; toast "Webhook URL copied." (`routines-panel.tsx:477-503`) | Trigger card shows the webhook URL + Copy (and "Copy URL" in the row menu); same pending copy and toast (§7.2) | Parity |
| RT8 | Card's inline "{{count}} recent runs" with time, trigger badge, result (`routines-panel.tsx:545-578`) | Runs list on the page: every recorded attempt (`recentRuns`, with stable attempt ids after §31.5 f) joined to its session in `routineRuns` when it has one (§7.3); sessionless attempts (skipped, no workspace, failed to start) stay listed | Parity |
| RT9 | Enable/disable: card Switch, page Pause/Resume button with "Paused" badge; toast "Could not update the routine." (`routines-panel.tsx:252-260`, `routine-page.tsx:161-205`) | header Switch (`aria-label="Routine on"`), row menu Pause/Resume, same toast (§9.2) | Parity |
| RT10 | Run now; toasts "Routine started." / "Could not start the routine."; main skips when a run is in flight (`routines-panel.tsx:261-274`, `service-host.ts:3803`) | header "Run now", row menu; same toasts; the skip is main's and shows as a run with main's result (§9.2) | Parity |
| RT11 | Delete confirm "Delete routine" / "This deletes “{{name}}” and its run history." / Cancel / Delete; inline error "Could not delete the routine."; page navigates to `/settings/jobs` (`routines-panel.tsx:303-335`, `routine-page.tsx:266-297`) | registry `AlertDialog`, same copy; navigate first to the next routine or `/routines`, then delete (§9.2) | Parity |
| RT12 | `RoutineDialog` create/edit: Name, Instruction, Folder (own folder, projects, "Choose a folder…"), Schedule presets Manual/Once/Hourly/Daily/Weekdays/Weekly/Custom with Run at / At / On / Cron, Webhook switch, "Run once now" (create only, on by default), footer note (`routines-panel.tsx:651-1049`) | `RoutineForm` in the masked create and edit dialogs, canvas order: Name, Instruction, Schedule (segmented Hourly … Custom), At / On / Run at / Cron with a live "Next:" preview, Folder, Webhook, "Run once now" (create) (§8) | Parity + New (next-fire preview) |
| RT13 | Validation: "An instruction is required.", "A cron expression is required.", "Pick a date and time to run at.", "That time has already passed.", server `error.message`, "Could not save the routine." (`routines-panel.tsx:769-776`) | valibot schema with the same messages; cron validated by the shared parser (F1); server `BAD_REQUEST {field}` on the named field; other errors → "Could not save the routine." (§8.4) | Parity (typed errors, F1) |
| RT14 | Template shelf "Or start from one of these" with 6 templates, "Reads from {{names}}", project needed → active workspace (`routines-panel.tsx:586-635`, `routine-templates.ts`) | "Or start from a template" chips in the create dialog (canvas), same 6 templates moved to `shared/routines/templates.ts`; a project template picks `prefs.lastPickedWorkspaceId` (§8.6) | Parity (canvas placement) |
| RT15 | `describeSchedule`: "Once on …", "On demand", "Every hour", "Daily at …", "Weekdays at …", "{{day}}s at …", raw cron (`routines-panel.tsx:380-414`) | `scheduleLabel(row, locale)` ported with its cases; custom cron shows "Custom: {cron}" (§8.5) | Parity |
| RT16 | Page header "· made by {{bot}}", "· runs in {{folder}}" for project workspaces; missing routine "This routine is gone." (`routine-page.tsx:75-226`) | same header; `notFoundComponent` "This routine is gone." + link to Routines (§5.5) | Parity |
| RT17 | Runs rail grouped Running / Completed / Failed, Intl stamp, "outcome · trigger", `aria-pressed`, polled every 4 s (`routine-runs-rail.tsx:18-116`, `use-routines.ts:32-45`) | Runs list newest first (canvas), 48 px rows: dot, outcome word, stamp, (result), trigger; live from `routines` + `routineRuns` (no polling) (§7.3) | Parity (live instead of polling) |
| RT18 | Run report: the run's session in `ChatPanel` read-only, bot bubbles, banner `routines.runReadOnly`; selection defaults to the newest run; empty "This routine has not fired yet…" (`routine-page.tsx:92-100,228-256`, `chat-panel.tsx:878-879,2265-2290`) | `?run=<sessionId>` → 420 px run report beside the page: header "Run · {stamp}" + outcome + Close, "A run of this routine. It’s a report, not a conversation.", read-only `ChatView skin="bot"`; no auto-selection (canvas: the report opens on click) (§7.4) | Changed (canvas: report on demand) |
| RT19 | Showing a run switches the main-side active workspace (`useShowSession`, `routine-page.tsx`) | no workspace switch (routes carry ids; a bot-skin read-only transcript needs no git/tree state) | Retired (PLAN "no state in two places") |
| RT20 | Edit-by-chat: input + Send, "Changing…", reply in an `aria-live` line; placeholder "Tell the routine how to change: “every morning at 9 instead”, “stop”"; errors toast (`routine-page.tsx:302-374`) | "Change it by talking to it" panel on the page: bubbles, typing dots + "Changing…", reply bubble, composer pill "Tell the routine how to change" (canvas `RoutineStates`); errors inline (§7.6) | Parity (canvas) |
| RT21 | Firing frame stripped from the run's first message (`[routine] "…"` and `<system_reminder>` blocks, `injected-text.ts:8-18`) | chat kit amendment: `visibleUserText` semantics ported unchanged (reminder blocks removed anywhere, surrounding words kept, an all-app message hidden) for every user message in the bot skin, and the scheduler's first message of a routine-run session (`routineId != null`) hidden by position, which also covers bot-voiced envelopes (§31.2) | Parity |
| RT22 | Auto-replies section in the panel (15 s polled snapshot): name, platform, On/Paused, Pause/Resume, Revoke (no confirm) (`routines-panel.tsx:89-171`) | the sidebar Auto-replies group (§6.4); Pause/Resume on `/bots/$botId/chats/$sessionId` (03 P61); Revoke on Library › Messaging with a confirm (§13.3) | Changed (03 F8; confirm added) |
| RT23 | Auto-reply page `/routines/chat:<id>` (`routine-page.tsx:376-493`) | `/bots/$botId/chats/$sessionId` (03 §11.5) | Changed (03 F8) |
| RT24 | Live sync: `cronjobs-updated` and `local-cli-session-created` invalidate (`use-routines.ts:47-69`) | `routinesCollection`, `routineRunsCollection` change batches (spec 00 B) | Parity |
| RT25 | Main guards shown as results: 30 min timeout, auto-pause after 3 failures, out-of-credits pause, once-jobs turn off (`routine-guards.ts`) | row state line shows `lastResult` text verbatim when paused or failed (display only, never branched on) (§6.3) | Parity |
| RT26 | Old routes `/settings/jobs`, `/routines/chat:<id>` | — (renderer-next has its own tree; no legacy URLs reach it) | Retired (PLAN "Nuked: `?view=` redirects"; new entry HTML) |

### 2.2 Artifacts

| # | Today | New | Status |
|---|---|---|---|
| AR1 | `/settings/artifacts`, sidebar footer "Artifacts" (`router.tsx:432-442`, `workspace-sidebar.tsx:145-155`) | `/artifacts` under its own rail item with `ArtifactsSidebar` (§10) | Changed (PLAN rail) |
| AR2 | List from `listSessionArtifacts`, newest first by `updatedAt` (main sort), live via `session-artifacts-updated` (`use-workspace-queries.ts:117-129`) | `artifactsCollection` (`db.artifacts`), sort Newest / Oldest / Name (canvas "Newest" menu) (§10.3) | Parity + New (sort) |
| AR3 | Search: fuzzy on title, location, session label; Esc clears; clear X; placeholder "Search artifacts and sessions…" (`artifacts-panel.tsx:196,220-232,353-380`) | "Search artifacts" in the sidebar (canvas), same fields (title, location, session label), substring accent-insensitive (the canvas; fuzzy retired as in 04 §7.1), `q` in the URL, Esc clears (§10.2) | Parity (matching changed to substring) |
| AR4 | Kind filter All / Images / Files / Links with counts from the searched set (`artifacts-panel.tsx:234-243,382-406`) | sidebar Type group All / Files / Images / Links with counts from the searched set, `type` in the URL (F5) | Parity |
| AR5 | — | From group: bots (avatars) and workspaces (folders), `from` in the URL (canvas) | New |
| AR6 | Refresh button (`artifacts-panel.tsx:408-420`) | none (the table is live and re-diffs every 2 s) | Retired (live data) |
| AR7 | Empty "No artifacts yet" / "Files the agent writes and pages it opens are collected here."; no-match "Nothing matches" / "Try a different name, path, or session title." (`artifacts-panel.tsx:423-440`) | canvas `ArtifactsStates`: same titles, "…Start a session or ask a bot for something.", "Nothing matches “{q}”" + Clear search (§10.6) | Parity (canvas copy) |
| AR8 | Count "{{count}} items" (`artifacts-panel.tsx:443-448`) | header "{n} items" (canvas) | Parity |
| AR9 | Table rows: kind icon, title, location tail, notice, session column, age (`artifacts-panel.tsx:449-521`) | Grid (default) and List (canvas): format tile, title, format label, source · stamp; day group headers (§10.4) | Changed (canvas) |
| AR10 | Open a file: probe with `readFileAsText(maxBytes 1)`: missing → notice, directory → URL or reveal + "Opened in your file manager."; else preview in its session's pane by type, or `openFilePath` with `openFile.*` toasts (`artifacts-panel.tsx:280-337`, `preview-utils.ts:127-190`) | click selects (`?item=`) and previews beside the list (canvas `ArtifactsPreview`) through `components/file-preview`; same probe; directory → reveal + same toast; Open (double-click, Enter) → `system.openPath` with the same toasts (§11) | Changed (canvas: preview in Artifacts, not in the session) |
| AR11 | Open a link: browser tab in its session's pane (`artifacts-panel.tsx:280-300`) | link preview card with "Open in browser" (`system.openExternal`) and "Go to session" (§11.3) | Changed (canvas `ArtifactsPreview`: "Open in browser") |
| AR12 | Session column opens the chat (`artifacts-panel.tsx:252-259`) | "Go to session" (row menu, preview header): session → `/sessions/$id`, bot session → `/bots/$botId` (forever) or `/bots/$botId/chats/$sessionId`, routine run → `/routines/$routineId?run=` (§11.4) | Parity + New (bot and routine targets) |
| AR13 | Hover Copy path/URL with "Copied" tooltip, Reveal in folder (files) (`artifacts-panel.tsx:128-183`) | row menu and preview header: Copy path / Copy URL, Show in folder (canvas labels) (§11.4) | Parity |
| AR14 | — | row context menu (canvas: Open, Open in browser, Show in folder, Copy path, Copy URL, Go to session) and ⋯ button, one item list (§11.4) | New |
| AR15 | `missing` flag branch (never set by main) | inline "This file is no longer on disk." after a failed probe; Remove not built (F6) | Parity (Remove deferred) |

### 2.3 Library (connectors, messaging, MCP, skills, tools)

| # | Today | New | Status |
|---|---|---|---|
| LB1 | Capabilities tab strip Tools / MCP / Skills / Connectors under Settings, back chevron on a toolset (`in-pane-settings.tsx:14-56`) | Library rail item with `LibrarySidebar`: Connectors, Messaging, MCP servers, Skills, Tools (§12.1) | Changed (PLAN "Library vs Settings") |
| LB2 | Connectors registry from `@abacus-ai/connectors/registry`; statuses from `listConnectorStatuses` invalidated by `connector-status-changed`, `credentials-changed`, `messaging-updated`; not-offered cards hidden after load (`use-connector-statuses.ts`, `connectors-panel.tsx:330-337`) | same registry and `connectors.statuses` with the same three invalidation sources (§12.2) | Parity |
| LB3 | Search "Search connectors", no match "No connectors match that search." | same (§12.3) | Parity |
| LB4 | Sections Messaging (first) / Installed / Not installed (`connectors-panel.tsx:400-529`) | category segmented control (Featured, Abacus.AI, Productivity, Data, Development, Infrastructure, Payments, Support, Web; registry `ConnectorCategory`, platform connectors under Abacus.AI and Featured), then Connected / Available (canvas); messaging platforms live on the Messaging page (F7) | Changed (canvas) |
| LB5 | Card: logo, name, auth badge, description, Manage (setup guide), Docs, Sign in (MCP OAuth auth-required), Remove, Add/Connect, inline error (`connectors-panel.tsx:554-701`) | row (canvas): `ConnectorMark` 28, name, account or description, state pill, Manage / Reconnect / Add; the rest in the connector sheet (§12.3, §12.5) | Parity (canvas layout) |
| LB6 | Connect: browser hop with a 3 min watchdog, one hop at a time (another card cancels with "Stopped adding {{name}}."), "Finish connecting {{name}} in your browser…", success/failure toasts and inline errors, Chrome-required warning, `refreshMcpServers` after success (`connectors-panel.tsx:84,163-263`) | `useConnectFlow` port: same rules, copy and toasts; MCP refresh for every running session (§12.4) | Parity; a hop now survives leaving the page (Changed, §12.4 item 8) |
| LB7 | Fields dialog (token, key, oauth-client with redirect URL `http://127.0.0.1:33418/callback`, setup steps, masked inputs, required non-blank) (`connect-flow.tsx:179-335`) | `ConnectorFieldsDialog` on TanStack Form + valibot (§12.6) | Parity |
| LB8 | Disconnect toasts; messaging remove disables the platform (`connectors-panel.tsx:265-300`) | sheet "Disconnect" (confirm added), same toasts (§12.5) | Parity + confirm |
| LB9 | MCP OAuth sign-in from a card when the runtime says `auth-required` | same, from the sheet and the MCP page (§12.5, §14.4) | Parity |
| LB10 | `ConnectorRequestCard` in the chat (03 P63, 04 S65) | unchanged component (`components/connector-request-card`, phase 3); its connect path uses §12.4's flow | Parity (phase 3) |
| LB11 | Messaging: section + `MessagingConnectorDialog` + `PlatformDetail` (state badges, two-step note, web login, shared link with QR/code/Discord steps, syncing note, pending approvals Approve/Reject, cancel-connect semantics, dormant credentials form) (`messaging-connectors.tsx:185-925`) | `/library/messaging` list + `?platform=` sheet with the same parts and copy (§13) | Parity (own page, F7) |
| LB12 | `MessagingSettingsDialog`: gateway on, workspace, bot, respond to inbound, run remote turns unattended (`messaging-connectors.tsx:1006-1179`) | "Settings" card on the Messaging page, same five controls and copy (§13.4) | Parity |
| LB13 | MCP list (`listMcpServers({mode:"code"})`), runtime pill Connected · n tools / Connecting / Error / Auth required / Off / Not connected, row error (`mcp-management-panel.tsx:123-136,696-741`) | `/library/mcp` rows (canvas): mark, name, command or URL, status pill with the same states (§14) | Parity |
| LB14 | Add / Import (file, Cursor, Claude Code, DeepAgent, clipboard JSON when it parses), Refresh (needs a session) (`mcp-management-panel.tsx:144-283`) | header "Add server", "Import ▾" (Claude, Cursor, DeepAgent, From a file…, Paste JSON), Refresh; runtime scope rule (F17) (§14.2–§14.3) | Parity |
| LB15 | Enable/disable optimistic, Remove optimistic **without confirm**, Restart, OAuth sign-in, Logs panel (tail 200) (`mcp-management-panel.tsx:169-352,593-616`) | same; Remove confirms (§14.4) | Parity + confirm (gap fix) |
| LB16 | `McpServerForm`: name, STDIO/HTTP, command, args, env, URL, headers, OAuth; required-only validation (`mcp-server-form.tsx:108-132`) | `McpServerForm` on TanStack Form + valibot, same fields and messages; URL must be `http(s)` (§14.5) | Parity + URL check (gap fix) |
| LB17 | `AbacusConnectorsSummary` under `abacus-connectors` (`abacus-connectors-summary.tsx`) | same row summary from `connectors.statuses` (§14.3) | Parity |
| LB18 | Skills: installed grouped Workspace / Global, Edit skill file, Uninstall with confirm, Upload from file/folder, marketplace dialog (350 ms debounce, install global, "Powered by skills.sh"), restart banner (`skills-management-panel.tsx`) | `/library/skills` (canvas), same parts; workspace for project skills from a picker (default `prefs.lastPickedWorkspaceId`) (§15) | Parity |
| LB19 | Tools: toolset list with switches, search, detail with tool table and notes, planned toolsets, alwaysOn still toggleable (`capabilities-panel.tsx:49-317`) | `/library/tools`, `/library/tools/$toolsetId`; alwaysOn toolsets show "Always on" instead of a switch (§16) | Parity + gap fix |
| LB20 | Execution backend and terminal shell on the terminal toolset page (`capabilities-panel.tsx:325-513`) | Settings › Execution backend (§20.1); the terminal toolset page links there | Changed (canvas `SettingsEnvironment`) |
| LB21 | Legacy `?view=capabilities|messaging` redirects | — | Retired (PLAN "Nuked") |

### 2.4 Settings

| # | Today | New | Status |
|---|---|---|---|
| ST1 | No settings nav: account dropdown `SettingsMenu` with Profile, Invite friends, Theme, Language, Models, Capabilities, Memory, Routines, Usage, MCP, Skills, Browser, Devices, Notifications, Replay tour, Dump logs, What's new, About…, Sign out/in (`settings-menu.tsx`) | settings shell: sidebar nav (F8), each item a page; the rail's account button opens a small menu (Account, Sign out/in, Settings) (§17) | Changed (canvas, user decision) |
| ST2 | `/settings` → `/settings/account` | `/settings` → `/settings/general` (foundation) | Changed (foundation) |
| ST3 | Page titles in the title bar (`staticData.titleKey`) | title bar shows "Settings" identity; each page has its `<h1>` (canvas) | Changed (PLAN "Nuked: `staticData.titleKey`") |
| ST4 | Theme submenu Dark/Light/System, `theme:set` (`use-theme.ts`) | Appearance › Theme (`prefs.theme`, phase 1 control moved to `updatePrefs(patch)`) (§18.2) | Parity |
| ST5 | Language submenu, 11 locales, stored `abacusai-bot-language`, Spanish rule (`language-store.ts`, `i18n.ts:34-122`) | Language page: "System ({resolved})" + the 11 shipped locales (`prefs.language`) (§21.2) | Parity + System option (foundation §9.2) |
| ST6 | Profile: account card (avatar, name, email, plan), Organization, Plan, Credits "{{used}} of {{granted}} used", Team members; signed-out text (`profile-panel.tsx:132-198`) | Account page (canvas): identity row + Sign out, Plan (Manage plan), Credits (Top up), Organization; signed-out board (§19.1) | Parity (canvas) |
| ST7 | Default permission mode on Profile, only with sandbox support: Full access / Auto + warning (`profile-panel.tsx:55-102`) | General › "Bots and routines run in" (`settings.defaultMode`), same gating and warning (§18.1) | Changed (canvas placement) |
| ST8 | Sign out: `auth.abacus.signOut({keepOtherApiKeys:false})`, `account.signOut`, tour reset, navigate `/`, toast "Signed out. A chat that is already running keeps the key it started with until you start a new one." (`settings-menu.tsx:78-89`) | Account › Sign out (confirm added), same calls, copy and toast; tour reset is phase 6's hook (§19.2) | Parity + confirm |
| ST9 | Sign in when no key: `account.forget` → onboarding | Account signed-out: "Sign in with Abacus.AI" (`auth.abacus.start`), "Use my own keys" → Models (canvas `SettingsSignedOut`) (§19.2) | Changed (canvas) |
| ST10 | Referrals page: summary, copy invite link, Gmail/WhatsApp contacts, manual emails, note, send, toasts (`referrals-panel.tsx`) | Account › Referrals rows → masked invite dialog `?invite=gmail|whatsapp|link`, same logic (§19.3) | Parity (canvas placement) |
| ST11 | Models: provider grid (featured, other), search, configured state, key dialog with `isPlausibleApiKey`, "Saved, not checked", browser connect for Abacus/OpenRouter with cancel and attempt guard, remove key confirm, `?provider=` (`models-panel.tsx`, `provider-key-dialog.tsx`) | Models page (canvas): same providers and dialogs incl. Remove for stored connect-provider credentials, `?provider=` kept (03 §13.1 links to it) (§20.4) | Parity |
| ST12 | Local models section: catalog, Recommended, size, progress, Download/Stop/Remove, hardware note; `local-model-progress` folding; the local-model dialog (`local-models-section.tsx`, `local-model-dialog.tsx`, `use-local-models.ts`) | "On this machine" section (canvas) over `localModels.state` + `localModels.progress`; remove confirms; install-and-use returns to the requesting chat via `?provider=local&for=` (§20.5) | Parity + confirm |
| ST13 | Notifications page: "Notify me", "Play a sound" (OS sound) (`notification-settings-dialog.tsx`) | Notifications page: Notify me (`settings.notifications.enabled`), Play sounds (`prefs.sounds.enabled`, in-app cues), per-cue switches with Preview, per-bot levels, quiet hours (§22) | Changed (PLAN Sound, F12); the old sound opt-out is imported (§31.5 i) |
| ST14 | Memory page: custom instructions (Save when changed, status lines), sessions stores remember/user/memory with forget and Clear all confirm, bots section with forget/clear, states and copy (`memory-panel.tsx`) | Memory page (canvas): same parts; bots reuse `BotMemoryList` (03 §12.2) with "Open" → `/bots/$botId?tab=memory` (§18.4) | Parity |
| ST15 | Usage page: Refresh, plan card, Today / Last N days / OpenRouter cards, daily bars, RouteLLM pool and other models with req/err/tok/cost, formatting, unpriced hint (`usage-panel.tsx`) | Usage page (canvas): credits card, OpenRouter card, This week, Daily activity chart (SVG), by model (F14) (§18.5) | Parity (canvas layout) |
| ST16 | Browser settings: master switch, engine, Chrome status/connect/token, home page (durable storage), clear data (no confirm), approval (`browser-settings-dialog.tsx`, `lib/browser-homepage.ts`) | Settings › Browser, same controls; home page is `prefs.browserHomepage` (spec 00 C.4 already imports it) (§20.2) | Parity |
| ST17 | Devices settings: switch, toolchains with download links, Maestro note, approval (`device-settings-dialog.tsx`) | Settings › Devices + Install Maestro (`devices.installMaestro`) (canvas) (§20.3) | Parity + New (install) |
| ST18 | Updates: pill, composer strip, home banner, critical dialog with 5:00 countdown, stalled banner; no manual check (`common/*`, `chat/composer-update-strip.tsx`) | title-bar `UpdatePill`, critical dialog and stalled banner as shell globals; About page with Check for updates and every state (canvas `SettingsAbout`) (§21.4) | Parity + New (manual check, About); composer strip and home banner Retired (canvas: pill + About cover them) |
| ST19 | What's new `/settings/changelog` from `CHANGELOG.md?raw` | `/settings/about/changelog` from About (§21.4) | Parity |
| ST20 | About… native panel (`window:show-about`) | About page; "Show app info" still calls `window.showAbout` on macOS (§21.4) | Changed (canvas) |
| ST21 | Dump logs: `saveLogs(getLogDump())`, toasts (`settings-menu.tsx:97-111`) | About › "Save logs…" (`system.logs.save`), same toasts (§21.4) | Parity |
| ST22 | Replay tour (menu) | phase 6 | Deferred to phase 6 |
| ST23 | — | General: Launch at login (new procedure), default workspace, default permission mode for sessions, modes explainer (canvas) (§18.1) | New |
| ST24 | — | Appearance: density (new procedure), text size, reduce motion, bubble tint (F10) (§18.2) | New |
| ST25 | — | Keyboard page: action list, record, reset, conflicts (F13) (§21.3) | New |
| ST26 | — | Settings search "Search settings" (canvas) (§17.3) | New |
| ST27 | Abacus account polled every 5 min (`use-abacus-account.ts`) | `account.abacus` query `refetchInterval: 300_000` while an Account/Usage/Models page is mounted (§19.1) | Parity |

---

## 3. Dependencies

**No new packages.** Everything below is installed or pinned by an earlier phase. The OSI-licence rule (04 F2) is met by all of them; nothing here is a small library added for this phase.

| Package | Version | Used for | Verified |
|---|---|---|---|
| `@tanstack/react-form` + `valibot` | 1.33.5 / 1.5.0 | routine form, MCP server form, connector fields, key dialog, custom instructions, messaging fields, invite dialog, quiet hours | 03 F1 (`createFormHook`, `revalidateLogic`, Standard Schema validators; parse-on-submit because the bridge drops schema output; remote sync with `dontUpdateMeta`, `dontValidate`, `dontRunListeners`) |
| `@tanstack/db` / `@tanstack/react-db` | 0.9.2 / 0.4.1 | `routines`, `routineRuns`, `artifacts`, `sessions`, `bots`, `workspaces`, `memories`, `prefs` collections; `useLiveQuery` | 03 §3 |
| `@tanstack/react-query` + `@orpc/tanstack-query` | foundation | every §3-of-area query | contract files |
| `@tanstack/react-hotkeys` (+ `@tanstack/hotkeys` via `export *`) | 0.12.1 (0.10.1) | Keyboard page: `useHotkeyRecorder`, `validateHotkey`, `findHotkeyConflicts`, `formatForDisplay` | typings cited in the sources table |
| `@tanstack/react-pacer` | 0.24.0 | debounced search fields (connectors, artifacts, skills marketplace 350 ms parity), text size slider-free writes | foundation §3.1 |
| `motion` | **13.4.6 installed** | presence of the run report, sheets' inner steps, sidebar row reorder | `node_modules/motion/package.json` 13.4.6 (MIT) with its own `framer-motion` 13.x; R5-T34 type-checks the imports |
| `react` | **19.3.0 installed** | `ViewTransition` (settings in/out are foundation's), `<Activity>` for the run report | `react/package.json` 19.3.0 |
| `@abacus-ai/connectors` | `workspace:*` | `./registry` (connector catalogue, `connectUi`, categories) | `packages/connectors/package.json:7-11`; browser-safety of the built `dist/registry.js` is **unverified** for renderer-next's bundle (the old renderer imports the same entry through `renderer/connectors.ts`); R5-T33 bundles it |
| Registry atoms | foundation §5.2 | `dialog`, `alert-dialog`, `sheet`, `tabs`, `toggle-group`, `switch`, `select`, `native-select`, `field`, `input`, `input-group`, `textarea`, `dropdown-menu`, `context-menu`, `popover`, `command`, `combobox`, `tooltip`, `item`, `badge`, `skeleton`, `empty`, `spinner`, `kbd`, `toast`, `collapsible`, `scroll-area`, `resizable` | all in the foundation `add` list; no new atom |

Not used, with reasons: any cron or natural-language date library (F1: main's own parser is the authority, and it moves to `shared/`); any chart library (F14: one SVG series); a QR library in the renderer (main renders the data URL); `@tanstack/react-virtual` (not installed; the artifacts grid uses a bounded window, §10.5); `monaco-editor` (PLAN "Editing": "Edit skill file" and "Open" hand files to the OS through `skills.openFile` / `system.openPath`); `temml` (no math on these pages; Markdown previews reuse 04's `components/file-preview`, whose math path is the chat kit's).

---

## 4. Folder shape and public API

```
src/shared/routines/                  (new; pure, used by main, both renderers and tests)
├─ cron.ts                            parseCron, nextRun, CronParseError (moved from main/services/agent-tools/cron-store.ts; main re-exports)
└─ templates.ts                       ROUTINE_TEMPLATES (moved from renderer/components/settings/routine-templates.ts; old file re-exports)
src/shared/settings/                  (new)
├─ abacus-urls.ts                     ABACUS_PLAN_URL, ABACUS_BUY_CREDITS_URL (moved from renderer/lib/abacus-credits.ts)
├─ browser-homepage.ts                normalizeBrowserHomepage (moved from renderer/lib/browser-homepage.ts; main/services/config/legacy-prefs.ts drops its duplicate)
├─ changelog.ts                       parseChangelog (moved from renderer/lib/changelog.ts)
└─ usage-format.ts                    fmtTokens, fmtCost (moved from components/settings/usage-panel.tsx:34-50)
src/renderer-next/
├─ components/
│  ├─ artifact-kind/                  artifactFormat(location, kind) → { labelKey, tone, icon }, ArtifactTile (28/40 px tile) — bots' Files tab uses it (03 §12.3)
│  ├─ settings-rows/                  SettingsPage, SettingsSection, SettingsRow, SettingsGroupCard, StatePill (the 52 px row grammar, §17.4)
│  ├─ connector-mark/                 (phase 3, reused)
│  ├─ bot-memory-list/                (phase 3, reused)
│  ├─ file-preview/                   (phase 4, reused)
│  ├─ form-kit/                       createFormHook field components (moved from 03's features/bots/form/form-kit.ts, §31.3)
│  └─ usage-chart/                    UsageChart (SVG bars, §18.5)
├─ features/routines/
│  ├─ index.ts                        public API (below)
│  ├─ data/                           queries.ts actions.ts (§9) routine-state.ts (§6.3) search.ts stats.ts
│  ├─ sidebar/                        routines-sidebar.tsx routine-row.tsx routine-row-menu.tsx auto-reply-row.tsx (§6)
│  ├─ page/                           routine-page.tsx header.tsx cards.tsx runs-list.tsx run-report.tsx editor-chat.tsx (§7)
│  ├─ form/                           form-kit.ts schema.ts routine-form.tsx schedule-field.tsx templates.tsx submit.ts schedule-label.ts (§8)
│  ├─ home/                           routines-home.tsx (index body, empty state)
│  ├─ parity.ts  gallery/sections.tsx
├─ features/artifacts/
│  ├─ index.ts  data/ (queries.ts filters.ts sources.ts open.ts)  sidebar/  page/ (grid.tsx list.tsx preview-pane.tsx row-menu.tsx)  parity.ts  gallery/
├─ features/library/
│  ├─ index.ts  sidebar.tsx
│  ├─ connectors/                     connectors-page.tsx connector-row.tsx connector-sheet.tsx connect-flow.ts fields-dialog.tsx (§12)
│  ├─ messaging/                      messaging-page.tsx platform-sheet.tsx web-login.tsx shared-link.tsx pending-list.tsx settings-card.tsx (§13)
│  ├─ mcp/                            mcp-page.tsx server-row.tsx server-form.tsx import-menu.tsx logs.tsx runtime-scope.ts (§14)
│  ├─ skills/                         skills-page.tsx marketplace-dialog.tsx (§15)
│  ├─ tools/                          tools-page.tsx toolset-page.tsx (§16)
│  ├─ parity.ts  gallery/
└─ features/settings/
   ├─ index.ts  sidebar.tsx search-index.ts (§17)
   ├─ pages/                          general.tsx appearance.tsx notifications.tsx memory.tsx usage.tsx account.tsx models.tsx
   │                                  environment.tsx browser.tsx devices.tsx language.tsx keyboard.tsx about.tsx changelog.tsx
   ├─ account/                        invite-dialog.tsx (§19.3)
   ├─ models/                         provider-row.tsx key-dialog.tsx connect-dialog.tsx local-models.tsx (§20.4–§20.5)
   ├─ updates/                        update-pill.tsx critical-update-dialog.tsx stalled-banner.tsx use-update-status.ts (§21.4)
   ├─ sound/                          cue-preview.tsx quiet-hours.tsx per-bot-levels.tsx (§22)
   ├─ parity.ts  gallery/
src/renderer-next/lib/
├─ keyboard/actions.ts                APP_ACTIONS (id, default binding, owner, rebindable) and resolveKeymap(prefs.keymap) (§21.3)
└─ notify.ts                          shouldNotify / shouldPlay gating shared by sound and OS notifications (§23.2)
```

Rules (foundation §4; R5-T37 checks them): features import `components/`, `ui/`, `data/`, `lib/`, `#shared/*`, never another feature; the routine run report renders the chat kit **through a render prop the route passes** (features do not import `features/chat`, as 04 §4); `components/*` import no `data/` or feature; `features/shell/sidebars.ts` gains `UpdatePill`, `CriticalUpdateDialog` and `UpdateStalledBanner` in its `globals` list (04 §26.1 introduced the list).

Public APIs (named exports only):

```ts
// features/routines/index.ts
export { RoutinesSidebar } from "./sidebar/routines-sidebar";
export { RoutinesHome } from "./home/routines-home";
export { RoutinePage, RunReportFrame } from "./page";                  // RunReportFrame: header + banner; the route supplies the ChatView
export { RoutineCreateDialog, RoutineEditDialog } from "./form";
export { routinesQueries, RoutineSearch, RoutineNewSearch } from "./data";
export { routinesGallerySections } from "./gallery/sections";
// features/artifacts/index.ts
export { ArtifactsSidebar, ArtifactsPage } from "./page";
export { ArtifactsSearch, artifactsQueries } from "./data";
export { artifactsGallerySections } from "./gallery/sections";
// features/library/index.ts
export { LibrarySidebar } from "./sidebar";
export { ConnectorsPage, ConnectorSheet, MessagingPage, PlatformSheet, McpPage, McpServerDialog, SkillsPage,
         MarketplaceDialog, ToolsPage, ToolsetPage, useConnectFlow } from "./…";
export { ConnectorsSearch, MessagingSearch, McpSearch, SkillsSearch } from "./search";
export { libraryGallerySections } from "./gallery/sections";
// features/settings/index.ts
export { SettingsSidebar, SettingsBackButton } from "./sidebar";
export { GeneralPage, AppearancePage, NotificationsPage, MemoryPage, UsagePage, AccountPage, ModelsPage, EnvironmentPage,
         BrowserPage, DevicesPage, LanguagePage, KeyboardPage, AboutPage, ChangelogPage, InviteDialog } from "./pages";
export { UpdatePill, CriticalUpdateDialog, UpdateStalledBanner } from "./updates";   // shell globals
export { SettingsSearch, ModelsSearch, AccountSearch } from "./search";
export { settingsGallerySections } from "./gallery/sections";
```

`useConnectFlow` is exported because the connector request card (`components/connector-request-card`, phase 3) and onboarding (phase 6) connect through the same flow; `components/*` cannot import a feature, so the card receives the flow as a prop from the route that renders it (03 §11.4 already passes `connect`/`respond` callbacks).

---

## 5. Routes

### 5.1 Files

Directory form under `src/renderer-next/routes/_shell/`. **(f)** rows exist as phase 1 placeholders and are filled here; **(a)** rows amend the foundation (§31.1); **(n)** are new.

**Routines** (`(routines)/`):

| File | Path | Responsibility |
|---|---|---|
| `routines.tsx` (f) | `/routines` layout | `staticData: { area: "routines", sidebar: "routines" }`. Loader: `await Promise.all([routines.preload(), routineRuns.preload(), bots.preload()])` (the sidebar needs all three; `sessions` is `startSync`) + `ensureQueryData(botsQueries.senderChats())` (auto-replies). Component `<Outlet/>`. |
| `routines._list.tsx` (f) | pathless | Renders `RoutinesHome` (§7.1) and `<Outlet/>` (the masked create dialog renders over it). |
| `routines._list.index.tsx` (f) | `/routines/` | `null` (body is the parent's). |
| `routines._list.new.tsx` (f → dialog) | `/routines/new` | `validateSearch: RoutineNewSearch` (`template?`); `RoutineCreateDialog` (registry `Dialog`, F2); masked to `/routines`. Its own loader awaits `routines.preload()` and `workspaces.preload()`. |
| `routines.$routineId.tsx` (f) | `/routines/$routineId` | `params.parse` with `RoutineId`; `validateSearch: RoutineSearch` (`run?`); `loaderDeps: ({ search }) => ({ run: search.run })`; loader §5.3; `pendingComponent` page skeleton; `notFoundComponent` §5.5. Renders `RoutinePage` with the run report (§7.4) and `<Outlet/>` for the masked edit dialog. |
| `routines.$routineId.edit.tsx` (n) | `/routines/$routineId/edit` | Masked pop-up (registry `Dialog`) with `RoutineEditDialog`; mask → `/routines/$routineId` keeping params and search. A child of the page on purpose: it renders over the page through its `<Outlet/>` (03's check-in dialog pattern). Close/Escape = `history.back()`, or the mask target when `!canGoBack()`. |

**Artifacts** (`(artifacts)/`):

| File | Path | Responsibility |
|---|---|---|
| `artifacts.tsx` (f) | `/artifacts` layout | `staticData: { area: "artifacts", sidebar: "artifacts" }`. Loader: `await Promise.all([artifacts.preload(), bots.preload(), routines.preload()])` (source labels, §10.3). |
| `artifacts.index.tsx` (f, a) | `/artifacts/` | `validateSearch: ArtifactsSearch` (§5.2, replaces foundation's); `search.middlewares: [stripSearchParams({ view: "grid", sort: "newest" })]`; loader awaits `artifacts.preload()` itself (loaders run concurrently, 03 §5.1); no `loaderDeps` (filters are client-side over a live query). Renders `ArtifactsPage`. |

**Library** (`(library)/`):

| File | Path | Responsibility |
|---|---|---|
| `library.tsx` (f) | `/library` layout | `staticData: { area: "library", sidebar: "library" }`. |
| `library.index.tsx` (f) | `/library/` | redirect → `/library/connectors` (or the area's last location). |
| `library.connectors.tsx` (f) | `/library/connectors` | `validateSearch: ConnectorsSearch` (`connector?`, `category?`, `q?`); loader `ensureQueryData(connectors.statuses)`; `ConnectorsPage` + `ConnectorSheet` when `connector` is set; masked (foundation) so the URL hides `connector`. |
| `library.messaging.tsx` (f, a) | `/library/messaging` | `validateSearch: MessagingSearch` (`platform?`); loader `ensureQueryData(messaging.snapshot)`; `MessagingPage` + `PlatformSheet` when `platform` is set; masked like connectors (hides `platform`). |
| `library.mcp.tsx` (f, a) | `/library/mcp` | `validateSearch: McpSearch` (`server?: "new" | <name>`, `logs?: <name>`); loader `ensureQueryData(mcp.list({ mode: "code" }))`; `McpPage` + `McpServerDialog` when `server` is set; masked (hides `server`). |
| `library.skills.tsx` (f, a) | `/library/skills` | `validateSearch: SkillsSearch` (`marketplace?: true`, `workspace?`); loader `ensureQueryData(skills.listInstalled({ workspacePath }))`; `SkillsPage` + `MarketplaceDialog` when `marketplace`; masked (hides `marketplace`). |
| `library.tools.index.tsx` (f) | `/library/tools` | loader `ensureQueryData(settings.toolsets.get)`; `ToolsPage`. |
| `library.tools.$toolsetId.tsx` (f) | `/library/tools/$toolsetId` | `params.parse` against `TOOLSETS_BY_ID` keys (foundation); unknown → `redirect` to `/library/tools` (parity `router.tsx:379-397`); `ToolsetPage`. |

**Settings** (`settings*`, directly under `_shell`; foundation had nine pages):

| File | Path | Responsibility |
|---|---|---|
| `settings.tsx` (f) | `/settings` layout | `staticData: { area: "settings", sidebar: "settings" }`; `validateSearch: SettingsSearch` (`focus?`, §17.3); `search.middlewares: [stripSearchParams({})]`; `beforeLoad` records nothing (the back target is kept by the shell, §17.2). |
| `settings.index.tsx` (f) | `/settings/` | redirect → `/settings/general`. |
| `settings.general.tsx` … `settings.about.tsx` (f) | `/settings/{general,appearance,notifications,memory,usage,account,models,environment,about}` | one page each (§18–§21). `account` has `validateSearch: AccountSearch` (`invite?: "link" | "gmail" | "whatsapp"`), masked like connectors. `models` has `validateSearch: ModelsSearch` (`provider?`, parity `router.tsx:479-506`: kept only for `"local"` or a `PROVIDER_KEY_FIELDS` provider). |
| `settings.browser.tsx`, `settings.devices.tsx`, `settings.language.tsx`, `settings.keyboard.tsx` (n) | `/settings/{browser,devices,language,keyboard}` | §20.2, §20.3, §21.2, §21.3. |
| `settings.about_.changelog.tsx` (n) | `/settings/about/changelog` | What's new (§21.4), un-nested from About (see note). |

Note: a flat `settings.about.changelog.tsx` would nest inside About (`routing-concepts.md:527-548`, 03 F2); the trailing `_` un-nests it, so What's new replaces About in the pane. The generated id is snapshotted by R5-T1 like 03's un-nested routes.

Generated ids (R5-T1 snapshots them): `/_shell/(routines)/routines`, `…/routines/_list`, `…/routines/_list/`, `…/routines/_list/new`, `…/routines/$routineId`, `…/routines/$routineId/edit`, `/_shell/(artifacts)/artifacts`, `…/artifacts/`, `/_shell/(library)/library`, `…/library/`, `…/library/connectors`, `…/library/messaging`, `…/library/mcp`, `…/library/skills`, `…/library/tools/`, `…/library/tools/$toolsetId`, `/_shell/settings`, `/_shell/settings/`, `/_shell/settings/{general,…,keyboard}`, `/_shell/settings/about_/changelog`.

### 5.2 Search schemas (valibot, foundation §6.2 conventions: every field falls back)

```ts
// features/routines/data/search.ts
export const RoutineSearch = v.object({ run: optionalField(SessionId) });            // foundation's, unchanged
export const RoutineNewSearch = v.object({ template: optionalField(v.picklist(ROUTINE_TEMPLATE_IDS)) });
// features/artifacts/data/search.ts  (replaces foundation's ArtifactsSearch, F5)
const SourceRef = v.pipe(v.string(), v.regex(/^(bot|workspace):[A-Za-z0-9._-]{1,120}$/));
export const ArtifactsSearch = v.object({
  type: optionalField(v.picklist(["file", "image", "link"])),
  from: optionalField(v.union([v.literal("routines"), SourceRef])),
  q: optionalField(v.pipe(v.string(), v.maxLength(200))),
  item: optionalField(v.pipe(v.string(), v.maxLength(4200))),                          // artifact id `${sessionId}::${location}`
  view: v.optional(v.fallback(v.picklist(["grid", "list"]), "grid"), "grid"),
  sort: v.optional(v.fallback(v.picklist(["newest", "oldest", "name"]), "newest"), "newest"),
});
// features/library/search.ts
export const ConnectorsSearch = v.object({
  connector: optionalField(v.pipe(v.string(), v.maxLength(120))),
  category: v.optional(v.fallback(v.picklist(CONNECTOR_CATEGORY_TABS), "featured"), "featured"),
  q: optionalField(v.pipe(v.string(), v.maxLength(120))),
});
export const MessagingSearch = v.object({ platform: optionalField(MessagingPlatformIdSchema) });
export const McpSearch = v.object({ server: optionalField(v.pipe(v.string(), v.minLength(1), v.maxLength(200))), logs: optionalField(v.string()) });
export const SkillsSearch = v.object({ marketplace: optionalField(v.literal(true)), workspace: optionalField(WorkspaceId) });
// features/settings/search.ts
export const SettingsSearch = v.object({ focus: optionalField(v.picklist(SETTING_IDS)) });   // §17.3
export const ModelsSearch = v.object({ provider: optionalField(v.picklist(["local", ...PROVIDER_KEY_FIELD_IDS])), for: optionalField(SessionId) });   // `for`: the thread to adopt a local model into (§20.5)
export const AccountSearch = v.object({ invite: optionalField(v.picklist(["link", "gmail", "whatsapp"])) });
```

- `CONNECTOR_CATEGORY_TABS` = `["featured", "abacus", "productivity", "data", "development", "infrastructure", "payments", "support", "web"]` (`abacus` is registry `abacus-connectors`; `messaging` has its own page; §12.3); `stripSearchParams({ category: "featured" })`.
- Search-only changes on every route here keep `paneKey` and start no view transition (foundation §6.7 rule 1): opening a sheet, a dialog, the run report, the artifact preview, or changing a filter.

### 5.3 Loaders with side effects and preload

| Route | Loader on `enter`/`stay` | On `preload` (hover) |
|---|---|---|
| `/routines/$routineId` | `await routines.preload()`; row or `notFound()`; when `search.run` is set: the run row from `routineRunsCollection` (after its own `preload()`) must belong to this routine, else the search is replaced without `run` (`throw redirect({ search: { run: undefined }, replace: true })`); then `await context.chat.session(run).load()` (chat kit readiness, 02 §3.2) | rows only; **no `session.load()`** (hovering must not open chat subscriptions; 03 F9 class) |
| `/library/mcp` | the list query; the runtime scope is chosen in the component (§14.2) | the list query only |
| `/settings/about` | `ensureQueryData(update.status)`; the `update.events` iterator is the shell global's (§21.4) | same (pure read) |
| every other route | queries/collections only (reads) | same |

No loader in this phase starts an agent, switches a workspace, opens a window, or starts a sign-in; every such action is a user click (R5-T3 hovers every link in the four sidebars and asserts no mutation procedure was called).

### 5.4 Masks and pane boundaries

```ts
// router.tsx additions (foundation §6.6 masks use full paths)
createRouteMask({ routeTree, from: "/routines/$routineId/edit", to: "/routines/$routineId", params: (p) => p, search: (s) => s }),
createRouteMask({ routeTree, from: "/library/messaging", to: "/library/messaging", search: ({ platform: _p, ...rest }) => rest }),
createRouteMask({ routeTree, from: "/library/mcp", to: "/library/mcp", search: ({ server: _s, ...rest }) => rest }),
createRouteMask({ routeTree, from: "/library/skills", to: "/library/skills", search: ({ marketplace: _m, ...rest }) => rest }),
createRouteMask({ routeTree, from: "/settings/account", to: "/settings/account", search: ({ invite: _i, ...rest }) => rest }),
// PANE_BOUNDARIES additions (typed satisfies Partial<Record<keyof FileRoutesById, string>>)
"/_shell/(routines)/routines/$routineId": "routine:$routineId",
"/_shell/(routines)/routines/$routineId/edit": "routine:$routineId",
"/_shell/(library)/library/messaging": "library-messaging",
"/_shell/(library)/library/mcp": "library-mcp",
"/_shell/(library)/library/skills": "library-skills",
"/_shell/settings/account": "settings-account",
```

- The existing masks (`/routines/new` → `/routines`, `/library/connectors` hiding `connector`) and boundaries (`routines-list`, `library-connectors`) stay.
- `ROUTE_RANK` (foundation `nav-type.ts`) gains: `/routines/$routineId` 1 (foundation), `/routines/$routineId/edit` none (pop-up); `/library/tools/$toolsetId` 1 (foundation); `/settings/about/changelog` 1 (so About → What's new is `nav-forward`, back is `nav-back`); every other settings page 0 (`nav-lateral` between them). Entering and leaving Settings stay `settings-in`/`settings-out` (foundation).
- **Why the routine run report is not masked**: it is a panel beside the page, `?run=` is a search-only change, and the page stays interactive while it is open (canvas).

### 5.5 Not found, deleted while open

- `/routines/$routineId`: `notFoundComponent` = registry `Empty` "This routine is gone." (parity) + "All routines" → `/routines`. Deleted elsewhere while open: `useLiveQuery(findOne)` null after ready → the same view (not a throw from render, 03 §5.5). Deleted here: `deleteRoutine` navigates first (next routine in sidebar order, else `/routines`, `replace`), then deletes (§9.2).
- A run whose session is deleted while its report is open (a session delete removes its `routineRuns` row): the report shows "This run was removed." with Close.
- `/artifacts?item=` naming an artifact that is gone (its session was deleted, or its file vanished and main dropped the row): the preview pane shows "This artifact is no longer here." and the list stays; the URL is replaced without `item` on the next list click.
- `/library/tools/$toolsetId` unknown → redirect (parity). `/library/mcp?server=<name>` unknown → the dialog shows "This server was removed." with Close.

---

## 6. The routines sidebar (`features/routines/sidebar/`, canvas `Routines`, `RoutineStates`)

Built on `NavList` (foundation §7.3). Replaces phase 1's name-only list.

### 6.1 Header and search

- 32 px field "Search routines" (radius 9, `bg-muted`, margin `0 0 8px 8px`, canvas) always visible (the canvas has no search toggle here). Filters by name and instruction, case- and accent-insensitive substring; results replace the groups with one list; "No routines match" compact `Empty`; Escape clears.
- No header title row: the title bar says "Routines" (canvas identity). A `+` is not in the header; the footer holds **New routine** (36 px, radius 10, `bg-muted`, full width, `Plus` 14) → `/routines/new` with `transition: "none"` (a masked pop-up). `Mod+N` in the area opens the same (foundation §7.9).

### 6.2 Stats line

`padding: 4px 8px 10px`, 12/16 muted, gap 12: "**{a}** active", "**{t}** fire today", "**{p}** paused" (numbers 600 in `--foreground`). `stats(rows, now)` (pure, `data/stats.ts`): `active` = enabled; `paused` = not enabled; `fireToday` = enabled routines with a `recentRuns` entry at or after local midnight **or** `nextRunAt` before the next local midnight (RT4). Recomputed on a one-minute clock (`useMinuteClock`, 03 P17) and on row changes. Hidden when there are no routines.

### 6.3 Routine row and its state (`routine-row.tsx`, `data/routine-state.ts`)

`NavList.Item` as `<AppLink to="/routines/$routineId" transition="nav-lateral">`, 56 px, padding `0 8px`, gap 10, radius 12; active `bg-sidebar-accent`, `aria-current="page"`.

```
[avatar 32]  [name 13/500 ……………………………]  [state dot 8]
             [state line 12/16 ……………………]
```

- **Avatar**: when `botId` resolves to a bot, its `BotAvatar` (look from `resolveLook`, 03 §14.3); else a 32 px routine tile (radius 9, `bg-muted`, lucide `CalendarClock` 16). Mood from the state below.
- **State** (`routineState(row, runs, now)`, pure, a table test in R5-T6):

| State | When | Mood | State line | Dot |
|---|---|---|---|---|
| `needs-you` | a run session of it has `turn.phase === "waiting_permission"` or pending connector asks (§9.4) | `waiting` | "Needs you · {first ask title}" (attention colour) | `--chat-status-attention` |
| `running` | a `routineRuns` row for it has `outcome: "running"` | `working` | "Running · {elapsed}" (running colour) | `--chat-status-running` |
| `failed` | the newest run's outcome is `failed` and the routine is enabled | `blocked` | "Failed · {lastResult}" (destructive text, ellipsis) | `--destructive` |
| `paused` | `enabled === false` | `asleep` | "Paused" + (" · {lastResult}" when `lastResult` is non-empty; main writes the pause reason there, RT25) | muted at 40% |
| `once` | `runAt != null && schedule == null` | `waiting` | "Once on {date, time}" | done colour |
| `webhook` | `schedule == null && runAt == null && webhookToken != null` | `idle` | "Webhook" + (" · fired {n}× today" when `n > 0`, from `recentRuns` trigger `webhook`) | done colour |
| `manual` | `schedule == null && runAt == null && webhookToken == null` | `idle` | "On demand" | done colour |
| `scheduled` | otherwise | `idle` | `scheduleLabel` (§8.5) | done colour |

  The dot never carries meaning alone: the state line says it, and the link's accessible name is "{name}, {state line}". The name is `--muted-foreground` when paused (canvas "Test watch").
- Order: running first, then by name (locale compare, as phase 1). No pinned group (routines had none).
- **Row menu** (`routine-row-menu.tsx`; context menu and ⋯ `NavList.Action`, one item list, 03 §7.4): Run now, Pause / Resume, Edit (→ `/routines/$routineId/edit`), Copy webhook URL (when `webhookUrl`), — , Delete routine (destructive, §9.2 confirm).

### 6.4 Auto-replies group

Label "Auto-replies" (12 muted, `padding: 14px 8px 6px 16px`), shown when `bots.senderChats` has any row with `autoReply != null`. Row 56 px: the bot's avatar 32, "{bot} → {sender}" (500), "on {App} · On|Paused" (12 muted), `ConnectorMark` 18 of the platform (03 §15); link to `/bots/$botId/chats/$sessionId` with `transition: "nav-lateral"` (03 §11.5, RT3). Busy sessions (`turn.isBusy` of the sender session) show the running dot beside the mark. A paused one has its name muted.

### 6.5 Empty, loading, error

- Empty (no routines, no auto-replies): the search field, then compact `Empty` "No routines yet" (the page carries the full empty state, §7.1); footer New routine stays.
- Loading: `NavList.Skeleton` × 5 at 56 px; error: foundation's "Couldn't load" + Retry (`routinesCollection.utils.resync()`).

---

## 7. The routines pages (`features/routines/page/`, `home/`)

### 7.1 `/routines` (home)

- **No routines** (canvas `RoutineStates` first panel): centred in the pane, gap 6: `BotAvatar` 56 (`blob`, neutral, `asleep`), "No routines yet" (600), "Create one, or ask a bot to schedule something: “every weekday at 9, summarise my inbox.”" (13/18 muted, max 300), primary "New routine" (32 px) → `/routines/new`. Below it, "Or start from a template" chips (§8.6) linking to `/routines/new?template=<id>`.
- **With routines**: the pane shows the most recently visited routine: the area's `lastLocationByArea` (foundation) sends the rail there; a bare `/routines` renders a compact `Empty` "Pick a routine, or make a new one" with New routine and the template chips.

### 7.2 Routine page (`/routines/$routineId`, canvas `Routines`)

Layout inside the pane: a column (flex 1) and, when `?run=` is set, the run report (§7.4).

- **Header** (`padding: 20px 24px 0`, gap 12): avatar 40 (§6.3 rule), name 18/24 600, sub-line 13/18 muted "{scheduleLabel} · {folder} · made by {bot}" where folder = "runs in its own folder" for `workspaceId == null` or a `kind: "routine"` workspace, else "runs in {workspace label}" (RT16), and "made by {botName}" only when `botName`. Buttons (32 px, radius 8, `variant="secondary"`): **Run now**, **Edit** (→ `/routines/$routineId/edit`), a ⋯ `DropdownMenu` (Copy webhook URL, Delete routine), and a registry `Switch` (`aria-label="Routine on"`, `checked = enabled`).
- **Cards** (3-column grid, gap 8, `padding: 16px 24px 0`; each `padding: 12px 14px`, radius 12, `bg-card`; label 12/16 muted, value 500):
  - **Next**: `nextRunAt` formatted ("Tomorrow, 8:00"; `Intl.DateTimeFormat` with a relative day word from `chatStamp`'s rules, 03 P17) or "—" (manual/webhook/paused).
  - **Last**: `lastRunAt` + " · {outcome of the newest run}" or "Never".
  - **Trigger** (replaces the canvas "Delivers to", F3): "Schedule", "Once", "On demand", or "Webhook" with the URL (mono 12, ellipsis) and a Copy icon button (`aria-label="Copy webhook URL"`, toast "Webhook URL copied.", RT7); while `webhookPublicPending`: "Creating your public webhook link…" (muted) and the loopback URL.
- **Instruction** (`padding: 20px 24px 0`): label "Instruction" (12 muted), the prompt in a card (`padding: 12px 14px`, radius 12, `bg-card`, 13/20), clamped to 6 lines with "Show all" (`Collapsible`).
- **Runs** (§7.3), then **Change it by talking to it** (§7.6) at the bottom of the column.

### 7.3 Runs list (`runs-list.tsx`)

- Title row (`padding: 20px 24px 8px`): "Runs" (13/600) + "{n} recent runs · each fire runs in a fresh session" (12 muted, canvas).
- Source (`runsView(routine, runRows)`, pure): the routine's attempts `recentRuns` (≤ 20, newest first; each `{ id, at, trigger, result, sessionId }` after §31.5 f) joined by `sessionId` to `routineRunsCollection` rows (the 03 §6.2 join) for outcome and live state; plus any `routineRuns` row of this routine whose session no attempt names (older sessions beyond the 20 attempts), after them. Attempts without a session render with outcome "Skipped" or "Failed" from their result kind (`CronRun.kind`, §31.5 f: `started`, `skipped`, `no-workspace`, `start-failed`, `timed-out`, `paused`; never parsed from `result`). Until §31.5 f lands the list is the `routineRuns` rows alone (sessionless attempts missing; the parity row stays red). At most 50 rendered; "Show {n} more" pages by 50.
- Row 48 px, radius 10, padding `0 8px`, gap 12, 13 px: dot 8 (outcome colour) · outcome word 92 px wide ("Running" running colour, "Completed" done, "Failed" destructive) · stamp 112 px muted (`chatStamp(startedAt)`) · result (flex 1, ellipsis; the attempt's `result`) · trigger 12 muted ("schedule", "webhook", "manual", "on creation"; `trigger ?? "schedule"`). A row with a session is a button toggling `?run=<sessionId>`; a sessionless attempt is plain text (search-only navigation, `replace: false` so Back closes it); the selected row is `bg-muted` with `aria-pressed="true"`.
- Empty: "This routine has not fired yet. Run it now, or wait for its next fire." (RT18 copy) with Run now.

### 7.4 Run report (`run-report.tsx`, canvas `Routines` right panel)

- **Placement**: at `xl` a 420 px panel inside the pane, `border-left: 1px solid var(--border)`, `margin-left: 8px`, resizable (registry `resizable`, min 360, max 560, width persisted as `prefs.panes["routines.run"]` through the pacer, foundation §7.5). Below `xl` the report **replaces** the column with a 44 px header whose leading button is "All runs" (clears `run`).
- **Header** 44 px (`padding: 0 12px 0 16px`): "Run · {stamp}" (500), outcome pill (6 px dot + word), Close (`aria-label="Close run"`, clears `run`). Sub-line (12 muted, `padding: 0 16px 8px`): "A run of this routine. It’s a report, not a conversation." (canvas; the old key `routines.runReadOnly` is remapped to this shorter string plus a separate "Pick another run, or edit the routine to change what it does." hint shown only when the transcript is empty).
- **Body**: the route renders `ChatView threadId={run} skin="bot" composer={{ readOnly: { reason: t("routines.run.readOnly") } }} slots={{ header: <RunReportFrame/> }}` from `features/chat` and passes it into `RoutinePage` as `renderRunReport(runId)` (features do not import each other). The kit hides the firing frame (RT21, §31.2) and renders what the session holds: bot bubbles, deliverables (03 §11.3a), the run's error card. "Open as a session" (a text button in the frame) navigates to `/sessions/$runId` (04 renders routine runs read-only with "Talk to the routine" back here, 04 §17.3).
- **Readiness**: the loader awaited `session.load()` for an enter/stay with `run` set (§5.3); a direct switch between runs re-runs the loader for the new `run` (`loaderDeps`), so the report commits only once hydrated (no empty flash). `<Activity mode>` keeps the last report mounted while hidden (React 19.3), so reopening the same run is instant.
- **Live runs**: a `running` run streams in the report like any open thread (the chat kit's subscription); the runs list row updates from `routineRuns` batches.

### 7.5 Delete, rename, gone

Rename is the form's Name field (no inline rename; the canvas has none). Delete from the header ⋯ or the row menu (§9.2). Gone: §5.5.

### 7.6 Change it by talking to it (`editor-chat.tsx`, canvas `RoutineStates` second panel)

- A card (radius 12, `bg-card`, padding 16, gap 10) titled "Change it by talking to it" (13/500) with a small transcript and a 40 px pill field "Tell the routine how to change" (placeholder; the old example text becomes its `aria-description`: "For example: “every morning at 9 instead”, “stop”").
- Enter (trimmed, non-empty) → the user bubble (right, `bg-muted`, radius `18 18 4 18`) appears at once; then typing dots + "Changing…" (12 muted) while `routines.editByChat({ routineId, text })` runs (up to main's 90 s); the reply bubble (left, radius `4 18 18 18`) shows `reply`. The row, cards and schedule update through the `routines` change batch main emits (`cronjobs-updated`).
- The exchange log is ephemeral: a TanStack Store keyed by routine id, last 10 exchanges, `sessionStorage` (like 03's drafts). The field is disabled while a request is pending (one at a time, parity).
- Errors (typed): `NOT_FOUND {entity:"routine"}` → the page's gone view; `TIMEOUT` (after §31.5; today main throws a plain "The routine did not answer in time.") → reply bubble in muted destructive "The routine didn't answer in time. Try again."; `INTERNAL_SERVER_ERROR` → "Couldn't change the routine." with the server's message shown as secondary text (display only, never matched). The input keeps the text on failure.
- The live region (`aria-live="polite"`) announces the reply once.

---

## 8. The routine form (`features/routines/form/`, canvas `RoutineCreate`)

### 8.1 Dialog layout

Registry `Dialog`, 640 px (`max-width: calc(100vw − 48px)`), radius 16, `bg-popover`. Header `padding: 16px 16px 0 20px`: "Create routine" / "Edit routine" (16/600) + Close. Body `padding: 16px 20px 0`, gap 14. Footer `padding: 16px 20px 20px`, gap 8: the template line (create only, §8.6) left, **Cancel** (secondary) and **Create** / **Save** (primary) right.

Fields, in canvas order (labels 12 muted, gap 6; inputs 40 px radius 10 `bg-muted`):

| Label | Field | Control | Rules |
|---|---|---|---|
| Name | `name` | `input`, placeholder "e.g. Morning brief" | trimmed, ≤ 80 UTF-16 units; empty allowed (main derives it from the first line of the instruction, `deriveName`, 57 chars + "…") |
| Instruction | `prompt` | `textarea` 84 px, auto-grow to 240, placeholder "What should run? Write it to stand alone." | trimmed, required ("An instruction is required."), ≤ 16,000 units (gap fix; today unbounded) |
| Schedule | `schedule` | segmented `toggle-group` (36 px track, radius 10, items radius 7): Hourly, Daily, Weekdays, Weekly, Once, Manual, Custom (canvas order) | §8.3 |
| At / On / Run at / Cron | per preset | §8.3 | §8.3 |
| Folder | `workspaceId` | `Select` 40 px: "Its own folder" (`null`), pickable workspaces (04 `usePickableWorkspaces`), "Choose a folder…" | hint "Where the run happens. Pick a project when the instruction reads its code, tests or dependencies."; the template warning (§8.6) |
| Webhook | `webhook` | `Switch` row | hint "Fire this routine with an HTTP POST. Signed in, the URL is public: paste it into any service that sends webhooks; events are held for you for up to a day." (parity) |
| Run once now | `testRun` (create only) | checkbox row "Run once now, so you can see it work before the schedule does." (canvas) | default on (parity) |

The canvas's "Run by" and "Deliver to" rows are not rendered (F3). The old footer note "Each fire runs in a fresh session of its own…" becomes the dialog's `aria-describedby` description (visually hidden; the Runs title says it on the page).

### 8.2 TanStack Form wiring

Same kit shape as 03 §9.2 (`createFormHook` with `TextField`, `TextAreaField`, `SegmentedField`, `TimeField`, `WeekdayField`, `DateTimeField`, `SelectField`, `SwitchField` wrapping registry `Field` parts), `validationLogic: revalidateLogic({ mode: "blur", modeAfterSubmission: "change" })`, `validators: { onDynamic: RoutineFormSchema }`, errors displayed only when `isBlurred || submissionAttempts > 0`, and **`onSubmit` persists `v.parse(RoutineFormSchema, value)`** (parse-on-submit; the Standard Schema bridge drops outputs, 03 F1/review #5). The field kit is a copy of 03's `form-kit.ts` factored into `components/form-kit/` (both features use it; §31.3 moves 03's file there).

**Remote sync without validation side effects** (edit dialog; 03 §6.4 concurrency rule, review #6): the form seeds `defaultValues` from the row and keeps a per-field **baseline**; when the live row changes (for example edit-by-chat changed the schedule in another window, or a run updated `lastResult`), each field whose current value equals its baseline is replaced with `form.setFieldValue(name, value, { dontUpdateMeta: true, dontValidate: true, dontRunListeners: true })` and its baseline moves; edited fields are kept, and "Changed in another window" shows above the footer. Save sends only fields whose value differs from the baseline, so it never reverts a remote change. The schedule is compared as its **composed** value (`scheduleFromDraft(draft)`), not per sub-field, so a remote cron change and a local time edit conflict as one field (the local value wins on save, the notice warned).

### 8.3 The schedule editor (`schedule-field.tsx`)

```ts
// shared/bots/schedule.ts (03 §10) gives ScheduleDraft, composeCron, decomposeCron; this form adds once/manual/custom:
type RoutineScheduleDraft =
  | { preset: "hourly"; minute: number }
  | { preset: "daily" | "weekdays"; time: string /* HH:MM */ }
  | { preset: "weekly"; time: string; weekday: Weekday }
  | { preset: "once"; runAt: string /* local datetime */ }
  | { preset: "manual" }
  | { preset: "custom"; cron: string };
export function draftFromRoutine(row: Pick<RoutineRow, "schedule" | "runAt">): RoutineScheduleDraft;   // decomposeCron; non-preset cron → custom; runAt → once; neither → manual
export function toRoutineWrite(d: RoutineScheduleDraft): { schedule: string | null; runAt: number | null };
```

- Controls per preset (one row under the segmented control, gap 8, 13 px): Hourly → "At minute" (0–59 number input, 64 px); Daily, Weekdays → "At" time input (120 px); Weekly → "On" weekday `toggle-group` (7 × 32 px, full day names as labels) + "At"; Once → "Run at" `datetime-local` with `min` = now (rounded up to the minute); Manual → none; Custom → "Cron expression" mono input, placeholder `0 9 * * 1-5`.
- Hint (12 muted, beside the controls, canvas): Manual → "Runs only when you press Run now or fire the webhook."; Once → "Fires once at that time, then turns itself off. Local time; a moment the app slept through fires when it wakes."; otherwise "Local time. Fires only while the app is running." (parity copy).
- **Next-fire preview** (new): for Hourly … Custom, "Next: {date, time}" computed with the shared `nextRun(expr, now)` (the existing signature, `cron-store.ts:237`; it parses internally) after `parseCron(expr)` has validated it (F1); for a Custom expression that does not parse, the field error is the parser's `CronParseError` **code** mapped to i18n (`fields`, `seconds`, `names`, `range`, `step`), never its message.
- Validation (schema, §8.4): Custom empty → "A cron expression is required."; Custom invalid → the mapped parser error; Once empty → "Pick a date and time to run at."; Once in the past at submit → "That time has already passed." (parity copy).
- Edit mode on a routine whose cron is not a preset opens on **Custom** with the stored expression (no silent conversion; parity with 03 P41's "custom stays untouched").

### 8.4 Schema and submit (`schema.ts`, `submit.ts`)

```ts
const trimmed = (max: number) => v.pipe(v.string(), v.trim(), v.maxLength(max, "too-long"));
export const RoutineFormSchema = v.object({
  name: trimmed(80),
  prompt: v.pipe(trimmed(16_000), v.minLength(1, "instruction-required")),
  schedule: RoutineScheduleDraftSchema,          // variant on preset; custom: v.check(isValidCron, "cron-invalid"); once: v.check(inFuture, "once-past")
  workspaceId: v.nullable(WorkspaceId),
  webhook: v.boolean(),
  testRun: v.boolean(),
});
```

**Create** (`/routines/new`):
1. `id = "routine-" + crypto.randomUUID()` (minted when the dialog mounts; `RoutineId` shape, spec 00 caller ids).
2. `tx = routinesCollection.insert(optimisticRow)` with `{ id, name, prompt, ...toRoutineWrite(schedule), webhookToken: null, workspaceId, botId: null, enabled: true }` and the derived fields filled as 03 §10.3 (`nextRunAt: null`, `webhookUrl: null`, `webhookPublicPending: webhook`, `botName: null`, `recentRuns: []`, `lastRunAt: null`, `lastResult: null`, `createdAt: now`); `toInsertInput` sends `RoutineCreateInput & { id }` including `webhook`. `await tx.isPersisted.promise`.
3. If `testRun`: `routines.run({ id, trigger: "create" })`, not awaited; a failure toasts "The routine was made, but its first run didn't start." (today swallowed; gap fix).
4. Navigate to `/routines/$id` with `replace: true` (the dialog's history entry is replaced by the page), `transition: "nav-forward"`.

**Edit**: the dirty patch (value ≠ baseline; `schedule` composed) → `routinesCollection.update(id, (d) => Object.assign(d, patch))`; close with `history.back()`.

Failures (typed only, R5-T11 greps for message matching):

| Error | Handling |
|---|---|
| `CONFLICT` (taken id) | mint a new id, retry once, else form error "Couldn't save the routine." |
| `BAD_REQUEST { field: "schedule", detail }` (after §31.5) | the Schedule field's error "Main couldn't read that schedule." + `detail` as secondary text |
| `NOT_FOUND {entity:"routine"}` (edit) | toast "This routine was deleted", close, the page shows gone |
| `INTERNAL_SERVER_ERROR` | form-level error "Couldn't save the routine." with the message as secondary text; values kept |

A dirty dialog closed by Escape, Cancel or the mask's Back asks "Discard changes?" through the router's `useBlocker` (03 §9.4).

### 8.5 `scheduleLabel` (`schedule-label.ts`)

Port of `describeSchedule` (`routines-panel.tsx:380-414`) with its cases, i18n: "Once on {date}" (`Intl` medium/short), "On demand", "Every hour" (or "Every hour at :{mm}" when the minute is not 0; new), "Daily at {time}", "Weekdays at {time}", "{Weekday}s at {time}", "Custom: {cron}". Also used by the sidebar and the header.

### 8.6 Templates

`ROUTINE_TEMPLATES` (6: morning-brief, inbox-triage, pr-digest, failing-tests, dependency-watch, week-in-review) move to `shared/routines/templates.ts` verbatim (prompts are English and model-facing; names and descriptions stay `routines.templates.<id>.*`). In the create dialog footer: "Or start from a template:" + the names as link buttons separated by "·" (canvas). Picking one fills name, prompt, preset and time, and for `needsWorkspace` templates sets `workspaceId` to `prefs.lastPickedWorkspaceId` when pickable (parity "the active workspace"); if still `null`, the Folder field shows "This instruction reads a project's code. In its own folder there is nothing to read." (parity warning). `?template=<id>` preselects one (the home chips link there). Picking a template when the form is dirty asks "Replace what you wrote?".

---

## 9. Routines data (`features/routines/data/`)

### 9.1 Sources

| Data | Source | Loaded by | Live / invalidated by |
|---|---|---|---|
| Routines | `routinesCollection` (`db.routines`, lazy) | `routines.tsx` | change batches (`cronjobs-updated`, cron-store write hook, the 60 s re-diff for `nextRunAt`) |
| Runs | `routineRunsCollection` (derived from sessions, keyed by `sessionId`) joined with `RoutineRow.recentRuns` attempts | `routines.tsx`, `$routineId` | change batches from every sessions trigger **and** from cron writes (`onRoutinesWritten` notifies `routineRuns` as well as `routines` after §31.5 f, so a result recorded after the session's own notification still arrives) |
| Run transcript | chat kit `session(runId)` | `$routineId` loader when `run` is set | the chat kit's subscription |
| Bots (avatars, names) | `botsCollection` | `routines.tsx` | change batches |
| Workspaces (folder names, picker) | `workspacesCollection` (`startSync`) | shell | change batches |
| Auto-replies | `bots.senderChats` query | `routines.tsx` | `bots.events` **and** `messaging.events { updated }` **and** a sender-session insert/delete (03 §6.1 row, reused) |
| Sender-session busy | `sessionsCollection` `turn` | shell | change batches |
| Webhook URL, pending flag | the routine row | — | change batches (main re-diffs on relay callbacks, spec 00 B.2) |

### 9.2 Mutations (`actions.ts`)

Handlers are `ipcCollectionOptions`'s (await the echo *received*); actions needing visible state await `tx.isPersisted.promise` outside the handler (spec 00 B.3).

| Action | Client call | Main | Final row | Failure → handling |
|---|---|---|---|---|
| Create | §8.4 | `createRoutine(input, id)` (derives name, mints webhook token, computes `nextRunAt`) | server row replaces the optimistic one on the echo | §8.4 table |
| Edit | §8.4 | `updateRoutine` | echo | §8.4 table |
| On / off | `routinesCollection.update(id, (r) => { r.enabled = next })` | `updateRoutine({ enabled })` | echo (main recomputes `nextRunAt`) | `NOT_FOUND` → rollback + toast "This routine was deleted"; others → rollback + toast "Could not update the routine." (RT9) |
| Run now | `routines.run({ id, trigger: "manual" })` | fires unless a run is in flight (then records "skipped: the previous run is still going") | a `routineRuns` insert arrives | toast "Routine started." on resolve; `NOT_FOUND` → gone; others → toast "Could not start the routine." (RT10) |
| Delete | navigate away (§5.5), then `routinesCollection.delete(id)` | `removeRoutine`: stops run sessions, removes them, their transcripts, the routine dirs | row gone; its runs vanish from `routineRuns` | `NOT_FOUND` → resolves (`idempotentDelete`, 03 §24.5 lists routines); others → rollback, the AlertDialog stays open with "Could not delete the routine." (RT11) |
| Edit by chat | `routines.editByChat({ routineId, text })` | editor session turn restricted to the cronjob tool | batches for whatever it changed | §7.6 |
| Copy webhook URL | `navigator.clipboard.writeText(webhookUrl)` | — | — | toast "Couldn't copy" |
| Choose a folder… (form) | `system.dialog.openFolder()` → `workspaces.add({ path })` → wait for the row (04 §6.5 `awaitRow`) → select it | `addWorkspace` | workspace row | toast "That folder could not be added." (parity) |

Read-only fields: only `RoutineUpdateInput` fields are ever written (`schedule`, `runAt`, `prompt`, `enabled`, `name`, `botId`, `workspaceId`, `webhook`); anything else throws `ReadOnlyFieldError` in the handler (spec 00 B notes). The renderer never writes `botId` (provenance, F3).

### 9.3 Check-in routines

A routine created by a bot's check-in (03 §10: `botId === bot.id && prompt === CHECK_IN_PROMPT`) is an ordinary routine here: it lists with the bot's avatar and "made by {bot}". Its page shows a one-line note "This is {bot}'s check-in. Its schedule is also on the bot." with "Open {bot}" → `/bots/$botId?tab=details`, and editing it here is allowed (03 §10.1 reads a changed cron back as "Custom schedule"). 03's "Edit in Routines" link targets `/routines/$routineId/edit`.

### 9.4 Attention and sound

Routine runs are excluded from the sessions sidebar (04 F14) and 03 counts only check-in runs, so an ordinary routine run waiting on a permission or a connector would have no attention owner. This phase adds **`RoutinesNeedsYou`**, a contributor to the shell's needs-you group (foundation §7.2, merged with bots and sessions by oldest waiting, 04 §26.1): every session with `routineId != null` whose routine is not a bot's check-in (those stay 03's) and whose `turn.phase === "waiting_permission"` or that has pending connector asks (`connectors.events` keyless, 03 §6.1); row "{routine} needs you" linking to `/routines/$routineId?run=$sessionId`, where the run report renders the chat kit's permission list (the read-only composer keeps `PermissionList`, 02 §6.2). The sidebar row's state gains `needs-you` (above `running`: attention dot, "Needs you · {title}"). Sound: `routine-fired` from main's live routine-start notice (§23.1).

---

## 10. Artifacts (`/artifacts`, canvas `Artifacts`, `ArtifactsPreview`, `ArtifactsStates`)

### 10.1 Sidebar (`ArtifactsSidebar`, replaces phase 1's static list)

Padding `8px 8px 8px 0`, gap 2, 13 px:

1. "Search artifacts" field (32 px, radius 9, `bg-muted`), bound to `q` through a 150 ms pacer debounce with `replace: true`; Escape clears.
2. **Type** label (12 muted, `padding: 6px 8px 6px 16px`), then four 32 px rows: All, Files, Images, Links, each with its count at the right (12 muted). Active row `bg-sidebar-accent`; each is an `AppLink` that sets or clears `type` (search-only). Counts come from the **searched** set (`q` and `from` applied, `type` not), so a count equals what a click shows (parity AR4).
3. **From** label, then one row per source that has at least one artifact: bots first (avatar 18 + name), then workspaces (folder icon + label; `kind: "auto"` reads "Default workspace"; routine and bot workspaces are not listed, their artifacts count under the bot or "Routines"), then "Routines" when routine runs produced any. Each sets or clears `from` (`bot:<id>`, `workspace:<id>`, `routines`).
4. Footer hint card (`padding: 10px 12px`, radius 10, `bg-card`, 12/16 muted): "Files the agent writes and pages it opens are collected here, per session and per bot." (canvas).

### 10.2 Header (`padding: 0 16px 0 20px`, 52 px)

"Artifacts" (15/600), "{n} items" (12 muted; "1 item"), spacer, a `toggle-group` Grid / List (30 px, `bg-card`, items 26 px radius 6; `view`), and a Sort `DropdownMenu` button "Newest ▾" (Newest, Oldest, Name; `sort`). In preview mode the header reads "{Type label} · {n}" (canvas "Files · 74").

### 10.3 Data, filters, sources (`data/`)

- Rows: `artifactsCollection` (`db.artifacts`, lazy; `ArtifactRow = SessionArtifact`, `id = ${sessionId}::${location}`, `kind`, `title`, `location`, `toolName`, `workspaceId`, `sessionId`, `createdAt`, `updatedAt`).
- **Source of a row** (`sources.ts`, pure over live rows) is two separate facts. **Provenance** (what filters match): `botIds` = `{ owner.botId }` for bot-owned sessions ∪ `{ RoutineRow.botId }` for routine runs whose routine a bot made (ownerless check-in runs included, 03 §6.2); `routine` = the session's `routineId`; `workspaceId` = the artifact's. **Display source** (the card label): bot-owned → bot name; routine run → routine name; otherwise the session label. `from=bot:<id>` matches when `botIds` contains the id, `from=routines` when `routine != null`, `from=workspace:<id>` on `workspaceId`; so a check-in run's artifact appears under its bot **and** under Routines. Labels on cards: bot name, routine name, or the **session label** (canvas: "Clean up a spreadsheet") falling back to the workspace label; a session that is gone reads "Deleted session" (parity `artifacts.unknownSession`).
- **Filter** (`filters.ts`, pure, table-tested): `q` substring (accent/case-insensitive) over `title`, `location`, the **session label** (parity `artifacts-panel.tsx:220-232`: sender chats and runs keep their own titles) and the display source label; `type` equals `kind`; `from` matches the source. Sort: `newest` `updatedAt` desc (main's order), `oldest` asc, `name` by title with `localeCompare(…, { numeric: true })`.
- **Groups** (grid and list): day headers by `updatedAt` in local time: "Today", "Yesterday", weekday within 6 days, else a short date (`chatStamp`'s day rule, 03 P17); `sort=name` has no groups.
- **Format** (`components/artifact-kind`, `artifactFormat(location, kind)`): by extension: PDF (red tile), Word (blue), Spreadsheet (`xlsx|xls|csv`, green), Slides (`pptx`, orange), Markdown/Text (neutral), Code (neutral, mono glyph), Image (`kind: "image"`, tinted thumbnail), Archive, Audio, Video; links "Web page" (sky). Tones are fixed palette colours with a contrast-checked glyph (R5-T30). Canvas sub-lines like "PDF · 412 KB" become "PDF" (F6).

### 10.4 Grid and list

- **Grid** (canvas): `grid-template-columns: repeat(auto-fill, minmax(200px, 1fr))` (4 columns at the 1280 board, 3 at 1000, 2 at 800), gap 10, `padding: 4px 16px 0 20px`. Card radius 12, `bg-card`: a 96 px thumb area (`bg-muted`, radius `10 10 0 0`) with the format tile (40 × 50, radius 6, shadow) or, for images, the image (`object-fit: cover`) loaded lazily; for links, a text skeleton with the favicon-less "Web page" label (canvas); below, `padding: 10px 12px 12px`: title (13/18 500, ellipsis), format label (12 muted), a footer row "source … stamp" (12 muted). The whole card is a button (select = `item`); the ⋯ menu button appears on hover/focus in the thumb's corner.
- **List** (canvas `ArtifactsPreview` left column): rows 48 px, radius 10, padding `0 8px`, gap 10: format tile 28 (radius 7), title (13/500) over "source · stamp" (12 muted); selected `bg-muted`.
- **Thumbnails**: `files.readImageAsDataUrl({ filePath: location, hostRoot: dirname(location) })` (the old code's containment root, parity) as a query keyed by `id + updatedAt` (`staleTime: Infinity`, `gcTime: 300_000`), enabled only when the card is within 400 px of the viewport (`IntersectionObserver`); a failure shows the tile.

### 10.5 Rendering budget

The ledger holds up to 2,000 rows (`MAX_ARTIFACTS`, main). No virtualiser is installed and none is added (§3), so the page renders a **bounded window** (`window.ts`, the chat kit's moving-window technique, 02 §10): the filtered, sorted, grouped items are flattened into rows (a grid row = `columns` cards, measured from the container width; group headers are rows); at most `MAX_MOUNTED = 400` cards are mounted at any time, as a contiguous slice; the rows above and below the slice are two spacer elements sized from measured row heights (180 px per grid row, 48 px per list row until measured). Scrolling moves the slice (recomputed on `scroll` through a rAF throttle from `scrollTop` and the cumulative row offsets) and **evicts** rows from the far side, keeping the first visible row's offset (the anchor rule of 02 §10). Selecting `item` scrolls its row into the slice. R5-T31 measures 2,000 rows: first paint < 400 ms, scroll ≥ 50 fps median, and never more than 400 cards in the DOM. If it fails, the budget is lowered; adding `@tanstack/react-virtual` would be a new dependency and a separate PLAN decision, not a fallback of this spec.

### 10.6 Empty, no match, loading

- Empty (no rows at all; canvas): centred 56 px tile (radius 18, `bg-muted`), "No artifacts yet" (600), "Files the agent writes and pages it opens are collected here. Start a session or ask a bot for something." (12 muted).
- No match (filters exclude everything): "Nothing matches “{q}”" (or "Nothing here" when only `type`/`from` filter) + "Try a different name, path, or session title." + **Clear search** (clears `q`, `type`, `from`).
- Loading: skeleton cards (8) / rows; error: "Couldn't load artifacts" + Retry (`resync()`).

---

## 11. Opening, previewing and acting on artifacts (`features/artifacts/page/`, `data/open.ts`)

### 11.1 Selection and the preview pane (canvas `ArtifactsPreview`)

- Clicking a card or row sets `item` (search-only). With `item` set, the page switches to the list column (420 px, `padding: 0 12px`) and a preview pane (flex 1, `margin: 0 8px 8px 0`, radius 12, `bg-card`); below `lg` (1000 px) the preview replaces the list with a 44 px back row "All artifacts".
- Preview header 48 px (`padding: 0 8px 0 16px`, gap 8): title (500, ellipsis), then secondary 32 px buttons by kind: files **Show in folder**, **Open** (OS default app); links **Open in browser**, **Go to session**; always **Copy path** / **Copy URL**. A ⋯ menu holds the rest of §11.4.
- Preview body (`margin: 0 12px 12px`, radius 8): `components/file-preview` (04 §13.3: code/text with `@tanstack/highlight` and a 1 MB cap, Markdown, images, `.pptx` decks; binary/office "This file can't be shown here" + Open) with `hostRoot = dirname(location)`. PDFs and HTML render the fallback with **Open** (the Browser-tab path of 04 F8 needs a session dock and is not used here). Links render a card: the URL (mono), the source and stamp, **Open in browser**, **Go to session**.
- Arrow keys move the selection in the list (roving focus); Enter opens (§11.2); Escape clears `item`.

### 11.2 Open (double-click, Enter, header "Open")

Port of `openArtifact` (`artifacts-panel.tsx:280-337`), minus the in-session preview (AR10):

1. Links → `system.openExternal({ url: location })`.
2. Files: probe `files.readText({ filePath: location, hostRoot: dirname(location), maxBytes: 1 })`:
   - thrown `NOT_FOUND {entity:"file"}` (the files procedures throw typed errors, `main/rpc/procedures/files.ts:13-20`: `not-found` → `NOT_FOUND`, `outside-root` → `FORBIDDEN`, any other reason → `CONFLICT {reason}`) → inline notice on the row and in the preview "This file is no longer on disk." (parity; the row disappears by itself within 2 s when main's re-diff drops it, F6);
   - thrown `CONFLICT {reason:"not-a-file"}` (a directory, e.g. an app build) → `system.showItemInFolder({ path })` + toast "Opened in your file manager." (parity);
   - thrown `FORBIDDEN` or another `CONFLICT` reason → fall back to `system.openPath` (main's own guard decides, parity with the old fallback to `openLocalFile`);
   - no error: `system.openPath({ path })` → `OpenFilePathResult`: `opened` → nothing; `revealed` → toast "Opening that file would run it, so it was shown in your file manager instead."; `refused {missing}` → "That file is no longer there."; `refused {outside|invalid}` → "That file can't be opened from here." (the `openFile.*` copy, remapped).

The branches read `isDefinedError(e) && e.code` and `e.data.reason` only, never message text; R5-T15 runs the probe through the real `filesRouter` over the memory transport.

### 11.3 Go to session

| The artifact's session | Target |
|---|---|
| a session with no owner and no `routineId` | `/sessions/$sessionId` |
| `owner.role === "forever"` | `/bots/$botId` |
| `owner.role === "sender"` (or `"routine"` owner role, 03 §6.2) | `/bots/$botId/chats/$sessionId` |
| `routineId != null` | `/routines/$routineId?run=$sessionId` |
| session gone | the action is disabled with the tooltip "Its session was deleted" |

All with `transition: "nav-lateral"` (different area).

### 11.4 Row menu (one item list: context menu, ⋯ button, preview ⋯)

Canvas `ArtifactsStates` (208 px, radius 14, 32 px items): **Open** (files) / **Open in browser** (links), **Show in folder** (files: `system.showItemInFolder`), **Copy path** (files) / **Copy URL** (links) (`navigator.clipboard.writeText`, toast "Copied"), **Go to session**. "Remove from artifacts" is not rendered (F6).

### 11.5 Mutations

None: the table is read-only (spec 00 B.2). Everything here is a query, a system call or navigation.

---

## 12. Library shell and Connectors (`features/library/`, canvas `SettingsConnectors`, `ConnectorStates`)

### 12.1 The Library sidebar

Phase 1's static `LibrarySidebar` gains a header "Library" and icons: Connectors (`Plug`), Messaging (`MessagesSquare`), MCP servers (`Server`), Skills (`Sparkles`), Tools (`Wrench`); counts at the right: connected connectors, connected platforms, enabled MCP servers, installed skills (each from its already-cached query; absent until loaded, never a fetch from the sidebar). Every Library page uses the settings page grammar (§17.4): a 680 px centred column, `padding-top: 40px`, `<h1>` 22/600, a 13 px muted description.

### 12.2 Data

| Data | Source | Live / invalidated by |
|---|---|---|
| Catalogue | `@abacus-ai/connectors/registry` (static) | — |
| Statuses | `connectors.statuses` query (`staleTime: 60_000`, parity) | `connectors.events { status-changed }`, `settings.events { credentials-changed }`, `messaging.events { updated }` (parity LB2) |
| Pending asks (for the request card) | `connectors.events` (keyless, lossless-actionable, snapshot first) | the iterator (03 §6.1) |
| Chrome present | `browser.hasGoogleChrome` query (`staleTime: Infinity`) | — |
| Running sessions (MCP refresh after connect) | `sessionsCollection` where `status === "running"` | change batches |

Cards whose status has `reason === "not-offered"` are hidden once statuses load (parity).

### 12.3 The page

Header: "Connectors", description "Give bots and sessions access to your tools through Abacus.AI. Each one asks before anything leaves your computer." (canvas). A 32 px search "Search connectors" (`q`, 150 ms debounce) and the category segmented control (Featured, **Abacus.AI**, Productivity, Data, Development, Infrastructure, Payments, Support, Web; `category`; hidden while searching, since search covers all categories). Every platform connector is registry category `abacus-connectors` (`packages/connectors/src/registry.ts:185`), so the **Abacus.AI** tab lists them (the canvas's Gmail, Calendar, Slack, GitHub rows live there), and **Featured** = category `featured` ∪ platform connectors with `onboarding: true` (the canvas's featured rows). `visibleTabsFor(entry)` is pure; R5-T17 asserts every catalogue entry that is not `messaging` and not hidden by status is reachable from at least one tab without searching. Two grouped cards (radius 14, `bg-card`, `padding: 0 4px`):

- **Connected**: statuses `connected` or `pending` in the category (all categories when searching), and `credential`/`mcp` connectors the status reports installed.
- **Available**: the rest.

Row (min-height 52, `padding: 8px 12px`, gap 12): `ConnectorMark` 28 (03 §15; registry id → mark id through a table, unknown → neutral tile with the initial), name (500) over the detail (12 muted: `status.account` + the registry description when connected, else the description), a `StatePill` ("Connected" done, "Connecting…" running, "Reconnect" attention when `status.state === "unavailable"` with a `reason` other than not-offered), and a 30 px button: **Manage** (connected) → `?connector=<id>`; **Reconnect** → the connect flow; **Add** (available) → the connect flow. The row itself is also a link to the sheet. Search with no result: "No connectors match that search." (parity).

### 12.4 The connect flow (`connect-flow.ts`, port of `connect-flow.tsx` + `connectors-panel.tsx:163-263`)

`useConnectFlow()` returns `{ start(connectorId), cancel(), state: { connectorId, phase: "idle" | "hop" | "fields" | "pairing" | "signing-in", error? } }`, one per document (a module store), so only one hop runs at a time (parity):

1. `connectUi(entry)` (registry) decides: `browser-hop` (platform connectors, MCP `oauth`), `fields` (credential, MCP `token`/`key`/`oauth-client`), `pairing` (messaging) or `none` (MCP `auth: "none"`).
2. **Platform** connectors first check `connectors.statuses`: `reason === "not-signed-in"` → `auth.abacus.start()` (main's sign-in window; outcome `cancelled` stops quietly; success toast "Abacus.AI is successfully connected", parity) and continue.
3. **Chrome-required** MCP entries (`requires: "google-chrome"`) with `browser.hasGoogleChrome === false` → warning toast (15 s) "{name} drives Google Chrome, and Chrome was not found on this computer. Install it from google.com/chrome and the browser tools will work." (parity), then continue.
4. `browser-hop` / `none`: `connectors.connect({ connectorId })`; toast "Finish connecting {name} in your browser…" for hops. A **3 min watchdog** (parity `CONNECT_WATCHDOG_MS`) cancels with `connectors.cancelConnect()` and an inline error. Starting another connector while one hops cancels the first with toast "Stopped adding {name}."; clicking the same row again retries.
5. `fields`: opens `ConnectorFieldsDialog` (§12.6) → `connectors.submitFields({ connectorId, values })`.
6. `pairing`: `connectPlatform(platform)` first (below), then navigates to `/library/messaging?platform=<platform>` (the pairing UI lives there, F7). **`connectPlatform(platformId)`** (`features/library/messaging/connect.ts`, port of `messaging-connectors.tsx:153-169`): read the snapshot; if `gatewayEnabled === false`, await `messaging.updateSettings({ gatewayEnabled: true })`; then await `messaging.updatePlatform({ platformId, enabled: true })`; the returned snapshot replaces the cache. It is awaited before any web login or shared pairing starts.
7. Outcome `ConnectorOutcome`: `{ ok: true }` → toast "{name} connected" (platform) / "{name} added." (others), then `mcp.refresh({ workspaceId, sessionId })` for **each running session** (the old code refreshed the active session only; running sessions are few, calls are parallel, failures logged); `{ ok: false, cancelled: true }` → nothing; `{ ok: false, error }` → the row's inline error "Couldn't add {name}. Try again." (or, for an MCP connector that was added but whose sign-in failed, "{name} was added, but the sign-in didn't finish: {error} You can retry from the MCP panel.", parity).
8. Leaving the page does **not** cancel a hop (the flow lives in the module store and the sheet or row shows it on return); closing the window does (main's own cleanup). This is a change from the old unmount-cancels rule, which lost hops on navigation. Changed (LB6 note in `parity.ts`).

### 12.5 The connector sheet (`?connector=<id>`, masked; canvas `ConnectorStates`)

Registry `Sheet` (side right, 420 px). Contents:

- Header: mark 40, name (16/600), `status.account` (12 muted), `StatePill`.
- **What it can do**: the registry's tools for platform connectors (`PlatformConnector.tools`, read-only rows with `capabilities.toolDescriptions.*` where a key exists, else the tool name), or the MCP entry's command/URL for MCP connectors, or the env var for credentials (never the value). Canvas scope toggles are not built (F16).
- **Setup guide** (when the registry has `setup` steps) and **Documentation** (`system.openExternal(docsUrl)`).
- States (canvas): *connecting* ("Finish connecting {name} in your browser…" / "A tab opened at abacus.ai. Sign in there and come back." + Cancel → `useConnectFlow().cancel()`), *failed* ("Couldn't add {name}. Try again." + the error line + Try again), *signed out* (platform connectors while `reason === "not-signed-in"`: "Sign in to Abacus.AI to add connectors" / "Connectors run through your Abacus.AI account. No card needed." + Sign in → `auth.abacus.start()`).
- MCP connectors with runtime status `auth-required` (§14.2 scope): "Sign in" → `mcp.oauthSignIn({ mode: "code", name: id })`; success toast "{name} is signed in and ready. It connects when your next session starts."; failure inline "Sign-in failed: {error}" (parity LB9).
- Footer: **Disconnect** (destructive text; AlertDialog "Disconnect {name}?" / "Bots and sessions lose its tools until you add it again." — new confirm) → `connectors.disconnect({ connectorId })`; toasts "{name} disconnected" / "{name} removed." and failures "Could not disconnect {name}. Please try again." / "Could not remove {name}." (parity); **Done** (closes: `history.back()`).
- Toasts use the registry `toast` (bottom left under the foundation's viewport rules); "Undo" is not offered (F16).

### 12.6 `ConnectorFieldsDialog` (TanStack Form)

Registry `Dialog` 480 px, title "Connect {name}"; description per kind (parity copy: oauth-client hint, credential storage note, MCP config note); optional setup steps; for `oauth-client` a read-only "Redirect URL: add this to your app" box with `mcpOAuthRedirectUri()` (`http://127.0.0.1:33418/callback`) and Copy. Fields from `fieldsFor(entry)` (parity: credential `fields`, `token` → one field labelled `token.label ?? "Token"`, `oauth-client` → Client ID + optional Client secret, `key` → the `env[]` names). Schema: each required field `v.pipe(v.string(), v.trim(), v.minLength(1))`; submit parses and sends the trimmed values. Inputs are `type="password"` unless the registry marks `secret: false`. "Where do I get this?" opens `docsUrl`. Buttons Cancel / Connect (disabled until valid after first blur, 03 display gate).

### 12.7 The connector request card

Unchanged from phase 3 (`components/connector-request-card`, 03 §11.4, R3-T32). This phase supplies the flow: the bots and sessions routes pass `connect={(id) => useConnectFlow().start(id)}` so the card and the Library share one hop at a time and one watchdog.

---

## 13. Messaging (`/library/messaging`, canvas `SettingsMessaging`)

### 13.1 Data

`messaging.snapshot` query (`MessagingSnapshot`: `platforms`, `pending`, `approved`, `autoReplies`, `gatewayEnabled`, `autoApproveTools`, `respondToInbound`, `workspaceId`, `botId`), invalidated by `messaging.events { updated }` (coalescing). Every messaging mutation **returns the snapshot**, which is written into the query cache with `setQueryData` (parity: the old hook replaced its state with the returned snapshot). `workspacesCollection` and `botsCollection` feed the settings selects.

### 13.2 The page

Header "Messaging", "Reach your bots from WhatsApp, Telegram and Discord." (canvas). One grouped card with a row per base platform (`whatsapp`, `telegram`, `discord`; the shared lanes `abacus_telegram`/`abacus_discord` are parts of their base platform's detail, `SHARED_BOT_PLATFORM_OF`): mark 28, name, the state line (canvas: "Connected. Message me from your “Message yourself” chat.", "Waiting for Start to be tapped in Telegram…", or the platform description), a `StatePill` from `MessagingStateBadge`'s mapping (Connected / Connecting / Disabled / Error / Finish linking / Waiting for login / Not configured / Pending restart / Rate limited / Syncing; tones parity), a pending-count badge "Waiting for approval ({n})" when `pendingCount > 0`, and a button: **Connect** (not attached), **Cancel** (connecting), **Unlink** (attached) → each opens or acts through the sheet. Then the **Settings** card (§13.4) and an **Auto-replies** row: "{n} people get automatic answers" + "Manage in Routines" → `/routines` (RT22).

### 13.3 Platform sheet (`?platform=<id>`, masked; port of `PlatformDetail`)

Registry `Sheet` 480 px. Parts, each ported with its copy:

- Header: mark, name, `StatePill`, "Needs setup" pill when not configured, description `messaging.descriptions.<key>`; the two-step note for `SHARED_LINK_REQUIRED` platforms.
- Error box: amber for `needs_login`/`rate_limited`, destructive otherwise (display of `errorMessage`, not branched on).
- **Enable first**: opening the sheet's Connect (or arriving from the connect flow) runs `connectPlatform(platformId)` (§12.4 item 6: gateway on, then the platform) and awaits it; web login and shared linking start only after it resolves, so a disabled platform or `gatewayEnabled: false` never leaves the card stuck on "Disabled".
- **Web login** (telegram, discord, whatsapp when enabled and not connected): on mount calls `messaging.showLogin({ platformId })` once (main opens the platform's own web login window, F19); the per-platform scan copy (the WhatsApp line "then scan the code above" becomes "then scan the code in the login window": the renderer draws no QR, so the old "above" was wrong); "Open {App} login" re-calls it.
- **Shared link** (shared-bot lanes): auto-starts once when required (`connectPlatform` for the base platform and the shared lane — gateway first — then `messaging.pairShared`); Telegram shows `sharedLink.qrDataUrl` as a 180 × 180 `<img alt="QR code to link the Abacus AI bot">`, the `/link <code>` command with Copy ("Copied" for 2 s), "Waiting for Start to be tapped in Telegram…"; Discord shows the three steps with "Add to Discord" (`messaging.openSharedLink({ platformId, target: "install" })`) and "Open Abacus AI's chat" (`target: "dm"`, re-copies the command). Linked: "Linked as {name}. Message the Abacus AI bot in {app} to talk to your agent." + Unlink (`messaging.unlinkShared`, then disable). Retry after a failure. Pairing progress arrives by `messaging.events` (main polls every 3 s, parity).
- **Syncing** note for WhatsApp (parity copy).
- **Pending approvals**: user name (or id) + first message; Approve → `messaging.decidePairing({ platformId, userId, decision: "approve" })`, Reject → `"revoke"` (parity). The old page deliberately had no approved list; see the disclosure below.
- **Credentials form** (TanStack Form over `MessagingFieldInfo[]`): ported and kept, although every catalogue platform has `fields: []` today (dormant, parity); secret fields masked, `redactedValue` as placeholder, `fromEnv` disables with "Set by {key} in your environment", Clear sends `values: { [key]: "" }`; Save sends only non-empty values, then connects.
- Footer: while connecting, **Cancel** (disables the platform and its shared lane, `CANCELLABLE_CONNECT` parity); once both halves are done, **Done**. Closing an unfinished connect by Escape does the same as Cancel after a confirm "Stop linking {App}?".
- Connected platforms also show **Unlink**: AlertDialog "Unlink {App}?" / "Your bots stop answering there. Chats already saved stay." → `messaging.updatePlatform({ platformId, enabled: false })` (+ the shared lane).
- Revoking an auto-reply (from the Routines side it is Pause/Resume only, 03 P61): a person with `status: "approved"` listed under the sheet's "People who can message your bots" disclosure (new, collapsed by default, since the canvas lists "Allowed contacts") has **Revoke** → confirm "Stop {name} from reaching your bots?" → `decidePairing({ decision: "revoke" })`.

### 13.4 Settings card (port of `MessagingSettingsDialog`)

Rows (§17.4 grammar), same labels and help text as today: **Messaging enabled** (`gatewayEnabled`), **Workspace** (`workspaceId`; "Follow the active workspace" = `null`; pickable workspaces), **Deliver messages to a bot** (`botId`; "No bot (one session per sender)" = `null`), **Respond to incoming messages** (`respondToInbound`), **Run remote turns unattended** (`autoApproveTools`, with its warning help). Each change calls `messaging.updateSettings({ [field]: value })` optimistically in the query cache (snapshot-patched, rolled back on error with toast "Couldn't change messaging settings"); the returned snapshot replaces the cache.

---

## 14. MCP servers (`/library/mcp`, canvas `SettingsMCP`)

### 14.1 Data

| Data | Source | Live / invalidated by |
|---|---|---|
| Configured servers | `mcp.list({ mode: "code" })` (`staleTime: 30_000`) | its own mutations (each invalidates it); `connectors.events { status-changed }` (connecting an MCP connector adds a server) |
| Runtime servers of the scope session | `mcp.runtime.servers({ workspaceId, sessionId })` | `mcp.runtime.events({ sessionId })`: `servers` replaces, `status` merges, `refresh-failed`/`restart-failed` toast (parity) |
| Logs of one server | `mcp.runtime.logs({ workspaceId, sessionId, serverId })` + the same iterator's `log` entries appended (tail 200, parity) | the iterator |
| Abacus connectors attached | `connectors.statuses` (connected platform connectors) | as §12.2 |

### 14.2 Runtime scope (`runtime-scope.ts`, F17)

`useMcpRuntimeScope()`: candidates = sessions with `status === "running"` (`sessionsCollection`), ordered by `turn?.updatedAt ?? updatedAt` desc; the scope is the first unless the user picked another in the header's "Live status from {session label} ▾" menu (component state, reset when that session stops). With no running session: every status pill reads "Not connected", Refresh and Restart are disabled with the tooltip "Start a session to refresh MCP servers." (parity), and the header says "Statuses appear while a session is running." Bot sessions count too (they run MCP servers the same way).

### 14.3 The page

Header "MCP servers", "Tool servers sessions can call. Status updates live." (canvas), buttons **Add server** (→ `?server=new`), **Import ▾** (Import from Claude, Import from Cursor, Import from DeepAgent, From a file…, Paste JSON — the last enabled only when the clipboard parses as a server object, parity check on menu open), **Refresh** (`mcp.refresh(scope)`; toasts "MCP servers reloaded." / "Failed to refresh: {error}").

One grouped card, a row per server (min-height 52): mark (`ConnectorMark` of a known connector id, else `mcp`), name (500), sub-line mono 12 (`command args…` or URL), a status pill (§14.4), and **Edit** (→ `?server=<name>`), plus a ⋯ menu: Enable/Disable, Restart (scope running and server enabled), Logs (→ `?logs=<name>`, an inline expandable panel under the row, max 240 px, mono 12, "No log output captured yet."), Remove. `auth-required` rows show "Sign in to use {name}’s tools" and a **Sign in** button instead of Edit (canvas). Disabled rows show "Disabled" and an **Enable** button (canvas). The `abacus-connectors` row carries the summary sub-line (parity copy: "{n} Abacus connectors, served through this server:" + marks; loading/unreadable/none lines). Below the card: "Abacus.AI connectors as tools" note (canvas) with the count and names.

Empty: "No MCP servers configured." + Add server.

### 14.4 Status pill and actions

Pill from `AgentMcpServer.status` (hidden when disabled, parity): Connected (+ " · {n} tools"), Connecting (spinner), Error (+ the row's error text, destructive), Auth required, Off (disconnected), Not connected (idle or no scope).

| Action | Call | Optimistic | Failure |
|---|---|---|---|
| Enable / disable | `mcp.setDisabled({ mode, name, disabled })` | query cache flips `config.disabled` | rollback + toast (`result.error` or "Failed to update server.") |
| Remove | AlertDialog "Remove {name}?" / "Sessions lose its tools. You can add it again later." (new confirm, LB15) → `mcp.remove` | row removed | rollback + "Failed to remove server." |
| Restart | `mcp.restart({ …scope, serverId })` | — | toast "Failed to restart: {error}" |
| Sign in | `mcp.oauthSignIn({ mode, name })` (system browser, main waits 20 min) | button "Waiting for the browser…" | toast "Sign-in failed: {error}" unless `cancelled`; success toast "Signed in to {name}." then `mcp.refresh(scope)` |
| Import | `mcp.import({ mode, source, json? })` | — | `singleEntry` → opens the add dialog prefilled; else toast "Imported {n} server(s)."; errors inline under the header |

`MutationResult { success: false, error }` from `mcp.*` is unwrapped to a failure branch with its `error` text displayed (the contract keeps these outcome objects; the UI displays, never matches, the text).

### 14.5 Server dialog (`?server=new|<name>`, masked; `server-form.tsx`)

Registry `Dialog` 560 px, title "Connect to a custom MCP" / "Edit MCP server: {name}". TanStack Form over:

```ts
const KV = v.array(v.object({ key: v.pipe(v.string(), v.trim()), value: v.string() }));
export const McpServerFormSchema = v.variant("transport", [
  v.object({ transport: v.literal("stdio"), name: ServerName, command: v.pipe(v.string(), v.trim(), v.minLength(1, "command-required")),
             args: v.array(v.pipe(v.string(), v.trim())), env: KV }),
  v.object({ transport: v.literal("http"), name: ServerName, url: v.pipe(v.string(), v.trim(), v.minLength(1, "url-required"), v.url("url-invalid"), v.check(isHttpUrl, "url-invalid")),
             headers: KV, oauth: v.object({ clientId: v.string(), clientSecret: v.string(), scope: v.string() }) }),
]);
const ServerName = v.pipe(v.string(), v.trim(), v.minLength(1, "name-required"));   // disabled in edit
```

- Fields and copy are the old form's (Name "Server name"; STDIO / Streamable HTTP; "Command to launch" "e.g. npx, node, uvx"; Arguments list with "Add argument"; Environment variables "Key"/"Value" with "Add environment variable"; URL `https://mcp.example.com/mcp`; Headers with "Add header"; "OAuth (optional)" with its hint, Client ID, Client Secret (password), Scopes). The URL check is new (LB16).
- Submit parses, drops empty args and blank keys, omits `oauth` when all three are empty (parity), then `mcp.add({ mode, name, config })` or `mcp.update({ mode, name, config })`; `success: false` → form error with `error` (or "Failed to add server."). Edit uses the §8.2 baseline rule against the list query's entry (a remote edit refreshes untouched fields).

---

## 15. Skills (`/library/skills`, canvas `SettingsSkills`)

- **Data**: `skills.listInstalled({ workspacePath })` (`staleTime: 30_000`), where `workspacePath` is the workspace chosen in a header picker ("Project skills from {workspace} ▾", pickable workspaces, default `prefs.lastPickedWorkspaceId`, `?workspace=` when changed); `skills.search({ query })` (`staleTime: 300_000`, parity).
- **Page**: header "Skills", "Packaged instructions the agent follows for a kind of task." (canvas), buttons **Browse marketplace** (→ `?marketplace=true`) and **Install from folder ▾** (From a folder…, From a file… → `skills.importLocal({ kind })`; a cancelled picker is ignored; error "Could not import the selected skill."). Groups "Workspace" (project) then "Global"; builtin skills hidden (parity). Row (min-height 52): a 28 px glyph tile (the first letter of the id on `bg-muted`; canvas glyphs are decorative), `/{id}` (mono 13/500), "{Global|Project · workspace} · {description}" (12 muted), `argumentHint` (mono 12 muted), a state pill "Installed" (or "Installing…" while an install from the marketplace for that id is pending), and **Edit skill file** → `skills.openFile({ path, workspacePath })` (the OS editor; no in-app editing, PLAN) with error "Could not open skill file.", and ⋯ → **Uninstall** (AlertDialog "Uninstall skill" / "Remove skill “{id}”? This deletes the skill file." → optimistic removal, `skills.remove`, rollback with "Could not remove skill." in the dialog; parity).
- **Restart banner** after any install, import or removal (parity): "Restart the app to start using your newly added skills." + "Restart now" (`system.restart`). The composer's `/` menu keeps a **disk baseline** as today (`chat-panel.tsx:751-770` seeds it from `skills.listInstalled` before any agent exists): a query `skills.listInstalled({ workspacePath })` for the thread's workspace, which the chat kit uses until the session's `CUSTOM skills.loaded` arrives and prefers afterwards (§31.2); every install, import and removal here invalidates that query, so `/` shows a new skill before anything is sent.
- **Marketplace dialog** (`?marketplace=true`, masked): search debounced 350 ms (pacer), "Search for skills to install.", "Could not reach the marketplace." (thrown or `result.error`), "No skills found.", rows `/{skillId}`, source, "{n} installs", **Install** (global scope, `skills.install({ skillId, source, name, scope: "global" })`, per-row spinner, "✓ Installed", error `result.error ?? "Install failed"`), footer "Powered by skills.sh" (`system.openExternal`).
- Canvas "Update available" is not built (F16).
- Keyboard lives on its own settings page (§21.3), not on this page (the canvas board puts both on one artboard).

---

## 16. Tools (`/library/tools`, `/library/tools/$toolsetId`)

- **Data**: `settings.toolsets.get` (`staleTime: 10_000`, parity); `settings.toolsets.setEnabled` returns the full map, written to the cache.
- **List**: header "Tools", "Built-in groups of tools the agent can use. Turn off what you don't want it to reach for." (new copy, i18n); search "Search toolsets and tools…" (label or any tool name, parity); one grouped card of `TOOLSETS_FOR_DISPLAY` rows: `Wrench` 16, label + description (12 muted), then a `Switch` (optimistic, rollback on error with toast "Couldn't change {toolset}"), or **"Always on"** for `alwaysOn` toolsets (the unused `capabilities.tools.alwaysOn` key; LB19), or "Planned" for planned ones; the row links to the detail. Empty: "No toolset matches that."
- **Detail** (`$toolsetId`): back row "All tools" (`nav-back`), label + switch (as above), state text ("On. The agent can call these tools." / "Off. The agent isn't told these tools exist." / the planned text), tool table (mono name + `capabilities.toolDescriptions.<key>`), the builtin-delivery note and the MCP note (parity). The **terminal** toolset adds "Execution backend and terminal shell moved to Settings." with a link to `/settings/environment` (`settings-in`) (LB20).

---

## 17. The settings shell (`features/settings/`, canvas `SettingsGeneral` et al., `SettingsInPlace`)

### 17.1 Sidebar (`SettingsSidebar`, replaces phase 1's)

In the sidebar slot (280, foundation §7.3), `padding: 8px 8px 8px 0`, gap 1, 13 px:

1. "Search settings" field (32 px, radius 9, `bg-muted`, margin `0 0 8px 8px`), §17.3.
2. Group labels (12 muted, `padding: 10px 8px 4px 16px`) and 32 px rows (radius 8; active `bg-sidebar-accent`, idle `text-sidebar-foreground/85`), each an `AppLink` with `transition` inferred (`nav-lateral` between pages):
   - **Personal**: General, Appearance, Notifications, Memory, Usage, Account
   - **Models**: Models
   - **Environment**: Execution backend (`/settings/environment`), Browser, Devices
   - **App**: Language, Keyboard, About
   - **Library**: one row "Connectors, messaging, MCP and more" → `/library` (`settings-out`), with an arrow-up-right glyph (F7, F8)
3. At `sm` the settings sidebar floats like every other (foundation §7.1); nothing settings-specific.

The rail keeps its items; the Settings gear at the bottom shows active (foundation §7.2); no top item is active (canvas `Rail active=none`).

### 17.2 Title bar: Back to the app

- `TopBarSlot identity`: "Settings" (13/500) (canvas `TopBar title=Settings`).
- **Back to the app** (F8): while the area is `settings`, `TopBar.Leading`'s back button is replaced by `SettingsBackButton` (lucide `ArrowLeft`, `aria-label="Back to the app"`, tooltip "Back to the app"), which navigates to `shellStore.lastLocationOutsideSettings` (new slot, written by the foundation's `lastLocationByArea` writer whenever the area is not `settings`; default `/bots/new`) with `transition: "settings-out"`. It is not `history.back()`: moving between settings pages pushes entries, and one click must leave Settings. Forward stays the history forward button. `Escape` does nothing global here (menus and dialogs own it).
- Entering Settings (`Mod+,`, the rail gear, a Library link, a "Set up models" CTA) uses `settings-in` (foundation).

### 17.3 Settings search (`search-index.ts`)

A static index `SETTINGS_INDEX: Array<{ id: SettingId; page: SettingsPageId; labelKey: string; keywordsKey?: string }>` of every row on every page (about 70), plus the Library pages as entries that navigate out. Typing filters it (substring over the translated label and keywords, accent-insensitive); the nav is replaced by a result list (page name 12 muted over the setting label); Enter or click navigates to the page with `?focus=<id>`; the page scrolls `[data-setting-id=<id>]` into view (`block: "center"`), moves focus to its control, and plays a 1.2 s highlight (`bg-(--accent)` fading, none under reduced motion); the param is then removed with `replace`. No match: "No settings match". R5-T24 asserts every `data-setting-id` on every page is in the index and vice versa.

### 17.4 Page grammar (`components/settings-rows/`)

From the canvas boards: content column `width: min(680px, 100% − 48px)`, centred, `padding-top: 40px`, `padding-bottom: 64px`, scrolling inside the pane; `<h1>` 22/600; description 13 muted `padding: 4px 0 24px`; section titles 13/600 `padding: 24px 0 8px`; a **group card** (radius 14, `bg-card`, `padding: 0 4px`) of **rows** (min-height 52, `padding: 8px 12px`, gap 12; title 13/500 + detail 12 muted on the left; the control right-aligned: `Switch` (registry, 34 × 20 on the canvas → the registry size), a 30 px `Select`/`DropdownMenu` trigger (radius 8, `bg-muted`), a 30 px secondary button, or a `StatePill`). Rows separate with a 1 px inset border (`--border` at 60%). Every row has `data-setting-id`; its control is labelled by the row title (`aria-labelledby`) and described by the detail (`aria-describedby`).

Writes are **immediate** (no page-level Save), optimistic where the source allows (prefs through `updatePrefs(patch)`; query-backed settings through `setQueryData` + rollback), with a toast on failure "Couldn't save that setting". The only explicit Save buttons are free-text fields: custom instructions (§18.4), API keys (§20.4), Chrome token (§20.2), browser home page (§20.2), quiet hours times (§22.4 saves on blur).

---

## 18. Personal pages

### 18.1 General (`/settings/general`, canvas `SettingsGeneral`)

| Row (`data-setting-id`) | Control | Source / write | Notes |
|---|---|---|---|
| Launch at login (`launchAtLogin`) | Switch | `system.loginItem.get` / `.set({ openAtLogin })` (§31.5) | hidden on Linux (`system.info.platform === "linux"`; Electron: darwin, win32 only). Copy "Start AbacusAI Bot when you sign in to your Mac" (macOS) / "…to Windows" |
| Default workspace (`defaultWorkspace`) | Select: "Default workspace" (`kind: "auto"`), pickable workspaces | `prefs.lastPickedWorkspaceId` via `updatePrefs({ lastPickedWorkspaceId })` | the same field 04 §8.3 uses for new sessions ("Where new sessions run unless you pick a folder") |
| Default permission mode (`defaultMode`) | Select of the five modes (Auto hidden without sandbox support) | `prefs.defaultMode` via `updatePrefs` | the session composer's sticky mode (04 S34, §9.3): picking here is the same write |
| Bots and routines run in (`botMode`) | Select Full access / Auto | `settings.defaultMode.get/set` | shown only when `settings.sandboxSupport.available` (parity ST7); description and the Auto warning are the Profile page's copy |
| Modes (explainer) | static list: Auto "Sandboxed, no prompts", Supervised "Asks before edits and commands", Auto-accept edits "Edits go through, commands ask", Plan "Reads and plans only", Full access "Nothing asks" + "Careful" pill | — | copy follows the chat kit's mode menu (02 §8.2), not the canvas's "Picks a mode from the request" for Auto, which describes no behaviour that exists |

Canvas rows not built: "Keep running in the menu bar" (F11), "Notch companion" (phase 6).

### 18.2 Appearance (`/settings/appearance`, canvas `SettingsAppearance`)

| Row | Control | Source / write |
|---|---|---|
| Theme (`theme`) | three 88 × 64 preview tiles Dark / Light / System (canvas), a `toggle-group` with `aria-label="Theme"` | `prefs.theme` via `updatePrefs({ theme })` (phase 1's recipe write moves to the patch, F18); main applies `nativeTheme` (spec 00 B) |
| Density (`density`) | segmented Comfortable / Compact | `window.chrome` query's `density`; write `window.setDensity({ density })` (§31.5). On macOS main recreates the window to re-seat the traffic lights (`main/index.ts:1888-1890`), so the control shows "The window reopens to apply this." under the row on darwin |
| Text size (`textSize`) | segmented 13 / 14 / 15 | `prefs.appearance.textSize` (§31.5); `ThemeEffect` sets `--chat-font-size` on `<html>`; the chat kit's prose and composer read it (§31.2) |
| Reduce motion (`reduceMotion`) | segmented System / On / Off | `prefs.motion.reduce` (exists); `ThemeEffect` already writes `data-reduce-motion` (foundation §7.7) |
| Bot colour in bubbles (`bubbleTint`) | Switch | `prefs.appearance.bubbleTint` (§31.5); `ThemeEffect` sets `html[data-bubble-tint="off"]`, which the kit's bot skin reads (§31.2) |

Accent is not built (F10).

### 18.3 Notifications

§22 (with sound settings).

### 18.4 Memory (`/settings/memory`, canvas `SettingsMemory`)

- Description (parity lead, trimmed): "What the agent has chosen to remember across sessions, and what you tell every session."
- **Instructions for every session** (`customInstructions`): a TanStack Form textarea (5 rows, auto-grow) with the parity description, placeholder and status lines ("Unsaved", "Applies to your next message, including in a chat already open.", "Could not save. Check that the settings folder is writable."); **Save** enabled only when the trimmed value differs from the saved one → `memory.customInstructions.set({ text })` (returns what is stored; the query cache takes it). Remote sync by the §8.2 baseline rule: `memory.customInstructions.get` is refetched on window focus (the file can be edited outside the app; parity used `refetchOnMount: "always"`), and an untouched field follows it.
- **Remembered from sessions**: `memoriesCollection` where `scope === "global"`, grouped by `target` in parity order: "Always remember" (`remember`), "About you" (`user`), "The agent's own notes" (`memory`), each with its help text and count. Row: the entry (13, up to 3 lines, full text on focus), **Forget this** (28 px secondary) → `memoriesCollection.delete(row.id)` (the original row with `index`, `entry`, `occurrences`, spec 00 B notes). Each group with entries has **Clear all** → AlertDialog "Clear all" / "Forget everything here?" / Keep / Forget all → `memory.forgetAll({ target })`. Failures: `CONFLICT` → rollback + the parity line "Nothing was deleted. A session was writing to memory at the same moment. Try again." (kept until the next successful delete). States: loading "Reading memory…", error "Could not read what is remembered. The files are in ~/.abacusai-bot/memories.", empty (parity copy). Canvas sub-lines ("abacusai-bot · 2 days ago") have no data (03 F11).
- **Remembered by bots**: per bot with entries or notes, a row: avatar 28, "{name} · {n} things", the first three entries joined by " · " (12 muted, ellipsis), **Open** → `/bots/$botId?tab=memory` (`settings-out`); expanding the row (disclosure) shows `BotMemoryList` (03 §12.2) with forget and "Forget everything here" (`memory.clearBot`), "{n} days of working notes on disk." from `memory.bots` (parity). Data: `memoriesCollection` where `scope === "bot"` + `memory.bots` (invalidated by `memory.events` and bot renames, 03 §6.1).

### 18.5 Usage (`/settings/usage`, canvas `SettingsUsage`)

- **Data**: `account.usage` (`UsageSnapshot`, `staleTime: 0`, refetch on mount, parity) and `account.abacus` (§19.1). Header button **Refresh**: refetches the snapshot and `account.abacus({ refresh: true })` (parity).
- **Cards** (3-column grid, radius 14, `bg-card`, `padding: 14px 16px`): **Abacus.AI credits** ("{used}" large, "of {granted} · resets in {n} days" when `credits_granted > 0`; the reset date is not in the data, so "resets in" is omitted — the canvas line becomes "of {granted}"); **OpenRouter** (`openrouter`: "Free tier" + "shared daily request cap · {errors} errors today" or "Credits purchased" + usage / limit); **This week** ("{requests} requests", "{tokens} tokens · {cost}" with `fmtCost`, "not billed" when zero cost and free).
- **Daily activity** (`components/usage-chart`, F14): an SVG of `snapshot.days` bars (the window from `generatedAt` back; a missing day is a zero bar), bar height ∝ requests (min 3 px when > 0), the error count drawn as a darker cap at the bottom of each bar; x labels every 7 days; each bar has a `<title>` "{date} · {requests} requests · {errors} errors · {tokens} tokens" and the chart has a visually hidden table with the same numbers (a11y). Legend: "Requests", "Provider errors: usually free-tier rate limits. RouteLLM retries elsewhere." (canvas).
- **By model** (parity, replacing the canvas's "By bot and session", F14): two lists "RouteLLM - Open pool" (subtitle parity) and "Other models"; rows: model label, a share bar (requests for the pool, cost else, parity), "{n} req · {n} err · {tokens} tok · {cost | Not billed | Price unknown}".
- States: "Reading session logs…", "Could not read the session logs.", "No usage recorded yet. Run a conversation and come back." (parity); the unpriced hint when `unpriced` (parity).

---

## 19. Account (`/settings/account`, canvas `SettingsAccount`, `SettingsSignedOut`)

### 19.1 Signed in

- **Data**: `account.abacus()` (`AbacusAccountInfo | null`, `staleTime: 60_000`, `refetchInterval: 300_000` while an Account, Usage or Models page is mounted: ST27), `account.state` (local account name/email), `settings.get` → `canSignOutOfAbacus` (a stored key), `referrals.summary`.
- **Identity row**: avatar 40 (`picture` or initials of `displayName`, parity rule local name → Abacus name → email handle), name (500), "{email} · Abacus.AI account" (12 muted), **Sign out** (secondary).
- **Plan** group: Plan "{plan}" + **Manage plan** → `system.openExternal({ url: ABACUS_PLAN_URL })`; Credits this month "{used} of {granted} used" (only when `credits_granted > 0`, parity) + **Top up** → `ABACUS_BUY_CREDITS_URL` (the chat kit's upgrade card uses the same constants; they move to `shared/settings/abacus-urls.ts`); Organization "{organization} · {n} members" (members only when > 1, parity). The canvas "Invite" (organization) is not built (no procedure).
- **Referrals** group: "Invite link" (Copy → "Invite link copied"), "From your Gmail — The people you email most", "From your WhatsApp — Your chats, ready to invite" (canvas), each opening the invite dialog (§19.3); progress line from `referrals.summary` (parity "{sent} of {total} invites sent", "{n} friends joined…").
- **Danger zone**: the canvas "Delete all local data" is not built (no procedure); the group shows **Forget this computer's account** → `account.forget` (the local name/email, parity `account:forget`), confirm "Forget your name and email on this computer?".

### 19.2 Sign in and out

- **Sign out**: AlertDialog "Sign out of Abacus.AI?" / "A chat that is already running keeps the key it started with until you start a new one." with a checkbox "Also remove my other API keys", **checked by default** (parity: the old sweep called `auth.abacus.signOut({ keepOtherApiKeys: false })`), mapping to `keepOtherApiKeys: !checked`; the confirm itself is new (ST8); then `account.signOut`; then phase 6's `tourSignedOut()` hook (a no-op until then); then navigate to `/bots/new` (`settings-out`); toast (parity copy). Main's sign-out stashes the account's sessions (`sessions-reloaded` → the collections reset; spec 00 A.2.1 #71).
- **Signed out** (canvas `SettingsSignedOut`): centred mark 48 (`abacus`), "Not signed in to Abacus.AI", "Sign in for connectors, RouteLLM and free credits. Local models and your own API keys work without it.", **Sign in with Abacus.AI** → `auth.abacus.start({ intent: "signin" })` (main's window; while pending the button reads "Waiting for the sign-in window…" with Cancel → `auth.abacus.cancel`, and "Continue in your browser" → `auth.abacus.openInBrowser`; outcome `cancelled` resets quietly, errors inline, `unidentified-account` gets the parity copy), **Use my own keys** → `/settings/models`.
- A browser profile offer (`auth.abacus.browserProfiles`, "Continue with {profile}") is onboarding's (phase 6); the Account page uses the plain start.

### 19.3 Invite dialog (`?invite=link|gmail|whatsapp`, masked)

Port of `referrals-panel.tsx` into a registry `Dialog` 520 px: link tab (copy), Gmail tab (connect Gmail through `useConnectFlow().start("abacus-gmailuser")` when needed; contacts from `referrals.gmailContacts`; manual emails validated with the parity `EMAIL_RE`, lower-cased, deduped), WhatsApp tab (`referrals.whatsappContacts`; phones 7–15 digits normalised to `+digits`; not linked → "Link WhatsApp in Messaging" → `/library/messaging?platform=whatsapp`), a note (TanStack Form textarea, max 1,000, prefilled from `referrals.defaultMessage`), Send → `referrals.sendEmail` / `sendWhatsapp`, toasts and `ReferralInviteOutcome` errors mapped by outcome code (parity `referrals.errors.*`). Signed out: "Sign in to Abacus.AI to invite friends."

---

## 20. Models and environment

### 20.1 Execution backend (`/settings/environment`, canvas `SettingsEnvironment` first group)

- Description "Where commands run, which browser, and which devices." on this page only (canvas title "Environment"; nav label "Execution backend").
- **Backends** group from `settings.execBackend.get` (`ExecBackendState { selected, effective, statuses }`) over `EXEC_BACKENDS`: row per backend: mark (docker `ConnectorMark`, others a neutral tile), label, detail (canvas: "Commands run here, sandboxed" for local when the sandbox is available, "Each session in its own container", "A machine you name", "Cloud sandboxes"), then: **In use** pill for `selected`; **Use** button for a ready one (`settings.execBackend.set({ backend })`, optimistic, rollback toast); a blocker line for a not-ready one (parity copy: "{command} wasn't found on your PATH.", "Set {vars} to use this backend.", "Not available on Windows…", "AbacusAI Bot can't run commands here yet.") with the canvas's "Set up" button opening the backend's docs where the registry has one, else none; unimplemented backends show "Unavailable". Only `SELECTABLE_EXEC_BACKENDS` can be chosen (parity).
- Fallback alert when `effective !== selected`: "{selected} isn't usable right now, so commands are running {effective}." (parity).
- **Sandbox** row: `settings.sandboxSupport` → "Sandbox: available" or "Sandbox: unavailable — {reason}" (display of `reason`); links to General › Bots and routines run in.
- **Terminal shell** (moved from the terminal toolset, LB20): `terminal.shell.get` → Select of `TerminalShellState` options (hidden with fewer than two shells, parity); "Not found on this machine." for missing ones; the fallback line (parity); write `terminal.shell.set({ shell })`.
- Network allowlist and environment variables: none exist (F9).

### 20.2 Browser (`/settings/browser`, canvas second group; port of `browser-settings-dialog.tsx`)

| Row | Control | Source / write |
|---|---|---|
| Browser (`browserEnabled`) | Switch "Let the agent control the built-in browser" | `browser.status` (`McpBrowserStatus`) + `browser.events { status }`; `browser.setEnabled` optimistic |
| Which browser (`browserEngine`) | segmented Built in / Chrome (canvas) | `browser.setEngine({ engine })` |
| Chrome extension (engine = chrome) | status line (parity five cases), **Install the extension** / **Connect** / **Disconnect**, token (password input + Save token, toast "Token saved.") | `browser.chrome.connect/disconnect/setExtensionToken` |
| Home page (`browserHomepage`) | URL input + Save (Enter) | `prefs.browserHomepage` via `updatePrefs`; `normalizeBrowserHomepage` (moved to `shared/settings/browser-homepage.ts`); toasts "Home page saved." / "Enter a valid web address." (parity) |
| Approval (`browserApproval`) | segmented Ask / Always (canvas) | `browser.permissions.setApproval({ approval })` (parity "Always ask"/"Never ask" labels remapped to the canvas words; values `ask`/`always` unchanged) |
| Browsing data (`browserData`) | **Clear all** | `browser.clearData`; toasts "Browsing data cleared." / the error (no confirm, parity) |

### 20.3 Devices (`/settings/devices`, canvas third group; port of `device-settings-dialog.tsx`)

`devices.status` + `devices.events`. Rows: **Enable device tools** (Switch, `devices.setEnabled`, optimistic); toolchain rows iOS simulator ("Xcode {version}" when detected), Android (adb), Maestro with Detected / Not detected pills and the parity download links (`system.openExternal`); **Install** on Maestro → `devices.installMaestro` (new here; the device tab already had it, 04 §16.1) with its toasts; **Tool approval** Ask / Always (`devices.setApproval`, default `ask`).

### 20.4 Models (`/settings/models`, canvas `SettingsModels`)

- **Data**: `models.list` and `settings.keys.listProviders` (no secrets), `settings.get`, all invalidated by `settings.events { credentials-changed }` (foundation invalidation table); `account.abacus` for the Abacus row.
- Description "Where requests go. RouteLLM chooses unless you pick a model in the composer." (canvas).
- **Providers** group: the featured providers of `PROVIDER_KEY_FIELDS` first (Abacus.AI, OpenRouter, Anthropic, OpenAI, Gemini, DeepSeek; canvas order Abacus, OpenRouter, Anthropic, OpenAI), then a disclosure "Other providers ({n})" with the rest and the search field "Search model providers…" (parity match on label, id, env var, hint). Row: mark (`abacus`, `openrouter`, else initial tile), label, detail (Abacus: "Signed in · RouteLLM picks the model per request" or "Not signed in"; OpenRouter: "Free tier · shared daily request cap" when `usage.openrouter.isFreeTier`; key providers: "Paste an API key" / "Saved, not checked" with the parity tooltip), pill (Connected / Not verified), button: **Manage** (connected) → `?provider=<id>`; **Add key** → `?provider=<id>`; **Connect** (connect providers) → `?provider=<id>`.
- **`?provider=` dialog** (parity: kept only for `"local"` or a `PROVIDER_KEY_FIELDS` provider; opened by 03 §13.1's "Connect OpenRouter" rows):
  - *Key providers* (`KeyDialog`, port of `provider-key-dialog.tsx`): title "Go to {provider} and get your API key", body, "Open {provider}" (`openExternal(signupUrl)`), password field (autofocus; placeholders parity), hint "Stored on this machine only.", `isPlausibleApiKey` as a valibot `v.check` ("That doesn't look like an API key. Check the paste for a stray line or URL."), Enter saves → `settings.keys.save({ provider, key: trimmed })` then `models.list({ refresh: true })`; **Remove key** (when stored) → AlertDialog "Remove the {provider} key?" (parity copy) → `settings.keys.save({ provider, key: "" })` (optimistic on `listProviders`, rollback).
  - *Connect providers* (Abacus, OpenRouter; `ConnectDialog`): "Connect Abacus.AI" → `auth.abacus.start()` / "Connect OpenRouter" → `auth.openRouter.start()`; pending state with Cancel (`auth.*.cancel`); an attempt token so a late outcome from a cancelled attempt is ignored (parity); `cancelled` is not an error; unmount cancels a pending attempt (parity; unlike connectors, these are modal flows). When the provider's credential is **stored** (`settings.keys.listProviders` includes it; parity `models-panel.tsx:294-305`: only a key the app wrote can be removed), the dialog also offers **Remove** → the same AlertDialog "Remove the {provider} key?" → `settings.keys.save({ provider, key: "" })` (optimistic on `listProviders`, rollback), then `models.list({ refresh: true })`; `credentials-changed` invalidates the rest. For Abacus.AI this removes the key only (Account › Sign out stays the full sign-out).
  - `?provider=local` scrolls to and focuses the local models section.
- **Free credits** card (canvas) when `prefs.creditsExhaustedAt != null`: "You’ve used all your free Abacus.AI credits" / "Connect a free source to keep going, or run a model on this computer. No card needed." + **Upgrade** (`ABACUS_PLAN_URL`) + **Dismiss** (`updatePrefs({ creditsExhaustedAt: null })`).
- Canvas "Rate limited" and "Check" are not built (F15). Default model and favourites stay in the composer's picker (parity, 03 §13).

### 20.5 On this machine (local models; canvas `SettingsModels` second group)

- Hidden when `localModels.state.runtimeAvailable === false` (parity), else: "On this machine" + "Models the app downloads and runs here with the built-in runtime. This computer has {memory} of memory." (canvas + parity hardware line).
- Rows from `LocalModelState.catalog`: label, "Recommended · {size}" for `recommendedId`, a detail for too-little memory ("needs more memory than this computer has" when `totalMemoryBytes < minMemoryBytes`; the old dialog's "tight" warning), and by state: installed → "Installed" pill + **Remove** (confirm "Remove {model}? You can download it again." — new; ST12), downloading → progress bar + "{received} of {total} {percent}%" + **Stop** (`localModels.cancelInstall`), verifying → "Checking the download…", otherwise **Download** (`localModels.install({ modelId })`, disabled while any other download runs, parity) → outcome `LocalModelInstallOutcome` (`{ ok: false, error }` shown inline unless `"cancelled"`).
- Progress: `localModels.progress` (coalescing iterator; each yield the latest `LocalModelProgress`) folded into the `localModels.state` query cache (parity), and `ready`/`failed`/`cancelled` invalidate `localModels.state` and `models.list`.
- **Install and use** (parity `local-model-dialog.tsx:54-64`): the old dialog, opened from the upgrade card and the credits-exhausted card, installs the recommended model and **selects** `localModelReference(id)` for the chat that asked, and offers **Use {model}** for an installed one. Here: those entry points (the chat kit's upgrade `ErrorCard` and the model picker's "Use a local model" row) navigate to `/settings/models?provider=local&for=<threadId>` (`ModelsSearch.for`: a `SessionId`, validated against `sessionsCollection`). With `for` set, each installed row shows **Use {model}** and a finished download from this page adopts it automatically: the page calls the route-provided `adoptModel(threadId, localModelReference(id))`, which applies the thread's own model rule (bots write `bot.model`, 03 §13.4; sessions `sessions.update({ model })` + `agent.setModel` when running, 04 §6.4), then navigates back to the requesting thread (`history.back()` when the previous entry is that thread, else to its route) with `settings-out`. Without `for`, rows offer Download/Stop/Remove only.

---

## 21. App pages

### 21.1 Rules

Same grammar (§17.4). These three pages have no loaders beyond their queries.

### 21.2 Language (`/settings/language`, canvas `SettingsAbout` "Language" group)

One row **App language** ("Follows the system unless you pick one"), a `Select`: "System ({resolved name})" first (value `"system"`), then the 11 shipped locales by their own names (`SUPPORTED_LANGUAGES`; the canvas's 中文 (简体) is not shipped and is not listed). Write `updatePrefs({ language })`; after the echo the app calls `changeLanguage(resolveLanguage(language))` (foundation §9.2) from a `LanguageEffect` in `__root` (so a change made in another window applies here too), which loads the bundle and sets `lang`/`dir`. Provenance: an explicit pick, even the language the system already resolves to, is recorded `user` because `updatePrefs` sends every named leaf (spec 00 B notes).

### 21.3 Keyboard (`/settings/keyboard`, canvas `SettingsSkills` "Keyboard" group, F13)

- **Actions** (`lib/keyboard/actions.ts`):

```ts
export interface AppAction { id: ActionId; labelKey: string; defaultBinding: string | null; rebindable: boolean; owner: "shell" | "chat" | "sessions" | "main"; scope: "window" | "global";
  /** The binding used while a terminal has focus, per platform (04's Windows/Linux close-tab exception: Ctrl+W is the shell's delete-word). An override in prefs.keymap replaces defaultBinding only. */
  terminalBinding?: Partial<Record<"mac" | "windows" | "linux", string>>; }
export const APP_ACTIONS = [
  { id: "command-menu", defaultBinding: "Mod+K", rebindable: true, owner: "shell" },
  { id: "new-in-area", defaultBinding: "Mod+N", rebindable: true, owner: "shell" },          // canvas "New session"
  { id: "new-bot", defaultBinding: "Mod+Shift+N", rebindable: true, owner: "shell" },        // canvas; new
  { id: "toggle-sidebar", defaultBinding: "Mod+B", rebindable: true, owner: "shell" },
  { id: "toggle-side-panel", defaultBinding: "Mod+Alt+B", rebindable: true, owner: "shell" },
  { id: "open-settings", defaultBinding: "Mod+,", rebindable: true, owner: "shell" },
  { id: "new-terminal-tab", defaultBinding: "Mod+`", rebindable: true, owner: "sessions" },  // canvas; registered by the sessions dock
  { id: "close-tab", defaultBinding: "Mod+W", terminalBinding: { windows: "Ctrl+Shift+W", linux: "Ctrl+Shift+W" }, rebindable: true, owner: "sessions" },  // 04 §10.1/§11.4
  { id: "next-tab", defaultBinding: "Ctrl+Tab", rebindable: true, owner: "sessions" },
  { id: "previous-tab", defaultBinding: "Ctrl+Shift+Tab", rebindable: true, owner: "sessions" },
  { id: "stop-run", defaultBinding: "Mod+.", rebindable: true, owner: "chat" },             // 02 §8.4 (the canvas's "Esc" would collide with every overlay)
  { id: "send", defaultBinding: "Enter", rebindable: false, owner: "chat" },                // shown, not editable ("Enter sends, Shift-Enter for a new line")
  { id: "notch-reply", defaultBinding: "Mod+Shift+Space", rebindable: false, owner: "main", scope: "global" },  // phase 6; shown "Coming with the notch" until then
] as const satisfies readonly AppAction[];
export function resolveKeymap(overrides: PrefsRow["keymap"]): Record<ActionId, string | null>;   // default ⊕ overrides; null = unbound
```

- `useAppHotkey(actionId, handler)` (foundation §7.9's wrapper) now takes an **action id** and reads its binding from `resolveKeymap(prefs.keymap)`; the registrations re-bind when the map changes, and each registration carries `meta: { actionId, name, description }` (`HotkeyMeta` extended with `actionId` by declaration merging, as its doc comment shows, `@tanstack/hotkeys/dist/hotkey.types.d.ts:202-223`; a registration view exposes `options.meta`, `hotkey-manager.d.ts:31,69`) so conflicts resolve to actions (§31.1).
- **Terminal dispatch** (04 §11.4, "Dock chords reach the dock"): the terminal adapter's key handler matches the focused event against the **resolved** bindings of the dock and shell actions (`close-tab`, `next-tab`, `previous-tab`, `toggle-side-panel`, `new-in-area`), using `terminalBinding[platform]` where present, and calls `dispatchAppAction(actionId)` (the shell hotkey module's export; 04 r3 names the dispatcher, and whichever name it settles on takes an action id, not a raw binding); it returns `false` so no bytes reach the PTY. On Windows and Linux `new-in-area` and a `Ctrl+W` close-tab are not intercepted inside a terminal (04's exception); a user rebinding of `close-tab` applies to both, while `terminalBinding` stays the terminal's default unless the user rebinds it too (a second row "Close tab, in a terminal" appears on Windows/Linux).
- **Page**: one group card; row per action: label, binding as `Kbd` keys from `formatForDisplay(binding, { platform })` (⌘ on macOS, Ctrl elsewhere), and for rebindable rows **Change** and (when overridden) **Reset**. Change starts `useHotkeyRecorder({ onRecord, onCancel })`: the row shows "Press the new shortcut… Esc to cancel" (`aria-live`); on record the candidate is checked with `validateHotkey` (must include a non-modifier key and, except function keys, at least one of Mod/Ctrl/Alt), against the other actions' resolved bindings (exact equality after `normalizeHotkey`), and with `findHotkeyConflicts(candidate, { platform, exclude: (r) => r.options.meta?.actionId === id })` (every registration of the edited action is excluded, not just one) against live registrations, which returns hotkey or sequence registrations (`conflicts.d.ts:5-11`). A conflict whose registration carries `meta.actionId` of a **rebindable** action shows "Already used by {action}" with **Use anyway** (sets that action to `null` in the keymap) or **Cancel**; a conflict with a fixed binding, a non-rebindable action, or a sequence (no `actionId`, e.g. a component-level or registry binding) shows "Already used by {description ?? 'another part of the app'}" with **Cancel** only. Save → `updatePrefs({ keymap: { ...prefs.keymap, [id]: binding } })`; Reset removes the key; **Reset all shortcuts** (footer) → `updatePrefs({ keymap: {} })`.
- Reserved combinations the OS or Chromium owns (`Mod+Q`, `Mod+H`, `Mod+M`, `Mod+Tab`, `Mod+C/V/X/Z/A`; `Mod+W` is not reserved: it is `close-tab`'s default) are refused with "That shortcut belongs to the system." (a fixed list in `actions.ts`, tested).
- Provenance note: the map is one leaf (F13).

### 21.4 About and updates (`/settings/about`, `/settings/about/changelog`, canvas `SettingsAbout`)

- **Identity** card: app mark 48, "AbacusAI Bot", "Version {appVersion} · {platform label}" (`system.info`), **Check for updates** → `update.check()` (a failure is thrown as an error by the procedure, spec 00 `update.check`), and on macOS a text button "Show app info" → `window.showAbout` (ST20).
- **Update state** row (one line under the card) from `useUpdateStatus()` (port of `use-update-status.ts`: `update.status` query seeded, then `update.events` (first yield is current, coalescing), ignoring the seed once a live event arrived; a local `clicked` flag for instant "installing" feedback):

| `UpdateStatus` | Line | Action |
|---|---|---|
| `checking` | "Checking…" + spinner | — |
| `downloading` | "Downloading update… {percent}%" + "{version} · {transferred} of {total}" + progress bar | — |
| `downloaded` | "Version {version} is ready to install" / "Restarts the app" | **Relaunch to update** → `update.install()` |
| `installing` | "Restarting…" | — |
| `error` and not downloaded | "Update download failed" when `failedPhase === "download"`, "Couldn't check for updates" + "Offline?" when `"check"`, "Couldn't install the update" when `"install"` — from the typed `UpdateStatus.failedPhase` (§31.5 h), never the text or `progress` (main clears `progress` on every error, `update-service.ts:178-189`) | **Retry** → `update.check()` |
| none of the above, `available === false` | "You’re on the latest version" / "Checked {relative time}" (the time of the last `checking: true → false` transition seen in this document; "Checked just now" after a manual check) | — |

- **Save logs…** → `system.logs.save({ rendererLogs })` (the renderer's log ring from `lib/log-ring.ts`, a port of `getLogDump`); toasts "Logs saved to {path}" / "Could not save logs: {error}"; `filePath: null` (cancelled) → nothing (ST21).
- **What's new** row → `/settings/about/changelog` (`nav-forward`): `parseChangelog` over `CHANGELOG.md?raw` (Vite raw import of the repo-root file, as the old renderer does), the running version badged "This version" (parity ST19), Markdown bodies through the same `@tanstack/markdown` renderer 04's `components/file-preview` uses.
- **Shell globals** (mounted once by `__root` through `features/shell/sidebars.ts`'s `globals`, §4):
  - `UpdatePill` in `TopBar.Actions`' global end slot (canvas "Update pill, in the title bar"): hidden when idle, when `criticalUpdate` or `installStalled`; "Downloading update… {percent}%", "Relaunch to update" (click → `update.install()`, tooltip "Version {version} is ready to install"), "Update download failed. Retry" (click → `update.check()`), "Restarting…". Folds into the ⋯ at `sm` (foundation §7.4).
  - `CriticalUpdateDialog`: non-dismissable `AlertDialog` when `criticalUpdate && downloaded`: title "A required update is ready", body (parity), "Restarting automatically in {m:ss}" counting down from 5:00, auto-installing at 0, **Restart now** / "Restarting…" (parity).
  - `UpdateStalledBanner`: when `installStalled`, a top banner under the title bar "Couldn't restart automatically. Quit and reopen the app to finish updating." (parity).
  - The old composer strip and home banner are retired (ST18).

---

## 22. Notifications and sounds (`/settings/notifications`, canvas `SettingsNotifications`, PLAN §Sound)

### 22.1 Page

Description "What AbacusAI Bot tells you while you are looking elsewhere." (parity).

| Row | Control | Source / write |
|---|---|---|
| Notify me (`notify`) | Switch, "When a task finishes, or a tool is waiting for you. Only while the window is not focused." | `settings.notifications.get/set({ enabled, sound })` (`sound` passed through unchanged; optimistic with rollback, parity) |
| Play sounds (`sounds`) | Switch, "Short sounds when a reply arrives or something needs you. Never while you're looking at it." | `prefs.sounds.enabled` via `updatePrefs({ sounds: { enabled } })` (F12) Upgrade: the old `notificationSoundDisabled: true` opt-out is imported into `sounds.enabled = false` with `legacy` provenance before any cue can play (§31.5 i). |
| Sounds (disclosure, one row per cue) | Switch + **Preview** (▶ 28 px icon button, `aria-label="Play {cue} sound"`) per cue: Sent, Reply arrived, Needs you, Done, Failed, Routine fired | `prefs.sounds.perEvent[cue]` via `updatePrefs({ sounds: { perEvent: { ...current, [cue]: on } } })` (a record is one leaf) |
| Quiet hours (`quietHours`) | Switch + From / To time inputs (§22.4) | `prefs.sounds.quietHours` (§31.5) |
| Per bot (`perBot`) | a row per bot: avatar 28, name, "Check-ins {summary}" (03 §10.1 summary, or "No check-ins"), `Select` All / Needs me / Nothing | `prefs.sounds.perBot[botId]` (§31.5); absent = All |

Canvas "Show in the notch" (phase 6) and "Badge the dock icon" (F11) are not rendered in this phase.

### 22.2 What the switches govern

| Setting | OS notifications (`system.notify`) | In-app cues (`lib/sound.ts`) |
|---|---|---|
| Notify me off | none | unaffected |
| Play sounds off | unaffected (OS notifications are always silent in this generation, §31.5) | none |
| per-cue off | unaffected | that cue never plays |
| Quiet hours active | none (all kinds) | none |
| Bot level Needs me | only needs-you for that bot's sessions (forever, sender, check-in runs) | only `needs-you` for that bot |
| Bot level Nothing | none for that bot | none for that bot |

Routine runs follow the routine's `botId` level when it has one, else All. Sessions (not bot-owned) follow the global switches only.

### 22.3 Preview

**Preview** calls `player.preview(cue)` (§23.1): it bypasses the visibility, coalescing, per-cue and quiet-hours gates (it is an explicit request) but not the audio unlock; the first click unlocks the `AudioContext` (the click is a user gesture). The button shows a 600 ms "playing" state (`aria-pressed` not used; `aria-live` stays silent).

### 22.4 Quiet hours

`{ enabled: boolean; start: "HH:MM"; end: "HH:MM" }`, default `{ enabled: false, start: "22:00", end: "08:00" }`. Two `input type="time"` (TanStack Form field pair; valid when both parse; `start === end` refused with "Pick two different times."; an overnight range is allowed); saved on blur of either (debounced 300 ms) through `updatePrefs({ sounds: { quietHours } })`. The row's detail shows "Now quiet until {end}" while active. `isQuietNow(q, now)` is pure and shared by the sound player, the notification gate and (phase 6) the notch.

---

## 23. Sound cues and gating (`lib/sound.ts`, `lib/notify.ts`)

### 23.1 Cues

The foundation's `Cue` set with 03 §17's synthesis for `sent`, `received`, `needs-you`, `done`, `failed`, plus this phase's **`routine-fired`**: two 50 ms sines 587 then 784 Hz, 60 ms apart, gain 0.06, exponential release (provisional values in one table in `lib/sound.ts`, same family as 03's; "Slack/WhatsApp-style: short, distinct, same family", PLAN). Triggers owned here: `routine-fired` from main's live notice `routines.events { type: "run-started", routineId, attemptId, trigger, startedAt }` (§31.5 j; lossless-actionable, **no snapshot**: a subscriber sees only fires after it subscribed), for trigger `schedule` or `webhook` (not `manual`/`create`, which the user just caused), gated by the routine's bot level, and deduplicated by `attemptId` in a per-document set (a reconnect that re-delivers an attempt plays nothing). Collection inserts never trigger it: snapshot loading and resync write every existing row as an insert (spec 00 B.3), so table changes cannot tell a new fire from hydration.

API additions (§31.1):

```ts
play(cue: Cue, opts?: { threadId?: string; botId?: string | null }): void;   // + perBot and quiet-hours gates
preview(cue: Cue): void;                                                       // §22.3
// SoundContext.prefs() now returns PrefsRow["sounds"] including perBot and quietHours
```

### 23.2 One gate for sound and notifications (`lib/notify.ts`)

```ts
export type AttentionKind = "needs-you" | "done" | "failed" | "received" | "routine-fired" | "sent";
export function allowed(kind: AttentionKind, ctx: { botId: string | null; now: Date; sounds: PrefsRow["sounds"] }): boolean;   // quiet hours, per-bot level
```

`createSoundPlayer` calls it before its own visibility/coalescing gates; 04's `features/sessions/notify.ts` and 03's cue watcher call it before `system.notify` (amendments §31.3, §31.4). R5-T26 is a table test over every kind × level × quiet state.

---

## 24. Motion

All values from `lib/motion.ts` via `motionFor`; reduced motion → cuts and 120 ms fades (foundation). Every `<ViewTransition>` prop is a type map with `default: "none"`.

| Moment | Owner | Spec |
|---|---|---|
| Rail into Routines / Artifacts / Library; into and out of Settings | foundation pane + sidebar VTs (`nav-lateral`, `settings-in`, `settings-out`) | unchanged |
| Settings page to page; Library page to page | foundation `nav-lateral` (rank 0 siblings) | cross-fade 200 ms |
| About → What's new; toolset list → detail | foundation `nav-forward` / `nav-back` | 12 px drill |
| Run report opens / closes (search-only) | `motion/react` `AnimatePresence` + width `layout` on the column | report `x: 16 → 0` + opacity 200 ms; the column width animates with `springs.panel`; no pane VT (search-only, foundation rule 1) |
| Artifact preview opens (grid → list + preview) | `motion` `layout` on the card list container, presence on the preview | 240 ms; items do not animate individually (up to 2,000) |
| Create / edit dialogs, sheets, invite dialog, alert dialogs | registry atoms (`data-starting-style`/`data-ending-style`) | registry-owned |
| Edit-by-chat bubbles appear | CSS `@starting-style` `translateY(4px)` + opacity 160 ms | none when reduced |
| Sidebar row reorder (running first), state dot change | `motion` `layout` on rows; CSS `@starting-style` for dots | `springs.sidebar` |
| Settings search result highlight | CSS keyframe 1.2 s background fade | none when reduced |
| Update pill appears / changes label | swap-label molecule (foundation) | 160 ms |
| Download progress bars | CSS `transition: width 200ms linear` | none when reduced |

---

## 25. i18n

New keys under `routines.*` (sub-objects `sidebar`, `page`, `run`, `form`, `schedule`, `editor`, `errors`), `artifacts.*` (`sidebar`, `page`, `preview`, `menu`, `format`, `open`), `library.*` (`connectors`, `messaging`, `mcp`, `skills`, `tools`), `settings.*` (`sidebar`, `search`, `general`, `appearance`, `notifications`, `memory`, `usage`, `account`, `models`, `environment`, `browser`, `devices`, `language`, `keyboard`, `about`, `updates`). Reused strings are mapped through `scripts/locale-keymap.json` (foundation §9.3; 03 §18 pattern) so all 11 locales arrive translated. Mapped families (every leaf listed in the keymap; R5-T35 checks sources exist):

| New family | Old source |
|---|---|
| `routines.form.*`, `routines.schedule.*`, `routines.page.*` (copy, delete, run toasts, webhook) | `routines.*` (`en-US.json:1379+`: dialog labels, hints, validation, `describeSchedule`, `runReadOnly`, `webhookPublicPending`, toasts) |
| `routines.templates.*` | read in place (existing keys) |
| `artifacts.*` (search, filters, empty, missing, copy, reveal) | `artifacts.*` (`en-US.json:28-53`), `openFile.*` (`:1294-1300`) |
| `library.connectors.*` | `connectors.*`, `sidebarNav.connectors` |
| `library.messaging.*` | `messaging.*` (states, descriptions, setup, web login, shared link, settings dialog) |
| `library.mcp.*` | `mcpManagement.*` |
| `library.skills.*` | `skills.*` |
| `library.tools.*` | `capabilities.*` (tabs, tools, toolsets, toolDescriptions read in place) |
| `settings.account.*` | `profile.*`, `referrals.*` |
| `settings.models.*` | `apiKeys.*`, `localModels.*` |
| `settings.notifications.*` | `notificationSettings.*` |
| `settings.memory.*` | `memory.*` |
| `settings.usage.*` | `usage.*` |
| `settings.browser.*`, `settings.devices.*` | `browserSettings.*`, `deviceSettings.*` |
| `settings.environment.*` | `capabilities.execBackend.*`, `capabilities.terminalShell.*` |
| `settings.updates.*` | `update.*` (pill, strip, critical dialog, stalled banner) |
| `settings.about.*` | `about.*` (already renderer-next scaffolding), `changelog.*`, `logs.*` |
| `settings.appearance.theme.*`, `settings.language.*` | `theme.*`, `languages.*` |

- Model-facing strings are not i18n: routine template **prompts** (English, byte-equal, R5-T35 checks `en-US`), the edit-by-chat text is the user's words.
- Canvas copy that is new (stats line, run report sub-line, format labels, Library descriptions, settings page descriptions, Keyboard page, quiet hours, per-bot levels, sound cue names, Back to the app) gets new English keys.
- Estimated ~620 new keys, ~430 mapped. The phase gate "every locale key accounted for" is R5-T35: every `en-US.json` leaf is either used by renderer-next (static `t()` scan plus the dynamic families registered in `lib/i18n/dynamic-keys.ts`), a keymap source, or listed in `scripts/locale-retired.json` with a reason; nothing is left unclassified.

---

## 26. Accessibility

- **Sidebars**: `<nav aria-label>` per area ("Routines", "Artifacts", "Library", "Settings"); rows are links with composed names ("Morning brief, Weekdays at 8:00", "Inbox triage, Running, 3 minutes"); state dots never alone; stats line is plain text; artifacts filter rows expose counts in the name ("Images, 31").
- **Routine page**: `<h1>` name; the Switch named "Routine on"; runs list is a list of buttons with `aria-pressed`; the run report is a `region` labelled "Run of {name}, {stamp}"; its Close named; the edit-by-chat reply announced once (`aria-live="polite"`).
- **Forms**: every control has a `FieldLabel`; errors linked by `aria-describedby`, `aria-invalid` after display (03 §19); the schedule segmented control is a radio-like `toggle-group` labelled "Schedule"; weekday buttons use full names; the next-fire preview is `aria-live="polite"` only after a change.
- **Artifacts**: grid is a `list` of `listitem` buttons; the selected card `aria-current="true"`; thumbnails `alt=""` (the card's name carries the meaning); the preview is a `region` "Preview of {title}"; the chart-free page needs no table.
- **Library**: state pills are text; connect waiting states `aria-live`; the QR image has an `alt`; the MCP logs panel is a `log` role, `aria-live="off"` (high rate) with "Copy logs".
- **Settings**: each page has one `<h1>`; each row's control is labelled by its title and described by its detail; segmented controls are `toggle-group`s with names; theme tiles have text labels; the Keyboard recorder announces "Recording shortcut for {action}" and the result; the usage chart has a visually hidden data table; the Back to the app button is named; settings search results are a `listbox` with `aria-activedescendant` (registry `Command`).
- **Contrast**: pills (done, running, attention, destructive tokens from 02) on `bg-card` in both themes; artifact format tile glyphs on their tones ≥ 3:1 (graphics) and the tile labels are not text-on-tone; chart bars ≥ 3:1 against the card (R5-T30 computes).
- **Keyboard**: `Mod+N` in Routines opens the create dialog (foundation); every row menu has the ⋯ button path; arrow keys in the artifacts list; `Escape` closes dialogs/sheets (history back) and clears `item` in Artifacts.
- R5-T32 runs axe over every gallery section with one overlay open at a time (foundation R1-T8 pattern) and over the real routes in the screenshot run (contrast on).

---

## 27. Gallery (`/__ui`)

Sections passed by the `[__ui].tsx` route (02 §14.8 pattern), data from fake `AppClient` slices plus real collections over the foundation's fake tables:

| Section | Content | Canvas boards |
|---|---|---|
| `routines-sidebar` | stats line, every §6.3 state, auto-replies, search with/without results, empty, loading, error, row menu open | Routines, RoutineStates (rows) |
| `routines-page` | header (bot-made and plain, webhook pending), cards, runs list (running/completed/failed), run report (completed, failed, running; the read-only banner; the firing frame hidden), edit-by-chat (idle, changing, reply, timeout) | Routines, RoutineStates |
| `routines-form` | create with each preset, custom valid/invalid with the next-fire preview, once past, template picked with the folder warning, edit with "Changed in another window", discard prompt | RoutineCreate |
| `artifacts` | grid, list, preview (code, markdown, image, deck, binary, link), empty, no match, missing notice, row menu, 2,000-row fixture | Artifacts, ArtifactsPreview, ArtifactsStates |
| `library-connectors` | categories, connected/available, search, sheet in each state (connected, connecting, failed, signed out, MCP auth-required), fields dialog (token, oauth-client), toasts | SettingsConnectors, ConnectorStates |
| `library-messaging` | platform rows in each state, sheet: web login, shared link Telegram (QR) and Discord (steps), syncing, pending approvals, settings card | SettingsMessaging |
| `library-mcp` | rows in each runtime status, no running session, logs, server dialog (stdio, http, errors), import menu | SettingsMCP |
| `library-skills-tools` | skills groups, marketplace dialog states, restart banner; tools list with Always on / Planned, toolset detail | SettingsSkills, SettingsInPlace |
| `settings-shell` | nav, search with results/no results, Back to the app, focus highlight | SettingsInPlace, SettingsGeneral |
| `settings-pages` | every page, signed in and out where it matters, every update state, the pill and the critical dialog, local model download states, keyboard recorder and conflict, quiet hours, per-bot levels, preview buttons | SettingsGeneral, SettingsAppearance, SettingsNotifications, SettingsMemory, SettingsUsage, SettingsAccount, SettingsSignedOut, SettingsModels, SettingsEnvironment, SettingsAbout, SettingsSkills (Keyboard half) |

The screenshot script (foundation §10.2) gains `/routines`, `/routines/<first>`, `/routines/<first>?run=<run>`, `/routines/new`, `/routines/<first>/edit`, `/artifacts`, `/artifacts?view=list&item=<id>`, `/library/{connectors,messaging,mcp,skills,tools}`, `/library/connectors?connector=gmail`, `/library/messaging?platform=telegram`, `/library/mcp?server=new`, and every `/settings/*` page; the fixtures home gains the canvas routines (one bot-made, one webhook, one paused, one once, one failing) with recorded runs as sessions, 120 artifacts across bots and workspaces (with real files in the scratch home, one deleted after seeding), MCP servers with a scripted runtime, a messaging snapshot fixture, and a local-models state with a download in progress.

---

## 28. Tests

Projects: **jsdom** = vitest `renderer-next`; **main** = vitest `main`; **shared** = vitest `shared`; **Electron** = `main-serial` with the A-T12 harness (isolated profile + CDP); **type** = `tsc -b` + `expectTypeOf`. "Fake tables" = the foundation's `fake-table.ts` under the real `createCollection` + `ipcCollectionOptions` (never a mocked collection); "memory transport" = spec 00's `createMemoryTransport` over the real router with fake services; forms run on the real TanStack Form 1.33.5 and valibot 1.5.0.

| Id | File | Runs in | What it proves |
|---|---|---|---|
| R5-T1 | `routes/phase5.routes.test.ts` | jsdom | Route-tree snapshot for §5.1 (ids and fullPaths, including `settings/about_/changelog`); every new mask (`/routines/$routineId/edit`, messaging `platform`, mcp `server`, skills `marketplace`, account `invite`) shows its mask target as `maskedLocation`, survives a simulated reload and closes with `history.back()` (or the mask target with no history); opening and closing each keeps the background's instance, scroll and a local counter; every `PANE_BOUNDARIES` key is a generated id; `/library/tools/<unknown>` redirects; `/settings` → `/settings/general`. |
| R5-T2 | `lib/navigation/nav-type.phase5.test.ts` | jsdom | Settings page ↔ page `nav-lateral`; into/out of Settings `settings-in`/`settings-out`; About → changelog `nav-forward` and back `nav-back`; routine → routine `nav-lateral`; every search-only change (`run`, `item`, filters, `connector`, `platform`, `server`, `focus`) none. |
| R5-T3 | `routes/phase5.preload.test.ts` | jsdom (memory transport) | Hovering every link of the Routines, Artifacts, Library and Settings sidebars (preload) calls no mutation procedure and no `ai.hydrate`; `/routines/$id?run=` hydrates the run on enter only; a cold direct navigation with the `routines`/`routineRuns` snapshots delayed 1 s renders the page, never `notFound` (loaders await their own preload, 03 review #1); a `run` of another routine is dropped with `replace`. |
| R5-T4 | `routes/phase5.gone.test.tsx` | jsdom (fake tables) | A routine deleted by a batch while open renders "This routine is gone." without an error boundary; deleting here navigates first; a run removed while its report is open shows "This run was removed."; an artifact `item` that vanished shows "This artifact is no longer here."; an unknown MCP `server` shows the removed state. |
| R5-T5 | `features/*/data/invalidation.phase5.test.ts` | jsdom | For each data-source row of §9.1, §12.2, §13.1, §14.1 and the settings pages, emitting only that source refetches exactly its queries: statuses on `connectors.events`, `settings.events { credentials-changed }` and `messaging.events`; snapshot on `messaging.events`; sender chats on `bots.events`, `messaging.events` and a sender-session insert; `mcp.list` on its mutations and `connectors.events`; `models.list`/`listProviders` on `credentials-changed`; `memory.bots` on `memory.events` and a bot rename; `update.status` seeded then superseded by `update.events`; `localModels.state` folded from `progress` and invalidated on terminal phases. |
| R5-T6 | `features/routines/data/routine-state.test.ts` + `stats.test.ts` | jsdom | `routineState` table for every §6.3 case and precedence (needs-you > running > failed > paused > once > webhook > manual > scheduled); `stats` at the midnight boundary and with a future `nextRunAt` today; the minute clock re-evaluates. |
| R5-T7 | `features/routines/data/actions.test.ts` | jsdom (fake tables + fake procedures) | Every §9.2 row through the real collections: create (optimistic row, echo with server-derived name and `nextRunAt`, no intermediate old value), `CONFLICT` retry with a new id, `BAD_REQUEST {field:"schedule"}` on the Schedule field, test run fired with `trigger: "create"` and its failure toast; edit sends only edited fields and the composed schedule; on/off rollback; run now toasts; delete navigates first, `NOT_FOUND` resolves (idempotent), other errors keep the dialog; the renderer never writes `botId`. |
| R5-T8 | `features/routines/form/routine-form.test.tsx` | jsdom | Real TanStack Form + valibot: no errors before the first blur; blurring one field shows only its error; after a submit attempt errors update on change; parity messages for instruction, custom empty, once missing, once past; **whitespace-only instruction is refused and a trimmed name persists** (parse-on-submit, 03 review #5); every preset's controls; a non-preset cron opens as Custom and saves untouched; the next-fire preview equals `nextRun(e, now)`; **two successive remote changes** refresh untouched fields without marking them touched or validating, an edited field is kept, the notice shows, and save sends only edited fields (03 review #6); a template replaces a clean form and asks on a dirty one; the discard prompt blocks navigation. |
| R5-T9 | `shared/routines/cron.test.ts` | shared | The moved `parseCron`/`nextRun` pass main's existing `cron-store.test.ts` cases imported from the shared module **and** through main's re-export; `CronParseError.code` for each error family; `composeCron`/`decomposeCron` round-trip with `draftFromRoutine`/`toRoutineWrite` (once, manual, custom). |
| R5-T10 | `features/routines/page/run-report.test.tsx` | jsdom (memory transport + chat fixtures) | `?run=` renders the report beside the page at `xl` and in place of the column below it; the report is a read-only `ChatView` (no composer), the firing frame is hidden, "Open as a session" targets `/sessions/$run`; switching runs commits only after hydration (no empty frame); the runs list is `routineRuns` where `routineId`, newest first, with the result column only when the row has `result`. Also: sessionless attempts (skipped overlap, no workspace) are listed and not clickable; a result recorded by a cron write after the session batch appears for an already-subscribed client; the first user message of a routine run is hidden by position (plain and bot-voiced envelope) while `<system_reminder>` blocks around user words leave the words. |
| R5-T11 | `guards.phase5.test.ts` (extends R1-T15) | jsdom | AST scan of the four features: no `.message.includes(`/`.message ===`/regex tests on error messages or on `lastResult`/`reason`/`errorMessage` strings; no feature imports another; `components/{artifact-kind,settings-rows,usage-chart}` import no `data/` or feature; no `monaco`, no chart or cron library, no `qrcode` import in renderer-next; no `window.api`. |
| R5-T12 | `features/routines/page/editor-chat.test.tsx` | jsdom (fake procedures, fake timers) | Enter sends trimmed text once; the field is disabled while pending; "Changing…" shows; the reply bubble and one live-region announcement; `NOT_FOUND` → gone view; `TIMEOUT` → the timeout bubble; `INTERNAL_SERVER_ERROR` → the generic line with the message as secondary text; the log survives a store re-creation from `sessionStorage` and keeps 10 exchanges. |
| R5-T13 | `features/routines/sidebar/routines-sidebar.test.tsx` | jsdom (fake tables) | Stats line, rows in every state (including `needs-you`), the needs-you contributor for a non-check-in routine run waiting for approval, with composed names, running first, auto-replies from `senderChats` linking to `/bots/$botId/chats/$sessionId`, search, empty, loading, error; the context menu and ⋯ render the same items; rows do not remount on data changes. |
| R5-T14 | `features/artifacts/data/filters.test.ts` + `sources.test.ts` | jsdom (fake tables) | Source derivation for forever, sender, check-in-run, routine-run, plain and deleted sessions; `q` over title, location and source label (accent-insensitive); `type`, `from` (`bot:`, `workspace:`, `routines`); counts from the searched set equal what each type click shows; sorts; day grouping at midnight; `artifactFormat` for every extension family. Also: an ownerless check-in run's artifact matches `from=bot:<bot>` and `from=routines`; `q` matches a sender chat's and a run's session label that differs from the bot or routine name. |
| R5-T15 | `features/artifacts/page/artifacts-page.test.tsx` | jsdom (fake tables + fake procedures) | Grid and list render; `item` opens the preview (list + pane at `xl`, replacement below `lg`); thumbnails request `readImageAsDataUrl` with `hostRoot = dirname` only when near the viewport; open: link → `openExternal`, missing file → notice, directory → reveal + toast, file → `openPath` with each `OpenFilePathResult` toast; Go to session targets per §11.3; copy path/URL; the menu has no Remove; empty and no-match states and Clear search. The probe runs through the real `filesRouter` (memory transport): a directory yields `CONFLICT {reason:"not-a-file"}` and the reveal path, a missing file `NOT_FOUND`. |
| R5-T16 | `features/library/connectors/connect-flow.test.ts` | jsdom (memory transport, fake timers) | One hop at a time (another start cancels with the toast; the same row retries); the 3 min watchdog cancels; signed-out platform runs `auth.abacus.start` first; the Chrome warning; fields path with `submitFields`; pairing navigates to Messaging; success refreshes MCP for each running session; `cancelled` is silent; the MCP sign-in failure copy; a hop survives navigating away and back. |
| R5-T17 | `features/library/connectors/connectors-page.test.tsx` | jsdom | Categories from the registry, every non-messaging entry reachable from a tab without searching (platform connectors under Abacus.AI and Featured); connected vs available; not-offered hidden after load; search across categories; row buttons per state; the sheet in connected, connecting, failed, signed-out and MCP auth-required states; Disconnect confirm and toasts; fields dialog validation, masking and the redirect URL. |
| R5-T18 | `features/library/messaging/messaging.test.tsx` | jsdom (fake procedures) | Rows per platform state and badge mapping; `connectPlatform` enables the gateway before the platform when `gatewayEnabled:false`, for a disabled WhatsApp and for shared linking, and web login/pairing start only after it; the sheet: web login called once on mount, shared link auto-start once, QR `<img>` from the snapshot, copy "/link code", Discord steps and `openSharedLink` targets, pending Approve/Reject decisions, cancel disables both halves, unlink confirm, revoke confirm for approved people; settings card writes each field and applies the returned snapshot; the dormant credentials form still renders from `fields` when present. |
| R5-T19 | `features/library/mcp/mcp-page.test.tsx` | jsdom (memory transport, fake runtime iterator) | Runtime scope: the most recent running session, a manual pick, none running (disabled Refresh/Restart with the copy); status pills from `servers` then merged `status` events; logs from `runtime.logs` + `log` events capped at 200; enable/disable and remove (with confirm) optimistic with rollback; import paths including `singleEntry` prefill and clipboard detection; OAuth sign-in states. |
| R5-T20 | `features/library/mcp/server-form.test.tsx` | jsdom | Form schema: required name/command/url, `http(s)` only, trimmed args, blank keys dropped, empty OAuth omitted; `success: false` shows `error`; edit keeps the name disabled and follows remote changes for untouched fields. |
| R5-T21 | `features/library/skills-tools.test.tsx` | jsdom (fake procedures) | Skills grouped with builtin hidden, workspace picker drives `workspacePath`, Edit skill file, uninstall confirm and rollback, import cancel ignored, marketplace debounce 350 ms and states, restart banner after changes; tools switches with rollback, Always on / Planned rows, detail texts, the terminal toolset's link to Settings. Also: after an install the `skills.listInstalled` baseline is invalidated and `/` in a thread with no agent yet lists the new skill. |
| R5-T22 | `features/settings/shell.test.tsx` | jsdom | Nav groups and links; the Library row leaves with `settings-out`; Back to the app returns to the last location outside Settings after several settings pages (not one history step) and defaults to `/bots/new`; identity "Settings". |
| R5-T23 | `features/settings/pages/*.test.tsx` | jsdom (fake tables + fake procedures) | Each page's rows read and write their sources (§18–§22): immediate optimistic writes with rollback toasts; prefs writes go through `updatePrefs(patch)` and resend same-value choices (provenance, spec 00 B notes); General hides Launch at login on Linux and "Bots and routines run in" without sandbox support; Appearance density calls `window.setDensity` and shows the macOS note; Memory forget sends the original row and shows the `CONFLICT` line, clear confirms per target, custom instructions Save enabling and remote sync; Usage cards, chart bars and hidden table, by-model rows, states; Account signed in/out, sign-out checkbox mapping, invite dialog validation (emails, phones); Models dialogs (`isPlausibleApiKey`, remove confirm, connect attempt token, `?provider=local`), local models states and the fold of progress; Environment backends, fallback alert, shell picker; Browser and Devices parity rows; Language writes then `changeLanguage` on the echo; About update-state table. Also: Remove for a stored Abacus/OpenRouter credential; `?provider=local&for=<thread>` adopts a downloaded or installed model into a bot and into a session and returns to the thread. |
| R5-T24 | `features/settings/search-index.test.ts` | jsdom | Every `data-setting-id` rendered by every page (rendered in turn) is in `SETTINGS_INDEX` and every index entry renders; search matching (accents, keywords); `?focus=` scrolls, focuses, highlights and is removed with `replace`. |
| R5-T25 | `features/settings/keyboard.test.tsx` + `lib/keyboard/actions.test.ts` | jsdom | `resolveKeymap` over defaults, overrides and `null`; the recorder flow (start, record, Esc cancel); `validateHotkey` refusal; conflicts against other actions and against live registrations via `findHotkeyConflicts`; "Use anyway" unbinds the other; reserved system shortcuts refused; Reset and Reset all write the right patches; `useAppHotkey` re-binds when `prefs.keymap` changes and the old binding stops firing; labels via `formatForDisplay` per platform. Also: `close-tab`/`next-tab`/`previous-tab` in `APP_ACTIONS` with the Windows/Linux terminal binding; a conflict with a rebindable mapped action offers Use anyway, a fixed registration or a sequence offers Cancel only; all registrations of the edited action are excluded. |
| R5-T26 | `lib/notify.test.ts` + `lib/sound.phase5.test.ts` | jsdom | `allowed(kind, …)` table over every kind × bot level × quiet hours (overnight ranges, the boundary minutes); the player gates on it before visibility/coalescing; `preview` bypasses every gate but unlock; `routine-fired` plays only for live `routines.events run-started` notices (schedule/webhook), once per `attemptId`, never for collection snapshot or resync inserts, and follows the routine's bot level; synthesis of `routine-fired` schedules audible output (`OfflineAudioContext`, Electron where jsdom lacks it). |
| R5-T27 | `features/settings/updates.test.tsx` | jsdom (fake iterator, fake timers) | `useUpdateStatus` seed then live; the pill's states and hiding rules; the critical dialog counts down 5:00 and installs at 0, cannot be dismissed; the stalled banner; About's check and relaunch; the `error` row uses `failedPhase` (real transitions: an error while checking, one while downloading), never text or `progress`. |
| R5-T28 | `main/services/system/login-item.test.ts`, `window-density.test.ts`, `notify-silent.test.ts`, `cron-errors.test.ts`, `routine-runs-result.test.ts` | main | After §31.5: `system.loginItem.get/set` call `app.get/setLoginItemSettings` (mocked) and refuse on Linux with `PRECONDITION_FAILED {reason:"unsupported-platform"}`; `window.setDensity` persists, republishes `window.events { chrome }`, recreates on macOS; notifications are `silent` in the wco generation and keep the old rule in legacy; cron parse failures reach the client as `BAD_REQUEST {field:"schedule", detail}` (legacy IPC keeps its `Error` text); `editByChat` timeout is `TIMEOUT`; a fired routine records its `sessionId` on the `CronRun` and `routineRuns` rows carry `result`. Also: every attempt kind records an id (overlap and missing-workspace attempts included); `failedPhase` is set from the pre-error state; `notificationSoundDisabled: true` imports as `sounds.enabled: false` (legacy) on upgrade and does not override a `user` value; `routines.events run-started` fires once per started attempt. |
| R5-T29 | `shared/contract/prefs.phase5.test.ts` | shared + main | `PrefsRow`/`PrefsPatchSchema` accept `sounds.perBot`, `sounds.quietHours`, `keymap`, `appearance.textSize`, `appearance.bubbleTint`; each is a leaf with its own provenance; defaults; unknown keys refused; a `user` keymap survives a legacy import; `PREFS_LEAVES` lists the new leaves. |
| R5-T30 | `features/*/contrast.phase5.test.ts` | jsdom | Computed ratios: state pills on `bg-card` in both themes (≥ 4.5:1 text), format tile glyphs on their tones (≥ 3:1), chart bars on the card (≥ 3:1), the attention/running/done tokens in rows. |
| R5-T31 | `e2e/artifacts-2000.mjs` | Electron | 2,000 artifacts with 300 images: first paint < 400 ms, scroll ≥ 50 fps median, at most 400 cards in the DOM at any scroll position (bounded window, §10.5), thumbnails load only near the viewport. |
| R5-T32 | `features/*/gallery/a11y.test.tsx` | jsdom | axe over every §27 section with one overlay open at a time; icon buttons named; rows' controls labelled and described; the chart's hidden table; the recorder's live announcements; menus reachable from ⋯. |
| R5-T33 | `features/library/registry-bundle.test.ts` | jsdom + build | `@abacus-ai/connectors/registry` imports in the renderer-next bundle with no Node built-ins (a Vite build of a probe entry fails on `node:` imports), deciding the §3 unverified claim; `connectUi` gives the §12.4 table for every catalogue entry. |
| R5-T34 | `features/*/motion.phase5.test.tsx` + `motion.types.test.ts` | jsdom + type | Reduced motion: run report and preview open as cuts, bubbles and highlight without animation; `motion/react` imports type-check against the installed 13.4.6. |
| R5-T35 | `lib/i18n/phase5.keys.test.ts` | jsdom | Every `t()` key under the four features and the new components exists in `en-US.json`; every keymap source exists; template prompts are byte-equal to today's `en-US`; **the phase gate**: every `en-US.json` leaf is used by renderer-next (static scan + `dynamic-keys.ts`), a keymap source, or in `locale-retired.json` with a reason. |
| R5-T36 | `e2e/phase5-real.mjs` | Electron (real main, fake provider) | The gate run: create a routine from a template with a weekday schedule and "Run once now" → a run appears, its report streams read-only; edit it by chat ("every day at 7 instead") → the schedule label changes; pause it → no fire; open an artifact the run wrote in Artifacts, preview it, reveal it; connect a credential connector through the fields dialog and see it Connected; add an MCP server, see it Connected in a running session, disable and remove it; change theme, language, density, a shortcut and quiet hours → each persists across a restart and the old renderer (legacy generation) shows theme and language; check for updates against the fake feed through each state to "ready". |
| R5-T37 | `features/*/structure.test.ts` | jsdom | The folder rules of §4 (a script over imports). |
| R5-T38 | `features/*/parity.test.ts` | jsdom | Every `parity.ts` row (§2) names an existing route, component or test id and has a status. |
| R5-T39 | `e2e/settings-transitions.mjs` | Electron | Entering and leaving Settings starts one view transition typed `settings-in`/`settings-out` over pane and sidebar; page ↔ page one `nav-lateral`; opening the run report, the artifact preview, a sheet or a dialog starts none. |

---

## 29. Scaffold order

Each step is a commit on `rewrite/05-routines-library-settings`, stacked on the phase 4 branch.

1. `shared/routines/{cron,templates}.ts`, `shared/settings/{abacus-urls,browser-homepage,changelog,usage-format}.ts` + the old-file re-export shims (§31.7) + moved tests; old renderer and main suites green; R5-T9.
2. Main and contract (§31.5): prefs leaves, `window.setDensity`, `system.loginItem`, silent notifications, typed cron and timeout errors, `CronRun.sessionId` + `RoutineRunRow.result`; R5-T28, R5-T29.
3. Foundation amendments (§31.1): `updatePrefs(patch)` everywhere (phase 1's `AppearanceTheme` included), search schemas, masks, boundaries, ranks, `lastLocationOutsideSettings`, settings back button, keymap-driven `useAppHotkey`, sound API; R5-T1, R5-T2, R5-T22.
4. `components/{artifact-kind,settings-rows,usage-chart,form-kit}`; `lib/{notify,keyboard/actions}.ts`; R5-T26 (logic half), R5-T30.
5. Routines data, sidebar, pages, form, run report, editor chat; R5-T3 … R5-T8, R5-T10, R5-T12, R5-T13.
6. Artifacts; R5-T14, R5-T15, R5-T31.
7. Library: connectors + flow, messaging, MCP, skills, tools; R5-T16 … R5-T21, R5-T33.
8. Settings shell and pages, updates globals, keyboard, notifications and sound; R5-T23 … R5-T27.
9. Chat kit and bots/sessions amendments (§31.2–§31.4).
10. Motion; R5-T34, R5-T39.
11. i18n + keymap + `locale-retired.json`; gallery; screenshots; R5-T11, R5-T32, R5-T35, R5-T37, R5-T38; R5-T36 recorded; `PROGRESS.md`.

---

## 30. Acceptance

**Build and rules**
- [ ] `typecheck`, `lint`, `format:check`, `check:knip-next`, `check:i18n`, `check:locales`, `test:unit` green; R5-T1 … R5-T39 pass; R5-T31, R5-T36, R5-T39 recorded on macOS (R5-T36 also on Windows for Launch at login and density).
- [ ] Changes under `src/renderer` are only locale additions and the re-export shims of §31.7; the old renderer suites pass unchanged.
- [ ] No `ui/` diff; no new dependency; no cron, chart or QR library and no `monaco` in renderer-next.

**Parity (gate)**
- [ ] Every §2 row is green in `parity.ts` (R5-T38), and each "Parity" row is demonstrated in the real app once (checklist in the PR).
- [ ] `PARITY.md` rows for `routines.*`, `db.routines`, `db.routineRuns`, `db.artifacts`, `connectors.*`, `messaging.*`, `mcp.*`, `skills.*`, `settings.*`, `update.*`, `localModels.*`, `account.*`, `auth.*`, `referrals.*`, `memory.*`, `browser.*` settings rows, `devices.setEnabled/setApproval/installMaestro`, `terminal.shell.*`, `system.logs.save`, `window.showAbout` name their renderer-next consumer or retirement.
- [ ] Every `en-US.json` key is accounted for (R5-T35).

**Canvas (screenshots at 1280/1000/900/800, light and dark)**
- [ ] Routines, RoutineCreate, RoutineStates; Artifacts, ArtifactsPreview, ArtifactsStates; SettingsConnectors, ConnectorStates, SettingsMessaging, SettingsMCP, SettingsSkills (both halves) as Library and Settings pages; SettingsInPlace, SettingsGeneral, SettingsAppearance, SettingsNotifications, SettingsMemory, SettingsUsage, SettingsAccount, SettingsSignedOut, SettingsModels, SettingsEnvironment, SettingsAbout (every update state, the pill), each side by side with its board and the deviations of §32.3 marked.
- [ ] axe in the real layout reports no violations, contrast included.

**Behaviour (real app)**
- [ ] A routine created here fires on schedule in the running app, its run lists within one change batch, and its report is read-only; the old renderer shows the same routine and run.
- [ ] Hovering any sidebar row in the four areas starts nothing (logs show no mutation, no hydrate).
- [ ] A connector hop can be cancelled, times out after 3 minutes, and only one runs at a time, across the Library and a chat's request card.
- [ ] Theme, language, density, text size, reduce motion, shortcuts, sounds, per-bot levels and quiet hours survive a restart; a same-value theme or language pick is recorded as the user's (a later legacy import does not change it).
- [ ] With quiet hours active, no cue plays and no OS notification shows; with a bot at "Needs me", only its approval requests make a sound.
- [ ] With reduced motion on, no springs, slides or highlights play.

---

## 31. Amendments this spec requires elsewhere

1. **Foundation spec (01) and its implementation.** §6.1: routine edit masked child, `settings.about_.changelog`, settings pages `browser`, `devices`, `language`, `keyboard` (13 pages; the nine placeholders stay). §6.2: `ArtifactsSearch` replaced (F5); new `RoutineNewSearch`, `MessagingSearch`, `McpSearch`, `SkillsSearch`, `SettingsSearch`, `ModelsSearch`, `AccountSearch`; `ConnectorsSearch` gains `category`, `q`; `AREA_PANEL_TABS` for routines, artifacts, library become `[]` (no side-panel tabs; the run report and the artifact preview are in-pane). §6.6/§6.7: the five masks and six boundaries of §5.4; `ROUTE_RANK` for the changelog. §7.2/§7.4: the settings area replaces `TopBar.Leading`'s back with `SettingsBackButton`; `shellStore.lastLocationOutsideSettings`; the rail's Settings gear shows active in the area; the account button opens a small menu (Account, Sign out/in, Settings). §7.3: `SettingsSidebar` groups of §17.1 (replacing "Personal / App / Capabilities → Library"). §7.8: sound API `play(cue, { threadId, botId })`, `preview(cue)`, `routine-fired` synthesis; `lib/notify.ts`. §7.9: `useAppHotkey(actionId, handler)` resolves bindings from `prefs.keymap` through `lib/keyboard/actions.ts` and tags each registration with `meta.actionId`; the terminal dispatch of 04 takes action ids (`dispatchAppAction`); the needs-you slot merges a third contributor, `RoutinesNeedsYou` (§9.4); new default actions `new-bot` (`Mod+Shift+N`) and `new-terminal-tab` (``Mod+` ``). §8.3: phase 1's `data/collections/prefs.ts` recipe `updatePrefs` is replaced by `#next/data/db`'s `updatePrefs(patch)` (F18; 03 §24.1 already asked), and `data/collections/` is folded into `data/db/`. §7.7: `ThemeEffect` also writes `--chat-font-size` (`appearance.textSize`) and `data-bubble-tint`; a `LanguageEffect` applies `prefs.language` changes. `features/shell/sidebars.ts` `globals`: `UpdatePill`, `CriticalUpdateDialog`, `UpdateStalledBanner`.
2. **Chat kit (02).** `visibleUserText` moves unchanged from `renderer/components/chat/injected-text.ts` to `shared/transcript/injected-text.ts` with its tests (reminder blocks removed anywhere with the surrounding words kept, `injected-text.test.ts:43-50`; a message that is only app text becomes ""); the bot and session skins render every user message through it and hide one that becomes empty. For a routine-run session (`routineId != null`) the **first** user message is the scheduler's envelope by construction (main sends it, `service-host.ts:3892-3906`, possibly after a bot-voice prefix from `withBotVoice`, which the old regex missed): the kit hides it by position, not by text (RT21, R5-T10 covers a bot-voiced envelope and reminders around user words). The composer's `/` menu takes a route-provided `skillsBaseline` (§15) and prefers `CUSTOM skills.loaded` once it arrives. The upgrade `ErrorCard`'s "Use a local model" goes to `/settings/models?provider=local&for=<threadId>` (§20.5); prose and composer font size read `--chat-font-size`; the bot skin's user-bubble tint turns off under `html[data-bubble-tint="off"]`; `ChatView` read-only mode is used for routine run reports (no new prop). The model picker's "Use a local model" row links to `/settings/models?provider=local`.
3. **Bots (03).** `features/bots/form/form-kit.ts` moves to `components/form-kit/` (routines, library and settings use the same field components; the feature re-exports it for one release of the spec). Files tab uses `components/artifact-kind` (03 §12.3 waited on it). The check-in's "Edit in Routines" link targets `/routines/$routineId/edit`. Per-bot sound levels and quiet hours now exist (03 §25.3): 03's cue watcher calls `lib/notify.ts`'s `allowed` with the bot id.
4. **Sessions (04).** `features/sessions/notify.ts` calls `allowed` (quiet hours) before `system.notify`; its settings links now resolve (`/settings/browser`, `/settings/devices`, `/settings/environment` for the terminal shell, `/settings/notifications`); the dock registers `new-terminal-tab`, `close-tab`, `next-tab` and `previous-tab` through `useAppHotkey(actionId)` and its terminal adapter dispatches by action id with the Windows/Linux `terminalBinding` exception kept (coordinated with 04 r3; R4-T39 gains rebound shortcuts and asserts no PTY bytes escape).
5. **Main contract and services (00).** (a) **Prefs**: `PrefsRow.sounds` gains `perBot: Record<BotId, "all" | "needs-me" | "nothing">` (default `{}`) and `quietHours: { enabled: boolean; start: string; end: string }` (default off, 22:00–08:00); new scalar `keymap: Record<string, string | null>` (default `{}`); new group `appearance: { textSize: 13 | 14 | 15; bubbleTint: boolean }` (defaults 14, true); `PrefsPatchSchema`, `PREFS_LEAVES`, `PREFS_GROUP_ENTRIES`, defaults and the renderer's `DEFAULT_PREFS` updated; no legacy mapping (none of these exist in the old renderer). (b) **`window.setDensity({ density: "comfortable" | "compact" })`** over `setTitlebarDensity` with today's side effects (refresh chrome, publish, recreate on macOS); the raw `settings:set-titlebar-density` handler stays for tests until cut-over. (c) **`system.loginItem.get` / `.set({ openAtLogin: boolean })`** over `app.getLoginItemSettings`/`setLoginItemSettings`; `PRECONDITION_FAILED {reason:"unsupported-platform"}` on Linux. (d) **Silent notifications**: in the `wco` generation `showNotification` passes `silent: true` (the renderer's cue is the sound, PLAN §Sound); the legacy generation keeps `silent: !prefs.sound`. (e) **Typed routine errors**: cron-store parse failures throw a `CronParseError` (from `shared/routines/cron.ts`) mapped by `toRpcError` to `BAD_REQUEST { field: "schedule", detail }`; `editRoutineByChat`'s 90 s timeout throws a typed timeout mapped to `TIMEOUT {ms}`; legacy IPC keeps the same `Error` messages. (f) **Run attempts**: every `recordRun` gets a stable `id` (`attempt-<uuid>`), a `kind` (`started`, `skipped`, `no-workspace`, `start-failed`, `timed-out`, `paused`; the call sites at `service-host.ts:3571,3596,3875,3910,3947,3970` each pass their own) and a nullable `sessionId` (set when a session exists: `started`, `start-failed`, `timed-out`); `RoutineRunRow` gains `attemptId: string | null` and `result: string | null` from the matching attempt; `onRoutinesWritten` notifies `routineRuns` as well as `routines` (`rpc/tables/index.ts:249`), so a result recorded after the session notification reaches subscribed clients; stored runs without ids read as `id: legacy-<at>-<n>`, `kind` from `sessionId != null ? "started" : null`. (g) `routines` sets `idempotentDelete` (03 §24.5 already lists it). (h) **Update failure phase**: `UpdateStatus` gains `failedPhase: "check" | "download" | "install" | null`, set in the updater's `error` handler from the state **before** it clears `checking`/`downloading`/`progress` (`update-service.ts:178-189`: `downloading` → `download`, an install hand-off → `install`, else `check`), cleared on the next check; the legacy renderer ignores it. (i) **Sound opt-out import**: `legacy-prefs.ts` imports `config.json`'s `notificationSoundDisabled === true` into `sounds.enabled = false` with `legacy` provenance (the provenance rule: a `user` leaf is never overwritten), in the one-time step and the live sync (`setNotificationSettings` writes trigger it), so an old opt-out survives the change of sound mechanism. (j) **Routine start notice**: `routines.events` (new subscription, lossless-actionable without snapshot) publishes `{ type: "run-started", routineId, attemptId, trigger, startedAt }` when `startRoutineRun` records a `started` attempt.
6. **PLAN.md.** Route tree: `routines.$routineId.edit` (masked), settings pages as §17.1 (Personal, Models, Environment, App; Library linked), `library.messaging` as its own page, Artifacts filters `type ∈ file|image|link`, `from ∈ bot:|workspace:|routines`. Settings: "back to the app" in the title bar replaces the sidebar with the settings nav (confirmed; not a window). Sound: OS notifications are silent in the new generation; per-bot levels and quiet hours are prefs leaves. "Libraries to use or verify": no cron or chart library (F1, F14). Stack: `@tanstack/react-virtual` stays unadded unless R5-T31 fails.
7. **Old renderer (the only non-locale edits).** One-line re-exports: `components/settings/routine-templates.ts` → `shared/routines/templates.ts`; `lib/abacus-credits.ts` URL constants → `shared/settings/abacus-urls.ts`; `lib/browser-homepage.ts` → `shared/settings/browser-homepage.ts`; `lib/changelog.ts` → `shared/settings/changelog.ts`; `components/chat/injected-text.ts` → `shared/transcript/injected-text.ts`; the usage formatters stay in the panel (it keeps its own copy; `shared/settings/usage-format.ts` is a copy with the panel's tests re-pointed). Main: `cron-store.ts` re-exports `parseCron`/`nextRun` from `shared/routines/cron.ts`; `legacy-prefs.ts` imports `normalizeBrowserHomepage` from shared instead of its duplicate.

---

## 32. Risks, unverified claims, deferred items, review classes applied

### 32.1 Risks

| Risk | Mitigation |
|---|---|
| The shared cron parser drifts from what the scheduler runs | one implementation in `shared/`, main re-exports it; R5-T9 runs main's old cases through both paths |
| Routine runs and results joined by time instead of id | §31.5 (f) records the session id at fire time; until it lands the result column is absent, never guessed |
| A connector hop outliving its page (new rule) confuses users | the row and the sheet both show the waiting state with Cancel, and the watchdog still ends it at 3 minutes; R5-T16 |
| MCP status shown for the wrong session | the scope is explicit in the header and switchable; without a running session the page says so |
| Density change recreates the window on macOS (visible flash) | the row warns before; parity with main's existing behaviour |
| Keymap as one leaf: provenance for every shortcut flips together | there is no legacy keymap to import, so no user choice can be overwritten; noted in F13 |
| 2,000 artifacts without a virtualiser | a bounded 400-card window with evicting spacers; R5-T31 gates it; lowering the budget is the fallback |
| Settings search index drifts from the pages | R5-T24 renders every page and compares ids both ways |
| Silent OS notifications change legacy behaviour | only in the `wco` generation (§31.5 d); the legacy generation keeps its rule |

### 32.2 Unverified claims (each has a test that decides it)

`@abacus-ai/connectors/registry` in the renderer-next bundle (R5-T33); the bounded artifact window meets the frame budget (R5-T31); `useHotkeyRecorder` behaviour beyond its typings (R5-T25); `findHotkeyConflicts` sees `useAppHotkey` registrations (R5-T25); `app.setLoginItemSettings` in a packaged Windows build (R5-T36 on Windows); the run report committing only after hydration when switching runs (R5-T10); `motion` 13.4.6 typings (R5-T34); `settings-in`/`settings-out` view transitions with the new back button (R5-T39).

### 32.3 Deferred or not built (canvas elements without data or backend)

Routines: "Run by" a bot and "Deliver to" (F3); duplicate routine (none today); OS notifications for routine runs (none today). Artifacts: "Remove" / "Remove from artifacts" and a flagged missing state (F6); file sizes and image dimensions (F6). Library: connector scope toggles, "Used by", disconnect Undo (F16); skill "Update available" (F16). Settings: Accent (F10); Keep running in the menu bar, Badge the dock icon (F11); Notch companion and Show in the notch (phase 6); provider "Rate limited" and key "Check" (F15); "By bot and session" usage and per-provider daily split (F14); "Delete all local data" and organization Invite (no procedure); network allowlist and environment variables (F9); Replay the tour (phase 6); credit reset date ("resets in 9 days", not in the data). Canvas copy "Digest only" / "Mentions" levels (F12, PLAN's three levels instead).

### 32.4 Review defect classes applied

Every library claim cites the installed `package.json` / `.d.ts` or is listed in §32.2 (classes 1–2; F1, F13, F14 verified against packages and source, not assumed); masks use full paths and `PANE_BOUNDARIES` is typed (6–7); loaders await their own collection preload and never cause side effects on hover (8, 20; R5-T3); mutations await *received* in handlers and `isPersisted` outside, and every action has client / server / final row / failure (10–12; §9.2, §12.4, §14.4); every derived query lists all its sources with a single-source test (13; R5-T5); client ids are UUIDs checked against the id atoms (19); forms persist the **parsed** schema output and refresh remote values with `dontUpdateMeta`, `dontValidate`, `dontRunListeners` against a per-field baseline (03 reviews #5, #6); errors are typed and the UI never parses messages or main's free-text fields (42; R5-T11); prefs writes are patches so explicit choices get `user` provenance (03 review #8); intended behaviour changes are listed with owners in §2 (39); contrast is computed (27; R5-T30); tests go through real collections, router, form library and transport (31–32); every drag-free action has a keyboard path and every menu a ⋯ button.

---

## Review responses (r1)

Source: `docs/rewrite/specs/reviews/05-routines-artifacts-library-settings.codex-r1.md` (19 items: 17 major, 2 minor). All accepted. Coordinator decisions applied: parity first (#12 Remove kept for stored connect-provider credentials, #13 install-and-use with return to the requesting composer, #16 import the old sound opt-out with legacy provenance); #11 typed failure phase in `UpdateStatus` (a main requirement); #14 dock action ids in `APP_ACTIONS` with 04's terminal dispatch and Windows/Linux close-tab exception (wording coordinated with 04 r3); #15 action metadata on registrations, reassignment only for rebindable mapped actions; #17 a live routine-start notice with dedupe; #18 `nextRun(expr, now)` kept; #19 a bounded window, no new dependency; #1–#10 as proposed, each re-checked against the cited source.

| # | Sev. | Verdict | Evidence checked | What changed |
|---|---|---|---|---|
| 1 | Major | **Accepted** | `service-host.ts:3874-3880` records "skipped: the previous run is still going" and `:3909-3914` "no workspace to run in" before any session exists; `:3947` and `:3970` record after one. | F4, RT8, §7.3 list built from attempts (`recentRuns`) joined to `routineRuns` by `sessionId`; §31.5 f: stable attempt `id`, `kind`, nullable `sessionId`, `RoutineRunRow.attemptId/result`; sessionless attempts listed, not clickable; R5-T10, R5-T28. |
| 2 | Major | **Accepted** | `rpc/tables/index.ts:249`: `onRoutinesWritten` notifies `routines` only. | §9.1 source row adds cron writes; §31.5 f notifies `routineRuns` from `onRoutinesWritten`; R5-T10 cron-only result with a subscribed client. |
| 3 | Major | **Accepted** | 04 §6.2 excludes `routineId` sessions from the sidebar; 03 §6.2 counts only check-in runs. | §9.4 `RoutinesNeedsYou` contributor (non-check-in routine runs waiting on a permission or connector), linking to the run report; row state `needs-you`; §31.1 needs-you merge; R5-T13. |
| 4 | Major | **Accepted** | `injected-text.ts`: reminders removed anywhere; test `:43-50` keeps `hi`; `withBotVoice` (`service-host.ts:3603-3613`) prefixes the envelope, so `^\[routine\] "` misses bot routines. | RT21, §31.2: `visibleUserText` ported unchanged for every user message; the routine-run envelope hidden by position (first user message of a `routineId` session); R5-T10 plain and bot-voiced cases. |
| 5 | Major | **Accepted** | `packages/connectors/src/registry.ts:185`: every platform connector is `abacus-connectors`. | §12.3 tabs gain Abacus.AI; Featured includes `onboarding` platform connectors; `CONNECTOR_CATEGORY_TABS`, LB4; R5-T17 reachability without search. |
| 6 | Major | **Accepted** | `messaging-connectors.tsx:153-169`: gateway enabled first, then the platform. | §12.4 item 6 `connectPlatform` sequence awaited before pairing; §13.3 "Enable first" and the shared-link start; R5-T18 with `gatewayEnabled:false`. |
| 7 | Major | **Accepted** | `main/rpc/procedures/files.ts:13-20`: `not-found` → `NOT_FOUND`, `outside-root` → `FORBIDDEN`, others (incl. `not-a-file`) → `CONFLICT {reason}`. | §11.2 branches on the thrown typed errors, with the `openPath` fallback; R5-T15 through the real router. |
| 8 | Major | **Accepted** | F5 promised `RoutineRow.botId` provenance; r1 §10.3 gave routine runs only the routine source. | §10.3 splits provenance (`botIds`, `routine`, `workspaceId`) from the display label; a check-in run's artifact matches its bot and Routines; R5-T14. |
| 9 | Major | **Accepted** | `artifacts-panel.tsx:220-232` searches the session label. | §10.3 `q` covers the session label independently; AR3; R5-T14. |
| 10 | Major | **Accepted** | `chat-panel.tsx:751-770` seeds `/` from `skills.listInstalled` before an agent exists. | §15 keeps a query-backed disk baseline invalidated by skill mutations; §31.2 the kit prefers `skills.loaded` once it arrives; R5-T21. |
| 11 | Major | **Accepted** | `update-service.ts:178-189` clears `checking`, `downloading` and `progress` on every error. | §21.4 row reads `failedPhase`; §31.5 h adds it to `UpdateStatus`, set from the pre-error state; R5-T27, R5-T28. |
| 12 | Major | **Accepted** | `models-panel.tsx:294-305` offers Remove for any stored key, Abacus and OpenRouter included. | §20.4 connect-provider dialogs offer Remove for a stored credential; ST11; R5-T23. |
| 13 | Major | **Accepted** | `local-model-dialog.tsx:54-64` adopts `localModelReference(id)` via `onReady`; opened from `premium-upgrade-card.tsx` and `credits-exhausted-card.tsx`. | §20.5 install-and-use with `?provider=local&for=<thread>`, route-provided `adoptModel` per thread kind, return to the thread; `ModelsSearch.for`; ST12; §31.2; R5-T23. |
| 14 | Major | **Accepted** | 04 §11.4 "Dock chords reach the dock" registers `Mod+W`, `Ctrl+Tab`, `Ctrl+Shift+Tab` and keeps `Ctrl+Shift+W` for terminals on Windows/Linux. | `APP_ACTIONS` gains `close-tab` (with `terminalBinding`), `next-tab`, `previous-tab`; terminal dispatch by action id against resolved bindings; `Mod+W` no longer reserved; §31.1, §31.4 (04 r3 names the dispatcher); R5-T25, R4-T39 extension. |
| 15 | Major | **Accepted** | `@tanstack/hotkeys/dist/conflicts.d.ts:5-11` returns hotkey or sequence registrations; `HotkeyMeta` exists in `hotkey.types`. | §21.3: registrations carry `meta.actionId`; all registrations of the edited action excluded; Use anyway only for rebindable mapped actions, Cancel only otherwise; R5-T25 fixed and sequence conflicts. |
| 16 | Major | **Accepted** | `main/services/config/settings.ts:215-222` reads `notificationSoundDisabled` as the sound opt-out. | §22.1 note; §31.5 i legacy import into `sounds.enabled` (provenance-respecting, step and live sync); ST13; R5-T28 upgrade case. |
| 17 | Major | **Accepted** | spec 00 B.3: snapshot rows are written as inserts, resync truncates and re-inserts. | §23.1 and §9.4: `routine-fired` from `routines.events run-started` (no snapshot), deduped by `attemptId`; §31.5 j; R5-T26 hydration and resync play nothing. |
| 18 | Minor | **Accepted** | `cron-store.ts:237` `nextRun(expression: string, from: Date)`. | §8.3 calls `nextRun(expr, now)` after `parseCron` validates; signature unchanged by the move. |
| 19 | Minor | **Accepted** | Incremental mounting never unmounts; `content-visibility` keeps nodes in the DOM. | §10.5 bounded 400-card window with evicting spacers and anchor preservation; fallback is lowering the budget; §3, §32.1, §32.2, R5-T31. |

**Consistency pass (r2).** r1 mechanisms that no longer apply (routine-fired from table inserts, `progress`-based update failure, the `^[routine]` leading-message hide, runs from `routineRuns` alone, incremental mounting, `nextRun(parseCron(…))`, `Mod+W` as reserved, routine artifacts under the routine source only) appear only in this table.

