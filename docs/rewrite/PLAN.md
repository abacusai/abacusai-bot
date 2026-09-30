<!-- Generated from the design plan page https://claude.ai/artifact/WCbv9jobJ8QLXbzVtMTqZD (rev 6). Canvas: https://claude.ai/artifact/XpL2PgWae6rUjXDTWyUqYX -->
Renderer Rewrite Plan

AbacusAI Bot · apps/desktop + packages/agentPlan, no code yet30 Sep 2026 · rev 6Design canvas: 84 boards, 11 pages
# Renderer Rewrite Plan

A from-scratch front end and a protocol change underneath it: `packages/agent` emits **AG-UI** straight from pi’s session events through a thin adapter, main is a transport-agnostic relay (oRPC over an Electron MessagePort now, WebSocket for a future `abacusai-bot web`), and the React 19.3 front end is file-routed TanStack Router, TanStack DB collections over IPC, shadcn `base-mira` atoms, TanStack AI’s chat UI kit skinned with the registry chat components, React view transitions, and `motion` only where the browser can’t. Facts below come from the current source and from six cloned reference repos (listed at the end).

## Decisions

- **Protocol** — Wire change only. `packages/agent` keeps its behaviour (pi-coding-agent SDK sessions, extensions, permission gate, sandbox, bot loop, retry/routing, OpenLLM rotation, reply extraction); the NDJSON host and `DesktopEvent` vocabulary are replaced by an AG-UI emitter + AG-UI run input. Vendors pi-acp’s MIT helpers. ACP server mode is a later optional presenter.

- **Transport** — oRPC: one typed contract, `RPCHandler` over Electron `MessagePortMain` today and WebSocket for the web mode; event-iterator procedures carry the AG-UI stream with `lastEventId` resume; `@orpc/tanstack-query` feeds Query and the DB collections. `window.api` goes away.

- **Window chrome** — Electron Window Controls Overlay on macOS, Windows and Linux (`titleBarStyle: "hidden"` + `titleBarOverlay`, Linux via PR #41769); layout reads `env(titlebar-area-*)` and `navigator.windowControlsOverlay`, so OS, window manager and DE decide the geometry. No hard-coded insets or heights. Electron bumped to 44.x (PR #53639 forwards overlay geometry to WebContentsViews).

- **UI base** — shadcn CLI, `base-mira` on `@base-ui/react`, lucide icons (the preset default is hugeicons; we override). `ui/` is registry output, never hand-edited.

- **Chat UI** — `createChatUI()` from `@tanstack/ai-react/ui` (Messages/Message/Part/Interrupts/Queue/Subagents dispatchers) skinned with registry `message-scroller`, `message`, `bubble`, `attachment`, `marker`, `questionnaire`.

- **Routing** — File-based via `@tanstack/router-plugin`; hash history in the main window, memory history in the notch window; pathless layouts and groups by file name; pop-ups are masked child routes.

- **Motion** — React 19.3 `<ViewTransition>` + `addTransitionType` own every view transition (router `defaultViewTransition` stays off: the two would fight). `motion/react` for springs, drag, layout, presence.

- **State** — URL (valibot search schemas) → TanStack Query → TanStack DB collections with a custom IPC `sync` → TanStack Store for ephemeral UI. zustand removed.

- **Persistence** — Main keeps JSON stores under `~/.abacusai-bot`; collections mirror them. No SQLite adapter. One-time versioned migration.

- **Theme** — Light, dark, system. shadcn is `.dark`-class only, so a prefs collection drives `.dark` + `color-scheme` on `<html>` and `nativeTheme` in main.

- **Library vs Settings** — New rail item **Library**: connectors, messaging, MCP servers, skills, tools. Settings keeps only settings. Artifacts stays its own rail item.

- **Bot model** — Persistent choice in Details and a chip in the focused composer; one element morphing between them (`layoutId`).

- **Math** — `temml` (LaTeX → MathML Core, MIT, 351★) replaces KaTeX; math renders only once an expression is closed while streaming.

- **Notch** — macOS window hugging the notch (openbot.run’s window recipe; `node-mac-notch` optional); Windows capsule by the clock; Linux out for now.

- **Editing / sound** — No in-app editor: “Open in editor” only. Sound cues synthesised in WebAudio to start.

- **Sound** — Own cue set (send, receive, needs-you, done, failed), synthesised or licensed; per-event and per-bot switches; quiet hours; coalesced; silent while the thread is visible and focused.

- **Strategy** — Fresh renderer on a long-lived branch, stacked PRs by area, old tree deleted at parity; before/after screenshots against the canvas on every PR; parity checklist generated from `preload/bridge.ts`.

- **Structure** — `ui/` atoms · `components/` molecules · `features/<area>/` organisms, hooks, collections · `routes/` compose only. Shared primitives stay under the renderer.

- **Nuked** — zustand, framer-motion, react-tourlight, tsparticles, uuid, dicebear, monaco, katex, @lobehub icons, @aceternity registry, the legacy dialog wrapper, hand-rolled tabs/menus/listboxes, `?view=` redirects, `staticData.titleKey/backTo`, the 9.1k-line conversation layer.

- **Small libraries** — Typed + ESM; alpha/beta fine if maintained in the last 90 days; TanStack/shadcn first when equivalent.

## Stack and upgrades

| Package | Today | Target (verified in the cloned repos) | Note |
|---|---|---|---|
| react, react-dom | 19.2.8 | **19.3.x** | Stable `<ViewTransition>`, `<Activity>`, Fragment refs. |
| @tanstack/react-router | 1.170.31, code-based | 1.170.40+, `@tanstack/router-plugin` 1.168+, `react-router-devtools` | File routes; `validateSearch` takes valibot directly (no adapter needed). |
| @tanstack/react-query | 5.101.4 | latest 5.x | Non-collection reads and mutations. |
| @tanstack/db, @tanstack/react-db | — | 0.9.2 / 0.4.1 (0.10.0 / 0.4.2 once published; spec 01 F2) | Custom `sync` over IPC; plain `createCollection` singletons (DbClient is for SSR). |
| @tanstack/ai-react, ai-client, ai | — | 0.29.3 / 0.36.0 / 0.63.0 | Client is browser-safe; main runs `chat()`. |
| @earendil-works/pi-coding-agent (SDK, headless) | 0.85.1 | **0.99.x** | We use its session/extension runtime, not its TUI. Bump for the positives (`ctx.executeTool`, `builtin:mcp` available, settle/turn boundaries, virtual models) but adopt a feature only where it does not change today’s behaviour. `pi-agent-core` alone would force re-implementing sessions, compaction and extensions. |
| @orpc/server, @orpc/client, @orpc/contract, @orpc/tanstack-query | — | latest | Typed transport: MessagePort (Electron) and WebSocket adapters; event iterators for streams. |
| @tanstack/ai-acp (optional, later) | — | — | Only if we mount Claude Code/Codex/ACP agents as alternative engines in main. |
| @tanstack/react-store | 0.11.1 | latest | Ephemeral UI state. |
| @tanstack/react-virtual | — | 3.x | Long transcripts (on the message-scroller viewport ref, per its docs), artifacts grid, logs. |
| @tanstack/markdown, @tanstack/highlight | 0.0.13 / 0.0.10 | latest | Used by TanStack AI’s `TextPart` too; highlight replaces Monaco for read-only views. |
| @tanstack/react-form, react-pacer, react-devtools, react-hotkeys | form 1.33 | latest | Forms; debounce/queue; dev cockpit; typed shortcuts. |
| valibot | — | 1.x | Search params, forms, IPC payload guards. |
| motion | framer-motion 12.43 | `motion` 13.x (`motion/react`; spec 01 F8) | Layout, drag, springs, presence. |
| shadcn, @shadcn/react, @shadcn/helpers | 4.19 / 0.3 / — | latest | Registry chat parts; `@shadcn/react` needs React ≥19; helpers for scripted chat fixtures (pins ai-client 0.20 — verify against 0.36). |
| @base-ui/react | 1.7.0 | 1.6+ (registry decides) | Never imported outside `ui/`. |
| tailwindcss, @tailwindcss/vite | 4.3.3 | latest 4.x | `shadcn/tailwind.css` brings `scroll-fade-*` and `shimmer-*` utilities. |
| temml | katex | latest | Math as MathML Core; 10 KB font minimum. |
| react-resizable-panels, i18next, ghostty-web, @pierre/trees, lucide-react | present | keep | Panels, 11 locales, terminal engine, file tree, icons. Toasts are the registry `toast` (Base UI), not sonner (spec 01 F6); `cn` and `cmdk` arrive with the registry (spec 01 §3.1). |
| electron | 43.4.1 | **44.4.x** | Window Controls Overlay on Linux; overlay geometry delivered to WebContentsViews (#53639); View Transitions; `type: "panel"` windows. |

## Architecture

```
packages/agent  (pi-coding-agent SDK, child process per session — behaviour unchanged)
├─ session.ts / bot-session.ts   as today: pi AgentSession + extensions, permission gate, sandbox, bot loop, retry/routing
├─ src/agui/host.ts              NEW  replaces host.ts NdjsonHost: reads AG-UI run input on stdin, writes AG-UI chunks on stdout
└─ src/agui/emit.ts              NEW  replaces protocol.ts DesktopEvent: the session's emit() calls become AG-UI chunks
                                      (text/reasoning/tool/step/subagent/state/custom; permissions → interrupts;
                                      RUN_FINISHED/RUN_ERROR guaranteed). Nothing else in the package changes.

apps/desktop main  (transport host, engine-agnostic)
├─ rpc/                          NEW  oRPC router (contract shared with the renderer): sessions, bots, routines, artifacts,
│                                     memory, workspaces, git, files, terminal, browser, settings, library…
│                                     ai.subscribe(threadId) → event iterator of AG-UI (replay ring + lastEventId resume)
│                                     ai.send(run) · db.snapshot/subscribe/mutate per table
├─ transports/                   NEW  electron-message-port (today) · websocket (abacusai-bot web, later)
├─ engines/                      pi child process (default); later TanStack chat({acpCompatible|claudeCodeText}) — same AG-UI out
├─ taps                          artifacts, messaging relay, routine settle, browser auto-allow read AG-UI
├─ notch window                  NEW
└─ unchanged: browser runtime, pty, connectors, settings stores

preload:  hands the renderer a MessagePort (ipcRenderer.postMessage) — nothing else exposed

renderer main window                       renderer notch window
├─ routes/ features/ components/ ui/       ├─ notch.html → NotchApp (memory history)
├─ data/transport  oRPC link (MessagePort | WebSocket)          ← shared
├─ data/ai         SubscribeConnectionAdapter over ai.subscribe/ai.send
├─ data/collections ipcCollectionOptions over db.*
└─ lib/  tokens · motion · sound · i18n · window-chrome (env(titlebar-area-*))
```

- **Chat:** the renderer implements `SubscribeConnectionAdapter` on top of two oRPC procedures: `subscribe()` iterates `ai.subscribe(threadId, lastEventId)` (replay ring, then live), `send()` calls `ai.send` with `runContext.threadId/runId/parentRunId/resume` so interrupts resume correctly. Every run ends in `RUN_FINISHED`/`RUN_ERROR` (the client hangs otherwise); the agent emitter guarantees it and main has a stall watchdog.
- **Transport:** one oRPC contract in `src/shared/contract.ts`; main mounts it on a MessagePort per window; the WebSocket adapter exists only to prove nothing is Electron-bound (a real web mode is out of scope). The renderer never imports Electron; platform facts (chrome insets, platform, versions) are procedures too.
- **Collections:** `ipcCollectionOptions({ table })` implements the DB `sync` contract: buffer change events, load snapshot (`begin/write/commit`), flush, `markReady`; a resent snapshot goes through `truncate()`. `onInsert/onUpdate/onDelete` call the existing mutation IPC and resolve on the echoed change.
- **Query:** settings, usage, connectors, MCP, models, device/browser/terminal status, git diffs. One query-options module per feature; the five ad-hoc keys disappear; the 393-line refresh map becomes an `eventType → queryKey` table.

## Protocol: AG-UI straight from pi

Today `session.ts` translates pi’s `AgentSessionEvent` into a bespoke NDJSON `DesktopEvent`, and the renderer keeps a second vocabulary on top. The inspection of pi 0.99 and pi-acp settled the shape: pi ships no ACP or AG-UI (its own RPC mode and an experimental CBOR/Chord protocol only); pi-acp is Bun-only, pinned to pi 0.75, stale, and lacks permissions, plan, elicitation, MCP and steering. ACP itself has no steering, no sub-sessions and unstable elicitation, so every feature we have would ride `_meta` anyway. Since the desktop is the only client, the thin layer is a direct **session → AG-UI** emitter; the renderer’s TanStack AI client consumes it unchanged, and main never parses it. This is a **faithful port of the wire**, not a rework of the agent: `AbacusBotSession`, `BotSession`, the permission gate, sandbox ops, delegation, continuations, OpenLLM rotation and the messaging reply extraction keep their logic; only what `emit()` writes and what stdin accepts change.

| pi AgentSessionEvent / our extension | AG-UI | Renderer |
|---|---|---|
| `agent_start` … `agent_end` / `agent_settled` | `RUN_STARTED` … `RUN_FINISHED{usage}`; failures `RUN_ERROR{code, actions}` | status, usage, error cards with actions (upgrade, switch model) |
| `message_update` text_delta / thinking_delta, `message_end` | `TEXT_MESSAGE_START/CONTENT/END` (real message ids), `REASONING_*` | `text`, `thinking` parts |
| `tool_execution_start/update/end` (+ pre-execution diff from the gate, terminal output) | `TOOL_CALL_START/ARGS/END`, streamed `TOOL_CALL_RESULT`; diff/terminal payloads in the result content | ToolLine + expanders (read/write/bash/browser) |
| permission gate (`tool_call` hook), 15 request kinds, 10 decisions | `approval-requested` CUSTOM + `RUN_FINISHED{interrupt}`; request kind and payload in the interrupt; decision + rules in `resolveInterrupt(approved, {payload})`; resumed run carries `resume` | inline approval on the tool, or the Interrupts slot; mirrored to the notch |
| mid-command sandbox asks (`sandbox_denied`, `network_host`) | same interrupt, attached to the running tool call id | composer-slot card (“the sandbox refused…”) |
| `ask_user_question` | generic interrupt (`defineInterrupt`) with the question schema | registry `questionnaire` |
| modes (Auto, Supervised, Auto-accept edits, Plan, Full access), `mode_changed` | `STATE_DELTA` + `forwardedProps.mode` on send | mode chip |
| todo tool | `STATE_SNAPSHOT/DELTA` (plan) | task card, “Tasks 2 of 4” |
| delegation / component tasks (nested `createAgentSession`), child tool forwarding | Per the AG-UI spec: `SubagentStarted{subagentRunId, name, description, parentToolCallId, parentMessageId, parentSubagentRunId?}`, every forwarded child event carries `subagentRunId` (the spec allows it on most events), then `SubagentFinished{subagentRunId, result, outcome}` or `SubagentError`. Nested delegation uses `parentSubagentRunId`. | TanStack’s `SubagentHandle` → sub-agent cards with status, messages, `stop()`; detail in a side-panel tab |
| steering / follow-up queue (`queue_update`) | client-side TanStack queue + `CUSTOM queue.steered/dequeued` | queue slot: steer, edit, cancel |
| host services (render_document, render_deck…) | AG-UI client tools (`clientTools` in run context; results via `addToolResult`) | renderer-side tool implementations |
| heartbeat, retry, notification, MCP status/logs, skills loaded, compaction | `CUSTOM` (tagged), `STEP_*` for retries, `compaction:*` as in TanStack’s own middleware | markers, banners, Library › MCP page |
| bot loop hidden turns, output sanitiser, `NO_REPLY` | emitter-side: hidden runs never leave the process; sanitised deltas; `CUSTOM bot.reply` for the messaging relay | — |

**Reuse vs override, as it is today and stays:** pi’s `read`, `write`, `edit`, `grep`/`find`/`ls` are reused (some wrapped); `bash` is overridden with our confined tool and sandbox `BashOperations`; extensions add `ast_edit`, `batch_edit`, `batch_file_read`, web tools, guardrails, budgets, spill, repairs, compaction pruner. None of that moves. **Not changing:** retry/routing and OpenLLM rotation (`continuePastRecoverableFailures`, `openllm.ts`), the messaging reply extraction (`<reply>` parsing stays where it is, now reading AG-UI text chunks and `RUN_FINISHED` as end of turn), MCP client, compaction anchor. **Taken from pi-acp (MIT)**: `buildToolTitle`, `toToolKind`, `formatToolContent`, stop-reason mapping.**Alternative engines later:** main’s `engines/` can also run TanStack `chat({ adapter: claudeCodeText | codexText | acpCompatible })`; they emit the same AG-UI, so nothing in the renderer changes.

## Where state lives

| State | Home | Why |
|---|---|---|
| Rail item, bot/session/routine id, side-panel tab, split vs full, settings page, open pop-up | URL: path + typed search params | Reload, back/forward, deep links; the notch can open the same location. |
| Sidebar pinned/collapsed, panel widths, theme, density, reduce-motion, sounds, last workspace | Prefs collection (one row, main-backed JSON) | Cross-window, cross-restart. |
| Sessions, bots, routines + runs, artifacts, memories, workspaces, git state, transcripts index | TanStack DB collections | Live queries with includes (bot → chats, routine → runs); optimistic create/rename/delete. |
| Settings pages, usage, connectors, MCP, models, statuses, diffs | TanStack Query | Request/response with invalidation. |
| Composer draft, floating sidebar, drag, avatar mood, spotlight step | TanStack Store | Ephemeral, high-frequency. |
| Messages of the open thread | TanStack AI chat client (hydrate on mount, joinRun for a live run) | Owned by the client; persisted by main’s `withPersistence`. |

**Rule:** no state in two places. Today `?panel=` is mirrored into zustand and the active workspace is pushed from route effects; the new routes carry `workspaceId` and read the URL only. Avatar mood and sidebar badge derive from one pure function (openbot.run’s `waiting > routine > working > unread`) so they never disagree.

## Route tree (file-based)

```
routes/
├─ __root.tsx                       providers, <Outlet/>, devtools, notFound
├─ _shell.tsx                       pathless: Rail + Sidebar slot + TopBar + Outlet; validateSearch: ShellSearch
│   ├─ _shell.index.tsx             "/"  → throw redirect({ to: "/bots/new" })
│   ├─ _shell.(bots)/               group: BotsSidebar
│   │   ├─ bots.new.tsx
│   │   ├─ bots.$botId.tsx          loader: bot + thread hydrate; search: { panel?, tab? }
│   │   ├─ bots.$botId.details.tsx  masked pop-up (createRouteMask → /bots/$botId)
│   │   └─ bots.$botId.edit.tsx
│   ├─ _shell.(sessions)/           group: SessionsSidebar
│   │   ├─ sessions.new.tsx         search: { workspace?: id }
│   │   ├─ sessions.$sessionId.tsx  search: { view: "split"|"full", tab?: "changes"|"terminal"|"files"|"browser", agent?: id }
│   │   └─ sessions.$sessionId.review.tsx
│   ├─ _shell.(routines)/           routines.index · routines.$routineId (search: { run?: id }) · routines.new (masked sheet)
│   ├─ _shell.(artifacts)/          artifacts.index  search: { type?, from?, q?, item? }
│   ├─ _shell.(library)/            LibrarySidebar: library.connectors (search: { connector?: id }, masked sheet) ·
│   │                                messaging · mcp · skills · tools.$toolsetId
│   └─ _shell.settings/             settings sidebar: general · appearance · notifications · memory · usage · account ·
│                                    models · environment · about
├─ _bare.tsx                        no chrome: onboarding.$step · __ui (dev gallery)
└─ notch entry: memory-history router  /idle /working /approval/$id /reply/$id /call /done /failed
```

- Search schemas are valibot objects next to each route; middlewares `retainSearchParams(["view","tab"])` + `stripSearchParams(defaults)`; `loaderDeps` keys the loader on search.
- Loaders: `queryClient.ensureQueryData` for Query data, `collection.preload()` for DB, and `chatClient.hydrate(threadId)` for threads; `defaultPreload: "intent"`, `defaultPreloadStaleTime: 0` (external caches own staleness).
- Pop-ups are child routes in `Sheet`/`Dialog` joined by `createRouteMask` at router level; Escape = `history.back()`.
- Route context: `queryClient`, collections, chat client factory, `t`. `staticData` is typed and limited to `{ area, sidebar }`.

## Folder structure

```
src/renderer/
├─ main.tsx  notch.tsx                two vite inputs
├─ routes/                            files above; composition + loaders only
├─ ui/                                shadcn registry output (button, dialog, sheet, drawer, tabs, menus, combobox, command,
│                                     resizable, scroll-area, sidebar, kbd, field, input-group, item, empty, spinner,
│                                     message-scroller, message, bubble, attachment, marker, questionnaire, toast …)
├─ components/                        molecules used by ≥2 features
│   ├─ bot-avatar/                    BotAvatar (24 shapes, lifecycle + reactions, accessories), useBotMood
│   ├─ connector-mark/                26 product marks
│   ├─ composer/                      Composer.Root/Field/Attach/Dictate/Send/ModeChip/ModelChip/ContextBar (input-group based)
│   ├─ chat-kit/                      createChatUI wiring: parts, tools (ToolLine), interrupts, queue, subagent cards
│   ├─ spotlight/ empty-state/ status-dot/ digit-roll/ swap-label/ typing-dots/ shimmer-text
├─ features/
│   ├─ shell/        Rail, TopBar, SidebarSlot (pinned | floating), SidePanel (tabs in title bar), breakpoints, occlusion
│   ├─ chat/         chat client factory (IpcConnection), thread hydrate, markdown+highlight+temml, transcript virtualisation
│   ├─ bots/ sessions/ routines/ artifacts/ library/ settings/ onboarding/ notch/
├─ data/
│   ├─ collections/  ipcCollectionOptions + one file per entity + prefs
│   ├─ queries/      query options per feature
│   └─ ai/           IpcConnection adapter, tool/interrupt typings, fixtures via @shadcn/helpers
├─ lib/              tokens.css, motion.ts, sound.ts, i18n, window-chrome, keyboard (react-hotkeys)
└─ test-support/
```

Rules: a route file never imports another feature; features import `components/` and `ui/`, never each other; `ui/` diffs are rejected in review; no default exports except route files; React Compiler on, so no manual memo.

## Chat UI

| Kit slot (createChatUI) | Skin | Notes |
|---|---|---|
| `layout` | registry `MessageScroller` (Provider/Viewport/Content/Item/Button) + Interrupts slot above the composer + Queue slot | Anchored turns, prepend preservation, jump-to; `scroll-fade-b`; virtualise on the viewport ref past ~200 parts. |
| `message` | bots: `Bubble` (per-bot tint) · sessions: `Message` prose rows | Same kit, two skins. |
| `partsComponents.text` | TanStack `TextPart` (markdown streaming) + highlight + temml | File links open the Files tab. |
| `partsComponents.thinking` | `Marker` + `shimmer`, collapsible | Lifecycle face → _thinking_. |
| `toolsComponents[name]` | one-line `ToolLine` per tool (shimmer while running; refused vs failed); expanders for read/write/bash/browser | Approval renders inline through `ToolProps.interrupt` for tool kinds; big ones (send mail, calendar) go to the Interrupts slot. |
| `interruptsComponents.generic` | registry `Questionnaire` for `elicitation/create` | Mirrored to the notch. |
| `queue` | queue slot rows with steer / edit / cancel | TanStack queue: `whenBusy: "queue"`, fifo. |
| `subagentsComponents` | sub-agent cards with `stop()`; detail in a side-panel tab |  |
| media parts | registry `Attachment` (+ group scroll-fade) |  |

The `/__ui` gallery replays scripted conversations through `@shadcn/helpers/tanstack-ai` (`createChat().transport()` is a connect adapter emitting AG-UI), so every state on canvas pages 2–4 is a runnable fixture and a screenshot target without the agent.

## Motion system

| Moment | Owner | Spec |
|---|---|---|
| Rail switch, drill in/out, settings in/out | React `<ViewTransition>` + `addTransitionType` in a `useAppNavigate` wrapper | Cross-fade 200ms; drill-in slides 12px; CSS keyed by `:active-view-transition-type()` |
| Bot avatar transcript → title bar; welcome parade → shell | React `<ViewTransition name>` | Shared element, 420ms `cubic-bezier(.2,.8,.2,1)` |
| Sidebar pinned ↔ floating; side panel ↔ drawer at 1000px | `motion/react` layout + presence | Spring 500/40; content never reflows while floating |
| Composer pill → two rows; model chip ↔ details row | `motion/react` `layoutId` | 240ms, children fade 120ms after |
| Avatar lifecycle/reactions, typing dots, shimmer | CSS keyframes, registry `shimmer` | Reactions 600ms on top of the lifecycle face |
| Streamed text | Markdown streaming profile | No per-token motion; last block fades 80ms |
| Spotlight (tour) | own molecule: one mask + `<ViewTransition>` | Mask morphs, card follows 40ms later |
| Notch wings/body | CSS size transitions + `motion` reactions | exit 160 / expand 420 / contract 450ms, blur 4px, `cubic-bezier(.22,1,.36,1)`; reduced-motion 120ms (openbot.run’s tuned values) |
| Counters, label swaps | digit-roll and swap-label molecules |  |

`lib/motion.ts` exports durations, easings and springs once; `prefers-reduced-motion` collapses every entry to a fade and every layout animation to a cut. Emil Kowalski’s `animate`/`review-animations`/`improve-animations` and Vercel’s `vercel-react-view-transitions` skills run per feature PR.

## Sound

- **Cues:** sent, received (bot reply arrived while not looking), needs-you (approval/question), done (session finished), failed, routine fired. Slack/WhatsApp-style: short, distinct, same family. Start synthesised in WebAudio (openbot.run proves a 220ms swept sine reads as “done”), replace with a licensed set if design wants.
- **Rules:** never while the thread that caused it is visible and the window is focused; coalesce a burst into one cue; per-event switches, per-bot level (all / needs-me / nothing, like openbot.run’s `notificationLevel`), quiet hours shared with the notch; volume follows the system.
- **Where:** `lib/sound.ts` in the renderer (one `AudioContext`, unlocked on first interaction); the notch window plays needs-you and done when the main window is not focused; OS notifications carry no sound of their own.
- **Haptics (macOS):** optional alignment tick when the notch expands, via a long-lived `osascript -l JavaScript` calling `NSHapticFeedbackManager` (openbot.run’s trick, no native module).

## Shell

- **Rail** (56px): Bots, Sessions, Routines, Artifacts, Library; Settings and account at the bottom. Duotone icons from the canvas. A pinned “Needs you” group sits above the sidebar sections.
- **Sidebar slot** (280px) per rail item; pinned (in layout, app name in the title bar above it) or collapsed (floats on rail hover). At 800px the bots sidebar snaps to the 88px avatar strip.
- **Title bar**: Window Controls Overlay on every platform; the bar is laid out from `env(titlebar-area-x/y/width/height)` (traffic lights left on macOS, caption buttons right on Windows and on Linux DEs that draw them; a DE that keeps server-side decorations reports a full-width area and we render no controls) and `app-region: drag`; `navigator.windowControlsOverlay`’s `geometrychange` re-lays out live. The old `window-chrome.ts` constants (84/16 insets, 40/32 heights) are deleted; `titleBarOverlay.height` is the only number main sets, and it follows the DE font/scale. Contents: back/forward/sidebar toggle · app name (pinned only) · identity or breadcrumb · actions · side-panel tabs (only when something is open) · toggle.
- **Panes**: registry `resizable`; split view or full view (mini composer bottom-right). Widths 1100/1000/900/800 as on the canvas.
- **Native browser view:** stays a `WebContentsView` (a content surface only, never app chrome); with Electron 44 it also receives overlay geometry, so a browser tab can draw its own toolbar correctly if we ever want that. Overlays: every overlay is a registry atom. In Base UI the surface is the Popup: `data-slot="*-content"` (dialog, alert-dialog, sheet, popover, dropdown-menu(+sub), context-menu(+sub), menubar, select, combobox, hover-card, tooltip, navigation-menu), plus `drawer-popup`, `*-overlay` and `toast-viewport`; CommandDialog renders `dialog-content`. The occlusion watcher uses that explicit list (not `[data-slot$="-content"]`, which would catch `message-scroller-content`) and respects `data-starting-style`/`data-ending-style` during exit animations. A test asserts the list against the registry output.
- **Theme**: `.dark` on `<html>` from the prefs collection; per-bot accent as a CSS variable on the route element; `menuColor: default-translucent` for the frosted menus.

## Areas and parity

- **Bots** — Sidebar, chat (identity → title bar), details, setup, new, channel read-only, call, approval cards, memory/files panels, row menu, banners. IPC: bots.*, openBotChat, chat previews, sender chats, bot memory.

- **Sessions** — New (starters; history when collapsed), running (steps, queue, context bar), review (keep/undo), sub-agents, failed/sandbox prompt, workspace missing, Changes/Terminal/Files/Browser tabs. IPC: sessions.*, queue, git.*, files.*, terminal.*, browser runtime.*

- **Routines** — Sidebar with stats and auto-replies, routine page with runs and run report, create sheet, talk-to-it editor, firing-frame wrapper stripped for display. IPC: routines.*, editRoutineByChat, messaging snapshot.

- **Artifacts** — Grid/list, filters, preview, empty/no-match/missing. IPC: session-artifacts, files.*, openFilePath, showItemInFolder.

- **Library** — Connectors (+sheet), Messaging (WhatsApp/Telegram/Discord link flows), MCP servers (runtime statuses, import), Skills, Tools. IPC: connectors.*, messaging.*, mcp.*, skills.*, toolsets.

- **Settings** — General, Appearance, Notifications (+ sounds, notch), Memory, Usage, Account, Models, Environment, About. IPC: settings.*, models, local models, auth, browser, devices, memory, usage, update.*

- **Onboarding + tour** — 7 steps under `_bare`; 12 tour stops; first-bot hatch. IPC: account, auth, connectors, createBot.

- **Notch** — 12 states; approvals, elicitations, replies, dictation without the window. IPC: ai subscribe/send, prefs, window focus.

- **Parity checklist** — Generated from `preload/bridge.ts` (~190 methods): each gets “used by” or “retired because”. Ships as `PARITY.md`.

## Notch window

- **Window (from openbot.run’s recipe):** `BrowserWindow({ type: "panel", transparent, frame: false, alwaysOnTop, focusable: false, hiddenInMissionControl, skipTaskbar, hasShadow: false, enableLargerThanScreen })`, then `setAlwaysOnTop(true, "status")`, `setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })`, `setIgnoreMouseEvents(true, { forward: true })`; interactive only while hovered/focused. One per display on macOS, re-laid-out on display and power events.
- **Geometry:** centred at the top; compact height = notch + 18; a 700ms settle before shrinking so the collapse animation isn’t clipped. Notch size from `node-mac-notch` (`safeAreaInsets`, auxiliary areas) with openbot.run’s aspect-ratio inference (1512×982 → 185×32) as the fallback. Wings beside the cut-out, body below; nothing under it.
- **Content:** the same `features/chat` client against the same AG-UI stream; states `idle | working | message | question | approval | takeover | failed` with priority question > approval > takeover > failed > working > message > idle and a “remaining” count; while the pointer is over an attention state, updates queue instead of replacing content; reacts to the main window (send → wink, done → bounce).
- **Windows:** capsule by the taskbar clock, same states, grows upward. Linux: not now.
- **Prefs:** enabled, haptics, idle visible, extra displays, per-bot level; off switch in General.

## One-time migration

- Versioned migration runner in main (numbered steps, one transaction per step, recorded in a `migrations.json`), modelled on openbot.run’s numbered schema migrations; runs once on first launch of the new build, before the renderer loads, with a visible progress screen.
- **Transcripts:** `transcripts/<id>.json` (version 1 segments) → UIMessage parts; pi’s `agent/sessions/desktop/<id>.jsonl` stays the model-context source and is re-attached via `session/load`.
- **Sessions/workspaces:** `local-code.json` records → collection tables (same fields; `runOutcome: running` → `failed` on restore as today).
- **Bots:** `bots.json` + `bots/<id>/` unchanged on disk; avatar shape/colour map to the new 24-shape set; check-in routines stay routines.
- **Routines:** `cronjobs.json` + `routines/<id>/runs/*.md` unchanged; run index becomes a collection.
- **Memory:** `memories/*.md` unchanged.
- **Prefs:** zustand-persisted keys (`local-code-ui-store`, language, credits, accordion) → prefs collection; legacy keys deleted after a successful run.

## Tooling

- **React Compiler** on the renderer through `@vitejs/plugin-react`'s native `compiler` option (`oxc-transform-react`, no Babel; spec 01 F1); no hand-written memoisation.
- **TanStack Devtools** cockpit in dev: router, query, db, ai (`ai-client/devtools`), pacer; stripped in production.
- **UI gallery** at `/__ui` with scripted chat fixtures; screenshot script (isolated-profile CDP) captures every route at 1280/1000/900/800 in both themes for PR review.
- **knip**, **size-limit**, oxlint with React/a11y rules, oxfmt; Vitest browser mode for layout-dependent molecules; RTL stays; `@copilotkit/aimock`-style mock LLM for main-side host tests.
- **i18n:** keys reorganised by area; `check:jsx-i18n` and `sync-locales` kept; a test asserts every route title/empty state has a key.
- **Skills installed for the build:** TanStack (14), Emil Kowalski (`emil-design-eng`, animate, review/improve/find-animation, animation-vocabulary, ask-sonner), Vercel (composition patterns, react best practices, react view transitions, web design guidelines, writing), shadcn, Matt Pocock (grill-me, grill-with-docs, codebase-design, improve-codebase-architecture, domain-modeling, code-review, to-spec, implement-spec, tdd, ts deep modules), frontend-design, unslop.

## Libraries to use or verify

| Library | Use | Status |
|---|---|---|
| `@tanstack/ai-react/ui` createChatUI kit | Chat dispatchers | [use] 0.29.3; avoid the deprecated `Chat`/`useChatContext` exports |
| oRPC (`@orpc/*`) | Typed transport, MessagePort + WebSocket, event iterators, TanStack Query/AI integrations | [use] |
| pi-acp (victor-software-house, MIT) | Translation helpers to vendor | [reference] Bun-only, pinned to pi 0.75; copy code, don’t depend |
| `@tanstack/ai-acp`, `ai-claude-code`, `ai-codex` | Alternative engines in main, later | [later] |
| `@shadcn/react` message-scroller, questionnaire + registry chat parts | Transcript skin, HITL forms | [use] React ≥19 |
| `@shadcn/helpers/tanstack-ai` | Scripted fixtures | [verify] pins ai-client 0.20 vs 0.36 |
| `temml` (351★) | Math | [use] MIT, active |
| `node-mac-notch` | Exact notch metrics | [verify] Electron 43 ABI; aspect-ratio inference as fallback |
| `@tanstack/react-hotkeys` | Typed shortcuts (⌘K, ⌘N, ⌘., ⌘⇧Space) | [use] (OpenBot uses it) |
| `prompt-area` (OpenBot’s composer chips/triggers) | @-mentions, / commands in the composer | [evaluate] vs registry `input-group` + `combobox` |
| `streamdown`, `boring-avatars` | — | [skip] TanStack Markdown and BotAvatar cover them |
| `@pierre/trees`, `ghostty-web`, `valibot`, `@tanstack/react-pacer` | File tree, terminal, schemas, pacing | [use] |
| openbot.run code | — | [no copying] PolyForm Noncommercial; ideas only |

## References read (cloned under scratchpad/refs)

| Repo | Licence | What we took |
|---|---|---|
| TanStack/ai (ai-react 0.29.3, ai-client 0.36.0, ai 0.63.0, ai-acp 0.3.19) | MIT | createChatUI kit, connection adapters, interrupts model, harness adapters, replay primitives |
| TanStack/db (0.10.0) · TanStack/router (1.170.40) | MIT | Custom sync contract, live queries with includes; file-route conventions, route masking, view-transition ownership, search middlewares |
| shadcn-ui/ui | MIT | base-mira tokens and density, chat registry parts, message-scroller API, data-slot names, CLI presets |
| CopilotKit/openbot (v0.0.15) · CopilotKit/openmuse (v0.1.0) | MIT | Approvals as suspending tools, hash-bound proposals, firing frame for routines, stall watchdog, history repair, roster patches, ToolLine |
| nightly-labs/openbot (openbot.run) | PolyForm NC | Island window recipe and motion values, attention priority and locking, badge/mood single source, queue UI, sound gating, ACP as a provider seam (ideas only) |
| earendil-works/pi (0.99.1) · victor-software-house/pi-acp (0.17.1) | MIT | Extension API (`agent_before_settle`, `registerMcpServer`, virtual models), AgentSessionEvent shapes, why not ACP; tool title/kind/content helpers to vendor |
| Grok Bot design write-ups; Temml; ACP docs; oRPC docs | — | Lifecycle states and accessories; math; protocol shape; transport |

## Phases and PR stack

0
### Agent emitter, transport host, migration
`packages/agent`: add `src/agui` host + emitter with the mapping above, keep the NDJSON host behind a flag until cut-over; no changes to session logic. Main: oRPC contract + router, MessagePort transport, `ai.subscribe/send` with replay ring and stall watchdog, DB tables, taps moved onto AG-UI, Window Controls Overlay, migration runner.Gate: the 1185-line transport-bridge tests ported to AG-UI fixtures; a recorded pi session replays identically through both paths; a second transport (WebSocket) proven with a smoke test only — web mode itself is not in scope.
1
### Foundation
New `src/renderer`: deps upgraded, shadcn re-init (`--base base --preset mira`, lucide), tokens + `.dark`, router plugin, `__root`/`_shell`/`_bare`, data layer (collections, queries, IpcConnection), motion + sound presets, `/__ui` gallery, devtools, i18n boot, migration runner.Gate: shell renders with real sidebars from collections; 4 widths × 2 themes screenshots match the canvas.
2
### Chat kit
createChatUI wiring, parts/tools/interrupts/queue/subagent components, message-scroller + virtual, markdown + highlight + temml, composer molecules, questionnaire interrupts.Gate: scripted fixtures cover every state on canvas pages 2–4; a real session streams end to end with an approval round-trip.
3
### Bots
Routes, sidebar, chat with identity → title bar, details, setup, new, channel banner, call view, memory/files panels; BotAvatar as the app’s avatar; needs-you group.Gate: parity rows for bots.* and memory; before/after per PR.
4
### Sessions
New/running/review/sub-agents, split/full, Changes/Terminal (ghostty behind new tabs)/Files (highlight viewer)/Browser (runtime surface + occlusion list), sandbox and provider cards, workspace missing.Gate: parity for sessions/git/files/terminal/browser; terminal and native browser verified in the real app.
5
### Routines, Artifacts, Library, Settings
All as routes; connector sheet masked; update states; account/credits; sounds and notification prefs.Gate: parity for the remaining IPC groups; every locale key accounted for.
6
### Onboarding, tour, notch
Onboarding routes, first-bot hatch, spotlight tour, notch entry with states, reactions, sounds and haptics; Windows capsule.Gate: fresh-install run-through recorded; notch tested on a notched Mac, an external display and Windows.
7
### Cut-over
Delete the old renderer, conversation layer, NDJSON host, `window.api`, zustand stores, unused patches; knip clean; size-limit set; PARITY.md all green; migration runs on real data from a backup.Gate: `pnpm check` green; release build smoke on macOS and Windows.

## Open questions

- None blocking. Sub-agents follow the AG-UI spec’s subagent events (resolved above); pi is bumped to 0.99 with behaviour held constant.


## Amendments after phase-0 spec reviews (30 Sep 2026)

- Main's taps (messaging relay, artifacts, routine settle, turn waiter, browser auto-allow, host services) keep reading the agent's byte-identical legacy NDJSON on a compat channel (fd 3); only the renderer reads AG-UI. No `bot.reply` event.
- Permissions are not TanStack native interrupts (its interrupt manager replaces the pending set and submits all-or-nothing, which would change approval timing). Each permission is an independent `CUSTOM permission.requested` descriptor answered with a `permission.respond` command carrying thread, process incarnation, run and permission id; the run stays open while waiting. The chat kit renders permissions from that state and joins them to tool widgets by `(subagentRunId, toolCallId)`.
- Host services stay on the compat stream (not AG-UI client tools) for now.
- Window chrome ships in legacy mode until the new renderer lands (`RENDERER_GENERATION`).
- Spec 01 (renderer foundation) amendments: `tw-animate-css` stays (registry-owned); the rail's fifth item is Library with the canvas Connectors glyph; the registry `sidebar` is not used (its provider owns a global ⌘B); DB packages are 0.9.2 / 0.4.1 until 0.10.0 / 0.4.2 are published.
