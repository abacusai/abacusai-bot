# 03 — Bots (phase 3)

Status: draft spec **r2**. r1 was reviewed by Codex (`reviews/03-bots.codex-r1.md`, 21 items); responses at the end. Branch `rewrite/renderer`. It implements the "Bots" phase of `docs/rewrite/PLAN.md` (§Areas and parity "Bots", §Route tree, §Motion system, §Sound, §Phases 3, and the Amendments), on top of:

- `00-transport-db-migration.md` **r2** with its implementation notes: sub-slice A (the contract, `bots.*`, `memory.*`, `messaging.*`, `models.*`), sub-slice B (the `bots`, `sessions`, `routines`, `memories`, `artifacts`, `prefs` tables and `ipcCollectionOptions`), sub-slice C (prefs provenance, the legacy sync);
- `00-agent-agui.md` **r3**: §4 (bot loop: hidden turns never reach AG-UI, sanitised text, no `bot.reply`), §5 (main's relay needs), §3.5 (permissions);
- `01-renderer-foundation.md` **r4**: folder layout and import rules (§4), `#next/*` (§3.3), routes, masks, `PANE_BOUNDARIES` and navigation types (§6), shell bands, sidebar slot, title bar and side panel (§7), the per-bot accent rule (§5.3), motion presets (§7.8), sound gating (§7.8), hotkeys (§7.9), registry rules (§5), gallery and screenshots (§10), test conventions (§11);
- `02-chat-kit.md` **r3**: `ChatView` with `skin: "bot"`, the composer and its `ModelChip`, the permission cards, the gallery sections (§2, §5, §6, §8, §9, §11).

Paths are relative to `apps/desktop/` unless noted. Code in this spec is type declarations and short sketches only.

**Sources read for this spec** (versions are what is installed or pinned, checked on 30 Sep 2026):

| Source | Version / commit | Where |
|---|---|---|
| Old renderer, bots | `HEAD 448b2bdf` | `src/renderer/router.tsx:185-320`, `components/bots/*` (`bots-tree.tsx`, `bots-home.tsx`, `new-bot-dialog.tsx`, `bot-dialog.tsx`, `bot-avatar.tsx`, `bot-avatar-picker.tsx`, `bot-templates.ts`), `components/chat/{chat-panel,bot-message-list,chat-composer,model-picker,feedback-row}.tsx`, `components/routines/{routines-tree,routine-page}.tsx`, `components/settings/{memory-panel,messaging-connectors,routine-schedule}.ts(x)`, `components/onboarding/first-bot-dialog.tsx`, `hooks/use-bots.ts`, `stores/{code-store,sidebar-accordion-store}.ts`, `locales/en-US.json` (`bots.*`), and their tests |
| Shared and main | same | `shared/bots.ts`, `shared/contracts.ts:298-370,461-474,1136-1160`, `shared/routines.ts`, `shared/models.ts`, `shared/messaging.ts:132-190`, `main/services/bots/{bot-store,bot-service,bot-memory-store,bot-chat-preview}.ts`, `main/service-host.ts:1079-1140,2186-2310,2449-2472`, `main/services/messaging/messaging-gateway-service.ts`, `main/rpc/{procedures,tables}/*`, `main/rpc/errors.ts:62-80` |
| Contract (implemented) | same | `shared/contract/{bots,memory,messaging,models,routines,db,rows,ids,agent,ai,settings,connectors}.ts` |
| renderer-next (implemented) | same | `src/renderer-next/data/db/{index,tables,ipc-collection-options}.ts`, `data/transport/*` (nothing else exists yet) |
| `@tanstack/react-form` / `form-core` | 1.33.5 installed (repo-root `node_modules`) | `form-core/dist/esm/{FormApi,FieldApi,ValidationLogic,standardSchemaValidator}.d.ts`, `react-form/dist/esm/{index,createFormHook}.d.ts` |
| `valibot` | 1.5.0 installed | `valibot/dist/index.d.mts` (`~standard`) |
| `@tanstack/db` / `@tanstack/react-db` | 0.9.2 / 0.4.1 installed | `db/dist/esm/{collection/index,transactions,types,query/builder/index,optimistic-action}.d.ts`, `react-db/dist/esm/useLiveQuery.d.ts` |
| `motion` | **not installed**; foundation pins 13.4.6 (re-exports `framer-motion ^13.4.6`) | APIs checked against the installed `framer-motion` 12.43.0 / `motion-dom` 12.43.0 typings |
| `@tanstack/react-router` | 1.170.31 installed; foundation pins 1.170.40 | clone `scratchpad/refs/router` (1.170.40): `router-core/src/route.ts:1494,1514`, `docs/router/routing/routing-concepts.md:527-548` |
| shadcn registry | clone `refs/ui` HEAD `10cd7f0` | `apps/v4/registry/bases/base/ui/{field,toggle-group,context-menu,dropdown-menu,alert-dialog,popover,combobox,tabs,input,textarea}.tsx` |
| Design canvas | artifact `XpL2PgWae6rUjXDTWyUqYX`, version `1790747894-aeaf` | page 2 "Bots" (`BotsEmpty`, `BotNew`, `BotCreate`, `BotDetails`, `BotStates`, `BotApproval`, `BotChannel`, `BotCall`, `BotChatPanel`), page 1 (`BotChat`, `BotChatScrolled`), page 4 (`ComposerStates`, `Pickers`, `ReadOnlyStates`), page 6 (`WidthRules`, `BW1000`, `BW800`), page 7 (`SettingsMemory`, `SettingsMessaging`), page 8 parts (`BotsSidebar`, `BotAvatar`, `Avatars`, `ConnectorIcon`), page 11 (`OnboardFirstBot`) |
| Reviews | all 17 files | `docs/rewrite/specs/reviews/*` (defect classes applied in §25) |

---

## 0. Findings that change the brief (read first)

Each was checked against source. The ones that change another spec are repeated in §24.

| # | Brief / plan / earlier spec says | Verified fact | Consequence here |
|---|---|---|---|
| F1 | "TanStack Form if the plan allows" | PLAN's stack table lists `@tanstack/react-form` (L66). 1.33.5 is installed (`apps/desktop/package.json:94`). Form and field validators accept any Standard Schema (`FormValidateOrFn<T> = FormValidateFn<T> \| StandardSchemaV1<T, unknown>`, `form-core/dist/esm/FormApi.d.ts:20`), and valibot 1.5.0 objects carry `~standard` (`valibot/dist/index.d.mts`). `createFormHook` / `createFormHookContexts` exist (`react-form/dist/esm/createFormHook.d.ts:39,70`), as does `revalidateLogic({ mode, modeAfterSubmission })` (`form-core/dist/esm/ValidationLogic.d.ts:52`). `react-form` depends on `@tanstack/react-store ^0.11.0` (the app's store major). | The bot form is TanStack Form with valibot schemas passed directly, through one `createFormHook` whose field components wrap registry `Field` parts (§9). No adapter package. |
| F2 | PLAN route tree: `bots.$botId.details.tsx` a masked pop-up, `bots.$botId.edit.tsx` a page | The canvas draws Details as a **panel beside the chat** (BotDetails: a 320 px pane with a close button; BotStates: the same pane with Details / Memory / Files tabs), and WidthRules says "Details and side panel open as sheets" only at 800–899, which the foundation's side-panel drawer already does. Foundation's `BotSearch.tab` already includes `details`, `memory`, `files`. A file `bots.$botId.edit.tsx` is a **child** of `bots.$botId.tsx` (flat-route nesting), so the editor would render inside the chat's `<Outlet/>`. | Details, Memory and Files are **side-panel tabs** (`?tab=`). `/bots/$botId/details` becomes a redirect to `?tab=details` (deep links keep working) and loses its mask. The one masked pop-up is the **check-in editor** `/bots/$botId/check-in` (§5.4). The editor and sender-chat pages are **un-nested** routes (`bots.$botId_.edit.tsx`, `bots.$botId_.chats.$sessionId.tsx`; trailing `_` un-nests, `routing-concepts.md:527-548`). Foundation §6.1, §6.6 and `PANE_BOUNDARIES` are amended (§24.1). |
| F3 | "check-ins scheduling UI" | There is no check-in concept in main or the contract. A check-in is a routine with `botId === bot.id && prompt === CHECK_IN_PROMPT` (exact text, `renderer/components/bots/new-bot-dialog.tsx:67-73,88-96`); `Routine.botId` is "provenance, not a target" (`shared/routines.ts:26-27`). Deleting a bot **does not** delete its routines: main clears their `botId` (`service-host.ts:1116-1137`). | The check-in is found by the same exact-prompt rule, with the prompt moved to `shared/bots/check-in.ts` so both renderers and a test share one string (§10). Deleting a bot keeps today's behaviour; the confirm text says the check-in stops being linked (it keeps running as an ordinary routine, visible in Routines). |
| F4 | Plan: "per-bot model both in Details and as a composer chip" | Today the chat's model picker in a bot chat writes the **session** model and the global default, never `bot.model` (`chat-panel.tsx:1999-2048`); `bot.model` is set only in the dialog. Main pins a bot session's model at `openChat` to `bot.model \|\| default` and, on `update`, re-pins **only** the forever session and **only** for a non-null model (`bot-service.ts:250-262`); a reused sender session returns before any re-pin (`bot-service.ts:360-400`). So resetting to App default leaves a stale explicit pin. | Intended behaviour change (PLAN decision "Bot model"): both surfaces edit `bot.model`. **Main** owns the effective model: on every model change (null included) it re-pins every session of the bot to `bot.model ?? default` and applies it live to running ones; reused sender sessions re-pin too (§13.4, §24.10). The renderer only writes the row. The global default is no longer written from a bot chat. |
| F5 | "dicebear/uuid/lobehub icons nuked (own avatar scheme)" | Today's `Bot.avatarShape` ids are `cone, pebble, cloud, tablet, squircle, drop, pill, blob` and `avatarColor` is one of ten Tailwind-500 swatches (`shared/bots.ts:88-112`). The canvas scheme is 24 shapes, 18 moods, 8 accessories and ten Tailwind-400 colours (`Avatars`, `BotAvatar`, `BotCreate`). Main never validates shape or colour (`bot-store.ts:88-121`); the old renderer maps unknown shapes to `blob` (`bot-avatar.tsx:27-43`) and takes any hex. | New shape and colour ids can be written without breaking the old renderer. Legacy values are **mapped at render time** (disk unchanged, PLAN migration row "Bots"): a fixed table, not a nearest-colour search (§14.3). A new optional `avatarAccessory` field is added to `Bot` (additive, main normalises a missing value to `"none"`; §24.3). |
| F6 | Foundation §5.3: `accentForeground` picks `#171717` or `#fafafa` by WCAG ratio, tested over `BOT_AVATAR_COLORS` | With the canvas palette the dark foreground wins for every swatch, 6.01:1 (`#818cf8`) to 11.71:1 (`#facc15`); the light one never passes (1.47–2.86:1). **On a light theme background (`#ffffff`) every swatch is below 3:1** (1.53–2.98:1). | The accent is never used as text or as the only boundary of a control on the page background: text on the accent uses `accentForeground`; accent dots and rings get a 1 px `--foreground`/15% outline in light theme; speaker labels use `--foreground` (§14.5). R3-T8 computes every pair. |
| F7 | PLAN motion: "Bot avatar transcript → title bar: React `<ViewTransition name>`, 420 ms" | The dock happens on **scroll** (BotChat → BotChatScrolled). A view transition freezes the old and new snapshots for its duration, so a scroll-triggered 420 ms transition would freeze the transcript under the user's scroll. React only runs view transitions for updates inside `startTransition`. | The scroll dock is a 160 ms opacity/translate fade of the title-bar identity (motion, no view transition). The shared element `bot-identity-{botId}` is used on the two **navigations** where both ends mount in one commit: setup → new chat, and editor → chat (§16.2). PLAN amendment (§24.6). |
| F8 | "messaging channel views (reply extraction stays in main)" | Sender chats (one session per bot × platform chat, owner `{kind:"bot", role:"sender"}`) are **not** in today's bots list; they appear in the Routines tree as auto-reply rows at `/routines/chat:<sessionId>` (`routines-tree.tsx:37-61,118-128`). Self-lane channel bots (`bot.channel != null`) are read-only windows (`chat-panel.tsx:846-851,2239-2251`). Reply extraction is the gateway's `<reply>` / `NO_REPLY` handling (`messaging-gateway-service.ts:94-105,1156`). | Phase 3 owns one sender-chat view, `/bots/$botId/chats/$sessionId`, reached from the bot's Details panel; phase 5's Routines auto-reply rows link to the same route (§11.5, §24.8). Nothing in the renderer parses `<reply>`. |
| F9 | Plan: `bots.openChat` echoes, loaders preload by intent | `openChat` has side effects: it may create the forever session, start the agent and, the first time a bot is ever opened, send the `[first run]` kickstart (`bot-service.ts:295-353`). The router calls loaders on hover with `preload: true` (`router-core/src/route.ts:1494`, `cause: 'preload' \| 'enter' \| 'stay'` at `:1514`) because `defaultPreload: "intent"` (foundation §6.4). | The bot route's loader never calls `openChat` when `preload` is true (§5.3). R3-T3 hovers a never-opened bot and asserts no `openChat` call. |
| F10 | "conflict handling" | Most bot failures reach the renderer as `INTERNAL_SERVER_ERROR`: empty name or description, the 50-bot limit, editing or deleting a channel bot, and `openChat` on an unknown id are plain `Error`s (`bot-store.ts:88-144`, `service-host.ts:2294-2307`, `main/rpc/errors.ts:62-80`). Only a taken id (`CONFLICT`) and update/delete of a missing id (`NOT_FOUND {entity:"bot"}`) are typed. | The renderer prevents each of those cases before calling (§6.5), and main maps them to typed codes (§24.4: `PRECONDITION_FAILED {reason:"bot-limit"}`, `FORBIDDEN {reason:"channel-bot"}`, `BAD_REQUEST`, `NOT_FOUND`). The UI never parses error messages. |
| F11 | Plan: "memory/files panels" | `MemoryRow` carries only the entry text (`rows.ts:65-80`); the canvas sub-lines ("from chat · today", "you told it · last week") have no data behind them. `BotMemoryView.noteDays` exists (`shared/contracts.ts:1148`). Files: `SessionArtifact` rows carry `sessionId` (`contracts.ts:480-493`), and a bot's sessions are known from `SessionRow.owner.botId` (`contracts.ts:331-369`). | Memory rows show the entry only, plus "Also keeps {n} days of notes" from `memory.bots`. Files lists artifacts of every session owned by the bot. The provenance sub-line is deferred (§25.3). |
| F12 | Canvas: Call button, BotCall board | There is no call transport, text-to-speech or call procedure anywhere (contract `voice.*` is Whisper download and microphone permission only; `PARITY.md` rows 180-182). The old renderer has no call view. | No Call button or route in phase 3 (§25.3). The title-bar actions list reserves the slot. |
| F13 | Chat kit §1.2: the kit leaves bot and session routes, identity and side-panel tabs to phases 3–4 | Today's bot transcript (`bot-message-list.tsx`) has behaviours the kit's `BotMessage` does not specify: per-message feedback (`feedback-row.tsx`), duplicate-emoji reply suppression and the reaction badge, dropping silent turns, the deliverables card, 15-minute time stamps. | These are listed as parity rows owned by this phase and implemented as a `BotMessage` amendment inside `features/chat` (§11.3, §24.2). |
| F14 | Foundation §4: collections under `data/collections/` | The implemented data layer is `src/renderer-next/data/db/` with singletons `botsCollection`, `sessionsCollection`, `routinesCollection`, `memoriesCollection`, `artifactsCollection`, `prefsCollection` in `data/db/index.ts`. `botsCollectionOptions` sends `BOT_CREATE_FIELDS`/`BOT_UPDATE_FIELDS` only (`data/db/tables.ts:90-117`). | This spec imports from `#next/data/db`. Adding `avatarAccessory` means adding it to both field lists (§24.3). |
| F15 | "one sidebar per rail item (Slack-style)" | The old sidebar is one accordion of Bots / Routines / Sessions (`sidebar-accordion-store.ts:6-33`). | Retired. The bots sidebar lists bots only (§7). |

---

## 1. Scope

### 1.1 In scope

- **Routes** under `/bots` (§5): the start page and its setup step, the forever chat with Details / Memory / Files side-panel tabs, the check-in editor as a masked pop-up, the bot editor page, and the sender-chat view; loaders, search schemas, masks, pane boundaries, navigation types, not-found and deleted-while-open behaviour.
- **Data** (§6): the collections and queries the area reads, every mutation with its optimistic row, echo and failure path, the ephemeral unread store, and one pure attention function behind the avatar mood, the sidebar badge and the needs-you group.
- **The bots sidebar** (§7) with search, pinned and needs-you groups, row states, row menu and the 88 px strip.
- **Create and edit** (§8, §9): the start page with templates, the setup form, the editor, validation with valibot through TanStack Form, and the submit pipeline including the check-in routine and `bots.announceChange`.
- **Check-ins** (§10), the **chat route composition** (§11), the **side panel** (§12), the **model picker** (§13), **BotAvatar and the accent** (§14), **connector marks** (§15), **motion** (§16), **sound cue synthesis** (§17), **i18n** (§18), **a11y** (§19), **gallery** (§20), **tests** (§21), **acceptance** (§23).

### 1.2 Out of scope

Onboarding's first-bot hatch and the tour (phase 6; §5.6 exposes what it needs), the notch (phase 6), Settings › Memory and Settings › Messaging pages (phase 5; they reuse §12.2's list), the Routines auto-reply rows (phase 5; they link to §11.5), sessions (phase 4), per-bot sound levels (phase 5 with Notifications), and everything in §25.3 (Call, restore a deleted bot, check-in "pause until", hide from sidebar, disconnected-connector banner, memory provenance, the setup greeting preview).

### 1.3 Gate (PLAN phase 3)

Parity rows for `bots.*` and bot memory are green (§2), and before/after screenshots of every bots board at the foundation widths and both themes are attached to the PR (§23).

---

## 2. Parity table

Every behaviour of today's bots area, where it lands, and its status. "New" rows are canvas behaviours that did not exist; "Changed" rows are intended changes with their decision owner; "Retired" rows have a reason. The table is also `features/bots/parity.ts` as data, which R3-T30 checks: every row names an existing route/component/test.

### 2.1 Navigation and routes

| # | Today (file:line) | New route / component | Status |
|---|---|---|---|
| P1 | `/bots/new` renders `BotsHome` in `ChatPanel` with pane intent "bot" (`router.tsx:233-247`, `chat-panel.tsx:1948-1949`) | `/bots/new` → `BotStartPage` (§8.1) | Parity |
| P2 | `/bots/$botId` opens the forever chat: `openBotChat` once per bot, then activates the session, switches workspace (`router.tsx:249-292`, `:185-193`) | `/bots/$botId` loader: `openChatOnce` + `session.load()` (§5.3); no active-workspace switch (routes carry ids, PLAN "no state in two places") | Parity; workspace switch retired (PLAN) |
| P3 | Spinner while the bot list loads (`router.tsx:290,316-320`) | route `pendingComponent`: transcript skeleton (foundation `defaultPendingMs` 150) | Parity |
| P4 | `openBotChat` failure logged, no UI (`router.tsx:278-281`) | route `errorComponent` "Couldn't open {name}" + Retry (§5.3) | Changed (gap fix) |
| P5 | `/bots/$botId/edit` renders the dialog over the chat; close → `/bots/$botId` (`router.tsx:255-259,294-314`) | `/bots/$botId/edit` full page `BotEditorPage` (§9) | Changed (PLAN route tree) |
| P6 | Deleting the open bot leaves the route on a null bot; the title bar says "New bot" (`use-bots.ts:113-130`, `titlebar.tsx:245-251`) | delete navigates first, then deletes; a bot deleted elsewhere while open → `notFound` → "This bot was deleted" with a link to `/bots/new` (§5.5) | Changed (gap fix) |
| P7 | Sidebar route parsing `/(bots\|sessions\|routines)/<id>(/edit)?` for the active row (`lib/sidebar-conversation-route.ts:9-33`) | active row from `useParams({ strict: false }).botId` | Parity |
| P8 | Sidebar auto-reveals the bots section on a bot route (`workspace-sidebar.tsx:57-64`) | one sidebar per rail item; the rail selects Bots (foundation §7.3) | Retired (F15) |
| P9 | Bots-first send: a composer with no session sends to the most recent bot and lands on `/sessions/$id` (`chat-panel.tsx:630-657,1280-1308`, `workspace-activation.ts:56-65`) | none: the start page has no composer (canvas BotNew) | Retired (canvas) |
| P10 | Title-bar identity click → `/bots/$id/edit` (`titlebar.tsx:252-263`) | identity click → `?tab=details`; "Edit bot" in Details → `/bots/$botId/edit` (§11.2) | Changed (canvas BotDetails) |
| P11 | — | `/bots/$botId/check-in` masked dialog (§5.4); `/bots/$botId/details` redirect (F2) | New |
| P12 | Auto-reply sender chat page at `/routines/chat:<sessionId>` (`routines-tree.tsx:37-41,118-128`, `routine-page.tsx:381-493`) | `/bots/$botId/chats/$sessionId` `SenderChatPage` (§11.5); Routines rows link here in phase 5 | Changed (F8) |

### 2.2 Sidebar

| # | Today | New | Status |
|---|---|---|---|
| P13 | Flat list, header "Bots" + count + `+` (`bots-tree.tsx:157-173`) | header "Bots" + Search + New (canvas BotsSidebar); no count | Parity; count retired (canvas) |
| P14 | Order `updatedAt` desc; "Pinned" group first, collapsible (`bots-tree.tsx:80-93,202-214`) | Needs you → Pinned → rest; rest ordered by last activity `preview.at ?? updatedAt` desc (§7.2) | Changed (needs-you group, PLAN) |
| P15 | Empty: "No bots yet" + description + New bot (`bots-tree.tsx:181-199`) | canvas BotsEmpty sidebar: asleep avatar + "No bots yet" + "Make one for a job you hand off often." (§7.6) | Parity |
| P16 | Row: 24 px avatar, name + stamp, preview (fallback `bot.title`), pin icon, unread dot (`bots-tree.tsx:304-382`) | 56 px row, 36 px avatar with mood, name + stamp, preview (fallback `bot.title`), unread dot; pin shown by group (§7.3) | Parity (canvas geometry) |
| P17 | Stamp rule: time today → "Yesterday" → weekday within 6 days → short date (+ year) (`session-list-utils.ts:209-230`); re-render every 60 s (`bots-tree.tsx:74-79`) | `chatStamp` ported verbatim to `lib/format/chat-stamp.ts` with its test; one 60 s clock for the sidebar | Parity |
| P18 | Working = forever session `isBusy`, shown only as avatar animation (`bots-tree.tsx:333-335`) | mood `working` + preview replaced by "Working" / the running tool title (§6.6, §7.3) | Parity + canvas |
| P19 | Unread = forever session completed in the background, cleared on open, not persisted (`code-store.ts`, `use-workspace-refresh.ts:342-347`, `router.tsx:189`) | `botsUnreadStore` (TanStack Store), same rule over every bot-owned session (§6.7) | Parity |
| P20 | Active row highlighted and scrolled into view (`bots-tree.tsx:133,336`) | same (`scrollIntoView({ block: "nearest" })` on route change) | Parity |
| P21 | Context menu: Pin/Unpin, Edit (non-channel), Delete (non-channel) (`bots-tree.tsx:384-407`) | row menu (context menu **and** a ⋯ button, one item list): Pin/Unpin, Mark as unread, Edit bot, Duplicate, Pause/Resume check-ins, Delete bot; channel bots show Pin and Mark as unread only (§7.4) | Parity + New (Mark as unread, Duplicate, Pause) |
| P22 | Hover ⋮ menu shows Edit/Delete for channel bots too (`bots-tree.tsx:410-453`) | one item list for both menus (§7.4) | Changed (bug fix) |
| P23 | Edit from the sidebar opens the dialog in place (`bots-tree.tsx:135,222-226`) | navigates to `/bots/$botId/edit` | Changed (PLAN) |
| P24 | Delete confirm: "Delete bot" / "This deletes {{name}} and its chat. This cannot be undone." / Cancel / Delete; inline `deleteError` (`bots-tree.tsx:228-260`) | registry `AlertDialog`, same copy plus the check-in sentence when one exists (F3); inline error (§7.5) | Parity |
| P25 | Pinned ids in zustand `local-code-ui-store.pinnedBotIds` (`code-store.ts:32,91-92,373-382`) | `prefs.pinned.botIds` (spec 00 C.4 already imports it) | Parity |
| P26 | Sidebar folds to its header when another section opens (`bots-tree.test.tsx:79-117`) | — | Retired (F15) |
| P27 | — | Search field filtering by name and title (canvas BotsSidebar) | New |
| P28 | — | 88 px strip at 800–899 (foundation §7.1; canvas BW800) with mood, unread dot, name tooltip | Parity with foundation |

### 2.3 Create, edit, templates

| # | Today | New | Status |
|---|---|---|---|
| P29 | Start page: 64 px avatar following the typed name, heading, name input (max 30, autofocus when no bots, Enter → dialog), "Create Bot" (`bots-home.tsx:149-249`) | `BotStartPage`: 96 px avatar (canvas BotNew), shape strip, name pill with arrow; Enter or arrow → setup step (§8.1) | Parity (canvas geometry) |
| P30 | Templates: 8 category tabs, grid of cards (icon tile, name, 3-line description), click → prefilled dialog (`bots-home.tsx:254-333`) | same 8 categories (4 visible + More, canvas), 3-column cards with avatar, name, description, connector marks (§8.2) | Parity + New (marks) |
| P31 | Connected connectors promote their template within its tab (`bot-templates.ts:49-55,872-883`, `bots-home.tsx:156-163`) | same rule over `connectors.statuses` (§8.2) | Parity |
| P32 | 44 templates, English persona/mission, localized card copy (`bot-templates.ts:31-57+`) | moved to `shared/bots/templates.ts` unchanged; old file re-exports (§24.9) | Parity |
| P33 | One dialog for create, edit, first bot (`new-bot-dialog.tsx`) | `BotForm` in the setup step and the editor page (§9) | Parity |
| P34 | Fields: Name (req, 30), Persona (1000), Instructions (mission; no UI max), More options: Description (role), Check-ins (Off/Hourly/Daily/Weekdays/Weekly + day + time), Model (App default + configured) (`new-bot-dialog.tsx:364-515`) | Name, Persona, Instructions, Description, Checks in, At / On, Model — all visible, canvas BotCreate order; Instructions max 4,000 enforced (§9.2) | Parity; max added (gap fix) |
| P35 | Only validation: empty name → `bots.nameRequired` (`new-bot-dialog.tsx:259-260`) | valibot schema, all limits, inline errors on blur then on change after first submit (§9.3) | Changed (gap fix) |
| P36 | Empty instructions → `NAME_ONLY_MISSION` (`new-bot-dialog.tsx:56-62,280,293`) | same constant, moved to `shared/bots/check-in.ts` beside the check-in prompt (§9.4) | Parity |
| P37 | Look fallback: picked → bot's → template's → initial → name hash (`new-bot-dialog.tsx:185-193,236-243`); **the name becomes the template's translated name when a template is picked** (`new-bot-dialog.tsx:195-205`) | same order with the new scheme's name hash; picking a template replaces the typed name with `t("bots.templates.<id>.name")` (§8.2) | Parity |
| P38 | Avatar picker popover: 8 shapes, 10 colours, `aria-pressed` (`bot-avatar-picker.tsx:22-112`) | setup column: shape grid (8 + More → 24), 10 colours, accessories (canvas BotCreate) (§9.2) | Parity + New (accessory) |
| P39 | Create → `/bots/$id` (`chat-panel.tsx:2068-2071`) | create → `/bots/$id` with `nav-forward` and the identity morph (§16.2) | Parity |
| P40 | Check-in on create → `createRoutine({name:"{{name}} check-in", prompt: CHECK_IN_PROMPT, schedule, botId})`; failure → toast, bot kept (`new-bot-dialog.tsx:303-333`) | same, through `routinesCollection` (§10.3) | Parity |
| P41 | Edit: check-in read back by `decomposeCron`; a custom cron shows Off and is left alone; changed only if touched and different; off → remove, existing → update `{schedule, enabled:true}`, none → create (`new-bot-dialog.tsx:216-230,304-327`) | same rules; a custom cron shows "Custom schedule" with a link to the routine instead of Off (§10.2) | Parity; custom display changed (gap fix, value still untouched) |
| P42 | `announceBotChange` on edit only, once, for mission / persona / check-in (English words) (`new-bot-dialog.tsx:97-115,334-356`) | same, after both writes persisted; `describeCheckIn` copied verbatim (English, model-facing) (§9.5) | Parity |
| P43 | Save errors: `bots.saveError` inline (`new-bot-dialog.tsx:273-299`) | typed errors mapped per §6.5 | Parity |
| P44 | Composer model picker in a bot chat writes the session model + global default (`chat-panel.tsx:1999-2048`) | writes `bot.model`; main re-pins and applies it to every bot session (F4, §24.10) | Changed (PLAN "Bot model") |
| P45 | Tour stop "makeBot" targets `bots-home-name-input` (`tour-stops.ts:35,64-77`) | `data-tour="bots-name-input"` on the name field (phase 6 reads it) | Parity (hook only) |
| P46 | First-bot dialog: auto-create "Chief of Staff" unless an own bot exists; Cancel deletes; Save keeps (`first-bot-dialog.tsx:61-132`) | phase 6; this phase exports `createBotFromTemplate` and `deleteBot` (§5.6) | Deferred to phase 6 |

### 2.4 Chat view

| # | Today | New | Status |
|---|---|---|---|
| P47 | Bot chat: no New chat button, no terminal, inspector without dev actions (`titlebar.tsx:79-80,355`, `workspace-view.tsx:104-123,518`) | bot routes have no terminal/changes tabs; `BotSearch.tab` excludes them (foundation §6.2) | Parity |
| P48 | Mode forced to the Profile default (`settings.defaultMode`, Yolo fallback), never written globally (`chat-panel.tsx:880-884,2309-2322`, `:1222-1240`) | `ChatView composer.fixedMode = defaultMode` sent on every admission; no mode chip (§11.4, §24.2) | Parity |
| P49 | Compact composer: pill, `+` beside the box, no mode picker, no checkout rail (`chat-composer.tsx:2330-2390,2741,2792`) | chat kit bot skin (02 §8.1) | Parity |
| P50 | Placeholder "Message {name}" (`chat-panel.tsx:648-657`) | same key | Parity |
| P51 | `BotMessageList`: tool calls hidden, prose bubbles, user on the other side (`bot-message-list.tsx:73-79`) | chat kit `BotMessage` + "Worked through {n} steps" marker (02 §5.4) | Parity (kit) |
| P52 | Silent turns (nothing said, no deliverables) dropped (`bot-message-list.tsx:262-269`) | `BotMessage` amendment (§11.3) | Parity |
| P53 | Deliverables card: `present_deliverable` results win, else settled user-facing file writes and media artifacts, deduplicated, rejected/unsettled calls excluded, source code and scratch files filtered (`deliverables.ts`); open = read-only preview (files resolved against the workspace, guest `/workspace/…` paths contained by the workspace root) or the in-app browser for URLs; secondary Reveal in folder / Open in browser; 3 visible + show all (`deliverables-pill.tsx:30-110`, `utils/preview-utils.ts:55-170`); `preview-open` from `present_deliverable` opens the preview unasked for in-app types only (`usePreviewOpenBridge`) | `BotMessage` amendment: ported derivation + `DeliverablesCard` + `components/file-preview` (§11.3a) | Parity (URL preview needs phase 4's browser surface, §24.13) |
| P54 | Notifications as muted bubbles with Switch model; credits-exhausted → upgrade card (`bot-message-list.tsx:327-351`) | chat kit `Notice` / `ErrorCard` upgrade variant (02 §5.6) | Parity (kit) |
| P55 | Sub-agent thread header (kind · tools · duration, live timer) (`bot-message-list.tsx:108-184`) | chat kit `SubagentCard` in the bot skin | Parity (kit) |
| P56 | Reaction badge from **successful `react_to_message` results only** (done, not rejected, valid emoji JSON) on the preceding user bubble; an emoji-only reply equal to that reaction is dropped; a trailing emoji-only text of the live turn is held until it is known whether it becomes a badge (`message-reactions.tsx:1-40`, `bot-message-list.tsx:226-257,287-298`) | `BotMessage` amendment porting `agentReactions` and the hold/suppress rule (§11.3) | Parity |
| P57 | Time stamps on the first message and after 15-minute gaps (`bot-message-list.tsx:45-67,373-394`) | `BotMessage` amendment: `gapStamp` rule beside the kit's day separators (§11.3) | Parity |
| P58 | Typing dots in a fixed-height slot (`bot-message-list.tsx:190-202,395-398`) | chat kit `Typing` (02 §5.6) | Parity (kit) |
| P59 | Per-message feedback 👍/👎 + comment, never on the live turn; **offered only when an Abacus.AI account exists** (`chat-panel.tsx:602-610`, `feedback-row.tsx:151-200,345-380`) | `BotMessage` amendment calling `agent.feedback`, gated on `account.abacus` (§11.3); live-message identity via §24.12 | Parity |
| P60 | Channel bot: no composer, banner `bots.channelChatReadOnly{app}` / WhatsApp variant (`chat-panel.tsx:846-851,2239-2251`) | `composer.readOnly` with the same copy, plus "Open {app}" when the platform has a shared link (§11.4) | Parity + New (button) |
| P61 | Sender chat: no composer, `bots.senderChatReadOnly{bot,sender}` (`chat-panel.tsx:2253-2264`); auto-reply page Pause/Resume and Revoke via `decidePairing` (`routine-page.tsx:381-493`) | `SenderChatPage`: same banner, Pause/Resume (disabled without `userId`); Revoke stays with phase 5's Messaging page (§11.5) | Parity; Revoke moves |
| P62 | Routine-run chats read-only (`chat-panel.tsx:2265-2272`) | check-in runs open in the Routines area (phase 5); a bot-owned routine session reached here renders read-only with the routines banner | Parity |
| P63 | Deleted-workspace banner; actionable `ConnectorRequestCard` for the conversation on screen, asks from other conversations flag those conversations (`chat-panel.tsx:2223-2232`, `connector-request-card.tsx`) | `ConnectorRequestCard` (`components/connector-request-card`) in the bot chat's banner slot over `connectors.events`/`requests`/`respond` (§11.4); other bots' asks raise their needs-you attention (§6.6) | Parity |
| P64 | Approvals via the composer's pending permission (`chat-panel.tsx:2340`) | chat kit bot skin: inline card at the tool, others in `PermissionList` (02 §6.2) | Changed (canvas BotApproval, 02) |
| P65 | "remember this" toast `memory.rememberedToast` (`chat-panel.tsx:1277-1278`) | chat kit composer (unchanged key) | Parity (kit) |

### 2.5 Memory, model, avatar

| # | Today | New | Status |
|---|---|---|---|
| P66 | Bot memory only in Settings › Memory: per bot count, entries, forget one, "Clear" with confirm, notes line, empty line (`memory-panel.tsx:148-283`) | Memory tab in the bot's side panel with the same actions (§12.2); Settings › Memory in phase 5 reuses the list molecule | Parity + New (entry point) |
| P67 | Forget one entry by `{botId,index,entry}`; error → refetch (`memory-panel.tsx:164-170`) | `memoriesCollection.delete(id)` with the original row and `occurrences`; `CONFLICT` → rollback + toast (§6.4) | Parity |
| P68 | Clear confirm "Forget everything here?" (`memory-panel.tsx:172-179,251-280`) | same copy, `memory.clearBot` (§12.2) | Parity |
| P69 | Model select: "App default" + configured models (`new-bot-dialog.tsx:491-513`) | model picker with App default first (§13) | Parity |
| P70 | Composer model picker: configured only, provider groups (abacus/openllm, openrouter, gemini, alphabetical), favourites, search, Connect OpenRouter / Google AI Studio rows, provider links to `/settings/models?provider=` (`model-picker.tsx:38-236`) | same groups and rows as `ModelGroup[]` for the kit's picker shell (§13.1) | Parity |
| P71 | DiceBear avatar, 8 shapes, `active` animation (`bot-avatar.tsx`) | `BotAvatar` (24 shapes, 18 moods, 8 accessories) (§14) | Changed (PLAN "Nuked") |
| P72 | — | Files tab (artifacts of the bot's sessions) (§12.3) | New |
| P73 | — | Needs-you group and badge (§7.2) | New (PLAN) |

---

## 3. Dependencies

No new packages. Everything below is already a dependency of the desktop app or pinned by an earlier phase.

| Package | Version | Used for | Verified |
|---|---|---|---|
| `@tanstack/react-form` | 1.33.5 (installed) | `createFormHook`, `useAppForm`, `revalidateLogic`, Standard Schema validators | F1 |
| `valibot` | 1.5.0 (installed) | form schemas, search schemas | `~standard` in `dist/index.d.mts` |
| `@tanstack/db`, `@tanstack/react-db` | 0.9.2 / 0.4.1 (installed) | `insert` returns a `Transaction` (`collection/index.d.ts:358`) whose `isPersisted.promise` settles after the handler (`transactions.d.ts:90`); `useLiveQuery` (`useLiveQuery.d.ts:107`); `findOne` (`query/builder/index.d.ts:376`); `leftJoin` (`:114`) | typings |
| `motion` | 13.4.6 (foundation §3.1; not installed yet) | `motion.*`, `layoutId`, `LayoutGroup`, `AnimatePresence`, `useReducedMotion` | **Unverified for 13.4.6.** Present in the installed `framer-motion` 12.43.0: `LayoutGroup` (`framer-motion/dist/index.d.ts:206`), `useReducedMotion` (`:1283`), `layoutId?: string` (`motion-dom/dist/index.d.ts:919`). R3-T27 type-checks against the pinned package. |
| `react` | 19.3.x (foundation) | `ViewTransition` `name`/`share`, `addTransitionType` | foundation §3.1; installed is 19.2.8 until the foundation bump |
| `@tanstack/react-router` | 1.170.40 (foundation) | loader `preload`/`cause` (`route.ts:1494,1514`), un-nested routes (`routing-concepts.md:527-548`), masks | clone |
| `@tanstack/react-query` + `@orpc/tanstack-query` | foundation | `bots.chatPreviews`, `bots.senderChats`, `memory.bots`, `models.list`, `settings.get`, `settings.defaultMode.get`, `messaging.snapshot`, `connectors.statuses` | contract files |
| Registry atoms | foundation §5.2 list | `field`, `input`, `textarea`, `toggle-group`, `tabs`, `popover`, `combobox`, `command`, `dropdown-menu`, `context-menu`, `alert-dialog`, `dialog`, `tooltip`, `item`, `badge`, `skeleton`, `empty`, `spinner`, `kbd`, `toast` | every one is in foundation §5.2's `add` list; no new atom |

`@tanstack/react-form`'s `useSelector`/`useStore` come from `@tanstack/react-store` (`react-form/dist/esm/index.d.ts`); the form never subscribes a whole form state object (selectors only), per the React Compiler rules (foundation §3.4).

---
## 4. Folder shape and public API

```
src/shared/bots/                     (new; pure data and helpers, used by both renderers, main tests and renderer-next)
├─ templates.ts                      BOT_TEMPLATES, BOT_TEMPLATE_CATEGORIES, TEMPLATE_FOR_CONNECTOR, orderedTemplateIds (moved, §24.9)
├─ check-in.ts                       CHECK_IN_PROMPT, NAME_ONLY_MISSION, isCheckInRoutine, describeCheckIn (moved/copied verbatim)
├─ schedule.ts                       ScheduleDraft, composeCron/decomposeCron/composeSchedule (moved from renderer/components/settings/routine-schedule.ts)
└─ avatar.ts                         AVATAR_SHAPES (24), AVATAR_MOODS, AVATAR_ACCESSORIES, AVATAR_PALETTE (10), LEGACY_* maps, resolveLook, defaultLook
src/renderer-next/
├─ components/
│  ├─ bot-avatar/                    BotAvatar, BotAvatarShapes (SVG defs), useBotMood, moods.css (§14)
│  ├─ connector-mark/                ConnectorMark (26 marks, canvas ConnectorIcon) (§15)
│  ├─ bot-memory-list/               BotMemoryList (presentational; phase 5 Settings › Memory reuses it) (§12.2)
│  ├─ connector-request-card/        ConnectorRequestCard (port; sessions reuse it in phase 4) (§11.4)
│  └─ file-preview/                  read-only FilePreview renderers (port of today's preview pane; phase 4's Files tab reuses it) (§11.3a)
├─ features/bots/
│  ├─ index.ts                       the only file routes import (below)
│  ├─ data/                          queries.ts (query options), bot-actions.ts (§6.4), attention.ts (§6.6), unread-store.ts (§6.7), open-chat.ts (§5.3)
│  ├─ sidebar/                       bots-sidebar.tsx bots-strip.tsx bot-row.tsx bot-row-menu.tsx needs-you.tsx search.tsx (§7)
│  ├─ start/                         bot-start-page.tsx templates-grid.tsx shape-strip.tsx (§8)
│  ├─ form/                          form-kit.ts (createFormHook) schema.ts bot-form.tsx look-column.tsx check-in-fields.tsx submit.ts (§9, §10)
│  ├─ chat/                          bot-chat-view.tsx identity.tsx banners.tsx sender-chat-page.tsx (§11)
│  ├─ panel/                         details-tab.tsx memory-tab.tsx files-tab.tsx model-row.tsx reachable-on.tsx (§12)
│  ├─ model/                         model-groups.ts app-default.ts (§13)
│  ├─ check-in/                      check-in-dialog.tsx check-in-summary.ts (§10)
│  ├─ sound/                         bot-cues.ts (§17)
│  ├─ parity.ts                      §2 as data
│  └─ gallery/                       sections.tsx (botsGallerySections, §20)
└─ lib/format/chat-stamp.ts          ported chatStamp (P17)
```

Rules (foundation §4, restated as checks by R3-T29): `features/bots` imports `components/`, `ui/`, `data/`, `lib/`, `#shared/*`, never another feature; `components/*` never import `data/` or a feature (presentational molecules; props in, callbacks out); routes compose `features/bots` and `features/chat` through their `index.ts`.

Public API (`features/bots/index.ts`, named exports only):

```ts
export { BotsSidebar, BotsStrip, BotsNeedsYou } from "./sidebar";               // picked by features/shell/sidebars.ts
export { BotStartPage } from "./start/bot-start-page";
export { BotEditorPage, BotSetupForm } from "./form/bot-form";
export { BotChatView, SenderChatPage } from "./chat";
export { BotSidePanel } from "./panel";                                          // Details | Memory | Files contents
export { CheckInDialog } from "./check-in/check-in-dialog";
export { openChatOnce, botsQueries, createBotFromTemplate, deleteBot } from "./data";
export { botsGallerySections } from "./gallery/sections";
export type { BotAttention } from "./data/attention";
```

`BotChatView` is the bot-specific wrapper around `features/chat`'s `ChatView`, but features cannot import each other: the **route** renders `ChatView` and passes the bot pieces into its slots. `BotChatView` is therefore a set of slot builders, not a component that renders the chat (§11.1).

---

## 5. Routes

### 5.1 Files

Directory form under `src/renderer-next/routes/_shell/(bots)/` (foundation §6.1). Rows marked **(f)** exist as foundation placeholders and are filled here; **(a)** rows amend the foundation (§24.1).

| File | Path | Responsibility |
|---|---|---|
| `bots.tsx` (f) | `/bots` layout | `staticData: { area: "bots", sidebar: "bots" }`; loader: `Promise.all([bots.preload(), routines.preload(), queryClient.ensureQueryData(botsQueries.chatPreviews())])`. `routines` is needed by every row (check-in paused state). **Child loaders do not rely on this one:** the router runs matched loaders concurrently (`refs/router/packages/router-core/src/load-client.ts:1014-1035`, `settleTasks` awaits them with `Promise.all`), so every loader that reads a collection awaits that collection's `preload()` itself (idempotent after the first snapshot). Component: `<LayoutGroup id="bots">` (motion) around `<Outlet/>` so the model morph can cross the pane and the side panel (§16.3). |
| `bots.index.tsx` (f) | `/bots/` | redirect → `/bots/new` (foundation). The rail's "last visited" memory (`shellStore.lastLocationByArea`) sends returning users to their last bot. |
| `bots.new.tsx` (f) | `/bots/new` | `validateSearch: NewBotSearch`; renders `BotStartPage` (`step` absent) or `BotSetupForm` (`step: "setup"`) (§8). No loader beyond the layout's; `connectors.statuses` and `models.list` are `ensureQueryData`'d **only when `step === "setup"` or templates are visible** (`loaderDeps: ({ search }) => ({ step: search.step })`). |
| `bots.$botId.tsx` (f) | `/bots/$botId` | `params.parse: v.parser(v.object({ botId: BotId }))`; `validateSearch: BotSearch` (foundation) ; loader §5.3; `pendingComponent` transcript skeleton; `errorComponent` §5.3; `notFoundComponent` §5.5. Renders chat kit `ChatView` with the bot slots, the side-panel contents, and `<Outlet/>` for the masked check-in dialog. Sets `--bot-accent`/`--bot-accent-foreground` on its root (foundation §5.3). |
| `bots.$botId.check-in.tsx` (a) | `/bots/$botId/check-in` | Masked pop-up (registry `Dialog`) with `CheckInDialog`; mask → `/bots/$botId` keeping params and search. Close/Escape = `history.back()`, or navigate to the mask target when `!router.history.canGoBack()` (foundation §6.6). |
| `bots.$botId.details.tsx` (a) | `/bots/$botId/details` | `beforeLoad: ({ params, search }) => { throw redirect({ to: "/bots/$botId", params, search: { ...search, tab: "details" }, replace: true }) }`. No mask, no component. |
| `bots.$botId_.edit.tsx` (a, was `bots.$botId.edit.tsx`) | `/bots/$botId/edit` | Un-nested from the chat (F2). Loader: `await bots.preload()`, then the bot row or `notFound()`; `routines.preload()`; `ensureQueryData(models.list)`. Renders `BotEditorPage` (§9). A channel bot (`channel != null`) redirects to `/bots/$botId` (edit is refused by main). |
| `bots.$botId_.chats.$sessionId.tsx` (new) | `/bots/$botId/chats/$sessionId` | Un-nested sender-chat view (§11.5). `params.parse` with `BotId` and `SessionId`. Loader: `await Promise.all([bots.preload(), sessions.preload(), routines.preload()])`, then the session row: a **sender** session (`owner?.kind === "bot" && owner.botId === botId && owner.role !== "forever"`) or a **check-in run** (`routineId === checkIn(botId)?.id`, `owner: null`, §6.2), else `notFound()`; then `chat.session(sessionId).load()` (not on `preload`). |

Generated ids (the router-generator decides them; R3-T1 snapshots them and fails if any id below differs): `/_shell/(bots)/bots`, `/_shell/(bots)/bots/new`, `/_shell/(bots)/bots/$botId`, `/_shell/(bots)/bots/$botId/check-in`, `/_shell/(bots)/bots/$botId/details`, `/_shell/(bots)/bots/$botId_/edit`, `/_shell/(bots)/bots/$botId_/chats/$sessionId`. **The two un-nested ids are unverified** (the generator's escaping of `_` in ids is not covered by a clone snapshot I found); `PANE_BOUNDARIES` below is typed `satisfies Partial<Record<keyof FileRoutesById, string>>`, so a wrong id is a type error.

### 5.2 Search schemas (valibot; foundation §6.2 conventions)

```ts
// features/bots/data/search.ts, imported by the route files
export const TemplateId = v.picklist(BOT_TEMPLATES.map((t) => t.id) as [string, ...string[]]);
export const TemplateCategory = v.picklist(BOT_TEMPLATE_CATEGORIES);
export const NewBotSearch = v.object({
  step: v.optional(v.fallback(v.picklist(["setup"]), undefined)),          // absent = start page
  template: v.optional(v.fallback(TemplateId, undefined)),
  category: v.optional(v.fallback(TemplateCategory, "featured"), "featured"),
});
// BotSearch is the foundation's: { tab?: "memory" | "files" | "browser" | "details" }.
```

- The typed name and the picked look are **not** in the URL (a name is free text; a 30-character search param is harmless but a draft would outlive the page). They live in the draft store (§8.3) keyed `"new"`, so Back from the setup step shows the start page with the same name and look.
- `stripSearchParams({ category: "featured" })` on `bots.new`.
- `BotSearch` gains `preview: v.optional(v.fallback(AbsPath, undefined))` for the Files tab's read-only preview (§11.3a; foundation amendment §24.1). Valibot rejects a non-absolute path, so a bad URL simply shows the list.
- `tab=browser` is accepted (foundation schema) but renders nothing until phase 4 gives bots a browser runtime tab; the tab list hides it.

### 5.3 The chat loader (`/bots/$botId`)

```ts
loader: async ({ params, context, preload }) => {
  await context.collections.bots.preload();                           // loaders run concurrently (load-client.ts:1023): never rely on the layout's
  const bot = context.collections.bots.get(params.botId);
  if (bot == null) throw notFound();
  if (preload) return { bot: bot.id, sessionId: bot.sessionId };      // F9: never openChat on hover
  const handle = await openChatOnce(context.transport, bot);           // bots.openChat, deduplicated
  await context.chat.session(handle.sessionId).load();                 // chat kit readiness (02 §3.2)
  return { bot: bot.id, sessionId: handle.sessionId, workspaceId: handle.workspaceId };
}
```

- **`openChatOnce(transport, bot)`** (`features/bots/data/open-chat.ts`): one in-flight promise per `botId` per document; the resolved handle is cached while `bot.sessionId === handle.sessionId` and the session row exists in `sessionsCollection`. A cached handle is returned synchronously on `cause: "stay"` re-runs (search changes such as `tab`), so switching panel tabs never calls `openChat` again. Main also deduplicates concurrent calls (`bot-service.ts:295-353`); the renderer's cache exists to avoid the round trip and the loader wait.
- **After `openChat`** the echo arrives on `db.bots` (sessionId) and `db.sessions` (insert); the component reads both with `useLiveQuery`, never from loader data except the ids.
- **Errors.** `openChat` rejecting renders the route's `errorComponent`: registry `Empty` with the bot's avatar (mood `blocked`), "Couldn't open {name}", the error's `message` in muted text for `INTERNAL_SERVER_ERROR`, and **Retry** (`router.invalidate()`, which clears the `openChatOnce` entry first). `UNAVAILABLE` (agent host not ready) shows "The agent isn't available yet" (chat kit 02 §12.7 copy). `NOT_FOUND` (after §24.4) → §5.5.
- **Mode.** The route passes `composer.fixedMode = settings.defaultMode ?? "YOLO"` (P48) to `ChatView` (§11.4).
- **Cold start.** A direct navigation to `/bots/<id>` with a delayed `db.bots` snapshot waits in the loader's own `preload()`; it never reads an empty collection and throws a false `notFound` (R3-T3).
- **Preload.** With `preload: true` the loader returns without any side effect and without `session.load()`: hovering many bots must not open chat subscriptions (the chat kit's LRU holds 8, 02 §3.1).

### 5.4 Masks and pane boundaries

`router.tsx` (foundation §6.6/§6.7) after this phase:

```ts
export const routeMasks = [
  createRouteMask({ routeTree, from: "/bots/$botId/check-in", to: "/bots/$botId", params: (p) => p, search: (s) => s }),
  createRouteMask({ routeTree, from: "/routines/new", to: "/routines" }),
  createRouteMask({ routeTree, from: "/library/connectors", to: "/library/connectors", search: ({ connector: _c, ...rest }) => rest }),
];
export const PANE_BOUNDARIES = {
  "/_shell/(routines)/routines/_list/": "routines-list",
  "/_shell/(routines)/routines/_list/new": "routines-list",
  "/_shell/(bots)/bots/$botId": "bot:$botId",
  "/_shell/(bots)/bots/$botId/check-in": "bot:$botId",
  "/_shell/(library)/library/connectors": "library-connectors",
} as const satisfies Partial<Record<keyof FileRoutesById, string>>;
```

- The bot-details mask and boundary are removed (F2). Opening and closing the check-in dialog keeps the chat's instance, scroll position and composer draft (R3-T1, the foundation's identity assertion pattern).
- A search-only change on `/bots/$botId` (opening a panel tab) keeps `paneKey` and starts no view transition (foundation §6.7 rule 1).
- `ROUTE_RANK` (foundation `lib/navigation/nav-type.ts`) gains `/bots/$botId/chats/$sessionId` = 2; `/bots/$botId/edit` stays 2; `/bots/$botId/check-in` has no rank (a pop-up; rule 1 applies first). So: `/bots/new` → `/bots/<id>` = `nav-forward`; bot → bot = `nav-lateral`; chat → editor = `nav-forward`; editor → chat (Save or Back) = `nav-back`; Details › a sender chat = `nav-forward`.

### 5.5 Not found, deleted while open

- `notFoundComponent` for `/bots/$botId`, the editor and the sender chat: registry `Empty` with an asleep neutral avatar, "This bot was deleted" (or "This chat is gone" for a sender chat), and a primary link "Make a bot" → `/bots/new`. The sidebar shows no active row.
- **Deleted in this window:** `deleteBot` (§6.4) navigates first (to the next bot in sidebar order, else `/bots/new`, `replace: true`, `transition: "nav-lateral"`), then deletes. The chat never renders a null bot (P6).
- **Deleted elsewhere while open** (another window, main): the live row disappears after the loader ran. The route component reads the bot with `useLiveQuery(...findOne())`; when the collection is ready and the row is absent it renders `<BotGone/>` (the same view as `notFoundComponent`) instead of the chat. It does not throw `notFound()` from render: a throw during render reaches the nearest error boundary, not the router's not-found handling. R3-T4 covers the loader path and the live path.
- The chat kit's session for a deleted bot keeps its transcript cached until eviction; `ChatView` is not rendered once the bot is gone, so nothing sends.

### 5.6 What phase 6 (onboarding) consumes

`createBotFromTemplate(templateId, overrides?)` and `deleteBot(id)` from `features/bots/index.ts` (§6.4), `BotAvatar` from `components/bot-avatar`, and the `data-tour` hooks (P45). The first-bot hatch route composes them; nothing in phase 3 renders onboarding.

---

## 6. Data

### 6.1 Sources

| Data | Source | Loaded by | Invalidated / live by |
|---|---|---|---|
| Bots | `botsCollection` (`db.bots`) | `bots.tsx` loader | change batches (`bots-updated`, bot-store write hook) |
| A bot's sessions | `sessionsCollection` (always syncing): forever and sender sessions by `owner?.kind === "bot" && owner.botId`; **check-in runs by `routineId === checkIn.id`** (main creates them with `owner: null`, `service-host.ts:3846-3851`) | shell | change batches; `turn` gives busy / waiting-permission / error |
| Run completions | `bots.events { type: "run-finished", botId, sessionId, runId, outcome, hasVisibleAssistantText }` (new, §24.11) | `BotsSidebar` module (one subscription per document) | coalescing is **not** acceptable: declared lossless-actionable, no snapshot needed (a missed cue is not re-announced) |
| Pending connector asks | `connectors.events({ conversationKey })` (lossless-actionable, first yield `snapshot`) for the open chat; `connectors.events()` keyless for the attention of other bots | chat route; sidebar module | the iterator itself |
| Check-in routine | `routinesCollection` where `isCheckInRoutine(row, botId)` | `bots.tsx` loader | `cronjobs-updated`, cron-store hook, 60 s re-diff |
| Previews | `bots.chatPreviews` query (`Record<botId, {text, at}>`) | `bots.tsx` loader | `bots.events { previews-changed }` (every `bots-updated`, including transcript-only saves, spec 00 A.2.3) |
| Sender-chat details (`platform`, `senderName`, `userId`, `autoReply`) | `bots.senderChats` query | Details panel, sender-chat route | `bots.events` **and** `messaging.events { updated }` (pairing status changes emit `messaging-updated`, not `bots-updated`) **and** a `sessionsCollection` insert/delete of a sender session (a new sender chat) |
| Memory entries | `memoriesCollection` where `scope === "bot" && botId` | Memory tab (`preload()` on mount) | change batches (watchers, spec 00 B.2) |
| Note days, empty-memory bots | `memory.bots` query | Memory tab, Details "Memory" row | `memory.events { changed }` **and** a `botsCollection` rename (`BotMemoryView.name`; TBx#12 class) |
| Files | `artifactsCollection` where `sessionId ∈ botSessionIds` | Files tab (`preload()` on mount) | change batches |
| Models | `models.list` query | editor, setup step, model picker open | `settings.events { credentials-changed }` (foundation invalidation table) |
| App default model | `settings.get` (`defaultModel`) + `models.list` (`recommended`) | same | `settings.events` |
| Default mode for bots | `settings.defaultMode.get` | chat route | on its own mutation (phase 5) |
| Messaging platforms | `messaging.snapshot` query | Details "Also reachable on", channel banners | `messaging.events { updated }` |
| Connected connectors | `connectors.statuses` query | template ordering | `connectors.events { status-changed }` |
| Pinned bots | `prefs.pinned.botIds` (`usePrefs`) | boot | prefs change batches |

Every query's options live in `features/bots/data/queries.ts` built from `transport.orpc.<path>.queryOptions`; their invalidation entries are added to the foundation's `data/queries/invalidation.ts` table (`eventType → queryKey[]`), which R3-T5 walks: for each row of the table above it emits only that source's event and asserts the query refetches (TBx#5/TBx#12 class: each derived view lists every source of change).

### 6.2 Live queries (the shapes components read)

```ts
// features/bots/data/queries.ts (sketches; all through useLiveQuery from @tanstack/react-db)
useBot(botId)            → q.from({ b: botsCollection }).where(({ b }) => eq(b.id, botId)).findOne()
useBotSessions(botId)    → q.from({ s: sessionsCollection }).where(({ s }) => or(eq(s.owner?.botId, botId), eq(s.routineId, checkInId)))   // see note; checkInId from useCheckIn
useCheckIn(botId)        → q.from({ r: routinesCollection }).where(({ r }) => and(eq(r.botId, botId), eq(r.prompt, CHECK_IN_PROMPT)))
                            .orderBy(({ r }) => r.createdAt, "asc").findOne()
useBotMemories(botId)    → q.from({ m: memoriesCollection }).where(({ m }) => and(eq(m.scope, "bot"), eq(m.botId, botId))).orderBy(({ m }) => m.index)
useBotFiles(sessionIds)  → q.from({ a: artifactsCollection }).where(({ a }) => inArray(a.sessionId, sessionIds)).orderBy(({ a }) => a.updatedAt, "desc")
```

- Check-in runs carry `routineId` and no owner (`service-host.ts:3846-3851`); forever and sender sessions carry `owner.botId` and no `routineId`. A `role: "routine"` owner exists only for sender chats opened with platform `"routine"` (`bot-service.ts:360-438`) and is treated like a sender session.
- **Nested property filters** (`s.owner?.botId`) must be supported by the 0.9.2 query builder's expression refs; **unverified**. If not, `useBotSessions` filters `useLiveQuery(q => q.from({ s: sessionsCollection }))` in the component (the collection is a few hundred rows). R3-T6 pins whichever form ships.
- **Several check-in routines** for one bot (possible after a manual duplicate in Routines): the oldest is "the" check-in (the old dialog took the first match, `new-bot-dialog.tsx:147-156`); the others are ordinary routines.
- `eq`, `and`, `or`, `inArray` are `@tanstack/db` 0.9.2 query functions (`query/builder/functions.d.ts:23,38,40,45`).

### 6.3 Ids

New bots get a client id `"bot-" + crypto.randomUUID()` (matches `BotId`, `ids.ts:15-27`; main honours a valid unused caller id and returns `CONFLICT` for a taken one, spec 00 sub-slice B notes). The id is minted **when the setup step mounts** and kept in the draft, so the shared-element name `bot-identity-{id}` is stable before the create navigation (§16.2). New check-in routines get `"routine-" + crypto.randomUUID()` the same way.

### 6.4 Mutations (`features/bots/data/bot-actions.ts`)

Every row: what the renderer calls, what main does, the final row the user sees, and each failure's handling (TBc#6/#7, TBx#4 class). Handlers are the `ipcCollectionOptions` ones (spec 00 B.3): they await the echo *received*, never *applied*; actions that need visible state after persistence await `tx.isPersisted.promise` outside the handler.

| Action | Client call | Main | Final row | Failure → handling |
|---|---|---|---|---|
| Create bot | `botsCollection.insert(row)` with a full `BotRow` (§9.4), then `await tx.isPersisted.promise` | `createBot(input, id)`: trims, slices, defaults, `createdAt/updatedAt = now` | server-normalised row replaces the optimistic one on the echo (no flicker; B-T1 8b) | `CONFLICT` (id taken) → rollback, mint a new id, retry once, else form error "Couldn't create the bot"; `PRECONDITION_FAILED {bot-limit}` → form error "You have 50 bots, the most there can be. Delete one to make another." (prevented client-side first: §9.3); `BAD_REQUEST` → form error with the field the server names; `UNAVAILABLE`/`INTERNAL` → form error + the message, draft kept |
| Create check-in (after create) | `routinesCollection.insert(row)` (§10.3) | `createRoutine` | row with `nextRunAt` from main | any error → toast "The bot was made, but its check-in wasn't saved" + "Try again" (re-runs only this step); the bot stays (P40) |
| Update bot | `botsCollection.update(id, (d) => Object.assign(d, dirtyPatch))`, `dirtyPatch` = only fields the user edited (value ≠ baseline, see Concurrency) | `updateBot`: merges, re-trims; relabels the forever session on rename; re-pins its model on a non-null model | echo | `NOT_FOUND` → rollback, toast "This bot was deleted", navigate `/bots/new`; `FORBIDDEN {channel-bot}` → prevented (no edit UI for channel bots); others → form error, dirty values kept. An update whose values equal the row sends nothing (TanStack suppresses it, TBx#4); the form treats it as saved. |
| Update/create/delete check-in (edit) | `routinesCollection.insert/update/delete` per §10.3 | `createRoutine` / `updateRoutine` / `removeRoutine` | echo | error → form error on the Checks-in field "Couldn't change the check-in"; the bot fields already saved stay saved (two writes, not a transaction; P41) |
| Announce | `bots.announceChange({ id, notice })` after the writes above resolve | starts the session and sends `[mission updated] …` if mission/persona/check-in changed and a session exists | — | fire-and-forget, errors logged (parity: `new-bot-dialog.tsx:334-356`) |
| Delete bot | navigate away (§5.5), then `botsCollection.delete(id)` | `removeBot` + directory; forever session removed; sender routes removed (transcripts kept); routines get `botId: null`; messaging `botId` cleared | row gone; its check-in routine stays with `botId: null` | `NOT_FOUND` → resolves as deleted (idempotent delete, §24.5); `FORBIDDEN {channel-bot}` → prevented; others → rollback, the AlertDialog stays open with the inline `deleteError` (P24) |
| Pin / unpin | `updatePrefs({ pinned: { botIds: next } })` with `next` computed from the current row (the implemented `updatePrefs(patch: PrefsPatch)`, `data/db/tables.ts:380-400`; it sends every named leaf, so an explicit choice is recorded `user` even when equal) | `PrefsStore.update` (marks `user`) | echo | rollback + toast "Couldn't pin" |
| Model (Details or chip) | `botsCollection.update(id, (d) => { d.model = next })` (null = App default) | `updateBot` + §24.10: re-pins every session of the bot to `model ?? default`, applies it to running agents | echo | as Update bot; a failed live apply is main's to log (the pin still applies at the next start) |
| Pause / resume check-ins | `routinesCollection.update(checkInId, (r) => { r.enabled = !r.enabled })` | `updateRoutine({enabled})` | echo | rollback + toast |
| Forget one memory | `memoriesCollection.delete(row.id)`; `toDeleteInput` sends the **original** row (`index`, `entry`, `occurrences`) | `forgetBotMemoryEntry` under the store lock | row gone (renumbered siblings arrive as updates) | `CONFLICT` (stale click) → rollback, toast "That changed while you were looking. The list is up to date." |
| Forget everything | `memory.clearBot({ botId })` (plain mutation) | empties `MEMORY.md`, keeps daily notes | memory rows deleted by the watcher batch; `memory.bots` refetched on `memory.events` | toast "Couldn't clear memory" |
| Duplicate (New) | `botsCollection.insert(copy)`: fields and look copied, `name = truncate(name, 27) + " 2"` (unique suffix counting up), `sessionId: null`, `channel: null`; check-in not copied | `createBot` | new row | as Create bot |
| Mark as unread (New) | `botsUnreadStore.mark(botId)` | — | dot shown | — |
| Pause / resume a sender's auto-reply | `messaging.decidePairing({ platformId, userId, decision: "pause" \| "resume" })` | pairing row status | `bots.senderChats` refetch (via `messaging.events`) | toast; disabled when `userId == null` (P61) |

**Concurrency** (two windows, or main writes while a form is open):

- The editor seeds `defaultValues` from the row when it mounts and keeps that seed as a per-field **baseline**. A field counts as edited by the user when its current value differs from its baseline (a value comparison, not TanStack's `isTouched`/`isDirty` metadata: a blur without an edit sets `isTouched`, and `setFieldValue` without `dontUpdateMeta` sets both, `FormApi.js:646-675`). When the live row changes, every field whose current value still equals its baseline is replaced with `form.setFieldValue(name, value, { dontUpdateMeta: true, dontValidate: true, dontRunListeners: true })` and its baseline moves to the new value. All three options are needed: in 1.33.5 `dontUpdateMeta` alone still calls `validateField`, which marks a mounted field touched (`FormApi.js:204-217`). Edited fields keep the user's value; a one-line notice "Changed in another window" appears above the actions and clears on save. Saving sends only edited fields (value ≠ baseline), so it never reverts another window's change. R3-T10 applies two successive remote changes and a blur without an edit.
- A row deleted while its editor is open: §5.5.
- Two creates from two windows with the same template are two bots (ids are UUIDs); names may repeat, as today.

### 6.5 Errors the UI must never parse

The renderer branches on `isDefinedError(e) && e.code` and `e.data` only (foundation §8.2). Until §24.4 lands, the bot-limit, empty-name and channel-bot cases arrive as `INTERNAL_SERVER_ERROR`; they are **prevented client-side** (limit check, schema, hidden actions for channel bots), so in practice the generic "Couldn't save" + message path only shows for genuine failures. No code path matches on `message` text (R3-T11 greps `features/bots` for `.message.includes(` / `.message ===`).

### 6.6 Attention: one pure function

PLAN: avatar mood and sidebar badge derive from one pure function (openbot.run's order `waiting > routine > working > unread`), so they never disagree.

```ts
// features/bots/data/attention.ts (pure; R3-T12 is a table test)
export interface BotAttentionInput {
  sessions: Array<Pick<SessionRow, "id" | "owner" | "routineId" | "turn">>;   // the bot's sessions incl. check-in runs (§6.2)
  checkInRoutineId: string | null;
  cachedDescriptors: Record<string /* sessionId */, { count: number; firstTitle: string | null }>;   // only sessions whose thread the chat kit holds
  connectorAsks: Record<string /* sessionId */, number>;                                             // pending connector requests per session
  unread: boolean;                                                // §6.7
  checkIn: { enabled: boolean } | null;
  runningTool: string | null;                                     // from the chat kit's store, only for a cached thread (else null)
}
export type BotAttention =
  | { kind: "needs-you"; count: number; title: string | null }    // count > 0 (permissions or connector asks, aggregated per session)
  | { kind: "routine" }                                           // a session with routineId === checkInRoutineId is busy (a check-in is running)
  | { kind: "working"; caption: string | null }                   // forever or sender session busy (pending | streaming)
  | { kind: "error" }                                             // forever session phase "error" and nothing above
  | { kind: "unread" }
  | { kind: "paused" }                                            // check-in exists, disabled, and nothing above
  | { kind: "idle" };
export function botAttention(input: BotAttentionInput): BotAttention;
export function moodFor(a: BotAttention): LifecycleMood;          // needs-you→waiting, routine→working, working→working, error→blocked, unread→idle, paused→asleep, idle→idle
```

- `count` is aggregated **per session**: for each of the bot's sessions, its cached descriptor count when the chat kit holds that session's thread, else 1 when its `turn.phase === "waiting_permission"`, else 0; plus that session's pending connector asks. The sum over sessions is the count; `title` is the first cached descriptor's title in session order, else null. A cached forever thread with no requests therefore contributes 0 without hiding a waiting sender session (review r1 #14).
- `done` is not a state of this function: it is a transient reaction (§14.2).
- `useBotAttention(botId)` composes the live queries with `botsUnreadStore` and the chat kit's `useThreadStore(threadId, selector)` when the thread is cached (read through a route-provided accessor, since features do not import each other: the route passes `threadActivity(threadId)` into `BotsSidebar` via the shell's sidebar props; §24.2).

### 6.7 Unread (`features/bots/data/unread-store.ts`)

A TanStack `Store<{ ids: Set<botId> }>`, not persisted (parity P19). A single watcher (`subscribeChanges` on `sessionsCollection`, installed by `BotsSidebar`'s module once per document) marks a bot unread when one of its sessions' `turn.phase` goes from `pending`/`streaming` to `idle` **and** that thread is not visible (the current route's session with the window focused; `document.hasFocus()` + the router's current match). Opening any of the bot's chats clears it. "Mark as unread" adds it. Parity note: the old store also set unread when a background browser opened (`use-workspace-refresh.ts:46-48`); that event belongs to the browser runtime (phase 4) and joins then.

---
## 7. The bots sidebar (`features/bots/sidebar/`)

Built on the foundation's `NavList` molecule (§7.3 there; no registry `sidebar`). Geometry from canvas `BotsSidebar` (the parts board is the source of truth where `BotStates` differs, e.g. 56 vs 52 px rows).

### 7.1 Header and search

- Header row 36 px, padding `0 4px 0 8px`: "Bots" (15 px / 600), then two 28 × 28 icon buttons, radius 8: **Search** (lucide `Search`, `aria-label="Search bots"`, `aria-expanded`) and **New bot** (lucide `Plus`, `aria-label="New bot"`, `<AppLink to="/bots/new">`).
- Search opens a 32 px input (radius 9, `bg-muted`, canvas BotsEmpty "Search bots") under the header, focused. It filters by `name` and `title`, case- and accent-insensitive (`localeCompare` with `sensitivity: "base"` on normalised strings), live as you type; Escape clears and closes it and returns focus to the Search button. With a query, groups collapse into one flat result list; "No bots match" (`Empty` compact) when nothing matches. The query is ephemeral (component state).

### 7.2 Groups and order

1. **Needs you** (label "Needs you", only when non-empty): bots whose `botAttention(...).kind === "needs-you"`, ordered by the oldest waiting first (session `turn.updatedAt` asc).
2. **Pinned** (label "Pinned", collapsible via registry `Collapsible`, open by default; the open state is component state as today, `bots-tree.tsx:202-214`): `prefs.pinned.botIds` order, excluding bots in group 1.
3. **Everything else**, no label, by last activity desc: `chatPreviews[id]?.at ?? updatedAt`.

Pinned ids whose bot is gone render nothing (parity). The group label rows are 28 px, 12 px muted text, `role="presentation"`; each group is a `NavList.Group` with `aria-label`.

**`BotsNeedsYou`** is the same group rendered alone for the shell's "Needs you" slot above other areas' sidebars (foundation §7.2 reserved it): when the current area is not Bots and at least one bot needs you, the slot shows up to 3 compact rows (32 px, avatar 22) and "{n} more" linking to `/bots`. Sessions join it in phase 4.

### 7.3 Row (`bot-row.tsx`)

`NavList.Item` rendered as `<AppLink to="/bots/$botId" params={{ botId }} transition="nav-lateral">`, 56 px high, padding `0 8px`, gap 10, radius 10; active row `bg-sidebar-accent` with `aria-current="page"`.

```
[BotAvatar 36, mood]  [name 13/500 ………………… stamp 11 muted]
                      [secondary 12 ……………… trailing: unread dot 8 | needs-you count 18]
```

| State (`botAttention`) | Avatar mood | Secondary line | Trailing |
|---|---|---|---|
| `needs-you` | `waiting` | "Needs you · {title}" (title when known, else "Needs you") in `--chat-status-attention` | count badge 18 × 18, `bg-(--chat-status-attention)` with its foreground, `aria-label="{n} waiting on you"` |
| `routine` | `working` | "Checking in" in `--chat-status-running` | — |
| `working` | `working` | "Working · {caption}" or "Working" in `--chat-status-running` | — |
| `error` | `blocked` | "Stopped with an error" in `--destructive` | — |
| `unread` | `idle` | preview text | 8 px dot `bg-(--chat-status-attention)` + visually hidden "Unread" |
| `paused` | `asleep` | "Check-ins paused" muted; the name in `--muted-foreground` | — |
| `idle` | `idle` | preview `text` (last line, ≤ 200 chars, main-built) or `bot.title` | — |

- Stamp: `chatStamp(preview.at ?? updatedAt)` (P17); one shared 60 s clock (`useMinuteClock()`), not a timer per row.
- The avatar has `title={previewText}` like the canvas and `aria-hidden`; the link's accessible name is "{name}, {secondary line}".
- Channel bots (`channel != null`) show the platform's `ConnectorMark` (16 px) after the name.
- Rows never remount on a data change (the foundation's R1-T4 pattern): keys are bot ids.

### 7.4 Row menu (`bot-row-menu.tsx`)

One item list rendered by both a registry `ContextMenu` (right-click, and the keyboard `ContextMenu` key / Shift+F10 on a focused row: Chromium dispatches `contextmenu` on the focused element for both; **unverified with Base UI's `ContextMenu` trigger**, R3-T14 checks it) and a `DropdownMenu` behind a ⋯ `NavList.Action` button (visible on hover and focus-within; `aria-label="Options for {name}"`). Canvas BotStates menu: 208 px, radius 14, 32 px items.

| Item | Shown when | Action |
|---|---|---|
| Pin / Unpin | always | §6.4 |
| Mark as unread | not unread | `botsUnreadStore.mark` |
| Edit bot | `channel == null` | navigate `/bots/$botId/edit` |
| Duplicate | `channel == null` and fewer than `MAX_BOTS` bots | §6.4 |
| — separator — | | |
| Pause check-ins / Resume check-ins | a check-in exists | §6.4 |
| — separator — | | |
| Delete bot (destructive) | `channel == null` | opens §7.5 |

Canvas items without data behind them ("Hide from sidebar") are not rendered (§25.3). The same list feeds the 800 px title-bar ⋯ menu's bot items (§11.2).

### 7.5 Delete confirmation

Registry `AlertDialog`: title "Delete bot", body "This deletes {{name}} and its chat. This cannot be undone." plus, when a check-in exists, "Its check-in keeps running as an ordinary routine." (F3); buttons Cancel / Delete (destructive, `autoFocus` on Cancel). Delete runs §6.4's action; while pending the Delete button shows a `Spinner` and both buttons are disabled; an error stays in the dialog (P24).

### 7.6 Empty and loading

- **Empty** (`bots` ready, zero rows): canvas BotsEmpty sidebar: the search field, then centred 44 px `BotAvatar` (`blob`, neutral colour, `asleep`), "No bots yet", "Make one for a job you hand off often." No button (the pane's start page is the call to action; the header's New stays).
- **Loading**: `NavList.Skeleton` × 5 at 56 px; **error**: foundation's inline "Couldn't load" + Retry (`collection.utils.resync()`).

### 7.7 Strip at 800–899 (`bots-strip.tsx`)

Canvas BW800: 88 px column, padding 8, gap 4: New button 40 × 40 radius 12 `bg-muted`; tiles 56 × 56 radius 14 with a 40 px avatar (mood from §6.6), active tile `bg-sidebar-accent`; unread / needs-you dot 8 px at top 6 / right 6 with a 2 px ring in `--sidebar`. Each tile is a link with `aria-label` = the row's accessible name and a registry `Tooltip` with the name (the canvas's `title`). No search, no groups: needs-you tiles first, then pinned, then the rest (§7.2 order).

---

## 8. The start page and the create flow

### 8.1 Start page (`/bots/new`, canvas BotNew; BotsEmpty when there are no bots)

Centred column, width `min(760px, 100% − 48px)`, `padding-top: 32px`:

1. `BotAvatar` 96 px in a `motion.div layoutId="bot-draft-avatar"` (§16.4): look = the draft's picked look, else `defaultLook(name)` (§14.4); mood `happy` when the name is non-empty, else `asleep` with the neutral colour and `round` shape (canvas).
2. Shape strip: 8 × 32 px buttons, radius 8, gap 6 (`blob, round, star, flower, heart, cloud, clover, burst`, canvas), each a `toggle-group` item with the shape in the current colour when selected (neutral otherwise), `aria-label` = the shape's name, `aria-pressed`.
3. Name pill: 480 × 52, radius 999, `bg-muted`, padding `0 8px 0 20px`: registry `input` (unstyled variant through `className`), centred text, placeholder "Name your bot", `maxLength={30}`, `aria-label="Bot name"`, `data-tour="bots-name-input"`; autofocus only when there are no bots (P29). A 36 px round submit button with lucide `ArrowRight`, filled `--bot-accent` of the draft colour with its foreground, `aria-label="Set up {name}"`, disabled while the trimmed name is empty. Enter or the button → `navigate({ search: { step: "setup" } })`.
4. With **zero bots** (canvas BotsEmpty): above the pill, three decorative avatars (bunny + bow, blob wink 64, cat) `aria-hidden`, "Who do you need?" (22/600) and "A bot is a standing agent with its own instructions, schedule, memory and chats. Start from a template, or name one and describe the job." (13 muted, max 420). Below the pill, template **chips** (36 px, avatar 24 + name) for the Featured category instead of the grid.
5. With bots: "Templates" label (13 muted) + category segmented control (32 px, radius 999; Featured, Assistant (personal-assistant), Productivity, Research visible; "More" is a `DropdownMenu` with Social media, Finance, Marketing, Recruiting) bound to `search.category`; then the grid (§8.2).

Keyboard: the page's tab order is avatar strip → name → submit → category → cards. `Mod+N` (foundation hotkey) lands here.

### 8.2 Templates grid

- `orderedTemplateIds(category, connectedConnectorIds)` (moved verbatim, P31), 3 columns (`grid-template-columns: repeat(3, minmax(0, 1fr))`, gap 8), cards radius 16, padding 14, `bg-card`: avatar 32 (template look via `resolveLook`) + name (500, one line); description (13 muted, 2 lines clamped, min-height 36); connector marks row (12 px marks + "uses" text) when the template has `connectors` (§24.9 adds the field for the six featured templates, canvas copy).
- A card is a `button` (`aria-describedby` its description): it sets `search.template` and `step: "setup"` in one navigation; the draft takes the template's **translated name** (replacing a typed one, parity P37), persona, mission, title and look (`new-bot-dialog.tsx:195-214`).
- Card copy is `bots.templates.<id>.{name,description}` (existing keys); persona and mission stay English (they are the prompt).

### 8.3 The draft (`features/bots/form/draft-store.ts`)

A TanStack `Store` keyed by `"new"` or a bot id: `{ id, name, look, templateId, values? }`, kept in `sessionStorage` per document (lost on quit, kept across HMR and Back/Forward), cleared on successful create or explicit Cancel. `id` is the client id minted on first use (§6.3).

### 8.4 Setup step (`/bots/new?step=setup`, canvas BotCreate)

`BotSetupForm` = `BotForm` (§9) in create mode. Title bar identity: "New bot". Footer: "Started from the {template} template" (when `templateId`), Cancel (→ `history.back()`; the draft stays so the start page shows the same name), **Create bot** (primary, filled with the draft accent and `accentForeground`). After create: §9.4.

---

## 9. The bot form (`features/bots/form/`)

### 9.1 Layout (canvas BotCreate; the editor page reuses it)

Two columns inside the pane: the **look column** 300 px, `bg-(--muted)/40`, padding `40px 24px 0`, centred avatar; and the **fields column**, flex 1, padding `32px 40px 0`, gap 14. Below 1000 px the look column collapses to a 160 px strip on top (avatar 72 + name/title; the pickers move into a "Look" popover beside the avatar). Field geometry: label 12/16 muted, gap 6, inputs 40 px radius 10 `bg-muted`, textarea 96 px (auto-grow to 240 px).

**Look column:** avatar 96 (mood `happy`, `bot-identity-{id}` shared element §16.2, `layoutId="bot-draft-avatar"`), name 16/600 and title 13 muted (live from the fields), then:

- **Shape**: 4-column grid, 32 px cells radius 8, the 8 canvas shapes (`blob, mochi, pebble, bunny, cat, bear, star, cloud`) then a "More shapes" disclosure showing the other 16; registry `toggle-group` (single), items `aria-label` = shape name.
- **Colour**: 10 swatches in one row (20 px, radius 999), the `AVATAR_PALETTE`; selected = ring `0 0 0 2px var(--card), 0 0 0 4px var(--foreground)` (canvas); `toggle-group` items with `aria-label` = colour name ("Green", "Blue", …); in light theme each swatch also has a 1 px `--foreground`/15% border (F6).
- **Accessory**: chips 26 px radius 999: None, Glasses, Shades, Bow, Cap, Headphones, Antenna, Crown, Monocle (canvas shows the first four; the row wraps).
- The canvas's "How it will greet you" preview is not built (§25.3).

**Fields column**, in canvas order:

| Label | Bot field | Control | Limits |
|---|---|---|---|
| Name | `name` | `input` | required, trimmed length 1–30 (`MAX_BOT_NAME`) |
| Persona | `persona` | `input` (single line on canvas; `textarea` auto-grow when the text wraps) | ≤ 1,000 (`MAX_BOT_PERSONA`) |
| Instructions | `description` (the mission) | `textarea` | ≤ 4,000 (`MAX_BOT_DESCRIPTION`); empty allowed (becomes `NAME_ONLY_MISSION`) |
| Description | `title` (the role line) | `input` | ≤ 80 (`MAX_BOT_TITLE`) |
| Checks in | check-in routine | `toggle-group` segmented: Off, Hourly, Daily, Weekdays, Weekly (40 px track, 32 px items, radius 10/7) | §10 |
| At / On | check-in time; weekday for Weekly; minute for Hourly | `input type="time"` 120 px; weekday `toggle-group` (7 × 32 px, "M T W T F S S" with full names as `aria-label`) | shown per preset (§10.1) |
| Model | `model` | `ModelPickerField` (40 px trigger, "App default" or the model label + provider mark) opening the §13 picker | — |

A character counter ("24/30") appears under a field once it is within 20% of its limit, `aria-live="polite"` only when it reaches the limit.

### 9.2 TanStack Form wiring

```ts
// form-kit.ts
const { fieldContext, formContext, useFieldContext, useFormContext } = createFormHookContexts();
export const { useAppForm } = createFormHook({
  fieldContext, formContext,
  fieldComponents: { TextField, TextAreaField, SegmentedField, TimeField, WeekdayField, ModelField },   // each wraps registry Field/FieldLabel/FieldDescription/FieldError + the atom
  formComponents: { SubmitButton },
});
// bot-form.tsx
const form = useAppForm({
  defaultValues: toFormValues(bot ?? draft),
  validationLogic: revalidateLogic({ mode: "blur", modeAfterSubmission: "change" }),   // RevalidateLogicProps.mode: "change" | "blur" | "submit" (ValidationLogic.d.ts:26-40,52)
  validators: { onDynamic: BotFormSchema },                                              // FormValidators.onDynamic (FormApi.d.ts:74); revalidateLogic runs only onDynamic
  onSubmit: ({ value }) => submitBot(mode, v.parse(BotFormSchema, value), editedFields(form)),   // schema OUTPUT, see below
});
```

- Field components read `field.state.meta.errors` (valibot issues mapped to messages through `issueMessage(issue, t)`) but **display** them only when `field.state.meta.isBlurred || form.state.submissionAttempts > 0` (`FieldMeta.isBlurred`, `form-core/dist/esm/types.d.ts:196`; `FormState.submissionAttempts`, `FormApi.d.ts:235`). The form-level `onDynamic` schema validates the whole object and fills every invalid field's errors, so without that gate blurring Name would show Description's error. `aria-invalid` and `aria-describedby` follow the displayed state. Components never subscribe to the whole form state (selectors via `form.Subscribe` / `useStore(form.store, selector)`).
- `SubmitButton` subscribes to `[canSubmit, isSubmitting]`; disabled when `!canSubmit` after a submit attempt or while submitting (shows `Spinner`).
- **Submitted values are parsed, not taken raw.** TanStack Form's Standard Schema bridge keeps only the issues and discards the schema's output (`form-core/dist/esm/standardSchemaValidator.js`: `validate` returns `undefined` when there are no issues), and `parseValuesWithSchema` also returns issues only (`FormApi.d.ts:510-518`). `onSubmit` therefore runs `v.parse(BotFormSchema, value)` and persists its output, so `v.trim()` applies: whitespace-only Instructions become `""` and then `NAME_ONLY_MISSION` (R3-T10, create and edit).
- `revalidateLogic` runs **only** the `onDynamic` validator (its doc comment, `ValidationLogic.d.ts:43-51`), so no `onChange`/`onBlur` validators are declared anywhere in the form. The typings are verified; the runtime sequence (nothing before the first blur, blur-validated before submit, change-validated after) is proved by R3-T10 on the real library, not assumed.

### 9.3 Schema (`schema.ts`)

```ts
const trimmed = (max: number) => v.pipe(v.string(), v.trim(), v.maxLength(max, "too-long"));
export const BotFormSchema = v.object({
  name: v.pipe(trimmed(MAX_BOT_NAME), v.minLength(1, "required")),
  persona: trimmed(MAX_BOT_PERSONA),
  instructions: trimmed(MAX_BOT_DESCRIPTION),
  description: trimmed(MAX_BOT_TITLE),
  look: v.object({ shape: v.picklist(AVATAR_SHAPES), color: v.pipe(v.string(), v.check(isSupportedAvatarColor, "color")), accessory: v.picklist(AVATAR_ACCESSORIES) }),
  model: v.nullable(v.pipe(v.string(), v.minLength(1))),
  checkIn: CheckInDraftSchema,                                  // §10.1
});
```

- Lengths are UTF-16 code units, the same unit main's `slice(0, n)` uses (`bot-store.ts:88-121`), so what validates is exactly what main stores.
- `isSupportedAvatarColor(c)` = `c` is in `AVATAR_PALETTE`, **or** `c` is a valid `#rrggbb` whose `accentForeground` reaches 4.5:1 (the same predicate `resolveLook` uses to keep an existing custom colour, §14.3). So a bot with an existing compliant custom colour saves an unrelated edit; the picker itself only offers the palette. Shapes and accessories validate against the new scheme; a legacy shape is mapped by `resolveLook` into `defaultValues`, and an untouched look writes nothing (not edited, §6.4).
- **Client-side prevention** (F10): create is blocked with a form-level message when `bots.length >= MAX_BOTS`; the editor and every edit/delete entry are absent for channel bots.

### 9.4 Submit pipeline (`submit.ts`)

**Create** (`mode: "create"`):

1. `row = { id: draft.id, name, title: description, description: instructions || NAME_ONLY_MISSION, persona, avatarColor, avatarShape, avatarAccessory, workspaceId: null, sessionId: null, channel: null, model, createdAt: now, updatedAt: now }`; `tx = botsCollection.insert(row)`; `await tx.isPersisted.promise` (§6.4 failures).
2. If `checkIn.preset !== "off"`: insert the check-in routine (§10.3); its failure toasts and continues.
3. **Readiness before navigating** (review r1 #20): with the setup page still mounted and the Create button showing a spinner, `await openChatOnce(bot)` then `await chat.session(handle.sessionId).load()` (capped at 5 s, after which it navigates anyway). The destination loader then finds both cached and commits without a pending screen, so the setup avatar and the transcript avatar swap in one commit (§16.2).
4. Clear the draft; `navigate({ to: "/bots/$botId", params: { botId: row.id }, transition: "nav-forward" })`. The chat loader calls `openChatOnce`, which creates the forever session and (first ever open) main's kickstart; the renderer sends no first message (P39, parity).

**Edit** (`mode: "edit"`):

1. `dirtyPatch` from the fields edited by the user (value ≠ baseline, §6.4) (look fields map to `avatarShape`/`avatarColor`/`avatarAccessory`; `instructions` → `description`, with the `NAME_ONLY_MISSION` substitution; `description` → `title`); `botsCollection.update` with it; await persisted.
2. If the check-in field was edited **and** its composed schedule or its `enabled` differs from the stored routine: §10.3.
3. `bots.announceChange({ id, notice: { mission?: descriptionChanged, persona?: personaChanged, checkIn?: describeCheckIn(draft) } })` when any of the three is set; not awaited for navigation.
4. `await chat.session(sessionId).load()` when the forever session is known and not cached (same 5 s cap), then `navigate({ to: "/bots/$botId", transition: "nav-back" })` (the identity morph, §16.2). Cancel = `history.back()` with no writes; leaving with dirty fields asks through the router's `useBlocker` + registry `AlertDialog` ("Discard changes?").

### 9.5 Model-facing strings

`NAME_ONLY_MISSION`, `CHECK_IN_PROMPT` and `describeCheckIn` output are sent to the model and stay **English and byte-identical** to today's (`new-bot-dialog.tsx:56-62,67-73,97-115`). Before anything moves, scaffold step 1 captures them into **immutable fixtures** `shared/bots/__fixtures__/legacy-model-strings/{name-only-mission,check-in-prompt}.txt` and `describe-check-in.json` (inputs → outputs for every preset), extracted from the pre-migration source and reviewed as data. Then they move to `shared/bots/check-in.ts` and the old files re-export them (§24.9). R3-T9 tests **both** the shared helpers and the legacy re-exports against the fixtures, so the oracle survives the move (review r1 #21).

---

## 10. Check-ins (`features/bots/check-in/`, `shared/bots/check-in.ts`, `shared/bots/schedule.ts`)

### 10.1 Model

```ts
export type CheckInPreset = "off" | "hourly" | "daily" | "weekdays" | "weekly";
export interface CheckInDraft { preset: CheckInPreset | "custom"; time: string /* HH:MM */; weekday: Weekday; custom: string | null; enabled: boolean }
export function checkInFromRoutine(routine: RoutineRow | null): CheckInDraft;   // null or no schedule → off; decomposeCron; non-preset cron → custom; enabled = routine.enabled (true when none)
export function scheduleFromCheckIn(d: CheckInDraft): string | null;             // composeCron over the preset (custom → the stored cron, unchanged)
```

- Presets are exactly today's (P34); `once`, `manual` and `custom` never appear in the segmented control. The time input shows for Daily, Weekdays and Weekly; Hourly shows "At minute" (a 0–59 number input) because `composeCron` keeps the minute for hourly; Weekly adds the weekday row. Defaults for a fresh check-in: 09:00, Monday (`DEFAULT_SCHEDULE`).
- **Custom** (a check-in routine whose cron no preset expresses, e.g. edited in Routines): the segmented control shows no selection and a row "Custom schedule: {cron in words}" with "Edit in Routines" (`/routines/$routineId`). Saving the bot leaves it untouched unless the user picks a preset (today it showed Off; P41).
- `describeCheckIn` for the announcement is today's English output ("off", "every hour", "every day at HH:MM", "weekdays at HH:MM", "weekly on <Day> at HH:MM").
- Summary for the Details row and the sidebar: i18n "Weekdays, 8:00", "Every day, 9:00", "Every hour", "Mondays, 9:00", "Custom", "Off", "Paused" (times formatted with `Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit" })`).

### 10.2 The check-in dialog (`/bots/$botId/check-in`, masked)

Registry `Dialog`, 420 px: title "Checks in", the segmented control and the At/On fields from §9.1 (same field components, its own small `useAppForm` over `CheckInDraftSchema`), a `Switch` "Paused" when a check-in exists (bound to `!draft.enabled`), and Save / Cancel. A pause-only save writes only `enabled`; a schedule edit on a paused check-in keeps it paused unless the switch is turned off (§10.3). Save runs §10.3 then `bots.announceChange({ id, notice: { checkIn } })` when the schedule changed (P42), then closes (history back). Entry points: the Details "Checks in" row, the BotChannel "Change schedule" chip (§11.5), the row menu's Pause item does not open it.

### 10.3 Persistence rules (parity P40/P41)

| Before | After | Call |
|---|---|---|
| none | preset ≠ off | `routinesCollection.insert({ …, enabled: draft.enabled, id: "routine-"+uuid, name: t("bots.checkIn.routineName", { name }), prompt: CHECK_IN_PROMPT, schedule, runAt: null, webhookToken: null, workspaceId: null, botId, … })` (a new check-in defaults to enabled) |
| exists | off | `routinesCollection.delete(id)` |
| exists | schedule and/or `enabled` differ | `routinesCollection.update(id, (r) => { if (scheduleChanged) r.schedule = s; if (enabledChanged) r.enabled = draft.enabled })` — `enabled` is written only when the draft's differs; a schedule edit on a paused check-in keeps it paused |
| exists | same schedule and same `enabled` | nothing |
| exists (custom) | untouched | nothing |

- The routine name is localized at creation, as today (`bots.newDialog.checkInRoutineName` → mapped to `bots.checkIn.routineName` by the keymap, §18). The prompt is not.
- The optimistic routine row fills derived fields (`nextRunAt: null`, `webhookUrl: null`, `webhookPublicPending: false`, `botName: bot.name`, `recentRuns: []`, `lastRunAt: null`, `lastResult: null`, `createdAt: now`); main's echo replaces them (`routinesCollectionOptions.toInsertInput`, `data/db/tables.ts:129-160`).
- The row menu's Pause/Resume and the paused banner's Resume write `enabled` alone (§6.4). Today's dialog wrote `enabled: true` on every schedule change (`new-bot-dialog.tsx:310-327`) because it had no pause control; with a pause control, preserving the chosen state is required (review r1 #4).
- **Pause** is `enabled = false`. Canvas "Check-ins paused until Monday" (a pause with an end) has no data (§25.3); the banner shows "Check-ins paused." with Resume.

---
## 11. The bot chat (`/bots/$botId`)

### 11.1 Composition in the route

The route file composes two features; neither imports the other (foundation §4):

```tsx
function BotChatRoute() {
  const { botId } = Route.useParams();
  const { sessionId, workspaceId } = Route.useLoaderData();
  const bot = useBot(botId);                                          // features/bots
  if (bot == null) return <BotGone />;                                // §5.5
  const slots = useBotChatSlots(bot, { sessionId, workspaceId });     // features/bots: banner, empty, typing caption, model binding, readOnly
  const expanded = useComposerExpanded(sessionId);                    // features/chat (§24.2)
  return (
    <div style={accentVars(bot)} className="contents">
      <TopBarSlot name="identity"><BotIdentity bot={bot} docked={slots.identityDocked} /></TopBarSlot>
      <TopBarSlot name="actions"><BotTitleActions bot={bot} /></TopBarSlot>
      <ChatView threadId={sessionId} skin="bot" slots={slots.chat} composer={slots.composer} workspaceRoot={null} />
      <SidePanel.Content tab="details"><BotSidePanel.Details bot={bot} modelInComposer={expanded} /></SidePanel.Content>
      <SidePanel.Content tab="memory"><BotSidePanel.Memory bot={bot} /></SidePanel.Content>
      <SidePanel.Content tab="files"><BotSidePanel.Files bot={bot} /></SidePanel.Content>
      <Outlet />                                                        {/* masked check-in dialog */}
    </div>
  );
}
```

`accentVars(bot)` = `{ "--bot-accent": look.color, "--bot-accent-foreground": accentForeground(look.color) }` from `resolveLook(bot)` (§14.3), so a legacy colour renders its mapped swatch everywhere, including the bubble tint (chat kit).

### 11.2 Identity and title-bar actions (canvas BotChat, BotChatScrolled, BotChatPanel, BW900, BW800)

- **Transcript header** (canvas BotChat, not docked): centred, `padding: 28px 0 8px`, gap 6: `BotAvatar` 56 (mood from §6.6), name 15/600, status line 12 muted with a 6 px dot. It is the chat kit's `slots.empty`-independent header: the route passes it as `slots.header` (§24.2) so it scrolls with the transcript.
- **Docked identity** (title bar, canvas BotChatScrolled): avatar 22 (mood), name 13/500, 6 px dot, status text; shown when the transcript header's avatar is less than 50% visible (an `IntersectionObserver` on the header avatar, threshold 0.5, root = the scroller viewport). The identity fades/slides in (§16.1). At `md` and below the status text is hidden (foundation `data-slot="topbar-status"`).
- **Status text and dot** (`botStatusLine(attention, bot, activity)`, pure): needs-you → "Needs you" (dot `--chat-status-attention`); routine → "Checking in"; working → the running tool title (chat kit typing caption, e.g. "Checking your calendar") or "Working" (dot `--chat-status-running`); error → "Stopped with an error" (dot `--destructive`); channel bot → "on {App}" (dot = platform colour from the connector mark); idle → `bot.title` (no dot). The dot never carries meaning alone: the text always does.
- Clicking the identity (name or avatar) toggles `?tab=details` (P10), `aria-expanded` bound to it, `aria-label="Details for {name}"`.
- **Actions** (28 px icon buttons, `titlebar-nodrag`): Details (lucide `PanelRight`, same toggle), then the foundation's panel toggle. Call is not rendered (F12). At `sm` (800–899) the actions fold into a ⋯ `DropdownMenu` (canvas BW800: Details, Memory, Files, Pin, Edit bot; plus the row-menu items of §7.4 that apply), 176 px, radius 14.

### 11.3 The bot skin amendments to `features/chat` (F13)

Owned by this phase, implemented inside `features/chat` (kit code), gated by `skin === "bot"`, and covered by chat-kit tests extended here (R3-T19):

| Behaviour (today) | Kit change |
|---|---|
| Silent turns dropped: a run with no assistant text, no deliverables and no notices renders nothing (`bot-message-list.tsx:262-269`) | `BotMessage` returns `null` for an assistant message with no text part, no artifact/file parts and no notice parts; the run marker is not rendered in the bot skin (bots show no "Done in"). |
| Deliverables card (`:364-368`) | `DeliverablesCard` over `turnDeliverables(message)` ported from `renderer/components/chat/deliverables.ts` (§11.3a). |
| Reaction badge + duplicate-emoji suppression (`message-reactions.tsx:1-40`, `bot-message-list.tsx:226-257`) | Port of `agentReactions`: a badge on the preceding user bubble **only** from a `react_to_message` tool call whose result is complete, not denied/rejected, and whose JSON content has an `emoji` accepted by `isMessageReaction` (`#shared/message-reactions`); live parts read the result part, migrated parts `result.metadata.abacus.data`/`content` (C.3). An assistant text part equal to that emoji (trimmed) is dropped. While the run is active, a trailing emoji-only text part of the last message is held (not rendered) until the run ends or the reaction resolves. An ordinary emoji-only reply with no successful reaction stays a bubble. |
| 15-minute gap stamps (`:45-67,373-394`) | `gapStamp(prev, next)` pure (15 min): a centred 12 px muted stamp ("Yesterday 9:41", weekday, date) between messages, in addition to the kit's day separators (a gap stamp is not drawn where a day separator already is). |
| Per-message feedback (`feedback-row.tsx:151-200,345-380`; gate `chat-panel.tsx:602-610`) | Offered **only when `account.abacus` returns an account** (no controls at all otherwise, as today). A hover/focus "…" on completed assistant bubbles (never the live run) opens a popover with 👍 / 👎 (a second click sends `rating: "clear"`) and an optional comment → `agent.feedback` with `TurnFeedbackInput { sessionId, segmentId, rating, comment?, model? }` (`shared/contracts.ts:1121-1128`); `model` is the session's. `segmentId` is `metadata.abacus.segmentId` for migrated messages and the message id for live ones, resolved to an uploaded event sequence by main (§24.12). Outcome `not-synced` shows "Couldn't send feedback yet"; `no-key` cannot occur behind the gate. |
| "Read 9:41" under the last user bubble (canvas BotChat, BotChannel) | Not built: no read receipts exist (§25.3). |

### 11.3a Deliverables (parity P53)

**Derivation** (`features/chat/kit/deliverables.ts`, a port of `renderer/components/chat/deliverables.ts` with its test cases; `#shared/deliverables` is imported unchanged):

- Only **settled** calls count: result complete and not denied/rejected (live: result part state/outcome; migrated: C.3 `state`/`outcome`). A streaming write and a rejected `present_deliverable` contribute nothing.
- If any settled `present_deliverable` (by `componentToolBase`) exists in the message, its `presentedDeliverables(input, resultContent)` are the list, in order, and nothing else is added.
- Otherwise: paths written by settled component tools (`componentOutputPath`), by the file tools `write, edit, write_file, patch, notebook_edit, multi_edit` (`getFilePath(input)`), and media tools' `declaredArtifactTargets(resultContent)`; kept only when the extension is user-facing (`md, pdf, docx, doc, pptx, xlsx, xls, csv, zip, html, png, jpg, jpeg, gif, webp, svg, mp3, wav, mp4`) and the basename is not a scratch file (`todo.md, plan.md, notes.md`).
- Each path once (first occurrence wins); `isUrl` from `isDeliverableUrl`.

**Card** (`DeliverablesCard`, canvas BotChat attachment rows): header "Files {n}"; 3 rows visible then "Show all"; a row = file-kind icon + label (the agent's label, else basename, else the URL) with the full path in a tooltip, and a secondary icon button: **Show in folder** (files, `system.showItemInFolder(resolved)`) or **Open in browser** (URLs, `system.openExternal`).

**Open** (the row's primary action), as `deliverables-pill.tsx:43-59` and `utils/preview-utils.ts:55-170`:

- Paths are resolved first: absolute (`/…`, `C:\…`) unchanged; relative → joined to the bot session's workspace root (`useResolveWorkspacePath` port); the containment root for the read is the workspace root for guest `/workspace/…` paths, else the file's own directory (`containmentRootFor` port).
- URLs open in the bot's `browser` side-panel tab (`?tab=browser`), on phase 4's browser surface (§24.13).
- Files open a **read-only preview** in the side panel (`?tab=files&preview=<abs path>`) through `components/file-preview/` (ported renderers: image, markdown, code/text via `@tanstack/highlight` over `files.readText({ filePath, hostRoot })`, images over `files.readImageAsDataUrl`, pptx over `files.readPptx` (`shared/contract/files.ts:64-76`), and today's pdf/html renderers); binary and office documents without an in-app viewer go to `system.openPath` (today's `openLocalFile` rule). No editor (PLAN).
- `files.events { type: "preview-open", path, conversationKey }` (from `present_deliverable`) opens the preview unasked **only** for this conversation, only for URLs and in-app viewer types (`hasInAppViewer`), as `usePreviewOpenBridge` does.

### 11.4 Composer binding and read-only states

`useBotChatSlots` returns the `ChatViewProps` pieces (02 §2):

- `composer.mode: "full"`, `placeholder: t("bots.chat.placeholder", { name })` ("Message {name}"), `showModeChip: false`, `fixedMode: defaultMode` (§24.2; P48), `attachmentsBase` = the forever session's workspace path from `workspacesCollection` (bots' default workspace; `null` while unknown, which disables paste-to-file with the kit's tooltip), `mentions: undefined` (bots have no `@` file mentions, as today).
- `composer.model` = the §13 binding with `layoutId: "model:" + botId`.
- **Channel bot** (`bot.channel != null`): `composer.readOnly = { reason: t("bots.chat.channelReadOnly", { app }) (WhatsApp uses its own key, parity P60), action }`, where `action` is "Open {App}" only when `messaging.snapshot` has a platform `id === channel` (or its shared twin, `SHARED_BOT_PLATFORM_OF`) with a `sharedLink` → `messaging.openSharedLink({ platformId, target: "dm" })`. Canvas BotChannel's "New chat here" is not built (no behaviour behind it).
- `slots.banner`: (1) `ConnectorRequestCard` (`components/connector-request-card/`, port of `renderer/components/chat/connector-request-card.tsx`) for this session's `conversationKey`: fed by `connectors.events({ conversationKey })` (first yield `snapshot` of pending asks, then `request`/`cleared`), actions `connectors.connect({ connectorId })` or `connectors.submitFields` for field flows, then `connectors.respond({ requestId, conversationKey, outcome })` (`shared/contract/connectors.ts:12-60`); the agent's turn is suspended inside the tool call until `respond`, so completing the connection releases it (R3-T32). (2) the paused check-in banner ("Check-ins paused." + Resume, canvas BotStates) when `attention.kind === "paused"`. Credits are the kit's `ErrorCard`; the decorative disconnected-connector and deleted-bot banners stay §25.3.
- `slots.typingCaption`: the running tool's title (kit default) — also feeds the status line.

### 11.5 Sender chats (`/bots/$botId/chats/$sessionId`, canvas BotChannel, ReadOnlyStates)

- Listed in Details under "Chats on your behalf" (§12.1): one 44 px row per bot session with `owner.role === "sender"` — `ConnectorMark` of the platform, sender name, auto-reply state ("On" / "Paused"), last activity stamp.
- The page is `ChatView skin="bot"` for that session with `composer.readOnly = { reason: t("bots.chat.senderReadOnly", { bot, sender }) (P61), action }`; `action` = Pause / Resume (`messaging.decidePairing`, disabled with a tooltip when `userId` is null). The identity shows the bot's avatar and "{bot} ↔ {sender}" with the platform mark; the status line is "on {App}".
- The transcript shows what the session holds; what was **sent** to the person is main's business (`<reply>` extraction, `NO_REPLY`, the deferral text; `messaging-gateway-service.ts:94-105,1156`). The renderer never parses `<reply>`; R3-T20 greps `features/bots` and `features/chat` for `<reply>`/`NO_REPLY` string handling.
- BotChannel's check-in chips ("Snooze an hour", "Change schedule"): only "Change schedule" is built (→ `/bots/$botId/check-in`); "Snooze" has no backend (§25.3). **Check-in runs are their own sessions** (`routineId === checkIn.id`, `owner: null`, one per fire, `service-host.ts:3846-3851`), not messages inside a sender chat. They are listed in Details under "Check-ins" (last 5 runs: stamp, outcome from `runOutcome`, link) and open at `/bots/$botId/chats/$sessionId` read-only with the routines banner (`routines.runReadOnly`, parity P62); Routines' run page (phase 5) links there too. The BotChannel marker row "Check-in · 8:00" is drawn at the top of a check-in run's view (routine trigger + time from `runTrigger`/`createdAt`).

---

## 12. Side panel (`features/bots/panel/`)

Tabs: Details, Memory, Files (`BotSearch.tab`), in the title bar at `xl` and in the drawer's own tab row below (foundation §7.4/§7.5; canvas BotStates draws them inside the panel, which is the drawer case). Panel width follows the foundation (min 360, default from `prefs.panes`); canvas BotDetails' 320 px is below the foundation's minimum and is not used.

### 12.1 Details (canvas BotDetails)

Top block, centred, `padding: 8px 16px 20px`, gap 4: avatar 72, name 16/600, title 13 muted (centred, 3 lines max), "Edit bot" (32 px pill, `variant="secondary"`, → editor) — hidden for channel bots.

Grouped list (radius 12, `bg-card`, rows 44 px, 1 px separators inset 12):

| Row | Value | Action |
|---|---|---|
| Model | the model label or "App default"; the morphing element (§16.3) | opens the §13 picker anchored to the row (popover, 360 px) |
| Checks in | §10.1 summary | navigates to `/bots/$botId/check-in` (masked) |
| Memory | "{n} things" (entries) or "Nothing yet" | `tab=memory` |
| Files | count | `tab=files` |

"Check-ins" (when a check-in exists): the last 5 runs (`routineId === checkIn.id`, newest first) as 44 px rows with stamp and outcome, each opening `/bots/$botId/chats/$sessionId` (§11.5).

"Also reachable on" (12 muted label) + a second grouped list: one 44 px row per messaging platform relevant to this bot: platforms where `messaging.snapshot.botId === bot.id` (inbound delivered to this bot) or any `approved` row has `botId === bot.id`, plus the bot's own `channel`; value "Connected" (`--chat-status-done` text colour, contrast-checked) or "Connect" (link to `/library/messaging`). Then "Chats on your behalf" (§11.5) when non-empty.

Footer (padding `12px 16px 16px`, gap 8): **Pin/Unpin** and **Delete bot** (destructive text), 36 px, radius 10, each flex 1; Delete hidden for channel bots.

### 12.2 Memory (canvas BotStates, SettingsMemory "Remembered by bots")

- Intro line: "What {name} remembers. It writes here on its own." (12 muted).
- `BotMemoryList` (`components/bot-memory-list/`, presentational): rows min-height 44, padding `6px 12px`, 1 px bottom border: the entry (13 px, one line with ellipsis, full text in a `Tooltip` and on focus), "Forget" (28 px secondary). Below: "Also keeps {n} days of notes" when `noteDays > 0` (P66). Empty: "Nothing remembered yet" (`memory.bots.empty` mapped).
- "Forget everything" (32 px, destructive text) → `AlertDialog` "Forget everything here?" (P68) → §6.4.
- Canvas sub-lines ("from chat · today") are not shown (F11).

### 12.3 Files (canvas BotStates, new)

"Files this bot made or was given. Also in Artifacts." then rows 48 px: kind tile 26 px radius 7 (file-type colour by extension from the artifacts area's mapping; phase 5 owns it, a neutral tile until then), title (one line), "{stamp} · {size}" (size only when known; artifacts rows carry none, so the stamp alone), click → `system.openPath` (files) or `system.openExternal` (links); context menu Reveal in folder (`system.showItemInFolder`). Empty: "Nothing here yet".

---

## 13. Model picker (`features/bots/model/`)

The chat kit ships the chip and the picker shell taking `groups` as props (02 §8.2). This phase supplies the groups and the semantics for bots.

### 13.1 Groups (parity P70)

```ts
export interface ModelGroup { id: string; label: string; mark?: ConnectorMarkId; items: ModelItem[]; connect?: { label: string; href: string } }
export function botModelGroups(models: ModelAvailability[], favorites: string[], defaultLabel: string): ModelGroup[];
```

- First group "Default" with one item **App default** (`value: null`), sub-label = the resolved default's label ("RouteLLM" etc.; §13.2).
- "Favourites" from `prefs.models.favoriteModelIds` (only configured ones), then provider groups in today's order: abacus/openllm first, then openrouter, gemini, then alphabetical by provider (`model-picker.tsx:150-167`), configured models only; each item: label, `note` muted, tier badge for `free`/`local`.
- Unconfigured free-tier providers get a `connect` row ("Connect OpenRouter", "Connect Google AI Studio") → `/settings/models?provider=<id>` (P70; the canvas's provider-not-connected state with its copy "Connect it to use its models, including the free ones.").
- Search (the shell's "Search models") matches label, id, provider and note (`model-picker.tsx:221-236`).
- Favouriting (star on hover/focus of an item) writes `updatePrefs({ models: { favoriteModelIds: next } })` (patch API, §6.4).

### 13.2 App default

`resolveDefaultModel(settings, models)` = `settings.defaultModel` if configured, else the `recommended` model, else `DEFAULT_MODEL_ID`, else the first configured (the order main and today's panel use: `service-host.ts:1113-1114`, `chat-panel.tsx:886-930`). Display only: `bot.model = null` is what is stored for "App default".

### 13.3 Where it is used

The editor's Model field (§9.1), the Details Model row (§12.1) and the composer chip (02 §8.2). All three edit `bot.model` (F4).

### 13.4 Applying a change

1. The renderer writes `botsCollection.update(id, (d) => { d.model = next })` (optimistic; the chip and the row show it at once). It never calls `agent.setModel` for a bot.
2. **Main owns the effective model** (§24.10): on every `bot.model` change, including a reset to `null`, it resolves `effective = bot.model ?? defaultModel()` (`service-host.ts:1113-1114`), persists it as the session model of **every** session the bot owns (forever and sender), and applies it to those whose agent is running. `openChat` and `openSenderChat` also re-pin a **reused** session when its stored model differs from the effective one (today a reused sender session returns before any pin, `bot-service.ts:360-400`, and `update` re-pins only the forever session for a non-null model, `:250-262`).
3. Check-in runs are fresh sessions per fire and start with the routine's model rules (unchanged).

The agent slice's fix for a throwing `setModel` wedging the host (reviews AGc#1, AGx#3) is a prerequisite for R3-T28's live-apply case.

---

## 14. BotAvatar and the accent (`components/bot-avatar/`, `shared/bots/avatar.ts`)

### 14.1 Look

- **Shapes (24, canvas Avatars):** `blob, round, squircle, pebble, leaf, drop, bean, slab, mochi, egg, pillow, jelly` (CSS border-radius bodies; `blob` slowly morphs) and `star, flower, heart, cloud, hex, gem, clover, burst, bunny, cat, bear, ghost` (SVG paths; `bunny`, `cat`, `bear` carry ears). Radii and paths are copied from the canvas `BotAvatar` board's `radii`/`paths`/`ears` tables into `BotAvatarShapes` (one hidden `<svg><defs>` of `<symbol>`s mounted once in `__root`, like the rail sprite, foundation §7.2).
- **Palette (10, canvas BotCreate/Avatars):** `#4ade80, #60a5fa, #c084fc, #f472b6, #f87171, #fb923c, #facc15, #2dd4bf, #818cf8, #a8a29e`, named Green, Blue, Purple, Pink, Red, Orange, Yellow, Teal, Indigo, Stone.
- **Accessories (8 + none):** `glasses, shades, bow, cap, headphones, antenna, crown, monocle`; fixed per bot, never change with state (canvas).
- **Face:** eyes, cheeks, mouth drawn in SVG over the body; the glow is the colour at 40% alpha.
- **Sizes (canvas):** 22 title bar, 36 sidebar, 56 transcript, 96 setup; also 24 (chips), 32 (template cards, strip compact), 40 (strip), 44 (empty states), 72 (Details). `size` prop is a number in px; the component scales one 100 × 100 `viewBox`.

### 14.2 Moods

- **Lifecycle** (what the roster, title bar and notch show; canvas "from the Grok Bot write-up"): `idle` (calm), `thinking` (eyes drift up), `working` (kicks into gear), `waiting` (looks at you; brows), `blocked` (stuck; sweat drop), `done` (settles, bounces; rendered with the `happy` face as the canvas does). Plus `asleep` (paused check-ins, empty states, zz).
- **Reactions** (layered on top for 600 ms, then back to the lifecycle; PLAN motion table): `talking, listening, happy, surprised, wink, love, confused, sad, focused, excited, error`. Phase 3 triggers: `wink` when the user sends in the open thread, `happy` when a run succeeds while visible (then `done` settles), `sad` on a run error, `surprised` when a permission arrives, `talking` while assistant text streams in the visible thread (a lifecycle overlay, not a 600 ms reaction: it lasts while text streams).
- `useBotMood(botId, { reactions?: boolean })` = `moodFor(botAttention(...))` plus the reaction layer from a small TanStack Store (`reactionStore`: one active reaction per bot with its expiry); `thinking` comes from the chat kit's store (a reasoning part streaming) when the thread is cached, else `working`.
- **Animation:** CSS keyframes per mood in `moods.css` (idle breathing 3 s, working bounce 0.9 s, waiting look 2.4 s, blocked shake + drop, asleep zz float, done bounce once 600 ms); reactions 600 ms; `prefers-reduced-motion` or `html[data-reduce-motion="on"]` → no keyframes (static faces). Infinite animations are frozen by the screenshot settle (foundation R1-T21).

### 14.3 Legacy mapping (render-time; disk unchanged)

```ts
export const LEGACY_SHAPES = { cone: "hex", tablet: "slab", pill: "bean" } as const;          // pebble, cloud, squircle, drop, blob exist in both
export const LEGACY_COLORS = {                                                                 // OKLab nearest by hue, then lightness
  "#a855f7": "#c084fc", "#b08968": "#a8a29e", "#ef4444": "#f87171", "#f97316": "#fb923c", "#eab308": "#facc15",
  "#22c55e": "#4ade80", "#14b8a6": "#2dd4bf", "#3b82f6": "#60a5fa", "#ec4899": "#f472b6", "#9ca3af": "#a8a29e",
} as const;
export function resolveLook(bot: Pick<Bot, "name" | "avatarShape" | "avatarColor"> & { avatarAccessory?: string | null }): Look;
```

- Shape: a current id is used as is; a legacy id maps through `LEGACY_SHAPES`; anything else → `defaultLook(name).shape`.
- Colour: a palette colour is used as is; a legacy one maps through `LEGACY_COLORS` (brown and grey both become Stone: the palette has no brown and no cool grey); any other valid hex is used as is **only if** `accentForeground` reaches 4.5:1 against it, else `defaultLook(name).color`.
- Accessory: a known id or `"none"`.
- Nothing is written back. Editing a legacy bot and saving without touching the look writes no look fields (§9.3). The old renderer keeps rendering new ids (unknown shape → its `blob`; any hex works; F5).

### 14.4 Defaults

`defaultLook(name)` = the canvas BotNew hash with one fix: `h = (h * 31 + code) >>> 0` over the name's UTF-16 units; colour `PALETTE[h % 10]`; shape `DEFAULT_SHAPES[(h >>> 4) % 16]` over the first 16 shapes (`blob … burst`, canvas order); accessory `none`. The canvas's `(h >> 4)` turns a hash with the high bit set negative ("Assistant" hashes to 3,433,796,286, and `(h >> 4) % 16 === -5`), so the unsigned shift is required. Empty name → `round`, neutral (`--muted-foreground`), `asleep`. The fallback order for the picked look is P37's.

### 14.5 Accent and contrast (F6; foundation §5.3)

- Route roots set `--bot-accent` (the resolved colour) and `--bot-accent-foreground` (`accentForeground`, the WCAG-2 winner of `#171717`/`#fafafa`). For the palette the dark foreground wins at 6.01–11.71:1 (computed; R3-T8 recomputes).
- The accent is used as a **fill** under `--bot-accent-foreground` text (user bubbles, send button, Create bot) or as decoration beside text that carries the meaning. It is never text on the page background, and never the only boundary of a control: in light theme accent dots, swatches and rings get a 1 px `color-mix(in oklab, var(--foreground) 15%, transparent)` outline (every swatch is under 3:1 against white, F6). Canvas's accent-coloured speaker label (BotCall) is not built.
- R3-T8 asserts: every palette colour ≥ 4.5:1 with its foreground; every `LEGACY_COLORS` target likewise; `resolveLook` never returns a colour failing it.

---

## 15. Connector marks (`components/connector-mark/`)

`ConnectorMark({ id, size })`: the 26 canvas marks (`gmail, calendar, drive, slack, notion, github, linear, jira, stripe, zendesk, hubspot, postgres, snowflake, vercel, aws, whatsapp, telegram, discord, abacus, openrouter, chrome, docker, mcp, figma, sheets, outlook`) as one `<svg><defs>` sprite, paths and tile colours copied from the canvas `ConnectorIcon` board; tile radius `round(size × 0.28)`, glyph `round(size × 0.68)`. `aria-hidden` unless given a `label`. Replaces `@lobehub/icons-static-svg` and the old `connector-logo.tsx` for renderer-next (PLAN "Nuked"). Messaging platform ids map `whatsapp`, `telegram`, `discord`, and the shared twins `abacus_telegram`/`abacus_discord` to their base marks. Bots use it for channel bots, "Also reachable on", sender chats, template cards and the model picker's provider marks (`abacus`, `openrouter`, …; providers without a mark get a neutral tile with the provider's initial).

---
## 16. Motion

All values come from `lib/motion.ts` (foundation §7.8) and go through `motionFor(pref, full, reduced)`; reduced motion turns layout animations into cuts and everything else into a 120 ms fade. No new transition types enter the pane map except as listed; every `<ViewTransition>` prop is a type map with `default: "none"` (foundation §6.7, review RF2#5).

### 16.1 Owners

| Moment | Owner | Spec |
|---|---|---|
| Rail/bot switch, drill into editor or sender chat | foundation pane VT (`nav-lateral`, `nav-forward`, `nav-back`) | unchanged |
| Setup avatar → chat header avatar (create); editor avatar → header (save / back) | React `<ViewTransition name={"bot-identity-" + id} share={IDENTITY}>` on both ends | 420 ms `easings.standard`; `IDENTITY = { "nav-forward": "bot-identity", "nav-back": "bot-identity", default: "none" }`; `enter`/`exit` `"none"` so an unpaired end never animates on its own |
| Title-bar identity dock (scroll) | `motion/react` `AnimatePresence` | opacity 0→1 and `y: 4 → 0`, 160 ms; out 120 ms; no view transition (F7) |
| Start page → setup step (search-only change) | `motion` `layoutId="bot-draft-avatar"` inside the bots `LayoutGroup` | 240 ms; the fields column fades in 120 ms after (`durations.layout − durations.childFade`) |
| Details Model row ↔ composer chip | `motion` `layoutId={"model:" + botId}` (§16.3) | 240 ms; the label cross-fades 120 ms (02 §9.1) |
| Sidebar rows reorder (needs-you, pin) | `motion` `layout` on rows + `AnimatePresence` for group labels | spring `springs.sidebar`; reduced → cut |
| Row/strip unread dot, needs-you badge appear | CSS `@starting-style` scale 0.6→1 + opacity, 160 ms | none under reduced motion |
| Avatar moods and reactions | CSS keyframes (§14.2) | reactions 600 ms |
| Check-in dialog, delete confirm, menus | registry atoms (Base UI `data-starting-style`/`data-ending-style`) | registry-owned |

### 16.2 The identity shared element

The source is kept until the destination is ready: create and save await `openChatOnce` and `session.load()` **before** navigating (§9.4), so the chat route commits without its pending screen and the two named boundaries swap in one commit. If readiness exceeds the 5 s cap the navigation proceeds and the morph may not pair (it degrades to the pane transition, never a broken frame). The bot route's `pendingComponent` carries no identity name. Only two surfaces carry `name="bot-identity-{id}"`: the transcript-header avatar on `/bots/$botId`, and the look-column avatar on the setup step (id = the draft's client id, §6.3) and on the editor. React pairs a shared element only when one named boundary is removed and another with the same name is inserted in the **same** transition; the create and save navigations commit through the foundation's `router.startTransition` seam, which adds `nav-forward`/`nav-back`. Bot → bot navigation removes A's header and inserts B's (different names): no pairing, and `enter/exit: "none"` keeps them still. The title-bar avatar never carries the name (it would duplicate the header's during the dock). R3-T26 (Electron) observes one `::view-transition-group(bot-identity-…)` on create and on save, **including with agent start and hydration delayed beyond the 150 ms pending threshold**, and none on bot → bot or on a panel tab change.

### 16.3 The model morph

PLAN: one element, persistent in Details, a chip in the focused composer. Rule, per bot: the element `ModelValue` with `layoutId="model:{botId}"` is mounted in **exactly one** place:

| Details tab open | Composer expanded (focused or non-empty draft, 02 §8.7) | `ModelValue` lives in | The other place shows |
|---|---|---|---|
| yes | no | Details Model row | the composer has no chip (canvas bot pill) |
| yes | yes | composer chip | the Details row shows the label as plain muted text (a separate node, `aria-hidden` duplicate avoided by giving the row its own accessible name "Model: {label}") |
| no | yes | composer chip | — |
| no | no | nowhere | — |

`modelInComposer` comes from `useComposerExpanded(sessionId)` (chat kit, §24.2); the route passes it to Details. The `LayoutGroup id="bots"` in `bots.tsx` wraps both the pane and the side-panel content (React context crosses the side panel's portal). **Unverified:** a `layoutId` animation between an element in the pane and one inside the side-panel drawer's portal (Base UI `Drawer` popup, `position: fixed`) at < 1100 px; R3-T25 records it in Electron at 1280 and 1000. If the drawer case misbehaves, the morph is a cut when the panel is a drawer (`motionFor` with the band), not a different mechanism.

### 16.4 Reduced motion

`prefers-reduced-motion: reduce` or `prefs.motion.reduce === "on"`: no `layoutId` travel (cuts), identity dock is an instant swap, avatar faces static, VT group durations 120 ms fade (foundation CSS). R3-T27 asserts each.

---

## 17. Sound cues (`lib/sound.ts` synthesis + `features/bots/sound/bot-cues.ts`)

The foundation fixed the API and gating (§7.8 there: never while the causing thread is visible and the window focused; bursts within 400 ms coalesce; per-event switches; master switch). Phase 3 fills `synth(cue)` for the cues bots produce and wires them:

| Cue | Bots trigger | Synthesis (WebAudio, one shared `AudioContext`, unlocked on first pointerdown) |
|---|---|---|
| `sent` | the user's admission acked `started`/`queued` in a bot thread | 90 ms sine 660 → 880 Hz, gain 0.08, exp release |
| `received` | main's `bots.events { type: "run-finished", hasVisibleAssistantText: true }` (§24.11) for a thread that is not visible; covers never-opened bots | two 70 ms sines 880 then 1175 Hz, 40 ms apart, gain 0.07 |
| `needs-you` | a bot session enters `waiting_permission` | three 60 ms triangle pulses at 740 Hz, 80 ms apart, gain 0.09 |
| `done` | a check-in run finishes: `run-finished` for a session whose `routineId` is the bot's check-in routine | 220 ms swept sine 520 → 1040 Hz (PLAN: openbot.run's "done") |
| `failed` | a bot run ends in `RUN_ERROR` (not `cancelled`) | 180 ms sine 440 → 294 Hz, gain 0.08 |

- Triggers come from the sessions table's `turn.phase` transitions (every bot, cached or not) plus the chat kit's stream for the open thread; one watcher, the same one as §6.7.
- Per-bot levels (all / needs-me / nothing, PLAN §Sound) need a prefs field and the Notifications page; both are phase 5 (§25.3).
- The values above are provisional and live once in `lib/sound.ts`; R3-T23 checks gating and that each cue schedules nodes (an `OfflineAudioContext` render has non-zero energy in its window), not how it sounds.

---

## 18. i18n

New strings go under `bots.*` in sub-objects that do not exist yet (foundation §9.3): `bots.sidebar.*`, `bots.start.*`, `bots.form.*`, `bots.checkIn.*`, `bots.chat.*`, `bots.panel.*`, `bots.model.*`, `bots.avatar.*` (shape, colour and accessory names), `bots.status.*`, `bots.errors.*`, `bots.gone.*`. Reused strings are mapped through `scripts/locale-keymap.json` so all 11 locales arrive translated:

| New key | Old key |
|---|---|
| `bots.sidebar.title` / `.new` / `.pin` / `.unpin` / `.pinned` / `.options` / `.edit` / `.delete` / `.emptyTitle` / `.emptyBody` | `bots.title` / `newBot` / `pin` / `unpin` / `pinned` / `botOptions` / `editBot` / `deleteBot` / `emptyTitle` / `emptyDescription` |
| `bots.delete.title` / `.body` / `.confirm` / `.cancel` / `.error` | `bots.deleteTitle` / `deleteBody` / `delete` / `cancel` / `deleteError` |
| `bots.form.name` / `.persona` / `.personaPlaceholder` / `.instructions` / `.instructionsPlaceholder` / `.description` / `.descriptionPlaceholder` / `.model` / `.modelDefault` / `.modelHelp` / `.create` / `.save` / `.saveError` / `.nameRequired` / `.editTitle` | `bots.nameLabel` / `personaLabel` / `personaPlaceholder` / `newDialog.instructionsLabel` / `newDialog.instructionsPlaceholder` / `newDialog.descriptionLabel` / `newDialog.descriptionPlaceholder` / `modelLabel` / `modelDefault` / `modelHelp` / `create` / `save` / `saveError` / `nameRequired` / `editTitle` |
| `bots.checkIn.label` / `.off` / `.hourly` / `.daily` / `.weekdays` / `.weekly` / `.day` / `.time` / `.routineName` / `.error` | `bots.newDialog.checkInLabel` / `newDialog.checkIn.{off,hourly,daily,weekdays,weekly}` / `newDialog.checkInDayLabel` / `newDialog.checkInTimeLabel` / `newDialog.checkInRoutineName` / `newDialog.checkInError` |
| `bots.start.namePlaceholder` / `.templates` / `.categories.*` | `bots.home.namePlaceholder` / `home.templatesDivider` / `home.categories.*` |
| `bots.chat.placeholder` / `.channelReadOnly` / `.channelReadOnlyWhatsapp` / `.senderReadOnly` / `.openError` | `workspace.messageBot` / `bots.channelChatReadOnly` / `channelChatReadOnlyWhatsapp` / `senderChatReadOnly` / `openError` |
| `bots.panel.memory.*` (clear, clearConfirm, clearYes, clearNo, forget, notes, empty) | `memory.clear` / `clearConfirm` / `clearYes` / `clearNo` / `forget` / `bots.notes` / `bots.empty` |
| `bots.avatar.label` / `.color` | `bots.avatarLabel` / `avatarColor` |

- Template card copy keeps its existing keys `bots.templates.<id>.{name,description}` (read in place, not remapped).
- Model-facing strings (§9.5) are not i18n. The check-in routine **name** is (parity).
- Estimated ~110 new keys, ~55 mapped. Old keys are deleted only at cut-over. R3-T21: every key used under `features/bots` exists in `en-US.json`; no new key collides with an existing leaf; every keymap source exists.

---

## 19. Accessibility

- **Sidebar**: `<nav aria-label="Bots">`; rows are links with a composed accessible name ("Chief of Staff, needs you: Send this from Gmail?"); status never by colour alone (text always present); unread has visually hidden "Unread"; the ⋯ button reaches the same menu as right-click; group labels are not focusable; the strip's tiles carry names via `aria-label` and a tooltip on focus as well as hover.
- **Start page**: the shape and colour pickers are `toggle-group`s (roving focus, arrows, `aria-pressed`) with names; the name field has a real label (`aria-label`); decorative avatars are `aria-hidden`.
- **Form**: every control has a `FieldLabel` (`for`/`id`), errors in `FieldError` linked by `aria-describedby` and announced through `aria-invalid` + the field's live region only on submit; the counter is polite and only at the limit; the segmented control is a radio-like `toggle-group` with `aria-label="Checks in"`; the weekday row uses full day names as labels; the dirty-leave prompt is an `AlertDialog` with focus on "Keep editing".
- **Chat**: identity button `aria-expanded` for Details; the docked identity is `aria-hidden` while the header is visible (one identity in the accessibility tree at a time); read-only banners are `role="status"` once on mount.
- **Panel**: tabs are registry `Tabs` (title bar) with `aria-controls`; memory rows expose the full entry on focus (tooltip) and "Forget {entry excerpt}" as the button name; destructive confirms default focus to Cancel.
- **Contrast**: §14.5; the needs-you, running and done tokens (`--chat-status-*`, 02) meet 4.5:1 for text in both themes (R3-T8 + axe in the screenshot run).
- **Keyboard**: no new global shortcuts; `Mod+N` (foundation) opens `/bots/new`; Escape closes search, menus, the check-in dialog (history back) and never discards a dirty form without the prompt.
- R3-T22 runs axe (`color-contrast` off in jsdom, on in the screenshot run) over every bots gallery section and route.

---

## 20. Gallery (`/__ui`)

`botsGallerySections` adds (the `[__ui].tsx` route passes them, 02 §14.8 pattern):

| Section | Content | Canvas boards |
|---|---|---|
| `bots-avatar` | 24 shapes × one colour; 10 colours; 9 accessories; every lifecycle mood and reaction; sizes 22/36/56/96; reduced-motion toggle; legacy looks resolved (the 8 old shapes × 10 old colours) | Avatars, BotAvatar |
| `bots-connector-marks` | all 26 marks at 16/28/40 | ConnectorIcon |
| `bots-sidebar` | rows in every §7.3 state, groups, search with/without results, empty, loading, error, strip; row menu open (`open=bots-row-menu`) | BotsSidebar, BotStates (rows, menu), BotsEmpty, BW800 |
| `bots-start` | start page with and without bots, a template selected, the setup step create mode, form errors, bot limit reached | BotNew, BotsEmpty, BotCreate |
| `bots-panel` | Details (normal, channel bot, with sender chats), Memory (entries, notes, empty, forget pending, conflict toast), Files (rows, empty) | BotDetails, BotStates (panels) |
| `bots-check-in` | dialog in each preset, custom schedule, paused | BotCreate (fields), BotDetails row |
| `bots-chat` | the chat kit's bot scenarios (02 §11.2) wrapped with this phase's identity, banners and read-only states: channel bot, sender chat, paused banner, model chip morph (a toggle that flips `modelInComposer`) | BotChat, BotChatScrolled, BotChannel, BotApproval, BotChatPanel, ReadOnlyStates, BotDetails |

Data comes from a fake `AppClient` slice plus real collections over the foundation's fake tables (`test-support/fake-table.ts`), so every state is the real component path. The screenshot script (foundation §10.2) gains the routes `/bots/new`, `/bots/new?step=setup&template=chief-of-staff`, `/bots/<first>`, `/bots/<first>?tab=details`, `?tab=memory`, `?tab=files`, `/bots/<first>/check-in`, `/bots/<first>/edit`, `/bots/<first>/chats/<sender>`, and the fixtures home gains the canvas's five bots (their looks in the new palette), one legacy-look bot, a check-in routine, a paused one, bot memory files and a sender session.

---

## 21. Tests

Projects: **jsdom** = vitest `renderer-next`; **main** = vitest `main`; **Electron** = `main-serial` with the A-T12 harness (isolated profile + CDP; foundation R1-T11b); **type** = `tsc -b` + `expectTypeOf`. "Fake tables" = the foundation's `fake-table.ts` under the real `createCollection` + `ipcCollectionOptions` (never a mocked collection, review class 32).

| Id | File | Runs in | What it proves |
|---|---|---|---|
| R3-T1 | `routes/bots.routes.test.ts` | jsdom | Route-tree snapshot for §5.1 (ids and fullPaths, including both un-nested routes); `/bots/$botId/check-in` is masked to `/bots/$botId`, survives a simulated reload and closes with `history.back()`; opening and closing it keeps the chat's instance, scroll and composer draft; `/bots/$botId/details` redirects to `?tab=details` with no mask; every `PANE_BOUNDARIES` key is a generated id; `/bots/$id/edit` renders without the chat mounted. |
| R3-T2 | `lib/navigation/nav-type.bots.test.ts` | jsdom | `inferNavType` rows of §5.4 (`/bots/new` → bot forward, bot → bot lateral, chat → editor forward, editor → chat back, tab change none, check-in open/close none). |
| R3-T3 | `routes/bots.$botId.loader.test.ts` | jsdom (memory transport) | Hover preload of a never-opened bot calls neither `bots.openChat` nor `ai.hydrate` (F9); a real navigation calls `openChat` once and awaits `session.load()`; a `tab` change (`cause: "stay"`) does not call it again; two concurrent navigations share one call; `openChat` rejection renders the error component with Retry, and Retry calls it once more. **Cold direct navigation** to `/bots/<id>`, `/bots/<id>/edit` and `/bots/<id>/chats/<sid>` with the `db.bots`/`db.sessions` snapshots delayed 1 s renders the chat/editor, never `notFound` (loaders run concurrently, review r1 #1). |
| R3-T4 | `routes/bots.gone.test.tsx` | jsdom | Loader `notFound` for an unknown id; a row deleted by a change batch while the chat is open shows `BotGone` without an error boundary; deleting from this window navigates before the delete (no frame renders a null bot). |
| R3-T5 | `features/bots/data/invalidation.test.ts` | jsdom | For each §6.1 row, emitting only that source's event (or change batch) refetches exactly its queries: previews on `bots.events`, sender chats on `messaging.events` **and** on a sender-session insert, `memory.bots` on `memory.events` **and** on a bot rename. |
| R3-T6 | `features/bots/data/queries.test.ts` | jsdom (fake tables) | Each §6.2 live query over real collections: a bot's sessions = forever + sender by `owner.botId` **plus check-in runs by `routineId` with `owner: null`** (the shape `service-host.ts:3846-3851` creates); the check-in = oldest exact-prompt routine; memories scoped to the bot; files over all those sessions; updates flow without remount. |
| R3-T7 | `features/bots/data/bot-actions.test.ts` | jsdom (fake tables + fake procedures) | Every §6.4 row through the real collections: create (optimistic row, echo with server-normalised values, no intermediate old value), `CONFLICT` retry with a new id, bot-limit / `BAD_REQUEST` / `INTERNAL` form errors with the draft kept; update sends only edited fields and an equal value sends nothing; `NOT_FOUND` on update navigates; delete navigates first and a `NOT_FOUND` delete resolves (after §24.5); pin sends `updatePrefs({ pinned: { botIds } })` (a patch; an explicit re-pin of the same list is still sent); the model action only writes the row (no `agent.setModel` call from the renderer); check-in create failure after a successful bot create keeps the bot and offers Try again; memory `CONFLICT` rolls back with the toast; duplicate naming. |
| R3-T8 | `shared/bots/avatar.test.ts` + `lib/theme.bots.test.ts` | jsdom | WCAG ratios: every palette colour and every `LEGACY_COLORS` target ≥ 4.5:1 with `accentForeground`; the light-theme outline rule is applied to dots/swatches (computed style); `resolveLook` maps each legacy shape and colour, keeps current ids and compliant custom hexes, rejects a failing custom hex, and falls back to `defaultLook`; `defaultLook` matches fixed names **including hashes with the high bit set** ("Assistant" = 3,433,796,286 → a valid shape via `>>> 4`, review r1 #15); `isSupportedAvatarColor` agrees with `resolveLook`. |
| R3-T9 | `shared/bots/check-in.test.ts` | shared | Against the immutable pre-migration fixtures (§9.5): `CHECK_IN_PROMPT`, `NAME_ONLY_MISSION` and every `describeCheckIn` preset output equal the fixture bytes, **both** from `shared/bots/check-in.ts` and through the old renderer's re-exports; `composeCron`/`decomposeCron` pass the old `routine-schedule.test.ts` cases against the shared module; `checkInFromRoutine` returns `custom` for a non-preset cron and carries `enabled`. |
| R3-T10 | `features/bots/form/bot-form.test.tsx` | jsdom | Real TanStack Form 1.33.5 + valibot: no errors before the first blur; blurring one field shows only that field's error while other invalid untouched fields stay hidden (review r1 #17); after a submit attempt errors update on change; limits at exact boundaries in UTF-16 units (30/31, emoji); **whitespace-only Instructions submit as `NAME_ONLY_MISSION` on create and on edit** (schema output persisted, review r1 #5); a legacy look seeds mapped values and an untouched save writes no look fields; a bot with a compliant custom colour saves an unrelated name edit (review r1 #7); **two successive remote changes** both refresh untouched fields, a field blurred without an edit keeps refreshing, an edited field is kept, and no remote refresh marks a field touched or runs validation (review r1 #6); the leave prompt blocks navigation with edited fields. |
| R3-T11 | `guards.bots.test.ts` (extends R1-T15) | jsdom | AST scan of `features/bots`: no `.message.includes(`/`.message ===` on errors; no import of another feature; `components/bot-avatar`, `connector-mark`, `bot-memory-list` import no `data/` or feature; no `@dicebear`, `@lobehub`, `uuid`. |
| R3-T12 | `features/bots/data/attention.test.ts` | jsdom | `botAttention` table: every precedence pair (needs-you > routine > working > error > unread > paused > idle); per-session aggregation: forever + sender waiting simultaneously = 2, a cached forever thread with zero descriptors plus a waiting sender = 1 (not 0), a cached thread with 3 descriptors counts 3, connector asks add per session (review r1 #14); a busy check-in run (`routineId`) gives `routine`; `moodFor` mapping; sidebar badge and avatar mood render from the same result for one input. |
| R3-T13 | `features/bots/sidebar/bots-sidebar.test.tsx` | jsdom (fake tables) | Group order and membership (needs-you removed from pinned), last-activity order, row states and secondary lines of §7.3, stamp from preview else `updatedAt`, one 60 s clock, search filtering (accents, no results), empty/loading/error, strip order and dots at `sm`; rows do not remount on data changes. |
| R3-T14 | `features/bots/sidebar/row-menu.test.tsx` | jsdom + Electron | The context menu and the ⋯ menu render the same items; channel bots get Pin and Mark as unread only (P22); Pause appears only with a check-in; jsdom: `contextmenu` on a focused row opens it; Electron: the keyboard `ContextMenu` key and Shift+F10 on a focused row open it (the unverified Base UI path). |
| R3-T15 | `features/bots/data/unread.test.ts` | jsdom (fake tables) | A background turn completion marks unread; a visible and focused thread does not; opening any of the bot's chats clears; Mark as unread sets; state is not persisted across a store re-creation. |
| R3-T16 | `features/bots/start/start-page.test.tsx` | jsdom | Name/shape/colour draft survives setup and Back; Enter and the arrow go to setup; disabled on empty name; picking a template **replaces a typed name with the template's translated name** (parity P37, review r1 #18) and prefills persona, mission, title, look; connector ordering promotes the template within its tab only (parity cases from `bots-home.test.tsx`); zero-bot variant; category "More". |
| R3-T17 | `features/bots/form/submit.test.ts` | jsdom (fake tables) | Create order: bot persisted, check-in inserted, `openChatOnce` + `session.load()` awaited, then navigate with the draft id; edit: edited-field patch, every §10.3 row including **pause-only save (writes `enabled` only), resume-only save, and a schedule change on a paused check-in (stays paused)** (review r1 #4); announce flags exactly as the old tests (`bot-dialog.test.tsx:91-220`: mission change announced, rename not, check-in in words, untouched check-in left alone). |
| R3-T18 | `features/bots/check-in/check-in-dialog.test.tsx` | jsdom | Presets show the right time/minute/weekday fields; custom shows the Routines link and saves nothing unless a preset is picked; the Paused switch reflects and writes `enabled` independently of the schedule; Save announces only on a schedule change; Escape closes via history back. |
| R3-T19 | `features/chat/kit/bot-message.test.tsx` (+ `kit/deliverables.test.ts`, main `feedback-service.agui.test.ts`) | jsdom + main | Silent turn dropped; **reactions**: a successful `react_to_message` gives a badge and drops the equal emoji reply, an emoji-only reply without the tool stays a bubble, failed and rejected reaction calls give nothing, a trailing emoji is held while streaming and released or dropped at the end (review r1 #9); **deliverables**: the old `deliverables.test.ts` cases (present_deliverable precedence, duplicates once, rejected/unsettled excluded, source code and scratch files filtered, media artifacts) over live and migrated parts; 15-minute gap stamps not doubled; **feedback**: no controls without an Abacus account, controls with one, never on the live run, `clear` on re-click; main: a live message id reaches the outgoing request with its uploaded `event_sequence_number` through `FeedbackService` + `DebugSyncService` (§24.12, review r1 #13). |
| R3-T20 | `features/bots/chat/read-only.test.tsx` | jsdom | Channel bot: no composer, parity copy, "Open {App}" only with a shared link; sender chat: banner, Pause/Resume via `decidePairing`, disabled without `userId`; a check-in run session opens read-only with the routines banner; no string handling of `<reply>`/`NO_REPLY` anywhere in `features/bots` or `features/chat` (grep). |
| R3-T21 | `lib/i18n/bots.keys.test.ts` | jsdom | Every `t()` key under `features/bots` exists in `en-US.json`; keymap sources exist; no new key collides with an existing leaf. |
| R3-T22 | `features/bots/gallery/a11y.test.tsx` | jsdom | axe over every §20 section with one overlay open at a time; every icon button named; menus reachable from the ⋯ button; the docked and header identities are never both in the accessibility tree. |
| R3-T23 | `lib/sound.bots.test.ts` | jsdom | Each §17 trigger plays its cue once through the gating (visible+focused thread → none; burst → one); `received` fires for a **never-opened** bot from a `run-finished { hasVisibleAssistantText: true }` notice and **not** for a silent run (`false`) (review r1 #16); `done` for a check-in run; synthesis schedules audible output in an `OfflineAudioContext` (Electron where jsdom lacks it). |
| R3-T24 | `features/bots/model/model.test.tsx` | jsdom | Groups: App default first with the resolved default's label, favourites, provider order, connect rows for unconfigured free providers, search; favouriting sends `updatePrefs({ models: { favoriteModelIds } })`; picking writes `bot.model` from Details, the editor and the chip alike, `null` for App default; the renderer never calls `agent.setModel` for a bot. |
| R3-T25 | `e2e/bots-model-morph.mjs` | Electron | At 1280 and 1000: with Details open, focusing the composer moves one `ModelValue` element (same DOM node count before/after = 1) and records a layout animation; with the panel as a drawer the rule of §16.3 holds or cuts; reduced motion cuts. |
| R3-T26 | `e2e/bots-identity.mjs` | Electron | One `bot-identity-*` view-transition group on create and on save, **also with the agent start and `ai.hydrate` delayed 1 s (beyond the 150 ms pending threshold)** — the setup page stays until readiness (review r1 #20); none on bot → bot, on a tab change or on the scroll dock; the scroll dock starts no view transition. |
| R3-T27 | `components/bot-avatar/bot-avatar.test.tsx` + `motion.types.test.ts` | jsdom + type | Every shape/mood/accessory renders; reactions last 600 ms and return to the lifecycle; reduced motion → no animation classes; `motion/react` imports used here type-check against the pinned `motion`. |
| R3-T28 | `main/services/bots/bot-model.test.ts` + `bot-errors.test.ts` | main | **Effective model** (§24.10): changing `bot.model` re-pins the forever and every sender session; resetting to `null` re-pins them to the default (a stopped session then starts, through the real start handler, with the default, not the stale pin); a reused sender session is re-pinned on `openSenderChat`; running sessions receive the live apply (fake agent). **Errors** (§24.4): bot limit → `PRECONDITION_FAILED {reason:"bot-limit"}`, channel-bot edit/delete → `FORBIDDEN {reason:"channel-bot"}`, empty name/description → `BAD_REQUEST`, `openChat` unknown → `NOT_FOUND {entity:"bot"}`; legacy IPC keeps its `Error` messages. `avatarAccessory` round-trips; a missing one reads `"none"`. **Run-finished notice** (§24.11): published once per terminal of a bot session with the right `hasVisibleAssistantText` for a spoken, a silent (`NO_REPLY`) and a hidden housekeeping turn (none published). |
| R3-T29 | `features/bots/structure.test.ts` | jsdom | The folder rules of §4 (a script over imports). |
| R3-T30 | `features/bots/parity.test.ts` | jsdom | Every `parity.ts` row (§2) names an existing route, component or test id, and no row is left without a status. |
| R3-T31 | `e2e/bots-real.mjs` | Electron (real main, fake provider) | The gate run: create a bot from a template with a weekday check-in → the routine exists with the exact prompt; **fire the check-in (`routines.run`) and assert the resulting session (`routineId` = the check-in, `owner: null`) appears in the bot's Details, drives `routine` attention while running and opens read-only** (review r1 #3); open the bot (kickstart once); change the model from the chip → the next message runs on it; reset to App default while the agent is stopped → the next start uses the default; forget a memory from a "remember" turn; complete a pending connector request and see the turn resume; delete the bot → its check-in routine remains with `botId: null`; the legacy generation shows the same bots. |
| R3-T32 | `components/connector-request-card/connector-request-card.test.tsx` | jsdom (memory transport) | The card shows the snapshot's pending asks for this `conversationKey` only; `request`/`cleared` update it; Connect → `connectors.connect` then `respond {outcome: "connected"}`; Decline → `respond {declined}`; a field flow uses `submitFields`; asks of another bot's session raise that bot's needs-you count; a reopened iterator re-snapshots (review r1 #12). |
| R3-T33 | `components/file-preview/file-preview.test.tsx` + `kit/deliverables-open.test.tsx` | jsdom | Relative paths resolve against the workspace root, absolute ones unchanged; guest `/workspace/…` reads pass the workspace root as `hostRoot`; URLs route to the browser tab and "Open in browser"; files route to the preview (image, markdown, code, text, pptx) or `system.openPath` for binary/office; Show in folder resolves first; `preview-open` for another conversation or a non-viewable type opens nothing (review r1 #10/#11). |

---

## 22. Scaffold order

Each step is a commit on `rewrite/03-bots`, stacked on the phase 2 branch.

1. **First**, the immutable fixtures `shared/bots/__fixtures__/legacy-model-strings/*` captured from the unmodified old source (§9.5); **then** `shared/bots/{templates,check-in,schedule,avatar}.ts` + old-file re-export shims + R3-T9, R3-T8 (shared half); old renderer suites green.
2. Main (§24.3, §24.4, §24.5): `avatarAccessory`, typed errors, idempotent delete; R3-T28; `data/db/tables.ts` field lists.
3. `components/bot-avatar`, `components/connector-mark`, `components/bot-memory-list`; R3-T27.
4. `features/bots/data` (queries, actions, attention, unread, open-chat) + invalidation entries; R3-T5, R3-T6, R3-T7, R3-T12, R3-T15.
5. Sidebar + strip + needs-you slot; R3-T13, R3-T14.
6. Routes of §5.1 + foundation amendments (§24.1); R3-T1 … R3-T4.
7. Start page, form, check-ins; R3-T10, R3-T16 … R3-T18.
8. Chat composition, panel, model, chat-kit amendments (§24.2); R3-T19, R3-T20, R3-T24.
9. Motion, sound; R3-T23, R3-T25, R3-T26.
10. i18n keys + keymap; gallery; screenshots; R3-T21, R3-T22, R3-T29 … R3-T31; `PROGRESS.md`.

---

## 23. Acceptance

**Build and rules**
- [ ] `typecheck`, `lint`, `format:check`, `check:knip-next`, `check:i18n`, `check:locales`, `test:unit` green; R3-T1 … R3-T30, R3-T32, R3-T33 pass; R3-T31 recorded on macOS.
- [ ] Changes under `src/renderer` are only locale additions and the re-export shims of §24.9; the old `renderer` suites pass unchanged.
- [ ] No `ui/` diff (`check:ui-registry`); no new dependency.

**Parity (gate)**
- [ ] Every §2 row is green in `parity.ts` (R3-T30), and each "Parity" row is demonstrated in the real app by hand once (checklist in the PR).
- [ ] `PARITY.md` rows 46–53 and 155–162 (bots and memory) name their renderer-next consumer.

**Canvas (screenshots at 1280/1000/900/800, light and dark, foundation §10.2; side by side with the boards)**
- [ ] BotsSidebar, BotsEmpty, BotNew, BotCreate, BotDetails (with the composer morph), BotStates (panels, rows, menu, paused banner), BotChat, BotChatScrolled, BotChannel (sender chat), BotApproval (inline card; no connector banner), BotChatPanel (typing caption), BW1000 (panel as drawer), BW900 (status hidden), BW800 (strip, ⋯ menu), Avatars, ConnectorIcon.
- [ ] axe in the real layout reports no violations, contrast included.

**Behaviour (real app)**
- [ ] Creating, editing, pinning and deleting a bot in renderer-next shows in the old renderer's sidebar and back (dev generation switch, same home), with legacy looks rendering in both.
- [ ] Hovering sidebar rows never starts an agent or sends a kickstart (logs show no `openBotChat` from hover).
- [ ] A check-in created here fires on schedule and lands in the bot's chats; pausing stops it; deleting the bot leaves it as an unlinked routine.
- [ ] Changing the model from the chip affects the very next reply.
- [ ] With reduced motion on, no morphs or face animations play.

---

## 24. Amendments this spec requires elsewhere

1. **Foundation spec (01).** §6.1: `bots.$botId.details.tsx` is a redirect with no mask; `bots.$botId.edit.tsx` becomes `bots.$botId_.edit.tsx`; add `bots.$botId.check-in.tsx` and `bots.$botId_.chats.$sessionId.tsx`. §6.2: `BotSearch` gains `preview?: AbsPath`. §6.5: loaders that read a collection await its `preload()` themselves (matched loaders run concurrently, `load-client.ts:1014-1035`); the "layout preloads, leaf reads" pattern is not safe. §6.6: replace the bot-details mask with the check-in mask. §6.7: `PANE_BOUNDARIES` bot entries become `$botId` and `$botId/check-in`; `ROUTE_RANK` gains the sender chat (2). R1-T1's bot-details identity case moves to the check-in dialog. §7.2's reserved "Needs you" slot renders `BotsNeedsYou` (and gets a `threadActivity` accessor prop from the route layer for cached-thread counts). §8.3: `updatePrefs` is `updatePrefs(patch: PrefsPatch)` as implemented (`renderer-next/data/db/tables.ts:380-400`; spec 00 sub-slice B notes), not a recipe; it sends every named leaf so an explicit same-value choice is recorded `user`.
2. **Chat kit (02).** Public API additions: `useComposerExpanded(threadId): boolean` (derived from the draft store, 02 §8.7); `ChatViewProps.slots.header?: ReactNode` (scrolls with the transcript, above the first message); `ChatViewProps.composer.fixedMode?: AgentMode` (sent as `forwardedProps.mode` on every admission, not only pre-start); `ModelChipBinding.layoutId` already exists. `BotMessage` gains §11.3's behaviours (implemented in this phase). The bot skin renders no `RunMarker`.
3. **Shared types, main, data layer (00 B).** `Bot.avatarAccessory?: string` (+ `BotCreateInput`, `BotUpdateInput`, `BotCreateInputSchema`/`BotUpdateInputSchema` as `v.optional(v.picklist(AVATAR_ACCESSORY_IDS))`); `bot-store` normalises a missing value to `"none"` on read; `BOT_CREATE_FIELDS`/`BOT_UPDATE_FIELDS` in `data/db/tables.ts` include it. No change to `avatarShape`/`avatarColor` validation (F5).
4. **Main error mapping (00 A.5).** `PRECONDITION_FAILED.reason` gains `"bot-limit"`; `FORBIDDEN {reason: "channel-bot"}` for channel-bot edit/delete; empty name/description → `BAD_REQUEST`; `bots.openChat` on an unknown id → `NOT_FOUND {entity:"bot"}`. Through typed error classes in `bot-store`/`service-host` (legacy IPC keeps the same `Error` messages, like `ConflictError`).
5. **`ipcCollectionOptions` (00 B.3).** Option `idempotentDelete?: boolean`: a `NOT_FOUND` from `delete` resolves after a `resync()` instead of rolling back (bots and routines set it).
6. **PLAN.md.** Motion table: the transcript → title-bar identity is a fade, not a view transition; the shared element is used for create/save navigations (F7). Route tree: details is a side-panel tab; the masked pop-up is the check-in editor; edit and sender chats are un-nested (F2). Bot model: both surfaces edit `bot.model`; main resolves, persists and applies the effective model to every bot session (F4, item 10).
7. **Main AG-UI relay slice.** `ai.send` on a bot thread whose agent is stopped starts it with the session's pinned model and the `forwardedProps.mode` (P48). (Feedback identity moved to item 12.)
8. **Phase 5.** Routines auto-reply rows link to `/bots/$botId/chats/$sessionId`; Settings › Memory reuses `BotMemoryList`; per-bot sound levels and the Notifications page add a prefs field.
9. **Old renderer (the only non-locale edit).** `components/bots/bot-templates.ts`, the check-in constants in `new-bot-dialog.tsx` and `components/settings/routine-schedule.ts` become re-exports of `shared/bots/*` (one line each; their tests unchanged). Templates gain an optional `connectors?: ConnectorMarkId[]` for the six featured ones (display only).
10. **Main: effective bot model** (review r1 #2). `BotService` resolves `effective = bot.model ?? defaultModel()` and, on any `model` change (null included), persists it as the session model of every session the bot owns (forever and sender; via `setAgentSessionModel`) and applies it to running agents (`setAgentModel`, errors logged, never thrown into the update). `openChat` and `openSenderChat` re-pin a reused session whose stored model differs from the effective one. Today: `bot-service.ts:250-262` (forever only, non-null only) and `:360-400` (reused sender session returns first). Test: R3-T28.
11. **Main: run-completion notice** (review r1 #16). `bots.events` gains `{ type: "run-finished"; botId; sessionId; runId: string \| null; outcome: "success" \| "cancelled" \| "error"; hasVisibleAssistantText: boolean }`, published from main's compat taps (turn end) for every session of a bot (owner or check-in `routineId`); `hasVisibleAssistantText` = the turn produced post-sanitiser assistant text other than exactly `NO_REPLY`; hidden housekeeping turns publish nothing. Delivery class lossless-actionable (not coalescing; a burst of completions must not collapse to one). Test: R3-T28.
12. **Main: feedback identity for live messages** (review r1 #13). `FeedbackService.submit` resolves `sequenceOf(sessionId, segmentId)` from `DebugSyncService`'s per-session `sequences` map, which is keyed by v1 transcript segment ids (`debug-sync-service.ts:119-122`, `feedback-service.ts:94-122`). Requirement: when main persists a thread's UIMessages (relay thread store), it records `messageId → segmentId` for each assistant message whose content the dual-written v1 transcript also holds, and `sequenceOf` accepts either id (or the uploader keys sequences by message id directly). Test: the outgoing feedback request for a live message carries the uploaded `event_sequence_number` (R3-T19 main case).
13. **Phase 4 dependency.** URL deliverables open in the bot's `browser` side-panel tab, which needs phase 4's browser surface component. If phase 3 lands first, that one row of P53 is not green and the gate waits for it; no interim external-browser substitute is shipped as parity.

---

## 25. Risks, deferred items, review classes applied

### 25.1 Risks

| Risk | Mitigation |
|---|---|
| Un-nested route ids and the check-in mask are generator-dependent | `PANE_BOUNDARIES` is typed against `FileRoutesById`; R3-T1 snapshots ids and masked reload. |
| `layoutId` across the side-panel portal/drawer | R3-T25 in Electron; fallback is a cut in the drawer case (§16.3), not a new mechanism. |
| `openChat` side effects (kickstart) triggered by an extra loader run | preload guard + `openChatOnce` cache + R3-T3; main also deduplicates. |
| Legacy look mapping hides a user's exact old colour | disk unchanged; only a picked look is written; the old renderer still shows the stored value. |
| Model live switch while a run streams | main applies the model between turns (agent behaviour); the chip shows the new value at once; a failed live apply is logged by main and the pin applies at the next start. |
| Two writes (bot, then check-in) are not atomic | parity with today; the second write's failure is explicit with Try again (R3-T7). |
| Feedback keyed by segment ids in a UIMessage world | §24.12 + R3-T19's main case. |

### 25.2 Unverified claims (each has a test that decides it)

`motion` 13.4.6 typings (R3-T27); nested `owner.botId` refs in DB queries (R3-T6); Base UI `ContextMenu` from the keyboard (R3-T14); generated un-nested ids (R3-T1); `layoutId` across the drawer portal (R3-T25); the §24.12 message-id mapping (R3-T19 main case); the `revalidateLogic` runtime sequence (R3-T10); the pdf/html preview renderers' portability from the old pane (R3-T33).

### 25.3 Deferred or not built (canvas elements without data or backend)

Call view and button (F12); "Restore" for a deleted bot; "Check-ins paused until Monday" (timed pause); "Snooze an hour"; "Hide from sidebar"; the disconnected-connector banner and `blocked` from connectors (no per-bot connector list); memory provenance sub-lines; "Read 9:41" receipts; the setup "How it will greet you" preview; "New chat here" and "Take over" on read-only chats; per-bot sound levels (phase 5); first-bot hatch and tour (phase 6); browser tab for bots (phase 4).

### 25.4 Review defect classes applied

Every library claim cites the installed `.d.ts` or is listed in §25.2 (classes 1–2); masks use fullPaths and `PANE_BOUNDARIES` is typed (6–7); mutations await *received* in handlers and `isPersisted` outside, and each has a client/server/final-row/failure row (10–12); each derived query lists every source and has a single-source test (13); stale clicks send the original memory row (18); client ids are UUIDs (19); loaders guard preload side effects (8, 20); every pending permission stays individually answerable through the kit (22); view-transition props are type maps with `none` defaults and no VT on scroll (23–25); contrast is computed, not judged (27); tests go through real collections, router and form library (31–32); intended behaviour changes are listed with owners in §2 (39); error codes are typed and the UI never parses messages (42).

---

## Review responses (r1)

Source: `docs/rewrite/specs/reviews/03-bots.codex-r1.md` (21 items, 16 major). All accepted. Coordinator decisions applied: parity means porting the old behaviour for #9, #10/#11, #12, #18 and #19; #3 joins check-in runs by `routineId`; #2 moves the effective model into main; the rest as listed. Each item was re-checked against the source named in "Evidence".

| # | Sev. | Verdict | Evidence checked | What changed |
|---|---|---|---|---|
| 1 | Major | **Accepted** | `refs/router/packages/router-core/src/load-client.ts:1014-1035`: `settleTasks` awaits every matched loader's outcome with `Promise.all`; a child loader does not wait for its parent's. | §5.1 layout row, §5.3 loader (`await bots.preload()` first), editor and sender-chat loaders await their own collections; foundation §6.5 amendment (§24.1); R3-T3 cold navigation with delayed snapshots. |
| 2 | Major | **Accepted** | `bot-service.ts:250-262` re-pins only the forever session and only for a non-null model; `:360-400` returns a reused sender session before any pin. | F4, P44, §6.4 model row, §13.4 rewritten: the renderer writes `bot.model` only; main resolves, persists and applies the effective model to every bot session, reused sessions included (§24.10); R3-T28 main tests with the real start handler; R3-T7/T24 assert no renderer `agent.setModel`. |
| 3 | Major | **Accepted** | `service-host.ts:3846-3851`: `agentSessionManagerService.create(target, job.id, null, trigger)` — `routineId = job.id`, `owner: null`. | §6.1, §6.2 (`or(owner.botId, routineId === checkIn.id)`), §6.6 `routine` kind, §11.5 check-in runs as their own sessions with navigation, §12.1 "Check-ins" list, §17 `done`; sender-chat route accepts check-in runs; R3-T6, R3-T12, R3-T20; R3-T31 now fires the check-in and inspects its session. |
| 4 | Major | **Accepted** | r1 `CheckInDraft` had no `enabled`; §10.3 forced `enabled: true`. | `CheckInDraft.enabled`; §10.2 switch bound to it; §10.3 compares schedule and `enabled` independently and keeps a paused check-in paused on a schedule edit; R3-T17 pause-only, resume-only, paused-schedule-change. |
| 5 | Major | **Accepted** | `@tanstack/form-core@1.33.5 dist/esm/standardSchemaValidator.js`: `validate` returns only issues (`undefined` on success); `parseValuesWithSchema` returns issues only (`FormApi.d.ts:510-518`). | §9.2 `onSubmit` persists `v.parse(BotFormSchema, value)`; whitespace-only Instructions become `NAME_ONLY_MISSION`; R3-T10 create and edit cases. |
| 6 | Major | **Accepted** | `FormApi.js:646-675`: `setFieldValue` runs `validateField` unless `dontValidate`; `:204-217` `validateField` sets `isTouched` on a mounted field; `dontRunListeners` exists. | §6.4 Concurrency: per-field baseline, user edit = value ≠ baseline (not meta), remote refresh with `dontUpdateMeta`, `dontValidate`, `dontRunListeners`; R3-T10 two successive remote changes and blur without edit. |
| 7 | Major | **Accepted** | r1 §9.3 `v.picklist(AVATAR_PALETTE)` vs §14.3 keeping compliant custom hexes. | §9.3 `isSupportedAvatarColor` (palette or compliant hex, the `resolveLook` predicate); R3-T8, R3-T10 unrelated edit on a custom-colour bot. |
| 8 | Major | **Accepted** | `renderer-next/data/db/tables.ts:380-400` `createUpdatePrefs(...)(patch: PrefsPatch)`; spec 00 sub-slice B notes (per-leaf provenance, same-value writes). | §6.4 pin, §13.1 favourites use patches; foundation §8.3 amendment (§24.1); R3-T7, R3-T24. |
| 9 | Major | **Accepted** (port) | `renderer/components/chat/message-reactions.tsx:1-40` (successful `react_to_message` only); `bot-message-list.tsx:226-257` (hold while streaming, drop equal reply). | P56 and §11.3 row rewritten as a port; R3-T19 emoji without the tool, failed and rejected calls, streaming hold. |
| 10 | Major | **Accepted** (port) | `renderer/components/chat/deliverables.ts` (settled only, `present_deliverable` precedence, dedupe, user-facing extensions, scratch basenames, media artifacts). | New §11.3a derivation; P53; R3-T19 ports the old `deliverables.test.ts` cases over live and migrated parts. |
| 11 | Major | **Accepted** (port) | `deliverables-pill.tsx:30-110`, `utils/preview-utils.ts:55-170` (resolution, containment root for guest paths, URL dispatch, preview types, `openLocalFile` fallback, `usePreviewOpenBridge`), `hooks/use-workspace-root.ts:15-40`. | §11.3a open rules, `components/file-preview`, `BotSearch.preview`, Show in folder / Open in browser, `preview-open` bridge; URL previews depend on phase 4's browser surface (§24.13); R3-T33. |
| 12 | Major | **Accepted** (port) | `chat-panel.tsx:2228-2232` renders `ConnectorRequestCard`; contract `connectors.events/requests/respond/connect/submitFields` (`shared/contract/connectors.ts:12-60`). | P63 now Parity in phase 3; §11.4 banner slot builds the card; other bots' asks feed attention (§6.1, §6.6); R3-T32; R3-T31 resumes a suspended turn. |
| 13 | Major | **Accepted** | `feedback-service.ts:94-122` flushes debug sync and needs `sequenceOf(sessionId, segmentId)`; `debug-sync-service.ts:119-122` keys sequences by v1 segment ids. | §24.12 main requirement (message id → uploaded sequence); §11.3 feedback row; R3-T19 asserts the outgoing `event_sequence_number`. |
| 14 | Major | **Accepted** | r1 §6.6 replaced the aggregate with one thread's descriptors. | `count` aggregated per session, cached descriptor count substituted only for that session, connector asks added; R3-T12 simultaneous forever + sender, cached forever with zero. |
| 15 | Major | **Accepted** | Recomputed: "Assistant" hashes to 3,433,796,286; `(h >> 4) % 16 === -5`. The canvas BotNew script has the same bug. | §14.4 uses `>>> 4` and notes the canvas bug; R3-T8 high-bit names. |
| 16 | Major | **Accepted** | `SessionRow.turn` = `{ phase, isBusy, updatedAt }` only (`rows.ts`, `contracts.ts:461-474`); uncached threads have no message stream. | §24.11 main `run-finished` notice with `hasVisibleAssistantText`; §6.1 source row; §17 `received`/`done` triggers; R3-T23 never-opened and silent cases; R3-T28 main side. |
| 17 | Minor | **Accepted** | `FieldMeta.isBlurred` (`types.d.ts:196`), `FormState.submissionAttempts` (`FormApi.d.ts:235`); form-level `onDynamic` fills every field's errors. | §9.2 display gate; R3-T10 blur on one field keeps others hidden. |
| 18 | Minor | **Accepted** (port) | `new-bot-dialog.tsx:195-205` sets the name to `t("bots.templates.<id>.name")` when a template is picked. | P37, §8.2; R3-T16. |
| 19 | Minor | **Accepted** (port) | `chat-panel.tsx:602-610`: no rating handler without an Abacus account. | P59 and §11.3: controls gated on `account.abacus`; R3-T19 signed-out and signed-in. |
| 20 | Minor | **Accepted** | Foundation `defaultPendingMs: 150` would swap the setup page for the pending component before the transcript avatar mounts. | §9.4 create/edit await `openChatOnce` + `session.load()` before navigating (5 s cap), §16.2; R3-T26 with delays beyond the pending threshold. |
| 21 | Minor | **Accepted** | §24.9 turns the old literals into re-exports, removing r1's oracle. | §9.5 immutable pre-migration fixtures captured first (§22 step 1); R3-T9 checks the shared module and the legacy re-exports against them. |

**Consistency pass (r2).** New tests R3-T32 and R3-T33 are defined and cited; §24 gains items 10–13; stale r1 mechanisms (renderer-side `agent.setModel` for bots, recipe-style `updatePrefs`, `owner.role === "routine"` check-in detection, emoji-only-reply badges, `system.openPath` for every deliverable, `>> 4`) appear only in this table.
