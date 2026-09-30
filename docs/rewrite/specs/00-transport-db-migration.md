# Spec 00 — Transport, DB tables, migration runner

Phase 0 of `docs/rewrite/PLAN.md` (rows 2–4 of `PROGRESS.md`): "main oRPC contract + MessagePort transport", "DB tables (snapshot + change events)", "migration runner". This spec defines behaviour, files, tests and acceptance for three sub-slices that ship as three stacked PRs on `rewrite/renderer`:

| Sub-slice | PR | Depends on |
|---|---|---|
| A. oRPC contract + MessagePort transport | `rewrite/00a-transport` | — |
| B. DB tables over the transport | `rewrite/00b-db-tables` | A |
| C. Migration runner | `rewrite/00c-migrations` | A (for `db.prefs` row type), B (prefs store) |

The AG-UI emitter (`packages/agent/src/agui/*`) is a separate Phase 0 slice. This spec defines the `ai.*` procedures and their main-side seam (`AguiSource`), but not the emitter. Until the emitter lands, `ai.*` resolves against a fake `AguiSource` in tests and throws `UNAVAILABLE` in the app.

## Ground rules

- **No behaviour change for the running app.** The old renderer keeps `window.api` and every `ipcMain.handle` until the Phase 7 cut-over. The oRPC router runs alongside and calls the same `ServiceHost` methods. Both are mounted at once, and both see every event.
- **The contract is the parity list.** Every legacy bridge method and `IpcEvent` variant gets a row in the tables below: a procedure, a DB table, an event iterator, or "retire" with a reason. A test (A-T6) fails when a legacy method has no row.
- **The renderer never imports `electron`.** It gets a `Transport` object: an oRPC client plus `@orpc/tanstack-query` utilities. The only preload export besides the port handshake is `getPathForFile`, which needs `webUtils`.
- **Versions (checked on npm, 30 Sep 2026):** `@orpc/server`, `@orpc/client`, `@orpc/contract`, `@orpc/tanstack-query` **1.15.4** (published 23 Sep 2026). Pin all four to the same exact version. `@tanstack/db` 0.10.0 and `@tanstack/react-db` 0.4.2, as verified in the cloned repo. `valibot` 1.x (new dependency). `ws` 8.21.3 is already in `apps/desktop/package.json`.

### oRPC facts this spec relies on (checked in the 1.15.4 package typings)

- Contract builder: `oc` from `@orpc/contract`, with `.input(schema)`, `.output(schema)`, `.errors({...})` and `.meta()`. Input and output accept any Standard Schema, so valibot works directly. `type<T>()` from `@orpc/contract` gives a type-only schema with no runtime cost. `eventIterator(yieldSchema, returnSchema?)` from `@orpc/contract` declares a streaming output.
- Implementation: `implement(contract)` from `@orpc/server`. Streaming handlers are `async function*` and receive `{ input, context, signal, lastEventId }`. `withEventMeta(value, { id, retry })` and `getEventMeta` are exported from `@orpc/server` and `@orpc/client`. `EventPublisher` (from `@orpc/server`, re-exported from `@orpc/shared`) supports `publish(event, payload)` and `subscribe(event, { signal, maxBufferedEvents })`. `maxBufferedEvents` defaults to 100 and drops the oldest events beyond that.
- MessagePort server: `RPCHandler` from `@orpc/server/message-port`, with `handler.upgrade(port, { context })` followed by `port.start()`. `SupportedMessagePort` explicitly includes Electron's `MessagePortMain` (`on('message'|'close')`, `postMessage`). The handler listens for `close` and tears down its peer.
- MessagePort client: `RPCLink` from `@orpc/client/message-port` (`{ port, interceptors, plugins, customJsonSerializers }`), then `port.start()`, then `createORPCClient(link)` from `@orpc/client`.
- WebSocket server: `RPCHandler` from `@orpc/server/ws`, where `upgrade(ws)` takes a `ws` `WebSocket`. WebSocket client: `RPCLink` from `@orpc/client/websocket` (`{ websocket }`).
- The RPC serializer handles `Date`, `BigInt`, `Map`, `Set`, `URL`, `RegExp`, `NaN`, `undefined` and `Blob`/`File` out of the box. **`Uint8Array`/`Buffer` is not built in**, so a custom JSON serializer is needed (A.6).
- TanStack Query utilities: `createTanstackQueryUtils(client)` (alias of `createRouterUtils`). It provides `.queryOptions()`, `.mutationOptions()`, `.key()`, `.queryKey()`, `.experimental_streamedOptions()` and `.experimental_liveOptions()` for event iterators.
- Client plugins: `ClientRetryPlugin` from `@orpc/client/plugins` retries event iterators and re-sends `last-event-id`, which surfaces as `lastEventId` in the handler.

### Where things are today (cited)

- The preload exposes `window.api` through `contextBridge` (`apps/desktop/src/preload/index.ts:36-264`). `api.agent` is `createBridge(ipcRenderer)` (`preload/bridge.ts:179-1090`), with 196 members. There are 50 more top-level members, including sync `platform`/`versions` values and `durableState`, whose snapshot is read with `ipcRenderer.sendSync` (`preload/index.ts:18-28`).
- There is one catch-all event channel. `ServiceHost.emitEvent` (`main/service-host.ts:3828`) calls the dispatcher installed by `registerIpcHandlers` (`main/handler.ts:143-147`), which calls `sendToRenderer(IpcChannels.Event, event)` (`main/renderer-host.ts:285`). The union has 46 variants (`shared/contracts.ts:499-719`). Direct senders that bypass the dispatcher:
  - `mcp-agent-tools-server.ts:1164`
  - `mcp-browser-server.ts:703,1413`
  - `electron-browser-runtime.ts:750`
  - `update-service.ts:449` (`update-status`)
  - `main/index.ts:544` (`window:full-screen-changed`)
  - `main/index.ts:1628` (`notification-clicked`)
  - the device stream chunks on `agent:device-stream-chunk`
- The renderer runs in a `WebContentsView` owned by `RendererHost` (`main/renderer-host.ts:116`). An experience update creates a second `webContents` and swaps it in (`renderer-host.ts:172-265`). Every new `webContents` goes through `wireRendererContents` (`main/index.ts:690`), which `RendererHost` receives as `wire` (`index.ts:874-884`). `contextIsolation` is the default (true); `sandbox: false` (`index.ts:877`).
- Startup order: `whenReady` → `workspaceServiceHost.initialize()` (`index.ts:960`) → `registerRendererState()` (`index.ts:964`) → `registerIpcHandlers` (`index.ts:965`) → experience runtime (`index.ts:1735`) → `createWindow` (`index.ts:1752`).
- Durable renderer state lives in main's `RendererStateStore`, at `userData/renderer-state.json` (`main/services/config/renderer-state.ts:132-148`), not in localStorage. Every renderer origin is versioned, so localStorage resets on each swap. `renderer/lib/durable-storage.ts:72-105` copies an origin's localStorage into the store once. All zustand `persist()` stores use it as storage.
- The experience compatibility gate is `FOUNDATION_API = 1` (`shared/experience.ts:11`), checked in `updates/experience/integrity.ts:57`.

---

## A. oRPC contract + MessagePort transport

### A.1 Contract layout

The contract lives in `apps/desktop/src/shared/contract/`, one file per domain, mirroring the bridge families. Each file exports a plain object of `oc` procedures. `index.ts` composes them:

```
shared/contract/
├─ index.ts            export const contract = { workspaces, git, files, sessions, agent, ai, bots, routines, settings,
│                        models, localModels, account, auth, referrals, connectors, mcp, browser, terminal, memory,
│                        devices, voice, messaging, system, window, update, skills, durableState, db }
│                      export type Contract = typeof contract; export const CONTRACT_VERSION = 1
├─ base.ts             `base = oc.errors(COMMON_ERRORS)` — every procedure starts from `base`
├─ errors.ts           COMMON_ERRORS map + `RpcErrorCode` union (A.5)
├─ ids.ts              valibot id/path atoms: SessionId, WorkspaceId, BotId, RoutineId, TerminalId, AbsPath, HttpUrl
├─ serializer.ts       Uint8Array custom JSON serializer, shared by handler and link (A.6)
├─ agui.ts             AG-UI types re-exported from @tanstack/ai (`StreamChunk`, `UIMessage`, `ChatHydrationResult`,
│                      `RunAgentInputContext`) — type-only imports, no runtime dependency in main
├─ rows.ts             DB row types (B.2) — shared by main feeds and renderer collections
├─ workspaces.ts git.ts files.ts sessions.ts agent.ts ai.ts bots.ts routines.ts settings.ts models.ts
├─ local-models.ts account.ts auth.ts referrals.ts connectors.ts mcp.ts browser.ts terminal.ts memory.ts
├─ devices.ts voice.ts messaging.ts system.ts window.ts update.ts skills.ts durable-state.ts db.ts
└─ legacy-map.ts       LEGACY_BRIDGE_MAP / LEGACY_EVENT_MAP: the parity tables below as data (drives A-T6 and PARITY.md)
```

Conventions:

- **Inputs are always an object**, validated with valibot. Positional legacy arguments become named fields. For example, `setAgentSessionModel(workspaceId, sessionId, model)` becomes `{ workspaceId, sessionId, model }`. Where a request type already exists in `shared/contracts.ts`, its schema is declared as `v.GenericSchema<ThatType>`, and a type test (A-T1) asserts that `v.InferOutput<Schema>` equals the existing type in both directions. The legacy type and the schema therefore cannot drift.
- **Outputs are `type<T>()`**, typed but not validated at runtime. Main is trusted, and validating every output would cost CPU on hot paths such as terminal output and AG-UI deltas. The one exception is `db.*.snapshot`, which gets a valibot row schema in development builds only (`import.meta.env.DEV`) to catch feed bugs early.
- **Ids** reuse the transcript path guard (`main/services/session/transcript-service.ts:18-21`): `v.pipe(v.string(), v.regex(/^[A-Za-z0-9._-]+$/), v.check(s => !s.startsWith(".")))`. Paths are `AbsPath = v.pipe(v.string(), v.check(path.isAbsolute-equivalent for posix and win32))`. URLs are checked with `v.url()`, and `system.openExternal` keeps `isSafeExternalUrl` in its handler.
- **Streams** are procedures whose output is `eventIterator(type<E>())`. They are named `*.events` (a domain's notices), `*.output`/`*.progress` (a single resource) or `db.<table>.changes`.
- **Fire-and-forget** calls (`appendLogs`, `reportUiActivity`, `writeTerminalInput`, `streamDeviceTouch/Key`, `reportFunnelStep`) are ordinary procedures returning `void`. The caller does not await them, and the transport sends them in order.

### A.2 Domain map (legacy → procedure)

Kinds: **Q** query, used through `orpc.<path>.queryOptions`. **M** mutation. **S** event-iterator subscription. **T** served by a DB table (B). **R** retired, not mounted on the router (the legacy handler stays until cut-over). Line numbers point at the legacy bridge definition.

#### A.2.1 `window.api.agent.*` (preload/bridge.ts, 196 members)

| # | Legacy `window.api.agent.*` | Current | Procedure | Kind | Notes |
|---|---|---|---|---|---|
| 1 | `getMetadata` | bridge.ts:181 | `db.workspaces (snapshot/subscribe)` | T | `materialIconsBasePath` → `system.info`; `activeWorkspaceId` → row `isActive` |
| 2 | `getGitState` | bridge.ts:186 | `db.gitState (snapshot/subscribe)` | T | keyed by workspaceId |
| 3 | `listWorktrees` | bridge.ts:188 | `git.worktrees.list` | Q |  |
| 4 | `createWorktree` | bridge.ts:193 | `git.worktrees.create` | M |  |
| 5 | `setSessionWorktree` | bridge.ts:198 | `git.worktrees.setForSession` | M | echoes `sessions` update |
| 6 | `materializeSessionWorktree` | bridge.ts:203 | `git.worktrees.materialize` | M | echoes `sessions` update |
| 7 | `getFileTreeRoot` | bridge.ts:208 | `files.treeRoot` | Q | invalidated by `files.treeRootChanged` iterator |
| 8 | `listModels` | bridge.ts:212 | `models.list` | Q | input `{ refresh?: boolean }` |
| 9 | `getUsageSnapshot` | bridge.ts:216 | `account.usage` | Q |  |
| 10 | `getAbacusAccount` | bridge.ts:220 | `account.abacus` | Q |  |
| 11 | `getReferralSummary` | bridge.ts:225 | `referrals.summary` | Q |  |
| 12 | `listReferralGmailContacts` | bridge.ts:229 | `referrals.gmailContacts` | Q |  |
| 13 | `sendReferralEmailInvites` | bridge.ts:233 | `referrals.sendEmail` | M |  |
| 14 | `listReferralWhatsappContacts` | bridge.ts:239 | `referrals.whatsappContacts` | Q |  |
| 15 | `sendReferralWhatsappInvites` | bridge.ts:243 | `referrals.sendWhatsapp` | M |  |
| 16 | `submitTurnFeedback` | bridge.ts:249 | `agent.feedback` | M |  |
| 17 | `getSettings` | bridge.ts:254 | `settings.get` | Q |  |
| 18 | `listPromptHistory` | bridge.ts:256 | `settings.promptHistory.list` | Q |  |
| 19 | `addPromptHistory` | bridge.ts:260 | `settings.promptHistory.add` | M |  |
| 20 | `listStoredKeyProviders` | bridge.ts:266 | `settings.keys.listProviders` | Q | invalidated by `system.events` `credentials-changed` |
| 21 | `saveApiKey` | bridge.ts:270 | `settings.keys.save` | M |  |
| 22 | `setDefaultModel` | bridge.ts:276 | `settings.setDefaultModel` | M |  |
| 23 | `addWorkspace` | bridge.ts:281 | `workspaces.add` | M | echoes `workspaces` insert |
| 24 | `ensureSessionHomeWorkspace` | bridge.ts:287 | `workspaces.ensureSessionHome` | M |  |
| 25 | `getSessionHomeWorkspacePath` | bridge.ts:291 | `workspaces.sessionHomePath` | Q |  |
| 26 | `switchWorkspace` | bridge.ts:295 | `workspaces.switch` | M | legacy main-side active workspace; new routes carry `workspaceId` |
| 27 | `initGit` | bridge.ts:300 | — | R | no renderer caller |
| 28 | `getFileTreeChildren` | bridge.ts:302 | `files.treeChildren` | Q |  |
| 29 | `searchFiles` | bridge.ts:307 | `files.search` | Q |  |
| 30 | `getGitDiffForPath` | bridge.ts:315 | — | R | no renderer caller; `git.diff` below covers it |
| 31 | `getGitChangeStatsForPath` | bridge.ts:321 | — | R | no renderer caller |
| 32 | `startTerminalSession` | bridge.ts:327 | `terminal.start` | M |  |
| 33 | `writeTerminalInput` | bridge.ts:332 | `terminal.write` | M | fire-and-forget (no await in callers) |
| 34 | `resizeTerminalSession` | bridge.ts:337 | `terminal.resize` | M |  |
| 35 | `hideTerminalSession` | bridge.ts:342 | `terminal.hide` | M |  |
| 36 | `promoteTerminalSessionScope` | bridge.ts:347 | `terminal.promoteScope` | M |  |
| 37 | `getGitBranches` | bridge.ts:354 | `git.branches` | Q |  |
| 38 | `getGitCurrentBranch` | bridge.ts:359 | `git.currentBranch` | Q |  |
| 39 | `getPrInfo` | bridge.ts:364 | `git.prInfo` | Q |  |
| 40 | `getSessionTurnState` | bridge.ts:369 | `sessions.turnState` | Q | live phase also derivable from `ai.subscribe`; kept for rows not open |
| 41 | `switchGitBranch` | bridge.ts:375 | `git.switchBranch` | M | echoes `gitState` |
| 42 | `createGitBranch` | bridge.ts:381 | `git.createBranch` | M |  |
| 43 | `createAgentSession` | bridge.ts:387 | `db.sessions.mutate insert → sessions.create` | T |  |
| 44 | `listAgentSessions` | bridge.ts:392 | `db.sessions (live query `where workspaceId`)` | T | per-workspace list becomes a live query |
| 45 | `listAllAgentSessions` | bridge.ts:396 | `db.sessions (snapshot/subscribe)` | T |  |
| 46 | `listBots` | bridge.ts:400 | `db.bots (snapshot/subscribe)` | T |  |
| 47 | `listBotChatPreviews` | bridge.ts:401 | `bots.chatPreviews` | Q | invalidated on `bots`/`sessions` change |
| 48 | `listBotSenderChats` | bridge.ts:405 | `bots.senderChats` | Q |  |
| 49 | `createBot` | bridge.ts:409 | `db.bots.mutate insert → bots.create` | T |  |
| 50 | `updateBot` | bridge.ts:411 | `db.bots.mutate update → bots.update` | T |  |
| 51 | `deleteBot` | bridge.ts:413 | `db.bots.mutate delete → bots.remove` | T |  |
| 52 | `announceBotChange` | bridge.ts:415 | `bots.announceChange` | M |  |
| 53 | `openBotChat` | bridge.ts:421 | `bots.openChat` | M | echoes `bots` update (sessionId) and `sessions` insert |
| 54 | `listRoutines` | bridge.ts:426 | `db.routines (snapshot/subscribe)` | T |  |
| 55 | `listRoutineRuns` | bridge.ts:430 | `db.routineRuns (live query `where routineId`)` | T |  |
| 56 | `editRoutineByChat` | bridge.ts:434 | `routines.editByChat` | M | long-running; returns reply text |
| 57 | `createRoutine` | bridge.ts:440 | `db.routines.mutate insert → routines.create` | T |  |
| 58 | `updateRoutine` | bridge.ts:442 | `db.routines.mutate update → routines.update` | T |  |
| 59 | `removeRoutine` | bridge.ts:448 | `db.routines.mutate delete → routines.remove` | T |  |
| 60 | `runRoutine` | bridge.ts:450 | `routines.run` | M | echoes `routineRuns` insert |
| 61 | `getLocalModelState` | bridge.ts:452 | `localModels.state` | Q |  |
| 62 | `installLocalModel` | bridge.ts:456 | `localModels.install` | M |  |
| 63 | `cancelLocalModelInstall` | bridge.ts:461 | `localModels.cancelInstall` | M |  |
| 64 | `removeLocalModel` | bridge.ts:463 | `localModels.remove` | M |  |
| 65 | `startOpenRouterAuth` | bridge.ts:468 | `auth.openRouter.start` | M | long-running; resolves to outcome union |
| 66 | `startAbacusAuth` | bridge.ts:472 | `auth.abacus.start` | M | long-running; outcome union kept (`cancelled`) |
| 67 | `listBrowserSignInProfiles` | bridge.ts:478 | `auth.abacus.browserProfiles` | Q |  |
| 68 | `cancelAbacusAuth` | bridge.ts:482 | `auth.abacus.cancel` | M |  |
| 69 | `openAbacusAuthInBrowser` | bridge.ts:484 | `auth.abacus.openInBrowser` | M |  |
| 70 | `cancelOpenRouterAuth` | bridge.ts:486 | `auth.openRouter.cancel` | M |  |
| 71 | `signOutAbacus` | bridge.ts:488 | `auth.abacus.signOut` | M | echoes `sessions` reset (stash) |
| 72 | `listConnectorStatuses` | bridge.ts:493 | `connectors.statuses` | Q | invalidated by `connectors.events` `status-changed` |
| 73 | `connectConnector` | bridge.ts:497 | `connectors.connect` | M |  |
| 74 | `submitConnectorFields` | bridge.ts:502 | `connectors.submitFields` | M |  |
| 75 | `cancelConnectorConnect` | bridge.ts:511 | `connectors.cancelConnect` | M |  |
| 76 | `disconnectConnector` | bridge.ts:513 | `connectors.disconnect` | M |  |
| 77 | `listSessionArtifacts` | bridge.ts:518 | `db.artifacts (snapshot/subscribe)` | T |  |
| 78 | `removeAgentSession` | bridge.ts:522 | `db.sessions.mutate delete → sessions.remove` | T |  |
| 79 | `startAgentSession` | bridge.ts:528 | `agent.start` | M | spawns the child; the AG-UI stream arrives on `ai.subscribe` |
| 80 | `stopAgentSession` | bridge.ts:533 | `agent.stop` | M |  |
| 81 | `getAgentSessionState` | bridge.ts:538 | `agent.state` | Q | live updates via `ai.subscribe` `STATE_*`/`CUSTOM session.state` |
| 82 | `sendAgentMessage` | bridge.ts:543 | `ai.send` | M | AG-UI `RunAgentInput` (threadId/runId/parentRunId/resume/forwardedProps) |
| 83 | `setAgentMode` | bridge.ts:548 | `agent.setMode` | M | also `forwardedProps.mode` on `ai.send` |
| 84 | `setAgentModel` | bridge.ts:550 | `agent.setModel` | M |  |
| 85 | `stopAgentTurn` | bridge.ts:552 | `ai.cancel` | M | ends the run with `RUN_FINISHED{outcome:cancelled}` |
| 86 | `resetAgentConversation` | bridge.ts:554 | `agent.reset` | M |  |
| 87 | `switchAgentConversation` | bridge.ts:559 | `agent.switchConversation` | M |  |
| 88 | `respondAgentPermission` | bridge.ts:564 | `ai.send (resume)` | M | approval = interrupt resume entry; `agent.respondPermission` kept as a thin alias until chat kit lands |
| 89 | `listAgentSkills` | bridge.ts:569 | `agent.skills` | Q | skills-loaded arrives as `CUSTOM skills.loaded` |
| 90 | `enqueueAgentMessage` | bridge.ts:571 | `agent.queue.enqueue` | M | queue state via `CUSTOM queue.*` on `ai.subscribe` |
| 91 | `dequeueAgentMessage` | bridge.ts:576 | `agent.queue.dequeue` | M |  |
| 92 | `getAgentQueue` | bridge.ts:581 | `agent.queue.get` | Q |  |
| 93 | `clearAgentQueue` | bridge.ts:583 | `agent.queue.clear` | M |  |
| 94 | `removeAgentQueueMessage` | bridge.ts:585 | `agent.queue.remove` | M |  |
| 95 | `updateAgentQueueMessage` | bridge.ts:590 | `agent.queue.update` | M |  |
| 96 | `renameLocalFile` | bridge.ts:595 | `files.rename` | M |  |
| 97 | `trashLocalFile` | bridge.ts:601 | `files.trash` | M |  |
| 98 | `saveResolvedConflict` | bridge.ts:606 | — | R | no renderer caller |
| 99 | `writeFile` | bridge.ts:612 | — | R | no renderer caller ("Open in editor" only) |
| 100 | `stageFile` | bridge.ts:618 | — | R | no renderer caller |
| 101 | `unstageFile` | bridge.ts:623 | — | R | no renderer caller |
| 102 | `removeWorkspace` | bridge.ts:628 | `db.workspaces.mutate delete → workspaces.remove` | T |  |
| 103 | `updateWorkspaceLabel` | bridge.ts:633 | `db.workspaces.mutate update → workspaces.rename` | T |  |
| 104 | `checkWorkspacePath` | bridge.ts:642 | `workspaces.checkPath` | Q |  |
| 105 | `relocateWorkspace` | bridge.ts:647 | `workspaces.relocate` | M | echoes `workspaces` update |
| 106 | `updateAgentSessionLabel` | bridge.ts:653 | `db.sessions.mutate update → sessions.rename` | T |  |
| 107 | `listBrowserProfiles` | bridge.ts:660 | `browser.profiles.list` | Q |  |
| 108 | `refreshBrowserProfiles` | bridge.ts:664 | — | R | no renderer caller |
| 109 | `importBrowserProfile` | bridge.ts:668 | `browser.profiles.import` | M |  |
| 110 | `clearImportedBrowserProfile` | bridge.ts:673 | — | R | no renderer caller |
| 111 | `materializeBrowserRuntime` | bridge.ts:681 | `browser.runtime.materialize` | M |  |
| 112 | `presentBrowserRuntime` | bridge.ts:686 | `browser.runtime.present` | M |  |
| 113 | `navigateBrowserRuntime` | bridge.ts:691 | `browser.runtime.navigate` | M |  |
| 114 | `captureBrowserRuntime` | bridge.ts:696 | `browser.runtime.capture` | M |  |
| 115 | `hideBrowserRuntime` | bridge.ts:701 | `browser.runtime.hide` | M |  |
| 116 | `closeBrowserRuntime` | bridge.ts:706 | `browser.runtime.close` | M |  |
| 117 | `promoteBrowserRuntimeScope` | bridge.ts:711 | `browser.runtime.promoteScope` | M |  |
| 118 | `disposeBrowserRuntimeScope` | bridge.ts:716 | — | R | no renderer caller (main disposes on navigation) |
| 119 | `disposeBrowserRuntimeWorkspace` | bridge.ts:721 | — | R | no renderer caller |
| 120 | `listMcpServers` | bridge.ts:726 | `mcp.list` | Q |  |
| 121 | `addMcpServer` | bridge.ts:730 | `mcp.add` | M |  |
| 122 | `updateMcpServer` | bridge.ts:735 | `mcp.update` | M |  |
| 123 | `removeMcpServer` | bridge.ts:740 | `mcp.remove` | M |  |
| 124 | `setMcpServerDisabled` | bridge.ts:745 | `mcp.setDisabled` | M |  |
| 125 | `importMcpServers` | bridge.ts:750 | `mcp.import` | M |  |
| 126 | `refreshMcpServers` | bridge.ts:755 | `mcp.refresh` | M |  |
| 127 | `restartMcpServer` | bridge.ts:760 | `mcp.restart` | M |  |
| 128 | `mcpOAuthSignIn` | bridge.ts:765 | `mcp.oauthSignIn` | M |  |
| 129 | `getMcpRuntimeServers` | bridge.ts:770 | `mcp.runtime.servers` | Q | live via `mcp.runtime.events` |
| 130 | `getMcpServerLogs` | bridge.ts:774 | `mcp.runtime.logs` | Q |  |
| 131 | `setBrowserEngine` | bridge.ts:778 | `browser.setEngine` | M |  |
| 132 | `connectChromeBrowser` | bridge.ts:783 | `browser.chrome.connect` | M |  |
| 133 | `disconnectChromeBrowser` | bridge.ts:787 | `browser.chrome.disconnect` | M |  |
| 134 | `setChromeExtensionToken` | bridge.ts:791 | `browser.chrome.setExtensionToken` | M |  |
| 135 | `getMcpBrowserStatus` | bridge.ts:796 | `browser.status` | Q | live via `browser.events` `status` |
| 136 | `setMcpBrowserEnabled` | bridge.ts:800 | `browser.setEnabled` | M |  |
| 137 | `getToolsetStates` | bridge.ts:805 | `settings.toolsets.get` | Q |  |
| 138 | `getDefaultAgentMode` | bridge.ts:809 | `settings.defaultMode.get` | Q |  |
| 139 | `getSandboxSupport` | bridge.ts:813 | `settings.sandboxSupport` | Q |  |
| 140 | `setDefaultAgentMode` | bridge.ts:817 | `settings.defaultMode.set` | M |  |
| 141 | `getNotificationSettings` | bridge.ts:822 | `settings.notifications.get` | Q |  |
| 142 | `setNotificationSettings` | bridge.ts:826 | `settings.notifications.set` | M |  |
| 143 | `setToolsetEnabled` | bridge.ts:831 | `settings.toolsets.setEnabled` | M |  |
| 144 | `getExecBackendState` | bridge.ts:837 | `settings.execBackend.get` | Q |  |
| 145 | `setExecBackend` | bridge.ts:841 | `settings.execBackend.set` | M |  |
| 146 | `getTerminalShellState` | bridge.ts:846 | `terminal.shell.get` | Q |  |
| 147 | `setTerminalShell` | bridge.ts:850 | `terminal.shell.set` | M |  |
| 148 | `respondConnector` | bridge.ts:855 | `connectors.respond` | M |  |
| 149 | `listConnectorRequests` | bridge.ts:860 | `connectors.requests` | Q | live via `connectors.events` |
| 150 | `listBrowserPermissionRequests` | bridge.ts:865 | `browser.permissions.list` | Q | live via `browser.events` |
| 151 | `setBrowserApproval` | bridge.ts:870 | `browser.permissions.setApproval` | M |  |
| 152 | `clearBrowserData` | bridge.ts:875 | `browser.clearData` | M |  |
| 153 | `respondBrowserPermission` | bridge.ts:880 | `browser.permissions.respond` | M |  |
| 154 | `setAgentSessionModel` | bridge.ts:885 | `db.sessions.mutate update → sessions.setModel` | T |  |
| 155 | `listMemories` | bridge.ts:896 | `db.memories (scope `global`)` | T |  |
| 156 | `getCustomInstructions` | bridge.ts:898 | `memory.customInstructions.get` | Q |  |
| 157 | `setCustomInstructions` | bridge.ts:900 | `memory.customInstructions.set` | M |  |
| 158 | `forgetMemory` | bridge.ts:905 | `db.memories.mutate delete → memory.forget` | T |  |
| 159 | `forgetAllMemories` | bridge.ts:910 | `memory.forgetAll` | M | echoes `memories` deletes |
| 160 | `listBotMemories` | bridge.ts:915 | `db.memories (scope `bot`)` | T |  |
| 161 | `forgetBotMemory` | bridge.ts:919 | `db.memories.mutate delete → memory.forgetBot` | T |  |
| 162 | `clearBotMemory` | bridge.ts:923 | `memory.clearBot` | M | echoes `memories` deletes |
| 163 | `readTranscript` | bridge.ts:927 | `ai.hydrate` | Q | returns `ChatHydrationResult` (UIMessage[]) from v2 thread files |
| 164 | `writeTranscript` | bridge.ts:931 | — | R | main persists from the AG-UI stream (`withPersistence`); legacy path dual-writes v2 until cut-over |
| 165 | `getDeviceStatus` | bridge.ts:937 | `devices.status` | Q | live via `devices.events` |
| 166 | `listLocalDevices` | bridge.ts:939 | `devices.list` | Q |  |
| 167 | `captureDeviceScreenshot` | bridge.ts:943 | `devices.screenshot` | M | binary → `Uint8Array` custom serializer |
| 168 | `bootLocalDevice` | bridge.ts:948 | `devices.boot` | M |  |
| 169 | `createLocalDevice` | bridge.ts:953 | `devices.create` | M |  |
| 170 | `refreshDeviceStatus` | bridge.ts:958 | `devices.refresh` | M |  |
| 171 | `setDevicesEnabled` | bridge.ts:962 | `devices.setEnabled` | M |  |
| 172 | `setDevicesApproval` | bridge.ts:967 | `devices.setApproval` | M |  |
| 173 | `getDeviceProjectInfo` | bridge.ts:972 | `devices.projectInfo` | Q |  |
| 174 | `interactLocalDevice` | bridge.ts:976 | `devices.interact` | M |  |
| 175 | `buildAndRunLocalDevice` | bridge.ts:981 | `devices.buildAndRun` | M | progress via `devices.events` `build-state` |
| 176 | `startDeviceStream` | bridge.ts:986 | `devices.stream.start` | M |  |
| 177 | `stopDeviceStream` | bridge.ts:991 | `devices.stream.stop` | M |  |
| 178 | `getSimulatorWindowSource` | bridge.ts:996 | `devices.simulatorWindowSource` | Q |  |
| 179 | `installMaestro` | bridge.ts:1001 | `devices.installMaestro` | M |  |
| 180 | `fetchWhisperFile` | bridge.ts:1005 | `voice.whisper.fetch` | M | progress via `voice.whisper.progress` iterator |
| 181 | `isWhisperCached` | bridge.ts:1010 | — | R | no renderer caller |
| 182 | `requestMicrophoneAccess` | bridge.ts:1012 | `voice.requestMicrophone` | M |  |
| 183 | `streamDeviceTouch` | bridge.ts:1016 | `devices.stream.touch` | M | was `ipcRenderer.send`; call without await |
| 184 | `streamDeviceKey` | bridge.ts:1018 | `devices.stream.key` | M | was `ipcRenderer.send`; call without await |
| 185 | `openScreenRecordingSettings` | bridge.ts:1020 | `system.openPrivacyPane` | M | input `{ pane: "screen-recording" }` |
| 186 | `openAccessibilitySettings` | bridge.ts:1024 | `system.openPrivacyPane` | M | input `{ pane: "accessibility" }` |
| 187 | `getMessagingSnapshot` | bridge.ts:1028 | `messaging.snapshot` | Q | invalidated by `messaging.events` `updated` |
| 188 | `updateMessagingPlatform` | bridge.ts:1032 | `messaging.updatePlatform` | M |  |
| 189 | `decideMessagingPairing` | bridge.ts:1037 | `messaging.decidePairing` | M |  |
| 190 | `updateMessagingSettings` | bridge.ts:1042 | `messaging.updateSettings` | M |  |
| 191 | `showMessagingLogin` | bridge.ts:1047 | `messaging.showLogin` | M |  |
| 192 | `pairSharedChannel` | bridge.ts:1052 | `messaging.pairShared` | M |  |
| 193 | `unlinkSharedChannel` | bridge.ts:1057 | `messaging.unlinkShared` | M |  |
| 194 | `openSharedChannelLink` | bridge.ts:1062 | `messaging.openSharedLink` | M |  |
| 195 | `onDeviceStreamChunk` | bridge.ts:1071 | `devices.stream.chunks` | S | event iterator of `DeviceStreamChunk` (input `{ streamId }`) |
| 196 | `onEvent` | bridge.ts:1078 | (split, see IpcEvent table) | S | the catch-all channel is replaced by typed iterators |

Totals: 110 M, 47 Q, 24 T, 2 S (`onEvent` is split by A.2.3), 13 R.

#### A.2.2 Top-level `window.api.*` (preload/index.ts, 50 members)

| # | Legacy `window.api.*` | Current | Procedure | Kind | Notes |
|---|---|---|---|---|---|
| 1 | `openFolderDialog` | preload/index.ts:37 | `system.dialog.openFolder` | M |  |
| 2 | `openFilesDialog` | preload/index.ts:39 | `system.dialog.openFiles` | M | `data: Buffer` → `Uint8Array` (custom serializer) |
| 3 | `readClipboardImage` | preload/index.ts:48 | — | R | no renderer caller; composer paste uses DOM clipboard |
| 4 | `fetchUrlAttachment` | preload/index.ts:54 | — | R | no renderer caller |
| 5 | `openExternal` | preload/index.ts:62 | `system.openExternal` | M | same `isSafeExternalUrl` guard |
| 6 | `openFilePath` | preload/index.ts:66 | `system.openPath` | M | same local-open-guard |
| 7 | `showItemInFolder` | preload/index.ts:69 | `system.showItemInFolder` | M |  |
| 8 | `getAppVersion` | preload/index.ts:72 | `system.info` | Q | `{ appVersion, platform, arch, versions, homeDir, paths, materialIconsBasePath, contractVersion }` |
| 9 | `showAboutPanel` | preload/index.ts:73 | `window.showAbout` | M |  |
| 10 | `isFullScreen` | preload/index.ts:74 | `window.state` | Q | `{ fullScreen, focused, maximized }` |
| 11 | `onFullScreenChange` | preload/index.ts:76 | `window.events` | S | `{ type: "state", state }` |
| 12 | `restartApp` | preload/index.ts:85 | `system.restart` | M |  |
| 13 | `getHomeDir` | preload/index.ts:87 | `system.info` | Q | `homeDir` |
| 14 | `hasGoogleChrome` | preload/index.ts:88 | `browser.hasGoogleChrome` | Q |  |
| 15 | `setThemeSource` | preload/index.ts:90 | `db.prefs `theme` (main applies `nativeTheme`)` | T | prefs row change drives `nativeTheme.themeSource` in main |
| 16 | `platform` | preload/index.ts:92 | `system.info` | Q | `platform` (was a sync preload value) |
| 17 | `reportFunnelStep` | preload/index.ts:95 | `system.funnelStep` | M | fire-and-forget |
| 18 | `getAccountState` | preload/index.ts:100 | `account.state` | Q |  |
| 19 | `skipAccountOnboarding` | preload/index.ts:102 | `account.skipOnboarding` | M |  |
| 20 | `signOutAccount` | preload/index.ts:104 | `account.signOut` | M |  |
| 21 | `forgetAccount` | preload/index.ts:106 | `account.forget` | M |  |
| 22 | `savePastedTempFiles` | preload/index.ts:110 | `files.savePastedTemp` | M | `Uint8Array` payloads; `baseFolder` dropped |
| 23 | `saveLogs` | preload/index.ts:121 | `system.logs.save` | M |  |
| 24 | `appendLogs` | preload/index.ts:127 | `system.logs.append` | M | fire-and-forget; batched client-side |
| 25 | `showNotification` | preload/index.ts:131 | `system.notify` | M |  |
| 26 | `onNotificationClicked` | preload/index.ts:137 | `system.events` | S | `{ type: "notification-clicked", metadata }` |
| 27 | `power.getKeepAwake` | preload/index.ts:149 | — | R | no renderer caller |
| 28 | `power.setKeepAwake` | preload/index.ts:151 | — | R | no renderer caller |
| 29 | `power.setAgentBusy` | preload/index.ts:154 | — | R | main derives busy from run state (AG-UI `RUN_STARTED`/`RUN_FINISHED`) instead of trusting a renderer edge |
| 30 | `update.check` | preload/index.ts:159 | `update.check` | M |  |
| 31 | `update.install` | preload/index.ts:162 | `update.install` | M |  |
| 32 | `update.getStatus` | preload/index.ts:165 | `update.status` | Q |  |
| 33 | `update.onStatusChange` | preload/index.ts:168 | `update.events` | S | `UpdateStatus` iterator; first yield is current status |
| 34 | `skills.listInstalled` | preload/index.ts:179 | `skills.listInstalled` | Q | input schema replaces `unknown` |
| 35 | `skills.searchMarketplace` | preload/index.ts:181 | `skills.search` | Q |  |
| 36 | `skills.install` | preload/index.ts:183 | `skills.install` | M |  |
| 37 | `skills.remove` | preload/index.ts:185 | `skills.remove` | M |  |
| 38 | `skills.openFile` | preload/index.ts:187 | `skills.openFile` | M |  |
| 39 | `skills.importLocal` | preload/index.ts:189 | `skills.importLocal` | M |  |
| 40 | `files.readImageAsDataUrl` | preload/index.ts:192 | `files.readImageAsDataUrl` | Q |  |
| 41 | `files.readFileAsText` | preload/index.ts:203 | `files.readText` | Q |  |
| 42 | `files.readPptx` | preload/index.ts:215 | `files.readPptx` | Q |  |
| 43 | `versions` | preload/index.ts:222 | `system.info` | Q | `versions` |
| 44 | `durableState.snapshot` | preload/index.ts:226 | `durableState.snapshot (old renderer only)` | Q | new renderer uses `db.prefs`; sync `sendSync` read stays in legacy preload |
| 45 | `durableState.set` | preload/index.ts:227 | `durableState.set (old renderer only)` | M |  |
| 46 | `durableState.remove` | preload/index.ts:230 | `durableState.set `value: null` (old renderer only)` | M |  |
| 47 | `durableState.clear` | preload/index.ts:233 | `durableState.clear (old renderer only)` | M |  |
| 48 | `reportUiActivity` | preload/index.ts:239 | `window.activity` | M | fire-and-forget; feeds the swap deferral |
| 49 | `signalRendererReady` | preload/index.ts:245 | `window.ready` | M | renderer-host also accepts this (per `webContents`) as the swap-ready signal |
| 50 | `getPathForFile` | preload/index.ts:251 | `window.abacusHost.getPathForFile` (preload, not RPC) | — | needs `webUtils` in preload; the only non-port preload export; optional on `Transport.host` |

Retired (18 total): the 13 bridge rows marked R, plus `readClipboardImage`, `fetchUrlAttachment`, `power.getKeepAwake`, `power.setKeepAwake` and `power.setAgentBusy`. All but `setAgentBusy` have no renderer caller today (`grep` over `src/renderer`, tests excluded). `setAgentBusy` moves into main: the keep-awake blocker follows `RUN_STARTED`/`RUN_FINISHED` for the threads main relays. Their `ipcMain` handlers stay until cut-over for the old renderer, and `PARITY.md` records the reason for each.

#### A.2.3 `IpcEvent` variants and other push channels → subscriptions

Every push becomes either a DB change (B) or a typed event iterator. In main, a single `MainEventBus` (A.4.3) replaces the fan-out, and the legacy `sendToRenderer` keeps running beside it.

| `IpcEvent.type` / channel | contracts.ts | New home | Payload notes |
|---|---|---|---|
| `metadata-updated` | 500 | `db.workspaces.changes` (feed notify) | — |
| `git-state-updated` | 501 | `db.gitState.changes` | — |
| `file-tree-root-updated` | 502 | `files.events` `{ type: "tree-root-changed", workspaceId }` | the renderer invalidates `files.treeRoot`/`treeChildren` |
| `terminal-output` | 504 | `terminal.output({ terminalId })` iterator of `{ data, generation }` | per terminal, so a hidden pane does not receive other panes' bytes |
| `terminal-exited` | 513 | `terminal.output` last yield `{ type: "exit", exitCode, signal }`; the iterator then returns | |
| `terminal-state-updated` | 523 | `terminal.events({ conversationKey? })` `{ type: "state", state }` | |
| `local-cli-state-updated` | 531 | `db.sessions` update (`agentStatus`, `status`) + `ai.subscribe` `CUSTOM abacus.session.state` | |
| `local-cli-ndjson` | 540 | `ai.subscribe` (AG-UI) | the NDJSON stream is not mounted on oRPC |
| `local-cli-system-ready` | 546 | `ai.subscribe` `CUSTOM abacus.session.ready` | |
| `local-cli-skills-loaded` | 551 | `ai.subscribe` `CUSTOM abacus.skills.loaded` | |
| `local-cli-session-created` | 557 | `db.sessions` insert | |
| `local-cli-session-removed` | 563 | `db.sessions` delete (+ `db.artifacts` deletes, `db.routineRuns` delete) | |
| `local-cli-session-updated` | 568 | `db.sessions` update (`label`) | |
| `local-cli-session-conversation-id-updated` | 574 | `db.sessions` update (`conversationId`) | |
| `local-cli-session-model-updated` | 580 | `db.sessions` update (`model`) | |
| `session-turn-state-updated` | 586 | `db.sessions` update (`turn`) | turn state becomes a column (B.2) |
| `session-artifacts-updated` | 591 | `db.artifacts.changes` | |
| `mcp-open-preview` | 593 | `browser.events` `{ type: "open-preview", url?, conversationKey? }` | |
| `browser-runtime-materialized` | 599 | `browser.events` `{ type: "runtime-materialized", … }` | |
| `preview-open` | 605 | `files.events` `{ type: "preview-open", path, conversationKey? }` | |
| `mcp-cursor-move` / `-click` / `-hide` | 610-612 | `browser.events` `{ type: "cursor", action, x?, y? }` | high rate; the renderer uses `experimental_liveOptions` |
| `browser-permission-request` / `-cleared` | 614, 623 | `browser.events` `{ type: "permission-request" \| "permission-cleared" }` | |
| `connector-request` / `-cleared` / `-status-changed` | 617-621 | `connectors.events` | `status-changed` invalidates `connectors.statuses` |
| `browser-status-updated` | 627 | `browser.events` `{ type: "status", status }` | |
| `browser-runtime-state-updated` | 631 | `browser.events` `{ type: "runtime-state", state }` | |
| `device-status-updated` / `device-build-state` | 635, 639 | `devices.events` | |
| `mcp-runtime-servers` / `-status` / `-log` / `-refresh-failed` / `-restart-failed` | 644-680 | `mcp.runtime.events({ sessionId? })` | |
| `messaging-updated` | 682 | `messaging.events` `{ type: "updated" }` | invalidates `messaging.snapshot` |
| `bots-updated` | 683 | `db.bots.changes` (feed notify) | coarse notice → row diff |
| `cronjobs-updated` | 684 | `db.routines.changes` (feed notify) | |
| `messaging-user-message` / `messaging-agent-message` | 688, 696 | `ai.subscribe`: a relay turn is an AG-UI run with a `role: "user"` `TEXT_MESSAGE_*` and `CUSTOM abacus.messaging.sent` | retired as separate events once the emitter lands |
| `credentials-changed` | 704 | `settings.events` `{ type: "credentials-changed", provider, configured? }` | |
| `whisper-download-progress` | 710 | `voice.whisper.progress` iterator | |
| `sessions-reloaded` | 715 | `db.sessions` `reset` batch (+ `routineRuns`, `artifacts`) | |
| `local-model-progress` | 718 | `localModels.progress` iterator | |
| `update-status` (update-service.ts:449) | — | `update.events` | first yield is the current status |
| `notification-clicked` (index.ts:1628) | — | `system.events` `{ type: "notification-clicked", metadata }` | |
| `window:full-screen-changed` (index.ts:544) | — | `window.events` `{ type: "state", state }` | only the window the port belongs to |
| `agent:device-stream-chunk` (bridge.ts:1071) | — | `devices.stream.chunks({ streamId })` | binary; see A.6 |

### A.3 AI procedures (`contract.ai`)

The thread id is the session id. Main resolves the workspace from `AgentSessionManagerService.get(sessionId)` (`agent-session-manager-service.ts:347`). All five procedures sit on an `AguiSource` interface in `main/rpc/ai/source.ts`, which the AG-UI slice implements:

```ts
interface AguiSource {
  subscribe(threadId: string, afterSeq: number | null, signal: AbortSignal): AsyncIterable<{ seq: number; event: StreamChunk }>;
  joinRun(runId: string, signal: AbortSignal): AsyncIterable<{ seq: number; event: StreamChunk }>;
  send(input: AiSendInput): Promise<{ runId: string }>;
  hydrate(threadId: string, opts: { limit?: number; before?: string }): Promise<ChatHydrationResult>;
  cancel(threadId: string, runId?: string): Promise<void>;
}
```

| Procedure | Input (valibot) | Output | Behaviour |
|---|---|---|---|
| `ai.subscribe` | `{ threadId: SessionId, lastEventId?: string }` | `eventIterator(type<StreamChunk>())` | Yields `withEventMeta(event, { id: String(seq) })`. The resume point is `input.lastEventId ?? lastEventId` (the retry-plugin header). If the point is older than the thread's replay ring, the first yield is `{ type: "CUSTOM", name: "abacus.resync" }`, then live events; the renderer adapter responds by calling `ai.hydrate`. The iterator never returns by itself. It ends when the signal aborts (port closed, component unmounted). |
| `ai.send` | `{ threadId, runId, parentRunId?, messages: v.array(UIMessageLoose), resume?: v.array(ResumeItem), forwardedProps?: v.record(v.string(), v.unknown()), clientTools?: v.array(ClientTool) }` | `{ runId: string }` | Starts the run (or queues it, per `forwardedProps.whenBusy`). It resolves once the child has accepted the run; the events arrive on `ai.subscribe`. |
| `ai.hydrate` | `{ threadId, limit?: v.number(), before?: v.string() }` | `type<ChatHydrationResult>()` | Reads `threads/<id>.json` (v2, C.3). If the file is missing, it converts `transcripts/<id>.json` (v1) on the fly with the same pure mapper, so a failed migration step never blanks a thread. |
| `ai.joinRun` | `{ runId: v.string() }` | `eventIterator(type<StreamChunk>())` | Replays the run from `RUN_STARTED`, then follows it live. Returns after `RUN_FINISHED`/`RUN_ERROR`. |
| `ai.cancel` | `{ threadId, runId?: v.string() }` | `void` | Maps to today's `stopAgentTurn`. The source guarantees a closing `RUN_FINISHED{ outcome: "cancelled" }`. |

`UIMessageLoose = v.looseObject({ id: v.string(), role: v.picklist(["system","user","assistant"]), parts: v.array(v.looseObject({ type: v.string() })) })`. Main does not re-validate the parts deeply: the agent child owns the message semantics.

### A.4 Main side

#### A.4.1 Files

```
apps/desktop/src/main/rpc/
├─ router.ts            createRouter(deps): implement(contract).router({...domain routers})
├─ context.ts           RpcContext = { transport: "message-port" | "websocket" | "memory"; webContentsId: number | null;
│                        windowKind: "main" | "notch" | "dev"; deps: RpcDeps }
├─ deps.ts              RpcDeps = { serviceHost, browserRuntime, updateService, rendererState, bus, tables, ai, windows }
├─ errors.ts            toRpcError(), unwrapResult() (A.5)
├─ event-bus.ts         MainEventBus (A.4.3)
├─ procedures/<domain>.ts  one per contract domain; thin: validate → call ServiceHost/handler helper → map result
├─ ai/source.ts         AguiSource interface + UnavailableAguiSource (throws UNAVAILABLE)
├─ tables/              B
└─ transports/
   ├─ message-port.ts   installMessagePortTransport({ router, deps, isTrustedRenderer })
   └─ websocket.ts      startWebSocketTransport({ router, deps, port }) — dev/test only (A.8)
```

`procedures/*` must not duplicate logic from `main/handler.ts`. Where a handler body in `handler.ts` does more than forward to `serviceHost` (for example `signOutAbacus`, around `handler.ts:280-296`), that body moves into a named function in `handler.ts` (or the owning service), and both the `ipcMain.handle` and the procedure call it. This is a mechanical extract-function refactor, reviewed as such.

#### A.4.2 MessagePort transport (per window)

```ts
// transports/message-port.ts
const handler = new RPCHandler(router, {
  customJsonSerializers: [uint8ArraySerializer],
  interceptors: [onError(logRpcError)],          // [rpc] <path> <code> <message>; stack only for INTERNAL
  clientInterceptors: [slowCallWarning(2_000)],
});

ipcMain.on("rpc:connect", (event, meta: unknown) => {
  const [port] = event.ports;
  if (port == null) return;
  if (!isTrustedRenderer(event)) { port.close(); return; }       // see rules below
  const contents = event.sender;
  handler.upgrade(port, { context: {
    transport: "message-port", webContentsId: contents.id,
    windowKind: parseWindowKind(meta), deps } });
  port.start();
  ports.add(contents.id, port);                                    // several per contents (HMR, reload)
  contents.once("destroyed", () => ports.closeAll(contents.id));
  contents.on("did-start-navigation", (_e, _u, sameDoc, mainFrame) => {
    if (mainFrame && !sameDoc) ports.closeAll(contents.id);        // reload: old page's iterators end
  });
});
```

Rules:

- **Trust:** `event.senderFrame === event.sender.mainFrame`, and `event.sender.id` is in the set registered by `wireRendererContents` (`main/index.ts:690`). That set holds the live view and any swap candidate. Later it also holds the notch window's contents. Webviews, the connector windows, the Abacus sign-in window (`abacus-signin-window.ts:301`) and PDF/deck windows never get ports, because `wire` never sees them.
- **One port per page load.** The renderer asks once per document (A.4.4). Closing the port (renderer reload, swap flip `renderer-host.ts:262`, window close) fires `close`. oRPC then aborts every open iterator's `signal`, and each generator's `finally` unsubscribes from the bus.
- **Swaps:** the candidate `webContents` connects while hidden. Its `ai.subscribe`/`db.*.changes` subscriptions are live before the flip. That is the same guarantee `renderer-ready` gives today (`renderer-host.ts:58-79`). `window.ready` (the procedure) resolves the same `rendererReady` promise: `RendererHost` gets a `markReady(contents)` method, so the legacy `ipc-message` path and the RPC path both work.
- **Registration** happens in `registerIpcHandlers` (`handler.ts:143`), right after `serviceHost.setEventDispatcher`, so `deps.bus` exists before the first connect.

#### A.4.3 Event bus

`MainEventBus` wraps `EventPublisher<MainEvents>` (`@orpc/server`). `MainEvents` is keyed by channel: `"ipc"` (legacy `IpcEvent`), `"update"`, `"window:<id>"`, `"system"`, `"device-chunk:<streamId>"`. There is a single entry point:

```ts
// main/rpc/event-bus.ts
export const emitIpcEvent = (event: IpcEvent): void => {
  sendToRenderer(IpcChannels.Event, event);   // legacy renderer, unchanged
  bus.publish("ipc", event);                   // routed to domain iterators + table feeds
};
```

- `handler.ts:144-146` dispatches through `emitIpcEvent`. The direct senders listed under "Where things are today" switch to `emitIpcEvent` or `bus.publish`, keeping their legacy `send`.
- Domain iterators subscribe with `bus.subscribe("ipc", { signal, maxBufferedEvents: 1_000 })` and filter by type. If an iterator overflows its buffer, that is logged once per subscription. These notices are advisory: the renderer refetches on its next invalidation.
- DB feeds do **not** read from `EventPublisher` iterators. They subscribe with callbacks (`bus.subscribe("ipc", listener)`) and run their own lossless per-subscriber queue (B.4), because a dropped change would corrupt a collection.

#### A.4.4 Preload handshake

File: `apps/desktop/src/preload/rpc-port.ts`, installed from `preload/index.ts` before the `contextBridge` call.

```ts
export const installRpcPortHandshake = (ipcRenderer: IpcRenderer, win: Window, kind: "main" | "notch"): void => {
  win.addEventListener("message", (event) => {
    if (event.source !== win) return;                                  // same window only
    const data = event.data as { type?: unknown; nonce?: unknown };
    if (data?.type !== "abacus:rpc-connect" || typeof data.nonce !== "string") return;
    const { port1, port2 } = new MessageChannel();
    ipcRenderer.postMessage("rpc:connect", { kind }, [port1]);        // → MessagePortMain in main
    win.postMessage({ type: "abacus:rpc-port", nonce: data.nonce }, "*", [port2]);
  });
};
```

- **The renderer initiates, the preload answers.** A preload-initiated post can fire before the page's module scripts have attached a listener, and the message is then lost. With a request/response keyed by `nonce`, there is no race, and each request (reload, Vite HMR full reload) gets a fresh channel.
- `"*"` as the target origin is safe here: posting to your own `window` only reaches that window, and `event.source === win` filters out frames.
- This is Electron's documented pattern for handing a port to the main world of a context-isolated page (a port created in the isolated world and transferred with `window.postMessage`). The page never sees `ipcRenderer`.
- The preload also exposes `window.abacusHost = { getPathForFile }` (`webUtils.getPathForFile`, moved from `preload/index.ts:251`). The WebSocket transport has no equivalent; a web mode would upload bytes instead.
- `window.api` stays exposed and unchanged until cut-over.

#### A.4.5 Window/system facts as procedures

`system.info` returns everything the renderer read synchronously before:

```ts
{ appVersion, platform, arch, versions, homeDir, paths: { home, sessionHome, botHome }, materialIconsBasePath, contractVersion: CONTRACT_VERSION, foundationApi: FOUNDATION_API }
```

The renderer's `__root` loader awaits it once (`ensureQueryData`, `staleTime: Infinity`). Chrome insets are not procedures: Window Controls Overlay geometry comes from CSS `env(titlebar-area-*)` (PLAN, Window chrome). `window.state` and `window.events` are scoped to the caller's window through `context.webContentsId`.

### A.5 Error model

`shared/contract/errors.ts`:

| Code | Status | `data` | When | Renderer handling |
|---|---|---|---|---|
| `BAD_REQUEST` | 400 | `ValidationError` issues (oRPC built-in) | Input failed its valibot schema | Bug: toast in development, log in production |
| `NOT_FOUND` | 404 | `{ entity: "session" \| "workspace" \| "bot" \| "routine" \| "terminal" \| "thread" \| "file", id }` | The referenced row is gone | The route's `notFound`; the collection re-snapshots |
| `CONFLICT` | 409 | `{ reason: string }` | Run already active, duplicate id, stale edit (memory `entry` mismatch) | Inline message; the optimistic write rolls back |
| `PRECONDITION_FAILED` | 412 | `{ reason: "workspace-missing" \| "not-signed-in" \| "no-credentials" \| "git-unavailable", detail? }` | `WORKSPACE_MISSING_ERROR` (`contracts.ts:372`) and friends | A feature card, such as "workspace missing" |
| `FORBIDDEN` | 403 | `{ reason }` | local-open-guard refusal, untrusted path, write to a read-only field | Toast |
| `UNAVAILABLE` | 503 | `{ retryAfterMs? }` | Service not initialised yet; `ai.*` before the emitter lands | Query retry (3× backoff) |
| `TIMEOUT` | 504 | `{ ms }` | The child did not answer (agent start timeout) | Retry affordance |
| `INTERNAL_SERVER_ERROR` | 500 | — | Anything thrown and not mapped | Error boundary; `onError` logs the stack in main |

Rules:

- Every contract procedure is built from `base = oc.errors(COMMON_ERRORS)`, so `isDefinedError(error)` narrows every code on the client (`@orpc/client`).
- **Result objects:** legacy results shaped `{ success: false, error }` (`AddWorkspaceResult`, `RelocateWorkspaceResult`, `SwitchGitBranchResult`, `CreateGitBranchResult`, `Rename/TrashLocalFileResult`, `update.check/install`, `saveLogs`, `savePastedTempFiles`, `files.read*`) are unwrapped in the procedure layer with `unwrapResult(result, mapReason)`. It returns the success payload or throws the mapped `ORPCError`. The legacy IPC handlers keep the old shape.
- **Outcome unions the UI branches on** stay as outputs, not errors: `AbacusAuthOutcome` and `OpenRouterAuthOutcome` (`cancelled`), `LocalModelInstallOutcome`, `ConnectorOutcome`, `McpRuntimeRequestResult`, `ReferralInviteOutcome`, `TurnFeedbackOutcome`.
- **Iterator errors:** a stream that fails after its first yield throws an `ORPCError`, which the client's `for await` receives. A benign end (terminal exit, run finished) returns normally.
- No error `message` carries secrets. `logRpcError` redacts `apiKey`, `token` and `authorization` fields from `input` before logging.

### A.6 Serialization

- `uint8ArraySerializer: StandardRPCCustomJsonSerializer` (`type: 100`, `condition: v => v instanceof Uint8Array`, which covers `Buffer`; `serialize` produces base64; `deserialize` returns a `Uint8Array`). Both `RPCHandler` and `RPCLink` register it through `customJsonSerializers`. Contract output types say `Uint8Array`, never `Buffer`, because the renderer has no `Buffer`. Legacy types that say `Buffer` (`preload/index.ts:44`, `:49`, `:58`) are re-declared as `Uint8Array` in the contract.
- Device stream chunks (`DeviceStreamChunk.data`, `contracts.ts:1037-1044`) go through the same serializer. Acceptance includes a measurement (A-T8): 60 fps H.264 chunks from `devices.stream.chunks` must stay under 5 ms median serialize + deserialize per chunk on an M-series Mac. If they do not, the fallback is written down here but not built: a second, raw `MessageChannel` negotiated by the same handshake (`type: "abacus:raw-port", purpose: "device-stream"`), carrying structured-clone `Uint8Array`s outside oRPC.
- `Date` stays ISO strings in rows (today's stores already use strings or epoch ms). Nothing in rows relies on the `Date` serializer.

### A.7 Renderer `Transport` (zero Electron imports)

Files: `apps/desktop/src/renderer/data/transport/`

```ts
// types.ts
export type AppClient = ContractRouterClient<Contract>;                 // @orpc/contract
export type AppQueryUtils = RouterUtils<AppClient>;                     // @orpc/tanstack-query
export interface Transport {
  readonly kind: "message-port" | "websocket" | "memory";
  readonly client: AppClient;
  readonly orpc: AppQueryUtils;                                         // createTanstackQueryUtils(client)
  readonly host: { getPathForFile?: (file: File) => string };           // from window.abacusHost when present
  close(): void;
}

// message-port.ts
export const connectMessagePortTransport = async (
  opts: { win?: Window; timeoutMs?: number; kind?: "main" | "notch" } = {}
): Promise<Transport>
//  1. nonce = crypto.randomUUID(); listen for { type: "abacus:rpc-port", nonce } with event.source === win
//  2. win.postMessage({ type: "abacus:rpc-connect", nonce }, "*")
//  3. resolve with event.ports[0]; reject with TransportUnavailableError after timeoutMs (default 5_000)
//  4. link = new RPCLink({ port, customJsonSerializers: [uint8ArraySerializer] }); port.start()
//  5. client = createORPCClient<AppClient>(link); orpc = createTanstackQueryUtils(client)

// websocket.ts — later web mode, dev smoke only now
export const createWebSocketTransport = (url: string): Transport     // RPCLink from @orpc/client/websocket + ClientRetryPlugin

// memory.ts — tests
export const createMemoryTransport = (router, context): Transport     // real MessageChannel + RPCHandler + RPCLink in-process
```

- `renderer/data/transport/index.ts` exports `getTransport(): Promise<Transport>`, a module-level singleton whose promise is created on first call. `__root.tsx` awaits it in `beforeLoad` and puts `transport` in the router context. Nothing else reads `window.*`.
- A guard test (A-T7) fails if any file under `src/renderer/data/**` or `src/shared/contract/**` imports `electron` or references `window.api`.
- The old renderer may import `getTransport` too. Both paths work at the same time, and no old-renderer code is required to move in this slice.

### A.8 WebSocket adapter (dev smoke only)

`main/rpc/transports/websocket.ts` exports `startWebSocketTransport({ router, deps, host: "127.0.0.1", port })`. It creates a `WebSocketServer` from `ws`, and each connection gets `new RPCHandler(router, { customJsonSerializers }).upgrade(ws, { context: { transport: "websocket", webContentsId: null, windowKind: "dev", deps } })` from `@orpc/server/ws`.

- It is not wired into `main/index.ts`. The only callers are the smoke test (A-T5) and an opt-in development script, `scripts/rpc-ws-smoke.mjs`. The router must work with `webContentsId: null`: window-scoped procedures (`window.*`) throw `FORBIDDEN` over this transport.
- It binds to loopback only and requires a random token in the first message (`?token=` query checked in `wss.on("connection")`), even in development.

### A.9 Files to add or change (A)

| Path | Change |
|---|---|
| `apps/desktop/package.json` | add `@orpc/server`, `@orpc/client`, `@orpc/contract`, `@orpc/tanstack-query` (1.15.4 exact), `valibot` |
| `apps/desktop/src/shared/contract/**` | new (A.1) |
| `apps/desktop/src/shared/experience.ts:11` | `FOUNDATION_API = 2`; the experience updater then refuses an old renderer on this shell, and a new renderer on an old shell (also bump `apps/updater/src/manifest.ts` as that comment requires) |
| `apps/desktop/src/main/rpc/**` | new (A.4) |
| `apps/desktop/src/main/handler.ts` | dispatcher → `emitIpcEvent` (144-146); `installMessagePortTransport` after it; extract multi-line handler bodies the procedures reuse |
| `apps/desktop/src/main/renderer-host.ts` | `markReady(contents)` for `window.ready`; export the trusted-contents registry |
| `apps/desktop/src/main/index.ts` | `wireRendererContents` registers contents as trusted (690); full-screen and notification senders → bus (544, 1628) |
| `main/services/mcp/mcp-agent-tools-server.ts:1164`, `mcp-browser-server.ts:703,1413`, `browser/electron-browser-runtime.ts:750`, `updates/update-service.ts:449` | send through `emitIpcEvent` / `bus.publish` as well |
| `apps/desktop/src/preload/rpc-port.ts` (new), `preload/index.ts`, `preload/index.d.ts` | handshake; `abacusHost.getPathForFile` |
| `apps/desktop/src/renderer/data/transport/**` | new (A.7) |
| `apps/desktop/scripts/rpc-ws-smoke.mjs` | new, development only |

### A.10 Test plan (A)

| Id | Project | Test |
|---|---|---|
| A-T1 | shared | `contract.types.test.ts`: `expectTypeOf` for (a) every input schema that mirrors a `contracts.ts` request type (both directions), (b) `ContractRouterClient<Contract>` for a sample of each kind (query returns `Promise<T>`, stream returns `AsyncIteratorClass<E>`), (c) `isDefinedError` narrows `NOT_FOUND.data.entity`. Run by `tsc -b` (`typecheck` script) and vitest. |
| A-T2 | main | `message-port.test.ts`: Node `MessageChannel` + `RPCHandler`/`RPCLink` (the real adapters) + `createRouter` over fakes. Covers a round-trip query, a mutation, a `BAD_REQUEST` on bad input, a mapped `NOT_FOUND`, `Uint8Array` round-trip, iterator cancel via `AbortController` running the generator's `finally`, and port `close` aborting every open iterator. |
| A-T3 | main | `connect.test.ts`: `ipcMain.on("rpc:connect")` rejects (closes the port) for a subframe sender and for an unregistered `webContents`; accepts a registered one; `destroyed` and main-frame navigation close its ports. Electron is mocked the same way as `handler.test.ts`. |
| A-T4 | preload | `rpc-port.test.ts`: fake `window`/`ipcRenderer`. It checks that the handshake answers only same-window messages with a matching `type`; that each request gets a new channel and echoes the nonce; that `ipcRenderer.postMessage` receives `port1`; and that `window.api` is still exposed. |
| A-T5 | main | `websocket.smoke.test.ts`: starts `startWebSocketTransport` on port 0 with fakes, connects `@orpc/client/websocket`, calls `system.info`, subscribes to `db.bots.changes`, triggers a fake change, receives the batch, and checks that `window.state` gives `FORBIDDEN`. No `electron` import is reachable: the test runs with `electron` mocked to throw on import. |
| A-T6 | preload | `parity.test.ts`: builds `createBridge(fakeIpc)` and the top-level `api` keys, and asserts that every key has an entry in `LEGACY_BRIDGE_MAP` (procedure path exists in `contract`, or `retired` with a non-empty reason). It also asserts that every `IpcEvent["type"]` appears in `LEGACY_EVENT_MAP`. It writes `docs/rewrite/PARITY.md` when `UPDATE_PARITY=1`. |
| A-T7 | renderer | `transport-guard.test.ts`: static scan of `src/renderer/data/**` and `src/shared/contract/**` for `from "electron"`, `window.api`, `ipcRenderer`. |
| A-T8 | main-serial | `serializer.bench.test.ts`: 1,000 × 64 KB `Uint8Array` through handler/link over `MessageChannel`, reporting the median. Informational: it fails only above 20 ms median, and the 5 ms target is recorded in the PR. |

### A.11 Acceptance (A)

- [ ] `pnpm --filter desktop typecheck` and `test:unit` are green; A-T1…A-T8 pass.
- [ ] The app launches, and the old renderer works unchanged: legacy IPC is untouched, and events still arrive on `IpcChannels.Event`.
- [ ] From the renderer DevTools console, `(await import("/src/renderer/data/transport/index.ts")).getTransport()` resolves. `transport.client.system.info()` returns the platform and versions. `for await (const b of transport.client.db.bots.changes({}))` yields after creating a bot in the old UI (this needs B; in PR A the check is `update.events`).
- [ ] A renderer reload and an experience swap each leave exactly one live port per `webContents` (a debug counter in `ports`), and no iterator leaks: the bus subscriber count returns to its baseline.
- [ ] `PARITY.md` is generated, and every row has a procedure or a retire reason.
- [ ] `FOUNDATION_API` is bumped in both places, and an experience built for 1 is refused (existing integrity test extended).

### A.12 Risks (A)

- **Handshake ordering under `sandbox: false`.** The page could in theory post `rpc-connect` before the preload has installed its listener. The preload runs before any page script, so this cannot happen for our own documents. The renderer still retries the post once after 250 ms if no answer has come.
- **oRPC 1.x churn.** The TanStack Query stream helpers are `experimental_*`. Only `queryOptions`/`mutationOptions`/`key` are used in Phase 1. Stream-to-query use is limited to low-rate notices (cursor, status), behind one wrapper in `renderer/data/queries/live.ts`.
- **Event bus back-pressure.** `EventPublisher` drops the oldest events past `maxBufferedEvents`. That is fine for notices, but tables and AG-UI do not use it (B.4, AG-UI ring).
- **Two sources of truth during the transition.** The legacy `IpcEvent` and the bus are fed from one function, so they cannot diverge. Any new sender must use `emitIpcEvent`. An oxlint `no-restricted-syntax` rule flags `sendToRenderer(IpcChannels.Event` outside `event-bus.ts`.
- **Device stream throughput** (A.6). The measured fallback is specified but not built.
- **`strictNullChecks: false` in `tsconfig.main.json`.** `shared/contract` is compiled by both the main and renderer projects, so it must compile cleanly under both. A-T1 runs under the renderer config (strict).

---

## B. DB tables over the transport

### B.1 Wire protocol (all tables)

Each table `<t>` has two read procedures and zero or more mutation procedures under `contract.db.<t>`:

```ts
type Epoch = string;                                  // random per main-process start
type Change<Row, Key> =
  | { type: "insert"; key: Key; value: Row }
  | { type: "update"; key: Key; value: Row }          // always the full row (rowUpdateMode: "full")
  | { type: "delete"; key: Key };
type ChangeBatch<Row, Key> =
  | { kind: "hello"; epoch: Epoch; seq: number }      // first yield of every changes() stream
  | { kind: "changes"; epoch: Epoch; seq: number; changes: Change<Row, Key>[] }   // seq = previous + 1
  | { kind: "reset"; epoch: Epoch; seq: number };     // "your copy is invalid; re-snapshot"

db.<t>.snapshot : base.input(v.object({})).output(type<{ epoch: Epoch; seq: number; rows: Row[] }>())
db.<t>.changes  : base.input(v.object({})).output(eventIterator(type<ChangeBatch<Row, Key>>()))
db.<t>.insert / update / delete : base.input(<valibot>).output(type<{ seq: number; key: Key }>())
```

- `seq` is per table, starts at 0 for each epoch, and advances by exactly 1 per `changes`/`reset` batch. `snapshot().seq` is the seq of the last batch already folded into `rows`.
- **Race-free start:** the feed registers the subscriber before it yields `hello`. The client asks for the snapshot only after it has received `hello`, so every change after `snapshot().seq` is guaranteed to arrive on the stream. Batches with `seq <= snapshot.seq` are dropped. A batch with `seq > lastSeq + 1` is a gap: the client re-snapshots. A different `epoch` (main restarted, WebSocket reconnect) is treated as `reset`.
- **Mutation echo:** a mutation procedure applies the write through the owning store, runs the table's diff synchronously, publishes the resulting batch, and only then returns `{ seq }`, the batch that contains the echo. The renderer handler resolves once its collection has applied `seq` (B.3). If the write changed nothing (idempotent), it returns the current seq.
- Updates always carry the whole row. Rows are small: the largest is a routine with `recentRuns` capped at 20.

### B.2 Tables

All row types live in `shared/contract/rows.ts`. Keys are strings.

| Table | Row type | Key | Snapshot source (main) | Fed by (change triggers) | Mutations → store |
|---|---|---|---|---|---|
| `sessions` | `SessionRow = AgentSessionListItem & { turn: { phase: SessionTurnPhase; isBusy: boolean; updatedAt: string } \| null }` (`contracts.ts:341-372`, `468-474`) | `id` | `AgentSessionManagerService.listAll()` (`agent-session-manager-service.ts:301`) joined with ServiceHost's turn-state map (emitted at `service-host.ts:1456`) | IPC events `local-cli-session-created/removed/updated/model-updated/conversation-id-updated`, `local-cli-state-updated`, `session-turn-state-updated`; `sessions-reloaded` → `reset`; plus a direct hook: `AgentSessionManagerService` gets an `onChanged` callback fired from `persist()` (`agent-session-manager-service.ts:526`), which covers `setRunOutcome`, `rehome`, `updateWorktree` and other writes that emit no event today | `insert` `{ id?: SessionId, workspaceId }` → `serviceHost.createAgentSession` (honours a client id when it is valid and unused, otherwise `CONFLICT`). `update` `{ id, patch: { label?, model? } }` → `updateAgentSessionLabel` / `setAgentSessionModel`; any other field → `FORBIDDEN` ("read-only field"). `delete` `{ id }` → `removeAgentSession` |
| `bots` | `BotRow = Bot` (`shared/bots.ts:8-35`) | `id` | `listBots()` (`bots/bot-store.ts:60`) | `bots-updated` (`service-host.ts:1124,1524,2097`) + an `onWrite` hook in `bot-store.ts` `write()` (`:55`). Only main writes `bots.json`; nothing in `packages/agent` does. | `insert` `BotCreateInput & { id?: BotId }` → `createBot` (`bot-store.ts:65`, which gains an optional id). `update` `{ id, patch: BotUpdateInput }` → `updateBot` (`:98`, via ServiceHost so the change notice still fires). `delete` → `deleteBot` |
| `routines` | `RoutineRow = Omit<RoutineListItem, "runs"> & { recentRuns: CronRun[] }` (at most 20, newest first; `shared/routines.ts:15-43`, `cron-store.ts:16-47`) | `id` | `serviceHost.listRoutines()` (`service-host.ts:3573`) | `cronjobs-updated` (the `onCronChanged` and webhook relay callbacks at `service-host.ts:640-645`, `:714-722`, and every other emit site) + a 60 s re-diff from the cron scheduler tick (`service-host.ts:3316`), because `nextRunAt` is derived from the clock | `insert` `RoutineCreateInput & { id?: RoutineId }` → `createRoutine`. `update` `{ id, patch: RoutineUpdateInput }` → `updateRoutine`. `delete` → `removeRoutine`. Fire → `routines.run` (plain mutation) |
| `routineRuns` | `RoutineRunRow = RoutineRunItem & { routineId: string }` (`contracts.ts:321-328`) | `sessionId` | derived: `listAll()` sessions with `routineId != null && editorFor == null`, mapped as in `service-host.ts:3559-3570` | recomputed whenever the `sessions` feed publishes | read-only |
| `artifacts` | `SessionArtifact` (`contracts.ts:480-493`) | `id` (`${sessionId}::${location}`) | `SessionArtifactsService.list()` (`session-artifacts-service.ts:56`) | its `onChanged` dependency (`session-artifacts-service.ts:35`), wired at `service-host.ts:1145` | read-only (removed with their session) |
| `memories` | `MemoryRow = { id; scope: "global" \| "bot"; target: MemoryTargetId \| null; botId: string \| null; botName: string \| null; index: number; entry: string }` | `id` (below) | `listMemories()` (`agent-tools/memory-store.ts:413`) + `listBotMemories()` (`bots/bot-memory-store.ts:60`) | main's own forget calls (`service-host.ts:2354,2378`, `clearBotMemory`) + `fs.watch` on `~/.abacusai-bot/memories/` and each `bots/<id>/` directory (debounced 150 ms), because the agent child writes these files itself (`packages/agent/src/memory-store.ts`, `bot/bot-memory.ts`) | `delete` `{ id }` → `forgetEntryAt(target, index, entry)` / `forgetBotMemoryEntry(botId, index, entry)`, using the row's current `index` and `entry` (the existing stale-click guard, `contracts.ts:1136-1141`). Inserts come from the agent (`remember`), so there is no `insert`. `memory.forgetAll` and `memory.clearBot` stay plain mutations. |
| `workspaces` | `WorkspaceRow = WorkspaceListItem & { isActive: boolean }` (`contracts.ts:51-60`) | `id` | `WorkspaceService.getWorkspaces()` / `getActiveWorkspaceId()` (`workspace/workspace-service.ts:88,92`) | `metadata-updated` (`workspace-runtime-service.ts:380`) + an `onChanged` hook in `WorkspaceService`'s store writes (add, remove, rename, switch, markDeleted) | `update` `{ id, patch: { label } }` → `updateWorkspaceLabel`. `delete` → `removeWorkspace`. No `insert`: the id is derived in main from the path, so creation goes through `workspaces.add` and the row arrives as an insert. |
| `gitState` | `GitStateRow = GitStateSnapshot & { workspaceId: string }` (`contracts.ts:181-187`) | `workspaceId` | `serviceHost.getGitState()` (served at `handler.ts:302`) for the active workspace | `git-state-updated` (`workspace-runtime-service.ts:384`). A change of active workspace deletes the old row and inserts the new one. Today only the active workspace is computed, so the table holds at most one row. | read-only (`git.*` mutations echo here) |
| `prefs` | `PrefsRow` (below) | `"app"` | new `PrefsStore` (`main/services/config/prefs-store.ts`, file `~/.abacusai-bot/prefs.json`, atomic writes via `writeFileAtomicSync`) | its own writes | `update` `{ patch: PrefsPatch }` (valibot, every field optional, unknown keys rejected). No `insert`/`delete`: the row always exists and is created with defaults on first read. |

`MemoryRow.id` is `${scope}:${botId ?? target}:${sha256(entry).slice(0, 16)}:${n}`, where `n` counts earlier identical entries in the same list. It stays stable when an earlier entry is removed; only `index` changes, which is an `update`.

```ts
// shared/contract/rows.ts
export interface PrefsRow {
  id: "app";
  theme: "system" | "light" | "dark";
  language: string;                                   // BCP-47, default "en-US"
  sidebar: { pinned: boolean; openSection: "bots" | "routines" | "sessions" | null };
  pinned: { sessionIds: string[]; botIds: string[] };
  models: { selectedModelId: string | null; favoriteModelIds: string[]; perWorkspace: Record<string, string | null> };
  defaultMode: AgentMode;                             // default AgentMode.Yolo, as code-store.ts:120
  workspaceExpanded: Record<string, boolean>;
  lastPickedWorkspaceId: string | null;
  recentFolders: string[];                            // ≤ 5
  creditsExhaustedAt: number | null;
  browserHomepage: string | null;
  onboardingStep: string | null;
  dismissals: { referralCardUntil: number | null; upsell: boolean };
  panes: Record<string, number>;                      // panel widths, new
  motion: { reduce: "system" | "on" | "off" };        // new
  sounds: { enabled: boolean; perEvent: Record<string, boolean> };  // new, defaults on
  updatedAt: string;
}
```

Main side effects of `prefs`: `theme` drives `nativeTheme.themeSource`, replacing the `theme:set` handler for the new renderer (`preload/index.ts:90`). Nothing else in main reads prefs in this slice.

### B.3 Renderer: `ipcCollectionOptions`

File: `apps/desktop/src/renderer/data/collections/ipc-collection-options.ts`. One file per table in the same folder (`sessions.ts`, `bots.ts`, …, `prefs.ts`) calls `createCollection(ipcCollectionOptions({...}))` at module level with a lazy transport.

```ts
interface IpcTableClient<Row, Key> {
  snapshot(input: {}, opts: { signal }): Promise<{ epoch: string; seq: number; rows: Row[] }>;
  changes(input: {}, opts: { signal }): Promise<AsyncIterable<ChangeBatch<Row, Key>>>;
  insert?(input: unknown): Promise<{ seq: number; key: Key }>;
  update?(input: unknown): Promise<{ seq: number; key: Key }>;
  delete?(input: unknown): Promise<{ seq: number; key: Key }>;
}

export function ipcCollectionOptions<Row extends object, Key extends string>(cfg: {
  id: string;                                          // "sessions", …
  table: () => Promise<IpcTableClient<Row, Key>>;      // resolves transport.client.db.<t>
  getKey: (row: Row) => Key;
  toInsertInput?: (row: Row) => unknown;
  toUpdateInput?: (key: Key, changes: Partial<Row>, modified: Row) => unknown;
  toDeleteInput?: (key: Key, original: Row) => unknown;
  echoTimeoutMs?: number;                              // default 10_000
}): CollectionConfig<Row, Key> & { utils: { awaitSeq(seq: number): Promise<void>; resync(): Promise<void>; status(): SyncStatus } }
```

**`sync.sync({ begin, write, commit, markReady, markError, truncate, collection })`**, per the TanStack DB contract (`db/packages/db/src/types.ts:422-490`; guide "Sync Implementation"):

1. Create an `AbortController`. Open `changes()` and start a consumer loop immediately. Until the first snapshot has been applied, every batch after `hello` is pushed onto `buffer`.
2. On `hello`, record `epoch` and call `loadSnapshot({ initial: true })`.
3. `loadSnapshot({ initial })`:
   - `const s = await table.snapshot()`
   - `begin()`
   - if `!initial`, call `truncate()` (it must run inside the open transaction; `sync.ts:315-348` throws otherwise)
   - `write({ type: "insert", value })` for each row
   - `commit()`, then `lastSeq = s.seq; epoch = s.epoch`
   - flush `buffer`: drop batches with `seq <= lastSeq`, apply the rest in order (step 4)
   - if `initial`, call `markReady()` exactly once
   - resolve `awaitSeq` waiters `<= lastSeq`
4. `apply(batch)`:
   - `reset`, or a different epoch → `resync()`
   - `seq <= lastSeq` → ignore
   - `seq !== lastSeq + 1` → `resync()` (gap)
   - otherwise `begin()`, then for each change: `insert`/`update` → `write({ type, value })`; `delete` → `write({ type: "delete", key })`. Then `commit()`, set `lastSeq = seq`, and resolve waiters.
5. `resync()` is single-flight: it sets `resyncing = true`, buffers incoming batches, and calls `loadSnapshot({ initial: false })`.
6. **Errors:** if the initial snapshot fails while `collection.status === "loading"`, call `markError(error)`. A later failure keeps the last good rows. A failed resync is retried with backoff (0.5 s, 1 s, 2 s, then every 5 s). If the stream itself throws, reopen `changes()` and resync on its `hello`.
7. **Cleanup:** return `() => abort.abort()`. That ends the oRPC iterator, and main's feed unsubscribes in `finally`.
8. `rowUpdateMode: "full"`. `startSync: true` for `prefs`, `workspaces` and `sessions` (the shell needs them at once); lazy for the others (`collection.preload()` from route loaders).

**Mutations** (Pattern A with a built-in echo wait):

```ts
onInsert: async ({ transaction }) => {
  for (const m of transaction.mutations) {
    const { seq } = await (await cfg.table()).insert!(cfg.toInsertInput!(m.modified));
    await utils.awaitSeq(seq);        // resolves when lastSeq >= seq; rejects on echoTimeoutMs → triggers resync()
  }
},
onUpdate: /* same, with toUpdateInput(m.key, m.changes, m.modified) */,
onDelete: /* same, with toDeleteInput(m.key, m.original) */,
```

- A thrown `ORPCError` (such as `CONFLICT`) rejects the handler, and TanStack DB rolls the optimistic state back.
- On an echo timeout, the write did happen on the server. The handler therefore calls `resync()`, awaits it, and **resolves**, so the optimistic state is replaced by the fresh snapshot instead of being rolled back.
- A table without a given procedure has no handler for it. Calling `collection.insert` on such a table then throws TanStack's "no onInsert handler" error, which is what we want.
- Client-generated ids come from `crypto.randomUUID()`, and `toInsertInput` passes them through.

### B.4 Main: `TableFeed`

File: `apps/desktop/src/main/rpc/tables/table-feed.ts`. One instance per table, created in `rpc/tables/index.ts` (`createTables(deps)`):

```ts
class TableFeed<Row, Key extends string> {
  constructor(opts: { name: string; read: () => Row[] | Promise<Row[]>; getKey: (r: Row) => Key; equals?: (a: Row, b: Row) => boolean });
  readonly epoch: string;                 // crypto.randomUUID() at construction
  notify(): void;                         // coalesced: one re-read + diff per microtask/tick (setImmediate)
  notifyNow(): Promise<number>;           // re-read + diff synchronously; returns the seq that includes it (used by mutations)
  reset(): void;                          // publish { kind: "reset" } and re-baseline
  snapshot(): { epoch; seq; rows };       // from the cached baseline, not a fresh read (so seq and rows agree)
  subscribe(signal): AsyncIterable<ChangeBatch>;   // registers, yields hello, then an unbounded per-subscriber queue
}
```

- `equals` defaults to a stable JSON comparison. A diff with no changes publishes nothing and does not advance `seq`.
- Per-subscriber queues are unbounded. If a queue passes 5,000 batches (a stuck renderer), the feed drops the queue and ends the stream with `reset`, and the client re-snapshots.
- Derived tables (`routineRuns`) are `TableFeed`s whose `read` is computed from the `sessions` baseline. `sessions.notify` chains `routineRuns.notify`.
- **Triggers:** `createTables` subscribes to `bus` (`"ipc"`) and maps event types to `notify()` calls (the table in B.2). It also installs the direct hooks (`onChanged`/`onWrite`) that B adds to `AgentSessionManagerService`, `bot-store`, `WorkspaceService` and `PrefsStore`, plus the memory `fs.watch`ers. Over-notifying is harmless (diff-based), and under-notifying is what the direct hooks prevent.
- Procedures: `db.<t>.snapshot` → `feed.snapshot()`. `db.<t>.changes` → `async function* ({ signal }) { yield* feed.subscribe(signal) }`. Mutations → call the ServiceHost method, then `return { seq: await feed.notifyNow(), key }`.

### B.5 Files to add or change (B)

| Path | Change |
|---|---|
| `apps/desktop/package.json` | add `@tanstack/db` 0.10.0 |
| `shared/contract/rows.ts`, `shared/contract/db.ts` | row types, valibot mutation inputs, table procedures |
| `main/rpc/tables/{table-feed,index,sessions,bots,routines,routine-runs,artifacts,memories,workspaces,git-state,prefs}.ts` | new |
| `main/services/config/prefs-store.ts` | new (defaults, atomic write, `onChanged`) |
| `main/services/session/agent-session-manager-service.ts` | `onChanged` callback fired from `persist()` (`:526`) |
| `main/services/bots/bot-store.ts` | optional client id in `createBot`; `onWrite` hook (`:55`) |
| `main/services/agent-tools/cron-store.ts` | optional client id in `createJob` (`:248`) |
| `main/services/workspace/workspace-service.ts` | `onChanged` hook around its store writes |
| `main/service-host.ts` | expose the turn-state map getter; `createAgentSession` accepts an optional id |
| `renderer/data/collections/**` | `ipcCollectionOptions` + one module per table |

### B.6 Test plan (B)

| Id | Project | Test |
|---|---|---|
| B-T1 | renderer (node env acceptable) | `ipc-collection-options.test.ts` with a **fake table client** (a controllable async queue plus deferred snapshot) and the real `createCollection` from `@tanstack/db`. Cases: (1) batches buffered during the snapshot are applied after it, in order; (2) batches with `seq <= snapshot.seq` are dropped; (3) a gap causes one resync with `truncate`, and the collection equals the new snapshot; (4) `reset` truncates and reloads; (5) an epoch change on reconnect is treated as reset; (6) `markReady` is called exactly once, and `markError` on initial failure; (7) cleanup aborts the stream (the fake records `signal.aborted`); (8) the `onInsert` promise resolves only after the echo batch is applied (asserted with a deferred echo); (9) a `CONFLICT` error rolls back the optimistic row; (10) on echo timeout, the handler resyncs and resolves; (11) delete-by-key message shape. |
| B-T2 | main | `table-feed.test.ts`: diff yields insert/update/delete with contiguous seq; no-op diff publishes nothing; `hello` precedes all batches; snapshot and seq agree under concurrent notify; `notifyNow` returns the seq containing the change; queue overflow ends the stream with `reset`; `finally` unsubscribes on abort. |
| B-T3 | main | per-table wiring with `ABACUSAI_BOT_HOME` set to a temp dir: create/update/delete a bot through the store → one batch each; a `cronjobs-updated` bus event → routine diff; `setRunOutcome` → sessions update + routineRuns update; writing `memories/MEMORY.md` externally → memories batch within 500 ms; prefs update → `nativeTheme.themeSource` set (Electron mocked). |
| B-T4 | main | end-to-end over the memory transport (a real `MessageChannel`): collection in the same process, mutate through `collection.update`, assert the row round-trips and `awaitSeq` settles. |

### B.7 Acceptance (B)

- [ ] B-T1…B-T4 green.
- [ ] In the running app, a scratch page mounting `useLiveQuery(q => q.from({ s: sessionsCollection }))` shows the same sessions as the old sidebar. Creating, renaming and deleting a session in the **old** UI appears in the collection within one frame of the IPC event.
- [ ] `bots` insert/update/delete from the collection show up in the old UI, which refetches on `bots-updated` because the store hook still emits it.
- [ ] After `sessions-reloaded` (sign-out/sign-in), the collection matches `listAllAgentSessions()` exactly.
- [ ] Memory written by the agent child (a "remember X" turn) appears as a new `memories` row without reopening anything.
- [ ] No table sends more than one batch per event-loop turn under a burst of 100 notifies (B-T2 asserts it).

### B.8 Risks (B)

- **Diff cost.** `sessions` re-reads `listAll()` on every notify. Today's lists are hundreds of rows, and the coalescing keeps it to at most one diff per tick. If profiling shows more than 2 ms per diff, switch `sessions` to event-driven patches, keeping the same wire.
- **`fs.watch` quirks.** Flat directories only (no recursive watch on Linux). Editors replace files through rename, so the watcher re-arms on `rename` events. The debounce and diff absorb duplicates.
- **Memory keys under duplicates.** Two identical entries get `:0` and `:1` suffixes. Deleting the first renumbers the second, which the renderer sees as a delete plus an update. That is acceptable.
- **`gitState` covers only the active workspace** until a later slice widens `WorkspaceRuntimeService`. Routes for a non-active workspace show "not tracked" rather than stale data.
- **Two UIs, two sources of prefs.** During the transition the old renderer writes `renderer-state.json` and the new one writes `prefs.json`. C.4 copies once, and they are not kept in sync afterwards. This is acceptable because users never run both, and the developer flag `--rerun-migration=2` re-imports.
- **Optimistic ids.** Stores that mint ids (bots, routines, sessions) gain an optional caller id. A collision throws `CONFLICT`, never a silent overwrite.

---

## C. Migration runner

### C.1 Runner

Files: `apps/desktop/src/main/migrations/{runner.ts, record.ts, backup.ts, progress-window.ts, steps/index.ts, steps/001-*.ts, steps/002-*.ts}`.

```ts
interface MigrationContext {
  home: string;                       // abacusBotHome() (paths.ts)
  userData: string;                   // app.getPath("userData")
  appVersion: string;
  staging: string;                    // <home>/.migrating/<id>-<name>/, fresh per attempt
  backup(relPaths: string[]): Promise<string>;     // copies into <home>/backups/migrations/<stamp>-<id>-<name>/
  progress(done: number, total: number, label?: string): void;
  log: (msg: string) => void;
}
interface MigrationStep {
  id: number;                         // 1, 2, …; never reused, never renumbered
  name: string;                       // kebab-case
  destructive: boolean;               // true = modifies or deletes existing files → must call ctx.backup first
  run(ctx: MigrationContext): Promise<{ stats: Record<string, number>; commit: () => void }>;
}
```

- **Where it runs:** in `main/index.ts`, inside `whenReady`, after the single-instance lock is held (`index.ts:911-925`) and **before** `workspaceServiceHost.initialize()` (`index.ts:960`) and `registerRendererState()` (`index.ts:964`). No service has read the files yet, and nothing writes them concurrently. `local-code.json`'s import-time migrations (`workspace-store.ts:28-103`) are untouched and not part of this runner.
- **Record:** `~/.abacusai-bot/migrations.json`, written atomically (`writeFileAtomicSync` from `@abacus-ai/agent/atomic-file`, as in `transcript-service.ts:73`):
  ```json
  { "version": 1,
    "applied": [ { "id": 1, "name": "transcripts-v2", "appliedAt": "ISO", "appVersion": "x.y.z", "durationMs": 812, "stats": { "converted": 214, "skipped": 3, "corrupt": 1 } } ],
    "lastFailure": { "id": 2, "name": "prefs-from-renderer-state", "at": "ISO", "error": "message" } }
  ```
  A missing or corrupt file means nothing has been applied. Every step is idempotent (C.3, C.4), so re-running is safe.
- **One transaction per step:**
  1. `run()` writes only under `ctx.staging`, or into new files that are not read by anything yet.
  2. `commit()` moves staged outputs into place with `fs.renameSync`, which is atomic within the same volume. Staging sits under `home` for exactly that reason.
  3. The record is appended only after `commit()` returns.
  4. A throw anywhere in `run` or `commit` deletes `staging`, records `lastFailure`, logs the error, and **stops the runner**. Later steps have not run; the next launch retries from the failed step.
- **Failure never blocks launch.** Every consumer has a fallback: `ai.hydrate` converts v1 on the fly (A.3), and `PrefsStore` starts from defaults. The runner resolves, and the app starts.
- **Order:** steps run in ascending `id`, and only those not present in `applied`. `--rerun-migration=<id>` (unpackaged builds only) removes that id from `applied` before running.
- **Progress window:** `progress-window.ts` opens a window only if the runner has not finished within 400 ms, so fast upgrades never flash one.
  - `new BrowserWindow({ width: 420, height: 140, frame: false, resizable: false, show: false, backgroundColor, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })`
  - It loads a self-contained `data:text/html` page (app name, step label, determinate bar; no external resources, so it works under the CSP). It is shown `once("ready-to-show")`.
  - Progress is pushed with `webContents.executeJavaScript(\`window.setProgress(${done},${total},${JSON.stringify(label)})\`)`, throttled to 10/s.
  - It closes when the runner resolves, before `createWindow`. It is not a `RendererHost` view and never gets an RPC port.
- **Backups:** a `destructive` step must call `ctx.backup([...])` before touching anything. Backups older than 30 days, and all but the newest 3 per step, are pruned at the end of a successful run. Non-destructive steps (both steps in this slice) create only new files and take no backup.
- **Rollback rule:** applied steps are never rolled back automatically.
  - **Downgrade safety comes from never mutating what an older build reads** until the cut-over build. Steps 1–2 add `threads/` and `prefs.json` and leave `transcripts/` and `renderer-state.json` intact, so installing an older build just works.
  - Destructive steps (C.5, cut-over build only) back up first. Manual rollback means copying the backup directory back and removing the step's entry from `migrations.json`; `PARITY.md` documents the procedure.
  - A failed step rolls back itself only: it deletes its staging.

### C.2 Steps in this slice

| Id | Name | Destructive | Reads | Writes |
|---|---|---|---|---|
| 1 | `transcripts-v2` | no | `~/.abacusai-bot/transcripts/*.json` (v1, `transcript-service.ts:14-33`) | `~/.abacusai-bot/threads/<sessionId>.json` (v2) |
| 2 | `prefs-from-renderer-state` | no | `userData/renderer-state.json` (`renderer-state.ts:132-135`) | `~/.abacusai-bot/prefs.json` |

Not migrated, by decision:

- Session and workspace records (`local-code.json`, including `runOutcome: running → failed` on restore, already done at `agent-session-manager-service.ts:107`).
- Bots (`bots.json`, `bots/<id>/`).
- Routines (`cronjobs.json`, `routines/<id>/runs/*.md`).
- Memories (`memories/*.md`, `bots/<id>/MEMORY.md`).
- pi's `agent/sessions/desktop/<id>.jsonl` (the model-context source).

The DB tables read all of these in place (B.2).

### C.3 Step 1: transcripts v1 → v2 (UIMessage JSON)

**Why localStorage is not involved:** transcripts are main-side files. The v1 file holds `ConversationSegment`s, the wire shape (`renderer/conversation/agent-types.ts:354-436`). The renderer serialises into it (`conversation/serialization.ts:123-185`) and stamps each segment with `at` (epoch ms, `conversation/persistence.ts:54-68`). It does not contain the renderer's `Segment` union (`conversation/types.ts:229-244`), whose extra types (`terminal_command`, `file_write`, `file_read`, `pending`) are folded into `tool_call` or dropped before the write (`serialization.ts:11-12`, `:67-71`).

**Target file** `threads/<sessionId>.json`:

```ts
interface ThreadFileV2 {
  version: 2;
  threadId: string;                                   // = sessionId
  updatedAt: string;                                  // ISO
  source:
    | { kind: "transcript-v1"; updatedAt: string; segments: number }   // written by this step / the dual-write
    | { kind: "agui" };                                                // written by main's AG-UI persistence later
  messages: UIMessage[];                              // @tanstack/ai UIMessage JSON; Date fields never used:
                                                      // time lives in metadata.tanstack.createdAt (ISO)
}
```

**Extension namespace:** anything AG-UI/TanStack has no part for is kept losslessly as a `TextPart` whose `metadata.abacus.kind` names it. The `content` is a readable fallback, so any renderer shows something. Message-level extras live in `UIMessage.metadata.abacus`.

**Grouping:**

- Walk the segments in order. A user `text` closes the current assistant message and becomes its own `{ role: "user" }` message.
- Every other segment appends parts to the current assistant message, which opens on the first non-user segment after a user message. Its `id` is the first segment's `id`.
- Message `metadata.tanstack.createdAt` is the ISO form of the first contributing segment's `at`, and is omitted when there is no `at`.
- `messageIndex`, `regenerateAttempt` and `versions` go into `metadata.abacus` of the message whose text carried them.

| v1 `ConversationSegment` (agent-types.ts) | v2 |
|---|---|
| `text`, `source: "user"` | new `UIMessage { id, role: "user", parts: [{ type: "text", content }] }` |
| `text`, `source: "bot"` | `{ type: "text", content }` |
| `thinking` | `{ type: "thinking", content }` (`title` is dropped: display-only; `isSpinny` is always false once persisted) |
| `collapsible` | `{ type: "text", content, metadata: { abacus: { kind: "collapsible", title } } }` |
| `tool_call` `{ toolCall, toolResult? }` | two parts, described below |
| `tool_group` `{ tools, category, summary }` | its `tools` flattened in order through the same rules; `category`/`summary` are dropped (derivable) |
| `notification` | `{ type: "text", content: message, metadata: { abacus: { kind: "notification", severity, actions?, notificationKey? } } }` |
| `credits` | added to the current assistant message's `metadata.abacus.creditsUsed` (summed) |
| `web_search_results` | `{ type: "text", content: query, metadata: { abacus: { kind: "web_search_results", resultType, results } } }` |
| `media` (image) | `{ type: "image", source: { type: "url", value: url }, metadata: { abacus: { width, height, prompt?, model? } } }` |
| `media` (video) | `{ type: "video", source: { type: "url", value: url }, metadata: { abacus: { width, height, prompt?, model?, aspectRatio?, duration?, loop } } }` |
| `feature_limit` | `{ type: "text", content: featureName, metadata: { abacus: { kind: "feature_limit", featureName, limitType } } }` |
| `compaction` `{ summary }` | `{ type: "text", content: summary, metadata: { abacus: { kind: "compaction" } } }` |
| `subtask` `created` … `completed` | described below |
| anything else | `{ type: "text", content: "", metadata: { abacus: { kind: "unknown", raw } } }` (lossless) |

A `tool_call` segment `{ toolCall, toolResult? }` becomes two parts:

- `{ type: "tool-call", id: toolCall.id, name: toolCall.name, arguments: JSON.stringify(toolCall.args), input: toolCall.args, state, output?: toolResult?.output, metadata: { abacus: { endpoint?, status: toolCall.status } } }`
- plus, when a `toolResult` exists: `{ type: "tool-result", toolCallId, content: toolResult.output, state: toolResult.error ? "error" : "complete", outcome?, error?: toolResult.error, metadata: { abacus: { data: toolResult.data, rejection: toolResult.rejection } } }`

The `state` of the tool-call part comes from `toolCall.status`:

| `toolCall.status` | `state` | Extra |
|---|---|---|
| `success` | `complete` | — |
| `error` | `error` | — |
| `rejected` | `approval-responded` | `approval: { id: \`${id}:approval\`, needsApproval: true, approved: false }` |
| `pending`, `executing`, `awaiting_permission`, `interrupted`, `skipped`, `abandoned` | `error` | The paired result gets `outcome: "cancelled"`; one is synthesised with `content: ""` if none was stored. A v1 in-flight call can never resume. |

The result's `outcome` is `"denied"` when `rejection.reason === "rejected"`, and `"cancelled"` for `interrupted` or `sibling_failed`.

A `subtask` bracket (`created` … `completed`) becomes one `SubagentPart`:

```
{ type: "subagent", subagent: {
    id, name: kind ?? "delegate", description?,
    status: outcome === "completed" ? "finished" : "error",
    error?: outcome === "interrupted" || no closing frame ? { message: "interrupted" } : undefined,
    messages: [{ id: `${id}:0`, role: "assistant", parts: <members> }],
    metadata: { abacus: { startTime?, endTime? } } } }
```

Members are the segments between the `created` and `completed` frames. This is the same positional rule as `serialization.ts:156-181` and `hydration.ts:63`.

Other rules:

- `id`s are preserved everywhere, so edit, rewind and version navigation keep working through `metadata.abacus.messageIndex`.
- **Idempotent:** a v1 file is converted when the v2 file is missing, or when `v2.source.kind === "transcript-v1" && v2.source.updatedAt < v1.updatedAt`. A v2 file with `source.kind === "agui"` is never overwritten.
- Unsafe file names (the `isSafeSessionId` rule, `transcript-service.ts:18`) and unparseable or non-v1 files are skipped and counted (`corrupt`, `skipped`).
- Output is staged in `staging/threads/` and committed file by file with `renameSync` into `threads/`. That is safe to interrupt: a half-done commit just re-converts next time.
- **Mapper location:** `shared/transcript/v1-to-ui-messages.ts`, a pure function with no Node or Electron imports. Three callers use it: this step, `ai.hydrate`'s on-the-fly fallback, and the **transition dual-write**, where `TranscriptService.write` (`transcript-service.ts:60-84`) also writes the v2 file after a successful v1 write. That keeps `threads/` current while the old renderer still saves v1. The dual-write is removed at cut-over, when main persists v2 from the AG-UI stream.

### C.4 Step 2: renderer durable state → `prefs.json`

**Decision: read main's durable-state file directly. No renderer handoff.** Every persisted renderer key already lives in `userData/renderer-state.json`, owned by `RendererStateStore` (`renderer-state.ts:19-126`):

- All zustand `persist()` stores use `createJSONStorage(() => durableStorage)`: `code-store.ts:386`, `sidebar-accordion-store.ts:29`, `language-store.ts:25`, `credits-store.ts:27`, `code-folder-context.ts:68`.
- The raw keys use `durableStorage` directly: `use-theme.ts:6`, `browser-homepage.ts:5`, `onboarding-flow.tsx:44`, `referral-card.tsx:11`, `credits-exhausted-card.tsx:125`.
- `durable-storage.ts:72-90` has already copied any origin-local localStorage into the store (marker `durable-storage.migrated`).

localStorage itself is per origin, and origins are versioned per experience (`renderer-state.ts:1-6`), so main could not reach a meaningful localStorage anyway. The one case this misses is a build older than `durable-storage.ts`. Those values sit under an older origin that no current build can read either, and the loss is accepted (it is today's behaviour on any swap).

The step parses the file with the same tolerant reader as `RendererStateStore`'s constructor (factored out as `readRendererStateFile(file)`).

| Source key (renderer-state.json) | Format | → `PrefsRow` |
|---|---|---|
| `theme` | raw `"light"\|"dark"\|"system"` | `theme` |
| `abacusai-bot-language` | zustand JSON `{ state: { languageCode } }` | `language` |
| `local-code-ui-store` (v4, `code-store.ts:384-416`) | zustand JSON | `sidebar.pinned` ← `isSidebarVisible`; `models.selectedModelId`, `models.favoriteModelIds`, `models.perWorkspace` ← `workspaceSelectedModelIds`; `defaultMode` ← `globalSelectedMode`; `workspaceExpanded` ← `workspaceAccordionExpanded`; `pinned.sessionIds`/`botIds`; `lastPickedWorkspaceId`. **Dropped:** `codeSidebarTab` (no equivalent in the new shell). Versions below 4 go through the same field deletions as `code-store.ts:390-403` first. |
| `sidebar-accordion` | zustand JSON `{ state: { openSection } }` | `sidebar.openSection` |
| `abacus-credits` | zustand JSON `{ state: { exhaustedAt } }` | `creditsExhaustedAt` |
| `abacusai-bot-code-folder` | zustand JSON `{ state: { recentFolders } }` | `recentFolders` (`currentFolder` dropped: the URL owns location) |
| `browser.homepage` | raw string | `browserHomepage` |
| `onboarding.step` | raw string | `onboardingStep` |
| `referral-card.dismissed-until` | raw number string | `dismissals.referralCardUntil` |
| `local-code:upsell-dismissed` | presence | `dismissals.upsell` |
| `composer.draft:<workspaceId>` | raw string | **not migrated**: drafts are ephemeral TanStack Store state in the new renderer (PLAN, State). Listed in the release notes. |
| `durable-storage.migrated`, `abacusai-bot.promptSnippets`, anything else | — | ignored |

- Each value is validated with the `PrefsPatch` valibot schema. An invalid field is replaced by its default and counted in `stats.invalid`. The whole row is never rejected.
- **Merge:** if `prefs.json` already exists (a developer ran the new renderer first), existing fields win. The step only fills fields still at their defaults, so it is idempotent.
- It writes to `staging/prefs.json`, and `commit()` renames it to `~/.abacusai-bot/prefs.json`. `renderer-state.json` is **not modified**: the old renderer and older builds keep working.

### C.5 Later steps (registered only in the cut-over build, listed so ids are reserved)

| Id | Name | Destructive | Action |
|---|---|---|---|
| 3 | `drop-legacy-renderer-state` | yes | Back up `renderer-state.json`, then remove the keys in C.4's table. |
| 4 | `archive-transcripts-v1` | yes | Back up (move) `transcripts/` into the backup directory once every file has a v2 twin with a newer or equal `source.updatedAt`. |

### C.6 Files to add or change (C)

| Path | Change |
|---|---|
| `main/migrations/**` | new (C.1) |
| `shared/transcript/v1-to-ui-messages.ts` | new pure mapper (C.3) |
| `main/services/session/thread-store.ts` | new: read/write `threads/<id>.json` (used by `ai.hydrate` and the dual-write) |
| `main/services/session/transcript-service.ts` | dual-write v2 after v1 (`:79`, before `onPersist`) |
| `main/services/config/renderer-state.ts` | extract `readRendererStateFile(file)` from the constructor (`:29-42`) |
| `main/index.ts` | `await runMigrations(...)` before `workspaceServiceHost.initialize()` (`:960`) |

### C.7 Test plan (C)

| Id | Project | Test |
|---|---|---|
| C-T1 | shared | `v1-to-ui-messages.golden.test.ts`: fixtures in `shared/transcript/__fixtures__/v1/*.json` → `expected-v2/*.json`, compared byte-for-byte after stable key ordering, with `UPDATE_GOLDEN=1` to rewrite. Fixtures: plain chat; bash/read/write/edit/mcp/unknown tool calls; rejected, interrupted and sibling_failed results; an in-flight call; `tool_group`; a subtask completed, one interrupted, and one with no closing frame; image and video media; notification with actions; credits across two turns; compaction; web search; versions/regenerate metadata; an unknown segment type; empty segments; missing `at`. |
| C-T2 | shared | Mapper properties: every input segment id appears in the output; the output parses with a valibot `ThreadFileV2` schema; running the mapper twice on the same input gives identical output. |
| C-T3 | main | `runner.test.ts` with a temp `ABACUSAI_BOT_HOME` and `userData`: steps run in order; a second run is a no-op; the record is written only after commit; a throwing step leaves no staging, records `lastFailure`, skips later steps, and the next run retries; `--rerun-migration`; backup-before-destructive is enforced (a destructive step that does not call `backup` fails); pruning. |
| C-T4 | main | Step 1 against fixture directories: skip rules (unsafe name, corrupt, v2 newer, v2 `agui`); an interrupted commit resumes; stats counts. |
| C-T5 | main | Step 2 golden: `renderer-state.json` fixtures (v2, v3 and v4 `local-code-ui-store`, missing keys, invalid values) → `prefs.json` expected; merge precedence with an existing `prefs.json`; the source file stays byte-identical. |
| C-T6 | main | Progress window: not created when the runner finishes in under 400 ms (fake timers); created, updated and closed otherwise (Electron mocked). |
| C-T7 | main | Dual-write: `TranscriptService.write` produces the matching v2 file; a v2 file with `source.kind === "agui"` is not overwritten. |

### C.8 Acceptance (C)

- [ ] C-T1…C-T7 green.
- [ ] Against a copy of a real `~/.abacusai-bot` (the developer's own, anonymised copy kept out of git): the migration completes, `threads/` has one file per `transcripts/` file (minus corrupt ones), and `ai.hydrate` for three sample sessions returns messages whose text parts match what the old UI shows.
- [ ] The old renderer still opens every session with its full transcript after migration, because the v1 files are untouched.
- [ ] Prefs: theme, language, pinned bots/sessions, favourite models and default mode read from `db.prefs` equal what the old UI shows.
- [ ] Killing the app mid-migration (a `SIGKILL` during step 1 in a manual test) leaves a consistent state, and the next launch finishes.
- [ ] No progress window appears on a machine with fewer than 50 transcripts. With about 2k synthetic transcripts it appears and closes before the main window.

### C.9 Risks (C)

- **Transcript volume.** Heavy users have thousands of large files. The step streams file by file (never all in memory), yields to the event loop every 20 files so the progress window paints, and uses a 1 MB read buffer. The worst case is bounded by disk reads, since the mapping itself is linear.
- **Mapping loss.** `thinking.title` and `tool_group` summaries are dropped deliberately. Everything else is kept, either in parts or in `metadata.abacus`. The chat kit (Phase 2) must render `metadata.abacus.kind` text parts. That is a named dependency, not something decided here.
- **Two writers of `threads/`.** The dual-write (v1-derived) and future AG-UI persistence (`agui`) could collide. The `source.kind` rule makes `agui` always win, and the cut-over removes the dual-write.
- **Prefs drift during the transition** (B.8).
- **Timestamps.** Only v1 segments saved after `persistence.ts` began stamping `at` have times. Older threads have no `createdAt`, and the UI must tolerate that (it already does for separators).
- **Startup latency.** The runner is awaited on the startup path. It is a no-op after the first run (one small JSON read). The first run happens once per machine.

---

## Order of work and definition of done

1. **PR A.** Contract (all domains, legacy map), main router, MessagePort transport, preload handshake, renderer transport, WebSocket smoke, `FOUNDATION_API` bump. Gate: A.11.
2. **PR B.** `TableFeed`, 9 tables, store hooks, `PrefsStore`, `ipcCollectionOptions` with its tests. Gate: B.7.
3. **PR C.** Runner, steps 1–2, mapper, thread store, dual-write, progress window. Gate: C.8.

Each PR updates `docs/rewrite/PROGRESS.md` (Spec/Impl/Review columns) and regenerates `docs/rewrite/PARITY.md` through A-T6.

## Decisions recorded here

- oRPC 1.15.4, exact pins. MessagePort channel created in the preload on a renderer-initiated nonce handshake. One port per page load.
- `window.api` and the legacy IPC stay mounted until the Phase 7 cut-over. Every event goes through one `emitIpcEvent` into both paths.
- `Uint8Array` travels through a custom oRPC JSON serializer. A raw side port for device streams is the documented fallback, not built.
- DB wire: `hello` → snapshot → contiguous seq batches; `reset` via `truncate()`; full-row updates; mutations resolve on their echoed seq.
- `gitState` covers the active workspace only for now. `memories` has no insert. `workspaces` has no insert (it uses `workspaces.add`).
- The prefs migration reads `renderer-state.json` in main. There is no renderer handoff.
- Transcripts become `threads/<id>.json` (v2 UIMessage JSON). v1 is kept until the cut-over build. Main dual-writes v2 during the transition, and `ai.hydrate` falls back to on-the-fly conversion.
- Composer drafts are not migrated.
