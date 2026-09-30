# 02 — Chat kit (phase 2)

Status: draft spec **r3** (no code; final spec round before implementation). r2 answered Codex round 1 (`reviews/02-chat-kit.codex-r1.md`, 22 findings), r3 answers round 2 (`…codex-r2.md`, 13 items); responses at the end. Branch `rewrite/renderer`. It implements the "Chat kit" phase of `docs/rewrite/PLAN.md` (§Chat UI, §Motion system, §Phases 2, and the "Amendments after phase-0 spec reviews"), on top of:

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
| F1 | Agent spec §3.1.6: "ChatClient is configured with `whenBusy: "error"`" | `WhenBusy = 'queue' \| 'drop' \| 'interrupt'` (`types.ts:430`). There is no `"error"`, and `onOverflow: 'reject'` discards **silently** (`types.ts:468-474`). | The client gets a `QueueStrategy` that **throws** (`ChatBusyError`; `decideWhenBusy` runs synchronously in `sendMessage`, `chat-client.ts:2276-2279`). The kit never calls `sendMessage` at all (admission is `session.submit`, §3.7), so the guard only catches bugs. PLAN amendment added. |
| F2 | Agent spec §5.3 (hydrate excludes the active run) combined with TanStack's own rejoin | `resumeInFlightRun` drops only the **last** assistant message on the first rebuild chunk (`chat-client.ts:2016-2018`, `:2080-2086`), so with the active run excluded it would delete the previous reply, and with it included it would duplicate earlier active-run messages (review r1-4). | The kit does not use TanStack's rejoin at all: the client is ephemeral and each generation is built from the completed transcript plus a from-start replay of the active run in a **fresh** client (§3.3, §3.4). Agent spec §5.3's "excluding the active run" stands (§14.1). |
| F3 | (r1) main must echo client-run user messages | **Withdrawn.** `AguiHost.onRun` already echoes the user message with the client's id (`packages/agent/src/agui/host.ts:327-331`, `emit.ts:359-372`); a second echo concatenates (review r1-3). | §3.4 relies on the agent's single echo; R2-T6. |
| F4 | PLAN: "loader: `chatClient.hydrate(threadId)`" | `ChatClient` has no public hydrate; it hydrates itself in `attach()` only with `persistence === true` (`chat-client.ts:1017-1039`). | The kit hydrates itself: loaders await `session.load()` (§3.2) and the client is constructed with the snapshot's messages (§3.3). |
| F5 | Transport A.3: `ai.subscribe` and `ai.joinRun` are independent iterators | Two independent loops in `ChatClient` would duplicate and reorder the active run's events (`consumeSubscription` `:1942`, `resumeInFlightRun` `:1982`). | One pump per generation reads `joinRun` then `subscribe` in order and feeds one wakeable dispatcher, the client's only source (§3.4); a reconstruction cursor decides recovery (§3.3). |
| F6 | Agent spec §3.1.6 / §5.2: main injects `RUN_ERROR {queued}` into "the requesting subscription" | A terminal through the shared processor affects any run in flight (`chat-client.ts:1296-1380`, `processor.ts:2260-2306`), and any `ChatClient` request path resets the shared processor first (`streamResponse` → `prepareAssistantMessage()`, `:2551`; reviews r1-6, r2-2). | Admission is outside `ChatClient`: `session.submit` calls `ai.send` directly and keeps the pending message in an outbox (§3.7); `ai.send` returns the ack; main injects nothing (§14.5). |
| F7 | PLAN: `createChatUI` dispatchers render every tool and sub-agent | Missing `toolsComponents[name]` warns once and renders **nothing** (`create-ui.tsx:725-731`); missing `subagentsComponents[name]` **throws** (`:743-748`, `:951-955`). Tool names are open (MCP tools, extensions). | The tool and sub-agent maps are `Proxy` objects that resolve any name to the generic widget (§5.2). Nested `SubagentMessages` overrides would spread the proxy into a plain object (`withWidgets`, `:339-348`), so cards never pass override maps. R2-T12. |
| F8 | PLAN: gallery fixtures via `@shadcn/helpers/tanstack-ai` | `@shadcn/helpers@0.2.0` peers `@tanstack/ai >=0.40.0 <0.41.0` and `@tanstack/ai-client >=0.20.0 <0.21.0` (clone `packages/helpers/package.json`); its writer has no permissions, sub-agents, `STATE_*` or `CUSTOM`. | Not used. Fixtures are recorded AG-UI streams replayed through the **real** adapter over a fake `AppClient` (§11). |
| F9 | PLAN: math via `temml` in TanStack `TextPart` | `@tanstack/markdown` has no math node; the inline parser consumes `\(`, `\)`, `\[`, `\]` as escapes before any extension sees them (`dist/inline.js:28-39`), and the React renderer ignores extension `renderHtml` (only `html.js` calls it). `temml.mjs` exports **only a default** although `temml.d.ts` declares named exports (`dist/temml.mjs:14755`). | Math is rewritten in a **pre-pass on the raw string** into forms the Markdown React renderer already has hooks for: display math becomes a fenced block with language `math` that the synchronous `highlighter` renders to MathML; inline math becomes inline code with a sentinel prefix that a custom `code` component renders (§7.3). `import temml from "temml"` only. R2-T19. |
| F10 | PLAN: virtualise the transcript on the viewport ref past ~200 parts | The registry scroller's anchoring, `scrollToMessage`, visibility and prepend preservation need `MessageScrollerItem` rows with `messageId` (clone `use-message-scroller-controller.ts:260-309, 424-461`); the docs' virtualisation example renders plain divs (`message-scroller.mdx:527-594`). The scroller's `PERFORMANCE.md` excludes Markdown cost. | No `@tanstack/react-virtual` in phase 2, **conditional** on the R2-T31 gate: paging plus a mounted-row budget and processor retention (`MAX_ROWS = 400`, `MAX_MESSAGES = 300`, §10); if the gate fails, lower `MAX_ROWS`, then a virtualisation slice. |
| F11 | PLAN: "Stop" and sub-agent `stop()` | `ChatClient.stop()` aborts only the local request ("A durable server run keeps going", `:2825-2842`); `SubagentHandle.stop` likewise (`:3194-3211`). | Stop is `ai.cancel({ threadId, runId })` everywhere (agent spec §3.6). `useChat().stop` and `handle.stop` are never called (§4.5). |
| F12 | — | A `RUN_ERROR` with no active assistant message **creates an empty assistant message** (`processor.ts:913-928` via `handleRunErrorEvent` `:2270`). | Message widgets render nothing for an empty assistant message; the run's outcome renders from its record (§5.1). |
| F13 | PLAN: Interrupts slot for approvals | Agent spec r3 already superseded native interrupts; confirmed: the kit's `Interrupts` reads only `chat.interrupts` (`create-ui.tsx:818-837`). | `interruptsComponents` is not configured; permissions render from the kit's own descriptor store (§6). |
| F14 | — | `useChat` subscribes only with `live: true` (`use-chat.ts:361-375`). | Moot: the kit owns the client and calls `subscribe()` for every generation (§3.3 step 5). |
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
- **The ChatClient binding** to `ai.*`: a `SubscribeConnectionAdapter` over `ai.subscribe` / `ai.send` / `ai.hydrate` / `ai.joinRun` with `lastEventId` resume, generations and a reconstruction cursor over an owned `ChatClient`; loaders awaiting the first snapshot; `ai.queue.*` for busy input; `ai.respondPermission` as independent answers; `ai.cancel` for Stop (§3, §4).
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
│  ├─ session.ts                 ThreadSession: generations, cursors, load(), recovery (§3.1–§3.3)
│  ├─ dispatcher.ts              the wakeable dispatcher and the pump (§3.4)
│  ├─ adapter.ts                 SubscribeConnectionAdapter { subscribe } over the dispatcher (§3.4)
│  ├─ admission.ts               submit() / retry() via ai.send, the outbox (§3.7)
│  ├─ host.ts                    useThreadHost(): UseChatReturn over the owned ChatClient (§3.5)
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
export { useThreadHost } from "./runtime/host";
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
  workspaceRoot: string | null;            // resolves relative file links (§7.5); null for bots
  onOpenFile?: (absPath: string) => void;  // file links in markdown and tool rows → Files tab (sessions)
  onOpenSubagent?: (subagentRunId: string) => void;   // card → side-panel "Agents" tab (sessions)
}
```

`ChatRuntime` joins the router context (foundation §6.4 "Chat client factory joins the context in phase 2"):

```ts
export interface ChatRuntime {
  session(threadId: string): ThreadSession;                        // cached per document (§3.1); loaders await session.load() (§3.2)
  respondPermission(d: PermissionDescriptor, decision: PermissionDecision): Promise<void>;   // §6.3
  queue: { enqueue(threadId: string, text: string): Promise<void>; update(threadId: string, entryId: string, text: string): Promise<void>;
           remove(threadId: string, entryId: string): Promise<void>; clear(threadId: string): Promise<void> };   // incarnation added from the store (§8.5)
  cancel(threadId: string): Promise<void>;                         // Stop (§4.5)
}
```

`createChatRuntime(transport)` is called once in `createAppRouter(boot)`; the notch entry (phase 6) calls it with its own transport.

---

## 3. The ChatClient binding

### 3.1 One `ThreadSession` per thread per document

`runtime.session(threadId)` returns a cached `ThreadSession` (an LRU of 8 threads; a session with a mounted view is pinned; the cache lives on `globalThis[Symbol.for("abacus.chat.sessions")]` so Fast Refresh keeps streams, as the transport does, foundation §8.1). A session owns:

- the **`ChatClient`** of the current generation, constructed by the kit and used **only as a receive-side processor**: it is fed exclusively by the pump (§3.4) and the kit never calls a method that starts a request (§3.6; `useChat` is not used, review r1-1);
- the **admission path** `session.submit()` / `session.retry()`, which calls `ai.send` directly and keeps pending user messages in an **outbox** (§3.7), outside `ChatClient` (review r2-2);
- the **host store**: a TanStack `Store` that the React host reads (§3.5);
- the **thread store** (§4), the **dispatcher** and the **pump** (§3.4);
- a **generation token** `gen`, a **reset revision** `rev` (bumped by `session.cleared`), and the positions of §3.3;
- the **connection state** `connection: "connecting" | "connected" | "reconnecting" | "error"`, owned by the pump (§3.4, review r2-13).

Keeping this per document (not per component) means a Strict Mode remount, a route re-render or a second consumer in the same window share one client and one stream.

### 3.2 Loading and readiness

```ts
interface ThreadSession {
  load(): Promise<void>;   // the current generation's readiness promise (below); the same promise for every caller
  readonly ready: boolean;
  retire(): void;          // LRU eviction / thread deleted: abort the pump, unsubscribe + dispose the client
}
```

- `load()` returns the **in-flight readiness promise** of the current generation, creating a generation only when none exists or the last one failed (review r2-3). Every caller waits on the same promise; none bypasses it.
- **Readiness** resolves when the generation's client has been constructed **and** its consumer has *applied* (§3.3) every event up to the checkpoint `N`. With no active run that is immediately after construction; with an active run it is after replay through `N`, so the transcript contains the active run's user echo and everything it streamed so far (review r2-3). A replay that has not reached `N` within 5 s resolves readiness anyway with `session.partial = true`; the view then shows what it has plus a `Skeleton` row at the end, and the rest arrives as it streams (a hung `joinRun` never hangs navigation).
- Route loaders (phases 3–4) **await** `context.chat.session(threadId).load()` (review r1-11). The router shows its pending UI after `defaultPendingMs` (150 ms, foundation §6.4), and the navigation, including its view transition, commits only after readiness.
- `ChatView` renders the transcript only when `session.ready`; before that (a direct mount without a loader, e.g. the gallery) it renders the registry `Skeleton` rows, never an empty log.
- The opening scroll position is applied by the registry scroller while `data-pending-scroll` hides the viewport (`@shadcn/react ≥ 0.3.1`, F15); because content is present at mount, that hold covers the first paint. R2-T16 tests a slow hydrate, a slow `joinRun` with an empty completed transcript, and a direct mount.

### 3.3 Generations, positions and recovery

Every (re)construction of the thread view is a **generation** `g`:

1. `g = ++session.gen`. The new generation's client, host fields and positions are **staged** privately; the previous generation keeps rendering until the swap in step 7.
2. `snap = await client.ai.hydrate({ threadId, limit: PAGE_SIZE })` → `ChatHydrationResult & { abacus: ThreadSnapshot }` (§14.1). If `session.gen !== g` on return, the result is dropped.
3. **Messages** = `snap.messages`: the completed transcript only. Every message produced inside the active run is **excluded** and rebuilt from replay (review r1-4). An empty array is authoritative (review r1-9).
4. **Thread store** = `reset(snap.abacus)`: the session-scoped slices from the snapshot (§4.1, §14.1); run-scoped slices empty; `runs.active` seeded from `snap.abacus.activeRun` so the thread is busy and Stop has a target **before** any replayed content (review r2-1).
5. A new `ChatClient` (§3.6) is constructed with `initialMessages = messages`; every callback is bound to `g` (§3.5); the kit calls `client.subscribe()` (`chat-client.ts:2760`), starting the client's single consumer loop over the dispatcher.
6. The pump for `g` starts (§3.4).
7. **Swap** at readiness (§3.2): in one host-store `setState`, the staged client and fields replace the previous generation's; then the previous client is `unsubscribe()`d and `dispose()`d. Its callbacks are already inert (they check `g`), so its teardown notifications (`unsubscribe` emits loading, subscription, generation and connection changes synchronously, `chat-client.ts:2779-2791`) cannot touch the new binding (review r2-6).

**Positions** (all per generation):

| Position | Starts at | Meaning |
|---|---|---|
| `sessionCursor` | `N` (`snap.abacus.cursor`) | session-scoped store slices skip events with `seq ≤ N` (already in the snapshot) |
| `receivedSeq` | `activeRun ? activeRun.startSeq − 1 : N` | the last seq the pump accepted from the server; the pump drops `seq ≤ receivedSeq`, so replay is the **inclusive** interval `[startSeq, …]` and `RUN_STARTED` is replayed (review r2-1) |
| `appliedSeq` | same as `receivedSeq` | the last seq whose chunk the client has **processed** (§3.4) |

A generation is **reconstructed** when `appliedSeq ≥ N`. Recovery:

| Event | Before reconstructed | After reconstructed |
|---|---|---|
| `ai.joinRun` errors or ends without a terminal | a **new generation** (never switch to `ai.subscribe` at `N`, review r1-7) | switch to `ai.subscribe({ lastEventId: receivedSeq })` |
| `ai.subscribe` errors (`RESYNC_REQUIRED`, transient) | — | `connection = "reconnecting"`; reopen from `receivedSeq` after 250 ms, 1 s, 4 s; the third failure sets `connection = "error"` |
| `CUSTOM abacus.resync` | new generation | new generation |
| Retry on the connection error; `NOT_FOUND` then the row reappears | new generation | new generation |

A new generation always gets a fresh `ChatClient`, so no per-message or per-tool processor state (`processor.ts:3048-3062` `resetStreamState` is private) can absorb replayed events (reviews r1-8, r1-9).

### 3.4 The adapter, the dispatcher and the pump

The client is built in **ephemeral mode** (no `persistence`, no `history`) and its adapter implements only `subscribe` and `send` (`connection-adapters.ts:1023-1041`), so `attach()` never hydrates and TanStack's rejoin path, including `dropTrailingInFlightAssistant`, never runs (F2).

**The pump** (one per generation) is the only reader of the server: `ai.joinRun({ runId })` when `snap.abacus.activeRun` is set (from `RUN_STARTED`, then live until the terminal, every event with its seq, §14.3), then `ai.subscribe({ threadId, lastEventId: String(receivedSeq) })`. Per server event: `abacus.subscribed` → `connection = "connected"` and nothing else (review r2-13; the first `joinRun` event also sets it); `abacus.resync` → new generation; `seq ≤ receivedSeq` → drop; otherwise `receivedSeq = seq` and `dispatcher.push({ seq, event })`. The pump never touches the store or the client.

**The dispatcher** (review r1-5) is one wakeable queue per generation: `push`, `close` and the abort signal each resolve a single `Deferred` that `stream()` awaits, so nothing waits behind an idle server read. `stream(signal)` is the adapter's `subscribe()`:

```
for each queued item, in push order:
  resume point from the previous yield ⇒ the client has processed the previous chunk:
      appliedSeq = previous.seq; run post-apply hooks for it (below)
  applyEvent(store, item.seq, item.event)          // pre-apply slices (§4.2)
  yield item.event                                  // the client processes it synchronously on resume
```

`consumeSubscription` calls `processIncomingChunk` synchronously for each chunk before pulling the next (`chat-client.ts:1942-1956`; it only yields to the host *between* chunks), so "the generator resumed" is exactly "the previous chunk was processed". **Post-apply hooks** therefore run in consumer order (review r2-5): recording a terminal's `RunOutcomeRecord` (its `steps` and `afterMessageId` read `client.getMessages()`, which now include that run's final parts), advancing `appliedSeq`, flipping `reconstructed`, and resolving readiness. A consumer that has not yet processed a chunk never sees its dependent store state.

**`send`** is never called: the kit never calls `sendMessage`, `append`, `reload`, `addToolResult`, `addToolApprovalResponse` or the interrupt resume methods, which are the only callers of `streamResponse()` (`chat-client.ts:1620, 2345, 2452-2457, 2819, 3091`). `streamResponse()` resets the shared processor's stream state before calling `send` (`processor.prepareAssistantMessage()`, `:2551`, → `resetStreamState`, `processor.ts:378-381, 3048-3062`), which would drop another run's in-flight tool arguments and reasoning (review r2-2). The adapter's `send` therefore throws `Error("chat: send is not used")`, and R2-T30 bans those calls.

**Why the order is total.** One pump per generation reads the server in seq order and is the only producer; `stream()` is the only consumer; admission never goes through the client; a new generation gets a new client, dispatcher and pump. R2-T3 checks this by property test, R2-T5 the idle-read and budget-crossing cases.

### 3.5 The React host (`useThreadHost`)

`createChatUI`'s `ChatUIHost` is `UseChatReturn` (`create-ui.tsx:47-51`). The kit builds it from the session:

```ts
import type { UseChatReturn } from "@tanstack/ai-react";                // exported type (ai-react src/index.ts:17-29)
export function useThreadHost(session: ThreadSession): UseChatReturn {
  const s = useStore(session.hostStore);
  return {
    messages: withOutbox(s.messages, s.outbox),                          // §3.7
    subagents: s.subagents, queue: [], runId: s.pendingRunId ?? s.activeRunId,
    isLoading: s.outbox.length > 0, status: s.status, error: undefined,
    isSubscribed: s.connection !== "error", connectionStatus: toConnectionStatus(s.connection),   // from the pump (§3.4)
    sessionGenerating: s.activeRunId !== null,
    interrupts: [], pendingInterrupts: [], interruptErrors: [], resuming: false,
    hasOlderMessages: s.hasOlderMessages,
    sendMessage: (content) => session.submit(toText(content)),         // admission, §3.7
    reload: () => session.retry(),                                       // admission, §4.6
    stop: () => session.cancel(),                                        // ai.cancel, §4.5
    loadOlderMessages: () => session.loadOlder(),                        // §10
    setMessages: () => { throw unsupported("setMessages") },
    append: unsupported, addToolResult: unsupported, addToolApprovalResponse: unsupported,
    cancelQueued: () => {}, clear: unsupported,
    resolveInterrupts: unsupported as UseChatReturn["resolveInterrupts"], cancelInterrupts: () => {}, retryInterrupts: () => {},
    resumeInterrupts: unsupported, resumeInterruptsUnsafe: unsupported,
  } satisfies UseChatReturn;
}
```

- The generation-`g` client's callbacks (`onMessagesChange`, `onStatusChange`, `onRunIdChange`, `onSessionGeneratingChange`; `types.ts:1042-1135`) each start with `if (g !== session.gen) return` and write into the staged fields until the swap, then into the live ones (review r2-6). `subagents` is read with `client.getSubagents()` in `onMessagesChange` (`chat-client.ts:3144`). `activeRunId` comes from `store.runs.active`, not from the client.
- The host's `sendMessage` maps to admission, so the kit's own components (and nothing else) can send. The stubbed methods exist only to satisfy the type; R2-T30 forbids calling them.
- R2-T2 type-checks the object with `satisfies UseChatReturn` against `@tanstack/ai-react@0.29.3` (§14.9), renders it through the real `createChatUI`, and tears down an old generation, and delivers a late ack and a late page, after a swap, asserting the new binding is untouched.

### 3.6 Client options

```ts
new ChatClient({
  connection: { subscribe: (signal) => dispatcher.stream(signal), send: () => { throw new Error("chat: send is not used"); } },
  threadId,
  initialMessages: snap.messages,          // types.ts:974
  queue: throwWhenBusy,                    // F1: a request path is a bug
  onError: guarded(g, (e) => session.onClientError(e)),
  …guarded callbacks of §3.5,
});
const throwWhenBusy: QueueStrategy = ({ busyReason }) => { throw new ChatBusyError(busyReason); };
```

`throwWhenBusy` is the loud guard the PLAN amendment records (F1): `decideWhenBusy` runs synchronously inside `sendMessage` before any claim (`chat-client.ts:2276-2279`). Since the kit never calls `sendMessage`, it can only fire through a bug, and then it rejects instead of queueing.

### 3.7 Admission (`session.submit`, `session.retry`)

```ts
async submit(text: string, forwardedProps?: { mode?: AgentMode; model?: string }): Promise<AdmissionResult> {
  const g = this.gen, rev = this.rev;
  const id = "u-" + crypto.randomUUID(), runId = "run-" + crypto.randomUUID();
  outbox.add({ id, runId, text, createdAt: now });                          // renders as a pending user message
  const ack = await client.ai.send({ threadId, runId,
    messages: [{ id, role: "user", parts: [{ type: "text", content: text }] }], forwardedProps });
  if (g !== this.gen || rev !== this.rev) { outbox.remove(id); return { kind: "stale" }; }   // review r2-6
  // ack: { runId, status: "started" | "queued" | "rejected" | "duplicate", reason?, entryId? }   (§14.5)
  if (ack.status !== "started" && ack.status !== "duplicate") outbox.remove(id);
  return { kind: ack.status, reason: ack.reason };
}
```

- **Outbox.** Pending user messages live in the host store, never in the processor. `withOutbox(messages, outbox)` appends each outbox entry whose `id` is not yet among the client's messages as a `UIMessage { id, role: "user", parts: [text], metadata: { abacus: { pending: true } } }`. When the agent's echo of that message (same id, `packages/agent/src/agui/host.ts:327-331`) is processed, the id appears in the client's messages and the entry is dropped from the outbox. No processor state is ever created or reset by admission, so a run already streaming, including its partial tool arguments and reasoning, is untouched (review r2-2).
- **Acks.** `queued` → the entry leaves the outbox and the text appears in the queue slot from `queue.updated` (the agent queued it). `rejected` → the entry leaves and the draft is restored with an inline error (§4.6). `duplicate` → wait for the echo as for `started`. A thrown oRPC error → the entry leaves and §4.6 applies.
- **Retry** (`session.retry()`, ErrorCard "Retry" and after `cancelled`): the same `ai.send` with a **new** run id and the **last user message's id and text** from the transcript; the agent admits it as a retry because the previous run for that message ended in `RUN_ERROR` or `cancelled` (agent spec §3.1.4). Never offered after a successful run.
- **Stop before `RUN_STARTED`**: the outbox entry's `runId` is the Stop target (§4.5).
- **Conversion.** The UIMessage goes to main as `UIMessageLoose`; main converts it with `uiMessagesToWire` at the relay boundary, keeping the id (§14.2).

### 3.8 TanStack AI APIs used (verified signatures)

| API | Signature (as used) | Source |
|---|---|---|
| `new ChatClient(options)` | `ChatClientOptions`: `connection`, `threadId`, `initialMessages`, `queue`, `onError` and change callbacks | `chat-client.ts:589`, `types.ts:974-1135` |
| `subscribe()` / `unsubscribe()` / `dispose()` | `(options?: { restart?: boolean }): void` / `(): void` / `(): void` | `:2760`, `:2779`, `:3600` |
| `getMessages()`, `getSubagents()` | read accessors | `:3140`, `:3144` |
| `setMessagesManually(messages)` | replaces the processor's message array (paging and retention only, §10) | `:3483-3486` |
| `QueueStrategy` | `(ctx) => { action: WhenBusy }`; ours throws | `types.ts:487-491` |
| `SubscribeConnectionAdapter` | `{ subscribe(signal?), send(...) }` | `connection-adapters.ts:1023-1041` |
| `UseChatReturn` (type only) | the `ChatUIHost` shape | ai-react `src/types.ts:135-313`, `create-ui.tsx:47-51` |
| `createChatUI(options, config)` | `{ Chat, Provider, Messages, Message, Part, Interrupts, Interrupt, Queue, Subagents, SubagentMessages, useChatContext, Input }` | `create-ui.tsx:371-1003` |
| `LayoutProps` / `MessageProps` / `PartProps` / `ToolProps` / `SubagentProps` | `{ Messages, Interrupts, Queue, Subagents, Input }` / `{ message, Parts }` / `{ part }` / `{ part, result?, interrupt? }` / `{ subagent, Parts }` | `create-ui.tsx:57-127` |
| `TextPart` | `{ content, role?, className?, userClassName?, assistantClassName?, extensions?, highlighter?, components? }` | `chat-ui/text-part.tsx:10-34` |
| `parsePartialJSON` | streaming tool-argument parse | `@tanstack/ai/client` (`src/client.ts:299`) |
| `uiMessagesToWire(messages)` (main side, §14.2) | UIMessage → AG-UI `RunAgentInput.messages` | `@tanstack/ai` (`src/index.ts:522`, `utilities/ag-ui-wire.ts:91`) |
| `ToolCallState`, `ToolResultPart`, `SubagentHandle` | `awaiting-input … error`; `{ toolCallId, content, state, outcome?, error? }`; `{ id, name, status, parentToolCallId?, messages, error? }` | `@tanstack/ai/src/types.ts:86-93, 450-462, 507-531` |

`useChat`, the kit's deprecated `Chat`/`useChatContext` exports and ai-react's `ThinkingPart` are not used.

---

## 4. The thread store

### 4.1 State

A `Store` from `@tanstack/react-store` per thread (ephemeral UI state, PLAN §Where state lives), owned by the session and reset at the start of every generation (§3.3):

```ts
export interface ThreadStoreState {
  sessionCursor: number;                               // session slices skip seq ≤ this (§3.3)
  incarnation: string | null;                          // from snapshot / session.ready
  agent: AgentState | null;                            // agent spec §2.3 AgentState: mode, modeSource, model, plan?
  permissions: { items: PermissionDescriptor[]; answering: Record<string, AnsweringState> };
  queue: QueueEntry[];                                 // { id, message, waitingFor: "step" | "permission" | "turn" }
  runs: { active: ActiveRun | null; outcomes: RunOutcomeRecord[] };   // outcomes: from the snapshot (§14.7), then live terminals
  tools: { output: Record<ToolKey, string>; display: Record<ToolKey, ToolDisplayData> };   // live CUSTOM tool.output / tool.display
  activity: { status: AgentStatus; runningTools: number; retry: RetryInfo | null };        // status, runningTools: snapshot + S events; retry: run-scoped (replay)
  notices: Notice[];                                   // snapshot + S agent.notification / non-terminal agent.error
  skills: SkillMetadata[];                             // skills.loaded, for the `/` menu
}
type ToolKey = `${string}\u0000${string}`;             // (subagentRunId ?? "", toolCallId), agent spec §3.5.4
interface ActiveRun { runId: string; startedAt: number; serverInitiated: boolean }
interface RunOutcomeRecord { runId: string; kind: "success" | "cancelled" | "error"; startedAt: number; endedAt: number;
                             usage?: TokenUsage; error?: AgentErrorPayload & { code?: string }; steps: number; afterMessageId: string | null }
```

Types `PermissionDescriptor`, `AgentState`, `AgentErrorPayload`, `QueueEntry`, `ToolDisplayData` come from `@abacus-ai/agent`'s wire types (agent spec §2.3; the browser-safe `tool-display` entry pattern extends to a type-only import, which carries no runtime code).

### 4.2 Event → store → component mapping

`applyEvent(state, seq, chunk, positions)` is pure and runs in the dispatcher just before the chunk is yielded (§3.4). Rows are **session-scoped** (agent spec §2.3 *S*, and `STATE_*`: skipped when `seq ≤ sessionCursor`, because the snapshot already holds them, §14.1) or **run-scoped** (*R* names and all `RUN_*`/`TEXT_*`/`REASONING_*`/`TOOL_*`/`SUBAGENT_*`: always applied; replay is inclusive from `startSeq`). Terminal records (`RunOutcomeRecord`) are written by the **post-apply hook**, after the client processed the terminal (§3.4). `ChatClient` handles message parts independently from the same chunk.

| AG-UI event (agent spec) | `StreamProcessor` → `UIMessage` part | Store | Component |
|---|---|---|---|
| `RUN_STARTED {runId, metadata.abacus.serverInitiated?}` | `activeRuns.add` (`:2115`); client `sessionGenerating` | `runs.active = { runId, startedAt: event timestamp, serverInitiated }` (also seeded from the snapshot at load, §3.3); clear `tools.*` of finished runs | `BusyLine` (sessions: "Working 12.4s"), `Typing` bubble (bots), Stop button |
| `RUN_FINISHED {outcome: success}` + `usage[]`, `metadata.abacus.{turnUsage, stopReason}` | finalize (`:2131-2161`) | post-apply: append a `RunOutcomeRecord { kind: "success", usage, steps, afterMessageId }`; `active = null` | `RunMarker` "Done in 48s, 7 steps" (sessions), usage in its hover card; nothing for bots |
| `RUN_FINISHED {outcome: cancelled}` | finalize | `kind: "cancelled"` | `RunMarker` "Stopped" (muted) |
| `RUN_ERROR {code, message, metadata.abacus.error}` | empty assistant message if none active (F12); `onError(Error{code})` | post-apply: append a `RunOutcomeRecord { kind: "error", error }` | `ErrorCard` with actions (§5.6); `queued`/`rejected`/`agent_*` handled per §4.6 |
| `TEXT_MESSAGE_START/CONTENT/END {role: "assistant"}` | `text` part (`:1221-1350`, `:1772-1848`) | — | `TextPart` via `Markdown` (§7) inside `BotMessage` bubble or `SessionMessage` prose |
| `TEXT_MESSAGE_* {role: "user"}` (`runId:user`, `steer-N`) | user message with a `text` part (role kept from `START`, `:1228-1231`) | — | user bubble (bot tint) / right-aligned muted bubble (sessions); `@path` lines → attachment chips (§8.6) |
| `REASONING_START … REASONING_END` | `thinking` part (`:2375-2412`) | — | `ThinkingPart`: registry `Marker` + `Collapsible`, shimmer while it is the message's last part and the run is active (§5.3) |
| `TOOL_CALL_START {toolCallName, parentMessageId, metadata.abacus.rawName}` | `tool-call` part, `state: awaiting-input` | — | `ToolLine` "runs" + title from `buildToolTitle(name, parsePartialJSON(arguments))` |
| `TOOL_CALL_ARGS` | `arguments` grows, `input-streaming` | — | title updates |
| `TOOL_CALL_END {metadata.tanstack.input}` | `input` set, `input-complete` | — | title from the final `input` (agent spec §3.3.5) |
| `CUSTOM tool.output {toolCallId, output}` (R) | forwarded to `onCustomEvent` (`:2632-2639`) | `tools.output[key] = output` (replace, as today, §12.7) | `BashExpander` live tail |
| `CUSTOM tool.display {toolCallId, data}` (R) | forwarded | `tools.display[key] = { ...tools.display[key], ...data }` (the emitter sends each patch unchanged, `agui/emit.ts:594-606`) | `DiffExpander` (edit/write) before the result |
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
| `CUSTOM session.cleared` (S) | forwarded | `rev += 1` (post-apply) | a **new generation** (§3.3): fresh snapshot and client, so the transcript is replaced authoritatively and pending pages and acks from before the reset are discarded |
| `CUSTOM skills.loaded {skills}` (S) | forwarded | `skills` | `/` menu |
| `CUSTOM run.ack`, `wire.hello`, `wire.compat_lost`, `mcp.*` | forwarded | ignored (main or Library consume them) | — |
| `CUSTOM abacus.subscribed` / `abacus.resync` (main, transport A.3) | never reach the client | — | the pump (§3.4) |
| any other `CUSTOM` name | forwarded | ignored; dev builds log once per name | — |

**Usage.** `RUN_FINISHED.usage` follows `@ag-ui/core` accounting (agent spec §3.3.8: `inputTokens` includes cache reads and writes; `totalTokens = inputTokens + outputTokens`). The hover card shows "In 12.3k (8.1k cached) · Out 1.2k"; the canvas has no usage UI, so this is the minimal surface. Settings › Usage (phase 5) owns the full view.

**Steps count** for "Done in 48s, 7 steps" = the parent message's `tool-call` parts of that run, counted at the terminal (children count inside their own card).

### 4.3 `STATE_DELTA` application

The agent emits `replace /mode`, `replace /modeSource`, `replace /model` and `add /plan` (agent spec §3.3.2). `json-patch.ts` implements RFC 6902 `add`, `replace` and `remove` on object paths (JSON Pointer with `~0`/`~1` unescaping) plus array index `-`; any other op, or a path into a missing parent, is ignored and the store requests a fresh snapshot by setting `agent = null` until the next `STATE_SNAPSHOT` or hydrate. Replaying an already-applied delta is harmless (the store guard skips `seq ≤ appliedSeq`, and `add`/`replace` of these paths are idempotent anyway). R2-T9.

### 4.4 Busy

```ts
busy(threadId) = sessionsRow.turn?.isBusy === true        // db.sessions turn column (transport A.2.3, B.2): pending | streaming | waiting_permission
              || store.runs.active !== null                // RUN_STARTED seen, terminal not yet
              || outbox.length > 0                         // an admission in flight or awaiting its echo (§3.7)
```

Any one of them makes the composer busy. The turn column is main's own view derived from compat (agent spec §3.1.6); the other two close the window before the turn column's change batch arrives (§8.3).

### 4.5 Stop

`runtime.cancel(threadId)` calls `ai.cancel({ threadId, runId })` with `runId = store.runs.active?.runId ?? outbox.last?.runId` (the kit-generated id of an admission that has not yet seen `RUN_STARTED`, §3.7; the agent applies `cancel {runId}` to a run whose admission is still preparing, agent spec §3.8). The UI never calls `ChatClient.stop` or `SubagentHandle.stop` (F11); the host's `stop` is `session.cancel()` (§3.5). The run settles with `RUN_FINISHED {cancelled}`, which resolves `processingComplete` normally. Stop is shown only while busy; a second press while cancelling is ignored until the terminal (button shows a spinner). The sub-agent card's Stop calls the same function (agent spec §3.6: it stops the whole turn, as today).

### 4.6 Run errors and admission failures

Real run failures arrive as `RUN_ERROR` through the pump; admission outcomes come from `session.submit()`'s result (§3.7). Neither path touches the other.

| Case | Detect | Handling |
|---|---|---|
| ack `queued` (two-window race) | `submit()` → `{ kind: "queued" }` | The outbox entry is removed; the text shows in the queue slot through `queue.updated` (the agent queued it). No processor change, no error card. |
| ack `rejected` (`empty`, `resume_unsupported`, `regenerate_unsupported`) | `{ kind: "rejected", reason }` | Outbox entry removed; draft restored; inline composer error "The agent didn't accept that message." |
| ack `duplicate` | `{ kind: "duplicate" }` | Wait for the echo, as for `started`. |
| `ai.send` throws `UNAVAILABLE` / `TIMEOUT` | rejected promise | Outbox entry removed, draft restored, "The agent isn't ready. Try again." with Retry. |
| `ai.send` throws `NOT_FOUND {entity: "thread" \| "session"}` | same | The composer turns read-only "This conversation no longer exists." (§12.5). |
| `ai.send` throws `CONFLICT` | same | Outbox entry removed; the text is sent with `ai.queue.enqueue`. |
| `{ kind: "stale" }` (a new generation or a reset happened meanwhile) | — | Nothing (the entry was removed); if the draft was cleared optimistically it is restored. |
| a real `RUN_ERROR` (`turn_failed`, out of credits, `stall`, `compat_lost`, `agent_exit`, `agent_crashed`, `inactivity_timeout`) | pump → post-apply hook | `RunOutcomeRecord { kind: "error" }` drives the `ErrorCard` (§5.6); an empty assistant message the processor may create (F12) renders nothing. `agent_exit`/`agent_crashed`: "The agent stopped unexpectedly" plus Retry. |
| `ChatBusyError` / `"chat: send is not used"` | would only come from a forbidden call | A bug: logged; R2-T30 prevents it statically. |

The client's own `status`/`error` are not rendered. **Retry** is `session.retry()` (§3.7).

---

## 5. Message rendering (`createChatUI`)

### 5.1 Kit configuration

```ts
const options = { /* type-only: no tools or interrupts are declared */ } as const;
export const SessionUI = createChatUI(options, {
  components: { layout: ChatLayout, message: SessionMessage, input: ComposerSlot },   // `queue` not set: QueueSlot reads the store (§8.5)
  partsComponents: { text: TextPartDispatch, thinking: ThinkingView, image: ImageView, video: VideoView, document: DocumentView, fallback: UnknownPart },
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

`RunTail` renders after the last message: `BusyLine` or `Typing` while a run is active, then `RunMarker` / `ErrorCard` for the latest terminal. Past runs' outcomes render from `store.runs.outcomes` after the message named by `afterMessageId` (§14.7), so a cancellation before any output or a message-free failure still shows after reload; migrated transcripts have no records and show none.

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

`partsComponents.text` is a **dispatcher on `part.metadata?.abacus?.kind`** (finding r1-12). Transport C.3 maps several legacy segment types to text parts distinguished by that key; live AG-UI text never sets it.

| `metadata.abacus.kind` (transport C.3) | Widget |
|---|---|
| absent | `TextPartView` → the kit's `Markdown` (§7) with the message role; plain prose in sessions, inside a `BubbleContent` in bots |
| `notification` (`severity`, `actions?`, `notificationKey?`) | `Notice` row (§5.6) with its actions |
| `collapsible` (`title`) | registry `Collapsible` titled `title`, body = `content` as Markdown |
| `web_search_results` (`resultType`, `results`) | `SearchResultsCard`: query (`content`) + result rows (title, URL, snippet) opening externally |
| `feature_limit` (`featureName`, `limitType`) | `FeatureLimitCard` ("{featureName} limit reached"), with the upgrade CTA of §5.6 |
| `compaction` | `Marker variant="separator"` "Earlier conversation summarised" with a `Collapsible` showing the summary |
| `unknown` (`raw`) | nothing in production; a dev-only muted row |

Other parts:

- **`ThinkingView`** (not on the canvas; PLAN "Marker + shimmer, collapsible"): registry `Marker` with `role="status"`, `MarkerIcon` (lucide `Brain`), `MarkerContent className="shimmer"` "Thinking" while the part is the last part of a message whose run is active; afterwards "Thoughts", collapsed; `Collapsible` reveals the text rendered as Markdown. Migrated thinking keeps its title in `metadata.abacus.segments[].title` (C.3), which is used as the collapsed label when present.
- **`ImageView`**: registry `Attachment` with image media; `metadata.abacus.{width,height,prompt,model}` (C.3 `media`) sized and captioned.
- **`VideoView`** (finding r1-12): `<video controls preload="metadata">` from `source.value`, with `loop` and `aspectRatio` from `metadata.abacus`, inside an `Attachment` frame.
- **`DocumentView`**: `Attachment` with a file icon.
- **Credits** (`message.metadata.abacus.credits`, C.3): a muted footer "Used {n} credits" under the message, as today's transcript shows credits items.
- **Tool groups** (`metadata.abacus.segments[]` entries with `type: "tool_group"` and members with `groupId`, C.3): consecutive tool-call parts sharing a `groupId` render under one header with the group's `summary`, collapsed to a single row in the bot skin and expanded in sessions.
- **`UnknownPart`** (`fallback`): nothing in production; a dev-only muted row with the part type.
- **Empty assistant message** (F12): message widgets return `null` when `parts.length === 0`; its run outcome renders from the durable record (§5.1).

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
- **Expanders** (`Collapsible`, closed by default, `aria-expanded` on the row button), all fed by `NormalizedTool` (§5.4a):
  - `BashExpander`: the command (from input), then `terminal.output` from the result or `tools.output[key]` while running, in a mono block capped at 400 px with its own scroll, auto-following the tail while running unless the user scrolled it.
  - `DiffExpander`: unified diff built from `display.originalContent` → `display.newContent` (or `finalContent`); lines coloured as the canvas PermissionStates diff (`#2a1618`/`#fca5a5`, `#13261a`/`#86efac` mapped to `--chat-diff-del-bg/-fg`, `--chat-diff-add-bg/-fg` tokens defined for light and dark), highlighted per line with the file's language (§7.4). Diffs over 2,000 lines show the first 400 with "Show all".
  - `ReadExpander`: the returned text (first 200 lines) highlighted by extension, with "Open file" calling `onOpenFile`.
  - `BrowserExpander`: action and URL from input; screenshot when the result content carries an image part.
  - `GenericExpander`: `output.formatted` (vendored `formatToolContent` markdown, agent spec §6.2) through the kit's `Markdown`, else `output.text` as preformatted text.
- **Bot skin**: tool rows are not shown inline (the canvas bot boards show none). Each bot message with tool calls gets one `Marker` row "Worked through {n} steps" (a `Collapsible` revealing the same `ToolLine`s); the running tool's title is the typing caption ("Browsing news.example.com", BotChatPanel).

### 5.4a Tool result normalisation (`kit/tools/normalize.ts`, pure)

Tool widgets never read `part.output` or `result.content` directly (finding r1-13). They read:

```ts
interface NormalizedTool {
  status: "running" | "needs-you" | "done" | "failed" | "refused" | "stopped";
  text: string;                       // the result text shown by the generic expander
  error?: string;
  formatted?: string;                 // markdown (live only: vendored formatToolContent)
  diff?: { original?: string; final?: string; unified?: string; additions?: number; deletions?: number; isNewFile?: boolean };
  terminal?: { command?: string; output: string; exitCode?: number; timedOut?: boolean; background?: boolean };
  read?: { content: string; startLine?: number; lineCount: number; filePath?: string };
  source: "live" | "migrated";
}
normalizeTool(call: ToolCallPart, result: ToolResultPart | undefined, live: { output?: string; display?: ToolDisplayData }): NormalizedTool
```

| Source | Detect | Mapping |
|---|---|---|
| **Live** (agent spec §3.3.6) | origin = live unless the migrated test below matches; decided from the call alone, so it holds **before** any result exists (review r2-9). Before the result: `status: "running"`, `terminal.output = live.output`, `diff` from `live.display` (merged patches, §4.2). After: `call.output` is the parsed `ToolResultContent` | `text`, `error`, `formatted`; `diff` from `output.display` merged over `live.display` (`originalContent`, `newContent`/`finalContent`, `additions`, `deletions`, `isNewFile`); `terminal` from `output.terminal.output` or `live.output` while running, `command` from `call.input.command`; `read.lineCount` from `display.lineCount` |
| **Migrated** (transport C.3) | `call.metadata?.abacus?.segmentId` is a string (every C.3 tool-call part has it) | `text` = `call.output` (legacy `ToolResult.output`, a string) or `result.content`; `error` = `result.error`; by `result.metadata.abacus.data.type` (legacy `ToolResultData`, `renderer/conversation/agent-types.ts:273-322`): `read` → `read`; `file_mutation` → `diff` (`originalContent`, `finalContent`, `diff`, `additions`, `deletions`, `isNewFile`); `bash` → `terminal` (`command`, `output`, `exitCode`, `timedOut`, `background`); `mcp`/`generic` → `text` |
| **Status** (both) | — | the §5.4 status table, using C.3's result `state`/`outcome` for migrated history (denied → "refused", cancelled → "stopped") |

R2-T13 covers live and migrated successful, denied, cancelled, edit and terminal cases.

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
  | `retry` | "Retry" | `session.retry()` (§3.7) |
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

Every pending descriptor is **independently answerable** (finding r1-15, coordinator decision 9; agent spec §3.5 "no batching").

| Skin | Where |
|---|---|
| sessions | The composer slot shows the **permission tray**: when one descriptor is pending, its card (canvas PermissionStates, "Permission prompts take over the composer"); when several are pending, a row of selectable chips above the card, one per descriptor in arrival order (kind icon + short title: "Run command", "Edit workspace-view.tsx", "Connect registry.npmjs.org"), each with `aria-pressed`, and the card of the selected one below. Any chip can be selected and answered first; answering one selects the next remaining chip in order. Each joined ToolLine reads "needs you" with a "Show" button that selects its chip. The composer returns when no descriptor is pending. |
| bots | An inline card in the transcript at the tool's position (canvas BotApproval) for descriptors joined to a mounted tool part `(subagentRunId ?? "", toolCallId)`; every other descriptor in `PermissionList` above the composer. Each card is its own form; any can be answered in any order. |

`PermissionList` is the application-owned list of agent spec §3.5.5, subscribed to the store, rendering every descriptor that no mounted inline widget renders. "Mounted" is tracked by a registry that inline widgets write in an effect (`registerInline(key)` / cleanup), so a descriptor whose tool part is paged out or collapsed in a sub-agent card still shows. The notch (phase 6) mounts the same component. R2-T22 answers the second of two pending requests first **through the rendered controls** (chip, then button) in both skins.

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

Presenters are one typed function per `PermissionRequest` variant (`kit/permissions/presenters.ts`, exhaustive `switch` on `request.type` over `packages/agent/src/protocol.ts:273-387`; a new variant is a type error). Buttons: primary = white/foreground, secondary = `variant="secondary"`, deny = `variant="ghost"` after a spacer; `…` = "Add a note" (expands a textarea; with text the allow button sends `accept_with_message`, deny sends `reject_with_message`, as today `chat-composer.tsx:420-435`).

| `request.type` | Title / body | Buttons → decision |
|---|---|---|
| `run_terminal` | "Run this command?", right label = mode ("Supervised"); mono `command`; `cwd` muted | [Allow once] → `"accept"`; [Always allow {rule}] → `{type:"allow_always_with_rules", rules:[rule]}` with `rule = "Bash(" + command.slice(0,120) + (command.length>120 ? "…" : "") + ")"` (F20); [Deny] → `"reject"`; [`…`] note. `background: true` requests add [Run in background] → `"background"`. |
| `run_terminal` with `credentialPaths` | orange dot "This command reads saved credentials"; the paths listed | [Allow once] secondary → `"accept"`; [Deny] **primary** → `"reject"`; [`…`]; no "Always" |
| `edit_file` (`filePath`, `originalContent`, `newContent`, `diffContent?`) | "Edit {basename(filePath)}?" with `+a -d`; inline diff of `originalContent` → `newContent` (or `diffContent` when present), first 12 changed lines, "Show all" opens the full diff in a dialog | [Allow once] → `"accept"`; [Always accept edits this session] → `"allowAlways"`; [Deny] → `"reject"`; [`…`] |
| `write_file` (`filePath`, `originalContent`, `content`, `isNewFile`) | `isNewFile` ? "Create {basename}?" with the first 12 lines of `content` : "Overwrite {basename}?" with the diff `originalContent` → `content` | same |
| `notebook_edit` (`notebookPath`, `cellId?`, `editMode`, `cellType?`, `originalContent`, `newContent`) | "{Replace \| Insert \| Delete} a {cellType ?? "cell"} in {basename(notebookPath)}?" with the cell diff (insert: `newContent` only; delete: `originalContent` only) | same |
| `delete` | "Delete {basename}?" | [Allow once], [Deny], [`…`] |
| `read_outside_directory`, `write_outside_directory` (`isNewFile`), `edit_outside_directory`, `notebook_edit_outside_directory` (`filePath`, `resolvedPath`, `deducedDirectory`) | "{Read \| Write \| Edit \| Edit notebook} outside the folder?" with `resolvedPath` | [Allow once] → `"accept"`; [Always allow {deducedDirectory}] → `"allowAlways"` (scopes to that directory, agent spec §3.5.2); [Deny] |
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
- `@tanstack/markdown` re-parses the whole string on every render (`dist/react.js:6-8`). Each message is parsed as one document, because reference links and footnotes need document-wide context (review r1-18); R2-T31 measures the cost.
- `MARKDOWN_COMPONENTS` (tag-name map, `dist/react.js:166-169`): `a` → `ChatLink` (§7.5); `pre` → `CodeBlock` (§7.4); `code` → `InlineCode` (§7.3); `table` → wrapped in a horizontally scrolling `div` with `scroll-fade-x`; `img` → lazy, max-width 100%, click to open in a dialog.
- Streamed text gets no per-token motion; the last block fades in over 80 ms via CSS on `.chat-prose > :last-child` while `streaming` (PLAN motion table).

### 7.2 Styling

`chat-prose` is a small hand-written CSS block in `features/chat/markdown/prose.css` using theme tokens (headings, lists, tables, blockquote, hr, inline code) at the mira density (`text-sm`, 1.6 line height). No `@tailwindcss/typography` (not in the dependency set).

### 7.3 Math with temml

**Pre-pass** (`prepass.ts`, pure; it also rewrites file-link targets, §7.5). It scans the raw string once, skipping fenced code blocks (``` and ~~~), indented code and inline code spans, and rewrites only **closed** spans (PLAN: "math renders only once an expression is closed while streaming"):

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

`sanitizeUrl` keeps only `#…`, `/…`, `./…`, `../…`, `http(s):`, `mailto:`, `tel:` and scheme-less relative URLs, drops any other scheme including `file:`, and strips whitespace (`@tanstack/markdown dist/utils.js:53-64`; finding r1-19). File links are therefore rewritten by the same pre-pass as math (§7.3), before parsing, outside code:

| Link target in the source | Rewritten to | `ChatLink` action |
|---|---|---|
| `file:///abs/path` (percent-encoded or not) | `#abacus-file=` + `encodeURIComponent(decodedAbsPath)` | `onOpenFile(abs)` |
| `/abs/path`, `C:\…`, `C:/…` (absolute on either platform) | same | same |
| `./rel`, `../rel`, `rel/path.ts` (no scheme) | same, resolved against `workspaceRoot` (new `ChatViewProps.workspaceRoot: string \| null`); left unchanged when `workspaceRoot` is null | same |
| `http(s):`, `mailto:` | unchanged | `system.openExternal({ url })` |
| any other scheme | unchanged (the sanitiser turns it into plain text) | none |

`#abacus-file=` passes the sanitiser's `#` rule, and the encoding survives its whitespace stripping. Without `onOpenFile`, the action is `system.showItemInFolder({ path })`. Whether the path may be opened is main's decision (`system.openPath` is restricted to the app's working directories, `shared/contract/system.ts:59-62`). R2-T17 covers `file://` URLs, encoded paths with spaces, Windows paths, relative paths with and without a workspace root, and a `javascript:` link.

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

- `send`: `session.submit(finalText, preStart ? { mode, model } : undefined)` (§3.7). The draft clears optimistically and is restored on `rejected`, a thrown error or `stale`; `queued` clears it for good (the text is in the queue slot).
- `enqueue`: `runtime.queue.enqueue(threadId, finalText)` → `ai.queue.enqueue`. The draft clears when the procedure resolves; on error it stays with an inline error. The queued text appears through `queue.updated` (never from local state), so a second window sees it too.
- `blocked`: `question-pending` when an `ask_user_question` descriptor is pending (its card owns the slot); `uploading` while an attachment is still saving; `loading` while the session has no ready generation (§3.2).
- `busy` is §4.4. The composer never admits while busy (agent spec §3.1.6); a busy submit is an `enqueue`.
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

`QueueSlot` renders `store.queue` above the composer: one 40 px row per entry, radius 12: text (one line, ellipsis), a muted hint by `waitingFor` ("Sends at the next step" for `step`, "Waits for your answer" for `permission`, "Sends after this reply" for `turn`), [Edit] and [Remove] (`aria-label="Remove queued message"`). Edit turns the row into an inline input; Enter → `ai.queue.update({ threadId, incarnation, entryId, message })`, Escape cancels. Remove → `ai.queue.remove({ threadId, incarnation, entryId })`. Entry ids are process-local (`q-N`, `packages/agent/src/agui/queue.ts:530`), so every edit carries the store's `incarnation` and the agent validates and mutates atomically (§14.6, finding r1-14). A rejection (`CUSTOM queue.command_rejected {entryId, reason}`) shows "That message already went out" and the row refreshes from the next `queue.updated`. More than 3 entries collapse into "{n} more waiting" with a disclosure.

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
2. The transcript must be at its opening scroll position before the pane transition snapshots the new page: the registry viewport is `invisible` while `data-pending-scroll` is set (`@shadcn/react ≥ 0.3.1`, F15), and the navigation commits only after `session.load()` resolved, so content is present at mount (§3.2). R2-T28 (Electron) navigates between two long threads with `nav-lateral` and asserts the new snapshot shows the bottom of the transcript.

Reserved for phase 3/4 (not built here): `bot-identity-{botId}` (foundation §6.7) and a sub-agent card → Agents tab morph.

---

## 10. The transcript scroller

- Registry `MessageScrollerProvider autoScroll defaultScrollPosition="last-anchor" scrollPreviousItemPeek={64}` → `MessageScroller` → `MessageScrollerViewport` (`scroll-fade-b`, as registry) → `MessageScrollerContent` (`role="log"` default, `aria-busy={runActive}`) → one `MessageScrollerItem messageId={m.id} scrollAnchor={m.role === "user"}` per message.
- **Stick to bottom**: `autoScroll` follows the end while streaming; a user scroll up releases it (clone controller `:148-177`, `:632-643`). New user turns anchor to the top of the viewport with a 64 px peek of the previous message (`:437-461`).
- **Scroll button**: `MessageScrollerButton direction="end"` bottom-centre above the composer (PLAN "jump-to").
- **New-message marker** (the registry has none, clone docs `message-scroller.mdx:40`): `NewMessagesMarker` tracks the id of the first message that arrived while `useMessageScrollerScrollable().end === true`; it renders a registry `Marker variant="separator"` "{n} new" before that message (canvas BotChannel "2 new"), and the scroll button shows the count. It clears when that message becomes visible (`useMessageScrollerVisibility().visibleMessageIds`) or when the user sends.
- **History paging** (the client is ephemeral, so paging is the session's): when the viewport reaches the start and the snapshot's `page.truncated`, `session.loadOlder()` captures `{ gen, rev, client }`, calls `ai.hydrate({ threadId, limit: PAGE_SIZE, before: cursor })`, and on return **discards** the page if `gen`, `rev` or the client changed (a recovery or a `session.cleared` happened meanwhile, review r2-7). Otherwise it prepends in one synchronous step: messages deduplicated by id, `client.setMessagesManually([...older, ...client.getMessages()])` (`setMessages` only replaces the array, `processor.ts:283-286`), and the page's `abacus.runOutcomes` merged into `store.runs.outcomes` by `runId` (review r2-8). Prepend preservation keeps the viewport stable. A `Skeleton` row shows while loading; a failure shows "Couldn't load earlier messages" + Retry.
- **Bounded rendering and retention** (reviews r1-22, r2-12). Two budgets, independent of each other:
  - **Mounted rows** (`MAX_ROWS = 400`, counting messages, tool rows and sub-agent rows as the transcript renders them): the transcript mounts only the newest rows within the budget; everything older is a single "Show earlier" row that mounts the next 100 on activation or when scrolled into view. This bounds a replayed active run of any length and a single message with thousands of tool calls, because within one message tool rows past the first 50 collapse into "{n} more steps" (expanded in batches of 100). Rows are unmounted only while the user is at the end, so reading history never shifts.
  - **Processor retention** (`MAX_MESSAGES = 300`): when a prepend pushes the client past it while the user is at the end, the oldest completed messages (never the active run's) are dropped with `setMessagesManually` together with their outcome records, and the paging cursor is moved to the new first message, so `hasOlderMessages` is true again.
  R2-T31 is a **gate** over both (§13).
- **Timestamps** (finding r1-20): `messageTime(m) = m.createdAt ?? parseIso(m.metadata?.tanstack?.createdAt) ?? null` (C.3 keeps time in `metadata.tanstack.createdAt`). Day separators (BotChat "Today") are placed before the first message of each local day with a known time; messages without a time never start a new day.
- **Scroll fade at the top** (BotChatScrolled): the viewport's `scroll-fade-t` when scrolled.

---

## 11. Fixtures and gallery

### 11.1 Fixture player

`fixtures/player.ts` builds a fake `AppClient` slice (`ai.subscribe`, `ai.send`, `ai.hydrate`, `ai.joinRun`, `ai.cancel`, `ai.respondPermission`, `ai.queue.*`) over a scenario, and the **real** `ThreadSession` runs on top of it, so every fixture exercises the session, the pump, the dispatcher, the store and the kit exactly as production does.

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
- **Migrated scenarios** (review r1-12, r1-13): recorded v1 transcripts, one per `ConversationSegment` type (including tool groups, rejected and interrupted tools, subtasks, media, notifications, compaction), converted by the real `shared/transcript/v1-to-ui-messages.ts` mapper (transport C.3) into `snapshot.messages`.
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

Iterator error → the §3.3 recovery table: after reconstruction, reopen `ai.subscribe` from `reconstructCursor` (in the ring → seamless); before reconstruction, or on `abacus.resync`, a new generation (fresh snapshot, fresh client). Permission and queue state come from the new snapshot, so a card answered during the gap disappears and one raised during the gap appears. R2-T4.

### 12.3 Run finished while unmounted

Unmount unpins the session; it stays in the LRU with its client subscribed until evicted (then `retire()`: `unsubscribe()` + `dispose()`). Remount within the LRU shows the live state at once; after eviction, `load()` builds a new generation whose snapshot contains the finished run and its outcome record (§14.7); no join because `activeRun` is null. R2-T7.

### 12.4 Permission answered elsewhere

Covered in §6.3 (second window, notch, auto-allow, expiry). R2-T22.

### 12.5 Stale thread

- The session row is deleted (`db.sessions` delete) while the view is open: the route's `notFound` (phase 3/4) unmounts the view; the kit also stops sending on `NOT_FOUND` from any `ai.*` call and turns the composer read-only (§4.6).
- The agent process restarted (new incarnation, `session.ready`): descriptors of the old incarnation are dropped; a `RUN_ERROR {agent_exit | agent_crashed}` already closed the run; queued messages come back through the next `queue.updated`.
- Reset (`session.cleared`): messages cleared, stores reset (§4.2).
- Workspace folder missing (SessionWorkspaceMissing): the route passes `composer.readOnly` ("Can't send: {path} no longer exists."); the transcript stays readable.

### 12.6 Queue while busy

§8.3/§8.5. The two-window race (`queued` ack) is §3.7 + §4.6. R2-T21.

### 12.7 Other cases

| Case | Behaviour |
|---|---|
| `ai.*` answers `UNAVAILABLE` before the emitter lands (transport A.3 `UnavailableAguiSource`) | `session.load()` rejects; the route shows "The agent isn't available yet" with Retry (a new `load()`), composer disabled. |
| Two views of the same thread in one document (mini composer + full view) | One `ThreadSession` (§3.1) and one client; both views read the same host store. |
| Server-initiated run (routine, messaging, dequeue) while idle | Arrives on the live subscription (`live: true`); `RUN_STARTED` → busy; the user `TEXT_MESSAGE` shows the message; nothing special. |
| Hidden bot housekeeping permission (no `runId`) | `PermissionList` (bots) / composer slot (sessions); lineage validates by `turnSeq` (agent spec §3.5.3). |
| Very long tool output | Each `tool.output` **replaces** the buffer, exactly as today's transport does with `tool_output_update` (`conversation/transport.ts:379-394` passes `event.output` through as the card's whole output); the agent forwards pi's `partialResult` unchanged (`session.ts:2529-2538`). Whether pi's `partialResult` is cumulative is not re-verified here; replacement keeps today's rendering either way. The expander renders only the last 2,000 lines with "Show all" opening a dialog. |
| HMR of kit modules | `createChatUI` configs are module singletons; Fast Refresh re-creates them; the session cache lives on `globalThis[Symbol.for("abacus.chat.sessions")]` like the transport (foundation §8.1), so clients and streams survive a component edit. |

---

## 13. Tests

Projects: **jsdom** = vitest project `renderer-next` (foundation §3.7); **Electron** = `main-serial` using the A-T12 harness (isolated profile + CDP, as foundation R1-T11b/R1-T22); **type** = `tsc -b` plus `expectTypeOf` in the jsdom project. "Memory transport" = the real `RPCHandler`/`RPCLink` over a `MessageChannel` (foundation `createMemoryTransport`) with a fake `AguiSource` in main; "real host" = `AguiHost` from `packages/agent/src/agui/host.ts` driven in process with the fake provider (agent spec §7.2 harness).

| Id | File | Runs in | What it proves |
|---|---|---|---|
| R2-T1 | `runtime/positions.test.ts` | jsdom | §3.3: `receivedSeq`/`appliedSeq` start at `startSeq − 1` with an active run (so `RUN_STARTED` is replayed; inclusive interval) and at `N` without one; before any replayed content the store's `runs.active`, `busy`, the Stop target and the client's `sessionGenerating` are set (review r2-1); `reconstructed` flips only when `appliedSeq ≥ N`; recovery table rows; a stale generation's hydrate is dropped. |
| R2-T2 | `runtime/host.test.tsx` + `host.types.test.ts` | type + jsdom | `useThreadHost` output `satisfies UseChatReturn` from `@tanstack/ai-react@0.29.3`; rendered through the real `createChatUI`; `sendMessage`/`reload`/`stop` map to `submit`/`retry`/`cancel`; after a generation swap, the old client's `unsubscribe()`/`dispose()` notifications, a late `submit` ack and a late older page from the old generation leave the new binding unchanged (reviews r1-1, r2-6). |
| R2-T3 | `runtime/ordering.test.ts` | jsdom | Seeded property test (2,000 sequences) over hydrate at `N`, join replay, live events, iterator failures at every position and generation restarts: the client of the final generation processes every seq in `(startSeq, max]` exactly once, in order, and its `getMessages()` equals a fresh `StreamProcessor` fed the completed transcript then the same events. |
| R2-T4 | `runtime/recovery.test.ts` | jsdom (memory transport) | Join failure after each individual replay chunk before `N` → new generation, final messages identical to an uninterrupted client (finding r1-7); failure after `N` → seamless switch; `abacus.resync` with a subscription open and with a join open → new generation, one subscription afterwards, old client disposed (finding r1-8); ring eviction with a `session.cleared` during the gap → the new generation shows `[]` (finding r1-9). |
| R2-T5 | `runtime/dispatcher.test.ts` | jsdom | The dispatcher wakes for a push while the pump's server read is idle and for an abort; items keep push order; a closed generation's stream ends (review r1-5). With a replay larger than the client's 8 ms processing budget (`chat-client.ts:92`), `appliedSeq` trails `receivedSeq` and every terminal's `RunOutcomeRecord` (steps, `afterMessageId`) and readiness are computed only after the client processed that terminal (review r2-5). |
| R2-T6 | `runtime/user-echo.test.ts` | jsdom (memory transport + real host) | The agent's own echo (`host.ts:327-331`) with the client id leaves exactly one user message with unchanged text in the sending window (single-line, multi-line, 20 KB), and the same message in a second window and in a later hydrate; no main-side echo exists (finding r1-3). |
| R2-T7 | `runtime/unmounted.test.ts` | jsdom | A run finishes while the view is unmounted; remount (same session within the LRU, or a retired one) shows the finished transcript and its outcome record, no busy state, no leaked iterator (the fake counts open iterators: 0 after `retire`). |
| R2-T8 | `store/apply.test.ts` | jsdom | The §4.2 table row by row; session slices from the snapshot (permissions, queue, agent, skills, activity, notices, outcomes) with no further events arriving after hydrate (review r2-4); run-scoped slices rebuilt from inclusive replay: a reload during live bash output restores the output so far, a reload after `tool.display` but before the result restores the diff (review r1-10); successive disjoint `tool.display` patches merge (review r1-17); `permission.pending` authoritative; incarnation change drops old descriptors; `session.cleared` resets. |
| R2-T9 | `store/json-patch.test.ts` | jsdom | `add`/`replace`/`remove`, pointer escaping, `add /plan` when absent (agent spec finding 19), idempotent re-application, unsupported op → `agent = null` until the next snapshot. |
| R2-T10 | `store/busy.test.ts` | jsdom | `busy` is true from submit to terminal across: the turn column arriving before and after `RUN_STARTED`, an admission before `RUN_STARTED` (outbox), a server-initiated run, a permission wait, and a restored active run before any replayed content. |
| R2-T11 | `kit/parts.test.tsx` | jsdom | The exported `SessionUI` and `BotUI` configurations (not test-local ones) over live and C.3-migrated fixtures: plain text, every `metadata.abacus.kind`, image, **video** (registered, review r2-10), credits footer, tool groups; empty assistant message renders nothing (review r1-12). |
| R2-T12 | `kit/widget-maps.test.tsx` | jsdom | F7: an MCP tool name and an unknown sub-agent name render `ToolLine` and `SubagentCard`; no `console.warn`, no throw; a card's nested `<Parts/>` still resolves unknown tool names (proxy not spread). |
| R2-T13 | `kit/tool-line.test.tsx` + `tools/normalize.test.ts` | jsdom | `normalizeTool` on recorded emitter calls with `output === undefined` (running), streamed `tool.output`, successive `tool.display` patches, then the result (review r2-9); migrated successful, denied, cancelled, edit and terminal results (review r1-13); status words; title equals `buildToolTitle(name, finalInput)` after `TOOL_CALL_END` and uses `parsePartialJSON` before. |
| R2-T14 | `kit/subagents.test.tsx` | jsdom | Parallel delegates with colliding legacy ids stay apart; child results render before the error status (agent spec §3.1.5 order); status sub-lines; Stop calls `ai.cancel({ threadId, runId: parentRun })`, never `handle.stop` (F11); Open calls `onOpenSubagent`. |
| R2-T15 | `kit/status.test.tsx` | jsdom | `BusyLine` labels (one tool, several tools, sub-agents, retry, needs you); `RunMarker` duration and steps; `ErrorCard` action table incl. unknown actions and the upgrade variant; `Notice` dedup by `notificationKey`. Also: outcome records rendering at `afterMessageId` for a pre-output cancellation and a message-free failure after reload (finding r1-21) |
| R2-T16 | `scroller/transcript.test.tsx` | jsdom + Electron | jsdom: `messageId`/`scrollAnchor` per message, `aria-busy` while active, new-message marker, timestamps with and without `metadata.tanstack.createdAt` (review r1-20); paging: a page returned after a recovery or a `session.cleared` is discarded, ids are deduplicated, and an older page's failed and cancelled runs get their markers (reviews r2-7, r2-8). Electron: `data-pending-scroll` before the first paint (F15); prepend keeps the first visible message at the same offset (±1 px); loaders awaiting `load()` with a 2 s hydrate and with a 2 s `joinRun` on a thread whose only run is active commit only after the active run's echo and streamed content are in the transcript, and the first captured frame shows the transcript end; two concurrent `load()` callers get the same promise (reviews r1-11, r2-3). |
| R2-T17 | `markdown/markdown.test.tsx` | jsdom | Headings, lists, tables (scroll wrapper), code blocks with header and Copy, links routed by §7.5 (http → `openExternal`, abs path → `onOpenFile`), raw HTML escaped, `javascript:` link rendered as text, an unclosed fence renders as a block without Copy while streaming. Also: the §7.5 link table (finding r1-19) |
| R2-T18 | `markdown/references.test.tsx` | jsdom | Reference links and footnotes whose definitions are far from their use render correctly in long streaming messages (whole-document rendering, finding r1-18). |
| R2-T19 | `markdown/math.test.ts` | jsdom | Pre-pass table (§7.3): closed vs unclosed for all four delimiters, streaming prefixes of each, `$5 and $6` stays text, math inside code fences and inline code untouched; display math → `math` fence → MathML with `display="block"`; inline → sentinel inline code → MathML; parse errors render `.temml-error`; `import temml from "temml"` works and named imports are not used (a lint-level grep); 200 hostile inputs produce no `<script`, `on*=`, or `javascript:`. |
| R2-T20 | `runtime/admission.test.ts` | jsdom (memory transport) | `routeSubmit` truth table (noop, blocked: read-only, question pending, uploading, loading; send with `forwardedProps` only pre-start; enqueue when busy; IME never submits; `deriveSessionTitle` ported cases). Admission isolation (review r2-2): while run A streams **partial tool arguments and reasoning**, admission B gets `queued`, then `rejected`, then a thrown `UNAVAILABLE`; A's tool arguments, reasoning and text continue into the same parts and its final `getMessages()` equals an undisturbed run's; the outbox entry for B appears and disappears without any processor change; `started` removes the entry exactly when the echo is processed. |
| R2-T21 | `runtime/queue.test.ts` | jsdom (memory transport + real host) | Busy submit calls `ai.queue.enqueue`; rows appear only from `queue.updated`; edit/remove carry `incarnation` + `entryId`; an edit after a respawn (new incarnation, same `q-1`) and an edit racing a drain are rejected by the agent and change nothing (review r1-14); the two-window race: window B's admission is acked `queued` before A ends and its text is in the queue slot. |
| R2-T22 | `kit/permissions.test.tsx` | jsdom | Through rendered controls only: two pending descriptors, the second answered first, in both skins (finding r1-15); placement; answered elsewhere; `response_rejected` messages; timeout; expiry. |
| R2-T23 | `kit/permission-presenters.test.tsx` | jsdom | For every `request.type` variant, from real descriptors: title, path field (`filePath`, `notebookPath`, `resolvedPath`/`deducedDirectory`), diff body (`newContent` for edits, `content` for writes incl. existing-file writes, notebook cells) and exactly the allowed decisions (finding r1-16). |
| R2-T24 | `kit/question.test.tsx` | jsdom | The questionnaire encodes answers byte for byte like `chat-composer.tsx:1018-1037` (single, multi, note, skipped question) (F19); letters shortcuts and `Mod+Enter` work; "Skip all" sends `"reject"`. |
| R2-T25 | `composer/composer.test.tsx` | jsdom | Geometry state machine per skin/mode (§8.1 table), Stop replaces Send while busy, mode chip labels/descriptions/values and optimistic revert after 5 s without `STATE_DELTA`, pre-start mode goes out once as `forwardedProps.mode`, attachments (path, pasted → `savePastedTemp`, error chip, disabled without base), `@`/`/` menus insert text, `ArrowUp` edits the last queued item, `Mod+.` stops only in the focused view. |
| R2-T26 | `gallery/a11y.test.tsx` | jsdom | axe (`color-contrast` off in jsdom, as R1-T8) over every chat scenario; the status region announces each milestone once; every icon button has a name; cards are `role="group"` with a label. Also: the permission tray chips (`aria-pressed`, labels) |
| R2-T27 | `motion.types.test.ts` + `motion.test.tsx` | type + jsdom | `motion/react` exports used here type-check against the pinned `motion`; with reduced motion, layout animations are cuts and fades are 120 ms; the composer's children delay equals `durations.layout - durations.childFade`. |
| R2-T28 | `e2e/chat-transitions.mjs` | Electron | A `nav-lateral` switch between two long threads starts one view transition whose new snapshot shows the transcript end; a streaming update never starts a view transition (`document.activeViewTransition` stays null during a replayed stream). |
| R2-T29 | `fixtures/fixtures.test.ts` | jsdom | Copied agent goldens equal their sources; builder scenarios type-check as `AguiEvent`; every canvas board in `canvas-map.ts` has a scenario; every scenario replays to completion with no warnings. Also: C.3 fixtures produced by running the real `shared/transcript/v1-to-ui-messages.ts` mapper over recorded v1 transcripts (one per segment type) |
| R2-T30 | `guards.test.ts` (extends R1-T15) | jsdom | AST scan of renderer-next: no calls to `agent.respondPermission`, `agent.queue.*`, `.stop()` on a `SubagentHandle`, or any `ChatClient` request method (`sendMessage`, `append`, `reload`, `addToolResult`, `addToolApprovalResponse`, `resumeInterrupts*`, `resolveInterrupts`, `stop`, `attach`, `detach`) outside `runtime/`, and none inside it except `subscribe`/`unsubscribe`/`dispose`/`getMessages`/`getSubagents`/`setMessagesManually`; no `useChat` import; no named `temml` import; `features/chat` imports no other feature; routes import only `features/chat/index.ts`. |
| R2-T31 | `perf/transcript.bench.test.tsx` | Electron | **Gate** (reviews r1-22, r2-12) on the reference M-series Mac: (a) a 1,000-message thread with rich Markdown (code, tables, math), 1,500 tool rows and 5 sub-agent cards: first paint < 600 ms, scroll ≥ 50 fps median, mounted rows ≤ `MAX_ROWS`; (b) a replayed active run of 800 events producing 350 messages: readiness < 800 ms, mounted rows ≤ `MAX_ROWS`; (c) one message with 3,000 tool calls: first paint < 400 ms; (d) streaming 20 KB of Markdown: main-thread tasks < 50 ms at p95. A failure blocks the phase gate; the fallback is lowering `MAX_ROWS` until it passes, then a virtualisation slice. |
| R2-T32 | `e2e/chat-real-session.mjs` | Electron (real agent, fake provider) | The phase gate (§15): a real session streams text, a `bash` tool with live output, an `edit` that raises a permission answered with "Allow once", the tool result, and `RUN_FINISHED`; a reload mid-stream resumes without loss or duplicates; Stop mid-run ends with "Stopped"; a busy submit steers the turn. Also: an attachment-only submission (text is only `@path` lines) reaching the agent as a non-empty prompt through `uiMessagesToWire` (finding r1-2) |
| R2-T33 | `runtime/steer-ids.test.ts` | jsdom (memory transport + real host) | A persisted transcript containing a steer from process 1, then a replacement process that steers again: both steers are separate messages with their original texts after live delivery, a new generation and a later hydrate (review r2-11; relies on the agent slice's incarnation-scoped ids, §14.11). |
| R2-T34 | `runtime/connection.test.ts` | jsdom (memory transport) | `connection` is `"connected"` after `abacus.subscribed` on an idle thread with no further AG-UI event; `"reconnecting"` during a pump retry with no following event; `"error"` after three failures; `connectionStatus` on the host follows it, not the client's chunk-driven state (review r2-13). |

---

## 14. Amendments this spec requires elsewhere

1. **`ai.hydrate` (transport A.3; agent spec §5.3), "main AG-UI relay" slice.** `messages` stays as agent spec §5.3 defines it: the transcript as of the last terminal, **excluding every message of the active run** (the kit rebuilds them from replay, §3.3; r1's F2 remedy of including live active-run messages is withdrawn, finding r1-4). The output gains `abacus`:

   ```ts
   interface ThreadSnapshot {
     cursor: number;                                            // relay seq N of the checkpoint
     incarnation: string | null;
     activeRun: { runId: string; startSeq: number; startedAt: number; serverInitiated: boolean } | null;
     permissions: PermissionDescriptor[];                       // live incarnation only
     queue: QueueEntry[];
     agent: AgentState | null;
     skills: SkillMetadata[];
     activity: { status: AgentStatus; runningTools: number };  // latest agent.status / agent.heartbeat
     notices: Notice[];                                         // live agent.notification / non-terminal agent.error, deduplicated by notificationKey
     runOutcomes: RunOutcomeRecord[];                           // item 7, for the returned message window
   }
   ```

   Every session-scoped slice the kit keeps is in the snapshot (review r2-4), including activity and notices raised outside the active run; run-scoped state (live tool output, tool display, retry) is rebuilt by the kit from the inclusive `joinRun` replay (review r1-10). Notices are cleared from main's copy when a later event supersedes them (same `notificationKey`) or at `session.cleared`. All fields are read in one synchronous relay turn (agent spec §5.3 point 3). `page` applies to `messages` and to `runOutcomes` together.
2. **UIMessage → AG-UI input conversion at the main boundary** ("main AG-UI relay" slice; coordinator decision 4, finding r1-2). `ai.send` accepts `messages: UIMessageLoose[]` (parts); before writing the `run` command, main converts them with `uiMessagesToWire` from `@tanstack/ai` (`src/index.ts:522`), keeping each message's `id`, so the agent's `newestUserMessage` (`packages/agent/src/agui/host.ts:64-98`, which reads `content`) sees the text and the agent's echo carries the client id. A test in that slice sends a text message, a multi-line message and an attachment-only message (`@path` lines) through the real contract and host and asserts `run.ack {started}` and the echo id.
3. **`ai.joinRun`** (transport A.3): yields **every** relay event of the thread whose seq lies in `[RUN_STARTED.seq, terminal.seq]`, session-scoped ones included, each with `withEventMeta(event, { id: String(seq) })`, starting at `activeRun.startSeq`.
4. **`ai.subscribe`** (transport A.3): `lastEventId` means "events with seq greater than this"; the first yield stays `abacus.subscribed`.
5. **`ai.send`** (transport A.3; agent spec §3.1.6, §5.2): output `{ runId; status: "started" | "queued" | "rejected" | "duplicate"; reason?: "regenerate_unsupported" | "empty" | "resume_unsupported"; entryId?: string }`, resolved from the agent's `run.ack` for that run id. Main injects no per-subscription terminal (F6). `forwardedProps.whenBusy` is removed from the transport row.
6. **Permission and queue procedures** (`contract.ai`), with the agent-side requirement for queue identity (coordinator decision 8, finding r1-14):

   | Procedure | Input | Output | Maps to |
   |---|---|---|---|
   | `ai.respondPermission` | `{ threadId, lineage: PermissionLineage, decision: PermissionDecision }` (valibot union mirroring `protocol.ts:256-266`) | `void`; outcome on the stream (`permission.resolved` / `permission.response_rejected`) | `permission.respond` (agent spec §2.2) |
   | `ai.queue.enqueue` | `{ threadId, message }` | `void` | legacy `enqueue {message, hidden: false}` |
   | `ai.queue.update` | `{ threadId, incarnation, entryId, message }` | `void`; outcome on the stream | **new agent command** `queue.update {incarnation, entryId, message}` |
   | `ai.queue.remove` | `{ threadId, incarnation, entryId }` | same | **new agent command** `queue.remove {incarnation, entryId}` |
   | `ai.queue.clear` | `{ threadId }` | `void` | legacy `clear_queue` |

   **Agent slice requirement:** `HostCore` handles `queue.update` / `queue.remove` by checking `incarnation` against its own and looking the entry up **by id** in its current queue, then mutating it in the same synchronous step (no index crosses a process boundary). A mismatch or a missing id emits `CUSTOM queue.command_rejected {entryId, reason: "incarnation" | "not_found"}` followed by the authoritative `queue.updated`, and writes nothing to compat. The accepted path produces the same compat lines as today's `update_queue_item` / `remove_from_queue` for that entry's index. `agent.respondPermission` and `agent.queue.*` stay for the old renderer only.
7. **Durable run outcomes** (finding r1-21): main's thread store persists, independently of assistant content, one `RunOutcomeRecord` per terminal: `{ runId, kind: "success" | "cancelled" | "error", startedAt, endedAt, steps, usage?, error?: AgentErrorPayload & { code?: string }, afterMessageId: string | null }`, where `afterMessageId` is the id of the last transcript message at the terminal (the run's user echo when it produced nothing else). It lives beside `messages` in `ThreadFileV2` (transport C.3) as `runs: RunOutcomeRecord[]` for `source.kind === "agui"` files (migrated files have none) and is returned as `abacus.runOutcomes`. Cancellation during preparation and message-free failures therefore survive reload.
8. **Foundation spec**: `createAppRouter` adds `chat: ChatRuntime` to `RouterContext` (§6.4); thread route loaders await `session.load()` (§3.2); the gallery accepts extra sections from the `[__ui].tsx` route; R1-T15 gains the R2-T30 checks; `@shadcn/react ^0.3.1` is a phase-2 prerequisite (F15).
9. **Dependencies** (desktop `devDependencies`): add `@tanstack/ai-react` **0.29.3** exact (used for `createChatUI` and the `UseChatReturn` type; `useChat` is not called); add `temml` **0.13.5** exact; keep `@tanstack/ai` 0.63.0, `@tanstack/ai-client` 0.36.0, `@tanstack/markdown` 0.0.13, `@tanstack/highlight` 0.0.10. Not added: `@shadcn/helpers` (F8), `@tanstack/react-virtual` (F10, pending the R2-T31 gate). `@tanstack/react-ai-devtools` is left out (peer range against ai-client 0.36 unchecked).
10. **PLAN.md**: the busy-input amendment line was added under "Amendments" (F1, coordinator decision 2). Still to amend when the plan is next revised: virtualisation replaced by paging plus bounded retention (F10); fixtures by replaying agent goldens (F8); the chat kit lives in `features/chat` composed by routes; math via a pre-pass (F9).
11. **Agent spec**: none for the user echo (F3 withdrawn: `AguiHost.onRun` already echoes the user message with the client id; the agent-side fix for Stop races is in progress in that slice). **Steering and fallback message ids are scoped by incarnation in the agent slice** (done there, from `reviews/00-agent-agui.impl-claude-r1.md` item 3: `steer-N` restarted at 0 per process, `agui/ids.ts:15`, `emit.ts:523`, so a new process's `steer-1` rewrote the persisted `steer-1`); the kit relies on replayed ids never colliding with completed history (review r2-11) and R2-T33 checks it end to end.

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
| TanStack AI internals the kit depends on (ephemeral `ChatClient` with `initialMessages`, synchronous per-chunk processing in `consumeSubscription`, the synchronous `QueueStrategy` call, property-get widget lookup, `UseChatReturn`) change in a minor release. | Exact pins (0.29.3 / 0.36.0 / 0.63.0); R2-T2, R2-T5, R2-T12 and R2-T20 exercise each assumption and fail loudly on a bump. |
| Generations and the reconstruction cursor are subtle. | Pure cursor rules with their own tests (R2-T1), a seeded property test over failures at every replay position (R2-T3, R2-T4). |
| Main- and agent-side amendments (§14.1–§14.7) land in other slices. | The kit's tests run against a main relay fake implementing exactly §14; the real-session gate (R2-T32) cannot pass until they land, which makes the dependency explicit. |
| Queue edits race drains and respawns. | Incarnation + entry id validated and applied atomically in the agent (§14.6); R2-T21. |
| Math fonts in Chromium: temml's README warns about rendering bugs with system fonts. | r1 ships `Temml-Local.css` + `Temml.woff2`; the screenshot run includes a math scenario on macOS and Windows; if glyphs are wrong, bundle Latin Modern (380 KB, lazy with the math chunk) in a follow-up. |
| No virtualisation (F10) for very long threads. | Paging, the mounted-row budget (`MAX_ROWS = 400`, bounding active replay and single huge messages) and processor retention (`MAX_MESSAGES = 300`), with R2-T31 as a gate and a defined fallback (§10). |
| The highlight grammar gap (F17). | Plaintext fallback with full chrome; bumping `@tanstack/highlight` is a separate reviewed change. |
| Busy detection from three sources can disagree for a frame. | Any one being true means busy (§4.4). An admission that races another window's run is acked `queued` by the agent and lands in the host queue; it never touches the processor (§3.7). |
| `@tanstack/markdown` re-parses whole messages per render. | One document per message (the split was removed for correctness); the cost is inside the R2-T31 gate. |

---

## Review responses (r1)

Source: `docs/rewrite/specs/reviews/02-chat-kit.codex-r1.md` (22 findings, 5 blockers, plus verdicts on F1–F17). Each finding was re-checked against the installed `@tanstack/ai-client` 0.36.0 / `@tanstack/ai` 0.63.0 sources, the ai-react 0.29.3 clone, the implemented emitter in `packages/agent/src/agui/`, and transport C.3. Coordinator decisions applied: F3 withdrawn (the emitter already echoes); F1 kept as a throwing strategy with a PLAN amendment; own the `ChatClient`; conversion at the main boundary; one generation token plus a reconstruction cursor; one wakeable dispatcher with rejected admissions settled outside the processor; C.3-aware renderers and tool normalisation; queue identity = incarnation + entry id validated in the agent; independently answerable permissions; drop the Markdown split.

| # | Sev. | Verdict | Evidence checked | What changed |
|---|---|---|---|---|
| 1 | Blocker | **Accepted** | `useChat` keeps its client private and returns `setMessages`, not `setMessagesManually` (ai-react `types.ts` `BaseUseChatReturn`; `use-chat.ts:111-302`). | §3.1, §3.5: the kit owns the `ChatClient`; `useThreadHost` builds a `UseChatReturn` from it (`satisfies` against ai-react 0.29.3); R2-T2. |
| 2 | Blocker | **Accepted** | `newestUserMessage` reads `content` (`agui/host.ts:64-98`); `uiMessagesToWire` exported from `@tanstack/ai` (`index.ts:522`). | §3.4 sends a UIMessage; §14.2 puts the conversion in the main AG-UI relay slice with the client id kept; R2-T32 attachment-only case. |
| 3 | Major | **Accepted** | `AguiHost.onRun` → `emitter.userInput(runId, text, { messageId: newest.id })` (`host.ts:327-331`, `emit.ts:359-372`); two identical blocks concatenate (reviewer's repro; state persists after the first block, `processor.ts:1288-1312`). | F3 withdrawn; §3.4 relies on the single agent echo; §14.11; R2-T6 exercises the real host. |
| 4 | Blocker | **Accepted** | `dropTrailingInFlightAssistant` removes only the last message (`chat-client.ts:2080-2086`). | The client is ephemeral and never rejoins (§3.4); hydrate excludes **all** active-run messages and replay rebuilds them in a fresh client (§3.3, §14.1); F2 rewritten; R2-T3 includes multi-round tool loops. |
| 5 | Blocker | **Accepted** | r1's `localQueue` was drained only between server events. | §3.4 dispatcher: server reads live in the pump, `stream()` waits on one `Deferred` woken by pushes and aborts; R2-T5. |
| 6 | Major | **Accepted** | `updateRunLifecycle` resolves processing for any terminal; `handleRunErrorEvent` is global (`chat-client.ts:1296-1380`, `processor.ts:2260-2306`). | No synthetic `RUN_ERROR`: `send` throws an `AbortError` on `queued`/`rejected`, which `streamResponse` handles without the processor (`chat-client.ts:2656-2666`); §4.6 cleanup by message id; R2-T20. |
| 7 | Blocker | **Accepted** | A join failing below `N` then subscribing at `N` skipped reconstruction. | §3.3 `reconstructCursor`; failure before `N` starts a new generation; R2-T4 fails after every replay chunk. |
| 8 | Major | **Accepted** | `detach` does not abort the subscription (`chat-client.ts:1056-1065`); `attach` does not subscribe. | Recovery constructs a new client per generation (§3.3); `attach`/`detach` are not used (R2-T30). |
| 9 | Major | **Accepted** | `hydrateFromServer` applies messages only when non-empty (`:1186-1190`). | Each generation constructs its client with the authoritative messages, `[]` included (§3.3 step 3); R2-T4. |
| 10 | Major | **Accepted** | The r1 snapshot lacked run-scoped state and `appliedSeq = N` blocked replay. | Two cursors: session slices from the snapshot, run-scoped slices rebuilt from replay (§3.3, §4.2); R2-T8. |
| 11 | Major | **Accepted** | `prime` was fire-and-forget; hydration started after mount. | Loaders await `session.load()`; `ChatView` never renders an empty log before `ready` (§3.2); R2-T16 Electron case with a 2 s hydrate. |
| 12 | Major | **Accepted** | C.3 maps notification, collapsible, web_search_results, feature_limit, compaction and unknown to text parts keyed by `metadata.abacus.kind`, and video to `VideoPart`. | §5.3 metadata-aware dispatch, video, credits, tool groups; R2-T11 and R2-T29 with mapper-generated fixtures. |
| 13 | Major | **Accepted** | C.3 keeps legacy `ToolResult.output` in the call's `output` and `ToolResultData` in `result.metadata.abacus.data` (`agent-types.ts:273-336`). | §5.4a `normalizeTool` for live and migrated results; widgets read only `NormalizedTool`; R2-T13. |
| 14 | Major | **Accepted** | Entry ids are `q-${++this.queueIds}` (`agui/queue.ts:530`), process-local. | `ai.queue.update/remove` carry `incarnation` + `entryId`; new agent commands validate and mutate atomically (§8.5, §14.6); R2-T21 with respawn and drain races. |
| 15 | Major | **Accepted** | r1 exposed only the oldest descriptor. | §6.2 permission tray with selectable chips; bots already had independent cards; R2-T22 through rendered controls. |
| 16 | Major | **Accepted in part** | `write_file` carries `content`, `notebook_edit` carries `notebookPath`/`cellId`/`editMode` (`protocol.ts:282-289`, `:379-387`). The outside-directory field is `deducedDirectory` in `protocol.ts:358-377` for all four variants, which is the name r1 used, so that sub-point needs no change. | §6.4 per-variant presenters (typed on the `PermissionRequest` union); R2-T23 from real descriptors. |
| 17 | Major | **Accepted** | The emitter merges into its own state but sends `event.data` unchanged (`agui/emit.ts:594-606`). | §4.2: `tools.display[key] = { ...prev, ...data }`; R2-T8. |
| 18 | Major | **Accepted** | Reference definitions and footnotes are document-wide. | The split optimisation is removed (§7.1); R2-T18 now guards whole-document semantics. |
| 19 | Major | **Accepted** | `sanitizeUrl` drops every non-allowed scheme and strips whitespace (`@tanstack/markdown dist/utils.js:53-64`). | §7.5 pre-pass rewrites file targets to `#abacus-file=…`; `ChatViewProps.workspaceRoot`; R2-T17. |
| 20 | Minor | **Accepted** | C.3 time is in `metadata.tanstack.createdAt`. | §10 `messageTime` fallback; R2-T16. |
| 21 | Major | **Accepted** | r1 stamped outcomes on assistant messages only. | §14.7 durable `RunOutcomeRecord`s with `afterMessageId`, returned by hydrate; §5.1 renders from them; R2-T15. |
| 22 | Minor | **Accepted** | The scroller's `PERFORMANCE.md` excludes Markdown cost; paging accumulates. | §10 bounded retention (`MAX_MOUNTED = 300`); R2-T31 is a gate over fully mounted rich transcripts and active-run replay, with a defined fallback. |

**Verdicts on F1–F17.** F1: kept, now a throwing strategy (coordinator decision 2). F2: diagnosis kept, remedy replaced (#4). F3: withdrawn (#3). F5, F6: redesigned (#5–#7). F9: rendering approach kept for math; links added to the pre-pass (#19). F10: conditional on the R2-T31 gate (#22). F12: now relevant only to real `RUN_ERROR`s (#6). F15: first paint gated on load (#11). F16: queue identity extended (#14). The others stand as written.

## Review responses (r2)

Source: `docs/rewrite/specs/reviews/02-chat-kit.codex-r2.md` (13 items, 2 blockers). All accepted; each re-checked against the installed `@tanstack/ai-client` 0.36.0 / `@tanstack/ai` 0.63.0 sources and `packages/agent/src/agui/`.

| # | Sev. | Verdict | Evidence checked | What changed |
|---|---|---|---|---|
| 1 | Blocker | **Accepted** | r2 dropped `seq ≤ startSeq`, skipping `RUN_STARTED`, and left `runs.active` empty. | §3.3: `receivedSeq`/`appliedSeq` start at `startSeq − 1` (inclusive replay); `runs.active` seeded from the snapshot; R2-T1 asserts busy, Stop target and `sessionGenerating` before any content. |
| 2 | Blocker | **Accepted** | `streamResponse()` calls `processor.prepareAssistantMessage()` → `resetStreamState()` before `send` (`chat-client.ts:2551`, `processor.ts:378-381, 3048-3062`); `isSendBusy()` excludes `sessionGenerating` (`:2311-2313`). The only callers of `streamResponse` are `sendMessage`, `append`, `reload`, interrupt resume and tool continuations (`:1620, 2345, 2452-2457, 2819, 3091`). | Admission moved out of `ChatClient`: `session.submit`/`retry` call `ai.send` directly with an outbox for pending user messages (§3.7); the client is receive-only and its adapter `send` throws; R2-T30 bans every request method; R2-T20 checks partial tool arguments and reasoning of a concurrent run. |
| 3 | Major | **Accepted** | r2's `load()` resolved before replay; its "returns at once" rule let callers bypass it. | §3.2: one readiness promise per generation, resolved when `appliedSeq ≥ N` (5 s cap with `partial`); R2-T16 delayed `joinRun` with an empty completed transcript and concurrent callers. |
| 4 | Major | **Accepted** | `agent.status`, `agent.heartbeat`, `agent.notification`, `agent.error` are session-scoped (agent spec §2.3) and were skipped at `seq ≤ N` without being in the snapshot. | `ThreadSnapshot` gains `activity` and `notices` (§14.1); §4.1/§4.2 partition rules; R2-T8 hydrates with no further events. |
| 5 | Major | **Accepted** | `consumeSubscription` yields to the host between chunks after an 8 ms budget (`chat-client.ts:92, 1942-1956`) but processes each chunk synchronously. | §3.4: the pump only receives (`receivedSeq`); the dispatcher applies pre-apply slices before yielding and runs post-apply hooks (terminal records, `appliedSeq`, readiness) when it resumes, i.e. after the client processed the chunk; R2-T5. |
| 6 | Major | **Accepted** | `unsubscribe()` emits loading/subscription/generation/connection changes synchronously (`chat-client.ts:2779-2791`). | §3.3 staging and atomic swap; every callback, ack and page result is guarded by `gen` (and `rev`); R2-T2. |
| 7 | Major | **Accepted** | r2's `loadOlder` had no guard. | §10: page discarded if `gen`, `rev` or the client changed; ids deduplicated; R2-T16. |
| 8 | Major | **Accepted** | §14.1 pages outcomes with messages. | §10 merges page `runOutcomes` by `runId`; R2-T16. |
| 9 | Major | **Accepted** | A running tool has `output === undefined`. | §5.4a: origin decided from the call (`metadata.abacus.segmentId` ⇒ migrated, else live) before any result; running state from live output/display; R2-T13. |
| 10 | Minor | **Accepted** | `partsComponents` lacked `video`. | §5.1 registers `video: VideoView`; R2-T11 uses the exported configurations. |
| 11 | Major | **Accepted (fixed in the agent slice)** | `steerMessageId(n) = "steer-" + n` restarts per process (`agui/ids.ts:19`); the same defect is `reviews/00-agent-agui.impl-claude-r1.md` item 3, which the agent slice is fixing by scoping steering and fallback ids by incarnation. | §14.11 records the dependency; R2-T33 checks persisted steers across a respawn. |
| 12 | Minor | **Accepted** | Retention deferred while reading, replay untrimmed, one message could hold thousands of tools. | §10: a mounted-row budget (`MAX_ROWS = 400`, per-message tool collapse past 50) independent of processor retention (`MAX_MESSAGES = 300`); R2-T31 benchmarks > 300-message replay and a 3,000-tool message. |
| 13 | Minor | **Accepted** | `connectionStatus` becomes `"connected"` only when the client processes a chunk (`chat-client.ts:2099-2101`). | §3.1/§3.4: `connection` owned by the pump (`abacus.subscribed`, retries, failures); the host exposes it; R2-T34. |

**Self-consistency pass (r3).** Every `§n`/`§n.m` reference to this spec and every `R2-T*` id in the text resolves; the tests are numbered R2-T1…R2-T34 without gaps; superseded r1/r2 mechanisms (the cursor gate, `localQueue`, synthetic terminals, the `AbortError` admission path, `detach`/`attach` recovery, the Markdown split, `MAX_MOUNTED`) remain only in the review tables.
