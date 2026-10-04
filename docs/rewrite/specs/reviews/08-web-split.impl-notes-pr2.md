# Spec 08 PR 2 implementation notes

Branch: `rewrite/headless-host`, stacked on `rewrite/web-split`. Scope: spec r2
§6, D1/D8–D10/D13–D15, R8-T8–T11 and PR 1's host follow-ups. The same-origin
amendment changes the configured apps Origin, rather than the host protocol.

## Landed

- Shared `composeHost` owns migration, held-write replay, initialize/start,
  event wiring, cron and disposal. Desktop hooks preserve preference overlay,
  account restoration, RPC installation and startup order. `handler.ts` takes
  platform operations; native auth, microphone, login item, local models and
  relaunch live in the Electron adapter. Node file, log-archive and selected-skill
  helpers are shared with the desktop.
- `apps/host` implements all AppOperations, the host operations, lease tracking,
  a generated Electron export shim with import-drift coverage, and a Conf store
  using `host-userdata`. Native services receive `web-host`; device/privacy,
  browser profiles, MCP file import/OAuth, render services and browser runtime
  fail before touching Electron. Messaging constructs only Abacus connectors
  and returns browser URLs.
- The host strips inherited pod credentials before service imports. Web auth
  uses a single-use ten-minute S256 verifier and adopts the exchanged bot key
  without relaunch. Origin, signed owner/org/expiry claims and proxy owner header
  are required on upgrades and uploads. The secret is read from the supplied
  file, with its UTF-8 text used as the HMAC key.
- HTTP exposes minimal unauthenticated health, activity/busy state and a bounded
  256 MiB raw/multipart upload route, with no CORS headers. The socket transport
  retains loopback defaults and adds per-connection flow registries, JSON ack
  filtering before oRPC, a 1 MiB frame cap and a 16 MiB backlog kill switch.
  The existing renderer interceptor works with the host ack protocol.
- Agent launch uses the bundled Node, sandbox off, `web_host`, and browser-tool
  exclusions. Browser/device MCP servers are disabled on the host. Resource
  override, staging endpoint resolution, baseline-only artifacts and opt-in
  telemetry are implemented without changing `packages/agent` behavior.
- Linux bundling ships SHA256-pinned Node 22.22.0, host chunks, contained runtime
  dependency closures, desktop resources and the agent/native tooling. `--verify`
  imports host and agent external package entry points. Bundle verification
  launches an authenticated host, tests refusals, PTY, native search, rg/fd and
  agent readiness. A local HTTPS dev proxy supplies bootstrap identity headers;
  [exact commands](../../../../apps/host/README.md) cover host, Vite and Chromium.
- Host tests compose real services under the shim, exercise retained procedures
  with structurally valid fixtures, all seven agent host-service entry points,
  workspace-store migrations and config preservation, auth, HTTP, and stalled
  socket flow control. Workspace type checks include the host tests.

## Facts and deviations

- The actual account shape is `account` plus onboarding state, with no
  `AccountState.signedIn` field. The host returns the existing AccountState.
  The actual messaging link procedure is `openSharedLink`; no new `openLink`
  procedure is invented. Update idle is the existing all-false status object.
  `showItemInFolder` has a void contract, so its Node implementation is a no-op.
- T10's literal “answers or UNSUPPORTED” excludes ordinary domain failures.
  Offline/unconfigured retained procedures also return their existing
  NOT_FOUND, CONFLICT, unauthorized or precondition outcomes. The comprehensive
  procedure probe accepts those failures and rejects invalid-input, internal
  failures and accidental shim access; it does not fake successful server data.
- Failed host upgrades are HTTP 403 before a socket exists; a browser observes
  the failed handshake rather than a WebSocket 1008 frame. The existing loopback
  transport's missing-token close remains 1008.
- The export drift list includes `contextBridge` and `webUtils` from preload
  imports, beyond the spec's illustrative main-side list. Conf 10 is the current
  desktop electron-store base version and preserves its JSON format.
- Dependency closures use relative symlinks into `host/node_modules/.packages`;
  all targets remain inside the extracted tarball. The connector package exposes
  registry/describe/tool-meta subpaths rather than an importable package root;
  verification imports those entry points.
- The only renderer changes handle the new `system.notification` contract event
  and narrow notification-click consumers. SPA deployment, connection screen
  service URLs and the `/bot/` amendment remain owned by PR 1's fix pass.

## Validation

- `env -u NO_COLOR xvfb-run -a pnpm check`: workspace build, typecheck, lint,
  formatting, unused-code checks and tests pass, including Linux Electron suites
  (288 desktop suites / 2,782 tests passed; 26 existing platform/fixture skips).
- `pnpm smoke:rpc`: loopback system info, streams, windowless refusal and original
  missing-token behavior remain green (R8-T9).
- Host: seven suites / nineteen tests, including migrations, retained procedures
  and real WebSocket acknowledgements. A stalled consumer stops wire delivery;
  pending overflow yields RESYNC_REQUIRED and bufferedAmount above 16 MiB closes
  with retryable 1013 (R8-T10/T11).
- The local proxy smoke verifies HTTP identity headers, preview CORS preflight
  and a WebSocket round trip with injected Origin, owner and token. Sign-out
  coverage confirms stored-key removal without native auth cancellation.
- `pnpm --filter @abacus-ai/host bundle` and independent
  `verify-host-bundle.mjs apps/host/dist/host-linux-x64.tar.gz`: Linux x64 Node 22,
  native imports, health, valid auth, foreign Origin/missing token/wrong owner
  refusals, PTY, native search and agent ready (R8-T8).

## Not run and follow-ups

- R8-T4's staging browser/real account handoff, real gateway polling and LLM run
  need a logged-in staging user and deployed hosting services. The local proxy
  commands support this run; the automated tests use isolated homes and fake
  credentials. No production services were changed.
- Linux arm64 execution and macOS Electron acceptance require those machines;
  the arm64 Node checksum is pinned but this machine builds/verifies x64 only.
- Hosting bootstrap/CDN/proxy deployment is PR 3 scope. Headless Chromium
  render/browser services remain the explicitly deferred v1 follow-up.
