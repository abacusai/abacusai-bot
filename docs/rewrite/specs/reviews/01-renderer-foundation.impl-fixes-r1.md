# Renderer foundation, implementation review r1: fixes

Answers `01-renderer-foundation.impl-codex-r1.md` (15 findings) and `01-renderer-foundation.impl-claude-r1.md` (25 findings, visual V1–V9), with the owner's decisions A–F recorded in PLAN "Amendments after the phase-1 implementation review", spec 01 §6.7 and §13, and spec 03 §16.2.

Commits on `rewrite/renderer` (after `bb653495`):

- `b4a20100` renderer-next: data/db adapter, boot, shell, transitions, a11y, visuals.
- `dddb36ef` acceptance: Electron suite on real `db.*`, port loss, legacy-diff base.
- `d6e1a776` screenshot gate: collapsed/floating, 1100 split, compact, full screen, OS vibrancy capture; axe serious/critical fail the run.
- (docs) this log, PLAN and spec amendments.

Every fix has a test that fails without it; the test is named per row. "Electron" means `src/main/dev/renderer-next.electron.test.ts` (project `main-serial`), which runs against main's real tables.

## Codex r1

| # | Status | Fix | Test |
|---|---|---|---|
| 1 | Fixed | `bootstrap()`'s failure path returns at once; `reportFailedBoot()` sends `window.ready({ barrier: "failed" })` with an abort signal and a 1 s bound, never awaited by the renderer. | `lib/bootstrap.test.ts` "returns the failure at once when main stops answering the readiness call" |
| 2 | Fixed | `changeLanguage` failure keeps bundled English; `start()` is wrapped: any throw renders BootFailure and reports `failed` (bounded). i18n text lookups in the failure screen cannot throw. | `lib/i18n/i18n.test.ts` (unchanged fallbacks) + Electron boot; the guard is structural (main.tsx, no router in jsdom) — see "Limits" |
| 3 | Fixed | `<Pane>` is always the first panel of one `ResizablePanelGroup`; the side panel is a sibling added/removed, so open/close and 1100 crossings never re-parent the route. | `shell-layout.test.tsx` "across panel open/close at xl and crossing 1100 with a tab open" (same DOM nodes, `scrollTop` kept) |
| 4 | Fixed (adapter replaced) | The interim adapter is deleted; `data/db` runs one snapshot loop per connection that re-passes on a gap found while draining. | `data/db/ipc-collection-options.test.ts` (1c), (1b) |
| 5 | Fixed (adapter replaced) | `data/db` guards every pass by connection (`isCurrent`) and clears `loading` in one `finally` per connection. | same file (5c), (15) |
| 6 | Fixed (adapter replaced) | `awaitEcho` waits for the write's own position; the fallback resync is one started after the timeout. | same file (10b) |
| 7 | Fixed | Where the band forces floating (sessions at 800), the title-bar toggle and ⌘B reveal the floating sidebar (`peek`), move focus in, keep it open while focus is inside, Escape closes and returns focus; `aria-expanded` on the toggle. | `shell-layout.test.tsx` "opens from the keyboard where the band forces floating" |
| 8 | Fixed | Hover timers live in a per-shell `FloatingIntent`; navigation, floating turning off and unmount cancel them. | `shell-layout.test.tsx` "a hover followed at once by navigation never reopens it" |
| 9 | Fixed | The OS reduced-motion rule is scoped `html:not([data-reduce-motion="off"])`. | `transition-types.test.tsx` "the OS rule never applies when prefs say off" |
| 10 | Fixed | Acceptance is fixture-disabled: the Electron suite refuses (rebuilds when required) a fixture build and creates a bot through the mutation harness, then finds it in the renderer's sidebar and collection. | Electron "reads main's real db.*", "a harness-created bot shows in the live sidebar" |
| 11 | Fixed | Harness op `renderer.dropPort` makes main drop the renderer's port (a reconnect from its main frame); one reload and reconnect, then the error screen on a second loss within 10 s, no loop. | Electron "R1-T22"; `mutation-harness.test.ts` "renderer.dropPort" |
| 12 | Fixed | Each transition is recorded on its own with the pseudo elements tokens.css animated; `pane === true` and `sidebar === true` asserted; a `beforeLoad` delay past `pendingMs` shows the pending pane with no transition, then exactly one. | Electron R1-T11b (6 cases) |
| 13 | Fixed | The gate programs collapsed and hover (floating) states, compact density (stored setting, second launch), full screen (harness op) and the 1100 split, asserting geometry before capture; native frame is Linux-only and recorded as n/a on macOS. | `screenshots-gate.test.ts`; the run's `shots.json` |
| 14 | Fixed | The readiness test holds the sessions snapshot, asserts the table is not ready and no call was made, releases, asserts exactly one; a remount of the reporter in the same document reports nothing. | `features/shell/readiness.test.tsx` "waits for the sessions snapshot", "a remount (HMR) … never reports again" |
| 15 | Fixed | PLAN's Motion decision rewritten and amendments added (document transition, adapter replacement, fixture-only limits). | docs |

## Claude r1

| # | Status | Fix | Test |
|---|---|---|---|
| 1 | Fixed | Same as Codex #3. | as Codex #3 |
| 2 | Fixed | The seam is removed; every R1-T11 case runs against the router's `types` callback with a stubbed `startViewTransition`; types are computed from `router.stores.location` (the committing transaction), not `latestLocation`. | `transition-types.test.tsx` (10 cases incl. "types the committing location, not router.latestLocation") |
| 3 | Fixed (decision A) | PLAN/spec amendment; shared elements use CSS `view-transition-name` (`useSharedElementName`); a single-transition guard counts a start inside another's update; R1-T11b asserts 0 with a route mounting a React `<ViewTransition>`. | `single-transition.test.ts`; `shell-a11y.test.tsx` "shared elements"; Electron "never starts two transitions at once" |
| 4 | Fixed (decision B) | `data/db` gets `createDb(transport)`/`installDb`/`DbProvider`; interim adapter deleted; 7 call sites send patches (⌘B `{ sidebar: { pinned } }`); fixture DB is a `LazyTransport` and merges group leaves like main; tests and harness ported. | `data/db/collections.test.tsx` (R1-T3 on the real adapter: patches, explicit same-value choice, lazy insert, ReadOnlyFieldError, pane writer) |
| 5 | Fixed | `dev:next` reads main's `db.*`; `dev:next:fixtures` keeps the fixtures; the memory-source header no longer claims main answers UNAVAILABLE; harness → sidebar and theme → nativeTheme covered. | Electron "a theme written from the renderer reaches main's nativeTheme", live-sidebar case |
| 6 | Fixed | The rail stores `{ pathname, search }` of the shown location (a masked pop-up's background), filed under the area the location itself belongs to, and links with `to` + `search`. | `shell-layout.test.tsx` "is a route location", "remembers the background of a masked pop-up" |
| 7 | Fixed | `db.stop()` aborts every sync through the adapter (`signal`): no reopen, no snapshot, no restart on a new subscriber; a loss before the Toaster mounts renders a static screen. | `bootstrap.test.ts` "stopping the syncs is final"; `shell-a11y.test.tsx` "is mounted with the app" |
| 8 | Fixed | Same as Codex #2. | as Codex #2 |
| 9 | Fixed | `role="list"` removed (`NavList.Rows`); the gate fails on serious/critical axe results. | `shell-a11y.test.tsx` "has no list role over bare links and no critical violation"; `screenshots-gate.test.ts` |
| 10 | Fixed | Contrast: axe now runs after every finite animation ends (the alert dialog was measured mid fade-in; 0 violations settled). `aria-hidden-focus`: any element a modal marks `aria-hidden` while it holds focusables becomes `inert` until the mark goes. `shots.json` records `exitStatus`. | `shell-a11y.test.tsx` "a region a modal hides … becomes inert"; the gate run |
| 11 | Fixed | Base is the merge-base with `main` (`$GITHUB_BASE_REF`/`origin/main` fallbacks); wired into root `check`. The correct base surfaced three deliberate old-renderer edits (`a79707f6`, sign-in with the default browser's sessions), allow-listed pinned to that commit. | `src/main/dev/legacy-diff.test.ts` |
| 12 | Fixed | Same as Codex #12; `skipIf` becomes a failing test under `CI` or `ABACUSBOT_REQUIRE_ELECTRON_SUITES=1`; the suite builds its dist when required. | Electron suite |
| 13 | Fixed | `-old` fades out; groups do not move under reduced motion; `"on"` applies regardless of the OS. | `transition-types.test.tsx` "fades the old snapshot out, never in" |
| 14 | Fixed | The watcher re-queries only for child-list changes that add or remove an occluder; attribute changes re-measure only on or inside a tracked candidate. | `occlusion.test.tsx` "never re-queries the document for style or class flips" |
| 15 | Fixed | Same as Codex #8; the rail rendered alone (gallery) owns and cancels its own timers. | `shell-layout.test.tsx` "a hover pending when the rail unmounts" |
| 16 | Fixed | `useCanGoForward()` tracks the furthest history index (a push truncates). | `shell-layout.test.tsx` "enables Forward only when history has an entry ahead" |
| 17 | Fixed | `pr-[max(var(--titlebar-end),var(--pane-inset))]`. | `geometry.test.ts` (tokens) + visual |
| 18 | Fixed | `features/shell/geometry.ts` holds the widths, tokens.css mirrors them, a test keeps them equal; one motion value drives the column; the strip follows it, pinned content is clipped at 280. | `geometry.test.ts` |
| 19 | Fixed | `lastTabByArea` in the shell store; one `usePanel().toggle` for the button and ⌘⌥B. | `shell-layout.test.tsx` "reopens the area's last tab"; `shell-a11y.test.tsx` "panelToggleTarget" |
| 20 | Fixed | `notFound()` only when the table is `ready` and lacks the row (`isMissing`). | `shell-layout.test.tsx` "a bot route whose table failed to load shows the sidebar's Retry, not Not found" |
| 21 | Fixed | The command dialog mounts its lists (and live queries) only while open. | `shell-layout.test.tsx` "the closed command menu never starts the lazy bots table" |
| 22 | Fixed | A `chrome` notice updates the query without invalidating it; `FORBIDDEN`/`UNAUTHORIZED`/`NOT_FOUND`/`BAD_REQUEST` end a notice stream. | `data/queries/live.test.ts` |
| 23 | Fixed | `AppToaster` places the viewport from `useTitlebarArea()` (toolbar height + 10, clear of the caption buttons) and records that it mounted. | `shell-a11y.test.tsx` "the toast viewport" |
| 24 | Fixed | `PANE_VT` removed from the shell; the gallery keeps its own map for its in-route demo. | knip clean |
| 25 | Follow-up (accepted) | German (and other) new keys are English copies; listed below for translation. | — |

## Visual

| # | Status | Fix | Evidence |
|---|---|---|---|
| V1 | Fixed | On `data-platform` darwin/win32 with `data-titlebar="overlay"` and not `prefers-reduced-transparency`, `html` is transparent and the chrome is `--sidebar` at 35 % over the window's vibrancy/mica (main already sets `vibrancy: "under-window"` / `mica` and a transparent background; no `src/main/index.ts` change needed). | `geometry.test.ts` V1; `os-window-bots-new@1280-{light,dark}.png` (a screen capture of the real window with its traffic lights; `probes.vibrancy` records `html: rgba(0,0,0,0)`) |
| V2 | Fixed | A 1 px border-coloured outline inside the pane and the in-layout panel (a box-shadow was clipped by the resizable panels). | `geometry.test.ts` V2; light captures |
| V3 | Fixed | The resize handle is the 8 px gutter with a 1 px line on hover/focus; 1100 maths: 748 = pane + panel + gutter room. | `geometry.test.ts`; gate `panelSplitProblems` at 1100 |
| V4 | Fixed | No constant status; routes set one with `useTopBarStatusText`. | `shell-layout.test.tsx` "shows no status unless a route sets one" |
| V5 | Fixed | 8 px grid: row pitch 32 (gap 0; compact 24), rail pitch 48 (no gap), sidebar header 40, drawer padding 16, bots strip pitch 64. | `geometry.test.ts`; gate compact check |
| V6 | Fixed | A toothed gear (the canvas's rayed glyph read as brightness) in the rail's duotone style. | `shell-a11y.test.tsx` "the Settings glyph" |
| V7 | Fixed | Canvas `SplitView` tabs: borderless chips at the bar's 28 px control height, active filled, 8 px before the toggle. | `shell-layout.test.tsx` "panel tabs are borderless chips" |
| V8 | Info | — | — |
| V9 | Fixed | `floating@{1280,1100,1000,900}-{light,dark}.png` and `collapsed@…`, geometry asserted (left = rail + 4, width 280, top = toolbar + 4, pane not reflowed). | gate |

## i18n follow-up (Claude #25)

114 of the 128 keys added since `main` in `de-DE.json` are English copies (the same holds for the other nine non-English locales). For translation:

`artifacts.page.emptyTitle`, `artifacts.page.emptyDescription`, `artifacts.sidebar.type`, `artifacts.sidebar.source`, `artifacts.sidebar.all`, `artifacts.sidebar.types.{document,deck,image,code,other}`, `artifacts.sidebar.sources.{bots,sessions}`, `bots.page.{newTitle,newDescription,chatTitle,chatDescription,editTitle,editDescription,detailsTitle,detailsDescription}`, `bots.sidebar.label`, `routines.page.{emptyTitle,emptyDescription,routineTitle,routineDescription,createDescription}`, `routines.sidebar.{paused,empty}`, `sessions.page.{newTitle,newDescription,sessionTitle,sessionDescription,reviewTitle,reviewDescription}`, `sessions.sidebar.{label,new,pinned}`, `shell.appName`, `shell.rail.{label,bots,sessions,library,settings,account}`, `shell.topBar.{back,forward,toggleSidebar,openPanel,closePanel,more,panelTabs,geometryMissing}`, `shell.panel.{label,emptyDescription}`, `shell.panel.tabs.{changes,terminal,files,browser,memory,details,agent}`, `shell.sidebar.{loadError,retry}`, `shell.status.ready` (now unused; kept, phase 1 deletes no keys), `shell.command.{title,placeholder,empty,toggleTheme}`, `shell.command.groups.{areas,settings,bots,sessions,actions}`, `shell.connectionLost`, `shell.boot.{title,description,reload}`, `errors.{genericTitle,genericDescription,reload,notFoundTitle,notFoundDescription,goHome}`, `library.sidebar.label`, `library.pages.{messaging,mcp,skills,tools}`, `library.emptyDescription`, `library.connectorDescription`, `settings.sidebar.{label,personal,app,capabilities,openLibrary}`, `settings.pages.{general,appearance,notifications,memory,account,models,environment,about}`, `settings.emptyDescription`, `settings.theme.{label,description}`, `onboardingFlow.description`, `onboardingFlow.steps.{welcome,connect,connected,models,connectors,first-bot,done}`.

## Limits and notes

- Codex #2 / Claude #8: the `start()` guard lives in `main.tsx`, which boots the real document; jsdom tests cover `bootstrap()` and the bounded report, the Electron suite covers a real boot and the error screen. No unit test drives `main.tsx` itself.
- `data/db`'s `signal` option is new code inside the sub-slice B adapter (renderer-next ownership); B-T1 still passes unchanged.
- The mutation harness's `renderer.dropPort` reaches main's transport through its public `rpc:connect` path (a reconnect from the renderer's main frame closes the active port); `src/main/rpc/**` is untouched.
- `agent-runtime-deps.test.ts` needs `packages/agent` built after `packages/connectors` (its runtime package step); it passes once built in that order.

## r2

Answers `01-renderer-foundation.impl-codex-r2.md` (9 findings). Commits on `rewrite/renderer` after `cd5fbda4`:

- `22cdf69d` boot: `getDb()` inside the failure handling; mount guard re-checked after the dev-hooks import (#1, #2).
- `4f6401b7` shell: occlusion on tracked-overlay ancestors; inert-hidden self match, insertions, late children (#3, #4).
- `1713373f` fixture db header (#9).
- `5c647f68` legacy diff: exported check, temporary-repository tests (#8).
- `abd565e4` R1-T22: one counted reload, first-loss notification, stopped syncs (#7).
- `2f751dcd` screenshot gate: Linux native-frame probe and CI job; collapsed/floating waits and rects (#5, #6).

| # | Status | Fix | Test |
|---|---|---|---|
| 1 | Fixed | `bootstrap()` creates the collections inside the prefs step's `try`: a throwing `getDb()` returns `{ ok: false, step: "prefs", transport }` and reports `failed` (bounded) through the transport that already exists, instead of escaping to `main.tsx`'s catch with no transport. | `lib/bootstrap.test.ts` "a getDb() that throws fails boot and reports failed readiness through the open transport" |
| 2 | Fixed | `mountWhenOpen({ transport, prepare, mount })` (lib/bootstrap) checks the transport before and after the awaited `prepare` (the dev-hooks import) and mounts only if it is still open; `main.tsx` mounts through it, so a loss during the import leaves the connection-lost or error screen in place. | `lib/bootstrap.test.ts` "mountWhenOpen": loss during a held import (first loss: connection-lost screen kept), second loss within 10 s (error screen kept), already closed (no import) |
| 3 | Fixed | An attribute mutation on an ancestor of a tracked overlay (a Base UI positioner's inline transform) re-measures, without a re-query. | `occlusion.test.tsx` "re-measures when an ancestor of a tracked overlay moves it without a resize or scroll" (fails without the fix) |
| 4 | Fixed | A hidden element that is itself focusable becomes inert; the observer also watches `childList` (a subtree inserted already hidden, focusable content arriving in a hidden region) and `href`/`disabled`/`tabindex` (a child becoming focusable). Base UI focus guards (`data-base-ui-focus-guard`, `aria-hidden` and focusable on purpose) are never made inert. | `shell-a11y.test.tsx` "a hidden element that is itself focusable…", "covers subtrees inserted already hidden, and focusable children that arrive later" (axe `aria-hidden-focus` clean; both fail on the r1 code) |
| 5 | Fixed | On Linux the gate launches once per width with `ABACUSBOT_NATIVE_FRAME=1`, asserts `data-titlebar="native-frame"`, `--titlebar-x`/`--titlebar-end`/bar padding 0, no visible overlay, the bar at the top at `--toolbar-h` (40) and full width, `innerWidth` and band, then captures `native-frame-bots-new@<W>-light.png`; a probe that throws fails the run. Elsewhere `probes.nativeFrame` is `"skipped: not linux"`, which fails under `--require-native-frame` / `ABACUSBOT_REQUIRE_NATIVE_FRAME=1`. New CI job `screenshots-next` (ubuntu, xvfb, setuid sandbox helper) runs the gate with the probe required. | `screenshots-gate.test.ts` `nativeFrameStatus`, `nativeFrameProblems`; macOS run records the skip |
| 6 | Fixed | Collapsed: the mode wait's result is kept, sidebar slot and pane rects must hold still (`waitStable`, three equal reads), and `collapsedProblems` fails on a timeout, a column wider than 0, `--sidebar-occupied-w` other than `0px`, a pane not against the rail, or a pane that did not grow from pinned. Floating: its rect and the pane are read once stable; `floatingProblems` compares pane left and width, and fails when unstable. | `screenshots-gate.test.ts` collapsed and floating cases (width-only reflow fails); local run at 1280/900 green |
| 7 | Fixed | R1-T22 enables CDP `Page` and counts top-frame `Page.frameNavigated`: exactly one after the first loss, none after the second. An in-page probe records, when the connection-lost toast appears, the document (`performance.timeOrigin`, the first one) and `__abacusDev.stopped()` (true); it is read back after the reload. Reconnection is asserted (`stopped()` false, prefs `live`). New dev hook `stopped()`. | Electron "R1-T22" |
| 8 | Fixed | `checkLegacyDiff({ cwd, base, allow })` exported; the tests build a temporary repository with the `apps/desktop` layout: diverged `main`/branch (main's later work excluded, merge-base is not HEAD), a component edit and a changed locale value failing, the real allow-list (every entry pinned to `a79707f6`) exempting its files exactly as the sanctioned commit left them and nothing else, and a later edit (uncommitted, then committed) failing. | `legacy-diff.test.ts` (4 new) |
| 9 | Fixed | The `memory-source.ts` header states the fixture-only purpose (gallery and visual screenshot run); acceptance reads main's real `db.*`. | — |

### r2 limits

- The Linux native-frame run and the new CI job have not run here (macOS); the probe's checks are unit-tested and the job is wired. Under xvfb with no window manager there is no system title bar, so the probe asserts the renderer's side (mode, reservations, bar geometry, band), not the WM decoration height (recorded as `frame`).
