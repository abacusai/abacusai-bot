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

## Fix pass r1

Read both complete independent reviews and the server minter/verifier and
bootstrap in the web server worktree. Changes and commands are confined to
`rewrite/headless-host`; the server files were read only. The dispositions below
supersede the broader acceptance claims in the initial notes.

| Finding | Disposition and evidence |
| --- | --- |
| Codex 1 / Opus B1 | Fixed. The entry defaults resources to its installed sibling before importing consumers. Bundle verification clears the inherited override, uses an unrelated cwd, discards stdout and runs the bootstrap's direct `node host/index.js --verify` command. Runtime smoke starts through `bin/abacusai-bot-host`. |
| Codex 2 / Opus M2 | Fixed. The messaging procedure returns the service's URL. A pending real web-host connector is exercised through an actual authenticated-development socket; desktop coverage pins the native window and void result. |
| Codex 3 / Opus M3 | Fixed. Authenticated `GET /files?hostRoot=&path=` (`/file` alias) streams through `openHostFile`. Host middleware caps all replies and iterator events with the defined `PAYLOAD_TOO_LARGE` error and HTTP alternative; file readers also check size before reading. Desktop MessagePorts keep their existing behavior. The socket guards outbound sends at 1 MiB with 1009. Actual socket tests cover inbound/outbound frames, a 4 MiB image, continued RPC use after the typed error, and oversized terminal scrollback. |
| Codex 4 | Fixed. Service disposal stops agent-tools MCP, closes its connections, stops telemetry timers, awaits messaging disposal and removes composition tracker listeners. Real composition tests start MCP, dispose, check the listening port, active Server handles and bus listener counts. Extracted-bundle smoke starts MCP in a child, sends SIGTERM and requires natural exit without SIGKILL. |
| Codex 5 / Opus m1 | Fixed. Resource copies dereference symlinks; desktop-only llama and scrcpy resources are excluded. The verifier audits every extracted link and rejects absolute, escaping or broken targets. The x64 archive is approximately 68 MiB. |
| Codex 6 / Opus N2 | Fixed. Exactly two token segments, canonical unpadded base64url, fatal UTF-8 decoding, object/string claim types, integer JSON expiry spelling and constant-time HMAC comparison are required. Tests include expiry boundaries, floats (including exponent/integral float spelling), malformed claims, altered payloads and extra segments. Python's verifier accepts some padding; strict unpadded encoding follows the explicit fix-pass decision. |
| Codex 7 / Opus m4 | Fixed. EXDEV falls back to copy then removal, preserving symlinks; failed copying cleans partial trash and retains the source. Tests use `/dev/shm` versus `/tmp` for files, directories, symlinks and a failed FIFO copy. A 30-day trash sweep runs at composition startup. |
| Codex 8 | Fixed. The broad probe now has explicit per-procedure expected codes/messages for absent IDs and offline fixtures, rejects unexpected errors or successes, and allows cancellation only for named idle subscriptions/waiters. Successful reads, pending messaging URLs, migrated workspace/session snapshots, HTTP transfers and disposal have focused value assertions. Real backlog and frame tests complement the retained stalled-terminal/ack/RESYNC_REQUIRED test. This remains an offline probe, not live gateway or LLM acceptance. |
| Opus M1 | Fixed. Host behavior uses `import.meta.env.ABACUS_WEB_HOST`, defined true by the host build and false by the Electron main build. All previous runtime HOST_MODE reads were replaced. A packaged-desktop test sets both environment variables and pins the production endpoint. |
| Opus m2 | Fixed. Restart, relaunch and shim quit share shutdown: dispose and flush before exit 75; SIGTERM/SIGINT dispose and exit naturally, with a 10-second deadline if cleanup or remaining handles stall. Bundle smoke fails if the public host needs SIGKILL. |
| Opus m3 | Fixed. Upload requires an existing workspace/session pair and resolves its workspace/worktree folder server-side. `baseFolder` is ignored; unique attachment prefixes prevent collisions. HTTP tests reject missing sessions, ignore an attacker-chosen folder, and cover multipart and large raw uploads; real composition tests pin session-folder resolution. |
| Opus m5 | Fixed. A paused real client's TCP reads create more than 16 MiB backlog. The installed timer closes with 1013; assertions cover actual close delivery, timer removal and empty flow registries. |
| Opus m6 | Fixed. Shim drift coverage invokes the vendored `packages/agent/vendor/rg`, independent of PATH. |
| Opus m7 | Fixed. `src/fixtures/python-token.json` was generated by executing the exact reference `mint_connect_token` function extracted from the read-only server source. Tests check that vector and a one-byte mutation. |
| Opus m8 | Fixed. The procedure probe captures unhandled rejections and spies on shim `HostUnsupportedError` construction, including a background settling interval. Any observed use fails the probe. |
| Opus m9 | Fixed. Host telemetry uses the configured sync URL as its target; the endpoint helpers explicitly permit the build-time host surface while preserving packaged desktop restrictions. |
| Opus N1 | Fixed. Removed the duplicate device guard and empty type import; moved the composition constant after imports. |
| Opus N3 | Fixed. When present, proxy org headers must match. Secret files must contain exactly 64 lowercase hex characters without a newline; README provisioning now writes that format. Exact UTF-8 HMAC key text remains pinned in auth tests. |
| Opus N4 | Fixed. Bundle contract metadata reads the shared CONTRACT_VERSION declaration rather than hard-coding 1. |
| Opus N5 | Fixed. Dev proxy output and host README use `/bot/`. |
| Opus N6 | Fixed. Each bundle uses unique temporary staging and build output, verifies its own temporary tarball, and atomically renames the finished archive. No stale `dist/*.js` copy or shared staging tree remains. |
| Opus N7 | Fixed for the reported text-frame case. The flow adapter quietly drops malformed text and invalid oRPC text envelopes before dispatch; valid binary frames retain the oRPC decoder. |
| Opus N8 | Fixed. Host log saving returns defined UNSUPPORTED instead of an unreachable pod zip path. |

Final validation (all commands run from this worktree with the requested global
npm bin directory on PATH; native Linux runs used `env -u NO_COLOR xvfb-run -a`):

- `pnpm --filter @abacus-ai/host test`: 9 suites / 31 tests passed.
- `pnpm --filter @abacus-ai/host bundle`: passed, including bootstrap-exact
  verification, extracted-link audit, wrapper runtime and natural disposal exit.
- `node apps/host/scripts/verify-host-bundle.mjs apps/host/dist/host-linux-x64.tar.gz`:
  independently passed against the final extracted archive.
- `pnpm smoke:rpc`: passed all loopback, stream, windowless and missing-token checks.
- Desktop `vitest run --project main`: 278 suites / 2,483 tests passed, 3 skipped.
- `pnpm check` under xvfb: all 33 tasks passed; its full desktop run passed
  290 suites / 2,784 tests with the existing 26 platform/fixture skips.

Linux arm64, macOS, a logged-in staging handoff and a billed LLM turn remain
unrun as described above. No push, deployment or write to another worktree was
performed.
