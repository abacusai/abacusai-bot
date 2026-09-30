# 06 — Onboarding, tour, notch (phase 6)

Status: draft spec **r1** (no code; the Codex review comes next). Branch `rewrite/renderer`. It implements the "Onboarding, tour, notch" phase of `docs/rewrite/PLAN.md` (§Decisions "Notch", "Sound", "Small libraries"; §Where state lives, "spotlight step" → TanStack Store; §Route tree `_bare` and "notch entry: memory-history router"; §Folder structure `main.tsx notch.tsx`; §Motion system "Spotlight (tour)", "Notch wings/body", "welcome parade → shell"; §Sound; §Areas and parity "Onboarding + tour", "Notch"; §Notch window; §Phases 6; and the Amendments), on top of:

- `00-transport-db-migration.md` **r2** with its implementation notes: A.2.2 rows 19, 25, 26 (`account.skipOnboarding`, `system.notify`, `system.events`), A.4.1 (`windowKind: "main" | "notch" | "dev"`), A.4.2 (one port per window; only `wireRendererContents` registers contents, "later, the notch window"), A.4.3 (delivery classes), A.4.4 (handshake `kind: "main" | "notch"`), A.4.6 (the readiness barrier), A.5 (errors), B.2 (`prefs`, `onboardingStep`), the leaf-provenance notes and `updatePrefs(patch)`;
- `00-window-chrome.md` **r2**: `BaseWindow` + `WebContentsView` (§2, "do not migrate to `BrowserWindow`"), §6 line 85 ("the notch overlay window … must not import or use any of this, and must not be created with `titleBarOverlay`"), the recreate lifecycle;
- `00-agent-agui.md` **r3** with the relay notes: `PermissionDescriptor` (§3.5, `reason: "abacus:permission" | "abacus:question"`, `metadata.abacus.{lineage, kind, request, allowed}`), `permission.*` CUSTOM events, RUN_FINISHED/RUN_ERROR settle semantics, L808 ("the layout and the notch each mount an application-owned `PermissionList`");
- `01-renderer-foundation.md` **r4** as implemented (phase 1 merged `6847de01`): `_bare.tsx` + `onboarding.$step.tsx` placeholders with `ONBOARDING_STEPS` (§6.1), readiness reported from `__root` for every entry route including `/onboarding/*` (§6.1, R1-T20), the second Vite input (§3.3), hotkeys (§7.9), theme (§7.7), motion and sound modules (§7.8), occlusion lists (§7.6), gallery and screenshots (§10);
- `02-chat-kit.md` **r4**: `createChatRuntime(transport)` ("the notch entry (phase 6) calls it with its own transport", L170), `ThreadSession.load()`/`submit()`, `runtime.respondPermission`, `PermissionList` ("the notch mounts the same component", §6.2), the questionnaire encoding (F19), "Also in the notch" (§6.4);
- `03-bots.md` **r3**: §5.6 (what phase 6 consumes: `createBotFromTemplate`, `deleteBot`, `BotAvatar`, `data-tour="bots-name-input"`), §6.6 (the attention function), §14 (BotAvatar looks, moods, reactions), §17 (cue synthesis), §24.11 (the run-finished notice, r3 semantics);
- `04-sessions.md` **r2**: §6.6 (session attention), §19 (cues and notifications), §26.4 (e) (the run-finished notice as `sessions.events`), §26.8 (the OSI-licence rule for small libraries);
- `05-routines-artifacts-library-settings.md` **r1**: `updatePrefs(patch)` everywhere, `useConnectFlow` (§12.4, exported for onboarding), messaging flows (§13), the signed-out Account page and `tourSignedOut()` (§19.2), Settings rows reserved for this phase (F11, §18.1, §22.1), `sounds.perBot` / `sounds.quietHours` and `isQuietNow` (§22.4), `lib/notify.ts` `allowed` (§23.2), the `notch-reply` keymap entry (§21.3), silent OS notifications in the new generation (§31.5 d).

Paths are relative to `apps/desktop/` unless noted. Code in this spec is type declarations and short sketches only. **No code from openbot.run is copied or paraphrased line by line** (PolyForm Noncommercial 1.0.0, `refs/openbot-run/LICENSE`); only ideas and published numbers are used, each marked where it appears.

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
| openbot.run (ideas only) | clone under `scratchpad/refs/openbot-run`, `LICENSE` = PolyForm Noncommercial 1.0.0 | `src/main/{dynamic-island-window,main-window,mac-haptic-feedback,dynamic-island-actions}.ts`, `packages/ui/src/dynamic-island.tsx`, `packages/ui/src/features/dynamic-island/*`, `packages/team-client/src/dynamic-island-presentation.ts`, `src/renderer/src/completion-sound.ts` (read for behaviour and numbers; nothing copied) |
| Reviews | all 34 files | `docs/rewrite/specs/reviews/*` (defect classes applied in §24.4) |

---

## 0. Findings that change the brief (read first)

Each was checked against source. The ones that change another spec are repeated in §23.

| # | Brief / plan / earlier spec says | Verified fact | Consequence here |
|---|---|---|---|
| F1 | PLAN: notch size "from `node-mac-notch` (`safeAreaInsets`, auxiliary areas)"; window-chrome spec L85 names it | **`node-mac-notch` does not exist** (npm E404, as do `electron-notch` and `mac-notch`; nothing under `node_modules`). **Electron 44 has no notch or safe-area API**: `Display` (E:7998-8079) has `bounds`, `workArea`, `internal`, `label`, `scaleFactor`, `size`, `id`, … and nothing about the cut-out; a grep for `notch|safeArea|auxiliary|cutout` finds only `View.setBorderRadius` prose (E:16116). | Metrics come from a **one-shot JXA probe** (`/usr/bin/osascript -l JavaScript`, reading `NSScreen.screens` `frame`, `safeAreaInsets.top`, `auxiliaryTopLeftArea`, `auxiliaryTopRightArea`; macOS 12+), run by main, matched to Electron displays by frame (§10.2). Fallback: aspect-ratio inference on internal displays (openbot.run's published idea, re-derived). No native module. The probe's behaviour on hardware is **unverified** and decided by R6-T31 on a notched Mac. |
| F2 | PLAN: `BrowserWindow({ type: "panel", … })` | The app builds windows as `BaseWindow` + `WebContentsView` (`main/index.ts:625`, `renderer-host.ts:283-353`) and window-chrome §2 forbids migrating to `BrowserWindow`. `BaseWindowConstructorOptions` accepts `type?: string` (E:4070) but the typings list **no values**; `"panel"` (macOS) and `"toolbar"` (Windows) are from Electron's online docs only. A transparent `BaseWindow` needs `view.setBackgroundColor` with alpha on its child view (E:4066). | `BaseWindow({ type: "panel" \| "toolbar", transparent: true, frame: false, … })` + one `WebContentsView` with `setBackgroundColor("#00000000")` (§10.1). Whether `type: "panel"` yields a non-activating panel that never raises the hidden main window is **unverified**; R6-T30 asserts it on macOS. |
| F3 | Transport "later, the notch window" (00 A.4.2) | The transport is ready: `RendererKind = "main" \| "notch"` (`message-port.ts:39,96`), `windowKind` comes from main's registry, not the page (`:131-167`), and `connect.test.ts:258-269` already covers a `"notch"` port. But **main's deps assume every registered id is the main window**: `windows.state/chrome` answer the main window for any id (`index.ts:1618-1631`, "the notch comes later"), and `publishToWindowViews` sends main-window state and chrome to every registered id (`window-events.ts`, `index.ts:653-662,1584-1598`). | Per-window lookups and kind-filtered publication (§10.10, amendment §23.1 b). The notch registers with kind `"notch"` through `wireRendererContents`' sibling `wireNotchContents`; `requireMainRenderer` keeps it away from the browser runtime. |
| F4 | Brief: "the shared `sessions.events { run-finished }` notice" | Not implemented (no `sessions.events` anywhere in `shared/contract`). Two specs define it differently: **04 r2 §26.4 (e)** names it `sessions.events { run-finished }` and publishes it "from the compat taps"; **03 r3 §24.11** names it `ai.runFinished` and publishes it from `ThreadRelay` "at the authoritative run terminal … never from compat `turn_complete`" (03 codex r2 #8: `turn_complete` also fires between tool rounds), with `errorCode`, `threadId`, `at` and a `seq` for resume. | This spec consumes **one** notice under the brief's name with 03 r3's semantics: `sessions.events { type: "run-finished"; sessionId; runId; outcome; errorCode?; hasVisibleAssistantText; owner; routineId; at }` published at the relay's authoritative terminal, lossless-actionable, resumable by `lastEventId` (§11.3, amendment §23.4). Phase 6 cannot merge before it lands. |
| F5 | PLAN: the notch runs "the same `features/chat` client against the same AG-UI stream" | Pending permissions exist only inside each thread's stream: descriptors come from `ai.subscribe` (`permission.pending`) or `ai.hydrate` (`AiThreadSnapshot.permissions`, `ai-thread.ts:60-78`). There is no cross-thread permission feed. `SessionRow.turn.phase === "waiting_permission"` is the cross-thread signal, which 03 §6.6 already counts as 1 per uncached session. | The notch reads **levels** from the `sessions` table (which sessions wait, run, failed) and subscribes to a thread **only for the attention it is about to show** (at most two `ThreadSession`s: the one on screen and the next in line), through its own `createChatRuntime` (§11.2). It never subscribes to every thread. |
| F6 | PLAN: notch states `idle \| working \| message \| question \| approval \| takeover \| failed`; brief: routes `/idle /working /approval/$id /reply/$id /call /done /failed` | `takeover` is browser take-over (04's browser runtime), which has no cross-thread signal in the tables; the canvas `Notch` board draws no take-over state. `done` is on the canvas but not in PLAN's list. | Routes as the brief lists them. `question` renders inside `/approval/$id` (a descriptor with `reason: "abacus:question"`), with question ranked above approval (PLAN order). Take-over is **not built** (§24.3); a session waiting on a take-over shows as working. |
| F7 | Canvas `NotchRules`: "Answer from here … Replies: type or hold the mic"; `Notch` "Listening (dictation or a call)"; brief route `/call` | There is **no call transport** (03 F12: `voice.*` is Whisper download and microphone permission only). **Dictation audio has no owner** in 02–05: 02 §1.2 leaves "dictation audio" out and gives the composer a `Dictate` slot with states only; 03, 04 and 05 do not claim it. The old renderer's dictation is `renderer/voice/{recorder,whisper,use-dictation}.ts` (411 lines, `@huggingface/transformers` ^4.3.0 in-renderer, `package.json:96`). | Phase 6 ports dictation once to `lib/voice/` and wires both the composer's `Dictate` slot (amendment §23.2) and the notch. `/call` is the **listening** state for a dictated reply (waveform, timer, End); real calls stay not built (§24.3). |
| F8 | PLAN: 12 tour stops; old tour "react-tourlight" | The old tour has **4 live stops** (`tour-stops.ts:91-128`: bots, makeBot, connectors, terminal) of 15 authored copy families; no persistence (`tour-store.ts:3-10`, in memory, "deliberately no completed flag"); started as the last onboarding step (`explainer`) or from the account menu "Take the tour" (`settings-menu.tsx:69,357-360`). Canvas `TourMap`: twelve stops, "Replay from Settings › General › Take the tour". | Our own spotlight (§9) with the canvas's 12 stops, targets moved to the new shell (Library, not Settings, holds Connectors, 05 F7). Completion persists in prefs (`tour.status`); the running step is ephemeral (PLAN "spotlight step → TanStack Store"). The tour becomes opt-in from the first-bot step (canvas "Take the tour") instead of a forced last step (Changed). |
| F9 | Canvas `OnboardWelcome`: "Skip for now" | The old gate is `needsOnboarding = !onboarded \|\| !hasAbacusCredential` (`app.tsx:40-55`): a signed-out user, even onboarded, always lands on the sign-in step and cannot reach the app without Abacus. | Changed (canvas, and 05 `SettingsSignedOut`: "Local models and your own API keys work without it"): onboarding shows only while `!onboarded`; a signed-out onboarded user reaches the shell and signs in from Settings › Account. "Skip for now" jumps to the models step (own keys or a local model). Listed with its owner in §2.1 OB3. |
| F10 | Foundation `ONBOARDING_STEPS = ["welcome","connect","connected","models","connectors","first-bot","done"]`; spec 00: `prefs.onboardingStep` from legacy `onboarding.step`, "outside STEP_ORDER maps to null" | Legacy step ids are `auth, welcome, connectors, models, explainer` (`legacy-prefs.ts:85-95`), a different vocabulary: legacy `auth` is the new `welcome` (the sign-in screen), legacy `welcome` is the new `connected`. The canvas orders connectors **after** models (Onboard 4 models, 5 connectors); the old flow put connectors first. | `resumeStep(stored)` (pure, §6.3) reads both vocabularies (`auth→welcome`, `welcome→connected`, `explainer→first-bot`, the rest by name), so a user mid-onboarding on the old build resumes in the right place. New writes use the new ids. Order follows the canvas. |
| F11 | Canvas `OnboardConnect`: "Waiting for the browser… Continue with Chrome · Work" | Main decides between an in-app sign-in window (`abacus-signin-window.ts:286-330`, a 520×760 `BrowserWindow`) and the system browser (`shell.openExternal`) from a server experiment (`abacus-signin-config.ts:13-74`) and the picked browser profile (`abacus-auth-service.ts:300-304`); the renderer is not told which. `auth.abacus.browserProfiles` is empty unless the variant is `in_app` (`abacus-browser-profiles.ts:58-86`). | The `connect` step uses one neutral waiting line ("Finish signing in, then come back here") that is true for both surfaces, and shows the profile line only when the user picked a profile. No new procedure is added to report the surface. The renderer never opens those windows (05 F19). |
| F12 | Canvas `OnboardModels` row "Run a model on this computer · Qwen3 8B" | Onboarding never offered local models in the old app (only the "Runs locally." promise, `welcome-step.tsx:13`); the local-model UI is 05 §20.5 (`features/settings/models/local-models.tsx`). | New row, composed by the route from 05's exported local-model row (features cannot import features; routes compose). |
| F13 | Canvas `OnboardConnectors`: twelve product marks, "three already on" | Old step offered `messaging-whatsapp`, `messaging-telegram`, `messaging-discord`, `abacus-gmailuser` + "Many more" (`connectors-step.tsx:28-46`); every connect runs through `useConnectFlow` (05 §12.4: platform hop, messaging pairing, fields). | The canvas's grid (Gmail, Google Calendar, Google Drive, Slack, GitHub, Notion, Linear, Jira, WhatsApp, Telegram, Figma, Stripe) filtered by the registry and `connectors.statuses` (`not-offered` hidden, parity), with "Many more…" → the rest of the platform catalogue. Connect goes through `useConnectFlow` passed in by the route; messaging pairing opens `/library/messaging?platform=` **after** onboarding finishes (§7.5). |
| F14 | Canvas `OnboardFirstBot`: "the first bot hatches (egg → blob)"; `OnboardDone`: confetti | The old first-bot popup auto-creates Chief of Staff unless the user owns a non-channel bot (`first-bot-dialog.tsx:56-92`), Cancel deletes it, Create keeps it; no animation (no tsparticles/confetti code anywhere, the packages are listed but unused, `package.json:123-125`). The template's look is `squircle`, `#22c55e` (`bot-templates.ts:57-75`); 03 maps legacy `#22c55e` → `#4ade80` (03 §14.3). | Hatch and confetti are our own CSS/`motion` (§8, §16); `tsparticles` stays nuked. The hatch starts from the `egg` shape and settles on the template's own look (`resolveLook`), not the canvas's `blob`. |
| F15 | PLAN motion: notch "exit 160 / expand 420 / contract 450 ms, blur 4 px, `cubic-bezier(.22,1,.36,1)`" (openbot.run's values); canvas `NotchRules`: "Wings widen and the body drops with a 350 ms cubic-bezier(.2,.8,.2,1); content fades in 120 ms after the shape settles" | The two disagree. Foundation already ships `easings.notch = [0.22, 1, 0.36, 1]` (`lib/motion.ts`). | PLAN's values (they are in the foundation's motion module and tested there); the canvas's 120 ms content delay is kept. The board's 350 ms is a design follow-up (§23.7). |
| F16 | PLAN recipe: `setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, … })` | Canvas `NotchRules` "Quiet by default: nothing expands while you type, present, or sit in a full-screen app". `visibleOnFullScreen` is darwin-only (E:24419). | `visibleOnFullScreen: **false**`: the companion is not drawn over other apps' full-screen spaces (the OS hides it), attention collects and shows as a count when the user returns. Behaviour over full-screen spaces is **unverified** (R6-T30). |
| F17 | Brief: approval and reply flows "bound to the relay's `ai.*` procedures" | `ai.respondPermission` exists with the ten decisions (`ai.ts`); there is **no regenerate/retry of a failed run** (`ai.send` answers `regenerate_unsupported`); `ai.hydrate` returns the completed transcript. | Approval: `runtime.respondPermission` (02 §6.3). Reply: `ThreadSession.submit(text)` (02 §3.7; busy → host queue). Failed: "Open" only; the canvas's "Retry" is **not built** (§24.3). |
| F18 | PLAN §Sound: "the notch window plays needs-you and done when the main window is not focused" | Both documents would own an `AudioContext` and both see the same notices, so without arbitration a cue plays twice or not at all. | Main computes one **sound owner** (`main` or `notch`) and publishes it to both windows (§14.2); attention cues play in exactly one document. |
| F19 | Brief: "OS notifications policy (silent in the new generation per spec 05)"; canvas `SettingsNotifications` "Show in the notch: Replies and approvals appear in the notch companion, not as banners" | 05 §31.5 (d) sends every new-generation notification `silent`. Nothing lets main know which attention the notch is already showing. | `system.notify` gains an optional `kind`; main drops a notification of kind `needs-you` or `received` while `prefs.notch.showInNotch` is on and a notch window is ready (§13). |
| F20 | 02 §6.4: the kit renders "Also in the notch" "when `notchEnabled` prop is true" | `ChatViewProps` (02 §2) has no such prop, and `useThreadStore`, `decisionLabel`, the questionnaire encoder are not exported from `features/chat/index.ts` (02 L122-130). | Amendment §23.2: `ChatViewProps.notchEnabled?: boolean`; `PermissionList` gains `variant: "chat" \| "notch"`; the kit exports `encodeQuestionAnswers` and `runErrorCopy(code)`. |
| F21 | 03 §5.6: `createBotFromTemplate(templateId, overrides?)` "(§6.4)" | 03's §6.4 mutation table has no row for it; it exists only as an export name (03 L239) and in P46. | Its contract is defined here as a request to 03 (§23.3): insert the template bot with a client id, await `isPersisted`, create the check-in as 03 §9.4 does, return the row; `NOT_FOUND` for an unknown template id. |
| F22 | 03 §6.6 attention lives in `features/bots/data/attention.ts` | The notch entry is a separate document whose feature (`features/notch`) cannot import `features/bots` (foundation §4 rule). | The pure attention functions move to `lib/attention/` (`botAttention`, `moodFor`, `sessionAttention`); both features re-export them (amendment §23.3, §23.4). |
| F23 | Old close behaviour | On macOS closing hides the main window; on Windows/Linux closing quits unless a turn runs (dialog) (`index.ts:718-760`). A live capsule `BaseWindow` keeps `window-all-closed` from firing, so the app would no longer quit on Windows (review class: window-all-closed, 00-window-chrome impl #1). | On win32 the controller destroys the capsule when the main window closes for real (after the dialog); macOS keeps today's hide (§10.6). |
| F24 | 05 review r1 #3 | An ordinary routine run waiting on a permission gets no global attention (sessions exclude `routineId`, bots only check-in runs). | The notch's attention input covers **every** session kind (listed, bot, check-in, routine run), so a waiting routine run reaches the notch; its "Open" targets the run report (`/routines/$routineId?run=`). |

---

## 1. Scope

### 1.1 In scope

- **Onboarding** (§5–§8): the seven `_bare` routes of canvas page 11 with a pure step machine, resume after restart (both step vocabularies), skip paths, sign-in through the windows main owns, provider keys and local models, connectors through `useConnectFlow`, the first-bot hatch, the done step, the gate that sends a new user there, and completion.
- **Tour** (§9): the `Spotlight` molecule (one mask + card), typed `data-tour` anchors placed by shell and feature components, the 12 stops with their `prepare()` steps, ephemeral run state, persisted completion, replay from Settings and the command menu, sign-out hook, platform variants.
- **Notch window, main side** (§10): the macOS panel per display (window recipe, metrics probe and inference, geometry, multi-display, full-screen spaces, power events, click-through vs interactive, keyboard focus on demand, haptics), the Windows capsule by the clock, lifecycle (generation gate, readiness, reload on renderer swap, crash backoff, disable, quit), the `notch.*` contract and the per-window fixes in main.
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
| OB5 | Resume from `durableStorage` key `onboarding.step` (`onboarding-flow.tsx:44-62,109-111`), mirrored to `prefs.onboardingStep` (spec 00) | `prefs.onboardingStep` written on entering each step through `updatePrefs(patch)`; `resumeStep` maps both vocabularies (F10) (§6.3) | Parity |
| OB6 | Progress dots `StepDots` (`onboarding-flow.tsx:73-94`) | progress pill in the drag strip (canvas: 5 marks, active 20 × 6, radius 3; `connect`/`connected` share mark 2) (§7.1) | Parity (canvas look) |
| OB7 | Sign-in step: "Free forever" badge, title "AbacusAI Bot", tagline, three capabilities, "Sign Up For Free" (`signup`), "I already have an account" (+ "· Continue with {browser}" and a profile menu), hint "Google, Microsoft and Apple sign-in use your {browser} accounts.", "Use my browser instead", Cancel, error line (`sign-in-step.tsx:26-274`) | `welcome` (canvas `OnboardWelcome`): avatar parade, title, tagline, four pills, **Sign up for free**, **I already have an account** (profile menu kept), **Skip for now**; `connect` (canvas `OnboardConnect`) holds the waiting state, "Use my browser instead", "Sign in another way", Cancel (§7.2–§7.3) | Parity + Changed (canvas split into two steps; Skip added, F9) |
| OB8 | `signInToAbacus(intent, profileId)`; toast "Abacus.AI is successfully connected"; `unidentified-account` copy; cancelled silent; afterwards credential cache true, `listModels(true)`, `getAbacusAccount(true)` (`onboarding-flow.tsx:186-215`, `lib/abacus-sign-in.ts`) | `auth.abacus.start({ intent, browserProfileId? })` from `connect`; outcome `ok` → `connected` (the "successfully connected" line is on the page, canvas), refetch `account.abacus({ refresh: true })`, invalidate `models.list`; `unidentified-account` parity copy; `cancelled` → back to `welcome` quietly (§6.4) | Parity |
| OB9 | Browser profiles query on the auth step only (`onboarding-flow.tsx:220-225`) | `auth.abacus.browserProfiles` on `welcome` only (05 §19.2 hands it to this phase) | Parity |
| OB10 | Welcome step: "Welcome to AbacusAI Bot", four promises, "Get Started" (`welcome-step.tsx:9-75`) | `connected` (canvas `OnboardConnected`): check badge, "Abacus.AI is successfully connected", same title and promises, **Get started** (§7.4) | Parity |
| OB11 | Models step: Abacus / OpenRouter / Gemini cards with the parity blurbs, inert "Existing subscriptions", "Many more" providers, key dialog with `isPlausibleApiKey` and `onboarding.setupKeyInvalid`, OpenRouter browser hop, handshakes cancelled on leave (`provider-setup-step.tsx:24-393`) | `models` (canvas `OnboardModels`, `OnboardKeyDialog`): same three rows + **Run a model on this computer** (F12) + "Existing subscriptions · Connect later · Paste a key"; key dialog with "Open {provider}", invalid state, "Stored on this machine only." (§7.5) | Parity + New (local model row) |
| OB12 | Connectors step: WhatsApp, Telegram, Discord, Gmail + "Many more", "Continue" / "Continue without connectors", Cancel while a hop runs, flow cancelled on leave (`connectors-step.tsx:28-285`) | `connectors` (canvas `OnboardConnectors`): the canvas grid (F13) + "Many more…", same buttons; `useConnectFlow` (05 §12.4) passed by the route; a hop in flight is cancelled on leaving the step (parity, not 05's "survives navigation") (§7.6) | Parity (canvas grid) |
| OB13 | `finish()`: clear step, funnel `onboarding_done`, activate the active workspace and `agent.switchWorkspace`, `skipAccountOnboarding` (`onboarding-flow.tsx:145-159`) | `completeOnboarding()`: `account.skipOnboarding()`, `updatePrefs({ onboardingStep: null })`, funnel `onboarding_done` (§6.5); no workspace activation (routes carry ids) | Parity; workspace switch Retired (PLAN "no state in two places") |
| OB14 | Funnel `screen_<step>` per step (`onboarding-flow.tsx:126-128`, `shared/funnel.ts:6-27`) | `system.funnelStep` per step with the **existing** names: `welcome → screen_auth`, `connected → screen_welcome`, `connectors → screen_connectors`, `models → screen_models`, `first-bot → first_bot_shown`, `done → onboarding_done` (no new names leave the machine) (§6.6) | Parity |
| OB15 | "Sign in" in the settings menu when signed out: `forgetAccount()` + tour reset + navigate `/` (restarts onboarding) (`settings-menu.tsx:91-95,382-389`) | Settings › Account signed-out "Sign in with Abacus.AI" (05 §19.2, ST9); onboarding is not re-entered | Changed (05 ST9) |
| OB16 | Onboarding resets an open tour on mount (`onboarding-flow.tsx:136-138`) | `tourStore` is ephemeral and the tour host lives only under `_shell`, so nothing to reset | Retired (structure) |
| OB17 | — | Welcome → shell shared element: the parade's centre bot flies to the transcript header, shell fades in from 0.98 (canvas `OnboardMotion`) (§16) | New |

### 2.2 First bot and first-run

| # | Today | New | Status |
|---|---|---|---|
| FB1 | Armed only by the onboarding → app transition, in memory (`app.tsx:96-108,188`) | the `first-bot` step (§8), reached only from onboarding | Parity (placement changed: a step, not a popup) |
| FB2 | Skipped when the user owns a bot without `channel` (`first_bot_skipped:has_bots`), when the template is missing, or creation fails (`first-bot-dialog.tsx:61-92`) | same three rules; the step is then skipped forward to `done` with the funnel detail (§8.1) | Parity |
| FB3 | Creates "Chief of Staff" (`FIRST_BOT_TEMPLATE_ID`, `bot-templates.ts:57-75`) and opens `NewBotDialog` "We have created your first bot for you, enjoy!" | `createBotFromTemplate("chief-of-staff")` (03 §5.6, contract §23.3) on entering the step; canvas copy "We made your first bot for you" with the bot card and **Edit** (§8.2) | Parity (canvas copy) |
| FB4 | Cancel deletes the bot (`first_bot_cancelled`); Create keeps it and opens `/bots/$botId` (`first_bot_kept`) (`first-bot-dialog.tsx:109-131`) | **Start from scratch** (secondary link) deletes it (`deleteBot`, `first_bot_cancelled`) and goes to `done`; **Say hello** keeps it (`first_bot_kept`) → `done`; **Take the tour** keeps it and starts the tour after completion (§8.3) | Parity + New (tour entry) |
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
├─ metrics.ts                            probeNotchMetrics() (JXA, §10.2), inferNotchMetrics(display) (pure)
├─ geometry.ts                           notchPlacement(), capsulePlacement(), windowBoundsFor(shape) (pure, §10.2, §10.8)
├─ interaction.ts                        setInteractive / focus-on-demand / settle timer (§10.5)
├─ haptics.ts                            one long-lived osascript helper, throttled (§10.7)
├─ sound-owner.ts                        soundOwner() + publication (§14.2)
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
| `_bare/onboarding.$step.tsx` (f) | `/onboarding/$step` | `params.parse` against `ONBOARDING_STEPS` (unchanged); `beforeLoad`: `guardStep(step, ctx)` (§6.2) redirects an unreachable step (e.g. `connected` while signed out → `welcome`, `first-bot` with no model access → `models`) with `replace`; loader: step data (§5.3); component: the step's organism from `features/onboarding` with the route-composed pieces (§7.5–§7.6). |

`_shell.tsx` (a): `beforeLoad` gains the gate (§5.2).

### 5.2 The gate (`features/onboarding/gate.ts`)

```ts
export function needsOnboarding(account: AccountState): boolean;          // !account.onboarded (F9)
export function onboardingTarget(prefs: PrefsRow): { to: "/onboarding/$step"; params: { step: OnboardingStepId } };
```

`_shell.tsx` `beforeLoad: async ({ context }) => { const account = await context.queryClient.ensureQueryData(accountStateQuery(context.transport.orpc)); if (needsOnboarding(account)) throw redirect({ ...onboardingTarget(context.collections.prefs.get("app") ?? DEFAULT_PREFS), replace: true }); }` (prefs are ready before the router exists, foundation §8.6). `accountStateQuery` has `staleTime: Infinity`, is seeded by `bootstrap()` (a fourth step after prefs, 2 s timeout, failure → treat as onboarded so an unreachable account file never locks the user out; the error is logged) and invalidated by `completeOnboarding` and `account.*` mutations. The redirect happens before the shell renders, so there is no flash. Deep links from notifications into the shell of a not-yet-onboarded user land on onboarding (acceptable: a new user has no sessions to open).

### 5.3 Onboarding loaders

| Step | Loader (enter/stay) | On `preload` (hover) |
|---|---|---|
| `welcome` | `auth.abacus.browserProfiles` via `ensureQueryData` (parity OB9: only here) | none (no link to it is ever hovered) |
| `connect` | none; the sign-in call is started by the click on `welcome`, not by the route (§6.4) | none |
| `connected` | `account.abacus({ refresh: true })` (tier decides the models step) | none |
| `models` | `settings.keys.listProviders`, `localModels.state` (05 §20.5) | none |
| `connectors` | `connectors.statuses` | none |
| `first-bot` | `bots.preload()`; the template bot is created by the **component** on mount of the step (not a loader), once per onboarding (§8.1) | none |
| `done` | `bots.preload()` | none |

No loader starts a sign-in, opens a window, creates a bot or connects anything (R6-T3). Every such action is a click.

### 5.4 Notch route tree (`src/renderer-next/notch-routes/`, memory history)

| File | Path | Params / search | Loader | Renders |
|---|---|---|---|---|
| `__root.tsx` | root | — | none (boot resolved transport, prefs, sessions, bots) | `NotchShell` (shape, wings) + `<Outlet/>` in the body; `NotchDirector`; readiness (`window.ready` once the three tables are ready) |
| `idle.tsx` | `/idle` | — | — | `IdleView` (faces, dot, count; nothing when idle is hidden) |
| `working.tsx` | `/working` | `session?: SessionId` | — | `WorkingView` (face + caption left, progress right) |
| `approval.$id.tsx` | `/approval/$id` | `$id` = session id | `await context.chat.session(id).load()` (5 s cap, 02 §3.2) | `ApprovalView` or `QuestionView` for the session's first pending descriptor |
| `reply.$id.tsx` | `/reply/$id` | `$id` = session id; `focus?: true` | `await context.chat.session(id).load()` | `ReplyView` (last assistant text, reply field) |
| `call.tsx` | `/call` | `session: SessionId`; `from: "reply" \| "hover"` | — | `ListeningView` (waveform, timer, End) |
| `done.tsx` | `/done` | `session: SessionId` | — | `DoneView` |
| `failed.tsx` | `/failed` | `session: SessionId`; `code?: string` | — | `FailedView` |

- `createRouter({ routeTree: notchRouteTree, history: createMemoryHistory({ initialEntries: ["/idle"] }), defaultPreload: false, context })`. Nothing in the notch is hovered for navigation (the director navigates), so there is no preloading. The director awaits `session.load()` before navigating (§11.6), so the two loaders resolve at once from the cached session and no pending UI ever shows.
- Every navigation is `replace: true` (the notch has no back stack; memory history stays one entry deep).
- Unknown path → `/idle` (`notFoundComponent` redirects). A `$id` whose session vanished (deleted) → the director's next presentation replaces it; the route renders nothing meanwhile (no error boundary).
- Params use `SessionId` from `#shared/contract/ids` (valibot parser), search fields fall back as foundation §6.2.

### 5.5 Not found, gone while open

- `/onboarding/<unknown>`: the foundation's `params.parse` throws → `notFoundComponent` of `_bare` redirects to `/onboarding/` (resume).
- The first bot deleted elsewhere while `first-bot` is open: the card shows "This bot was removed." and the step offers **Continue** to `done` (no re-creation loop).
- Tour anchors that vanish mid-stop (a sidebar collapses): the mask re-measures; a rect of 0 × 0 or a detached element turns the stop into a centred card (§9.3).

---

## 6. Onboarding state machine and data (`features/onboarding/machine.ts`, `actions.ts`)

### 6.1 Steps and transitions (pure)

```ts
export const ONBOARDING_FLOW = ["welcome", "connect", "connected", "models", "connectors", "first-bot", "done"] as const;   // = ONBOARDING_STEPS
export interface FlowFacts {
  signedIn: boolean;            // settings.get → canSignOutOfAbacus (a stored Abacus key)
  payingTier: boolean;          // isPayingAbacusTier(account.abacus) (parity OB4)
  ownsBot: boolean;             // a bot with channel == null exists (parity FB2)
  platform: NodeJS.Platform;
}
export type FlowEvent =
  | { type: "sign-up" } | { type: "sign-in"; profileId?: string } | { type: "skip" }         // welcome
  | { type: "auth-ok" } | { type: "auth-cancelled" } | { type: "auth-failed"; code: AbacusAuthError }   // connect
  | { type: "next" } | { type: "back" };
export function next(step: OnboardingStepId, event: FlowEvent, facts: FlowFacts): OnboardingStepId | "complete";
```

| From | Event | To |
|---|---|---|
| `welcome` | `sign-up` / `sign-in` | `connect` (the click also starts `auth.abacus.start`, §6.4) |
| `welcome` | `skip` | `models` (F9) |
| `connect` | `auth-ok` | `connected` |
| `connect` | `auth-cancelled` | `welcome` (quiet) |
| `connect` | `auth-failed` | stays, error line (§6.4) |
| `connected` | `next` | `models`, or `connectors` when `payingTier` (parity OB4) |
| `models` | `next` | `connectors` |
| `models` | `back` | `connected` when signed in, else `welcome` |
| `connectors` | `next` | `first-bot`, or `done` when `ownsBot` (parity FB2, `first_bot_skipped` detail `has_bots`) |
| `connectors` | `back` | `models` (or `connected` on a paying tier) |
| `first-bot` | `next` (Say hello / Start from scratch) | `done` |
| `first-bot` | `tour` | `complete` then the tour (§8.3) |
| `done` | `next` (either button) | `complete` |

R6-T4 is a table test over every row and every `FlowFacts` combination.

### 6.2 Guards (`guardStep`)

A direct URL or a stale resume can name a step whose preconditions do not hold. `guardStep(step, facts)` (pure) returns the nearest valid step: `connect` is never a resume target (a sign-in window does not survive a restart) → `welcome`; `connected` when not signed in → `welcome`; `first-bot` when `ownsBot` and no bot was created in this onboarding → `done`. The `$step` route's `beforeLoad` redirects with `replace` when the guard differs.

### 6.3 Resume after restart

`onboardingStep` is written on **entering** each step (`updatePrefs({ onboardingStep: step })`, a patch, so an explicit write is `user` provenance and a later legacy import cannot move it back, spec 00 notes). `resumeStep(stored: string | null): OnboardingStepId`:

| Stored | Resume at |
|---|---|
| `null` | `welcome` |
| new id (`welcome`, `connected`, `models`, `connectors`, `first-bot`, `done`) | itself, then `guardStep` |
| `connect` | `welcome` |
| legacy `auth` | `welcome` |
| legacy `welcome` | `connected` |
| legacy `connectors`, `models` | same name |
| legacy `explainer` | `first-bot` (the old last step was the tour; the new equivalent entry point is the first-bot step's "Take the tour") |
| anything else | `welcome` |

Spec 00's import of the legacy key keeps only legacy `STEP_ORDER` values (`legacy-prefs.ts:85-95`); new ids arrive only from renderer-next writes. R6-T5 covers the table and a restart in the middle of `connect` (main's pending handshake is cancelled on quit, `abacus-auth-service.ts` 20 min timeout otherwise).

### 6.4 Sign-in (`welcome` → `connect`)

- **Sign up for free** → `auth.abacus.start({ intent: "signup" })`; **I already have an account** → `intent: "signin"`; a picked browser profile passes `browserProfileId` (parity OB7). The mutation is started from the click handler and its promise is held in `onboardingStore.signIn` (ephemeral TanStack Store), so navigating to `connect` does not cancel it and a double click starts nothing new (the button is disabled while the promise is pending).
- `connect` shows the waiting row (canvas: 52 px, radius 14, `bg-muted`, one spinner, "Finish signing in, then come back here" (F11) and the profile line "Continue with {browser} · {profile}" when one was picked). The bot avatar carries the waiting face (canvas "Only one spinner on screen").
- **Use my browser instead** → `auth.abacus.openInBrowser()` (parity); **Sign in another way** → the profile menu's "Sign in another way" (parity: opens the plain browser flow, `auth.abacus.cancel()` then `start({ intent, browserProfileId: undefined })`); **Skip for now** → `auth.abacus.cancel()` then `skip`.
- Outcomes (`AbacusAuthOutcome`, typed output, never an error, spec 00 A.5): `{ ok: true }` → `auth-ok`; `{ ok: false, cancelled: true }` → `auth-cancelled`; `{ ok: false, error: "unidentified-account" }` → the parity line "Couldn't verify which account this key belongs to. Nothing was saved. Please try signing in again."; any other `error` code → "Sign-in didn't finish. Try again, or use your browser instead." with **Try again**. The UI never parses messages (review class 36).
- After `auth-ok`: `queryClient.invalidateQueries` for `account.*`, `settings.get`, `models.list` (parity: credential cache, `listModels(true)`, `getAbacusAccount(true)`).
- Main already brings the app to the front on success (`abacus-auth-service.ts:240-247`); nothing else is needed here.

### 6.5 Completion (`completeOnboarding`)

1. `await account.skipOnboarding()` (writes `onboarded: true`; the name is historical, spec 00 A.2.2 row 19) → set the `accountStateQuery` cache from its result.
2. `await updatePrefs({ onboardingStep: null })`.
3. `system.funnelStep({ step: "onboarding_done" })` (fire and forget).
4. Navigate: `done`'s buttons → `/bots/$botId` (shared-element flight, §16) or `/sessions/new`; the first-bot "Take the tour" → `/bots/$botId` then `startTour({ origin: "onboarding" })` after the navigation commits.

A failure in step 1 keeps the user on the step with a toast "Couldn't finish setting up. Try again." and a retry; steps 2–4 do not run (no half-finished onboarding). R6-T6.

### 6.6 Funnel

`enterStep(step)` calls `system.funnelStep` with the existing names (OB14); `first-bot` reports `first_bot_shown`, `first_bot_kept`, `first_bot_cancelled`, `first_bot_skipped` (detail `has_bots`, `no_template`, `create_failed`) as today; the tour reports `tour_done`/`tour_skipped` (TR6). No new names (the list is fixed so nothing else leaves the machine, `shared/funnel.ts:1-5`).

---

## 7. Onboarding pages (`features/onboarding/steps/`, canvas page 11)

### 7.1 Frame (`OnboardingFrame`)

- Full window, `bg-background` with the canvas's radial wash (`radial-gradient(900px 500px at 50% -10%, color-mix(in oklch, var(--primary) 18%, transparent), transparent 60%)`, computed from tokens so light theme works), content centred in a column `max-width: 640px`, `padding: 0 40px 40px`, scrolling inside when the window is 800 × 600 (the minimum, `index.ts:604-621`).
- The foundation's `_bare` drag strip is the title bar; the **progress pill** sits at its right end before `--titlebar-end` (canvas: five marks 6 × 6, gap 6, active 20 × 6, done `--muted-foreground`, future `--border`; width animates 300 ms). Marks: 1 welcome, 2 connect/connected, 3 models, 4 connectors, 5 first-bot/done. `role="progressbar"`, `aria-valuenow` = mark, `aria-valuetext="Step {n} of 5"`.
- Buttons: primary 44 px radius 12 (registry `Button` size `lg` with the canvas radius through `className`), secondary `variant="secondary"`, tertiary `variant="ghost"` 32 px 13 px text.
- Enter animation per step: children rise 12 px and fade, staggered 80 ms (canvas `.rise d1…d5`); between steps the step VT (§16).

### 7.2 `welcome` (canvas `OnboardWelcome`)

Parade of five `BotAvatar`s (bunny/pink/bow/happy 56, blob/green/wink 72, mochi/blue/glasses/idle 88, cat/orange/love 72, star/yellow/crown/excited 56) bobbing 3.2 s staggered 0.4 s, the centre one named `welcome-parade` for the shared-element flight (§16); "AbacusAI Bot" 40/48 700; "Open Source Agent And AI Co-Worker" 17/24; four pills (dot + label): "Free forever", "100+ AI models", "100+ connectors", "Persistent memory" (parity capabilities + badge, OB7); **Sign up for free** (primary), **I already have an account** (secondary; when `browserProfiles` has a default profile the label is "I already have an account · Continue with {browser}" with a chevron `DropdownMenu` listing each profile "Continue with {browser} · {profile}" and "Sign in another way", parity); **Skip for now** (tertiary). The parity hint "Google, Microsoft and Apple sign-in use your {browser} accounts." shows under the buttons when a default profile exists.

### 7.3 `connect` (canvas `OnboardConnect`)

Avatar 88 (`blob` green, `waiting`), "Sign in to Abacus.AI in your browser" (28/36), "Your browser opens to sign in, or create an account. The app gets its own API key; your password never touches it." (max 460), the waiting row (§6.4), tertiary row "Use my browser instead · Sign in another way · Skip for now", error line when present (`role="alert"`).

### 7.4 `connected` (canvas `OnboardConnected`)

Avatar 96 `happy` with a 26 px check badge, "Abacus.AI is successfully connected" (success tone), "Welcome to AbacusAI Bot" 34/42, a 2 × 2 grid of the four promises (parity OB10 strings), **Get started** → `next`.

### 7.5 `models` (canvas `OnboardModels`, `OnboardKeyDialog`)

Rows (640 wide, 14 px radius, `bg-muted`, 1 px `--success` border when connected):

| Row | State source | Action |
|---|---|---|
| Abacus.AI "Get world-class models free · 2000 free credits" | signed in → "Connected" | signed out → **Connect** = `welcome`'s sign-in inline (`auth.abacus.start({ intent: "signin" })`, the row shows the waiting state; parity `provider-setup-step.tsx:124-139`) |
| OpenRouter "Unlock FREE models with one connection" | `settings.keys.listProviders` includes `openrouter` → "Connected" | **Connect** → `auth.openRouter.start()` (browser hop; Cancel → `auth.openRouter.cancel()`; parity) |
| Gemini "Use Gemini free to create anything" | provider key present → "Connected" | **Add key** → `ProviderKeyDialog` (05 §20.4, passed in by the route): "Go to Gemini and get your API key", **Open Gemini** (`system.openExternal` to the provider's console URL from `PROVIDER_KEY_FIELDS`), masked input, `isPlausibleApiKey` → "That doesn't look like an API key. Check the paste for a stray line or URL." (parity `onboarding.setupKeyInvalid`), "Stored on this machine only.", Save → `settings.keys.save` |
| This computer "Run a model on this computer · {model}, {size}, no account" (F12) | `localModels.state` (05 §20.5) | **Download** / progress / **Ready**, the recommended model from 05's catalogue; the row is 05's `LocalModelRow` passed in by the route |

Below: "Existing subscriptions — Bring your paid models and tools into one place" (parity inert copy) with **Connect later** (= `next`) and **Paste a key** (opens the provider picker: the "Many more" providers of parity OB11 in a `DropdownMenu`, then the key dialog). **Continue** is always enabled (a user may continue with nothing; the composer's model picker explains later). Leaving the step cancels both handshakes (parity `provider-setup-step.tsx:114-120`).

### 7.6 `connectors` (canvas `OnboardConnectors`)

"Connect with your tools & services." (accent on the second half), "Chat where you work. Attach the ones you use and the agent can read, draft and act in them, asking first." A 3-column grid of 12 tiles (`ConnectorMark` 28, name, **Connect** / "Connected"), ids in canvas order mapped to registry ids (`abacus-gmailuser`, `abacus-googlecalendar`, `abacus-googledrive`, `abacus-slack`, `abacus-github`, `abacus-notion`, `abacus-linear`, `abacus-jira`, `messaging-whatsapp`, `messaging-telegram`, `abacus-figma`, `abacus-stripe`; ids that the registry does not carry are dropped at build time by a test, R6-T8), tiles whose status reason is `not-offered` hidden (parity), **Many more…** reveals every other `kind: "platform"` connector (parity).

Connect is `useConnectFlow().start(id)` (05 §12.4) passed by the route. Two onboarding-specific rules: (1) a hop in flight is **cancelled** when leaving the step (parity OB12; 05's flow survives navigation elsewhere); (2) messaging (`pairing`) does not navigate to Library mid-onboarding: the tile shows "Finish after setup" and the platform is queued in `onboardingStore.pendingPairing`; `completeOnboarding` then opens `/library/messaging?platform=<first queued>` instead of the default target. **Continue** / **Continue without connectors** (label by whether anything connected, parity).

### 7.7 `done` (canvas `OnboardDone`)

Three avatars (the first bot 80 `excited` in the centre, two neighbours 56), "You're set", "{bot} is checking your calendar. Say hello, or start a session in a folder." (the middle clause only when the bot has a check-in; else "Say hello, or start a session in a folder."), **Message {bot}** (primary) and **New session** (secondary). Confetti plays once on entry (§8.2). Without a first bot (skipped): the parade of `welcome`, "You're set", **New bot** and **New session**.

---

## 8. First bot (`features/onboarding/steps/first-bot.tsx`, canvas `OnboardFirstBot`)

### 8.1 Creation

On mount of the step, once per document (`onboardingStore.firstBot` holds `{ botId } | { skipped: reason }`; a remount reuses it):

1. `ownsBot` (a bot with `channel == null`) → skip to `done` (`first_bot_skipped:has_bots`). This also covers a restart in the middle of the step: the bot created before the restart is an own bot, so the step is skipped rather than creating a second Chief of Staff (the old flow re-armed nothing after a restart either, the flag was in memory, `app.tsx:96-108`).
2. `createBotFromTemplate("chief-of-staff")` (03 §5.6, contract §23.3). `NOT_FOUND` (no template) → skip (`no_template`); any other error → skip (`create_failed`) with a toast "Couldn't create your first bot. You can make one any time." (parity: failure skips).
3. Success → `first_bot_shown`, the hatch plays.

### 8.2 Hatch and confetti

- `BotAvatar` gains a `hatch?: { from: "egg"; onDone(): void }` prop (amendment §23.3): the avatar renders the `egg` shape in the bot's colour at 112 px with a 220 px radial glow pulsing 2 s, wobbles 3 cycles of 220 ms (±6°), squashes to `scaleY 0.9`, then swaps to the bot's resolved look (`resolveLook`, F14) popping to 1.08 and settling with a `motion` spring (`damping: 0.6` expressed as `{ type: "spring", stiffness: 420, damping: 18 }`, the canvas's "0.6 damping" re-expressed in `motion` terms and marked provisional), then `onDone`.
- `Confetti` (`components/confetti`): seven 8 × 12 pieces radius 2 in the palette colours, 2.4 s `translateY(-20px → 140px) rotate(0 → 320deg)` fade in/out, staggered 0–0.8 s, `aria-hidden`, removed after one run (canvas "then gone"). Reduced motion: hatch is a 120 ms cross-fade from egg to look, confetti skipped (canvas `OnboardMotion`).

### 8.3 The step

"We made your first bot for you" (28/36), "{name} runs your workday across Gmail, Calendar and Slack. Rename it, restyle it, or start from scratch." (the template's description, i18n'd, not hard-coded), the bot card (avatar 40 `wink`, name, "Checks in weekdays at 8:00 · Gmail, Calendar" from the check-in summary 03 §10.1 and the template's connectors), **Edit** → opens `/bots/$botId/edit` **after** completion (`completeOnboarding` target), **Say hello** (primary) → `first_bot_kept` → `done`, **Take the tour** (secondary) → `first_bot_kept` → complete + tour, **Start from scratch** (tertiary) → `deleteBot(botId)` (`first_bot_cancelled`) → `done` without a bot.

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

### 10.1 macOS window recipe (`window.ts`)

The recipe follows PLAN §Notch window (openbot.run's idea, re-expressed for `BaseWindow`, F2):

```ts
const win = new BaseWindow({
  type: "panel",                 // macOS NSPanel (value from Electron's docs; typings say only `string`, E:4070) — R6-T30
  show: false, frame: false, transparent: true, hasShadow: false, roundedCorners: false,
  resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false,
  focusable: false,              // made focusable only on demand (§10.5)
  skipTaskbar: true, hiddenInMissionControl: true, alwaysOnTop: true,
  enableLargerThanScreen: true,  // lets the window sit over the menu bar strip (E:3884) — R6-T30 asserts y = display.bounds.y
  acceptFirstMouse: true,        // a click on an unfocused panel acts at once (E:3832)
  backgroundColor: "#00000000",
  ...placement.bounds,
});
win.excludedFromShownWindowsMenu = true;                              // E:3701
win.setAlwaysOnTop(true, "status");                                   // E:3196
win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false, skipTransformProcessType: true });   // F16; no dock flicker (E:24429)
win.setIgnoreMouseEvents(true, { forward: true });                    // click-through, mousemove still delivered (E:3378, 22197)
const view = new WebContentsView({ webPreferences: {
  preload: join(import.meta.dirname, "../preload/index.cjs"),
  additionalArguments: ["--abacus-window=notch"],                     // E:19418; the preload picks the notch branch
  sandbox: false, contextIsolation: true, nodeIntegration: false,      // same as the main view (`index.ts:1077-1089`)
  backgroundThrottling: false,                                         // timers and reactions run while never focused
  spellcheck: true, webviewTag: false,
}});
view.setBackgroundColor("#00000000");                                 // required for a transparent BaseWindow (E:4066, 16114)
win.contentView.addChildView(view);
```

- `webContents.setWindowOpenHandler(() => ({ action: "deny" }))`; `will-navigate` is prevented except a same-document reload; `will-attach-webview` denied. Links in the notch never open anything but the main window (`notch.openInApp`, §10.10).
- The entry is `notchEntry(base)` next to `index-next.html` (amendment to `renderer-entry.ts`: `NOTCH_ENTRY = "notch.html"`, the same three bases), so dev, experience bundles and packaged files all resolve it.
- **Registration**: `wireNotchContents(contents)` is the sibling of `wireRendererContents` and calls `rpcTransport.registerRendererContents(contents, "notch")`; it is the only other place a webContents becomes trusted (spec 00 A.4.2's rule, amended). The transport already gives the port `windowKind: "notch"` from main's registry, never from the page (`message-port.ts:131-167`).
- **Preload**: `src/preload/index.ts` becomes a dispatcher on `process.argv.includes("--abacus-window=notch")`: the notch branch installs only `installRpcPortHandshake(ipcRenderer, window, "notch")`; the main branch is today's file body, moved verbatim into `main-preload.ts` (its tests unchanged). The notch page therefore has no `window.api`, no `window.abacusHost`, and never runs the synchronous `renderer-state:snapshot` read.
- No `titleBarOverlay`, no chrome options, no theme-driven background (window-chrome §6 L85): the notch is always drawn black with light text in both themes (canvas), so it needs no `nativeTheme` follow.

### 10.2 Notch metrics and geometry (`metrics.ts`, `geometry.ts`)

**Probe (F1).** `probeNotchMetrics(): Promise<ProbedScreen[] | null>` runs `/usr/bin/osascript -l JavaScript -e <script>` through `execFile` with a 3 s timeout. The script (our own, a dozen lines of JXA over the Objective-C bridge) prints JSON: for each `NSScreen.screens` entry its `frame` (points, bottom-left origin), `safeAreaInsets.top`, and the widths of `auxiliaryTopLeftArea` / `auxiliaryTopRightArea` (both `nil` on screens without a cut-out and on macOS < 12). Failure modes (timeout, non-zero exit, unparsable output, macOS < 12) return `null`; nothing throws into the controller.

**Matching to Electron displays.** Electron `Display.bounds` are DIP with a top-left origin (E:8009); `NSScreen.frame` is in points with the origin at the primary screen's bottom-left. Points equal DIP on macOS. A probed screen matches a display when `frame.width === bounds.width && frame.height === bounds.height && frame.x === bounds.x && primary.height - (frame.y + frame.height) === bounds.y`. Unmatched entries are ignored.

```ts
export type NotchMetrics = { width: number; height: number };            // the cut-out, DIP; centred on the display
export function metricsFromProbe(s: ProbedScreen): NotchMetrics | null;   // top > 0 && left > 0 && right > 0 → { width: frame.width - left - right, height: top }
export function inferNotchMetrics(d: Pick<Display, "internal" | "bounds">): NotchMetrics | null;
```

**Inference (fallback, pure).** Only for `internal` displays whose aspect ratio is within ±0.01 of 1512 / 982 (the 14″ MacBook Pro's default point size; the ±0.01 window also covers the 13.6″/15.3″ Air and 16″ Pro defaults and their "More space" sizes): `{ width: round(185 × bounds.width / 1512), height: 32 }`. The 185 × 32 reference is openbot.run's published figure; the canvas board says 200 × 32 (14″) and 196 × 32 (16″). Neither is authoritative: R6-T31 records the probe's values on real hardware into `metrics.fixtures.json`, and the inference constants are updated from those records before release. Any other display → `null` (no cut-out).

Results are cached per `${display.id}:${w}x${h}@${scaleFactor}` and re-probed on every reconcile that changes the key.

**Dev override** (review class 4): `ABACUSBOT_NOTCH_METRICS=WxH` forces metrics on the primary display, honoured only when `!app.isPackaged` (unit test R6-T24).

**Placement (pure).**

```ts
export interface NotchPlacement {
  displayId: number;
  mode: "notch" | "plain";                       // plain: no cut-out (external display, non-notched Mac)
  notch: NotchMetrics | null;
  bounds: Rectangle;                             // the window, DIP
  shapeOrigin: { x: number; y: number };         // where the shape's top-left sits inside the window
}
export function notchPlacement(display: Display, notch: NotchMetrics | null, shape: { width: number; height: number }): NotchPlacement;
```

- Window = shape + 24 px each side and 32 px below (the canvas's `0 8px 24px` shadow never clips), top edge at `display.bounds.y`, centred on `display.bounds.x + display.bounds.width / 2`.
- The shape is centred too; in `notch` mode its wings are `(shape.width - notch.width) / 2` each and the renderer never draws content in the centre `notch.width` (canvas "Around the notch, never on it").
- Maximum shape 560 × 220 (the tallest body: an approval with a two-line summary and one question row); requests above it are clamped by main and reported back in `notch.layout`.

**Grow before, shrink after (openbot.run's 700 ms settle, PLAN).** `notch.setShape({ width, height })` from the renderer: a larger rect is applied **immediately** (`setBounds` without animation) and the call resolves after it, so the renderer's CSS grow animation is never clipped; a smaller rect is applied after a **700 ms settle** timer, cancelled if a larger rect or `interactive: true` arrives meanwhile, and re-read from the display's current geometry when it fires (not the rect captured when it was armed).

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

- The panel is never focusable except in the third state (openbot.run keeps its island unfocusable so it never shows as an app window in switchers; we do the same and add focus only for typing). Focusing a `type: "panel"` window must not raise or show the hidden main window: **unverified**, R6-T30 asserts `mainWindow.isVisible()` stays false.
- On `setFocusable(false)` macOS keeps focus (E:3341 "does not remove the focus"); the controller therefore also calls `win.blur()` when leaving the focused state.
- **Global shortcut** (05 §21.3 `notch-reply`, `Mod+Shift+Space`, owner main, not rebindable): registered with `globalShortcut.register("CommandOrControl+Shift+Space", …)` (E:8608) while the companion is enabled on a supported platform; press → focus the window on the display nearest the cursor (`screen.getDisplayNearestPoint(screen.getCursorScreenPoint())`, E:12190/12198) and publish `notch.events { type: "shortcut" }`. `register` returning `false` (taken by another app) sets `notch.status().shortcut = "unavailable"`, shown in Settings (§15). Unregistered on disable and in `will-quit`.

### 10.6 Lifecycle

- **Generation gate** (review class 3): the controller exists only when `RENDERER_GENERATION === "wco"`; the legacy generation creates nothing, registers no shortcut and publishes no `notch.*` events.
- **Platform gate**: darwin and win32 only; Linux never creates a window (`notch.status` reason `platform`).
- **Start**: after the main renderer reports readiness (`RendererReadiness`), if `prefs.notch.enabled`.
- **Readiness**: each notch view reports `window.ready({ barrier: "subscriptions" })` once its tables are ready (the existing procedure, keyed by `webContentsId`, `rpc/readiness.ts`); main waits up to 10 s, then shows the window with `showInactive()` (E:3632) only when the renderer's first `setShape` says something is drawn. Timeout or `failed` → destroy and retry after 2 s, 10 s, 60 s; three failures within 10 minutes stop retries until the next launch or a prefs toggle, and `notch.status` reports `failed` (Settings shows "The notch companion couldn't start." with **Try again**).
- **Crash**: `render-process-gone` on a notch view → the same backoff.
- **Renderer swap**: when `RendererHost` commits a new experience base for the main renderer, each notch view reloads `notchEntry(newBase)` (one version of the UI at a time); readiness again, the old window stays visible until the new document is ready (same `BaseWindow`, the view is reloaded, not recreated).
- **Disable** (`prefs.notch.enabled = false`): destroy every notch window, unregister the shortcut, sound owner → `main`.
- **Main window close / recreate**: macOS closing hides the main window (today) and the companion keeps running (canvas `TourNotch` "Close the window and your bots keep going"). Windows: the main window's real close (after the existing "Keep running in background" dialog) destroys the capsule first, so `window-all-closed` still fires and the app quits as today (F23). `recreateMainWindow` (density, Linux probe) never touches notch windows; `mainWindowLifecycle` counts only the main window.
- **Quit**: `before-quit` destroys notch windows and the haptics helper before other teardown (review class 2).
- **Audit**: every main use of `BaseWindow.getAllWindows()` / `getFocusedWindow()` is listed and filtered to exclude notch windows (R6-T29 greps `src/main` for them and asserts each call site filters by kind).

### 10.7 Haptics (`haptics.ts`, macOS)

PLAN's trick (openbot.run's idea; our own code): one long-lived `/usr/bin/osascript -l JavaScript` child with stdin piped and stdout/stderr ignored, running a JXA loop that reads a line and calls `NSHapticFeedbackManager.defaultPerformer`'s alignment pattern. `perform("alignment")` writes one line; throttled to one per 300 ms; spawned lazily on first use; on `error`/`exit` the reference clears and the next call respawns (at most 3 respawns per 10 minutes, then disabled for the session). `before-quit`: end stdin, `SIGTERM` after 500 ms if still alive. Triggers (from the renderer via `notch.haptic`): the body expanding into an approval or question, and each step through a multi-question prompt. Gated by `prefs.notch.haptics` and darwin. Haptics need a Force Touch trackpad under the finger; elsewhere they do nothing, which is fine.

### 10.8 Windows capsule (`geometry.ts` `capsulePlacement`, canvas `Notch` "Windows")

```ts
new BaseWindow({ type: "toolbar", show: false, frame: false, transparent: true, thickFrame: false, backgroundMaterial: "none",
                 resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false,
                 focusable: false, skipTaskbar: true, alwaysOnTop: true, backgroundColor: "#00000000", ...bounds });
win.setAlwaysOnTop(true, "pop-up-menu");
win.setIgnoreMouseEvents(true, { forward: true });                   // win32 supports forward (E:22197)
```

- `type: "toolbar"` keeps it out of Alt+Tab (Electron docs; unverified in typings, R6-T33). `setVisibleOnAllWorkspaces` does nothing on Windows (E:3605) and is not called.
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
  | { type: "sound-owner"; owner: "main" | "notch" }              // §14.2
  | { type: "shortcut" }                                          // §10.5
  | { type: "preview" };                                          // tour stop 12
export type OpenTarget =
  | { kind: "bot"; botId: string; sessionId?: string }            // forever chat or /bots/$botId/chats/$sessionId
  | { kind: "session"; sessionId: string }
  | { kind: "routine-run"; routineId: string; sessionId: string };
export interface NotchStatus {
  available: boolean;
  reason?: "platform" | "generation" | "disabled" | "failed";
  displays: number;
  shortcut: "registered" | "unavailable" | "off";
}

export const notch = {
  layout: query.input(NoInput).output(type<NotchLayout>()),                                       // notch window only
  events: subscription.input(NoInput).output(eventIterator(type<NotchEvent>())),                   // notch window only; coalescing by type (reaction: by sessionId)
  setShape: mutation.input(v.object({ width: v.number(), height: v.number(), visible: v.boolean(), audio: v.boolean() })).output(type<NotchLayout>()),   // notch only; resolves after a grow is applied; `audio`: its AudioContext is unlocked (§14.3)
  setInteractive: mutation.input(v.object({ interactive: v.boolean() })).output(type<void>()),    // notch only
  focus: mutation.input(v.object({ focus: v.boolean() })).output(type<void>()),                   // notch only
  haptic: mutation.input(v.object({ pattern: v.literal("alignment") })).output(type<void>()),     // notch only; no-op off darwin
  openInApp: mutation.input(OpenTargetSchema).output(type<void>()),                                // notch only: reveal + window.events { open }
  status: query.input(NoInput).output(type<NotchStatus>()),                                        // any window
  preview: mutation.input(NoInput).output(type<void>()),                                           // main window only (tour)
};
```

- **Guards**: `requireNotch(context)` → `FORBIDDEN { reason: "not-notch" }` unless `context.windowKind === "notch"`; `preview` uses the existing `requireMainRenderer`. Both are typed errors (spec 00 A.5).
- **Delivery**: `notch.events` is **coalescing** (spec 00 A.4.3) with key `type` (reactions keyed by `sessionId`): every event is a level or a harmless transient.
- **`window.events` additions** (main windows only): `{ type: "open"; target: OpenTarget }` (renderer-next's `OpenTargetBridge` global navigates: bot → `/bots/$botId` or `/bots/$botId/chats/$sessionId`, session → `/sessions/$sessionId`, routine run → `/routines/$routineId?run=`) and `{ type: "sound-owner"; owner }`.
- **Per-window main fixes (F3)**: `RpcWindows.state(id)` / `chrome(id)` return the state of the window that owns `id` (the notch's own `{ focused, fullScreen: false, maximized: false }`; `chrome` `null` → `window.chrome` answers `FORBIDDEN` for a notch caller); `publishToWindowViews` sends main-window state and chrome only to ids registered as `"main"`; `window.activity` from a notch id does not defer renderer swaps (a notch hover is not main-window activity). `system.events` stays broadcast (a notification click is handled only by the main renderer's bridge; the notch ignores it).
- **Reaction source**: `ai.send` accepted (`started`/`queued`) from a `windowKind: "main"` caller publishes `notch.events { reaction: "wink", sessionId }` (canvas "Send in the window → wink"); no renderer change.

---

## 11. The notch renderer (`notch.html`, `notch.tsx`, `features/notch/`)

### 11.1 Entry and build

- `apps/desktop/notch.html`: a copy of `index-next.html` (same CSP `<meta>` verbatim, `renderer-csp.ts` keeps them in sync), `<html class="dark notch" style="color-scheme: dark; background: transparent">`, `<script type="module" src="/src/renderer-next/notch.tsx">`.
- `vite.config.ts` (amendment to foundation §3.3): `rolldownOptions.input.notch = resolve(root, "notch.html")` (a third input; all three land at the root of `dist/renderer`, so experience bundles and `electron-builder.yml`'s `dist/**` carry it unchanged); a **second** `tanstackRouter({ routesDirectory: "./src/renderer-next/notch-routes", generatedRouteTree: "./src/renderer-next/notchRouteTree.gen.ts", routeFileIgnorePrefix: "-", autoCodeSplitting: false, quoteStyle: "double" })` before the React plugins (code splitting off: the notch is small and must paint its first state without chunk loads). The two instances keep separate contexts (sources table); that two trees build and hot-reload side by side is **unverified** until R6-T1 builds both in dev and production. The React Compiler instance already covers `src/renderer-next/**` (`NEXT_MODULES`).
- `knip.json` entries gain `notch.tsx` and `notch-routes/**/*.tsx`; `notchRouteTree.gen.ts` is ignored like the main tree; oxlint's `routes/**` default-export override is extended to `notch-routes/**`.
- **Boot** (`notch.tsx`), the foundation's order (§8.6) with notch specifics: styles (`app.css` + `features/notch/notch.css`); `applyTheme(document, "dark")` fixed (the hardware is black in both themes); `initI18n()`; `bootstrap()` with the same transport code (the preload answered with kind `"notch"`; main decides the kind); prefs, then `sessions` and `bots` preloaded; `changeLanguage(resolveLanguage(prefs.language))`; `createChatRuntime(transport)` (02 L170); `createNotchRouter(boot)`; render. Transport loss → the foundation's reload policy (main sees the reload through `did-navigate` and re-registers the port).
- **Readiness**: `NotchReadiness` (a sibling of the foundation's reporter, watching `prefs`, `sessions`, `bots`) calls `window.ready({ barrier: "subscriptions" })` once (§10.6).
- The notch document never mounts the devtools cockpit, the command menu, hotkeys provider bindings other than the notch's own (`Mod+Enter`, `Escape`, active only while focused), or any shell global.

### 11.2 Inputs (`inputs.ts`)

Levels come from tables, events from notices (review class 31: nothing is derived from collection inserts or coalesced diffs).

| Input | Source | Kind |
|---|---|---|
| Who waits, runs, errored | `sessionsCollection` rows: `id`, `owner`, `routineId`, `label`, `turn { phase, isBusy, updatedAt }` | level |
| Names, looks | `botsCollection` | level |
| Enabled, idle visibility, quiet hours, per-bot levels, reduce motion | `prefsCollection` (`notch.*`, `sounds.*`, `motion.reduce`) | level |
| Run outcomes (reply arrived, done, failed) | `sessions.events { run-finished }` (F4), one subscription per document, `lastEventId` resume within the document | event |
| Connector asks | `connectors.events()` keyless (03 §6.1: first yield `snapshot`) | level after snapshot |
| Descriptors (question vs approval, titles, allowed decisions) | the chat kit's thread store for the ≤ 2 sessions the notch holds (§11.3) | level |
| Main window visible/focused, sound owner, layout, reactions, shortcut, preview | `notch.events` | level / transient |

### 11.3 Which threads the notch holds

The notch calls `context.chat.session(id).load()` only for (a) the session the presentation is about to show in `/approval/$id` or `/reply/$id`, and (b) the next attention in line, so a click on "Allow" can move straight on. Everything else is known from rows: a waiting session counts as one "needs you" until its thread is held (03 §6.6's rule). Sessions it no longer shows are left to the kit's LRU (8, 02 §3.1); none is pinned by the notch except the one on screen. This bounds the notch to two live `ai.subscribe` streams however many bots wait (R6-T19).

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

- **Priority** (PLAN, F6): question > approval > connector-ask > failed > working > reply > done > idle; within a kind the oldest `since`/`at` first. Every session kind counts (F24): listed sessions, bot chats, check-in runs, routine runs.
- **Per-bot level** (`prefs.sounds.perBot`, 05 §22): `nothing` → that bot's sessions are left out entirely; `needs-me` → only question/approval/connector-ask for them. Sessions with no bot follow the global switches.
- **Expanded** only for question, approval and a fresh reply (6 s after it arrives, then it collapses to its wing until acknowledged), and while hovered (§11.6) or listening.
- **Calm** (canvas "Window focused → the companion calms to the idle wings"): while `app.mainFocused`, nothing expands; the route is `/idle` with the most urgent face and the count.
- **Quiet hours** (`isQuietNow`, 05 §22.4): `/idle` with the `asleep` face dimmed and "Until {end}"; nothing expands, no sound, the count grows.
- **Dwell and acknowledgement**: `done` shows for 5 s; `reply` and `failed` stay (collapsed) until acknowledged (opened, replied, dismissed), a newer run of the same session starts, or 10 minutes pass. Acknowledgements live in `notchUiStore.acks` (ephemeral, per document; keyed by run id). A duplicate notice for one run id counts once (a bounded `Set`, 500 ids, as 04 §19.1).
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

`NotchDirector` subscribes to the presentation and drives the router:

1. **Hover lock** (openbot.run's idea): while the pointer or focus is inside the shape, or the body is expanded, **and** the current route is critical (`/approval`, `/reply`, `/call`, or the window is focused), a presentation with a different `identity` is **queued** (`notchUiStore.queued`, latest wins), applied on pointer leave, blur or collapse.
2. **Load first**: for `/approval/$id` and `/reply/$id` it awaits `context.chat.session(id).load()` (the kit caps it at 5 s, 02 §3.2); a failure keeps the compact wing with **Open** instead of an empty body.
3. **Grow, navigate, shrink**: a larger shape → `await notch.setShape(next)` then `navigate({ to, params, search, replace: true })` with the transition type (§16); a smaller one → navigate, then `notch.setShape(next)` after the contract animation (450 ms); main adds its 700 ms settle (§10.2). `visible: false` hides the window (`hide()`), `true` shows it inactive.
4. **Hover intent**: a pointer resting 300 ms on a non-expanded shape opens the quick-actions body; leaving closes it after 100 ms (openbot.run's published timings).
5. **Shortcut** (`notch.events { shortcut }`): opens the most urgent approval/question or the newest reply with focus; with nothing to show, opens the quick actions of the most recent bot.
6. **Preview** (tour stop 12): wink + the idle wings for 3 s, even when idle is hidden.

### 11.7 Reactions (canvas `NotchRules` "Reacts to the app")

| Trigger | Source | Reaction (600 ms, 03 §14.2) |
|---|---|---|
| Send in the main window | `notch.events { reaction: "wink" }` (§10.10) | `wink` + caption "On it" (reaction shape) |
| A run finished `success` | `sessions.events { run-finished }` | `happy` then the `done` bounce |
| A run finished `error` | same | `error` (the shake) |
| Main window focused | `notch.events { app }` | calm (§11.4) |

Reactions play on the face of the session's bot in the wings; under reduced motion the face swaps without keyframes.

---

## 12. Flows in the notch (`features/notch/views/`)

### 12.1 Approval (`/approval/$id`, canvas `Notch` "Needs you")

- Rendered by the chat kit: `<PermissionList threadId={id} variant="notch" limit={1} />` (02 §6.2 "the notch mounts the same component"; the `variant` prop is amendment §23.2). One decision logic, one answering state, one set of labels.
- Wings: left = face (`waiting`) + bot or session name; right = "⌘↩" hint (only while focused) and **Not now**. Body: the descriptor's title (the kit's `decisionTitle`, e.g. "Send this from Gmail?"), one summary line (ellipsis), then pills.
- **Decisions offered in the notch** (the rest need the full card): the primary accept (`accept`, label by kind from the kit, e.g. "Allow", "Send", "Run"), `reject` ("Deny"), and **Review** (`notch.openInApp` to the chat). `allowAlways`, rules, `allowYolo`, `background`, `accept_with_message` are never shown here. **Safety rule**: the accept pill is shown only when the kit's summary of the request is complete (`permissionSummary(d).complete`, amendment §23.2); a truncated command, a diff or a long message shows only **Deny** and **Review** with "Too long to check here" (openbot.run hides Accept on truncated payloads; same idea).
- **Not now** snoozes that descriptor in this document (`notchUiStore.snoozed`, until a new descriptor arrives or 10 minutes), collapses the body and keeps it in the count. It sends nothing.
- Answering: `runtime.respondPermission(d, decision)` (02 §6.3): the pill shows the kit's answering state; `permission.resolved` + `pending` remove it and the presenter moves on; `permission.response_rejected` shows the kit's copy with **Review**; 10 s without resolution → "No response from the agent" + **Review**. A second window or the main window answering first makes the descriptor vanish (the kit's rule).
- Keyboard (only while focused): `Mod+Enter` = primary, `Escape` = Not now (canvas "⌘↩ and Esc"). Clicking pills needs no focus (`acceptFirstMouse`).
- `remaining > 0` shows "{n} more" on the right wing; the next item follows without collapsing.

### 12.2 Question (`/approval/$id` with `reason: "abacus:question"`)

- In the notch when every question in the descriptor is single-select, not secret, with 1–3 options (openbot.run's rule): each question as its label and option pills, one question at a time with a haptic per step; the answers are encoded by the kit's `encodeQuestionAnswers` (02 F19, byte-identical to the composer's questionnaire, amendment §23.2) and sent once as `{ type: "question_answers", answers }`.
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
- The Whisper pipeline in the notch document is disposed after 2 minutes idle; its memory cost is **unverified** (R6-T27 measures it).

### 12.6 Quick actions (hover, canvas `Notch` "Hovered")

For the leftmost face's bot: **Message** (its forever chat's reply view, focused), **Call** (reply + mic), **Pause** / **Resume** check-ins (`routinesCollection.update(checkInRoutineId, (d) => { d.enabled = next })` over `db.routines`, spec 00 B.2; the notch preloads the `routines` collection the first time the quick actions open, and the pill shows a pending state until the echo; a failure rolls back and shows "Couldn't pause check-ins" inline), **Open app** (`openInApp`). For a session face: **Open** only.

### 12.7 Open in app

`notch.openInApp(target)` → main reveals the main window (`revealMainWindow`, `index.ts:350-358`) and emits `window.events { open }`; the main renderer's `OpenTargetBridge` navigates (bot → `/bots/$botId` or `/bots/$botId/chats/$sessionId` for sender chats; session → `/sessions/$sessionId`; routine run → `/routines/$routineId?run=$sessionId`, F24). The notch collapses and marks the attention acknowledged.

---

## 13. OS notifications policy

1. **Silent** in the new generation (05 §31.5 d): the in-app cue is the sound.
2. **Kind**: `system.notify` input gains `kind?: "needs-you" | "received" | "done" | "failed"` (amendment §23.6); 03's cue watcher and 04's `features/sessions/notify.ts` pass it.
3. **Show in the notch** (canvas `SettingsNotifications`, F19): main drops a notification of kind `needs-you` or `received` when `prefs.notch.showInNotch` is on and at least one notch window is ready and not hidden by a full-screen space (the controller knows). `done` and `failed` still notify (the notch shows them for seconds only). Quiet hours and per-bot levels already gate everything before `system.notify` (05 §23.2).
4. The background "Task still running" notice (`index.ts:366-383`) is skipped while a notch window is ready (NT3).
5. Clicks are unchanged (`system.events { notification-clicked }`, spec 00 A.2.3).

---

## 14. Sound

### 14.1 Engine completion

The cue set and synthesis are 03 §17 and 05 §23.1; this phase fills one gap and adds the owner rule. `done`'s gain is unspecified in 03 §17: it is **0.08**, exponential release (same family). Values stay provisional and live once in `lib/sound.ts`.

### 14.2 One owner (`src/main/notch/sound-owner.ts`, F18)

```ts
soundOwner = notchReady && prefs.notch.enabled && !mainWindow.isFocused() ? "notch" : "main";
```

Main publishes it on `notch.events { sound-owner }` and `window.events { sound-owner }` whenever an input changes (focus, blur, readiness, prefs). Each document's player checks it for the **attention cues** (`needs-you`, `received`, `done`, `failed`): it plays them only when it is the owner. `sent` (always the focused main window) and `routine-fired` stay with the main document. Both players still apply the foundation gates (visible-and-focused thread, 400 ms coalescing), 05's `allowed` (quiet hours, per-bot level) and the per-cue switches. A cue whose trigger races a focus change may be decided by the old owner; at most one document plays it (each checks its own last-known owner; the two values are published in one main tick). R6-T22.

### 14.3 The notch player (`features/notch/sound.ts`)

`createSoundPlayer` with `isWindowFocused = () => false` (the notch never counts as "looking at it"), `isThreadVisible = () => false`, the shared `prefs().sounds`, and the owner check. Triggers: `needs-you` when a session enters `waiting_permission` (a level transition of the held presentation, not a table insert), `received`/`done`/`failed` from the run-finished notice (cancelled plays nothing; duplicates once). The `AudioContext` unlock needs a user gesture: the notch's first pointerdown unlocks it; until then the main document keeps the owner (main computes `notchReady` as "ready **and** audio unlocked", reported by `notch.setShape`'s `audio: boolean` field, so a locked notch never takes cues it cannot play). Haptics accompany `needs-you` when enabled (§10.7).

### 14.4 Per-bot level, quiet hours, preview

Unchanged from 05 §22–§23: the notch uses the same `allowed(kind, { botId, now, sounds })` and `isQuietNow`. Preview stays on the Settings page (main document).

---

## 15. Settings rows added (05's reserved rows)

| Page | Row (`data-setting-id`) | Control | Source / write | Notes |
|---|---|---|---|---|
| General | Notch companion (`notchCompanion`) | Switch; detail "Live status, replies and approvals from the notch" (macOS) / "…from a capsule by the clock" (Windows) | `prefs.notch.enabled` via `updatePrefs` | hidden when `notch.status().reason === "platform"`; failed start shows "The notch companion couldn't start." + **Try again** (toggles off/on) |
| General | Show when idle (`notchIdle`) | Switch, under the companion row | `prefs.notch.idleVisible` | only when enabled |
| General | On every display (`notchDisplays`) | Switch | `prefs.notch.extraDisplays` | macOS only |
| General | Haptics (`notchHaptics`) | Switch | `prefs.notch.haptics` | macOS only |
| General | Shortcut (`notchShortcut`) | read-only `Kbd` `⌘⇧Space` / `Ctrl+Shift+Space`, or "In use by another app" | `notch.status().shortcut` | 05 §21.3 lists it as not rebindable |
| General | Take the tour (`tour`) | secondary button **Take the tour** | `startTour({ origin })` (§9.5) | detail "Twelve stops, skip any time." (count from the stop list) |
| Notifications | Show in the notch (`showInNotch`) | Switch; "Replies and approvals appear in the notch companion, not as banners" | `prefs.notch.showInNotch` | only when the companion is available |

All rows join 05's `SETTINGS_INDEX` (05 R5-T24 checks both ways).

---

## 16. Motion

All values from `lib/motion.ts` via `motionFor`; reduced motion (the pref or `prefers-reduced-motion`) collapses every entry to a 120 ms fade and every layout or spring animation to a cut (foundation §7.8). Every `<ViewTransition>` prop is a type map with `default: "none"` (foundation §6.7). New constants go into `lib/motion.ts` once and are mirrored in CSS where CSS runs them (R6-T37 compares the two):

```ts
export const onboarding = { stepExit: 160, stepEnter: 320, stagger: 60, rise: 12, sharedElement: 420, shellScaleFrom: 0.98 } as const;
export const spotlight = { mask: { type: "spring", mass: 1, stiffness: 80, damping: 14 }, cardLag: 40 } as const;
export const hatch = { wobbleCycles: 3, wobbleMs: 220, squash: 0.9, pop: 1.08, settle: { type: "spring", stiffness: 420, damping: 18 }, confettiMs: 2400, confettiPieces: 7 } as const;
export const notch = { exit: 160, expand: 420, contract: 450, contentDelay: 120, blurPx: 4, settleMs: 700, hoverIntent: 300, hoverExit: 100, reaction: 600 } as const;   // easings.notch exists
export type NavType = /* foundation's */ | "onboarding-step" | "notch-expand" | "notch-contract" | "notch-swap";
```

| Moment | Owner | Spec |
|---|---|---|
| Step to step (onboarding) | React `<ViewTransition>` keyed by step in `_bare/onboarding.tsx`, type `onboarding-step` | old content up 12 px + fade 160 ms; new content rises 12 px + fades 320 ms, children staggered 60 ms (canvas `OnboardMotion`); the progress pill's active mark widens 300 ms, never jumps |
| Welcome parade → shell; done → bot chat | React `<ViewTransition name>`: the parade's centre avatar / the done step's bot avatar named `bot-identity-${botId}` (foundation's reserved name) meets the transcript header's avatar | 420 ms `cubic-bezier(.2,.8,.2,1)`; the shell fades in from scale 0.98 (a `::view-transition-new(root)` rule keyed on `nav-forward` from `_bare`) |
| Hatch | `BotAvatar` `hatch` prop: CSS keyframes (wobble, squash) + `motion` spring (pop, settle) | §8.2; reduced → 120 ms cross-fade |
| Confetti | CSS keyframes, seven pieces, 2.4 s, once | skipped when reduced |
| Waiting states | one spinner per screen; the avatar's `waiting` face carries the rest (canvas) | — |
| Spotlight mask | `motion` on one element's `x/y/width/height` with `spotlight.mask` | card follows `cardLag` 40 ms; reduced → the mask cuts, the card fades |
| Notch shape grow / shrink | CSS `transition: width, height` on the shape: grow `notch.expand` 420 ms, shrink `notch.contract` 450 ms, `cubic-bezier(.22,1,.36,1)` (`easings.notch`) | PLAN values (F15); content fades in `contentDelay` 120 ms after the shape settles (canvas) |
| Notch content swap | `<ViewTransition>` around the body/wing content with types `notch-expand` / `notch-contract` / `notch-swap` | exit 160 ms fade + blur 4 px + scale 0.985; enter fade + blur 4 → 0 + scale 0.965 → 1 over 420 (growing) / 450 (shrinking) / 240 ms (same size) (openbot.run's published values, PLAN) |
| Face reactions, moods | `BotAvatar` (03 §14.2) | 600 ms reactions; static under reduced motion |
| Listening waveform | CSS keyframes per bar (canvas `nb-wave` 0.9 s) driven by the recorder level | static bars at the current level when reduced |

The notch document wraps its tree in `<MotionConfig reducedMotion="user">` plus the prefs override (`motionFor`), so `motion` respects both. Reduced motion in the notch: shape size changes **snap** (no transition), content cross-fades 120 ms.

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
| R6-T3 | `routes/phase6.preload.test.ts` | jsdom (memory transport) | No onboarding loader calls `auth.abacus.start`, `auth.openRouter.start`, `connectors.connect*`, `db.bots.insert` or any mutation; `browserProfiles` is fetched only on `welcome`; cold direct navigation to each step with delayed snapshots renders the step (loaders await their own preload). |
| R6-T4 | `features/onboarding/machine.test.ts` | jsdom | Every §6.1 row × `FlowFacts` (signed in/out, paying tier, owns bot); `guardStep` for each unreachable combination. |
| R6-T5 | `features/onboarding/resume.test.ts` | jsdom (fake tables) | `resumeStep` table for new ids, legacy ids and garbage; entering a step writes `updatePrefs({ onboardingStep })` as a patch (same-value writes still sent); a restart during `connect` resumes at `welcome`. |
| R6-T6 | `features/onboarding/complete.test.ts` | jsdom (memory transport) | `completeOnboarding` order: `account.skipOnboarding`, then `onboardingStep: null`, then funnel; a failing first call stops the rest and shows the retry toast; the queued messaging platform becomes the navigation target. |
| R6-T7 | `features/onboarding/steps/sign-in.test.tsx` | jsdom (fake procedures) | Sign up / sign in / profile each call `auth.abacus.start` with the right input exactly once (double click ignored); outcomes: ok → `connected` + invalidations; cancelled → `welcome` silently; `unidentified-account` parity copy; other codes the generic line; Use my browser, Sign in another way, Skip each call the right procedure; no error message is parsed. |
| R6-T8 | `features/onboarding/steps/models-connectors.test.tsx` | jsdom (fake procedures) | Models rows per state, OpenRouter hop and cancel on leave, key dialog validation (`isPlausibleApiKey` cases) and save, local-model row states; connectors grid ids all exist in the registry, `not-offered` hidden, many more, connect via the passed flow, a hop cancelled on leaving the step, messaging queued not navigated; button label by connected count. |
| R6-T9 | `features/onboarding/steps/first-bot.test.tsx` | jsdom (fake tables + fake procedures) | Creates once per document (remount reuses), skips with `has_bots` / `no_template` / `create_failed` and the funnel detail; Say hello keeps; Start from scratch deletes then `done`; Take the tour completes then starts the tour after navigation; bot removed elsewhere → the removed state. |
| R6-T10 | `features/onboarding/funnel.test.ts` | jsdom | Each step reports the parity funnel name (OB14) once per entry; no name outside `FUNNEL_STEPS` is ever sent (type + runtime). |
| R6-T11 | `components/spotlight/place-card.test.ts` | jsdom | `placeCard` picks right/left/bottom/top by space, clamps to 16 px and below the title bar, centres for a null rect; at 800 × 600 every stop's fixture rect yields an on-screen card. |
| R6-T12 | `components/spotlight/spotlight.test.tsx` | jsdom | Mask and card render; the card follows 40 ms after the mask (motion values from `lib/motion.ts`); the shell is `inert` while open and restored; focus on Next each stop, returned on end; Escape = skip; overlay click ignored; reduced motion → cut; `data-slot="tour-spotlight"` is in `OCCLUDER_SLOTS` and the no-drag selector. |
| R6-T13 | `features/onboarding/tour/tour.test.tsx` | jsdom (memory transport + fake tables) | Stop list 12 with the notch, 11 without (status unavailable); `prepare` navigations with inferred types; `waitForAnchor` resolves on a late-mounted element, returns null after 2 s and the stop becomes a centred card; Next/Back await `prepare`; finish → `status: "done"` + `tour_done` + back to origin; skip → `skipped`; `tourSignedOut` ends without status; replay from Settings and the command menu; not startable before onboarding. |
| R6-T14 | `lib/tour/anchors.placement.test.tsx` | jsdom | Rendering the shell and each page places every `TOUR_ANCHORS` id exactly once at the owner in §9.2 (fails when an owner drops one). |
| R6-T15 | `features/notch/inputs.test.ts` | jsdom (fake tables + fake iterators) | Levels from rows, outcomes only from the run-finished notice (a sessions batch that goes busy → idle produces no reply/done); duplicate run ids once; `cancelled` nothing; connector asks after the keyless snapshot. |
| R6-T16 | `features/notch/presenter.test.ts` | jsdom | `presentNotch` table: priority order and oldest-first; every session kind including routine runs (F24); per-bot `nothing`/`needs-me`; calm while main focused; quiet hours; dwell (done 5 s, reply 6 s expanded then collapsed, failed until ack/new run/10 min); hidden rules; faces ≤ 3 most urgent leftmost; `remaining`; identity strings. |
| R6-T17 | `features/notch/director.test.tsx` | jsdom (memory transport) | Hover lock queues a different identity on a critical route and applies it on leave; loads the thread before navigating to approval/reply and falls back to the wing when `load()` fails; grow calls `setShape` before navigating, shrink after; hover intent 300 / 100 ms; shortcut and preview behaviours. |
| R6-T18 | `features/notch/views/approval.test.tsx` | jsdom (chat fixtures) | `PermissionList variant="notch"` shows one descriptor with only accept/deny/review; truncated summary hides accept; Not now snoozes locally and sends nothing; answer → `ai.respondPermission` with the kit's lineage; answered elsewhere → it disappears; `response_rejected` and 10 s timeout copy; `Mod+Enter` / Escape only while focused; question: 1–3 single options step through and send `encodeQuestionAnswers` output byte-identical to the composer's; others → Answer in app. |
| R6-T19 | `features/notch/threads.test.ts` | jsdom (memory transport) | With 20 waiting sessions the notch holds at most two `ai.subscribe` streams; moving on releases the pin. |
| R6-T20 | `features/notch/views/reply.test.tsx` | jsdom (chat fixtures) | Plain-text last assistant message (markdown and tool parts not rendered); field only for forever chats; click → `notch.focus(true)`; Enter → `session.submit` once; `queued`/`started` clear + wink; `rejected` keeps text; draft survives collapse; Escape unfocuses. |
| R6-T21 | `features/notch/views/listening.test.tsx` + `lib/voice/*.test.ts` | jsdom (fake recorder) | Ported dictation tests (recorder, whisper loader, use-dictation) against contract procedures; listening view timer, End → transcript into the draft, never sent automatically; mic refused and failure copy. |
| R6-T22 | `main/notch/sound-owner.test.ts` + `features/notch/sound.test.ts` | main + jsdom | Owner flips on focus/blur/readiness/audio unlock/prefs and is published to both windows in one tick; each document plays attention cues only when owner; `sent`/`routine-fired` stay main; a locked notch never owns; `done` gain 0.08 schedules audible output (`OfflineAudioContext`). |
| R6-T23 | `main/notch/geometry.test.ts` | main | `notchPlacement` for notch/plain modes, window = shape + margins, top at `bounds.y`, centred; clamp to max; `capsulePlacement` for bottom/top/left/right/auto-hidden taskbars and mixed scale factors; `metricsFromProbe` and the DIP/points origin conversion with a primary and a secondary screen above/left; `inferNotchMetrics` ratio window. |
| R6-T24 | `main/notch/metrics.test.ts` | main | The probe with a fake `execFile`: success JSON, timeout, non-zero exit, garbage, macOS < 12 nils → fallback; cache keying; `ABACUSBOT_NOTCH_METRICS` honoured only unpackaged. |
| R6-T25 | `main/notch/controller.test.ts` | main (fake `BaseWindow`/`WebContentsView`/`screen`/`powerMonitor` recording calls) | Generation gate (legacy creates nothing), platform gate, start after main readiness; targets per `extraDisplays`; reconcile on each screen/power event (debounced, serialised, a throwing reconcile keeps windows); layout pushed without reload; readiness timeout → backoff 2/10/60 s and give-up after 3; crash backoff; renderer swap reloads each view on the new base; disable destroys all and unregisters the shortcut; `before-quit` order; win32 main close destroys the capsule so `window-all-closed` fires; `recreateMainWindow` leaves notch windows alone. |
| R6-T26 | `main/notch/interaction.test.ts` + `haptics.test.ts` | main | Passive/interactive/focused transitions call `setIgnoreMouseEvents`/`setFocusable`/`blur` as the §10.5 table says; the grow-now/shrink-after-700 ms settle, cancelled by a grow or interaction, re-reading geometry; global shortcut register/`unavailable`/unregister; haptics helper throttle 300 ms, respawn limit, quit teardown, darwin only. |
| R6-T27 | `e2e/notch-voice.mjs` | Electron (macOS runner) | The notch document loads `@huggingface/transformers` under the notch CSP and transcribes a bundled 2 s WAV fixture through the fake microphone (Chromium `--use-fake-device-for-media-stream --use-file-for-fake-audio-capture`); records the process memory before, during and 2 min after (disposal) in the run log (decides §12.5's claim). |
| R6-T28 | `main/rpc/notch-procedures.test.ts` | main (memory transport) | `requireNotch` on every notch-only procedure (`FORBIDDEN { reason: "not-notch" }` from a main caller) and `preview` main-only; `openInApp` validates targets and emits `window.events { open }` only to main ids; `window.state/chrome` answer per window (F3); `publishToWindowViews` skips notch ids; notch `window.activity` does not defer swaps; an accepted main `ai.send` emits the wink reaction; `system.notify` with `kind` is dropped per §13 and kept otherwise. |
| R6-T29 | `main/notch/audit.test.ts` | main | Every `getAllWindows`/`getFocusedWindow` call in `src/main` filters notch windows (AST scan); `wireNotchContents` is the only other `registerRendererContents` caller; the preload dispatcher gives a notch page no `window.api` (preload test with `additionalArguments`). |
| R6-T30 | `e2e/notch-window.mjs` | Electron (**macos-latest** runner, with `ABACUSBOT_NOTCH_METRICS=185x32`) | The real window: created as a panel (`type: "panel"`), never activates the app or shows the hidden main window when focused; `getBounds().y === display.bounds.y` (over the menu bar); click-through: a synthetic click outside the shape reaches a window underneath, inside it reaches the notch after `setInteractive`; hidden from Mission Control listing (`excludedFromShownWindowsMenu`); not drawn over a full-screen space (a second test window toggled full screen, then `isVisible()` / a screenshot of the space shows no notch) — **decides F2 and F16**; reloads on a renderer swap; destroyed on quit. |
| R6-T31 | `e2e/notch-hardware.mjs` (checklist driver) | hardware: a notched MacBook (14″ or 16″ Pro, or 13.6″/15.3″ Air), built-in display | Records the probe's JSON and the chosen metrics into `metrics.fixtures.json`; screenshots the top 150 px of the display in idle, working, approval, reply, listening and quiet; the reviewer checks nothing is drawn under the cut-out and the wings touch it; runs a real approval and reply against a fake provider; checks haptics fire on a Force Touch trackpad. Decides F1 on hardware. |
| R6-T32 | `e2e/notch-displays.mjs` | hardware: the same Mac with an external display | Plain capsule on the external display only with `extraDisplays`; unplug/replug and lid close/open reconcile without duplicates; moving the menu bar's primary display re-places. |
| R6-T33 | `e2e/notch-capsule.mjs` | Electron (**windows-latest** runner) + hardware once (Windows 11, taskbar bottom and left) | `type: "toolbar"` window absent from Alt+Tab (`EnumWindows` check through a PowerShell helper), always on top, transparent and click-through outside the pill, placed by the clock for each taskbar edge (the runner's bottom taskbar; other edges by the hardware run), grows upward; closing the main window for real destroys the capsule and the app quits. |
| R6-T34 | `lib/i18n/phase6.keys.test.ts` | jsdom | Every new `t()` key exists; keymap sources exist; retired list reasons; folds into 05's accounted-for gate. |
| R6-T35 | `features/{onboarding,notch}/gallery/a11y.test.tsx` + `contrast.phase6.test.ts` | jsdom | axe over each §19 section (one overlay at a time); tour dialog semantics; notch region, button names, announcements only while focused; computed contrast of notch text and pills on black ≥ 4.5:1, onboarding pills and progress marks ≥ 3:1 (graphics). |
| R6-T36 | `e2e/fresh-install.mjs` | Electron (macOS and Windows runners, fake Abacus auth server + fake provider) + recorded on hardware for the gate | Empty home → onboarding welcome → sign up (fake in-app window flow completes) → connected → models (add a key) → connectors (connect a credential connector) → first bot hatches → Take the tour → all stops to Start working → the bot chat; restart mid-way resumes at the right step; the notch appears (macOS/Windows) and shows an approval raised by the fake provider, answered from the notch; the transcript shows the answer. |
| R6-T37 | `lib/motion.phase6.test.ts` + `motion.types.test.ts` | jsdom + type | New motion constants equal the CSS mirrors; reduced motion paths (step fades, spotlight cut, hatch cross-fade, confetti skipped, notch snap); `motion/react` imports type-check against 13.4.6. |
| R6-T38 | `features/{onboarding,notch}/structure.test.ts` | jsdom | §4 folder rules, including "the notch tree imports no `features/shell` and no `lib/window-chrome`". |
| R6-T39 | `guards.phase6.test.ts` (extends R1-T15) | jsdom | No `react-tourlight`, `tsparticles`, `canvas-confetti`, `electron` import; no parsing of error messages; no `window.api`; notch code never calls `ai.send` directly (only `session.submit`) nor `agent.respondPermission`. |
| R6-T40 | `features/{onboarding,notch}/parity.test.ts` | jsdom | Every §2 row names an existing route, component or test id and has a status. |

---

## 21. Scaffold order

Each step is a commit on `rewrite/06-onboarding-tour-notch`, stacked on the phase 5 branch.

1. Contract and main plumbing: `shared/contract/notch.ts`, `window.events { open, sound-owner }`, `system.notify { kind }`, prefs leaves (`notch.*`, `tour.*`), per-window deps (F3), `requireNotch`, the preload dispatcher; R6-T28, R6-T29 (preload half).
2. Main notch: `metrics`, `geometry`, `window`, `interaction`, `haptics`, `sound-owner`, `controller` with all gates and lifecycle; R6-T22 (main), R6-T23 … R6-T26.
3. Dependencies landed by other phases: the run-finished notice (§23.4) and `createBotFromTemplate` (§23.3) must be merged; `lib/attention` move; chat kit exports and `PermissionList variant` (§23.2).
4. Build: `notch.html`, the third input, the second router plugin, `notch.tsx` boot, notch router; R6-T1.
5. Notch renderer: inputs, presenter, director, shell and shapes, views, reactions, sound; R6-T15 … R6-T20, R6-T22 (renderer).
6. `lib/voice` port + composer `Dictate` wiring + listening view; R6-T21, R6-T27.
7. Onboarding: machine, gate, resume, actions, frame, steps, first bot, hatch, confetti; R6-T2 … R6-T10.
8. Tour: anchors placed by their owners, spotlight, stops, host, Settings rows and command menu entry; R6-T11 … R6-T14.
9. Settings rows (§15), OS notification policy (§13).
10. Motion constants and CSS; R6-T37. i18n + keymap + retired list; gallery; screenshots; R6-T34, R6-T35, R6-T38 … R6-T40.
11. Electron and hardware runs: R6-T30, R6-T33 in CI; R6-T31, R6-T32, R6-T36 recorded; `PROGRESS.md`.

---

## 22. Acceptance

**Build and rules**
- [ ] `typecheck`, `lint`, `format:check`, `check:knip-next`, `check:i18n`, `check:locales`, `test:unit` green; R6-T1 … R6-T40 pass; R6-T30 green on `macos-latest`, R6-T33 on `windows-latest`, with no silently skipped Electron test.
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

1. **Foundation (01) and its implementation.** (a) §3.3: `notch.html` as a third input; a second `tanstackRouter` instance for `notch-routes/`; knip and oxlint entries (§11.1). (b) §6.1: `_bare/onboarding.tsx` layout (account gate), `onboarding.index` resumes; `_shell.tsx` `beforeLoad` gate (§5.2); `bootstrap()` seeds `accountStateQuery` (fourth step, 2 s, fail-open). (c) §6.7: `NavType` gains `onboarding-step`, `notch-expand`, `notch-contract`, `notch-swap` (each with its `default: "none"` type map). (d) §7.2/§7.4: `tourAnchor` on the Rail (`rail-bots-sessions` wrapper, `rail-library`, `rail-artifacts`) and `TopBar.PanelTabs` (`topbar-panel-tabs`). (e) §7.6: `tour-spotlight` in `OCCLUDER_SLOTS` (a non-registry slot; R1-T9's registry classification is unaffected). (f) §7.9: command menu item "Take the tour". (g) `features/shell/sidebars.ts` `globals`: `TourHost`, `OpenTargetBridge`. (h) `lib/sound.ts`: the owner check and `done` gain 0.08 (§14).
2. **Chat kit (02).** `ChatViewProps.notchEnabled?: boolean` (F20; the route passes `notch.status().available && prefs.notch.enabled`); `PermissionList` gains `variant: "chat" | "notch"` and `limit?: number`, the notch variant offering only accept/deny/review with the completeness rule (§12.1); exports from `features/chat/index.ts`: `useThreadStore` (read-only selectors), `encodeQuestionAnswers`, `permissionSummary`, `decisionTitle`, `runErrorCopy`, `messagePlainText`; the composer's `Dictate` slot is wired to `lib/voice` (F7).
3. **Bots (03).** Define `createBotFromTemplate(templateId, overrides?)` in the §6.4 table (F21): client id, `db.bots.insert`, `isPersisted`, the template's check-in created as §9.4 does, returns the row; `NOT_FOUND { entity: "bot-template" }` for an unknown id. `BotAvatar` gains `hatch?: { from: "egg"; onDone(): void }` (§8.2). `features/bots/data/attention.ts` moves to `lib/attention/` and `features/bots` re-exports it (F22). The sidebar's `threadActivity` accessor stays. 03's cue watcher passes `kind` to `system.notify` (§13).
4. **Sessions (04).** The run-finished notice (F4): **one** notice, named `sessions.events { type: "run-finished" }` as 04 says, **with 03 r3's semantics**: published by the relay at the authoritative run terminal (never from compat `turn_complete`, which fires between tool rounds), payload `{ sessionId, threadId, runId, outcome, errorCode?, hasVisibleAssistantText, owner, routineId, at }`, lossless-actionable with `lastEventId` resume; 03's `ai.runFinished` name is dropped in favour of it. `sessionAttention` moves to `lib/attention/` (F22). `features/sessions/notify.ts` passes `kind` (§13). Anchors: `sessions-sidebar`, `new-session-composer`, `panel-changes`.
5. **Routines/Settings (05).** Prefs (main contract): new group `notch: { enabled: boolean; haptics: boolean; idleVisible: boolean; extraDisplays: boolean; showInNotch: boolean }` (defaults `true, true, true, false, true`) and group `tour: { status: "unseen" | "done" | "skipped"; at: number | null }` (default `unseen, null`); every member a leaf with its own provenance; `PrefsPatchSchema`, `PREFS_LEAVES`, `PREFS_GROUP_ENTRIES`, defaults and `DEFAULT_PREFS` updated; no legacy mapping. The General and Notifications rows of §15 replace 05's reserved placeholders; `tourSignedOut()` is now real; anchors `library-connectors`, `settings-memory`. 05's local-model row and `ProviderKeyDialog` are exported for the onboarding route (§7.5).
6. **Main contract and services (00).** `notch.*` group (§10.10); `window.events { open, sound-owner }`; `system.notify` input `kind?`; per-window `RpcWindows.state/chrome`, kind-filtered `publishToWindowViews`, notch `window.activity` excluded from swap deferral (F3); `wireNotchContents` as the second trust point (A.4.2's rule amended); `NOTCH_ENTRY` in `renderer-entry.ts`; the preload dispatcher; `ai.send` from a main caller publishes the wink reaction.
7. **PLAN.md.** Notch window: `BaseWindow` + `WebContentsView` (not `BrowserWindow`); metrics from a JXA probe with inference fallback (`node-mac-notch` does not exist); `visibleOnFullScreen: false`; one sound owner; routes as §5.4. Libraries table: `node-mac-notch` row → "does not exist; JXA probe". Motion: the canvas `NotchRules` 350 ms is a design follow-up (PLAN's values stand). Onboarding: "Skip for now" (no forced sign-in) recorded as a decision. Tour: completion persisted as `prefs.tour`. Areas: dictation audio is phase 6's (`lib/voice`).
8. **Design canvas** (follow-ups, not blockers): `TourMap` stop 6 → Library › Connectors; `NotchRules` duration; `SettingsNotifications` "Play a sound — Uses your system notification sound" (05's in-app cues replace it); `Notch` "Retry" and "Summary ready · 2 files" (no data).

---

## 24. Risks, unverified claims, deferred items, review classes applied

### 24.1 Risks

| Risk | Mitigation |
|---|---|
| The JXA probe fails or is slow on some macOS versions | 3 s timeout, cached per display key, inference fallback; R6-T31 records real values and updates the inference constants |
| `type: "panel"` activates the app or shows the hidden main window on focus | focus only on demand (§10.5); R6-T30 decides; fallback: never focus, the reply field opens the main window's chat instead |
| The panel over the menu bar is pushed down by macOS window constraints (E:3287-3290 note) | `enableLargerThanScreen`; R6-T30 asserts `y`; fallback: shape drawn from the window's top with the notch gap still centred |
| Two notch documents plus the main one triple memory (chat kit, collections, Whisper) | two held threads per notch; Whisper lazy and disposed; `extraDisplays` off by default; R6-T27 measures |
| Windows: the capsule stays over full-screen apps | documented difference; the companion can be switched off; revisit with a foreground-window check later |
| Duplicate or missing sounds when focus flips during a cue | one owner published by main in one tick; R6-T22 |
| Onboarding no longer forces Abacus sign-in (F9) | canvas decision recorded in PLAN (§23.7); the app works with own keys or a local model; Settings › Account offers sign-in |
| A new user with no sessions sees tour stops 8–9 as centred cards | expected; the copy stands alone; the stops are marked optional in spirit (9 is "Optional") |
| The run-finished notice lands late (owned by 03/04 main work) | scaffold step 3 blocks on it; no fallback derived from table diffs (review class 31) |
| A notch window registered as trusted widens the RPC surface | notch-only procedures guarded, main-only ones already guarded (`requireMainRenderer`), the notch preload exposes nothing else; R6-T28/T29 |

### 24.2 Unverified claims (each has a test that decides it)

`type: "panel"` / `"toolbar"` behaviour (R6-T30, R6-T33); window at `display.bounds.y` over the menu bar (R6-T30); `visibleOnFullScreen: false` hides it on other apps' full-screen spaces (R6-T30); the JXA probe's fields and values on notched hardware (R6-T31); the inference constants (R6-T31); two `tanstackRouter` instances building and hot-reloading side by side (R6-T1); `@huggingface/transformers` under the notch CSP and its memory (R6-T27); `motion` 13.4.6 typings for the new uses (R6-T37); haptics through `osascript` on current macOS (R6-T31 checklist); Alt+Tab exclusion for `toolbar` windows (R6-T33).

### 24.3 Deferred or not built

Calls (03 F12); browser take-over in the notch (F6); **Retry** of a failed run (F17); "Summary ready · 2 files" result lines (no data); the capsule on extra Windows displays; a notch on Linux (PLAN); menu-bar/tray item and dock badge (05 F11); "Edit" of an approval inside the notch (Review opens the chat); `allowAlways`/rules/`allowYolo` from the notch (full card only); canvas per-bot "Digest only"/"Mentions" (05 F12); a real-time progress figure for the working ring (no data).

### 24.4 Review defect classes applied

Every library and API claim cites the installed `.d.ts`/`package.json` or is listed in §24.2 (classes 25, 1–2: F1, F2, the router plugin, `setSinkId` absence noted so no player relies on it); new-generation machinery is gated on `RENDERER_GENERATION === "wco"` and dev hooks on `!app.isPackaged` (3, 4); no import-time side effects in `src/main/notch/*` (the controller is constructed in `app.whenReady`) (5); platform APIs used only where their typings say (`setVisibleOnAllWorkspaces` darwin, `forward` darwin/win32, `setFocusable` semantics) (6, 8); `toHotkeyPlatform` reused, never a Node platform string in hotkeys (7); ports: the notch's port lifecycle is the transport's (closed on committed navigation, one per webContents) and its window is created before destroy on reloads (1, 9); window-state events filtered by kind (10); readiness for a second document with a timeout and a give-up (11); iterators end on window destroy and notices dedupe by run id (13, 17); timers (settle, hover, dwell, backoff) are cancelled on destroy/unmount and never poll while hidden (15); events from notices, levels from tables, never cues from inserts or coalesced diffs (31); irreversible actions (approvals) through the lossless kit path, never an advisory notice (32); prefs as patches with leaf provenance (33); one data layer (`#next/data/db`) and one state home per fact (tour run state ephemeral, completion in prefs) (34); forms parse on submit (the key dialog is 05's) (35); typed errors only, no message parsing (36); every parity row has a status and an owner for each change (37); tests run through real collections, router, transport and Electron, with hardware runs where a VM cannot tell (38, 24); computed contrast (42); cross-spec drift called out and resolved in §23 (the run-finished notice, `createBotFromTemplate`, `notchEnabled`) (44).
