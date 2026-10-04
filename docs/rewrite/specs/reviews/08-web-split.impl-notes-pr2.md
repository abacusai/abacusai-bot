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

## Fix pass r2

Addressed every finding in `pr2.claude-r2.md` on the rebased
`rewrite/headless-host` worktree. This section supersedes the pre-rebase test
counts and capability claims above. All commands used the global npm bin on
PATH; desktop/native acceptance ran with `env -u NO_COLOR xvfb-run -a`.

| Finding | Disposition and evidence |
| --- | --- |
| Rebase fallout | `update.status` now expects `UNSUPPORTED`; removed the dead `system.openExternal` and `system.logs.save` expected-failure entries. Running the composition test exposed the next stale assertion: PR 1 also denies `auth.abacus.signOut`. It now asserts `UNSUPPORTED` and verifies the sentinel credential remains intact. |
| N-M1 | The socket junk filter accepts string `i`, optional `t` in 1–4, and optional object `p`, including payload-free abort frames. The real-socket cancellation test enables server flow control and the client credit interceptor, receives a system event, returns the iterator, and checks that both bus listeners and the flow registry return to baseline while the socket remains open. |
| N-M2 | Reply/event sizing uses the actual oRPC serializer and shared custom binary serializers. An asynchronous preflight counts base64 length and serializer path metadata without enumerating bytes, yields while walking large collections, and rejects oversized or excessively deep values before synchronous serialization. File reader stat checks remain before reads. Tests pin 300 KiB Uint8Array and Buffer wire sizes, early 40 MiB rejection, event-loop progress, and metadata expansion bounds. |
| N-M2 / Whisper | `voice.whisper.fetch` is denied on web hosts before the model service runs. Authenticated `GET /files?whisperUrl=<encoded-original-model-url>` resolves/downloads a validated Whisper repository file and streams its cached path. Downloads use asynchronous disk I/O and a streaming pipeline into a temporary file, followed by rename, with no whole-model RPC reply or synchronous model read/write. Existing desktop fetch remains available. HTTP tests cover authentication before downloads, 2 MiB transfer, caching, and foreign URL refusal. |
| N-m1 / renderer consumers | The host README and the PR 1 handoff below specify the HTTP consumers and typed error handling still needed in the renderer. |
| Trash sweep | Removed the sweep from composition. It starts unawaited after the socket/HTTP listener is ready; root and individual entry failures are logged and never reject startup. A broken entry test confirms that other expired entries are still removed. |
| Bundle staging | Staging lives inside `try/finally`, so failures remove the temporary directory; only a verified tarball is renamed into place. |
| Host dev | `host dev` now builds/verifies a bundle and runs its extracted wrapper with complete resources, forwards arguments, and cleans extraction on exit. `pnpm --filter @abacus-ai/host dev --verify` passed. |
| HTTP length | `/files` advertises stat size and uses `end: size - 1`, with an explicit empty-file response. A real HTTP regression grows a file after stat and verifies that only the original length is returned. |

Post-rebase validation:

- `pnpm --filter @abacus-ai/host test`: 10 suites / 38 tests passed.
- Desktop `vitest run --project main`: 278 suites / 2,484 tests passed, 3 skipped.
- `pnpm smoke:rpc`: passed system info, update stream, windowless refusal, and
  missing-token close 1008.
- `pnpm --filter @abacus-ai/host bundle` and independent
  `node apps/host/scripts/verify-host-bundle.mjs apps/host/dist/host-linux-x64.tar.gz`:
  passed bootstrap-exact verification, link audit, native search/PTY, agent
  readiness and natural disposal exit.
- Full `env -u NO_COLOR xvfb-run -a pnpm check`: all 33 tasks passed. Its full
  desktop run passed 290 suites / 2,785 tests, with 3 suites and 26 tests skipped;
  host passed 10 suites / 38 tests. Web passed 211 suites / 1,563 tests.

PR 1 renderer handoff (required by the web host):

- Add a `/files` consumer using the host service origin and the current connect
  token in `Authorization: Bearer <token>`. The proxy supplies the owner/Origin
  headers; use the same authentication/renewal flow as uploads. File requests
  use `/files?hostRoot=<workspace>&path=<file>`, encoded with `URLSearchParams`.
- Use that consumer for `files.readImageAsDataUrl` and `files.readPptx` when the
  RPC limit is exceeded, and for large transcript/export files. Consume Blob or
  ArrayBuffer data, render/revoke image Blob URLs, parse deck bytes and transcript
  text in the renderer, and retain desktop transport behavior.
- Change the web Whisper fetch hook to fetch
  `${host.origin}/files?${new URLSearchParams({ whisperUrl: originalModelUrl })}`
  with the connect token. Accepted URLs are under
  `https://huggingface.co/onnx-community/whisper-base/resolve/main/`;
  `voice.whisper.progress` remains available during cache population. Web hosts
  return `UNSUPPORTED` for the old `voice.whisper.fetch` RPC.
- Handle defined `PAYLOAD_TOO_LARGE` explicitly: use `data.alternative` when it
  identifies a concrete file, keep the connection usable, and offer HTTP
  download/retry. Large snapshots without an export file still require paging
  or chunking; the placeholder alternative is not an existing download.

Linux arm64, macOS, logged-in staging handoff and billed LLM acceptance remain
unrun. Changes and commits stay in this worktree; no push or deployment occurred.

## Fix pass r3

Addressed F1–F3 from `pr2.codex-r2.md` in `rewrite/headless-host`:

- F1: the asynchronous preflight now charges serializer metadata paths for
  undefined array elements and NaN, including undefined values in Sets/Map
  entries. Path sizes include JSON escaping and UTF-8 bytes. Accepted values
  are measured using the actual `StandardRPCSerializer` output and the shared
  binary serializer. Tests compare exact output sizes for undefined elements,
  sparse arrays, Sets/Maps, NaN, valid/invalid Dates and nested binaries, and
  require oversized repeated metadata paths to be rejected before synchronous
  serialization.
- F2: authenticated file downloads open one descriptor, stat it and stream from
  that same descriptor with the original length bound. A byte-counting transform
  errors on short EOF, destroying the response socket before a clean end. The
  HTTP regression truncates a file after stat and requires a prompt aborted
  response; growth and empty-file tests still pass.
- F3: the text-frame gate validates the request decoder's envelope and payload
  grammar and closes malformed frames with 1008 before decoding. Tests cover
  invalid ids/types/payloads/extra keys, missing request URLs and iterator events,
  invalid JSON, and valid request, iterator and payload-free abort frames. Binary
  pass-through and the real-socket cancellation regression remain covered.

Validation (global npm bin on PATH, all commands in this worktree):

- `pnpm --filter @abacus-ai/host test`: 10 suites / 73 tests passed.
- `pnpm smoke:rpc`: passed system info, initial/update stream, windowless
  refusal and missing-token close 1008.
- `env -u NO_COLOR xvfb-run -a pnpm check`: all 33 tasks passed (19 cached).
  Desktop passed 290 suites / 2,785 tests, with 3 suites / 26 tests skipped;
  web passed 211 suites / 1,568 tests. The initial lint failure for the sparse
  array fixture was corrected before this successful run.

Logs: `/tmp/pr2-r3-{host,smoke,check}.log`. The Electron tests generated a core
dump, moved out of the worktree to `/tmp/pr2-r3-electron.core`.

Committed locally; no push or deployment.

## Rebase onto PR 1 r3

Rebase sanity on `rewrite/headless-host` after PR 1 r2/r3 (`#platform/*`
aliases, resolved-target import boundary, nullable bootstrap schema, `/files`
consumers and shared PPTX parsing) passed without code changes. All commands ran
in this worktree with `export PATH="$(npm prefix -g)/bin:$PATH"`:
`pnpm --filter @abacus-ai/host test` passed 10 suites / 73 tests;
`pnpm smoke:rpc` passed all five checks; desktop `vitest run --project main`
passed 278 suites / 2,484 tests with 3 tests skipped; and
`env -u NO_COLOR xvfb-run -a pnpm check` passed all 33 tasks (12 cached), including
desktop 290 suites / 2,785 tests with 3 suites / 26 tests skipped and web
212 suites / 1,579 tests. Logs are `/tmp/pr2-rebase-r3-{host,smoke,main,check}.log`.
Only this results note was changed and committed locally; no push or changes to
the main checkout or other worktrees occurred.

## Handoff r4 (/files probes)

Implemented the PR 1 r3 renderer handoff in `rewrite/headless-host` after reading
its `/files` reader and browser tests in this worktree. Renderer code and fixtures
already accept the typed bodies and prefer `X-File-Size`; neither needed changes.

- `/files` and its `/file` alias return 404 `{error:"not-found"}`, containment
  403 `{error:"forbidden",reason:"outside-root"}`, and 409
  `{error:"conflict",reason}`. Authentication still returns 403
  `{error:"forbidden"}` without a reason, preserving the renderer's renewal rule.
- HEAD authenticates and resolves the same file, reports the GET representation's
  headers, and sends no body. GET `Range: bytes=0-0` returns one byte with 206
  and `Content-Range: bytes 0-0/<original-size>`; an empty representation returns
  416 with `Content-Range: bytes */<original-size>`. Other ranges are ignored.
- `maxBytes` bounds the descriptor stream on the server. `Content-Length` is the
  transmitted length and `X-File-Size` is the original descriptor stat size.
  Zero returns an empty body; larger limits return the complete file. Invalid
  limits return 400 `{error:"invalid-max-bytes"}`. No limit retains full streaming.
- The descriptor stat/stream and byte-counting transform remain together. Short
  EOF aborts the response; regression coverage now checks full and bounded reads.
  Tests also cover each typed status, auth distinction, HEAD, range, empty files,
  limits, invalid limits, the alias and growth after stat.

Validation (all commands in this worktree, global npm bin directory on PATH):

- `pnpm --filter @abacus-ai/host test`: 10 suites / 74 tests passed.
- `pnpm --filter @abacus-ai/web test`: both Vitest projects passed, 212 files /
  1,597 tests, including the 29 browser host-file reader tests.
- `pnpm smoke:rpc`: all five checks passed.
- `env -u NO_COLOR xvfb-run -a pnpm check`: all 33 tasks passed (17 cached),
  4m48.326s. Desktop passed 290 files / 2,785 tests, with the existing 3 file /
  26 test skips. Native reload/swap and late-port coverage passed.

Logs: `/tmp/pr2-r4-{host,web,smoke,check}.log`.

Committed locally; no push, deployment or changes to another worktree.

- Claude r3 N2–N4 follow-up: binary JSON frames use the text envelope gate; `/files` returns fixed realpath/Whisper error reasons; uncached Whisper HEAD returns 404 without fetching; the dev proxy exposes Content-Length, Content-Range and X-File-Size. Regression coverage passes with `pnpm --filter @abacus-ai/host test` (11 suites / 98 tests), `pnpm smoke:rpc` (all five checks), host typecheck and targeted lint. Committed locally without pushing; all work stayed in this worktree.
