# Transcript rendering audit

The first change isolates unchanged message rows during streaming. It retains the existing moving window, scroll anchoring, tool paging and thread stores. No T3 Code source was copied, and no dependencies were added.

## Reference and decisions

The reference is [pingdotgg/t3code at commit 611132c](https://github.com/pingdotgg/t3code/tree/611132c171f3a821bd2e32f22261135cef6330ac), verified with GitHub CLI and shallow-cloned outside this repository. Its `LICENSE` is MIT, copyright T3 Tools Inc. The following paths are relative to that clone.

| T3 implementation | Decision for this app |
| --- | --- |
| `apps/web/src/components/chat/MessagesTimeline.tsx` separates memoized row content from shared callbacks and ticking time, with stable keys and LegendList virtualization. | Adopt the row boundary and stable paging callbacks. Keep our existing bounded moving window and measured `content-visibility` geometry. |
| `packages/client-runtime/src/state/threads.ts` uses per-thread atoms and consumes arrays of stream events. `packages/client-runtime/src/state/shell.ts` publishes one state update per batch. | Keep TanStack Store selectors and the eight-thread runtime cache. Frame-based delta batching needs a separate ordering and replay change. |
| `apps/web/src/markdown-incremental.ts` caches closed top-level blocks and falls back for definitions, footnotes and ambiguous input. `apps/web/src/lib/incrementalHighlighting.ts` resumes grammar state on completed lines. | Prioritize this for a later change. Our live Markdown still renders once per text delta. Preserve existing lazy syntax/math loading and bounded caches. |
| `apps/web/src/components/DiffWorkerPoolProvider.tsx` creates workers after commit and briefly retains the pool between viewers. | Consider only after a large-diff benchmark. Our terminal output pump already awaits writes and resumes from offsets. |
| `packages/client-runtime/src/rpc/session.ts` and `apps/server/src/ws.ts` use Effect WebSocket RPC with JSON serialization and scoped connection hooks. `apps/server/src/terminal/OutputProtocol.ts` allows eight pending terminal chunks or 64 KiB before waiting for acknowledgements. | Preserve our binary oRPC transports, delivery-specific queues and acknowledgements. The useful shared principle is bounded delivery; switching serialization or RPC frameworks would not improve this measured renderer bottleneck. |
| `apps/desktop/src/main.ts` assembles desktop lifecycle/window services separately from `apps/desktop/src/backend/DesktopBackendPool.ts` and its scoped server processes. | Keep the current main/renderer responsibilities. Moving the service host into another process needs a separate startup, CPU and teardown benchmark. |
| `apps/web/vite.config.ts` splits routes, uses React Compiler and preloads route intent. | Already present here. Do not introduce another route or state framework. |
| `apps/web/src/components/RenderErrorBoundary.tsx` resets failed rendering when relevant inputs change. | Keep current route and chat error handling. Recovery semantics need focused tests before changing them. |
| Root `vite.config.ts` enforces module boundaries and UI conventions. | Preserve the repository's compiler, import restrictions, lint, format, test and knip gates. Use a narrow, explained manual-memoization import exception. |

## Findings ranked by impact

1. Completed transcript wrappers rerender during every live update. The compiler caches individual elements but cannot cache the row JSX built inside the transcript loop. Changing paging closures also invalidates row props and their tool-window context. `TranscriptMessage` now has a memo boundary, and paging callbacks read current refs through a small scroll-preservation hook.
2. The live message still reparses Markdown on every delta. Incremental parsing or frame-based presentation updates could reduce this cost. Any batching must flush terminal events, preserve replay offsets, handle hidden windows and retain low-rate responsiveness. TanStack AI's fixed-count text batching is not a drop-in frame scheduler.
3. Production startup is about 0.9 s in the baseline, with 639,267 gzip bytes in the main document's static JavaScript import graph and 397,963 in the companion's graph. These are baseline measurements, not established startup regressions. Main startup eagerly imports a large service graph. Profile individual initialization phases before moving services behind async boundaries. Authentication, subscriptions and notch readiness must keep their ordering.
4. Large diff computation and highlighting are unmeasured candidates that warrant a dedicated stress fixture. T3's workers are a useful design reference. A worker conversion without a measured slow case would add complexity.
5. Existing protections should remain. `runtime/session.ts` retains at most 300 messages and hydrates pages of 50; `runtime/runtime.ts` bounds the cache to eight threads; `scroller/window.ts` limits mounted rows and tool steps. `store/selectors.ts` already uses TanStack Store selectors. `markdown/highlighter.ts`, `syntax.ts` and `math.ts` lazily load expensive code and bound cached output. MessagePort/WebSocket transports, `subscriber-queue.ts` and flow-control tests already cover binary serialization, acknowledgements, coalescing and overflow recovery.

## Measurement method

Measurements use an isolated synthetic profile, a separate Vite port and separate Electron/CDP ports. No real API key is supplied. The gallery's `bench-rich` source contains 1,000 messages, 1,500 tool rows and five subagents. The measured transcript retains 300 messages, mounts 95 combined rows initially and 93 after the 20 KiB stream. The stream emits 171 deltas at a requested 4 ms interval. These are synthetic renderer measurements, not provider latency or end-to-end agent throughput.

`node scripts/perf-transcript.mjs <label> <debug-port> <absolute-output-dir>` records three trials, Chrome traces, frame intervals, long tasks, host notifications and `Performance.getMetrics` deltas. It temporarily inserts development-only marks at the row and Markdown function entries and restores the original files in `finally`. Use a disposable worktree and avoid editing these files while it runs. Marks count actual function executions; React fiber flags are not reliable render counters for skipped subtrees. Traces and profiles belong outside the repository.

The dev instance needs `VITE_UI_GALLERY=1`, isolated `ABACUSAI_BOT_HOME` and `ABACUSAI_BOT_USERDATA`, `env -u ABACUS_API_KEY`, and `ABACUSAI_BOT_DEBUG_PORT` other than 9333. This checkout's Vite Electron startup resolves the renderer root instead of the desktop package, so the benchmark disables plugin startup with `ELECTRON_STARTUP_PREVENT=1` and launches Electron explicitly against `apps/desktop`. The dev CSP also blocks the React refresh preamble. The script bypasses CSP over CDP only for this isolated development measurement. Neither workaround changes production security or startup code.

Launch with `--disable-backgrounding-occluded-windows --disable-renderer-backgrounding --disable-background-timer-throttling`. Through the isolated main-process inspector, set `webContents.setBackgroundThrottling(false)` so another running desktop instance does not pause measurement frames. Apply the same settings before and after. Use the default renderer execution context rather than Electron's isolated preload context. The script installs the same no-op DevTools hook in both versions.

Timing comparisons must use the same build mode, profile, instrumentation and background settings. Exact render counts are the primary result; tracing and marks add overhead, and concurrent applications introduce timing noise. Report medians and retain all three samples. Production startup and bundle results use release builds without gallery modules or a CSP bypass. A five-minute forced-GC session probe measures retained heap, DOM counters, main CPU/RSS and outgoing MessagePort volume during repeated fixture navigation. It is a short regression probe, not proof against all leaks. Synthetic gallery streams do not exercise agent IPC. No INP or real-provider throughput improvement is claimed. Production startup is the interval from spawning Electron to the landing page marker followed by two animation frames, sampled every 25 ms. It is a usable-page paint proxy, not a standardized TTI measurement. Each production trial uses a fresh user-data directory, 200 sessions, 100 bots and a persisted 1,000-message thread. The companion uses the unpackaged test geometry override `ABACUSBOT_NOTCH_METRICS=200x32`.

## Results and verification

The primary paired comparison uses three traced, instrumented trials per revision on Apple M3, 16 GiB RAM, Electron 44.4.5 and Node 22.19.0. Row executions fall from a median 10,098 to 210, or 59.1 to 1.23 per delta. Renderer script time falls from 2,300 ms to 1,746 ms, a 24.1% reduction. Frame interval p95 changes from 33.7 ms to 32.9 ms. Long tasks fall from two to one per stream. Main-thread task p95 increases from 14.9 ms to 16.3 ms. The task-duration distribution changes, and this metric is not a separate win. Markdown executions remain 175 and host notifications remain 186.

A second candidate run in a fresh Electron process records row counts of 240, 210 and 207, and script times of 1,727, 1,640 and 1,729 ms. Frame p95 varies between 17.6 and 32.8 ms in that repeat. The reduced rendering work is reproducible; the frame timing varies with scheduling and should not be presented as a guaranteed percentage improvement.

All individual samples are in [t3-transcript-results.json](./t3-transcript-results.json). Traces remain outside the repository as `before-compiler-{0,1,2}.trace.json` and `after-compiler-{0,1,2}.trace.json`.

| Metric | Before | After | Interpretation |
| --- | ---: | ---: | --- |
| Row executions per 171-delta stream | 10,098 | 210 | 97.9% fewer |
| Renderer script time per stream | 2,300 ms | 1,746 ms | 24.1% lower |
| Streaming frame interval p95 | 33.7 ms | 32.9 ms | Small change; variable across repeats |
| Long tasks per stream | 2 | 1 | One expensive task remains |
| Markdown executions / host notifications | 175 / 186 | 175 / 186 | Next optimization target |
| Five-second scroll frame interval p95 | 17.5 ms | 17.6 ms | Unchanged |
| Five-minute retained heap after GC | 72.7 MiB | 72.8 MiB | Stable within this probe |
| Final DOM nodes | 4,696 | 4,696 | Stable |
| Production landing-page paint | 896 ms | 887 ms | No meaningful startup change |
| Production persisted-thread paint | 561 ms | 556 ms | No meaningful navigation change |
| Main CPU during navigation plus five seconds | 249 ms | 220 ms | Noise-sized difference; no main-process code change |
| Main RSS at the end of that window | 233.6 MiB | 233.6 MiB | Unchanged |
| Outgoing MessagePort messages in that window | 59 | 59 | About 10.6 messages/s including navigation |
| All production JS chunks, raw | 6,416,930 bytes | 6,417,110 bytes | +180 bytes, still 318 chunks |
| All production JS chunks, gzip | 2,154,756 bytes | 2,154,799 bytes | +43 bytes |
| Main document static JS graph, raw | 1,843,391 bytes | 1,843,391 bytes | Unchanged |
| Companion static JS graph, raw | 1,193,785 bytes | 1,193,785 bytes | Unchanged |

The five-minute probes complete 77 baseline cycles and 90 candidate cycles. Each cycle streams 20 KiB and remounts the fixture. Retained heap starts at 73.8/74.2 MiB and peaks at 77.0/76.9 MiB. Both end with two DOM documents. The first scrolling sample loads 300 retained messages; subsequent fresh fixture visits use the normal 50-message hydration page. Outgoing IPC does not increase during synthetic gallery streams. Those streams run through FakeRelay, so these counts do not measure real agent IPC. Main-process RSS/CPU from the development probes are not compared because the companion's readiness and process warmup differ. The matched production trials above include both documents.

The cleanup extracts the existing scroll-preservation logic into one helper/hook and makes tool paging callbacks stable. The row's message, tool range, freshness, estimated height and component identity remain normal memoized props. The regression test checks that changing live text skips the completed row's context, while repeated paging advances correctly. No dead files or dependencies were removed without evidence. The full renderer run exposed a stale assertion in `features/settings/cross-apis.test.tsx`: it expected an `href` call after production navigation had moved to typed route parameters. That test now verifies the resulting routine path and run query instead of the internal argument shape. Its four tests pass; production notification code is unchanged.

Verification passed on macOS with the checkout commit pinned for CI build provenance:

- `env -u ABACUS_API_KEY CI=1 ABACUS_BUILD_COMMIT=<checkout> pnpm check`: all 27 static/build tasks and all 25 test/build tasks passed. Vitest recorded 7,928 passed tests and six existing skips across the agent, web, desktop, contract, host, connectors and updater packages. The 270 renderer files and 298 desktop files passed, including all 13 transcript tests and the real Electron suites.
- `typecheck:tools`, `check:react-compiler` with zero diagnostics, `check:chat-bundle`, `check:release`, `scripts/check-web-bundle.mjs`, `measure-release-size.mjs` and `size-limit` passed. Generated size-budget paths were restored after checking; measurement outputs and traces stay outside the repository.

The existing skips are in agent guardrails/POSIX-shell, host filesystem and desktop window-chrome suites. The initial full run found the stale notification assertion described above; the corrected full run passed. Review scroll anchoring while paging old tool-heavy messages, arrival of fresh messages, and returning to a cached thread. Follow-up work should start with incremental Markdown or frame-based presentation batching, then a dedicated large-diff benchmark, then startup phase profiling. The dev Electron launch-root and React-refresh CSP issues are separate tooling fixes.
