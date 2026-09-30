# 02 — Chat kit (phase 2)

Status: draft spec **r1** (no code). Branch `rewrite/renderer`. It implements the "Chat kit" phase of `docs/rewrite/PLAN.md` (§Chat UI, §Motion system, §Phases 2, and the "Amendments after phase-0 spec reviews"), on top of:

- `00-agent-agui.md` **r3**: the AG-UI wire the chat consumes (§2.3 events, §3.1.6 busy input, §3.5 permissions, §3.6 sub-agents, §5.3 hydration);
- `00-transport-db-migration.md` **r2**, sub-slice A as implemented (`cfb550aa`): the `ai.*` procedures behind `AguiSource` (A.3), event iterators and `lastEventId` (A.4.3), the renderer `Transport` (A.7);
- `01-renderer-foundation.md` **r4**: folder layout and import rules (§4), `#next/*` aliases (§3.3), router context and view-transition rules (§6.4, §6.7), motion presets (§7.8), hotkeys (§7.9), the shadcn registry rules and dependency allowlist (§3.1, §5), the gallery (§10) and the test conventions (§11).

Paths are relative to `apps/desktop/` unless noted. Code in this spec is type declarations and short sketches only.

**Sources read for this spec** (all versions are what is installed or pinned, checked on 30 Sep 2026):

| Source | Version | Where |
|---|---|---|
| `@tanstack/ai-client` | 0.36.0 | installed at repo-root `node_modules/@tanstack/ai-client/src` (ships its `src`; `diff -rq` against the clone's `packages/ai-client/src` is empty) |
| `@tanstack/ai` | 0.63.0 | installed, `node_modules/@tanstack/ai/src` (StreamProcessor, types) |
| `@tanstack/ai-react` | 0.29.3 | **not installed**; read from the TanStack AI clone `scratchpad/refs/ai/packages/ai-react` (commit `e9ff416`), whose `package.json` is 0.29.3, equal to npm `latest` (published 27 Sep 2026) |
| `@tanstack/markdown` / `@tanstack/highlight` | 0.0.13 / 0.0.10 | installed (`apps/desktop/package.json:90-91`, devDependencies) |
| `@shadcn/react` | 0.3.0 installed, 0.3.1 in the clone and pinned by the foundation spec (§3.1) | `node_modules/@shadcn/react/dist`, clone `scratchpad/refs/ui/packages/react/src` (HEAD `10cd7f0`) |
| shadcn registry chat parts | clone HEAD `10cd7f0` | `scratchpad/refs/ui/apps/v4/registry/bases/base/ui/{message-scroller,message,bubble,attachment,marker,questionnaire}.tsx` |
| `@shadcn/helpers` | 0.2.0 (clone and npm latest) | clone `packages/helpers` |
| `temml` | 0.13.5 (npm latest, 28 Aug 2026) | `npm pack temml@0.13.5`, unpacked in the scratchpad |
| `motion` | 13.4.6 (npm latest) depends on `framer-motion ^13.4.6` | `npm view`; APIs checked against the installed `framer-motion` 12.43 types |
| Design canvas | artifact `XpL2PgWae6rUjXDTWyUqYX`, version `1790747894-aeaf` | boards on pages 1 (BotChat, BotChatScrolled, SessionRunning), 2 (bots), 3 (sessions), 4 (ComposerStates, PermissionStates, Pickers, ReadOnlyStates), 6 (widths) |
| Current app | `HEAD d7307c71` | `apps/desktop/src/renderer/components/chat/chat-composer.tsx`, `chat-panel.tsx`, `conversation/transport.ts`, `packages/agent/src/protocol.ts` |

Citations of the form `chat-client.ts:1234` refer to the installed `@tanstack/ai-client/src`; `processor.ts:…` to `@tanstack/ai/src/activities/chat/stream/processor.ts`; `create-ui.tsx:…` and `use-chat.ts:…` to the clone's `packages/ai-react/src/…`.

---

## 0. Findings that change the brief (read first)

Each was checked against source. Every one is carried into the sections below, and the ones that change another spec are listed again in §14.

| # | Brief / plan / earlier spec says | Verified fact | Consequence here |
|---|---|---|---|
| F1 | Agent spec §3.1.6: "ChatClient is configured with `whenBusy: "error"`" | `WhenBusy = 'queue' \| 'drop' \| 'interrupt'` (`types.ts:430`). There is no `"error"`. `QueueConfig.onOverflow: 'reject'` also discards **silently** (`types.ts:468-474`). | The client gets a `QueueStrategy` function (`types.ts:487`) that reports a bug and returns `{ action: "drop" }` (§3.4). The composer never calls `sendMessage` while busy (§8.3), which is what actually prevents the case. |
| F2 | Agent spec §5.3: `hydrate` returns "the transcript as of the last terminal, i.e. excluding the active run" | `resumeInFlightRun` drops the **trailing assistant message** on the first rebuild chunk of the join (`chat-client.ts:2016-2018`, `dropTrailingInFlightAssistant` `:2080-2086`, triggers `:345-352`). With the active run excluded, the trailing message is the **previous run's reply**, which would be deleted on every reload mid-run. | `hydrate.messages` must end with the active run's opening user message, or with that run's own partial assistant message (main's live processor state at the checkpoint). Amendment §14.1. R2-T5 proves the previous reply survives a mid-run reload. |
| F3 | Agent spec §3.1.3: only server-initiated runs carry a user `TEXT_MESSAGE_*`; main's transcript is its `StreamProcessor` fed from stdout | A client `run` therefore never puts the user's own message on stdout, so main's transcript (and every hydrate, every second window) would lack every message typed in the new renderer. | Main relays a user `TEXT_MESSAGE_START/CONTENT/END` with the **client's** message id and text right after that run's `RUN_STARTED` (as the agent already does for server runs), so the transcript, the run log and other windows all get it. In the sending window the processor finds the message already present (dedup Case 2, `processor.ts:1288-1312`) and the single `CONTENT` replaces the text part with the same text (`updateTextPart` replaces the last text part, `message-updaters.ts:26-49`), so nothing is duplicated. Amendment §14.2. R2-T6. |
| F4 | PLAN: "loader: `chatClient.hydrate(threadId)`" | `ChatClient` has no public hydrate. It hydrates itself in `attach()` when `persistence === true` and the connection has `hydrate` (`chat-client.ts:1017-1039`, `hydrateFromServer` `:1146-1232`); `useChat` calls `attach()` on mount (`use-chat.ts:391-396`). | Loaders **prime** the connection (`ai.hydrate` started early, consumed once by the adapter's `hydrate`), §3.2. |
| F5 | Transport A.3: `ai.subscribe` (ring + live) and `ai.joinRun` (from `RUN_STARTED`, then live) are independent iterators | `ChatClient` consumes `subscribe()` and `joinRun()` in two independent loops (`consumeSubscription` `:1942`, `resumeInFlightRun` `:1982`) and processes whatever each yields. Both would carry the active run's live events: duplicates and cross-loop reordering. | The adapter serialises them with a **cursor gate** (§3.3): `hydrate` returns a cursor `N`; while a join is active the subscription is held; when the join ends, the subscription opens at the join's last sequence. `joinRun` must yield every relay event of the run window with its sequence id. Amendments §14.3, §14.4. |
| F6 | Agent spec §3.1.6 / §5.2: main injects `RUN_ERROR {queued}` into "the requesting subscription" | The requesting subscription may be gated (F5) or not yet open when the ack arrives; the injected terminal would then be lost and `sendMessage()` would hang on `processingComplete` (`chat-client.ts:2625`). | `ai.send` returns the ack (`started \| queued \| rejected \| duplicate`) and the **adapter** synthesises the terminal locally, bypassing the gate (§3.3). Main injects nothing. Amendment §14.5. |
| F7 | PLAN: `createChatUI` dispatchers render every tool and sub-agent | Missing `toolsComponents[name]` warns once and renders **nothing** (`create-ui.tsx:725-731`); missing `subagentsComponents[name]` **throws** (`:743-748`, `:951-955`). Tool names are open (MCP tools, extensions). | The tool and sub-agent maps are `Proxy` objects that resolve any name to the generic widget (§5.2). Nested `SubagentMessages` overrides would spread the proxy into a plain object (`withWidgets`, `:339-348`), so cards never pass override maps. R2-T12. |
| F8 | PLAN: gallery fixtures via `@shadcn/helpers/tanstack-ai` | `@shadcn/helpers@0.2.0` peers `@tanstack/ai >=0.40.0 <0.41.0` and `@tanstack/ai-client >=0.20.0 <0.21.0` (clone `packages/helpers/package.json`); its writer has no permissions, sub-agents, `STATE_*` or `CUSTOM`. | Not used. Fixtures are recorded AG-UI streams replayed through the **real** adapter over a fake `AppClient` (§11). |
| F9 | PLAN: math via `temml` in TanStack `TextPart` | `@tanstack/markdown` has no math node; the inline parser consumes `\(`, `\)`, `\[`, `\]` as escapes before any extension sees them (`dist/inline.js:28-39`), and the React renderer ignores extension `renderHtml` (only `html.js` calls it). `temml.mjs` exports **only a default** although `temml.d.ts` declares named exports (`dist/temml.mjs:14755`). | Math is rewritten in a **pre-pass on the raw string** into forms the Markdown React renderer already has hooks for: display math becomes a fenced block with language `math` that the synchronous `highlighter` renders to MathML; inline math becomes inline code with a sentinel prefix that a custom `code` component renders (§7.3). `import temml from "temml"` only. R2-T19. |
| F10 | PLAN: virtualise the transcript on the viewport ref past ~200 parts | The registry scroller's anchoring, `scrollToMessage`, visibility tracking and prepend preservation all work on `MessageScrollerItem` rows with `messageId` (clone `use-message-scroller-controller.ts:260-309, 424-461`); the docs' virtualisation example renders plain divs (`message-scroller.mdx:527-594`), losing them. The registry `Item` already sets `content-visibility: auto` (`message-scroller.tsx:79`), and `PERFORMANCE.md:167-175` reports headroom for "hundreds to low thousands of turns". | No `@tanstack/react-virtual` in phase 2. Long threads are **paged** instead (`history.pageSize`, §3.4) with `loadOlderMessages` on scroll-to-top. A performance budget (R2-T31) decides whether a later slice adds virtualisation. |
| F11 | PLAN: "Stop" and sub-agent `stop()` | `ChatClient.stop()` aborts only the local request ("A durable server run keeps going", `:2825-2842`); `SubagentHandle.stop` likewise (`:3194-3211`). | Stop is `ai.cancel({ threadId, runId })` everywhere (agent spec §3.6). `useChat().stop` and `handle.stop` are never called (§4.5). |
| F12 | — | A `RUN_ERROR` with no active assistant message **creates an empty assistant message** (`processor.ts:913-928` via `handleRunErrorEvent` `:2270`). | Message widgets render nothing for an empty assistant message; `queued`/`rejected` cleanup removes it (§4.6). |
| F13 | PLAN: Interrupts slot for approvals | Agent spec r3 already superseded native interrupts; confirmed: the kit's `Interrupts` reads only `chat.interrupts` (`create-ui.tsx:818-837`). | `interruptsComponents` is not configured; permissions render from the kit's own descriptor store (§6). |
| F14 | — | `useChat` subscribes only when `live: true` (`use-chat.ts:361-375`); without it, runs started elsewhere (routines, messaging, a second window) never reach an idle client. | `live: true` for every thread view (§3.4). |
| F15 | Foundation §3.1 pins `@shadcn/react ^0.3.1` | Installed is 0.3.0, which never sets `data-pending-scroll` (0.3.1 changelog), so the registry viewport's `data-pending-scroll:invisible` is a no-op and a reload flashes the top of the transcript. | The 0.3.1 pin is a phase-2 prerequisite; R2-T16 asserts the attribute. |
| F16 | Implemented `contract.ai` = `subscribe, send, hydrate, joinRun, cancel`; `contract.agent` has `respondPermission` (legacy `permission_response`, **no lineage**) and `queue.*` (**index**-based) (`shared/contract/agent.ts:94-139`) | Agent spec §3.5.3 requires lineage on every renderer answer; the legacy queue commands take indexes (`protocol.ts:437-440`) that go stale while a queue drains. | New procedures `ai.respondPermission` and `ai.queue.*` keyed by entry id (§14.6). renderer-next never calls `agent.respondPermission` or `agent.queue.*` (R1-T15 extension, R2-T30). |
| F17 | Brief: `@tanstack/highlight` for code blocks | 0.0.10 ships 26 grammars; **no Go, Rust, Java, C/C++, Ruby, Swift, Kotlin** (`dist/index.d.ts:2`). Unknown languages fall back to plaintext (`core.js:15-17`). No lazy loading. Markdown code blocks render as `pre.tm-code` while the highlight theme targets `pre.th-code` by default (`theme.js:24-62`). | Accepted gap: those languages render as escaped plaintext with the block chrome (copy, language label). `createThemeCss({ codeBlockSelector: "pre.tm-code", … })`. Bumping to 0.1.0 is out of scope (its changes are unverified). |
| F18 | PLAN motion table: "Composer pill → two rows; model chip ↔ details row: `layoutId` 240 ms, children fade 120 ms after" | The canvas has **no** motion notes for chat beyond the `bob` typing dots (1.2 s, delays .15/.3 s) and the words "morphs" in two board titles. | Values come from PLAN and `lib/motion.ts`; the canvas supplies only the start and end states (§9). |
| F19 | PLAN: `questionnaire` for `ask_user_question` | Today's answers are encoded as `answers["question_" + i] = labels.join(", ") + (note ? " — " + note : "")` (`chat-composer.tsx:1018-1037`), and the agent steers `JSON.stringify(answers)` verbatim (`session.ts:3107-3110`). | The kit reproduces that encoding byte for byte (§6.5, R2-T24); the model prompt must not change. |
| F20 | Canvas labels vs today's | Today's "Always allow" rule for a command is `Bash(<command, first 120 chars>…)` sent as `allow_always_with_rules` (`chat-composer.tsx:659-666, 500-513`); `_alwaysAllowRule` has no producer in `packages/agent/src`. The canvas shows "Always allow git push". | Behaviour stays today's (the full-command rule); the label renders the rule text. A prefix-rule suggestion is a separate behaviour change, not in this slice (§6.4). |

---

## 1. Scope

### 1.1 In scope

- **`#next/features/chat`**, a feature module that routes compose (§2). Other features never import it (foundation §4 rule unchanged); cross-area pieces (bot identity, workspace context tab, session side-panel tabs) arrive through props and slots from the route.
- **The ChatClient binding** to `ai.*`: a `SubscribeConnectionAdapter` over `ai.subscribe` / `ai.send` / `ai.hydrate` / `ai.joinRun` with `lastEventId` resume and the cursor gate; loader priming; `ai.queue.*` for busy input; `ai.respondPermission` as independent answers; `ai.cancel` for Stop (§3, §4).
- **The thread store**: permission descriptors, host queue, agent state (mode, model, plan), run tracker, live tool output and display, per thread (§4).
- **Renderers** for every AG-UI event class the agent emits: text, reasoning, tool calls (including the overridden `bash` and the `read`/`write`/`edit` shapes), sub-agents with `subagentRunId`, permissions, `STATE_*` plan and mode, usage, errors, notices (§5, §6).
- **The composer**: attachments, `@` and `/` triggers, queue behaviour, permission-mode and model chips, busy states, keyboard (§8).
- **Markdown** with `@tanstack/markdown`, code blocks with `@tanstack/highlight`, math with `temml` (§7).
- **The transcript scroller**: stick to bottom, anchored turns, new-message marker, history paging (§10).
- **Motion** and **a11y** (§9, §12), **gallery entries** and fixtures (§11), tests (§13).

### 1.2 Out of scope

Bot and session routes, sidebars, title-bar identity and side-panel tabs (phases 3–4 compose the kit); the model catalogue and the model picker's contents (the kit ships the chip and a picker shell taking groups as props); the notch (phase 6, reuses §3–§6); dictation audio (the composer has the `Dictate` slot and states only); sounds (the kit emits cue *intents* on `lib/sound.ts`, which stays silent until phase 3); anything main-side beyond the contract amendments in §14; branching / regenerate after success (agent spec §3.1.4); `send now` (`dequeue`) from a queue row (the canvas has Edit and Remove only; the procedure exists for a later slice).

### 1.3 Gate (PLAN phase 2)

Scripted fixtures cover every chat state on canvas pages 1–4 (the chat boards of page 1 included, since BotChat, BotChatScrolled and SessionRunning live there); a real session streams end to end with an approval round trip (§15).

---

## 2. Folder shape and public API

```
src/renderer-next/features/chat/
├─ index.ts                      public API (below); the only file routes import
├─ runtime/
│  ├─ runtime.ts                 createChatRuntime(transport): ChatRuntime (router context member)
│  ├─ connection.ts              createThreadConnection(): SubscribeConnectionAdapter + gate (§3.3)
│  ├─ gate.ts                    CursorGate (pure, tested alone)
│  ├─ prime.ts                   loader priming (§3.2)
│  ├─ send.ts                    routeSubmit(): send | enqueue | blocked (§8.3), deriveSessionTitle (port)
│  └─ errors.ts                  run-error classification (§4.6)
├─ store/
│  ├─ thread-store.ts            ThreadStore = TanStack Store per thread (§4.1)
│  ├─ apply.ts                   applyEvent(state, seq, chunk) — pure reducer (§4.2)
│  ├─ json-patch.ts              RFC 6902 subset for STATE_DELTA (§4.3)
│  └─ selectors.ts               useThreadStore(threadId, selector), descriptorFor(key), busy(), …
├─ kit/
│  ├─ ui.tsx                     createChatUI(options, config) for both skins (§5.1)
│  ├─ layout.tsx                 ChatLayout (scroller + composer slot + queue + permission list)
│  ├─ message.tsx                BotMessage (bubbles) · SessionMessage (prose rows)
│  ├─ parts/                     text.tsx thinking.tsx attachment.tsx fallback.tsx
│  ├─ tools/                     tool-line.tsx tool-meta.ts tool-widgets.ts (Proxy map) expanders/{bash,diff,read,browser,generic}.tsx
│  ├─ subagents/                 subagent-card.tsx subagent-widgets.ts (Proxy map) subagent-scope.tsx
│  ├─ permissions/               permission-card.tsx permission-list.tsx decisions.ts question-card.tsx plan-card.tsx
│  ├─ queue/                     queue-slot.tsx
│  └─ status/                    run-marker.tsx busy-line.tsx error-card.tsx notice.tsx typing.tsx changes-card.tsx
├─ markdown/                     markdown.tsx math-prepass.ts math.tsx highlighter.ts links.tsx code-block.tsx
├─ composer/                     composer.tsx (compound) mode-chip.tsx model-chip.tsx attachments.ts triggers.tsx draft-store.ts keys.ts
├─ scroller/                     transcript.tsx new-marker.tsx paging.ts
├─ motion.ts                     chat motion constants (from lib/motion.ts) and helpers
├─ fixtures/                     player.ts scenarios/*.agui.jsonl builders.ts canvas-map.ts
└─ gallery/                      sections.tsx (exported as chatGallerySections)
```

Public API (`index.ts`), all named exports:

```ts
export { createChatRuntime, type ChatRuntime } from "./runtime/runtime";
export { ChatView, type ChatViewProps } from "./kit/layout";           // the whole thread view
export { useThreadChat, type ThreadChat } from "./runtime/use-thread-chat";
export { PermissionList } from "./kit/permissions/permission-list";   // also used by the notch (phase 6)
export { Composer } from "./composer/composer";                        // compound, for the new-session page
export { chatGallerySections } from "./gallery/sections";
export type { ThreadSkin, ThreadStoreState, PermissionDescriptor, QueueEntry, AgentState } from "./store/thread-store";
```

```ts
export interface ChatViewProps {
  threadId: string;                        // the session id (transport A.3)
  skin: "bot" | "session";
  /** Route-provided pieces; the kit never imports another feature. */
  slots?: {
    empty?: ReactNode;                     // new-chat state
    banner?: ReactNode;                    // read-only / disconnected / credits banners (ReadOnlyStates, BotStates)
    composerContext?: ReactNode;           // the context tab under the composer (workspace, branch, PR)
    typingCaption?: (activity: Activity) => ReactNode;
  };
  composer: {
    mode: "full" | "mini";                 // FullView mini pill vs full composer
    readOnly?: { reason: ReactNode; action?: ReactNode };   // replaces the composer (ReadOnlyStates)
    placeholder: string;                   // "Message Chief of Staff", "Steer the run, or queue the next step", …
    attachmentsBase: string | null;        // folder for pasted files (workspace root); null disables paste-to-file
    showModeChip: boolean;                 // false for bots (agent spec: "main omits it for bots")
    model: ModelChipBinding | null;        // value + onChange + picker groups, supplied by the route
    mentions?: MentionSource;              // `@` file search (sessions), supplied by the route
  };
  onOpenFile?: (absPath: string) => void;  // file links in markdown and tool rows → Files tab (sessions)
  onOpenSubagent?: (subagentRunId: string) => void;   // card → side-panel "Agents" tab (sessions)
}
```

`ChatRuntime` joins the router context (foundation §6.4 "Chat client factory joins the context in phase 2"):

```ts
export interface ChatRuntime {
  prime(threadId: string): void;                                   // loaders (§3.2)
  connection(threadId: string): ThreadConnection;                  // cached per document (§3.1)
  store(threadId: string): ThreadStore;
  respondPermission(d: PermissionDescriptor, decision: PermissionDecision): Promise<void>;   // §6.3
  queue: { enqueue(threadId: string, text: string): Promise<void>; update(threadId: string, id: string, text: string): Promise<void>;
           remove(threadId: string, id: string): Promise<void>; clear(threadId: string): Promise<void> };
  cancel(threadId: string): Promise<void>;                         // Stop (§4.5)
}
```

`createChatRuntime(transport)` is called once in `createAppRouter(boot)`; the notch entry (phase 6) calls it with its own transport.

---

## 3. The ChatClient binding

### 3.1 One connection per thread per document

`runtime.connection(threadId)` returns a cached `ThreadConnection` (an LRU of 8 threads; a connection with an open iterator or a mounted view is pinned). It owns the `ThreadStore`, the cursor gate and the adapter below. Keeping it per document (not per component) means a Strict Mode remount, a route re-render or a second consumer in the same window (the mini composer in full view, the bot strip's working face) share one stream, and a thread revisited within the LRU window repaints from the store at once.

### 3.2 Loader priming

Route loaders (phases 3–4) call `context.chat.prime(threadId)`. It starts `client.ai.hydrate({ threadId, limit: PAGE_SIZE })` and parks the promise on the connection for 5 s. The adapter's `hydrate` (called by `ChatClient.attach()`, F4) consumes it **once**; a later call, a `before` page request, or an expired prime fetches fresh. Priming never touches `ChatClient` (none exists yet) and never opens a stream. A rejected prime is discarded, not cached, so the mount-time hydrate retries once.

### 3.3 The adapter (`SubscribeConnectionAdapter`) and the cursor gate

The interface is verified at `connection-adapters.ts:1023-1060`:

```ts
subscribe: (abortSignal?: AbortSignal) => AsyncIterable<StreamChunk>
send: (messages, data?, abortSignal?, runContext?: RunAgentInputContext) => Promise<void>
joinRun?: (runId: string, abortSignal?: AbortSignal) => AsyncIterable<StreamChunk>
hydrate?: (threadId: string, options?: ChatHydrateOptions) => Promise<ChatHydrationResult>
```

Every server event carries its relay sequence `seq` as the oRPC event id (`withEventMeta(event, { id: String(seq) })`, transport A.3; read on the client with `getEventMeta(event)?.id` from `@orpc/client`). The connection keeps `yieldedSeq` (the highest seq handed to `ChatClient`) and a `CursorGate { state: "closed" | "open", cursor: number | null }`.

**`hydrate(threadId, options)`**

1. `options?.before` set → a history page: `ai.hydrate({ threadId, limit, before })` passthrough; the gate and store are untouched.
2. Otherwise: take the prime or call `ai.hydrate({ threadId, limit })`. The result is `ChatHydrationResult & { abacus: ThreadSnapshot }` (§14.1).
3. `store.reset(abacus)`: descriptors, queue, agent state, active run and `appliedSeq = abacus.cursor` (§4.1).
4. `yieldedSeq = abacus.cursor`. If `activeRun` is set, the gate stays closed and records `expectJoin = activeRun.runId`; `setTimeout(0)` later, if no `joinRun(expectJoin)` has started, the gate opens at `abacus.cursor`. `hydrateFromServer` calls `maybeRejoinInFlight` synchronously in the continuation that receives the hydrate result (`chat-client.ts:1158` await, `:1217` rejoin), so a join that is going to happen has always started by then; one that does not (the client is loading a send, detached, or already joined) leaves the subscription to cover the run from `N`.
5. Return `{ messages, activeRun, interrupts: null, page }` (`interrupts` is always null, F13).

**`joinRun(runId, signal)`** — async generator over `client.ai.joinRun({ runId }, { signal })`. Main replays the run's events from `RUN_STARTED` up to the checkpoint and then streams live until the terminal (agent spec §5.3), yielding **every** relay event in that window with its seq (§14.3). For each event: `store.apply(seq, event)` (no-op when `seq ≤ appliedSeq`), `lastJoinSeq = seq`, `yieldedSeq = max(yieldedSeq, seq)`, yield. `finally`: open the gate at `max(abacus.cursor, lastJoinSeq)`. A join refused before its first chunk, aborted by `REJOIN_CONNECT_DEADLINE_MS` (2 s, `:337`) or by `detach()` also opens the gate at the cursor: the run then continues through the subscription, without the replayed prefix but without loss after `N`.

**`subscribe(signal)`** — async generator, one per `ChatClient.subscribe()`:

```
loop until signal aborts:
  await first of (gate open, localQueue non-empty)
  drain localQueue first (synthesised terminals, below), yielding each
  open client.ai.subscribe({ threadId, lastEventId: String(gate.cursor) }) with an inner AbortController
  for each event:
    CUSTOM abacus.subscribed → skip (readiness signal, transport A.3)
    CUSTOM abacus.resync     → onResync(): see below; break to the outer loop
    seq ≤ yieldedSeq          → skip (duplicate)
    store.apply(seq, event); yieldedSeq = seq; yield event
    between events, drain localQueue
  on gate close (a new hydrate expects a join): abort the inner iterator, continue the outer loop
  on iterator error: see "Reconnect" below
```

**`send(messages, _data, _signal, runContext)`** — calls

```ts
client.ai.send({
  threadId, runId: runContext.runId,
  messages: [lastUserMessage(messages)],           // history paging already trims to unknown messages (§3.4)
  forwardedProps: runContext.forwardedProps,       // { mode?, model? } only for a pre-start draft (§8.4)
})  // → { runId, status: "started" | "queued" | "rejected" | "duplicate", reason? }   (§14.5)
```

- `started` or `duplicate`: resolve. Events arrive on the subscription.
- `queued`: push `RUN_ERROR { threadId, runId, code: "queued", message: "Queued behind the running reply." }` (with `metadata.tanstack { threadId, runId }`, the convention the agent uses) onto `localQueue`, then resolve. The subscription generator yields it even while the gate is closed, which settles `processingComplete` for that run id at once (agent spec §3.1.6 intent, without main-side injection).
- `rejected`: the same with `code: "rejected"` and `message: reason`.
- A thrown oRPC error (`UNAVAILABLE`, `NOT_FOUND`, `CONFLICT`, `TIMEOUT`) is rethrown; `streamResponse` reports it (`chat-client.ts:2656-2690`) and the kit handles it as a send failure (§4.6).
- The abort signal is ignored. `ChatClient` aborts on `detach()`/`unsubscribe()`, which mean "nobody is watching", never "stop the run" (§4.5).

**`onResync`** (the resume point fell out of the replay ring, transport A.3): the kit calls `client.detach(); client.attach()`. `detach` keeps the transcript and clears `rejoinedRunId` (`:1056-1065`); `attach` re-runs `hydrateFromServer`, which replaces the messages (`processor.setMessages`) and rejoins an active run. The adapter's `hydrate` closes and re-arms the gate, so the subscription reopens at the new cursor. No public API outside `attach`/`detach` is used.

**Reconnect.** An `ai.subscribe` iterator that throws `RESYNC_REQUIRED` (its lossless queue overflowed, transport A.4.3) or any error other than an abort is reopened from `yieldedSeq` after 250 ms, 1 s, 4 s. A resume point still in the ring replays seamlessly; one that is not gets `abacus.resync` (above). After three consecutive failures the generator throws; `ChatClient` sets `connectionStatus: "error"` (`chat-client.ts:1915`) and the layout shows the "Reconnecting…" notice with a Retry button that calls `client.subscribe({ restart: true })`. Port loss is not retried here: the foundation reloads the document (foundation §8.6 step 8).

**Why this ordering is total.** Every event the client processes comes through exactly one of the two generators; the gate guarantees they never run concurrently for the same range (the subscription starts strictly after the join's last seq), and `seq ≤ yieldedSeq` drops any overlap. `localQueue` terminals carry run ids the server never started, so they cannot interleave with a real run's events. R2-T3 and R2-T4 prove it with adversarial timings.

### 3.4 `useThreadChat`

```ts
export function useThreadChat(threadId: string, skin: ThreadSkin): ThreadChat {
  const runtime = useChatRuntime();
  const conn = runtime.connection(threadId);
  const chat = useChat({
    connection: conn.adapter,
    threadId,
    persistence: true,                 // server-authoritative: hydrate on attach (chat-client.ts:1017-1039)
    history: { pageSize: PAGE_SIZE },  // 60 messages; also makes sends carry only unknown messages (:3285-3316)
    live: true,                        // watch runs started elsewhere (F14)
    queue: rejectBusySends,            // QueueStrategy (F1)
    onError: (e) => conn.onClientError(e),        // §4.6
  });
  useEffect(() => conn.bindClient({ detach: ..., attach: ..., setMessages: chat.setMessagesManually }), [conn, chat]);
  return { chat, store: conn.store, threadId, skin };
}

const rejectBusySends: QueueStrategy = ({ busyReason }) => {
  reportBug("chat.send-while-busy", { busyReason });   // dev: console.error + toast; prod: log
  return { action: "drop" };
};
```

`useChat` builds one `ChatClient` per `threadId` (`use-chat.ts:111`, keyed on `clientId`), attaches on mount and detaches on unmount (`:391-396`), and disposes after a tick unless remounted (`:398-446`). Switching threads therefore creates a new client for the new thread; the old one is disposed, and its connection stays in the LRU with its store (§3.1).

`ChatUIHost` for `createChatUI` is exactly `UseChatReturn` (`create-ui.tsx:47-51`), so `chat` is passed straight to `UI.Chat`/`UI.Provider`.

### 3.5 TanStack AI APIs used (verified signatures)

| API | Signature (as used) | Source |
|---|---|---|
| `useChat(options)` | `UseChatOptions` with `connection`, `threadId`, `persistence: true`, `history: { pageSize: number }`, `live`, `queue`, `onError`, `onCustomEvent?` → `UseChatReturn` (`messages`, `sendMessage(content, sendOptions?)`, `status`, `isLoading`, `subagents`, `queue`, `runId`, `error`, `connectionStatus`, `sessionGenerating`, `hasOlderMessages`, `loadOlderMessages()`, `reload()`, `setMessagesManually(messages)`) | `use-chat.ts:36-47`, `types.ts:85-270` (clone) |
| `ChatClient.attach()` / `detach()` | `(): void` | `chat-client.ts:1017`, `:1056` |
| `ChatClient.subscribe({ restart? })` | `(options?: { restart?: boolean }): void` | `:2760` |
| `sendMessage(content, body?, sendOptions?)` | `content: string \| MultimodalContent` (`{ content, id?, metadata? }`, `types.ts:395-410`) | `:2258` |
| `QueueStrategy` | `(ctx: { pending, busyReason, queued }) => { action: WhenBusy }` | `types.ts:487-491` |
| `reload()` | re-sends from the last user message | `:2793` |
| `setMessagesManually(messages)` | replaces the processor's messages | `:3483` |
| `getMessages()` | current `UIMessage[]` | `:3140` |
| `createChatUI(options, config)` | returns `{ Chat, Provider, Messages, Message, Part, Interrupts, Interrupt, Queue, Subagents, SubagentMessages, useChatContext, Input }` | `create-ui.tsx:371-1003` |
| `LayoutProps` | `{ Messages, Interrupts, Queue, Subagents } & { Input }` | `:57-68` |
| `MessageProps` | `{ message: UIMessage, Parts: ComponentType }` | `:70-73` |
| `PartProps` / `ToolProps` | `{ part }` / `{ part: ToolCallPart, result?: ToolResultPart, interrupt? }` | `:84-86`, `:120-127` |
| `SubagentProps` | `{ subagent: SubagentHandle & { name }, Parts: ComponentType<SubagentPartsProps> }` | `:109-118` |
| `TextPart` | `{ content, role?, className?, userClassName?, assistantClassName?, extensions?, highlighter?, components? }` | `chat-ui/text-part.tsx:10-34` |
| `parsePartialJSON` | streaming tool-argument parse for titles before `input` exists | `@tanstack/ai/client` (`src/client.ts:299`) |
| `ToolCallState` | `awaiting-input \| input-streaming \| input-complete \| approval-requested \| approval-responded \| complete \| error` | `@tanstack/ai/src/types.ts:86-93` |
| `ToolResultPart` | `{ toolCallId, content, state: streaming\|complete\|error, outcome?: cancelled\|denied, error? }` | `ai-client/src/types.ts:615-627` |
| `SubagentHandle` | `{ id, name, description?, status: running\|finished\|error\|suspended, parentToolCallId?, messages, error?: { message, code? } }` | `@tanstack/ai/src/types.ts:507-531` |

`ThinkingPart` and the kit's `Chat`/`useChatContext` deprecated exports (`ui.ts:27`) are not used (PLAN "avoid the deprecated exports").

---

## 4. The thread store

### 4.1 State

A `Store` from `@tanstack/react-store` per thread (ephemeral UI state, PLAN §Where state lives), created by the connection:

```ts
export interface ThreadStoreState {
  appliedSeq: number;                                  // store-side guard (§3.3)
  incarnation: string | null;                          // from snapshot / session.ready
  agent: AgentState | null;                            // agent spec §2.3 AgentState: mode, modeSource, model, plan?
  permissions: { items: PermissionDescriptor[]; answering: Record<string, AnsweringState> };
  queue: QueueEntry[];                                 // { id, message, waitingFor: "step" | "permission" | "turn" }
  runs: { active: ActiveRun | null; last: RunOutcome | null; byId: Record<string, RunOutcome> };
  tools: { output: Record<ToolKey, string>; display: Record<ToolKey, ToolDisplayData> };   // live CUSTOM tool.output / tool.display
  activity: { status: AgentStatus; runningTools: number; retry: RetryInfo | null };        // agent.status / heartbeat / retry
  notices: Notice[];                                   // agent.notification, non-terminal agent.error
  skills: SkillMetadata[];                             // skills.loaded, for the `/` menu
}
type ToolKey = `${string}\u0000${string}`;             // (subagentRunId ?? "", toolCallId), agent spec §3.5.4
interface ActiveRun { runId: string; startedAt: number; serverInitiated: boolean }
interface RunOutcome { runId: string; kind: "success" | "cancelled" | "error"; startedAt: number; endedAt: number;
                       usage?: TokenUsage; error?: AgentErrorPayload & { code?: string }; steps: number }
```

Types `PermissionDescriptor`, `AgentState`, `AgentErrorPayload`, `QueueEntry`, `ToolDisplayData` come from `@abacus-ai/agent`'s wire types (agent spec §2.3; the browser-safe `tool-display` entry pattern extends to a type-only import, which carries no runtime code).

### 4.2 Event → store → component mapping

`applyEvent(state, seq, chunk)` is pure. `ChatClient` handles message parts independently from the same chunk. Columns: what the agent emits (agent spec §2.3/§3), what `StreamProcessor` makes of it (verified in `processor.ts`), what the store records, and which component renders it.

| AG-UI event (agent spec) | `StreamProcessor` → `UIMessage` part | Store | Component |
|---|---|---|---|
| `RUN_STARTED {runId, metadata.abacus.serverInitiated?}` | `activeRuns.add` (`:2115`); client `sessionGenerating` | `runs.active = { runId, startedAt: now, serverInitiated }`; clear `tools.*` of finished runs | `BusyLine` (sessions: "Working 12.4s"), `Typing` bubble (bots), Stop button |
| `RUN_FINISHED {outcome: success}` + `usage[]`, `metadata.abacus.{turnUsage, stopReason}` | finalize (`:2131-2161`) | `runs.last = byId[runId] = { kind: "success", usage, steps }`; `active = null` | `RunMarker` "Done in 48s, 7 steps" (sessions), usage in its hover card; nothing for bots |
| `RUN_FINISHED {outcome: cancelled}` | finalize | `kind: "cancelled"` | `RunMarker` "Stopped" (muted) |
| `RUN_ERROR {code, message, metadata.abacus.error}` | empty assistant message if none active (F12); `onError(Error{code})` | `kind: "error"`, `error` | `ErrorCard` with actions (§5.6); `queued`/`rejected`/`agent_*` handled per §4.6 |
| `TEXT_MESSAGE_START/CONTENT/END {role: "assistant"}` | `text` part (`:1221-1350`, `:1772-1848`) | — | `TextPart` via `Markdown` (§7) inside `BotMessage` bubble or `SessionMessage` prose |
| `TEXT_MESSAGE_* {role: "user"}` (`runId:user`, `steer-N`) | user message with a `text` part (role kept from `START`, `:1228-1231`) | — | user bubble (bot tint) / right-aligned muted bubble (sessions); `@path` lines → attachment chips (§8.6) |
| `REASONING_START … REASONING_END` | `thinking` part (`:2375-2412`) | — | `ThinkingPart`: registry `Marker` + `Collapsible`, shimmer while it is the message's last part and the run is active (§5.3) |
| `TOOL_CALL_START {toolCallName, parentMessageId, metadata.abacus.rawName}` | `tool-call` part, `state: awaiting-input` | — | `ToolLine` "runs" + title from `buildToolTitle(name, parsePartialJSON(arguments))` |
| `TOOL_CALL_ARGS` | `arguments` grows, `input-streaming` | — | title updates |
| `TOOL_CALL_END {metadata.tanstack.input}` | `input` set, `input-complete` | — | title from the final `input` (agent spec §3.3.5) |
| `CUSTOM tool.output {toolCallId, output}` (R) | forwarded to `onCustomEvent` (`:2632-2639`) | `tools.output[key] = output` (replace, as today, §12.7) | `BashExpander` live tail |
| `CUSTOM tool.display {toolCallId, data}` (R) | forwarded | `tools.display[key] = data` | `DiffExpander` (edit/write) before the result |
| `TOOL_CALL_RESULT {content: JSON(ToolResultContent), metadata.tanstack.{state, toolResultOutcome}}` | `output = JSON.parse(content)`; `tool-result` part with `state: complete \| error`, `outcome: denied \| cancelled` (`:2045-2112`) | drop `tools.output[key]` (the result carries `terminal.output`) | `ToolLine` status: `done` / `failed` / `refused` (denied) / `stopped` (cancelled, or `unfinished`) and the expander content from `output` |
| `SUBAGENT_STARTED {subagentRunId, name, description, parentToolCallId}` | `subagent` part on the current assistant message (`:1081-1121`) | — | `SubagentCard` (§5.5) |
| child events tagged `subagentRunId` | routed to the card's child processor (`:1178-1219`) | `tools.*` keyed with the child's `subagentRunId` | card body via `<Parts/>` |
| `SUBAGENT_FINISHED {result, outcome}` / `SUBAGENT_ERROR {code, message}` | card `status: finished \| error`, `error` (`:1123-1151`) | — | card status dot and sub-line ("Done, 30 steps, 3m 38s", "Stopped at its limit") |
| `STATE_SNAPSHOT {AgentState}` | ignored (`:764`) | `agent = value`; `incarnation = value.incarnation` | `ModeChip`, `ModelChip` value, `TasksSummary` ("Tasks 2 of 4") |
| `STATE_DELTA [ops]` | ignored | `agent = applyPatch(agent, ops)` (§4.3) | same |
| `CUSTOM permission.requested` / `permission.pending` / `permission.resolved` / `permission.cleared` / `permission.response_rejected` (S) | forwarded to `onCustomEvent` | `permissions.items = pending.items` (authoritative); `answering[id]` updates (§6.3) | `PermissionCard` in the composer slot (sessions) or inline (bots), `PermissionList`, ToolLine "needs you" |
| `CUSTOM queue.updated {messages, dequeued}` (S) | forwarded | `queue = messages.filter(m => !m.hidden)` | `QueueSlot` rows (Edit, Remove) |
| `CUSTOM queue.steered` / `queue.dequeued` (R) | forwarded | — | nothing (the user `TEXT_MESSAGE_*` that follows renders the message) |
| `CUSTOM agent.status {status}` (S) | forwarded | `activity.status` | typing caption fallback, sound intents |
| `CUSTOM agent.heartbeat {runningTools}` (S) | forwarded | `activity.runningTools` | `BusyLine` "Running 2 tools" |
| `CUSTOM agent.retry {attempt, maxAttempts, delayMs, isNetworkError}` (R) | forwarded | `activity.retry` (cleared on the next text/tool event or terminal) | `BusyLine` "Retrying, 2 of 5" |
| `CUSTOM agent.error` (S, non-terminal) / `agent.notification` (S) | forwarded | `notices.push` (deduplicated by `notificationKey`) | `Notice` rows above the composer (actions as buttons, §5.6) |
| `CUSTOM session.ready {incarnation, …}` (S) | forwarded | `incarnation`; drop descriptors of another incarnation | — |
| `CUSTOM session.cleared` (S) | forwarded | reset store except `agent`, `skills` | `client.setMessagesManually([])` |
| `CUSTOM skills.loaded {skills}` (S) | forwarded | `skills` | `/` menu |
| `CUSTOM run.ack`, `wire.hello`, `wire.compat_lost`, `mcp.*` | forwarded | ignored (main or Library consume them) | — |
| `CUSTOM abacus.subscribed` / `abacus.resync` (main, transport A.3) | never reach the client | — | adapter (§3.3) |
| any other `CUSTOM` name | forwarded | ignored; dev builds log once per name | — |

**Usage.** `RUN_FINISHED.usage` follows `@ag-ui/core` accounting (agent spec §3.3.8: `inputTokens` includes cache reads and writes; `totalTokens = inputTokens + outputTokens`). The hover card shows "In 12.3k (8.1k cached) · Out 1.2k"; the canvas has no usage UI, so this is the minimal surface. Settings › Usage (phase 5) owns the full view.

**Steps count** for "Done in 48s, 7 steps" = the parent message's `tool-call` parts of that run, counted at the terminal (children count inside their own card).

### 4.3 `STATE_DELTA` application

The agent emits `replace /mode`, `replace /modeSource`, `replace /model` and `add /plan` (agent spec §3.3.2). `json-patch.ts` implements RFC 6902 `add`, `replace` and `remove` on object paths (JSON Pointer with `~0`/`~1` unescaping) plus array index `-`; any other op, or a path into a missing parent, is ignored and the store requests a fresh snapshot by setting `agent = null` until the next `STATE_SNAPSHOT` or hydrate. Replaying an already-applied delta is harmless (the store guard skips `seq ≤ appliedSeq`, and `add`/`replace` of these paths are idempotent anyway). R2-T9.

### 4.4 Busy

```ts
busy(threadId) = sessionsRow.turn?.isBusy === true        // db.sessions turn column (transport A.2.3, B.2): pending | streaming | waiting_permission
              || store.runs.active !== null                // RUN_STARTED seen, terminal not yet
              || chat.isLoading                            // a local send in flight before RUN_STARTED
```

Any one of them makes the composer busy. The turn column is main's own view derived from compat (agent spec §3.1.6); the other two close the window before the turn column's change batch arrives (§8.3).

### 4.5 Stop

`runtime.cancel(threadId)` calls `ai.cancel({ threadId, runId })` with `runId = store.runs.active?.runId ?? chat.runId` (the client-generated id of a send that has not yet seen `RUN_STARTED`, `chat-client.ts:2481`; the agent applies `cancel {runId}` to a run whose admission is still preparing, agent spec §3.8). The UI never calls `useChat().stop` or `SubagentHandle.stop` (F11). The run settles with `RUN_FINISHED {cancelled}`, which resolves `processingComplete` normally. Stop is shown only while busy; a second press while cancelling is ignored until the terminal (button shows a spinner). The sub-agent card's Stop calls the same function (agent spec §3.6: it stops the whole turn, as today).

### 4.6 Run errors and send failures

`conn.onClientError(error)` receives the `Error` that `runErrorEventToError` builds (`code` copied from the event, `@tanstack/ai/src/utilities/errors.ts:80-94`) or a thrown send error.

| Case | Detect | Handling |
|---|---|---|
| `RUN_ERROR {code: "queued"}` (§3.3) | `error.code === "queued"` | Remove the optimistic user message and the empty assistant message the processor created (F12): `setMessagesManually(messages.filter(m => m.id !== userId && !(m.role === "assistant" && m.parts.length === 0 && after(userId))))`. The text is already in the queue slot (`queue.updated`). No error card. |
| `RUN_ERROR {code: "rejected", message: reason}` | `code === "rejected"` | `regenerate_unsupported` never happens (the kit does not offer regenerate after success); `empty` cannot (empty sends are blocked); `resume_unsupported` cannot (no resume). Any of them: same cleanup, restore the draft, inline composer error "The agent didn't accept that message." |
| `RUN_ERROR` with agent codes (`turn_failed`, out of credits, `stall`, `compat_lost`, `agent_exit`, `agent_crashed`, `inactivity_timeout`) | any other code | `ErrorCard` after the run's messages with `metadata.abacus.error.actions` (§5.6). `agent_exit`/`agent_crashed`: title "The agent stopped unexpectedly" plus Retry. |
| `ai.send` throws `UNAVAILABLE` / `TIMEOUT` | thrown in `send` | Remove the optimistic user message, restore the draft, composer error "The agent isn't ready. Try again." with Retry (re-submits the draft). |
| `ai.send` throws `NOT_FOUND {entity: "thread" \| "session"}` | thrown | The thread is gone: composer turns read-only "This conversation no longer exists." (stale thread, §12.5). |
| `ai.send` throws `CONFLICT` | thrown | Treated as `queued`: re-route the text through `ai.queue.enqueue` and clean up as above. |

The client's own `status: "error"` is not shown directly; errors render only from `runs.byId` and the composer error state, so a cleaned-up `queued` never flashes a generic error.

**Retry** (ErrorCard action `retry`, and after `cancelled`): `chat.reload()`, which removes messages after the last user message and re-sends it (`:2793-2823`); the agent admits it as a retry because the previous run for that message ended in `RUN_ERROR` or `cancelled` (agent spec §3.1.4). `reload()` is never offered after a successful run.

---

## 5. Message rendering (`createChatUI`)

### 5.1 Kit configuration

```ts
const options = { /* type-only: no tools or interrupts are declared */ } as const;
export const SessionUI = createChatUI(options, {
  components: { layout: ChatLayout, message: SessionMessage, input: ComposerSlot },   // `queue` not set: QueueSlot reads the store (§8.5)
  partsComponents: { text: TextPartView, thinking: ThinkingView, image: ImageView, document: DocumentView, fallback: UnknownPart },
  toolsComponents: toolWidgets,             // Proxy (§5.2)
  subagentsComponents: subagentWidgets,     // Proxy (§5.2)
});
export const BotUI = createChatUI(options, { …same, components: { layout: ChatLayout, message: BotMessage, input: ComposerSlot } });
```

Both are created once at module scope (`createChatUI` binds widgets once, `create-ui.tsx:361-376`). `ChatView` picks one by `skin`. The kit's `Interrupts` slot is not placed in the layout (F13); `Queue` renders nothing because no `queue` component is registered (`:555-570`), which is intended: `ChatClient`'s local queue is always empty (F1).

`ChatLayout({ Messages, Input })`:

```
<MessageScrollerProvider autoScroll defaultScrollPosition="last-anchor">
  <Transcript>                      §10: Viewport + Content(role=log, aria-busy) + <Messages/> + RunTail + NewMessagesMarker + ScrollButton
  <Notices/>                        agent.notification / non-terminal agent.error rows
  <PermissionList placement/>       §6.2
  <QueueSlot/>                      §8.5
  <Input/>                          ComposerSlot: the composer, or the permission card that takes it over (sessions), or read-only banner
</MessageScrollerProvider>
```

`RunTail` renders after the last message: `BusyLine` or `Typing` while a run is active, then `RunMarker` / `ErrorCard` for the latest terminal. Older runs' outcomes render after the last message of that run when `metadata.abacus.run` is present on it (§14.7); without it (older transcripts) nothing is shown for past runs.

### 5.2 Tool and sub-agent widget maps

```ts
export const toolWidgets = new Proxy(KNOWN_TOOL_WIDGETS, {
  get: (known, name) => typeof name === "string" ? (known[name] ?? ToolLine) : undefined,
}) as Record<string, ComponentType<ToolProps<typeof options>>>;
export const subagentWidgets = new Proxy({}, { get: (_t, name) => typeof name === "string" ? SubagentCard : undefined });
```

- `KNOWN_TOOL_WIDGETS` maps display names to `ToolLine` with a fixed expander: `bash` → `BashExpander`; `read`, `batch_file_read` → `ReadExpander`; `write`, `edit`, `ast_edit`, `batch_edit`, `notebook_edit` → `DiffExpander`; `browser_*` → `BrowserExpander`; `todo` → `ToolLine` with no expander (the plan shows in the context tab). Everything else resolves to `ToolLine` with `GenericExpander` (the vendored `formatted` markdown, or `text`).
- `collectInlineToolNames` runs `Object.keys` on the tool map (`create-ui.tsx:411-414`); with no `interruptsComponents.tools` it returns names that are never read, so the proxy's key list does not matter. The lookup at `:725` is a plain property get, which the proxy answers.
- Sub-agent names emitted today are `delegate` (`delegate-tool.ts:104`, `document-tool.ts:116`, `deck-tool.ts:124`, `design-tool.ts:137`), `browser` (`browser-task-tool.ts:248`) and `component` (agent spec §3.3.2). All render `SubagentCard`, varying only the kind label.
- `SubagentCard` renders its body with `<Parts/>` and **no** `partsComponents`/`toolsComponents` props, so `SubagentMessages` reuses the outer widget context (`:923-933`) instead of spreading the proxy.
- R2-T12 renders an MCP tool name (`mcp__linear__create_issue`) and an unknown sub-agent name and asserts the generic widgets, no warning, no throw.

### 5.3 Parts

- **`TextPartView`** → the kit's `Markdown` (§7) with the message role. Assistant text in sessions is plain prose (SessionRunning "Agent prose"); in bots it sits in a `BubbleContent`.
- **`ThinkingView`** (not on the canvas; PLAN "Marker + shimmer, collapsible"): registry `Marker` with `role="status"`, `MarkerIcon` (lucide `Brain`), `MarkerContent className="shimmer"` "Thinking" while the part is the last part of a message whose run is active; afterwards "Thought for 12s" (duration from the part's first and last content arrival, kept in a `WeakMap` keyed by the part object, else just "Thoughts"), collapsed by default, `Collapsible` reveals the text in a muted, `whitespace-pre-wrap` block rendered as markdown. The `ThinkingPart` component from ai-react is not used (it hard-codes English strings and an emoji, `thinking-part.tsx:64-75`).
- **`ImageView` / `DocumentView`**: registry `Attachment` (`variant="image"` media for images). The agent emits none today; they exist for hydrated legacy transcripts converted by main (spec 00 C) and user attachments (§8.6).
- **`UnknownPart`** (`fallback`): renders nothing in production; a dev-only muted row with the part type.
- **Empty assistant message** (F12): `BotMessage`/`SessionMessage` return `null` when `parts.length === 0`.

### 5.4 `ToolLine` (session step rows, canvas SessionRunning)

One row, mono 12 px, `min-h-7`: **status word**, **title**, **meta**, then an expander chevron when there is detail.

| Condition (part / result / store) | Status word (i18n) | Colour token |
|---|---|---|
| `state ∈ {awaiting-input, input-streaming, input-complete}` and no result, run active | "runs" + `shimmer` on the title | `text-orange-*` via `--chat-status-running` |
| a pending descriptor joins this call (§6.2) | "needs you" | `--chat-status-attention` |
| result `state: complete` | "done" | `--chat-status-done` (green) |
| result `state: error`, `outcome: denied` | "refused" | `--chat-status-muted` |
| result `state: error`, `outcome: cancelled` or `output.unfinished` | "stopped" | `--chat-status-muted` |
| result `state: error`, no outcome | "failed" | `--destructive` |
| no result and the run is no longer active (hydrated history without a result) | "stopped" | muted |

- **Title**: `buildToolTitle(part.name, input)` from `@abacus-ai/agent/tool-display` (agent spec §3.3.5, §6.1), where `input = part.input ?? parsePartialJSON(part.arguments) ?? {}`; the title always reflects the final input once `input-complete` (agent spec finding 25; R2-T13 asserts the rendered title equals `buildToolTitle` of the final input).
- **Kind icon**: `toToolKind(name)` → lucide icon (read `FileText`, edit `FilePen`, execute `Terminal`, search `Search`, fetch `Globe`, think `Bot`, switch_mode `ListChecks`, other `Wrench`), `aria-hidden`.
- **Meta** (`tool-meta.ts`, pure): edit/write → `+{additions} -{deletions}` from `output.display` or `tools.display[key]`; read → "lines {a} to {b}" from input offset/limit and `display.lineCount`; grep → "{n} matches" parsed from `text` when it is the grep tool's count line; bash → elapsed while running (from the part's first arrival), then exit status from `text` when `rejected`; others → none.
- **Expanders** (`Collapsible`, closed by default, `aria-expanded` on the row button):
  - `BashExpander`: the command (from input), then `terminal.output` from the result or `tools.output[key]` while running, in a mono block capped at 400 px with its own scroll, auto-following the tail while running unless the user scrolled it.
  - `DiffExpander`: unified diff built from `display.originalContent` → `display.newContent` (or `finalContent`); lines coloured as the canvas PermissionStates diff (`#2a1618`/`#fca5a5`, `#13261a`/`#86efac` mapped to `--chat-diff-del-bg/-fg`, `--chat-diff-add-bg/-fg` tokens defined for light and dark), highlighted per line with the file's language (§7.4). Diffs over 2,000 lines show the first 400 with "Show all".
  - `ReadExpander`: the returned text (first 200 lines) highlighted by extension, with "Open file" calling `onOpenFile`.
  - `BrowserExpander`: action and URL from input; screenshot when the result content carries an image part.
  - `GenericExpander`: `output.formatted` (vendored `formatToolContent` markdown, agent spec §6.2) through the kit's `Markdown`, else `output.text` as preformatted text.
- **Bot skin**: tool rows are not shown inline (the canvas bot boards show none). Each bot message with tool calls gets one `Marker` row "Worked through {n} steps" (a `Collapsible` revealing the same `ToolLine`s); the running tool's title is the typing caption ("Browsing news.example.com", BotChatPanel).

### 5.5 `SubagentCard` (canvas SubAgents)

- Rows of a grouped card (radius 12, `bg-muted`, 52 px rows): status dot (running orange, finished green, error red), name = `description ?? kindLabel(name)`, sub-line: running → the latest child tool title and "{n} steps"; finished → "Done, {n} steps, {duration}"; error → `error.message` ("Stopped at its limit" is the agent's text for that case) in red. Adjacent sub-agent parts of one message group into one card (`BusyLine` shows "Waiting on {k} agents").
- Expanding a row shows the child's messages via `<Parts/>` (ToolLines, final text) inside a `SubagentScope` context that provides `subagentRunId`, so nested ToolLines compute their permission key and live-output key (§4.1).
- Actions: **Open** (`onOpenSubagent(id)`, sessions: the side-panel "Agents" tab, phase 4; hidden when the prop is absent) and **Stop** (only while `status === "running"`; `runtime.cancel(threadId)`, §4.5; confirm with a tooltip "Stops the whole reply").
- `suspended` (child interrupts) never occurs (no native interrupts); rendered as running.

### 5.6 Status components

- **`BusyLine`** (sessions): orange dot, label, mono elapsed ("Running tests 12.4s" on the canvas: label = the running tool title if exactly one, "Running {n} tools" if several, "Waiting on {k} agents" when sub-agents run, "Retrying, {a} of {m}" during `agent.retry`, "Needs you" while a descriptor is pending, else "Working"). Elapsed from `runs.active.startedAt`, updated once per second by a single interval in the layout (no per-row timers).
- **`Typing`** (bots): a bubble with three dots using the canvas `bob` keyframes (1.2 s ease-in-out infinite, delays 0/.15/.3 s) plus the caption; reduced motion → static dots.
- **`RunMarker`** (sessions): green dot "Done in {duration}, {steps} steps" (SessionReview), muted "Stopped" for `cancelled`; hover card with usage (§4.2).
- **`ErrorCard`** (SessionFailed): destructive tint, title = `error.message`, sub = `error.detail`/`segmentData.message`, actions from `error.actions` (`NotificationAction`, `protocol.ts:49-55`):

  | `action.type` | Button | Effect |
  |---|---|---|
  | `retry` | "Retry" | `chat.reload()` (§4.6) |
  | `switch-model` with `model` | "Continue on {label ?? model}" (today's `workspace.premiumUpgrade.continueOn`) | `composer.model.onChange(model)` |
  | `switch-model` without `model` | "Switch model" | opens the model picker |
  | `upgrade-abacus`, `free-pool-out` | the **upgrade variant** of the card | ported from `components/chat/premium-upgrade-card.tsx`: `wantsUpgradeCard`, `exhaustedScope` ("abacus" vs "pool" title) and `freeModelSwitches` (`:186-212`) verbatim, and its top-up CTA opening `ABACUS_BUY_CREDITS_URL` or `ABACUS_PLAN_URL` by account tier (`:113-122`, tier from the `account.*` query) |
  | unknown with `link` | `action.label ?? "Open"` | `system.openExternal({ url: link })` |
  | unknown without `link` | not rendered | — |

  The action types the agent produces today are exactly `switch-model`, `retry`, `upgrade-abacus` and `free-pool-out` (`packages/agent/src/session.ts`, e.g. `:1400`, `:1558`, `:2264`).

  "Stop" is added while the run is still active (it never is after a terminal; kept for notices).
- **`Notice`**: registry `Marker variant="border"` rows for `agent.notification` (severity icon, message, actions as above) and non-terminal `agent.error`; dismissible; keyed by `notificationKey` so a repeated key replaces its row.
- **`ChangesCard`** ("1 file changed +24 -5 [Undo] [Review changes]") is phase 4 (it needs git state); the kit exposes the `RunTail` slot where the route places it.

---

## 6. Permissions

### 6.1 Store and lifecycle

The descriptor store is the latest `permission.pending.items` (authoritative after every change, agent spec §3.5.1). `permission.requested`/`resolved`/`cleared` update `answering` and drive sounds and announcements; the item list itself comes only from `permission.pending` and the hydrate snapshot. On `session.ready` with a new incarnation, items of other incarnations are dropped (agent spec §3.5.5).

### 6.2 Placement

| Skin | Joined to a mounted tool part (`(subagentRunId ?? "", toolCallId)`) | Not joined (no `toolCallId`, housekeeping, part not mounted) |
|---|---|---|
| sessions | The **oldest** pending descriptor takes over the composer slot (canvas PermissionStates: "Permission prompts take over the composer"); its ToolLine reads "needs you" with a "Show" link that focuses the card. With several pending, the card header shows "1 of 3" and the next one follows when this one resolves. | Same composer-slot card. |
| bots | Inline card in the transcript at the tool's position, inside the bot message (BotApproval) | `PermissionList` above the composer |

`PermissionList` is the application-owned list of agent spec §3.5.5, subscribed to the store, rendering every descriptor that no mounted widget renders. "Mounted" is tracked by a registry the inline widgets write to in an effect (`registerInline(key)` / cleanup), so a descriptor whose tool part is paged out or collapsed in a sub-agent card still shows in the list. The notch (phase 6) mounts the same component.

### 6.3 Answering

`runtime.respondPermission(descriptor, decision)`:

1. Validate `decision` against `descriptor.metadata.abacus.allowed` (`decisions.ts`; a widget that offers a disallowed decision is a bug, caught by R2-T23).
2. `answering[id] = { decision, since: now }`: buttons disabled, a spinner on the chosen one.
3. `ai.respondPermission({ threadId, lineage: descriptor.metadata.abacus.lineage, decision })` (§14.6).
4. Resolution arrives on the stream:
   - `permission.resolved {permissionId}` + `permission.pending` without it → the card leaves (motion §9.1);
   - `permission.response_rejected {lineage, reason}` → `answering[id]` cleared and an inline message on the card: `not_pending` "Already answered" (the card leaves with the following `permission.pending`); `incarnation` "The agent restarted. This request is gone."; `thread`/`turn` "This request belongs to an earlier turn."; `invalid_decision`/`decision_not_allowed` "Couldn't send that answer" (and a bug report).
5. No resolution within 10 s → `answering[id]` cleared, inline "No response from the agent. Try again."
6. The procedure itself throwing (`UNAVAILABLE`) → same as 5, immediately.

Answered elsewhere (second window, notch, browser auto-allow): the descriptor simply disappears with the next `permission.pending`; a click racing it gets `not_pending` (step 4). Expiry: `permission.cleared {expired}` + `pending` → the card leaves; the ToolLine then shows "refused" from its result (`tool_blocked {expired}` → `denied`, agent spec §3.5.5).

### 6.4 Cards per request kind (labels from canvas PermissionStates, SessionFailed, BotApproval)

Buttons: primary = white/foreground, secondary = `variant="secondary"`, deny = `variant="ghost"` after a spacer; `…` = "Add a note" (expands a textarea; with text the allow button sends `accept_with_message`, deny sends `reject_with_message`, as today `chat-composer.tsx:420-435`).

| `request.type` | Title / body | Buttons → decision |
|---|---|---|
| `run_terminal` | "Run this command?", right label = mode ("Supervised"); mono `command`; `cwd` muted | [Allow once] → `"accept"`; [Always allow {rule}] → `{type:"allow_always_with_rules", rules:[rule]}` with `rule = "Bash(" + command.slice(0,120) + (command.length>120 ? "…" : "") + ")"` (F20); [Deny] → `"reject"`; [`…`] note. `background: true` requests add [Run in background] → `"background"`. |
| `run_terminal` with `credentialPaths` | orange dot "This command reads saved credentials"; the paths listed | [Allow once] secondary → `"accept"`; [Deny] **primary** → `"reject"`; [`…`]; no "Always" |
| `edit_file`, `write_file`, `notebook_edit` | "Edit {basename}?" / "Create {basename}?" with `+a -d`; inline diff (first 12 changed lines, "Show all" opens `DiffExpander` content in a dialog) | [Allow once] → `"accept"`; [Always accept edits this session] → `"allowAlways"`; [Deny] → `"reject"`; [`…`] |
| `delete` | "Delete {basename}?" | [Allow once], [Deny], [`…`] |
| `read_/write_/edit_/notebook_edit_outside_directory` | "Reach outside the folder?" `resolvedPath` | [Allow once] → `"accept"`; [Always allow {deducedDirectory}] → `"allowAlways"` (scopes to that directory, agent spec §3.5.2); [Deny] |
| `network_host` | "Connect to {host}?" "The sandbox blocked this host. Allowing it lets the command download packages." | [Allow once] → `"accept"`; [Always allow this host, this session] → `"allowAlways"`; [Deny] → `"reject"` |
| `sandbox_denied` | orange dot "The sandbox refused something this command tried"; mono `command`; denials as "write {path}" / "read {path}" / "reach {host}" with the verb in red; `note`; "If you allow it, the command runs again with that access." | [Allow once] → `"accept"`; [Always allow these this session] → `"allowAlways"`; [Deny] → `"reject"` |
| `fetch_url` | "Open {origin}?" full `url` in mono | [Allow once], [Always allow this site, this session] → `"allowAlways"`, [Deny] |
| `browser_action` | "{description}" + `url` | [Allow once], [Deny] (auto-allowed kinds never show: they resolve through main's auto-allow, agent spec §3.5.6; the card may flash for one frame at most, so it renders only after 150 ms pending) |
| `generic` | "Use {toolName}?" `inputSummary` | [Allow once], [Always allow] → `"allowAlways"`, [Deny] |
| `exit_plan_mode` | "Ready to build this plan?" with `planContent` as markdown (numbered list) | stacked, full width: [Yes, and approve each edit] → `"accept"`; [Yes, and accept all edits] → `"allowAlways"`; [Yes, with full access] (orange) → `"allowYolo"`; [No, keep planning] → `"reject"`; note field → `accept_with_message`/`reject_with_message` |
| `ask_user_question` | registry `Questionnaire` (§6.5) | [Next]/[Submit] → `{type:"question_answers", answers}`; [Skip all] → `"reject"` |
| bot skin, any kind | Canvas BotApproval: "Allow" (not "Allow once"), "Always allow …", "Deny", right-aligned "Also in the notch" (phase 6 shows it; the kit renders it when `notchEnabled` prop is true) | same decisions |

The allowed set per kind is exactly agent spec §3.5.2; a button whose decision is not in `descriptor.metadata.abacus.allowed` is not rendered (R2-T23 walks every kind).

Keyboard on a card: focus moves to the primary button when the card appears and the composer had focus; `Mod+Enter` = the primary action; `Escape` closes an open note field only (never denies).

### 6.5 Questions

`ask_user_question` → registry `Questionnaire` (clone `questionnaire.tsx`, primitive `@shadcn/react/questionnaire`): one `QuestionnaireItem` per question (`name = "question_" + i`, `multiple = multiSelect`), `QuestionnaireChoice` per option (label + `QuestionnaireChoiceDescription`), `shortcuts="letters"` (canvas "A 960…"), `QuestionnaireProgress` ("1 of 2"), an optional "Add a note" `QuestionnaireInput type="text"`, `QuestionnairePrevious`/`Next`/`Submit`. On submit (`FormData`), `answers["question_" + i] = labels.join(", ") + (note ? " — " + note : "")`, skipping unanswered items, exactly as `chat-composer.tsx:1018-1037` (F19). The primitive's own keyboard (letters, arrows, `Mod+Enter`) applies (clone `use-questionnaire-root.ts:361-461`).

---

## 7. Markdown, code and math

### 7.1 Component

```ts
export function Markdown({ content, role, streaming }: { content: string; role: "user" | "assistant" | "system"; streaming: boolean }) {
  const source = rewriteMath(content);                        // §7.3, pure, memoised by the compiler on `content`
  return <TextPart content={source} role={role} highlighter={highlight} components={MARKDOWN_COMPONENTS}
                   className="chat-prose" />;
}
```

- `TextPart` adds `streamingMarkdownExtension()` (trims trailing empty headings, list items and blockquotes) and passes `frontmatter={false} headingIds={false}` (`text-part.tsx:78-93`). Raw HTML stays escaped (`allowHtml` is never set) and `sanitizeUrl` keeps only relative, `#`, `http(s):`, `mailto:`, `tel:` URLs.
- `@tanstack/markdown` re-parses the whole string on every render (`dist/react.js:6-8`); for long streaming replies the kit splits `content` at the last blank line outside a fence into a stable prefix and a live tail rendered as two `TextPart`s, **only** when the prefix is ≥ 4 KB and the split point is not inside a list, blockquote or table (checked by a small line scanner). R2-T18 asserts identical DOM for split and unsplit rendering across all fixtures.
- `MARKDOWN_COMPONENTS` (tag-name map, `dist/react.js:166-169`): `a` → `ChatLink` (§7.5); `pre` → `CodeBlock` (§7.4); `code` → `InlineCode` (§7.3); `table` → wrapped in a horizontally scrolling `div` with `scroll-fade-x`; `img` → lazy, max-width 100%, click to open in a dialog.
- Streamed text gets no per-token motion; the last block fades in over 80 ms via CSS on `.chat-prose > :last-child` while `streaming` (PLAN motion table).

### 7.2 Styling

`chat-prose` is a small hand-written CSS block in `features/chat/markdown/prose.css` using theme tokens (headings, lists, tables, blockquote, hr, inline code) at the mira density (`text-sm`, 1.6 line height). No `@tailwindcss/typography` (not in the dependency set).

### 7.3 Math with temml

**Pre-pass** (`math-prepass.ts`, pure). It scans the raw string once, skipping fenced code blocks (``` and ~~~), indented code and inline code spans, and rewrites only **closed** spans (PLAN: "math renders only once an expression is closed while streaming"):

| Source | Closed when | Rewritten to |
|---|---|---|
| `$$…$$` (may span lines) | a matching `$$` follows | a fenced block ```` ```math ```` with the TeX body |
| `\[…\]` | a matching `\]` follows | same |
| `\(…\)` | a matching `\)` on the same paragraph | inline code with the sentinel `U+2062` + TeX, fenced with enough backticks to contain the body |
| `$…$` | the closing `$` is on the same line, the opening `$` is followed by a non-space, the closing `$` is preceded by a non-space and **not** followed by a digit (pandoc's rule, so "$5 and $6" stays text) | same as `\(…\)` |

Unclosed spans are left untouched and render as text until they close (then the next render shows math). The pre-pass runs before `@tanstack/markdown` parses, so the backslash-escape problem (F9) never applies.

**Rendering.**

- Display: `highlight(code, lang)` is our `CodeHighlighter` (synchronous, returns trusted HTML, `types.d.ts:159-180`). For `lang === "math"` it returns `temml.renderToString(tex, { displayMode: true, throwOnError: false, trust: false, maxExpand: 1000 })`, cached in a bounded `Map` (500 entries) keyed by the TeX string. `CodeBlock` (the `pre` override) sees `data-lang="math"` and renders a `div.chat-math` instead of the code chrome.
- Inline: `InlineCode` checks for the sentinel prefix on its string child and renders `<span className="chat-math-inline" dangerouslySetInnerHTML={{ __html: renderInline(tex) }} />` with `displayMode: false`; otherwise a normal `<code>`.
- Errors: with `throwOnError: false`, temml returns `<span class="temml-error">…ParseError…</span>` with escaped text (`temml.js:103-111`); the kit styles `.temml-error` with `--destructive` and shows the raw TeX in a tooltip. Undefined macros render as red `<mtext>` (strict off), same styling.
- Safety: `trust: false` (no `\href`, `\url`, `\includegraphics`), `macros` from a frozen empty object per call (temml strips the prototype). temml output is MathML only; no scripts or event attributes (R2-T19 fuzzes 200 hostile inputs and asserts the output contains no `<script`, `on*=`, `javascript:`).
- Import: `import temml from "temml"` (default only, F9). Fonts: `temml/dist/Temml-Local.css` + `Temml.woff2` (9.4 KB, the script-capitals font), bundled by Vite as assets; the math font stack falls back to the OS (`"Cambria Math", "STIX Two Math", math`). Latin Modern (380 KB, recommended by temml's README for Chromium) is **not** bundled in r1; see §16.
- Size: `temml.mjs` is ~480 KB unminified (168 KB minified). It is loaded lazily: the pre-pass is synchronous and cheap, and the first message that contains closed math triggers `import("temml")`; until it resolves the math renders as its raw TeX in `chat-math-pending` style, then re-renders. The chunk is prefetched on idle after the first chat view mounts.

### 7.4 Code blocks

- `highlight = createTanStackMarkdownHighlighter(createHighlighter({ languages: [all 26 from @tanstack/highlight/languages] }))` (`markdown.js:100-121`, `core.d.ts:83`), except the `math` branch above. Theme: `createThemeCss({ light: githubLight, dark: githubDark, darkSelector: ".dark", codeBlockSelector: ".chat-prose pre.tm-code" })` injected once as a `<style>` by the chat module (F17).
- `CodeBlock` wraps `pre.tm-code` with a header: language label (`data-lang`), Copy button (copies the text content of `code`; "Copied" swap-label for 1.2 s), and for `diff`/`patch` the add/delete colours from §5.4. Blocks over 30 lines collapse to 30 with "Show {n} more".
- An unclosed fence renders as a normal block while streaming (the markdown parser runs a fence to end of input, `parser.js:103-125`); the header shows no Copy button until the message's run is no longer active.
- Languages without a grammar (Go, Rust, Java, C/C++, …) render escaped plaintext with the same chrome (F17).

### 7.5 Links

`ChatLink`: `http(s):`/`mailto:` → `system.openExternal` (the link has `href` for accessibility, `onClick` prevents default); an absolute path or `file://` URL, or a relative path resolved against the session's workspace → `onOpenFile(absPath)` (Files tab in sessions, PLAN "File links open the Files tab"); without `onOpenFile`, `system.showItemInFolder({ path })`. Anything `sanitizeUrl` stripped arrives as plain text and stays text.

---

## 8. The composer

### 8.1 Structure (compound, `input-group` based)

```tsx
<Composer.Root threadId skin mode="full|mini" state={resting|focused|typing|busy|dictating|blocked}>
  <Composer.Attachments/>                   registry AttachmentGroup of chips (scroll-fade-x)
  <Composer.Field/>                         InputGroupTextarea, auto-grow to 200 px (COMPOSER_MAX_HEIGHT as today)
  <Composer.Row>
    <Composer.Attach/>                      "+" → menu: "Files or images", "Folder" (Pickers board)
    <Composer.ModeChip/>                    sessions only (showModeChip)
    <Composer.Spacer/>
    <Composer.ModelChip/>                   when `composer.model` is provided
    <Composer.Dictate/>                     slot; states only in phase 2
    <Composer.Send/> | <Composer.Stop/>
  </Composer.Row>
  <Composer.Context>{slots.composerContext}</Composer.Context>   the context tab under the box (sessions)
</Composer.Root>
```

Geometry from canvas ComposerStates / BotChat / SessionRunning / FullView:

| Skin / mode | Resting | Focused / typing / attachment | Busy |
|---|---|---|---|
| bot, full | one-line pill 52 px, radius 999: [Attach 36 px] placeholder [Dictate] [Send] (send filled with `--bot-accent` only when there is text) | box radius 22: attachments row, text, bottom row [Attach] spacer [Send] | placeholder "Add to the queue, or stop"; [Stop] (white circle, 10 px square) replaces Send; typing text shows Send again (enqueue) |
| session, full | two-row box 100–104 px, radius 20: row 1 text; row 2 [Attach] [Mode chip] spacer [Model chip] [Dictate] [Send] | same box, grows | placeholder "Steer the run, or queue the next step"; [Stop] |
| session, mini (FullView) | one-line pill: `+` "Reply, or steer the run" [Send] | two rows with mode and model chips; the context strip appears | as full |
| 800 px band (W800) | model chip becomes an icon button, `aria-label="Model: {name}"` | same | same |

Width: edge to edge inside the pane, `max-width: 680px` (WidthRules), centred.

### 8.2 Chips

- **`ModeChip`** (sessions): value from `store.agent.mode` (or the draft before the runtime exists); menu `DropdownMenu` 340 px, items title + muted description, exactly the canvas "Session, permission mode open" table:

  | Label | Description | `AgentMode` (`protocol.ts:10-18`) |
  |---|---|---|
  | Auto | Sandboxed, no prompts | `AUTO` |
  | Supervised | Approve edits and commands one by one | `DEFAULT` |
  | Auto-accept edits | Change files, ask before commands | `ACCEPTEDITS` |
  | Plan | Read and propose, change nothing | `PLAN` |
  | Full access | No approvals (title in orange) | `YOLO` |

  Selecting calls `agent.setMode({ workspaceId, sessionId, mode })` when the runtime is live (`store.incarnation !== null`), shows the new value optimistically with a pending dot, and reverts if no `STATE_DELTA /mode` confirms within 5 s (toast "Couldn't change the mode"). Before the runtime exists (new session), the choice lives in the draft store and is sent once as `forwardedProps.mode` on the first send (agent spec §2.2), and cleared after. The chip on the canvas carries an icon before the label; the menu has none. `Full access` is orange in both. While the menu is open the composer collapses to a single 56 px row (canvas).
- **`ModelChip`**: `composer.model = { value: string; label: string; onChange(id): void; groups: ModelGroup[]; layoutId?: string }`, supplied by the route (sessions: `agent.setModel` + `store.agent.model`; bots: the bot's persistent model, phase 3). The popover shell (340 px, "Search models", grouped items, a "Connect …" row per group, canvas "Session, model picker open" and Pickers) takes `groups` as props. The chip turns into a pill (`bg-secondary`) while the picker is open. `layoutId` enables the chip ↔ Details-row morph (§9.2).

### 8.3 Submit routing (`routeSubmit`, pure, R2-T20)

```ts
type SubmitRoute =
  | { kind: "noop" }                                         // empty text and no attachments
  | { kind: "blocked"; reason: "read-only" | "question-pending" | "uploading" | "loading" }
  | { kind: "send"; content: MultimodalContent; forwardedProps?: { mode?: AgentMode; model?: string } }
  | { kind: "enqueue"; text: string };
routeSubmit({ text, attachments, busy, readOnly, questionPending, preStart, hydrated }): SubmitRoute
```

- `send`: `chat.sendMessage({ content: finalText, id: "u-" + crypto.randomUUID() }, preStart ? { body: forwardedProps } : undefined)`. The known id lets §4.6 remove exactly this message on `queued`/`rejected`/throw. The draft clears optimistically and is restored on those failures.
- `enqueue`: `runtime.queue.enqueue(threadId, finalText)` → `ai.queue.enqueue`. The draft clears when the procedure resolves; on error it stays with an inline error. The queued text appears through `queue.updated` (never from local state), so a second window sees it too.
- `blocked`: `question-pending` when an `ask_user_question` descriptor is pending (its card owns the slot); `uploading` while an attachment is still saving; `loading` until the first hydrate of this connection has resolved. `hydrateFromServer` skips applying its result when a send started while the fetch was in flight (`chat-client.ts:1176-1177`), which would leave the transcript empty; blocking sends until then removes that case (the gate's `setTimeout(0)` fallback still opens the subscription if it ever happens).
- A send dropped by the `QueueStrategy` backstop (F1) resolves without adding the message; the handler detects that its message id is absent from `getMessages()`, restores the draft and re-routes the text through `enqueue`.
- `busy` is §4.4. The composer never calls `sendMessage` while busy (agent spec §3.1.6); the `QueueStrategy` backstop (F1) only catches bugs.
- **Session titling** (ported from `conversation/transport.ts:94, 497-525` and its tests, transport-bridge "naming a session from its first message"): on the first `send` of a session whose `collections.sessions` row label is `"Untitled"` or blank, `deriveSessionTitle(text)` (copied verbatim) is written with `collections.sessions.update(id, { label })`; empty titles (e.g. a code-only message) are skipped; failures are swallowed and never block the send.

### 8.4 Keyboard

| Keys | Where | Action |
|---|---|---|
| `Enter` | field, not composing (`event.nativeEvent.isComposing === false`), no trigger menu open | submit (`routeSubmit`) |
| `Shift+Enter` | field | newline |
| `Mod+Enter` | field | submit even when a trigger menu is open |
| `ArrowUp` | empty field, queue non-empty | edit the last queued item (moves its text into an inline editor on its row) |
| `Escape` | field | closes an open trigger menu; otherwise blurs (the bot pill collapses) |
| `Mod+.` | anywhere in the thread view, busy | Stop (`useAppHotkey`, foundation §7.9; registered once per mounted `ChatView`, `enabled` only when that view is the focused thread) |
| `@` | sessions field | file mention menu from `composer.mentions` (registry `Combobox` anchored above the box, canvas "Session, picking a file with @"); inserts `@relative/path` |
| `/` | at the start of the field | skills menu from `store.skills`; inserts `/name ` |

All composer shortcuts are element-level `onKeyDown` handlers on the field (not global), so they never collide with the app's hotkey manager; `Mod+.` is the only global one and is registered through `useAppHotkey`.

### 8.5 Queue slot (canvas "Bot, working, with a message waiting", SessionRunning)

`QueueSlot` renders `store.queue` above the composer: one 40 px row per entry, radius 12: text (one line, ellipsis), a muted hint by `waitingFor` ("Sends at the next step" for `step`, "Waits for your answer" for `permission`, "Sends after this reply" for `turn`), [Edit] and [Remove] (`aria-label="Remove queued message"`). Edit turns the row into an inline input; Enter → `ai.queue.update({ threadId, id, message })`, Escape cancels. Remove → `ai.queue.remove({ threadId, id })`. Both are keyed by entry id (§14.6); a `CONFLICT` (the entry left the queue) shows "That message already went out" and refreshes from the next `queue.updated`. More than 3 entries collapse into "{n} more waiting" with a disclosure.

### 8.6 Attachments

Parity with today (`chat-panel.tsx:1395-1455`): attachments reach the agent as `@<absolute path>` lines appended to the text (`text + "\n\n" + refs.join("\n")`), and the agent reads them from disk.

- **Picked or dropped files** with a real path: `transport.host.getPathForFile(file)` (spec 00 A.4.4) → the path is used directly; chip state `done`.
- **Pasted data** (clipboard images, dropped blobs without a path): chip `uploading` while `files.savePastedTemp({ baseFolder: attachmentsBase, files: [{ name: id + "." + ext, data }] })` runs (extension rule copied from `chat-panel.tsx:1403-1410`); then `done`, or `error` with the message and a Remove action. Disabled when `attachmentsBase` is null (tooltip "Pasting files isn't available here").
- **"Files or images"** (Attach menu): `system.dialog.openFiles({ kind: "all" })` returns `PickedFile[]` with `path` (`shared/contract/system.ts:48-53`) → `@<path>` lines; chip state `done`.
- **"Folder"** (Attach menu): `system.dialog.openFolder()` (`system.ts:47`) → an `@<path>` line.
- Chips: registry `Attachment` (image media for images: object URL of the local file, revoked on removal; file icon and "PDF, 412 KB" description otherwise), `AttachmentAction` Remove. `AttachmentGroup` scrolls horizontally with `scroll-fade-x`.
- **Transcript rendering**: a user message whose text ends with lines of the form `@/abs/path` renders those lines as attachment chips under the bubble (BotChat "contract-v3.pdf" card) and the rest as text. Images show a thumbnail through `files.readImageAsDataUrl({ filePath, hostRoot })` (lazy, only in view).

### 8.7 Draft store

`draft-store.ts`: a TanStack Store keyed by `threadId` with `{ text, attachments, mode?, model? }`, persisted to `sessionStorage` per document (lost on quit, kept across HMR and route switches). The bot pill's focused/resting state is derived (focus or non-empty draft), not stored.

---

## 9. Motion

All values come from `lib/motion.ts` (foundation §7.8) plus the chat-specific constants in `features/chat/motion.ts`; every `motion/react` transition goes through `motionFor(pref, full, reduced)`, and reduced motion turns layout animations into cuts and everything else into a 120 ms fade (PLAN §Motion system). `motion/react` APIs used: `motion.*`, `AnimatePresence` (`mode="popLayout"`), `LayoutGroup`, `layoutId`, `useReducedMotion` (present in the installed `framer-motion` 12.43 types; `motion@13.4.6` re-exports `framer-motion@^13.4.6`, so R2-T27 type-checks them against the pinned version).

### 9.1 Owners

| Moment | Owner | Spec |
|---|---|---|
| Composer pill ↔ box (bot focus, mini ↔ focused full view) | `motion/react` `layout` on `Composer.Root`'s surface, shared `layoutId="composer:{threadId}"` | 240 ms `easings.standard`; children (`Row`, `Context`) fade in 120 ms **after** the surface settles (`transition.delay = durations.layout - durations.childFade`) and out immediately |
| Model chip ↔ Details model row (bots) | `layoutId="model:{botId}"` inside a `LayoutGroup` the route provides around the chat and the details panel | 240 ms; the label cross-fades 120 ms |
| Permission card takes over the composer / hands it back | `AnimatePresence mode="popLayout"` in `ComposerSlot` | card enters `y: 8 → 0`, opacity 0 → 1 over 200 ms; the composer exits with opacity only (120 ms); the slot height animates with `layout` |
| Queue rows in/out | `AnimatePresence` + `layout` | height + opacity 160 ms |
| New message rows | CSS `@starting-style` on `[data-slot=message-scroller-item][data-fresh]` | opacity 0 → 1 and `translateY(4px)` → 0 over 160 ms; `data-fresh` set only for messages that arrive live (not hydrated, not history pages) |
| Streamed text | none per token; last block fades 80 ms (§7.1) | — |
| Running tool title, thinking marker | registry `shimmer` utility (`shadcn/tailwind.css`) | `shimmer-none` under reduced motion |
| Typing dots | canvas `bob` keyframes | static under reduced motion |
| ToolLine / thinking expanders | registry `Collapsible` (Base UI, `data-starting-style`/`data-ending-style`) | registry-owned |
| Thread switch, drill in/out | foundation pane `<ViewTransition>` (`nav-lateral`, `nav-forward`) | unchanged; the chat adds no transition types |

### 9.2 View transitions and the chat

The chat adds **no** `<ViewTransition>` boundaries and no transition types in phase 2. Two rules keep it compatible with the foundation's pane transition (foundation §6.7):

1. Streaming updates are ordinary state updates, never inside `startTransition`, so they never start a view transition (a view transition only runs for updates inside a transition).
2. The transcript must be at its opening scroll position before the pane transition snapshots the new page: the registry viewport is `invisible` while `data-pending-scroll` is set (`@shadcn/react ≥ 0.3.1`, F15), and hydrate resolves before first paint when primed (§3.2). R2-T28 (Electron) navigates between two long threads with `nav-lateral` and asserts the new snapshot shows the bottom of the transcript.

Reserved for phase 3/4 (not built here): `bot-identity-{botId}` (foundation §6.7) and a sub-agent card → Agents tab morph.

---

## 10. The transcript scroller

- Registry `MessageScrollerProvider autoScroll defaultScrollPosition="last-anchor" scrollPreviousItemPeek={64}` → `MessageScroller` → `MessageScrollerViewport` (`scroll-fade-b`, as registry) → `MessageScrollerContent` (`role="log"` default, `aria-busy={runActive}`) → one `MessageScrollerItem messageId={m.id} scrollAnchor={m.role === "user"}` per message, rendered by the kit's `message` component.
- **Stick to bottom**: `autoScroll` follows the end while streaming; a user scroll up (wheel, touch, keys, scrollbar drag) releases it (clone controller `:148-177`, `:632-643`). New user turns anchor to the top of the viewport with a 64 px peek of the previous message ("anchored turns", `:437-461`).
- **Scroll button**: `MessageScrollerButton direction="end"` bottom-centre above the composer, `inert` when inactive (registry behaviour). Not on the canvas; PLAN "jump-to".
- **New-message marker** (the registry has none, clone docs `message-scroller.mdx:40`): `NewMessagesMarker` tracks the id of the first message that arrived while `useMessageScrollerScrollable().end === true` (the user is away from the end). It renders a registry `Marker variant="separator"` with the accent line and label "{n} new" before that message (canvas BotChannel "2 new"), and the scroll button shows the count as a badge. It clears when that message becomes visible (`useMessageScrollerVisibility().visibleMessageIds`) or when the user sends.
- **History paging**: when the viewport reaches the start and `chat.hasOlderMessages`, call `chat.loadOlderMessages()` (`:3224-3254`; the adapter forwards `before` to `ai.hydrate`, §3.3 step 1). Prepend preservation keeps the viewport stable (`preserveScrollOnPrepend`, controller `:424-435`); a `Skeleton` row shows while loading; a failed page shows "Couldn't load earlier messages" + Retry.
- **Day separators** (BotChat "Today"): a `Marker variant="separator"` before the first message of each local calendar day, from `message.createdAt` (hydrated dates are normalised by the client, `normalizeMessagesDates`).
- **Scroll fade at the top** (BotChatScrolled): the viewport's `scroll-fade-t` when scrolled.

---

## 11. Fixtures and gallery

### 11.1 Fixture player

`fixtures/player.ts` builds a fake `AppClient` slice (`ai.subscribe`, `ai.send`, `ai.hydrate`, `ai.joinRun`, `ai.cancel`, `ai.respondPermission`, `ai.queue.*`) over a scenario, and the **real** `createThreadConnection` runs on top of it, so every fixture exercises the adapter, the gate, the store and the kit exactly as production does.

```ts
interface Scenario {
  id: string;                                   // "session-running", "permission-edit", …
  canvas: string[];                             // board ids it reproduces (canvas-map.ts)
  skin: "bot" | "session";
  snapshot: ThreadSnapshot & { messages: UIMessage[] };   // what ai.hydrate returns
  events: Array<{ seq: number; event: StreamChunk; delayMs?: number }>;
  onSend?: (input) => Array<{ event: StreamChunk; delayMs?: number }> | { ack: "queued" | "rejected" };
  onRespond?: (lineage, decision) => Array<{ event: StreamChunk }>;
}
```

- `?fixture=<id>&step=end` (default) replays everything at once; `step=<n>` stops after the n-th event (deterministic screenshots of mid-stream states); `play=1` replays with the recorded delays.
- **Recorded scenarios**: the agent's golden AG-UI fixtures (`packages/agent/src/agui/__fixtures__/*.agui.jsonl`, agent spec §7.1) are copied by `scripts/sync-chat-fixtures.mjs` into `fixtures/scenarios/` with sequence numbers added; R2-T29 fails when a copy differs from its source, so the kit always renders what the agent actually emits.
- **Canvas scenarios** that the agent goldens do not cover (a credits banner, a rate-limit error card with its three actions, a queued message while working, three sub-agents with the three statuses, a WhatsApp read-only thread) are written with `builders.ts`, typed as `@ag-ui/core` events (`EventType`), and validated by R2-T29 against the same `AguiEvent` type the agent uses.

### 11.2 Gallery sections

`chatGallerySections` adds these to `/__ui` (the `[__ui].tsx` route passes them into the gallery, §14.8): `chat-transcript`, `chat-tools`, `chat-permissions`, `chat-questions`, `chat-subagents`, `chat-composer`, `chat-errors`, `chat-markdown`. Each section lists its scenarios with the canvas board ids they reproduce. `canvas-map.ts` is the coverage table:

| Canvas board (page) | Scenario ids |
|---|---|
| BotChat, BotChatScrolled (1) | `bot-chat`, `bot-chat-scrolled` |
| SessionRunning (1) | `session-running` (step rows, busy line, queue row, composer busy, Tasks 2 of 4) |
| BotApproval, BotChatPanel, BotChannel, BotStates, BotDetails (2) | `bot-approval-inline`, `bot-typing`, `bot-unread-marker`, `bot-banners`, `bot-model-chip` |
| Main, MainCollapsed, FullView, FullViewFocused, SplitView, SubAgents, SessionFailed, SessionBrowser, SessionReview, SessionWorkspaceMissing (3) | `session-new`, `session-mini`, `session-mini-focused`, `session-split`, `session-subagents`, `session-failed-ratelimit`, `session-sandbox-refused`, `session-browser`, `session-review`, `session-workspace-missing` |
| ComposerStates (4) | `composer-bot-resting`, `composer-session-resting`, `composer-bot-attachment`, `composer-mention`, `composer-dictating`, `composer-model-open`, `composer-bot-queue`, `composer-mode-open` |
| PermissionStates (4) | `perm-run-command`, `perm-credentials`, `perm-edit-file`, `perm-network-host`, `perm-exit-plan`, `perm-question` |
| Pickers (4) | `picker-model`, `picker-provider-disconnected`, `picker-attach`, `dictation-sequence`, `dictation-errors` |
| ReadOnlyStates (4) | `readonly-telegram`, `readonly-answering`, `readonly-routine-run`, `readonly-folder-gone` |
| W800, W900, BW800–BW1000 (6) | the above at the foundation §10.2 widths (its screenshot script) |

Components owned by later phases (the bot avatar in the header, the Changes card, the side-panel detail tab, the notch mirror, dictation audio) appear in the scenarios as static placeholders so the chat part of the board is complete. R2-T29 asserts every board in the table has at least one scenario and every scenario id resolves.

---

## 12. Accessibility and edge cases

### 12.1 Screen readers

- The log is the registry `role="log"` content with `aria-relevant="additions"`; `aria-busy="true"` while a run is active, so streaming token churn is not announced piecemeal (registry docs `message-scroller.mdx:609-616`).
- A separate visually hidden `role="status"` region announces run milestones once each: "Reply finished", "Stopped", "Error: {message}", "Needs your approval: {title}", "{n} new messages". Announcements are debounced to one per 500 ms.
- ToolLine status is text ("done", "runs", "failed", "refused", "stopped", "needs you"), never colour alone; the expander is a `button` with `aria-expanded` and `aria-controls`.
- Permission and question cards are `role="group"` with `aria-labelledby` the title (not modal dialogs: the transcript stays readable and scrollable); focus moves to the primary button only when the composer had focus (§6.4).
- Every icon-only button has an `aria-label` (Attach, Dictate, Send, Stop, Remove queued message, Add a note, Model: {name}); mode and model chips are `button`s with `aria-haspopup="menu"`/`"listbox"`.
- The composer textarea has an accessible name from the placeholder via `aria-label` (placeholders are not labels).
- Colours: every chat token pair (`--chat-status-*`, diff add/del, bot bubble text on `--bot-accent`) meets 4.5:1 in both themes; R2-T26 runs axe on each gallery scenario (foundation R1-T8 pattern) with `color-contrast` on in the screenshot run.

### 12.2 Reconnect mid-run

Iterator error → reopen from `yieldedSeq` (§3.3); in the ring → seamless; evicted → `abacus.resync` → `detach()`/`attach()` → hydrate + join. The permission and queue stores are replaced from the snapshot, so a card answered during the gap disappears and one raised during the gap appears. R2-T4.

### 12.3 Run finished while unmounted

Unmount → `detach()` and deferred `dispose()` (`use-chat.ts:398-446`); the connection keeps its store (LRU) but closes its iterators (the subscription generator ends when the client's signal aborts). Remount → new client → `attach()` → hydrate: the transcript now contains the finished run (and `metadata.abacus.run` for its outcome, §14.7); no join because `activeRun` is null. R2-T7.

### 12.4 Permission answered elsewhere

Covered in §6.3 (second window, notch, auto-allow, expiry). R2-T22.

### 12.5 Stale thread

- The session row is deleted (`db.sessions` delete) while the view is open: the route's `notFound` (phase 3/4) unmounts the view; the kit also stops sending on `NOT_FOUND` from any `ai.*` call and turns the composer read-only (§4.6).
- The agent process restarted (new incarnation, `session.ready`): descriptors of the old incarnation are dropped; a `RUN_ERROR {agent_exit | agent_crashed}` already closed the run; queued messages come back through the next `queue.updated`.
- Reset (`session.cleared`): messages cleared, stores reset (§4.2).
- Workspace folder missing (SessionWorkspaceMissing): the route passes `composer.readOnly` ("Can't send: {path} no longer exists."); the transcript stays readable.

### 12.6 Queue while busy

§8.3/§8.5. The two-window race (`queued` ack) is §3.3 + §4.6. R2-T21.

### 12.7 Other cases

| Case | Behaviour |
|---|---|
| `ai.*` answers `UNAVAILABLE` before the emitter lands (transport A.3 `UnavailableAguiSource`) | Hydrate fails → `ChatClient.failHydration` sets `error` (`:1234-1250`); the view shows "The agent isn't available yet" with Retry (`client.detach(); client.attach()`), composer disabled. |
| Two tabs of the same thread in one document (mini composer + full view) | One connection (§3.1), one `ChatClient` per mounted `useThreadChat`; only the `ChatView` that owns the transcript mounts `useThreadChat`; the mini composer is inside it. |
| Server-initiated run (routine, messaging, dequeue) while idle | Arrives on the live subscription (`live: true`); `RUN_STARTED` → busy; the user `TEXT_MESSAGE` shows the message; nothing special. |
| Hidden bot housekeeping permission (no `runId`) | `PermissionList` (bots) / composer slot (sessions); lineage validates by `turnSeq` (agent spec §3.5.3). |
| Very long tool output | Each `tool.output` **replaces** the buffer, exactly as today's transport does with `tool_output_update` (`conversation/transport.ts:379-394` passes `event.output` through as the card's whole output); the agent forwards pi's `partialResult` unchanged (`session.ts:2529-2538`). Whether pi's `partialResult` is cumulative is not re-verified here; replacement keeps today's rendering either way. The expander renders only the last 2,000 lines with "Show all" opening a dialog. |
| HMR of kit modules | `createChatUI` configs are module singletons; Fast Refresh re-creates them, the connection cache lives on `globalThis[Symbol.for("abacus.chat.connections")]` like the transport (foundation §8.1), so streams survive a component edit. |

---

## 13. Tests

Projects: **jsdom** = vitest project `renderer-next` (foundation §3.7); **Electron** = `main-serial` using the A-T12 harness (isolated profile + CDP, as foundation R1-T11b/R1-T22); **type** = `tsc -b` plus `expectTypeOf` in the jsdom project. The fake `AppClient` is the fixture player (§11.1) unless a test says "memory transport" (the real `RPCHandler`/`RPCLink` over a `MessageChannel`, foundation `createMemoryTransport`, with a fake `AguiSource` in main).

| Id | File | Runs in | What it proves |
|---|---|---|---|
| R2-T1 | `runtime/gate.test.ts` | jsdom | `CursorGate`: closed on hydrate-with-activeRun; opens at the cursor after one macrotask when no join starts; opens at `max(cursor, lastJoinSeq)` when a join ends, is refused, times out, or is aborted by `detach`; re-closes on a new hydrate. |
| R2-T2 | `runtime/connection.test.ts` | jsdom (memory transport + fake `AguiSource`) | Adapter contract: `abacus.subscribed` swallowed; every yielded chunk has its seq applied to the store; `lastEventId` sent on reopen equals `yieldedSeq`; `hydrate` with `before` is a pure page; `send` sends only the last user message and the client `runId`; `send`'s abort signal never calls `ai.cancel`. |
| R2-T3 | `runtime/ordering.test.ts` | jsdom | Property test (seeded, 2,000 sequences): hydrate at `N` with an active run, random interleavings of join replay, live events, reconnects and `localQueue` terminals; the client processes every seq in `(0, max]` exactly once and in order, and the final `getMessages()` equals a single continuous processor fed the same events (agent spec §7.8 invariant on the renderer side). |
| R2-T4 | `runtime/reconnect.test.ts` | jsdom (memory transport) | Mid-run iterator error with the resume point in the ring → no gap or duplicate; resume point evicted → `abacus.resync` → `detach`/`attach` → hydrate + join → same final messages and stores as an uninterrupted client; three consecutive failures → `connectionStatus: "error"` and the Reconnecting notice; Retry recovers. |
| R2-T5 | `runtime/rejoin-keeps-history.test.ts` | jsdom | F2: with the amended hydrate (messages end with the active run's user message), a mid-run reload keeps the previous run's assistant reply; with a hydrate that **excludes** the active run (the r3 wording), the test demonstrates the loss (documents why §14.1 is required). |
| R2-T6 | `runtime/user-message-transcript.test.ts` | jsdom (memory transport + main relay fake) | F3: a message sent from this window appears live in a second window, in a later hydrate and in the persisted transcript with the same id; the sending window ends with exactly one user message with unchanged text after the relayed `TEXT_MESSAGE_*` (dedup Case 2 plus `updateTextPart` replacement); a multi-line and a 20 KB message included. |
| R2-T7 | `runtime/unmounted.test.ts` | jsdom | A run finishes while the view is unmounted; remount hydrates the finished transcript, no join, no busy state, no leaked iterator (the fake counts open iterators: 0 after dispose). |
| R2-T8 | `store/apply.test.ts` | jsdom | The §4.2 table row by row: each event updates exactly the documented slice; `permission.pending` is authoritative over `requested`/`resolved`; `seq ≤ appliedSeq` is ignored; `session.ready` with a new incarnation drops old descriptors; `session.cleared` resets; unknown CUSTOM names are ignored. |
| R2-T9 | `store/json-patch.test.ts` | jsdom | `add`/`replace`/`remove`, pointer escaping, `add /plan` when absent (agent spec finding 19), idempotent re-application, unsupported op → `agent = null` until the next snapshot. |
| R2-T10 | `store/busy.test.ts` | jsdom | `busy` is true from submit to terminal across: the turn column arriving before and after `RUN_STARTED`, a send before `RUN_STARTED`, a server-initiated run, a permission wait. |
| R2-T11 | `kit/parts.test.tsx` | jsdom | Real `createChatUI` over fixture messages: text, user text with `@path` chips, thinking (shimmer while last and active; collapsed after), empty assistant message renders nothing (F12), unknown part renders nothing in production. |
| R2-T12 | `kit/widget-maps.test.tsx` | jsdom | F7: an MCP tool name and an unknown sub-agent name render `ToolLine` and `SubagentCard`; no `console.warn`, no throw; a card's nested `<Parts/>` still resolves unknown tool names (proxy not spread). |
| R2-T13 | `kit/tool-line.test.tsx` | jsdom | Status words for every §5.4 row, from recorded fixtures (bash streamed, edit approved, edit denied, stop mid-call, unfinished); title equals `buildToolTitle(name, finalInput)` after `TOOL_CALL_END` and uses `parsePartialJSON` before (agent spec §7.6 "Title and kind" moved here); meta strings; expanders show `tool.output` live and `terminal.output` after the result. |
| R2-T14 | `kit/subagents.test.tsx` | jsdom | Parallel delegates with colliding legacy ids stay apart; child results render before the error status (agent spec §3.1.5 order); status sub-lines; Stop calls `ai.cancel({ threadId, runId: parentRun })`, never `handle.stop` (F11); Open calls `onOpenSubagent`. |
| R2-T15 | `kit/status.test.tsx` | jsdom | `BusyLine` labels (one tool, several tools, sub-agents, retry, needs you); `RunMarker` duration and steps; `ErrorCard` action table incl. unknown actions and the upgrade variant; `Notice` dedup by `notificationKey`. |
| R2-T16 | `scroller/transcript.test.tsx` | jsdom (stubbed geometry) + Electron | jsdom: `messageId`/`scrollAnchor` per message, `aria-busy` while active, new-message marker count and clearing, `loadOlderMessages` on reaching the start. Electron: `data-pending-scroll` is present before the first paint and the first captured frame shows the end (F15); prepend keeps the first visible message at the same offset (±1 px). |
| R2-T17 | `markdown/markdown.test.tsx` | jsdom | Headings, lists, tables (scroll wrapper), code blocks with header and Copy, links routed by §7.5 (http → `openExternal`, abs path → `onOpenFile`), raw HTML escaped, `javascript:` link rendered as text, an unclosed fence renders as a block without Copy while streaming. |
| R2-T18 | `markdown/split.test.tsx` | jsdom | The stable-prefix split produces the same DOM as a single render for every fixture's final text and at every 64-byte streaming step; lists, blockquotes and tables across the split point are never split. |
| R2-T19 | `markdown/math.test.ts` | jsdom | Pre-pass table (§7.3): closed vs unclosed for all four delimiters, streaming prefixes of each, `$5 and $6` stays text, math inside code fences and inline code untouched; display math → `math` fence → MathML with `display="block"`; inline → sentinel inline code → MathML; parse errors render `.temml-error`; `import temml from "temml"` works and named imports are not used (a lint-level grep); 200 hostile inputs produce no `<script`, `on*=`, or `javascript:`. |
| R2-T20 | `runtime/route-submit.test.ts` | jsdom | `routeSubmit` truth table: noop, blocked (read-only, question pending, uploading), send (with `forwardedProps` only pre-start), enqueue when busy; IME `isComposing` never submits; `deriveSessionTitle` ported cases (placeholder renamed, user title kept, failure does not block, code-only skipped). |
| R2-T21 | `runtime/queue.test.ts` | jsdom (memory transport) | Busy submit calls `ai.queue.enqueue`, never `sendMessage`; the row appears only from `queue.updated`; Edit/Remove send entry ids; `CONFLICT` shows the notice; the two-window race: `ai.send` returns `queued` → the synthesised `RUN_ERROR {queued}` settles `sendMessage()` **before** the running turn ends, the optimistic user message and the empty assistant message are removed, and the text is in the queue slot. |
| R2-T22 | `kit/permissions.test.tsx` | jsdom | Placement per skin (§6.2): composer takeover (sessions), inline + `PermissionList` fallback (bots), a descriptor whose part is not mounted shows in the list; two parallel descriptors answered in reverse order; answered elsewhere removes the card; `response_rejected` reasons map to the §6.3 messages; 10 s timeout re-enables; expiry removes only its own card (agent spec §7.5 renderer half). |
| R2-T23 | `kit/permission-decisions.test.tsx` | jsdom | For every `request.type` in agent spec §3.5.2: the rendered buttons send exactly the decisions in that table, never one outside `allowed`; the `run_terminal` rule text equals today's `Bash(...)` fallback (F20); notes produce `accept_with_message`/`reject_with_message`; credentials card has no "Always". |
| R2-T24 | `kit/question.test.tsx` | jsdom | The questionnaire encodes answers byte for byte like `chat-composer.tsx:1018-1037` (single, multi, note, skipped question) (F19); letters shortcuts and `Mod+Enter` work; "Skip all" sends `"reject"`. |
| R2-T25 | `composer/composer.test.tsx` | jsdom | Geometry state machine per skin/mode (§8.1 table), Stop replaces Send while busy, mode chip labels/descriptions/values and optimistic revert after 5 s without `STATE_DELTA`, pre-start mode goes out once as `forwardedProps.mode`, attachments (path, pasted → `savePastedTemp`, error chip, disabled without base), `@`/`/` menus insert text, `ArrowUp` edits the last queued item, `Mod+.` stops only in the focused view. |
| R2-T26 | `gallery/a11y.test.tsx` | jsdom | axe (`color-contrast` off in jsdom, as R1-T8) over every chat scenario; the status region announces each milestone once; every icon button has a name; cards are `role="group"` with a label. |
| R2-T27 | `motion.types.test.ts` + `motion.test.tsx` | type + jsdom | `motion/react` exports used here type-check against the pinned `motion`; with reduced motion, layout animations are cuts and fades are 120 ms; the composer's children delay equals `durations.layout - durations.childFade`. |
| R2-T28 | `e2e/chat-transitions.mjs` | Electron | A `nav-lateral` switch between two long threads starts one view transition whose new snapshot shows the transcript end; a streaming update never starts a view transition (`document.activeViewTransition` stays null during a replayed stream). |
| R2-T29 | `fixtures/fixtures.test.ts` | jsdom | Copied agent goldens equal their sources; builder scenarios type-check as `AguiEvent`; every canvas board in `canvas-map.ts` has a scenario; every scenario replays to completion with no warnings. |
| R2-T30 | `guards.test.ts` (extends R1-T15) | jsdom | AST scan: renderer-next never calls `agent.respondPermission`, `agent.queue.*`, `useChat().stop`, `.stop()` on a `SubagentHandle`, or imports `temml` by name; `features/chat` imports no other feature; only `features/chat/index.ts` is imported from routes. |
| R2-T31 | `perf/transcript.bench.test.tsx` | Electron | Budget for F10: a 600-message thread with 3,000 parts hydrates to first paint in < 400 ms and scrolls at ≥ 55 fps median on an M-series Mac; streaming 20 KB of markdown keeps main-thread tasks < 50 ms at p95. Informational in r1 (records numbers in the PR); a failure opens the virtualisation follow-up rather than failing CI. |
| R2-T32 | `e2e/chat-real-session.mjs` | Electron (real agent, fake provider) | The phase gate (§15): a real session streams text, a `bash` tool with live output, an `edit` that raises a permission answered with "Allow once", the tool result, and `RUN_FINISHED`; a reload mid-stream resumes without loss or duplicates; Stop mid-run ends with "Stopped"; a busy submit steers the turn. |

---

## 14. Amendments this spec requires elsewhere

1. **Agent spec §5.3 / transport A.3 `ai.hydrate`** (F2): `messages` for a thread with an active run = the persisted transcript **plus** the active run's messages as main's live processor holds them at the checkpoint (at minimum its opening user message). Output type becomes `ChatHydrationResult & { abacus: ThreadSnapshot }`:

   ```ts
   interface ThreadSnapshot {
     cursor: number;                                            // relay seq N of the checkpoint
     incarnation: string | null;
     activeRun: { runId: string; startedAt: number; serverInitiated: boolean } | null;
     permissions: PermissionDescriptor[];                       // live incarnation only
     queue: QueueEntry[];
     agent: AgentState | null;
     skills: SkillMetadata[];
   }
   ```

   All fields are read in the same synchronous relay turn as the transcript (agent spec §5.3 point 3).
2. **Agent spec §3.1.3 / §5.3 point 1** (F3): for a run acked `started`, main's relay emits, immediately after that run's `RUN_STARTED`, a user `TEXT_MESSAGE_START {role: "user", messageId: <client message id>}` + one `TEXT_MESSAGE_CONTENT` with the message text + `TEXT_MESSAGE_END`, taken from `ai.send`'s last user message. They get relay sequence numbers like any other event, so they reach the transcript processor, the active-run log, the ring and every window. `queued`/`rejected`/`duplicate` emit nothing. (Alternatively the agent emits them for `run` too; either side works as long as the id is the client's.)
3. **Transport A.3 `ai.joinRun`** (F5): yields **every** relay event of the thread whose seq lies in `[RUN_STARTED.seq, terminal.seq]`, session-scoped ones included, each with `withEventMeta(event, { id: String(seq) })`.
4. **Transport A.3 `ai.subscribe`**: `lastEventId` means "events with seq greater than this"; the first yield stays `abacus.subscribed`.
5. **Agent spec §3.1.6 / §5.2 and transport A.3 `ai.send`** (F6, F1): output `{ runId: string; status: "started" | "queued" | "rejected" | "duplicate"; reason?: "regenerate_unsupported" | "empty" | "resume_unsupported" }`, resolved from the agent's `run.ack` for that run id. Main injects no per-subscription terminal. `forwardedProps.whenBusy` is removed from the transport row. `whenBusy: "error"` is replaced by the `QueueStrategy` backstop (F1).
6. **New procedures** (F16), in `contract.ai`:

   | Procedure | Input | Output | Maps to |
   |---|---|---|---|
   | `ai.respondPermission` | `{ threadId, lineage: PermissionLineage, decision: PermissionDecision }` (decision validated by a valibot union mirroring `protocol.ts:256-266`) | `void` (the outcome arrives as `permission.resolved` / `permission.response_rejected` on the stream) | `permission.respond` (agent spec §2.2) |
   | `ai.queue.enqueue` | `{ threadId, message }` | `void` | legacy `enqueue {message, hidden: false}` |
   | `ai.queue.update` | `{ threadId, id, message }` | `void`, `CONFLICT` if `id` is not in main's latest `queue.updated` | legacy `update_queue_item {index}` with the index resolved from that snapshot at call time |
   | `ai.queue.remove` | `{ threadId, id }` | same | `remove_from_queue {index}` |
   | `ai.queue.clear` | `{ threadId }` | `void` | `clear_queue` |

   The index is resolved in main at call time; a drain between that and the agent processing the command can still hit the wrong entry. That residual window is today's behaviour (legacy commands are index-based) and is recorded as a risk (§16). `agent.respondPermission` and `agent.queue.*` stay for the old renderer only.
7. **Run outcome in the transcript** (§5.1): at each terminal, main stamps `metadata.abacus.run = { runId, kind, startedAt, endedAt, steps, usage?, error? }` on the run's last assistant message (creating none if the run produced no message), so outcomes survive reload. Optional for the kit: without it, past runs show no marker.
8. **Foundation spec**: `createAppRouter` adds `chat: ChatRuntime` to `RouterContext` (§6.4, already anticipated); the gallery accepts extra sections from the `[__ui].tsx` route (`<Gallery sections={[...base, ...chatGallerySections]}/>`), keeping the rule that features do not import each other; R1-T15 gains the R2-T30 checks; the `@shadcn/react ^0.3.1` pin is a phase-2 prerequisite (F15).
9. **Dependencies** (desktop `devDependencies`, per the app's convention): add `@tanstack/ai-react` **0.29.3** exact (peers `@tanstack/ai ^0.63.0`, `react >=18`, optional `@mcp-ui/client`); add `temml` **0.13.5** exact; keep `@tanstack/ai` 0.63.0, `@tanstack/ai-client` 0.36.0, `@tanstack/markdown` 0.0.13, `@tanstack/highlight` 0.0.10 (already present). Not added: `@shadcn/helpers` (F8), `@tanstack/react-virtual` (F10). The AI devtools plugin (`@tanstack/react-ai-devtools` 0.2.71) is left out of r1: its peer range against ai-client 0.36 was not checked.
10. **PLAN.md**: `whenBusy` wording (host queue, `QueueStrategy` backstop); virtualisation replaced by paging for now (F10); fixtures by replaying agent goldens (F8); the chat kit lives in `features/chat` composed by routes (PLAN's `components/chat-kit` and `components/composer` folders are not created); math via a pre-pass (F9).

---

## 15. Acceptance

**Build and rules**
- [ ] `typecheck`, `lint`, `format:check`, `check:knip-next`, `check:i18n` (new keys under `chat.*`, reused strings mapped through `scripts/locale-keymap.json` from `workspace.perm.*`, `permissions.*`, `workspace.attach.*`) and `test:unit` are green; R2-T1…R2-T30 pass; R2-T31 numbers are recorded in the PR.
- [ ] No file under `src/renderer` changes except locale additions; no `ui/` diff (`check:ui-registry`).
- [ ] The built renderer-next bundle contains `temml` only in a lazy chunk.

**Canvas pages 1–4 (fixtures, screenshots at 1280 and 800, light and dark, via the foundation screenshot script)**
- [ ] Every scenario in §11.2 renders its board's chat content: bubbles with the bot tint, session prose and step rows, busy line with elapsed time, queue rows with Edit/Remove, composer in each state, both chips, the permission-mode menu with the five modes and descriptions, every PermissionStates card with the canvas labels, the plan card's four stacked choices, the questionnaire "1 of 2", sub-agent rows with three statuses, the rate-limit error card with "Switch to Abacus.AI", "Retry in 41s", "Stop", the sandbox-refused card, read-only banners, "2 new" marker, "Today" separator, typing dots.
- [ ] axe reports no violations (contrast included in the real-layout run).

**Real session (R2-T32, also done by hand on macOS)**
- [ ] A new session streams markdown with a code block and inline and display math; a `bash` tool streams output live in its expander; an `edit` raises "Edit {file}?" in the composer slot; "Allow once" applies it and the row turns "done" with `+a -d`.
- [ ] While the run streams, a submitted message goes to the queue slot and steers the turn; Stop ends the run with "Stopped".
- [ ] Reloading the window mid-run shows the transcript, including the previous reply, and the run continues with no duplicated or missing text.
- [ ] A second window on the same thread shows the same messages (including the user's own) and the same pending permission; answering in one removes it from the other.
- [ ] With the emitter absent (`UnavailableAguiSource`), the chat shows the unavailable state and no errors are thrown.

---

## 16. Risks

| Risk | Mitigation |
|---|---|
| TanStack AI internals the kit depends on (the rejoin drop rule, the `attach`-time hydrate, property-get widget lookup, `QueueStrategy`) change in a minor release. | Exact pins (0.29.3 / 0.36.0 / 0.63.0); R2-T3, R2-T5, R2-T12 and R2-T21 exercise each assumption and fail loudly on a bump. |
| The cursor gate is subtle. | It is a pure module with its own tests (R2-T1) plus a seeded property test over interleavings (R2-T3). |
| Main-side amendments (§14.1–§14.7) land in other slices. | The kit's tests run against a main relay fake implementing exactly §14; the real-session gate (R2-T32) cannot pass until they land, which makes the dependency explicit. |
| Index-based legacy queue commands can still hit the wrong entry if a drain lands between main's lookup and the agent. | Same as today; main resolves the index at call time from its latest snapshot, which narrows the window to one pipe hop. A follow-up can add id-based commands to the agent. |
| Math fonts in Chromium: temml's README warns about rendering bugs with system fonts. | r1 ships `Temml-Local.css` + `Temml.woff2`; the screenshot run includes a math scenario on macOS and Windows; if glyphs are wrong, bundle Latin Modern (380 KB, lazy with the math chunk) in a follow-up. |
| No virtualisation (F10) for very long threads. | History paging with 60-message pages, `content-visibility: auto` on rows, R2-T31 budget; virtualisation is a separate slice if the budget fails. |
| The highlight grammar gap (F17). | Plaintext fallback with full chrome; bumping `@tanstack/highlight` is a separate reviewed change. |
| Busy detection from three sources can disagree for a frame. | Any one being true means busy (§4.4). The `QueueStrategy` backstop catches a send that slips through: `sendMessage` then resolves without adding the message, the submit handler sees that its message id is absent from `getMessages()`, restores the draft and re-routes it through `ai.queue.enqueue` (logged as a bug). |
| `@tanstack/markdown` re-parses whole messages per render. | Stable-prefix split for long streaming replies (§7.1), verified equivalent by R2-T18. |
