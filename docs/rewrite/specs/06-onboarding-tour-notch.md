# 06 — Onboarding, tour, notch (phase 6)

Status: spec **r4** (final; no code). r2 answered Codex round 1 (`reviews/06-onboarding-tour-notch.codex-r1.md`, 25 items); r3 answered round 2 (`…codex-r2.md`, 25 items); r4 answers round 3 (`…codex-r3.md`, 8 items, 1 blocker), each with the coordinator's decisions; responses at the end.

- `00-transport-db-migration.md` **r2** with its implementation notes: A.2.2 rows 19, 25, 26 (`account.skipOnboarding`, `system.notify`, `system.events`), A.4.1 (`windowKind: "main" | "notch" | "dev"`), A.4.2 (one port per window; only `wireRendererContents` registers contents, "later, the notch window"), A.4.3 (delivery classes), A.4.4 (handshake `kind: "main" | "notch"`), A.4.6 (the readiness barrier), A.5 (errors), B.2 (`prefs`, `onboardingStep`), the leaf-provenance notes and `updatePrefs(patch)`;
- `00-window-chrome.md` **r2**: `BaseWindow` + `WebContentsView` (§2, "do not migrate to `BrowserWindow`"), §6 line 85 ("the notch overlay window … must not import or use any of this, and must not be created with `titleBarOverlay`"), the recreate lifecycle;
- `00-agent-agui.md` **r3** with the relay notes: `PermissionDescriptor` (§3.5, `reason: "abacus:permission" | "abacus:question"`, `metadata.abacus.{lineage, kind, request, allowed}`), `permission.*` CUSTOM events, RUN_FINISHED/RUN_ERROR settle semantics, L808 ("the layout and the notch each mount an application-owned `PermissionList`");
- `01-renderer-foundation.md` **r4** as implemented (phase 1 merged `6847de01`) with its **impl r1 amendment to §6.7** (route changes are the router's document-level view transition with types from the committing location; React `<ViewTransition>` only for in-route changes; cross-route shared elements through `useSharedElementName`, `lib/navigation/shared-element.ts`): `_bare.tsx` + `onboarding.$step.tsx` placeholders with `ONBOARDING_STEPS` (§6.1), readiness reported from `__root` for every entry route including `/onboarding/*` (§6.1, R1-T20), the second Vite input (§3.3), hotkeys (§7.9), theme (§7.7), motion and sound modules (§7.8), occlusion lists (§7.6), gallery and screenshots (§10);
- `02-chat-kit.md` **r4**: `createChatRuntime(transport)` ("the notch entry (phase 6) calls it with its own transport", L170), `ThreadSession.load()`/`submit()`, `runtime.respondPermission`, `PermissionList` ("the notch mounts the same component", §6.2), the questionnaire encoding (F19), "Also in the notch" (§6.4);
- `03-bots.md` **r3**: §5.6 (what phase 6 consumes: `createBotFromTemplate`, `deleteBot`, `BotAvatar`, `data-tour="bots-name-input"`), §6.6 (the attention function), §14 (BotAvatar looks, moods, reactions), §16.2 (the identity morph as a CSS shared element), §17 (cue synthesis), §24.11 (`ai.runFinished`, the relay's run-terminal notice);
- `04-sessions.md` **r3**: §6.6 (session attention), §6.7 and §26.7 (the shared `turnTransitions` helper; **one `ai.runFinished` subscription per document**, consumed unchanged from 03 r3), §19 (cues and notifications), §26.8 (the OSI-licence rule for small libraries);
- `05-routines-artifacts-library-settings.md` **r3**: `updatePrefs(patch)` everywhere, `useConnectFlow` (§12.4, exported for onboarding; pairing navigates to Library and keeps its promise pending until the sheet closes), `notifyAttention` and OS-notification ownership (§23.3, which already passes `kind` to `system.notify`), messaging flows (§13), the signed-out Account page and `tourSignedOut()` (§19.2), Settings rows reserved for this phase (F11, §18.1, §22.1), `sounds.perBot` / `sounds.quietHours` and `isQuietNow` (§22.4), `lib/notify.ts` `allowed` (§23.2), the `notch-reply` keymap entry (§21.3), silent OS notifications in the new generation (§31.5 d).

Paths are relative to `apps/desktop/` unless noted. Code in this spec is type declarations and short sketches only. **Provenance (user rule: ideas only, never copy code).** openbot.run (PolyForm Noncommercial 1.0.0) was read for ideas. r2 removes every recipe and constant that came from its source (the notch-size inference, the 700 ms shrink delay, the persistent stdin haptic helper and its throttle, the hover timings, the 1–3-option question rule, its motion values). Every number that remains is derived from Apple's or Electron's documented APIs, the design canvas, this repo's own foundation, or a measurement a named test records; each states its derivation where it appears.

**Sources read for this spec** (installed versions, checked on 30 Sep 2026):

| Source | Version / commit | Where |
|---|---|---|
| Old renderer, onboarding | `HEAD 9b4afe15` | `src/renderer/components/onboarding/{onboarding-flow,onboarding-steps,sign-in-step,welcome-step,connectors-step,provider-setup-step,welcome-tour,tour-stops,tour-tooltip,first-bot-dialog}.ts(x)`, `app.tsx:40-55,96-108,140,167,182-192`, `stores/{account-store,tour-store}.ts`, `hooks/{use-abacus-credential,use-notifications}.ts`, `lib/{abacus-sign-in,durable-storage}.ts`, `components/settings/settings-menu.tsx:69-111,345-389`, `components/connectors/connect-flow.tsx`, `components/bots/bot-templates.ts:57-75`, `voice/{recorder,whisper,use-dictation}.ts`, `locales/en-US.json` (`onboarding.*` 1226-1293, `tour.*` 1631-1699, `firstBot.*` 870-872, `notifications.*` 1219-1225, `onboardingFlow.*` 2309-2320), their tests |
| Main | same | `main/index.ts:322-358,366-383,505-526,537-566,604-668,718-760,765-796,828,837-859,1077-1091,1385-1403,1569-1631,1824-1848,1880-1893,2039-2049,2115-2126`, `main/{renderer-host,renderer-entry,renderer-generation,window-chrome-options,startup-theme,recreate-main-window}.ts`, `main/rpc/{context,deps,readiness,window-events,delivery}.ts`, `main/rpc/transports/message-port.ts:37-221`, `main/rpc/procedures/{impl,window,system}.ts`, `main/services/providers/{account-service,abacus-auth-service,abacus-signin-window,abacus-browser-profiles,abacus-signin-config,openrouter-auth-service}.ts`, `main/services/config/{prefs-store,legacy-prefs,settings}.ts`, `preload/{index,rpc-port}.ts`, `shared/{funnel,account,settings}.ts` |
| Contract (implemented) | same | `shared/contract/{window,system,account,auth,settings,ai,voice,db,rows}.ts`, `shared/contract/ai-thread.ts:60-78` |
| renderer-next (implemented, phase 1) | same | `routes/_bare/{onboarding.$step,onboarding.index,[__ui]}.tsx`, `features/onboarding/index.tsx`, `features/shell/{readiness,sidebars}.ts(x)`, `lib/{sound,motion}.ts`, `lib/navigation/areas.ts:56-65`, `main.tsx`, `index-next.html`, `vite.config.ts:34-70` |
| Electron | **44.4.5** installed | `node_modules/electron/electron.d.ts` (cited as E:line below): `Display` 7998-8079, `screen` events 12119-12152 and methods 12170-12202, `BaseWindowConstructorOptions` 3814-4124 (`type?: string` 4070 with no value list), `setAlwaysOnTop` 3196, `setVisibleOnAllWorkspaces` 3605 + options 24413-24429, `setIgnoreMouseEvents` 3378 (`forward` 22197, darwin/win32), `setFocusable` 3341, `showInactive` 3632, `setHiddenInMissionControl` 3365, `setBounds` 3292 (note 3287-3290), `View.setBackgroundColor` 16114, `WebContentsView` 18947-18963, `WebPreferences.additionalArguments` 19418, `powerMonitor` 10944-11154, `globalShortcut.register` 8608, `Notification` options 22793-22886 |
| `motion` | **13.4.6** (its own `framer-motion` 13.4.6 under `node_modules/motion/node_modules/`) | `dist/react.d.ts` re-exports; `framer-motion/dist/index.d.ts`: `AnimatePresence` :126, `LayoutGroup` :206, `MotionConfig` :634 (`reducedMotion: "always" \| "never" \| "user"` :208,:235), `animate` :740, `motion` :940, `useSpring` :1122-1125, `useReducedMotion` :1302, `useAnimate` :1311, `usePresence` :1381 |
| `react` / `@types/react` | **19.3.0** | `@types/react/index.d.ts`: `useEffectEvent` :1798, `startTransition` :1892, `Activity` :2022, `ViewTransition` :2095, `addTransitionType` :2101; `react/cjs/react.production.js:387-521` |
| `@tanstack/react-router` / `router-plugin` | 1.170.40 / 1.168.41 | `createMemoryHistory` re-exported (`react-router/dist/esm/index.d.ts:3`, signature `@tanstack/history/dist/esm/index.d.ts:113`); `history` option (`router-core/dist/esm/router.d.ts:52`); plugin config `router-plugin/dist/esm/vite.d.ts:33-79`; per-call plugin context (`core/router-composed-plugin.js:19-20`, `core/router-generator-plugin.js:7-23`) |
| `@tanstack/react-hotkeys` | 0.12.1 | DOM only (`hotkeys/dist/hotkey-manager.d.ts:29`, `hotkey-manager.js:236`); OS-wide shortcuts need Electron `globalShortcut` |
| TypeScript lib.dom | 7.0.2 | `OfflineAudioContext` :26689; `AudioContext` :4008 has **no** `setSinkId` |
| npm registry (30 Sep 2026) | — | `node-mac-notch`, `electron-notch`, `mac-notch`: **E404, do not exist** |
| Design canvas | artifact `XpL2PgWae6rUjXDTWyUqYX`, version `1790747894-aeaf` | page 10 (`Notch`, `NotchRules`), page 11 (`OnboardWelcome`, `OnboardConnect`, `OnboardConnected`, `OnboardModels`, `OnboardKeyDialog`, `OnboardConnectors`, `OnboardFirstBot`, `OnboardDone`, `OnboardMotion`, `TourMap`, `TourRail`, `TourComposer`, `TourPanel`, `TourNotch`), page 7 (`SettingsGeneral`, `SettingsNotifications`), page 8 (`BotAvatar`, `Avatars`, `ConnectorIcon`) |
| openbot.run (ideas only) | clone under `scratchpad/refs/openbot-run`, `LICENSE` = PolyForm Noncommercial 1.0.0 | read for ideas (a panel beside the notch, click-through until hovered, a hover lock, attention priority); **no code, recipe or constant is used** (see Provenance above) |
| Apple SDK | local SDK `NSScreen.h` | `safeAreaInsets`, `auxiliaryTopLeftArea`, `auxiliaryTopRightArea` declared `API_AVAILABLE(macos(12.0))`; the two areas are `NSRect` values (an empty rect on a screen without a cut-out), not nullable objects; `NSHapticFeedbackManager.defaultPerformer`, `performFeedbackPattern:performanceTime:` (AppKit) |
| Connector registry | `workspace:*` | `packages/connectors/src/registry.ts:170-230,232-305,384-410`: `platform(…)` ids `abacus-${service}` (`gmailuser`, `googledriveuser`, `googlecalendar`, `slack`, `outlook`, `onedrive`, `jira`, `confluence`, `dropbox` carry `onboarding: true`; `twitter`, `figmauser`, `zoom`, `docusign`, `gcpcloud` do not), messaging ids `messaging-${platform}` with `onboarding: true` (WhatsApp, Telegram, Discord); `github`, `notion`, `stripe` are MCP entries; there is no Linear connector |
| Reviews | all 35 files | `docs/rewrite/specs/reviews/*` (defect classes applied in §24.4), including `06-onboarding-tour-notch.codex-r1.md` (answered at the end) |

---

## 0. Findings that change the brief (read first)

Each was checked against source. The ones that change another spec are repeated in §23.

| # | Brief / plan / earlier spec says | Verified fact | Consequence here |
|---|---|---|---|
| F1 | PLAN: notch size "from `node-mac-notch` (`safeAreaInsets`, auxiliary areas)"; window-chrome spec L85 names it | **`node-mac-notch` does not exist** (npm E404, as do `electron-notch` and `mac-notch`; nothing under `node_modules`). **Electron 44 has no notch or safe-area API**: `Display` (E:7998-8079) has `bounds`, `workArea`, `internal`, `label`, `scaleFactor`, `size`, `id`, … and nothing about the cut-out. AppKit has one: `NSScreen.safeAreaInsets` and `auxiliaryTopLeftArea`/`auxiliaryTopRightArea` (`NSRect` values; macOS 12+, local SDK `NSScreen.h`). | Metrics come from a **one-shot JXA probe** (`/usr/bin/osascript -l JavaScript`) that checks selector availability and reads those AppKit values, run by main and matched to Electron displays by frame (§10.2). **No inference fallback** (r2, review #25): when the probe fails on a display, the companion is not drawn on it and Settings says why. The probe's output on hardware is **unverified** until R6-T31 records it on a notched Mac. |
| F2 | PLAN: `BrowserWindow({ type: "panel", … })` | The app builds windows as `BaseWindow` + `WebContentsView` (`main/index.ts:625`, `renderer-host.ts:283-353`) and window-chrome §2 forbids migrating to `BrowserWindow`. `BaseWindowConstructorOptions` accepts `type?: string` (E:4070) but the typings list **no values**; `"panel"` (macOS) and `"toolbar"` (Windows) are from Electron's online docs only. A transparent `BaseWindow` needs `view.setBackgroundColor` with alpha on its child view (E:4066). | `BaseWindow({ type: "panel" \| "toolbar", transparent: true, frame: false, … })` + one `WebContentsView` with `setBackgroundColor("#00000000")` (§10.1). Whether `type: "panel"` yields a non-activating panel that never raises the hidden main window is **unverified**; R6-T30 asserts it on macOS. |
| F3 | Transport "later, the notch window" (00 A.4.2) | The transport is ready: `RendererKind = "main" \| "notch"` (`message-port.ts:39,96`), `windowKind` comes from main's registry, not the page (`:131-167`), and `connect.test.ts:258-269` already covers a `"notch"` port. But **main's deps assume every registered id is the main window**: `windows.state/chrome` answer the main window for any id (`index.ts:1618-1631`, "the notch comes later"), and `publishToWindowViews` sends main-window state and chrome to every registered id (`window-events.ts`, `index.ts:653-662,1584-1598`). | Per-window lookups and kind-filtered publication (§10.10, amendment §23.1 b). The notch registers with kind `"notch"` through `wireRendererContents`' sibling `wireNotchContents`; `requireMainRenderer` keeps it away from the browser runtime. |
| F4 | Brief: "the shared `sessions.events { run-finished }` notice" | Not implemented yet. 03 r3 §24.11 defines `ai.runFinished({}) → eventIterator<{ threadId; runId; outcome; errorCode?; hasVisibleAssistantText; owner; routineId; at }>`, published by `ThreadRelay` at the authoritative run terminal (never from compat `turn_complete`, which also fires between tool rounds), lossless-actionable with `lastEventId` resume. **04 r3 and 05 r3 consume it unchanged**, one subscription per document shared by every consumer (04 §26.7, 05 §23.3). | The notch consumes **`ai.runFinished`** unchanged through the same one-per-document feed (§11.2). The r1 rename amendment is withdrawn. The feed moves from the bots sidebar module to `lib/run-finished.ts` so a document without `features/bots` (the notch) mounts the same code (§23.3). Phase 6 cannot merge before the notice lands. |
| F5 | PLAN: the notch runs "the same `features/chat` client against the same AG-UI stream" | Pending permissions exist only inside each thread's stream: descriptors come from `ai.subscribe` (`permission.pending`) or `ai.hydrate` (`AiThreadSnapshot.permissions`, `ai-thread.ts:60-78`). There is no cross-thread permission feed. `SessionRow.turn.phase === "waiting_permission"` is the cross-thread signal, which 03 §6.6 already counts as 1 per uncached session. | The notch reads **levels** from the `sessions` table (which sessions wait, run, failed) and subscribes to a thread **only for the attention it is about to show** (at most two `ThreadSession`s: the one on screen and the next in line), through its own `createChatRuntime` (§11.2). It never subscribes to every thread. |
| F6 | PLAN: notch states `idle \| working \| message \| question \| approval \| takeover \| failed`; brief: routes `/idle /working /approval/$id /reply/$id /call /done /failed` | `takeover` is browser take-over (04's browser runtime), which has no cross-thread signal in the tables; the canvas `Notch` board draws no take-over state. `done` is on the canvas but not in PLAN's list. | Routes as the brief lists them. `question` renders inside `/approval/$id` (a descriptor with `reason: "abacus:question"`), with question ranked above approval (PLAN order). Take-over is **not built** (§24.3); a session waiting on a take-over shows as working. |
| F7 | Canvas `NotchRules`: "Answer from here … Replies: type or hold the mic"; `Notch` "Listening (dictation or a call)"; brief route `/call` | There is **no call transport** (03 F12: `voice.*` is Whisper download and microphone permission only). **Dictation audio has no owner** in 02–05: 02 §1.2 leaves "dictation audio" out and gives the composer a `Dictate` slot with states only; 03, 04 and 05 do not claim it. The old renderer's dictation is `renderer/voice/{recorder,whisper,use-dictation}.ts` (411 lines, `@huggingface/transformers` ^4.3.0 in-renderer, `package.json:96`). | Phase 6 ports dictation once to `lib/voice/` and wires both the composer's `Dictate` slot (amendment §23.2) and the notch. `/call` is the **listening** state for a dictated reply (waveform, timer, End); real calls stay not built (§24.3). |
| F8 | PLAN: 12 tour stops; old tour "react-tourlight" | The old tour has **4 live stops** (`tour-stops.ts:91-128`: bots, makeBot, connectors, terminal) of 15 authored copy families; no persistence (`tour-store.ts:3-10`, in memory, "deliberately no completed flag"); started as the last onboarding step (`explainer`) or from the account menu "Take the tour" (`settings-menu.tsx:69,357-360`). Canvas `TourMap`: twelve stops, "Replay from Settings › General › Take the tour". | Our own spotlight (§9) with the canvas's 12 stops, targets moved to the new shell (Library, not Settings, holds Connectors, 05 F7). Completion persists in prefs (`tour.status`); the running step is ephemeral (PLAN "spotlight step → TanStack Store"). The tour becomes opt-in from the first-bot step (canvas "Take the tour") instead of a forced last step (Changed). |
| F9 | Canvas `OnboardWelcome`: "Skip for now" | The old gate is `needsOnboarding = !onboarded \|\| !hasAbacusCredential` (`app.tsx:40-55`): a signed-out user, even onboarded, always lands on the sign-in step and cannot reach the app without Abacus. | Changed (canvas, and 05 `SettingsSignedOut`: "Local models and your own API keys work without it"): onboarding shows only while `!onboarded`; a signed-out onboarded user reaches the shell and signs in from Settings › Account. "Skip for now" jumps to the models step (own keys or a local model). Listed with its owner in §2.1 OB3. |
| F10 | Foundation `ONBOARDING_STEPS = ["welcome","connect","connected","models","connectors","first-bot","done"]`; spec 00: `prefs.onboardingStep` from legacy `onboarding.step`, "outside STEP_ORDER maps to null" | Legacy step ids are `auth, welcome, connectors, models, explainer` (`legacy-prefs.ts:85-95`), a different vocabulary: legacy `auth` is the new `welcome` (the sign-in screen), legacy `welcome` is the new `connected`. Both vocabularies contain `"welcome"`, so a stored string alone cannot say which step it means (review #2). The canvas orders connectors **after** models; the old flow put connectors first. | **Canonicalised at the source** (coordinator decision): spec 00 C.4's migration and live legacy sync translate legacy ids into the new vocabulary when they write `onboardingStep` and set a new leaf `onboardingFlow = 2`; renderer-next writes only new ids with `onboardingFlow = 2`. Resume therefore reads one vocabulary; a row whose `onboardingFlow` is not 2 resumes at `welcome` (§6.3, §23.6). Order follows the canvas. |
| F11 | Canvas `OnboardConnect`: "Waiting for the browser… Continue with Chrome · Work" | Main decides between an in-app sign-in window (`abacus-signin-window.ts:286-330`, a 520×760 `BrowserWindow`) and the system browser (`shell.openExternal`) from a server experiment (`abacus-signin-config.ts:13-74`) and the picked browser profile (`abacus-auth-service.ts:300-304`); the renderer is not told which. `auth.abacus.browserProfiles` is empty unless the variant is `in_app` (`abacus-browser-profiles.ts:58-86`). | The `connect` step uses one neutral waiting line ("Finish signing in, then come back here") that is true for both surfaces, and shows the profile line only when the user picked a profile. No new procedure is added to report the surface. The renderer never opens those windows (05 F19). |
| F12 | Canvas `OnboardModels` row "Run a model on this computer · Qwen3 8B" | Onboarding never offered local models in the old app (only the "Runs locally." promise, `welcome-step.tsx:13`); the local-model UI is 05 §20.5 (`features/settings/models/local-models.tsx`). | New row, composed by the route from 05's exported local-model row (features cannot import features; routes compose). |
| F13 | Canvas `OnboardConnectors`: twelve product marks (Gmail, Google Calendar, Google Drive, Slack, GitHub, Notion, Linear, Jira, WhatsApp, Telegram, Figma, Stripe), "three already on" | Old step offered `messaging-whatsapp`, `messaging-telegram`, `messaging-discord`, `abacus-gmailuser` + "Many more" (`connectors-step.tsx:28-46`). The registry already marks onboarding connectors: `onboarding: true` on WhatsApp, Telegram, **Discord**, Gmail, Google Drive, Google Calendar, Slack, Outlook, OneDrive, Jira, Confluence, Dropbox (`registry.ts:200-305`). The canvas's GitHub, Notion and Stripe are MCP entries, Figma is a platform entry without the flag, and **Linear does not exist** in the registry. | The grid is the registry's `onboarding: true` entries in registry order (messaging first), which keeps Discord (review #10) and covers every formerly offered connector; "Many more…" adds every other `kind: "platform"` entry (parity). The canvas's GitHub/Notion/Stripe/Linear tiles are a deviation listed in §24.3. Connect goes through `useConnectFlow` with the onboarding pairing policy (§7.6, amendment §23.5). |
| F14 | Canvas `OnboardFirstBot`: "the first bot hatches (egg → blob)", the card reads "Checks in weekdays at 8:00 · Gmail, Calendar"; `OnboardDone`: "Chief of Staff is checking your calendar", confetti | The old first-bot popup auto-creates Chief of Staff unless the user owns a non-channel bot (`first-bot-dialog.tsx:56-92`), with **no** check-in (the template has no check-in field, `bot-templates.ts:57-75`; the editor defaults check-ins to Off); Cancel deletes it; no animation (no tsparticles/confetti code anywhere; the packages are listed but unused, `package.json:123-125`). The template's look is `squircle`, `#22c55e` (03 maps legacy `#22c55e` → `#4ade80`, 03 §14.3). | The check-in is **Weekdays 08:00** because the canvas board `OnboardFirstBot` shows it (coordinator decision #7: a schedule only where a board shows one; cited here and in §8). Onboarding tracks the routine it created and removes it on "Start from scratch"; a partial failure leaves check-ins Off (§8.1). Hatch and confetti are our own CSS/`motion` (§8, §16); the hatch settles on the template's own look (`resolveLook`), not the canvas's `blob`. |
| F15 | PLAN motion: notch "exit 160 / expand 420 / contract 450 ms, blur 4 px, `cubic-bezier(.22,1,.36,1)`" (PLAN labels them openbot.run's tuned values); canvas `NotchRules`: "Wings widen and the body drops with a 350 ms cubic-bezier(.2,.8,.2,1); content fades in 120 ms after the shape settles" | The two disagree, and PLAN's set comes from the clone (review #25). | **The canvas's values** (r2): shape 350 ms `easings.standard`, content fades in 120 ms (`durations.childFade`) after the shape settles, out 120 ms before it moves. PLAN's openbot values and `easings.notch` are dropped (§16, §23.7). |
| F16 | PLAN recipe: `setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, … })` | Canvas `NotchRules` "Quiet by default: nothing expands while you type, present, or sit in a full-screen app". `visibleOnFullScreen` is darwin-only (E:24419). | `visibleOnFullScreen: **false**`: the companion is not drawn over other apps' full-screen spaces (the OS hides it), attention collects and shows as a count when the user returns. Behaviour over full-screen spaces is **unverified** (R6-T30). |
| F17 | Brief: approval and reply flows "bound to the relay's `ai.*` procedures" | `ai.respondPermission` exists with the ten decisions (`ai.ts`); there is **no regenerate/retry of a failed run** (`ai.send` answers `regenerate_unsupported`); `ai.hydrate` returns the completed transcript. | Approval: `runtime.respondPermission` (02 §6.3). Reply: `ThreadSession.submit(text)` (02 §3.7; busy → host queue). Failed: "Open" only; the canvas's "Retry" is **not built** (§24.3). |
| F18 | PLAN §Sound: "the notch window plays needs-you and done when the main window is not focused" | With several documents (the main one and one notch per display) owning an `AudioContext` and seeing the same notices, any class-level owner flag ("main" or "notch") still lets several notch documents play, and two separately delivered owner values can disagree for a moment (review #19). | Main **arbitrates each cue centrally**: a document asks `window.claimCue({ cueId, threadId })` before playing, and main grants it to exactly one specific `webContents` per `cueId` (§14.2). |
| F19 | Brief: "OS notifications policy (silent in the new generation per spec 05)"; canvas `SettingsNotifications` "Show in the notch: Replies and approvals appear in the notch companion, not as banners" | 05 r3 §23.3 sends every notification through `notifyAttention` (kinds `needs-you` and `done`, silent, with `kind` passed to `system.notify` as this spec asks). Main cannot tell from geometry or `isVisible()` whether the user can see the companion: another app's full-screen Space hides it without any display event (review #21). | A banner is dropped only when a notch document **reports that it presented that attention while its document was visible** (Chromium's occlusion-driven `visibilityState`), within a 1.5 s hold; otherwise the banner shows. Whether `visibilityState` turns hidden on another app's full-screen Space is **unverified**; until R6-T30 proves it, suppression is off and banners always show (§13). |
| F20 | 02 §6.4: the kit renders "Also in the notch" "when `notchEnabled` prop is true" | `ChatViewProps` (02 §2) has no such prop, and `useThreadStore`, `decisionLabel`, the questionnaire encoder are not exported from `features/chat/index.ts` (02 L122-130). | Amendment §23.2: `ChatViewProps.notchEnabled?: boolean`; `PermissionList` gains `variant: "chat" \| "notch"`; the kit exports `encodeQuestionAnswers` and `runErrorCopy(code)`. |
| F21 | 03 §5.6: `createBotFromTemplate(templateId, overrides?)` "(§6.4)" | 03's §6.4 mutation table has no row for it; it exists only as an export name (03 L239) and in P46. | Its contract is defined here as a request to 03 (§23.3): insert the template bot with a client id, await `isPersisted`, optionally create a check-in from `overrides.checkIn`, and return `{ bot, checkInRoutineId }` so the caller can undo both; `NOT_FOUND` for an unknown template id. |
| F22 | 03 §6.6 attention lives in `features/bots/data/attention.ts` | The notch entry is a separate document whose feature (`features/notch`) cannot import `features/bots` (foundation §4 rule). | The pure attention functions move to `lib/attention/` (`botAttention`, `moodFor`, `sessionAttention`); both features re-export them (amendment §23.3, §23.4). |
| F23 | Old close behaviour | On macOS closing hides the main window; on Windows/Linux closing quits unless a turn runs (dialog) (`index.ts:718-760`). A live capsule `BaseWindow` keeps `window-all-closed` from firing, so the app would no longer quit on Windows (review class: window-all-closed, 00-window-chrome impl #1). | On win32 the controller destroys the capsule when the main window closes for real (after the dialog); macOS keeps today's hide (§10.6). |
| F24 | 05 review r1 #3 | An ordinary routine run waiting on a permission gets no global attention (sessions exclude `routineId`, bots only check-in runs). | The notch's attention input covers **every** session kind (listed, bot, check-in, routine run), so a waiting routine run reaches the notch; its "Open" targets the run report (`/routines/$routineId?run=`). |
| F25 | Brief: notch window as `BaseWindow` + `WebContentsView` | A child view is not sized by its window: the app's own `RendererHost.#fit()` calls `view.setBounds()` on every change (`renderer-host.ts:339-353`), and Electron's `BaseWindow` docs size child views explicitly. Closing a `BaseWindow` does **not** destroy an attached view's `WebContents` (Electron `BaseWindow` "Resource management"). | The notch sizes its view on creation and on every native bounds change **before** resolving a grow (§10.1, §10.2), and every disposal path closes the view's `WebContents` through one idempotent `disposeNotchWindow` (§10.6). |
| F26 | r1 §16: onboarding steps and the avatar flight as React `<ViewTransition>` | Foundation impl r1 amended §6.7: route changes are the router's document transition with types from the committing location; React cannot start or join them; cross-route shared elements use `useSharedElementName` (`lib/navigation/shared-element.ts`). | Onboarding step changes and the notch's route changes are router document transitions with new nav types; the avatar flights use `useSharedElementName`; React `<ViewTransition>` is kept for in-route changes only (§16). The notch router installs the same types callback on its own router. |

---

## 1. Scope

### 1.1 In scope

- **Onboarding** (§5–§8): the seven `_bare` routes of canvas page 11 with a pure step machine, resume after restart (both step vocabularies), skip paths, sign-in through the windows main owns, provider keys and local models, connectors through `useConnectFlow`, the first-bot hatch, the done step, the gate that sends a new user there, and completion.
- **Tour** (§9): the `Spotlight` molecule (one mask + card), typed `data-tour` anchors placed by shell and feature components, the 12 stops with their `prepare()` steps, ephemeral run state, persisted completion, replay from Settings and the command menu, sign-out hook, platform variants.
- **Notch window, main side** (§10): the macOS panel per display (window recipe, metrics probe, geometry, multi-display, full-screen spaces, power events, click-through vs interactive, keyboard focus on demand, haptics), the Windows capsule by the clock, lifecycle (generation gate, readiness, reload on renderer swap, crash backoff, disable, quit), the `notch.*` contract and the per-window fixes in main.
- **Notch renderer** (§11–§12): the third Vite entry `notch.html`, its memory-history router and routes, the pure presenter with priority, the hover lock, the approval, question, reply, listening, done and failed flows bound to `ai.*` through the chat kit, reactions, view transitions and shape sync with main.
- **OS notifications policy** (§13), **sound** (§14: engine completion, owner arbitration, notch player, haptics), the Settings rows reserved for this phase (§15), motion (§16), i18n (§17), a11y (§18), gallery (§19), tests R6-T1… (§20), scaffold order (§21), acceptance (§22).

### 1.2 Out of scope

Calls (03 F12), browser take-over in the notch (F6), a notch on Linux (PLAN), retrying a failed run (F17), a menu-bar/tray item and a dock badge (05 F11), the migration progress screen (spec 00 C), anything already owned by phases 2–5 except the amendments of §23.

### 1.3 Gate (PLAN phase 6)

"Onboarding routes, first-bot hatch, spotlight tour, notch entry with states, reactions, sounds and haptics; Windows capsule. Gate: fresh-install run-through recorded; notch tested on a notched Mac, an external display and Windows." Concretely: every §2 row is green in `parity.ts` (R6-T40); R6-T36 (fresh install, recorded) passes on macOS and Windows; R6-T31 (notched Mac, recorded) and R6-T32 (external display) pass; R6-T33 (Windows capsule) passes on the CI Windows runner and once on a real Windows 11 machine; `PARITY.md` rows for `account.skipOnboarding`, `auth.abacus.*` (onboarding), `system.funnelStep`, `system.notify` and `voice.*` name their renderer-next consumer.

---
## 2. Parity table

Every behaviour of today's onboarding, tour, first-run, notification and sound surfaces, where it lands, and its status. "New" rows are canvas or PLAN behaviours that did not exist; "Changed" rows name their owner; "Retired" rows give a reason. The table is also `features/{onboarding,notch}/parity.ts` as data, which R6-T40 checks (every row names an existing route, component or test id). Citations are against `HEAD 9b4afe15`, paths under `src/renderer/` unless noted.

### 2.1 Onboarding

| # | Today (file:line) | New route / component | Status |
|---|---|---|---|
| OB1 | Full-window overlay `OnboardingFlow` over the app, `data-id="onboarding-overlay"`, no route (`app.tsx:182-192`, `onboarding-flow.tsx:232-234`) | `_bare` routes `/onboarding/$step` (foundation §6.1), no shell underneath until completion (§5.1) | Changed (PLAN route tree) |
| OB2 | Gate `needsOnboarding = !onboarded \|\| !hasAbacusCredential`, held until account and credential settle (`app.tsx:40-55`) | `_shell` `beforeLoad`: `!account.onboarded` → redirect to `/onboarding/<resumeStep>` (§5.2); account read with `ensureQueryData` (no flash of the shell) | Changed (F9) |
| OB3 | Signed-out onboarded user is sent back to the sign-in step at every launch (`onboarding-steps.ts:33-49`) | reaches the shell; signs in from Settings › Account (05 §19.2) | Changed (F9; canvas "Skip for now", 05 `SettingsSignedOut`) |
| OB4 | `STEP_ORDER = auth, welcome, connectors, models, explainer`; models skipped on a paying tier (`onboarding-steps.ts:7-49`, `isPayingAbacusTier`) | `welcome → connect → connected → models → connectors → first-bot → done` (canvas); `models` skipped on a paying tier (parity rule, same predicate from `shared/models.ts:394`) (§6.1) | Changed (canvas order) + Parity (paying-tier skip) |
| OB5 | Resume from `durableStorage` key `onboarding.step` (`onboarding-flow.tsx:44-62,109-111`), mirrored to `prefs.onboardingStep` (spec 00) | `prefs.onboardingStep` in the new vocabulary with `prefs.onboardingFlow = 2` (legacy ids canonicalised by spec 00 C.4's import and live sync, F10), written on entering each step through `updatePrefs(patch)` (§6.3) | Parity |
| OB6 | Progress dots `StepDots` (`onboarding-flow.tsx:73-94`) | progress pill in the drag strip (canvas: 5 marks, active 20 × 6, radius 3; `connect`/`connected` share mark 2) (§7.1) | Parity (canvas look) |
| OB7 | Sign-in step: "Free forever" badge, title "AbacusAI Bot", tagline, three capabilities, "Sign Up For Free" (`signup`), "I already have an account" (+ "· Continue with {browser}" and a profile menu), hint "Google, Microsoft and Apple sign-in use your {browser} accounts.", "Use my browser instead", Cancel, error line (`sign-in-step.tsx:26-274`) | `welcome` (canvas `OnboardWelcome`): avatar parade, title, tagline, four pills, **Sign up for free**, **I already have an account** (profile menu kept), **Skip for now**; `connect` (canvas `OnboardConnect`) holds the waiting state, "Use my browser instead", "Sign in another way", Cancel (§7.2–§7.3) | Parity + Changed (canvas split into two steps; Skip added, F9) |
| OB8 | `signInToAbacus(intent, profileId)`; toast "Abacus.AI is successfully connected"; `unidentified-account` copy; cancelled silent; afterwards credential cache true, `listModels(true)`, `getAbacusAccount(true)` (`onboarding-flow.tsx:186-215`, `lib/abacus-sign-in.ts`) | a sign-in **attempt** with a token (§6.4): `auth.abacus.start({ intent, browserProfileId? })` started from `welcome`, `connect` shows it; the outcome of a superseded attempt is ignored; `ok` → `connected`, refetch `account.abacus({ refresh: true })`, invalidate `models.list`; `unidentified-account` parity copy; `cancelled` → back to `welcome` quietly | Parity |
| OB9 | Browser profiles query on the auth step only (`onboarding-flow.tsx:220-225`) | `auth.abacus.browserProfiles` on `welcome` only (05 §19.2 hands it to this phase) | Parity |
| OB10 | Welcome step: "Welcome to AbacusAI Bot", four promises, "Get Started" (`welcome-step.tsx:9-75`) | `connected` (canvas `OnboardConnected`): check badge, "Abacus.AI is successfully connected", same title and promises, **Get started** (§7.4) | Parity |
| OB11 | Models step: Abacus / OpenRouter / Gemini cards with the parity blurbs; a provider counts as connected when **a configured model of that provider exists or a key is stored** (environment keys count, `provider-setup-step.tsx:88-105`); inert "Existing subscriptions"; "Many more" providers; key dialog with `isPlausibleApiKey` and `onboarding.setupKeyInvalid`; OpenRouter browser hop; handshakes cancelled on leave (`provider-setup-step.tsx:24-393`) | `models` (canvas `OnboardModels`, `OnboardKeyDialog`): same three rows with the **same connected rule** (`models.list` configured models ∪ `settings.keys.listProviders`) + **Run a model on this computer** (F12) + "Existing subscriptions · Connect later · Paste a key"; key dialog with "Open {provider}", invalid state, "Stored on this machine only." (§7.5) | Parity + New (local model row) |
| OB12 | Connectors step: WhatsApp, Telegram, Discord, Gmail + "Many more", "Continue" / "Continue without connectors", Cancel while a hop runs, flow cancelled on leave (`connectors-step.tsx:28-285`); messaging opened its pairing dialog in place | `connectors` (canvas `OnboardConnectors`): the registry's `onboarding: true` entries (WhatsApp, Telegram, Discord, Gmail, Drive, Calendar, Slack, Outlook, OneDrive, Jira, Confluence, Dropbox) + "Many more…"; `useConnectFlow` (05 §12.4) with the `pairing: "defer"` policy: messaging is enabled now and paired after onboarding from a persisted queue (§7.6, §23.5); a browser hop in flight is cancelled on leaving the step (parity) | Parity (every old tile reachable) + Changed (pairing deferred to Library, 05 F7) |
| OB13 | `finish()`: clear step, funnel `onboarding_done`, activate the active workspace and `agent.switchWorkspace`, `skipAccountOnboarding` (`onboarding-flow.tsx:145-159`) | `completeOnboarding()` (§6.5): persist the exit target, `account.skipOnboarding()`, then non-blocking cleanup; resumable after any failure or quit; funnel `onboarding_done`; no workspace activation (routes carry ids) | Parity; workspace switch Retired (PLAN "no state in two places") |
| OB14 | Funnel `screen_<step>` per step (`onboarding-flow.tsx:126-128`, `shared/funnel.ts:6-27`) | `system.funnelStep` per step with the **existing** names: `welcome → screen_auth`, `connected → screen_welcome`, `connectors → screen_connectors`, `models → screen_models`, `first-bot → first_bot_shown`; `onboarding_done` only after the account commit, once (§6.5) (no new names leave the machine) (§6.6) | Parity |
| OB15 | "Sign in" in the settings menu when signed out: `forgetAccount()` + tour reset + navigate `/` (restarts onboarding) (`settings-menu.tsx:91-95,382-389`) | Settings › Account signed-out "Sign in with Abacus.AI" (05 §19.2, ST9); onboarding is not re-entered | Changed (05 ST9) |
| OB16 | Onboarding resets an open tour on mount (`onboarding-flow.tsx:136-138`) | `tourStore` is ephemeral and the tour host lives only under `_shell`, so nothing to reset | Retired (structure) |
| OB17 | — | Onboarding → shell shared element: the done step's first-bot avatar flies to the transcript header (`useSharedElementName`), the shell fades in from 0.98 (canvas `OnboardMotion`, which draws it from the welcome parade; the flow reaches the shell only from `done`) (§16) | New |

### 2.2 First bot and first-run

| # | Today | New | Status |
|---|---|---|---|
| FB1 | Armed only by the onboarding → app transition, in memory (`app.tsx:96-108,188`) | the `first-bot` step (§8), reached only from onboarding | Parity (placement changed: a step, not a popup) |
| FB2 | Skipped when the user owns a bot without `channel` (`first_bot_skipped:has_bots`), when the template is missing, or creation fails (`first-bot-dialog.tsx:61-92`) | same three rules; the step is then skipped forward to `done` with the funnel detail (§8.1) | Parity |
| FB3 | Creates "Chief of Staff" (`FIRST_BOT_TEMPLATE_ID`, `bot-templates.ts:57-75`), no check-in, and opens `NewBotDialog` "We have created your first bot for you, enjoy!" | `createBotFromTemplate("chief-of-staff", { checkIn: weekdays 08:00 })` (03 §5.6, contract §23.3) on entering the step, the check-in because the canvas `OnboardFirstBot` board shows "Checks in weekdays at 8:00" (F14); canvas copy "We made your first bot for you" with the bot card and **Edit** (§8) | Parity (canvas copy) + Changed (check-in, canvas board) |
| FB4 | Cancel deletes the bot (`first_bot_cancelled`); Create keeps it and opens `/bots/$botId` (`first_bot_kept`) (`first-bot-dialog.tsx:109-131`) | **Start from scratch** deletes the check-in routine this flow created, then the bot (`first_bot_cancelled`), and goes to `done`; **Say hello** keeps both (`first_bot_kept`) → `done`; **Take the tour** keeps them and starts the tour after completion (§8.3) | Parity + New (tour entry) |
| FB5 | — | Hatch: egg wobble ×3, squash, pop to the bot's look, seven confetti pieces for 2.4 s (canvas `OnboardMotion`) | New (F14) |
| FB6 | — | `done` (canvas `OnboardDone`): "You're set", **Message {bot}** → `/bots/$botId` with the shared-element flight, **New session** → `/sessions/new` | New |
| FB7 | Time-of-day greeting, new-session starters, bots home (`greeting.tsx`, `chat-panel.tsx:397-450`, `bots-home.tsx`) | owned by phases 3–4 (unchanged here) | Parity (other phases) |

### 2.3 Tour

| # | Today | New | Status |
|---|---|---|---|
| TR1 | react-tourlight provider, 4 stops, `waitForElementTimeout` 2000, transition 240 ms, overlay click ignored (`welcome-tour.tsx:36-204`) | `Spotlight` molecule (`components/spotlight/`) + `features/onboarding/tour/` with 12 stops (canvas `TourMap`) (§9) | Changed (PLAN "react-tourlight nuked"; canvas stops) |
| TR2 | Stop copy `tour.steps.{bots,makeBot,connectors,terminal}` | reused through the keymap for stops 2, 3, 6, 9; the canvas copy for the rest (§17) | Parity (copy) |
| TR3 | Target selectors `data-id="sidebar-lists"`, `bots-home-name-input`, `sidebar-nav-connectors`, `local-code-bottom-panel-toggle` (`tour-stops.ts:91-128`) | typed `data-tour` anchors on the new shell (`tourAnchor(id)`, §9.2); `bots-name-input` is 03 P45's | Changed (new shell) |
| TR4 | `prepare` steps (`showBotMaker` → `/bots/new`; terminal → `/sessions/new`) and `waitForBox` 2 s (`tour-stops.ts:45-89`) | `prepare(ctx)` per stop (navigate, open the floating sidebar, open a side-panel tab) and `waitForAnchor(id, 2000)`; a missing anchor degrades to a centred card, never an error (§9.3) | Parity |
| TR5 | Tooltip: "Step {current} of {total}", Back hidden on the first stop, Next → "Start working" on the last, X = skip, "Optional" badge + audience line (`tour-tooltip.tsx:54-154`) | same controls on the canvas card (340 px): Skip the tour, Back, Next / Start working, "Optional" badge on stop 9 (§9.4) | Parity |
| TR6 | Skip and finish both report (`tour_skipped`/`tour_done`), close, then navigate `/` with `newPaneIntent "bot"` (`welcome-tour.tsx:84-166`) | same funnel names; finish returns to where the tour started (or `/bots/$firstBotId`); `prefs.tour.status` records `done` or `skipped` (§9.5) | Parity + New (persisted completion) |
| TR7 | Replay: account menu "Take the tour" (`settings-menu.tsx:69,357-360`), gated on onboarded + account loaded (`welcome-tour.tsx:212-227`) | Settings › General "Take the tour" row (canvas `TourMap`) and command menu "Take the tour"; gated on `onboarded` (§9.5) | Changed (05 ST22 → here) |
| TR8 | Sign-out: `tour.signedOut()` closes it (`settings-menu.tsx:78-89`) | `tourSignedOut()` (05 §19.2 hook) ends an active tour without recording a status | Parity |
| TR9 | No persistence; replays freely | `prefs.tour.status` (`unseen`/`done`/`skipped`), only informational (the replay is always available) | New |

### 2.4 Notifications, notch, sound

| # | Today | New | Status |
|---|---|---|---|
| NT1 | Renderer notifies on NDJSON `permission_needed` / `turn_complete` when `!document.hasFocus()`, titles with emoji (`use-notifications.ts:11-59`) | 03 §17/04 §19.2 own the triggers; this phase adds `kind` and the notch suppression rule (§13) | Parity (phases 3–4) + Changed (F19) |
| NT2 | `showNotification` `silent: !prefs.sound`; click reveals the window and forwards metadata (`main/index.ts:1385-1403`) | silent in the new generation (05 §31.5 d); click unchanged (`system.events`) | Parity (05) |
| NT3 | "Task still running" notice when the window hides during a turn (`main/index.ts:366-383`) | unchanged in main; suppressed while a notch window is ready (the companion shows the work) (§13) | Changed (canvas `TourNotch` "Close the window and your bots keep going") |
| NT4 | No notch, companion, tray or badge (grep of `src`) | macOS notch companion per display, Windows capsule (§10–§12) | New (PLAN) |
| NT5 | No in-app sound (OS sound only) | cues synthesised in `lib/sound.ts` (03 §17, 05 §23) played by one owner (F18, §14) | Changed (PLAN Sound; phases 3/5) |
| NT6 | Dictation in the composer (`voice/use-dictation.ts`: push-to-talk, Whisper in the renderer, download progress, microphone permission) | `lib/voice/` port used by the composer `Dictate` slot and the notch (F7, §12.5) | Parity (ported) |
| NT7 | — | Settings › General "Notch companion"; Settings › Notifications "Show in the notch"; notch display and haptics options (§15) | New (canvas; 05 reserved) |

---

## 3. Dependencies

**No new packages.** The OSI-licence small-library rule (04 F2, §26.8: typed + ESM + maintained in the last 90 days + an OSI licence) is met by everything below; the two libraries PLAN named for this phase are gone: `react-tourlight` (nuked, replaced by our spotlight) and `tsparticles` (nuked, replaced by seven CSS pieces). `node-mac-notch` does not exist (F1).

| Package | Version | Used for | Verified |
|---|---|---|---|
| `electron` | 44.4.5 | `BaseWindow`, `WebContentsView`, `screen`, `powerMonitor`, `globalShortcut`, `Notification` | E:lines in the sources table; `type: "panel"`/`"toolbar"` values unverified in typings (F2, R6-T30, R6-T33) |
| `react` | 19.3.0 | `ViewTransition`, `addTransitionType`, `Activity` (the tour card keeps state while hidden between stops), `useEffectEvent` | `@types/react` lines in the sources table |
| `motion` | 13.4.6 | spotlight mask spring, hatch spring, presence of the notch body, `MotionConfig reducedMotion="user"` in the notch document | `framer-motion/dist/index.d.ts` lines in the sources table; R6-T37 type-checks imports |
| `@tanstack/react-router` + `router-plugin` | 1.170.40 / 1.168.41 | `createMemoryHistory` for the notch router; a **second** `tanstackRouter()` plugin instance generating `notchRouteTree.gen.ts` | per-call plugin context read in the compiled plugin (sources table); building two trees is **unverified** until R6-T1 builds both |
| `@tanstack/react-store` | foundation | `tourStore`, `notchUiStore` (hover lock, queued presentation, reply draft) | foundation §3.1 |
| `@tanstack/react-db` / `@tanstack/db` | 0.4.1 / 0.9.2 | `sessions`, `bots`, `prefs` in the notch document | 03 §3 |
| `@tanstack/react-form` + `valibot` | 1.33.5 / 1.5.0 | the onboarding key dialog (05's `ProviderKeyDialog` reused) | 03 F1 |
| `@huggingface/transformers` | ^4.3.0 (already a dependency, `package.json:96`) | `lib/voice/` (ported, F7) | the old renderer's `voice/whisper.ts` imports it lazily; renderer-next's CSP and bundle for it are **unverified** until R6-T27 |
| Registry atoms | foundation §5.2 | `dialog`, `button`, `dropdown-menu`, `input`, `field`, `kbd`, `spinner`, `toast`, `tooltip`, `badge` | no new atom |

Not used, with reasons: `react-tourlight` and any tour library (PLAN: our own spotlight); `tsparticles`/`canvas-confetti` (seven CSS pieces, canvas); any native addon for notch metrics (F1: JXA probe); `node-mac-notch` (does not exist); `electron-positioner` (the capsule's placement is 20 lines of pure geometry); xstate (the onboarding machine is a reducer of seven states).

---

## 4. Folder shape and public API

```
src/main/notch/                         (new)
├─ controller.ts                         NotchController: windows per display, reconcile, prefs, lifecycle (§10.3–§10.6)
├─ window.ts                             createNotchWindow(platform, placement) → { win, view } (§10.1, §10.8)
├─ metrics.ts                            probeNotchMetrics() (JXA, §10.2), parseProbe(), matchScreens() (pure)
├─ geometry.ts                           notchPlacement(), capsulePlacement(), windowBoundsFor(shape) (pure, §10.2, §10.8)
├─ interaction.ts                        setInteractive / focus-on-demand (§10.5)
├─ haptics.ts                            one-shot osascript per attention (§10.7)
├─ cue-arbiter.ts                        CueArbiter: the audible webContents and per-cue claims (§14.2)
├─ dispose.ts                            disposeNotchWindow() (idempotent, closes the WebContents) (§10.6)
└─ *.test.ts
src/main/rpc/procedures/notch.ts         the notch.* procedures (§10.10)
src/preload/index.ts                     dispatcher: `--abacus-window=notch` → notch-preload.ts, else main-preload.ts (today's body, unchanged) (§10.1)
src/preload/notch-preload.ts             handshake with kind "notch" only: no window.api, no abacusHost, no renderer-state snapshot
src/shared/contract/notch.ts             (new) contract group `notch` (§10.10)
apps/desktop/notch.html                  third Vite input (§11.1)
src/renderer-next/
├─ notch.tsx                             notch boot (§11.1)
├─ notch-router.tsx                      createNotchRouter(boot): memory history, context, no preload
├─ notch-routes/                         __root, idle, working, approval.$id, reply.$id, call, done, failed (§5.4)
├─ notchRouteTree.gen.ts                 generated, committed
├─ components/
│  ├─ spotlight/                         Spotlight.Root/Mask/Card, placeCard() (pure), waitForAnchor() (§9.3–§9.4)
│  ├─ confetti/                          Confetti (seven CSS pieces, 2.4 s, none under reduced motion) (§8.2)
│  └─ bot-avatar/                        (phase 3, reused; gains the `egg` hatch sequence as a `hatch` prop, §8.2)
├─ features/onboarding/
│  ├─ index.ts                           public API (below)
│  ├─ machine.ts                         steps, transitions, resumeStep(), stepsFor() (pure, §6)
│  ├─ gate.ts                            needsOnboarding(), onboardingTarget() (pure, §5.2)
│  ├─ actions.ts                         enterStep(), completeOnboarding(), funnel names (§6.5–§6.6)
│  ├─ steps/                             welcome.tsx connect.tsx connected.tsx models.tsx connectors.tsx first-bot.tsx done.tsx (§7–§8)
│  ├─ frame/                             onboarding-frame.tsx progress-pill.tsx parade.tsx (§7.1)
│  ├─ tour/                              stops.ts tour-host.tsx tour-store.ts tour-actions.ts (§9)
│  ├─ parity.ts  gallery/sections.tsx
├─ features/notch/
│  ├─ index.ts
│  ├─ shell/                             notch-shell.tsx (shape, wings, body), wings.tsx, body.tsx, faces.tsx (§11.5)
│  ├─ presenter.ts                       presentNotch(inputs) → NotchPresentation (pure, §11.4)
│  ├─ director.ts                        NotchDirector: presentation → navigation, hover lock, queue (§11.6)
│  ├─ inputs.ts                          useNotchInputs(): tables + notices + cached descriptors (§11.3)
│  ├─ views/                             idle.tsx working.tsx approval.tsx question.tsx reply.tsx listening.tsx done.tsx failed.tsx hover-actions.tsx
│  ├─ shape.ts                           SHAPES (canvas sizes) and shapeFor(presentation) (pure, §11.5)
│  ├─ sound.ts                           the notch document's player (§14.3)
│  ├─ parity.ts  gallery/sections.tsx
└─ lib/
   ├─ attention/                         botAttention, moodFor, sessionAttention (moved from 03/04, F22)
   ├─ tour/anchors.ts                    TOUR_ANCHORS, tourAnchor(id), TourAnchorId (§9.2)
   ├─ run-finished.ts                    runFinishedFeed(): the one `ai.runFinished` subscription per document (moved from 03's sidebar module, F4)
   └─ voice/                             recorder.ts whisper.ts use-dictation.ts (ported, F7, §12.5)
```

Rules (foundation §4; R6-T38 checks them): features import `components/`, `ui/`, `data/`, `lib/`, `#shared/*`, never another feature; `features/notch` and the `notch-routes/` tree never import `features/shell`, `lib/window-chrome/*` or anything of the title-bar contract (window-chrome §6 L85); the notch document imports `features/chat` only through its `index.ts` (02 R2-T30) and only in `notch-routes/` (routes compose); `components/spotlight` imports no `data/` and no feature; `src/main/notch/*` imports nothing from `src/main/window-chrome-*` or `startup-theme.ts` except `themedBackground` (none: the notch is transparent).

Public APIs (named exports only):

```ts
// features/onboarding/index.ts
export { OnboardingFrame, WelcomeStep, ConnectStep, ConnectedStep, ModelsStep, ConnectorsStep, FirstBotStep, DoneStep } from "./steps";
export { needsOnboarding, onboardingTarget, resumeStep, ONBOARDING_FLOW } from "./machine";
export { completeOnboarding } from "./actions";
export { TourHost, startTour, tourSignedOut, useTourState } from "./tour";   // TourHost: a shell global (features/shell/sidebars.ts `globals`)
export { onboardingGallerySections } from "./gallery/sections";
// features/notch/index.ts
export { NotchShell, NotchDirector, IdleView, WorkingView, ApprovalView, ReplyView, ListeningView, DoneView, FailedView } from "./…";
export { notchGallerySections } from "./gallery/sections";
// lib/tour/anchors.ts
export type TourAnchorId = (typeof TOUR_ANCHORS)[number];
export function tourAnchor(id: TourAnchorId): { "data-tour": TourAnchorId };
```

---

## 5. Routes

### 5.1 Onboarding files (`src/renderer-next/routes/_bare/`)

**(f)** rows exist as phase 1 placeholders; **(a)** amend the foundation (§23.1); **(n)** are new.

| File | Path | Responsibility |
|---|---|---|
| `_bare.tsx` (f) | pathless | unchanged (drag strip, `<Outlet/>`); readiness stays root-owned (R1-T20) |
| `_bare/onboarding.tsx` (n) | `/onboarding` layout | `beforeLoad`: `const account = await ensureQueryData(accountStateQuery)`; `account.onboarded` → `throw redirect({ to: "/bots/new", replace: true })` (a finished user never sees onboarding again, even by URL). Loader: `await Promise.all([prefs.preload(), bots.preload()])` (first-bot needs `bots`; loaders await their own preload, 03 review #1). Component: `<OnboardingFrame>` with `<Outlet/>` wrapped in the step view transition (§16). |
| `_bare/onboarding.index.tsx` (f → a) | `/onboarding/` | redirect → `/onboarding/$step` with `resumeStep(prefs.onboardingStep)` (was: always `welcome`) |
| `_bare/onboarding.$step.tsx` (f) | `/onboarding/$step` | `params.parse` against `ONBOARDING_STEPS` (unchanged); `beforeLoad`: `guardStep(step, facts, onboardingStore.signIn)` (§6.2) redirects an unreachable step with `replace` (a cold `connect` with no live sign-in attempt → `welcome`; `connected` while signed out → `welcome`); loader: step data (§5.3); component: the step's organism from `features/onboarding` with the route-composed pieces (§7.5–§7.6). There is **no** model prerequisite on any step (review #5): a user may reach `first-bot` and `done` with no provider and no local model. |

`_shell.tsx` (a): `beforeLoad` gains the gate (§5.2).

### 5.2 The gate (`features/onboarding/gate.ts`)

```ts
export function needsOnboarding(account: AccountState): boolean;          // !account.onboarded (F9)
export function onboardingTarget(prefs: PrefsRow): { to: "/onboarding/$step"; params: { step: OnboardingStepId } };
```

`_shell.tsx` `beforeLoad: async ({ context }) => { const account = await context.queryClient.ensureQueryData(accountStateQuery(context.transport.orpc)); if (needsOnboarding(account)) throw redirect({ ...onboardingTarget(context.collections.prefs.get("app") ?? DEFAULT_PREFS), replace: true }); }` (prefs are ready before the router exists, foundation §8.6). The gate also finishes an interrupted completion: when `account.onboarded` is true and `prefs.onboardingExit` is not null, `_shell`'s `beforeLoad` runs the idempotent tail of `completeOnboarding` (§6.5) once per document and redirects to the persisted target. `accountStateQuery` has `staleTime: Infinity`, is seeded by `bootstrap()` (a fourth step after prefs, 2 s timeout, failure → treat as onboarded so an unreachable account file never locks the user out; the error is logged) and invalidated by `completeOnboarding` and `account.*` mutations. The redirect happens before the shell renders, so there is no flash. Deep links from notifications into the shell of a not-yet-onboarded user land on onboarding (acceptable: a new user has no sessions to open).

### 5.3 Onboarding loaders

| Step | Loader (enter/stay) | On `preload` (hover) |
|---|---|---|
| `welcome` | `auth.abacus.browserProfiles` via `ensureQueryData` (parity OB9: only here) | none (no link to it is ever hovered) |
| `connect` | none; the sign-in call is started by the click on `welcome`, not by the route (§6.4) | none |
| `connected` | `account.abacus({ refresh: true })` (tier decides the models step) | none |
| `models` | `settings.keys.listProviders`, `localModels.state` (05 §20.5) | none |
| `connectors` | `connectors.statuses` | none |
| `first-bot` | `bots.preload()`, `routines.preload()`; the template bot is created by the **component** on mount of the step (not a loader), through the synchronous pending state of §8.1 | none |
| `done` | `bots.preload()` | none |

No loader starts a sign-in, opens a window, creates a bot or connects anything (R6-T3). Every such action is a click.

### 5.4 Notch route tree (`src/renderer-next/notch-routes/`, memory history)

| File | Path | Params / search | Loader | Renders |
|---|---|---|---|---|
| `__root.tsx` | root | — | none (boot resolved transport, prefs, sessions, bots) | `NotchShell` (shape, wings) + `<Outlet/>` in the body; `NotchDirector`; readiness (`window.ready` once the three tables are ready) |
| `idle.tsx` | `/idle` | — | — | `IdleView` (faces, dot, count; nothing when idle is hidden) |
| `working.tsx` | `/working` | `session?: SessionId` | — | `WorkingView` (face + caption left, progress right) |
| `approval.$id.tsx` | `/approval/$id` | `$id` = session id; `ask?: string` (a connector ask id) | none: the director navigates only after its own bounded load (§11.6); with `ask` no thread is loaded | `ApprovalView`, `QuestionView`, or `ConnectorAskView` when `ask` is set (§12.8) |
| `reply.$id.tsx` | `/reply/$id` | `$id` = session id; `focus?: true` | none (as above) | `ReplyView` (last assistant text, reply field) |
| `call.tsx` | `/call` | `session: SessionId`; `from: "reply" \| "hover"` | — | `ListeningView` (waveform, timer, End) |
| `done.tsx` | `/done` | `session: SessionId` | — | `DoneView` |
| `failed.tsx` | `/failed` | `session: SessionId`; `code?: string` | — | `FailedView` |

- `createRouter({ routeTree: notchRouteTree, history: createMemoryHistory({ initialEntries: ["/idle"] }), defaultPreload: false, context })`; then `installTransitionTypes(notchRouter, notchNavTypes)` (the foundation's implemented mechanism, §6.7 impl amendment): the router's document-level transition carries `notch-expand` / `notch-contract` / `notch-swap` from the navigation intent the director sets, and an untyped commit animates nothing. Nothing in the notch is hovered for navigation (the director navigates), so there is no preloading; the routes have no loaders.
- Every navigation is `replace: true` (the notch has no back stack; memory history stays one entry deep).
- Unknown path → `/idle` (`notFoundComponent` redirects). A `$id` whose session vanished (deleted) → the director's next presentation replaces it; the route renders nothing meanwhile (no error boundary).
- Params use `SessionId` from `#shared/contract/ids` (valibot parser), search fields fall back as foundation §6.2.

### 5.5 Not found, gone while open

- `/onboarding/<unknown>`: the foundation's `params.parse` throws → `notFoundComponent` of `_bare` redirects to `/onboarding/` (resume).
- The first bot deleted elsewhere while `first-bot` is open: the card shows "This bot was removed." and the step offers **Continue** to `done` (no re-creation loop).
- Tour anchors that vanish mid-stop (a sidebar collapses): the mask re-measures; a rect of 0 × 0 or a detached element turns the stop into a centred card (§9.3).

---

## 6. Onboarding state machine and data (`features/onboarding/machine.ts`, `actions.ts`)

### 6.1 Steps, events and transitions (pure)

```ts
export const ONBOARDING_FLOW = ["welcome", "connect", "connected", "models", "connectors", "first-bot", "done"] as const;   // = ONBOARDING_STEPS
export const ONBOARDING_FLOW_VERSION = 2;
export interface FlowFacts {
  signedIn: boolean;            // settings.get → canSignOutOfAbacus (a stored Abacus key)
  payingTier: boolean;          // isPayingAbacusTier(account.abacus) (parity OB4)
  ownsBot: boolean;             // a bot with channel == null exists (parity FB2)
}
export type AttemptId = string;  // crypto.randomUUID(), minted synchronously on the click
export type FlowEvent =
  | { type: "sign-up"; attempt: AttemptId } | { type: "sign-in"; attempt: AttemptId; profileId?: string }   // welcome → connect
  | { type: "skip" }                                                     // welcome or connect (cancels a live attempt) → models
  | { type: "auth-ok"; attempt: AttemptId } | { type: "auth-cancelled"; attempt: AttemptId }
  | { type: "auth-failed"; attempt: AttemptId; code: AbacusAuthError }
  | { type: "retry"; attempt: AttemptId }                                // connect after a failure: a new attempt
  | { type: "next" } | { type: "back" }
  | { type: "tour" };                                                    // first-bot: complete, then the tour
export function next(step: OnboardingStepId, event: FlowEvent, facts: FlowFacts, live: AttemptId | null): OnboardingStepId | "complete" | "ignore";
```

| From | Event | To |
|---|---|---|
| `welcome` | `sign-up` / `sign-in` | `connect` (the click also starts the attempt, §6.4) |
| `welcome` | `skip` | `models` (F9) |
| `connect` | `auth-ok` (attempt = live) | `connected` |
| `connect` | `auth-cancelled` (attempt = live) | `welcome` (quiet) |
| `connect` | `auth-failed` (attempt = live) | stays, error line + **Try again** (§6.4) |
| `connect` | `retry` | stays, a new live attempt |
| `connect` | `skip` | `models` (the live attempt is cancelled first) |
| `connect` | `back` | `welcome` (the live attempt is cancelled first) |
| any | an `auth-*` whose `attempt` ≠ live | `ignore` (a superseded attempt's outcome never moves the flow, review #4) |
| `connected` | `next` | `models`, or `connectors` when `payingTier` (parity OB4) |
| `models` | `next` | `connectors` (no model is required, review #5) |
| `models` | `back` | `connected` when signed in, else `welcome` |
| `connectors` | `next` | `first-bot`, or `done` when `ownsBot` (parity FB2, `first_bot_skipped` detail `has_bots`) |
| `connectors` | `back` | `models` (or `connected` on a paying tier) |
| `first-bot` | `next` (Say hello / Start from scratch) | `done` |
| `first-bot` | `tour` | `complete` (target: the bot, then the tour) |
| `done` | `next` (either button) | `complete` |

Every other (step, event) pair is `ignore`. R6-T4 is a table test over every row, every `FlowFacts` combination and every pair that must be ignored.

### 6.2 Guards (`guardStep`)

`guardStep(step, facts, doc: { signIn: SignInAttempt | null; createdBotId: string | null })` (pure) returns the nearest valid step for a direct URL, a stale resume or a navigation inside the flow. `doc` is this document's onboarding store (review r2 #5, #6):

- `connect` is valid while this document holds a sign-in attempt that is `pending` **or** `failed` (the failed attempt is retained so the error and **Try again** stay on screen through any revalidation, review r2 #6). A cold `connect` — no attempt in this document (a restart, a deep link) or a `cancelled`/`succeeded` one — → `welcome`.
- `connected` when not signed in → `welcome`.
- `first-bot` when `ownsBot` and `createdBotId === null` → `done`. A bot this document created (`createdBotId`, set synchronously when the creation starts, §8.1) keeps the step valid through its optimistic insert and its persistence echo, when `ownsBot` becomes true.
- Everything else is valid.

The `$step` route's `beforeLoad` redirects with `replace` when the guard differs. R6-T7 drives the **real router** through: welcome click → pending attempt → `connect` renders (not redirected); cancel → `welcome`; a restart during the attempt → `welcome`; a late `ok` from a cancelled attempt → ignored.

### 6.3 Resume after restart

`onboardingStep` is written on **entering** each step together with `onboardingFlow` (`updatePrefs({ onboardingStep: step, onboardingFlow: 2 })`, a patch, so both are `user` provenance and a later legacy import cannot move them, spec 00 notes). Spec 00 C.4's migration and live legacy sync write **only canonical ids** (F10: `auth → welcome`, `welcome → connected`, `connectors → connectors`, `models → models`, `explainer → first-bot`) with `onboardingFlow = 2` (amendment §23.6). So:

```ts
export function resumeStep(stored: { step: string | null; flow: number | null }): OnboardingStepId;
```

| Stored | Resume at |
|---|---|
| `flow !== 2` or `step === null` | `welcome` |
| `connect` | `welcome` (an attempt does not survive a restart) |
| a new id | itself, then `guardStep` |
| anything else | `welcome` |

R6-T5 checks the table and, in main, that the same stored string `"welcome"` arriving from the legacy import becomes `connected` while `"welcome"` written by renderer-next stays `welcome` (the import canonicalises before writing).

### 6.4 Sign-in attempts (`welcome` → `connect`)

```ts
interface SignInAttempt { id: AttemptId; intent: "signup" | "signin"; profileId: string | null; status: "pending" | "cancelling" | "failed" | "cancelled" | "succeeded"; error: AbacusAuthError | null; promise: Promise<AbacusAuthOutcome> }
```

- The click mints `id` and stores the attempt in `onboardingStore.signIn` **synchronously** (so the `connect` guard sees it on the same navigation), then calls `auth.abacus.start({ intent, browserProfileId? })` and navigates to `connect`. The button is disabled while an attempt is pending; a double click starts nothing.
- When the promise settles, the attempt's `status` becomes `succeeded`, `failed` (with `error`) or `cancelled`, and the outcome is dispatched with the attempt's `id`; `next()` ignores it unless `id` is still the live attempt (review #4). Cancel (Cancel, Back, Skip, leaving onboarding) sets `status: "cancelling"`, calls `auth.abacus.cancel()`, and clears the live attempt, so whatever the old promise returns later is ignored.
- **Try again** after a failure starts a new attempt (new id) with the same intent; **Sign in another way** cancels the live attempt and starts one without a profile (parity); **Use my browser instead** → `auth.abacus.openInBrowser()` for the live attempt (parity).
- Outcomes (`AbacusAuthOutcome`, typed output, never an error, spec 00 A.5): `{ ok: true }` → `auth-ok`; `{ ok: false, cancelled: true }` → `auth-cancelled`; `{ ok: false, error: "unidentified-account" }` → the parity line "Couldn't verify which account this key belongs to. Nothing was saved. Please try signing in again."; any other `error` code → "Sign-in didn't finish. Try again, or use your browser instead.". The UI never parses messages (review class 36).
- After `auth-ok`: invalidate `account.*`, `settings.get`, `models.list` (parity: credential cache, `listModels(true)`, `getAbacusAccount(true)`). Main already brings the app to the front on success (`abacus-auth-service.ts:240-247`).
- `connect` shows the waiting row (F11): one spinner, "Finish signing in, then come back here", the profile line when a profile was picked; the avatar carries the waiting face.

### 6.5 Completion (`completeOnboarding`, resumable)

```ts
type OnboardingExit =
  | { to: "bot"; botId: string; edit?: true } | { to: "new-session" } | { to: "new-bot" }
  | { to: "bot-tour"; botId: string };
```

1. `await updatePrefs({ onboardingExit: exit })`: the target is persisted **before** anything commits.
2. `await account.skipOnboarding()` (writes `onboarded: true`; repeating it writes the same value; the name is historical, spec 00 A.2.2 row 19) → set the `accountStateQuery` cache from its result.
3. `system.funnelStep({ step: "onboarding_done", once: true })` **after** step 2 succeeded (review r2 #4). The new `once` input makes main call its existing `reportFunnelStepOnce` (`funnel-beacon.ts:83`, persisted "seen" file) instead of `reportFunnelStep`, which sends every call; entering the `done` step no longer reports `onboarding_done` (OB14 amended).
4. `await updatePrefs({ onboardingStep: null })` (non-blocking for the user: a failure is retried on the next tail run).
5. Navigate to the exit (bot → `/bots/$botId` with the shared-element flight, §16; `edit` → `/bots/$botId/edit`; new session → `/sessions/new`; new bot → `/bots/new`; `bot-tour` → the bot). **The exit is cleared only when the destination has committed** (review r2 #3): the router's `onResolved` for that location, then `updatePrefs({ onboardingExit: null })`. For `bot-tour` the exit is cleared only after `startTour` has set `tourStore.active` on the bot route; a quit before that resumes on the bot and starts the tour.
6. **Resume**: whenever `account.onboarded` is true and `onboardingExit` is set, `_shell`'s gate reruns steps 3–5 once per document (each idempotent: the funnel is once-only in main, the prefs writes are same-value patches, navigation lands on the same place). If step 2 fails, the user stays on the step with "Couldn't finish setting up. Try again."; **Try again** reruns from step 1.

The messaging pairing queue (§7.6) is independent of the exit target: it is drained by the shell after the exit has committed. R6-T6 fails each call in turn and kills the app at every boundary (after 1, 2, 3, 4, after navigation starts, after it commits, after the tour starts), asserting the user always ends on the chosen target (with the tour running for `bot-tour`), `onboarded: true`, the exit and step cleared, and `onboarding_done` sent exactly once.

### 6.6 Funnel

`enterStep(step)` calls `system.funnelStep` with the existing names (OB14); `first-bot` reports `first_bot_shown`, `first_bot_kept`, `first_bot_cancelled`, `first_bot_skipped` (detail `has_bots`, `no_template`, `create_failed`); the tour reports `tour_done`/`tour_skipped` (TR6). No new names (the list is fixed so nothing else leaves the machine, `shared/funnel.ts:1-5`).

---

## 7. Onboarding pages (`features/onboarding/steps/`, canvas page 11)

### 7.1 Frame (`OnboardingFrame`)

- Full window, `bg-background` with the canvas's radial wash (`radial-gradient(900px 500px at 50% -10%, color-mix(in oklch, var(--primary) 18%, transparent), transparent 60%)`, computed from tokens so light theme works), content centred in a column `max-width: 640px`, `padding: 0 40px 40px`, scrolling inside when the window is 800 × 600 (the minimum, `index.ts:604-621`).
- The foundation's `_bare` drag strip is the title bar; the **progress pill** sits at its right end before `--titlebar-end` (canvas: five marks 6 × 6, gap 6, active 20 × 6, done `--muted-foreground`, future `--border`; width animates 300 ms). Marks: 1 welcome, 2 connect/connected, 3 models, 4 connectors, 5 first-bot/done. `role="progressbar"`, `aria-valuenow` = mark, `aria-valuetext="Step {n} of 5"`.
- Buttons: primary 44 px radius 12 (registry `Button` size `lg` with the canvas radius through `className`), secondary `variant="secondary"`, tertiary `variant="ghost"` 32 px 13 px text.
- Enter animation per step: children rise 12 px and fade, staggered 80 ms (canvas `.rise d1…d5`); between steps the step VT (§16).

### 7.2 `welcome` (canvas `OnboardWelcome`)

Parade of five `BotAvatar`s (bunny/pink/bow/happy 56, blob/green/wink 72, mochi/blue/glasses/idle 88, cat/orange/love 72, star/yellow/crown/excited 56) bobbing 3.2 s staggered 0.4 s, decorative (the canvas's "welcome → shell" flight happens from the `done` step, whose centre avatar is the first bot, §7.7 and §16, because `welcome` never goes straight to the shell); "AbacusAI Bot" 40/48 700; "Open Source Agent And AI Co-Worker" 17/24; four pills (dot + label): "Free forever", "100+ AI models", "100+ connectors", "Persistent memory" (parity capabilities + badge, OB7); **Sign up for free** (primary), **I already have an account** (secondary; when `browserProfiles` has a default profile the label is "I already have an account · Continue with {browser}" with a chevron `DropdownMenu` listing each profile "Continue with {browser} · {profile}" and "Sign in another way", parity); **Skip for now** (tertiary). The parity hint "Google, Microsoft and Apple sign-in use your {browser} accounts." shows under the buttons when a default profile exists.

### 7.3 `connect` (canvas `OnboardConnect`)

Avatar 88 (`blob` green, `waiting`), "Sign in to Abacus.AI in your browser" (28/36), "Your browser opens to sign in, or create an account. The app gets its own API key; your password never touches it." (max 460), the waiting row (§6.4), tertiary row "Use my browser instead · Sign in another way · Skip for now", error line when present (`role="alert"`).

### 7.4 `connected` (canvas `OnboardConnected`)

Avatar 96 `happy` with a 26 px check badge, "Abacus.AI is successfully connected" (success tone), "Welcome to AbacusAI Bot" 34/42, a 2 × 2 grid of the four promises (parity OB10 strings), **Get started** → `next`.

### 7.5 `models` (canvas `OnboardModels`, `OnboardKeyDialog`)

Rows (640 wide, 14 px radius, `bg-muted`, 1 px `--success` border when connected). A provider is **connected** when `models.list` has a configured model of that provider **or** `settings.keys.listProviders` includes it (parity: environment keys count, `provider-setup-step.tsx:88-105`, review #9); both queries are invalidated by `settings.events { credentials-changed }` and after every save or hop.

| Row | State source | Action |
|---|---|---|
| Abacus.AI "Get world-class models free · 2000 free credits" | signed in → "Connected" | signed out → **Connect** starts a sign-in attempt exactly as §6.4 (its own attempt id; the outcome only updates this row, never the step; parity `provider-setup-step.tsx:124-139`) |
| OpenRouter "Unlock FREE models with one connection" | the connected rule above | **Connect** → `auth.openRouter.start()` (browser hop; Cancel → `auth.openRouter.cancel()`; parity) |
| Gemini "Use Gemini free to create anything" | the connected rule above | **Add key** → `ProviderKeyDialog` (05 §20.4, passed in by the route): "Go to Gemini and get your API key", **Open Gemini** (`system.openExternal` to the provider's console URL from `PROVIDER_KEY_FIELDS`), masked input, `isPlausibleApiKey` → "That doesn't look like an API key. Check the paste for a stray line or URL." (parity `onboarding.setupKeyInvalid`), "Stored on this machine only.", Save → `settings.keys.save` |
| This computer "Run a model on this computer · {model}, {size}, no account" (F12) | `localModels.state` (05 §20.5) | **Download** / progress / **Ready**, the recommended model from 05's catalogue; the row is 05's `LocalModelRow` passed in by the route |

Below: "Existing subscriptions — Bring your paid models and tools into one place" (parity inert copy) with **Connect later** (= `next`) and **Paste a key** (opens the provider picker: the "Many more" providers of parity OB11 in a `DropdownMenu`, then the key dialog). **Continue** is always enabled: a user may finish onboarding with no provider and no local model (review #5); the composer's model picker explains later. R6-T8 walks Skip → models Continue → connectors Continue → first bot → done with nothing configured. Leaving the step cancels both handshakes (parity `provider-setup-step.tsx:114-120`).

### 7.6 `connectors` (canvas `OnboardConnectors`)

"Connect with your tools & services." (accent on the second half), "Chat where you work. Attach the ones you use and the agent can read, draft and act in them, asking first." A 3-column grid of the registry's `onboarding: true` entries in registry order (F13: WhatsApp, Telegram, Discord, Gmail, Google Drive, Google Calendar, Slack, Outlook, OneDrive, Jira, Confluence, Dropbox), each `ConnectorMark` 28, name, **Connect** / "Connected"; tiles whose status reason is `not-offered` hidden (parity); **Many more…** reveals every other `kind: "platform"` entry (parity). R6-T8 asserts every connector the old step offered is reachable.

Connect is `useConnectFlow().start(id, { pairing: "defer" })` passed by the route (amendment §23.5 to 05 §12.4):

- **Platform, fields, none**: 05's flow unchanged (hop with the 3 min watchdog, fields dialog). One onboarding rule: a hop in flight is **cancelled** when leaving the step (parity OB12; 05's flow otherwise survives navigation).
- **Messaging** (`pairing`): with `pairing: "defer"` the flow runs `connectPlatform(platform)` (enables the platform), appends the platform to the persisted queue `prefs.onboardingPairing` (a leaf, `MessagingPlatform[]`, deduplicated), and settles `{ ok: false, deferred: true }` **without navigating**. The tile reads "Finish linking after setup".
- **Draining**: after completion, a shell global `PairingQueueBanner` shows one toast per queued platform in queue order, "Finish linking {platform}" with **Link now** → `/library/messaging?platform=<p>`; the platform leaves the queue when `messaging.snapshot` reports it connected (`isMessagingPlatformConnected`, 05 §12.4) or the user dismisses the toast. The queue survives restarts (prefs). It never competes with the exit target (§6.5): the exit navigation happens first and the toasts follow; a tour started from the exit suppresses the toasts until it ends.

**Continue** / **Continue without connectors** (label by whether anything connected or queued, parity).

### 7.7 `done` (canvas `OnboardDone`)

Three avatars (the first bot 80 `excited` in the centre, two neighbours 56), "You're set", "{bot} is checking your calendar. Say hello, or start a session in a folder." (the middle clause only when the bot has a check-in; else "Say hello, or start a session in a folder."), **Message {bot}** (primary) and **New session** (secondary). Confetti plays once on entry (§8.2). Without a first bot (skipped): the parade of `welcome`, "You're set", **New bot** and **New session**.

---

## 8. First bot (`features/onboarding/steps/first-bot.tsx`, canvas `OnboardFirstBot`)

### 8.1 Creation

```ts
type FirstBotState =
  | { state: "pending"; clientId: string; promise: Promise<FirstBotResult> }   // set synchronously before the call (review #8)
  | { state: "ready"; botId: string; checkInRoutineId: string | null }
  | { state: "skipped"; reason: "has_bots" | "no_template" | "create_failed" }
  | { state: "removed" };
```

`onboardingStore.firstBot` is written **synchronously** on the first mount of the step, before any await: the client id is minted (`crypto.randomUUID()`) and stored as `onboardingStore.createdBotId` (the guard's input, §6.2), the creation promise is started and stored, then the component awaits it. Any remount (Strict Mode double mount, a navigation away and back) reads the same entry and awaits the same promise, so exactly one bot is created per document.

1. `ownsBot` (a bot with `channel == null`) → `skipped: has_bots` → `done`. This also covers a restart in the middle of the step: the bot created before the restart is an own bot, so the step is skipped rather than creating a second Chief of Staff (the old flow re-armed nothing after a restart either; its flag was in memory, `app.tsx:96-108`).
2. `createBotFromTemplate("chief-of-staff", { id: clientId, checkIn: { preset: "weekdays", time: "08:00" } })` (03 §5.6, contract §23.3). The check-in exists **because the canvas board `OnboardFirstBot` shows it** ("Checks in weekdays at 8:00 · Gmail, Calendar"; coordinator decision #7). `NOT_FOUND` (no template) → `skipped: no_template`; a failed bot insert → `skipped: create_failed` with the toast "Couldn't create your first bot. You can make one any time." (parity: failure skips).
3. **Partial failure**: the bot is persisted but the check-in insert fails → `ready` with `checkInRoutineId: null`; the card reads "No check-ins" (Off, the old default) and nothing retries; the funnel still reports `first_bot_shown`.
4. Success → `ready`, `first_bot_shown`, the hatch plays.

### 8.2 Hatch and confetti

- `BotAvatar` gains a `hatch?: { from: "egg"; onDone(): void }` prop (amendment §23.3): the avatar renders the `egg` shape in the bot's colour at 112 px with a 220 px radial glow pulsing 2 s, wobbles 3 cycles of 220 ms (±6°), squashes to `scaleY 0.9`, then swaps to the bot's resolved look (`resolveLook`, F14) popping to 1.08 and settling with a `motion` spring (`damping: 0.6` expressed as `{ type: "spring", stiffness: 420, damping: 18 }`, the canvas's "0.6 damping" re-expressed in `motion` terms and marked provisional), then `onDone`.
- `Confetti` (`components/confetti`): seven 8 × 12 pieces radius 2 in the palette colours, 2.4 s `translateY(-20px → 140px) rotate(0 → 320deg)` fade in/out, staggered 0–0.8 s, `aria-hidden`, removed after one run (canvas "then gone"). Reduced motion: hatch is a 120 ms cross-fade from egg to look, confetti skipped (canvas `OnboardMotion`).

### 8.3 The step

"We made your first bot for you" (28/36), "{name} runs your workday across Gmail, Calendar and Slack. Rename it, restyle it, or start from scratch." (the template's description, i18n'd, not hard-coded), the bot card (avatar 40 `wink`, name, the check-in summary from 03 §10.1 — "Checks in weekdays at 8:00" — or "No check-ins", then the template's connectors), and:

- **Edit** → sets the exit `{ to: "bot", botId, edit: true }` and completes (§6.5).
- **Say hello** (primary) → `first_bot_kept` → `done`.
- **Take the tour** (secondary) → `first_bot_kept` → exit `{ to: "bot-tour", botId }`, complete.
- **Start from scratch** (tertiary) → **persistence-only deletion** (review r2 #7, #8), not 03's `deleteBot` (which navigates away before deleting, 03 §5.5/§6.4): `await routinesCollection.delete(checkInRoutineId).isPersisted.promise` (when a check-in was created). **Already gone counts as done** (review r3 #6): if `routinesCollection.has(checkInRoutineId)` is false the delete is skipped; a synchronous `DeleteKeyNotFoundError` (installed `@tanstack/db` `errors.d.ts:91`, thrown before any transaction when the row is locally absent, e.g. deleted elsewhere or echoed between attempts) and a server `NOT_FOUND` are both treated as a completed deletion. The bot delete follows the same rule, **then** `await botsCollection.delete(botId).isPersisted.promise` (both from `#next/data/db`; `isPersisted.promise` is the transaction's persistence, `@tanstack/db` `transactions.d.ts:35-90`). So no ordinary routine outlives the bot, and the step never navigates while `onboarded` is false. `first_bot_cancelled` → `done` without a bot. A rejection of either shows "Couldn't remove it. Try again." and stays on the step; a retry repeats only what did not persist. R6-T9 holds and rejects the real transactions, and covers a routine already absent locally and one deleted elsewhere between two attempts.

---

## 9. The tour (`components/spotlight/`, `features/onboarding/tour/`, `lib/tour/anchors.ts`)

### 9.1 Shape

- **Run state** is ephemeral: `tourStore = new Store<{ active: null | { stopIndex: number; origin: string; startedAt: number } }>` (PLAN "spotlight step → TanStack Store"). A renderer reload ends a running tour silently.
- **Completion** persists: new prefs group `tour: { status: "unseen" | "done" | "skipped"; at: number | null }` (§23.5), written with `updatePrefs(patch)`. It is informational: the replay is always available; nothing auto-starts the tour after onboarding except the first-bot button.
- `TourHost` is a shell global (listed in `features/shell/sidebars.ts` `globals`, 04 §26.1), so the tour exists only under `_shell` (never over onboarding).

### 9.2 Anchors

`lib/tour/anchors.ts` exports `TOUR_ANCHORS` (a readonly tuple) and `tourAnchor(id)` returning `{ "data-tour": id }`, so every anchor id is typed at its call site. Owners place them (amendments §23.1–§23.4):

| Anchor id | Placed by | Element |
|---|---|---|
| `rail-bots-sessions` | foundation `Rail` | a wrapper around the Bots and Sessions rail buttons (one rect, canvas mask 48 × 104 at `left 4, top 44`) |
| `bots-name-input` | 03 §8.1 (exists, P45) | the name pill |
| `sessions-sidebar` | 04 `SessionsSidebar` | the sidebar root |
| `new-session-composer` | 04 new-session page | the centred composer |
| `rail-library` | foundation `Rail` | the Library rail button |
| `library-connectors` | 05 `ConnectorsPage` | the page's list |
| `composer` | 02 `ChatView` | the composer root (bot skin) |
| `panel-changes` | 04 side panel | the Changes tab content |
| `topbar-panel-tabs` | foundation `TopBar.PanelTabs` | the tab list |
| `settings-memory` | 05 settings sidebar | the Memory nav row |
| `rail-artifacts` | foundation `Rail` | the Artifacts rail button |

R6-T14 renders the shell, each area and each page in turn and asserts every `TOUR_ANCHORS` id is placed exactly where the table says (a missing id fails the build of the tour, not the tour at run time).

### 9.3 Stops (`tour/stops.ts`, canvas `TourMap`)

```ts
interface TourStop {
  id: "welcome" | "rail" | "make-bot" | "workspaces" | "start-session" | "connectors" | "talk" | "changes" | "preview-terminal" | "memory" | "artifacts" | "notch";
  anchor: TourAnchorId | null;                  // null = centred card
  prepare?(ctx: TourCtx): Promise<void>;        // navigation/panels, awaited before measuring
  optional?: true;                              // "Optional" badge
  available?(ctx: TourCtx): boolean;            // false = the stop is left out (numbering follows)
}
```

| # | Stop | `prepare` | Anchor | Copy (title / body) |
|---|---|---|---|---|
| 1 | welcome | — | none (centred) | "Welcome" / "A quick lap around the window. {n} short stops, skip any time." |
| 2 | rail | navigate `/bots/new` if the area is not bots/sessions | `rail-bots-sessions` | "Your bots & sessions" / "Two kinds of work." + the two bullet lines (canvas `TourRail`; parity `tour.steps.bots.*`) |
| 3 | make-bot | navigate `/bots/new` | `bots-name-input` | "Make a bot" / "Name one, or start from a template." |
| 4 | workspaces | navigate `/sessions/new`; if the sidebar is not pinned, `openFloating("peek")` (foundation store) | `sessions-sidebar` | "Your workspaces" / "Folders and conversations, one sidebar per rail item." |
| 5 | start-session | navigate `/sessions/new` | `new-session-composer` | "Start a session" / "Opens an empty composer in the current workspace." |
| 6 | connectors | navigate `/library/connectors` (Connectors live in Library, 05 F7; the canvas map still says Settings) | `library-connectors` | "Connectors" / "Connect the tools you already use, with your Abacus.AI account." |
| 7 | talk | navigate `/bots/$firstBotId` (the newest bot); none → `/sessions/new` and anchor `new-session-composer` | `composer` | "Talk to it" / canvas `TourComposer` body |
| 8 | changes | the newest listed session → `/sessions/$id?tab=changes`; no session → centred card | `panel-changes` | "Changes" / "Every edit as a diff, keep or undo." |
| 9 | preview-terminal (optional) | same session, `tab` unchanged | `topbar-panel-tabs` | "Changes, Preview, Terminal" / canvas `TourPanel` body |
| 10 | memory | navigate `/settings/memory` (`settings-in`) | `settings-memory` | "Memory" / "What it carries between sessions, and your standing instructions." |
| 11 | artifacts | navigate `/artifacts` (`settings-out` when coming from Settings) | `rail-artifacts` | "Artifacts" / "Files, images and links every run produced." |
| 12 | notch | `notch.preview()` (§10.10): the companion winks and shows its wings for 3 s | none (card at top centre with a 22 px avatar and "I live up here too", canvas `TourNotch`) | "The notch" (macOS) / "The companion" (Windows) / canvas body; **Start working** |

- Stop 12 is `available` only when `notch.status()` reports `available` (macOS or Windows, enabled, ready); otherwise the tour has 11 stops and stop 11's button reads **Start working**. `{n}` in stop 1 is the computed count.
- `waitForAnchor(id, 2000)`: resolves with the element once it is connected and has a non-zero box (a `MutationObserver` on `document.body` + `ResizeObserver`, rAF-checked), else `null` → the stop shows as a centred card with the same copy. It never throws and never leaves the tour stuck (parity TR4).
- Navigation inside the tour uses `useAppNavigate` with the inferred type, so the shell's pane/sidebar view transitions still play; the mask then morphs to the new rect.

### 9.4 Spotlight molecule (`components/spotlight/`, canvas `TourRail`, `OnboardMotion`)

```tsx
<Spotlight.Root open onDismiss>            // portal into body; data-slot="tour-spotlight"; full window; above the shell, below toasts
  <Spotlight.Mask rect={rect | null} />     // one rounded rect: radius 14, box-shadow 0 0 0 9999px rgb(0 0 0 / .55), 0 0 0 2px var(--primary), 0 0 40px color-mix(… 35%)
  <Spotlight.Card placement>…</Spotlight.Card>
</Spotlight.Root>
```

- **Mask**: one element whose `x, y, width, height` animate with `motion` `{ type: "spring", mass: 1, stiffness: 80, damping: 14 }` (canvas "spring(1, 80, 14)"); a `null` rect collapses it to a 0 × 0 rect at the card's centre (the whole window dimmed). Padding 4 px around the anchor rect.
- **Card**: 340 px wide, radius 16, `bg-popover`, padding `16px 16px 12px`, shadow `0 24px 64px rgb(0 0 0 / .6)`; header title (600) + "Step {i} of {n}" (12 muted), body 13/18, optional bullets with 22 px glyph tiles, footer **Skip the tour** (ghost) · spacer · **Back** (secondary, hidden on stop 1) · **Next** / **Start working** (primary). Follows the mask **40 ms later** (a `delay` on its own transition). Placement: `placeCard(anchorRect, cardSize, viewport, { gap: 16, toolbar: --toolbar-h })` (pure) picks right, left, bottom, top in that order by available space, clamps to 16 px from the window edges and below the title bar; centred when the rect is null.
- **Never scrolls the page under the user** (canvas): `prepare()` + `element.scrollIntoView({ block: "nearest" })` run **before** measuring, then the rect is read; later scrolls/resizes re-measure (capture-phase `scroll`, `resize`, `ResizeObserver` on the anchor), exactly like the occlusion watcher (foundation §7.6).
- **Modality**: the card is `role="dialog" aria-modal="true" aria-labelledby` its title; while the tour runs, the shell root gets `inert` (the anchor is visible through the mask but not operable: the tour points, it does not drive), focus moves to **Next** on each stop and returns to the element focused before the tour on end. `Escape` = Skip the tour (parity X button). The overlay click does nothing (parity TR1).
- **Title bar and native surfaces**: `tour-spotlight` joins `OCCLUDER_SLOTS` (foundation §7.6, amendment §23.1): the mask covers the window, so a native browser view hides while the tour runs, and the title bar's drag region is disabled under it (the no-drag selector).
- Reduced motion: the mask **cuts** between rects, the card fades 120 ms (canvas "the spotlight cuts").

### 9.5 Start, end, replay

- `startTour({ origin })`: refuses while one runs; records `origin` = the current location; sets stop 0.
- Next/Back move the index, awaiting `prepare` (buttons disabled meanwhile; `aria-busy` on the card). **Start working** → `status: "done"`, funnel `tour_done`, navigate back to `origin` (onboarding origin → `/bots/$firstBotId`). **Skip the tour** / Escape → `status: "skipped"`, `tour_skipped`, back to `origin`.
- Replay: Settings › General row **Take the tour** (§15) and the command menu item "Take the tour" (foundation §7.9 command list), both call `startTour({ origin: current })`. Gated on `account.onboarded` (parity TR7).
- `tourSignedOut()` (05 §19.2): ends an active tour without writing `status` (parity TR8).

---

## 10. The notch window, main side (`src/main/notch/`)

### 10.1 macOS window: requirements and the options they select (`window.ts`)

r3 (review r2 #1): the window is **derived from this spec's requirements**, one documented Electron option per requirement, not taken from any recipe. PLAN's Notch section now states the requirements only (§23.7).

| Req | Requirement (source in this spec) | Option chosen (Electron doc) | Verified by |
|---|---|---|---|
| W1 | Drawn around the cut-out in any shape, with nothing opaque outside the shape (canvas `Notch`) | `transparent: true`, `frame: false`, `backgroundColor: "#00000000"` (E:3850, 4066), child view `setBackgroundColor("#00000000")` (E:4066, 16114), `hasShadow: false` (the shape draws its own CSS shadow, E:3910), `roundedCorners: false` (E:4001) | R6-T30 screenshot |
| W2 | Never becomes the app's key window or raises the hidden main window when clicked or typed into (F2; "Close the window and your bots keep going", canvas `TourNotch`) | `type: "panel"` (Electron's documented macOS window type for a non-activating panel; not listed in the typings, E:4070) and `focusable: false` (E:3891), focus granted only on demand (§10.5) | R6-T30 (main window stays hidden) |
| W3 | Above ordinary windows and the menu bar strip on every Space the user visits (canvas "lives around the physical notch") | `alwaysOnTop: true` (E:3837) + `setAlwaysOnTop(true, "status")` (the documented level list, E:3196; "status" is the lowest documented level above the menu bar), `setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false })` (E:3605, 24413-24419), called **once** when the window is created and never again. `skipTransformProcessType` is **not** used (review r3 #8): Electron documents it as a bypass for processes that are already `UIElementApplication`, and this app stays a regular Dock application; the documented transformation may hide the Dock icon briefly on that single call, which R6-T30 records | R6-T30 (ordinary Spaces, Dock icon and activation unchanged) |
| W4 | Not drawn over another app's full-screen Space (F16, canvas "Quiet by default") | `visibleOnFullScreen: false` (E:24419) | R6-T30 compositor evidence |
| W5 | Its top edge at the display's top edge, over the menu bar (the wings sit beside the cut-out) | `enableLargerThanScreen: true` (E:3884) and explicit `setBounds` with `y = display.bounds.y` (note E:3287-3290 says macOS may constrain `y`; the test decides) | R6-T30 asserts `getBounds().y` |
| W6 | Not a user-managed window: no resize, move, minimise, zoom, full screen, Mission Control, Window menu or Dock/switcher entry (it is part of the menu bar area) | `resizable/movable/minimizable/maximizable/fullscreenable: false`, `hiddenInMissionControl: true` (E:3920), `skipTaskbar: true` (E:4017), `excludedFromShownWindowsMenu = true` (E:3701) | R6-T30 |
| W7 | Clicks outside the shape reach whatever is underneath; the shape itself takes clicks without a first "activation" click (§10.5) | `setIgnoreMouseEvents(true, { forward: true })` while passive (E:3378, 22197: `forward` keeps `mousemove` so the renderer can tell when the pointer enters the shape), `acceptFirstMouse: true` (E:3832) | R6-T30 synthetic clicks |
| W8 | Created hidden and revealed only when its document is ready and has something to draw (§10.6) | `show: false` (E:4005), later `showInactive()` (E:3632, shows without focusing) | R6-T25 |
| W9 | Hidden or occluded state is observable, so dwell clocks pause and cues/banners are not attributed to an unseen companion (§11.4, §13, §14.2) | **default background throttling kept** (`backgroundThrottling` not set; E:19431-19437 documents that disabling it also affects the Page Visibility API, and Electron's docs say it keeps visibility `visible` when hidden or occluded — review r3 #1). With throttling on, `document.visibilityState` follows hiding and occlusion; main combines that report with its own window facts (§13 rule 3). Nothing in the notch needs a renderer timer while hidden: dwell clocks pause, and the timers that must run while hidden (banner hold, cue fallback, haptic and claim expiry) live in main | R6-T30 (hide, occlusion by another window, another app's full-screen Space, with the shipped options) |

```ts
const win = new BaseWindow({ type: "panel", show: false, frame: false, transparent: true, backgroundColor: "#00000000",
  hasShadow: false, roundedCorners: false, resizable: false, movable: false, minimizable: false, maximizable: false,
  fullscreenable: false, focusable: false, skipTaskbar: true, hiddenInMissionControl: true, alwaysOnTop: true,
  enableLargerThanScreen: true, acceptFirstMouse: true, ...placement.bounds });           // W1–W8
win.excludedFromShownWindowsMenu = true;                                                     // W6
win.setAlwaysOnTop(true, "status");                                                          // W3
win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false });                        // W3, W4 — once, at creation
win.setIgnoreMouseEvents(true, { forward: true });                                           // W7
const view = createNotchView(base);   // WebContentsView: preload index.cjs + additionalArguments ["--abacus-window=notch"] (E:19418),
                                      // sandbox false / contextIsolation true / nodeIntegration false as the main view (index.ts:1077-1089),
                                      // default backgroundThrottling (W9), spellcheck true, webviewTag false; setBackgroundColor("#00000000") (W1)
win.contentView.addChildView(view);
fitView(win, view);                                                                          // view.setBounds({ x: 0, y: 0, ...win.getContentSize() }) — F25
win.on("resize", () => fitView(win, view));
```

- `webContents.setWindowOpenHandler(() => ({ action: "deny" }))`; `will-navigate` is prevented except a same-document reload; `will-attach-webview` denied. Links in the notch never open anything but the main window (`notch.openInApp`, §10.10).
- The entry is `notchEntry(base)` next to `index-next.html` (amendment to `renderer-entry.ts`: `NOTCH_ENTRY = "notch.html"`, the same three bases), so dev, experience bundles and packaged files all resolve it.
- **Registration**: `wireNotchContents(contents)` is the sibling of `wireRendererContents` and calls `rpcTransport.registerRendererContents(contents, "notch")`; it is the only other place a webContents becomes trusted (spec 00 A.4.2's rule, amended). The transport already gives the port `windowKind: "notch"` from main's registry, never from the page (`message-port.ts:131-167`).
- **Preload**: `src/preload/index.ts` becomes a dispatcher on `process.argv.includes("--abacus-window=notch")`: the notch branch installs only `installRpcPortHandshake(ipcRenderer, window, "notch")`; the main branch is today's file body, moved verbatim into `main-preload.ts` (its tests unchanged). The notch page therefore has no `window.api`, no `window.abacusHost`, and never runs the synchronous `renderer-state:snapshot` read.
- No `titleBarOverlay`, no chrome options, no theme-driven background (window-chrome §6 L85): the notch is always drawn black with light text in both themes (canvas), so it needs no `nativeTheme` follow.

### 10.2 Notch metrics and geometry (`metrics.ts`, `geometry.ts`)

**Probe (F1).** `probeNotchMetrics(): Promise<ProbeResult>` runs `/usr/bin/osascript -l JavaScript -e <script>` through `execFile` with a 3 s timeout. The script (ours) walks `$.NSScreen.screens` and, for each screen, first checks `screen.respondsToSelector("safeAreaInsets")` and `respondsToSelector("auxiliaryTopLeftArea")` (the selectors exist from macOS 12, `NSScreen.h` `API_AVAILABLE(macos(12.0))`); then reads `frame` and the two auxiliary areas as **`NSRect` structs** (`origin.x`, `origin.y`, `size.width`, `size.height` fields through the bridge; an area is an **empty rect** — zero width — on a screen without a cut-out, never `nil`), and `safeAreaInsets.top`. It prints one JSON object: `{ ok: true, screens: [{ frame, top, left, right }] }`, or `{ ok: false, reason: "selectors-unavailable" }` when the selectors are missing (macOS < 12).

```ts
type ProbeResult =
  | { kind: "ok"; screens: ProbedScreen[] }                          // left/right are the auxiliary widths, 0 when the rect is empty
  | { kind: "unavailable"; reason: "selectors-unavailable" | "timeout" | "exit" | "parse" };
export type NotchMetrics = { width: number; height: number };        // the cut-out, DIP, centred on the display
export function metricsFromProbe(s: ProbedScreen): NotchMetrics | null;   // top > 0 && left > 0 && right > 0 → { width: frame.width - left - right, height: top }; else null (a real "no cut-out")
```

A zero-area auxiliary rect is a **successful** probe that says "no cut-out"; a timeout, a non-zero exit, unparsable output or missing selectors is a **failed** probe. R6-T24 feeds `parseProbe` the JSON the script really prints (recorded from R6-T31 into `metrics.fixtures.json`), not hand-written shapes.

**Matching to Electron displays.** Electron `Display.bounds` are DIP with a top-left origin (E:8009); `NSScreen.frame` is in points with the origin at the primary screen's bottom-left, and points equal DIP on macOS. A probed screen matches a display when the sizes and `x` are equal and `primary.height - (frame.y + frame.height) === bounds.y`. Unmatched entries are ignored.

**No inference** (review #25). When the probe fails, or no screen matches, the controller does not guess: a display whose metrics are unknown and that is `internal` gets **no** companion (it might have a cut-out, and a guess could draw under it); external displays are known to have no cut-out and may get a plain capsule when `extraDisplays` is on. `notch.status` reports `reason: "metrics-unavailable"` and Settings shows "The notch companion couldn't measure this screen." with **Try again** (re-probe). Results are cached per `${display.id}:${w}x${h}@${scaleFactor}` and re-probed whenever that key changes.

**Dev override** (review class 4): `ABACUSBOT_NOTCH_METRICS=WxH` forces metrics on the primary display, honoured only when `!app.isPackaged` (R6-T24).

**Placement (pure).**

```ts
export interface NotchPlacement {
  displayId: number;
  mode: "notch" | "plain";                       // plain: a display known to have no cut-out
  notch: NotchMetrics | null;
  bounds: Rectangle;                             // the window, DIP
}
export function notchPlacement(display: Display, notch: NotchMetrics | null, shape: { width: number; height: number }): NotchPlacement;
```

- Window = shape + 24 px each side and 32 px below (derived from the canvas shadow `0 8px 24px`: blur radius 24 plus the 8 px offset so it never clips), top edge at `display.bounds.y`, centred on the display.
- In `notch` mode the wings are `(shape.width - notch.width) / 2` each and nothing is drawn in the centre `notch.width` (canvas "Around the notch, never on it").
- Maximum shape 560 × 220 (derived: the widest canvas state, 500, plus room for a longer caption; the tallest body, an approval with a two-line summary and one pill row, measured on the canvas grammar: 32 + 6 + 2 × 16 + 8 + 26 + 12 ≈ 116, doubled for a question with two option rows); requests above it are clamped and the clamp reported back in `notch.layout`.

**Envelope, then final** (review r2 #10, #11). A shape change can grow one dimension while shrinking the other (a 500 × 32 working shape becoming a 440 × 108 approval), so there is no single "larger" or "smaller" rect. For every change from shape A to shape B the renderer:

1. calls `notch.setShape({ phase: "envelope", width: max(A.w, B.w), height: max(A.h, B.h), … })` and awaits it: main applies the envelope at once (`setBounds` then `fitView`, anchored at the top edge on macOS and at the growth edge on Windows, where it grows upward) and resolves after both;
2. navigates / animates from A to B inside the envelope (nothing clips: both shapes fit);
3. when the animation is complete, calls `notch.setShape({ phase: "final", width: B.w, height: B.h, … })`.

"Complete" is decided by the renderer's `shapeSettled(gen)` and never by `transitionend` alone: it resolves immediately when reduced motion is on (sizes snap) or when neither dimension changes; otherwise it waits for **both** `width` and `height` `transitionend` events (only for dimensions that changed), and also resolves on `transitioncancel` or after a deadline of the transition duration + 100 ms (a change interrupted mid-way fires no `transitionend`; the deadline covers any case the events miss). Every callback checks the director's generation (§11.6); a stale generation never sends a `final`, and the newer change starts its own envelope from the **current** rendered size. Main applies each call as it arrives and re-reads the display's geometry; it keeps no timer. R6-T42 (Electron) runs grow, shrink, mixed, interrupted, reduced-motion and Windows upward-growth cases and asserts the rendered shape is never clipped (screenshots of the view at 60 fps sampling) and that the window ends at B plus margins.

### 10.3 Displays (`controller.ts`)

- **Targets (macOS)**: `prefs.notch.extraDisplays ? screen.getAllDisplays() : [the internal display with a notch ?? screen.getPrimaryDisplay()]`. A non-notched Mac therefore gets one plain capsule on the primary display (canvas "No notch, more room"); extra displays get plain capsules when the pref is on (PLAN "extra displays").
- One window per target display, keyed by `display.id`. `reconcile()` creates missing windows, destroys windows for displays no longer targeted (`display-removed`), re-places the rest, and pushes `notch.events { layout }` when a window's placement changed (no reload).
- Triggers: `screen` `display-added`, `display-removed`, `display-metrics-changed` (E:12119-12152; debounced 250 ms, bursts of all three arrive on lid close), `powerMonitor` `resume` and `unlock-screen` (E:11008, 11108), `prefs` changes of `notch.*`, and the main renderer's readiness (first creation). Reconciles are serialised through one promise chain; a reconcile that throws logs and leaves the previous windows in place.
- Every window runs the same presenter over the same inputs, so all displays show the same state; answering on one removes the descriptor from all through `permission.pending` (02 §6.3). A duplicate answer from a second window gets `not_pending` and is ignored.

### 10.4 Full-screen spaces, menu bar, Mission Control

- Other apps' full-screen spaces: not drawn (`visibleOnFullScreen: false`, F16). Attention that arrives meanwhile is counted and shown when the space changes back (the presenter is state-based, not event-based, so nothing is lost).
- Mission Control and the Window menu: excluded (`hiddenInMissionControl`, `excludedFromShownWindowsMenu`).
- A hidden menu bar (the user's "Automatically hide and show the menu bar"): the wings still sit beside the cut-out; nothing special is done (the area is black hardware either way). Not verified on hardware beyond R6-T31's checklist.
- The companion never takes the menu bar's clicks: outside the shape the window is click-through (§10.5).

### 10.5 Click-through, interactive, focus (`interaction.ts`)

| State | `setIgnoreMouseEvents` | focusable | Entered by | Left by |
|---|---|---|---|---|
| passive (default) | `true, { forward: true }` | no | start; pointer leaves the shape; window `blur` | pointer enters the shape |
| interactive | `false` | no | `notch.setInteractive({ interactive: true })` from the renderer when a forwarded `pointermove` hits the shape's rect | the renderer's `pointerleave` / a move outside the rect → `false` |
| focused | `false` | yes | `notch.focus({ focus: true })` after a user click in the reply field, the question's "Other" field, or the global shortcut | window `blur`, `notch.focus({ focus: false })`, collapse |

- The panel is never focusable except in the third state, so it never appears as an app window in switchers and never takes keys the user meant for another app; focus exists only for typing. Focusing a `type: "panel"` window must not raise or show the hidden main window: **unverified**, R6-T30 asserts `mainWindow.isVisible()` stays false.
- On `setFocusable(false)` macOS keeps focus (E:3341 "does not remove the focus"); the controller therefore also calls `win.blur()` when leaving the focused state.
- **Global shortcut** (05 §21.3 `notch-reply`, `Mod+Shift+Space`, owner main, not rebindable): registered with `globalShortcut.register("CommandOrControl+Shift+Space", …)` (E:8608) while the companion is enabled on a supported platform; press → pick among the **existing ready** notch windows (review #23): the one on the display nearest the cursor (`screen.getDisplayNearestPoint(screen.getCursorScreenPoint())`, E:12190/12198) when that display has a ready window, else the window the user last interacted with, else the one on the primary display; focus it and publish `notch.events { type: "shortcut" }` to it only. With no ready window (disabled, failed, Linux, full-screen hidden) the shortcut reveals the main window instead (`revealMainWindow`). `register` returning `false` (taken by another app) sets `notch.status().shortcut = "unavailable"`, shown in Settings (§15). Unregistered on disable and in `will-quit`.

### 10.6 Lifecycle

- **Generation gate** (review class 3): the controller exists only when `RENDERER_GENERATION === "wco"`; the legacy generation creates nothing, registers no shortcut and publishes no `notch.*` events.
- **Platform gate**: darwin and win32 only; Linux never creates a window (`notch.status` reason `platform`).
- **Disposal** (F25, review #18): every path that removes a notch window — disable, display removed, readiness failure or timeout, crash retry, main close on Windows, quit — goes through `disposeNotchWindow(entry)`: remove the entry from the controller map, unregister the contents from the transport, `win.contentView.removeChildView(view)`, `view.webContents.close()` (the view's renderer, its port, its iterators and any Whisper allocation die with it), then `win.destroy()`. It is idempotent (an `entry.disposed` flag; `webContents.isDestroyed()` checked before each step). R6-T25 counts live `webContents` and open RPC iterators after 20 enable/disable cycles and 5 forced readiness failures: both return to their baseline.
- **Start**: after the main renderer reports readiness (`RendererReadiness`), if `prefs.notch.enabled`.
- **Readiness**: each notch view reports `window.ready({ barrier: "subscriptions" })` once its tables are ready (the existing procedure, keyed by `webContentsId`, `rpc/readiness.ts`); main waits up to 10 s, then shows the window with `showInactive()` (E:3632) only when the renderer's first `setShape` says something is drawn. Timeout or `failed` → dispose and retry after 2 s, 10 s, 60 s; three failures within 10 minutes stop retries until the next launch or a prefs toggle, and `notch.status` reports `failed` (Settings shows "The notch companion couldn't start." with **Try again**).
- **Crash**: `render-process-gone` on a notch view → dispose, then the same backoff.
- **Renderer swap** (review r2 #21, r3 #5): each notch window entry holds `active: WebContentsView` and at most one `standby: WebContentsView`. When `RendererHost` commits a new experience base, the controller creates the standby view on `notchEntry(newBase)`, added to the same `BaseWindow` with `setVisible(false)` (E:16120), fitted, and registered with the transport under kind `"notch"` **marked standby** in main's registry. While standby, main **stages** its `setShape` reports (the latest one kept, not applied) and **rejects** its `setInteractive`, `focus`, `presented`, `visibility`, `haptic`, `openInApp` and `claimCue` calls with `FORBIDDEN { reason: "standby" }`; it receives `notch.events` so its director can compute its presentation. The active view keeps sole control of the window. On the standby's `window.ready` (10 s), one synchronous main step **promotes** it: it becomes `active` in the registry, its staged shape is applied (`setBounds` + `fitView`), it is made visible, the old view is removed and its `WebContents` closed, and the old view's claims and visibility report are dropped (the new active contents must report visibility before the window counts as seen, §13). If the standby fails or times out it is disposed, the old view stays active untouched, and the swap retries with the backoff below; after the give-up threshold the old view keeps serving until the next launch. R6-T25 sends conflicting shape reports from both views during delayed and failed swaps and asserts only the active view's reports reach the window.
- **Try again** (review r2 #20): `notch.retry()` (main window only) clears the metrics cache and the readiness/crash failure budget, re-probes and reconciles; Settings' **Try again** calls it and then refetches `notch.status`.
- **Disable** (`prefs.notch.enabled = false`): dispose every notch window, unregister the shortcut; the cue arbiter's audible document becomes the main one (§14.2).
- **Main window close / recreate**: macOS closing hides the main window (today) and the companion keeps running (canvas `TourNotch` "Close the window and your bots keep going"). Windows: the main window's real close (after the existing "Keep running in background" dialog) disposes the capsule first, so `window-all-closed` still fires and the app quits as today (F23). `recreateMainWindow` (density, Linux probe) never touches notch windows; `mainWindowLifecycle` counts only the main window.
- **Quit**: `before-quit` disposes notch windows before other teardown (review class 2); a haptic `osascript` still running is killed.
- **Audit**: every main use of `BaseWindow.getAllWindows()` / `getFocusedWindow()` is listed and filtered to exclude notch windows (R6-T29 greps `src/main` for them and asserts each call site filters by kind).

### 10.7 Haptics (`haptics.ts`, macOS)

Derived from Apple's documented API (AppKit `NSHapticFeedbackManager.defaultPerformer`, `performFeedbackPattern:performanceTime:` with the alignment pattern, `NSHapticFeedback.h:31`), reached through JXA because Electron exposes no haptics. Our design: **one short-lived `osascript -l JavaScript -e <script>` per haptic event** through `execFile` (timeout 2 s), no resident helper. Haptics fire when the notch expands into an approval or a question, and on each step of a multi-question prompt — never on hover.

**Deduplicated centrally** (review r2 #14): every notch document presents the same attention, so each calls `notch.haptic({ pattern, key })` with `key` = the permission lineage `${threadId}:${incarnation}:${permissionId}` (plus `:q${step}` for question steps). Main performs a key **once** (a bounded map: 500 keys, 10 minutes), whichever document or reload asks first; later calls with the same key do nothing.

The spawn latency is **measured** by R6-T31. **Threshold policy**: if the median exceeds 150 ms after the expansion starts, haptics ship off by default. Rationale: a tap arriving after the 350 ms shape animation is well under way no longer reads as "this appeared"; 150 ms keeps the tap inside the first half of the animation. It is a chosen policy value, confirmed or changed by the R6-T31 recording. Gated by `prefs.notch.haptics` and darwin; a failing spawn is logged once and ignored. Haptics need a Force Touch trackpad under the finger; elsewhere they do nothing.

### 10.8 Windows capsule (`geometry.ts` `capsulePlacement`, canvas `Notch` "Windows")

```ts
new BaseWindow({ type: "toolbar", show: false, frame: false, transparent: true, thickFrame: false, backgroundMaterial: "none",
                 resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false,
                 focusable: false, skipTaskbar: true, alwaysOnTop: true, backgroundColor: "#00000000", ...bounds });
win.setAlwaysOnTop(true, "pop-up-menu");
win.setIgnoreMouseEvents(true, { forward: true });                   // win32 supports forward (E:22197)
```

- The options follow §10.1's requirements W1, W3 and W6–W9 on Windows (W3 there is `alwaysOnTop` only; `setVisibleOnAllWorkspaces` does nothing on Windows); `type: "toolbar"` is Electron's documented Windows type for a window kept out of Alt+Tab (W6; not listed in the typings, R6-T33); `thickFrame: false` and `backgroundMaterial: "none"` keep the transparent pill free of a system frame or material (W1, E:4035, E:3858); `setAlwaysOnTop(true, "pop-up-menu")` places it above ordinary top-most windows but below system popups (W3; the level list is documented, its Windows mapping is checked by R6-T33). `setVisibleOnAllWorkspaces` does nothing on Windows (E:3605) and is not called.
- **Placement** on the primary display: the taskbar edge is where `workArea` differs from `bounds` (`bottom` when `workArea.y + workArea.height < bounds.y + bounds.height`, likewise top/left/right; an auto-hidden taskbar gives equal rects → treated as bottom with a 48 px reserve). The capsule sits by the clock: bottom or right taskbar → bottom-right corner, 12 px from the right and 8 px above the work area's bottom, **growing upward** (body above the pill); top taskbar → top-right below it, growing downward; left taskbar → bottom-left, growing upward. `display-metrics-changed` (taskbar moved or resized) re-places it.
- Shape: pill 36 px tall, radius 999 (canvas), same states and routes as macOS; `mode: "capsule"` in `notch.layout` tells the renderer to lay the wings out as one row (face, caption, trailing control) and put the body on the growth side.
- Extra displays are not used on Windows in this phase (§24.3). Full-screen apps: Windows has no equivalent of `visibleOnFullScreen`; the capsule stays topmost over them (a known difference, §24.1).

### 10.9 Linux

No window, no shortcut, no Settings rows (hidden when `notch.status().reason === "platform"`); the tour has 11 stops.

### 10.10 Contract `notch.*` (`shared/contract/notch.ts`) and main changes

```ts
export type NotchMode = "notch" | "plain" | "capsule";
export interface NotchLayout {
  displayId: number; mode: NotchMode;
  notch: { width: number; height: number } | null;             // the gap the renderer keeps empty
  growth: "down" | "up";                                        // macOS always down; Windows by taskbar edge
  maxShape: { width: number; height: number };                  // 560 × 220
}
export type NotchEvent =
  | { type: "layout"; layout: NotchLayout }
  | { type: "app"; mainVisible: boolean; mainFocused: boolean }  // calm while the main window is focused
  | { type: "reaction"; sessionId: string; reaction: "wink" }    // an accepted ai.send from the main window (§11.7)
  | { type: "shortcut" }                                          // §10.5
  | { type: "preview" };                                          // tour stop 12
// Lossless commands to the main renderer (review r2 #19): not window.events, which coalesces by type.
export type OpenCommand = { id: string; target: OpenTarget; at: number };
export type OpenTarget =
  | { kind: "bot"; botId: string; sessionId?: string }            // forever chat or /bots/$botId/chats/$sessionId
  | { kind: "session"; sessionId: string }
  | { kind: "routine-run"; routineId: string; sessionId: string };
export interface NotchStatus {
  available: boolean;
  reason?: "platform" | "generation" | "disabled" | "failed" | "metrics-unavailable";
  displays: number;
  shortcut: "registered" | "unavailable" | "off";
}

export const notch = {
  layout: query.input(NoInput).output(type<NotchLayout>()),                                       // notch window only
  events: subscription.input(NoInput).output(eventIterator(type<NotchEvent>())),                   // notch window only; coalescing by type (reaction: by sessionId)
  setShape: mutation.input(v.object({ phase: v.picklist(["envelope", "final"]), width: v.number(), height: v.number(), visible: v.boolean(), audio: v.boolean() })).output(type<NotchLayout>()),   // notch only; resolves after the window and its view are resized; `audio`: its AudioContext is unlocked (§14.3)
  visibility: mutation.input(v.object({ documentVisible: v.boolean() })).output(type<void>()),   // notch only: sent on boot and on every `visibilitychange` (§13)
  setInteractive: mutation.input(v.object({ interactive: v.boolean() })).output(type<void>()),    // notch only
  focus: mutation.input(v.object({ focus: v.boolean() })).output(type<void>()),                   // notch only
  haptic: mutation.input(v.object({ pattern: v.literal("alignment"), key: v.string() })).output(type<void>()),   // notch only; `key` = attention lineage (§10.7); main plays each key once; no-op off darwin
  openInApp: mutation.input(OpenTargetSchema).output(type<{ id: string }>()),                     // notch only: reveal + enqueue an OpenCommand
  presented: mutation.input(v.object({ dedupeKey: v.string(), documentVisible: v.boolean() })).output(type<void>()),   // notch only: an attention was drawn (§13)
  status: query.input(NoInput).output(type<NotchStatus>()),                                        // any window
  preview: mutation.input(NoInput).output(type<void>()),                                           // main window only (tour)
  retry: mutation.input(NoInput).output(type<NotchStatus>()),                                     // main window only: clear metrics cache + failure budget, reconcile
  openCommands: subscription.input(NoInput).output(eventIterator(type<OpenCommand>())),            // main window only; lossless-actionable (A.4.3): pending commands are re-sent on (re)subscribe until acked
  ackOpen: mutation.input(v.object({ id: v.string() })).output(type<void>()),                      // main window only: the navigation committed
};
```

- **Guards**: `requireNotch(context)` → `FORBIDDEN { reason: "not-notch" }` unless `context.windowKind === "notch"`, and `FORBIDDEN { reason: "standby" }` for a standby contents' interaction, focus, presentation, visibility, haptic, open and claim calls (its `setShape` is staged, §10.6); `preview`, `retry`, `openCommands` and `ackOpen` use the existing `requireMainRenderer`. Both are typed errors (spec 00 A.5).
- **Delivery**: `notch.events` is **coalescing** (spec 00 A.4.3) with key `type` (reactions keyed by `sessionId`): every event is a level or a harmless transient.
- **Open commands** (review r2 #19): `openInApp` reveals the main window (`revealMainWindow`) and appends `{ id, target, at }` to a pending list in main (bounded: 20 entries, 10 minutes). The main renderer's `OpenTargetBridge` global consumes `notch.openCommands` (lossless-actionable: on subscribe it receives every pending command, then new ones), navigates, and calls `notch.ackOpen({ id })` after the router resolves that location; main drops acked ids. A renderer swap or reload re-subscribes and receives what was not acked; a command older than 10 minutes is dropped. Commands are processed in order and a newer one supersedes older pending ones (only the last navigation happens; older ids are acked as superseded). R6-T28 delays consumption and swaps the renderer mid-way.
- **`window.claimCue({ cueId, threadId }) → { play: boolean }`** (any window kind) and **`window.visibleThread({ threadId: string | null })`** (main window only) (§14.2): the central cue arbitration and the focused-thread rule.
- **Per-window main fixes (F3)**: `RpcWindows.state(id)` / `chrome(id)` return the state of the window that owns `id` (the notch's own `{ focused, fullScreen: false, maximized: false }`; `chrome` `null` → `window.chrome` answers `FORBIDDEN` for a notch caller); `publishToWindowViews` sends main-window state and chrome only to ids registered as `"main"`; `window.activity` from a notch id does not defer renderer swaps (a notch hover is not main-window activity). `system.events` stays broadcast (a notification click is handled only by the main renderer's bridge; the notch ignores it).
- **Reaction source**: `ai.send` accepted (`started`/`queued`) from a `windowKind: "main"` caller publishes `notch.events { reaction: "wink", sessionId }` (canvas "Send in the window → wink"); no renderer change.

---

## 11. The notch renderer (`notch.html`, `notch.tsx`, `features/notch/`)

### 11.1 Entry and build

- `apps/desktop/notch.html`: a copy of `index-next.html` (same CSP `<meta>` verbatim, `renderer-csp.ts` keeps them in sync), `<html class="dark notch" style="color-scheme: dark; background: transparent">`, `<script type="module" src="/src/renderer-next/notch.tsx">`.
- `vite.config.ts` (amendment to foundation §3.3): `rolldownOptions.input.notch = resolve(root, "notch.html")` (a third input; all three land at the root of `dist/renderer`, so experience bundles and `electron-builder.yml`'s `dist/**` carry it unchanged); a **second** `tanstackRouter({ routesDirectory: "./src/renderer-next/notch-routes", generatedRouteTree: "./src/renderer-next/notchRouteTree.gen.ts", routeFileIgnorePrefix: "-", autoCodeSplitting: false, quoteStyle: "double" })` before the React plugins (code splitting off: the notch is small and must paint its first state without chunk loads). The two instances keep separate contexts (sources table); that two trees build and hot-reload side by side is **unverified** until R6-T1 builds both in dev and production. The React Compiler instance already covers `src/renderer-next/**` (`NEXT_MODULES`).
- `knip.json` entries gain `notch.tsx` and `notch-routes/**/*.tsx`; `notchRouteTree.gen.ts` is ignored like the main tree; oxlint's `routes/**` default-export override is extended to `notch-routes/**`.
- **Boot** (`notch.tsx`), the foundation's order (§8.6) with notch specifics: styles (`app.css` + `features/notch/notch.css`); `applyTheme(document, "dark")` fixed (the hardware is black in both themes); `initI18n()`; `bootstrap()` with the same transport code (the preload answered with kind `"notch"`; main decides the kind); prefs, then `sessions`, `bots` and `routines` preloaded (routines attribute check-in and routine runs to bots, review #14); `changeLanguage(resolveLanguage(prefs.language))`; `createChatRuntime(transport, { maxSessions: 2 })` (02 L170; the budget option is amendment §23.2); `createNotchRouter(boot)`; render. Transport loss → the foundation's reload policy (main sees the reload through `did-navigate` and re-registers the port).
- **Readiness**: `NotchReadiness` (a sibling of the foundation's reporter, watching `prefs`, `sessions`, `bots`, `routines`) calls `window.ready({ barrier: "subscriptions" })` once (§10.6).
- The notch document never mounts the devtools cockpit, the command menu, hotkeys provider bindings other than the notch's own (`Mod+Enter`, `Escape`, active only while focused), or any shell global.

### 11.2 Inputs (`inputs.ts`)

Levels come from tables, events from notices (review class 31: nothing is derived from collection inserts or coalesced diffs).

| Input | Source | Kind |
|---|---|---|
| Who waits, runs, errored | `sessionsCollection` rows: `id`, `owner`, `routineId`, `label`, `turn { phase, isBusy, updatedAt }` | level |
| Names, looks | `botsCollection` | level |
| Bot attribution of ownerless runs | `routinesCollection` (`RoutineRow.botId`; a check-in run has `owner: null` and its `routineId` names the bot's check-in routine) | level |
| Enabled, idle visibility, quiet hours, per-bot levels, reduce motion | `prefsCollection` (`notch.*`, `sounds.*`, `motion.reduce`) | level |
| Run outcomes (reply arrived, done, failed) | `ai.runFinished` (F4) through `lib/run-finished.ts`, the same one-subscription-per-document feed the main document's bots and sessions consumers use, `lastEventId` resume within the document | event |
| Connector asks | `connectors.events()` keyless (03 §6.1: first yield `snapshot`) | level after snapshot |
| Which waiting threads hold a question vs an approval, how many, since when, first title | **`ai.attention`** (review r2 #16, r3 #3; a relay requirement, §23.6): **one** subscription, `ai.attention({}) → eventIterator<AttentionEvent>`, whose first yield is an atomic snapshot taken under the relay's lock, followed by revisioned changes (protocol below) | level |
| Descriptors (full payloads, allowed decisions) | the chat kit's thread store for the ≤ 2 sessions the notch holds (§11.3) | level |
| Attention transitions for cues | the shared `turnTransitions(sessionsCollection)` helper (04 §6.7, homed in `lib/attention/`, §23.4) and a connector-ask watcher over the same `connectors.events()` feed, **independent of what the presentation shows** (§14.3) | transition |
| Main window visible/focused, layout, reactions, shortcut, preview | `notch.events` | level / transient |

**`ai.attention` protocol** (r3 #3, #4):

```ts
type AttentionSummary = { threadId: string; incarnation: string; questions: number; approvals: number; oldestAt: number; firstTitle: string | null };   // incarnation: the existing opaque string (ai-thread.ts:66), unchanged
type AttentionEvent =
  | { type: "snapshot"; revision: number; items: AttentionSummary[] }       // first yield; replaces the client's state wholesale
  | { type: "upsert"; revision: number; item: AttentionSummary }            // counts > 0 only
  | { type: "remove"; revision: number; threadId: string };                 // counts reached zero, the incarnation ended, or the session was deleted
```

- The relay keeps one table keyed by `threadId`, updated from each thread's `permission.pending` for its **live incarnation** only, with a single monotonic `revision` per relay process. On subscribe it registers the listener and takes the snapshot in the same synchronous step, so no change can fall between them; every later change is yielded with a higher revision, and the client ignores any event whose revision is ≤ the last applied one.
- **Removal**: an item never carries zero counts; it is removed. **Incarnation change** (a process respawn): the old incarnation's item is removed, and an item for the new incarnation appears only when its own `permission.pending` has entries. **Session deletion**: `remove`. **Reconnect** (transport loss, resubscribe): no resume; the new subscription starts with a fresh snapshot that replaces the client's state (items absent from it are dropped).
- Delivery is lossless-actionable (spec 00 A.4.3); an overflow ends the iterator with `RESYNC_REQUIRED` and the client resubscribes (fresh snapshot).
- R6-T44 races a permission change between subscribe and snapshot, delivers a stale snapshot after a newer event, removes via zero counts, respawns a thread (new string incarnation), deletes a session and reconnects mid-stream.

### 11.3 Which threads the notch holds

The notch document's chat runtime is created with a **two-session budget** (`createChatRuntime(transport, { maxSessions: 2 })`, amendment §23.2: the LRU size becomes an option, default 8 for the main document). The director keeps a set `held = { current, next }` (the session on screen in `/approval/$id` or `/reply/$id`, and the next attention in line) and, whenever `held` changes, calls `runtime.session(id).retire()` for every session it loaded that left the set: `retire()` aborts the pump and unsubscribes (02 §3.1), so its `ai.subscribe` iterator closes at once rather than at LRU eviction (review #13). Everything else is known from rows: a waiting session counts as one "needs you" until its thread is held (03 §6.6's rule). R6-T19 counts open `ai.subscribe` iterators on the memory transport after twenty sequential presentations: never more than two.

### 11.4 Presenter (`presenter.ts`, pure; R6-T16 is a table test)

```ts
export type Attention =
  | { kind: "question" | "approval"; sessionId: string; since: number; descriptorId: string | null }   // descriptorId null until the thread is held
  | { kind: "connector-ask"; sessionId: string; since: number }
  | { kind: "failed"; sessionId: string; runId: string; code: string | null; at: number }
  | { kind: "working"; sessionId: string; caption: string | null }
  | { kind: "reply"; sessionId: string; runId: string; at: number; canReply: boolean }                   // canReply: the bot's own ("forever") chat
  | { kind: "done"; sessionId: string; runId: string; at: number };
export interface NotchPresentation {
  route: "/idle" | "/working" | "/approval/$id" | "/reply/$id" | "/call" | "/done" | "/failed";
  sessionId: string | null;
  identity: string;                         // `${route}:${sessionId}:${descriptorId ?? runId ?? ""}` — the hover lock compares it
  faces: Array<{ botId: string | null; mood: LifecycleMood }>;   // ≤ 3, most urgent leftmost (canvas "Leftmost = needs you")
  remaining: number;                        // attention items beyond the shown one (right-wing count)
  expanded: boolean;                        // the body is open
  hidden: boolean;                          // nothing drawn (canvas "Nothing going on")
  quietUntil: string | null;                // "8:00" while quiet hours hold
}
export function presentNotch(inputs: NotchInputs, now: number): NotchPresentation;
```

- **Priority** (PLAN, F6): question > approval > connector-ask > failed > working > reply > done > idle; within a kind the oldest `since`/`at` first. Question vs approval is known for **every** waiting thread from `ai.attention`, loaded or not (review r2 #16); a thread with both counts as a question. Until the summary's first answer arrives, a `waiting_permission` session counts as an approval. Every session kind counts (F24): listed sessions, bot chats, check-in runs, routine runs.
- **Per-bot level** (`prefs.sounds.perBot`, 05 §22): `nothing` → that bot's sessions are left out entirely; `needs-me` → only question/approval/connector-ask for them. A session's bot is `owner.botId`, else the bot of its `routineId` (check-in runs and ordinary routine runs, `RoutineRow.botId`); sessions with no bot follow the global switches (review #14).
- **Expanded** only for question, approval and a fresh reply (6 s after it arrives, then it collapses to its wing until acknowledged), and while hovered (§11.6) or listening.
- **Calm** (canvas "Window focused → the companion calms to the idle wings"): while `app.mainFocused`, nothing expands; the route is `/idle` with the most urgent face and the count.
- **Quiet hours** (`isQuietNow`, 05 §22.4): `/idle` with the `asleep` face dimmed and "Until {end}"; nothing expands, no sound, the count grows.
- **Dwell and acknowledgement** (our values, recorded in `lib/motion.ts`'s `notch` constants so tests pin them): `done` shows for 5 s; `reply` and `failed` stay (collapsed) until acknowledged (opened, replied, dismissed), a newer run of the same session starts, or 10 minutes pass. Acknowledgements live in `notchUiStore.acks` (ephemeral, per document; keyed by run id). A duplicate notice for one run id counts once (a bounded `Set`, 500 ids, as 04 §19.1). **While the notch document is hidden** (`document.visibilityState === "hidden"`, which reflects hiding and occlusion because background throttling is kept, W9: another app's full-screen Space, the display asleep, or the window hidden by main) the dwell clocks pause and nothing is acknowledged or expired, so a reply that arrived during a long full-screen stay is still there on return (review #21).
- **Hidden**: no bots and no attention (canvas first state), or `prefs.notch.idleVisible === false` while idle.
- **Moods**: `moodFor(botAttention(…))` from `lib/attention` (F22) per bot; a session without a bot shows the app mark in a 20 px tile instead of a face.

### 11.5 Shell, wings, body, shapes (`shell/`, `shape.ts`; canvas `Notch`)

- **Shape**: `#000`, radius `0 0 22px 22px` (notch and plain modes) or 999 (capsule), shadow `0 8px 24px rgb(0 0 0 / .45)`, text 12/16 `--notch-fg` `#f2f2f3`, secondary `--notch-muted` `#8e8e93`, pills 26 px radius 999 (`#2a2a2e`, primary `#f2f2f3` on `#111`). These are notch-scoped constants in `notch.css`, not theme tokens (the shape is hardware-black in both themes); R6-T35 computes their contrast.
- **Wings** row 32 px (the notch height from `layout.notch.height`, never less), padding `0 10px 0 12px`; left wing: faces (20 px avatars, stacked −6 px) + caption; right wing: status dot, count badge (18 px, `bg-primary`), or a pill. In `notch` mode the centre `layout.notch.width` is empty (`gap` = notch width).
- **Body** below the wings, `padding: 6px 14px 12px`, full shape width.
- **Sizes** (`SHAPES`, from the canvas with a 200 px notch; the wing width is what varies, the total is `notch + 2 × wing`):

| Presentation | Wing | Body height | Canvas total |
|---|---|---|---|
| idle (a bot awake) | 48 | — | 296 × 32 |
| quiet | 90 | — | 380 × 32 |
| reaction ("On it") | 70 | — | 340 × 32 |
| working | 150 | — | 500 × 32 |
| several bots | 110 | — | 420 × 32 |
| listening | 110 | — | 420 × 32 |
| done | 150 | — | 500 × 32 |
| failed | 140 | — | 480 × 32 |
| approval / question | 120 | 76 | 440 × 108 |
| reply | 130 | 84 | 460 × 116 |
| hovered (quick actions) | 130 | 46 | 460 × 78 |

  In `plain` mode (no cut-out) the shape is content-sized, centred, 32 px, radius `0 0 18px 18px`, the face in the middle (canvas "No notch, more room"); in `capsule` mode (Windows) 36 px, radius 999, the body on the `growth` side.
- The shell measures the target shape from `shapeFor(presentation, layout)` (pure) **before** navigating and calls `notch.setShape` (§11.6); CSS `transition: width, height` animate the shape (§16).

### 11.6 Director (`director.ts`)

`NotchDirector` subscribes to the presentation and drives the router. Every run of the director is a **generation** (`gen = ++director.gen`); after **each** await (thread load, `setShape`, navigation) it checks `gen === director.gen` and stops if a newer presentation arrived (review #16).

1. **Hover lock** (an idea from PLAN, "while the pointer is over an attention state, updates queue"): the lock holds only while **the user is interacting** — the pointer is inside the shape, or the window is focused (typing a reply, answering) — not merely because the body auto-expanded (review #15). While locked, a presentation whose identity differs is **queued** (`notchUiStore.queued`, latest wins) and applied on pointer leave, blur or collapse, with three exceptions applied **immediately** even while locked: the item on screen became invalid (its descriptor was answered elsewhere, expired or was snoozed; its run was superseded), quiet hours started, or the main window gained focus while the notch is not focused (calm). R6-T17 answers an approval in the main window with the pointer resting on the notch and asserts the next item shows at once.
2. **Bounded, cancellable load** (review r2 #9): the director calls `context.chat.session(id).load({ signal })` (chat-kit amendment §23.2: `load` takes an optional `AbortSignal`) with an `AbortController` that fires on a **total presentation deadline of 8 s** or when a newer generation starts. An abort rejects **only this caller's** await with `AbortError`; other waiters on the shared readiness are unaffected. When no waiter remains and no view is mounted, the kit retires that generation: the in-flight `ai.hydrate` is aborted through oRPC's signal and the `ai.subscribe` iterator closes. The director then calls `retire()` for a session it will not show. On timeout or failure it keeps the compact wing with **Open** and marks the session unavailable for 30 s (policy: long enough not to loop on a broken thread, short enough to retry within one approval's lifetime). R6-T17 stalls `ai.hydrate` and asserts the request is aborted and the iterator count returns to baseline.
3. **Envelope, navigate, final** (§10.2): `await notch.setShape({ phase: "envelope", … })`, then `navigate({ to, params, search, replace: true, state: navIntent("notch-expand" | "notch-contract" | "notch-swap") })`, then `await shapeSettled(gen)` and `notch.setShape({ phase: "final", … })`, each step generation-checked. `visible: false` hides the window (`hide()`), `true` shows it inactive.
4. **Hover intent** (the foundation's own values, §7.2–§7.3: 120 ms rail hover intent, 300 ms leave grace): a pointer resting 120 ms on a non-expanded shape opens the quick-actions body; leaving closes it after 300 ms.
5. **Shortcut** (`notch.events { shortcut }`): opens the most urgent approval/question or the newest reply with focus; with nothing to show, opens the quick actions of the most recent bot.
6. **Preview** (tour stop 12): wink + the idle wings for 3 s, even when idle is hidden.

### 11.7 Reactions (canvas `NotchRules` "Reacts to the app")

| Trigger | Source | Reaction (600 ms, 03 §14.2) |
|---|---|---|
| Send in the main window | `notch.events { reaction: "wink" }` (§10.10) | `wink` + caption "On it" (reaction shape) |
| A run finished `success` | `ai.runFinished` | `happy` then the `done` bounce |
| A run finished `error` | same | `error` (the shake) |
| Main window focused | `notch.events { app }` | calm (§11.4) |

Reactions play on the face of the session's bot in the wings; under reduced motion the face swaps without keyframes.

---

## 12. Flows in the notch (`features/notch/views/`)

### 12.1 Approval (`/approval/$id`, canvas `Notch` "Needs you")

- Rendered by the chat kit: `<PermissionList threadId={id} variant="notch" limit={1} />` (02 §6.2 "the notch mounts the same component"; the `variant` prop is amendment §23.2). One decision logic, one answering state, one set of labels.
- Wings: left = face (`waiting`) + bot or session name; right = "⌘↩" hint (only while focused) and **Not now**. Body: the descriptor's title (the kit's `decisionTitle`, e.g. "Send this from Gmail?"), one summary line (ellipsis), then pills.
- **Decisions offered in the notch** (the rest need the full card): the primary accept (`accept`, label by kind from the kit, e.g. "Allow", "Send", "Run"), `reject` ("Deny"), and **Review** (`notch.openInApp` to the chat). `allowAlways`, rules, `allowYolo`, `background`, `accept_with_message` are never shown here.
- **Safety predicate** (review #22; `notchAcceptable(d): { ok: true; lines: string[] } | { ok: false; reason }`, exported by the kit, amendment §23.2). Accept is offered only when **every field that decides the request** is shown in full in the body, as text the notch renders without truncation (a measured check: each line's `scrollWidth <= clientWidth` at the body width, at most two lines). Per request variant (`shared/agent-types.ts:238-360`):

| Variant | Fields that must be visible in full | Otherwise |
|---|---|---|
| `run_terminal` | `command`, `cwd`, "in the background" when `background` | Review only when `credentialPaths` or `unmatchedPatterns` is non-empty |
| `delete` | `filePath` | — |
| `read_outside_directory` | `resolvedPath` | — |
| `fetch_url` | the whole `url` (never just `origin`) | — |
| `network_host` | `host:port` | — |
| `sandbox_denied` | `command`, every denial (`read`/`write` path, `host:port`) and `note` in full when present (what the command said it would do outside the workspace, `shared/agent-types.ts`) | Review when more than two denials, or when `note` does not fit (review r2 #23) |
| `browser_action` | `action`, the whole `url` when present, `description` | — |
| `edit_file`, `write_file`, `notebook_edit`, `edit_outside_directory`, `write_outside_directory`, `notebook_edit_outside_directory`, `exit_plan_mode` | — (the content or diff cannot be shown in a notch) | **Review only**, always |
| `generic` | — (`inputSummary` is already a summary) | **Review only**, always |
| `ask_user_question` | §12.2 | — |
| any variant not in this table | — | **Review only** |

  "Fits" means both dimensions (review r2 #24): every required field renders without horizontal overflow **and** the body, with its pills, fits the returned `layout.maxShape` height; if either overflows, accept is withheld. Measured in the real renderer with the shipped fonts and the active locale's strings (R6-T41, Electron). When accept is withheld the body reads "Check this in the app" with **Deny** and **Review**. R6-T18 runs every variant, a credential warning, a URL that differs only after its origin, and paths and commands at and just past the fitting width.
- **Not now** snoozes that descriptor in this document (`notchUiStore.snoozed`, until a new descriptor arrives or 10 minutes), collapses the body and keeps it in the count. It sends nothing.
- Answering: `runtime.respondPermission(d, decision)` (02 §6.3): the pill shows the kit's answering state; `permission.resolved` + `pending` remove it and the presenter moves on; `permission.response_rejected` shows the kit's copy with **Review**; 10 s without resolution → "No response from the agent" + **Review**. A second window or the main window answering first makes the descriptor vanish (the kit's rule).
- Keyboard (only while focused): `Mod+Enter` = primary, `Escape` = Not now (canvas "⌘↩ and Esc"). Clicking pills needs no focus (`acceptFirstMouse`).
- `remaining > 0` shows "{n} more" on the right wing; the next item follows without collapsing.

### 12.2 Question (`/approval/$id` with `reason: "abacus:question"`)

- In the notch only when every question has `multiSelect: false` and the notch can show it **in full** (review #22): the `header` and `question` text within two lines, and every option's `label` as a pill in one row at the body width, with each option's `description` either absent or within one line under the row (measured as in §12.1). One question at a time (a haptic per step when enabled); the answers are encoded by the kit's `encodeQuestionAnswers` (02 F19, byte-identical to the composer's questionnaire, amendment §23.2) and sent once as `{ type: "question_answers", answers }`.
- Otherwise: "{bot} has a question" + **Answer in app** (`openInApp`) + **Not now**. "Skip all" (`"reject"`) is not offered in the notch.

### 12.3 Reply (`/reply/$id`, canvas `Notch` "Reply arrived")

- Wings: face `talking` + bot name; right **Open**. Body: the last assistant message of the held thread as plain text, 3 lines clamped (the kit's `messagePlainText(message)` export, amendment §23.2, so markdown, tool parts and math are never rendered here), then a 26 px reply field "Reply…" and a mic button.
- The field exists only for `canReply` (the bot's own chat, `owner.role === "forever"`); sender chats and check-in runs are read-only (03 §11.5) and show **Open** only.
- Clicking the field → `notch.focus({ focus: true })`, then focus the input. `Enter` → `session.submit(text)` (02 §3.7): `started`/`queued` → clear, collapse, wink; `rejected` or a thrown error → "Couldn't send. Open the chat to try again." with the text kept. The draft lives in `notchUiStore.drafts[sessionId]` until sent or 10 minutes. `Escape` → collapse and unfocus.

### 12.4 Working, done, failed

- **Working** (`/working`): face `working` + caption (the kit's running-tool title when the thread is held, else "{bot} is working" / the session label), a 14 px indeterminate ring on the right (there is no progress figure in the data). Several: stacked faces + "{n} working".
- **Done** (`/done`, 5 s): face `done` + "{label} · Done" + **Open**. The canvas's "Summary ready · 2 files" needs a result summary the data does not carry; not built (§24.3).
- **Failed** (`/failed`): face `blocked` + the kit's `runErrorCopy(code)` (amendment §23.2; e.g. "Rate limited") + **Open** + dismiss (×). The canvas's **Retry** is not built (F17).

### 12.5 Listening (`/call`) and dictation (`lib/voice/`, F7)

- `lib/voice/` is a port of `renderer/voice/{recorder,whisper,use-dictation}.ts` (push-to-talk, Whisper through `@huggingface/transformers` loaded lazily, model files through `voice.whisper.fetch`, progress through `voice.whisper.progress`, microphone through `voice.requestMicrophone`), without `window.api` (contract procedures instead) and with its tests. The composer's `Dictate` slot uses it too (amendment §23.2).
- Entered from the reply mic (or the hover "Call" action, which opens the reply with the mic on): wings show the `listening` face, a six-bar waveform driven by the recorder's level, a `m:ss` timer and **End**. End → transcribe; the first use downloads the model ("Getting ready… {pct}%" on the wing); the text is inserted into the reply draft and the view returns to `/reply/$id` focused. Nothing is sent without the user pressing Enter.
- Errors: microphone refused → "Microphone access is off. Turn it on in System Settings › Privacy." (there is no microphone pane in `system.openPrivacyPane`, so no button); transcription failed → "Couldn't catch that. Try again." Both return to the reply view.
- **Operation tokens** (review r2 #22): each dictation is an operation `{ id, sessionId, state }` in `lib/voice`'s store. Its states are `acquiring → recording → transcribing → done`. **End** moves the current operation from `recording` to `transcribing` **without** invalidating its token (review r3 #2), and its transcript is inserted once. Cancel, unmount, a session change or a newer operation marks it stale: a microphone permission or `getUserMedia` result that arrives for a stale operation stops its tracks at once and never creates a recorder; a transcript for a stale operation or another session is discarded, never inserted. The pipeline is disposed only when no operation is transcribing (disposal waits for the in-flight transcription, then runs); a new operation during disposal loads a fresh pipeline. R6-T21 delays the permission, `getUserMedia` and transcription results past cancel and session change, and asserts that a normal End inserts exactly one transcript.
- The Whisper pipeline in the notch document is disposed after 2 minutes idle (policy: long enough for a back-and-forth of several dictated replies, short enough to release the model's memory when the notch goes quiet); its memory cost is **unverified** (R6-T27 measures it).

### 12.6 Quick actions (hover, canvas `Notch` "Hovered")

For the leftmost face's bot: **Message** and **Call** (review r2 #17) are click-owned: the click calls `bots.openChat({ botId })` (the existing contract procedure, `bots.ts:32-34`, which creates the forever chat when the bot has none and returns its `BotChatHandle`), awaits it, then the bounded `session.load` of §11.6, then navigates to `/reply/$sessionId` focused (Call also starts the mic). A failure shows "Couldn't open the chat" inline; nothing is created by hover or presentation, **Pause** / **Resume** check-ins (`routinesCollection.update(checkInRoutineId, (d) => { d.enabled = next })` over `db.routines`, spec 00 B.2; the notch preloads the `routines` collection the first time the quick actions open, and the pill shows a pending state until the echo; a failure rolls back and shows "Couldn't pause check-ins" inline), **Open app** (`openInApp`). For a session face: **Open** only.

### 12.7 Open in app

`notch.openInApp(target)` → main reveals the main window (`revealMainWindow`, `index.ts:350-358`) and enqueues a lossless open command (§10.10); the main renderer's `OpenTargetBridge` navigates and acknowledges it (bot → `/bots/$botId` or `/bots/$botId/chats/$sessionId` for sender chats; session → `/sessions/$sessionId`; routine run → `/routines/$routineId?run=$sessionId`, F24). The notch collapses and marks the attention acknowledged.

---

### 12.8 Connector asks (`/approval/$id?ask=<requestId>`, review r2 #15)

A pending connector request (the connector gate, `connectors.events()`, 03 §11.4) is not a permission descriptor and has its own response flow in the chat (`ConnectorRequestCard`). The notch does not answer it: `ConnectorAskView` shows the face (`waiting`), "{bot} wants to use {connector}" (names from the request and the registry), **Open** (`openInApp` to the chat whose conversation raised it, where the card is) and **Not now** (local snooze as §12.1). No thread is loaded for it. R6-T18 covers a connector ask with no pending permission.

---

## 13. OS notifications policy

1. **Silent** in the new generation (05 §31.5 d): the in-app cue is the sound.
2. **One path**: every attention notification goes through 05 r3's `notifyAttention` (§23.3 there: kinds `needs-you` and `done`, a `dedupeKey`, focus/Notify-me/quiet-hours/per-bot gates) and `system.notify({ title, body, metadata, kind, dedupeKey })`; this spec adds `dedupeKey` to the procedure's input (05 already passes `kind`).
3. **Visibility is a main-side fact** (review r2 #18, r3 #1): main treats a notch window as **seen** only when all hold: (a) main itself shows it (it has not called `hide()`; tracked from `show`/`hide` events and `isVisible()`); (b) the window's **active** contents (§10.6) last reported `notch.visibility({ documentVisible: true })`, sent on boot and on every `visibilitychange` — meaningful because background throttling is kept (W9), so Chromium's Page Visibility follows hiding and occlusion; (c) no active-Space change has happened since that report: main subscribes to `systemPreferences.subscribeWorkspaceNotification("NSWorkspaceActiveSpaceDidChangeNotification")` (E:14418) and marks every notch window unseen until its next report. Main clears (b) on navigation (`did-start-navigation`), on disposal and on promotion of a replacement until the new active contents report. The banner rule, the background-task notice and the audible-document choice (§14.2) all read this one fact.
4. **Show in the notch** (canvas `SettingsNotifications`, F19): when `prefs.notch.showInNotch` is on, main **holds** a `needs-you` notification, or a `done` notification whose `metadata.kind` is `bot` (a reply), for 1.5 s and drops it only if some notch document whose stored visibility is `true` called `notch.presented({ dedupeKey, documentVisible: true })` for that key within the hold. Otherwise the banner shows. Other `done`/`failed` notifications always show. The 1.5 s hold is a policy value: longer than the notch's own path (notice → presenter → draw → IPC), which R6-T28 measures, and short enough that a banner is not noticeably late.
5. **Until proven**: whether Chromium reports the notch document `hidden` on another app's full-screen Space is **unverified**. Rule 4 ships behind `NOTCH_BANNER_SUPPRESSION`, **off** until R6-T30 records `hidden` on a full-screen Space and `visible` otherwise; while off, every banner shows.
6. The background "Task still running" notice (`index.ts:366-383`) follows the same flag and the same stored visibility: skipped only when `NOTCH_BANNER_SUPPRESSION` is on and a notch document currently reports `documentVisible: true` (NT3).
7. Clicks are unchanged (`system.events { notification-clicked }`, spec 00 A.2.3).

---

## 14. Sound

### 14.1 The cue set (our own design, review r2 #2)

The cue set is designed here, not inherited: 03 §17's `done` row now points to this section (the swept sine it cited is removed from 03 and PLAN). Each cue is defined by its **intent**, **duration bounds** and a **synthesis method** chosen here; the initial parameters are starting points, tuned by the listening test R6-T43 (below) within the bounds. All cues share one family: sine or triangle tones, fast attack (≤ 5 ms), exponential release, peak gain ≤ 0.1, so none is louder than a system alert and all read as one app.

| Cue | Intent | Duration bounds (total) | Synthesis method (initial parameters) |
|---|---|---|---|
| `sent` | "gone" — a quick, light confirmation of your own action | 60–120 ms | one sine with a short upward glide (660 → 880 Hz over 90 ms), gain 0.08 (03 §17's values, kept as a starting point) |
| `received` | "someone answered" — friendly, two notes | 120–220 ms | two sine tones, a major sixth up (880 then 1175 Hz), 70 ms each, 40 ms apart, gain 0.07 (03 §17) |
| `needs-you` | "look at me" — the most insistent, but short | 200–320 ms | three triangle pulses on one pitch (740 Hz), 60 ms each, 80 ms apart, gain 0.09 (03 §17) |
| `done` | "finished, all good" — resolved, calmer than `received` | 180–280 ms | **two sine tones, a rising perfect fifth (523 Hz then 784 Hz, C5 → G5), 90 ms each, 30 ms apart, the second with a 60 ms exponential release**, gain 0.08. Designed here: a resolved interval distinct from `received`'s sixth and from `failed`'s falling tone |
| `failed` | "that didn't work" — falling, never alarming | 150–250 ms | one sine falling 440 → 294 Hz over 180 ms, gain 0.08 (03 §17) |
| `routine-fired` | "a schedule ran" — neutral, soft | 120–200 ms | two sines 587 then 784 Hz, 50 ms each, 60 ms apart, gain 0.06 (05 §23.1) |

**Listening test (R6-T43, recorded):** three listeners on laptop speakers and headphones rate, for each cue, whether it is (a) recognisable among the six without labels after one exposure, (b) not unpleasant at system volume, (c) distinct from macOS/Windows default alert sounds. A cue failing any point is retuned inside its bounds; the final parameters are written to `lib/sound.ts` with the date of the test. The automated half (R6-T22) only checks that each cue schedules audible output within its bounds (`OfflineAudioContext` energy in the window, none after it).

### 14.2 Central arbitration (`src/main/notch/cue-arbiter.ts`, F18)

- **The audible document** is one specific `webContents` id, chosen by main: the main renderer when the main window is focused, when no notch document is ready with an unlocked `AudioContext` (`setShape`'s `audio: true`), or when the companion is disabled; otherwise **one** notch document — the one on the display nearest the cursor among ready, unlocked, visible notch documents, else the one on the primary display.
- **Focused-thread silence first** (review r2 #12): the main renderer reports the thread it is showing through `window.visibleThread({ threadId: string | null })` (on every route commit and on focus/blur). A claim carries `threadId`; main **declines** (`play: false`, recorded as *suppressed*) any claim whose `threadId` equals the main window's visible thread while the main window is focused, before any other rule. A suppressed `cueId` is never granted later by the fallback.
- **Who may claim** (review r3 #7): only a document that can play — the main renderer, or an **active** (not standby) notch contents that is ready, has reported `audio: true` (an unlocked `AudioContext`) and whose window is seen (§13). Main answers any other claim `play: false` at once, and a notch document with a locked context does not send claims at all.
- **Per-cue claim**: before playing an attention cue a document calls `window.claimCue({ cueId, threadId })` with `cueId = ${kind}:${dedupeKey}` (keys as 05 §23.3). Main grants `play: true` to exactly one caller per `cueId`: the first claim from the audible document; if the audible document has not claimed within 1 s (it missed the event), main grants the earliest other claimant **that is still eligible at grant time** — rechecking that its contents still exist and are active, ready, unlocked and (for a notch) seen — trying claimants in arrival order; if none is eligible the cue is dropped (policy: 1 s is well past normal IPC and notice delivery, which R6-T22 measures, and short enough that a late cue still relates to its event). Every other claim gets `false`. The claim map is bounded (1,000 entries, 10 minutes: longer than any notice replay window within a document).
- `sent` (only the focused main window) and `routine-fired` (main document) do not claim. Both documents apply the foundation gates (400 ms coalescing), 05's `allowed` (quiet hours, per-bot level) and the per-cue switches **before** claiming.
- R6-T22 runs three notch documents (mixed locked and unlocked, one standby) plus the main one with shuffled event and focus deliveries: exactly one `play: true` per `cueId`, never to a locked, standby, unseen or disposed claimant (one is disposed during the 1 s fallback), none lost while an eligible claimant exists, and none for a cue whose thread is visible in the focused main window.

### 14.3 One notice-to-cue mapping (`lib/attention/cues.ts`, review r2 #13)

A single pure function used by every watcher in every document (03's bots watcher, 04's sessions watcher, 05's routines watcher, the notch player), so the same notice always maps to the same cue kind and key:

```ts
export function cueForNotice(n: RunFinishedNotice, ctx: { checkInRoutineIds: ReadonlySet<string> }): { kind: "received" | "done" | "failed"; dedupeKey: string } | null;
```

| Session (from `owner`, `routineId`) | `outcome` | `hasVisibleAssistantText` | Cue |
|---|---|---|---|
| any | `cancelled` | any | none |
| any | `error` | any | `failed` |
| bot forever or sender chat | `success` | `true` | `received` |
| bot forever or sender chat | `success` | `false` | none (silent turn) |
| check-in run (`routineId` ∈ check-in routines) | `success` | any | `done` |
| ordinary routine run | `success` | any | `done` |
| listed session (no owner, no routine) | `success` | any | `done` |

`dedupeKey` = `runId`. `needs-you` comes from `turnTransitions` (`sessionId:turn.updatedAt`) and connector asks (the ask id). Each watcher in the main document now takes its kind from this table (amendments §23.3–§23.5) instead of its own predicate; R6-T22 tests every row across owners.

### 14.4 The notch player (`features/notch/sound.ts`)

`createSoundPlayer` with the shared `prefs().sounds` and the claim step. Triggers are independent of the presentation: `needs-you` from `turnTransitions(sessionsCollection)` for every session kind and from new connector asks, outcome cues from `cueForNotice` over `ai.runFinished`. Every trigger claims with its `threadId`; main's focused-thread rule and arbitration decide. The `AudioContext` unlock needs a user gesture: the notch's first pointerdown unlocks it and it reports `audio: true` on its next `setShape`; until then it is never audible and sends no claims (§14.2). Haptics accompany a `needs-you` expansion when enabled (§10.7).

### 14.5 Per-bot level, quiet hours, preview

Unchanged from 05 §22–§23: the notch uses the same `allowed(kind, { botId, now, sounds })` and `isQuietNow`, with the bot attributed as §11.4 (owner, else the run's routine's bot). Preview stays on the Settings page (main document) and does not claim.

---

## 15. Settings rows added (05's reserved rows)

| Page | Row (`data-setting-id`) | Control | Source / write | Notes |
|---|---|---|---|---|
| General | Notch companion (`notchCompanion`) | Switch; detail "Live status, replies and approvals from the notch" (macOS) / "…from a capsule by the clock" (Windows) | `prefs.notch.enabled` via `updatePrefs` | hidden when `notch.status().reason === "platform"`; failed start shows "The notch companion couldn't start.", unknown metrics show "The notch companion couldn't measure this screen.", each with **Try again** (`notch.retry()`, §10.6) |
| General | Show when idle (`notchIdle`) | Switch, under the companion row | `prefs.notch.idleVisible` | only when enabled |
| General | On every display (`notchDisplays`) | Switch | `prefs.notch.extraDisplays` | macOS only |
| General | Haptics (`notchHaptics`) | Switch | `prefs.notch.haptics` | macOS only; default decided by R6-T31's latency measurement (§10.7) |
| General | Shortcut (`notchShortcut`) | read-only `Kbd` `⌘⇧Space` / `Ctrl+Shift+Space`, or "In use by another app" | `notch.status().shortcut` | 05 §21.3 lists it as not rebindable |
| General | Take the tour (`tour`) | secondary button **Take the tour** | `startTour({ origin })` (§9.5) | detail "Twelve stops, skip any time." (count from the stop list) |
| Notifications | Show in the notch (`showInNotch`) | Switch; "Replies and approvals appear in the notch companion, not as banners" | `prefs.notch.showInNotch` | only when the companion is available |

All rows join 05's `SETTINGS_INDEX` (05 R5-T24 checks both ways).

---

## 16. Motion

All values from `lib/motion.ts` via `motionFor`; reduced motion (the pref or `prefers-reduced-motion`) collapses every entry to a 120 ms fade and every layout or spring animation to a cut (foundation §7.8). **Route changes** — onboarding step to step, onboarding to the shell, and every notch route change — are the router's **document-level view transitions** with types from the committing location (foundation §6.7 impl amendment, F26); cross-route shared elements use `useSharedElementName`; React `<ViewTransition>` is used only for changes inside one route. New constants go into `lib/motion.ts` once and are mirrored in CSS where CSS runs them (R6-T37 compares the two). Every number's source is stated:

```ts
export const onboarding = { stepExit: 160, stepEnter: 320, stagger: 60, rise: 12, shellScaleFrom: 0.98 } as const;                 // canvas OnboardMotion
export const spotlight = { mask: { type: "spring", mass: 1, stiffness: 80, damping: 14 }, cardLag: 40 } as const;                  // canvas OnboardMotion "spring(1, 80, 14)", "40ms behind"
export const hatch = { wobbleCycles: 3, wobbleMs: 220, squash: 0.9, pop: 1.08, settle: { type: "spring", mass: 1, stiffness: 420, damping: 18 }, confettiMs: 2400, confettiPieces: 7 } as const;   // canvas OnboardMotion for the sequence; `settle` see below
export const notch = { shape: 350, contentFade: 120, reaction: 600, doneDwell: 5000, replyExpanded: 6000, ackExpiry: 600_000 } as const;   // canvas NotchRules (350, 120, 600); dwell values ours
export type NavType = /* foundation's */ | "onboarding-step" | "onboarding-finish" | "notch-expand" | "notch-contract" | "notch-swap";
```

| Moment | Owner | Spec |
|---|---|---|
| Step to step (onboarding) | router document transition, type `onboarding-step` (the step buttons navigate with that intent); CSS keyed by `:active-view-transition-type(onboarding-step)` on the `_bare` content (`view-transition-name: onboarding-step`) | old content up 12 px + fade 160 ms; new rises 12 px + fades 320 ms; children staggered 60 ms by CSS `animation-delay` on the new content (canvas `OnboardMotion`); the progress pill's active mark widens 300 ms (a CSS transition in the drag strip, which is outside the swapped content) |
| Onboarding → shell (done → bot chat) | router document transition, type `onboarding-finish`; the done step's centre (first-bot) avatar and the transcript header avatar both carry `useSharedElementName("bot-identity-" + botId)` (03 §16.2's name) | 420 ms `easings.standard` (foundation `durations.sharedElement`); the new root fades in from scale 0.98 |
| Hatch | `BotAvatar` `hatch` prop: CSS keyframes (wobble, squash) + `motion` spring (pop, settle) inside the route | §8.2; reduced → 120 ms cross-fade |
| Confetti | CSS keyframes, seven pieces, 2.4 s, once | skipped when reduced |
| Spotlight mask | `motion` on one element's `x/y/width/height` with `spotlight.mask` (in-route, the tour host) | card follows `cardLag` 40 ms; reduced → the mask cuts, the card fades |
| Notch shape grow / shrink | CSS `transition: width 350ms, height 350ms` with `easings.standard` on the shape (canvas "Grow, never pop") | the window grows before and shrinks after (§10.2) |
| Notch route change (body/wing content) | the notch router's document transition, types `notch-expand` / `notch-contract` / `notch-swap` | old content fades out 120 ms; new content fades in 120 ms **after** the shape settles (a 350 ms `animation-delay` for expand/contract, none for swap) (canvas) |
| In-route notch changes (count badge, caption, face) | React `<ViewTransition>` inside the route, or CSS | 120 ms fade |
| Face reactions, moods | `BotAvatar` (03 §14.2) | 600 ms reactions (canvas); static under reduced motion |
| Listening waveform | CSS keyframes per bar (canvas `nb-wave` 0.9 s) scaled by the recorder level | static bars at the current level when reduced |

**Spring model** (review r2 #25). `motion` springs are mass–spring–damper systems parameterised by `mass`, `stiffness` and `damping`; the damping ratio is ζ = damping / (2 √(stiffness × mass)). The hatch's `settle` (mass 1, stiffness 420, damping 18) has ζ ≈ 0.44: underdamped, so the bot overshoots once and settles within ~0.4 s, which is the visible "pop" the canvas asks for. It is **not** a conversion of the canvas's "0.6 damping" (that figure has no stated model); it is a starting value chosen for the look, tuned by eye in the gallery's hatch replay. The spotlight mask uses the canvas's own "spring(1, 80, 14)" read as mass 1, stiffness 80, damping 14 (ζ ≈ 0.78), which is how `motion` names those parameters.

**Policy constants** (review r2 #25). Every number in §10–§14 that is not from the canvas, the foundation or a platform document is a chosen policy with a stated reason; tests pin them and name the recording that may change them:

| Constant | Value | Reason | Revisited by |
|---|---|---|---|
| Screen-event reconcile debounce | 250 ms | a lid close or dock (un)plug emits added/removed/metrics-changed within a fraction of a second; one reconcile per burst avoids creating and disposing windows mid-burst, and 250 ms is below the point where a user waits for the notch to reappear | R6-T32 (records the burst spread) |
| Windows auto-hidden taskbar reserve | 48 px | Windows 11's default taskbar height at 100 % scale; the capsule must not sit where the taskbar slides in | R6-T33 hardware run |
| Readiness/crash backoff | 2 s, 10 s, 60 s, give up after 3 in 10 min | a fast retry for a transient boot failure, then slower, then stop so a broken build does not spin; **Try again** resets it | R6-T25 |
| Probe timeout | 3 s | a JXA cold start is well under a second on current Macs; 3 s leaves margin without blocking the reconcile | R6-T31 (records probe time) |
| Presentation deadline | 8 s | above the kit's 5 s replay cap plus a hydrate round-trip; beyond it an attention is better shown as a wing with Open than as a stall | R6-T17 |
| Unavailable-session back-off | 30 s | §11.6 | R6-T17 |
| Done dwell / reply expanded / ack expiry | 5 s / 6 s / 10 min | long enough to be read at a glance; a reply needs a sentence of reading; ten minutes keeps an unread reply across a short absence without piling up | R6-T36 walk-through feedback |
| Banner hold | 1.5 s | §13 | R6-T28 |
| Cue fallback / claim map | 1 s / 1,000 entries, 10 min | §14.2 | R6-T22 |
| Haptic latency threshold | 150 ms | §10.7 | R6-T31 |
| Whisper idle disposal | 2 min | §12.5 | R6-T27 |
| Max shape | 560 × 220 | §10.2 (canvas-derived) | R6-T42 |

The notch document wraps its tree in `<MotionConfig reducedMotion="user">` plus the prefs override (`motionFor`). Reduced motion in the notch: shape size changes **snap**, content cross-fades 120 ms. The foundation's single-transition guard (R1-T11b) is extended through onboarding and notch navigations (R6-T37).

---

## 17. i18n

New keys under `onboarding.*` (sub-objects that do not exist yet, foundation §9.3: `onboarding.frame.*`, `onboarding.welcome.*`, `onboarding.connect.*`, `onboarding.connected.*`, `onboarding.models.*`, `onboarding.connectors.*`, `onboarding.firstBot.*`, `onboarding.done.*`), `tour.*` (`tour.stops.<id>.{title,body,bullets.*}`, `tour.card.*`), `notch.*` (`notch.wings.*`, `notch.approval.*`, `notch.reply.*`, `notch.listening.*`, `notch.done.*`, `notch.failed.*`, `notch.quiet.*`, `notch.actions.*`, `notch.a11y.*`), and `settings.general.notch.*`, `settings.notifications.showInNotch.*`. Reused strings are mapped through `scripts/locale-keymap.json` (03 §18 pattern) so all 11 locales arrive translated:

| New family | Old source |
|---|---|
| `onboarding.welcome.*` (title, tagline, badge, capabilities, CTAs, hint, profile menu) | `onboarding.welcomeTitle`, `welcomeTagline`, `welcomeFreeBadge`, capabilities, `connectCta`, `haveAccountCta`, `haveAccountContinueWith`, `signInOptions`, `continueWithBrowser`, `signInAnotherWay`, `usesBrowserSessions` |
| `onboarding.connect.*` | `onboarding.openInBrowserCta`, `common.cancel`, `onboarding.abacusUnidentified`, `apiKeys.connecting` |
| `onboarding.connected.*` | `onboarding.abacusConnected`, `connectedTitleLead`, `connectedTitleName`, the four promise leads/bodies, `connectedCta` |
| `onboarding.models.*` | `onboarding.setupTitle*`, provider blurbs, "Existing subscriptions" copy, `setupKeyInvalid`, `setupDoneCta` |
| `onboarding.connectors.*` | `onboarding.connectorsTitleLead/TitleAccent/Subtitle`, continue labels, `connectors.abacusConnectFailed` |
| `onboarding.firstBot.*` | `firstBot.title` (reworded to the canvas: new key, old kept for the old renderer) and `bots.templates.chief-of-staff.*` read in place |
| `tour.card.*` | `tour.next`, `tour.skip`, `tour.finish`, `tour.optional`, `tour.progress`, `common.back`; `tour.replay` for the Settings row |
| `tour.stops.{rail,make-bot,connectors,preview-terminal}.*` | `tour.steps.{bots,makeBot,connectors,terminal}.*` |
| `tour.stops.{workspaces,start-session,memory,artifacts,changes,welcome}.*` | the unused old families `tour.steps.{sidebar,newSession,memory,artifacts,changes,welcome}.*` where the wording still fits; `tour.steps.welcome.body` ("Fifteen short stops") is **not** reused (wrong count) |
| `settings.notifications.showInNotch.*` | new (canvas) |

- Retired (listed in `scripts/locale-retired.json` with the reason, 05 R5-T35's gate): `onboarding.connectTitle`, `connectBody`, `signInCta`, `skipCta`, `setupSignInCta`, `setupAbacusNote`, `setupConnectorsTitle/Body/Cta` (unused already), `tour.steps.{messaging,capabilities,preview,usage}.*` (no stop), `notifications.*` emoji titles once 03/04 own the notification copy, `onboardingFlow.*` (phase-1 placeholder).
- Model-facing strings: none in this phase. Numbers and times use `Intl` ("Until 8:00", `m:ss`).
- Estimated ~210 new keys, ~110 mapped. R6-T34 checks every `t()` key exists, every keymap source exists, and folds into 05's "every `en-US` leaf accounted for" gate.

---

## 18. Accessibility

- **Onboarding**: each step has one `<h1>`; the progress pill is a `progressbar` with "Step {n} of 5"; the waiting row is `role="status"` (announced once); errors are `role="alert"`; focus moves to the step's `<h1>` on each step change (so screen readers hear the new step), then Tab reaches the primary button first; the parade and confetti are `aria-hidden`; the key dialog is the registry `Dialog` with labelled field and described error (`aria-invalid` after display, 03 §19).
- **First bot**: the hatch is `aria-hidden`; a visually hidden live line announces "{name} is ready".
- **Tour**: the card is `role="dialog" aria-modal="true"` labelled by its title and described by its body; the shell is `inert` while it runs; focus lands on **Next** each stop and returns on end; `Escape` skips; the spotlight's highlighted element gets no focus (it is `inert` with the shell); the step count is in the text.
- **Notch**: the shape is a `region` "AbacusAI Bot companion" (`aria-live="off"`); each state's primary text is a heading level 2 inside it; attention changes are announced once through a polite live region **only while the notch window is focused** (an unfocused panel's announcements would reach VoiceOver out of context); every pill is a `<button>` with a name; faces have `alt` via the avatar's `aria-label` ("{bot}, needs you"). The notch is reachable by keyboard with the global shortcut (§10.5) and is a **mirror**: every approval, question, reply and open action is also available in the main window (the chat kit's cards, the needs-you group), so nothing depends on the notch.
- **Reduced transparency / contrast**: the notch shape is opaque black; text and pills are computed ≥ 4.5:1 (R6-T35).
- R6-T35 runs axe over every gallery section (onboarding steps, tour card on each stop fixture, every notch state in both modes) and over the real onboarding routes in the screenshot run.

---

## 19. Gallery (`/__ui`) and screenshots

| Section | Content | Canvas boards |
|---|---|---|
| `onboarding` | each step in each state: welcome (with and without a browser profile), connect (waiting, error, unidentified), connected, models (signed in/out, OpenRouter connecting, key dialog valid/invalid, local model downloading), connectors (grid, many more, one connecting, one connected, messaging queued), first-bot (hatching, ready, removed), done (with/without bot) | OnboardWelcome, OnboardConnect, OnboardConnected, OnboardModels, OnboardKeyDialog, OnboardConnectors, OnboardFirstBot, OnboardDone |
| `onboarding-motion` | buttons replaying the step transition, hatch, confetti, parade flight | OnboardMotion |
| `tour` | the spotlight over a fixture shell at every stop (anchor present), a centred-card stop (anchor missing), the last stop with and without the notch | TourMap, TourRail, TourComposer, TourPanel, TourNotch |
| `notch` | a 680 × 150 frame per state with a fake menu bar and a 200 × 32 cut-out: hidden, idle, working, needs-you (approval, question, truncated), reply (field, read-only), listening, done, failed, several bots, hovered, quiet hours, reaction; plain mode; Windows capsule (growing up) | Notch, NotchRules |

The notch views render in the main document's gallery with a fake `NotchLayout`, fake presentation inputs and the chat kit's scripted fixtures (02 §14.8) for descriptors, so every state is a screenshot target without a second window. The screenshot script (foundation §10.2) gains `/onboarding/{welcome,connect,connected,models,connectors,first-bot,done}` (seeded to reach each), `/__ui?section=tour&open=<stop>` for the 12 stops, `/__ui?section=notch&state=<id>` for each state, and on macOS a real-window capture of the notch (the display's top 150 px through `desktopCapturer`-free CDP `Page.captureScreenshot` of the notch view itself, since the panel is its own web contents).

---

## 20. Tests

Projects as 05 §28: **jsdom** = vitest `renderer-next`; **main** = vitest `main`; **shared** = vitest `shared`; **Electron** = `main-serial` with the A-T12 harness (isolated profile + CDP), which CI runs on `ubuntu-latest`, `macos-latest` and `windows-latest` (`ci.yml:110-135` runs `pnpm run test`, every vitest project); **package** = the packaged-app smoke job (`ci.yml:220-310`, macOS and Windows runners); **hardware** = a recorded run on a named physical machine, attached to the PR (the phase gate requires it; CI cannot provide a notch). "Fake tables", "memory transport" as 05 §28. No test uses `skipIf(!runnable)` to pass silently: an Electron test that cannot run on a platform is **excluded by name** for that platform with the reason, and the CI job fails if an included test skips (review class 24).

| Id | File | Runs in | What it proves |
|---|---|---|---|
| R6-T1 | `routes/phase6.routes.test.ts` + `notch-routes/notch-router.test.ts` + `scripts/build-three-entries.test.mjs` | jsdom + build | Main route tree snapshot gains `_bare/onboarding` layout ids; notch tree snapshot (`/idle`, `/working`, `/approval/$id`, `/reply/$id`, `/call`, `/done`, `/failed`); the notch router uses memory history, `replace` only (history length stays 1 after 50 navigations), no preload; unknown path → `/idle`; `vite build` emits `index.html`, `index-next.html` **and** `notch.html`, and a dev server serves both route trees with Fast Refresh (decides the two-plugin claim). |
| R6-T2 | `features/onboarding/gate.test.ts` | jsdom (memory transport) | `_shell` redirects a not-onboarded account to `resumeStep(prefs)` with `replace` before any shell component renders; an onboarded signed-out account reaches the shell (F9); `/onboarding/*` for an onboarded account redirects to `/bots/new`; a failing `account.state` in bootstrap lets the user in and logs. |
| R6-T3 | `routes/phase6.preload.test.ts` | jsdom (memory transport) | No onboarding loader calls `auth.abacus.start`, `auth.openRouter.start`, `connectors.connect*`, `db.bots.insert` or any mutation; `browserProfiles` is fetched only on `welcome`; cold direct navigation to each step with delayed snapshots renders the step (loaders await their own preload). Entering `done` sends no funnel step; `onboarding_done` is sent only by completion with `once: true`. |
| R6-T4 | `features/onboarding/machine.test.ts` | jsdom | Every §6.1 row × `FlowFacts` (signed in/out, paying tier, owns bot); `guardStep` for each unreachable combination. |
| R6-T5 | `features/onboarding/resume.test.ts` + `main/migrations/onboarding-step.test.ts` | jsdom (fake tables) + main | `resumeStep` table (flow 2 ids, `connect`, flow ≠ 2, garbage); entering a step writes `updatePrefs({ onboardingStep, onboardingFlow: 2 })` as a patch (same-value writes still sent); main: the legacy import and the live sync write canonical ids with `onboardingFlow = 2` (`auth → welcome`, `welcome → connected`, `explainer → first-bot`), so the same string `"welcome"` from the legacy store resumes at `connected` while renderer-next's `"welcome"` resumes at `welcome`; a `user` value is never overwritten by a later legacy write. |
| R6-T6 | `features/onboarding/complete.test.ts` + `e2e/onboarding-complete-kill.mjs` | jsdom (memory transport) + Electron | Order: exit persisted, then `account.skipOnboarding`, then the tail; each call failing in turn keeps or resumes correctly; the Electron case kills the app between every pair of steps and relaunches: the user always lands on the chosen exit (bot, edit, new session, bot + tour) with `onboarded: true`, `onboardingStep`/`onboardingExit` cleared, the funnel sent at most once; the pairing queue is untouched by completion. |
| R6-T7 | `features/onboarding/steps/sign-in.test.tsx` | jsdom (real router + memory transport, delayed fake `auth.abacus.*`) | The welcome click mints an attempt synchronously and `connect` renders (not redirected by its guard); a cold `/onboarding/connect` redirects to `welcome`; cancel → `welcome` and the late outcome of the cancelled attempt (ok or cancelled, delivered after a new attempt started) is ignored; Try again uses a new id; Skip from `connect` cancels then goes to `models`; restart during an attempt resumes at `welcome`; outcome copy per code; double click starts one attempt; no error message is parsed. r3: after `auth-failed` the retained failed attempt keeps `/onboarding/connect` valid through a route invalidation and a revalidating navigation (error and Try again stay); a cold URL with no attempt still redirects. |
| R6-T8 | `features/onboarding/steps/models-connectors.test.tsx` | jsdom (fake procedures) | Models connected rule = configured models ∪ stored keys (environment-only credentials show Connected; removing a stored key while the environment key remains stays Connected); OpenRouter hop and cancel on leave; key dialog validation (`isPlausibleApiKey` cases) and save; local-model row; **Skip → models Continue → connectors Continue → first bot → done with nothing configured**. Connectors grid = registry `onboarding: true` in order, every formerly offered connector (WhatsApp, Telegram, Discord, Gmail) reachable, `not-offered` hidden, many more; a hop cancelled on leaving; messaging with `pairing: "defer"` enables the platform, queues it in `prefs.onboardingPairing` (deduplicated, persisted) and does not navigate; after completion the queue drains through the banner and leaves the queue on connect or dismiss. |
| R6-T9 | `features/onboarding/steps/first-bot.test.tsx` | jsdom (fake tables + fake procedures with delayed persistence) | The pending state is set synchronously: a Strict Mode double mount and a remount before persistence create exactly one bot; skips with `has_bots` / `no_template` / `create_failed` and the funnel detail; the check-in is Weekdays 08:00; a failing check-in insert leaves `checkInRoutineId: null` and "No check-ins"; Start from scratch deletes the routine then the bot (retry idempotent, `NOT_FOUND` = done); Say hello keeps both; Take the tour sets the `bot-tour` exit; bot removed elsewhere → the removed state. r3: `createdBotId` keeps `first-bot` valid after the optimistic insert and the persistence echo; Start from scratch never navigates and holds/rejects the real routine transaction's `isPersisted.promise` before the bot delete starts. |
| R6-T10 | `features/onboarding/funnel.test.ts` | jsdom | Each step reports the parity funnel name (OB14) once per entry; no name outside `FUNNEL_STEPS` is ever sent (type + runtime). |
| R6-T11 | `components/spotlight/place-card.test.ts` | jsdom | `placeCard` picks right/left/bottom/top by space, clamps to 16 px and below the title bar, centres for a null rect; at 800 × 600 every stop's fixture rect yields an on-screen card. |
| R6-T12 | `components/spotlight/spotlight.test.tsx` | jsdom | Mask and card render; the card follows 40 ms after the mask (motion values from `lib/motion.ts`); the shell is `inert` while open and restored; focus on Next each stop, returned on end; Escape = skip; overlay click ignored; reduced motion → cut; `data-slot="tour-spotlight"` is in `OCCLUDER_SLOTS` and the no-drag selector. |
| R6-T13 | `features/onboarding/tour/tour.test.tsx` | jsdom (memory transport + fake tables) | Stop list 12 with the notch, 11 without (status unavailable); `prepare` navigations with inferred types; `waitForAnchor` resolves on a late-mounted element, returns null after 2 s and the stop becomes a centred card; Next/Back await `prepare`; finish → `status: "done"` + `tour_done` + back to origin; skip → `skipped`; `tourSignedOut` ends without status; replay from Settings and the command menu; not startable before onboarding. |
| R6-T14 | `lib/tour/anchors.placement.test.tsx` | jsdom | Rendering the shell and each page places every `TOUR_ANCHORS` id exactly once at the owner in §9.2 (fails when an owner drops one). |
| R6-T15 | `features/notch/inputs.test.ts` | jsdom (fake tables + fake iterators) | Levels from rows, outcomes only from `ai.runFinished` through `lib/run-finished.ts` (a sessions batch that goes busy → idle produces no reply/done); the main document's bots/sessions consumers and the notch receive the same notices from the same feed module; duplicate run ids once; `cancelled` nothing; connector asks after the keyless snapshot; ownerless check-in runs and ordinary routine runs are attributed through `routinesCollection`. |
| R6-T16 | `features/notch/presenter.test.ts` | jsdom | `presentNotch` table: priority order and oldest-first; every session kind including routine runs (F24); per-bot `nothing`/`needs-me` applied to ownerless check-in and routine runs via the routine's bot; calm while main focused; quiet hours; dwell (done 5 s, reply 6 s expanded then collapsed, failed until ack/new run/10 min) paused while the document is hidden; hidden rules; faces ≤ 3 most urgent leftmost; `remaining`; identity strings. |
| R6-T17 | `features/notch/director.test.tsx` | jsdom (memory transport) | The lock holds only while the pointer is inside or the window is focused, never for auto-expansion alone; an item answered elsewhere, expired or snoozed, quiet hours and calm apply at once even when locked (pointer resting); other identities queue and apply on leave; a stalled hydrate hits the 8 s deadline and falls back to the wing; out-of-order completions of two loads never navigate the older presentation (generation check after each await); envelope `setShape` before navigating, final after `shapeSettled` (reduced motion and unchanged size resolve at once, cancel and deadline paths covered); hover intent 120 ms / leave 300 ms; shortcut and preview. r3: `load({ signal })` abort rejects only the director's await, a shared waiter still resolves; with no waiter left the stalled `ai.hydrate` is aborted and its iterator closes. |
| R6-T18 | `features/notch/views/approval.test.tsx` + `features/chat/kit/permissions/notch-acceptable.test.ts` | jsdom (chat fixtures) | `PermissionList variant="notch"` shows one descriptor with only accept/deny/review; `notchAcceptable` per request variant (every row of §12.1's table, credential paths, unmatched patterns, a URL differing only after its origin, paths/commands at and past the fitting width, >2 denials, unknown variants → Review); Not now snoozes locally and sends nothing; answer → `ai.respondPermission` with the kit's lineage; answered elsewhere → it disappears; `response_rejected` and 10 s copy; `Mod+Enter` / Escape only while focused; questions: single-select questions that fit step through and send `encodeQuestionAnswers` output byte-identical to the composer's; multi-select, over-long labels or descriptions → Answer in app. r3: `sandbox_denied` with a non-empty `note` (shown in full or Review only); a connector ask with no permission renders `ConnectorAskView` (Open, Not now) and loads no thread. |
| R6-T19 | `features/notch/threads.test.ts` | jsdom (memory transport) | With 20 waiting sessions presented one after another, the number of open `ai.subscribe` iterators never exceeds two (the budgeted runtime and explicit `retire()` of sessions leaving `held`); a retired session re-loads cleanly when it comes back. |
| R6-T20 | `features/notch/views/reply.test.tsx` | jsdom (chat fixtures) | Plain-text last assistant message (markdown and tool parts not rendered); field only for forever chats; click → `notch.focus(true)`; Enter → `session.submit` once; `queued`/`started` clear + wink; `rejected` keeps text; draft survives collapse; Escape unfocuses. r3: Message/Call on a bot with no forever chat calls `bots.openChat` once on click, awaits it and the bounded load, then opens the reply; nothing is created by hover or presentation. |
| R6-T21 | `features/notch/views/listening.test.tsx` + `lib/voice/*.test.ts` | jsdom (fake recorder) | Ported dictation tests (recorder, whisper loader, use-dictation) against contract procedures; listening view timer, End → transcript into the draft, never sent automatically; mic refused and failure copy. r3: operation tokens — a microphone permission, `getUserMedia` or transcript arriving after cancel, unmount or a session change stops its tracks / is discarded; disposal waits for an in-flight transcription. |
| R6-T22 | `main/notch/cue-arbiter.test.ts` + `features/notch/sound.test.ts` | main + jsdom (memory transport) | The audible document is one `webContents` id (main when focused, disabled, or no unlocked ready notch; else the nearest-cursor unlocked notch, else primary); with three unlocked notch documents and the main one, shuffled event/focus deliveries grant exactly one `play: true` per `cueId` and lose none (the 1 s non-audible fallback); gated cues never claim; attention arriving while another approval holds the presentation still cues (triggers independent of the presentation); connector asks cue; `sent`/`routine-fired` never claim; a locked notch is never audible; `done` gain 0.08 schedules audible output (`OfflineAudioContext`). r3: `cueForNotice` over every row of §14.3 across owners and `hasVisibleAssistantText`; focused-thread suppression declines a claim before any fallback, even when only notch documents claim; each cue's audible energy lies within its §14.1 duration bounds. |
| R6-T23 | `main/notch/geometry.test.ts` | main | `notchPlacement` for notch/plain modes, window = shape + 24/24/32 margins, top at `bounds.y`, centred; clamp to max; `capsulePlacement` for bottom/top/left/right/auto-hidden taskbars and mixed scale factors; the DIP/points origin conversion with a secondary screen above/left of the primary; an internal display with unknown metrics gets no placement. |
| R6-T24 | `main/notch/metrics.test.ts` | main | `parseProbe` over the JSON the script really prints (fixtures recorded by R6-T31): cut-out screens, screens with empty auxiliary rects (success, no cut-out), `selectors-unavailable`; `execFile` timeout, non-zero exit and garbage → `unavailable`; cache keying; `ABACUSBOT_NOTCH_METRICS` honoured only unpackaged. |
| R6-T25 | `main/notch/controller.test.ts` | main (fake `BaseWindow`/`WebContentsView`/`screen`/`powerMonitor` recording calls) + Electron (`main-serial`) for the counts | Generation gate (legacy creates nothing), platform gate, start after main readiness; targets per `extraDisplays`; reconcile on each screen/power event (debounced, serialised, a throwing reconcile keeps windows); layout pushed without reload; readiness timeout → backoff 2/10/60 s and give-up after 3; crash backoff; renderer swap reloads each view on the new base; the view is fitted on creation and after every bounds change before `setShape` resolves (rendered `innerWidth`/`innerHeight` equal the window across grow, shrink and a display change); every disposal path closes the view's `WebContents` exactly once (idempotent), and after 20 enable/disable cycles and 5 forced readiness failures live `webContents` and RPC iterators return to baseline; win32 main close disposes the capsule so `window-all-closed` fires; `recreateMainWindow` leaves notch windows alone. r3: a renderer swap boots a hidden replacement view, swaps only on its readiness (one live document per display throughout), and keeps the old view when the replacement is delayed past 10 s or fails; `notch.retry` clears the metrics cache and failure budget. |
| R6-T26 | `main/notch/interaction.test.ts` + `haptics.test.ts` | main | Passive/interactive/focused transitions call `setIgnoreMouseEvents`/`setFocusable`/`blur` as the §10.5 table says; grow applies at once, shrink applies when the renderer sends it (no main timer); the shortcut targets an existing ready window (nearest-cursor display with a window, else last interacted, else primary; none → main window), including a cursor on a secondary monitor with `extraDisplays` off and on Windows; register/`unavailable`/unregister; haptics: one `execFile` per attention identity, none on hover, a failing spawn logged once, darwin only. r3: `notch.haptic` from three documents with the same `key` spawns once; different question steps spawn once each. |
| R6-T27 | `e2e/notch-voice.mjs` | Electron (macOS runner) | The notch document loads `@huggingface/transformers` under the notch CSP and transcribes a bundled 2 s WAV fixture through the fake microphone (Chromium `--use-fake-device-for-media-stream --use-file-for-fake-audio-capture`); records the process memory before, during and 2 min after (disposal) in the run log (decides §12.5's claim). |
| R6-T28 | `main/rpc/notch-procedures.test.ts` | main (memory transport) | `requireNotch` on every notch-only procedure (`FORBIDDEN { reason: "not-notch" }` from a main caller) and `preview` main-only; `openInApp` validates targets and enqueues an open command delivered only to main ids; `window.state/chrome` answer per window (F3); `publishToWindowViews` skips notch ids; notch `window.activity` does not defer swaps; an accepted main `ai.send` emits the wink reaction; `window.claimCue` grants one caller per id; `system.notify` hold: with suppression on, a `needs-you` or bot `done` is dropped only after a `presented` with `documentVisible: true` inside 1.5 s, shown otherwise; with suppression off (default) always shown. r3: `openInApp` enqueues a command delivered losslessly by `openCommands`, re-sent after a renderer swap until `ackOpen`, superseded older commands acked; `retry`, `openCommands`, `ackOpen` are main-only; `notch.visibility` stored per webContents and cleared on navigation/disposal; the background-task notice follows the flag and stored visibility; the banner hold measures the notch path latency. |
| R6-T29 | `main/notch/audit.test.ts` | main | Every `getAllWindows`/`getFocusedWindow` call in `src/main` filters notch windows (AST scan); `wireNotchContents` is the only other `registerRendererContents` caller; the preload dispatcher gives a notch page no `window.api` (preload test with `additionalArguments`). |
| R6-T30 | `e2e/notch-window.mjs` | Electron (**macos-latest** runner, with `ABACUSBOT_NOTCH_METRICS=200x32`) | The real window: created as a panel (`type: "panel"`), never activates the app or shows the hidden main window when focused; `getBounds().y === display.bounds.y` (over the menu bar); the view fills the window after grow and shrink; click-through: a synthetic click outside the shape reaches a window underneath, inside it reaches the notch after `setInteractive`; excluded from the Window menu; with a second test window in its own full-screen Space, the notch is not in that Space's screenshot (compositor evidence via `screencapture`) and its document reports `visibilityState === "hidden"`, `"visible"` again on return — **decides F2, F16 and whether §13 rule 3 may ship**; reloads on a renderer swap; disposed on quit. r4: with the shipped options (default background throttling), the notch document reports `hidden` when main hides the window, when another window fully occludes it, and on another app's full-screen Space, and `visible` on return; the active-Space notification marks it unseen until the next report; ordinary Spaces keep it visible and the app's Dock icon and activation are unchanged by `setVisibleOnAllWorkspaces` (called once, without `skipTransformProcessType`). |
| R6-T31 | `e2e/notch-hardware.mjs` (checklist driver) | hardware: a notched MacBook (14″ or 16″ Pro, or 13.6″/15.3″ Air), built-in display | Records the probe's JSON into `metrics.fixtures.json` (feeding R6-T24); screenshots the top 150 px of the display in idle, working, approval, reply, listening and quiet; the reviewer checks nothing is drawn under the cut-out and the wings touch it; runs a real approval and reply against a fake provider; measures the haptic spawn latency (20 samples, median and p95 recorded; decides the haptics default, §10.7). Decides F1 on hardware. |
| R6-T32 | `e2e/notch-displays.mjs` | hardware: the same Mac with an external display | Plain capsule on the external display only with `extraDisplays`; unplug/replug and lid close/open reconcile without duplicates; moving the menu bar's primary display re-places. |
| R6-T33 | `e2e/notch-capsule.mjs` | Electron (**windows-latest** runner) + hardware once (Windows 11, taskbar bottom and left) | `type: "toolbar"` window absent from Alt+Tab (`EnumWindows` check through a PowerShell helper), always on top, transparent and click-through outside the pill, placed by the clock for each taskbar edge (the runner's bottom taskbar; other edges by the hardware run), grows upward; closing the main window for real destroys the capsule and the app quits. |
| R6-T34 | `lib/i18n/phase6.keys.test.ts` | jsdom | Every new `t()` key exists; keymap sources exist; retired list reasons; folds into 05's accounted-for gate. |
| R6-T35 | `features/{onboarding,notch}/gallery/a11y.test.tsx` + `contrast.phase6.test.ts` | jsdom | axe over each §19 section (one overlay at a time); tour dialog semantics; notch region, button names, announcements only while focused; computed contrast of notch text and pills on black ≥ 4.5:1, onboarding pills and progress marks ≥ 3:1 (graphics). |
| R6-T36 | `e2e/fresh-install.mjs` | Electron (macOS and Windows runners, fake Abacus auth server + fake provider) + recorded on hardware for the gate | Empty home → onboarding welcome → sign up (fake in-app window flow completes) → connected → models (add a key) → connectors (connect a credential connector) → first bot hatches → Take the tour → all stops to Start working → the bot chat; restart mid-way resumes at the right step; the notch appears (macOS/Windows) and shows an approval raised by the fake provider, answered from the notch; the transcript shows the answer. |
| R6-T37 | `lib/motion.phase6.test.ts` + `motion.types.test.ts` + Electron single-transition case | jsdom + type + Electron | New motion constants equal the CSS mirrors; reduced motion paths (step fades, spotlight cut, hatch cross-fade, confetti skipped, notch snap); onboarding step, onboarding → shell and every notch route change start exactly one document transition with the expected type and the shared element pairs by name; the foundation's overlap counter stays 0 (extends R1-T11b); `motion/react` imports type-check against 13.4.6. |
| R6-T38 | `features/{onboarding,notch}/structure.test.ts` | jsdom | §4 folder rules, including "the notch tree imports no `features/shell` and no `lib/window-chrome`". |
| R6-T39 | `guards.phase6.test.ts` (extends R1-T15) | jsdom | No `react-tourlight`, `tsparticles`, `canvas-confetti`, `electron` import; no parsing of error messages; no `window.api`; notch code never calls `ai.send` directly (only `session.submit`) nor `agent.respondPermission`. |
| R6-T40 | `features/{onboarding,notch}/parity.test.ts` | jsdom | Every §2 row names an existing route, component or test id and has a status. |
| R6-T41 | `e2e/notch-acceptable.mjs` | Electron (macOS runner) | `notchAcceptable` in the real notch document with the shipped fonts: each request variant with fields at, just below and just past the fitting width and height, multiline values, and the German and Japanese locale strings; accept is withheld whenever either dimension overflows the body within `layout.maxShape`; question fit likewise. |
| R6-T42 | `e2e/notch-shape.mjs` | Electron (macOS and Windows runners) | Envelope-then-final (§10.2): grow, shrink, mixed (width down + height up and the reverse), interrupted mid-transition, reduced motion (no transition events), unchanged size, and Windows upward growth; sampled screenshots show the shape never clipped; the window ends at the final shape plus margins; a stale generation never sends `final`. |
| R6-T43 | `docs/rewrite/listening/cues-r6.md` (recorded session) | listening test (three people, laptop speakers and headphones) | §14.1's criteria per cue; the final parameters and the date written to `lib/sound.ts`. |
| R6-T44 | `main/rpc/ai-attention.test.ts` | main (relay with fake agent streams) | The first yield is a snapshot taken atomically with registration (a `permission.pending` change raced between subscribe and snapshot is neither lost nor applied twice); events carry increasing revisions and a stale one is ignored by the client reducer; zero counts yield `remove`; a respawn with a new **string** incarnation removes the old item and adds the new one only with its own pending entries; session deletion removes; reconnect replaces state from a fresh snapshot; overflow ends with `RESYNC_REQUIRED`; with three waiting threads (two approvals loaded, one question not) the presenter ranks the question first. Type-check: `AttentionSummary.incarnation` is the contract's string type. |

---

## 21. Scaffold order

Each step is a commit on `rewrite/06-onboarding-tour-notch`, stacked on the phase 5 branch.

1. Contract and main plumbing: `shared/contract/notch.ts` (incl. `openCommands`/`ackOpen`, `retry`, `visibility`), `window.claimCue` + `window.visibleThread`, `system.funnelStep { once }`, the relay's `ai.attention`, `system.notify { kind, dedupeKey }`, prefs leaves (`notch.*`, `tour.*`, `onboardingFlow`, `onboardingExit`, `onboardingPairing`), spec 00 C.4's canonical step import, per-window deps (F3), `requireNotch`, the preload dispatcher; R6-T5 (main), R6-T28, R6-T29 (preload half).
2. Main notch: `metrics`, `geometry`, `window` (view fitting), `dispose`, `interaction`, `haptics`, `cue-arbiter`, `controller` with all gates and lifecycle; R6-T22 (main), R6-T23 … R6-T26.
3. Dependencies landed by other phases: `ai.runFinished` (03 r3 §24.11) and its feed moved to `lib/run-finished.ts`; `lib/attention/cues.ts` (`cueForNotice`) adopted by 03/04/05's watchers; the chat kit's `load({ signal })`; `createBotFromTemplate` (§23.3); the `lib/attention` move; the chat kit's `maxSessions` option, exports and `PermissionList variant` with `notchAcceptable` (§23.2); 05's `useConnectFlow` pairing policy (§23.5).
4. Build: `notch.html`, the third input, the second router plugin, `notch.tsx` boot, notch router; R6-T1.
5. Notch renderer: inputs, presenter, director, shell and shapes, views, reactions, sound; R6-T15 … R6-T20, R6-T22 (renderer).
6. `lib/voice` port + composer `Dictate` wiring + listening view; R6-T21, R6-T27.
7. Onboarding: machine, gate, resume, actions, frame, steps, first bot, hatch, confetti; R6-T2 … R6-T10.
8. Tour: anchors placed by their owners, spotlight, stops, host, Settings rows and command menu entry; R6-T11 … R6-T14.
9. Settings rows (§15), OS notification policy (§13).
10. Motion constants and CSS; R6-T37. i18n + keymap + retired list; gallery; screenshots; R6-T34, R6-T35, R6-T38 … R6-T40.
11. Electron and hardware runs: R6-T30, R6-T33, R6-T41, R6-T42 in CI; R6-T31, R6-T32, R6-T36 recorded; the R6-T43 listening test; `PROGRESS.md`.

---

## 22. Acceptance

**Build and rules**
- [ ] `typecheck`, `lint`, `format:check`, `check:knip-next`, `check:i18n`, `check:locales`, `test:unit` green; R6-T1 … R6-T44 pass; R6-T30 green on `macos-latest`, R6-T33 on `windows-latest`, with no silently skipped Electron test.
- [ ] `dist/renderer` contains `index.html`, `index-next.html`, `notch.html`; the experience bundle and the packaged app carry all three.
- [ ] No new dependency; no `react-tourlight`, `tsparticles`, confetti library or native module in renderer-next or main.
- [ ] Changes under `src/renderer` are only locale additions; `src/preload/index.ts`'s main branch is byte-identical to today's body (moved), its tests unchanged.

**Parity (gate)**
- [ ] Every §2 row is green in `parity.ts` (R6-T40) and each "Parity" row is demonstrated once in the real app (PR checklist).
- [ ] `PARITY.md` rows for `account.skipOnboarding`, `auth.abacus.*` (onboarding), `auth.openRouter.*`, `system.funnelStep`, `system.notify`, `voice.*` name their renderer-next consumer.

**Canvas (screenshots, light and dark for onboarding; the notch is dark only)**
- [ ] OnboardWelcome … OnboardDone, OnboardKeyDialog at 1280 × 800 and 800 × 600; TourRail, TourComposer, TourPanel, TourNotch and every other stop; every Notch state in notch, plain and capsule modes; each side by side with its board and the deviations of §24.3 marked.

**Behaviour (real app)**
- [ ] A fresh install walks onboarding to the first bot's chat (R6-T36 recorded on macOS and Windows); quitting at any step and relaunching resumes at the right step; an old-build user in the middle of onboarding resumes correctly (legacy step ids).
- [ ] The tour reaches all 12 stops (11 on Linux or with the companion off), never scrolls under the user, degrades to a centred card when an anchor is missing, and returns to where it started.
- [ ] On a notched Mac the companion sits around the cut-out and never draws under it; approvals and replies answered from it appear in the transcript; hovering an approval holds it while new attention queues; the main window focused calms it; quiet hours silence it (R6-T31).
- [ ] With an external display and "On every display", both displays show it; unplugging removes it without leftovers (R6-T32).
- [ ] On Windows the capsule sits by the clock, grows upward, is absent from Alt+Tab, and closing the app quits (R6-T33 hardware run).
- [ ] Exactly one sound per attention event whichever window is focused; no OS banner for approvals/replies while "Show in the notch" is on.
- [ ] With reduced motion on, nothing slides, springs, wobbles or blurs; the notch snaps.

---

## 23. Amendments this spec requires elsewhere

1. **Foundation (01) and its implementation.** (a) §3.3: `notch.html` as a third input; a second `tanstackRouter` instance for `notch-routes/`; knip and oxlint entries (§11.1). (b) §6.1: `_bare/onboarding.tsx` layout (account gate), `onboarding.index` resumes; `_shell.tsx` `beforeLoad` gate and completion tail (§5.2, §6.5); `bootstrap()` seeds `accountStateQuery` (fourth step, 2 s, fail-open). (c) §6.7 (impl amendment's mechanism): `NavType` gains `onboarding-step`, `onboarding-finish`, `notch-expand`, `notch-contract`, `notch-swap`; `installTransitionTypes` takes a nav-type function so the notch router installs its own. (d) §7.2/§7.4: `tourAnchor` on the Rail (`rail-bots-sessions` wrapper, `rail-library`, `rail-artifacts`) and `TopBar.PanelTabs` (`topbar-panel-tabs`). (e) §7.6: `tour-spotlight` in `OCCLUDER_SLOTS`. (f) §7.9: command menu item "Take the tour". (g) `features/shell/sidebars.ts` `globals`: `TourHost`, `OpenTargetBridge`, `PairingQueueBanner`. (h) `lib/sound.ts`: attention cues claim through `window.claimCue` before playing (§14.2); `done` gain 0.08. (i) `lib/motion.ts`: the constants of §16; `easings.notch` removed (unused after F15).
2. **Chat kit (02).** **§14 amendment (review r2 #9):** `ThreadSession.load(opts?: { signal?: AbortSignal })` — an abort rejects only that caller's await with `AbortError`; readiness stays shared; when every waiter has aborted and no view is mounted, the kit retires the generation (aborting `ai.hydrate` through the oRPC signal and closing the `ai.subscribe` iterator). `createChatRuntime(transport, { maxSessions?: number })` (the LRU size becomes an option, default 8) and `retire()` usable by callers (§11.3); `ChatViewProps.notchEnabled?: boolean` (F20); `PermissionList` gains `variant: "chat" | "notch"` and `limit?: number`; the kit exports `notchAcceptable(d, measure)` (§12.1's per-variant table, `sandbox_denied.note` included, both-dimension fit), `useThreadStore` (read-only selectors), `encodeQuestionAnswers`, `decisionTitle`, `runErrorCopy`, `messagePlainText`; the composer's `Dictate` slot is wired to `lib/voice` with operation tokens (§12.5).
3. **Bots (03).** Define `createBotFromTemplate(templateId, overrides?: { id?: string; checkIn?: { preset: SchedulePreset; time: string } })` in the §6.4 table (F21): client id, `db.bots.insert`, `isPersisted`, then the check-in when `overrides.checkIn` is given (created as §9.4 does); returns `{ bot, checkInRoutineId: string | null }` (null when none was asked for or its insert failed); `NOT_FOUND { entity: "bot-template" }` for an unknown id. `BotAvatar` gains `hatch?: { from: "egg"; onDone(): void }` (§8.2). The one-per-document `ai.runFinished` subscription moves from the `BotsSidebar` module to `lib/run-finished.ts` (`runFinishedFeed()`), which 03, 04, 05 and the notch all consume (F4); `features/bots/data/attention.ts` moves to `lib/attention/` with a re-export (F22). 03's cue watcher takes its kinds from `cueForNotice` (§14.3) and claims attention cues (§14.2). **§17's `done` synthesis is replaced** by 06 §14.1's own design (done in r3; the other cue rows are kept as starting parameters of 06 §14.1's bounds, all tuned by R6-T43).
4. **Sessions (04).** No change to the run-finished contract (04 r3 consumes 03's `ai.runFinished`; the r1 rename is withdrawn). `sessionAttention` moves to `lib/attention/` (F22); the shared `turnTransitions(collection)` helper (04 §26.7 names it but not its home) lives in `lib/attention/turn-transitions.ts` so the notch can import it. Its cue watcher takes its kinds from `cueForNotice` (§14.3) and claims (§14.2). Anchors: `sessions-sidebar`, `new-session-composer`, `panel-changes`.
5. **Routines/Settings (05).** (a) **`useConnectFlow().start(id, options?: { pairing?: "navigate" | "defer" })`** (default `"navigate"`, today's behaviour): `"defer"` runs `connectPlatform(platform)`, appends the platform to `prefs.onboardingPairing` (deduplicated) and settles `{ ok: false, deferred: true }` without navigating (§7.6); `ConnectorOutcome` gains `deferred`. (b) Prefs (main contract): group `notch: { enabled; haptics; idleVisible; extraDisplays; showInNotch }` (defaults `true, true, true, false, true`; `haptics` default revisited by R6-T31), group `tour: { status: "unseen" | "done" | "skipped"; at: number | null }`, scalars `onboardingFlow: number | null` (default `null`), `onboardingExit: OnboardingExit | null`, `onboardingPairing: MessagingPlatform[]` (default `[]`); each a leaf with its own provenance; `PrefsPatchSchema`, `PREFS_LEAVES`, `PREFS_GROUP_ENTRIES`, defaults and `DEFAULT_PREFS` updated. (c) The General and Notifications rows of §15 replace 05's reserved placeholders; `tourSignedOut()` is real; anchors `library-connectors`, `settings-memory`; 05's local-model row and `ProviderKeyDialog` are exported for the onboarding route (§7.5). (d) `notifyAttention` passes `dedupeKey` to `system.notify` (§13); its watchers take kinds from `cueForNotice` and claim cues (§14.2).
6. **Main contract and services (00).** `notch.*` group (§10.10: `setShape` with `phase`, `visibility`, `presented`, `haptic` with `key`, `retry`, `openCommands`/`ackOpen`); `window.claimCue({ cueId, threadId })` and `window.visibleThread`; `system.notify` input `kind?` and `dedupeKey?` with the hold of §13 (behind `NOTCH_BANNER_SUPPRESSION`, off until R6-T30); `system.funnelStep` input `once?: true` routed to the existing `reportFunnelStepOnce` (§6.5); per-window `RpcWindows.state/chrome`, kind-filtered `publishToWindowViews`, notch `window.activity` excluded from swap deferral (F3); `wireNotchContents` as the second trust point; `NOTCH_ENTRY` in `renderer-entry.ts`; the preload dispatcher; `ai.send` from a main caller publishes the wink reaction. **Relay requirement (review r2 #16, r3 #3/#4):** one subscription `ai.attention({}) → eventIterator<AttentionEvent>`: an atomic snapshot (listener registered and snapshot taken in one synchronous step), then revisioned `upsert`/`remove` events for every thread's live-incarnation `permission.pending`, cached or not; string incarnations unchanged; removal on zero counts, incarnation end and session deletion; a reconnect or `RESYNC_REQUIRED` starts a fresh snapshot (§11.2; R6-T44). **C.4**: the migration step and the live legacy sync canonicalise `onboarding.step` (`auth → welcome`, `welcome → connected`, `connectors`, `models`, `explainer → first-bot`) and write `onboardingFlow = 2` alongside (F10); values outside the legacy order still map to null.
7. **PLAN.md.** Applied in r3 (the two coordinator-authorised edits): the Decisions "Notch" line and §Notch window's Window and Geometry bullets now state requirements (no attribution, no recipe); §Sound's cue line no longer cites the swept sine. Still requested: Motion table row "Notch wings/body" → the canvas values (350 ms standard easing, content 120 ms after), and §Sound's haptics line → one-shot JXA per attention with a measured default; the `node-mac-notch` library row → "does not exist; JXA probe"; Onboarding "Skip for now" and the first bot's weekday check-in (canvas board) recorded as decisions; Tour completion persisted as `prefs.tour`; Areas: dictation audio is phase 6's (`lib/voice`).
8. **Design canvas** (follow-ups, not blockers): `TourMap` stop 6 → Library › Connectors; `OnboardConnectors` tiles → the registry's onboarding set (GitHub, Notion, Stripe are MCP entries, Linear does not exist); `SettingsNotifications` "Play a sound — Uses your system notification sound" (05's in-app cues replace it); `Notch` "Retry" and "Summary ready · 2 files" (no data).

---

## 24. Risks, unverified claims, deferred items, review classes applied

### 24.1 Risks

| Risk | Mitigation |
|---|---|
| The JXA probe fails or is slow on some macOS versions | 3 s timeout, cached per display key; **no guess**: an internal display with unknown metrics gets no companion and Settings says so with Try again; R6-T31 records real output and R6-T24 parses it |
| `type: "panel"` activates the app or shows the hidden main window on focus | focus only on demand (§10.5); R6-T30 decides; fallback: never focus, the reply field opens the main window's chat instead |
| The panel over the menu bar is pushed down by macOS window constraints (E:3287-3290 note) | `enableLargerThanScreen`; R6-T30 asserts `y`; fallback: shape drawn from the window's top with the notch gap still centred |
| Two notch documents plus the main one triple memory (chat kit, collections, Whisper) | two held threads per notch; Whisper lazy and disposed; `extraDisplays` off by default; R6-T27 measures |
| Windows: the capsule stays over full-screen apps | documented difference; the companion can be switched off; revisit with a foreground-window check later |
| Duplicate or missing sounds across several documents | main grants each `cueId` to one `webContents`, with a 1 s fallback to a non-audible claimant; R6-T22 shuffles deliveries |
| Onboarding no longer forces Abacus sign-in (F9) | canvas decision recorded in PLAN (§23.7); the app works with own keys or a local model; Settings › Account offers sign-in |
| A new user with no sessions sees tour stops 8–9 as centred cards | expected; the copy stands alone; the stops are marked optional in spirit (9 is "Optional") |
| `ai.attention` (a new relay procedure) or the chat kit's `load({ signal })` lands late | scaffold step 3 blocks on both; without `ai.attention` the presenter would mis-rank questions, so the notch does not ship without it |
| `ai.runFinished` lands late (owned by 03's main work) | scaffold step 3 blocks on it; no fallback derived from table diffs (review class 31) |
| Haptic spawn latency makes the tap arrive after the expansion | measured by R6-T31; above 150 ms median the default is off |
| A disposal path leaks a renderer | one idempotent `disposeNotchWindow` closing the `WebContents`; R6-T25 counts live contents and iterators after cycles |
| A notch window registered as trusted widens the RPC surface | notch-only procedures guarded, main-only ones already guarded (`requireMainRenderer`), the notch preload exposes nothing else; R6-T28/T29 |

### 24.2 Unverified claims (each has a test that decides it)

`type: "panel"` / `"toolbar"` behaviour (R6-T30, R6-T33); Page Visibility following hide, occlusion and Spaces with throttling kept, and the Dock staying put when `setVisibleOnAllWorkspaces` runs once without `skipTransformProcessType` (R6-T30); window at `display.bounds.y` over the menu bar (R6-T30); `visibleOnFullScreen: false` hides it on other apps' full-screen Spaces and the notch document then reports `visibilityState === "hidden"` (R6-T30; §13 rule 3 ships only if true); the JXA probe's output shape and values on notched hardware (R6-T31, R6-T24); haptic spawn latency (R6-T31); two `tanstackRouter` instances building and hot-reloading side by side (R6-T1); `@huggingface/transformers` under the notch CSP and its memory (R6-T27); `motion` 13.4.6 typings for the new uses (R6-T37); Alt+Tab exclusion for `toolbar` windows (R6-T33). r3 adds: real text fit of the approval predicate in both dimensions (R6-T41); no clipping across envelope/final shape changes including interrupted and reduced-motion cases (R6-T42); the designed cue set's recognisability (R6-T43); `ai.attention` staying consistent with each thread's `permission.pending` (R6-T44); `View.setVisible(false)` keeping a replacement view booting but invisible (R6-T25).

### 24.3 Deferred or not built

Calls (03 F12); browser take-over in the notch (F6); the canvas's GitHub, Notion, Stripe and Linear onboarding tiles (F13); a notch on an internal display whose metrics could not be probed (F1); **Retry** of a failed run (F17); "Summary ready · 2 files" result lines (no data); the capsule on extra Windows displays; a notch on Linux (PLAN); menu-bar/tray item and dock badge (05 F11); "Edit" of an approval inside the notch (Review opens the chat); `allowAlways`/rules/`allowYolo` from the notch (full card only); canvas per-bot "Digest only"/"Mentions" (05 F12); a real-time progress figure for the working ring (no data).

### 24.4 Review defect classes applied

Native views are sized explicitly and their `WebContents` closed on every disposal path (23, F25); every library and API claim cites the installed `.d.ts`/`package.json` or is listed in §24.2 (classes 25, 1–2: F1, F2, the router plugin, `setSinkId` absence noted so no player relies on it); new-generation machinery is gated on `RENDERER_GENERATION === "wco"` and dev hooks on `!app.isPackaged` (3, 4); no import-time side effects in `src/main/notch/*` (the controller is constructed in `app.whenReady`) (5); platform APIs used only where their typings say (`setVisibleOnAllWorkspaces` darwin, `forward` darwin/win32, `setFocusable` semantics) (6, 8); `toHotkeyPlatform` reused, never a Node platform string in hotkeys (7); ports: the notch's port lifecycle is the transport's (closed on committed navigation, one per webContents) and its window is created before destroy on reloads (1, 9); window-state events filtered by kind (10); readiness for a second document with a timeout and a give-up (11); iterators end on window destroy and notices dedupe by run id (13, 17); timers (settle, hover, dwell, backoff) are cancelled on destroy/unmount and never poll while hidden (15); events from notices, levels from tables, never cues from inserts or coalesced diffs (31); irreversible actions (approvals) through the lossless kit path, never an advisory notice (32); prefs as patches with leaf provenance (33); one data layer (`#next/data/db`) and one state home per fact (tour run state ephemeral, completion in prefs) (34); forms parse on submit (the key dialog is 05's) (35); typed errors only, no message parsing (36); every parity row has a status and an owner for each change (37); tests run through real collections, router, transport and Electron, with hardware runs where a VM cannot tell (38, 24); computed contrast (42); cross-spec drift called out and resolved in §23 (the run-finished notice, `createBotFromTemplate`, `notchEnabled`) (44).

---

## Review responses (r1)

Source: `docs/rewrite/specs/reviews/06-onboarding-tour-notch.codex-r1.md` (25 items: 3 blockers, 20 major, 2 minor). All accepted; each re-checked against sources. Coordinator decisions are marked **(C)**.

| # | Sev. | Verdict | Evidence checked | What changed |
|---|---|---|---|---|
| 1 | Major | **Accepted (C)** | 04 r3 L9, L443, §26.7 and 05 r3 §23.3 consume 03 r3's `ai.runFinished` unchanged, one subscription per document. | F4 rewritten; the rename amendment withdrawn (§23.4); the feed moves to `lib/run-finished.ts` and the notch consumes it (§11.2, §23.3); R6-T15 checks shared consumers. |
| 2 | Blocker | **Accepted (C)** | Legacy `STEP_ORDER` contains `welcome` with a different meaning (`legacy-prefs.ts:85-95`). | Spec 00 C.4's import and live sync canonicalise legacy ids and write `onboardingFlow = 2`; resume reads one vocabulary (F10, §6.3, §23.6); R6-T5 main + renderer cases. |
| 3 | Blocker | **Accepted (C)** | r1 `guardStep` always redirected `connect`. | Attempts with tokens stored synchronously; `connect` valid only while an attempt is live (§6.2, §6.4); R6-T7 on the real router. |
| 4 | Major | **Accepted (C)** | `skip` from `connect` and `tour` were missing from the table/union. | Complete event union and table with `ignore` for superseded attempts and every undefined pair (§6.1); cancel clears the live attempt (§6.4); R6-T4, R6-T7. |
| 5 | Major | **Accepted (C)** | §5.1's example contradicted §7.5. | No model prerequisite anywhere (§5.1, §6.1, §7.5); R6-T8 walks the no-model path. |
| 6 | Major | **Accepted (C)** | `account.skipOnboarding` commits before the prefs write (`account-service.ts:43-44`). | Exit persisted first, account commit idempotent, tail non-blocking and resumed by the shell gate (§5.2, §6.5); R6-T6 kills the app between steps. |
| 7 | Major | **Accepted (C)** — schedule kept, **cited**: canvas `OnboardFirstBot` shows "Checks in weekdays at 8:00 · Gmail, Calendar" | Template has no check-in (`bot-templates.ts:57-75`); 03 keeps a deleted bot's check-in as a routine. | Weekdays 08:00 because the board shows it (F14, §8.1); `createBotFromTemplate` returns `checkInRoutineId`; Start from scratch deletes routine then bot; a failed check-in insert leaves Off (§8.1, §8.3, §23.3); R6-T9. |
| 8 | Major | **Accepted (C)** | The old dialog sets `startedRef` before the mutation. | `FirstBotState.pending` with a synchronously minted client id and promise shared across mounts (§8.1); R6-T9 Strict Mode and delayed persistence. |
| 9 | Major | **Accepted (C)** | `provider-setup-step.tsx:88-105` combines configured models and stored keys. | Same rule (§7.5, OB11); R6-T8 environment-only and removed-key cases. |
| 10 | Major | **Accepted (C)** | Old list includes `messaging-discord`; registry marks Discord `onboarding: true` (`registry.ts:200-230`). | Grid = registry `onboarding: true` entries (F13, §7.6); R6-T8 reachability of every old tile. |
| 11 | Major | **Accepted (C)** | 05 r3 §12.4 item 6 always navigates to Library for pairing. | `start(id, { pairing: "defer" })` amendment, persisted `prefs.onboardingPairing`, a shell banner drains it after the exit navigation (§7.6, §23.5). |
| 12 | Major | **Accepted (C)** | Foundation §6.7 impl amendment; `lib/navigation/shared-element.ts`. | Route changes are router document transitions with new nav types, shared elements via `useSharedElementName`, React VT only in-route; the notch router installs the same mechanism (F26, §5.4, §16, §23.1 c); R6-T37 single-transition case. |
| 13 | Major | **Accepted (C)** | 02 §3.1: sessions stay subscribed until LRU eviction. | `createChatRuntime(transport, { maxSessions: 2 })` and explicit `retire()` of sessions leaving `held` (§11.3, §23.2); R6-T19 counts iterators. |
| 14 | Major | **Accepted (C)** | Check-in runs have `owner: null`; routine runs need `RoutineRow.botId`. | Notch preloads `routines`; attribution owner → routine's bot (§11.1, §11.2, §11.4, §14.4); R6-T15, R6-T16. |
| 15 | Major | **Accepted** | r1 locked on auto-expansion. | Lock only while the pointer is inside or the window is focused; invalid items, quiet hours and calm apply immediately (§11.6); R6-T17. |
| 16 | Major | **Accepted** | The kit's 5 s cap covers replay readiness only (02 §3.2). | 8 s total presentation deadline with an `AbortSignal`, a generation check after each await, 30 s back-off for a failed session (§11.6); R6-T17. |
| 17 | Blocker | **Accepted (C)** | `RendererHost.#fit()` calls `view.setBounds` (`renderer-host.ts:339-353`); Electron's `BaseWindow` docs size child views. | `fitView` on creation and every `resize`, before a grow resolves (F25, §10.1, §10.2); R6-T25 and R6-T30 check the viewport. |
| 18 | Major | **Accepted (C)** | Electron `BaseWindow` resource management: closing the window does not destroy the view's contents. | One idempotent `disposeNotchWindow` that closes the `WebContents` on every path (§10.6); R6-T25 counts after cycles. |
| 19 | Major | **Accepted (C)** | A class-level owner lets several notch documents play. | One audible `webContents` and a per-`cueId` claim arbitrated by main, with a 1 s fallback so no event is lost (F18, §14.2); R6-T22 with three notch documents and shuffled deliveries. |
| 20 | Major | **Accepted** | 03/04 cue needs-you from `turnTransitions` and connector asks. | Notch triggers independent of the presentation, including connector asks (§11.2, §14.3); R6-T22. |
| 21 | Major | **Accepted** | Geometry events do not reveal another app's full-screen Space. | Suppression needs a `presented` report from a visible document within a 1.5 s hold, behind a flag that stays off until R6-T30 proves `visibilityState`; dwell clocks pause while hidden (F19, §11.4, §13); R6-T28, R6-T30. |
| 22 | Major | **Accepted** | 19 `PermissionRequest` variants (`shared/agent-types.ts:238-360`), including `credentialPaths`, `cwd`, denials. | `notchAcceptable` with a per-variant table of fields that must be fully visible; content-bearing, generic and unknown variants Review only; question fit measured (§12.1, §12.2, §23.2); R6-T18 every variant. |
| 23 | Minor | **Accepted (C)** | Default targets create one window on macOS and Windows. | Shortcut picks among existing ready windows with a stated fallback, else reveals the main window (§10.5); R6-T26. |
| 24 | Minor | **Accepted (C)** | `NSScreen.h`: `API_AVAILABLE(macos(12.0))`; the auxiliary areas are `NSRect`. | Selector checks, struct field extraction, empty rect = success, missing selectors = failure; fixtures come from R6-T31's real output (§10.2); R6-T24. |
| 25 | Major | **Accepted (C)** | The user's rule is "ideas only, never copy code". | Removed: the inference constants (no inference at all), the 700 ms shrink (now the renderer's `transitionend`), the resident stdin haptic helper and its 300 ms throttle (now one-shot JXA per attention, latency measured), the hover timings (now the foundation's 120/300 ms), the 1–3-option question rule (now measured fit), PLAN's openbot motion values (now the canvas's 350/120 ms). Each remaining number states its source (Provenance note, F1, F15, §10.2, §10.7, §11.6, §12.2, §16). |

**Self-consistency pass.** Section references, test ids (R6-T1 … R6-T44) and the amendment list were re-read after the edits; the notch contract no longer carries a sound-owner event (arbitration is `window.claimCue`); `system.notify` gains `dedupeKey` alongside 05's `kind`; the prefs additions are listed once (§23.5 b).

---

## Review responses (r2)

Source: `docs/rewrite/specs/reviews/06-onboarding-tour-notch.codex-r2.md` (25 items: 2 blockers, 22 major, 1 minor). All accepted; each re-checked against sources. Coordinator decisions are marked **(C)**. This is the last spec round.

| # | Sev. | Verdict | Evidence checked | What changed |
|---|---|---|---|---|
| 1 | Blocker | **Accepted (C)** | PLAN §Notch window attributed the option list to openbot.run. | §10.1 rewritten as nine requirements (W1–W9), each selecting one documented Electron option with its doc line and its test; §10.8 cites the same requirements. PLAN's Decisions line and Window/Geometry bullets rewritten to requirements, attribution and recipe removed (edited in r3, §23.7). |
| 2 | Blocker | **Accepted (C)** | 03 §17's `done` row and PLAN §Sound cited openbot's swept sine. | §14.1: our own cue set — intent, duration bounds and synthesis method per cue; `done` redesigned as a rising perfect fifth (two tones); all tuned by the R6-T43 listening test. 03 §17's `done` row and PLAN's cue line edited (r3). |
| 3 | Major | **Accepted (C)** | r2 cleared the exit before navigating. | The exit is cleared only after the router resolves the destination, and for `bot-tour` only after the tour has started (§6.5); R6-T6 kills at every boundary. |
| 4 | Major | **Accepted (C)** | `main/index.ts:1282-1283` calls `reportFunnelStep`; `reportFunnelStepOnce` exists (`funnel-beacon.ts:83`). | `onboarding_done` sent only after the account commit with a new `once` input routed to `reportFunnelStepOnce`; entering `done` sends nothing (§6.5, OB14, §23.6); R6-T3, R6-T6. |
| 5 | Major | **Accepted (C)** | `guardStep` lacked the creation state. | `guardStep` takes `createdBotId` (set synchronously, §8.1) (§6.2); R6-T9 revalidates after insert and echo. |
| 6 | Major | **Accepted (C)** | A settled failed attempt made `connect` invalid. | Attempt statuses include `failed` (retained with its error) vs cold URL; `connect` valid while `pending` or `failed` (§6.2, §6.4); R6-T7. |
| 7 | Major | **Accepted (C)** | 03's `deleteBot` navigates before deleting (03 §5.5/§6.4). | Persistence-only deletion through `#next/data/db` collections; the step never navigates (§8.3). |
| 8 | Major | **Accepted (C)** | `@tanstack/db` `transactions.d.ts:35-90`: await `isPersisted.promise`. | Routine delete's `isPersisted.promise` awaited before the bot delete (§8.3); R6-T9 holds and rejects the real transaction. |
| 9 | Major | **Accepted (C)** | 02 `ThreadSession.load(): Promise<void>` had no signal. | Chat-kit §14 amendment: `load({ signal })`, caller-only abort, retirement (hydrate aborted, iterator closed) when no waiter remains (§11.6, §23.2); R6-T17. |
| 10 | Major | **Accepted (C)** | No `transitionend` under reduced motion, interruption or unchanged size. | `shapeSettled`: immediate for cuts and unchanged sizes, both dimensions tracked, `transitioncancel` and a duration + 100 ms deadline, generation-guarded (§10.2); R6-T42. |
| 11 | Major | **Accepted (C)** | Mixed width/height changes. | Envelope (max of both shapes, anchored at the growth edge) before the animation, final after (§10.2, `setShape.phase`); R6-T42 incl. Windows upward growth. |
| 12 | Major | **Accepted (C)** | The notch claimed with visibility predicates false. | `window.visibleThread` from the main renderer; main declines claims for the focused visible thread before any fallback, and never grants them later (§14.2); R6-T22. |
| 13 | Major | **Accepted (C)** | 03/04/05 use different predicates. | One `cueForNotice` table in `lib/attention/cues.ts` used by every watcher (§14.3, §23.3–§23.5); R6-T22 every row. |
| 14 | Major | **Accepted (C)** | `notch.haptic` took only a pattern. | `key` = permission lineage (+ question step); main performs each key once across documents and reloads (§10.7, §10.10); R6-T26. |
| 15 | Major | **Accepted (C)** | Connector asks had no view. | `ConnectorAskView` on `/approval/$id?ask=` with Open in app and Not now, no thread loaded (§5.4, §12.8); R6-T18. |
| 16 | Major | **Accepted (C)** | Question vs approval was unknown for unloaded threads. | Relay requirement `ai.attention` / `ai.attentionEvents` from each thread's latest `permission.pending` (§11.2, §11.4, §23.6); R6-T44 with three waiting threads. |
| 17 | Major | **Accepted (C)** | A new bot can have no forever session; `bots.openChat` exists (`shared/contract/bots.ts:32-34`). | Message/Call call `bots.openChat` on click, await it and the bounded load, then navigate (§12.6); R6-T20. |
| 18 | Major | **Accepted (C)** | `documentVisible` was not in the contract. | `notch.visibility` on boot and every `visibilitychange`, cleared on navigation/disposal/swap; the background-task notice follows the same flag and visibility (§13, §10.10); R6-T28. |
| 19 | Major | **Accepted (C)** | `window.events` coalesces by `event.type` (`procedures/window.ts:40`). | Lossless `notch.openCommands` with ids, `ackOpen` after the route resolves, re-sent after a swap, newer supersedes older (§10.10, §12.7); R6-T28. |
| 20 | Major | **Accepted (C)** | No recovery API existed. | `notch.retry()` (main only) clears the metrics cache and failure budget and reconciles (§10.6, §10.10, §15); R6-T25, R6-T28. |
| 21 | Major | **Accepted (C)** | Reloading a view replaces its document. | A hidden replacement view (`View.setVisible`, E:16120) boots beside the old one and is swapped in on readiness; failure keeps the old view (§10.6); R6-T25. |
| 22 | Major | **Accepted (C)** | The old hook cancels only an existing recorder. | Operation tokens in `lib/voice`: late permission/media results stop their tracks, stale transcripts are discarded, disposal waits for in-flight work (§12.5); R6-T21. |
| 23 | Major | **Accepted (C)** | `sandbox_denied.note` exists (`shared/agent-types.ts`). | The note must be shown in full, else Review only (§12.1); R6-T18. |
| 24 | Major | **Accepted (C)** | jsdom cannot lay out text. | Both-dimension fit against `layout.maxShape` measured in the real renderer with shipped fonts and locales (§12.1); new Electron test R6-T41. |
| 25 | Minor | **Accepted (C)** | ζ = 18 / (2√420) ≈ 0.44, not 0.6. | Spring model documented without a conversion claim; a policy-constants table gives each chosen value's reason and the recording that may revise it (§16). |

**Self-consistency pass (r3, final).** Re-read after the edits: the contract lists every procedure the text uses (`setShape.phase`, `visibility`, `presented`, `haptic.key`, `openInApp → { id }`, `retry`, `openCommands`, `ackOpen`, `window.claimCue { threadId }`, `window.visibleThread`, `system.funnelStep.once`, `ai.attention`); no text still routes open commands through `window.events`, relies on `transitionend` alone, or cites a clone-derived recipe or constant (openbot.run appears only in the provenance note and the sources table as "ideas only"); tests run R6-T1 … R6-T44 and each new behaviour has one; the amendment list names every change to 01–05, 00 and PLAN, and the two PLAN/03 edits the coordinator authorised are applied in the working tree.

---

## Review responses (r3)

Source: `docs/rewrite/specs/reviews/06-onboarding-tour-notch.codex-r3.md` (8 items: 1 blocker, 7 major). All accepted with the coordinator's decisions **(C)**. This is the last round.

| # | Sev. | Verdict | Evidence checked | What changed |
|---|---|---|---|---|
| 1 | Blocker | **Accepted (C)** | `electron.d.ts:19431-19437`: disabling `backgroundThrottling` also affects the Page Visibility API; Electron docs: visibility stays `visible` when hidden or occluded. | W9 now **keeps** default throttling; visibility is a main-side fact (main's own show/hide, the active contents' `visibilitychange` reports, and the active-Space workspace notification) read by the banner rule, the background notice and the audible-document choice; no renderer timer is needed while hidden, and the timers that must run then live in main (§10.1 W9, §11.4, §13 rule 3); R6-T30 tests hide, occlusion and Spaces with the shipped options. |
| 2 | Major | **Accepted (C)** | r3 listed End among invalidating events. | End moves `recording → transcribing` with the same token; only cancel, unmount, session change or a newer operation invalidate (§12.5); R6-T21 asserts one transcript per normal End. |
| 3 | Major | **Accepted (C)** | Snapshot and events were separate calls without revisions. | One subscription: atomic snapshot, revisioned `upsert`/`remove`, removal on zero counts, incarnation end and session deletion, fresh snapshot on reconnect or overflow (§11.2, §23.6); R6-T44 races. |
| 4 | Major | **Accepted (C)** | `ai-thread.ts:66`: `incarnation: string \| null`. | `AttentionSummary.incarnation: string`, passed through unchanged (§11.2); type-checked in R6-T44. |
| 5 | Major | **Accepted (C)** | Both views were registered as `notch` against one window. | Active vs standby contents in main's registry; standby shapes staged, its other native and claim calls rejected (`FORBIDDEN { reason: "standby" }`), one synchronous promotion applies the staged bounds and transfers ownership (§10.6, §10.10); R6-T25 conflicting reports during delayed and failed swaps. |
| 6 | Major | **Accepted (C)** | `@tanstack/db` `errors.d.ts:91` `DeleteKeyNotFoundError`, thrown before a transaction for a locally absent key. | Local absence (`has(id)` false), `DeleteKeyNotFoundError` and server `NOT_FOUND` all count as completed deletion, for the routine and the bot (§8.3); R6-T9 absent and deleted-between-attempts cases. |
| 7 | Major | **Accepted (C)** | The fallback granted any other claimant. | Only playable documents may claim (main, or an active, ready, unlocked, seen notch); a locked notch sends none; the fallback rechecks eligibility at grant time in arrival order and drops the cue only if none qualifies (§14.2, §14.4); R6-T22 mixed locked/unlocked, standby and disposal during the delay. |
| 8 | Major | **Accepted (C)** | Electron documents `skipTransformProcessType` for processes that are already `UIElementApplication`; this app keeps its Dock icon. | Option removed; `setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false })` called once at creation (§10.1 W3); R6-T30 checks ordinary Spaces, the Dock icon and activation. |

**Self-consistency pass (r4, final).** Re-read after the edits: no text relies on `backgroundThrottling: false` or on `document.visibilityState` without throttling kept; every reader of "is the companion seen" uses §13 rule 3's one fact; `ai.attention` is a single subscription everywhere (the r2 `ai.attentionEvents` name survives only in the r2 response table, as history); the contract guards name the standby rejection; `skipTransformProcessType` appears only where its removal is explained; tests remain R6-T1 … R6-T44 with R6-T9, R6-T21, R6-T22, R6-T25, R6-T30 and R6-T44 extended. The pass also found four r3 test extensions (for R6-T17, R6-T22, R6-T25, R6-T28) that had been appended to the W8 row and to the policy-constants table instead of their test rows; they are now in their rows.
