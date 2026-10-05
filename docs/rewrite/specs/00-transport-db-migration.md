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
├─ agui.ts             type-only AG-UI/TanStack AI imports, each from the package that actually exports it (A.3.1)
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
| 20 | `listStoredKeyProviders` | bridge.ts:266 | `settings.keys.listProviders` | Q | invalidated by `settings.events` `credentials-changed` (the single destination; A.2.3) |
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
| 44 | `listAgentSessions` | bridge.ts:392 | `db.sessions` (live query where workspaceId) | T | per-workspace list becomes a live query |
| 45 | `listAllAgentSessions` | bridge.ts:396 | `db.sessions (snapshot/subscribe)` | T |  |
| 46 | `listBots` | bridge.ts:400 | `db.bots (snapshot/subscribe)` | T |  |
| 47 | `listBotChatPreviews` | bridge.ts:401 | `bots.chatPreviews` | Q | invalidated by `bots.events` `{ type: "previews-changed" }`, published on every legacy `bots-updated` notice, including transcript-only saves (`service-host.ts:1519-1527`), independent of row diffs |
| 48 | `listBotSenderChats` | bridge.ts:405 | `bots.senderChats` | Q |  |
| 49 | `createBot` | bridge.ts:409 | `db.bots.mutate insert → bots.create` | T |  |
| 50 | `updateBot` | bridge.ts:411 | `db.bots.mutate update → bots.update` | T |  |
| 51 | `deleteBot` | bridge.ts:413 | `db.bots.mutate delete → bots.remove` | T |  |
| 52 | `announceBotChange` | bridge.ts:415 | `bots.announceChange` | M |  |
| 53 | `openBotChat` | bridge.ts:421 | `bots.openChat` | M | echoes `bots` update (sessionId) and `sessions` insert |
| 54 | `listRoutines` | bridge.ts:426 | `db.routines (snapshot/subscribe)` | T |  |
| 55 | `listRoutineRuns` | bridge.ts:430 | `db.routineRuns` (live query where routineId) | T |  |
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
| 155 | `listMemories` | bridge.ts:896 | `db.memories` (scope global) | T |  |
| 156 | `getCustomInstructions` | bridge.ts:898 | `memory.customInstructions.get` | Q |  |
| 157 | `setCustomInstructions` | bridge.ts:900 | `memory.customInstructions.set` | M |  |
| 158 | `forgetMemory` | bridge.ts:905 | `db.memories.mutate delete → memory.forget` | T |  |
| 159 | `forgetAllMemories` | bridge.ts:910 | `memory.forgetAll` | M | echoes `memories` deletes |
| 160 | `listBotMemories` | bridge.ts:915 | `db.memories` (scope bot) + `memory.bots` | T | entries in the table; `memory.bots` (Q) keeps `BotMemoryView` (`noteDays`, bots with no entries), invalidated by `memory.events` |
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
| `terminal-output` | 504 | `terminal.output({ terminalId, generation, fromOffset? })`, a lossless-replayable iterator (A.4.3) | per terminal, filtered before buffering; offset-addressed `snapshot`/`data` chunks |
| `terminal-exited` | 513 | `terminal.output` final yield `{ type: "exit", exitCode, signal }`, then return | sticky: a late subscriber still receives it |
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
| `bots-updated` | 683 | `db.bots.changes` (feed notify) **and** `bots.events` `{ type: "previews-changed" }` | the row diff may be empty (a transcript save changes no row), so previews get their own notice |
| `cronjobs-updated` | 684 | `db.routines.changes` (feed notify) | |
| `messaging-user-message` / `messaging-agent-message` | 688, 696 | `ai.subscribe`: a relay turn is an AG-UI run with a `role: "user"` `TEXT_MESSAGE_*` and `CUSTOM abacus.messaging.sent` | retired as separate events once the emitter lands |
| `credentials-changed` | 704 | `settings.events` `{ type: "credentials-changed", provider, configured? }` | the only destination. `renderer/data/queries/invalidation.ts` maps it to `settings.keys.listProviders`, `account.*` and `models.list`; A-T11 tests a save and a removal against those query keys |
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
  /** Authoritative live state for one thread: the in-flight run and the interrupts it is paused on. */
  liveState(threadId: string): { activeRun: { runId: string } | null; interrupts: ChatHydrationResult["interrupts"] };
  cancel(threadId: string, runId?: string): Promise<void>;
}
```

Hydration is not part of `AguiSource`. It is composed in `main/rpc/ai/hydrate.ts` from two sources: the persisted messages (thread store, C.3) and `AguiSource.liveState`. That keeps "what was said" and "what is running now" from separate owners.

| Procedure | Input (valibot) | Output | Behaviour |
|---|---|---|---|
| `ai.subscribe` | `{ threadId: SessionId, lastEventId?: string }` | `eventIterator(type<StreamChunk>())` | The first yield is always `{ type: "CUSTOM", name: "abacus.subscribed", value: { seq } }`, sent after the source has registered the subscriber. It is the readiness signal for A.4.6, and the chat adapter swallows it. Every other yield is `withEventMeta(event, { id: String(seq) })`. The resume point is `input.lastEventId ?? lastEventId` (the retry-plugin header). If the point is older than the thread's replay ring, the first yield is `{ type: "CUSTOM", name: "abacus.resync" }`, then live events; the renderer adapter responds by calling `ai.hydrate`. The iterator never returns by itself. It ends when the signal aborts (port closed, component unmounted). |
| `ai.send` | `{ threadId, runId, parentRunId?, messages: v.array(UIMessageLoose), resume?: v.array(ResumeItem), forwardedProps?: v.record(v.string(), v.unknown()), clientTools?: v.array(ClientTool) }` | `{ runId: string }` | Starts the run (or queues it, per `forwardedProps.whenBusy`). It resolves once the child has accepted the run; the events arrive on `ai.subscribe`. |
| `ai.hydrate` | `{ threadId, limit?: v.number(), before?: v.string() }` | `type<ChatHydrationResult>()` | Returns `{ messages, activeRun, interrupts, page }`. **Messages** come from the thread store's `readCurrent(threadId)` (C.3, "Freshness"): it reads `threads/<id>.json` (v2), and when the v2 file is missing, or is v1-derived and older than `transcripts/<id>.json`, it converts v1 with the same pure mapper and repairs the v2 file. A failed migration step or dual-write therefore never blanks or staleness-locks a thread. **`activeRun` and `interrupts`** come from `AguiSource.liveState(threadId)`, never from the file. The ai-client uses them to rejoin a generating run (`joinRun`) and to re-prompt pending approvals after a reload. `page` applies `limit`/`before` over `messages` (newest last); `truncated: false` when no `limit` is given. |
| `ai.joinRun` | `{ runId: v.string() }` | `eventIterator(type<StreamChunk>())` | Replays the run from `RUN_STARTED`, then follows it live. Returns after `RUN_FINISHED`/`RUN_ERROR`. |
| `ai.cancel` | `{ threadId, runId?: v.string() }` | `void` | Maps to today's `stopAgentTurn`. The source guarantees a closing `RUN_FINISHED{ outcome: "cancelled" }`. |

#### A.3.1 Type sources (checked against the TanStack AI clone: ai 0.63.0, ai-client 0.36.0)

`shared/contract/agui.ts` holds only `import type` statements:

```ts
import type { StreamChunk, UIMessage } from "@tanstack/ai";                        // ai/src/index.ts:412 `export * from './types'`
import type { RunAgentInputContext, RunAgentResumeItem, SubscribeConnectionAdapter } from "@tanstack/ai-client"; // ai-client/src/index.ts:154,181,183
// Not exported from either package root (declared in ai-client/src/connection-adapters.ts:963-994), so derive:
export type ChatHydrationResult = Awaited<ReturnType<NonNullable<SubscribeConnectionAdapter["hydrate"]>>>;
export type ChatHydrateOptions = NonNullable<Parameters<NonNullable<SubscribeConnectionAdapter["hydrate"]>>[1]>;
```

`@tanstack/ai` and `@tanstack/ai-client` become `devDependencies` of the desktop app for types, and `dependencies` once Phase 2 uses them at runtime. Test A-T1b (`lib-imports.types.test.ts`) imports every named type used by `shared/contract/**` and `renderer/data/**` from its declared package and asserts each is not `any` (`expectTypeOf<T>().not.toBeAny()`). A wrong package or a missing export then fails `tsc -b`.

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

// Called once per webContents from wireRendererContents (main/index.ts:690) — the only place listeners are installed.
export const registerRendererContents = (contents: WebContents, kind: "main" | "notch"): void => {
  if (registry.has(contents.id)) return;
  registry.set(contents.id, { kind, port: null });
  contents.on("did-start-navigation", onNavigation);           // one listener per contents, for its lifetime
  contents.once("destroyed", () => {
    closeActivePort(contents.id);
    contents.off("did-start-navigation", onNavigation);
    registry.delete(contents.id);                              // unregistered: later connects from this id are refused
  });
  function onNavigation(_e: unknown, _u: string, sameDoc: boolean, mainFrame: boolean): void {
    if (mainFrame && !sameDoc) closeActivePort(contents.id);   // reload: the old document's iterators end
  }
};

ipcMain.on("rpc:connect", (event) => {
  const [port] = event.ports;
  if (port == null) return;
  const entry = registry.get(event.sender.id);
  if (entry == null || event.senderFrame !== event.sender.mainFrame) { port.close(); return; }
  closeActivePort(event.sender.id);                           // at most one live port per contents
  entry.port = port;
  port.on("close", () => { if (entry.port === port) entry.port = null; });   // closed ports leave the registry
  handler.upgrade(port, { context: {
    transport: "message-port", webContentsId: event.sender.id, windowKind: entry.kind, deps } });
  port.start();
});
```

Rules:

- **Trust:** a port is accepted only if the sender is in `registry` and `event.senderFrame === event.sender.mainFrame`. Only `wireRendererContents` registers contents: the live view, any swap candidate and, later, the notch window. Webviews, the connector windows, the Abacus sign-in window (`abacus-signin-window.ts:301`) and PDF/deck windows are never registered. `windowKind` comes from the registry, not from the renderer's message.
- **Listeners** are installed exactly once per `webContents` (in `registerRendererContents`) and removed on `destroyed`. Per-connection state is only `entry.port`, which is cleared by the port's `close` event. Reloads therefore add no listeners.
- **One port per document.** The preload refuses a second connect in the same document (A.4.4). Main enforces the same invariant on its side: a new connect closes any previous port for that contents. Closing a port (reload, swap flip `renderer-host.ts:262`, window close) fires `close`. oRPC then aborts every open iterator's `signal`, and each generator's `finally` unsubscribes.
- **Registration** of the `ipcMain` listener happens in `registerIpcHandlers` (`handler.ts:143`), after `serviceHost.setEventDispatcher`.

#### A.4.3 Event bus

`MainEventBus` owns routing. It does **not** use oRPC's `EventPublisher` for anything that must be delivered. `EventPublisher` keeps at most `maxBufferedEvents` per subscriber, silently drops the oldest beyond that, and has no overflow callback (oRPC 1.15.4 `packages/shared/src/event-publisher.ts`).

```ts
// main/rpc/event-bus.ts
export const emitIpcEvent = (event: IpcEvent): void => {
  sendToRenderer(IpcChannels.Event, event);   // legacy renderer, unchanged
  bus.dispatch(event);                         // synchronous fan-out to listeners (no buffering here)
};
bus.listen(filter: (e: IpcEvent) => boolean, listener: (e: IpcEvent) => void): () => void
```

- `handler.ts:144-146` dispatches through `emitIpcEvent`. The direct senders listed under "Where things are today" switch to `emitIpcEvent` (or `bus.dispatchChannel("update" | "window:<id>" | "system" | "device-chunk:<id>", payload)`), keeping their legacy `send`.
- **Filter before buffering.** Every event iterator registers a listener with its own predicate (type plus the iterator's `terminalId`, `sessionId`, `conversationKey` and so on). Only matching events enter that subscriber's queue (`main/rpc/subscriber-queue.ts`). Unrelated traffic can never evict an iterator's events.
- **Three delivery classes.** Each iterator declares its class in `procedures/<domain>.ts`, and a test asserts the declaration (A-T9).

| Class | Iterators | Queue | On overflow | Recovery |
|---|---|---|---|---|
| **lossless-replayable** | `terminal.output` | unbounded until 8 MB of pending bytes | end the stream with the typed `RESYNC_REQUIRED` iterator error | the client reopens with `fromOffset`. Main answers with a `snapshot` from `BoundedScrollback` (`conversation-terminal-runtime-registry.ts:87,472,507`), then live chunks. |
| **lossless-actionable** | `browser.events` (permission-request/cleared, open-preview, runtime-materialized), `connectors.events` (request/cleared), `devices.events` (build-state), `ai.subscribe` (its own replay ring), `terminal.events` | unbounded, 10,000 events | same as above | The first yield on (re)open is a `snapshot` of current actionable state: pending permission requests (`listBrowserPermissionRequests`), pending connector requests (`listConnectorRequests`), device build phase, terminal states. A request is never lost; at worst it is re-announced. |
| **coalescing** | `browser.events` `cursor`, `status`, `runtime-state`; `mcp.runtime.events` status/servers; `update.events`; `window.events`; `system.events`; `settings.events`; `messaging.events`; `bots.events`; `memory.events`; `localModels.progress`; `voice.whisper.progress`; `files.events` `tree-root-changed` | latest value per key (for example `cursor`, `status:<id>`) | not applicable (bounded by key count) | none needed: each yield is a full state or an invalidation notice. `mcp.runtime.events` `log` entries are lossless-replayable from `mcp.runtime.logs`. |

- **Terminal output is offset-addressed.** `terminal.output({ terminalId, generation, fromOffset? })` yields:
  - `{ type: "snapshot", data, offset }` first: the scrollback when `fromOffset` is absent or has been evicted, otherwise the bytes after `fromOffset`
  - then `{ type: "data", data, offset }` chunks, where `offset` is the cumulative byte count after the chunk
  - then exactly one `{ type: "exit", exitCode, signal }`, after which the iterator returns.

  **Exit is sticky:** main records it on the runtime, so a subscriber that arrives after exit receives `snapshot` + `exit` at once.
- DB feeds use the same listener API with their own lossless queues (B.4).

#### A.4.4 Preload handshake

File: `apps/desktop/src/preload/rpc-port.ts`, installed from `preload/index.ts` before the `contextBridge` call.

```ts
export const installRpcPortHandshake = (ipcRenderer: IpcRenderer, win: Window, kind: "main" | "notch"): void => {
  let answered = false;                                               // one port per document; the preload re-runs per document
  win.addEventListener("message", (event) => {
    if (event.source !== win) return;
    const data = event.data as { type?: unknown; nonce?: unknown };
    if (data?.type !== "abacus:rpc-connect" || typeof data.nonce !== "string") return;
    if (answered) {                                                   // duplicate/late request: answer without a port
      win.postMessage({ type: "abacus:rpc-port", nonce: data.nonce, error: "already-connected" }, "*");
      return;
    }
    answered = true;
    const { port1, port2 } = new MessageChannel();
    ipcRenderer.postMessage("rpc:connect", { kind }, [port1]);
    win.postMessage({ type: "abacus:rpc-port", nonce: data.nonce }, "*", [port2]);
  });
};
```

Renderer side (`renderer/data/transport/message-port.ts`):

- **One request per document.** The transport promise is stored on `globalThis[Symbol.for("abacus.transport")]`, so a Vite HMR re-execution of the transport module reuses it instead of requesting again. A full reload is a new document, and the preload's `answered` flag resets with it.
- **Nothing to retry.** The preload's listener exists before any page script runs, and the page's listener exists before it posts, so a request cannot be lost. The earlier "retry after 250 ms" is removed. After `timeoutMs` (default 5,000), the promise rejects with `TransportUnavailableError`, and the root error boundary offers a reload.
- **Late or unexpected ports are closed.** A `abacus:rpc-port` message whose nonce is not the pending one, or that arrives after the timeout, has `event.ports.forEach(p => p.close())` called. On the main side, closing `port2` closes `port1`, whose `close` clears `entry.port`.
- `"*"` as the target origin is safe here: posting to your own `window` only reaches that window, and `event.source === win` filters out frames.
- This is Electron's documented pattern for handing a port to the main world of a context-isolated page. The page never sees `ipcRenderer`.
- The preload also exposes `window.abacusHost = { getPathForFile }` (`webUtils.getPathForFile`, moved from `preload/index.ts:251`).
- `window.api` stays exposed and unchanged until cut-over.

#### A.4.5 Window/system facts as procedures

`system.info` returns everything the renderer read synchronously before:

```ts
{ appVersion, platform, arch, versions, homeDir, paths: { home, sessionHome, botHome }, materialIconsBasePath, contractVersion: CONTRACT_VERSION, foundationApi: FOUNDATION_API }
```

The renderer's `__root` loader awaits it once (`ensureQueryData`, `staleTime: Infinity`). Chrome insets are not procedures: Window Controls Overlay geometry comes from CSS `env(titlebar-area-*)` (PLAN, Window chrome). `window.state` and `window.events` are scoped to the caller's window through `context.webContentsId`.

#### A.4.6 Swap readiness barrier

Today, `renderer-ready` means "first React commit", and `RendererHost` flips anyway after `READY_TIMEOUT_MS = 5_000` (`renderer-host.ts:42`, `:199-202`). Neither says that data subscriptions are live. The new contract defines readiness explicitly:

- **Renderer:** it calls `window.ready({ barrier: "subscriptions" })` only after all of the following have settled:
  1. The transport is connected.
  2. `prefs`, `workspaces` and `sessions` have each reached `status === "ready"` (B.3).
  3. For the thread visible in the carried-over route, `ai.subscribe` has yielded `abacus.subscribed`.
  4. The first React commit has happened.

  If any of 1–3 fails, the renderer calls `window.ready({ barrier: "failed", reason })` instead.
- **Main:** `RendererHost` gets `readiness(contents): Promise<"ready" | "failed">`, resolved by the procedure. The legacy `ipc-message` `"renderer-ready"` keeps resolving the old (first-commit) promise for the old renderer.
- **Timeout policy:**

  | Case | Timeout | Outcome |
  |---|---|---|
  | Swap candidate built for this contract (`FOUNDATION_API >= 2`) | `SWAP_READY_TIMEOUT_MS = 10_000` | If it does not report `ready` in time, or reports `failed`, the swap is aborted: the candidate is discarded, its port closes and its subscriptions end, and the old renderer keeps running. `scheduleRendererSwap` retries on the next idle window, at most 3 times per version, and then logs and stops until the next launch. |
  | Initial load (no swap) | none | There is nothing to preserve. The window reveals on `did-finish-load` as today (`index.ts:697`), and the renderer shows its own loading state until ready. |
  | Legacy renderer | 5,000 ms | Keeps today's behaviour. |

- A-T10 covers a slow candidate (the barrier resolves after the timeout → aborted, the old one stays, the bus listener count returns to baseline) and a candidate that fails its snapshot (→ aborted).

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
| `RESYNC_REQUIRED` | 409 | `{ stream: string }` | A lossless iterator's subscriber queue overflowed (A.4.3) | The caller reopens: `fromOffset` for terminals, re-snapshot for actionable and DB streams |
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
| `apps/desktop/src/main/renderer-host.ts` | `readiness(contents)` barrier and `SWAP_READY_TIMEOUT_MS` abort path (A.4.6); the legacy first-commit signal is kept |
| `apps/desktop/src/main/rpc/subscriber-queue.ts` | new: per-subscriber filtered queues with the delivery classes (A.4.3) |
| `main/services/conversation/conversation-terminal-runtime-registry.ts` | expose the byte offset and a sticky exit on the runtime for `terminal.output` resume |
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
| A-T3 | main | `connect.test.ts`: `ipcMain.on("rpc:connect")` rejects (closes the port) for a subframe sender and for an unregistered or destroyed `webContents`; accepts a registered one; a second connect closes the first port. **Listener hygiene:** after 20 reloads (main-frame navigations) and 20 connects, `listenerCount("did-start-navigation")` and `listenerCount("destroyed")` on the contents are still 1, and the registry holds at most one port; `destroyed` removes the registry entry. Electron is mocked the same way as `handler.test.ts`. |
| A-T4 | preload | `rpc-port.test.ts`: fake `window`/`ipcRenderer`. Checks: only same-window messages with a matching `type` are answered; the first request gets a channel; a **second or late request gets `already-connected` and no port**, and `ipcRenderer.postMessage` was called exactly once; `window.api` is still exposed. Renderer side (same file, with the transport module): a response delayed past the timeout is closed on arrival (`port.close` spy); a response with an unknown nonce is closed; an HMR re-import reuses the global promise and posts no second request. |
| A-T5 | main | `websocket.smoke.test.ts`: starts `startWebSocketTransport` on port 0 with fakes, connects `@orpc/client/websocket`, calls `system.info`, subscribes to `db.bots.changes`, triggers a fake change, receives the batch, and checks that `window.state` gives `FORBIDDEN`. No `electron` import is reachable: the test runs with `electron` mocked to throw on import. |
| A-T6 | preload | `parity.test.ts`: builds `createBridge(fakeIpc)` and the top-level `api` keys, and asserts that every key has an entry in `LEGACY_BRIDGE_MAP` (procedure path exists in `contract`, or `retired` with a non-empty reason). It also asserts that every `IpcEvent["type"]` appears in `LEGACY_EVENT_MAP`. It writes `docs/rewrite/PARITY.md` when `UPDATE_PARITY=1`. |
| A-T7 | renderer | `transport-guard.test.ts`: static scan of `src/renderer/data/**` and `src/shared/contract/**` for `from "electron"`, `window.api`, `ipcRenderer`. |
| A-T8 | main-serial | `serializer.bench.test.ts`: 1,000 × 64 KB `Uint8Array` through handler/link over `MessageChannel`, reporting the median. Informational: it fails only above 20 ms median, and the 5 ms target is recorded in the PR. |
| A-T1b | shared | `lib-imports.types.test.ts` (A.3.1): every named type imported from `@tanstack/ai`, `@tanstack/ai-client`, `@tanstack/db` and `@orpc/*` resolves and is not `any`. |
| A-T9 | main | `subscriber-queue.test.ts`: filtering happens before buffering (10k unrelated events do not evict one terminal chunk); each iterator's declared delivery class matches the A.4.3 table; lossless overflow ends with `RESYNC_REQUIRED`; `terminal.output` resumes from `fromOffset` with no gap or duplicate, falls back to a `snapshot` when the offset has been evicted, and delivers a sticky `exit` to a late subscriber; actionable streams start with a snapshot of pending permission and connector requests. |
| A-T10 | main | `swap-readiness.test.ts` (Electron mocked, fake clock): a candidate reporting `ready` flips; `failed` aborts; no report within `SWAP_READY_TIMEOUT_MS` aborts, and the old view stays live; an aborted candidate's port closes and the bus listener count returns to baseline; retry is capped at 3 per version. |
| A-T11 | renderer | `invalidation.test.ts`: a `settings.events` `credentials-changed` for a save and for a removal invalidates exactly `settings.keys.listProviders`, `account.*` and `models.list` (query keys from `orpc.*.key()`); `bots.events` `previews-changed` invalidates `bots.chatPreviews`. |
| A-T12 | e2e (real Electron) | `scripts/e2e/rpc-handshake.mjs` (isolated profile + CDP, per the repo's screenshot recipe): with `ABACUS_TEST_HANDSHAKE_DELAY_MS=6000` injected into the preload answer, the renderer times out and closes the late port, and main's registry shows 0 live ports; without the delay, exactly 1 port after load, after 5 reloads and after an experience swap. |

### A.11 Acceptance (A)

- [ ] `pnpm --filter desktop typecheck` and `test:unit` are green; A-T1…A-T12 (including A-T1b) pass.
- [ ] The app launches, and the old renderer works unchanged: legacy IPC is untouched, and events still arrive on `IpcChannels.Event`.
- [ ] From the renderer DevTools console, `(await import("/src/renderer/data/transport/index.ts")).getTransport()` resolves. `transport.client.system.info()` returns the platform and versions. `for await (const b of transport.client.db.bots.changes({}))` yields after creating a bot in the old UI (this needs B; in PR A the check is `update.events`).
- [ ] A renderer reload and an experience swap each leave exactly one live port per `webContents` (a debug counter in `ports`), and no iterator leaks: the bus subscriber count returns to its baseline.
- [ ] `PARITY.md` is generated, and every row has a procedure or a retire reason.
- [ ] `FOUNDATION_API` is bumped in both places, and an experience built for 1 is refused (existing integrity test extended).

### A.12 Risks (A)

- **Handshake.** A request cannot be lost, because the preload's listener precedes page scripts and the page's listener precedes its post. Duplicates are refused and late ports are closed (A.4.4). The residual risk is a document that never gets an answer (a preload crash). It surfaces as `TransportUnavailableError` after 5 s, with a reload affordance, rather than a hang.
- **oRPC 1.x churn.** The TanStack Query stream helpers are `experimental_*`. Only `queryOptions`/`mutationOptions`/`key` are used in Phase 1. Stream-to-query use is limited to low-rate notices (cursor, status), behind one wrapper in `renderer/data/queries/live.ts`.
- **Event bus back-pressure.** The bus never uses `EventPublisher`, whose drops are silent. Filtered per-subscriber queues with declared delivery classes (A.4.3) make every drop explicit (`RESYNC_REQUIRED`) and recoverable. The remaining risk is memory under a stuck renderer, capped by the overflow limits.
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
db.<t>.insert / update / delete : base.input(<valibot>).output(type<{ epoch: Epoch; seq: number; key: Key }>())
```

- `seq` is per table, starts at 0 for each epoch, and advances by exactly 1 per `changes`/`reset` batch. `snapshot().seq` is the seq of the last batch already folded into `rows`.
- **A position is `{ epoch, seq }`.** Seqs are comparable only within one epoch. Every comparison in B.3 checks the epoch first.
- **Race-free start:** the feed registers the subscriber before it yields `hello`. The client asks for the snapshot only after it has received `hello`, so every change after `snapshot().seq` is guaranteed to arrive on that stream. A snapshot whose `epoch` differs from the stream's `hello.epoch` (main restarted in between) is discarded, and the stream is reopened.
- **The stream never ends on its own.** A `changes()` stream returns only when the client aborts it, with one exception: after a server-side overflow `reset` (B.4), the server ends it. The client treats any end it did not request (EOF) exactly like an error: reopen, then re-snapshot on the new `hello`.
- **Mutation echo:** a mutation procedure applies the write through the owning store, runs the table's diff synchronously, publishes the resulting batch, and only then returns `{ epoch, seq, key }`, the position of the batch containing the echo. If the write changed nothing (idempotent), it returns the current position.
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
| `memories` | `MemoryRow = { id; scope: "global" \| "bot"; target: MemoryTargetId \| null; botId: string \| null; botName: string \| null; index: number; entry: string }` | `id` (below) | `listMemories()` (`agent-tools/memory-store.ts:413`) + `listBotMemories()` (`bots/bot-memory-store.ts:60`) | main's own forget calls (`service-host.ts:2354,2378`, `clearBotMemory`) + watchers (debounced 150 ms; the agent child writes these files itself, `packages/agent/src/memory-store.ts`, `bot/bot-memory.ts`). Watched: `~/.abacusai-bot/memories/`; `~/.abacusai-bot/bots/` (a bot directory created or removed adds or drops its watchers); each `bots/<id>/` (for `MEMORY.md`); each `bots/<id>/memory/` (the daily notes counted by `noteDays`, `bot-memory-store.ts:52`), armed when that directory appears. Every notify also publishes `memory.events { type: "changed" }`, which invalidates `memory.bots`. | `delete` `{ id, scope, target, botId, index, entry }`, built by `toDeleteInput` from `mutation.original` (the row the user clicked, not the current row). Main calls `forgetEntryAt(target, index, entry)` / `forgetBotMemoryEntry(botId, index, entry)`, which compare the stored entry at `index` under the store lock (`memory-store.ts:424-452`). A stale click after renumbering therefore gets `CONFLICT` instead of deleting the successor: the existing guard, `contracts.ts:1136-1141`. Inserts come from the agent (`remember`), so there is no `insert`. `memory.forgetAll` and `memory.clearBot` stay plain mutations. |
| `workspaces` | `WorkspaceRow = WorkspaceListItem & { isActive: boolean }` (`contracts.ts:51-60`) | `id` | `WorkspaceService.getWorkspaces()` / `getActiveWorkspaceId()` (`workspace/workspace-service.ts:88,92`) | `metadata-updated` (`workspace-runtime-service.ts:380`) + an `onChanged` hook in `WorkspaceService`'s store writes (add, remove, rename, switch, markDeleted) | `update` `{ id, patch: { label } }` → `updateWorkspaceLabel`. `delete` → `removeWorkspace`. No `insert`: the id is derived in main from the path, so creation goes through `workspaces.add` and the row arrives as an insert. |
| `gitState` | `GitStateRow = GitStateSnapshot & { workspaceId: string }` (`contracts.ts:181-187`) | `workspaceId` | `serviceHost.getGitState()` (served at `handler.ts:302`) for the active workspace | `git-state-updated` (`workspace-runtime-service.ts:384`). A change of active workspace deletes the old row and inserts the new one. Today only the active workspace is computed, so the table holds at most one row. | read-only (`git.*` mutations echo here) |
| `prefs` | `PrefsRow` (below) | `"app"` | new `PrefsStore` (`main/services/config/prefs-store.ts`, file `~/.abacusai-bot/prefs.json`, atomic writes via `writeFileAtomicSync`) | its own writes, including the legacy sync (C.4) | `update` `{ patch: PrefsPatch }` (valibot, every field optional, unknown keys rejected). No `insert`/`delete`: the row always exists and is created with defaults on first read. |

`MemoryRow.id` is `${scope}:${botId ?? target}:${sha256(entry).slice(0, 16)}:${n}`, where `n` counts earlier identical entries in the same list. It stays stable when an earlier, different entry is removed; only `index` changes, which is an `update`. With duplicates, removing the first renumbers the second into the first id. That is exactly why deletes carry the original `index` + `entry` and are validated in main. B-T3 covers a duplicate-entry race: two tabs delete `:0` of `["a","a"]`, and the second gets `CONFLICT`, leaving one entry.

`memory.bots` (query) keeps `BotMemoryView[]` from `listBotMemories()` for what entry rows cannot represent: `noteDays`, and bots whose memory is empty.

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

**Provenance.** `prefs.json` stores `{ row: PrefsRow, provenance: Record<PrefsField, "default" | "legacy" | "user"> }`. `provenance` is never part of the row the renderer sees.

- A `db.prefs.update` from the new renderer marks the touched fields `"user"`.
- A legacy import (C.4) marks the fields it sets `"legacy"`.
- Fields never written stay `"default"`.
- A legacy import writes a field only if its provenance is not `"user"`. An explicit choice in the new UI (even one equal to the default, such as `theme: "system"`) is never overwritten, and a later legacy change still flows while the user has not touched that field in the new UI.

### B.3 Renderer: `ipcCollectionOptions`

File: `apps/desktop/src/renderer/data/collections/ipc-collection-options.ts`. One file per table in the same folder (`sessions.ts`, `bots.ts`, …, `prefs.ts`) calls `createCollection(ipcCollectionOptions({...}))` at module level with a lazy transport.

```ts
interface IpcTableClient<Row, Key> {
  snapshot(input: {}, opts: { signal }): Promise<{ epoch: string; seq: number; rows: Row[] }>;
  changes(input: {}, opts: { signal }): Promise<AsyncIterable<ChangeBatch<Row, Key>>>;
  insert?(input: unknown): Promise<{ epoch: string; seq: number; key: Key }>;
  update?(input: unknown): Promise<{ epoch: string; seq: number; key: Key }>;
  delete?(input: unknown): Promise<{ epoch: string; seq: number; key: Key }>;
}

export function ipcCollectionOptions<Row extends object, Key extends string>(cfg: {
  id: string;                                          // "sessions", …
  table: () => Promise<IpcTableClient<Row, Key>>;      // resolves transport.client.db.<t>
  getKey: (row: Row) => Key;
  toInsertInput?: (row: Row) => unknown;
  toUpdateInput?: (key: Key, changes: Partial<Row>, modified: Row) => unknown;
  toDeleteInput?: (key: Key, original: Row) => unknown;
  echoTimeoutMs?: number;                              // default 10_000
}): CollectionConfig<Row, Key> & { utils: {
  awaitReceived(pos: { epoch: string; seq: number }): Promise<void>;   // mutation echo (see below)
  awaitApplied(pos: { epoch: string; seq: number }): Promise<void>;    // visible in collection state (loaders, tests)
  resync(): Promise<void>;
  status(): { epoch: string | null; receivedSeq: number; appliedSeq: number; connection: number; state: "connecting" | "live" | "resyncing" };
} }
```

**Received vs applied.** In TanStack DB 0.10.0, `commit()` queues a synced transaction. It becomes visible immediately only when no user transaction is persisting. Otherwise it waits until the persisting transaction settles, and then all queued synced transactions apply together (`db/packages/db/src/collection/state.ts:1335-1395`). `commit()` returns `true` if the change is already visible, or a receipt promise that resolves when it becomes visible (`types.ts:436-448`). The adapter therefore tracks two positions within the current epoch:

- `receivedSeq`: the highest seq whose batch has been committed to the collection's sync queue.
- `appliedSeq`: the highest seq whose commit returned `true` or whose receipt resolved.

**`sync.sync({ begin, write, commit, markReady, markError, truncate, collection })`**, per the TanStack DB contract (`db/packages/db/src/types.ts:422-490`; guide "Sync Implementation"):

1. **Connection generation.** Each time the adapter opens `changes()`, it increments `connection` and creates a fresh buffer tagged with it. Batches, snapshot results and resync completions carry the generation they started under. Anything from an older generation is discarded on arrival, so a replaced stream cannot contaminate its successor.
2. **Open.** Open `changes()` and consume it at once. Every batch after `hello` goes into this connection's `buffer` until a snapshot has been applied for this connection.
3. **On `hello`:** if `hello.epoch !== epoch` (a first connect, or main restarted), set `epoch = hello.epoch`, reset `receivedSeq`/`appliedSeq` to -1, and **settle waiters from the old epoch** (below). Then call `loadSnapshot()`.
4. **`loadSnapshot()`:**
   - Call `const s = await table.snapshot()`. If `s.epoch !== epoch` or the generation is stale, discard it (the stream will send a new `hello`).
   - `begin()`
   - `truncate()` if the collection already holds a snapshot (this also makes TanStack apply the transaction immediately, `state.ts:1373`)
   - `write({ type: "insert", value })` per row
   - `const r = commit()`, then `receivedSeq = s.seq`, then track `r` for `appliedSeq`.
   - Flush `buffer`: check the **epoch first** (a batch with another epoch triggers a reopen; it is never silently dropped), then drop `seq <= receivedSeq`, then apply the rest in order (step 5).
   - **Call `markReady()` whenever `collection.status` is `"loading"` or `"error"`**, not only on the first load. A usable snapshot after a failed start, or after recovery, moves an errored collection back to ready (`collection/lifecycle.ts:163-180`: `error → ready` is a valid transition, and `applyReadyTransition` clears `syncError`).
5. **`apply(batch)`** (same connection only):
   - `batch.epoch !== epoch` → reopen
   - `kind === "reset"` → `resync()`
   - `seq <= receivedSeq` → ignore
   - `seq !== receivedSeq + 1` → `resync()` (gap)
   - otherwise `begin()`, then write each change (`insert`/`update` → `{ type, value }`; `delete` → `{ type: "delete", key }`), then `commit()`, advance `receivedSeq`, and track the receipt for `appliedSeq`.
6. **`resync()`** is single-flight per connection: buffer incoming batches, then run `loadSnapshot()`.
7. **Reopen** on a stream error **or an unexpected EOF** (the stream returned without our abort), with backoff (0.5 s, 1 s, 2 s, then every 5 s, reset after a successful `hello`). A reopen increments `connection` (step 1).
8. **Errors:** if the first snapshot fails while `status === "loading"`, call `markError(error)`. Later failures keep the last good rows and keep retrying. A successful retry calls `markReady()` (step 4).
9. **Cleanup:** `return () => abort.abort()`. That ends the oRPC iterator; main unsubscribes in `finally`. Pending waiters reject with `AbortError`.
10. `rowUpdateMode: "full"`. `startSync: true` for `prefs`, `workspaces` and `sessions` (the shell needs them at once); lazy for the others (`collection.preload()` from route loaders).

**Waiters are keyed by `{ epoch, seq }`.**

- `awaitReceived(pos)` resolves when `epoch === pos.epoch && receivedSeq >= pos.seq`.
- `awaitApplied(pos)` resolves when `epoch === pos.epoch && appliedSeq >= pos.seq`.
- When the epoch changes, waiters for the old epoch resolve once the new epoch's first snapshot is applied: that snapshot is authoritative, whether or not the old write survived.

**Mutations** (Pattern A with a built-in echo wait):

```ts
onInsert: async ({ transaction }) => {
  for (const m of transaction.mutations) {
    const pos = await (await cfg.table()).insert!(cfg.toInsertInput!(m.modified));
    await utils.awaitReceived(pos);   // echo is in the sync queue; rejects after echoTimeoutMs → resync(), then resolve
  }
},
onUpdate: /* same, with toUpdateInput(m.key, m.changes, m.modified) */,
onDelete: /* same, with toDeleteInput(m.key, m.original) */,
```

- **Handlers wait for *received*, not *applied*.** While this handler runs, its own transaction is persisting, so TanStack holds every ordinary synced commit, the echo included, until the handler returns (`state.ts:1373`). Awaiting *applied* would therefore deadlock: the echo applies only after the handler returns, and the handler would return only after the echo applies. Awaiting *received* is the same design as Electric's `awaitTxId`, which waits for the txid to be seen. When the handler resolves, TanStack drops the optimistic layer and applies the queued synced transactions in one step, so the UI goes straight from optimistic to server state (including server-normalised fields: trimmed labels, derived timestamps, generated webhook URLs) with no flicker to the old value. B-T1 case 8b asserts this with a server that normalises the row.
- **No `begin({ immediate: true })` for echoes.** The guide forbids using it "to bypass that ordering just to settle a load". The only transactions that must apply at once are resync snapshots, and those carry `truncate()`, which TanStack already processes immediately (`state.ts:1373`). `immediate` stays unused. See Review responses R7.
- A thrown `ORPCError` (such as `CONFLICT`) rejects the handler, and TanStack DB rolls the optimistic state back.
- On an echo timeout, the write did happen on the server. The handler calls `resync()`, awaits it (up to *received*), and **resolves**, so the snapshot replaces the optimistic state.
- `awaitApplied` is for route loaders and tests that need visible state (for example "after creating a bot, navigate to it").
- A table without a given procedure has no handler for it. Calling `collection.insert` on such a table then throws TanStack's "no onInsert handler" error, which is what we want.
- Client-generated ids come from `crypto.randomUUID()`, and `toInsertInput` passes them through. `toDeleteInput` receives `mutation.original`, the row as the user saw it (memory deletes depend on this, B.2).

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
- Per-subscriber queues are unbounded up to 5,000 batches. Past that (a stuck renderer), the feed drops the queue, yields `{ kind: "reset" }` and ends the stream. The client re-snapshots on `reset` **and** reopens on the EOF that follows (B.3 step 7), so changes keep flowing afterwards. B-T1 case 12 covers a mutation after overflow recovery.
- Derived tables (`routineRuns`) are `TableFeed`s whose `read` is computed from the `sessions` baseline. `sessions.notify` chains `routineRuns.notify`.
- **Triggers:** `createTables` subscribes to `bus` (`"ipc"`) and maps event types to `notify()` calls (the table in B.2). It also installs the direct hooks (`onChanged`/`onWrite`) that B adds to `AgentSessionManagerService`, `bot-store`, `WorkspaceService` and `PrefsStore`, plus the memory `fs.watch`ers. Over-notifying is harmless (diff-based), and under-notifying is what the direct hooks prevent.
- Procedures: `db.<t>.snapshot` → `feed.snapshot()`. `db.<t>.changes` → `async function* ({ signal }) { yield* feed.subscribe(signal) }`. Mutations → call the ServiceHost method, then `return { epoch: feed.epoch, seq: await feed.notifyNow(), key }`.

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
| B-T1 | renderer (node env acceptable) | `ipc-collection-options.test.ts` with a **fake table client** (a controllable async queue per connection plus a deferred snapshot) and the real `createCollection` from `@tanstack/db`. Cases: (1) batches buffered during the snapshot are applied after it, in order; (2) same-epoch batches with `seq <= snapshot.seq` are dropped; (3) a gap causes one resync with `truncate`, and the collection equals the new snapshot; (4) `reset` truncates and reloads; (5) an epoch change on reconnect resets both positions and settles old-epoch waiters after the new snapshot; (5b) a buffered batch from another epoch triggers a reopen and is never silently dropped; (5c) a late batch or snapshot from a superseded connection generation is ignored; (6) **failure then recovery**: the initial snapshot fails → `status === "error"`, the retry succeeds → `markReady()` → `status === "ready"`, and live changes apply; (7) cleanup aborts the stream and rejects pending waiters with `AbortError`; (8) `onInsert` resolves only once the echo is *received*, and does not deadlock while its own transaction persists; (8b) a server that normalises the row (trims the label, adds `updatedAt`) produces the normalised value right after the handler resolves, with no intermediate old value in a `subscribeChanges` trace; (8c) `awaitApplied` resolves only after the receipt; (9) a `CONFLICT` error rolls back the optimistic row; (10) on echo timeout, the handler resyncs and resolves; (11) delete-by-key message shape and `toDeleteInput` receiving `mutation.original`; (12) server overflow: `reset` then EOF → reopen → `hello` → snapshot, then a mutation after recovery echoes normally; (13) a clean EOF without `reset` also reopens. |
| B-T2 | main | `table-feed.test.ts`: diff yields insert/update/delete with contiguous seq; no-op diff publishes nothing; `hello` precedes all batches; snapshot and seq agree under concurrent notify; `notifyNow` returns the seq containing the change; queue overflow ends the stream with `reset`; `finally` unsubscribes on abort. |
| B-T3 | main | per-table wiring with `ABACUSAI_BOT_HOME` set to a temp dir: create/update/delete a bot through the store → one batch each; a `cronjobs-updated` bus event → routine diff; `setRunOutcome` → sessions update + routineRuns update; writing `memories/MEMORY.md` externally → memories batch within 500 ms; creating `bots/<id>/memory/` and a daily note → `memory.events` fires and `memory.bots` `noteDays` changes; removing a bot directory drops its watchers; duplicate-entry delete race → the second delete gets `CONFLICT`; a transcript save for a bot session publishes `bots.events` `previews-changed` even though the `bots` diff is empty; prefs update → `nativeTheme.themeSource` set (Electron mocked); prefs provenance: a `user` field survives a legacy import, a `default`/`legacy` field takes it. |
| B-T4 | main | end-to-end over the memory transport (a real `MessageChannel`): collection in the same process, mutate through `collection.update`, assert the row round-trips, `awaitReceived` settles inside the handler and `awaitApplied` after it. |

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
- **Two UIs, two sources of prefs.** During the transition the old renderer writes `renderer-state.json`, and it stays the shipped UI until Phase 7. A one-time copy would therefore lose every later change. Instead, main keeps `prefs.json` in step with the legacy keys for the whole transition: C.4's live legacy sync plus a final provenance-aware import in cut-over step 3. The residual risk is a key whose mapping is lossy (C.4 table); those are listed in the release notes.
- **Optimistic ids.** Stores that mint ids (bots, routines, sessions) gain an optional caller id. A collision throws `CONFLICT`, never a silent overwrite.

---

## C. Migration runner

### C.1 Runner

Files: `apps/desktop/src/main/migrations/{runner.ts, record.ts, journal.ts, backup.ts, progress-window.ts, steps/index.ts, steps/001-*.ts, steps/002-*.ts}`.

```ts
type WriteKind =
  | "create"            // destination did not exist
  | "replace-derived"   // destination exists but is fully regenerable from sources the step does not touch
  | "replace-user";     // destination exists and may hold data found nowhere else → must be backed up
interface PlannedWrite { dest: string; staged: string; kind: WriteKind }
interface MigrationContext {
  home: string;                       // abacusBotHome() (paths.ts)
  userData: string;                   // app.getPath("userData")
  appVersion: string;
  staging: string;                    // <home>/.migrating/<id>-<name>/, fresh per attempt
  progress(done: number, total: number, label?: string): void;
  log: (msg: string) => void;
}
interface MigrationStep {
  id: number;                         // 1, 2, …; never reused, never renumbered
  name: string;                       // kebab-case
  plan(ctx: MigrationContext): Promise<{ writes: PlannedWrite[]; removals: string[]; stats: Record<string, number> }>;
}
```

A step never touches destinations itself. It only **plans**: it stages every output under `ctx.staging` and returns the list of writes (each classified by kind) and removals. The runner then commits the plan.

- **Where it runs:** in `main/index.ts`, inside `whenReady`, after the single-instance lock is held (`index.ts:911-925`) and **before** `workspaceServiceHost.initialize()` (`index.ts:960`) and `registerRendererState()` (`index.ts:964`). No service has read the files yet, and nothing writes them concurrently. `local-code.json`'s import-time migrations (`workspace-store.ts:28-103`) are untouched and not part of this runner.
- **Record:** `~/.abacusai-bot/migrations.json`, written atomically (`writeFileAtomicSync` from `@abacus-ai/agent/atomic-file`, as in `transcript-service.ts:73`):
  ```json
  { "version": 1,
    "applied": [ { "id": 1, "name": "transcripts-v2", "appliedAt": "ISO", "appVersion": "x.y.z", "durationMs": 812, "stats": { "converted": 214, "skipped": 3, "corrupt": 1 } } ],
    "lastFailure": { "id": 2, "name": "prefs-from-renderer-state", "at": "ISO", "error": "message" } }
  ```
  A missing or corrupt file means nothing has been applied. Every step is idempotent (C.3, C.4), so re-running is safe.
- **Commit protocol (per step):**
  1. For every `replace-user` write and every removal, copy the current destination into `<home>/backups/migrations/<stamp>-<id>-<name>/` (mirroring relative paths). `create` and `replace-derived` writes need no backup.
  2. Write `commit.journal` into staging (atomically): the plan, the backup directory, and `done: []`.
  3. For each write, `renameSync(staged, dest)` (atomic within the volume; staging sits under `home` for exactly that reason), then append `dest` to the journal's `done`. Removals move their file into the backup directory in the same way.
  4. Append the record entry to `migrations.json`.
  5. Delete staging, journal included.
- **Recovery on the next launch.** Before running steps, the runner looks for `.migrating/*/commit.journal`:
  - **Found:** the previous launch died mid-commit.
    - `replace-user` destinations in `done`, and removals, are restored from the backup directory.
    - `create` destinations in `done` are deleted.
    - `replace-derived` destinations in `done` are left: they are correct derived data or will be regenerated.
    - Then staging is deleted and the step runs again from scratch.
  - **Not found but staging exists:** the previous launch died before committing. Staging is deleted.
  - **A failure after step 3 but before step 4** (all renames done, record not written) takes the same journal path. The re-run is idempotent, so the result is identical.
- **Failure in the current launch:** a throw in `plan()` deletes staging. A throw during commit runs the recovery above immediately. Either way, `lastFailure` is recorded and the runner **stops**: later steps do not run, and the next launch retries from the failed step. Deleting staging alone is never described as a rollback.
- **Failure never blocks launch.** Every consumer has a fallback: `ai.hydrate` converts v1 on the fly and repairs stale twins (A.3, C.3), and `PrefsStore` starts from defaults and receives the live legacy sync (C.4). The runner resolves, and the app starts.
- **Order:** steps run in ascending `id`, and only those not present in `applied`. `--rerun-migration=<id>` (unpackaged builds only) removes that id from `applied` before running.
- **Progress window:** `progress-window.ts` opens a window only if the runner has not finished within 400 ms, so fast upgrades never flash one.
  - `new BrowserWindow({ width: 420, height: 140, frame: false, resizable: false, show: false, backgroundColor, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })`
  - It loads a self-contained `data:text/html` page (app name, step label, determinate bar; no external resources, so it works under the CSP). It is shown `once("ready-to-show")`.
  - Progress is pushed with `webContents.executeJavaScript(\`window.setProgress(${done},${total},${JSON.stringify(label)})\`)`, throttled to 10/s.
  - It closes when the runner resolves, before `createWindow`. It is not a registered renderer and never gets an RPC port.
- **Backups:** backups older than 30 days, and all but the newest 3 per step, are pruned at the end of a successful run. Quarantine directories (C.5) are kept 90 days.
- **Rollback rule:** applied steps are never rolled back automatically.
  - Downgrade safety comes from never mutating what an older build reads until the cut-over build. Steps 1–2 write `threads/` and `prefs.json` and leave `transcripts/` and `renderer-state.json` intact.
  - A manual rollback means copying a step's backup directory back and removing its entry from `migrations.json`; `PARITY.md` documents the procedure.

### C.2 Steps in this slice

| Id | Name | Write kinds | Reads | Writes |
|---|---|---|---|---|
| 1 | `transcripts-v2` | `create` (no v2 twin), `replace-derived` (a stale v1-derived twin; regenerable from the untouched v1). It never replaces a `source.kind: "agui"` file. | `~/.abacusai-bot/transcripts/*.json` (v1, `transcript-service.ts:14-33`) | `~/.abacusai-bot/threads/<sessionId>.json` (v2) |
| 2 | `prefs-from-renderer-state` | `create`, or `replace-user` when `prefs.json` exists (it may hold choices made in the new UI) | `userData/renderer-state.json` (`renderer-state.ts:132-135`) | `~/.abacusai-bot/prefs.json` |

Not migrated, by decision:

- Session and workspace records (`local-code.json`, including `runOutcome: running → failed` on restore, already done at `agent-session-manager-service.ts:107`).
- Bots (`bots.json`, `bots/<id>/`).
- Routines (`cronjobs.json`, `routines/<id>/runs/*.md`).
- Memories (`memories/*.md`, `bots/<id>/MEMORY.md`, `bots/<id>/memory/`).
- pi's `agent/sessions/desktop/<id>.jsonl` (the model-context source).

The DB tables read all of these in place (B.2).

### C.3 Step 1: transcripts v1 → v2 (UIMessage JSON)

**Source format.** Transcripts are main-side files, so localStorage is not involved. The v1 file holds `ConversationSegment`s, the wire shape (`renderer/conversation/agent-types.ts:354-436`). The renderer serialises into it (`conversation/serialization.ts:123-185`) and stamps each segment with `at` (epoch ms, `conversation/persistence.ts:54-68`). It does not contain the renderer's `Segment` union (`conversation/types.ts:229-244`), whose extra types are folded into `tool_call` or dropped before the write (`serialization.ts:11-12`, `:67-71`).

**Target file** `threads/<sessionId>.json`:

```ts
interface ThreadFileV2 {
  version: 2;
  threadId: string;                                   // = sessionId
  updatedAt: string;                                  // ISO
  source:
    | { kind: "transcript-v1"; updatedAt: string; segments: number }   // written by this step / the dual-write / hydrate repair
    | { kind: "agui"; migratedFrom?: { updatedAt: string } };          // written by main's AG-UI persistence later
  messages: UIMessage[];                              // @tanstack/ai UIMessage JSON; time lives in metadata.tanstack.createdAt (ISO)
}
```

**Identity and provenance: every v1 segment is traceable in v2.** The mapper maintains `metadata.abacus.segments` on each message: an ordered list of `{ id, type, at?, partIndex: number | null, groupId? }`, one entry per v1 segment that contributed to the message. That includes segments that produce no part of their own (credits, subtask close frames) and the members of a `tool_group` (with `groupId` set to the group's segment id). Parts also carry their own segment id where the part type allows it:

| Part | Where the segment id goes |
|---|---|
| `TextPart` | `metadata.abacus.segmentId` |
| `ToolCallPart` | `metadata.abacus.segmentId`; `id` stays `toolCall.id`, because TanStack pairs calls with results by it |
| `ToolResultPart` | `id` = segment id + `":result"` |
| `ImagePart` / `VideoPart` | `metadata.abacus.segmentId` |
| `ThinkingPart` (no `metadata` field) | `stepId` = segment id |
| `SubagentPart` | `subagent.id` = the bracket's `created` id; its `metadata.abacus.segments` lists the close frame |

The `at` timestamp of every segment is kept in the `segments` list. C-T2's property ("every input segment id appears in the output") holds by construction.

**Message boundaries** (these preserve edit and version targets):

- A user `text` segment always becomes its own `{ role: "user" }` message (`id` = segment id).
- Every other segment belongs to an assistant message. A new assistant message starts (a) after a user message, or (b) when a segment carries a `messageIndex` different from the current assistant message's `messageIndex` (the first segment that carries one sets it). A regenerated or edited turn with its own ordinal therefore gets its own message.
- The assistant message's `id` is its first contributing segment's id. `metadata.abacus` holds `messageIndex`, `regenerateAttempt`, `versions` (taken from the segment that carried them) and `credits: Array<{ segmentId, creditsUsed }>` (per segment, not summed). `metadata.tanstack.createdAt` is the ISO form of the first `at`, omitted when there is none.

**Per-segment mapping:**

| v1 `ConversationSegment` (agent-types.ts) | v2 part(s) |
|---|---|
| `text`, `source: "user"` | new `UIMessage { id, role: "user", parts: [{ type: "text", content, metadata: { abacus: { segmentId } } }] }` |
| `text`, `source: "bot"` | `{ type: "text", content, metadata: { abacus: { segmentId } } }` |
| `thinking` | `{ type: "thinking", content, stepId: segmentId }` (`title` is display-only; kept in `segments[]` as `title`) |
| `collapsible` | `{ type: "text", content, metadata: { abacus: { segmentId, kind: "collapsible", title } } }` |
| `tool_call` `{ toolCall, toolResult? }` | tool-call part + tool-result part, described below |
| `tool_group` `{ tools, category, summary }` | its `tools` mapped in order by these rules, each with `groupId`. The group itself is recorded as `{ id, type: "tool_group", category, summary, partIndex: null }` in `segments[]` (provenance, not dropped). |
| `notification` | `{ type: "text", content: message, metadata: { abacus: { segmentId, kind: "notification", severity, actions?, notificationKey? } } }` |
| `credits` | an entry in the message's `metadata.abacus.credits`, plus a `segments[]` entry |
| `web_search_results` | `{ type: "text", content: query, metadata: { abacus: { segmentId, kind: "web_search_results", resultType, results } } }` |
| `media` (image) | `{ type: "image", source: { type: "url", value: url }, metadata: { abacus: { segmentId, width, height, prompt?, model? } } }` |
| `media` (video) | `{ type: "video", source: { type: "url", value: url }, metadata: { abacus: { segmentId, width, height, prompt?, model?, aspectRatio?, duration?, loop } } }` |
| `feature_limit` | `{ type: "text", content: featureName, metadata: { abacus: { segmentId, kind: "feature_limit", featureName, limitType } } }` |
| `compaction` `{ summary }` | `{ type: "text", content: summary, metadata: { abacus: { segmentId, kind: "compaction" } } }` |
| `subtask` | the state machine below |
| anything else | `{ type: "text", content: "", metadata: { abacus: { segmentId, kind: "unknown", raw } } }` (lossless) |

**Tool calls.** A `tool_call` segment `{ toolCall, toolResult? }` maps to two parts:

- `{ type: "tool-call", id: toolCall.id, name: toolCall.name, arguments: JSON.stringify(toolCall.args), input: toolCall.args, state, approval?, output?: toolResult?.output, metadata: { abacus: { segmentId, endpoint?, status: toolCall.status } } }`
- plus a `ToolResultPart` `{ type: "tool-result", id: segmentId + ":result", toolCallId, content, state: resultState, outcome?, error?, metadata: { abacus: { data, rejection } } }`, whenever a result exists or one is synthesised.

The result's `state` never depends on `error` alone. In the AI clone, `outcome` means the call ended without executing successfully, and "state remains `error`" (`ai/src/types.ts:457-458`).

| v1 condition | call `state` | result `state` | result `outcome` | result exists |
|---|---|---|---|---|
| `status: "success"` and no `rejection`, no `error` | `complete` | `complete` | — | if stored |
| `status: "error"`, or `toolResult.error` set | `error` | `error` | — | yes (synthesised with `content: ""` and `error: "failed"` if none) |
| `status: "rejected"`, or `rejection.reason === "rejected"` | `approval-responded`, with `approval: { id: \`${id}:approval\`, needsApproval: true, approved: false }` | `error` | `denied` | yes (synthesised if none) |
| `rejection.reason` is `interrupted` or `sibling_failed`, or `status` is `interrupted`, `skipped` or `abandoned` | `error` | `error` | `cancelled` | yes (synthesised if none) |
| `status` is `pending`, `executing` or `awaiting_permission` (saved mid-flight; can never resume) | `error` | `error` | `cancelled` | yes (synthesised) |

The first matching row wins, top to bottom; rejection and status rows take precedence over a successful status.

**Subtasks: the same positional state machine as `hydration.ts:14-70`.** One variable holds the open bracket (`open: { ref, part } | null`):

| v1 segment | Action |
|---|---|
| `subtask` `created` | If a bracket is open, close it as **completed**: a new bracket while one is open is a hand-back (`hydration.ts:28-29`, default outcome of `finalizeSubtask`). Then open a new `SubagentPart` in the current assistant message: `{ type: "subagent", subagent: { id: created.id, name: kind ?? "delegate", description?, status: "running", messages: [{ id: \`${id}:0\`, role: "assistant", parts: [] }], metadata: { abacus: { startTime? } } } }` |
| `subtask` `completed` with a bracket open | Close it. `outcome ?? "completed"`: frames written before `outcome` existed only ever meant finished (`hydration.ts:47-53`). `"completed"` → `status: "finished"`; `"interrupted"` → `status: "error", error: { message: "interrupted" }`. `endTime` goes into `metadata.abacus`. |
| `subtask` `completed` with no bracket open | Ignored (the `else if` in `hydration.ts:47`), but recorded in the message's `segments[]`. |
| any other segment while a bracket is open | Mapped by the rules above into the open subagent's message parts, not the parent's. A user `text` cannot occur inside a bracket in v1 output; if it does, it closes the bracket as completed and proceeds as a user message. |
| end of file with a bracket open | Close it as interrupted (`hydration.ts:67-68`; history is never live). |

**Freshness, repair and deletion (thread store).** `main/services/session/thread-store.ts` owns `threads/`:

- **`readCurrent(id)`** is used by `ai.hydrate`. When the v2 file is missing or unparseable, or has `source.kind === "transcript-v1"` with `source.updatedAt < v1.updatedAt`, it converts v1, writes the repaired v2 atomically, and returns it. A `source.kind === "agui"` file is returned as is, since AG-UI persistence owns it.
- **`writeFromV1(id, v1)`** is the transition dual-write, called from `TranscriptService.write` after the v1 rename (`transcript-service.ts:73-77`). It runs inside its own `try/catch`: a v2 failure is logged, and `onPersist` (`:79-83`) still runs. A stale twin left by a failed dual-write is repaired by the next `readCurrent`.
- **`remove(id)`** is called from `TranscriptService.remove` (`transcript-service.ts:86-94`). That single function is the path used by conversation reset (`service-host.ts:2631`) and by session and workspace deletion (`service-host.ts:1691`, `:2242`), so every existing removal path deletes the v2 file too. No v2 file outlives its v1 file, and cleared history cannot come back.
- **Idempotent conversion** (step 1 and `readCurrent`): convert when v2 is missing, unparseable, or v1-derived and older. Never overwrite `agui`. Unsafe file names (`transcript-service.ts:18`) and unparseable or non-v1 v1 files are skipped and counted (`corrupt`, `skipped`).
- **Mapper location:** `shared/transcript/v1-to-ui-messages.ts`, a pure function with no Node or Electron imports. The dual-write is removed at cut-over, when main persists v2 from the AG-UI stream.

### C.4 Step 2 and the live legacy sync: renderer durable state → `prefs.json`

**Decision: read main's durable-state store directly. No renderer handoff.** Every persisted renderer key already lives in `userData/renderer-state.json`, owned by `RendererStateStore` (`renderer-state.ts:19-126`):

- All zustand `persist()` stores use `createJSONStorage(() => durableStorage)`: `code-store.ts:386`, `sidebar-accordion-store.ts:29`, `language-store.ts:25`, `credits-store.ts:27`, `code-folder-context.ts:68`.
- The raw keys use `durableStorage` directly: `use-theme.ts:6`, `browser-homepage.ts:5`, `onboarding-flow.tsx:44`, `referral-card.tsx:11`, `credits-exhausted-card.tsx:125`.
- `durable-storage.ts:72-90` has already copied origin-local localStorage into the store.

localStorage itself is per origin, and origins are versioned per experience (`renderer-state.ts:1-6`), so main could not reach a meaningful localStorage anyway. The one gap is a build older than `durable-storage.ts`, whose values sit under an origin no current build can read. That loss is accepted (it is today's behaviour on any swap).

**Three import points, one mapping** (`main/services/config/legacy-prefs.ts`: `mapLegacyKey(key, raw) → PrefsPatch | null`):

1. **Step 2 (one-time):** the step parses the file with `readRendererStateFile(file)`, factored out of the `RendererStateStore` constructor. It maps every known key and plans a `prefs.json` write that applies the patch through the provenance rule (B.2): a field is written only if its stored provenance is not `"user"`, and it is then marked `"legacy"`.
2. **Live legacy sync (transition only):** `RendererStateStore.set` (`renderer-state.ts:49`) calls an injected `onSet(key, value)`, which runs `mapLegacyKey` and `prefsStore.importLegacy(patch)` with the same provenance rule. The old renderer, which remains the shipped UI until Phase 7, keeps `prefs.json` current. Removed with the old renderer.
3. **Final import at cut-over (step 3, C.5):** the same provenance-aware import of the whole file, before the legacy keys are deleted.

Merging is **by provenance, never by default-equality**. An explicit `theme: "system"` chosen in the new UI has provenance `"user"` and is never replaced by a legacy `"dark"`.

| Source key (renderer-state.json) | Format | → `PrefsRow` |
|---|---|---|
| `theme` | raw `"light"\|"dark"\|"system"` | `theme` |
| `abacusai-bot-language` | zustand JSON `{ state: { languageCode } }` | `language` |
| `local-code-ui-store` (v4, `code-store.ts:384-416`) | zustand JSON | `sidebar.pinned` ← `isSidebarVisible`; `models.selectedModelId`, `models.favoriteModelIds`, `models.perWorkspace` ← `workspaceSelectedModelIds`; `defaultMode` ← `globalSelectedMode`; `workspaceExpanded` ← `workspaceAccordionExpanded`; `pinned.sessionIds`/`botIds`; `lastPickedWorkspaceId`. **Dropped:** `codeSidebarTab` (no equivalent). Versions below 4 go through the same field deletions as `code-store.ts:390-403` first. |
| `sidebar-accordion` | zustand JSON `{ state: { openSection } }` | `sidebar.openSection` |
| `abacus-credits` | zustand JSON `{ state: { exhaustedAt } }` | `creditsExhaustedAt` |
| `abacusai-bot-code-folder` | zustand JSON `{ state: { recentFolders } }` | `recentFolders` (`currentFolder` dropped: the URL owns location) |
| `browser.homepage` | raw string | `browserHomepage` |
| `onboarding.step` | raw string | `onboardingStep` |
| `referral-card.dismissed-until` | raw number string | `dismissals.referralCardUntil` |
| `local-code:upsell-dismissed` | presence | `dismissals.upsell` |
| `composer.draft:<workspaceId>` | raw string | **not migrated**: drafts are ephemeral TanStack Store state in the new renderer (PLAN, State). Listed in the release notes. |
| `durable-storage.migrated`, `abacusai-bot.promptSnippets`, anything else | — | ignored |

- Each value is validated with the `PrefsPatch` valibot schema. An invalid field is skipped (left at its current value) and counted in `stats.invalid`. The whole row is never rejected.
- A key **removed** from the legacy store (`set(key, null)`, or `clear()`) resets the mapped fields to their defaults only if their provenance is `"legacy"`.
- `renderer-state.json` is **not modified** by steps 1–2 or by the sync.

### C.5 Later steps (registered only in the cut-over build, listed so ids are reserved)

| Id | Name | Write kinds | Action |
|---|---|---|---|
| 3 | `final-legacy-prefs-import-and-drop` | `replace-user` (`prefs.json`, `renderer-state.json`) | Run the final provenance-aware import (C.4), then remove the mapped keys from `renderer-state.json`. Both files are backed up by the commit protocol. |
| 4 | `archive-transcripts-v1` | removals (move to backup) | Per file, not per directory; the rules follow. |

Per-file rules for step 4:

- **Archive** `transcripts/<id>.json` when its v2 twin is `source.kind === "transcript-v1"` and `source.updatedAt >= v1.updatedAt`. Also archive it when the twin is `source.kind === "agui"`: AG-UI persistence owns the thread, and the v1 file has been superseded. When AG-UI first writes a thread that had a v1-derived twin, it records `migratedFrom.updatedAt`. Such a twin qualifies only if `migratedFrom.updatedAt >= v1.updatedAt`; an `agui` twin without `migratedFrom` means the thread started under AG-UI, and any v1 file with that id is an orphan, archived as such.
- **Quarantine** v1 files that step 1 skipped (corrupt, unsafe name, not v1) into `backups/quarantine/transcripts/`. They are kept 90 days, counted in stats and listed in the log.
- **Convert first:** a v1 file with no qualifying twin is converted, then archived on the next run of the rule. Step 4 is idempotent, so it completes over at most two launches and never waits on a whole-directory condition.

### C.6 Files to add or change (C)

| Path | Change |
|---|---|
| `main/migrations/**` | new (C.1), including `journal.ts` for commit recovery |
| `shared/transcript/v1-to-ui-messages.ts` | new pure mapper (C.3) |
| `main/services/session/thread-store.ts` | new: `readCurrent` (repair), `writeFromV1`, `remove` |
| `main/services/session/transcript-service.ts` | isolated dual-write after the v1 rename (`:73-77`), before `onPersist` (`:79`); `remove` (`:86`) also removes v2 |
| `main/services/config/renderer-state.ts` | extract `readRendererStateFile(file)` (`:29-42`); `onSet` hook in `set` (`:49`) and `clear` (`:82`) |
| `main/services/config/legacy-prefs.ts` | new: `mapLegacyKey` |
| `main/services/config/prefs-store.ts` | provenance-aware `importLegacy`, `update` marks `user` |
| `main/index.ts` | `await runMigrations(...)` before `workspaceServiceHost.initialize()` (`:960`); wire `onSet` to `prefsStore.importLegacy` |

### C.7 Test plan (C)

| Id | Project | Test |
|---|---|---|
| C-T1 | shared | `v1-to-ui-messages.golden.test.ts`: fixtures in `shared/transcript/__fixtures__/v1/*.json` → `expected-v2/*.json`, compared after stable key ordering, with `UPDATE_GOLDEN=1` to rewrite. Fixtures:<br>• plain chat<br>• bash/read/write/edit/mcp/unknown tool calls<br>• every row of the tool-result state table: success; error; `rejected` status; rejection `rejected` with no `error`; `interrupted`; `sibling_failed`; `skipped`; mid-flight `executing`<br>• `tool_group`<br>• subtasks: completed with outcome; **completed without outcome (historical)**; interrupted; consecutive `created` (hand-back); unmatched `completed`; trailing open bracket<br>• image and video media<br>• notification with actions<br>• credits across two turns<br>• compaction<br>• web search<br>• versions and regenerate: two bot turns with different `messageIndex` and no user message between them<br>• an unknown segment type<br>• empty segments<br>• missing `at` |
| C-T2 | shared | Mapper properties over the fixtures plus 200 generated transcripts: every input segment id appears exactly once in some message's `metadata.abacus.segments`; every part-producing segment's id is on its part (by the placement table); the output parses with a valibot `ThreadFileV2` schema; no tool-result has `outcome` with `state !== "error"`; converting twice gives identical output. |
| C-T3 | main | `runner.test.ts` with a temp `ABACUSAI_BOT_HOME` and `userData`: steps run in order; a second run is a no-op; the record is written only after commit; a throwing `plan` leaves no staging, records `lastFailure`, skips later steps, and the next run retries. Commit recovery: kill after the first of three renames (simulated throw) → `replace-user` restored from backup, `create` deleted, `replace-derived` kept, then a rerun succeeds. Failure after all renames but before the record → the rerun gives an identical result. `--rerun-migration`; pruning. |
| C-T4 | main | Step 1 against fixture directories: skip rules (unsafe name, corrupt, v2 newer, v2 `agui`); a stale v1-derived twin is replaced as `replace-derived`; stats counts. |
| C-T5 | main | Step 2 golden: `renderer-state.json` fixtures (v2, v3 and v4 `local-code-ui-store`, missing keys, invalid values) → `prefs.json` expected. Provenance: an existing `prefs.json` with `theme: "system"` marked `user` keeps it against a legacy `"dark"`; a `default` field takes the legacy value; a `legacy` field takes a newer legacy value. The source file stays byte-identical. |
| C-T6 | main | Progress window: not created when the runner finishes in under 400 ms (fake timers); created, updated and closed otherwise (Electron mocked). |
| C-T7 | main | Thread store: a dual-write produces the matching v2; a v2 `agui` file is not overwritten; a failing v2 write does not stop `onPersist`, and the next `readCurrent` repairs the stale twin; `TranscriptService.remove` deletes both files. A reset via `resetAgentConversation` and via the new `agent.reset` both leave `ai.hydrate` empty, and a session delete and a workspace delete remove both files. |
| C-T8 | main | Live legacy sync: `RendererStateStore.set("theme", "dark")` updates `prefs.json` when the provenance is not `user`, and publishes a `db.prefs` change; `set(key, null)` resets only `legacy` fields. |
| C-T9 | main | Step 4 (registered in the test only): archives per file with v1 twins and with `agui` twins (with and without `migratedFrom`); quarantines skipped files; converts then archives a file with no twin across two runs. |

### C.8 Acceptance (C)

- [ ] C-T1…C-T9 green.
- [ ] Against a copy of a real `~/.abacusai-bot` (the developer's own, anonymised copy kept out of git): the migration completes; `threads/` has one file per `transcripts/` file (minus corrupt ones); `ai.hydrate` for three sample sessions returns messages whose text parts match what the old UI shows.
- [ ] The old renderer still opens every session with its full transcript after migration (the v1 files are untouched).
- [ ] Prefs: theme, language, pinned bots/sessions, favourite models and default mode read from `db.prefs` equal the old UI's, including after changing them in the old UI post-migration (live sync).
- [ ] Killing the app mid-migration (a `SIGKILL` during step 1's commit in a manual test) leaves a consistent state, and the next launch recovers from the journal and finishes.
- [ ] Clearing a conversation in the old UI, then opening it through `ai.hydrate`, shows it empty.
- [ ] No progress window appears on a machine with fewer than 50 transcripts. With about 2k synthetic transcripts it appears and closes before the main window.

### C.9 Risks (C)

- **Transcript volume.** Heavy users have thousands of large files. The step streams file by file (never all in memory), yields to the event loop every 20 files so the progress window paints, and uses a 1 MB read buffer. The worst case is bounded by disk reads, since the mapping itself is linear.
- **Mapping fidelity.** Nothing is dropped: display-only fields (`thinking.title`, `tool_group` category and summary) move into `metadata.abacus.segments`. The chat kit (Phase 2) must render `metadata.abacus.kind` text parts and read `metadata.abacus` for edit and version targets. That is a named dependency, not something decided here.
- **Two writers of `threads/`.** The dual-write and hydrate repair (v1-derived) and future AG-UI persistence (`agui`) could collide. The `source.kind` rule makes `agui` always win, and the cut-over removes the dual-write and repair.
- **Provenance mistakes.** If a code path wrote prefs without marking provenance, a legacy value could overwrite a user choice. `PrefsStore` is the only writer, and its two entry points (`update`, `importLegacy`) are the only ways provenance is set (C-T5, C-T8).
- **Timestamps.** Only v1 segments saved after `persistence.ts` began stamping `at` have times. Older threads have no `createdAt`, and the UI must tolerate that (it already does for separators).
- **Startup latency.** The runner is awaited on the startup path. It is a no-op after the first run (one small JSON read plus a `.migrating/` directory check).

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
- DB wire: `hello` → snapshot → contiguous seq batches; positions are `{ epoch, seq }`; `reset` via `truncate()`; full-row updates; streams reopen on error **or** EOF. Mutations resolve when their echo is *received* (awaiting *applied* would deadlock inside TanStack's persisting transaction); `awaitApplied` exists for loaders. `markReady()` is called after every usable snapshot while loading or errored.
- Event delivery has three declared classes (lossless-replayable, lossless-actionable, coalescing), filtered before buffering. oRPC's `EventPublisher` is not used for delivery.
- A swap flips only after the candidate passes the subscription readiness barrier, or it is aborted after 10 s.
- `gitState` covers the active workspace only for now. `memories` has no insert. `workspaces` has no insert (it uses `workspaces.add`).
- The prefs migration reads `renderer-state.json` in main. There is no renderer handoff. Legacy keys keep syncing into `prefs.json` for the whole transition. Merges are by provenance (`default`/`legacy`/`user`), never by default-equality.
- Transcripts become `threads/<id>.json` (v2 UIMessage JSON) with full segment provenance. v1 is kept until the cut-over build. Main dual-writes and dual-removes v2 during the transition, and `ai.hydrate` repairs a missing or stale twin. Migration commits are journaled, with backups for `replace-user` writes.
- Composer drafts are not migrated.

## Implementation notes (sub-slice A)

Where the implementation of A differs from the text above, and why.

- **Renderer path.** The transport is `src/renderer-next/data/transport/` (spec 01 §15.1), compiled by its own `tsconfig.renderer-next.json` with no Node or Electron types, and tested in the `renderer-next` vitest project.
- **Where the transport is installed.** `installMessagePortTransport` is called from `main/index.ts` right after `registerIpcHandlers` (which now returns the shared `HostOperations`), because its deps (`appOperations`, the renderer-state store, the browser runtime) live there. The order relative to `setEventDispatcher` is as specified.
- **`emitIpcEvent`** lives in `main/rpc/emit.ts`; `event-bus.ts` stays Electron-free so the router loads with `electron` made to throw (A-T5). oxlint has no `no-restricted-syntax`, so the "only `emit.ts` sends on `IpcChannels.Event`" rule is a test (`main/rpc/emit.test.ts`). The browser runtime keeps its per-window legacy send and publishes to the bus beside it.
- **Shared handler bodies.** `handler.ts` gained `createHostOperations` (sign-in/out, key storage, the local-model runtime, custom instructions, referral WhatsApp, `runRoutine`) and `main/index.ts` an `appOperations` object (dialogs, file readers, logs, notifications, account, skills import); both the `ipcMain` handlers and the procedures call these.
- **`terminal.output`** takes `conversationKey` as well (terminal ids are per conversation), and its `snapshot` carries `from`: equal to `fromOffset` for a delta, the scrollback's start for a full replacement. `BoundedScrollback` counts every byte ever appended (`end`), and the registry keeps the last 8 exited terminals for a late reader's sticky exit.
- **`files.events` `tree-root-changed`** has no `workspaceId`: the legacy event names none (it is the active workspace's tree).
- **`files.savePastedTemp`** keeps `baseFolder`: the legacy handler writes under `<baseFolder>/.abacusai-bot/temp/`, so dropping it would change where files land.
- **`devices.stream.chunks`** is declared lossless-actionable with a 16 MB pending-byte cap (a dropped H.264 delta frame corrupts every frame until the next key frame). A-T8 measured a 0.40 ms median (p95 0.48 ms) per 64 KB chunk on an M-series Mac, well under the 5 ms target, so the raw side port stays unbuilt.
- **Swap readiness (A.4.6)** is in `RendererHost` (`barrier: "subscriptions"`, `SWAP_READY_TIMEOUT_MS`, `SwapNotReady`, `SwapRetryBudget`). `scheduleRendererSwap` asks for it only when `FOUNDATION_API >= 2`; the integrity check admits only experiences built for the shell's own value, so that is also the candidate's contract. `FOUNDATION_API` is **not** bumped in A: bumping it refuses every published experience built for 1 and needs `apps/updater` in the same release, which is a release decision, not a transport one.
- **Spec 01 §15 amendments folded in:** `window.chrome` (query, the state `window:chrome` serves, now one `currentChromeState()` in main) and `window.events` `{ type: "chrome", chrome }` (published on capability, full-screen and density changes); `PrefsRow.language` is `"system" | SupportedLanguage` (`SUPPORTED_LANGUAGES` in `rows.ts`, checked against `renderer/locales/`).
- **A-T12** is a `main-serial` vitest test (`main/rpc/transports/rpc-handshake.electron.test.ts`) that bundles a real main process (`rpc-handshake.e2e-main.ts`), the real preload handshake and a page using the real renderer transport, and drives loads, five reloads and a `RendererHost` swap under the `subscriptions` barrier, then the delayed-handshake run. It stands in for `scripts/e2e/rpc-handshake.mjs`. It also checks, in real Chromium, that a transport closed locally settles its pending calls.

Added by the implementation review fixes (`reviews/00-transport-A.impl-fixes-r1.md`):

- **Iterator flow control (A.4.3).** oRPC 1.15.4's server peer drains a returned iterator into the port as fast as `send` resolves, and the client peer queues without bound (`resolveEventIterator` and `AsyncIdQueue` in `@orpc/standard-server-peer`/`@orpc/shared`), so the subscriber-queue caps never applied to a renderer that stopped reading. `shared/contract/flow-control.ts` adds credits: every call carries `x-abacus-flow: <id>;<window>` (window 64), main's handler interceptor pulls an iterator only while it holds credit, and the renderer's link acknowledges each event its consumer takes from `next()` with an `abacus:rpc-flow-ack` message on the same port (batched per microtask; main's port wrapper takes these out before oRPC decodes). A stalled consumer leaves the backlog in main's queue, where the class's cap ends it with `RESYNC_REQUIRED` and the listener is detached at once. The WebSocket transport sends no header and is ungated.
- **`Transport.close()`** also runs the link's own `close` listeners: the HTML spec fires `close` only at the other end of a channel, so closing locally left pending calls and reads unsettled.
- **`terminal.output`** ends with exactly one of `exit` or `{ type: "retired", reason: "closed" | "superseded" }`. `close`, the disposals and a scope promotion retire a generation without an exit of its own (the PTY's exit is suppressed once the generation is invalidated); the registry's `onRetire` publishes the bus-only `terminal-retired` channel (no legacy event), and the retirement is sticky for a late reader, with a frozen copy of the scrollback. Pending bytes are counted in UTF-8.
- **Keyless actionable streams** (`browser.events`, `connectors.events` without `conversationKey`) snapshot every conversation's pending asks, matching their live filter.
- **Device chunks** are delivered by one `deviceChunkSender` (`main/rpc/device-chunks.ts`) that keeps the legacy send and publishes to the bus; both the legacy `ipcMain.handle` and `devices.stream.start` use it. A tracker keeps each stream's current group of pictures from capture start (key frames carry SPS/PPS), and `devices.stream.chunks` opens on it, or holds live delta frames back until the first key frame.
- **Window facts** (`window.events` state and chrome) are published to every registered view in the window, so a swap candidate subscribed before the flip stays current; the legacy `window:chrome-changed` send still goes to the live view only.
- **Iterator errors** go through `toRpcError`/`logRpcError`: `rpcClientInterceptor` wraps a returned iterator, since oRPC consumes it after the interceptor returns.
- **Navigation (A.4.2).** The port closes when a main-frame cross-document navigation *commits* (`did-navigate`), not when it starts, and only if it is still the port the document had at `did-start-navigation`: a download, a 204 or an aborted navigation leaves the live document's port, and a new document that connected first keeps its own. A-T3 therefore counts `did-start-navigation`, `did-navigate` and `destroyed` listeners (one each), and `dispose()` removes all three. A destroyed contents fails its readiness waiters at once (`RendererReadiness.discard`).
- **NOT_FOUND (A.5).** `shared/not-found.ts` gives services `WORKSPACE_NOT_FOUND` (the same legacy result string) and `EntityNotFoundError` (the same legacy `Error` text); `workspaces.switch`/`relocate` and `routines.editByChat` map them to `NOT_FOUND { entity, id }`.
- **Swap retries** live in `RendererSwapScheduler` (`renderer-host.ts`): a `SwapNotReady` retry waits for the next idle poll, and the budget is keyed on the bundle URL actually swapped to and checked before the swap.
- **`scripts/rpc-ws-smoke.mjs`** exists (A.8): it bundles the router, the WebSocket transport and the test fakes with rolldown, `electron` made to throw, and runs the A-T5 checks, or `--serve` keeps the server up. `websocket.smoke.test.ts` runs it.
- The shipped preload never reads `ABACUS_TEST_HANDSHAKE_DELAY_MS`; only A-T12's own preload entry passes a delay.

## Deferred additions (for B and C)

- **Startup theme from prefs (spec 01 §7.7, §15.4).** When the renderer generation is `wco`, main reads `prefs.theme` through `PrefsStore` before `new BaseWindow`, sets `nativeTheme.themeSource`, and passes the resolved scheme to the window's initial `backgroundColor` (the window-chrome options module already takes `dark`). Needs B's `PrefsStore`; test: `createWindow` sets `themeSource` from prefs before constructing the window.
- **Legacy language import (C.4).** `abacusai-bot-language` maps to the explicit code when present; otherwise the row keeps `"system"`, the new default.
- **A-T1b** adds `@tanstack/db` and `@tanstack/react-db` types when B installs them.
- **A-T11** (`renderer-next/data/queries/invalidation.ts`) lands with the renderer's query layer (spec 01 §8.4).

## Implementation notes (sub-slice B)

Where the implementation of B differs from the text above, and why. The startup theme and A-T1b items of "Deferred additions" are done here; the C.4 language note is left for C.

- **Versions.** `@tanstack/db` **0.9.2** and `@tanstack/react-db` **0.4.1**, the latest published (npm, 30 Sep 2026). 0.10.0 / 0.4.2 exist only in the cloned repo and are not on the registry. The APIs B relies on are the same in 0.9.2: `commit()` returns `true` or a visibility receipt, `truncate()` and `immediate` transactions bypass a persisting user transaction (`collection/state.js`), `error → ready` is a valid transition and `markReady` clears `syncError`.
- **Renderer path.** `src/renderer-next/data/db/` (not `renderer/data/collections/`): `ipc-collection-options.ts`, one `tables.ts` holding the nine `<table>CollectionOptions(transport, overrides?)` factories (not one file per table), and `index.ts` with the module-level singletons over `getTransport`. The factories take a lazy transport so tests pass an in-memory one. `tables.ts` takes `transport.client.db.<t>` uncast, so the compiler checks that the real client satisfies `IpcTableClient`.
- **Writes of changes are upserts.** Insert and update changes are both written as `{ type: "update", value }` (with `rowUpdateMode: "full"` an update is a full-row upsert). TanStack checks a sync *insert* against its **applied** rows, which lag a delete still queued behind a persisting transaction, so a delete then re-create of one key would throw `DuplicateKeySyncError`. Snapshot rows are still written as inserts (in their own, truncating transaction). Change events are derived from visible state, so subscribers still see `insert` for a new row.
- **Overflow ends with `reset` then `RESYNC_REQUIRED`** (B.4 says `reset` then end). The feed yields `{ kind: "reset" }` and then throws the typed `RESYNC_REQUIRED` iterator error, so the drop is explicit on the wire and in the error model (A.5), and the client does what it would for an EOF: resync on the reset, reopen on the end. The per-subscriber queue is A's `SubscriberQueue` (`lossless-actionable`, `maxEvents` 5,000), gated by A's flow control like every iterator; an overflowed subscriber is detached at once. The overflow reset **reuses the feed's current seq** and advances nothing (it is that subscriber's alone). Every batch the stream lost is at or below it, so a client that has not seen it re-snapshots, and one whose snapshot already reached it may drop it (next bullet). B-T1 (12b) replays the exact wire shape: `reset`, then `RESYNC_REQUIRED`.
- **Snapshot loop (client).** B.3 step 6 is one loop per connection with one `finally`: a pass fetches, replaces and flushes; a `reset` or gap met in the flush, or a `resync()` asked for while a pass runs, sets `again` and the same loop runs another pass. Nothing reassigns the in-flight promise, so the connection cannot wedge. **A batch with `seq <= received` is dropped before its kind is looked at**, a `reset` included: the snapshot that brought `received` there was read after it. `utils.resync()` resolves only on a pass *started after the call*, so an echo timeout is never settled by an older in-flight snapshot, and it rejects (`AbortError`) when no sync session exists. The echo wait (`awaitEcho`, also on `utils` for writes made outside the handlers) is bounded twice (the echo, then the covering resync) and then resolves, leaving reconciliation to the next snapshot. A handler starts the sync of a collection still `idle`, because TanStack 0.9.2 does not start sync on a mutation. A sync write that throws cancels its transaction (`commit` with an aborted signal) and resyncs. The reconnect backoff resets after an applied snapshot, not on `hello`. A connection stops being current as soon as its stream ends.
- **`TableFeed`.** `read` is synchronous (every source is). `snapshot()` re-diffs first, so its rows are current and its seq is the batch that made them so (B.4 said "from the cached baseline"; the baseline is still what is served, after the diff). A table nobody has read is not diffed at all (`notify` with no baseline and no subscriber does nothing), so the legacy-only app pays nothing. A row equal to its baseline (custom `equals`) keeps the baseline value, so a snapshot never differs from the batches before it. `onPublish` chains derived tables (`routineRuns` on `sessions`). `notify` failures are logged; `notifyNow`/`snapshot` failures reach the caller.
- **Sources.** The tables read a `TableSources` interface (`main/rpc/tables/sources.ts`) that `ServiceHost` satisfies: new `listSessionTurnStates`, `onSessionsChanged`, `onWorkspacesChanged`, `onBotsWritten` (bot-store `onBotStoreWrite`), `onRoutinesWritten` (cron-store `onCronStoreWrite`, added beside the events as a direct hook), `gitStateWorkspacePath` (the runtime snapshot's `workspacePath`) and `botHome`. The session hook fires from `persist()` **and** the debounced `schedulePersist()`, since `updateFromCliState` changes the list before it is persisted. `WorkspaceService.onChanged` fires from `persist()` and `dispose()`.
- **Triggers.** `bots-updated` re-diffs `bots` only: it also fires on every bot transcript save. `routines` and `memories` show bot names, which change only in a `bots.json` write, so the bot-store hook re-diffs all three. `routineRuns` is notified from the session triggers themselves (the events, `sessions-reloaded`, the session hook), not only through a sessions batch: a `sessions` feed nobody reads publishes nothing to chain on. `metadata-updated` and the workspace hook also re-diff `gitState`. `gitState` ignores `lastUpdatedAt` (stamped on every read), and **publishes no row until the runtime snapshot describes the active workspace** (`TableSources.gitStateWorkspacePath()`, the runtime's `workspacePath`, compared with the active workspace's local path). A workspace added, or the active one deleted, changes the metadata before the asynchronous refresh finishes, and the previous workspace's changes must not appear under the new id. `artifacts` rows are filtered by whether their file exists, which no ledger write reports, so the table is re-diffed every 2 s while it has a reader. The `routines` clock (60 s, unref'd) likewise runs only while `routines` has a reader. `TableFeed.whileSubscribed(activate)` and `MainEventBus.whileListened(channel, activate)` arm and disarm these.
- **Memory stale-click guard with duplicates.** Index + entry cannot tell a stale click on the first of two identical entries from a fresh one (the second slides into its slot). `MemoryRow` gains `occurrences` (copies of the entry in its list), `db.memories.delete` sends it back (optional in `MemoryDeleteInputSchema`), and `forgetEntryAt` / `forgetBotMemoryEntry` compare the current count under the store lock. The legacy IPC passes nothing and behaves as before. B-T3's race: two deletes of `:0` of `["a","a"]` → one succeeds, one `CONFLICT`, one entry left.
- **Memory watchers** (`MemoryWatchers` in `tables/memories.ts`) watch the home (filtered to `memories`/`bots`), `memories/`, `bots/`, each `bots/<id>/` (filtered to `MEMORY.md`/`memory`) and each `bots/<id>/memory/`, reconciling the set on every relevant event. Each watcher keeps the `dev:ino` of the directory it was armed on, so a directory replaced at the same path inside one debounce is re-armed. A home that does not exist yet is waited for from its parent. The watchers run only while `memories` has a reader or `memory.events` has a listener, so the legacy-only app pays nothing. `memory.events { type: "changed" }` is published per debounced watcher change, and on a `bots.json` write that changes the `memory.bots` view (a rename, or a bot added or removed; compared with the last view published), not per `notify`.
- **Errors.** `shared/conflict.ts` adds `ConflictError` (same `Error` name and message for legacy IPC), mapped to `CONFLICT` by `toRpcError`; thrown for a taken caller id (sessions, bots, routines) and by the memory stale-click paths (`ServiceHost.failIfNotDone`, `forgetBotMemoryEntry`). bot-store and cron-store "No bot/job with id" become `EntityNotFoundError` (`NOT_FOUND { entity: "bot" | "routine" }`), same message. `badRequest` covers a memory delete whose scope and target/bot disagree. Mutations on a missing session or workspace are `NOT_FOUND`, not an idempotent echo.
- **Caller ids.** `AgentSessionManagerService.create(…, id?)`, `ServiceHost.createAgentSession(ws, routineId, owner, id?)`, `createBot(input, id?)`, `createJob(input, id?)` / `createRoutine(input, id?)`. The contract's id atoms validate the shape; a taken id is `ConflictError`. A minted id (`bot-<now>-<n>`, `job-<now>-<n>`) is checked against the stored ids and minted again on a clash, since a caller's id may look minted (same clock, same counter).
- **Read-only fields.** A collection `update` that touches a field the table does not let the client write throws `ReadOnlyFieldError` (`code: "FORBIDDEN"`) from the handler, so the optimistic change rolls back. It is no longer dropped from the patch, which made the call succeed and the change silently revert.
- **Workspace delete is two-stage.** `db.workspaces.delete` calls `removeWorkspace`, which first tombstones a live workspace (`status: "deleted"`, its sessions stay readable) and erases only a tombstone (`service-host.ts:1702-1716`, the legacy behaviour). The collection's optimistic delete is therefore followed by the row's return as an update with `status: "deleted"`. The shell lists workspaces with `status !== "deleted"`, and a second delete erases.
- **Prefs.** `PrefsStore` (`main/services/config/prefs-store.ts`) keeps the row lazily (defaults on first read, **no file written until a change**, so downgrade safety is kept), validates each stored leaf on load (an invalid one falls back to its default) and implements both writers now: `update` (marks `user`, even for a value equal to the stored one) and the provenance-aware `importLegacy` that C's step 2 and live sync will call. `language` defaults to `"system"` (spec 01 amendment). `onChanged(row, previous)` fires only when the row changed. A write is **staged, persisted, then published**: if the atomic write fails, neither the row nor the provenance changes, and a retry writes again.
- **Prefs provenance is per leaf** (the shape C builds on). A leaf (`PrefsLeaf`, `shared/contract/rows.ts`) is a scalar field (`theme`, `language`, `defaultMode`, `workspaceExpanded`, `lastPickedWorkspaceId`, `recentFolders`, `creditsExhaustedAt`, `browserHomepage`, `onboardingStep`, `panes`) or one member of a group: `sidebar.pinned`, `sidebar.openSection`, `pinned.sessionIds`, `pinned.botIds`, `models.selectedModelId`, `models.favoriteModelIds`, `models.perWorkspace`, `dismissals.referralCardUntil`, `dismissals.upsell`, `motion.reduce`, `sounds.enabled`, `sounds.perEvent`. Records are whole leaves. `prefs.json` is `{ row, provenance: Record<PrefsLeaf, "default" | "legacy" | "user"> }`. A group-level mark from the earlier per-field format applies to each of its leaves on load. `PrefsPatch` (and `PrefsPatchSchema`) take any subset of a group's leaves (`{ sidebar: { openSection: "bots" } }`); unknown fields and leaves are refused on `update`. `importLegacy` validates and applies each leaf on its own: it skips `user` leaves, counts invalid or unknown ones, and never invents a sibling. C.4's two keys into `sidebar` and two into `dismissals` therefore each import their own leaf, and C's reset of a removed key is per leaf too (`PREFS_LEAVES`, `getPrefsLeaf` are exported). On the renderer, a collection update sends only the leaves that differ from the row the user saw. `updatePrefs(patch)` (`renderer-next/data/db`) sends every leaf it names, even one equal to the current value, so an explicit choice becomes `user`. A plain `collection.update` cannot do that, because TanStack drops an assignment of the current value before any handler runs.
- **Startup theme.** `main/startup-theme.ts`: `mainWindowOptions` is the whole of `createWindow`'s option assembly. In wco it first sets `nativeTheme.themeSource` from `prefs.theme` (`applyStartupTheme`), then reads the chrome input, and puts the background **last** (`{ ...base, ...chrome, backgroundColor }`), so the chrome's fixed Linux overlay backdrop cannot override it. `themedBackground` stays transparent only while vibrancy (macOS) or mica (Windows) paints the backdrop; with reduced transparency, and always on Linux, it uses the resolved scheme's surface (`WINDOW_SURFACE`). `refreshWindowChrome` also applies it to the window and the renderer's view (`applyThemedBackground`), so reloads and swap candidates paint in the current scheme. `followPrefsTheme` sets `themeSource` and re-applies the window chrome when `prefs.theme` changes (installed in every generation; in the legacy one only C's sync will change it, to the value `theme:set` already applied). The legacy generation's options are unchanged (a test asserts the exact object on each platform). `window-chrome-options.ts` is untouched.
- **A-T5** also streams `db.bots.changes` (hello, snapshot, a batch for a fake change) over the WebSocket; the `A-T2` "UNAVAILABLE" case no longer names `db.*`.
- **B-T4** lives in the `main` project and imports the renderer's collection factories by path at run time: a static import across the `main` and `renderer-next` TypeScript projects is a TS6307 error. It covers all nine tables (snapshot, live change, reset with truncate) and every mutation.
- **Not done in B:** the development-only valibot row schema on `db.*.snapshot` outputs (A.1 conventions) is not added; the in-app acceptance checks of B.7 (a scratch page mounting `useLiveQuery`, old-UI edits appearing within a frame, sign-out/sign-in) were not run here, only their automated equivalents (B-T3, B-T4).

## Implementation notes (sub-slice C)

Sub-slice C was built in two parts. This part covers the runner (C.1), step 2 and the live legacy sync (C.4, including the "Deferred additions" language rule), and the progress window. Step 1 (transcripts → `threads/`, C.3) and everything that depends on it is not in this part (see the last item). Where the implementation differs from the text above, and why:

- **Files.** `main/migrations/`: `types.ts` (the C.1 contract), `record.ts`, `journal.ts`, `backup.ts`, `runner.ts`, `progress-window.ts`, `startup.ts` (the Electron wiring), `write-block.ts` (the Electron-free write-block predicate), `steps/index.ts` (`MIGRATION_STEPS`) and `steps/002-prefs-from-renderer-state.ts`. `main/services/config/legacy-prefs.ts` holds the mapping and the sync. `runner.ts` imports no Electron, so C-T3 runs it directly.
- **Record.** Each `applied` entry carries `commit` (the stamp), `attempt` (a random id unique to the commit attempt, also in its journal) and `backup` (its backup directory's name). A journal whose step **and** attempt are recorded belongs to a commit that finished, so its staging is deleted and nothing is undone; a stamp alone is not enough, since two steps can commit in one millisecond. `partial` holds the last commit of a step whose plan left `pending` work (see "Step 4 and `pending`"). `lastFailure` is cleared when that step later succeeds. `readRecordState` tells apart `missing`, `ok`, `corrupt` (bad JSON or shape), `unreadable` (a read error other than absence) and `newer` (`version` > 1):
  - `corrupt` with an unfinished journal pending: whether it committed is unknown, so the attempt is unresolved (below). With none pending, the file is kept as `migrations.json.corrupt-<stamp>` and the steps run again (they are idempotent).
  - `unreadable`: no step runs and nothing is written.
  - `newer` (a downgrade): nothing is judged, no step runs and the record is never written, so the newer build's fields survive.
- **Journal** (`journal.ts`, version 2). `commit.journal` is the plan, written once, atomically, before the first move: attempt, step, stamp, backup directory, and each write with its kind, backup and, for `replace-user`, the sha256 of the original and of the staged file. Progress goes to `commit.log`, append-only, one JSON line per event: `done` after each move, `undone` after each rollback operation, and `recorded` once the record holds the attempt. Every line carries the attempt. A torn last line (a crash mid-append) is ignored, and a rollback trims it before appending. Any other malformed line invalidates the journal. `readJournal` validates the whole journal and log before recovery touches anything: the version, the attempt, that the step matches its staging's name, the stamp, the backup directory (it must be the one this attempt would use), every write's kind, destination (absolute, normalised, under the home or userData, never `.migrating/`, `backups/migrations/` or `migrations.json`), staged path (inside the staging, used once), backup (exactly `backupPathFor(dest)` for `replace-user`, null otherwise) and hashes, every removal's backup, and that no path is touched twice. Only a journal that is genuinely absent (ENOENT) counts as missing.
- **Commit protocol.** Backups copy only `replace-user` destinations, hash-checked against the original. Removals are moved into the backup directory by the commit instead, so a large archive (step 4) is never written twice. A `create` whose destination has appeared since the plan is committed as `replace-user` (backed up); a `replace-user` whose destination is gone, as `create`. Then the journal, then the moves (each followed by a `done` line), then the record, then its `recorded` line, then the staging (journal first). The commit loop is `async`: it yields to the event loop every `yieldEvery` (20) moves and reports progress for the commit phase (the plan gets the first 80% of a step's share, the commit the rest). `moveFile` falls back to an atomic copy then an unlink on `EXDEV`; renames retry briefly on Windows EPERM/EACCES/EBUSY. Temp files are `<dest>.migrating-tmp` (fixed, so recovery sweeps them).
- **Recovery.** Per staging directory, after every journal is read and validated:
  - no journal: discarded;
  - recorded (the record holds the step and attempt, or the log has `recorded`): finished; the staging is deleted;
  - otherwise rolled back, then the journal is deleted, **then** the backup directory, then the staging. Once the journal is gone the attempt is over, so no crash can leave a journal whose backups are gone; a leftover backup directory is an orphan, pruned by age.
  
  The rollback does not depend on `done`: every operation is correct whether or not its move happened, so the cross-volume window (destination published, staged source not yet unlinked) needs no log entry. A `create` destination is deleted (it did not exist when the commit began, and nothing else writes it before recovery). A `replace-derived` one is kept. A `replace-user` one is judged by content: equal to the original means nothing to do; equal to the staged file, or missing, means restore from the backup (a missing backup is then an error); anything else was written after the commit and is **kept**, not overwritten, and logged. A removal is moved back when the original is gone; both gone is an error unless the log says this rollback already restored it. Each operation appends `undone`, so repeating a rollback after a crash part way is safe.
- **Unresolved attempts.** A journal that is unreadable or invalid, `.migrating/` that cannot be listed, a record that cannot judge an unfinished journal, or a rollback that throws: the attempt is left exactly as found, `lastFailure` is recorded (when the record is writable), no step runs, and nothing is pruned. `RunMigrationsResult.unresolved` lists each attempt with the destinations it may cover (`null` when the journal cannot be read, which means every destination). The app still starts. `write-block.ts` holds them for the launch: `isMigrationWriteBlocked(file)` is true for a listed destination, or for any file when one attempt's destinations are unknown. `index.ts` swaps `PrefsStore` onto a session-only copy of `prefs.json` in the temp directory when it is blocked (`prefsFileAfterMigrations`), so the UI works and nothing it saves can overwrite, or be overwritten by, the next launch's rollback. Those session changes are not kept. The manual way out of a permanently unresolved attempt is PARITY.md's: inspect `.migrating/<id>-<name>/`, restore from its backup directory, delete the staging.
- **`--rerun-migration`** is applied after recovery, so a finished commit whose staging survived is judged against the original record, then the step is re-planned from the current files.
- **Pruning** runs at the end of every launch that got there without a failure, including one with nothing pending (it is one `readdir` of each root), and never while an attempt is unresolved. Only backup directories the record references (applied and partial commits) count toward the newest 3 per step; any other (an undone or abandoned attempt) goes only when it is 30 days old. A directory is renamed to `.pruning-<name>` before its `rm -r`, and leftovers are swept first, so a crash never leaves a partial backup under a valid name. Quarantine entries are aged by a `<stamp>/` directory name when they have one (`quarantineDirFor`, for anything *moved* in, since a move keeps the source's mtime), else by mtime, which step 4's quarantine copies make the quarantine time because each is written fresh into staging.
- **Runner API for steps** (step 1 at about 2k files, step 4). A step still only plans. The runner's cost per file is one rename and one appended log line (no journal rewrite), plus a hash for `replace-user` writes only; the journal is written once. The plan should yield on its own every 20 files (`ctx.progress` and an `await` of `setImmediate`); the commit yields every 20 moves. A step whose output a running service also writes (the transcript dual-write writes `threads/`) should have that writer check `isMigrationWriteBlocked(file)` before writing, although for step 1's `create`/`replace-derived` outputs a rollback only removes or keeps derived data (the v1 source is untouched).
- **Test seams.** `CommitHooks.afterMove`/`beforeRecord`/`afterRecord`: a throw is a failure in this launch and is undone at once; returning `"crash"` stops the runner dead, as a `SIGKILL` would. `RunMigrationsOptions.io` (`MigrationIo`) carries every filesystem call, which the kill harness uses; `attemptId` and `yieldEvery` are also injectable.
- **Progress window.** When the runner resolves, the window is **hidden**. It is destroyed only after `createWindow`, from a `.finally` on the startup chain (so also when the chain fails before a window exists) and on `before-quit`. Destroying the only window fires `window-all-closed`, which quits the app on Windows and Linux (`recreate-main-window.ts`). It is created `closable: false`, `minimizable: false`, `maximizable: false`, `skipTaskbar: true`, and its `close` is prevented, so Alt+F4 cannot quit the app mid-migration. Its colours follow the old UI's `theme` key, else the OS. Overall progress is reported as `done/total` in thousandths across the steps that run.
- **Mapping (`legacy-prefs.ts`).** A prefs field can take values from several keys: `sidebar` from `local-code-ui-store` and `sidebar-accordion`, and `dismissals` from two keys. So `composeLegacyPrefs` builds each field from **every** key the old renderer holds, starting from what the old renderer shows for a missing member. The only such base value that differs from `PREFS_DEFAULTS` is `sidebar.openSection = "bots"` (`sidebar-accordion-store.ts`). `mapLegacyKey(key, raw)` returns one key's part of a field. A field is either valid, invalid or absent:
  - **Valid:** it takes the composed value (provenance rule).
  - **Invalid:** a present key whose part is unusable, or a composed value that fails `PrefsPatchSchema`. The field is left at its current value and counted in `stats.invalid`. For a member field (`sidebar`, `models`, `pinned`, `dismissals`) with some usable keys, the usable keys are composed over the base and imported, since the old renderer shows the base for what the unusable key would have held; it is still counted in `stats.invalid`. Only when every key for it is unusable is it left.
  - **Absent:** no key present. The field goes back to its default only if its provenance is `"legacy"` (new `PrefsStore.resetLegacy`, which also sets provenance back to `"default"`). For `sidebar` this is deliberately the new default (`openSection: null`), not the old UI's `"bots"`: importing a value the user never chose would mark it `"legacy"` and create `prefs.json` for a profile with no legacy state at all.

  A zustand value stored with another version, or with none, for a store without `migrate`, holds nothing, as zustand discards it (`stored.version !== options.version`). `local-code-ui-store` below v4 needs no deletions of its own, because the fields `code-store.ts` deletes map to nothing.
- **Language (Deferred additions).** An explicit supported `languageCode` maps to itself. Anything else in the key (corrupt, or unsupported) maps to `"system"`, as `i18n.ts`'s `storedLanguage` falls through to the OS. With no key, the field is absent.
- **Other key rules.** `browser.homepage` goes through the old UI's `normalizeBrowserHomepage`: blank, or not http(s), maps to `null` (the default); anything else is the normalised URL. `onboarding.step` outside the old UI's `STEP_ORDER` maps to `null`, as `onboarding-flow.tsx` reads it. Both predicates are duplicated in `legacy-prefs.ts` (main cannot import the renderer) and checked against the renderer sources in `legacy-prefs.test.ts`. `referral-card.dismissed-until` is `Number(raw)` and is invalid when not finite. `recentFolders` is not truncated: more than 5 is invalid.
- **Unreadable `renderer-state.json`.** `readRendererStateFile` throws for a file that exists but cannot be read (EACCES, EBUSY); a missing or corrupt file still reads as empty. Step 2 therefore fails and retries instead of recording an import of nothing. `RendererStateStore` catches it and starts empty, as it always has.
- **Live sync.** `RendererStateStore` gains `get(key)` and `onSet(listener)`. The listener runs after each change that took effect: never on a no-op write, once per key removed by `clear()`, and a throwing listener is logged. `installLegacyPrefsSync(rendererState, prefsStore)` is called right after `registerRendererState()`. Beyond C.4, it **imports the whole legacy state once at install**, which covers a launch whose step 2 failed ("PrefsStore … receives the live legacy sync") and anything an older build changed since. After that, each set of a mapped key re-imports only that key's fields. Unmapped keys (drafts, `durable-storage.migrated`) cost one map lookup. Nothing in the sync writes `renderer-state.json`.
- **Step 2.** The import runs through `PrefsStore` on a staged copy of `prefs.json`, so the provenance rule is the store's own. When the import changes nothing, the plan has no write, so a rerun makes no backup. `stats` = `{ keys, imported, keptUser, invalid, reset, written }`.
- **Tests.**
  - C-T3: `runner.test.ts`, and `runner.crash.test.ts`, the kill harness: every mutating filesystem call goes through `MigrationIo`, and the harness kills the process at each one in turn (a write, append or copy leaves a torn prefix; every later mutation fails without effect). It runs a full commit (every kind of write and removal, in the home and in a userData on another "volume") same-volume and with EXDEV, a commit whose in-launch undo dies, and a recovery killed once and twice. After each kill, the next launch must settle with nothing unresolved and leave the user's files exactly as before the commit or exactly as a clean commit leaves them, on the side of the record's rename the kill fell; the launch after that must finish the step, with a backup holding every original.
  - C-T5: `steps/002-prefs-from-renderer-state.test.ts`. Its goldens are in `steps/__fixtures__/{renderer-state,expected-prefs}/`, with `UPDATE_GOLDEN=1` to rewrite. `.txt` fixtures are raw bytes kept out of the formatter: a corrupt file, and one real `renderer-state.json` captured from a development machine, which contains no personal data.
  - C-T6: `progress-window.test.ts`.
  - C-T8: `services/config/legacy-prefs.test.ts`, including a `db.prefs` batch through `createTables`.
  - `legacy-home.test.ts` runs `MIGRATION_STEPS` over `__fixtures__/legacy-home/`. That fixture follows a shipped home's layout, but its values are synthetic. The test checks that every legacy file is byte-identical afterwards, that `prefs.json` and `migrations.json` are the only new files, that a second run is a no-op, and that old-UI changes after the migration reach `prefs.json`.
- **Not done in this part.** The following are left for the second part:
  - Step 1 `transcripts-v2` (C.3), with its pure mapper `shared/transcript/v1-to-ui-messages.ts`, `thread-store.ts`, and the `TranscriptService` dual-write and dual-remove.
  - C-T1, C-T2, C-T4, C-T7 and C-T9.

  Id 1 is reserved in `steps/index.ts`. Registering it later is safe: pending steps run in ascending id, and step 2 does not depend on it. The manual C.8 checks (a real `~/.abacusai-bot` copy, `SIGKILL` mid-commit, 2k synthetic transcripts) were not run.

### Second part: step 1, the thread store, step 4

This part adds step 1 (C.3), the thread store with the dual-write and dual-remove, and step 4's rules (C.5), with C-T1, C-T2, C-T4, C-T7 and C-T9. Where it differs from the text above, and why:

- **Files.**
  - `shared/transcript/`: `v1-to-ui-messages.ts` (the mapper), `thread-file.ts` (`ThreadFileV2`, its valibot schema, `parseTranscriptV1`, `parseThreadTwin`, `decideConversion`), `v1-types.ts` (the v1 shapes, vendored type-only from `renderer/conversation/agent-types.ts`, which `shared/` cannot import) and `test-support.ts`.
  - `main/services/session/thread-store.ts`: `ThreadStore`, which also owns `isSafeSessionId` now.
  - `main/migrations/steps/`: `001-transcripts-v2.ts`, `004-archive-transcripts-v1.ts` and `transcript-files.ts` (the per-file walk both steps share).
- **Mapper choices the text leaves open.**
  - Message ids are unique within a thread. The assistant message opened by an unmatched close frame would otherwise take the id of its bracket's `created` frame, and corrupt files repeat ids. A taken id gets `:1`, `:2`, …. `segments[]` still carries the original segment ids.
  - A segment with no string `id` is traced as `segment-<i>`, or as `<groupId>:<j>` inside a `tool_group`. A non-object segment becomes an `unknown` part with `raw` set to the value.
  - A known type whose required field is missing or has the wrong type is mapped as `unknown` with `raw`, not coerced. Examples: `text` with non-string content, `tool_call` with no call, `media` of another kind, `credits` without a number.
  - `segments[]` entries also carry `status` and `outcome` for subtask frames. The close frame is listed in `subagent.metadata.abacus.segments`, next to `startTime` and `endTime`. A close by hand-back, by a user text or at end of file has no frame, so it has no entry.
  - `at` is kept in `segments[]` as stored. `createdAt` uses the first `at` that `Date` can represent.
  - User messages also take `messageIndex`, `regenerateAttempt` and `versions` when their segment carries them, because they are edit targets. `credits` is left out when the message has none.
  - Tool results: `content` is the legacy `output`, and `metadata.abacus` holds `data` (the legacy `ToolResultData`) and `rejection` when present. A stored result keeps its own `error`. Only a synthesised one gets `error: "failed"` (row 2). The call part's `metadata.abacus.status` keeps the raw v1 status. A missing or unrecognised status with no error and no rejection counts as success, as `hydration.ts` treats it.
  - The agent protocol's older `tool_call` shape (`toolUseRequest`, `toolUseResult`, `toolPhase`, `protocol.ts`) has no producer today, but it is mapped: a stored result counts as success, or as rejected when `rejected` is set, and a missing result counts as interrupted. The legacy fields are kept in `metadata.abacus.legacy`.
  - `ThreadFileV2.updatedAt` is the v1 file's `updatedAt`, so the same v1 file always converts to the same bytes. When a v1 file has no `updatedAt`, its mtime stands in.
  - Migrated files have no `runs` (spec 02 §14.7).
- **Conversion rules** (`decideConversion`, shared by step 1, `readCurrent` and step 4).
  - An unparseable twin is replaced as `replace-user`, not `replace-derived`: it is most likely garbage, but nothing proves it was derived, so the runner backs it up.
  - Twins are classified from `version`, `source` and a `messages` array only, never the full schema. A field a future `agui` writer adds can never make its file look corrupt and get overwritten.
- **Step 1.** Stats: `files, converted, created, replaced, upToDate, agui, skipped, unsafe, corrupt, notV1`, where `skipped = unsafe + corrupt + notV1`.
  - Only `*.json` regular files count. Temp files, `.DS_Store` and folders are left alone.
  - One v1 file (and its twin) is in memory at a time, read whole with `readFileSync`; there is no 1 MB streaming reader. The step yields and reports progress every 20 files.
  - It does not quarantine: C.5 gives that to step 4.
- **Thread store.**
  - `readCurrent` returns `[]` for a v1-derived twin whose v1 file is gone, so a v2 removal that failed after a reset cannot bring cleared history back. It does not delete that twin. At the cut-over, step 4 archives v1 files, so this rule must go with the repair, as C.3 already plans.
  - The dual-write skips re-reading a twin whose size and mtime match its own last write. That saves a full parse of a large file every 750 ms while a chat streams.
  - `ServiceHost.threadStore` is passed to `TranscriptService` and to the RPC deps (`threads`), so `ai.hydrate` now serves migrated history.
- **Step 4 and `pending`.** C.5's "convert first, archive on the next run" could not finish, because the runner records a step as applied after its first commit. A plan now has `pending?: number`. While it is above zero, the plan is committed and recorded in `migrations.json` under `partial` (step, attempt, backup, `pending`, `stalled`), not under `applied`, and `RunMigrationsResult.partial` lists the step. The next launch runs the step again. The `partial` entry is the durable proof that the commit is final: a staging that survives it (a failed delete) is finished on the next launch, never rolled back. A crash before the record point is undone from the journal, as for any unrecorded commit. A step whose `pending` does not go down over `MAX_STALLED_PARTIALS` (2) partial commits in a row is recorded as applied as it stands, with `stats.pendingLeft`, so it never reruns forever; what it could not do is left where it was.
  - Step 4 sets `pending` to the number of files it converted, so it finishes over at most two launches.
  - A v1 file whose `agui` twin was migrated from an older v1 is kept (`stats.kept`), because AG-UI wins, and archiving would drop what the v1 file has beyond it.
  - Quarantine is a `create` of a copy under `backups/quarantine/transcripts/` plus a removal of the source into the step's backup directory. An unreadable source is left in place and counted.
- **Tests.**
  - C-T1: `shared/transcript/v1-to-ui-messages.golden.test.ts`. There are 18 synthetic fixtures in `__fixtures__/v1/`, which cover every C.7 case plus display-only segments, the protocol tool shape and a user text inside a bracket. The goldens are in `__fixtures__/expected-v2/`, rewritten with `UPDATE_GOLDEN=1`.
  - C-T2: `v1-to-ui-messages.property.test.ts`. It runs over the fixtures and 200 seeded transcripts. "Every input segment id appears exactly once" is checked as a multiset, because a bracket's `created` and `completed` frames share one id. It also checks that message ids are unique.
  - C-T4: `steps/001-transcripts-v2.test.ts`. It also runs every C-T1 fixture through the real runner against its golden, and a 45-file directory for yielding and progress. `legacy-home.test.ts` now expects `threads/` and steps `[1, 2]`.
  - C-T7: `services/session/thread-store.test.ts`. The reset, session-delete and workspace-delete cases run the real `ServiceHost` methods (Electron proxied, their collaborators faked), and `agent.reset` and `ai.hydrate` go through the real router.
  - C-T9: `steps/004-archive-transcripts-v1.test.ts`. `runner.test.ts` covers `pending`.
- **Not done.** The manual C.8 checks were not run: a copy of a real home, 2k synthetic transcripts, and a `SIGKILL` mid-commit. `packaged-startup.test.ts` and `agent-runtime-deps.test.ts` fail in this environment, because `pnpm exec vite build` refuses the installed pnpm version. That failure is unrelated to this part.

## Review responses (codex r1)

Source: `docs/rewrite/specs/reviews/00-transport-db-migration.codex-r1.md`. Each finding was checked against the 1.15.4 oRPC package (installed in the scratchpad), the TanStack DB 0.10.0 and TanStack AI (ai 0.63.0 / ai-client 0.36.0) clones, and the current source. 23 are fixed as the review proposed. One (R7) is fixed with a different mechanism, and the reason is given.

| # | Finding | Resolution |
|---|---|---|
| R1 | `ChatHydrationResult`/`RunAgentInputContext` imported from the wrong package | **Fixed** (A.3.1). Confirmed: `RunAgentInputContext` and `SubscribeConnectionAdapter` are exported from the `ai-client` root (`index.ts:181,183`), and `ChatHydrationResult` is not exported from any root. It is now derived from `SubscribeConnectionAdapter["hydrate"]`. A-T1b checks every named library import. |
| R2 | Handshake could create two ports | **Fixed** (A.4.4). The preload answers once per document and refuses later requests without a port. The renderer's retry is removed. Late or unknown-nonce ports are closed. Promise reuse is HMR-safe. Covered by A-T4 and the real-Electron A-T12. |
| R3 | Lifecycle listeners accumulate | **Fixed** (A.4.2). They are installed once in `registerRendererContents` and removed on `destroyed`. Closed ports clear their registry slot. A-T3 asserts the listener counts. |
| R4 | Swap readiness overstated | **Fixed** (A.4.6). There is an explicit subscription barrier (transport, `prefs`/`workspaces`/`sessions` ready, `abacus.subscribed` for the visible thread, first commit), plus a 10 s abort-and-retry policy for swap candidates. The legacy 5 s path is unchanged. A-T10 covers it. |
| R5 | Irreversible events on a lossy bounded publisher | **Fixed** (A.4.3). Confirmed: `EventPublisher` drops the oldest silently. Events are now filtered before buffering, with three declared delivery classes. Terminal output is offset-addressed and resumable from main's `BoundedScrollback`, exit is sticky, and actionable streams start with a pending-state snapshot. Overflow is an explicit `RESYNC_REQUIRED`. A-T9 covers it. |
| R6 | Two destinations for credentials invalidation | **Fixed.** `settings.events` is the only destination, in both A.2.1 and A.2.3. A-T11 covers it. |
| R7 | Commit ≠ apply; use immediate transactions | **Fixed differently.** Received and applied positions are now defined and tracked (B.3), and `awaitApplied` exists. But mutation handlers wait on *received*, and `begin({ immediate: true })` is not used for echoes. Verified in `collection/state.ts:1373`: ordinary synced commits apply only when no user transaction is persisting, and during `onInsert/onUpdate/onDelete` the caller's own transaction *is* persisting. Waiting for *applied* inside the handler would deadlock. Forcing `immediate` would contradict the DB guide ("do not use `begin({ immediate: true })` to bypass that ordering just to settle a load"). Once the handler resolves, TanStack applies the queued echo together with dropping the optimistic layer. That is the same pattern as Electric's `awaitTxId`. Resync snapshots apply immediately through `truncate()`. B-T1 cases 8, 8b and 8c cover server-normalised rows. |
| R8 | Stays in `error` after recovery | **Fixed** (B.3 step 4). `markReady()` is called after any usable snapshot while `loading` or `error`. Verified: `lifecycle.ts` allows `error → ready`, and `applyReadyTransition` clears `syncError`. B-T1 case 6 covers failure then recovery. |
| R9 | Freeze after overflow EOF | **Fixed** (B.1, B.3 step 7, B.4). The client reopens on unexpected EOF as well as on errors. B-T1 cases 12 and 13 cover it. |
| R10 | Epoch checked after seq | **Fixed** (B.3 steps 1, 3, 4, 5). The epoch is compared before any seq, a foreign-epoch batch triggers a reopen instead of being dropped, buffers and snapshots are tagged with a connection generation, and waiters are keyed `{ epoch, seq }`. B-T1 cases 5, 5b and 5c cover it. |
| R11 | Memory stale-click guard removed | **Fixed** (B.2). The delete sends the clicked row's original `index` and `entry`, which main validates under the store lock (`CONFLICT` when stale). B-T3 covers the duplicate-entry race. |
| R12 | `noteDays` / empty bots / daily-note directory | **Fixed** (A.2.1, B.2). `memory.bots` keeps `BotMemoryView`, and watchers cover `bots/`, `bots/<id>/` and `bots/<id>/memory/`, including creation and removal. B-T3 covers it. |
| R13 | Chat previews lose their trigger | **Fixed** (A.2.1, A.2.3). Every legacy `bots-updated` also publishes `bots.events previews-changed`, independent of the row diff. Confirmed: the transcript `onPersist` emits `bots-updated` (`service-host.ts:1519-1527`). B-T3 and A-T11 cover it. |
| R14 | Hydration missing `activeRun`/`interrupts` | **Fixed** (A.3). `ai.hydrate` combines stored messages with `AguiSource.liveState`. |
| R15 | Segment ids not preserved | **Fixed** (C.3). There is a per-message `metadata.abacus.segments` provenance list, a per-part id placement table, group provenance, and boundaries on user messages and on a `messageIndex` change. C-T2 checks it. |
| R16 | Completed frame without outcome misread | **Fixed** (C.3). A missing `outcome` defaults to `"completed"`, as in `hydration.ts:47-53`. There is a historical fixture in C-T1. |
| R17 | Hand-back rule missing | **Fixed** (C.3). The full positional state machine is specified: consecutive `created` closes the previous bracket as completed, an unmatched close is ignored, and a trailing open bracket is interrupted. |
| R18 | Success state with denied/cancelled outcome | **Fixed** (C.3). Result state is derived from status and rejection as well as error. Confirmed: `ToolResultPart.outcome` implies `state: "error"` (`ai/src/types.ts:457-458`). C-T1 and C-T2 cover it. |
| R19 | v2 not removed | **Fixed** (C.3, C.6). `TranscriptService.remove`, the path used at `service-host.ts:1691,2242,2631`, removes v2 too. C-T7 covers reset and deletion. |
| R20 | Stale v2 cannot be repaired | **Fixed** (A.3, C.3). `readCurrent` compares source timestamps and repairs a stale twin, and the dual-write is isolated so `onPersist` still runs. C-T7 covers it. |
| R21 | Prefs drift justification false | **Fixed** (C.4, B.8). There is a live legacy sync for the whole transition, plus a final provenance-aware import at cut-over (step 3). C-T8 covers it. |
| R22 | Default-equality merge | **Fixed** (B.2, C.4). Merges go by stored provenance. C-T5 covers an explicit `"system"` theme. |
| R23 | Overwrites and rollback misclassified | **Fixed** (C.1, C.2). Writes are classified as `create`, `replace-derived` or `replace-user`. `replace-user` writes are backed up, commits are journaled, and there is a recovery procedure. The review's failure points are tested in C-T3. |
| R24 | Archive gate cannot handle `agui` or skipped files | **Fixed** (C.5). Archiving is per file, with rules for `agui` twins (`migratedFrom`), a quarantine for skipped sources, and convert-then-archive. C-T9 covers it. |
