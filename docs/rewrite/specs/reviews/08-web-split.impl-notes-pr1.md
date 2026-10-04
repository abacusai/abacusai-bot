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
