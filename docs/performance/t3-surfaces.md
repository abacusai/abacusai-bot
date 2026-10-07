# T3 Code surface and idle-work audit

2026-10-07; base `origin/main` `097b0934`. Independent of transcript draft #225.
The reference is the MIT-licensed shallow clone of `pingdotgg/t3code` at
`611132c171f3a821bd2e32f22261135cef6330ac`. No reference source was copied.
Clone: `/private/tmp/claude-502/-Users-rajaniraiyn-work-abacusai-bot/8484e24c-4fa0-469e-9d25-ca66bb117a6c/scratchpad/t3code-ref`.

## Findings and retained changes

| Rank | Finding / workload | Before | After | Decision |
| --- | --- | --- | --- | --- |
| 1 | Sidebar timestamp formatting, 300 labels × 20 refreshes, five CDP samples | 141 ms median (134.3–144.3) | 4.9 ms (4.4–4.9) | Separate date-utility PR; output digest identical |
| 2 | One selected browser surface + 20 mounted inactive surfaces, three 5-second samples | 6,300 rectangle reads; 210 presenter refreshes | 300 reads; 10 refreshes | Keep; inactive surfaces retain registration without monitoring |
| 2 | Renderer script duration in the browser fixture | 29.94 ms median | 9.02 ms median | Keep; 69.9% lower in final comparison |
| 2 | Renderer task duration in the browser fixture | 83.77 ms median | 42.11 ms median | Keep; 49.7% lower in final comparison |
| 2 | Same 21 surfaces, document hidden, three 5-second samples | 210 refreshes; no frame reads | 0 refreshes; no frame reads | Stop observation while hidden; resume and refresh on visibility change |
| 3 | Scope message-action `:has()` to its existing `.isolate` positioner; 200 insert/remove operations, five samples | 88.16 ms median style recalculation | 87.95 ms | Rejected: no reliable improvement |
| — | GPU CPU during the browser fixture (`getAppMetrics`) | 0.074% median | About 0.08% | Measurement floor; no GPU win claimed |

These are narrow workload measurements, not whole-app latency claims. The date
benchmark's repeat was 155.9 → 5.5 ms with the same digest. Browser figures use
Electron 44.4.5 on macOS, a development build, CDP 10039, inspector 10032 and Vite
5199. The fixture uses a presenter stub, so its refresh counter is **not IPC
messages/s**. It isolates monitoring cost; native presenter tests cover ownership
and generation. Emulated focus makes the fixture foreground-visible without OS
input; the actual document-hidden run disables that emulation. Temporary
instrumentation counts only browser-region rectangle reads. Traces and raw
samples stay outside the repository in `/private/tmp/abacus-surface-perf`.

## Sidebar, browser and overlays: comparison

| T3 clone path / mechanism | Our equivalent | Adopted or deferred |
| --- | --- | --- |
| `apps/web/src/components/ui/sidebar.tsx`, `sidebarState.ts`, `components/sidebar/SidebarChrome.tsx`: shared responsive state, Sheet on mobile, ResizeObserver brand measurement | `features/shell/sidebar-slot.tsx`, `floating-intent.tsx`, `rail.tsx`; animated widths, hover intent, keyboard focus restoration, manual phone scrim | Defer phone drawer primitive migration. It changes focus and gesture behavior in a concurrent UI area; no measured benefit yet |
| `components/Sidebar.tsx`, `Sidebar.logic.tsx`: memoized rows, row-scoped subscriptions, visibility leases; #9052 and #10413 | Sessions use TanStack DB live collections and keyed rows; Bots use per-row `useNow`, broad attention/previews inputs | Keep the existing shared clock; timestamp formatter reuse is the isolated shared-utility win. Row subscriptions and grouping remain next candidates |
| `browser/BrowserSurfaceSlot.tsx`: slot lease, resize/scroll notifications, observe moving inline panel ancestor, layoutVersion | `components/browser-surface/index.tsx`, `features/shell/native-presenter.ts`: registered candidate, ResizeObserver plus permanent rAF and 500 ms poll | Adopt observation lifetime bounded by visible surface and visible document. Registration remains stable. Active monitoring remains for opaque `blocked(rect)` callbacks and document view transitions |
| `browser/browserSurfaceStore.ts`, `HostedBrowserWebview.tsx`, `hostedBrowserWebviewStyle.ts`: activity leases and capture exceptions; #8567, #9001 | Native `WebContentsView` parked in a hidden `BaseWindow`, retained 1280×900 viewport, capture with `stayHidden`; `services/browser/electron-browser-runtime.ts` | Preserve native parking and automation semantics. Do not transplant CSS `visibility:hidden` to native views or break screenshots |
| `components/ui/popover.tsx`, `dialog.tsx`, `tooltip.tsx`: Base UI Portal, Positioner, Popup, focus handling; tooltip dismissal through actions and scroll capture | `ui/popover.tsx`, `dialog.tsx`, `tooltip.tsx`, dropdown/context/select/combobox wrappers already use Base UI | Preserve the existing primitive layer. A framework migration would duplicate it. Message affordance has intentional re-anchoring and hover-grace logic |
| Base UI overlay focus and portals, explicit layer z-index values still present in T3 | `lib/overlay-slots.ts`, `features/shell/occlusion.ts`: tracked overlay rects and deduplicated publication | Native views composite above renderer DOM; portals alone cannot solve that. Our observer already ignores unrelated style mutations and follows only animating occluders. Keep it |
| `packages/shared/src/usageFormat.ts`: bounded formatter reuse with explicit zones; #11019 | `lib/format/chat-stamp.ts`: fresh formatter per timestamp | Re-implement bounded formatter reuse separately; project current local calendar fields into UTC so the cache cannot retain an obsolete system zone |

## CSS / GPU PR inventory and applicability

Searched merged PRs using the requested 100-result performance query, then
separate GPU, backdrop/blur/compositor/noise, will-change/content-visibility,
backgroundThrottling/hardware-acceleration/transition-all queries to recover older
results. The following are the relevant desktop/web rendering fixes found in
those results; this is not a claim to have inspected every PR in the repository.
PR bodies and diffs are retained under `/private/tmp/abacus-perf-t3/prs`.

| T3 PR | Actual fix | Audit / decision here |
| --- | --- | --- |
| [#3978](https://github.com/pingdotgg/t3code/pull/3978) | Duty-cycle pulse/ping keyframes with flat holds; move full-window fixed noise behind content into surface backgrounds | No fixed full-window noise found here. Our loading/shimmer/notch feedback needs visibility and idle profiling; do not remove it wholesale |
| [#4446](https://github.com/pingdotgg/t3code/pull/4446) | Remove per-card sidebar backdrop blur; avoid nested model-picker glass; simplify blur saturation and clipping | Ours has broad shell glass, small menu glass and dialog scrim blur. No matching per-row sidebar blur. Picker and avatar changes are excluded by coordination |
| [#7445](https://github.com/pingdotgg/t3code/pull/7445) | Restore default window throttling; unthrottle only capture consumers and clean up captures on close | Our main renderer is permanently unthrottled in `main/index.ts`; high-priority measured follow-up, with startup/hot-swap/capture tests before changing |
| [#7460](https://github.com/pingdotgg/t3code/pull/7460) | Restore unthrottled cold boot, throttle after first reveal | Important companion to #7445; do not merely delete our startup flag |
| [#8018](https://github.com/pingdotgg/t3code/pull/8018) | Suppress duplicate preview state and unchanged PiP frames; retain recording cadence and retry/reload behavior | Presenter already deduplicates bounds; no periodic PiP frame delivery equivalent found. Native browser emits on events. No blind frame dropping |
| [#8567](https://github.com/pingdotgg/t3code/pull/8567) | Hidden mounted previews stop painting unless automation/capture activity leases require them | Adopt inactive renderer monitoring lifetime. Native rendering behavior deliberately retained |
| [#9001](https://github.com/pingdotgg/t3code/pull/9001) | Repair Electron 43 capture/recording and macOS restored-preview regressions; keep macOS parked previews paintable | Evidence against blindly hiding all retained native views; keep capture and automation semantics |
| [#9709](https://github.com/pingdotgg/t3code/pull/9709) | Remove continuous status spin/shimmer and duplicate highlighted activity content | Later revised by #9799. No blanket animation removal here |
| [#9718](https://github.com/pingdotgg/t3code/pull/9718) | Pause hidden terminal drawing, defer font readiness and cancel unneeded animation frames | Our terminal output pump already batches with rAF; hidden terminal lifecycle needs a terminal-specific workload, not a chat benchmark |
| [#9799](https://github.com/pingdotgg/t3code/pull/9799) | Restore transform shimmer/rotation, pause offscreen/hidden, support reduced motion and forced colors; retain diff workers briefly | Preferred direction for ours: retain feedback, gate visibility. Our reduced-motion rules already exist |
| [#10413](https://github.com/pingdotgg/t3code/pull/10413) | Limit bulk row fades/deep clones to 40, retain cheap translated displacement; stabilize dnd-kit bag props; batch shell events | No matching FLIP deep-clone pass in ours. Sessions UI excluded; data batching is future work |
| [#10713](https://github.com/pingdotgg/t3code/pull/10713) | Match content-visibility intrinsic row sizes; gate FLIP work on actual row-sequence changes | Our transcript already measures retained row heights. Sidebar rows have no equivalent content-visibility/FLIP combination |
| [#11206](https://github.com/pingdotgg/t3code/pull/11206) | Remove unused sidebar-wrapper descendant `:has()` | No equivalent sidebar-wide selector found. Our direct-child message selector experiment was rejected |
| [#15265](https://github.com/pingdotgg/t3code/pull/15265) | Remove composer adjacent-sibling descendant `:has()` | Same audit above: ours uses direct-child selectors; measured no reliable gain |
| [#15033](https://github.com/pingdotgg/t3code/pull/15033), [#16372](https://github.com/pingdotgg/t3code/pull/16372) | First remove active-row shimmer, then restore it after profiling: stepped animation paused offscreen was not costly | Respect measured results and reversals; do not assume every animation is expensive |
| [#9697](https://github.com/pingdotgg/t3code/pull/9697), [#9799](https://github.com/pingdotgg/t3code/pull/9799), [#10455](https://github.com/pingdotgg/t3code/pull/10455) | Marketing motion removal, then gated feedback and native smooth paging restoration | Marketing-only; no desktop equivalent to copy |
| [#702](https://github.com/pingdotgg/t3code/pull/702), [#55](https://github.com/pingdotgg/t3code/pull/55) | Stable visible-toast offsets and frontmost filtered-toast visibility | Our Base UI toast stacking is not T3's thread-filtered stack. No matching bug or measured cost |

The own-code search found 24 non-test matches for backdrop blur, blur utilities,
permanent will-change, transition-all, pulse/ping. Notable cases: menu pseudo-element
24px glass; dialog/sheet/drawer scrim blur; `ui/toast.tsx` and `ui/drawer.tsx`
will-change; `ui/switch.tsx` transition-all; bot identity transforms (excluded);
`features/shell/side-panel.tsx` scrim blur. Static gradients and the companion's
small drop shadow are not evidence of a bottleneck. The companion is a transparent,
shadowless native panel; its waveform runs only in the listening UI and supports
reduced motion. Route view transitions are finite and have reduced-motion rules.

`scroll-fade-*` comes from `shadcn/dist/tailwind.css`: masks and scroll-timeline
animations, not a JavaScript polling loop. It warrants a paired scrolling trace;
removing it without a paint/composite win would be a visual change without evidence.
No applicable hardware-acceleration-disable PR was found; no GPU switches changed.

## Main / renderer / sidebar backlog

1. Measure permanent main-renderer `backgroundThrottling:false` with active CSS
   animation, hide/minimize, startup and hot-swaps. Adopt first-reveal/capture leases
   only if complete native tests preserve hidden automation and recording.
2. Measure one status update among 1,000 sidebar rows: Sessions grouping scans each
   workspace and parses dates in sort comparators; Bots rebuild broad attention and
   preview inputs. Row-scoped subscriptions and cached sort keys are promising.
   T3 #9052 / #10413 / #11019 are useful references. No sidebar UIs changed here.
3. Replace active browser rAF/poll with explicit occlusion/view-transition/layout
   notifications. T3's `BrowserSurfaceSlot` is the model; our opaque callbacks are
   the obstacle. Include ancestor motion, scroll, popup exit, document transitions,
   owner capture failures and generation changes in the test matrix.
4. Profile scroll-fade masks, glass and shimmer on a high-refresh display. Capture
   GPU process CPU/RSS, layers, paint/composite damage, dropped frames and trusted
   input Event Timing. Dev rAF samples are not a valid INP measurement.
5. Main process: profile checkout watcher/poll fallbacks, cron/webhook/debug-sync
   timers, diagnostics I/O, logging and session child processes with real sessions.
   T3 #16272 / #14893 / #13763 show why indiscriminate polling and whole-log reads
   deserve attention. Synthetic empty-service profiles cannot establish their cost.
6. Memory: repeat a multi-hour session with cached chats, terminals, browser leases
   and companion activity. T3 #5148 / #13686 / #16032 demonstrate retention paths;
   a short heap snapshot does not prove leak freedom.
7. Consider Base UI Drawer for the phone sidebar's focus/gesture layer after the
   concurrent Sessions work lands. Preserve hover sidebar behavior on desktop.

Review needs: switch repeatedly between local-file/browser tabs, open nested menus
and dialogs over the native view, hide/show the app, and check translated timestamps
around midnight. No Sessions panel, avatar or Settings About styling was changed.

## Production and native verification

Fresh profiles contain 200 sessions, 100 bots, a persisted 1,000-message thread
and the companion. Three launches each use the unchanged baseline production
build and the browser candidate production build. Spawn to the bot-start marker
plus two rAFs (25 ms readiness polling, an interactive-paint proxy) is
998.61 → 972.88 ms median. Opening the persisted thread (normal first 50-message
page) is 563.28 → 573.32 ms. Main RSS is 233.78 → 233.09 MiB; GPU RSS
115.66 → 116.52 MiB; main CPU for navigation plus five seconds is
199.02 → 201.26 ms. Median outgoing MessagePort count is 59 → 59; the first
baseline sample was 22, so this is not a stable IPC throughput result. None of
these differences is claimed as a performance win. Total renderer JS is
6,416,930 → 6,417,150 raw bytes; 2,154,756 → 2,154,820 gzip bytes; 318 chunks.
No production startup, memory or bundle improvement is claimed.

A separate dev-only probe invoked the real main browser procedures and mounted
`BrowserSurface` with `createNativePresenter`. It passed native present → inactive
parking → active return → occluder block with capture → restored presentation →
close. The temporary source and local page were removed before final verification.

The scroll-fade prototype used 120 rAF-driven scroll positions, alternating the
original mask and `mask-image:none` for three pairs over 300 retained messages.
Median frame p95 was 17.6 → 17.6 ms. Paint duration was 45.96 → 41.41 ms, raster
14.84 → 8.96 ms and the GPU process's reported CPU was 1.00% → 0.80%. It removes
a visible affordance and did not improve frame pacing, so it was rejected for this
patch; a visually equivalent replacement needs separate review. Trusted-input
INP, system power draw and a high-refresh display remain unmeasured. `Layers` was
enabled and traces include paint/raster/compositor categories; `DrawFrame` and
`CompositeLayers` events were absent in this runtime, so they are not reported as
zero dropped frames. Basic GPU info and feature status were captured externally;
they do not establish hardware utilization.

## Validation

The sequential full repository `pnpm check` passes on `a62e8ae5`: all 27
static/build checks and 7,928 tests across updater, connectors, agent, contract,
web, host and desktop, with six existing skips. This includes native browser
snapshots, companion viewport/disposal, real-session and rich-transcript
performance gates. Typecheck for tools, React Compiler (zero diagnostics),
chat/web bundles, release graph and size-limit gates also pass. The unchanged
agent golden tests share a temporary directory, so concurrent whole-repository
runs were discarded and rerun sequentially. The stale routing spy assertion
from #225 is repaired identically, with no production Settings UI change.

Production and CDP comparisons use the original `097b0934` base. Final branch
rebasing includes the independently landed avatar and license work; those
changes are not part of the measured comparison.
