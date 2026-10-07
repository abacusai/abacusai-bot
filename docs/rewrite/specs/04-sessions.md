# 04 — Sessions (phase 4)

Status: spec **r3** (final spec round; no code). r2 answered Codex round 1 (`reviews/04-sessions.codex-r1.md`, 23 items), r3 answers round 2 (`…codex-r2.md`, 16 items) with the coordinator's decisions; responses at the end. Branch `rewrite/renderer`. It implements the "Sessions" phase of `docs/rewrite/PLAN.md` (§Areas and parity "Sessions", §Route tree, §Where state lives, §Motion system, §Sound, §Phases 4, and the Amendments), on top of:

- `00-transport-db-migration.md` **r2** with its implementation notes: sub-slice A (the contract: `workspaces.*`, `git.*`, `files.*`, `terminal.*`, `browser.*`, `devices.*`, `sessions.turnState`, `agent.*`, `settings.execBackend.*`, `system.*`; the A fixes: offset-addressed `terminal.output` ending in exactly one `exit` or `retired`, the device-chunk key-frame barrier, keyless actionable snapshots, credit flow control), sub-slice B (the `sessions`, `workspaces`, `gitState`, `routineRuns`, `artifacts`, `prefs` tables, `ipcCollectionOptions`, the two-stage workspace delete, read-only fields, caller ids);
- `00-agent-agui.md` **r3**: §3.5 (permissions, including unattached `sandbox_denied` / `network_host`), §3.3.4 and §3.6 (sub-agents), §3.8 (cancel), §8 (acceptance; the main AG-UI relay this phase needs live);
- `01-renderer-foundation.md` **r4**: folder layout and import rules (§4), routes, masks, `PANE_BOUNDARIES` and navigation types (§6), shell bands, sidebar slot, title bar and side panel (§7.1–§7.5), the occlusion watcher (§7.6), motion and sound modules (§7.8), hotkeys (§7.9), data layer (§8), gallery and screenshots (§10), test conventions (§11);
- `02-chat-kit.md` **r4**: `ChatView` with `skin: "session"`, the two-row composer and its context tray (`slots.composerContext`, §8.1), the permission tray (§6.2), `ToolLine` and the diff/bash expanders (§5.4, §5.4a), `SubagentCard` and `onOpenSubagent` (§5.5), `RunTail` and the reserved `ChangesCard` (§5.6), mode and model chips (§8.2), the draft store (§8.7);
- `03-bots.md` **r3**: its structure and its decisions (the loader-readiness rule and `updatePrefs(patch)` of §24.1, the shared `ConnectorRequestCard` with refresh-before-respond of §11.4, the preview-open consumer of §11.3, and the relay's `ai.runFinished` notice of §24.11, which this spec consumes unchanged);
- `05-routines-artifacts-library-settings.md` **r1**: consumes this spec's `components/file-preview`, `features/sessions/notify.ts`, the OSI-licence rule and the settings pages deferred in §27.3 (names kept stable in r3) (side-panel content as `?tab=`, a redirect for a former pop-up route, un-nested editor routes, loader preload guards, typed errors only, `shared/*` helpers with one-line re-exports from the old tree, `NavList` rows, a row menu rendered by both a context menu and a ⋯ button, the attention function and the needs-you group).

Paths are relative to `apps/desktop/` unless noted. Code in this spec is type declarations and short sketches only.

**Sources read for this spec** (versions are what is installed or pinned, checked on 30 Sep 2026):

| Source | Version / commit | Where |
|---|---|---|
| Old renderer, sessions | `HEAD 47e9e770` | `src/renderer/router.tsx:157-206`, `components/workspace/*` (`workspace-tree.tsx`, `sessions-tree.tsx`, `explorer-panel.tsx`, `code-diff-full.tsx`, `code-view.tsx`, `monaco-file-editor.tsx`, `artifacts-panel.tsx`, `workspace-activation.ts`, `workspace-missing-dialog.tsx`), `components/layout/{secondary-sidebar-panel,workspace-view,workspace-sidebar,titlebar,session-list-utils}.tsx`, `components/terminal/*`, `terminals/*`, `components/browser/*`, `components/device/*`, `components/chat/*` (session parts), `stores/{code-store,right-panel-store,browser-resource-store}.ts`, `lib/{preview-tabs,native-surface-occlusion,agent-browser,mentions,composer-draft}.ts`, `conversation/*` (checkpoints), `locales/en-US.json` (`workspace.*`), and their tests. The per-behaviour inventory is §2. |
| Shared and main | same | `shared/contracts.ts` (`AgentSessionListItem:341-370`, `WorkspaceListItem:51-60`, `GitStateSnapshot:181-187`, `GitChangeItem:77-84`, `TerminalSessionSnapshot:207-221`, `BrowserRuntimeState:1451-1463`, `DeviceStreamChunk:1041-1048`, `PrInfo:1404-1416`), `shared/conversation-scope.ts`, `main/services/browser/electron-browser-runtime.ts` (one presented view per window, parking), `main/service-host.ts`, `main/rpc/{procedures,tables}/*` |
| Contract (implemented) | same | `shared/contract/{sessions,workspaces,git,files,terminal,browser,devices,db,rows,ids,system,settings,agent,ai}.ts` |
| renderer-next (implemented) | same | `src/renderer-next/data/db/{index,tables,ipc-collection-options}.ts`, `data/transport/*` |
| `ghostty-web` | **0.4.0** installed (root `node_modules`, `"type": "module"`, MIT) | `dist/index.d.ts`: `init(): Promise<void>` (`:700`), `class Terminal` (`:1455`: `open`, `write(data: string \| Uint8Array, cb?)`, `resize`, `dispose`, `onData`, `onResize`, `onTitleChange`, `attachCustomKeyEventHandler` `:1631`, public `renderer?: CanvasRenderer` `:1465`), `class FitAddon` (`:181-224`); `dist/ghostty-web.js:2439-2443` (`resize` returns early for an unchanged size), `:954` (the modified-key encoder stops propagation) |
| `react-resizable-panels` | **4.14.1** installed at the repo root (`node_modules/react-resizable-panels/package.json`; r1 cited 4.12.3 wrongly); foundation pins `^4.14.1` | `dist/react-resizable-panels.d.ts`: `Group` (`:26`, `orientation` `:140`, `onLayoutChanged` `:121`), `Panel` (`:214`, `groupResizeBehavior` `:320`, imperative `collapse`/`expand` `:358-359`, `onResize(panelSize: { asPercentage, inPixels })`), `Layout` = percentages (`:623`), `Separator` (`:395`, `disableDoubleClick` `:420`), `useDefaultLayout` (`:448`) |
| `@danfessler/trellis` | 0.3.0 (npm, packed into the scratchpad; not installed, no clone) | `package.json` (`"type": "module"`, `types`), `LICENSE.md`, `README.md`, `dist/index.d.ts:567` |
| `@pierre/trees` | **1.0.0-beta.6** installed (Apache-2.0, ESM, `./react` export) | `dist/react/{FileTree,useFileTree}.d.ts`, `dist/index.d.ts:12` (`GitStatus`, `FileTreeRowDecoration`, context-menu slot) |
| `diff` | 8.0.4 installed (BSD-3-Clause, ESM) | used by the old `code-diff-full.tsx`; the kit's `DiffExpander` (02 §5.4) |
| `@tanstack/highlight` | 0.0.10 installed | 02 F17 (26 grammars) |
| `@tanstack/db` / `@tanstack/react-db` | 0.9.2 / 0.4.1 installed | as 03 §3 |
| `@tanstack/react-form` / `valibot` | 1.33.5 / 1.5.0 installed | as 03 F1 |
| `motion` | **not installed**; foundation pins 13.4.6 | APIs checked against the installed `framer-motion` 12.43.0 typings, as 03 §3 |
| `react` | 19.2.8 installed; foundation pins 19.3 | `ViewTransition`/`addTransitionType` absent from the installed runtime (only in `@types/react/canary.d.ts`); foundation §3.1 verified them in `react@19.3.0` |
| Electron | 44.4.5 installed | `WebContentsView` for browser runtimes (`electron-browser-runtime.ts`); the old renderer also mounts a `<webview>` for previews (`components/browser/preview-panel.tsx:289`, `main/index.ts:1049 webviewTag: true`) |
| Design canvas | artifact `XpL2PgWae6rUjXDTWyUqYX`, version `1790747894-aeaf` | page 3 "Sessions" (`Main`, `MainCollapsed`, `SplitView`, `FullView`, `FullViewFocused`, `SessionReview`, `SubAgents`, `SessionFailed`, `SessionWorkspaceMissing`, `SessionBrowser`, `SessionFiles`, `SessionsSidebarStates`), page 1 (`SessionRunning`), page 4 (`ComposerStates`, `PermissionStates`, `Pickers`, `ReadOnlyStates`), page 6 (`W900`, `W800`, `WidthRules`), page 8 (`SessionsSidebar`, `TopBar`) |
| Reference screenshots | `scratchpad/refs/gpt-*.png` | the ChatGPT app's Chat/Work toggle (`gpt-30-toggle.png`), thread with a changes card (`gpt-22-thread.png`), full view with tabs and floating mini composer (`gpt-15-fullview.png`) |
| Reviews | all 24 files | `docs/rewrite/specs/reviews/*` (defect classes applied in §27.4) |

---

## 0. Findings that change the brief (read first)

Each was checked against source. The ones that change another spec are repeated in §26.

| # | Brief / plan / earlier spec says | Verified fact | Consequence here |
|---|---|---|---|
| F1 | "terminal tab (xterm or the library the old renderer uses — verify)" | No `@xterm/*` or `xterm` package is installed (`node_modules/@xterm/` is an empty directory) and the desktop manifest names none. The old renderer uses **`ghostty-web` 0.4.0** (`renderer/terminals/terminal-views.ts`), which PLAN's stack table already lists ("terminal engine"). Its API follows xterm's: `init()` loads the bundled `ghostty-vt.wasm` once; `Terminal.write(data: string \| Uint8Array, cb?)`; `FitAddon.fit()`/`observeResize()`. | The terminal tab is `ghostty-web` (§11). No new dependency. The wasm is loaded once per document behind a lazy chunk. |
| F2 | "evaluate `@danfessler/trellis` against the small-lib rule (typed + ESM, maintained in 90 days)" | 0.3.0 is typed (`dist/index.d.ts`) and ESM (`"type": "module"`, `exports.import`), first published 26 Sep 2026 with three versions in three days, so it passes the letter of the rule. But its licence is `SEE LICENSE IN LICENSE.md`: **free for non-commercial use only; commercial use requires an active GitHub Sponsorship (≤ 10 developers) or an enterprise licence** (`LICENSE.md`, `README.md` "License"). It is framework-agnostic with imperative `mount(el)` views (`README.md`), so every React tab would render through portals it owns, and it brings its own 27 KB stylesheet and keymap. | **Rejected** (licence; also a second layout engine beside the registry `resizable`). The dock is our own, on `react-resizable-panels` v4 (§10). PLAN's "Small libraries" rule gains "and an OSI licence" (§26.8). |
| F3 | PLAN route tree: `sessions.$sessionId.review.tsx` a page; foundation `SessionSearch.tab = "changes" \| "terminal" \| "files" \| "browser"` | The canvas draws review as the **Changes tab** of the split view (`SessionReview`: the title-bar strip has "Changes 2" active, the chat stays at 480 px beside a changed-files list and a diff). As a flat-route child, `sessions.$sessionId.review.tsx` renders inside the chat's `<Outlet/>` (same trap as 03 F2). The old side panel also has **Agents** and **Device** tabs and preview tabs for files, images, documents and URLs (`stores/right-panel-store.ts:34-43`, `components/layout/secondary-sidebar-panel.tsx:225-345`); the canvas has an "Agents 3" tab (`SubAgents`) and several tabs of one kind at once ("localhost:5173", "Terminal", "+ New tab", `SplitView`, `FullView`). | `/sessions/$sessionId/review` becomes a redirect to `?tab=changes`. `SessionSearch.tab` becomes a **tab reference** string (`changes`, `files`, `agents`, `device`, `terminal:<id>`, `browser:<id>`, `preview:<key>`), parsed by a valibot regex with a fallback (§5.2). Foundation §6.2 is amended (§26.1). |
| F4 | Foundation §7.1: below 1100 px every side panel is a 356 px drawer over a scrim | Canvas `W900` ("split view folds into one tab strip") shows the sessions pane as **tabs** at 900: `Chat`, `Terminal`, `Files`, `+`, with the chat as a tab and no drawer; `W800` keeps "Chat", "Terminal", "2 more". The split boards at 1280 (`SessionReview`, `SessionFailed`, `SessionFiles`, `SessionBrowser`) show **no sidebar**: rail, chat 480 px, panel filling the rest. The arithmetic agrees: at 1000 with the sidebar pinned the content has `1000 − 56 − 280 − 8 = 656 px`, less than two 360 px minimums. | For the sessions area only: at `xl` a split with an open tab **folds the sidebar** (effective, prefs untouched, as foundation already does at `sm`); below `xl` the split view is not offered and the pane shows one tab strip with **Chat** as its first tab (`view` is effectively `full`). Bots keep the drawer. Foundation §7.1 and `layout.ts` gain the area rule (§10.3, §26.1). |
| F5 | PLAN "no state in two places … the new routes carry `workspaceId` and read the URL only" | Main computes git state, the file tree, search, rename, trash and `git.diff` against the **active workspace's primary checkout** only: `gitState` holds at most one row with no checkout identity (spec 00 B notes, "Triggers"); `files.treeRoot`/`search` take no workspace (`shared/contract/files.ts:30-36`; `service-host.ts:1789-1810` resolves the active root); relative mutations resolve against it. A session in a **worktree** (`worktreePath`) therefore gets an empty or wrong tree, and a rename/trash/discard could touch the primary checkout (Codex r1 #1). The old session route calls `switchWorkspace` whenever the workspace differs (`router.tsx:185-193`). | **Checkout-aware APIs are a main requirement of this phase** (coordinator decision, §26.4): every file/search/git call takes a `CheckoutRef { workspaceId, sessionId? }` that main resolves to the session's worktree or the workspace's primary checkout, and `gitState` rows are keyed by checkout. renderer-next **never calls `workspaces.switch`** (the legacy renderer keeps its own). R4-T33 proves a sibling worktree is served correctly and the primary checkout stays byte-identical. |
| F6 | "diff views for edits", PLAN Sessions "review (keep/undo)" | Nothing produces or restores checkpoints: `CheckpointEntry`/`checkpoint_captured` exist only in the old renderer's conversation types (`renderer/conversation/agent-types.ts:654-690`) with no producer in `packages/agent` or main; `stageFile`, `unstageFile`, `writeFile`, `saveResolvedConflict` are retired as unused (spec 00 A.2.1 #98-101). There is **no procedure that undoes a change**. | "Keep" is a review mark (ephemeral, per session and file). "Undo" per file needs a new `git.discard` procedure (§14.4, §26.4); until it lands the Undo buttons are not rendered (no dead controls). Undo **per change** (hunk) and "Undo" on the run's `ChangesCard` are deferred (§27.3). |
| F7 | "workspace picker and creation" | `workspaces.add({ path, isRemote? })` derives the id from the path (no `insert` on the table); `workspaces.ensureSessionHome()` makes the "Auto workspace"; `db.workspaces.delete` is **two-stage** (first tombstone `status: "deleted"`, then erase; spec 00 B notes). Workspaces with `kind: "routine" \| "bot"` are app-owned and kept out of pickers (`contracts.ts:58-59`). There is no procedure to move a session to another workspace (`rehome` is internal to bot recovery, `service-host.ts:2147-2150`). | The picker lists `kind ∈ {undefined, "auto"}` and `status !== "deleted"`; "Add a folder" is `system.dialog.openFolder()` then `workspaces.add` (§8.3). Remove confirms and deletes once (the tombstone); a tombstoned workspace shows "Removed" with Restore-by-re-adding. Canvas "Move to workspace…" is not built (§27.3). |
| F8 | "browser tab (webview/WebContentsView contract as it exists in main)" | Main presents **one** `WebContentsView` per window at a time (`electron-browser-runtime.ts:216-280`: `presentedLease`, `presentedBy`; `present` at `:268` hides the previously presented runtime); runtimes are keyed by `(conversationKey, resourceId)` with a `generation`; `promoteScope` moves draft runtimes to the session key. The native view paints above all DOM. Main's URL guard **rejects `file:`** in materialize, present and navigate (`checkedUrl`, `:63-75`: only `http:`, `https:`, `about:blank`). The old renderer renders **PDF and HTML file previews** in a `<webview src=file://…>` (`preview-panel.tsx:289`; `main/index.ts:978-987` strips node/preload), code in read-only Monaco, decks in `PptxViewer`, images as data URLs. | Coordinator decisions: (a) **one presentation owner** per window (§12.2): only the owning browser tab is presented; every other visible browser surface shows its captured placeholder and activates on click. (b) **Guarded local-file presentation** (§12.8, main amendment §26.4 f): a runtime kind for a local PDF/HTML file inside the session's checkout or the app's artifact folders, locked to that file, so embedded previews are **kept**, not retired. `<webview>` is still not used in renderer-next (one native path). |
| F9 | "devices stream (Uint8Array chunks with key-frame barrier)" | `devices.stream.start` returns `{ streamId }`; `devices.stream.chunks({ streamId })` opens on the current group of pictures or holds deltas until a key frame (A fixes); every key frame carries SPS/PPS; MJPEG chunks are all key frames (`DeviceStreamChunk.isKey`, `format`). The old renderer decodes H.264 with WebCodecs `VideoDecoder` (configured lazily on the first key frame, drops deltas when `decodeQueueSize > 8`) and MJPEG with `createImageBitmap`, and falls back to screenshot polling when `VideoDecoder` is missing (`components/device/device-screen-stream.ts:10-168,267`). | The Device tab ports that decoder unchanged into `features/sessions/device/screen-stream.ts` over the new iterator (§16). A reopen after `RESYNC_REQUIRED` re-enters at a key frame by construction; the decoder resets on every key frame's SPS change. |
| F10 | Chat kit: the session composer's context tray is a slot | Canvas tray contents: workspace, branch (mono), worktree ("New worktree" / "No worktree"), PR status, then on the right the plan summary ("Tasks 2 of 4"), "This Mac" / "Docker" / "Sandboxed", "No PR yet" or "Connectors" (`Main`, `SessionRunning`, `SessionFiles`, `SessionFailed`, `SessionReview`, `FullView`). The execution backend is a **global** setting with ids `local`, `docker`, `singularity`, `modal`, `daytona`, `ssh` (`shared/contract/settings.ts:26-33`, `shared/exec-backends.ts`: only `local` and `docker` implemented), state `{ selected, effective, statuses }` (`contracts.ts:2110-2114`); there is **no sandbox backend**: sandboxing is agent mode `AUTO` (`SandboxSupport`, `contracts.ts:911-915`). | `SessionContextTray` (§9.4) fills `slots.composerContext`. The right-hand target item shows the **effective backend** ("This Mac" = `local`, "Docker"), and "Sandboxed" is a **derived label** shown when the session's mode is Auto, not a backend choice (§8.2). Choosing a backend is an immediate global mutation, never draft state. |
| F11 | "sessions and bots feel different (different start page and composer, ChatGPT-app Chat/Work toggle as the reference)" | The reference (`gpt-30-toggle.png`) is one start page with a Chat/Work segmented control that swaps the composer (Work adds the project/files/plugins tray under the box). Our two kinds already live under two rail items with their own start pages (`BotNew` vs `Main`). | No toggle is added (it would duplicate the rail). The **difference is carried by the start page and composer**: sessions get "What should we build?", the 120 px two-row box with the context tray and starters (`Main`); bots keep the name pill and templates (03 §8). Both keep one rail item each (user decision "one sidebar per rail item"). |
| F12 | Foundation `SessionsSidebar`: filter `!botOwned && editorFor == null && routineId == null`, group by workspace | Today's shipped sidebar is a **flat** list across workspaces with date buckets, Pinned, a pin icon and an unread dot, and no running indicator (`components/workspace/sessions-tree.tsx:96-114`, `session-list-utils.ts:257`); the grouped tree with search, rename and running dots (`workspace-tree.tsx:118`, `CodeWorkspaceTree`) is dead code, mounted nowhere. Canvas `SessionsSidebarStates` adds per-row status (running dot + "running" chip, "+59 −5" diff chip, "needs you" chip, idle), a count per workspace, a collapsed folder, a **missing** folder (red, "missing"), search with highlighted matches and a "workspace · branch" sub-line, an empty state with "drop a folder here", and two row menus. Diff stats per session have no source: `gitState` is per workspace, not per session. | Rows show running / needs you / error / unread from `turn` and the attention function (§6.6); the diff chip shows only for the session whose workspace (or worktree) is the one `gitState` describes **and** only when that session's last run touched files (§7.3). Drop-to-add uses `window.abacusHost.getPathForFile` (spec 00 A.2.2 #50). |
| F13 | "sandbox/network attach UI" | Unattached `sandbox_denied` / `network_host` descriptors render in the chat kit's `PermissionList`/permission tray; attached ones join the running `bash` ToolLine (00-agent-agui §3.5.4, 02 §6.2). The canvas `SessionFailed` draws the sandbox card in the composer slot and "Sandboxed" in the tray. | Nothing new in the kit; this phase supplies the tray's "Sandboxed" state and the Terminal tab link from the card ("Open in Terminal" when the command ran in a visible terminal) (§17). |
| F14 | "routine-run sessions" | Routine runs are sessions with `routineId != null` (read-only, `contracts.ts:355-356`), listed by `routineRuns`; `editorFor != null` sessions are hidden editor turns. | Not in the sessions sidebar (foundation filter kept). `/sessions/$id` for a routine run renders read-only with the routines banner (canvas `ReadOnlyStates` "One run of a routine"), and "Talk to the routine" links to `/routines/$routineId` (phase 5). |
| F15 | Foundation §4: collections under `data/collections/` | Implemented as `src/renderer-next/data/db/` (03 F14). | This spec imports from `#next/data/db`. |
| F16 | User decision: "terminal is a side-panel tab, no bottom panel" | Today the terminal is a **bottom panel** under the chat (vertical group `local-code-main-vertical-v2`: content 70% / terminal 30%, min 160, max 600, collapsible; `workspace-view.tsx:190-199`), toggled from the title bar (`titlebar.tsx`, `local-code-bottom-panel-toggle`); the right panel's "Terminal" action toggles that panel instead of adding a tab (`secondary-sidebar-panel.tsx`). Several terminals are tabs **inside** that panel ("Terminal N", `terminal-runtime-store.ts`). | Each terminal becomes its own side-panel tab `terminal:<id>` (§11). A pane can be split vertically to put a terminal under another tab (§10.4), which is how "terminal below the browser" is kept. |
| F17 | PLAN "Changes/Terminal/Files/Browser tabs" | There is **no Changes, Diff or Git tab today**; diffs render only inline in tool cards (`code-diff-full.tsx` with `diff`'s `diffLines`/`diffWords`, `tool-group.tsx:873-922`); git UI is a branch picker and a PR pill in the composer (`chat-composer.tsx:2741-2783`), with no commit or push buttons. | The Changes tab is **new** (canvas `SessionReview`), built on `gitState` + `git.diff` (§14). No commit/push UI is added (none exists; canvas has none). |
| F18 | "continuations" | There is no "continue session" feature: continuing is retry, resume on the free pool, steering, and reopening a session (which auto-starts the agent with up to 5 attempts at 0.5/1/2/4/8 s and calls `switchAgentConversation` once when a `conversationId` exists; `chat-panel.tsx:1046-1129`). | The session route ports the start-with-backoff and the one-time `agent.switchConversation` (§9.2). The kit's `ErrorCard` owns retry and resume-on-pool (02 §5.6). The canvas sub-agent "Continue" (a delegate "Stopped at its limit") has no procedure: it prefills the composer (§15.3). |

---

Current shared chrome/layout rules: [surface-rules.md](../surface-rules.md).

The shared TabsRail uses the title bar's first row for every dock group. No body tab header duplicates it. Tabs scroll horizontally with edge fades and an overflow picker by default. Appearance → Allow two rows of tabs is persisted, defaults off, and permits at most one extra row for medium tab sets that fit; caption buttons stay on row one.

## 1. Scope

### 1.1 In scope

- **Routes** under `/sessions` (§5): the start page, the session thread with side-panel tabs, the full-diff masked pop-up, the review redirect; loaders with preload guards, search schemas, masks, pane boundaries, navigation types, not-found and deleted-while-open behaviour.
- **Data** (§6): collections and queries, every mutation with its optimistic row, echo and failure path, conflict and `NOT_FOUND` handling, the attention function for sessions, unread, workspace management.
- **The sessions sidebar** (§7): workspace groups, pinned, search, row states and menus, empty and drop-to-add.
- **The start page** (§8): the centred composer, the context tray, the workspace picker and creation, starters, recent sessions when the sidebar is collapsed, the create-and-send pipeline.
- **The thread** (§9): title bar, composer binding, `ChangesCard`, continuation and delegation presentation, read-only states, workspace missing.
- **The side panel and dock** (§10): the tab strip that appears only once something is open, split and full view, dockable panes on `react-resizable-panels` v4.
- **Tabs**: Terminal (§11), Browser (§12), Files with open-in-editor and diffs (§13), Changes and git state (§14), Agents (§15), Device (§16).
- **Sandbox/network, missing workspace, read-only** (§17), **motion** (§18), **sound** (§19), **i18n** (§20), **a11y** (§21), **gallery** (§22), **tests** (§23), **scaffold order** (§24), **acceptance** (§25).

### 1.2 Out of scope

The chat kit itself (phase 2; this phase adds only the amendments of §26.2), Routines' pages and "Talk to the routine" (phase 5), Settings › Environment, Browser and Devices settings pages (phase 5; this phase links to them), the notch (phase 6), any in-app editor (PLAN "Editing": open in editor only; Monaco is not used), "Move to workspace…", per-change undo, the run-level Undo and everything else in §27.3.

### 1.3 Gate (PLAN phase 4)

Parity rows for sessions, git, files, terminal and browser are green (§2); the terminal and the native browser are verified in the real app (R4-T29, R4-T30); before/after screenshots of every sessions board at the foundation widths and both themes are attached to the PR (§25).

---

## 2. Parity table

Every behaviour of today's sessions area, where it lands, and its status. "New" rows are canvas behaviours that did not exist; "Changed" rows are intended changes with their decision owner; "Retired" rows have a reason. The table is also `features/sessions/parity.ts` as data, which R4-T31 checks: every row names an existing route, component or test. Citations are against `HEAD 47e9e770`, paths under `src/renderer/` unless noted.

### 2.1 Navigation and routes

| # | Today (file:line) | New route / component | Status |
|---|---|---|---|
| S1 | `/sessions/new`: sets `newPaneIntent("session")`, `deselectWorkspace()`, renders `ChatPanel` (`router.tsx:164-177`) | `/sessions/new` → `SessionStartPage` (§8); the workspace comes from `?workspace=` or `prefs.lastPickedWorkspaceId` (§8.3) | Parity; intent and deselect retired (routes carry ids) |
| S2 | `/sessions/$sessionId`: finds the row in the all-sessions query, `activateWorkspaceSession`, `markSessionViewed`, `switchWorkspace` when the workspace differs (`router.tsx:179-206`) | loader: awaits `sessions`/`workspaces` readiness, row or `notFound()`; on enter (not preload) unread cleared, `session.load()` (§5.3); every file/git call carries the session's checkout (F5) | Changed: the workspace switch is retired (checkout-aware APIs, §26.4) |
| S3 | `RouteLoading` spinner while the list is pending (`router.tsx:203`) | route `pendingComponent`: transcript skeleton (foundation `defaultPendingMs` 150) | Parity |
| S4 | Unknown id: `ChatPanel` renders with no session | `notFoundComponent` "This session was deleted" + New session (§5.5) | Changed (gap fix) |
| S5 | `/` with `?view=` redirects and `?panel=` two-way synced with `activeRightTab` (`router.tsx:83-152`) | `/` → `/bots/new` (foundation); side panel state is `?tab=` only | Retired (PLAN "Nuked: `?view=` redirects"; "no state in two places") |
| S6 | `useConversationActivator` navigates and acknowledges with `switchWorkspace` (`workspace/workspace-activation.ts:39`) | `<AppLink to="/sessions/$sessionId">` | Changed: no switch (F5) |
| S7 | Sidebar highlight from pathname parsing (`lib/sidebar-conversation-route.ts`) | `useParams({ strict: false }).sessionId` | Parity |
| S8 | — | `/sessions/$sessionId/review` → `?tab=changes` redirect (F3); `/sessions/$sessionId/diff` masked full-diff dialog (§5.4) | New |

### 2.2 Sidebar

| # | Today | New | Status |
|---|---|---|---|
| S9 | Accordion section "Sessions" with count, folds (`layout/workspace-sidebar.tsx`, `sessions-tree.tsx`) | one sidebar for the Sessions rail item, header "Sessions" + Search + New (canvas `SessionsSidebar`) | Changed (user decision "one sidebar per rail item") |
| S10 | Flat list across workspaces, `updatedAt` desc, bot-owned, routine runs and editor sessions excluded (`sessions-tree.tsx:96-114`) | same filter; grouped by workspace (foundation §7.3; canvas) (§7.2) | Changed (canvas, foundation) |
| S11 | Date buckets Today / Yesterday / N days ago / date, first 10 rows without a header, 60 s re-bucket (`session-list-utils.ts:257`) | inside a workspace group rows are ordered by `updatedAt` desc with no bucket headers; the search results and the collapsed-sidebar history show a relative stamp (`chatStamp`, 03 P17) | Changed (canvas has no buckets) |
| S12 | Pinned group first, foldable (`sessions-tree.tsx`) | "Pinned" group above the workspaces (`prefs.pinned.sessionIds`) | Parity |
| S13 | Row: icon, label with full-label `title`, pin icon, green unread dot (`sessions-tree.tsx`) | 32 px row (34 in the tree board): status dot, label, trailing chip (running / needs you / diff / unread); pin shown by group (§7.3) | Parity + New (status) |
| S14 | No running or permission indicator in the shipped list | running dot + "running", "needs you" chip, error (§6.6) | New (canvas; dead `workspace-tree.tsx` had dots) |
| S15 | Active row scrolls into view (`useScrollIntoSection`) | same (`scrollIntoView({ block: "nearest" })`) | Parity |
| S16 | Row click `activateSelection` | link to `/sessions/$sessionId`, `transition: "nav-lateral"` | Parity |
| S17 | Context menu and ⋮ menu: Pin/Unpin, Delete session (`sessions-tree.tsx`) | one item list for both menus: Rename, Pin/Unpin, Mark as unread, Open beside this chat, New worktree from here, Copy session ID, Delete session (§7.4) | Parity + New |
| S18 | Delete confirm "Delete this session?" / "'{label}' and its transcript are deleted. This cannot be undone."; confirm → `stopAgentSession` then `removeAgentSession`; inline "Could not delete that session. Try again." (`sessions-tree.tsx`) | registry `AlertDialog`, same copy; `agent.stop` then `sessionsCollection.delete` (§6.4); inline error | Parity |
| S19 | Empty: "No sessions yet" + New session | canvas: "No sessions yet" / "Start one with ⌘N, or drop a folder here." + drop zone (§7.6) | Parity + New (drop) |
| S20 | — | Search field with highlighted matches and "workspace · branch" sub-line (canvas) (§7.1) | New |
| S21 | — | Workspace group: collapsible (`prefs.workspaceExpanded`), count, branch, missing state, row menu (§7.5) | New in production (dead code had grouping) |
| S22 | Rename exists only as the automatic first-message title (`chat-panel.tsx` send path step 9) | inline rename from the row menu and the title bar (§7.4, §9.1); automatic title stays in the kit (02 §8.3) | Parity + New |
| S23 | `pinnedSessionIds` in zustand (`code-store.ts`) | `prefs.pinned.sessionIds` (spec 00 C.4 imports it) | Parity |
| S24 | Unread = `backgroundCompletedSessionIds` (not persisted), set on `turn_complete` for a non-active session, cleared by `markSessionViewed` (`use-workspace-refresh.ts`, `code-store.ts`) | `sessionsUnreadStore` over `ai.runFinished` (`success`/`error`; a Stop marks nothing) (§6.7) | Parity (cancellation no longer marks unread) |
| S25 | Agent browser opened in a hidden chat marks it unread (`lib/agent-browser.ts`, `use-workspace-refresh.ts:31-80`) | same rule on `browser.events runtime-materialized` (§6.7, §12.6) | Parity |
| S26 | Sidebar toggle ⌘B (`components/ui/sidebar.tsx:34,97`) | foundation `Mod+B` | Parity (foundation) |

### 2.3 Start page and new-session flow

| # | Today | New | Status |
|---|---|---|---|
| S27 | `SessionWelcomeHeader`: Laptop icon, greeting, `ProjectSwitcher` above a centred 3-row composer, placeholder "Describe the work and press send to start a session" (`chat/chat-panel.tsx:414,1952`) | canvas `Main`: "What should we build?", 120 px two-row box ("Describe the work. Type @ for files, / for skills"), context tray under it (§8.1) | Changed (canvas) |
| S28 | `ProjectSwitcher`: search (autofocus, keydown stops propagation), "Default workspace" (title = `getSessionHomeWorkspacePath`), user workspaces with a check, "No workspaces found", "Add workspace" (`chat-panel.tsx:248`) | tray workspace button → `WorkspacePicker` popover: same rows, search, Default workspace, Add a folder (§8.3) | Parity |
| S29 | Add workspace: `openFolderDialog` → `addWorkspace(path,false)`; error toast `result.error ?? "Unable to add workspace."`; success activates + switches (`chat-panel.tsx:1720`) | `system.dialog.openFolder()` → `workspaces.add({ path })`; typed errors (§6.5); picks it | Parity |
| S30 | Default workspace auto-picked: `lastPickedWorkspaceId`, else `ensureSessionHomeWorkspace` (`hooks/use-session-workspace.ts`, `workspace-view.tsx`) | same order in the start page's loader (§8.3); `prefs.lastPickedWorkspaceId` | Parity |
| S31 | Starter chips (6: review pull requests, design a PDF, build an app, process a spreadsheet, restyle a repo, find flights) fill and focus the composer, never send (`chat-panel.tsx:455`) | canvas starter cards (3 × 2, "Try one of these", Shuffle); same fill-and-focus (§8.4) | Parity (canvas geometry) |
| S32 | — | sidebar collapsed: "Pick up where you left off in {workspace}" list of 4 recent sessions beside starters (canvas `MainCollapsed`) (§8.5) | New |
| S33 | Worktree picker: current checkout, existing worktrees, "Create worktree" (new chat only), hidden unless git and not a bot (`chat/worktree-picker.tsx`) | tray worktree button (canvas "New worktree" / "No worktree") with the same options (§8.3) | Parity |
| S34 | Mode picker (`chat/runtime-mode-picker.tsx`): Auto only when `getSandboxSupport().available`; one global sticky mode (`globalSelectedMode`, default YOLO) | kit `ModeChip` (02 §8.2); Auto hidden without sandbox support; default from `prefs.defaultMode`, written on change (§9.3) | Parity |
| S35 | Model picker: favourites, search, refresh (`listModels(true)`), "Configure model providers", Compact UI toggle, Connect rows; auto-select order stored default → recommended → `DEFAULT_MODEL_ID` → first runnable (`chat/model-picker.tsx`, `chat-panel.tsx:889-930`) | kit `ModelChip` with the groups of 03 §13.1 (shared builder); same resolution; "Compact UI" retired (§9.3) | Parity; Compact UI retired (density is a window-chrome setting now) |
| S36 | Send gate: no usable model → popover with CTA to `/settings/models` (`chat-composer.tsx`, `local-code-send-gate`) | composer `blocked` reason "no-model" + the same CTA (§26.2 kit amendment) | Parity |
| S37 | New session send: optimistic pending bubble, `createAgentSession`, optional worktree materialize/set, promote browser and terminal draft scopes, promote right-panel scope, set active (`chat-panel.tsx:1268` steps 5) | `startSession()` (§8.6): client id, insert, worktree, `promoteScope` for terminal and browser, navigate, first message submitted by the thread | Parity |
| S38 | Pasted attachments saved with `savePastedTempFiles(root, …)` into `.abacusai-bot/temp` | kit attachments with `attachmentsBase` = workspace or worktree path (02 §8.6) | Parity (kit) |
| S39 | No workspace → `activateDefaultWorkspace`, else warning "Please select a workspace…"; missing folder → warning + dialog (send path steps 2-3) | start page resolves a workspace before enabling Send; missing folder → the workspace-missing state (§17.2) | Parity |

### 2.4 Thread

| # | Today | New | Status |
|---|---|---|---|
| S40 | Title bar breadcrumb: `WorkspacePicker` "/" session label or "New chat" (`layout/titlebar.tsx`) | `TopBarSlot identity`: "{workspace} /" (muted) + label (500), click to rename (§9.1) | Parity + New (rename) |
| S41 | Title bar New chat (`local-code-new-chat`), terminal toggle, right-panel toggle, update pill (`titlebar.tsx`) | New session (`Mod+N`, foundation), panel toggle (foundation), tab strip when open (§10.1); terminal toggle retired (F16) | Parity; terminal toggle changed |
| S42 | Auto-start: `startAgentSession({model, mode})` when not running, 5 attempts 0.5/1/2/4 s (cap 8 s), toast with Retry, no retry for a missing folder (`chat-panel.tsx:1046-1129`) | `ensureAgentStarted(row)` on enter, same schedule; failure → thread banner with Retry (not a toast, R4-T8) (§9.2) | Parity (banner instead of toast) |
| S43 | `switchAgentConversation` once per CLI start when `conversationId` exists (send path step 7) | after a successful start, once (§9.2) | Parity |
| S44 | Model pick: `setAgentModel` (when running), `setAgentSessionModel`, `setDefaultModel`; `model_unavailable` → toast "Couldn't switch models…" | `sessionsCollection.update({model})` + `agent.setModel` when running + `settings.setDefaultModel` (§9.3); same toast | Parity |
| S45 | Mode pick: `setAgentMode` when running; `mode_changed` with `source: approval` moves the picker | kit `ModeChip` (02 §8.2) + `prefs.defaultMode` write | Parity (kit) |
| S46 | Transcript `ChatMessageList`, scroll-to-bottom, pending new-session bubble + `ThinkingLoader` | kit `ChatView skin="session"` (02 §5, §10); pending first message = outbox (02 §3.7) | Parity (kit) |
| S47 | Busy, steer, queue (`PendingSteers`: "Sends at the agent's next step", "…after you answer the permission prompt", "…as the next turn"; inline edit, remove) | kit queue slot (02 §8.5) | Parity (kit) |
| S48 | Stop: pending new session → text back; unanswered last user message → text back, message retracted, empty session deleted; else `stopAgentTurn` (`chat-panel.tsx:1617`) | kit Stop = `ai.cancel` (02 §4.5) | Changed: retraction and empty-session deletion retired (the agent echoes and persists the user message on admission, 02 F3; deleting is explicit) |
| S49 | Send errors: `MessageUndeliverable` → retract echo, text back, toast; else toast | kit admission outcomes (02 §3.7, §4.6) | Parity (kit) |
| S50 | Automatic title from the first line, 57 chars + "…" over 60 (send path step 9) | kit `deriveSessionTitle` (02 §8.3) | Parity (kit) |
| S51 | Notification banners with Retry and Switch model; `PremiumUpgradeCard` with resume on pool (`chat-panel.tsx:1905`) | kit `Notice`, `ErrorCard` (02 §5.6) | Parity (kit) |
| S52 | Thumbs feedback when an Abacus account exists (`submitTurnFeedback`) | the feedback popover of 03 §11.3, enabled for `skin="session"` too (§26.2) | Parity |
| S53 | "remember" toast | kit (03 P65) | Parity (kit) |
| S54 | Prompt history: ArrowUp at the start walks back, ArrowDown forward (`usePromptHistory(scope)`, `listPromptHistory`/`addPromptHistory`) | kit composer: ArrowUp walks history when the queue is empty, from a route-supplied `history` source over `settings.promptHistory.*` (§26.2) | Parity |
| S55 | `@` mentions via `searchFiles(query)`; Folder attach inserts `@folder/` | kit `mentions` from this route: `files.search` (§9.3) | Parity |
| S56 | Todos drawer and badge (`ComposerTasksDrawer`, `ComposerTasksBadge`) | tray "Tasks {done} of {n}" opening the plan popover (§9.4) | Parity (canvas) |
| S57 | Branch picker in the composer: search, create; blocked while busy ("stop agent first"); toasts switched / switchFailed / createdAndSwitched / createFailed (`chat-composer.tsx:2741-2783`) | tray branch button → `BranchPicker` popover, same rules and copy (§14.2) | Parity |
| S58 | `PrStatusPill`: number, review state, CI summary, Open; polls `getPrInfo` every 60 s and on focus (`chat-composer.tsx:253`) | tray PR item + hover card, `git.prInfo` with `refetchInterval: 60_000` and focus refetch (§14.3) | Parity |
| S59 | Permission UI in the composer box, one pending at a time; `modeAfterDecision`; `permission-auto-resolve` (`chat-composer.tsx:1378`, `lib/permission-auto-resolve.ts`) | kit permission tray (02 §6); auto-resolve on a more permissive mode is main/agent behaviour (00-agent-agui §3.5) | Parity (kit) |
| S60 | OS notifications "Permission required", "Task completed"; click activates the session (`hooks/use-notifications.ts`, `app.tsx`) | `features/sessions/notify.ts` via `system.notify` + `system.events notification-clicked` (§19.2) | Parity |
| S61 | Global `BrowserPermissionPrompt` (Allow, Deny, "Allow until quit", "Never ask") → `respondBrowserPermission` (`browser/browser-permission-prompt.tsx`, `app.tsx:174`) | `BrowserAskHost` mounted by the shell, `browser.events` + `browser.permissions.respond` (§12.7) | Parity |
| S62 | Deleted-workspace banner, `canSend=false` | read-only composer banner (canvas `ReadOnlyStates` "A session whose folder is gone") (§17.3) | Parity |
| S63 | `WorkspaceMissingDialog`: Relocate (`openFolderDialog` → `relocateWorkspace` + toast), Delete (confirm → `removeWorkspace` + toast), dismissal remembered per workspace | canvas `SessionWorkspaceMissing` pane state with Choose folder / Delete workspace, and the send-blocked composer line (§17.2); dismissal retired (the state is inline, not a dialog) | Parity; dialog → inline |
| S64 | Routine run: `BotMessageList`, banner "routines.runReadOnly", no composer (`chat-panel.tsx:879`) | read-only session skin with the routines banner and "Talk to the routine" (phase 5 route) (§17.3) | Parity |
| S65 | `ConnectorRequestCard` (`respondConnector`, `refreshMcpServers`) above the composer; the tool waits for the connection | the shared `components/connector-request-card/` of 03 r3 §11.4 in the session's `slots.banner`, fed by `connectors.events({ conversationKey })` (snapshot of pending asks first), field flows via `connectors.submitFields`, decline, `connectors.respond` releasing the suspended turn (§9.3) | Parity |
| S66 | Panel-wide file drop inserts `@path` mentions | kit composer drop (02 §8.6) over the whole thread pane (the route forwards `onDrop`) | Parity |
| S67 | Tool cards with inline diffs (`code-diff-full.tsx`, `code-view.tsx`, `tool-group.tsx:873-922`) | kit `DiffExpander` (02 §5.4); "Open full diff" → `/sessions/$id/diff` (§5.4) | Parity (kit) + New (full diff) |
| S68 | Sub-agent inline `SubtaskCard` (live timer, "View transcript") and `SubtaskScopeHeader` with back (`chat/subtask-card.tsx:269`) | kit `SubagentCard` + Agents tab detail (§15) | Parity |
| S69 | — | `ChangesCard` in `RunTail`: "{n} files changed +a −d", Review changes (canvas `SessionRunning`, `SessionReview`) (§9.5) | New |

### 2.5 Side panel, dock, previews

| # | Today | New | Status |
|---|---|---|---|
| S70 | Right panel per conversation key: descriptors, active, open, `agentsAvailability` (`stores/right-panel-store.ts`); closing activates the right neighbour, else the left | `panelTabsStore` per conversation key (open tabs) + `?tab=` (active) (§10.2); same neighbour rule | Parity |
| S71 | "+" menu: Browser, Terminal, Files, Agents (only with subtasks), Device (only when enabled and not a bot); Files shows "Open" when open (`secondary-sidebar-panel.tsx:225-345`) | "Add a tab" menu, same items and rules; Changes added when there are changes (§10.1) | Parity + New (Changes) |
| S72 | Empty panel "Open a surface" with a card grid | no empty panel: the strip exists only while a tab is open (user decision); the toggle opens the last tab or the menu (§10.1) | Changed (user decision) |
| S73 | Hidden tabs kept mounted with `<Activity>`; the browser tab renders only when active | same: `<Activity mode>` per tab, browser presented only when visible (§10.5) | Parity |
| S74 | Middle-click closes a tab; hover × | same (§10.1) | Parity |
| S75 | Split sizes: sidebar 240–420, main ≥ 320, right panel default 420, 280–960, collapsible; terminal 30% (160–600) (`workspace-view.tsx:190-199`, `useDefaultLayout`) | chat pane default 480 (canvas), min 360; panel min 360; persisted in `prefs.panes` (§10.3) | Changed (canvas + foundation minimums) |
| S76 | Below 959 px the inspector becomes a right `Sheet` | below 1100 the pane folds into one tab strip with Chat first (F4) | Changed (canvas `W900`) |
| S77 | Preview tabs: file, document, image, URL, artifact (`stores/preview-store.ts` max 50, `lib/preview-tabs.ts:80`) | `preview:<key>` tabs, same cap and eviction (§13.3) | Parity |
| S78 | Code preview in read-only Monaco (`workspace/monaco-file-editor.tsx`) | `@tanstack/highlight` viewer + "Open in editor" (§13.3) | Changed (PLAN "Editing / Nuked: monaco") |
| S79 | Image preview (`readImageAsDataUrl`) with "Open externally" fallback; PPTX (`PptxViewer`); Markdown rendered; truncated banner | same viewers (`components/file-preview/`) (§13.3) | Parity |
| S80 | PDF and HTML via `<webview src=file://…>` (`browser/preview-panel.tsx:289`) | a guarded **local-file runtime** tab on the native surface (F8, §12.8, main amendment §26.4 f) | Parity (mechanism changed) |

### 2.6 Terminal

| # | Today | New | Status |
|---|---|---|---|
| S81 | `ghostty-web`, font 13, `TERMINAL_FONT_FAMILY`, blinking block cursor, scrollback 10000, `convertEol: false`, dark `#1e1e1e` (`terminals/terminal-views.ts`) | same engine and options; theme from tokens for both schemes (§11.2) | Parity + light theme |
| S82 | Links (`UrlRegexProvider`, `OSC8LinkProvider`) open in the in-app preview | open a Browser tab (§11.2) | Parity |
| S83 | DEC mouse modes 1000/1002/1003/1004/1006, Shift overrides (`terminals/terminal-mouse.ts`) | ported verbatim with its tests (§11.4) | Parity |
| S84 | Keys: Shift+PageUp/Down, copy ⌘C with selection / Ctrl+Shift+C, paste ⌘V / Ctrl+Shift+V bracketed, any key scrolls to bottom (`terminals/terminal-keys.ts`) | ported verbatim (§11.4) | Parity |
| S85 | Tabs "Terminal N" inside the bottom panel, ids `terminal-<ts36>-<n>` never reused (`stores/terminal-runtime-store.ts:56`) | one side-panel tab per terminal, same id scheme and labels (§11.1) | Changed (F16) |
| S86 | Shell picker when more than one shell (system, cmd, powershell, pwsh, busybox), remembered via `setTerminalShell` | "New terminal" split button with the shell menu (§11.1) | Parity |
| S87 | Hide keeps the PTY (`hideTerminalSession`); close kills (`close: true`); exit closes the tab | tab close = kill, no confirmation (parity); switching away = `hide`; exit → the tab shows "Process exited with code {n}" for 2 s, then closes (§11.1) | Parity + exit notice |
| S88 | Views outside React in a module map keyed by conversation and terminal id; React moves the element (`terminal-views.ts:449`) | same (`terminal-registry.ts`) (§11.3) | Parity |
| S89 | Resume: `initialOutput` = whole scrollback, `terminal.reset()` + write once; live via `terminal-output` filtered by id/key/generation | `terminal.output` with `fromOffset`; `snapshot` append vs replace by `from` (§11.3) | Changed (lossless offsets) |
| S90 | Resize: `ResizeObserver` debounced 40 ms → `proposeDimensions` → `resizeTerminalSession` | same, pacer-debounced 40 ms (§11.3) | Parity |
| S91 | Visibility: `setVisible(true)` re-syncs size, forces full repaint, focuses | same (§11.3) | Parity |
| S92 | Draft → session: `promoteTerminalSessionScope`, views re-keyed | `terminal.promoteScope` + re-key; `retired {superseded}` ends the old iterator (§11.1) | Parity |
| S93 | Start failure written in red into the terminal | same (§11.1) | Parity |

### 2.7 Browser

| # | Today | New | Status |
|---|---|---|---|
| S94 | Materialize → lease; present on resize/scroll throttled to rAF when bounds change; hide on unmount or when covered; capture for a placeholder image while covered (`browser/browser-runtime-surface.tsx`) | same contract (§12.2–§12.4) | Parity |
| S95 | Back, Forward, Reload ↔ Stop; address bar normalisation (localhost → http, bare host → https, empty → about:blank), select-all on focus, Escape restores, spinner | same (`normalizeAddress` ported with tests) (§12.5) | Parity |
| S96 | ⋮ menu: profile (none / imported Chrome profiles, import + re-materialize + toasts), hard reload, devtools, zoom ± / reset with %, clear site data, open externally | same items (§12.5) | Parity |
| S97 | "Page unavailable" overlay with Try again (hard reload) | same (§12.5) | Parity |
| S98 | Occlusion hides the native view; a warning after 5 s hidden (`lib/native-surface-occlusion.ts`) | foundation occlusion watcher + intersect test (§12.4) | Parity |
| S99 | Agent's browser adopted and revealed on `browser-runtime-materialized` and `mcp-open-preview`; unread if not on screen (`lib/agent-browser.ts`) | same on `browser.events` (§12.1, §12.6) | Parity |
| S100 | Close a browser tab: materialize → close → dispose | `browser.runtime.close(lease)` (§12.3) | Parity |
| S101 | `browser-cursor.tsx` unused | — | Retired (unused) |
| S102 | — | "The agent is browsing. Take over / I'm done" bar (canvas `SessionBrowser`) | Deferred: no take-over procedure (§27.3); the bar renders the status line only |

### 2.8 Files, Changes, Agents, Device

| # | Today | New | Status |
|---|---|---|---|
| S103 | Files: `@pierre/trees`, compact, coloured icons, git colouring from `gitChanges`, lazy children, prefetch on folder hover, double-click opens preview (`workspace/explorer-panel.tsx`) | same library and behaviour; canvas "Filter files" field and "M" marks (§13.1) | Parity + New (filter) |
| S104 | Inline rename; drag-and-drop move (`renameLocalFile`); drag paths into the composer (`text/x-code-paths`) | same (§13.2) | Parity |
| S105 | Context menu: Open Preview, Reveal in Finder, Rename, Move to Trash | same + Open in editor (§13.2) | Parity + New |
| S106 | States: no workspace, "Loading files...", load failed, no files; invalidated by tree-root and git-state events | same; `files.events tree-root-changed` + `gitState` (§13.1) | Parity |
| S107 | — | Changes tab: changed files, per-file diff, Keep, Undo (with §26.4), change navigation (canvas `SessionReview`) (§14) | New |
| S108 | Agents tab: "Main agent" row, subtask rows (spinner / amber "did not finish" / green check), kind badge (component, delegate, browser), tool count, last tool, duration; click scopes the transcript (`chat/agents-panel.tsx`) | Agents tab list + detail (canvas `SubAgents`) (§15) | Parity (detail replaces transcript scoping) |
| S109 | Device panel: iOS/Android tabs, device select, Boot, Build & Run with phases, Open native, Refresh, permission banners, live/poll badge, 1.5 s screenshot polling, 10 s device list polling, touch and key streaming, Android Back/Home/Recents, iOS Home, Install Maestro, Create device, setup guide, Recheck (`device/device-panel.tsx`) | Device tab, same controls (§16) | Parity |
| S110 | H.264 WebCodecs decoder (lazy configure from SPS, drop deltas at queue > 8, 5 s no-frame fallback to polling), MJPEG via `createImageBitmap`; **iOS: native stream → Simulator-window capture (boot, one screenshot for the aspect, `captureSimulatorWindow` with 3 retries 800 ms apart, bottom-anchored crop, track cleanup, screen-recording permission banner) → polling**, with a per-device failure latch (`device/device-screen-stream.ts`, `device/device-panel.tsx:320-420`) | ported (F9) (§16.2), fallback chain included | Parity |
| S111 | Shell-level preview bridge: `preview-open` (`present_deliverable`) and `mcp-open-preview` open supported deliverables (URLs and in-app viewer types) in the **originating** conversation's panel; a background conversation gets the tab recorded and an unread mark (`renderer/utils/preview-utils.ts:125`, `hooks/use-workspace-refresh.ts:31-80`) | `SessionPreviewBridge` mounted once by the shell (§13.4) | Parity |

---

## 3. Dependencies

No new packages. Everything below is already a dependency of the desktop app or pinned by an earlier phase.

| Package | Version | Used for | Verified |
|---|---|---|---|
| `ghostty-web` | 0.4.0 (installed, `^0.4.0` in the manifest) | terminal tab: `init`, `Terminal`, `FitAddon` | F1; `dist/index.d.ts` |
| `react-resizable-panels` | 4.14.1 installed (foundation pins `^4.14.1`) | the dock: `Group`, `Panel`, `Separator`, `panelRef.collapse/expand`; constraints in px (numbers are px, unit-less strings are %); sizes **persisted from `Panel.onResize(size).inPixels`**, never from the group's percentage `Layout` (Codex r1 #17) | typings (§0 sources); the registry `resizable` wraps it and is the only import site (`ui/resizable.tsx`) |
| `@pierre/trees` | 1.0.0-beta.6 (installed, Apache-2.0) | Files tab tree: `useFileTree`, `FileTree` (React), `GitStatus` decorations, header slot, context menu slot | `dist/react/*.d.ts`, `dist/index.d.ts:12`. PLAN lists it ("file tree") |
| `diff` | 8.0.4 (installed) | line diff for the Changes tab when `git.diff` is unavailable (new files) and for the full-diff dialog's side-by-side mode | old `code-diff-full.tsx` uses it |
| `@tanstack/highlight` | 0.0.10 | read-only file viewer and diff line highlighting (02 §7.4, F17 grammar gap applies) | 02 |
| `@tanstack/db`, `@tanstack/react-db` | 0.9.2 / 0.4.1 | collections, `useLiveQuery` | 03 §3 |
| `@tanstack/react-form` + `valibot` | 1.33.5 / 1.5.0 | rename (inline), the workspace relocate field; search schemas | 03 F1 |
| `@tanstack/react-pacer` | 0.24.0 (foundation) | debounced terminal resize, browser bounds, pane widths | foundation §3.1 |
| `motion` | 13.4.6 (foundation; not installed yet) | presence of the tab strip, tray morph, dock drag ghost, sidebar rows | **unverified for 13.4.6**, as 03 §3; R4-T27 type-checks |
| `react` | 19.3.x (foundation) | `ViewTransition` for split ↔ full (§18) | foundation §3.1 |
| Registry atoms | foundation §5.2 list | `resizable`, `tabs`, `dropdown-menu`, `context-menu`, `popover`, `combobox`, `command`, `alert-dialog`, `dialog`, `tooltip`, `item`, `badge`, `skeleton`, `empty`, `spinner`, `kbd`, `toast`, `input`, `input-group`, `toggle-group`, `collapsible`, `scroll-area` | every one is in the foundation's `add` list; no new atom |

Not used, with reasons: `@xterm/*` (not installed; F1), `@danfessler/trellis` (licence; F2), `monaco-editor` / `@monaco-editor/react` (PLAN "Editing"; banned in renderer-next by foundation §3.4), `<webview>` (F8), `@tanstack/react-virtual` (the tree virtualises itself; the terminal draws on a canvas).

---
## 4. Folder shape and public API

```
src/shared/sessions/                 (new; pure helpers used by both renderers and tests)
├─ starters.ts                       SESSION_STARTERS (ids, prompt text; moved from chat-panel.tsx, §26.9)
├─ address.ts                        normalizeAddress (moved from browser-runtime-surface.tsx)
└─ terminal-input.ts                 terminal key and mouse encoders (moved from renderer/terminals/terminal-{keys,mouse}.ts)
src/renderer-next/
├─ components/
│  ├─ file-preview/                  FilePreview (code via highlight, markdown, image, pptx), PptxDeck (ported viewer) — Artifacts (phase 5) reuses it
│  ├─ diff-view/                     DiffView (unified and split, per-line highlight, hunk anchors) over a parsed patch
│  └─ tab-strip/                     TabStrip, Tab, AddTabMenu (presentational; props in, callbacks out)
├─ features/sessions/
│  ├─ index.ts                       the only file routes import (below)
│  ├─ data/                          queries.ts, session-actions.ts (§6.4), workspace-actions.ts (§6.5), attention.ts (§6.6),
│  │                                 unread-store.ts (§6.7), agent-start.ts (§9.2), open-session.ts (§5.3), search.ts (§5.2)
│  ├─ sidebar/                       sessions-sidebar.tsx workspace-group.tsx session-row.tsx session-row-menu.tsx
│  │                                 workspace-row-menu.tsx search.tsx drop-zone.tsx (§7)
│  ├─ start/                         session-start-page.tsx starters.tsx recent-sessions.tsx start-session.ts (§8)
│  ├─ context/                       context-tray.tsx workspace-picker.tsx branch-picker.tsx worktree-picker.tsx pr-item.tsx
│  │                                 exec-target.tsx tasks-item.tsx (§8.2, §9.4, §14.2–§14.3)
│  ├─ thread/                        identity.tsx title-actions.tsx slots.ts changes-card.tsx gone.tsx read-only.tsx (§9, §17)
│  ├─ dock/                          dock-store.ts (pure reducer) dock-layout.tsx dock-drop.tsx panel-tabs-store.ts tab-refs.ts (§10)
│  ├─ terminal/                      terminal-tab.tsx terminal-registry.ts output-pump.ts ghostty.ts (§11)
│  ├─ browser/                       browser-tab.tsx address-bar.tsx browser-menu.tsx ask-host.tsx local-file.ts (§12)
│  ├─ files/                         files-tab.tsx tree-model.ts preview-tabs.ts open-in-editor.ts preview-bridge.tsx (§13)
│  ├─ changes/                       changes-tab.tsx review-store.ts diff-source.ts (§14)
│  ├─ agents/                        agents-tab.tsx (§15)
│  ├─ device/                        device-tab.tsx screen-stream.ts device-input.ts (§16)
│  ├─ notify.ts sound/session-cues.ts (§19)
│  ├─ parity.ts                      §2 as data
│  └─ gallery/                       sections.tsx (sessionsGallerySections, §22)
```

Rules (foundation §4; R4-T28 checks them): `features/sessions` imports `components/`, `ui/`, `data/`, `lib/`, `#shared/*`, never another feature; the Agents tab's detail renders the chat kit's sub-agent view **through a render prop the route passes** (features do not import `features/chat`); `components/*` import no `data/` or feature.

Public API (`features/sessions/index.ts`, named exports only):

```ts
export { SessionsSidebar, SessionsNeedsYou } from "./sidebar";                  // picked by features/shell/sidebars.ts
export { SessionStartPage } from "./start/session-start-page";
export { useSessionThreadSlots, SessionIdentity, SessionTitleActions, SessionGone } from "./thread";
export { SessionDock, SessionPanelTab } from "./dock";                           // the side panel's contents and strip
export { FullDiffDialog } from "./changes/full-diff-dialog";
export { BrowserAskHost } from "./browser/ask-host";                             // mounted once by the shell (§12.7)
export { SessionNotifications } from "./notify";                                 // mounted once by the shell (§19.2)
export { SessionPreviewBridge } from "./files/preview-bridge";                   // mounted once by the shell (§13.4)
export { sessionsQueries, openSessionOnce, startSession, deleteSession } from "./data";
export { SessionTabRef, NewSessionSearch, SessionSearch, DiffSearch } from "./data/search";
export { sessionsGallerySections } from "./gallery/sections";
export type { SessionAttention } from "./data/attention";
```

`features/shell/sidebars.ts` (foundation §7.3) is the one module that imports several features; it gains `BrowserAskHost`, `SessionNotifications` and `SessionPreviewBridge` in a `globals` list rendered by `__root` (§26.1).

---

## 5. Routes

### 5.1 Files

Directory form under `src/renderer-next/routes/_shell/(sessions)/`. **(f)** rows exist as foundation placeholders and are filled here; **(a)** rows amend the foundation (§26.1).

| File | Path | Responsibility |
|---|---|---|
| `sessions.tsx` (f) | `/sessions` layout | `staticData: { area: "sessions", sidebar: "sessions" }`; `search.middlewares: [retainSearchParams(["view"])]`; loader: nothing beyond `_shell`'s `sessions` + `workspaces` preload. Component: `<LayoutGroup id="sessions">` around `<Outlet/>` (tray and strip morphs, §18). |
| `sessions.index.tsx` (f) | `/sessions/` | `beforeLoad` is not used (it cannot await readiness cheaply); the **loader** awaits `sessions.preload()` then redirects → `shellStore.lastLocationByArea.sessions` when it is a session that still exists, else `/sessions/new`. |
| `sessions.new.tsx` (f) | `/sessions/new` | `validateSearch: NewSessionSearch`; `loaderDeps: ({ search }) => ({ workspace: search.workspace })`; loader §8.3 (awaits `workspaces.preload()`; resolves the workspace; `ensureSessionHome` is a side effect and is skipped on preload); renders `SessionStartPage`. |
| `sessions.$sessionId.tsx` (f) | `/sessions/$sessionId` | `params.parse: v.parser(v.object({ sessionId: SessionId }))`; `validateSearch: SessionSearch` (§5.2); loader §5.3; `pendingComponent` transcript skeleton; `errorComponent` §5.3; `notFoundComponent` `SessionGone` (§5.5). Renders `ChatView skin="session"` with the session slots, `SessionDock` around it, and `<Outlet/>` for the masked diff. |
| `sessions.$sessionId.review.tsx` (a) | `/sessions/$sessionId/review` | `beforeLoad`: `throw redirect({ to: "/sessions/$sessionId", params, search: { ...search, tab: "changes" }, replace: true })` (F3). No component. |
| `sessions.$sessionId.diff.tsx` (new) | `/sessions/$sessionId/diff` | Masked pop-up (registry `Dialog`, 90vw × 90vh, max 1200) with `FullDiffDialog`; loader awaits `sessions.preload()` and, for `source=tool` and not on preload, `chat.session(id).load()` (the resolver needs the hydrated thread, §14.5); `validateSearch: DiffSearch = { path: string, source: "git" \| "tool", toolKey?: string, mode?: "unified" \| "split" }`; mask → `/sessions/$sessionId` keeping its search minus the diff keys. Close/Escape = `history.back()`, or navigate to the mask target when `!router.history.canGoBack()`. |

Generated ids (R4-T1 snapshots them): `/_shell/(sessions)/sessions`, `/_shell/(sessions)/sessions/`, `/_shell/(sessions)/sessions/new`, `/_shell/(sessions)/sessions/$sessionId`, `/_shell/(sessions)/sessions/$sessionId/review`, `/_shell/(sessions)/sessions/$sessionId/diff`.

### 5.2 Search schemas (valibot; foundation §6.2 conventions)

```ts
// features/sessions/data/search.ts
const TabId = v.pipe(v.string(), v.regex(/^[A-Za-z0-9._-]{1,80}$/));
export const SessionTabRef = v.union([
  v.picklist(["chat", "changes", "files", "agents", "device"]),   // "chat" = the Chat pseudo-tab selected (§10.3)
  v.pipe(v.string(), v.regex(/^(terminal|browser|preview):[A-Za-z0-9._-]{1,80}$/)),
]);
export const NewSessionSearch = v.object({ workspace: v.optional(v.fallback(WorkspaceId, undefined)) });
export const SessionSearch = v.object({
  view: v.optional(v.fallback(v.picklist(["split", "full"]), "split"), "split"),
  tab: v.optional(v.fallback(SessionTabRef, undefined)),        // absent = panel closed (no strip); "chat" = strip shown, Chat selected
  agent: v.optional(v.fallback(TabId, undefined)),              // subagentRunId in the Agents tab (§15)
  file: v.optional(v.fallback(v.pipe(v.string(), v.maxLength(4096)), undefined)),   // Files/Changes selection (§13, §14)
  scope: v.optional(v.fallback(v.picklist(["staged", "unstaged"]), undefined)),       // Changes selection's section (§14.1); absent = the file's only section
});
export const DiffSearch = v.object({
  path: v.pipe(v.string(), v.minLength(1), v.maxLength(4096)),
  source: v.optional(v.fallback(v.picklist(["git", "tool"]), "git"), "git"),
  toolKey: v.optional(v.fallback(v.string(), undefined)),
  mode: v.optional(v.fallback(v.picklist(["unified", "split"]), "unified"), "unified"),
  scope: v.optional(v.fallback(v.picklist(["staged", "unstaged"]), undefined)),       // git source only (§14.5)
});
```

- `stripSearchParams({ view: "split", source: "git", mode: "unified" })` on the session and diff routes.
- A `tab` naming a terminal, browser or preview that is not open (a stale link, another window closed it) renders the strip without it and **replaces** the URL with the neighbour rule (§10.2); `terminal:<id>` for a terminal main still holds (it survived a reload) re-opens it.
- `file` is a workspace-relative path; `path` in `DiffSearch` likewise. Absolute paths are rejected by the Files and Changes tabs (they belong to `system.openPath`).
- `SessionSearch.tab` replaces foundation's picklist; `ShellSearch.tab` and `BotSearch.tab` are unchanged (§26.1).

### 5.3 The thread loader (`/sessions/$sessionId`)

```ts
loader: async ({ params, context, preload }) => {
  await Promise.all([context.collections.sessions.preload(), context.collections.workspaces.preload()]);   // 03 r3 §24.1: never trust the layout's preload
  const row = context.collections.sessions.get(params.sessionId);
  if (row == null) throw notFound();
  if (preload) return { sessionId: row.id, workspaceId: row.workspaceId };   // no side effect, no subscription
  openSessionOnce(context, row);                                             // unread clear (sync)
  await context.chat.session(row.id).load();                                 // chat kit readiness (02 §3.2)
  return { sessionId: row.id, workspaceId: row.workspaceId };
}
```

- **Readiness first** (Codex r1 #3): matched loaders run concurrently (`load-client.ts:1014-1035`, cited by 03 r3 §24.1), so every loader that reads `sessions` or `workspaces` awaits their `preload()` itself: `sessions.index`, `sessions.new`, `sessions.$sessionId`, `sessions.$sessionId.diff`. A cold direct navigation with a delayed snapshot therefore never reports a live session as deleted (R4-T3, R4-T4).
- **No workspace switch** (F5): file and git calls carry the session's `CheckoutRef` (§26.4 a), so entering a session changes nothing in main. `openSessionOnce` only clears unread and records `lastLocationByArea`.
- **Agent start is not in the loader.** `ensureAgentStarted` (§9.2) runs from the route component after mount.
- **Errors.** A rejected `session.load()` (`ThreadRetiredError`, `UNAVAILABLE`) renders the `errorComponent`: registry `Empty`, "Couldn't open this session", the message for `INTERNAL_SERVER_ERROR`, and Retry (`router.invalidate()`). `UNAVAILABLE` shows "The agent isn't available yet" (02 §12.7).
- **Preload** (hover) has no side effect and opens no subscription (R4-T3).

### 5.4 Masks and pane boundaries

```ts
// router.tsx additions
createRouteMask({ routeTree, from: "/sessions/$sessionId/diff", to: "/sessions/$sessionId",
                  params: (p) => p, search: ({ path: _p, source: _s, toolKey: _t, mode: _m, scope: _sc, ...rest }) => ({ ...rest, scope: _sc }) }),
// PANE_BOUNDARIES additions
"/_shell/(sessions)/sessions/$sessionId": "session:$sessionId",
"/_shell/(sessions)/sessions/$sessionId/diff": "session:$sessionId",
```

- Opening and closing the diff dialog keeps the thread's instance, scroll, composer draft and the dock (R4-T1).
- A search-only change on `/sessions/$sessionId` (`tab`, `view`, `agent`, `file`) keeps `paneKey` and starts no pane view transition (foundation §6.7 rule 1). The split ↔ full change has its **own** view transition inside the pane (§18.2), typed `session-view`, started by the dock, not by navigation.
- `ROUTE_RANK`: `/sessions/new` 0, `/sessions/$sessionId` 1 (foundation); the review redirect and the masked diff have no rank. So new → thread = `nav-forward` (explicit on create, §8.6), thread → thread = `nav-lateral`.
- **Why the diff is masked** (and not a tab): the canvas has no full-diff board; the permission card's "Show all" (02 §6.4), the kit's `DiffExpander` "Show all" and the Changes tab's "Open full diff" all want a large, dismissable view that is linkable and survives reload. The mask keeps the URL on the thread.

### 5.5 Not found, deleted while open

- `SessionGone` (route `notFoundComponent` and the live path below): registry `Empty`, "This session was deleted", primary "New session" → `/sessions/new?workspace=<its workspace if it still exists>`.
- **Deleted in this window:** `deleteSession` (§6.4) navigates first (next row in sidebar order within the same workspace, else `/sessions/new`, `replace: true`, `nav-lateral`), then deletes.
- **Deleted elsewhere while open:** the component reads the row with `useLiveQuery(...findOne())`; when the collection is ready and the row is absent it renders `SessionGone` (not a throw from render; 03 §5.5). The dock's terminals receive `retired {closed}` (main disposes the scope) and close; the browser runtime is closed by main (`disposeScope`).
- **Workspace removed while open:** the row survives (tombstone keeps sessions readable, F7): §17.3.

---

## 6. Data

### 6.1 Sources

| Data | Source | Loaded by | Invalidated / live by |
|---|---|---|---|
| Sessions | `sessionsCollection` (`db.sessions`, `startSync: true`) | `_shell` | change batches (created/removed/updated/model/conversation-id/state/turn events, the `persist()` hook, `sessions-reloaded` → reset) |
| Workspaces | `workspacesCollection` (`startSync: true`) | `_shell` | `metadata-updated` + the `WorkspaceService.onChanged` hook |
| Git state of a checkout | `gitStateCollection` (lazy), rows keyed by `checkoutKey` (§26.4 b) with each change's content `fingerprint` | Changes tab, Files tab, tray, sidebar diff chip (`preload()` on first mount); the thread holds a `git.watch({ checkout })` subscription while open so main computes that checkout | change batches; a content change with identical `+/−` still changes the row (fingerprint), so diffs and review marks follow content (Codex r1 #21) |
| Artifacts of a session | `artifactsCollection` where `sessionId` | not used in phase 4 beyond the Files tab's "Made in this session" filter (§13.1) | change batches |
| Checkout existence | `git.checkoutStatus({ checkout })` (§26.4 i) for a session (its **effective** checkout: the worktree when it has one); `workspaces.checkPath({ workspaceId })` for the start page and sidebar groups (primary path) | thread, start page, sidebar groups not `deleted` | no push event: invalidated on window focus, on a `workspaces`/`sessions` batch for that id, and on `NOT_FOUND`/`PRECONDITION_FAILED {workspace-missing}` from any call (§17.2) |
| Session home path | `workspaces.sessionHomePath` query | picker "Default workspace" title | `staleTime: Infinity` |
| File tree | `files.treeRoot({ checkout })`, `files.treeChildren({ checkout, directoryPath })` | Files tab | `files.events { tree-root-changed, checkoutKey }` → that checkout's tree queries; a `gitState` batch for the checkout → `treeRoot` only (colours) |
| File search | `files.search({ checkout, query })` | `@` mentions (start page: the **draft's** workspace; thread: the session's checkout), Files filter | per query, `staleTime: 5_000` |
| Branches / current branch | `git.branches(ctx)`, `git.currentBranch(ctx)` with `ctx = { workspaceId, sessionId? }` | tray branch picker | `staleTime: 5_000` (parity); `gitState` batch |
| PR | `git.prInfo(ctx)` | tray | `refetchInterval: 60_000`, `refetchOnWindowFocus: true` for this query only (parity S58), and a `gitState` batch |
| Worktrees | `git.worktrees.list({ workspaceId })` | tray worktree picker | on its own mutations; `gitState` batch |
| File diff | `git.diff({ checkout, filePath, scope? })`, query key includes the change's `fingerprint` | Changes tab, full diff | a new fingerprint for that path (content-based, not stat-based) |
| Terminal states | `terminal.events({ conversationKey })` (snapshot + state) | dock (open terminal tabs) | the iterator |
| Terminal output | `terminal.output(...)` per open terminal | terminal tab | the iterator (§11.3) |
| Browser events | `browser.events({ conversationKey })` for the open thread; keyless for `BrowserAskHost` | dock, ask host | the iterator (lossless-actionable; snapshot first) |
| Browser status, profiles | `browser.status`, `browser.profiles.list` | browser menu | `browser.events { status }` |
| Device status | `devices.status`, `devices.events` | Add-tab menu (Device shown only when enabled), Device tab | the iterator |
| Exec target | `settings.execBackend.get`, `settings.sandboxSupport` | tray, mode chip (Auto) | on its own mutation; `settings.events` |
| Models, default model, favourites | `models.list`, `settings.get`, `prefs.models.favoriteModelIds` | model chip | as 03 §6.1 |
| Default mode | `prefs.defaultMode` | new session, mode chip | prefs change batches |
| Run outcomes | `ai.runFinished({})` (03 r3 §24.11, consumed unchanged): one lossless notice per **relay run terminal** for every thread, `{ threadId, runId, outcome, errorCode?, hasVisibleAssistantText, owner, routineId, at }`, published by `ThreadRelay` under first-terminal-wins (main-written `agent_exit`/`agent_crashed`/`inactivity_timeout` included), never from compat `turn_complete` | one subscription per document shared with bots (`data/db/run-finished.ts`), resumed with `lastEventId` after reconnects | the iterator itself; never inferred from `sessionsCollection` snapshots |
| Pending connector asks | `connectors.events({ conversationKey })` for the open thread (snapshot first); keyless for other sessions' attention | thread route; sidebar module | the iterator |
| Agent-requested previews | `files.events { preview-open, path, conversationKey }` and `browser.events { open-preview, url?, conversationKey }` (keyless) | `SessionPreviewBridge` (shell) | lossless-actionable |
| Prompt history | `settings.promptHistory.list` | composer ArrowUp | on `settings.promptHistory.add` |
| Pinned, expanded, last workspace, pane widths | `prefs.pinned.sessionIds`, `prefs.workspaceExpanded`, `prefs.lastPickedWorkspaceId`, `prefs.panes` | boot | prefs change batches |

Every query's options live in `features/sessions/data/queries.ts`; their invalidation entries join the foundation's `data/queries/invalidation.ts` table, and R4-T5 walks each row emitting only that source (03 R3-T5 pattern).

### 6.2 Live queries

```ts
useSession(id)              → q.from({ s: sessionsCollection }).where(({ s }) => eq(s.id, id)).findOne()
useListedSessions()         → sessionsCollection filtered: !botOwned && editorFor == null && routineId == null   (foundation §7.3)
usePickableWorkspaces()     → workspacesCollection filtered: status !== "deleted" && (kind == null || kind === "auto")
useWorkspace(id)            → findOne on workspacesCollection
useGitState(checkout)       → findOne on gitStateCollection by checkoutKey(checkout)   // §26.4 b: rows keyed by the authoritative checkoutKey
useSessionArtifacts(id)     → artifactsCollection where sessionId
```

`checkoutKey(checkout)` is the shared function `shared/contract/checkout.ts` (`workspaceId + ":" + (worktreeId ?? "primary")`, the `worktreeId` read from the session row); main's feed and the renderer collection both key rows with it (§26.4 b amends `gitStateCollectionOptions.getKey`, `renderer-next/data/db/tables.ts:282`, and the feed key, `main/rpc/tables/index.ts:169`). Sidebar chips, Files decorations, the tray and the Changes tab all select by it, so a primary checkout and two worktrees of one workspace are three rows (R4-T6).

`!botOwned && editorFor == null && routineId == null` uses `eq`/`and`/`isNull` from `@tanstack/db` 0.9.2 (`query/builder/functions.d.ts`); whether `isNull` exists in 0.9.2 is **unverified**, and R4-T6 pins the form that ships (a component-side filter is the fallback, as 03 §6.2).

### 6.3 Ids

New sessions get a client id `crypto.randomUUID()` checked against `SessionId` (`ids.ts`); main honours a valid unused caller id and returns `CONFLICT` for a taken one (spec 00 B notes, "Caller ids"). The id is minted when the start page mounts and kept in the start draft, so the draft's conversation key can be promoted to the session key deterministically (§8.6). Terminal ids keep today's `terminal-<ts36>-<n>` scheme (S85); browser resource ids are `browser-<uuid>`.

### 6.4 Session mutations (`features/sessions/data/session-actions.ts`)

Handlers are `ipcCollectionOptions`'s (spec 00 B.3): they await the echo *received*; actions needing the persisted row await `tx.isPersisted.promise` outside the handler.

| Action | Client call | Main | Final row | Failure → handling |
|---|---|---|---|---|
| Create session | `sessionsCollection.insert(row)` with a full optimistic `SessionRow` (`label: ""` → "Untitled" display, `status: "stopped"`, `turn: null`, owner null, **`model` and `mode` = the draft's picks**) then `await tx.isPersisted.promise`; `toInsertInput` sends `{ id, workspaceId, model, mode }` (§26.4 d extends the insert schema) | `createAgentSession(workspaceId, null, null, id, { model, mode })`: both persisted on the row at creation, so `agent.start`, the relay's start-on-send and any concurrent caller read **one** configuration from the row (Codex r1 #5) | server row | `CONFLICT` for **this** id: only possible if the id was already created by an earlier attempt of the same draft, so the pipeline treats it as "already created" and resumes (§8.6); `NOT_FOUND {workspace}` → the picker shows "That folder was removed" and re-resolves (§8.3); `PRECONDITION_FAILED {workspace-missing}` → §17.2; `BAD_REQUEST {model}` (unknown model) → inline "That model isn't available", draft kept; others → inline error, draft kept |
| Rename | `sessionsCollection.update(id, (d) => { d.label = trimmed })` | `updateAgentSessionLabel` | echo (trimmed) | empty → prevented (inline "Name can't be empty", parity with the dead tree); `NOT_FOUND` → rollback + toast "This session was deleted"; others → rollback + toast "Couldn't rename" |
| Pin / unpin | `updatePrefs({ pinned: { sessionIds: next } })` with `next` computed from the row the user saw (the implemented `updatePrefs(patch: PrefsPatch)`, `renderer-next/data/db/tables.ts:380-400`; 03 r3 §24.1) | `PrefsStore.update` (marks the leaf `user`) | echo | rollback + toast "Couldn't pin" (R4-T7 drives the real helper's echo and rollback) |
| Model | `sessionsCollection.update(id, (d) => { d.model = next })`; then `agent.setModel` when `status === "running"`; then `settings.setDefaultModel({ model: next })` (parity S44) | `setAgentSessionModel` | echo | `agent.setModel` `CONFLICT {model_unavailable}` (or its legacy message until typed, §26.4) → toast "Couldn't switch models. {detail}" and the row keeps the persisted pick (it applies at the next start) |
| Delete | navigate away (§5.5); `agent.stop({ workspaceId, sessionId })` (ignore `NOT_FOUND`); `sessionsCollection.delete(id)` | `stopAgentSession`, `removeAgentSession` (transcript and artifacts removed; `routineRuns`/`artifacts` batches) | row gone | `NOT_FOUND` → resolves (idempotent, 03 §26.5 option `idempotentDelete`); others → rollback, the AlertDialog stays open with "Could not delete that session. Try again." (S18) |
| Worktree for a draft | `git.worktrees.materialize({ workspaceId, baseRef, name?, sessionId })` or `git.worktrees.setForSession({ workspaceId, sessionId, worktreeId })` **after** create, before the first send (S37) | creates/attaches, echoes `sessions` | row with `worktreePath/Branch` | result `success: false` is unwrapped to an error (spec 00 A.5): inline error on the tray item, the session stays (no worktree), send stays blocked until the user picks "No worktree" or retries |
| Mark as unread | `sessionsUnreadStore.mark(id)` | — | dot | — |
| Copy session ID | `navigator.clipboard.writeText(id)` + toast "Copied" | — | — | toast "Couldn't copy" |

Read-only fields: any other field in a `sessionsCollection.update` throws `ReadOnlyFieldError` (`FORBIDDEN`) in the handler (spec 00 B notes), so the UI never offers one.

### 6.5 Workspace mutations (`features/sessions/data/workspace-actions.ts`)

| Action | Client call | Main | Final row | Failure → handling |
|---|---|---|---|---|
| Add a folder | `system.dialog.openFolder()` → `workspaces.add({ path })` (a plain mutation returning `{ workspaceId }`; the row arrives as an insert batch), then the action waits for that id in the collection (`awaitRow(workspacesCollection, id, 5_000)`, a `subscribeChanges` helper; on timeout `utils.resync()` once) | `addWorkspace(path, false)` (id derived from the path; an existing path returns its id) | new or existing row | dialog cancelled → nothing; `BAD_REQUEST`/`INTERNAL` (legacy result `error`) → toast "Couldn't add that folder. {error}" (parity S29 copy) |
| Drop a folder on the sidebar | `transport.host.getPathForFile(file)` for a directory item → same as Add | same | same | a file, not a folder → toast "Drop a folder, not a file"; no host (web mode) → drop disabled |
| Default workspace | `workspaces.ensureSessionHome()` | creates or returns the "auto" workspace | `kind: "auto"` row | toast "Couldn't open the default workspace" |
| Pick (explicit) | `updatePrefs({ lastPickedWorkspaceId: id })` | — | — | — |
| Rename workspace | `workspacesCollection.update(id, (d) => { d.label = trimmed })` | `updateWorkspaceLabel` | echo | empty prevented; others rollback + toast |
| Choose another folder (relocate) | `system.dialog.openFolder()` → `workspaces.relocate({ workspaceId, newPath })` | `relocateWorkspace` | row `path` updated | `NOT_FOUND` → toast "This workspace was removed"; others → toast with the detail (parity S63) |
| Remove workspace | AlertDialog "Remove {name}?" / "Its sessions stay readable in Sessions. The folder itself is not touched." → `workspacesCollection.delete(id)` | first delete tombstones (`status: "deleted"`); the row returns as an update | row with `status: "deleted"` (hidden from pickers; its group shows "Removed") | `NOT_FOUND` → resolves; others → rollback + inline error |
| Erase a removed workspace | a second delete from the removed group's menu ("Forget this workspace", confirm) | erase | row gone | as above |
| Open in Finder / Explorer | `system.showItemInFolder({ path })` | — | — | toast on refusal |
| Open in terminal | opens a **Terminal tab** in the current session when that session belongs to the workspace, else starts `/sessions/new?workspace=` with a terminal tab (§11.1) | — | — | — |
| Set as default | `updatePrefs({ lastPickedWorkspaceId: id })` (the default for new sessions) | — | — | — |

The two-stage delete is the implemented behaviour (spec 00 B notes, "Workspace delete is two-stage"); the collection's optimistic delete is followed by the row's return, which the sidebar renders as the removed group without a flicker because the group is keyed by id and animates only on `status` change (R4-T7 asserts the DOM trace).

### 6.6 Attention: one pure function

Same shape as bots (03 §6.6), so the shell's needs-you group can merge both:

```ts
export type SessionAttention =
  | { kind: "needs-you"; since: string; reason: "permission" | "connector" }   // turn.phase === "waiting_permission", or a pending connector ask for this session
  | { kind: "running"; caption: string | null }     // turn.isBusy (pending | streaming)
  | { kind: "error" }                               // turn.phase === "error" or runOutcome failed (routine runs only)
  | { kind: "unread" }
  | { kind: "idle" };
export function sessionAttention(row: Pick<SessionRow, "turn" | "status">, unread: boolean, pendingConnectorAsks: number, activity?: { caption: string | null }): SessionAttention;
```

Precedence needs-you > running > error > unread > idle. `pendingConnectorAsks` comes from one keyless `connectors.events()` subscription per document (snapshot of every conversation's pending asks first, A fixes), folded into a `Map<sessionId, count>` store by `conversationRefFromKey`: ConnectorGate emits asks without changing the turn phase (`service-host.ts:793`), so a suspended session whose turn stays `streaming` is still `needs-you` (reason `connector`, chip "needs you", `SessionsNeedsYou`, and the `needs-you` cue, as bots do; Codex r2 #11). `caption` is the running tool title from the chat kit's store when the thread is cached (through the route-provided `threadActivity(threadId)` accessor, 03 §6.6), else null. `SessionsNeedsYou` is the shell's needs-you slot for sessions (foundation §7.2, 03 §7.2): up to 3 compact rows, "{n} more" → `/sessions`.

### 6.7 Unread (`features/sessions/data/unread-store.ts`)

A TanStack `Store<{ ids: Set<sessionId> }>`, not persisted (parity S24). It is driven by `ai.runFinished` (§6.1; 03 r3 §24.11), never by DB diffs (the tables coalesce notifies, so a quick run can show no busy → idle transition). A notice for a listed session with `outcome` `success` or `error` marks it unread unless that thread is visible (current route's session and `document.hasFocus()`); `cancelled` (Stop) marks nothing; a repeated `runId` counts once. The `turnTransitions(collection)` watcher is kept for `needs-you` only (a level, so coalescing is harmless). Also marked on `browser.events { runtime-materialized }` and on a background preview (§13.4) for a session that is not visible (S25). Cleared by opening the session; "Mark as unread" sets it.

---

## 7. The sessions sidebar (`features/sessions/sidebar/`)

Built on the foundation's `NavList` molecule. Geometry from canvas `SessionsSidebar` and `SessionsSidebarStates` (the states board is the source for rows: 34 px there, 32 px in the parts board; we use `--row-h` 32 with 2 px gap, i.e. the parts board, and the states board's contents).

### 7.1 Header and search

- Header 36 px, padding `0 4px 0 8px`: "Sessions" (15/600), Search (28 × 28, radius 8, `aria-label="Search sessions"`, `aria-expanded`) and New session (`<AppLink to="/sessions/new">`, `aria-label="New session"`).
- Search opens a 32 px field (radius 9, `bg-muted`) under the header, focused. Matching: every listed session by `label`, case- and accent-insensitive substring; results replace the groups with one list of two-line rows (canvas: label with the match in `--primary`-coloured bold (`<mark>` styled, not colour alone: bold), stamp right, sub-line "{workspace} · {branch}" where branch = `worktreeBranch` or the workspace's current branch when known). Escape clears and closes and returns focus to the Search button. "No sessions match" compact `Empty` when nothing matches. The dead tree's fuzzy matcher is not ported (substring is what the canvas shows).

### 7.2 Groups and order

1. **Pinned** (label, only when non-empty): `prefs.pinned.sessionIds` order, listed sessions only.
2. **One group per workspace** that has listed sessions or is pickable, ordered by the most recent `updatedAt` of its sessions desc, empty pickable workspaces last by label. Group row (32 px): chevron (rotates, `Collapsible`), folder icon, label (500), count (12 muted), branch (12 muted, from `git.currentBranch({ workspaceId })`, fetched only for **expanded** groups and cached 5 s; hidden while unknown or when the folder is not a repo); expanded state `prefs.workspaceExpanded[id]` (default expanded). A workspace whose `checkPath.exists === false` shows the label in `--destructive` and "missing" (canvas); `status: "deleted"` groups show "Removed" and only their sessions, collapsed by default.
3. Sessions inside a group: `updatedAt` desc, excluding pinned ones (they show only in Pinned).

`kind: "auto"` renders as "Default workspace" (canvas). `kind: "routine" | "bot"` never render (their sessions are filtered out anyway).

### 7.3 Row (`session-row.tsx`)

`NavList.Item` as `<AppLink to="/sessions/$sessionId" transition="nav-lateral">`, 32 px, padding `0 8px 0 28px` inside a group (`0 8px` in Pinned and search), radius 8; active `bg-sidebar-accent`, `aria-current="page"`.

| `sessionAttention` | Dot (6 px) | Trailing chip (11 px, radius 4, 1/4 px padding) |
|---|---|---|
| `needs-you` | `--chat-status-attention` | "needs you" filled attention with its foreground |
| `running` | `--chat-status-running` | "running" on `bg-sidebar-accent` in running colour |
| `error` | `--destructive` | — (label tooltip "Stopped with an error") |
| `unread` | `--chat-status-done` | — (visually hidden "Unread") |
| `idle` | `--muted-foreground` at 40% | the diff chip "+a −d" (done colour for +, destructive for −) **only** for sessions whose checkout has a `gitState` row (the active primary checkout, or one being watched, §26.4 b) and whose last completed run touched files (derived from the chat kit's cached `RunOutcomeRecord` + tool parts when cached, else omitted); otherwise none |

- Label: one line, ellipsis, full text in `title` and a tooltip on focus.
- Accessible name: "{label}, {state}" ("Fix sidebar restore width, running").
- Keys are session ids; rows never remount on data changes (foundation R1-T4 pattern).

### 7.4 Session row menu (`session-row-menu.tsx`)

One item list, rendered by a registry `ContextMenu` (right-click; keyboard via 03 §7.4's unverified path) and a `DropdownMenu` behind a ⋯ `NavList.Action` (hover/focus-within, `aria-label="Options for {label}"`). Canvas menus (`SessionsSidebarStates`, `Pickers`): 208 px, radius 14, 32 px items.

| Item | Shown when | Action |
|---|---|---|
| Rename | always | inline edit in the row (TanStack Form field, Enter saves, Escape cancels, blur saves) → §6.4 |
| Pin / Unpin | always | §6.4 |
| Mark as unread | not unread, not active | §6.7 |
| New worktree from here | the workspace is a git repo (`git.currentBranch({ workspaceId })` succeeded; hidden otherwise) | `/sessions/new?workspace=<id>` with the tray's worktree set to "New worktree" (draft) |
| — separator — | | |
| Copy session ID | always | §6.4 |
| — separator — | | |
| Delete session (destructive) | always | AlertDialog (S18) → §6.4 |

Canvas "Open in side panel" / "Open beside this chat" is not rendered: the kit has one chat surface per thread view and a second thread in a panel is out of scope (§27.3). Canvas "Move to workspace…" likewise (F7).

### 7.5 Workspace row menu (`workspace-row-menu.tsx`)

Canvas: New session here (`/sessions/new?workspace=`), Open in Finder (label per platform: "Open in Finder" on macOS, "Show in Explorer" on Windows, "Open folder" on Linux; `system.info.platform`), Open in terminal (§6.5), Set as default, — , Choose another folder…, Remove workspace (destructive). Also Rename workspace (dead-tree parity, placed after Set as default). A removed group's menu: Forget this workspace, Choose another folder… (re-add by relocate).

### 7.6 Empty, loading, drop

- **Empty** (no listed sessions and no pickable workspaces besides "auto"): canvas: "No sessions yet" (500), "Start one with ⌘N, or drop a folder here." (12 muted, the shortcut from `formatForDisplay("Mod+N")`), and the drop zone: 72 px, radius 10, 1 px dashed `--primary`, "Drop a folder to add a workspace" (12). The zone also appears over the whole sidebar while a drag with files is over it (`dragenter`/`dragleave` counters).
- **Footer** "Add a folder" row (32 px, `Plus` icon, muted) → §6.5 Add.
- **Loading / error**: `NavList.Skeleton` × 6; "Couldn't load" + Retry (`resync()`), foundation.
- At `sm` the sessions sidebar floats (foundation §7.1) and is otherwise identical.

---

## 8. The start page (`/sessions/new`, canvas `Main`, `MainCollapsed`)

### 8.1 Layout

Centred column, width 680 (760 when the sidebar is not in layout, `MainCollapsed`), vertically centred, gap 24:

1. "What should we build?" 28/600, line 36, centred.
2. The chat kit `Composer` (exported compound, 02 §2) in **session full** mode on a draft thread key `draft:<mintedId>`: 120 px box (radius 20, padding `14px 8px 8px 16px`, `bg-muted`), row 1 placeholder "Describe the work. Type @ for files, / for skills", row 2 [Attach 28] [Mode chip] spacer [Model chip] [Dictate 32] [Send 32]. `showModeChip: true`, `mentions` from `files.search({ checkout: { workspaceId: draft.workspaceId }, query })`, so a picked workspace B is searched even while main's legacy active workspace is A (Codex r1 #6; disabled with a tooltip until one is resolved).
3. The **context tray** under it (§8.2): 52 px, `margin: -16px 12px 0`, `padding: 16px 8px 0`, radius `0 0 14px 14px`, `bg-(--muted)/60` over `--background` (canvas `#1e1e21` between panel and raised; mapped to `color-mix(in oklab, var(--muted) 60%, var(--background))`, a molecule-level value, not a token).
4. Starters (§8.4), or with the sidebar collapsed the two-column recent + starters block (§8.5).

The 8 px grid holds: every value above is a multiple of 4, and the layout gaps (8, 12, 16, 24) are the canvas's; the 14 px tray radius and 20 px box radius are the canvas's radii, not spacing.

### 8.2 Context tray on the start page

Left: **workspace** (folder icon + name; opens `WorkspacePicker`), **branch** (branch icon + current branch of the draft's checkout, mono 12; opens `BranchPicker`; hidden when not a git repo), **worktree** ("New worktree" / "No worktree" / the chosen worktree name; opens `WorktreePicker`; hidden when not a git repo). Workspace and worktree are **draft state** until Send (§8.6).

Right: **execution target** (Codex r1 #7), from `settings.execBackend.get` → `{ selected, effective, statuses }`:

| Shown | When | Menu |
|---|---|---|
| "This Mac" | `effective === "local"` | the implemented backends (`local`, `docker`) as radio items with each `statuses[i]` reason when unavailable (disabled); unimplemented ids are not listed |
| "Docker" | `effective === "docker"` | same |
| "{selected} unavailable, using This Mac" (muted, warning dot) | `selected !== effective` | same, plus "Why" text from the status |
| "Sandboxed" suffix ("This Mac · Sandboxed") | the draft's (or session's) mode is `AUTO` | the mode is changed from the mode chip, not here |

Choosing a backend calls `settings.execBackend.set({ backend })` **at once** (a global setting: it applies to every agent started afterwards; it is not stored in the draft). The returned state replaces the query data; `effective !== backend` (refused or unavailable) shows an inline "Docker isn't available: {reason}. Using This Mac." under the tray for 5 s. **Unverified** whether a running agent picks up a backend change without restart; the thread's menu is therefore disabled while the agent is running, with "Applies to new sessions and restarts" (R4-T14 asserts the actual backend a new session's first command runs in, for each choice and for the fallback).

All items are 28 px buttons, radius 8, padding `0 8px`, gap 6, 13 px text, `aria-haspopup`.

### 8.3 Resolving the workspace, and the picker

Resolution order (loader, not on preload for the side effect): `search.workspace` if pickable → `prefs.lastPickedWorkspaceId` if pickable → the `kind: "auto"` workspace if one exists → `workspaces.ensureSessionHome()` (side effect; skipped on preload, run in the loader otherwise) (parity S30). The result is the start draft's `workspaceId`; the URL is **not** rewritten (a bare `/sessions/new` stays clean).

`WorkspacePicker` (registry `Popover` + `Command`, 320 px, radius 14, canvas `Pickers` geometry): search field (autofocus; `Command` handles keys, no propagation hacks), "Default workspace" (title attribute = `workspaces.sessionHomePath`), then pickable workspaces by label with a check on the current one and a muted path sub-line, a missing one with "missing" and disabled; "No workspaces found"; footer "Add a folder…" (§6.5). Picking sets the draft's workspace and `prefs.lastPickedWorkspaceId` (explicit pick, parity S30).

`WorktreePicker` (same shell): "No worktree" (current checkout), existing worktrees from `git.worktrees.list` (name, branch, `isCurrent` check), "New worktree" (draft: created at send with `baseRef` = the current branch and `name` = derived from the first line of the message, as `materialize` does today; §8.6).

`BranchPicker`: §14.2 (same component in the thread).

### 8.4 Starters

"Try one of these" (12 muted) + "Shuffle" (text button) over a 3 × 2 grid (gap 8) of cards: padding `12px 14px`, radius 14, `bg-card`; a 22 px tile (radius 7, tint + stroked glyph) + name (13/500, one line) and a 2-line muted detail. Content: `SESSION_STARTERS` (moved to `shared/sessions/starters.ts`, 6 today); card copy is i18n (`sessions.starters.<id>.{name,detail}`), the prompt text inserted is the existing one (`workspace.starters.*` keys, remapped). Click fills the composer and focuses it at the end; never sends (S31). Shuffle rotates which 6 of the pool show when the pool grows past 6 (today it is exactly 6, so Shuffle is hidden until then).

### 8.5 Collapsed sidebar: recent sessions (canvas `MainCollapsed`)

When the sessions sidebar is not in layout (collapsed or floating), the block under the composer is two columns (gap 24): left "Pick up where you left off in {workspace}" + "All sessions" (opens the floating sidebar) and the 4 most recent listed sessions of the resolved workspace as 44 px rows (radius 10, `bg-card`: status dot, label, branch mono 11, stamp 12 right); right "Try one of these" with 4 starters as 44 px rows. With the sidebar pinned, only the starter grid shows (the sidebar already lists history).

### 8.6 Send: `startSession()` (`features/sessions/start/start-session.ts`)

The **start draft** (a TanStack Store keyed `"new"`, `sessionStorage`-persisted like 03 §8.3) is a small state machine (Codex r1 #2, #4):

```ts
interface StartDraft {
  id: string;                                   // the session id, minted on mount
  workspaceId: string | null;
  worktree: { kind: "current" } | { kind: "existing"; id: string } | { kind: "new"; baseRef: string };
  worktreeOperationId: string | null;           // minted and persisted before the first materialize call (§26.4 g)
  stage: "draft" | "created" | "checkout-ready" | "handed-off";
  envelope: SubmissionEnvelope | null;          // set when Send is pressed, cleared at "handed-off"
}
interface SubmissionEnvelope {                  // chat kit type (§26.2)
  runId: string; messageId: string;             // caller-supplied, minted at Send
  parts: UIMessagePart[];                       // text + the attachment @path lines, exactly as the kit would build them
  forwardedProps: { mode: AgentMode; model: string | null };
}
```

1. **Send** (kit `routeSubmit` says `send`): the page builds the envelope with fresh `runId`/`messageId` and stores it in the draft **before** any call. Pressing Send again while a stage is running is ignored.
2. **Stage `draft` → `created`**: `sessionsCollection.insert({ id, workspaceId, model, mode })` (§6.4); a `CONFLICT` for this id means an earlier attempt already created it (e.g. reload mid-pipeline): verify the row exists with this workspace and continue. Persist `stage: "created"`.
3. **`created` → `checkout-ready`** (Codex r2 #3). Main's `materialize` creates a random branch/path per call (`service-host.ts:2971`, `git-service.ts:524`), so the stage must survive a reload between the server's success and the stage write:
   - **Reconcile first**: read the session row. If it already has the intended checkout (`new`: `worktreeOperationId` recorded on the row by main, §26.4 g; `existing`: `worktreeId === id`; `current`: `worktreeId == null`), skip to step 4.
   - **`new`**: mint `worktreeOperationId` (UUID), persist it in the draft, then `git.worktrees.materialize({ workspaceId, sessionId, baseRef, name?, operationId })`. Main is idempotent per `(sessionId, operationId)`: a repeat returns the recorded result and creates nothing.
   - **`existing`**: `git.worktrees.setForSession({ workspaceId, sessionId, worktreeId })` (idempotent by nature).
   - **"No worktree" after a failure or an attach**: an explicit **detach**, `setForSession({ …, worktreeId: null })`, then reconcile (the row must show `worktreeId == null`). It is never a silent no-op, so a worktree attached before the failure cannot stay selected.
   - On failure the draft stays at `created` with the tray's inline error; **Retry** repeats only this stage with the **same** `worktreeOperationId`. Neither path re-inserts the session (R4-T12 includes a reload after server success but before the stage write: one worktree, one session, one first message).
4. **Scope promotion** (parity S37): `terminal.promoteScope`, `browser.runtime.promoteScope`, `panelTabsStore.promote(draftKey, sessionKey)`; failures logged, never blocking. Persist `stage: "checkout-ready"`.
5. **Hand-off**: the envelope is written into the kit's draft store for the new thread as `pendingSubmit: SubmissionEnvelope` (§26.2), then `stage: "handed-off"` and the start draft is cleared (a new id is minted for the next visit). `navigate({ to: "/sessions/$sessionId", transition: "nav-forward" })`.
6. The thread's `ChatView`, after `session.load()`, admits `pendingSubmit` through `session.admitEnvelope(envelope)` (kit amendment: admission with **caller-supplied run and message ids**) and clears `pendingSubmit` only when the admission is definitive (`started`/`queued`/`rejected`/`duplicate`). A reload **after acceptance but before clearing** re-admits the same ids: main answers `duplicate` with the original ack (idempotent by run id, PLAN amendments), and the agent's echo carries the same message id, so exactly one run and one user message exist (R4-T13).
7. The agent is started by the relay's start-on-send (§26.3) or by `ensureAgentStarted` (§9.2), whichever comes first; both read model and mode from the row (step 2), so there is one configuration.

Resuming: opening `/sessions/new` with a draft in `created` or `checkout-ready` shows the composer with the envelope's text read-only and a line "Finishing your last session…" with Continue / Discard (Discard deletes the created session via §6.4 and restores the text).

Send is disabled while: no workspace resolved; the workspace is missing (§17.2); a "New worktree" is chosen but the repo has no current branch; the kit's own blocks (uploading, no model).

---

## 9. The thread (`/sessions/$sessionId`)

### 9.1 Composition in the route

```tsx
function SessionRoute() {
  const { sessionId } = Route.useParams();
  const search = Route.useSearch();
  const row = useSession(sessionId);                                   // features/sessions
  if (row == null) return <SessionGone />;
  const slots = useSessionThreadSlots(row);                            // banner, composerContext (tray), runTail (ChangesCard), empty, readOnly, model, mentions, history
  return (
    <>
      <TopBarSlot name="identity"><SessionIdentity row={row} /></TopBarSlot>
      <TopBarSlot name="actions"><SessionTitleActions row={row} /></TopBarSlot>
      <SessionDock row={row} search={search}
        chat={<ChatView threadId={row.id} skin="session" slots={slots.chat} composer={slots.composer}
                        workspaceRoot={slots.root} onOpenFile={slots.openFile} onOpenSubagent={slots.openAgent}
                        onOpenDiff={slots.openDiff} />}
        renderSubagent={(id) => <SubagentDetail threadId={row.id} subagentRunId={id} />} />   {/* chat kit export, §26.2 */}
      <Outlet />                                                         {/* masked full diff */}
    </>
  );
}
```

- **Identity** (canvas `TopBar` context): "{workspace label} /" muted + session label 13/500, ellipsis, max 440 px at `xl`. Clicking the label turns it into an inline field (rename, §6.4); `aria-label="Rename session"` on the button. When the dock is in split view with a tab open, the identity is followed by the tab strip (§10.1) in the same bar (canvas `SessionReview`).
- **Actions**: none of their own beyond the foundation's panel toggle; at `sm` the foundation's ⋯ fold holds Rename, Pin, Copy session ID, Delete.
- `workspaceRoot` = `row.worktreePath ?? workspace.path`; `onOpenFile(abs)` → opens a `preview:` tab for that file (inside the root) or `system.openPath` (outside); `onOpenSubagent(id)` → `tab=agents&agent=id`; `onOpenDiff(path, toolKey?)` → the masked diff route (kit amendment §26.2 adds `onOpenDiff`).

### 9.2 Agent start and continuation (`data/agent-start.ts`)

`agentLifecycle(sessionId)` (Codex r2 #9) is a small per-session controller owned by the mounted session route (not by the loader, never on preload) and scoped to **process incarnations**, as today's effect reacts to every stopped/error transition while the chat stays mounted (`chat-panel.tsx:1046-1129`):

1. **Trigger**: whenever the row's `status` is `stopped` or `error` while the route is mounted and the checkout exists (§17.2) — on mount, and again after any later transition into those states (a crash, an inactivity stop, `agent_exit`). A user-initiated `agent.stop` from this window (delete, §6.4) sets a flag that suppresses the restart.
2. **Start**: `agent.start({ workspaceId, sessionId })` with **no model/mode overrides** (main reads both from the row, §6.4, §26.4 d; a legacy row with `model: null` gets main's default resolution). A start already in progress (relay start-on-send, another window) is **joined**: the call resolves when main reports that start's readiness (§26.3), not immediately.
3. **Retries** after 0.5, 1, 2, 4 s (cap 8 s), 5 attempts per trigger (parity S42). Each trigger carries a **generation token**; a newer trigger, a successful start seen on the row (`status: running` with a new incarnation from `CUSTOM session.ready`), or route unmount cancels pending retries of older generations, so a stale retry never starts a second process. `PRECONDITION_FAILED {workspace-missing}` stops at once (→ §17.2). After the last failure the thread shows a `Notice`-styled banner "Couldn't start the agent. {detail}" with Retry (a new generation) — a banner, not a toast, announced once (R4-T8).
4. **Restoration per incarnation** (parity S43): after **each** successful start whose incarnation differs from the last one handled in this document, if `row.conversationId != null`, `agent.switchConversation({ workspaceId, sessionId, conversationId })` once for that incarnation.
5. The row's `status` echo drives the kit's busy/ready state; the controller caches only the last handled incarnation and the current generation.

Continuations are otherwise the kit's: `ErrorCard` retry and switch-model, resume on the free pool (02 §5.6), steering and the queue (02 §8.3, §8.5). Reopening a session is a continuation by construction (steps 1–4).

### 9.3 Composer binding (`useSessionThreadSlots`)

- `composer.mode`: `"full"` in split view, when the panel is closed, and when Chat is selected (`tab=chat`); `"mini"` when a non-Chat tab is selected in full view or below `xl` (§10.3, §10.4 state table, canvas `FullView`: floating 420 px mini pill bottom-right, 22 px from the edges, morphing to the two-row box with the tray on focus, `FullViewFocused`).
- `placeholder`: "Steer the run, or queue the next step" while busy (canvas), "Ask for a change, or open a pull request" after a run that changed files (canvas `SessionReview`), else "Reply, or steer the run" (canvas split/full).
- `showModeChip: true`; the chip hides **Auto** when `settings.sandboxSupport.available` is false (parity S34, kit prop `availableModes`, §26.2). A mode change also writes `prefs.defaultMode` (sticky global mode, parity).
- `model`: value = `row.model` (else the resolved default), `groups` = the shared builder of 03 §13.1 (moved to `components/model-groups/` so bots and sessions share it: `botModelGroups` becomes `modelGroups(models, favorites, { appDefault: false })`), `onChange` = §6.4 Model.
- `mentions`: `files.search({ checkout: { workspaceId, sessionId }, query })` results under the session's checkout (`relativePath`, kind icon).
- `history`: `settings.promptHistory.list` / `.add` for ArrowUp (kit amendment §26.2, S54).
- `attachmentsBase`: `workspaceRoot` (S38); `null` when the workspace is missing.
- `slots.banner`: the shared `ConnectorRequestCard` of **03 r3 §11.4, whose sequence is authoritative here** (Codex r2 #10): fed by `connectors.events({ conversationKey })` (pending asks snapshot first, then `request`/`cleared`); **Connect** runs the flow (`connectors.connect` or `connectors.submitFields`), then **awaits `mcp.refresh({ workspaceId, sessionId })` for the requesting session** (the request's `conversationKey`, which may belong to a non-active workspace; skipped when that session has no running agent; `success: false` for no process proceeds), and only then `connectors.respond({ requestId, conversationKey, outcome: "connected" })`, releasing the suspended tool; a flow or refresh failure shows the error on the card and answers nothing (the card stays actionable); a cancelled flow and **Not now** answer `declined` (R4-T35). Also the start-failure banner (§9.2).
- `readOnly`: §17.3.
- `blocked: "no-model"` when `models.list` has no configured model: the Send button opens the "Choose a model" popover with "Set up models" → `/settings/models` (S36; kit amendment §26.2).

### 9.4 The context tray in the thread (`slots.composerContext`)

Canvas `SessionRunning`: 46 px, `margin: -12px 28px 0`, `padding: 12px 8px 0`, radius `0 0 12px 12px`; items 26 px. Left: workspace (label only; opens the picker **read-only**: a running session's workspace cannot change; the picker shows it checked and a note "A session keeps its folder"), branch (mono 12; `BranchPicker`, §14.2), PR item (§14.3) or "No PR yet" muted. Right: plan summary "Tasks {done} of {n}" from `store.agent.plan` (opens a 320 px popover listing the plan items with checks; S56), else the execution target of §8.2 (menu disabled while the agent runs). In full view the tray appears only while the mini composer is expanded (canvas `FullViewFocused`), with "Connectors" on the right linking to `/library/connectors` (canvas).

### 9.5 `ChangesCard` (kit `RunTail` slot)

Canvas `SessionRunning`/`SessionReview`: 56 px, radius 12, `bg-(--muted)/60`, padding `0 8px 0 16px`: "{n} file(s) changed" (500) + mono "+a −d", then buttons. Source: the files the **latest completed run** wrote (the run's `edit`/`write`/`ast_edit`/`batch_edit`/`notebook_edit` tool parts' paths, joined to `gitState.gitChanges` for current `additions`/`deletions`; a path no longer changed in git drops out). Buttons: "Review changes" (secondary; → `tab=changes`), and — only after §26.4's `git.discard` lands — "Undo" is **not** on the card (run-level undo deferred, F6); "Keep all" / "Undo all" appear in the Changes tab (§14.4). The card hides when the run changed nothing git sees.

---

## 10. The side panel and the dock (`features/sessions/dock/`)

User decisions: tab strip only when content is open; terminal is a tab; panes malleable and dockable; 8 px grid. The foundation's `SidePanel` (§7.5) is used for bots; **sessions replace its contents and geometry with `SessionDock`**, which the route renders in place of the pane + panel pair (the foundation's `SidePanel.Root` stays mounted empty for sessions; §26.1 adds `staticData`-free opt-out: `SidePanel.Root` renders nothing when the route provides `<SidePanel.Override/>`).

### 10.1 The tab strip (canvas `SplitView`, `FullView`, `SessionReview`, `SubAgents`, `W900`, `W800`)

- **Exists only while the panel is open** (`search.tab` set, `"chat"` included). `tab` absent = **panel closed**: no strip, chat only, in every band. With the panel closed, the title bar shows the foundation's panel toggle (`aria-label="Open side panel"`, canvas `SessionWorkspaceMissing`), which sets `tab` to the last active tab of this session (from `panelTabsStore`) or, when none, opens the Add-tab menu anchored to the toggle.
- Location: in the title bar after the identity at `xl` split view (canvas: identity block 440 px, then tabs); as the whole leading area in full view and below `xl` (canvas `FullView`/`W900`: "Chat" is the first tab).
- Tab (`components/tab-strip`): 30 px high, radius 8, padding `0 12px`, gap 8, 13 px; active `bg-muted` + foreground, idle muted; kind icon 14 px (Changes `FileDiff`, Terminal `SquareTerminal`, Files `FolderOpen`, Browser `Globe`, Agents `Bot`, Device `Smartphone`, preview by file type), title (ellipsis; browser = page title or host, terminal = "Terminal N" or its OSC title, preview = file name), a count badge for Changes and Agents (18 px pill, `bg-secondary`), a close × (16 px, on hover/focus and always on the active tab; not on Chat, Changes, Files, Agents: those are closed by the strip's "Close tabs" or reopen from the menu). Middle-click closes (S74). Widths: min 96, max 200, shrink evenly; overflow collapses the tail into "{n} more" (canvas `W800`), a `DropdownMenu` listing hidden tabs.
- **Add a tab** (28 px, `Plus`, `aria-label="Add a tab"`): menu (240 px) with icon + label + one-line description (S71): Browser, Terminal (a split button: the item opens the stored shell; a chevron submenu lists shells when more than one, S86), Files, Changes (only when `gitState.gitChanges.length > 0`), Agents (only when the thread has sub-agents), Device (only when `devices.status.enabled` is true). Files/Changes/Agents/Device are singletons: choosing one that is open focuses it (menu row shows "Open", S71).
- Right end: **Enter full view / Exit full view** (28 px icon toggle, `aria-pressed`), **Close tabs** (closes the panel: `tab` cleared, `view` kept, tabs stay in `panelTabsStore` for the toggle). Selecting Chat in the strip sets `tab=chat`; it never closes the panel (Codex r1 #20).
- Keyboard: the strip is a registry `Tabs` `TabsList` (roving focus, arrows, Home/End); `Mod+W` closes the active closable tab (app hotkey, `guardRichText`), `Ctrl+Tab` / `Ctrl+Shift+Tab` cycle (`useAppHotkey`), `Mod+Alt+B` is the foundation's panel toggle.

### 10.2 Open tabs and the active tab

- **Active tab** = `search.tab` (URL; reload, back/forward, deep links, PLAN "state lives in the URL").
- **Open tabs** = `panelTabsStore` (TanStack Store keyed by conversation key, `sessionStorage`-persisted per document: survives reload and HMR, not quit; like the draft stores). Entry: `{ ref: SessionTabRef; title: string; openedAt: number }`. Kept in sync with main where main owns the resource: terminal tabs are reconciled with `terminal.events` states by **existence, not presentation** (Codex r1 #10): every runtime main reports for this conversation key is an open tab whatever its `visible` flag (`hide` sets `visible: false` and keeps the PTY, `conversation-terminal-runtime-registry.ts:380`); a tab is dropped only when its runtime disappears from a snapshot or its output iterator ends with `exit`/`retired {closed}`; a runtime the store lacks is added (a terminal the agent opened, or tabs lost with `sessionStorage`), browser tabs with `browser.events { runtime-materialized }` (the agent's browser is adopted, S99). Singletons need no reconciliation.
- **Closing** follows today's neighbour rule (S70): activate the right neighbour, else the left, else clear `tab` (the strip disappears). The close is optimistic in the store; the resource close (`terminal.hide({ close: true })`, `browser.runtime.close`) runs after.
- **Promotion** draft → session: `panelTabsStore.promote(from, to)` re-keys entries (§8.6 step 4).
- The preview tab cap is 50 with oldest-first eviction (S77).

### 10.3 Split and full view, and widths

`view` ∈ `split | full` (URL, retained across sessions by the layout's middleware). Effective layout (pure `sessionLayout(band, view, tabOpen, sidebarPinned)` in `dock/layout.ts`, a table test):

| Band | No tab | Tab, `view=split` | Tab, `view=full` |
|---|---|---|---|
| `xl` ≥ 1100 | chat pane centred (`max-width` 720 content), sidebar per prefs | **sidebar folds** (effective; prefs untouched), rail + chat pane (default 480, min 360) + separator + dock (min 360), `Group orientation="horizontal"` | rail + dock full width; "Chat" is the first tab (`tab=chat`); mini composer floats bottom-right over the dock (420 px, `right: 22px; bottom: 22px`, canvas `FullView`) when a non-Chat tab is selected |
| `lg`, `md` (900–1099) | as `xl` | as full (F4): tab strip with Chat first, sidebar per prefs | same |
| `sm` (800–899) | sidebar floats (foundation) | as full; strip overflow "{n} more" (canvas `W800`); model chip becomes an icon (kit) | same |

- Chat width in split: default **480** (canvas `SessionReview`/`SessionFailed`/`SessionFiles`/`SessionBrowser`; `SplitView` shows 600 with the old sidebar-less layout at 1280). Persisted as `prefs.panes["sessions.chat"]` in **pixels from the chat `Panel`'s `onResize(size).inPixels`** (Codex r1 #17; the group's `Layout` is percentages and is never persisted), pacer 300 ms → `updatePrefs({ panes: { …panes, "sessions.chat": px } })`, clamped on read to `[360, groupWidth − minWidth(dockTree)]` (§10.4); the dock takes the rest. Restored after a window resize by passing the clamped px as the chat `Panel`'s `defaultSize` (a number, i.e. pixels) on mount; R4-T15 restores at 1100 and 1440.
- The separator is the registry `ResizableHandle` (1 px, 8 px hit area via `resizeTargetMinimumSize`); double-click resets to 480 (`Separator` default double-click resize is disabled with `disableDoubleClick` and handled by us, so the reset targets our default, not the library's).
- Leaving `xl` (window narrowed) with `view=split` keeps `view=split` in the URL; the effective layout is full; widening restores split. `effectivePinned` never writes prefs (foundation rule).

### 10.4 Docking (our own, on `react-resizable-panels` v4)

Model (`dock-store.ts`, pure reducer, persisted with `panelTabsStore`): the dock area is a **tree of at most two levels**: a root split (`horizontal`) whose children are **panes**; a pane is either a leaf `{ id, tabs: TabRef[], active: TabRef }` or a `vertical` split of two leaves. Limits (screen space at 1100–1440 px): at most **3 leaves** and at most **2 columns**; a drop that would exceed them is refused (the drop zone does not highlight).

- **Default**: one leaf holding every open tab (what the canvas draws).
- **Minimum sizes are computed from the tree** (Codex r2 #13): `minWidth(leaf) = 240`; `minWidth(horizontal split) = Σ minWidth(children) + separators × 8` (the separator's hit area); `minWidth(vertical split) = max(minWidth(children))`; likewise `minHeight` with `240`. The chat clamp in split view is `[360, groupWidth − minWidth(dockTree)]`. **Folding**: when the available width (split: `groupWidth − 360`; full view or below `xl`: the pane width) is below `minWidth(dockTree)`, or the height below `minHeight`, the dock renders **folded**: one leaf with every tab of the tree in tree order and the focused tab active; the tree itself stays in the store and is restored as soon as it fits again (no data loss, no write to prefs). A drop that would create a tree that cannot fit at the current size is refused. R4-T15 resizes an existing two-column layout 1440 → 1100 → 800 with the sidebar pinned.
- **Moving a tab** by drag: pointer drag on a tab (6 px threshold) shows a ghost (`motion/react` `drag` with `dragSnapToOrigin` for the cancel case) and drop zones over each leaf: centre (join that leaf), left/right (new column), top/bottom (new row in that column). Dropping on the **chat pane's** right edge is the same as the dock's left zone. Dropping in the strip reorders. Escape cancels.
- **Keyboard alternative** (every drag has one): a tab's context menu (and `Shift+F10`) offers "Move to a new pane on the right", "Move to a new pane below", "Move to {other pane}", "Move left/right in the strip". R4-T21 drives both paths.
- **Closing the last tab of a leaf** removes the leaf and collapses its parent split.
- **Rendering**: nested registry `ResizablePanelGroup`s (`Group` with `orientation`), each leaf a `Panel` with `minSize={240}` px, `groupResizeBehavior="preserve-pixel-size"` on the chat pane so window resizes land on the dock. Sizes persist per leaf as pixels from each leaf `Panel`'s `onResize(size).inPixels`: key `sessions.dock.<splitId>.<leafId>` for every leaf except the last of its split (which takes the remainder); split and leaf ids are stable ids from the dock reducer. Keys of leaves that no longer exist are dropped on the next write.
- **Active tab per leaf**: the focused leaf's active tab is `search.tab`; other leaves keep theirs in the store (a second URL key would make two active tabs; one focused tab in the URL is enough to restore focus).
- **Chat as a tab** (full view and below `xl`): "Chat" is the pseudo-tab `tab=chat` in the first leaf. It cannot be moved out of the first leaf, closed, or dragged. State table (R4-T15 includes reload and back/forward over each):

  | `tab` | `view=split` at `xl` | full view, or below `xl` |
  |---|---|---|
  | absent | panel closed: chat only, no strip | panel closed: chat only, no strip |
  | `chat` | normalised with `replace` to the dock's last active tab, or cleared when none is open (the chat is always visible in split) | strip shown, Chat selected, mini composer not floating (the chat is the content) |
  | a tab ref | chat + dock with that tab | strip shown, that tab selected, mini composer floating |

### 10.5 Mounting, visibility and the native surfaces

- Each open tab renders inside React `<Activity mode={visible ? "visible" : "hidden"}>` (React 19.3, foundation) so terminals keep their views and the Files tree keeps its expansion (S73). A tab is **visible** when it is the active tab of its leaf and the dock is shown.
- The Browser and Device tabs are the only native or high-cost surfaces: the browser runtime is presented only through the **window's single presentation owner** (§12.2); the device stream is started only while the Device tab is visible and stopped after 10 s hidden (§16.2).
- The dock's own `ResizeObserver` feeds the terminal fit (§11.3) and the browser bounds (§12.2) through one pacer-throttled callback per tab.

---

## 11. Terminal tab (`features/sessions/terminal/`)

### 11.1 Tabs and lifecycle

- **Open**: Add a tab › Terminal (or the workspace menu's "Open in terminal", §6.5). A new id `terminal-<ts36>-<n>`, label "Terminal {n}" (n = 1 + the count of terminals opened in this conversation), `terminal.start({ terminalId, conversationKey, conversation, generation: null, cols, rows, shell })` with the measured size (the view is mounted off-screen first to measure, §11.3). Result `created: false` means main already had it (a reload): the tab reuses the returned `state.generation`.
- **Shell**: `terminal.shell.get` → the stored shell; the split button's submenu lists `TerminalShellState` options when more than one exists; picking one starts a terminal with that shell and `terminal.shell.set({ shell })` (S86).
- **Hide vs close** (S87): making the tab non-visible calls `terminal.hide({ terminalId, conversationKey, generation })` (the PTY stays alive, main marks it hidden); closing the tab calls `terminal.hide({ …, close: true })` (kills). No confirmation (parity).
- **Exit**: the output iterator yields `exit { exitCode, signal }`: the view writes a muted line "Process exited with code {code}" and the tab closes after 2 s unless the user interacts (today it closes at once, S87; the notice is new and cancellable by focusing the tab).
- **Retired**: `retired { closed }` → the tab closes (main closed it: scope or workspace disposal); `retired { superseded }` → the tab keeps its view and re-attaches to the new key/generation named by the next `terminal.events` state (scope promotion, S92).
- **Start failure** (`success: false`): the error is written in `--destructive` into the view (S93) and a "Try again" button sits in the tab's header row.

### 11.2 Engine and options (`ghostty.ts`)

`await init()` once per document (lazy chunk; `init` loads `ghostty-vt.wasm`, `dist/index.d.ts:700`); `new Terminal({ fontSize: 13, fontFamily: TERMINAL_FONT_FAMILY, cursorBlink: true, cursorStyle: "block", scrollback: 10_000, convertEol: false, theme })` (S81). `theme` is built from tokens for both schemes (`--background`, `--foreground`, the ANSI 16 from a fixed palette checked for 4.5:1 on each background, R4-T20), re-applied on `.dark` changes. Link providers `UrlRegexProvider` and `OSC8LinkProvider`; activation opens a Browser tab (S82).

### 11.3 Views, output and resume (`terminal-registry.ts`, `output-pump.ts`)

- **Views live outside React** (S88): a module map `(conversationKey, terminalId) → { term, fit, element, generation, offset }`; the tab component only moves `element` into its container (`appendChild` in a layout effect) and back to a hidden parking node on unmount, so `<Activity>` hide, a dock move, or a split ↔ full change never re-creates the terminal.
- **Output pump** per view: `for await (const chunk of transport.client.terminal.output({ conversationKey, terminalId, generation, fromOffset: view.offset ?? undefined }, { signal }))`:
  - `snapshot { data, from, offset }`: when `from === view.offset` append `data`; else `term.reset()` then write `data` (a replacement: main's scrollback no longer holds our offset, or first attach). Then `view.offset = offset`.
  - `data { data, offset }`: `term.write(data)`; `view.offset = offset`.
  - `exit` / `retired`: §11.1; the pump ends.
  - Iterator error `RESYNC_REQUIRED` (overflow, spec 00 A.4.3): reopen with `fromOffset: view.offset` after 0 ms, then 250 ms, 1 s (three tries), else show "Lost the terminal output. Reopen" in the tab header. Any other error: same schedule.
  - The pump runs while the tab is **open**, visible or not (hidden terminals keep receiving; `write` into a hidden ghostty terminal is cheap), and aborts on close or on thread unmount beyond the chat kit's LRU (the tab's view is disposed only on close).
- **Input**: `term.onData((data) => void transport.client.terminal.write({ terminalId, conversationKey, generation, data }))` (fire-and-forget, ordered by the port; spec 00 A.1).
- **Resize**: the dock's `ResizeObserver` → pacer debounce 40 ms → `fit.proposeDimensions()`; if changed, `term.resize(cols, rows)` and `terminal.resize({ …, cols, rows })` (S90). `FitAddon.observeResize()` is **not** used (it would bypass the debounce and the hidden-tab guard).
- **Show**: on becoming visible: re-fit, then `repaint(term)`, then focus. `repaint` is a version-pinned adapter (`ghostty.ts`, `ghostty-web` pinned **exact** 0.4.0): 0.4.0 has no public `refresh`, and `resize` to the same size returns before painting (`ghostty-web.js:2439-2443`), so the adapter calls the same full render `resize` performs, through the public `renderer` property: `term.renderer?.render(wasmTerm, true, term.viewportY, term)` with `wasmTerm`/`viewportY` read through a typed accessor that throws in development when the shape differs (today's reach-in, `terminal-views.ts`). R4-T20 verifies it on **canvas pixels**: output written while the tab is hidden is present in a pixel checksum of the region after reappearance (Codex r1 #22).

### 11.4 Keys and mouse

- **Shared encoders with injected platform** (Codex r1 #13): `terminal-keys.ts` imports the old renderer's `window-chrome` (`isMacOS`, which reads `window.api`), so it cannot move unchanged. `shared/sessions/terminal-input.ts` exports `createTerminalKeyHandler({ platform: "mac" | "windows" | "linux", copy, paste, scrollToBottom })` and the mouse-mode encoder, with no renderer imports; the old files become **compatibility wrappers** that keep every existing export and signature and build the injected platform from `window-chrome`'s **boolean** exports (`isMacOS ? "mac" : isWindows ? "windows" : "linux"`, `renderer/lib/window-chrome.ts:14-15`), and renderer-next passes `toHotkeyPlatform(system.info.platform)` (foundation §7.9). Both platform paths are tested (R4-T39).
- **Dock chords reach the dock** (Codex r1 #12): ghostty's modified-key encoder stops propagation (`ghostty-web.js:954`) and the app's hotkey manager listens in the bubbling phase, so `Mod+W`, `Ctrl+Tab`, `Ctrl+Shift+Tab`, `Mod+Alt+B` and `Mod+N` would never arrive while the terminal is focused. The terminal adapter registers `term.attachCustomKeyEventHandler(ev => …)` (`index.d.ts:1631`): when `ev` matches one of the **dock chords** (the exact bindings from `features/shell/hotkeys.tsx`, matched with `@tanstack/hotkeys`' matcher and the same platform), it calls the app action directly (`dispatchAppHotkey(binding)`, a new export of the shell's hotkey module) and returns **`true`**: in 0.4.0 a truthy result means "handled" — ghostty calls `preventDefault()` and skips encoding (`ghostty-web.js:853-856`). Every key the adapter does not handle returns **`false`** so ghostty encodes it as usual. The same handler is the composition point for today's copy/paste/scroll keys (§11.4 first bullet): the adapter runs dock chords first, then the shared key handler (copy with a selection, bracketed paste, Shift+PageUp/Down), each returning `true` only for what it consumed. On Windows and Linux `Mod` is `Ctrl`, and `Ctrl+W`/`Ctrl+N` are shell keys (delete word, next history), so inside a focused terminal those two chords are **not** intercepted there; the terminal's close-tab chord is `Ctrl+Shift+W` (as in common terminal apps) and New session stays reachable from the title bar. Ordinary control sequences (`Ctrl+C`, `Ctrl+R`, `Ctrl+W` on Windows/Linux) reach the shell unchanged. Verified in the installed source (`handleKeyDown`, `ghostty-web.js:850-856`); R4-T39 still runs real key events on a focused terminal in Electron and asserts the dock action, the PTY bytes for control keys **and ordinary printable input** (letters, digits, space, IME-free punctuation reach the PTY unchanged).

### 11.5 Accessibility

The canvas renderer is not readable by screen readers. The tab exposes `role="region"` with `aria-label="Terminal {n}"`, a visually hidden live region that announces "Process exited with code {n}", and "Copy all output" in the tab's context menu (reads the scrollback text through the terminal's buffer API) so the content is reachable. Recorded as a known limitation (§21).

---

## 12. Browser tab (`features/sessions/browser/`)

### 12.1 Resources

A browser tab is `browser:<resourceId>`. Opening one: `browser.runtime.materialize({ conversationKey, resourceId, profileId?, url? })` → `BrowserRuntimeState` with `lease { conversationKey, resourceId, generation }`. The agent's browser (materialized by main for this conversation) is adopted from `browser.events { runtime-materialized }` or the dock's reconciliation (§10.2). `open-preview { url }` for this conversation opens or focuses a browser tab on that URL (S99).

### 12.2 Presentation: one owner per window (`native-presenter.ts`, Codex r1 #15)

Main presents one `WebContentsView` per window (F8), and the dock can show two Browser leaves at once (§10.4), bots show one in their panel (03 r3 §11.3), and the local-file runtime (§12.8) is a browser too. So presentation has **one owner per window**: a TanStack Store `nativePresenter` in `features/shell/native-presenter.ts`, beside the occlusion watcher it depends on (foundation §7.6), exported from the shell's `index.ts`; routes of both areas pass it to their browser surfaces (features do not import each other):

- **Candidates** register `{ surfaceId, lease, rect(), visible(), lastInteraction }` while mounted. The **owner** is the most recently interacted-with visible candidate (pointer down or focus inside its placeholder, or the tab becoming active); ties go to the focused leaf.
- The owner, while unoccluded (§12.4), is presented: `browser.runtime.present({ lease, presentationId: surfaceId, bounds, url? })`, re-sent on the dock's `ResizeObserver`/window resize (rAF-throttled, only when the rounded rect changed; S94). One `presentationId` per mounted surface (`"surface:" + crypto.randomUUID()`).
- Every **other visible** candidate shows its **captured placeholder** (`browser.runtime.capture(lease)` `dataUrl`, refreshed when it loses ownership and every 5 s while visible) with a centred "Click to use this page" overlay; clicking (or focusing and pressing Enter) makes it the owner, which presents it and captures the previous owner first.
- Owner change order: capture outgoing → `hide` outgoing → `present` incoming, serialised through one promise chain per window (Codex r2 #12): each step is `await`ed inside `try`/`catch`, and the chain always continues (a rejected capture keeps the previous capture or none; a rejected `hide` or `present` is logged and the chain moves on), so one failure never blocks later ownership changes. **Before `present`** the presenter re-checks, after every await, that the incoming candidate is still registered, still the chosen owner, its lease generation unchanged (a profile replacement re-materializes and bumps it; a closed tab unregisters), visible, and not intersected by an occluder; if any fails, the chain re-runs the owner choice instead of presenting. A capture that resolves for a lease that is gone is dropped.
- `hide` carries the owner's own `presentationId`; main ignores a hide from a presenter that no longer owns the view, so a stale hide never hides another surface.

The bounds are the renderer's CSS pixels; the renderer is itself a `WebContentsView` at the window's origin (`renderer-host.ts`), so main's `setBounds` receives the same numbers. **Unverified** under a zoom factor ≠ 1; R4-T30 checks at 1.25.

### 12.3 Closing

Closing the tab: `browser.runtime.close(lease)` (S100); the entry leaves `panelTabsStore`. Main disposes runtimes on scope disposal (session delete), so the renderer needs no cleanup beyond that.

### 12.4 Occlusion and transitions

The owner is hidden (not presented; its placeholder shows its capture) whenever any of:

- `shellStore.occlusion.rects` has a rect **intersecting** the placeholder's rect (foundation §7.6; the whole window is not blanked for a tooltip elsewhere);
- `document.activeViewTransition` is non-null (a pane or `session-view` transition snapshots the DOM, which does not include the native view);
- a tab drag is in progress (the ghost must be visible);
- the window is hidden (`document.visibilityState`).

While hidden the placeholder shows the last capture, refreshed on each hide if older than 2 s (S94), so menus and dialogs over the browser show the page behind them rather than a hole. A 5 s continuous hide while visible logs a dev warning (S98).

### 12.5 Chrome (canvas `SessionBrowser`)

Row at the top of the tab, padding `8px 8px 0`, gap 4: Back, Forward (28 px, disabled per `canGoBack/Forward`), Reload ↔ Stop while `loading` (S95); address field (32 px, radius 999, `bg-(--muted)/60`, lock or globe icon, `normalizeAddress` on Enter, select-all on focus, Escape restores the current URL, spinner while loading); "Open in Chrome" (canvas; `system.openExternal({ url })`, label "Open in browser" when Chrome is not installed, `browser.hasGoogleChrome`); ⋮ menu (S96): Profile (submenu: None + `browser.profiles.list`; picking imports, re-materializes, toasts "Using {profile}" / "Profile cleared"), Hard reload, Developer tools, Zoom out / Zoom {n}% / Zoom in / Reset (navigate actions `zoom-*`, 25–500 %), Clear site data (confirm), Open externally. Page area: margin 8, radius 8. Error overlay: "Page unavailable" + `error` + Try again (hard reload) (S97). Agent status line at the bottom when the agent drives this runtime (the latest `browser_*` tool is running for this lease's conversation): orange dot + "The agent is browsing." (canvas copy without "Take over", S102).

### 12.6 Unread

A `runtime-materialized` for a conversation whose session is not visible marks it unread (§6.7) and records the tab in that session's `panelTabsStore` so it is there on open.

### 12.7 Browser permission asks (`ask-host.tsx`, mounted once by the shell)

`browser.events` keyless (snapshot of every pending ask first, A fixes): each `permission-request` shows a registry `AlertDialog`-styled non-modal card at the top-right under the title bar ("{origin} wants to {action}"): Allow → `respond({ decision: "allow" })`, "Allow until quit" → `"session"`, "Never ask" → `"always"`, Deny → `"deny"` (S61, labels kept). One card at a time, a count "1 of {n}", the rest queued; `permission-cleared` removes a card answered elsewhere. It is an occluder (its `data-slot` is `alert-dialog-content`), so a browser tab under it hides.

---

### 12.8 Local files on the native surface (guarded; main amendment §26.4 f, Codex r1 #14)

Main's URL guard rejects `file:` (`electron-browser-runtime.ts:63-75`), so embedded PDF and HTML previews need a deliberate path, not a loosened guard:

- **`browser.runtime.materializeFile({ conversationKey, resourceId, filePath, hostRoot })`** → `BrowserRuntimeState` with a lease like any runtime. Main validates with the same containment guard as `files.readText` (`filePath` inside `hostRoot`; `hostRoot` is the session's checkout or one of the app's artifact folders; symlinks resolved first), extension ∈ {`pdf`, `html`, `htm`}, the file exists and is a regular file.
- The view uses a **dedicated non-persistent partition** (`local-preview:<uuid>`), `sandbox: true`, `contextIsolation: true`, no preload, no node; JavaScript stays enabled for HTML (parity with today's `<webview>`, whose only hardening was stripping node and preload, `main/index.ts:978-987`).
- **Locked to the file**: `will-navigate` and `setWindowOpenHandler` deny every top-level navigation except fragment changes of the same file; an `http(s)` link is handed to `system.openExternal`'s `isSafeExternalUrl` path. `session.webRequest.onBeforeRequest` allows `file:` sub-resources only inside `hostRoot`, `data:`/`blob:`, and `http(s)` sub-resources (parity: today's webview loads them).
- `present`, `hide`, `capture`, `close` and `navigate` (`reload`, `zoom-*`, `open-devtools`) work on it unchanged; `navigate { url }` is refused (`FORBIDDEN {reason: "local-file"}`).
- The tab kind is `preview:<key>` rendered by `components/file-preview` through the **same presenter** (§12.2), chrome reduced to the file name, zoom and "Open in editor".

## 13. Files tab (`features/sessions/files/`, canvas `SessionFiles`)

### 13.1 Tree

Left column 232 px (a nested `Panel`, min 180, resizable), border-right 1 px `--border`, padding 8: "Filter files" field (30 px, radius 8) then the `@pierre/trees` `FileTree` (`useFileTree(options)` → `model`, `<FileTree model header renderContextMenu/>`, `dist/react/*.d.ts`): compact density, built-in coloured icons, rows 28 px, indent 14 px (canvas), git status decorations from `gitState.gitChanges` ("M" in running colour, "A", "D", "U" per `status`; canvas), lazy children via `files.treeChildren({ checkout, directoryPath })` on expand, prefetch on folder hover (S103). Every call carries the session's `checkout = { workspaceId, sessionId }` (F5, §26.4 a): the root is the session's worktree when it has one (a header line "This session works in {worktree}"), else the workspace's primary checkout. Filter: `files.search({ checkout, query })` results as a flat list replacing the tree (debounced 150 ms, pacer). A "Made in this session" toggle filters to `useSessionArtifacts(id)` paths.

States (S106): no workspace ("Pick a folder to see its files"), loading (`Skeleton` rows), failed ("Couldn't read this folder" + Retry), empty ("This folder is empty"), git unavailable (no decorations, no error).

### 13.2 Actions

- Single click selects and shows the file on the right (`search.file`); double click or Enter opens a **preview tab** (`preview:<hash>`) so it stays open (S103).
- Inline rename (F2 / context menu; `files.rename({ checkout, fromPath, toPath })`, both paths resolved and contained in the checkout by main), drag-and-drop move inside the tree (same), drag paths out onto the composer (`text/x-code-paths`, the kit inserts `@path`) (S104).
- Context menu (S105, the tree's context-menu slot rendering a registry `ContextMenu`): Open preview, Open in editor, Reveal in Finder (`system.showItemInFolder`), Copy path, Rename, Move to Trash (`files.trash({ checkout, filePath })`, confirm for folders).
- **Open in editor** (`open-in-editor.ts`): `system.openPath({ path })` (the OS default app; `OpenFilePathResult` outcomes `opened` / `revealed` / `refused` each get a toast; "revealed" = "Shown in Finder: opening it would run it"). No in-app editing (PLAN).

### 13.3 Viewer and preview tabs (`components/file-preview/`)

Right side of the Files tab and every `preview:` tab: header 40 px (path mono 12 ellipsis, git status word "Modified"/"Added"/"Untracked" muted, "Open in editor" secondary 28 px, canvas), then by type:

- **Code / text**: `files.readText({ filePath, hostRoot, maxBytes: 1_000_000 })` → line-numbered view (gutter 24 px right-aligned muted, 14 px gap, mono 12/20, canvas) highlighted with `@tanstack/highlight` by extension; a "Showing the first 1 MB" banner when `truncated` (S79). Modified files get a "Show changes" toggle that swaps in `DiffView` (§14).
- **Markdown**: the kit's `Markdown` is not importable (feature boundary); `components/file-preview` renders `@tanstack/markdown` `TextPart`-equivalent with the same highlighter (a molecule duplicate of 20 lines; the kit keeps its own). **Unverified** that `@tanstack/markdown`'s React renderer can be used outside `TextPart` without the kit's wrappers; R4-T24 decides.
- **Images**: `files.readImageAsDataUrl`, fit to width, click for 1:1; failure → "Can't show this image" + Open in editor.
- **Decks (`.pptx`)**: `files.readPptx` → the ported `PptxDeck` (copied from `components/browser/pptx-viewer.tsx` into `components/file-preview/pptx-deck.tsx`; the old file stays, §26.9).
- **PDF, HTML**: the guarded local-file runtime (§12.8) on the native surface, inside the preview (or the Files viewer) through the window's presenter; a refused file (`FORBIDDEN`, outside the checkout) shows "This file can't be shown here" + Open in editor.
- **Binary / too large**: "This file can't be shown here" + Open in editor.

`hostRoot` = the session's checkout root, or the artifact folder for artifact previews (main's read guard, `shared/contract/files.ts:24-27`).

### 13.4 Agent-requested previews (`preview-bridge.tsx`, shell-mounted; parity S111, Codex r1 #9)

Port of today's shell-level bridge (`renderer/utils/preview-utils.ts:125`, `use-workspace-refresh.ts:31-80`), mounted once through the shell's `globals` so it works whichever area is on screen:

- Consumes keyless `files.events { preview-open, path, conversationKey? }` (from `present_deliverable`) and `browser.events { open-preview, url?, conversationKey? }`; `conversationKey` is **optional** in both contracts (`shared/contract/files.ts:15`, `browser.ts:96`).
- **Target conversation** (Codex r2 #14): `conversationKey` when present; when absent, the **active conversation** as today (`preview-utils.ts:125` falls back to it): the conversation the current route shows (a session route → its session key; a bot route → the bot's session key; the start page → its draft key). **Dispatch**: bot-owned targets go to the bots area's consumer through the shell's `previewConsumers` registry (`features/shell/preview-consumers.ts`: each area registers `{ owns(key): boolean; open(event): void }`; bots register theirs, 03 r3 §11.3), everything else is handled here. A keyless event while no conversation is on screen (Settings, Library) goes to the last active conversation in `shellStore.lastLocationByArea`, else is dropped (today's behaviour with no active conversation).
- **Supported** targets: URLs (a `browser:` tab on that URL), and files with an in-app viewer (`hasInAppViewer`: code/text, markdown, image, pptx, pdf, html → a `preview:` tab). Unsupported types do nothing (today they are ignored; they remain available from the Files tab and Artifacts).
- **Visible session** (its route is current and the window focused): record the tab in `panelTabsStore`, set `tab` to it with `replace: true`.
- **Background session**: record the tab in that session's `panelTabsStore` (so it is there on open), and mark the session unread (§6.7); no navigation.
- A duplicate event for a tab already open focuses it (visible) or does nothing (background). R4-T36 covers URLs, files, unsupported types, background conversations and duplicates.

---

## 14. Changes tab and git state (`features/sessions/changes/`, canvas `SessionReview`)

### 14.1 Layout

Singleton tab `changes`, badge = changed file count. Left column 232 px: "Changed files" (12 muted), rows 48 px (radius 8; name 13 ellipsis over mono 11 "+a −d"; active `bg-muted`), grouped by section when `gitChangeSections` exists (Staged / Changes / Merged; else one list). **Scope is part of the selection** (Codex r2 #6): a row is `(path, scope)`, Staged rows carry `scope: "staged"`, Changes rows `"unstaged"`; a file with both a staged and an unstaged change appears once in each section and each row shows its own diff (the **merged view** is not a diff mode: "Merged" lists paths git reports under `merged`, each opened with its unstaged scope). Selecting sets `?file=<path>&scope=<scope>`; reload restores exactly that row; "Open full diff" carries `scope` into `DiffSearch`. Right: header 44 px ("Change {i} of {n}" muted; buttons Undo (ghost, §14.4) and Keep (secondary)), then `DiffView` (mono 12/20; context lines muted; deletions `--chat-diff-del-bg/-fg`, additions `--chat-diff-add-bg/-fg`, the kit's tokens; line numbers; hunk separators). `j`/`k` or ↓/↑ with Alt move between changes; `n`/`p` between files (element-level handlers while the diff has focus). "Open full diff" (header menu) → `/sessions/$id/diff?path=` (§5.4). Empty: "No changes" + the tray's branch.

### 14.2 Branch picker (tray; parity S57)

Popover (`Command`), 320 px: search, branches from `git.branches(ctx)` (current checked), "Create branch {query}" when no exact match; while the thread is busy the list is disabled with "Stop the agent first" (parity copy mapped). Switch → `git.switchBranch({ branchName, context: { workspaceId, sessionId } })`, toast "Switched to {branch}" / "Couldn't switch: {detail}"; create → `git.createBranch(...)`, toast "Created and switched to {branch}" / "Couldn't create the branch". Invalidates branches, currentBranch, prInfo; `gitState` arrives by batch.

### 14.3 PR item (tray; parity S58)

`git.prInfo(ctx)`: null → "No PR yet" (muted); else an 8 px dot (CI: passing done colour, failing destructive, pending running) + "PR {n}, checks {passing|failing|running}" (canvas "PR 112, checks passing"). Hover card (registry `HoverCard`, 320 px): title, review state, +/−, the check list, approvals/changes requested/review requested counts, "Open" → `system.openExternal({ url })`. Polling per §6.1.

### 14.4 Keep and Undo

- **Keep** (per `(path, scope)` row, and "Keep all" in the header when more than one): marks the row reviewed in `reviewStore` (TanStack Store keyed by session id, `sessionStorage`), moves to the next unreviewed row; reviewed rows render with a check and 60% opacity. The mark stores the row's **change fingerprint** (§26.4 b: for `staged`, the HEAD commit id + the index entry's blob id; for `unstaged`, the index entry's blob id + a hash of the worktree bytes; a deleted side hashes as "absent"), so an index-only change, a new HEAD (commit, rebase, checkout) or a same-stat worktree edit each produce a new fingerprint and clear the mark (Codex r1 #21, r2 #5).
- **Undo** (per file, "Undo all") appears only when the contract has `git.discard` (§26.4 c): AlertDialog "Undo changes to {file}?" / "This puts the file back as it was in the last commit. Files that did not exist there are moved to the Trash." → `git.discard({ checkout, entries })` for tracked changes, including staged additions and renames (main keeps new files' contents by moving them to the Trash **before** removing their index entries, §26.4 c; Codex r2 #7), and `files.trash({ checkout, filePath })` for untracked files (`status` `??`); failures toast with the detail and leave the list as git reports it.
- **Per change** Undo/Keep (canvas "Change 1 of 3 · Undo · Keep") is deferred (F6): the header shows file-level buttons and the change counter only.

### 14.5 Diff source (`diff-source.ts`)

`git.diff({ checkout, filePath, scope })` with the row's scope; query key `[checkoutKey, path, scope, fingerprint]`. Main answers `{ kind: "patch" | "untracked" | "binary" | "none", patch? }` (§26.4 h; today's empty-diff fallback diffs a tracked file against nothing, `git-service.ts:683`, which shows a staged-only change requested as `unstaged` as all-added). The renderer draws **all-added only for `kind: "untracked"`**, confirmed by main (and consistent with the row's `status` `??`); `none` renders "No changes in this section"; `binary` shows "Binary file changed"; `patch` is parsed by `diff`'s `parsePatch` (8.0.4) into hunks for `DiffView`. The full-diff dialog adds a split mode (two columns aligned by hunk). Tool-sourced diffs (`source=tool`, Codex r1 #18) are resolved, not passed: the kit exports `resolveToolDiff(threadId, toolKey): Promise<{ state: "ready"; filePath; original; final } | { state: "unavailable"; reason: "not-in-history" | "no-diff" }>` (§26.2), where `toolKey` is the kit's stable `(subagentRunId ?? "", toolCallId)` key. It reads the hydrated thread (`session.load()`, done by the diff route's loader), and when the call is not in the loaded window it pages older history (`hydrate({ before })`, at most 10 pages) until found. `original`/`final` come from the normalised tool (`NormalizedTool.diff`, 02 §5.4a: live `display` or migrated `file_mutation` data). `unavailable` renders "This change is no longer in the loaded history" with "Show the current git diff instead" (switches `source=git`). The diff is computed with `diff`'s `structuredPatch`. After a masked-route reload the same resolution runs, so a tool diff survives reload (R4-T37).

---

## 15. Agents tab (`features/sessions/agents/`, canvas `SubAgents`)

### 15.1 List

Singleton tab `agents`, badge = number of sub-agents in the thread (running first). Rows as the kit's `SubagentCard` rows (52 px, dot, name = description ?? kind label, sub-line), plus a leading "Main agent" row (the parent run's status, S108). Data: the chat kit's thread store, read through the route-provided `renderSubagent`/`subagentList(threadId)` accessors (features cannot import the kit; §26.2 exports `useSubagents(threadId)` from `features/chat/index.ts` and the route passes the result down).

### 15.2 Detail (`?agent=<subagentRunId>`)

Header 52 px: "All agents" back button (clears `agent`), name (500), kind ("Delegate", "Browser", "Component"), Stop (only while running; `runtime.cancel(threadId)`, tooltip "Stops the whole reply", 02 §5.5). Body: the task description in a card (radius 12, `bg-card`, 13/18) then the child's parts rendered by the kit's `SubagentDetail` (§26.2), which reuses the kit's widget context (ToolLines, final text). The kit's inline card "Open" navigates here (02 §5.5 `onOpenSubagent`).

### 15.3 "Continue" (canvas)

A sub-agent that ended with `SUBAGENT_ERROR` whose message is the limit text shows "Continue": it prefills the composer with "Continue the {name} task where it stopped." and focuses it (no send; F18). A dedicated resume procedure is out of scope.

---

## 16. Device tab (`features/sessions/device/`)

### 16.1 Controls (parity S109)

Singleton `device`, offered only when `devices.status.enabled` (S71). Header row: platform segmented control (iOS / Android), device `Select` (`devices.list`, polled every 10 s while visible), Boot, Build & Run (phases from `devices.events { build-state }`: "Building", "Installing", "Launching", error text), Open native, Refresh (`devices.refresh`). Banners: screen-recording and accessibility permission ("Grant access" → `system.openPrivacyPane`), toolchain missing (setup guide with the download links, Recheck), Maestro missing (Install → `devices.installMaestro`, toasts), Create device (`devices.create`). Mode badge "Live" / "Snapshots". Android Back / Home / Recents and iOS Home buttons → `devices.interact({ action: "press_key", key })`.

### 16.2 Screen stream (`screen-stream.ts`, F9)

While the tab is visible: `devices.stream.start({ deviceId, platform })` → `{ streamId }`, then `for await (chunk of devices.stream.chunks({ streamId }))`:

- `format === "mjpeg"` → `createImageBitmap(new Blob([chunk.data], { type: "image/jpeg" }))` → canvas.
- H.264: on `isKey`, parse SPS for `avc1.PPCCLL`, (re)configure a WebCodecs `VideoDecoder` `{ codec, optimizeForLatency: true }` when the codec string changed or none is configured; decode `EncodedVideoChunk({ type: isKey ? "key" : "delta", timestamp, data })`; drop deltas while `decodeQueueSize > 8`; draw frames to the canvas and `close()` them.
- No frame within 5 s, or no `VideoDecoder`, → snapshot mode: `devices.screenshot` every 1.5 s (S110).
- **iOS fallback chain (parity S110, Codex r1 #16):** native MJPEG stream → **Simulator-window capture** → snapshots. Window capture, ported from `device-panel.tsx:320-420`: `devices.boot({ platform: "ios", deviceId })` (ensures a capturable Simulator window), one `devices.screenshot` to learn the device aspect ratio, then `devices.simulatorWindowSource({ deviceName })` → `navigator.mediaDevices.getUserMedia({ video: { mandatory: { chromeMediaSource: "desktop", chromeMediaSourceId } } })` with up to 3 retries 800 ms apart (the window can appear late); a `<video muted playsInline>` drawn to the canvas each frame with today's **bottom-anchored crop** (`contentH = min(vh, round(vw / aspect))`, source y = `vh − contentH`; unknown aspect → the full frame). A screen-recording refusal (`ScreenPermissionError`) shows the permission banner ("Grant access" → `system.openPrivacyPane({ pane: "screen-recording" })`) and falls to snapshots; any failure latches per device key so it does not retry-loop. **Track cleanup**: every exit path (cancel, hide for 10 s, tab close, device change, error) calls `stream.getTracks().forEach((t) => t.stop())` and cancels the rAF. The mode badge reads "Live", "Window" or "Snapshots".
- Iterator `RESYNC_REQUIRED` → reopen the chunks iterator on the same `streamId` (main replays the current group of pictures, A fixes, so the first chunk is a key frame).
- Hidden for 10 s or tab closed → `devices.stream.stop({ streamId })` and decoder `close()`.

The decoder class is ported verbatim from `device-screen-stream.ts` with its tests, over the new iterator.

### 16.3 Input (`device-input.ts`)

Pointer down/move/up on the canvas → `devices.stream.touch({ platform, deviceId, phase, x, y, deviceWidth, deviceHeight })` (fire-and-forget, coordinates in device pixels); keys while the canvas has focus → `devices.stream.key({ …, code, key, shift, ctrl, alt, meta })`, modifiers alone ignored, `Mod` combos not prevented (parity). The canvas is focusable (`tabIndex=0`, `aria-label="{device} screen"`).

---

## 17. Sandbox, network, missing workspace, read-only

### 17.1 Sandbox and network asks (F13)

Rendered by the kit's permission tray (02 §6.2, §6.4 `sandbox_denied`, `network_host`). This phase adds: the tray's right item reads "Sandboxed" (running colour) while the session's exec target is the sandbox (canvas `SessionFailed`); and a `sandbox_denied` card whose command ran in a terminal the dock shows gets an "Open in Terminal" text button (route-provided card action through the kit's `permissionActions` slot, §26.2).

### 17.2 Workspace or worktree missing (canvas `SessionWorkspaceMissing`)

The thread reads `git.checkoutStatus({ checkout })` (§26.4 i; Codex r2 #8), so a session in a sibling worktree is checked at its **worktree** path, not the workspace's.

**Worktree missing, workspace intact** (`kind: "worktree"`, `exists: false`, `workspaceExists: true`): the block reads "This session's worktree is gone", the worktree path, "The workspace folder is still there.", with **Use the main checkout** (detach: `git.worktrees.setForSession({ worktreeId: null })`, then the session runs in the primary checkout; confirm first: "Changes that were only in the worktree are not recovered.") and **Delete session** (§6.4). Relocate is never offered here: it would repoint the workspace, not the worktree. Send is blocked with "Can't send: the worktree {path} no longer exists."

**Workspace missing** (`workspaceExists: false`, or `workspaces.checkPath` false on the start page, or any call returned `PRECONDITION_FAILED {workspace-missing}` / `NOT_FOUND {workspace}`): the thread pane shows, above the transcript's place, a centred block: 56 px tile (radius 18, destructive tint, `FolderX`), "Folder not found" (18/600), the path (mono 12 muted), "no longer exists. Point this workspace at another folder, or delete it. Your chats stay in Sessions and can be moved to another workspace." — the last clause is canvas copy for a feature we do not build (F7), so it reads "…or remove it. Your chats stay readable in Sessions." — and "Choose folder" (primary → relocate, §6.5) and "Remove workspace" (destructive text → §6.5). The composer is replaced by a 48 px line "Can't send: {path} no longer exists." (canvas). The transcript stays readable below (scrolling past the block). The start page shows the same block when the resolved workspace is missing. The old dialog's per-workspace dismissal is retired (S63).

### 17.3 Read-only sessions

| Case | Banner (kit `composer.readOnly`) | Action |
|---|---|---|
| Workspace removed (`status: "deleted"`) | "The folder for this session was not found, so it is read-only." (canvas `ReadOnlyStates`) | "Choose folder" (relocate, which also restores the workspace; **unverified** that `relocate` clears the tombstone; §26.4 asks) |
| Routine run (`routineId != null`, F14) | "This is a report from {routine}, not a conversation." | "Talk to the routine" → `/routines/$routineId` (phase 5 route) |
| Bot-owned session reached by URL (`botOwned`) | redirect to the bot route that owns it (`/bots/$botId` or its sender chat, 03 §5.1) | — |
| Editor turn (`editorFor != null`) | `notFound()` (never user-facing) | — |

---

## 18. Motion

All values from `lib/motion.ts` through `motionFor(pref, full, reduced)`; reduced motion turns layout animations into cuts and everything else into a 120 ms fade. Every `<ViewTransition>` prop is a type map with `default: "none"` (foundation §6.7).

### 18.1 Owners

| Moment | Owner | Spec |
|---|---|---|
| Rail/session switch, new → thread | foundation pane VT (`nav-lateral`, `nav-forward`) | unchanged; the thread commits after `session.load()` (02 §9.2) |
| Tab strip appears / disappears (first tab opened, last closed) | `motion/react` `AnimatePresence` on the strip | opacity + `x: 8 → 0`, 160 ms; out 120 ms |
| Dock opens beside the chat (split) / closes | `motion` `layout` on the chat pane's width + presence on the dock | spring `springs.panel` (500/40); the chat content does not reflow mid-spring (it is laid out at its final width and clipped, as the foundation's floating sidebar rule) |
| Split ↔ full | React `<ViewTransition>` inside the pane with type `session-view` added by the dock's own `startTransition` (not a navigation; `view` changes with `replace: true` and `transition: "none"` for the router) | 240 ms: the chat pane shrinks into the "Chat" tab slot (shared name `session-chat-{id}` on the chat pane and on the Chat tab), the dock grows; native browser hidden for the duration (§12.4) |
| Mini composer ↔ two-row box with tray (full view) | kit `layoutId="composer:{threadId}"` (02 §9.1) | 240 ms, tray fades 120 ms after |
| Start-page composer → thread composer | none (different pages; the pane VT covers it) | — |
| Tab reorder / move between leaves | `motion` `layout` on tabs + drag ghost | spring `springs.panel`; drop cancel returns with `dragSnapToOrigin` |
| Sidebar rows reorder (pin, activity), group expand/collapse | `motion` `layout` on rows; registry `Collapsible` for groups | `springs.sidebar`; reduced → cut |
| Status chips appear | CSS `@starting-style` scale 0.6 → 1 + opacity, 160 ms | none when reduced |
| ChangesCard enters (run ends with changes) | CSS `@starting-style` `translateY(4px)` + opacity, 160 ms | — |

### 18.2 The `session-view` transition

`NavType` gains nothing; `lib/motion.ts` gains `DockTransitionType = "session-view"`, and `tokens.css` a rule set keyed on `:active-view-transition-type(session-view)` for the two shared names. The dock calls `startTransition(() => { addTransitionType("session-view"); navigate({ search: { view }, replace: true }) })` — **unverified** that a router navigation started inside the caller's `startTransition` commits in that transition given the foundation's seam (foundation F7: the router commits in its own `startTransition`; a type added by the caller is lost). Therefore the dock does **not** rely on the navigation: it flips a local `viewPending` state inside its own `startTransition` + `addTransitionType("session-view")` (the layout reads `viewPending ?? search.view`), then writes the URL with `replace` outside the transition; the URL write causes no second visual change. R4-T26 (Electron) observes exactly one view transition with the `session-view` type and no pane transition.

### 18.3 Reduced motion

No `layoutId` travel, no springs (cuts), `session-view` becomes the 120 ms fade (foundation CSS), drag ghost has no snap-back animation. R4-T27.

---

## 19. Sound and notifications

### 19.1 Cues (`features/sessions/sound/session-cues.ts`, synthesis from `lib/sound.ts`, 03 §17)

| Cue | Sessions trigger |
|---|---|
| `sent` | a session admission acked `started`/`queued` |
| `needs-you` | a listed session enters `waiting_permission` |
| `done` | a listed session's run finishes `success` while its thread is not visible |
| `failed` | a listed session's run ends in `RUN_ERROR` (not `cancelled`) while not visible |

Gating is the foundation's (never while the causing thread is visible and the window focused; bursts coalesce). `needs-you` comes from the shared `turnTransitions` watcher (§6.7) and from a new pending connector ask for a listed session (§6.6). **`done` and `failed` come only from `ai.runFinished`** (03 r3 §24.11; Codex r1 #19, r2 #2): `turn.phase` going to `idle` cannot distinguish success from Stop (`session-turn-state-service.ts:99` sets `idle` on Stop), and compat `turn_complete` also fires between tool rounds; the relay's terminal is exactly one per run id, including crashes and inactivity timeouts (`outcome: "error"`, `errorCode`). `outcome: "cancelled"` plays nothing; duplicate delivery of one `runId` plays once (a per-document `Set` of run ids, bounded to 500). The same notice drives unread (§6.7: success or error only) and §19.2's notifications.

### 19.2 OS notifications (`notify.ts`, parity S60)

When the window is not focused: "Permission required" / "{label} needs your answer" on `needs-you`, "Task completed" / "{label} is done" on `done` (the notice's `outcome: "success"`, never on cancellation), via `system.notify({ title, body, metadata: { kind: "session", sessionId } })`. `system.events { notification-clicked }` with that metadata navigates to `/sessions/$sessionId` (focusing the window is main's side of the click). Respect `settings.notifications.get` (the existing switches) until phase 5's Notifications page owns them.

---

## 20. i18n

New keys under `sessions.*` (sub-objects `sidebar`, `start`, `tray`, `thread`, `dock`, `terminal`, `browser`, `files`, `changes`, `agents`, `device`, `missing`, `readOnly`, `errors`, `notify`). Reused strings are mapped through `scripts/locale-keymap.json` (03 §18 pattern) so all 11 locales arrive translated:

| New key | Old key |
|---|---|
| `sessions.sidebar.title` / `.new` / `.pin` / `.unpin` / `.pinned` / `.delete` / `.emptyTitle` | `workspace.sessions.title` / `newSession` / `pin` / `unpin` / `pinned` / `deleteSession` / `emptyTitle` (exact old leaf names confirmed by R4-T22 against `en-US.json`; any missing source fails the keymap check rather than silently shipping English) |
| `sessions.delete.title` / `.body` / `.error` | the `delete-session-dialog` strings (S18) |
| `sessions.start.starters.<id>.{name,detail,prompt}` | `workspace.starters.<id>.*` |
| `sessions.tray.workspace.*` (default, add, noResults, search) | `ProjectSwitcher` strings (S28) |
| `sessions.tray.branch.*`, `sessions.tray.pr.*` | branch picker and PR pill strings (S57, S58) |
| `sessions.dock.add.*` (browser, terminal, files, agents, device + descriptions) | `workspace.rightPanel.*`, `workspace.rightTab.*` |
| `sessions.terminal.*`, `sessions.browser.*` | terminal panel and browser surface strings |
| `sessions.files.*` | explorer panel strings |
| `sessions.agents.*` | `workspace.agents.*` |
| `sessions.device.*` | device panel strings |
| `sessions.missing.*`, `sessions.readOnly.*` | `WorkspaceMissingDialog`, deleted-workspace and routine-run banner strings |

- Canvas copy that is new (the start heading, tray items, the Changes tab, the missing-folder block's revised sentence, the "The agent is browsing." line) gets new keys with English values; translators receive them through the normal flow.
- Model-facing text is not i18n: starter **prompts** stay as today's values (they are sent to the model; the keymap copies them, R4-T22 checks byte equality in `en-US`), the sub-agent "Continue" prefill is a user message (i18n, it is the user's words).
- Estimated ~160 new keys, ~90 mapped. R4-T22: every `t()` key under `features/sessions` exists in `en-US.json`; keymap sources exist; no collisions.

---

## 21. Accessibility

- **Sidebar**: `<nav aria-label="Sessions">`; workspace groups are `NavList.Group` with the collapsible trigger as a button (`aria-expanded`, `aria-controls`); rows are links with composed names ("Audit the front end, needs you"); status never by colour alone (chip text or visually hidden text); drop zone has a keyboard equivalent ("Add a folder").
- **Start page**: heading is an `<h1>`; tray items are buttons with `aria-haspopup="dialog"` and names that include the value ("Workspace: abacusai-bot"); starter cards are buttons.
- **Tab strip**: registry `Tabs` semantics; each tab's close button is a separate button (`aria-label="Close {title}"`), not nested in the tab's interactive element (the tab is the `TabsTrigger`, the × sits beside it inside the same visual pill); count badges are included in the accessible name ("Changes, 2 files"); overflow menu reachable by keyboard; drag has the keyboard menu alternative (§10.4).
- **Terminal**: §11.5 (known limitation: canvas rendering). **Browser**: the native view is outside the accessibility tree of the renderer; the placeholder has `role="region"` `aria-label="Browser: {title}"`, focusing it sends `navigate { action: "focus" }` so keyboard focus moves into the page; Escape from the address field returns focus to the tab.
- **Files**: `@pierre/trees` renders a `tree` role with `treeitem`s (**unverified** for beta.6's shadow DOM; R4-T23 runs axe over it; fallback: `aria-label` on the host and a flat searchable list); the viewer's code is a `<pre>` with line numbers `aria-hidden`.
- **Changes**: diff lines expose "added"/"removed" as visually hidden text at hunk starts, not colour only; buttons named with the file ("Undo changes to workspace-view.tsx").
- **Device**: the canvas is focusable with a name; buttons named.
- **Contrast**: running/attention/done/destructive text tokens (02) in both themes; diff backgrounds with their foregrounds ≥ 4.5:1 (computed, R4-T20); terminal ANSI palette ≥ 4.5:1 on its background for the 8 foreground colours used by default prompts (computed).
- **Motion**: §18.3. **Keyboard**: `Mod+N` new session (foundation), `Mod+W`, `Ctrl+Tab`, `Mod+Alt+B`; Escape closes search, menus, the diff dialog (history back), the address field edit, and never discards a dirty rename without Enter/blur semantics (blur saves, Escape cancels; parity with the dead tree's dialog replaced by inline edit).
- R4-T23 runs axe over every gallery section and the real routes (contrast on in the screenshot run).

---

## 22. Gallery (`/__ui`)

`sessionsGallerySections` (the `[__ui].tsx` route passes them, 02 §14.8 pattern):

| Section | Content | Canvas boards |
|---|---|---|
| `sessions-sidebar` | groups (expanded, collapsed, missing, removed), rows in every §7.3 state, pinned, search with highlights and no results, empty with drop zone, loading, error; row and workspace menus (`open=sessions-row-menu`, `open=workspace-row-menu`) | SessionsSidebar, SessionsSidebarStates |
| `sessions-start` | start page with sidebar pinned and collapsed (recent + starters), each tray popover open (`open=workspace-picker`, `branch-picker`, `worktree-picker`, `exec-target`), missing workspace, no model | Main, MainCollapsed, ComposerStates (session column), Pickers |
| `sessions-thread` | the kit's session scenarios (02 §11.2) with this phase's identity, tray (branch, PR states, tasks, sandboxed), ChangesCard, read-only banners, start-failure banner | SessionRunning, SessionFailed, ReadOnlyStates |
| `sessions-dock` | no tab; split with each tab kind; full view with mini composer idle and focused; `W900` fold; `W800` overflow; two leaves (column split) and a vertical split; drag ghost over each drop zone | SplitView, FullView, FullViewFocused, W900, W800 |
| `sessions-terminal` | a terminal fed by a fixture output stream (snapshot append vs replace, exit notice, retired, start failure) | SessionFailed (terminal tab) |
| `sessions-browser` | the chrome over a placeholder (no native view in the gallery: a static screenshot image), loading, error overlay, agent-browsing line, menu open, ask card | SessionBrowser |
| `sessions-files` | tree with git marks, filter results, viewer (code, markdown, image, deck, binary, truncated), context menu | SessionFiles |
| `sessions-changes` | file list, diff with hunks, reviewed marks, Undo gated on/off, full-diff dialog unified and split | SessionReview |
| `sessions-agents` | list and detail with three statuses, Continue | SubAgents |
| `sessions-device` | controls in each state, live canvas fed by a recorded MJPEG fixture, snapshot mode, permission banners | — (no board; parity layout) |
| `sessions-missing` | folder-not-found block and send-blocked line | SessionWorkspaceMissing |

Data comes from fake `AppClient` slices plus real collections over the foundation's fake tables. The screenshot script (foundation §10.2) gains `/sessions/new`, `/sessions/<first>`, `?tab=changes`, `?tab=files&file=<path>`, `?tab=terminal:<id>`, `?tab=browser:<id>` (static page), `?tab=agents&agent=<id>`, `?view=full&tab=browser:<id>`, `/sessions/<first>/diff?path=<p>`, and the fixtures home gains the canvas sessions, three workspaces (one missing, one removed), a git repo fixture with two changed files (a real `git init` in the scratch home), and recorded terminal/device streams.

---
## 23. Tests

Projects: **jsdom** = vitest `renderer-next`; **main** = vitest `main`; **Electron** = `main-serial` with the A-T12 harness (isolated profile + CDP; foundation R1-T11b); **type** = `tsc -b` + `expectTypeOf`. "Fake tables" = the foundation's `fake-table.ts` under the real `createCollection` + `ipcCollectionOptions` (never a mocked collection). "Memory transport" = spec 00's `createMemoryTransport` over the real router with fake services.

| Id | File | Runs in | What it proves |
|---|---|---|---|
| R4-T1 | `routes/sessions.routes.test.ts` | jsdom | Route-tree snapshot for §5.1 (ids, fullPaths); `/sessions/$id/review` redirects to `?tab=changes` with `replace`; `/sessions/$id/diff` is masked to `/sessions/$id` minus the diff keys, survives a simulated reload, closes with `history.back()` (and by navigating to the mask target with no history); opening/closing it keeps the thread's instance, scroll, composer draft and dock; every `PANE_BOUNDARIES` key is a generated id; `/sessions/` goes to the last session or `/sessions/new`. |
| R4-T2 | `lib/navigation/nav-type.sessions.test.ts` | jsdom | new → thread `nav-forward` (explicit and inferred), thread → thread `nav-lateral`, `tab`/`view`/`agent`/`file` changes none, diff open/close none. |
| R4-T3 | `routes/sessions.$sessionId.loader.test.ts` | jsdom (memory transport) | **Cold direct navigation** to `/sessions/<id>`, `/sessions/`, `/sessions/new` and `/sessions/<id>/diff` with the `sessions`/`workspaces` snapshots delayed 500 ms renders the pending UI, then the session (never `notFound`); hover preload calls neither `ai.hydrate`, `agent.start`, `ensureSessionHome` nor any file/git procedure; no route ever calls `workspaces.switch`; a `cause: "stay"` re-run calls nothing; `session.load()` rejection renders the error component and Retry calls it again. |
| R4-T4 | `routes/sessions.gone.test.tsx` | jsdom | `notFound` for an unknown id **after** a delayed snapshot resolves (not before); a row deleted by a change batch while open renders `SessionGone` without an error boundary; deleting from this window navigates first; a bot-owned session URL redirects to its bot route; an editor turn is `notFound`. |
| R4-T5 | `features/sessions/data/invalidation.test.ts` | jsdom | For each §6.1 query row, emitting only that source refetches exactly its queries (`files.events` → tree, `gitState` batch → tree root + branches + PR + worktrees + that path's diff, `settings.events` → exec target, prompt history after `add`); PR polls at 60 s and refetches on focus while other queries do not. |
| R4-T6 | `features/sessions/data/queries.test.ts` | jsdom (fake tables) | Listed-sessions filter (bot-owned, routine runs, editor turns excluded) in whichever form ships; pickable workspaces exclude `routine`/`bot`/deleted; `useGitState(checkout)` selects by `checkoutKey`: a primary checkout and two worktrees of one workspace are three rows, and the sidebar chips and Files decorations of three sessions each read their own row; updates flow without remount. |
| R4-T7 | `features/sessions/data/actions.test.ts` | jsdom (fake tables + fake procedures) | Every §6.4 and §6.5 row through the real collections: create sends `{ id, workspaceId, model, mode }` (optimistic row, echo, `CONFLICT` for the same draft id treated as already created, `NOT_FOUND {workspace}`, `workspace-missing`, unknown model), rename (trim echo, empty prevented, `NOT_FOUND`), pin through the **real `updatePrefs(patch)` helper** (echo, and rollback on a rejected patch), model (setModel only when running, `setDefaultModel`, `model-unavailable` toast keeps the row), delete (navigate first, `agent.stop` then delete, idempotent `NOT_FOUND`, error keeps the dialog); workspace add (existing path returns its id), drop a file vs a folder, relocate, the **two-stage** remove (no flicker in the DOM trace), erase. |
| R4-T8 | `features/sessions/data/agent-start.test.ts` | jsdom (fake timers, fake procedures) | The lifecycle controller: start on mount (not on preload) without model/mode overrides; retries 0.5/1/2/4/8 s cap, 5 attempts per trigger; `workspace-missing` stops at once; the final failure renders the banner and Retry starts a new generation; a **crash while mounted** (row → `error`) restarts without unmount; a **second incarnation** in the same document runs `switchConversation` again, once per incarnation; stale retries of an older generation are cancelled when a newer start succeeds; a joined start resolves on readiness, not at once; a user-initiated stop suppresses the restart. |
| R4-T9 | `features/sessions/data/attention.test.ts` + `unread.test.ts` | jsdom (fake tables + fake iterator) | `sessionAttention` precedence table incl. pending connector asks (§6.6); unread from `ai.runFinished` `success`/`error` for a hidden session, **not** for `cancelled`, not for the visible focused thread, including a run that completes within one feed interval (no busy row ever published); a duplicate notice of one run id counts once; unread on `runtime-materialized` and on a background preview (§13.4); cleared on open; "Mark as unread". |
| R4-T10 | `features/sessions/sidebar/sessions-sidebar.test.tsx` | jsdom (fake tables) | Pinned then workspace groups by recency, counts, expanded state from prefs, missing and removed groups, `auto` as "Default workspace", row states and chips (§7.3, diff chip only when its conditions hold), search (accents, highlight as `<mark>` with bold, sub-line, no results), empty with drop zone, loading/error, rows do not remount; menus render the same items from right-click and ⋯; the canvas-only items are absent. |
| R4-T11 | `guards.sessions.test.ts` (extends R1-T15) | jsdom | AST scan of `features/sessions`: no `.message.includes(`/`.message ===` on errors; no import of another feature (the kit arrives by props); `components/{file-preview,diff-view,tab-strip}` import no `data/` or feature; no `monaco`, `@xterm/*`, `@danfessler/trellis`, no `<webview>` JSX. |
| R4-T12 | `features/sessions/start/start-page.test.tsx` | jsdom (memory transport) | Workspace resolution order (search → last picked → auto → `ensureSessionHome`, the last skipped on preload); explicit pick writes `lastPickedWorkspaceId`, resolution does not; picking B while main's legacy active workspace is A makes `@` search call `files.search({ checkout: { workspaceId: B } })`; starters fill and focus without sending; collapsed-sidebar recent list; Send disabled while unresolved, missing, or "New worktree" without a branch; **stage machine**: a failed `materialize` then Retry reuses the same `operationId`; a **reload after the server attached the worktree but before the stage write** reconciles from the row and creates nothing new; "No worktree" after an attach calls the explicit detach and the row shows no worktree; each ends with one session, at most one worktree, one first message; reopening `/sessions/new` with a `created` draft offers Continue/Discard. |
| R4-T13 | `features/sessions/start/start-session.test.ts` | jsdom (memory transport + the relay fake of 02 §16) | `startSession` order: envelope stored → insert (persisted, model/mode) → worktree → both `promoteScope`s + tab store promote → `pendingSubmit` written → navigate `nav-forward`; the thread admits the envelope with its **caller-supplied** run and message ids after `load()`; a **reload after acceptance but before `pendingSubmit` is cleared** re-admits the same ids, main answers `duplicate`, the transcript has one user message and one run; a reload before admission admits once. |
| R4-T14 | `features/sessions/context/tray.test.tsx` (+ Electron case) | jsdom (+ Electron) | Tray items per state (start page vs thread, git vs not, PR null/passing/failing/pending, tasks, full view "Connectors"); the thread's workspace picker is read-only; branch picker disabled while busy with its copy; switch/create toasts; Auto hidden without sandbox support; exec target: labels from `effective`, "Sandboxed" only as a mode-derived suffix, `set` called at once (not on Send), `selected ≠ effective` shows the fallback line, menu disabled while the agent runs; Electron: a new session's first command runs in the backend chosen (`local` → host `uname`, `docker` → container hostname) and in `local` after a refused `docker`. |
| R4-T15 | `features/sessions/dock/layout.test.ts` | jsdom | `sessionLayout` table: every band × view × `tab` ∈ {absent, `chat`, ref} × pinned (boundaries 899/900, 1099/1100); `chat` in split normalises with `replace`; Close tabs vs selecting Chat; reload and back/forward; the sidebar folds only at `xl` split with a tab and never writes prefs; `minWidth`/`minHeight` of trees (one leaf, two columns, column with a vertical split); an existing two-column tree through 1440 → 1100 → 800 with the sidebar pinned folds to one leaf and restores on widening; chat width persisted from `onResize().inPixels` and clamped by the tree's minimum. |
| R4-T16 | `features/sessions/dock/panel-tabs.test.ts` | jsdom (memory transport) | Open-tab store: neighbour rule on close; reconciliation **by existence**: three terminals, two hidden (`visible: false`), survive a reload with all three tabs; a tab disappears only on runtime removal or `exit`/`retired {closed}`; an agent-opened terminal is added; `runtime-materialized` adopts the agent browser; promotion draft → session; preview cap 50; a stale `?tab=` is replaced; `sessionStorage` persistence across a store re-creation. |
| R4-T17 | `features/sessions/terminal/output-pump.test.ts` | jsdom (memory transport + a fake ghostty `Terminal`) | Snapshot append when `from === offset`, reset + write otherwise; `data` advances the offset; `RESYNC_REQUIRED` reopens with `fromOffset` = last offset and the concatenated output equals main's scrollback exactly (no gap, no duplicate); `exit` notice then close after 2 s unless focused; `retired {closed}` closes; `retired {superseded}` re-attaches to the new generation from `terminal.events`; hide on invisibility, `close: true` on tab close; resize debounced 40 ms; input forwarded unawaited in order. |
| R4-T18 | `features/shell/native-presenter.test.tsx` | jsdom (fake procedures, stubbed rects, controllable promises) | One owner per window: two Browser leaves → only the owner is presented, the other shows its capture with "Click to use this page"; clicking swaps owners in order capture → hide → present; a **rejected capture**, `hide` or `present` does not block the next ownership change; a **delayed capture followed by closing** the incoming tab, by a **profile replacement** (new lease generation), or by an **intersecting overlay** appearing results in no `present` for the stale candidate and a re-run of the owner choice; resize re-presents only the owner on a changed rounded rect; hidden during a view transition, a drag, window hidden; `normalizeAddress` cases (ported). |
| R4-T19 | `features/sessions/files/files-tab.test.tsx` | jsdom (fake procedures) | Every tree, search, rename, trash, read and diff call carries the session's `checkout`; worktree sessions root at the worktree; filter debounced; single click selects (`?file=`), double click opens a preview tab; trash confirm for folders; Open in editor outcome toasts; viewer by type incl. truncated, binary, and PDF/HTML through the local-file runtime (refusal → fallback message). |
| R4-T20 | `features/sessions/contrast.test.ts` + `terminal/ghostty.types.test.ts` + `e2e/terminal-repaint.mjs` | jsdom + type + Electron | Computed ratios: diff backgrounds with foregrounds, terminal default palette on both backgrounds, chips; the ghostty-web 0.4.0 surface used here type-checks (`init`, options, `write(Uint8Array)`, `attachCustomKeyEventHandler`, public `renderer`); Electron: output written while the tab is hidden appears in a **canvas pixel checksum** after reappearance through the `repaint` adapter (and a control run without it shows the stale checksum, proving the adapter is what paints). |
| R4-T21 | `features/sessions/dock/dock.test.tsx` | jsdom (+ Electron for pointer drag) | Reducer: move/join/split/close with the 3-leaf, 2-column limits; keyboard menu moves produce the same trees as drags; drop-zone refusal beyond limits; sizes persisted per split in px; Chat pseudo-tab cannot move; Electron: a real pointer drag of a tab onto a right zone creates a column. |
| R4-T22 | `lib/i18n/sessions.keys.test.ts` | jsdom | Every key under `features/sessions` exists; every keymap source exists; starter prompts byte-equal to today's `en-US` values. |
| R4-T23 | `features/sessions/gallery/a11y.test.tsx` | jsdom | axe over every §22 section, one overlay open at a time; tab close buttons named and not nested; the tree's roles (or the fallback); diff lines' non-colour cues; icon buttons named. |
| R4-T24 | `components/file-preview/file-preview.test.tsx` | jsdom | Markdown renders through `@tanstack/markdown` outside the kit (decides §13.3's unverified path), images, pptx deck via the ported viewer, highlight by extension, truncation. |
| R4-T25 | `features/sessions/changes/changes-tab.test.tsx` | jsdom (fake procedures) | Rows are `(path, scope)`: a **staged-only** tracked modification shows its staged diff (never all-added), a **mixed** file shows both rows with their own diffs, and `?file=&scope=` restores the exact row after reload and into the full diff; `git.diff` kinds (`untracked` → all-added, `none`, `binary`, `patch`); Keep stores the fingerprint and is cleared by an **index-only** change, a **HEAD change** and a **same-stat worktree edit**, each refetching its diff; Undo buttons absent without `git.discard`, present with it; confirm calls `git.discard({ checkout, entries })` with `origPath` for renames and `files.trash` for untracked; ChangesCard source = the last run's written paths joined to git stats. |
| R4-T26 | `e2e/sessions-view-transition.mjs` | Electron | Split ↔ full starts exactly one view transition typed `session-view` and no pane transition; the browser runtime is hidden for its duration and re-presented after; new → thread starts one `nav-forward`; tab changes start none. |
| R4-T27 | `features/sessions/motion.test.tsx` + `motion.types.test.ts` | jsdom + type | Reduced motion: no layout travel, strip and dock cut, fade durations; `motion/react` imports type-check against the pinned `motion`. |
| R4-T28 | `features/sessions/structure.test.ts` | jsdom | The folder rules of §4 (a script over imports). |
| R4-T29 | `e2e/sessions-terminal-real.mjs` | Electron (real main, real PTY) | **Live delivery is lossless**: 5 MB written into a hidden open tab arrives in full (a byte-counting tap on the view's `write` equals the PTY's output). **Same-document reconnect** (the output iterator is aborted and reopened without reload, e.g. after `RESYNC_REQUIRED`): an **append** snapshot (`from === offset`) with no gap and no duplicate. **Window reload** (the module map and offset are gone): always a **replacement** snapshot, including after quiet output, holding exactly main's retained tail (`BoundedScrollback`, 2 MB, `conversation-terminal-runtime-registry.ts:143`), and the visible buffer equals the last `scrollback: 10_000` lines of it (Codex r1 #11, r2 #15). Also: two terminals, close one → PTY gone; a new session promotes its draft terminal; exit notice; resize reaches the PTY (`stty size`). macOS and Windows (ConPTY). |
| R4-T30 | `e2e/sessions-browser-real.mjs` | Electron (real main) | Present at the placeholder rect (±1 px, zoom 1 and 1.25); a popover over it hides the native view (pixel sample shows the capture), a tooltip elsewhere does not; **two browser leaves**: only the owner paints, focus/resize/occlusion swap correctly; back/forward/reload/zoom/devtools; the agent's browser adopted; close disposes; **local-file runtime**: a PDF and an HTML file inside the checkout render, an HTML link to another file or site is denied/opened externally, a file outside the checkout is `FORBIDDEN`. |
| R4-T31 | `features/sessions/parity.test.ts` | jsdom | Every `parity.ts` row (§2) names an existing route, component or test id and has a status. |
| R4-T32 | `features/sessions/device/screen-stream.test.ts` | jsdom (fake `VideoDecoder`, fake iterator, fake `getUserMedia`) | Configure on the first key frame, reconfigure on a codec change, drop deltas above queue 8, MJPEG path, 5 s no-frame fallback, `RESYNC_REQUIRED` reopen at a key frame, stop after 10 s hidden; **iOS chain**: stream failure → window capture (boot, aspect screenshot, 3 retries, bottom-anchored crop geometry) → snapshots; permission refusal shows the banner; the failure latch prevents retry loops; every exit path stops all tracks; touch/key shapes. |
| R4-T33 | `main/rpc/procedures/checkout.test.ts` + `git.discard.test.ts` + `worktrees.materialize.test.ts` + `workspaces.relocate.test.ts` + `sessions.insert.test.ts` | main | In a temp repo with a **sibling worktree** for a session: tree/children/search/rename/trash, `git.diff`, `git.discard` and the checkout's `gitState` row operate in the worktree, and the **primary checkout is byte-identical** afterwards (hash of every file + `git status --porcelain`); a primary and two worktrees publish three rows keyed by `checkoutKey`; paths escaping the checkout are `FORBIDDEN`; fingerprints change for an index-only change, a HEAD change and a same-stat worktree edit; `git.discard` of a **staged addition** and a **staged rename** leaves the new file's content in the Trash before the index entry goes, restores the rename's source; `git.diff` kinds (a staged-only change requested `unstaged` is `none`, an untracked file is `untracked`); `materialize` repeated with one `operationId` creates one branch and path; `checkoutStatus` reports a deleted worktree with an intact primary; `db.sessions.insert` persists `model`/`mode` and `agent.start` without overrides uses them; `model-unavailable` typed; `relocate` of a tombstoned workspace restores it (or pins today's behaviour, §17.3); `browser.runtime.materializeFile` guard cases. |
| R4-T34 | `e2e/sessions-real.mjs` | Electron (real main, fake provider) | The gate run: add a folder (git repo), start a session with "New worktree" and Supervised mode, the first message streams, an edit asks and is allowed from the tray, the ChangesCard appears, Review changes opens the Changes tab with the diff, Keep marks it, a terminal runs the tests, the browser opens `localhost`, delete the session → its terminal and browser are gone; the old renderer (legacy generation) shows the same sessions and workspaces. |
| R4-T35 | `features/sessions/thread/connector-card.test.tsx` | jsdom (memory transport + the relay fake) | The 03 r3 §11.4 sequence in a session: the card renders from the `connectors.events` snapshot (also after a reopen); Connect → flow → **`mcp.refresh({ workspaceId, sessionId })` awaited before** `respond(connected)` (call order asserted) → the suspended turn resumes; a refresh failure leaves the card actionable and answers nothing; a cancelled flow and Not now answer `declined`; a request from a session in a **non-active workspace** refreshes that session; an ask cleared elsewhere disappears. |
| R4-T36 | `features/sessions/files/preview-bridge.test.tsx` | jsdom | `preview-open` and `open-preview` for the visible session open and focus the tab (`replace`); for a background session the tab is recorded and the session marked unread without navigation; **keyless** URL and file events go to the active conversation: a session route, a bot route (handed to the bots consumer through the registry), the start page draft; keyless with no conversation on screen uses the last active one; unsupported types do nothing; duplicates focus once. |
| R4-T37 | `features/sessions/changes/tool-diff.test.tsx` | jsdom (memory transport) | `resolveToolDiff` for a live edit, a migrated `file_mutation`, a call paged out of the loaded window (found after paging), and a call beyond history (`unavailable` with the git fallback); the masked diff route resolves the same result after a simulated reload. |
| R4-T38 | `main/services/agui/run-finished.sessions.test.ts` | main (relay with a fake agent) | `ai.runFinished` for **session** threads (03 r3 §24.11's contract): a run with several tool rounds (compat `turn_complete` between rounds) publishes **one** notice at the terminal; Stop publishes one `cancelled`; an agent SIGKILL mid-run publishes one `error` with `agent_crashed`; the inactivity watchdog publishes one `error` `inactivity_timeout`; a terminal racing a main-written failure publishes only the first; a subscriber that reconnects with `lastEventId` receives the notices it missed exactly once; a background (never-opened) session's run on the agui wire produces its notice; a refused admission publishes nothing. |
| R4-T39 | `e2e/terminal-keys.mjs` + `shared/sessions/terminal-input.test.ts` | Electron + shared | With the terminal focused: `Ctrl+Tab`, `Mod+Alt+B` (and `Mod+W` on macOS, `Ctrl+Shift+W` on Windows/Linux) reach the dock and write **no** bytes to the PTY (the handler returns `true`); **ordinary printable input** (letters, digits, space, punctuation) and control keys (`Ctrl+C`, `Ctrl+R`, `Ctrl+W` on Windows/Linux) reach the PTY unchanged (the handler returns `false`); copy with a selection and bracketed paste still work through the composed handler; the shared encoders produce today's sequences for `platform: "mac"` and `"linux"`/`"windows"`, and the old files' compatibility wrappers keep their exports and signatures (old tests re-run through them). |

---

## 24. Scaffold order

Each step is a commit on `rewrite/04-sessions`, stacked on the phase 3 branch.

1. `shared/sessions/{starters,address,terminal-input}.ts` + the old files' re-exports and compatibility wrappers (§26.9) + their moved tests; old renderer suites green.
2. Main (§26.4, §26.3): checkout-aware file/git APIs and per-checkout `gitState` with fingerprints, `git.discard`, insert with model/mode, typed `model-unavailable`, relocate, consumption of `ai.runFinished` (03 r3 §24.11), `materializeFile`, the relay's start-on-send; R4-T33, R4-T38.
3. `components/{tab-strip,diff-view,file-preview}` (with the moved `PptxDeck`); R4-T24.
4. `features/sessions/data` (queries, actions, attention, unread, open-session, agent-start, search) + invalidation entries; R4-T5 … R4-T9.
5. Sidebar; R4-T10.
6. Routes of §5.1 + foundation amendments (§26.1); R4-T1 … R4-T4.
7. Start page, tray, pickers, `startSession`; R4-T12 … R4-T14.
8. Dock (layout, tab store, strip, split/full, docking); R4-T15, R4-T16, R4-T21.
9. Terminal (repaint adapter, key adapter, shared encoders); R4-T17, R4-T20, R4-T39.
10. Browser + ask host; R4-T18.
11. Files (+ preview bridge), Changes (+ tool-diff resolver), Agents, Device; R4-T19, R4-T25, R4-T32, R4-T36, R4-T37.
12. Thread composition, connector card, notices, read-only, missing, notifications, sound; chat-kit amendments (§26.2); R4-T35.
13. Motion; R4-T26, R4-T27.
14. i18n + keymap; gallery; screenshots; R4-T11, R4-T22, R4-T23, R4-T28, R4-T31; R4-T29, R4-T30, R4-T34 recorded; `PROGRESS.md`.

---

## 25. Acceptance

**Build and rules**
- [ ] `typecheck`, `lint`, `format:check`, `check:knip-next`, `check:i18n`, `check:locales`, `test:unit` green; R4-T1 … R4-T39 pass (Electron cases recorded); R4-T29, R4-T30, R4-T34 recorded on macOS (R4-T29 also on Windows).
- [ ] Changes under `src/renderer` are only locale additions and the re-exports and compatibility wrappers of §26.9 (existing exports and signatures preserved); the old renderer suites pass unchanged.
- [ ] No `ui/` diff; no new dependency; no `monaco`, `@xterm/*`, `trellis`, `<webview>` in renderer-next.

**Parity (gate)**
- [ ] Every §2 row is green in `parity.ts` (R4-T31), and each "Parity" row is demonstrated in the real app once (checklist in the PR).
- [ ] `PARITY.md` rows for sessions, workspaces, git, files, terminal, browser and devices name their renderer-next consumer or their retirement reason.

**Canvas (screenshots at 1280/1000/900/800, light and dark)**
- [ ] Main, MainCollapsed, SessionsSidebar, SessionsSidebarStates (tree, search, empty, both menus), SessionRunning, SplitView, FullView, FullViewFocused, SessionReview, SubAgents, SessionFailed (rate-limit card, sandbox card in the composer slot, terminal tab), SessionWorkspaceMissing, SessionBrowser, SessionFiles, W900 (fold to one strip), W800 (overflow, icon model chip), ComposerStates session column, Pickers session menu, ReadOnlyStates (folder gone, routine run).
- [ ] axe in the real layout reports no violations, contrast included.

**Behaviour (real app)**
- [ ] A 5 MB burst into a hidden terminal tab is delivered in full while the window lives, and after a reload the terminal shows exactly main's retained tail (R4-T29).
- [ ] A session in a sibling worktree shows that worktree's files and changes, and Undo/rename/trash there leave the primary checkout untouched (R4-T33).
- [ ] A connector ask in a session can be completed from the card and the turn resumes (R4-T35); a deliverable presented by the agent opens in its own session, in the background too (R4-T36).
- [ ] The native browser never paints over a menu, dialog, toast or the tab-drag ghost, and follows its placeholder through split/full, dock resizes and window resizes (R4-T30).
- [ ] Hovering sidebar rows never switches the workspace or starts an agent.
- [ ] Sessions, renames, pins, deletes and workspace adds/removes made in renderer-next show in the old renderer and back (dev generation switch, same home).
- [ ] With reduced motion on, no springs, travel or view-transition slides play.

---

## 26. Amendments this spec requires elsewhere

1. **Foundation spec (01).** §6.2: `SessionSearch` becomes §5.2's (tab references incl. `chat`, `agent`, `file`); add `DiffSearch`. §6.1: `sessions.$sessionId.review.tsx` is a redirect; add `sessions.$sessionId.diff.tsx` (masked). §6.5: the loader-readiness rule of 03 r3 §24.1 applies to every sessions loader. §6.6/§6.7: the diff mask and the two `PANE_BOUNDARIES` entries. §7.1 and `layout.ts`: the sessions rules of §10.3 (sidebar folds at `xl` split with a tab; below `xl` sessions fold into one strip instead of the drawer; `tab` absent = panel closed, `chat` = Chat selected). §7.5: `SidePanel.Override` so the sessions route supplies `SessionDock` (bots keep `SidePanel`). §7.6: `features/shell/native-presenter.ts` (one native-surface owner per window, §12.2), exported for both areas. §7.2/§7.3: the needs-you slot merges `BotsNeedsYou` and `SessionsNeedsYou` by oldest waiting; `features/shell/preview-consumers.ts` (a registry each area fills, used by the preview bridge for keyless and bot-owned previews, §13.4); `features/shell/sidebars.ts` gains a `globals` list (`BrowserAskHost`, `SessionNotifications`, `SessionPreviewBridge`) rendered once by `__root`. §7.8: `DockTransitionType = "session-view"` and its CSS. §7.9: `Mod+W` (`Ctrl+Shift+W` inside a terminal on Windows/Linux), `Ctrl+Tab`, `Ctrl+Shift+Tab` registered by the dock through `useAppHotkey`, and a `dispatchAppHotkey(binding)` export for the terminal adapter (§11.4; unique ownership, R1-T14 extended).
2. **Chat kit (02) — §14 requirements.** (a) **Admission with caller-supplied ids** (coordinator decision, Codex r1 #2): `ThreadSession.admitEnvelope(envelope: SubmissionEnvelope): Promise<AdmissionResult>` where `SubmissionEnvelope = { runId; messageId; parts: UIMessagePart[]; forwardedProps? }`; it is `submit` (02 §3.7) with the outbox entry built from the envelope's ids instead of fresh ones, so reconciliation and re-sends reuse them. (b) Draft store `pendingSubmit?: SubmissionEnvelope`, admitted exactly once after readiness and cleared only on a definitive result; a reload in between re-admits the same ids (main's `duplicate` ack). (c) `resolveToolDiff(threadId, toolKey)` export (§14.5) and `ChatViewProps.onOpenDiff?(path: string, toolKey?: string)`. (d) `ChatViewProps.composer.availableModes?: AgentMode[]`; `composer.history?: { list(): Promise<string[]>; add(text): Promise<void> }` (ArrowUp walks history when the queue is empty); `composer.blocked` gains `"no-model"` with a route CTA; `slots.runTail?: ReactNode`; `slots.permissionActions?: (d) => ReactNode`. (e) Exports `SubagentDetail({ threadId, subagentRunId })` and `useSubagents(threadId)`. (f) The feedback popover of 03 §11.3 enabled for `skin: "session"` (S52). The kit's `Composer` compound is used on the start page with a draft thread key.
3. **Main AG-UI relay (00-agent-agui §8 slice).** `ai.send` on a thread whose agent is stopped starts it from the **row's** `model`/`mode` (same requirement as 03 r3 §24.7), and `agent.start` without overrides does the same; concurrent starters **join** one start, and a joined `agent.start` resolves when that start is ready (or rejects with its failure), never early (§9.2). Idempotency by run id and message id is already required (PLAN amendments; 02 §14.5).
4. **Main contract and services (00 A/B) — required in this phase** (coordinator decision on Codex r1 #1):
   - (a) **Checkout-aware file and git APIs.** `CheckoutRef = { workspaceId: WorkspaceId; sessionId?: SessionId }`, resolved by main to the session's `worktreePath` when set, else the workspace's primary path. New inputs: `files.treeRoot({ checkout })`, `files.treeChildren({ checkout, directoryPath })`, `files.search({ checkout, query })`, `files.rename({ checkout, fromPath, toPath })`, `files.trash({ checkout, filePath })`, `git.diff({ checkout, filePath, scope? })`; every path is resolved (symlinks included) and must stay inside the checkout (`FORBIDDEN {reason: "outside"}`). The legacy procedures without `checkout` keep today's active-workspace behaviour for the old renderer. `files.events { tree-root-changed }` gains `checkoutKey`.
   - (b) **`gitState` per checkout with change fingerprints** (Codex r2 #4, #5). Rows keyed by `checkoutKey` (`shared/contract/checkout.ts`, `workspaceId + ":" + (worktreeId ?? "primary")`) and carrying it plus `checkoutPath`; **both key functions change**: the feed's (`main/rpc/tables/index.ts:169`) and `gitStateCollectionOptions.getKey` (`renderer-next/data/db/tables.ts:282`), spec 00 B.2's table row amended accordingly. Main computes a row for the active workspace's primary checkout (today) and for every checkout with a live `git.watch({ checkout })` subscription (`whileSubscribed`). `GitChangeItem` gains `origPath?: string` (the source of a rename, from porcelain `R`/`C` entries) and `fingerprints: { staged?: string; unstaged?: string }`: staged = hash(HEAD commit id, index blob id or "absent"), unstaged = hash(index blob id or HEAD blob id, worktree bytes hash or "absent"); `sameGitState` (`tables/git-state.ts:32`) compares them, so index-only, HEAD-only and same-stat worktree changes all publish.
   - (c) `git.discard({ checkout, entries: Array<{ path: string; origPath?: string }> })` in the resolved checkout (Codex r2 #7). Per entry: **present in HEAD** → `git restore --source=HEAD --staged --worktree -- <path>`; **absent from HEAD** (a staged addition, or the destination of a staged rename) → move the worktree file to the OS Trash (`shell.trashItem`) **first**, then `git rm --cached --quiet -- <path>` (the index entry), so the content is recoverable; **rename** (`origPath` set, from the change item) → restore `origPath` from HEAD (index + worktree) and treat `path` as an absent-from-HEAD entry. A Trash failure aborts that entry before any index change. Echoes `gitState`.
   - (d) `db.sessions.insert` accepts `model?: string | null` and `mode?: AgentMode | null` persisted at creation (`toInsertInput` sends them); `agent.setModel`'s refusal as `CONFLICT {reason: "model-unavailable"}`; `workspaces.relocate` on a tombstoned workspace clears `status: "deleted"` (or R4-T33 pins today's behaviour and §17.3's action changes).
   - (e) **Run outcomes: consume `ai.runFinished` of 03 r3 §24.11** (coordinator decision on Codex r2 #2). No sessions-specific event: the relay's notice already covers every thread (`owner`/`routineId` distinguish kinds), is published at the authoritative first terminal (never from compat), carries a non-null `runId` (so de-duplication is exact) and the relay's event id for `lastEventId` resume. Its coverage requirement (every spawn on the agui wire in the `wco` generation) is what makes uncached background sessions produce notices. Tests: R4-T38.
   - (f) **Guarded local-file runtime** (coordinator decision on Codex r1 #14): `browser.runtime.materializeFile({ conversationKey, resourceId, filePath, hostRoot })` with the rules of §12.8; `checkedUrl` is unchanged for every other path.
   - (g) **Idempotent worktree materialization** (Codex r2 #3): `git.worktrees.materialize` gains `operationId: string`; main records `{ operationId, worktreeId }` on the session (a `worktreeOperationId` field on the session record, not writable through `db.sessions.update`) inside the same persist as the attach, and a repeat with the same `(sessionId, operationId)` returns the recorded `MaterializeSessionWorktreeResult` without creating a branch or path. The session row exposes `worktreeOperationId` so the renderer can reconcile (§8.6 step 3). `setForSession({ worktreeId: null })` detaches (existing behaviour, now relied on).
   - (h) **`git.diff` result kinds** (Codex r2 #6): output `{ kind: "patch" | "untracked" | "binary" | "none"; patch?: string }`; the whole-file fallback is used only for a path git reports as untracked; a tracked path with no change in the requested scope is `none`.
   - (i) **Checkout status** (Codex r2 #8): `git.checkoutStatus({ checkout })` → `{ kind: "primary" | "worktree"; path: string; exists: boolean; workspaceExists: boolean }`, checking the **effective** path (the session's worktree when it has one), polled like `checkPath` (focus, a `workspaces`/`sessions` batch for it, and any `workspace-missing`/`NOT_FOUND` from a call).
   - Tests: R4-T33 (primary checkout untouched with a sibling worktree; two worktrees + primary as three rows; fingerprints for index-only, HEAD-only and same-stat edits; staged addition and staged rename discarded through the Trash; `materialize` repeated with one `operationId` creates one worktree; `git.diff` kinds; `checkoutStatus` for a deleted worktree with an intact primary), R4-T38.
5. **`ipcCollectionOptions` (00 B.3).** `sessions` and `workspaces` set `idempotentDelete` (03 §24.5).
6. **Transport (00 A).** None: `terminal.output` (offsets, `retired`), `devices.stream.chunks` (key-frame barrier), keyless `browser.events` snapshots and flow control are implemented and used as they are.
7. **Bots (03 r3).** `components/model-groups/` (moved from `features/bots/model/model-groups.ts`) so both areas build the picker's groups with one function; the shell's needs-you merge (item 1); the shared `turnTransitions(collection)` helper (needs-you only); **one `ai.runFinished` subscription per document** (03 r3 §24.11) feeds both areas' unread and cues; the **`ConnectorRequestCard`** of 03 r3 §11.4 (refresh-before-respond) is reused unchanged by sessions (§9.3); the bot browser tab and bot file previews (pdf/html) use the shell's native presenter (§12.2) and the local-file runtime (§12.8) rather than their own presentation; bot-owned conversations' `preview-open` stays with bots' consumer, the shell bridge handles the rest (§13.4).
8. **PLAN.md.** "Small libraries": typed + ESM + maintained in 90 days **+ an OSI licence** (F2); route tree: review is a side-panel tab, the diff is a masked pop-up, `tab` is a tab reference; "Shell › Panes": sessions fold below 1100 instead of the drawer (F4); stack table: `ghostty-web` confirmed, `react-resizable-panels` carries the dock.
9. **Old renderer (the only non-locale edits).** `renderer/terminals/terminal-{keys,mouse}.ts`, the session starters in `components/chat/chat-panel.tsx` and `normalizeAddress` in `components/browser/browser-runtime-surface.tsx` delegate to `shared/sessions/{terminal-input,starters,address}.ts`: starters and `normalizeAddress` are one-line re-exports; `terminal-{keys,mouse}.ts` are compatibility wrappers (same exports and signatures, the platform built from `window-chrome`'s booleans; Codex r2 #16). Their tests are unchanged. The deck viewer (`components/browser/pptx-viewer.tsx`) is React and cannot live in `shared/`, and the old tree may not import renderer-next (foundation §3.4), so it is **copied** into `components/file-preview/pptx-deck.tsx` and the old file is untouched until cut-over.

---

## 27. Risks, unverified claims, deferred items, review classes applied

### 27.1 Risks

| Risk | Mitigation |
|---|---|
| Checkout-aware main APIs (F5) are new main work on the critical path | required in this phase (§26.4 a–b), specified with R4-T33 proving worktree isolation; the legacy procedures stay unchanged for the old renderer; the tabs show "Getting this folder ready" until the checkout's `gitState` row exists |
| Native browser vs DOM overlays and competing surfaces | one presentation owner per window with captured placeholders (§12.2), the foundation's occluder list + intersection test, hide during view transitions and drags; R4-T18, R4-T30 pixel checks |
| Local-file runtime widens what the native surface loads | a separate `materializeFile` path with containment, a throwaway partition, top-level navigation locked, sub-resources limited (§12.8); `checkedUrl` untouched; R4-T30, R4-T33 |
| Terminal output after reload is bounded by main's 2 MB scrollback and ghostty's 10,000 lines | live delivery is lossless; replay is the retained tail by design (no retention change requested); R4-T17 and R4-T29 assert both separately |
| Our own dock grows into a layout engine | hard limits (3 leaves, 2 columns, two levels), a pure reducer, keyboard parity; anything beyond is a later design decision, not creep |
| Split ↔ full view transition vs the router seam | the dock owns its transition (local state inside its own `startTransition`), URL written outside it; R4-T26 |
| First message of a new session racing agent start | `ai.send` starts the agent (§26.3) + pre-minted run id + idempotent `ai.send`; R4-T13 |
| WebCodecs availability and H.264 profiles on Windows/Linux | parity fallback to snapshots after 5 s; R4-T32 |
| `@pierre/trees` beta API churn | exact pin at the installed beta; the tree is behind `tree-model.ts` (one adapter) |

### 27.2 Unverified claims (each has a test that decides it)

`motion` 13.4.6 typings (R4-T27); `isNull` in the 0.9.2 query builder (R4-T6); Base UI `ContextMenu` from the keyboard (03 R3-T14, reused); present bounds at zoom ≠ 1 (R4-T30); a running agent picking up an exec-backend change (R4-T14; the menu is disabled while running meanwhile); `@tanstack/markdown` React renderer outside the kit (R4-T24); `@pierre/trees` beta.6 accessibility roles (R4-T23); relocate clearing a tombstone (R4-T33); the `session-view` transition surviving the router seam (R4-T26); pointer drag between leaves in real Chromium (R4-T21 Electron half).

### 27.3 Deferred or not built

Per-change (hunk) Keep/Undo and the run-level Undo on the ChangesCard (F6); "Move to workspace…" (no procedure, F7); "Open in side panel" / "Open beside this chat" (a second chat surface); browser "Take over" / "I'm done" (no take-over procedure; the status line ships); commit / push / open-PR actions (none today; "Ask for a change, or open a pull request" is only the placeholder text); remote workspaces and cloning (`isRemote` exists in the contract, no UI today); the Chat/Work toggle (F11); Settings pages for browser, devices, terminal shell and notifications (phase 5).

### 27.4 Review defect classes applied

Every library claim cites the installed `.d.ts`/`package.json` or is listed in §27.2 (classes 1–2; F1, F2 verified against packages, not assumed); masks use full paths and `PANE_BOUNDARIES` is typed (6–7); loaders guard preload side effects: no `workspaces.switch`, `ensureSessionHome`, agent start or subscription on hover (8, 20); mutations await *received* in handlers and `isPersisted` outside, and every action has client/server/final-row/failure (10–12, §6.4–§6.5); each derived query lists every source of change with a single-source test (13, R4-T5); client ids are UUIDs checked against the id atom (19); lossless streams resume from positions and never from "latest" (terminal offsets, device key frames, keyless actionable snapshots: the A-fix classes); a native surface is hidden for every occluder, transition and drag (window-chrome/foundation occlusion class); view-transition props are type maps with `none` defaults and no view transition for scroll or search-only changes (23–25); every drag has a keyboard path; contrast is computed (27); tests go through real collections, router and transport (31–32); intended behaviour changes are listed with owners in §2 (39); errors are typed and the UI never parses messages (42, R4-T11). Added in r2: every loader awaits the collections it reads (cold-link class, 03 r3 §24.1); multi-step create pipelines persist their stage and resume instead of repeating side effects; admissions carry caller-supplied ids end to end so a reload cannot duplicate a run; invalidation and review marks key on content, not on derived statistics; cues and unread come from a lossless outcome notice, never from a phase that Stop also produces; a single owner arbitrates a single native resource; every version cited was re-read from the installed `package.json`.

---

## Review responses (r1)

Source: `docs/rewrite/specs/reviews/04-sessions.codex-r1.md` (23 items, 2 blockers). Coordinator decisions applied as given (#1, #2, #8, #9, #14–#17, #19–#23); the rest as the reviewer proposed, each re-checked against the cited source.

| # | Sev. | Verdict | Evidence checked | What changed |
|---|---|---|---|---|
| 1 | Blocker | **Accepted** (coordinator: required now) | `service-host.ts:1789-1810` resolves the active workspace root for tree/search; `gitState` has no checkout identity (spec 00 B notes); `files.*` inputs have no workspace (`shared/contract/files.ts:30-49`). | F5 rewritten; §26.4 (a)–(c): `CheckoutRef` on tree/children/search/rename/trash/diff/discard, per-checkout `gitState` via `git.watch`; renderer-next never calls `workspaces.switch` (S2, S6, §5.3, §13, §14); R4-T33 proves a sibling worktree works and the primary checkout is byte-identical. |
| 2 | Blocker | **Accepted** (coordinator) | 02 §3.7: `submit` mints `u-`/`run-` ids per call; `pendingSubmit` carried only `forwardedProps`. | §8.6 stores a full `SubmissionEnvelope` (run id, message id, parts, forwardedProps) before any call; §26.2 (a)–(b) adds `admitEnvelope` with caller-supplied ids and clearing only on a definitive result; R4-T13 reloads after acceptance and before clearing. |
| 3 | Major | **Accepted** | 03 r2 §24.1 (concurrent matched loaders, `load-client.ts:1014-1035`). | §5.1/§5.3: `sessions.index`, `sessions.new`, `sessions.$sessionId`, `…/diff` await `preload()` themselves; R4-T3/T4 cold links with delayed snapshots. |
| 4 | Major | **Accepted** | r1 §8.6 inserted before materializing and §6.4 kept the session on failure. | §8.6 stage machine (`draft → created → checkout-ready → handed-off`) persisted in the start draft; Retry and "No worktree" resume; same-id `CONFLICT` = already created; Continue/Discard on return; R4-T12. |
| 5 | Major | **Accepted** | `tables.ts:105` insert sends `{ id, workspaceId }`; rows start with `model/mode` null. | §6.4 insert carries `model`/`mode`; §26.4 (d) extends `db.sessions.insert`; §9.2 and §26.3 start from the row only (one configuration, joined concurrent starts); R4-T7, R4-T33. |
| 6 | Major | **Accepted** | `service-host.ts:1805` searches the active workspace. | §8.1 and §9.3 `files.search({ checkout })` with the draft's workspace; R4-T12 picks B while A is active. |
| 7 | Major | **Accepted** | `settings.ts:26-33` backend ids; `exec-backends.ts` (only local/docker implemented); `SandboxSupport` is mode Auto. | F10 and §8.2: tray shows the effective backend; "Sandboxed" is a mode-derived suffix; `set` is an immediate global mutation with refusal/fallback display, disabled while the agent runs; R4-T14 Electron checks where a command actually runs. |
| 8 | Major | **Accepted** (coordinator) | 03 r2 §11.4 shared `ConnectorRequestCard`, `connectors.respond` outcomes `connected\|declined\|failed` (`contract/connectors.ts:15`). | S65 Parity; §9.3 `slots.banner` reuses the card with snapshot, field flow, decline, respond; §6.1 row; R4-T35 resumes a suspended turn. |
| 9 | Major | **Accepted** (coordinator) | `renderer/utils/preview-utils.ts:125`, `use-workspace-refresh.ts:31-80`. | S111; §13.4 shell-mounted `SessionPreviewBridge` (visible → open, background → record + unread, unsupported → nothing, bots left to 03's consumer); §26.1 globals; R4-T36. |
| 10 | Major | **Accepted** | `conversation-terminal-runtime-registry.ts:380` (`hide` sets `visible: false`, PTY alive). | §10.2 reconciles by existence; tabs leave only on removal or `exit`/`retired {closed}`; R4-T16 with hidden terminals across reload. |
| 11 | Major | **Accepted** | `BoundedScrollback` 2 MB (`…registry.ts:143`); ghostty `scrollback: 10_000`. | R4-T29 and §25 split lossless live delivery from bounded replay (exact retained tail, replacement vs append snapshots); no retention change requested (§27.1). |
| 12 | Major | **Accepted** | `ghostty-web.js:954` stops propagation; hotkeys listen in bubbling. | §11.4: `attachCustomKeyEventHandler` intercepts dock chords and calls `dispatchAppHotkey`; `Ctrl+W`/`Ctrl+N` stay shell keys on Windows/Linux (`Ctrl+Shift+W` closes); R4-T39 in Electron with PTY byte assertions. |
| 13 | Major | **Accepted** | `terminal-keys.ts:10` imports `../lib/window-chrome` (`isMacOS` via `window.api`). | §11.4, §26.9: `shared/sessions/terminal-input.ts` takes an injected `platform`; thin legacy wrappers; R4-T39 covers both platform paths. |
| 14 | Major | **Accepted** (coordinator: guarded presentation, not retirement) | `electron-browser-runtime.ts:63-75` (`checkedUrl` rejects `file:`); `main/index.ts:978-987` webview hardening. | F8, S80, §12.8, §13.3: `browser.runtime.materializeFile` with containment, throwaway partition, locked navigation, sub-resource limits; §26.4 (f); R4-T30 renders PDF/HTML and asserts denials; the "or fallback" pass condition is gone. |
| 15 | Major | **Accepted** (coordinator) | `electron-browser-runtime.ts:268` (`present` hides the previous runtime). | §12.2 one owner per window in `features/shell/native-presenter.ts`, captured placeholders + click-to-activate, serialised capture → hide → present; bots use it too (§26.7); R4-T18, R4-T30 with two leaves. |
| 16 | Major | **Accepted** (coordinator: parity port) | `device-panel.tsx:320-420` (boot, aspect screenshot, `captureSimulatorWindow` retries, bottom crop, track stop, permission latch). | S110 and §16.2 port the iOS chain with permissions, crop and cleanup; R4-T32. |
| 17 | Major | **Accepted** (coordinator) | `react-resizable-panels.d.ts:623` (`Layout` = percentages); installed 4.14.1 (`package.json`). | Sources, §3, §10.3, §10.4 persist `Panel.onResize(size).inPixels` with defined keys (`sessions.chat`, `sessions.dock.<splitId>.<leafId>`); version cite fixed; R4-T15 restores after window resizes. |
| 18 | Major | **Accepted** | r1 `onOpenDiff` passed only path/source/key; no resolver. | §14.5 `resolveToolDiff(threadId, toolKey)` over the hydrated thread with bounded paging and an explicit unavailable state; diff route loader awaits `load()`; §26.2 (c); R4-T37 incl. reload. |
| 19 | Major | **Accepted** (coordinator: one shared notice) | `contracts.ts:468-474` (turn state has no outcome/run id); `session-turn-state-service.ts:99` (Stop → `idle`). | §26.4 (e) `sessions.events { run-finished }` shared with bots (03 r2 §24.11 becomes a filtered view); §6.7 unread and §19 cues/notifications use it; cancelled plays and marks nothing; duplicates once; R4-T9, R4-T38. |
| 20 | Major | **Accepted** (coordinator) | r1 §10.4 vs §10.1–§10.3. | `tab=chat` is a distinct value; `tab` absent = panel closed in every band; state table in §10.4; Close tabs vs selecting Chat defined; §5.2 schema; R4-T15 incl. reload and back/forward. |
| 21 | Major | **Accepted** (coordinator: content-based) | `rpc/tables/git-state.ts:32` equality ignores timestamps. | §26.4 (b) `GitChangeItem.fingerprint`; diff query keys and review marks use it (§6.1, §14.4, §14.5); R4-T25 same-stat edit. |
| 22 | Minor | **Accepted** (coordinator: verified on pixels) | 0.4.0 has no public `refresh`; `resize` returns early for the same size (`ghostty-web.js:2439-2443`); public `renderer` (`index.d.ts:1465`). | §11.3 version-pinned `repaint` adapter (full render through `renderer`), `ghostty-web` pinned exact; R4-T20 Electron pixel checksum with a control run. |
| 23 | Minor | **Accepted** (coordinator) | `renderer-next/data/db/tables.ts:380-400` `updatePrefs(patch: PrefsPatch)`; 03 r2 §24.1. | §6.4 pin sends `{ pinned: { sessionIds: next } }`; every prefs write in this spec is a patch; R4-T7 exercises the real helper's echo and rollback. |

Nothing was rejected.

## Review responses (r2)

Source: `docs/rewrite/specs/reviews/04-sessions.codex-r2.md` (16 items: 14 major, 2 minor). Coordinator decisions applied for #1–#8; the rest as the reviewer proposed, each re-checked against the cited source. This is the final spec round; a self-consistency pass follows the table.

| # | Sev. | Verdict | Evidence checked | What changed |
|---|---|---|---|---|
| 1 | Major | **Accepted** (coordinator) | `ghostty-web.js:850-856`: a truthy custom-handler result calls `preventDefault()` and returns before encoding. | §11.4: handled dock chords return `true`, everything else `false`; the handler composes dock chords then the shared copy/paste/scroll keys; §27.2 entry removed (verified); R4-T39 adds ordinary printable input and the composed copy/paste. |
| 2 | Major | **Accepted** (coordinator) | 03 r3 §24.11 (`ai.runFinished` at the relay's first-terminal-wins boundary, non-null run id, event-id resume, agui-wire coverage); `thread-relay.ts:254`. | §6.1, §6.7, §19.1, §26.4 (e), §26.7, S24: the sessions-specific notice is gone; both areas consume one `ai.runFinished` subscription; R4-T38 replaced by multi-round, Stop, crash, inactivity timeout, terminal race, reconnect with `lastEventId`, background-session and refused-admission cases; R4-T9 updated. |
| 3 | Major | **Accepted** (coordinator) | `service-host.ts:2971` materialize; `git-service.ts:524` random branch/path per call. | §8.6 step 3: reconcile from the row first; `worktreeOperationId` minted and persisted before the call; main idempotent per `(sessionId, operationId)` (§26.4 g); "No worktree" is an explicit detach; R4-T12 reloads after server success before the stage write. |
| 4 | Major | **Accepted** (coordinator) | `renderer-next/data/db/tables.ts:282` and `main/rpc/tables/index.ts:169` key rows by `workspaceId`. | §6.2 `useGitState(checkout)` by the shared `checkoutKey`; §26.4 (b) amends both key functions (spec 00 B.2); R4-T6 three rows for a primary and two worktrees, with chips and decorations; R4-T33. |
| 5 | Major | **Accepted** (coordinator) | `rpc/tables/git-state.ts:32` equality over status and stats. | §26.4 (b) per-scope fingerprints over HEAD commit, index blob and worktree bytes; §14.4 marks per `(path, scope)`; R4-T25/R4-T33 add index-only, HEAD-only and same-stat cases. |
| 6 | Major | **Accepted** (coordinator) | `git-service.ts:683` defaults to `unstaged` and falls back to a whole-file diff. | §5.2 `scope` in `SessionSearch` and `DiffSearch` (the mask keeps it); §14.1 rows are `(path, scope)` and the merged list is defined; §14.5 query key includes scope; §26.4 (h) `git.diff` result kinds, all-added only for confirmed untracked; R4-T25 staged-only and mixed files through reload. |
| 7 | Major | **Accepted** (coordinator) | git-restore(1): paths absent from the source are removed. | §26.4 (c) `entries` with `origPath`; absent-from-HEAD paths go to the Trash before `git rm --cached`; renames restore the source; `GitChangeItem.origPath`; §14.4 copy; R4-T33 staged addition and staged rename. |
| 8 | Major | **Accepted** (coordinator) | `workspace-service.ts:196` checks the primary workspace path. | §26.4 (i) `git.checkoutStatus` of the effective checkout; §6.1 row; §17.2 separate missing-worktree state (Use the main checkout / Delete session, never relocate); R4-T33. |
| 9 | Major | **Accepted** | `chat-panel.tsx:1046-1129` reacts to every stopped/error transition while mounted. | §9.2 lifecycle controller scoped to incarnations: restart on later transitions, generation tokens cancel stale retries, joined starts await readiness (§26.3), `switchConversation` once per incarnation; R4-T8 crash and second incarnation without unmount. |
| 10 | Major | **Accepted** | 03 r3 §11.4 (refresh before respond; failures keep the card actionable). | §9.3 adopts that sequence as authoritative; R4-T35 asserts call order, refresh failure, cancelled flow, non-active-workspace request. |
| 11 | Major | **Accepted** | `service-host.ts:793` (ConnectorGate emits without a phase change). | §6.6 `sessionAttention` takes pending connector asks (keyless `connectors.events` store), `needs-you` reason `connector`; R4-T9. |
| 12 | Major | **Accepted** | `electron-browser-runtime.ts:340` (capture and close). | §12.2 chain recovers from every rejection and re-validates registration, owner, lease generation, visibility and occlusion before `present`; R4-T18 delayed capture + close / profile replacement / overlay. |
| 13 | Major | **Accepted** | two leaves need 480 px + separator; pinned sidebar below `xl`. | §10.4 recursive `minWidth`/`minHeight`, chat clamp by the tree's minimum, folding to one leaf while the tree does not fit (restored later), refusal of drops that cannot fit; §10.3 clamp updated; R4-T15 1440 → 1100 → 800 with the sidebar pinned. |
| 14 | Major | **Accepted** | `preview-utils.ts:125` falls back to the active conversation; `files.ts:15`, `browser.ts:96` make the key optional. | §13.4 keyless events target the active conversation (session, bot or draft) with dispatch through `features/shell/preview-consumers.ts`; §26.1; R4-T36 keyless URL and file cases. |
| 15 | Minor | **Accepted** | §11.3 keeps views and offsets in a module map. | R4-T29: append snapshots on same-document reconnects, replacement snapshots on every window reload including quiet output. |
| 16 | Minor | **Accepted** | `renderer/lib/window-chrome.ts:14-15` export booleans. | §11.4 and §26.9: compatibility wrappers built from the booleans, existing exports and signatures preserved; §24 step 1 and §25 acceptance rule amended. |

**Final consistency pass (r3).** R4-T1 … R4-T39 are contiguous and every id cited in the text has a row; every `§n.m` of this spec cited in the text resolves to a heading, and every `§26.x` to an item of §26; references to 03 now cite r3 (§11.3, §11.4, §24.1, §24.7, §24.11), and the names 05 r1 consumes (`components/file-preview`, `features/sessions/notify.ts`, the OSI-licence rule of §26.8, the settings pages deferred in §27.3, S64) are unchanged. Superseded mechanisms (the sessions-only `sessions.events` notice, a `false`-for-handled key handler, stat-based invalidation, workspace-keyed `gitState`) no longer appear outside the review tables.

