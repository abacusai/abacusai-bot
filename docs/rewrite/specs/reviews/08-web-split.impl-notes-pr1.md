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
