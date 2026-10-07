# 08 — Web split: `apps/web` and the headless host

Status: spec **r2** (app-side), 4 Oct 2026, branch `rewrite/web-split`, stacked on `rewrite/renderer` (`HEAD 54dd7b69`, PR #140). Reviewed independently by two reviewers before implementation; this is the implementation baseline for the two app PRs. The hosting environment that runs the host (how a machine is started, how the browser is routed to it, and how it is kept alive or stopped) is outside this repository and is described only through the contract the host expects (§7).

Paths are relative to the repository root; `apps/desktop/src/` is abbreviated `desktop/` where a path starts with `main/`, `preload/`, `renderer/` or `shared/`.

## 1. Goal

The renderer runs as a plain browser app, built from the same source tree as the Electron renderer, with the Electron-only surfaces compiled out. It talks to a **headless host** (Electron main without Electron) that runs on a remote machine and is reached over a WebSocket through an authenticating reverse proxy. The browser authenticates to the host with a per-connection token plus a strict Origin check. The host holds a real bot API key obtained through the existing one-time-code exchange, so connectors, channels, hooks and billing behave as on the desktop. The Electron app keeps its PKCE sign-in and MessagePort transport unchanged.

Non-goals (v1): the agent's browser tool and Chromium-rendered documents, decks and designs on the host (§6.8); scheduled routine wake-up of a stopped host (§10); cookieless (Bearer) web sign-in; MCP OAuth on the web; WhatsApp, Telegram and Discord on the web; any change to `packages/agent` behaviour.

## 2. Facts the design rests on (this repository)

- The renderer talks only to Electron main's oRPC router (`desktop/main/rpc/router.ts`; contract `desktop/shared/contract/`) over a MessagePort from the preload (`desktop/preload/rpc-port.ts`). Main spawns one agent process per session (`desktop/main/services/session/cli-manager-service.ts:519-700`) over stdio in AG-UI. "The agent on the remote machine" therefore means "main on the remote machine".
- The router and procedures load without Electron; what they reach is injected as `RpcDeps` (`desktop/main/rpc/deps.ts`): `serviceHost`, `host: HostOperations`, `app: AppOperations`, `browserRuntime` (typed non-null), `update`, `windows`, `bus`, `ai`, `tables`, `threads?`, `trackers`, `cues`, `notch?`. The WebSocket smoke (`scripts/rpc-ws-smoke.mjs`, `websocket.smoke.test.ts`) proves router import isolation with fakes; it does not exercise ServiceHost.
- `HostOperations` is built by `createHostOperations` / `wireHostEvents` in `desktop/main/handler.ts`, which statically imports Electron `app`, the local-model service, login item, microphone, sign-in session and the Abacus auth and sign-in windows. `account.*` and `auth.*` go through it.
- Startup order in `desktop/main/index.ts:1795-1845`: `runStartupMigrations`, `threadStore.replayHeld()`, `serviceHost.initialize()`, `start()`, `wireHostEvents`, `startCronScheduler()`. Routines do not depend on a renderer. "Background sync" started by `window.ready` is only `debugSyncService.sweepOnStartup()`.
- WebSocket transport, unused in the app: `desktop/main/rpc/transports/websocket.ts` (loopback, random token, `windowKind: "dev"`, no `FlowRegistry`) and `desktop/renderer/data/transport/websocket.ts` (one socket bound to the link, retry 0, no flow-control interceptor). Flow control (`desktop/shared/contract/flow-control.ts`) is active only with `FLOW_CONTEXT_KEY` in the context, which only the MessagePort transport sets; otherwise the backlog lives in `ws.bufferedAmount` and `SubscriberQueue`'s caps never engage.
- Guards: `requireWindow` / `requireMainRenderer` (`desktop/main/rpc/procedures/impl.ts:20-35`). Guarded: `window.*` (11), `notch.*` (8), `browser.runtime.*` (8), `devices.stream.start`. The renderer already swallows FORBIDDEN from `window.ready` and `window.activity` and falls back to `DEFAULT_CHROME`.
- Renderer: no Electron imports (enforced by `renderer/guards.test.ts`), one preload-backed capability (`transport.host.getPathForFile`), no `isElectron`. Platform branches read `system.info.platform`. Build flags: `VITE_UI_GALLERY`, `VITE_NEXT_DB_FIXTURES` (compared as `=== "1"`, so dead branches drop), `import.meta.env.DEV`, `MODE`.
- `desktop/shared` is browser-clean; 668 `#shared/` import sites across renderer, main and preload.
- Build: one `apps/desktop/vite.config.ts` builds renderer (HTML inputs `index.html`, `notch.html`, root-absolute `/src/renderer/{main,notch}.tsx` scripts), main and preload. Vite emits HTML relative to `root`; five consumers expect `dist/renderer/index.html`; dev loads `new URL("index.html", VITE_DEV_SERVER_URL)`. Aliases and regexes keyed on `src/renderer/` and `src/shared/` are listed in §9.4. CSP meta `connect-src 'self' data:` in both HTML files, mirrored in `main/renderer-csp.ts`. Router: hash history.
- Electron coupling in main: about 50 runtime importers. Value exports used: `app`, `shell`, `session`, `BrowserWindow`, `BaseWindow`, `WebContentsView`, `nativeTheme`, `net`, `protocol`, `screen`, `powerMonitor`, `powerSaveBlocker`, `systemPreferences`, `ipcMain`, `ipcRenderer`, `webContents`, `Notification`, `dialog`, `Menu`, `globalShortcut`, `nativeImage`, `autoUpdater`, `crashReporter`; dynamic `dialog`, `desktopCapturer`. `electron-store` users: `index.ts`, `window-chrome-settings.ts` (defaults), `keep-awake.ts` (`get(key, fallback)`), `services/session/workspace-store.ts` (named store with `cwd`, default store, module-load migrations, `delete`, dotted keys, `clearInvalidConfig`), `services/updates/relaunch-hidden.ts` (`delete`). The real `electron-store` constructor calls `ipcMain.on`.
- Browser-callable procedures that reach Electron directly (the host must replace or deny each; §6.7): `mcp.import(source="file")` → `dialog`; `mcp.oauthSignIn` → `shell` + loopback callback; `connectors.connect` → sign-in session and connect window; `messaging.openSharedLink`/`openLink` → `BrowserWindow`; `files.trash`, `checkouts.trash` → `shell.trashItem`; `skills.openFile` → `shell`; `browser.profiles.*`, `browser.clearData` → `session`; `auth.abacus.*`, `auth.openRouter.start` → loopback PKCE, `shell`, `BrowserWindow`, `session`; profile switch → `app.relaunch()`. Reached by the agent: `render_document`, `render_deck`, `render_design` → `BrowserWindow`; the browser MCP server's target comes from `browserTargetSource()` (Chrome extension or Electron runtime, null otherwise).
- `messaging-gateway-service.ts:22-48` constructs the WhatsApp, Telegram and Discord connectors from config in `start()`.
- Resources and endpoints: `resourcesRoot()` returns `process.resourcesPath` when `app.isPackaged`; `agentEntry()` resolves `resources/agent/...`; `ArtifactResolver` consults installed experiences; `abacusRoutellmV1()` honours `ABACUSAI_BOT_ABACUS_HOST` only when unpackaged or a test build; `buildAgentConfigEnv` writes `ABACUSAI_BOT_ABACUS_V1` over the inherited env; `abacusUserAgent()` reads `app.userAgentFallback`; `ABACUSAI_BOT_CLIENT_KIND` is hard-coded `desktop_code_mode`.
- Host-side native deps outside the agent: `@lydell/node-pty`, `@ff-labs/fff-node`, `ffi-rs`.
- Auth today: PKCE with a loopback callback (`services/providers/abacus-auth-service.ts`), exchange at `POST ${abacusAppHost()}/api/v1/_exchangeAbacusaibotAuthCode` → permanent bot key in `~/.abacusai-bot/config.json`, adopted by `adoptAbacusCredential`. `credentialEnv()` prefers an env key over the stored one. `account.state` is the local profile; `account.abacus` fetches `/v1/account`.
- Notifications originate in renderer watchers that call `system.notify` → main's `Notification`.
- `apps/updater/src/classify.ts:11-16` treats `apps/desktop/src/renderer/` and the two HTML files as the experience prefix; `scripts/build-provenance.mjs:7` reads `desktop/shared/experience.ts`.

## 3. Decisions

| # | Decision | Why |
|---|---|---|
| D1 | The remote machine runs a **headless host** (`apps/host`): ServiceHost, router, WebSocket transport, Node implementations of the deps, spawning `packages/agent` with `node`. | The renderer's only peer is main's router. |
| D2 | **One renderer source tree** at `apps/bot/src`, consumed by both builds; Electron-only surfaces gated by a build-time constant that tree-shakes (§5). | No duplicate trees. |
| D3 | `desktop/shared` moves to `packages/contract` (`@abacus-ai/contract`), with explicit aliases in every bundler and test runner and a TS project referenced by web, main, preload and host. | Shared by four consumers; Node `imports` maps are package-private and `exports` cannot express the directory-index fallback. |
| D4 | The host is reached through an **authenticating reverse proxy** that injects the caller's identity as headers (§7). The host trusts nothing else about the network. | The proxy is the hosting side's; the host must still defend itself (D8). |
| D5 | The web app is served at **`/bot/`** on the same origin as the Abacus API (`apps.abacus.ai/bot`), by the same static-file path that already serves the main web app, with TanStack browser history and a `/bot` router basepath, plus content-hashed assets. | Same origin: first-party cookies, no CORS, and the Origin check is the apps host itself. Nested URLs use the nginx app-shell fallback. The publisher ships one tarball; no new edge infrastructure. |
| D6 | Web auth to Abacus is the browser's **existing cookie session**. The host obtains a **real bot API key** through the one-time-code exchange: the host makes the verifier, the browser fetches the code with its cookie, the host redeems it. The browser never holds the key. | Bot-only endpoints and billing need a bot key. The handoff is the desktop's exchange minus the loopback. |
| D7 | Web access is gated server-side to a paid tier in v1. | Product decision. |
| D8 | The host accepts a connection only if **all three** hold: `Origin` is exactly the SPA origin for the environment, the `Sec-WebSocket-Protocol` carries a valid **connect token** (HMAC over owner, org and expiry with the host secret), and the proxy's `x-abacus-user-id` header equals the owner. HTTP routes other than `/healthz` require the token as `Authorization: Bearer`. | Cookie-authenticated proxies without an Origin check are open to cross-site WebSocket hijacking; identity headers alone can be forged on internal paths. |
| D9 | The host tarball ships its **own Node 22**, the full dependency closure of host and agent with linux bindings, and the desktop `resources/` layout with `agent/` under it. | The remote Node version is not ours; `agentEntry()` resolves `resources/agent`. |
| D10 | Sandbox **off** on the remote machine (`ABACUSAI_BOT_SANDBOX=off`). | The machine is already isolated per user. |
| D11 | Routines run from the host's local store while the host is up. Waking a stopped host for a routine is §10, later. | Scope. |
| D12 | Reconnect on the web is **reload, then the connect screen re-resolves** the host. No in-place socket recreation in v1. | Matches desktop behaviour on port loss; the retry plugin is not a reconnection manager. |
| D13 | Flow control over the WebSocket **reuses the existing ack protocol** (`withFlowAcks` + `createFlowControlLinkInterceptor`) with a JSON control frame filtered before oRPC, plus a `bufferedAmount` kill switch. | The subscriber caps alone bound nothing over a socket. |
| D14 | On the host, unsupported capabilities are **denied server-side with a typed `UNSUPPORTED` oRPC error**, and small platform operations are **injected into the owning services**; the `electron` shim exists only so modules import. | Import-time safety is not reachability safety. |
| D15 | Two app PRs: `rewrite/web-split` (stacked on `rewrite/renderer`) and `rewrite/headless-host` (stacked on the former). | Independent review and revert. |

## 4. Layout after the split

```
apps/
├─ desktop/               Electron. src/main, src/preload stay. src/renderer and src/shared are gone.
│  └─ vite.config.ts      renderer root = ../web (§9.1), outDir dist/renderer, platform electron; main/preload via vite-plugin-electron
├─ web/                   @abacus-ai/web — the renderer tree, git-mv'd from apps/desktop/src/renderer
│  ├─ index.html          one HTML for both platforms; the CSP meta is injected per platform (§9.1)
│  ├─ notch.html          Electron-only document; an input of the desktop build only
│  ├─ src/                main.tsx, notch.tsx, routes/, notch-routes/, features/, components/, ui/, data/, lib/, locales/, styles/
│  ├─ vite.renderer.ts    shared plugins and build settings used by both configs
│  ├─ vite.config.ts      the browser build: base /bot/, platform browser, input index.html only
│  ├─ package.json        owns every renderer dependency; "imports": { "#renderer/*", "#locales/*" }
│  └─ tsconfig.json       the former tsconfig.renderer.json; references ../../packages/contract
├─ host/                  @abacus-ai/host — the headless host (PR 2)
│  ├─ src/index.ts        entry (§6.1)
│  ├─ src/{app-operations,host-operations,electron-shim,store,auth-web,lease,http}.ts
│  ├─ tsdown.config.ts    aliases: electron → src/electron-shim.ts, electron-store → src/store.ts, #main/* → ../desktop/src/main/*, @abacus-ai/contract/* → ../../packages/contract/src/*
│  └─ scripts/{bundle,verify-host-bundle,smoke-host,dev-proxy}.mjs
└─ updater/               classify.ts and tests updated (§9.3)
packages/
├─ contract/              @abacus-ai/contract — git-mv'd from apps/desktop/src/shared; own package.json; composite tsconfig
└─ agent/                 unchanged
```

`#renderer/*` keeps its name inside `apps/web`; `#shared/*` becomes `@abacus-ai/contract/*` (a scripted rewrite). `#main/*` and `#preload/*` stay desktop-private. `pnpm-workspace.yaml` lists the new packages; `@abacus-ai/web` and `@abacus-ai/contract` are workspace devDependencies of `@abacus-ai/desktop` so Turbo hashes them; `turbo.json` gets `VITE_ABACUS_PLATFORM` and `VITE_CONNECT_SRC` in the build `env`. Root `tsconfig.json` references the new projects; `check:knip` covers them.

## 5. Platform gating

### 5.1 The constant

`apps/bot/src/lib/platform.ts`:

```ts
declare const __ABACUS_PLATFORM__: "electron" | "browser";   // Vite define; each config throws if its value is missing
export const PLATFORM = __ABACUS_PLATFORM__;
export const IS_ELECTRON = PLATFORM === "electron";
export const IS_BROWSER = PLATFORM === "browser";
/** The user's OS for hotkeys and labels. On Electron the host's; on the browser the browser's. */
export const uiPlatform = (hostPlatform: string): HotkeyPlatform => IS_ELECTRON ? toHotkeyPlatform(hostPlatform) : fromNavigator();
```

A `define` rather than `import.meta.env` so a missing value is a build error. The Vitest renderer project runs with `electron`; a second project runs the gating tests with `browser`. R8-T6 proves the dead branches are gone from the browser bundle.

### 5.2 Rules

- A gated **component** branches on `IS_ELECTRON` at the feature's index, with the Electron implementation behind a dynamic import inside the branch. Static imports of an Electron-only component from a shared module are a lint error.
- A gated **procedure call** is not made on the browser (`enabled: IS_ELECTRON`; mutations behind UI that does not render). The host additionally denies the whole family with `UNSUPPORTED` (§6.7), and R8-T3's interceptor fails on any `FORBIDDEN` or `UNSUPPORTED` seen over the wire.
- No gated **route** exists; if one appears, it gates with `beforeLoad` → `notFound()` like the gallery stub.
- `transport.kind` is not a platform signal. The user's OS comes from `uiPlatform()`; `system.info.platform` stays the host's OS for path and shell semantics.
- `system.notify` on the browser is a Web Notification when permitted, else a toast; with several tabs, one leader elected over `BroadcastChannel` fires it.

### 5.3 Inventory

| Surface | Files (apps/bot/src) | Browser behaviour |
|---|---|---|
| Notch document and callers | `notch.tsx`, `notch-router.tsx`, `notch-routes/*`, `notch-context.ts`, `features/notch/*`; callers `lib/attention/open-target.tsx`, `features/tour/index.tsx`, `features/settings/companion.tsx` | Not built. Callers gated; companion section hidden. |
| Window chrome, readiness, activity | `lib/window-chrome/*`, `data/queries/window.ts`, `data/queries/invalidation.ts:49`, `features/shell/{readiness,occlusion,top-bar,rail,screens,app-toaster}`, `lib/activity.ts`, `lib/document-sound.ts`, `lib/bootstrap.ts:108`, `features/settings/updates.tsx:139` | `DEFAULT_CHROME`; `window.events` not subscribed; readiness barrier skipped; the activity beacon calls `system.activity`; `app-region` CSS inert. |
| Embedded browser runtime | `features/shell/native-presenter.ts`, `features/sessions/browser/*`, `features/sessions/start/start-session.ts:165`, `features/sessions/globals.tsx`, `components/browser-surface`, `features/library/connect-flow.ts`, `features/bots/panel/bot-side-panel.tsx`, `features/artifacts/index.tsx` | Browser tab hidden; `promoteScope` not called; URL deliverables render as links opened with `window.open`. |
| Devices | `features/sessions/device/*`, `features/sessions/dock/session-dock.tsx`, `features/library/globals.tsx`, `features/settings/environment.tsx` | Hidden. |
| Local models | `features/onboarding/steps/local-models.tsx`, `features/shell/credits-card.tsx`, `features/settings/models.tsx`, `routes/_bare/onboarding.$step.tsx` | Onboarding skips the step; section hidden. |
| Updater, login item, restart, about | `features/settings/updates.tsx`, `features/settings/personal.tsx`, `features/routines/globals.tsx` | Hidden. |
| Auth | `features/onboarding/{index.tsx, store.ts, first-run.ts}`, `routes/_bare/onboarding.$step.tsx`, `features/settings/{account-usage,models}.tsx`, `components/credits-card/actions.ts`, `features/library/connect-flow.ts:261` | Onboarding's sign-in step runs the **web handoff** (§6.5); OpenRouter is paste-key only; sign-out clears the host profile and the stored key. |
| Connectors and MCP OAuth | `features/library/{connectors,mcp}`, `connect-flow.ts`, `features/settings/mcp*` | Abacus connectors connect through the platform flow in a new tab with status polling; MCP OAuth and `mcp.import(file)` hidden (v1). |
| Messaging | `features/library/messaging.tsx`, `connect-flow.ts`, `features/onboarding/{pairing-banner.tsx, connect.ts}`, `features/routines/sidebar.tsx`, `features/bots/chat/slots.tsx`, `features/bots/data/live.ts` | WhatsApp, Telegram and Discord hidden; Abacus channels stay; `openSharedLink`/`openLink` return a URL the renderer opens with `window.open`. |
| Host file paths and uploads | `features/chat/runtime/host-actions.ts:61,82`, `features/sessions/sessions-sidebar.tsx:168`, `lib/file-highlight.ts:36`, `features/chat/markdown/prepass.ts:134` | Attach uploads bytes with `POST /upload` (§6.6); folder drop disabled; `file://` links resolve through `files.readText` / `readImage` / `readPptx`. |
| Shell and dialogs | `system.openExternal` (16 sites), `system.openPath`, `system.showItemInFolder`, `system.dialog.openFolder`, `files.trash`, `checkouts.trash`, `skills.openFile`, `browser.clearData`, `browser.profiles.*` | `openExternal` → `window.open`; `openPath`, `showItemInFolder`, `skills.openFile`, `browser.*` hidden; `dialog.openFolder` → a picker over `files.treeRoot` / `treeChildren`; trash works (host moves to `~/.abacusai-bot/trash/`). |
| Voice | `lib/voice/*` | Unchanged; the host answers `voice.requestMicrophone` as granted. |

### 5.4 Browser-only additions

- `features/shell/connect/`: the connect screen. It asks the hosting side for the host (create-or-get, start, bootstrap; §7.2), polls `GET https://<host>/healthz` with `credentials: "include"` until it answers with the expected owner and `contractVersion` (retrying 403 for 65 s), then opens the WebSocket (§6.3) and boots. It shows the sign-in link when the hosting side answers 401, an upgrade link on the tier error, and "Restart your computer" when `/healthz`'s `contractVersion` differs from the SPA's `CONTRACT_VERSION`.
- `features/shell/lease.ts`: while connected, visible and with `system.activity` fired in the last 5 minutes, call the hosting side's keep-alive every 60 s.
- `data/transport/index.ts`: `getTransport()` → `connectMessagePortTransport()` on Electron; on the browser `createWebSocketTransport({ url, protocols: ["abacus-rpc", `abacus-token.${token}`] })`, awaiting `open` before boot, with the flow-control interceptor (D13).
- CSP: no meta in source; the Vite plugin injects one per platform (§9.1). Browser: `connect-src 'self' <VITE_CONNECT_SRC>` where `VITE_CONNECT_SRC` lists only the preview hosts (the API is same-origin). Electron: `connect-src 'self' data:`, pinned equal to `main/renderer-csp.ts` by test.

## 6. The headless host (`apps/host`, PR 2)

### 6.1 Composition

PR 2 first extracts `composeHost()` from `desktop/main/index.ts:1795-1845` into `desktop/main/compose-host.ts`, taking `{ appOps, hostOps, windows, browserRuntime, update, notch, cues, platform }` and returning `{ serviceHost, deps, dispose }`. `index.ts` calls it with the Electron objects; `apps/host/src/index.ts` with the Node ones. `handler.ts` is split so `createHostOperations` imports no Electron module.

The host entry starts the WebSocket transport on `0.0.0.0:${ABACUSAI_BOT_HOST_PORT}` attached to an HTTP server (§6.6) with context `{ transport: "websocket", webContentsId: null, windowKind: "web", deps, [FLOW_CONTEXT_KEY]: registry }`. `RpcWindowKind` gains `"web"`. `startWebSocketTransport` gains `host: string`, `verifyClient` and `flowControl` options; the loopback smoke keeps its defaults. The debug sweep runs only when its URL is configured.

### 6.2 Node implementations

`apps/host/src/app-operations.ts` implements the full `AppOperations`. Dialog methods return `null`; `openExternal` rejects with `UNSUPPORTED`; `openFilePath` and `showItemInFolder` return the typed failure; `restartApp` exits 75 so the supervisor relaunches; `showNotification` forwards to the renderer; the file helpers are lifted into `desktop/main/app-operations/node.ts` and shared with Electron. `loginItem` is a disabled stub; `setTitlebarDensity` persists only.

`apps/host/src/host-operations.ts`: `account.*` as desktop; `auth.abacus.start/cancel/openInBrowser/browserProfiles` → `UNSUPPORTED`; `auth.web.*` (§6.5); `auth.openRouter.start` → `UNSUPPORTED`; `signOut` deletes the stored key and profile without relaunching; local models → `UNSUPPORTED`; microphone → granted.

`apps/host/src/electron-shim.ts` exports every value named in §2 so import never fails; a test generates the list from the grep and fails on drift. `app`: `getVersion`, `getPath(home|userData|temp|logs)` with `userData = <botHome>/host-userdata` (never `botHome` itself), `isPackaged: false`, `getLocale`, `userAgentFallback` = a realistic Chromium UA, `getApplicationNameForProtocol` → `""`, `relaunch`/`quit` → `process.exit(75)`. `shell.trashItem` moves into `<botHome>/trash/<date>/`; `openPath` returns a non-empty error string; `openExternal` rejects. `net.fetch` → `globalThis.fetch`. `nativeTheme` → a static light theme. Everything else is a class or object whose members throw `HostUnsupportedError`. R8-T10 exercises construction, `initialize`, `start`, each retained procedure and each agent host service under the shim.

`apps/host/src/store.ts` replaces `electron-store` with a subclass of `conf` (same on-disk format): `name`, `cwd` (default the shim's `userData`), `defaults`, `clearInvalidConfig`, dotted keys, `get(key, fallback)`, `set`, `delete`, `store`, atomic writes.

### 6.3 Connection authentication (D8)

Env at start: `ABACUSAI_BOT_HOST_OWNER` (hashed user id), `ABACUSAI_BOT_HOST_ORG` (hashed org id), `ABACUSAI_BOT_HOST_PORT`, `ABACUSAI_BOT_HOST_SECRET_FILE` (0600, written once by the bootstrap), `ABACUSAI_BOT_HOST_ORIGINS` (comma list), `ABACUSAI_BOT_HOST_MODE=1`.

Connect token: `base64url(JSON{ o: owner, g: org, e: expiry })` + `.` + HMAC-SHA256(secret, payload), minted by the hosting side with a 10-minute expiry (it authorizes a connection, not a session). The SPA sends it as the second `Sec-WebSocket-Protocol` entry (`abacus-token.<token>`); the host echoes `abacus-rpc`. For HTTP routes it is `Authorization: Bearer <token>`.

`verifyClient` (upgrade handler and every HTTP route except `/healthz`): `Origin` ∈ `ABACUSAI_BOT_HOST_ORIGINS` exactly; token present, valid, unexpired, `o` = owner and `g` = org; `x-abacus-user-id` = owner. Any failure: HTTP 403 / close 1008. `/healthz` is unauthenticated and reveals only `{ ok, version, contractVersion, owner: <hashed>, uptime, busy, lastActivityAt }`.

**Exception: the MCP connect routes.** `GET`/`POST /mcp/connect/<id>` and `GET /mcp/callback` are top-level browser navigations (a tab the page opens, a link sent in chat, the provider's redirect), which cannot carry a bearer token or an `Origin`. The proxy in front of the host is its only ingress; it strips any caller-supplied identity and proof headers, injects `x-abacus-user-id` from the user's own session, and signs every request it forwards to `/mcp/*`:

```
x-abacus-host-proof: <ts>.<mac>
ts        = Unix time in whole seconds, decimal ASCII, no sign
canonical = "mcp\n" + method + "\n" + path + "\n" + owner + "\n" + ts
mac       = lowercase hex of HMAC-SHA256(key, canonical)   (64 characters)
key       = the host secret as its UTF-8 bytes (the 64-hex-character string
            in ABACUSAI_BOT_HOST_SECRET_FILE, which the server derives with
            derive_host_secret(conversation_id)), not hex-decoded
method    = the HTTP method, upper case ("GET", "POST")
path      = the request target as the host receives it, up to and excluding
            "?", without decoding (e.g. "/mcp/connect/notion")
owner     = the hashed user id the proxy puts in x-abacus-user-id
```

The host recomputes the MAC with its own owner, compares in constant time, and refuses (403) a missing or malformed proof, a wrong MAC, or `ts` more than 120 s from its clock; it also requires `x-abacus-user-id` = owner (constant time). `/healthz` publishes the owner, so the header alone is never proof. Then, per route:
- `GET /mcp/connect/<id>` has no side effects. For a connector the registry names or a server the user installed (anything else is 404), it answers a confirm page ("Connect Notion to AbacusAI Bot?") and mints a confirm token bound to the owner and that connector: one live per connector, single use, 10 minutes, kept on the host. It answers a cross-site navigation too (a chat link opened in a web chat app), since it changes nothing.
- `POST /mcp/connect/<id>`, the page's button, requires `Sec-Fetch-Site: same-origin` and that token. Only after both are checked is the body read (4 KiB, 10 s, the connection dropped past either). Only then does the host install the connector (never rewriting an entry already there) and begin a sign-in, bound to the token and keyed by owner and connector, so a repeat replaces the earlier one; a cancel during discovery leaves nothing to complete.
- `GET /mcp/callback` is admitted by its OAuth `state`, matched once against the owner's pending sign-in within 30 minutes. It is cross-site by nature (the provider's redirect).

Every one requires `Sec-Fetch-Dest: document` (fail closed: a request without it is refused): no frames, images or fetches. Pages are `default-src 'none'; form-action 'self'; frame-ancestors 'none'`, `X-Frame-Options: DENY`, `Cross-Origin-Opener-Policy: same-origin`, `no-store` and `no-referrer`. A failed or refused connect is announced to the app (`connectors.events` connect-failed), and `connectors.cancelConnect` drops a connector's pending sign-in and confirm token. Every other route keeps the full check above.

### 6.4 Activity and readiness

`system.activity()` is added to the contract (the renderer's input beacon; on Electron it keeps calling `window.activity`). The host records `lastActivityAt` and `busy` (live agent run, routine run or terminal output in the last minute) and reports both on `/healthz`. No `system.ready`.

### 6.5 Credentials: the web handoff (D6)

Procedures `auth.web.start()` → `{ challenge }` (host generates verifier and S256 challenge, keeps them 10 minutes) and `auth.web.complete({ code })` → `AccountState` (host exchanges `{ authCode, verifier, signinVariant: "web" }` at the existing exchange endpoint, then `adoptAbacusCredential(key, "web")` without relaunch). Between the two, the SPA obtains the one-time code with its cookie session and forwards only the code. The key persists on the host's disk, so this happens once per user. Any `ABACUS_API_KEY` in the inherited environment is stripped before composing; the stored bot key is the only LLM credential.

### 6.6 HTTP routes

Same server as the WebSocket: `GET /healthz` (unauthenticated, §6.3); `POST /upload` (token-authenticated; up to 256 MiB; saves via the `savePastedTempFiles` code path; returns paths), because the proxy in front caps WebSocket messages at 4 MiB; oRPC messages stay under 1 MiB; `GET`/`POST /mcp/connect/<id>` and `GET /mcp/callback` (MCP connects, §6.3 exception). The host emits no CORS headers (the proxy adds them). A `bufferedAmount` above 16 MiB closes the socket with 1013.

### 6.7 Server-side denial (D14)

A `platform: HostPlatform` value (`"electron" | "web-host"`) is injected into the services that own a platform-bound operation, and those throw `UNSUPPORTED` on the host: `McpAdminService.import(file)`, `McpOAuthService.signIn`, `AbacusConnectorService.connect` (replaced by the platform flow returning a URL), `MessagingGatewayService.openLink`/`openSharedLink` (return the URL), `BrowserProfilesService.*`, `browser.clearData`, the three render host services, `devices.*`, `localModels.*`, `update.*` (`status` answers `idle`), `window.*`, `notch.*`. `syncConnectors` constructs only the Abacus channels connector on the host. The denied list is one table, `desktop/main/platform/capabilities.ts`, read by the procedures' guard and by R8-T3's interceptor.

### 6.8 The agent on the host

Spawned with the bundled `node`, `ABACUSAI_BOT_SANDBOX=off`, `ABACUSAI_BOT_CLIENT_KIND=web_host`, the browser toolset excluded, and the stored bot key. `render_document`, `render_deck` and `render_design` answer `UNSUPPORTED`. Restoring these with a headless Chromium `BrowserTargetSource` is the first follow-up.

### 6.9 Resources, endpoints, telemetry

- `resourcesRoot()` honours `ABACUSAI_BOT_RESOURCES` first, regardless of `isPackaged`; the tarball lays out `resources/agent/...` exactly as the packaged desktop does. `ArtifactResolver` on the host is baseline-only.
- `abacusAppHost()` and `abacusRoutellmV1()` honour `ABACUSAI_BOT_ABACUS_HOST` when `ABACUSAI_BOT_HOST_MODE=1` (still https and `*.abacus.ai`); `buildAgentConfigEnv` follows. Desktop restrictions unchanged.
- Client kind `web_host`; log, debug, diagnostics and funnel syncs only when their URLs are set.

### 6.10 Bundle

`apps/host/scripts/bundle.mjs` → `dist/host-linux-<arch>.tar.gz` (tar root `host/`):

```
node                       Node 22 linux-<arch>, sha256 pinned
bin/abacusai-bot-host      exec "$DIR/node" "$DIR/host/index.js" "$@"
host/index.js (+chunks)    tsdown esm node22; host/package.json {"type":"module","version","contractVersion"}
host/node_modules/         the host's external closure with linux-<arch> bindings
resources/                 apps/desktop/resources, plus resources/agent/ = packages/agent/dist filtered as electron-builder.yml does, vendor/, node_modules/ as electron-builder.yml:36-90
```

`verify-host-bundle.mjs` loads every shipped package under the bundled Node, runs rg and fd, spawns the agent to `ready`, opens a pty, runs a native search, and starts the host with a fake owner to check `/healthz`, a foreign-Origin refusal, a missing-token refusal and a wrong-owner refusal.

## 7. The hosting contract (what the host expects from its environment)

The hosting side is not in this repository. The host assumes:

1. **Launch.** A bootstrap on the remote machine downloads the tarball named by a published manifest (`{ version, contractVersion, files: { "linux-x64": { url, sha256 }, "linux-arm64": {...} } }`), verifies the checksum, runs `bin/abacusai-bot-host --verify`, and starts `bin/abacusai-bot-host` with the §6.3 environment plus `ABACUSAI_BOT_HOME`, `ABACUSAI_BOT_RESOURCES`, `ABACUSAI_BOT_SANDBOX=off` and (optionally) `ABACUSAI_BOT_ABACUS_HOST`. It relaunches on exit 75 only, never replaces a live host implicitly, and keeps the secret file stable across restarts.
2. **Routing.** A reverse proxy authenticates the browser, forwards `Origin`, `Sec-WebSocket-Protocol` and `Authorization`, strips inbound identity headers and injects `x-abacus-user-id` and `x-abacus-org-id` (hashed), and proxies WebSocket upgrades. It may cap WebSocket message size (§6.6 assumes 4 MiB) and add CORS headers.
3. **Connect token.** The hosting side mints §6.3 tokens with the same secret it gave the bootstrap and hands them to the SPA together with the host URL.
4. **Lifecycle.** The hosting side stops the machine when idle; the SPA's keep-alive (§5.4) is how it learns the user is still there. `/healthz`'s `busy` and `lastActivityAt` are available to it.

## 8. (reserved)

## 9. Desktop build after the split

### 9.1 One renderer root

Both Vite configs set `root: apps/web`. `apps/bot/vite.renderer.ts` exports the shared plugin list (two `tanstackRouter` instances with `routesDirectory` and `generatedRouteTree` under `apps/bot/src`, `tailwindcss`, the two `react()` instances with regexes re-keyed on `apps/bot/src/`, the release-build plugin re-keyed on `src/routes/_bare/[__ui].tsx`, and a `platform` plugin that provides the `__ABACUS_PLATFORM__` define, injects the CSP meta via `transformIndexHtml`, and throws when the platform or `VITE_CONNECT_SRC` (browser only) is missing). `apps/desktop/vite.config.ts` uses that root with inputs `index.html` and `notch.html`, `build.outDir = <desktop>/dist/renderer` (absolute), platform `electron`, plus the `vite-plugin-electron/multi-env` entries with absolute paths. `apps/bot/vite.config.ts` uses input `index.html` only, `base: "/bot/"`, outDir `apps/bot/dist`, platform `browser`. The `ort-dist` alias moves to `vite.renderer.ts`.

### 9.2 TypeScript and tests

`packages/contract/tsconfig.json` is a composite project; `apps/bot/tsconfig.json`, `apps/desktop/tsconfig.{main,preload}.json` and `apps/host/tsconfig.json` reference it. `apps/desktop/vitest.config.ts` drops the `renderer` and `shared` projects; `apps/bot/vitest.config.ts` has `renderer` (jsdom, `electron`) and `renderer-browser` (gating tests, `browser`); `packages/contract/vitest.config.ts` has `shared`. The WebSocket smoke aliases `@abacus-ai/contract` and keeps passing.

### 9.3 Experience, provenance and release guards

- `apps/updater/src/classify.ts`: experience prefixes become `apps/bot/src/`, `apps/bot/index.html`, `apps/bot/notch.html`, excluding browser-only paths (`features/shell/connect/`, `features/shell/lease.ts`, `apps/bot/vite.config.ts`); `packages/contract/` is foundation; `apps/host/` is ignored by the desktop classifier.
- `scripts/build-provenance.mjs` reads `packages/contract/src/experience.ts`.
- `scripts/release-build-plugin.mjs`: gallery stub path re-keyed; `chunk-sizes.json` ids normalised with `<web>` as well as `<desktop>`; a zero-match canary fails the build.
- `scripts/check-chat-bundle.mjs`, `oxlint.config.ts`, `components.json`, `knip.json`: re-keyed, each with a zero-match canary.

### 9.4 Path-bound files to update

Active consumers: `vite.shared.ts`, `package.json#imports` (desktop and web), `tsconfig*.json`, `vitest.config.ts`, `oxlint.config.ts`, `knip.json`, `components.json`, `turbo.json`, root `package.json`, `.github/workflows/ci.yml`, `scripts/{sync-locales.js, check-jsx-i18n.js, check-ui-copy.mjs, i18n-dynamic-keys.test.mjs, sync-chat-fixtures.mjs, shadcn.mjs, shadcn-init.mjs, shadcn-registry-snapshot.mjs, check-release-build.{mjs,test.mjs}, check-chat-bundle.mjs, check-react-compiler.mjs, generate-routes.mjs, screenshots.mjs, ui-audit-capture.mjs, measure-release-size.mjs, build-experience.js, release-build-plugin.mjs, vite-resolution.test.ts}`, `scripts/build-provenance.mjs`, `scripts/cutover/*`, `e2e/phase5-real.mjs`, `desktop/main/{notch/notch.electron.test.ts, dev/renderer.electron.test.ts, packaged-startup.test.ts}`, `desktop/shared/{contract/transport-guard.test.ts, desktop-notices.test.ts}`, `renderer/features/parity.test.ts`. Generated parity metadata is regenerated. Historical documents are left as written; `docs/architecture.md` gets a section on the layout.

## 10. Deferred

Scheduled routine wake-up of a stopped host, and a host-renewed busy lease, need the hosting side to know the schedule and the busy state. The host will publish its schedule (`routines.schedule`) and renew a lease while `busy`; the hosting side will start the machine for a due routine and call `routines.run` over the host's HTTP route. Nothing in r2 blocks it.

## 11. Acceptance (app side)

| # | Check |
|---|---|
| R8-T1 | `pnpm check` green on both branches; the sum of unit tests across desktop, web, contract and host is not lower than before the move. |
| R8-T2 | Electron dev and packaged smoke pass on macOS from the `apps/web` root; `dist/renderer/{index,notch}.html` exist; main-window screenshots byte-identical. |
| R8-T3 | `apps/web` dev against `pnpm smoke:rpc --serve` boots to the shell; an interceptor fails the run on any `FORBIDDEN` or `UNSUPPORTED` and on any `window.*`/`notch.*` call. |
| R8-T4 | `apps/web` against a real local host (Origin and token provided by `scripts/dev-proxy.mjs`): handoff, chat turn, terminal, files, routines, artifacts, settings persist across reload, trash moves the file, a 10 MB attachment uploads via `/upload`. |
| R8-T5 | Transport loss: connection-lost screen, reload, connect screen re-resolves the host. A failed handshake shows the connect error, not "connection lost". |
| R8-T6 | Browser bundle contains no module from `features/notch`, `features/sessions/device`, local-models, `settings/updates`, `window-chrome`, device or embedded-browser components; Electron bundle size within 1 %. |
| R8-T7 | Injected CSP per platform; Electron copy pinned equal to `renderer-csp.ts`; a build without a platform value fails. |
| R8-T8 | `verify-host-bundle.mjs` as §6.10, including the three refusal cases, a pty and a native search. |
| R8-T9 | `pnpm smoke:rpc` keeps passing with loopback defaults and no flow context. |
| R8-T10 | Under the shim: `composeHost` runs through `initialize` and `start`; every retained procedure answers or throws `UNSUPPORTED`; each agent host service is exercised; `workspace-store`'s migrations run; `config.json` is untouched by the store shim; the shim's export list diffs clean. |
| R8-T11 | Flow control over the socket bounds pending bytes under a stalled consumer; `bufferedAmount` over 16 MiB closes with 1013. |

## Amendments recorded during implementation (4 Oct 2026)

Decisions taken while the two app PRs were reviewed and fixed; the implementation notes under `reviews/08-web-split.impl-notes-pr{1,2}.md` carry the evidence.

- **Start and bootstrap are one call.** The browser polls a single hosting-side bootstrap service every 3 s; it answers `starting` until the machine is up and the host is launched, then `ready` with the connect token and the host address. The browser never drives machine start itself, and the token is re-minted (idempotently) before uploads when older than 8 minutes.
- **Host secret delivery.** The hosting side gives the bootstrap a one-use, short-lived, conversation-bound ticket; the bootstrap redeems it with the machine's own credential to fetch the host secret and writes it once to `ABACUSAI_BOT_HOST_SECRET_FILE`. A live healthy host is never replaced implicitly; a newer host version applies on the next cold start or an explicit "Restart your computer".
- **Payload bounds.** oRPC replies over the socket are bounded at 1 MiB (the proxy in front caps frames at 4 MiB). Large content (images, decks, long transcripts, Whisper models) is read by the browser through a token-authenticated `GET /files` route on the host, with the same typed errors and size caps as the RPC readers, HEAD and `Range` for existence probes, and a typed `PAYLOAD_TOO_LARGE` error instead of a dead socket. `voice.whisper.fetch` is denied on the web host.
- **Platform modules.** Electron-only implementations live behind build-time `#platform/<name>` aliases resolved per Vite config, so the Electron bundle keeps static imports and its chunk graph (parity within 1 % of the pre-split baseline, recipe committed); a resolved-target boundary plugin fails any browser build that reaches an Electron module. `IS_ELECTRON` remains for small inline branches.
- **Host mode is a build-time constant** of `apps/host`, never a runtime env var a packaged desktop build could honour.
- **Capability table** denies whole procedure families on the web host and a test classifies every contract procedure.
- **Same origin.** The web app is served at `/bot/` on the apps origin; all service calls are relative; `connect-src` is `'self'` plus the preview hosts; storage keys and the notification channel are namespaced.
