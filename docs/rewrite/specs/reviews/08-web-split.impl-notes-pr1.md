# Spec 08 PR 1 implementation notes

Branch: `rewrite/web-split`, on `rewrite/renderer`. Scope: spec r2 §§3 D2/D3,
4, 5 and 9, with the contract and capability groundwork owned by this slice.

## Landed

- Separate mechanical moves and scripted import rewrite commits. The shared tree
  is `packages/contract/src`; the sole renderer tree and both HTML entries are
  in `apps/web`. The rewrite replaced 688 occurrences of `#shared/`, including
  tooling and test aliases.
- Web and contract workspace manifests, dependency ownership, composite TS
  references, platform-specific Vitest projects, Turbo inputs, knip workspaces,
  and runtime aliases for directory-index imports. No host workspace was created.
- Shared renderer plugins, compile-time platform gates, CSP injection and the
  Electron and `/web/` browser builds. Desktop main/preload entries remain owned
  by the Electron plugin. Release, provenance, locale, registry, route, parity,
  screenshot and source-root consumers follow the moved sources.
- Browser bootstrap, connection screen, owner/version health check, proxy retry,
  authenticated WebSocket with open barrier and client flow-control interceptor,
  activity and lease. Native UI, native queries and subscriptions are gated.
  Native settings routes reject browser navigation in `beforeLoad`.
- Web sign-in handoff contracts and client, URL-based connector completion with
  polling, messaging link URL support, paste-key OpenRouter, uploads over HTTP,
  host folder picker and file viewer, browser external links and notifications
  with BroadcastChannel leader election. Electron paths retain their calls.
- `system.activity`, `UNSUPPORTED`, and a shared capability table used by the
  procedure middleware and browser smoke interceptor. Electron is the default
  platform; PR 2 supplies `web-host`.
- Bundle/config canaries, CSP/dev-entry pin tests, package classifier tests,
  browser gating tests and the real smoke-server jsdom boot test. CI checks the
  browser bundle. Architecture and progress documentation describe the layout.

## Deviations and reasons

- A concurrent, uncommitted r3 amendment changes deployment to `/bot/`. This
  slice follows the explicitly requested r2 `/web/` scope and leaves that
  amendment and the separate PR 3 / PR 4 notes untouched.

- The workspace already uses `apps/*`, which discovers `apps/web` and the future
  host. Only the contract package needed a new explicit entry. Host references
  and knip selection wait for PR 2; references to nonexistent projects fail TS.
- The actual dev entry file is `main/renderer-entry.ts`, rather than the spec's
  `main/dev/renderer-entry.ts`. The test pins `new URL("index.html", base)` and
  the moved HTML's `/src/main.tsx` entry at its real location.
- The real image procedure is `files.readImageAsDataUrl`, and the messaging
  contract exposes `openSharedLink`, not a separate `messaging.openLink`.
  Browser adapters use those actual procedures. Connector success can carry a
  URL, and `openSharedLink` can return a URL; Electron still returns its existing
  successful outcome or void. PR 2 implements the host side.
- Rolldown discovers dynamic entry chunks before propagating imported boolean
  constants. A small pre-transform converts platform imports into Vite defines
  before discovery, retaining source maps. This makes the exclusion assertion
  check emitted chunks rather than merely unreachable runtime branches.
- Browser-safe titlebar geometry and overlay selectors live outside the native
  `window-chrome` tree. The native presenter loads behind the platform branch,
  with an inert browser presenter for shared layout code.
- Oxlint also checks dynamic imports. Its native-import rule has explicit
  exemptions for the platform boundary modules and native implementations;
  shared static imports are pinned by a failing-import canary.
- Contract exports identify the public modules and public domain directories.
  A wildcard over the entire source tree caused knip to classify any new unused
  file as a public entry, defeating the unused-file canary.
- The shared project's emitted types need `strictNullChecks`; without it nullable
  procedure types lose their null alternatives across composite boundaries.
- Linux native testing exposed a fixture race: its fake readiness barrier
  resolves before Chromium publishes the swapped view's overlay geometry. The
  fixture now waits up to five seconds for that rectangle; its original
  clearance assertions remain unchanged.
- The root Turbo task was named `check:knip-next` while the script requests
  `check:knip`. It is corrected, and the source/config canaries join `pnpm check`.
  Display environment variables pass through so native Linux tests can run.
- Rebuilding the agent exposed its external workspace connector registry import.
  Desktop packaging now copies the registry manifest and built files beside the
  agent. No agent runtime source, configuration, or behavior was changed; its two
  registry-reading tests follow the new contract path.
- The audit gate found a new patched HTTP cache advisory; the tooling closure is
  pinned to `http-cache-semantics` 4.3.0. The unpatched braces advisory is recorded
  with the existing audit exception mechanism: these consumers use trusted build
  globs and pinned registry input, never user/host RPC patterns. Remove that
  exception when a patched release exists.
- Registry snapshots and cutover inventories retain their historical bytes.
  Active consumers and parity metadata are re-keyed instead. Locale and registry
  scripts remain desktop-owned commands that operate on web-owned sources.

## Validation

- `pnpm --filter @abacus-ai/desktop build`: passes; both
  `apps/desktop/dist/renderer/index.html` and `notch.html` exist.
- `pnpm --filter @abacus-ai/web build`: passes; `apps/web/dist/index.html`
  references `/web/assets/*`. `node scripts/check-web-bundle.mjs` passes over
  289 chunks / 476 web modules, with no listed native implementation modules.
- `pnpm smoke:rpc`: passes system info, initial/change update streams,
  windowless refusal and missing-token close 1008 (R8-T9).
- R8-T3 runs in the browser Vitest project against a child
  `pnpm smoke:rpc --serve`: the real transport and bootstrap mount the shell;
  navigation covers bots, appearance, models, messaging, sessions and account.
  Its interceptor asserts no denied procedure calls or wire errors. Client flow
  control is disabled for this legacy server; the separate WebSocket gating
  test verifies ack messages. PR 2 owns server flow control.
- CSP and dev URL pins pass. The real Linux MessagePort handshake's two tests
  pass under Xvfb, including reload/swap cleanup and late-port disposal.
- Release graph/output check, chat bundle check (349 chunks), source/config
  and knip canaries pass. React Compiler: zero diagnostics.
- Renderer size was compared with a fresh archive of `rewrite/renderer`, using
  the same installed dependencies and the emitted `chunk-sizes.json` graphs:
  raw JS is 6,099,921 → 6,155,773 bytes (+0.92%); summed per-chunk gzip is
  2,036,433 → 2,075,174 bytes (+1.90%). Raw size meets R8-T6's 1% threshold;
  per-chunk gzip exceeds it because the dynamic native boundaries split more
  chunks (306 → 349). Compression/chunk-layout parity remains a follow-up.
- `env -u NO_COLOR xvfb-run -a pnpm check`: green, 30/30 Turbo tasks.
  This includes format, lint, typecheck, tests, audit, i18n, locales, knip,
  UI registry and the added web-split canaries. Desktop: 288 suites / 2,782
  tests passed, 3 suites / 26 tests skipped by existing platform/build-mode
  conditions. Web: 208 suites / 1,543 tests passed. Contract: 25 suites / 419
  tests passed. Agent: 2,068 tests passed, 5 skipped; updater: 15 passed;
  connectors: 14 passed. A final frozen-lockfile install also passes.

R8-T2 requires macOS Electron and cannot run in this Linux environment. The dev
URL shape is covered by the unit pin; Linux native suites use Xvfb. The host
needed its missing GTK runtime installed before Electron could execute. The
runner injects both `NO_COLOR` and `FORCE_COLOR`; checks ran with `NO_COLOR`
unset to avoid a Node warning changing a subprocess stderr assertion. Production
Apps services, staging pods, proxy authentication, signed release packaging and
physical notch hardware are outside this local PR 1 run.

## PR 2 follow-ups

- Add the actual host package, TS reference and knip workspace; extract host
  composition and operations, set `RpcContext.platform` to `web-host`, and inject
  that platform into service operations reached outside RPC.
- Implement the web handoff's verifier storage, credential exchange/adoption,
  sign-out without relaunch, connector URL/polling backend and messaging URL
  return. Restrict connector construction and agent tools on the host.
- Implement token/Origin/owner verification and subprotocol selection, health,
  upload with size limits and CORS policy, server flow-control registry/acks,
  activity/busy tracking, and headless file/trash operations.
- Supply the Apps get-or-create/bootstrap/keep-alive services and deployment;
  exercise staging cold start, health negative-auth cache, expired tokens,
  lease/reaping and persisted credentials/workspaces end to end.
- Recheck compressed Electron bundle size after chunk-layout tuning; the raw
  bytes meet the 1% guard but summed per-chunk gzip currently grows 1.90%.
- Run the macOS R8-T2 smoke and host shim/bundle/foreign-Origin tests; preserve
  the desktop builds and loopback smoke while enabling host policy.

## Fix pass r1

Read both `pr1.codex-r1.md` and `pr1.claude-r1.md` completely. This pass adopts
all eight r3 deployment changes and the service/build decisions supplied with
the fix request. The original implementation and validation sections above are
historical: their `/web/` deployment, regex transform, lazy native boundaries,
connector packaging rationale, gzip measurements and acknowledgement-test claim
are superseded below. In particular, the original WebSocket tests did **not**
verify acknowledgements, and `generateBundle` did **not** measure final gzip.

The Apps boundary was checked against `abacusaibot_host.py`, `async_app/app.py`
and `return_filters.py` in the supplied server checkout. Its envelope and error
classes are implemented; bootstrap's starting/ready union follows the expressly
agreed parallel server change. SPA tests pin that agreed union rather than claim
that the current server already returns it. The SPA never calls the computer
service. It polls bootstrap every three seconds, then credentialed health,
verifies token owner and contract version, and retains the visible/active
60-second keep-alive. Upload refresh is single-flight after eight minutes and
on one authentication failure; it preserves the established RPC connection.

### Codex review dispositions

| Finding | Disposition and evidence |
| --- | --- |
| 1 — tour native query | Fixed final `enabled` option; R8-T3 starts the tour with denied-call interception. |
| 2 — onboarding focus | Native refetch listener installed only on Electron; R8-T3 focuses the rendered browser welcome page. |
| 3 — connector completion | Shared completion adapter used by onboarding, first-run Gmail, agent requests and library. URL success polls until connected before reporting success. First-run browser Gmail requires a visible consent button. Tests start disconnected. |
| 4 — popup activation | Blank window reserved synchronously before RPC, opener detached explicitly, then URL assigned. Blocked windows show a clickable continuation. Messaging links use the same reservation. Real Chromium checks delayed RPC and blocked recovery. |
| 5 — expired uploads | Eight-minute bootstrap refresh, concurrent-refresh deduplication and one auth-failure retry; tests keep connection URL unchanged. |
| 6 — client OS | Terminal keys, sidebar hints and search use `uiPlatform`; host dataset remains for shell/path semantics. Mac browser/Linux host test covers clipboard and Mod+N. |
| 7 — notification liveness | Boot-time peer discovery, per-event Web Lock and shared bounded dedupe survive heartbeat gaps; fresh election fallback. Tests cover simultaneous tabs, gaps and leader exit. |
| 8 — regex transform | Removed entirely. Vite resolves build-time `#platform/*` aliases; inline platform booleans use the define. No source-text rewriting or extra transform maps remain. |
| 9 — import boundary | Resolved-target Vite boundary rejects native implementations independent of alias/relative/index/extension spelling, including dynamic imports. Canaries exercise actual resolver hook. Ineffective oxlint rule removed. |
| 10 — discovery leaks | Platform-filtered search index and browser-hidden local-model credit action; browser UI assertions added. |
| 11 — folder navigation | Initial active workspace/root selected; Up and Root controls, empty directories selectable, generation guard rejects stale navigation results. Tests added. |
| 12 — gzip accounting/parity | Measure emitted files in `writeBundle`; commit fresh `99f20795` final-file baseline and enforce count/raw/gzip within 1%. Figures below. |
| 13 — ack coverage/claims | Added real WebSocket/oRPC stream consumption test for flow header, serialized JSON acknowledgements and closure; separate concurrent-consumption batching test. Legacy R8-T3 server still disables server flow control explicitly. Original unsupported claim retracted above. |
| 14 — computer wire format | Superseded by agreed server-owned start: removed computer service entirely. Tests pin get-or-create and bootstrap bodies, one-shot force restart, starting/ready polling, envelope and real error classes. |
| 15 / r3 — base | Browser base and asset fixtures/checks now `/bot/`; real served production bundle loads there. |
| 16 / r3 — origin | All Apps calls relative, `same-origin`, `REAI-UI: 1`; origins parameterized in tests. Sign-in/upgrade relative; obsolete host/env switch removed. |
| 17 / r3 — CSP | Exact self plus HTTPS/WSS preview defaults, empty browser value rejected, mode-correct env resolution; Electron policy preserved. |

### Claude review dispositions

| Finding | Disposition and evidence |
| --- | --- |
| B1 — service contract | Real envelope/token/error parsing and prescribed server-owned bootstrap, as described above; sign-in/upgrade/retry errors distinguished. |
| M1 — Electron rendering | Static imports restored via build-time platform modules; existing lazy tab boundaries retained. Standalone native handshake bundler explicitly resolves the application’s Electron transport alias. Removed harness pending-area waits and top-level-await boundaries. Final renderer parity enforced below. |
| M2 — native calls | Tour, onboarding focus, messaging login, routines folder selection and account native sign-out gated/adapted. Route smoke waits for rendered landmarks, then visits mutation/focus/search surfaces. |
| M3 — capability families | Deny full native families and explicitly allow shared procedures. Unknown procedures fail closed. Exhaustive test enumerates every contract procedure and rejects missing, overlapping or stale classification. |
| M4 — upload token | Same fix as Codex 5; idempotent bootstrap refresh never restarts a healthy host. |
| M5 — classifier ignore | Static Electron transport/system imports no longer live in browser-ignored files. Bundle check classifies every shipped repository module and fails if any is ignored; ignored browser modules must be absent from Electron. |
| M6 — coverage/notes | Real acknowledgement tests plus rendered-route/focus/tour smoke. Unsupported original claim explicitly corrected; local/live/platform limits recorded below. |
| m1 — CSP ordering | `head-prepend`; emitted HTML check requires CSP before first script. |
| m2 — fragile transform | Removed; alias selection precedes graph discovery. |
| m3 — alias-only lint | Replaced with resolved-target build boundary and spelling canaries. |
| m4 — contract strictness | Strict source config, unchecked-index/override checks, no ambient Node types; separate strict test config permits Node only in tests. Both configs checked. |
| m5 — absolute metadata IDs | Normalize desktop, web, contract and repository roots; final parity gate rejects remaining absolute paths. Browser metadata emitted outside dist. |
| m6 — UI OS | Same fix as Codex 6; host OS retained for shell selection. |
| m7 — messaging regression | Shared Abacus ID only in browser; second connect skipped for identical ID. Electron retains original shared-ID behavior. |
| m8 — connection robustness | Malformed envelope/health/token becomes retryable connection error; separate 65-second 403 and five-minute install deadlines; plain handshake errors offer reload; dev-only host/token override and matching dev CSP. |
| m9 — unbounded authorization | Three-minute deadline, current-flow checks and cancel affordance in shared adapter; cancellation/timeout tests. |
| m10 — multi-tab attention | Boot-time discovery and shared claims used by sounds and notifications; short content dedupe, event-key dedupe, user-gesture permission request and click navigation. |
| m11 — proxy spread/type | Browser returns a narrow explicitly typed adapter, with only supported methods and folder dialog; no oRPC proxy spread. Electron uses original system client. |
| m12 — Turbo/dev | Web hashing includes desktop shared config/scripts/main and root provenance inputs. Desktop dev depends on agent/vendor tasks explicitly; dry graph contains no browser build/typecheck prerequisite. |
| m13 — connector copy | Verified built agent has no external connector package specifier; removed redundant electron-builder resource copy. |
| m14 — CI settings | Restored CI timeouts, worker settings and locale/generated/UI coverage exclusions. |
| n1 — ownership/dead env | Agent type dependency and React testing library moved to dev dependencies; unused platform/environment env declarations removed. |
| n2 — redundant filter | Removed extra messaging filter. |
| n3 — repeated sign-in | Namespaced once-only browser claim makes sign-out stick on later welcome mounts, matching Electron intent. |
| n4 — platform API | Prefer `userAgentData.platform`, fall back to `navigator.platform`. |
| n5 — accuracy | Historical acknowledgement, gzip and connector packaging claims superseded and corrected explicitly here. |
| r3-1 | `/bot/` base, fixtures, checker and actual Chromium load. |
| r3-2 | Relative Apps APIs, same-origin credentials/header, no appsHost or environment switch. |
| r3-3 | Relative `/chatllm/signin` with encoded `/bot/<hash>` redirect and relative upgrade destination. |
| r3-4 | Exact requested self/preview HTTPS/WSS policy and blank-value failure; desktop does not read browser production env. Preview wildcard follows supplied deployment decision; no live preprod/devpod hostname assertion is claimed. |
| r3-5 | Preview health/upload use `include`; WebSocket constructor uses URL/subprotocol only, never an Origin override. Client tests pin these. Host allowlist/CORS implementation and live proxy verification remain PR 2/deployment work. |
| r3-6 | Every local/session storage key and BroadcastChannel name prefixed `abacusai-bot:` as requested. Same-origin security implication recorded below. |
| r3-7 | No maps, chunk sizes or release metadata in browser dist; chunk sizes live in sibling build-metadata directory. Publisher must archive that dist as `bot/index.html` and `bot/assets/*`; PR 4 owns archive/installer code outside this slice. |
| r3-8 | Desktop sets its own envDir and does not load apps/web/.env.production; browser uses current mode env. Shipped-module classifier guard verifies ignore list assumptions. |

For r3 / spec §5.4: `/bot/` and `/chatllm` share an origin. An XSS in either can
read the other's origin storage; namespacing prevents accidental key/channel
collisions, not access by hostile same-origin JavaScript. This note records the
amended security assumption without overwriting the user's concurrent spec edit.

### Fix-pass validation

- `env -u NO_COLOR xvfb-run -a pnpm check --force`: passes, **30/30 tasks,
  zero cached**, 8m13.813s. Includes format, lint, strict typechecks, tests,
  audit, i18n/locales, knip, registry and source/build canaries.
  Desktop: 288 files / 2,783 tests pass, 3 files / 26 tests skipped under existing
  platform/build-mode conditions. Web: both projects, 211 files / 1,563 tests
  pass (browser project: 9 files / 30 tests). Contract: 25 files / 419 tests
  pass. Agent: 128 files / 2,068 tests pass, 1 file / 5 tests skipped.
  Connectors: 14 tests pass; updater: 15 tests pass.
- Both `pnpm --filter @abacus-ai/desktop build` and
  `pnpm --filter @abacus-ai/web build` pass, also rerun in the final forced
  task graph. Desktop renderer/notch/main/preload output preserved.
- `node scripts/check-web-bundle.mjs`: passes, 293 browser chunks / 485 web
  module entries, `/bot/assets/*`, prescribed CSP before scripts, no native
  implementation modules and no maps/private metadata in browser dist.
- Final-file Electron baseline gate: fresh archive of `99f20795`, same installed
  dependencies, **306 → 309 chunks (+0.980%)**, **6,099,921 → 6,105,743 raw JS
  bytes (+0.095%)**, **2,036,433 → 2,039,133 summed gzip bytes (+0.133%)**.
  All three metrics satisfy 1%; stored graph totals equal actual files. Baseline
  archive is outside the checkout; no worktree/branch was modified.
- `pnpm smoke:rpc`: all five checks pass, including live update stream,
  windowless refusal and missing-token close 1008.
- Real Chromium over a local HTTP server (Electron BrowserWindow under Xvfb,
  temporary untracked harness): delayed 750ms RPC navigates a synchronously
  reserved popup; blocked popup exposes clickable continuation; built `/bot/`
  SPA loads and offers the relative same-origin sign-in link. All three pass.
  This is real browser execution with a fixture Apps endpoint, not live Apps.
- Both real native handshake tests pass independently and in the final forced
  run: reload/swap cleanup and late-port disposal. Their standalone bundle now
  resolves `#platform/transport` explicitly; port/iterator assertions were not
  relaxed. Earlier full-run failures exposed that missing fixture alias and its
  initial cross-project config import; both are corrected in the final run.
- `pnpm dev --dry=json`: no web build/typecheck prerequisite; agent and vendor
  dependencies retained. Built agent verified to inline the connector registry.
- `git diff --check` passes. Transient native core artifacts were removed.

No macOS R8-T2/physical-notch run, signed packaging run, live Apps deployment,
preprod/devpod hostname validation, preview proxy authentication/CORS/Origin
integration, or real host cold start is claimed. Server bootstrap rollout,
PR 2 host policy/flow-control stress tests, and PR 4 tarball publishing remain
owned by those parallel slices. Client schemas, error mappings, retry budgets,
upload refresh and handshake/ack behaviour are exercised locally.

## Fix pass r2

Addressed all four findings in `.codex-runs/reviews/pr1.codex-r2.md` in the main
checkout on `rewrite/web-split`. Existing spec and PR 3/4 notes were preserved;
no worktree was changed and no commits were pushed.

Bootstrap now requires the server's explicit nullable fields: starting includes
nullable token/version/detail, ready includes nullable version/detail and a
nonempty token. Read the supplied server's `abacusaibot_host.py` and
`return_filters.py`; the return filter preserves `None` and camelCases keys.
The committed JSON fixture is generated by
`scripts/fixtures/generate-bootstrap-fixture.py SERVER_CHECKOUT`. It retains
verbatim dictionaries from the Python tests for both complete starting shapes.
Those tests assert ready fields individually rather than a whole ready dict, so
that fixture retains the actual server method's ready return dictionary instead.
Dynamic identity/token expressions are replaced with deterministic local test
values; nulls are preserved. Connection, polling, refresh and upload tests use
these shapes, including ready `detail: null` and nullable version.

The browser boundary uses `enforce: "pre"`, a pre-ordered `resolveId` hook and
`this.resolve(..., { skipSelf: true })`. Resolved ids are checked independently
in load, transform and the final module graph in generateBundle. Electron
platform implementations and the MessagePort transport are denied alongside the
existing native feature targets. The final bundle check uses the same assertion.
Browser Vitest installs the boundary and production's existing UI-gallery
pruning, so route smoke does not import the internal native gallery.

The real Vite regression uses `createServer({ configFile: false, ... })` and the
client environment's plugin container. Against the old plugin it failed with
`Missing expected rejection` on native-presenter; with the fix it passes for
alias, relative, extension and directory/index imports, direct dev requests and
sanctioned browser aliases. Actual in-memory Vite builds reject both static and
dynamic imports of native-presenter, Electron transport and MessagePort. Separate
hook checks pin load/transform/final-graph rejection. Logs:
`/tmp/r2-boundary-before.log` and `/tmp/r2-boundary-after.log`.

Authorization rechecks cancellation and current-flow status immediately after
awaiting statuses. Deferred-RPC tests cancel or supersede the flow before a
connected response arrives, then require a cancelled result and closed dialog.

The baseline recipe and reproduction conditions live beside the JSON in
`scripts/fixtures/web-split-desktop-baseline.md` and its executable shell script.
A fresh source archive plus a separate frozen dependency archive reproduced the
existing **306 / 6,099,921 / 2,036,433** totals exactly. The recipe pins dependency
commit `6f9b4c10`, lockfile SHA-256, Node/pnpm versions, hoisted install, package
builds, symlinks, cwd, provenance environment and final-file gzip calculation.
It avoids reusing the installed closure that produced the reviewer's extra
nested store modules. The parity check prints the regeneration command.
Reproduction log: `/tmp/r2-baseline.log`.

Validation of the final code:

- Both `pnpm --filter @abacus-ai/desktop build` and
  `pnpm --filter @abacus-ai/web build` pass, independently and in the forced graph.
- `node scripts/check-web-bundle.mjs` passes: 293 browser chunks / 485 renderer
  module entries. Desktop remains 309 chunks / 6,105,743 raw / 2,039,133 gzip,
  within 1% of the independently reproduced baseline in all three metrics.
- `env -u NO_COLOR xvfb-run -a pnpm smoke:rpc` passes all five checks.
- Web Vitest: **211 files / 1,568 tests pass**, including **9 browser files /
  35 tests** with the boundary installed. Contract: **25 files / 419 tests pass**.
- `env -u NO_COLOR xvfb-run -a pnpm check --force`: **30/30 tasks pass, zero
  cached**, 8m27.127s. Includes both builds, all tests, strict typechecks, format,
  lint, audit, knip, i18n/locales, UI registry and canaries. Desktop: **288 files /
  2,783 tests pass**, 3 files / 26 tests skipped under existing conditions.
  Agent: 128 files / 2,068 tests pass, 1 file / 5 tests skipped. Connectors: 14
  tests pass; updater: 15 pass. Native reload/swap and late-port tests pass.
- Shell recipe syntax and `git diff --check` pass.

Logs are `/tmp/r2-{desktop-build,web-build,contract-test,smoke,bundle-final}.log`,
`/tmp/r2-browser-test.log` and `/tmp/r2-check-final.log`. The initial full web run
and first forced check exposed stale upload fixtures and test-only gallery
imports; those were corrected before the successful final forced run. The
standalone web suite's successful final result is included in that forced run.
No live Apps/server deployment or macOS/physical-notch validation is claimed.

## Follow-up r3 (/files consumers)

Implemented the host's Fix pass r2 renderer handoff on `rewrite/web-split` in
this main checkout. The host worktree was read only; existing spec edits and
other review notes were left outside these commits.

- Added browser-only `hostFiles` beside the upload adapter. It encodes
  `hostRoot`/`path` or `whisperUrl` with `URLSearchParams`, sends the connect
  token as a Bearer header with proxy credentials, and shares upload renewal:
  bootstrap after eight minutes and retry once after 401/403. It exposes
  Response, Blob, ArrayBuffer and text reads; HTTP failures remain explicit.
- The browser WebSocket transport routes all `files.readText`,
  `files.readImageAsDataUrl` and `files.readPptx` calls through HTTP before RPC
  encoding. This also covers TanStack query utilities: artifact thumbnails and
  previews, session file panes, bot panels, chat images, host-file dialogs,
  diffs, transcript files and exported snapshots. Text reads return complete
  content unless a consumer explicitly supplies `maxBytes`; binary detection
  and explicit truncation metadata remain. Images become MIME-correct data URLs
  without retaining object URLs.
- Shared the existing deck/XML parser through the contract package, with
  browser-safe package paths and base64 encoding. The browser opens downloaded
  PPTX bytes with JSZip and retains the existing slide/layout/master/theme and
  embedded-media rendering. Electron retains its ZIP reader and RPC readers.
- A shared browser call boundary catches `PAYLOAD_TOO_LARGE` and retries concrete
  `/files` export alternatives as JSON, preserving the socket for later calls.
  Placeholder alternatives are never fetched: as the host handoff states,
  snapshots without an existing export still require host paging/export support.
  Their typed error is preserved rather than pretending a placeholder is a file.
- Whisper's fetch hook gates the browser onto `/files?whisperUrl=...` before
  touching `voice.whisper.fetch`; Electron keeps the existing procedure. Platform
  aliases keep browser connection services out of the Electron bundle.
- Added eleven browser-project tests against a fake HTTP file server: large
  text and query reads, images, deck bytes with embedded media/relationships,
  host-file dialogs, Blob results, Whisper with RPC sends refused, stale-token
  renewal, both auth retry statuses, repeated/non-auth failures, concrete versus
  placeholder alternatives, and a real RPC socket that remains usable after an
  oversized snapshot falls back to HTTP. Fixtures use generic workspace files.

Validation:

- Both desktop and web builds pass. `node scripts/check-web-bundle.mjs` passes,
  including browser/Electron graph checks and desktop baseline bounds.
- Web Vitest in the forced xvfb run: 212 suites / 1,579 tests pass, including
  R8-T3 with no denied calls and the eleven new file-consumer tests.
- Contract Vitest: 25 suites / 419 tests pass.

The first forced check stopped at desktop build because a standalone rebuild
was accidentally started against the same output directory while that task was
running. Its 28 completed tasks passed; the complete forced check was then
rerun without overlapping builds. The earlier standalone web run also caught
the new authentication adapter's missing feature-boundary allowance, which was
fixed with a narrowly scoped seam entry before the passing web run.

Final `env -u NO_COLOR xvfb-run -a pnpm check --force`: **30/30 tasks passed,
zero cached**, 8m4.395s. Desktop: 288 suites / 2,783 tests passed, with the
existing 3 suite / 26 test skips. The complete run includes both builds,
web/contract/native tests, typechecks, formatting, lint, audit, knip, locale/i18n,
registry and cutover checks. Native reload/swap and late-port checks passed.

Logs: `/tmp/r3-desktop-build.log`, `/tmp/r3-web-build.log`,
`/tmp/r3-bundle.log`, `/tmp/r3-files-tests.log`, `/tmp/r3-contract-tests.log`
and `/tmp/r3-check-final.log`. No push, deployment, live Apps handoff or
physical-device validation was performed.

## Fix pass r3

Addresses `.codex-runs/reviews/pr1.claude-r2.md` F1–F3 and the boundary nit.

- PR 2 review r3 N1: text requests `maxBytes=limit+1`, detects overflow from received bytes while retaining only `limit`, and treats `X-File-Size` as optional (bounded Content-Length is only a size lower bound). Existence probes use `Range: bytes=0-0` and exposed `Content-Range`, accepting 206 and empty-file 416. The HTTP fixture honours `maxBytes` with the transmitted Content-Length and no `X-File-Size`; regressions cover below/exact/over-limit text and empty/nonempty probes. Browser Vitest: 10 files / 71 tests pass; the full web Vitest run also passes across both projects. Web build, typecheck and rebuilt bundle check pass (296 chunks / 487 modules).

- Browser HTTP readers translate the current host's `{error: reason}` and
  `{error, reason}` responses into defined `NOT_FOUND{entity:"file",id}`,
  `FORBIDDEN{reason}` and `CONFLICT{reason}` errors. Binary text retains the
  `binary-file` conflict. Content errors do not trigger an authentication refresh.
- Text defaults to 524288 bytes. Reads stream to the preview limit (at least
  8192 bytes for binary detection), then cancel. The `maxBytes:1` existence
  probe reads at most one byte and sends `maxBytes=1`. File size comes from
  `Content-Length`, or `X-File-Size` when the server truncates the response.
- Images use Electron's extension/MIME allowlist and 8 MB cap; PPTX uses its
  60 MB cap. Declared oversized bodies are cancelled before reading; streaming
  caps also apply without Content-Length. Deck parsing inflates XML,
  relationships and images only, skipping audio/video and other entries.
- Artifact integration tests use the browser transport's HTTP readers and
  actual browser dialog for PDF, image and PPTX; missing files return `missing`
  and directories return `directory`. PDFs use a PDF Blob iframe, with URL
  cleanup on close/cancel and browser CSP allowing Blob frames.
- Removed the dead `PAYLOAD_TOO_LARGE` JSON fallback. Host alternatives name
  raw input files or placeholders, not JSON procedure results. Tests preserve
  the actual `{limit:1048576,alternative}` shape and verify a real RPC socket
  remains usable after the error without fetching an alternative.
- File downloads and uploads pass their rejected token to the single-flight
  refresh so a delayed stale 403 cannot trigger another completed refresh.
  Fixture generation writes the same descriptive source field as the fixture,
  without server source paths. The browser boundary denies `#main`, `#preload`
  and resolved desktop main/preload paths; real Vite resolver tests cover both.

### PR 2 handoff

Read `apps/host/src/http.ts` in the supplied host worktree without modifying it.
It currently supports GET only, ignores `maxBytes`, and returns 404
`{error: reason}` even for outside-root and directory failures. The browser
accepts that shape already. For consistent HTTP semantics, return 404
`{error:"not-found"}`, 403 `{error:"forbidden",reason:"outside-root"}` and
409 `{error:"conflict",reason}` for other containment/type failures; keep auth
403 `{error:"forbidden"}` distinguishable from content failures.

Add HEAD and/or `Range: bytes=0-0` support for existence probes. Until then,
honour the browser's `maxBytes` query server-side (especially `maxBytes=1`),
return the transmitted byte count in Content-Length and the original file size
in `X-File-Size`. The browser bounds retained bytes and cancels the current GET
stream, but the existing server can send buffered bytes before cancellation;
server-side bounds are required to guarantee that probes do not transfer the
whole file. Preserve full streaming downloads when no query limit is supplied.
Snapshots still require a concrete export or paging design; raw file alternatives
must never be described as JSON procedure outputs.

### Validation

- `pnpm --filter @abacus-ai/desktop build` and
  `pnpm --filter @abacus-ai/web build`: pass.
- `node scripts/check-web-bundle.mjs`: pass, 296 browser chunks / 487 modules.
  Desktop remains 309 chunks / 6,105,743 bytes / 2,039,133 gzip bytes.
- `env -u NO_COLOR xvfb-run -a pnpm smoke:rpc`: all five checks pass.
- `env -u NO_COLOR xvfb-run -a pnpm --filter @abacus-ai/web test`:
  212 files / 1,597 tests pass, across both Vitest projects. The strengthened
  boundary initially rejected the smoke test's Vite import of native policy;
  the test now reads that policy with Node outside the browser module graph.
- `pnpm --filter @abacus-ai/contract test`: 25 files / 419 tests pass.
- Real Vite boundary tests pass, including `#main` and `#preload` resolves.
  Fixture regeneration from the committed verbatim Python dictionaries in a
  temporary server layout is byte-identical, including descriptive sources.
- `env -u NO_COLOR xvfb-run -a pnpm check --force`: **30/30 tasks pass,
  zero cached**, 7m59.754s. Desktop: 288 files / 2,783 tests pass, with the
  existing 3 file / 26 test skips. Native reload/swap and late-port tests pass.

Logs: `/tmp/fix-r3-desktop-build.log`, `/tmp/fix-r3-web-build.log`,
`/tmp/fix-r3-bundle.log`, `/tmp/fix-r3-smoke.log`, `/tmp/fix-r3-web-tests.log`,
`/tmp/fix-r3-contract-tests.log` and `/tmp/fix-r3-check.log`.

## Fix pass r4 (browser run)

Read `.codex-runs/browser-e2e/REPORT.md`, including “What failed” and all six
“Renderer defects to fix”. The live run successfully minted an auth code and
started the host handoff; the host rejected `auth.web.complete` with
`UNAUTHORIZED`. This pass fixes renderer diagnostics and recovery. It does not
resolve that host/API rejection or bypass the account/onboarding gate.

- Sign-in failures retain the `host-start`, `auth-code` or `host-complete` stage
  and distinguish network loss, missing cookie sessions and rejected handoffs.
  Only known RPC error codes survive; unknown codes become `UNKNOWN`. Original
  messages, causes and payloads are discarded, and codes/challenges/tokens are
  never logged. Onboarding preserves the sanitized outcome instead of replacing
  every browser failure with `auth-failed`.
- Browser onboarding describes connecting the existing account in the current
  tab, with retry/support guidance for auth-code and host failures and network
  recovery guidance for connection loss. Added the web copy to `en-US.json` and
  ran locale sync and the complete locale checks; all ten synced locales receive
  the new keys using the established English fallback.
- Pending copy and the spinner render only for pending attempts (or an idle
  preview). Failed attempts show the failure alert and retry, without
  “Waiting for sign-in…” or “Connecting your account…”.
- Browser “Sign in another way” appears only for a missing cookie session and
  links to same-origin `/chatllm/signin`, returning to `/bot/` plus the current
  hash route. Other browser failures hide it. Electron keeps its existing flow.
- Both injected CSPs add exactly `font-src 'self' data:`. The Electron header
  constant in `renderer-csp.ts` matches the injected Electron policy.
- The shared HTML explicitly links `%BASE_URL%favicon.png`; the public favicon
  is the existing 32×32 app icon. Production output points at
  `/bot/favicon.png`, avoiding the implicit root `/favicon.ico` fallback.

### Validation

- New browser-project tests: 13 pass, covering all failure stages, network
  failures, invalid auth-code responses, missing sessions, secret-bearing error
  sanitization, pending-to-failed UI, recovery-link origin/redirect, host error
  copy, both font policies, Electron CSP pin and the reused favicon asset.
- Web Vitest projects: 215 files / 1,617 tests pass.
- Contract Vitest project: 25 files / 419 tests pass.
- Web TypeScript, locale sync/checks, desktop build and browser build pass.
- `node scripts/check-web-bundle.mjs`: pass, 296 browser chunks / 488 modules.
  Desktop: 309 chunks / 6,115,057 bytes / 2,042,000 gzip bytes.

- `env -u NO_COLOR xvfb-run -a pnpm check --force`: **30/30 tasks pass,
  zero cached**, 8m8.818s. Electron: 288 files / 2,783 tests pass, with the
  existing 3 file / 26 test skips. Agent: 128 files / 2,068 tests pass, with
  the existing 1 file / 5 test skips.

Logs: `/tmp/fix-r4-focused.log`, `/tmp/fix-r4-focused-final.log`,
`/tmp/fix-r4-csp.log`, `/tmp/fix-r4-locales.log`,
`/tmp/fix-r4-typecheck.log`, `/tmp/fix-r4-web-tests.log`,
`/tmp/fix-r4-contract-tests.log`, `/tmp/fix-r4-desktop-build.log`,
`/tmp/fix-r4-web-build.log`, `/tmp/fix-r4-bundle.log` and
`/tmp/fix-r4-check.log`.

## Fix pass r5 (final browser run)

Addressed the renderer defects in `.codex-runs/browser-e2e-2/REPORT.md` on
`rewrite/web-split`, using the headless host checkout only to read its upload
contract. No host or `.worktrees/` files were changed.

- Terminal initialization imports `ghostty-web/ghostty-vt.wasm?url` and passes
  the emitted URL explicitly to `Ghostty.load`; each terminal receives that
  instance. Vite emits `assets/ghostty-vt-DOMeXDrv.wasm`: `/bot/assets/...` on web,
  a module-relative `file:` URL in Electron's `dist/renderer`. Browser
  `connect-src` still excludes `data:`. Initialization errors appear as terminal
  alerts; hidden-tab and disposal paths catch rejection, and failed loads can
  retry instead of caching a permanently rejected promise.
- Uploads pass the composer's workspace/session IDs as query parameters, retain
  token refresh/retry, and validate the host's `{ success, dir, paths }` success
  shape. Picked files, pasted files and drops use the same explicit context.
  The new-session composer persists its stopped session identity before upload
  because the host accepts only an existing session; this does not start an
  agent or advance submission. Bot and existing-session composers pass their
  own session context. Picker rejection appears in the composer as an alert.
- Gmail consent uses an onboarding layout banner slot with a dismiss control,
  rather than a fixed body overlay. The slot leaves the DOM with onboarding,
  including its pending CTA; delayed status results cannot append it to an
  unrelated route. Consent still begins only with an explicit click.
- Web Library hides Messaging navigation, queued-pairing links and the direct
  messaging pane/controls. WhatsApp, Telegram and Discord templates are filtered
  from the renderer catalog and category ordering; gallery connector marks are
  filtered too. Abacus channels remain available.
- Devices in Library Tools is intentionally hidden on web, including direct
  detail routes, consistent with Settings Devices. The contract catalog and
  Electron behavior remain intact. Terminal shell menu translations use
  `terminalShells.<key>.label`. Session/environment execution labels say Host;
  account copy says “Forget this host’s account”, including settings search.
- “Take the tour” remains Electron-only per spec (including removal from web
  settings search). Appearance Density remains Electron-only because it changes
  window chrome. Neither control is restored on web.

Regression coverage runs in `renderer-browser`: explicit WASM loading/retry and
visible hidden-tab failure, CSP, fake HTTP host multipart uploads and success/
failure responses, token retry with context, composer error display, persisted
new-session upload identity, Gmail slot/dismiss lifecycle, template categories,
Library navigation/direct panes/Devices, platform copy and shell menu labels.
R8-T3 now asserts the web Messaging capability gate rather than expecting the
previously leaked pane.

Production terminal probes also passed: Chromium served the built SPA at `/bot/`
and fetched `/bot/assets/ghostty-vt-DOMeXDrv.wasm`, while a real Electron renderer
loaded the built `file:///.../dist/renderer/index.html`. Both initialized the
terminal and read `r5-terminal-ok` from its terminal buffer. This specifically
verifies the renderer/WASM initialization; it is not a new live-host PTY test.
Evidence: `/tmp/fix-r5-browser-terminal-smoke.log`,
`/tmp/fix-r5-terminal-smoke.log`, `/tmp/fix-r5-electron.log`.

Validation and rollout:

- Browser project: 16 files / 95 tests pass, including R8-T3.
- Full web Vitest: 218 files / 1,628 tests pass across both projects.
- Contract Vitest: 25 files / 419 tests pass.
- Desktop and browser production builds pass. `node scripts/check-web-bundle.mjs`
  passes: 296 browser chunks / 489 modules; Electron parity remains within budget.
- `env -u NO_COLOR xvfb-run -a pnpm check --force`: all 30 tasks pass,
  zero cached tasks, including native Electron tests.
- Rebuilt browser dist with the requested `VITE_CONNECT_SRC` allowing self,
  preview HTTPS/WSS and Mumbai internal HTTPS/WSS. Installed with a staged,
  atomic directory exchange into `<dev-pod-html-root>/bot`. Rollback copy:
  `<dev-pod-html-root>/bot`.
- `curl -sk -o /dev/null -w "%{http_code}" <dev-pod-origin>/bot/`
  returns **200**. The hashed WASM reached from the built index's module graph,
  `/bot/assets/ghostty-vt-DOMeXDrv.wasm`, also returns **200**, has the WASM magic
  bytes and matches the built asset byte for byte. The live index matches the
  pod build, and its decoded CSP retains no `data:` in `connect-src`.

Logs: `/tmp/fix-r5-{browser-tests,web-tests,contract-tests,desktop-build,web-build,bundle,check,pod-build}.log`.
Deployment metadata: `/tmp/fix-r5-deployment.json`.
Implementation and notes are committed locally; nothing was pushed. Pre-existing
spec edits and untracked PR3/PR4 review notes were left untouched.

- Cleanup r6: browser Library Tools hides Messaging and its detail route; direct Messaging navigation throws `notFound()` in `beforeLoad`; WhatsApp referral actions, dialog choices and direct links are gated; startup copy says “Starting your workspace” in English and all synced locales. Browser regressions, full web Vitest, web build, bundle, TypeScript, Oxlint, formatting and locale/i18n checks pass.

## Simplification pass

A pass over the non-mechanical diff (everything except `c5e68e8d` moves and
`b60daefb` import rewrite) to remove bespoke code, dead gates and duplicate
tests. No contract changed: procedure names and shapes, `UNSUPPORTED`, the
capability table, `system.activity`, the `/bot/` base, the connect services and
their fields, the `abacus-token.` subprotocol, `/files` and `/upload`, CSP values
and storage keys are as before.

Removed or consolidated:

- **Platform aliases.** One `src/platform/<name>.<platform>.ts(x)` file per
  alias; `platformAlias()` reads the folder instead of listing names and special
  cases, and `package.json#imports` keeps only the `#platform/*` pattern. The
  Electron sign-in is defined beside `platformSystem` (re-exported by
  `sign-in.electron.ts`) so the Electron chunk count stays at 309.
- **Platform splits behind `#platform`.** `connectHost()` (browser connect
  screen, attention install, socket open), `cueClaim()` (sound-cue arbitration,
  formerly two copies of the same ternary) and `signInAbacus()` (four
  `auth.abacus.start`/`webSignIn` ternaries) replace call-site checks; `main.tsx`
  no longer branches on the platform for connect or lease.
- **Dead gates.** The messaging page body is the base version (its route throws
  `notFound` in browsers; only the `IS_ELECTRON` wrapper stays for bundle
  pruning). The onboarding `models` step's cleanup, loader and Connect gates go
  (`guardStep` redirects it). The tour's duplicate `enabled`, the onboarding
  messaging-connector gate, the gallery fixture filter and `platformSystem`
  calls inside Electron-only branches go. One `VISIBLE_TOOLSETS` list serves both
  tools pages.
- **Smaller.** `uiPlatform`, `ConnectScreen`'s error kinds, the authorization
  fallback's cancel handler, the folder picker's directory list, the picked-file
  mapping and the activity report each have one code path.
  `createWebSocketTransport` accepts an already-open socket, so neither
  `connectWebSocketTransport` nor the tests need a constructor shim. The browser
  system adapter imports its helpers statically. Locale keys
  `web.connect.signin`, `web.files.cancel` (duplicates of `phase5.*`) and
  `web.files.select` (always overwritten before display) are removed.
- **Re-export shims.** `lib/window-chrome/{overlay-slots,use-titlebar-area}.ts`
  are gone and their tests sit beside the real modules; the desktop
  `pptx-parser.ts` wrapper is gone (main calls the contract parser on a
  `ZipArchive`), so git reads the shared parser as a move.
- **Desktop.** `unsupported(procedure)` in `rpc/errors.ts` is used by the
  capability middleware and the `auth.web` stubs; the preload reverts to
  `Object.assign(window, …)`; a triple-slash directive the import sorter had
  stranded below an import is removed.
- **Tooling.** The second oxlint override (an exact copy of the renderer rule)
  and the applied one-shot `rekey-web-parity.mjs` are removed. The web Vitest
  config reuses `rendererAlias`. The parity check rejects any absolute module id
  generically, and the baseline note is shortened (the script is the recipe).
- **Tests.** The web CSP test no longer re-derives the Electron policy by
  scraping desktop source (the desktop test pins it against the constant); the
  favicon pin stays. Dropped: the duplicate dev-URL case, the path canary in
  `web-split.test.mjs`, two `/files` cases (a stub pass-through and a duplicate
  Blob read) and two redundant truncation sizes. `parity.test.ts`'s
  missing-symbol case tests symbol lookup again.

Left alone on purpose: the boundary plugin's four hooks (each closes a bypass
the r2 reviews reproduced), the capability allowlist (exact paths fail closed
for new procedures), the contract `exports` map (a wildcard would make every
file public to knip), the hand-written router type (TS7056 without it), the
notification `BroadcastChannel` fallback (jsdom and older browsers lack Web
Locks), the `/files` reader (every branch is pinned), and an i18n override bundle
for the host/desktop wording swaps (smaller, but riskier than this pass). About
120 desktop and contract files carry only import-sorting and wrapping from the
formatter run after `b60daefb`; they are needed by the format check.

`git diff --stat` excluding the two mechanical commits (`rewrite/renderer..99f20795`
plus `b60daefb..<tip>`; the spec commits are 4 files, +914):

| | Files | Insertions | Deletions |
|---|---:|---:|---:|
| Before (`794e13c3`) | 573 | 12,220 | 4,109 |
| After (`9cf872fc`, before this note) | 574 | 10,182 | 2,420 |

The full `rewrite/renderer..<tip>` stat went from 1,294 files, +12,487/−4,376 to
1,293 files, +10,593/−2,831. The pass itself is 73 files, +357/−706; about 3,000
of the stat reduction is the pptx parser now reading as a move.

Validation: web and desktop builds, `node scripts/check-web-bundle.mjs` (291
chunks, 492 web modules; desktop 309 chunks, 6,118,359 bytes, 2,042,961 gzip
against the pre-pass 309 / 6,119,132 / 2,043,375 and the 306 / 6,099,921 /
2,036,433 baseline), `pnpm smoke:rpc`, web Vitest (218 files, 1,625 tests, both
projects), contract Vitest (25 files, 419 tests), `scripts/web-split.test.mjs`,
and `env -u NO_COLOR xvfb-run -a pnpm check --force`: 29/30 tasks. The one
failure is `@abacus-ai/desktop#test`'s `notch.electron.test.ts` (1 of 2,809
tests): this host no longer has the GTK runtime Electron needs
(`libgtk-3.so.0` is missing), so the native suite reports "requires a display".
No native or notch code changed in this pass; the other 283 desktop test files
pass. Rerun on a host with GTK (or with the runtime reinstalled) to close it.

## Same-origin host path

Preprod showed the per-conversation preview hostname has no DNS on self-serve
(`ERR_NAME_NOT_RESOLVED` on `/healthz`). The server now also returns
`host_base` (camelCased to `hostBase`) from `_getOrCreateAbacusBotHost` and
`_bootstrapAbacusBotHost`: a same-origin path, `/api/botHost/<hashed
conversation>`, that it proxies to the host with the prefix stripped, owner
identity headers injected and `Origin`, `Authorization` and
`Sec-WebSocket-Protocol` passed through. `preview_host` stays for one release
and is null.

SPA changes:

- `connect/services.ts` parses `hostBase` (nullish; must start with a single
  `/`, so a protocol-relative or absolute value is refused) and `previewHost`
  (now nullish). `hostHttpBase()` is the one place a host URL is derived:
  `location.origin + hostBase` (trailing slash dropped), else
  `https://<previewHost>` when `hostBase` is null, else a typed connection
  error. `BrowserConnection.origin` became `base`; `/healthz`, `/files`,
  `/upload` and the WebSocket (`base` with `http`→`ws`, plus `/rpc`, so
  `wss://<location.host>/api/botHost/<id>/rpc` in production) all use it. The
  token refresh compares the refreshed `hostHttpBase()` with `base`.
  `getOrCreateAbacusBotHost`'s `previewHost` is no longer read.
- Unchanged: token in `Sec-WebSocket-Protocol`, Bearer on `/files` and
  `/upload`, typed errors, 403 retry window, `PAYLOAD_TOO_LARGE`, lease and
  keep-alive.
- The preview-host fallback is the second branch of `hostHttpBase()` plus the
  nullish `previewHost` fields; delete both once the server stops sending it.
- CSP: browser `connect-src` is `'self'` by default. `VITE_CONNECT_SRC` is now an
  optional extra list appended (deduplicated) to `'self'`; empty or unset is
  valid, so the "required" error is gone. `apps/web/.env.production` sets it
  empty. The bundle check accepts `connect-src 'self'` followed by optional
  extras.
- Fixture: `bootstrap-server.json` carries `hostBase: "/api/botHost/1c0d9e2f7a"`
  and `previewHost: null`; the generator maps `host_base`/`hostBase` to that
  value and keeps literal `None` as null.

Publisher: it no longer needs to pass the preview hosts in `VITE_CONNECT_SRC`
and can drop the variable (or leave it empty) for both channels. Passing the old
`'self' https://… wss://…` list still builds; it only widens the policy.

Host (PR 2): routes stay at `/healthz`, `/rpc`, `/files`, `/upload` because the
proxy strips the prefix. `Origin` is now the apps origin (already in
`ABACUSAI_BOT_HOST_ORIGINS`); the host must not emit absolute or root-relative
redirects or links that the browser follows (the `PAYLOAD_TOO_LARGE`
`alternative` path is data only and the SPA never resolves it). The server
proxy needs a body limit at least the host's upload limit, so the host's own
413 reaches the SPA, and a WebSocket idle timeout longer than the quietest RPC
period.

Tests: connect flow with `hostBase` (health and WebSocket URLs on the current
origin), URL derivation, fallback when `hostBase` is null, refusal of a missing
or off-origin path, refresh refusing a changed path, `/upload` and `/files`
URLs under `hostBase`, and the CSP pin (`'self'` alone for unset/empty/blank,
extras appended without a duplicate `'self'`).
