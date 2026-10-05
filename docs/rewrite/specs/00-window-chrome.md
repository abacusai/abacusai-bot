# 00 - Electron 44 + Window Controls Overlay everywhere

Status: draft spec (no code). Branch `rewrite/renderer`. Paths are relative to `apps/desktop/` unless noted. Sources: PLAN.md (Decisions > Window chrome L15; Stack > electron L74; Shell > Title bar L250; Native browser view L252), current source, and Electron docs / PRs #41769, #53639, breaking-changes, 44.0 blog (fetched 2026-09-30).

Note: the `to-spec` skill is `disable-model-invocation`, so this follows the repo's spec shape by hand.

## 1. Goal and non-goals

Goal: every platform draws the native window controls itself (traffic lights, caption buttons) inside a renderer-drawn title bar via Window Controls Overlay (WCO). OS, window manager and DE own the geometry; the renderer reads it. No hard-coded insets or heights. `titleBarOverlay.height` is the only number main sets.

Non-goals: custom-drawn caption buttons; Linux Wayland-specific work beyond what Electron ships; a user-facing density setting UI (only the plumbing and default).

## 2. Current state (what gets replaced)

- Main creates a `BaseWindow` (not `BrowserWindow`) at `src/main/index.ts:507`. The renderer is a `WebContentsView` inside it (`src/main/renderer-host.ts:155-170`, fitted to `getContentBounds()`). This matters: until PR #53639, WCO geometry was only forwarded by `BrowserWindow` to its own webContents, so the env vars are empty for our renderer today. This is why every renderer consumer carries a hard-coded fallback.
- Options per platform (`src/main/index.ts:520-549`): macOS `titleBarStyle: "hiddenInset"`, `trafficLightPosition {x:16,y:13}`, vibrancy `under-window` unless `prefersReducedTransparency`; Windows `titleBarStyle: "hidden"` + `titleBarOverlay {color:"#00000000", symbolColor by theme, height:32}` + `backgroundMaterial mica|none`; Linux `frame: true` (native chrome, separate from renderer bar).
- Constants: `src/shared/window-chrome.ts:1-31` (mac 40/84, win 32/16, linux 40/16, `MACOS_TRAFFIC_LIGHT_POSITION`), `src/renderer/lib/window-chrome.ts:1-37` (`TITLEBAR_HEIGHT`, `TITLEBAR_DEFAULT_START_INSET`, `TITLEBAR_START_INSET = var(--titlebar-start-inset)`, `titlebarStartInset()`, `TITLEBAR_CONTENT_END_INSET`, `TITLEBAR_END_INSET` (the only `env(titlebar-area-*)` use, win32 only), `TITLEBAR_CONTROL_CLEARANCE`, `TITLEBAR_ICON_SIZE`, `isMacOS`, `isWindows`).
- CSS vars set in `src/renderer/app.tsx:160-163` (`--workspace-topbar-height`, `--titlebar-start-inset`, with `isMacOS && fullScreen ? 16 : default`); Toaster offset `TITLEBAR_HEIGHT + 10` at `app.tsx:170`.
- Theme change: `theme:set` handler re-applies overlay colours, height and material on Windows only, and vibrancy on macOS (`src/main/index.ts:1121-1141`).
- Fullscreen plumbing: main emits `window:full-screen-changed` (`src/main/index.ts:540-548`), preload `onFullScreenChange` (`src/preload/index.ts:76-83`, `index.d.ts:41`), hook `src/renderer/hooks/use-window-fullscreen.ts`.
- Tests: `src/shared/window-chrome.test.ts` (asserts 40/84, 32/16, 40/16 and the traffic light position). Layout tests touching the bar: `components/layout/focused-tool-layout.test.tsx`, `secondary-sidebar-panel.test.tsx`, `workspace-view.shell.test.tsx`.
- Native browser: `renderer/components/browser/browser-runtime-surface.tsx:87-92,262-268` sends `getBoundingClientRect()` rounded bounds; main clamps them to `window.getContentBounds()` and calls `view.setBounds` (`src/main/services/browser/electron-browser-runtime.ts:89-119,603-627`).
- Electron pinned `43.4.1` (`package.json:104`); `pnpm-workspace.yaml` exempts it from the release-age gate (`minimumReleaseAgeExclude`, ~L64).

## 3. BrowserWindow options per platform

Introduce one pure module `src/main/window-chrome-options.ts` (replaces `src/shared/window-chrome.ts`) exporting `windowChromeOptions({ platform, dark, reducedTransparency, overlayHeight })` returning the constructor fragment, plus `overlayColors(dark)`. Called both at creation and from `theme:set`. It is the unit-test seam.

| Platform | Options |
|---|---|
| macOS | `titleBarStyle: "hidden"`, `titleBarOverlay: { height }`, `vibrancy: "under-window"` + `visualEffectState: "active"` unless `prefersReducedTransparency`. Drop `trafficLightPosition` unless verification (below) shows the lights are not vertically centred in `height`; if kept it is derived from `height` (`y = round((height - 14) / 2)`, `x` = platform default 16), never a literal. |
| Windows | `titleBarStyle: "hidden"`, `titleBarOverlay: { color: "#00000000", symbolColor, height }`, `backgroundMaterial: "mica"` (`"none"` when reduced transparency). |
| Linux | `titleBarStyle: "hidden"`, `titleBarOverlay: { color, symbolColor, height }` (Linux honours `color`/`symbolColor`/`height`; see PR #41769, X11 first, 43 made WCO follow native button layout). `backgroundColor` stays opaque `#2a2a28`-style (no vibrancy/material on Linux). Drop `frame: true`. |

Keep as today: `backgroundColor` transparent on mac/win, opaque on Linux (`index.ts:487-492`); `autoHideMenuBar`; min size 800x600.

`color` is `"#00000000"` on Windows so mica/the title bar shows through. On Linux use the theme's title bar surface colour (opaque) because no material paints behind the buttons; take it from the same token the CSS uses (`--background` resolved value), passed as a constant pair `{light, dark}` in the options module with a comment tying it to `tokens.css`.

Because the renderer is a `WebContentsView` in a `BaseWindow`, WCO relies on #53639 (see 8). Do not migrate to `BrowserWindow` in this slice.

### Linux native-frame fallback and startup capability probe (review 4, 12)

`titleBarStyle: "hidden"` actively removes the normal title bar; missing overlay geometry does not prove the compositor restored native controls. So the hidden-titlebar path on Linux is opt-in by a verified probe, not the default assumption:

1. Decision table (`linuxChromeMode(env)` in the options module, pure): `overlay` is chosen only when the session type / DE combination is on an allow-list verified in the acceptance matrix (initially X11 sessions on GNOME, KDE, Xfce, Cinnamon; Wayland enters the list only after it passes 12). Everything else (unknown DE, Wayland until verified, `ELECTRON_OZONE_PLATFORM_HINT` overrides, an env override `ABACUSBOT_NATIVE_FRAME=1`) gets `frame: true` with the normal system title bar and the app's own bar drawn below it (`overlay` capability state `native-frame`).
2. Post-show probe: after `ready-to-show`, main asks the renderer for `navigator.windowControlsOverlay.visible` and `getTitlebarAreaRect()` (via a one-shot `webContents.executeJavaScript` on the RendererHost view, no new IPC surface). If `overlay` mode was chosen but `visible === false` or the rect is empty/full-width on a non-fullscreen window within 1.5 s of first paint, main recreates the window with `frame: true` (state, bounds and renderer route preserved through the existing window-state store) and persists `linuxChromeMode: "native-frame"` so the next start skips the overlay. The failed probe is logged with session type, DE and Electron version.
3. Verified native-frame requirements (acceptance, per configuration): close, minimize (where the WM offers it), maximize/restore, move by dragging, resize edges, Alt-drag/double-click title behaviour. These are the gate to enable `overlay` mode for any DE; each cell of the matrix in 12 must pass before its DE joins the allow-list.
4. The renderer never guesses: main exposes the resolved mode as a capability state (see 6, "Capability state") through an oRPC procedure `window.chrome` (`{ mode: "overlay" | "native-frame", fullScreen: boolean }`), and the renderer writes `data-titlebar="overlay|native-frame"` on `<html>`.

## 4. Choosing `titleBarOverlay.height`

- One integer. Source: `settings.titlebarDensity` in the existing electron-store (`"comfortable"` default, `"compact"`), mapped in the options module to 40 and 32. Default 40 on every platform. Clamp to [28, 64].
- Read once at window creation, before `new BaseWindow`.
- Runtime change, per platform (review 1). `BaseWindow.setTitleBarOverlay` is declared `@platform win32,linux` in `node_modules/electron/electron.d.ts:3539-3541` (and in the API docs); there is no macOS runtime setter, so the earlier claim is withdrawn.
  - Windows and Linux: `settings.setTitlebarDensity` stores the value and calls `win.setTitleBarOverlay({ height, color, symbolColor })`.
  - macOS: the density change is applied on the next window creation. The settings procedure stores the value and the UI says "applies after restarting the window"; main then offers `recreateMainWindow()` (same code path as the Linux probe recreate, state preserved). Decision: macOS density is restart-applied, not live. The renderer's app toolbar height (`--toolbar-h`, see 6) still updates immediately on all platforms, so on macOS the toolbar and the traffic-light cluster centre may be briefly mismatched until recreation; acceptable and documented.
  - The options module exposes `canSetOverlayLive(platform)`; the test asserts it is true for win32/linux and false for darwin, and a guard test checks the code never calls `setTitleBarOverlay` on darwin.
- Do NOT unset `height` ("system height"): per-DE system heights make a single-bar layout unpredictable.

## 5. Theme changes

`theme:set` (`index.ts:1121`) becomes: set `nativeTheme.themeSource`; then on win32 and linux (overlay mode only) call `setTitleBarOverlay({ color, symbolColor, height })` with the height taken from the current stored density (never from a constant, so a theme change after selecting compact does not reset height); keep `setBackgroundMaterial` (win32) and `setVibrancy` (darwin).

Correction (review 13): system theme changes do reach main today, through the renderer: `src/renderer/hooks/use-theme.ts:59-66` subscribes to system colour scheme changes and calls `window.api.setThemeSource(theme)` whenever `effectiveTheme` changes, which runs the existing handler. So this is not a latent bug. The new main-side `nativeTheme.on("updated")` subscription exists to remove reliance on the renderer (headless/relaunch, renderer swap in progress, the future web mode where the renderer is not the source of truth). Extract into one `applyWindowChrome(win)` used by creation, `theme:set` and `updated`; debounce to one call per tick; also react to `prefersReducedTransparency` there.

Tests (added to section 10): explicit theme change and system theme change (`nativeTheme "updated"` with `themeSource: "system"`) after selecting compact density update `symbolColor`/`color` and keep `height === 32`.

## 6. Renderer layout contract

Single source: CSS custom properties defined once in `src/renderer/lib/tokens.css` (new file per PLAN) on `:root`:

- `--titlebar-x: env(titlebar-area-x, 0px)`
- `--titlebar-end: calc(100vw - env(titlebar-area-x, 0px) - env(titlebar-area-width, 100vw))` (space the native buttons occupy on the right)
- `--toolbar-h`: density-driven app toolbar height (default 40px), see below; independent of the env vars.

The 0px/100vw fallbacks apply when env vars are absent (tests, built HTML outside Electron, native-frame, fullscreen); they are correct there because no controls overlap the bar.

Rules:
1. The title bar element: `height: var(--toolbar-h)`, `padding-left: var(--titlebar-x)`, `padding-right: var(--titlebar-end)`, `app-region: drag`. Content lives between. On macOS `--titlebar-x` is the traffic-light cluster; on Windows/Linux-with-buttons `--titlebar-end` is the caption buttons; both are handled by the same two vars with no `isMacOS`/`isWindows` branches.
2. Interactive children of the bar: `app-region: no-drag`; portaled overlays are covered by the rule below. Use the standard `app-region` property (not `-webkit-app-region`); provide utility classes `titlebar-drag` / `titlebar-nodrag` in `tokens.css`. Drop the `WebkitAppRegion` inline-style casts (~14 sites, see 7).
3. Native button rectangle itself is never drag and never receives our clicks; do not draw under it (padding above guarantees this).
4. Pinned sidebar column: its top segment is the title bar's left part; it starts at 0 and reserves `--titlebar-x` only while the bar is the leftmost element (i.e. when the sidebar is pinned on mac the app name sits right of the lights; when floating, the toggle sits right of the lights). Layout must not assume 84px.
6. Linux/SSD or native-frame mode: see section 3 fallback; controls are the WM's and the app bar sits below them.
5. JS consumers (Toaster offset, tour stops, floating overlays needing the bar height): `lib/window-chrome.ts` shrinks to a hook `useTitlebarArea()` built on `navigator.windowControlsOverlay?.getTitlebarAreaRect()` and the `geometrychange` event, returning `{ x, end, toolbarHeight, overlayVisible }` (see "Native overlay geometry vs app toolbar height"); fallback `{0,0,densityHeight,false}` when the API is undefined or `visible` is false. It writes nothing to CSS and exists only for JS-side math. Toaster: `offset={{ top: toolbarHeight + 10 }}`.
6. Notch window is excluded: the notch overlay window (`node-mac-notch`, PLAN L313) is a separate window; it must not import or use any of this, and must not be created with `titleBarOverlay`.
7. Never read overlay geometry from `window.api` or an oRPC procedure. Platform facts remain available through procedures only for non-geometry needs (keyboard shortcut labels, `isMacOS` in `terminal-keys.ts:8`), which keeps `isMacOS` in a smaller `lib/platform.ts`.

### Native overlay geometry vs app toolbar height (review 2)

These are two different things and must not share one variable:
- Native overlay geometry: what Electron reports (`env(titlebar-area-*)`, `getTitlebarAreaRect()`, `visible`). It is only valid while `visible === true`.
- App toolbar height: what the app wants its bar to be. Single source `--toolbar-h`, set once on `<html>` from the density value (`comfortable` 40, `compact` 32; delivered through the same `window.chrome` procedure plus a `density` field, defaulted from CSS as 40px). It never depends on the env vars.

So the earlier `--titlebar-h: env(titlebar-area-height, 40px)` is replaced. Revised vars:
- `--toolbar-h`: app toolbar height (density).
- `--titlebar-x: env(titlebar-area-x, 0px)` and `--titlebar-end: calc(100vw - env(titlebar-area-x, 0px) - env(titlebar-area-width, 100vw))`: native controls' horizontal reservations only.
- `--titlebar-y` is dropped (unused).

Hidden-overlay behaviour (macOS fullscreen, Linux/other native-frame, any `visible=false`): Electron 44 disables WCO in macOS fullscreen and returns an empty rect, and Chromium removes the env vars, so CSS falls back to `0px`/`100vw` reservations while the toolbar height stays `--toolbar-h`. Both CSS and JS therefore agree: reservations 0, height `--toolbar-h` (compact stays 32 in fullscreen). `useTitlebarArea()` returns `{ x, end, height: toolbarHeight, overlayVisible }`, where `height` is never taken from a zero-height rect; when `visible === false` it returns `x=0, end=0`. Toaster offset uses `toolbarHeight + 10` so it never overlaps the toolbar in fullscreen.

### Capability state (review 12)

State machine, not CSS feature detection: `overlay` (WCO requested and `visible === true`), `overlay-pending` (requested, first geometry not seen yet, first 1.5 s), `native-frame` (no overlay by design or after failed probe), `overlay-unavailable` (requested, CSS parses `env()` but `visible === false` while not fullscreen, e.g. #53639 forwarding missing or clipped). `overlay-unavailable` triggers the section 3 recreate-with-native-frame path on Linux; on macOS/Windows it is treated as a release-blocking defect and reported through the log store plus a dev-mode banner (the fallback CSS stays valid: 0 reservations, `--toolbar-h`), and the release gate is that the integration test in 10 passes. No `@supports` fallback is used anywhere (it only tests syntax and never activates in this failure).

### Popups over the title bar (review 8)

`app-region: drag` regions swallow pointer events regardless of DOM stacking. Every portaled surface can overlap the bar: dialog, alert-dialog, sheet, popover, dropdown/context/menubar menus, select, combobox, hover-card, tooltip, command dialog, drawer, toast viewport, and their backdrops (`*-overlay`). Contract:
- `tokens.css` defines one rule `[data-slot$="-content"], [data-slot$="-overlay"], [data-slot="toast-viewport"], [data-slot="drawer-popup"] { app-region: no-drag; }` (the explicit list from PLAN L252, not the broad suffix match: implement as the enumerated selector list, sharing the list with the occlusion watcher and its registry test), so the fix lives in the atom layer, not per call site.
- `WindowDragRegion` on `_bare` routes is `z-10` below overlay layers, but no-drag must still win: covered by the same selector list.
- Tests: in the Electron integration test (10), open a popover and a dialog positioned over the bar (and on a `_bare` route), click inside and on the backdrop, and assert it dismisses; unit test asserts the selector list equals the registry-derived list.

### Edge cases

- Linux DE with server-side decorations or a WM that does not accept the overlay: we cannot assume the compositor restored native controls when `hidden` was requested. Handled by the section 3 allow-list, probe and `frame: true` recreate. The renderer only sees `native-frame` and reserves nothing. (Detecting by DE name is done in main, in the pure allow-list function, not in the renderer.)
- macOS fullscreen: traffic lights hidden; Electron 44 disables WCO for the window (empty rect, `visible=false`) and Chromium drops the env vars, so reservations fall to 0 through the CSS fallbacks while `--toolbar-h` is unchanged (see hidden-overlay behaviour above). Entry and exit fire `geometrychange`. Delete `useWindowFullScreen`'s use in the title bar. Keep the fullscreen plumbing only if some non-bar feature needs it; otherwise delete the whole set listed in 7 (initial-state query and event subscription both).
- macOS with WCO in the renderer's `WebContentsView` and hidden views not intersecting the bar: they see `visible === false` and an empty rect (#53639); any tab that draws its own toolbar must tolerate that.
- Maximized/snapped Windows: geometry event fires; the bar reflows.
- RTL locales: env vars are physical; use `padding-left`/`-right` from vars, not logical properties, until verified (spec says the rect flips in RTL; verify on Windows).
- High zoom: env vars are in CSS px and already scaled.

## 7. Deletion list (each with every consumer)

Delete `src/shared/window-chrome.ts` and `src/shared/window-chrome.test.ts` (replaced by main module + tests below). Then remove:

| Symbol | Consumers to change |
|---|---|
| `windowChromeMetrics`, `MACOS_TRAFFIC_LIGHT_POSITION` | `src/main/index.ts:85-86,484,510,1131` |
| `TITLEBAR_HEIGHT` | `app.tsx:25,160,170`; `components/layout/titlebar.tsx:13,327`; |
| `TITLEBAR_DEFAULT_START_INSET`, `--titlebar-start-inset`, `isMacOS && fullScreen` branch | `app.tsx:24,161-163` |
| `TITLEBAR_START_INSET`, `titlebarStartInset()` | `titlebar.tsx:14,15,106,326`; `workspace-sidebar.tsx:8,76`; `focused-tool-layout.tsx:4,59,90`; `focused-titlebar.tsx:6,29` |
| `TITLEBAR_END_INSET`, `TITLEBAR_CONTENT_END_INSET` | `titlebar.tsx:11,12,108-109`; `secondary-sidebar-panel.tsx:28,418`; `focused-titlebar.tsx:5,44` |
| `TITLEBAR_CONTROL_CLEARANCE`, `TITLEBAR_ICON_SIZE` | grep first; move icon size to the TopBar component if still used |
| `--workspace-topbar-height` (CSS var and `h-(--workspace-topbar-height)` classes, replaced by `--toolbar-h`) | `titlebar.tsx:97`; `workspace-sidebar.tsx:73`; `secondary-sidebar-panel.tsx:415`; `focused-titlebar.tsx:37`; `focused-tool-layout.tsx:56`; `window-drag-region.tsx:9`; `onboarding-flow.tsx:232` (`pt-[max(3rem,var(--workspace-topbar-height))]`) -> `--toolbar-h` |
| `isWindows` | only in `lib/window-chrome.ts`; delete |
| `WebkitAppRegion` inline styles | `titlebar.tsx:98,124,146,266,325`; `secondary-sidebar-panel.tsx:419,428,456`; `window-drag-region.tsx:10`; `focused-tool-layout.tsx:60,70,95`; `workspace-sidebar.tsx:77,96,107`; `focused-titlebar.tsx:38,56,73` -> utility classes |
| Fullscreen plumbing (both halves): `isFullScreen()` query and `onFullScreenChange` subscription | `preload/index.ts:74-83`; `preload/index.d.ts:40-41`; `main/index.ts:540-548` (event emit) and `main/index.ts:1099` (`window:is-full-screen` handler); `hooks/use-window-fullscreen.ts` and its consumers (`app.tsx`) |
| `WindowDragRegion` | keep as a component for `_bare` routes (onboarding, `__ui`) but size it with `--toolbar-h` and use the class |

Since the shell is being rewritten (PLAN Shell), most of these files are replaced; the deletion is completed when `grep -rn "TITLEBAR_\|workspace-topbar-height\|titlebar-start-inset\|WebkitAppRegion\|windowChromeMetrics\|isFullScreen\|onFullScreenChange\|window:is-full-screen\|window:full-screen-changed\|useWindowFullScreen"` over `apps/desktop/src` returns nothing.

## 8. Native browser WebContentsView

Not affected by overlay geometry, but the earlier "needs nothing" conclusion was wrong in two respects (reviews 6, 7). What is unchanged: bounds come from the DOM rect (`browser-runtime-surface.tsx:87-92`), are clamped in main against `getContentBounds()` (`electron-browser-runtime.ts:89-119`), and browser views sit strictly below the bar. Electron 44 (#53639, backport #53812) additionally forwards the overlay rect (local coordinates, clipped, `visible=false` when not intersecting) to every `WebContentsView`, so pages in browser views see consistent values; nothing to write for that.

Required changes:
1. Zoom conversion (review 6). `roundedBounds()` sends CSS pixels; `view.setBounds` uses DIPs. They differ whenever the presenting renderer's zoom factor is not 1 (user zoom, `Ctrl +/-`). Convert before rounding and clamping: multiply the rect by the renderer's `webFrame.getZoomFactor()` (exposed from preload as a sync value, or read in main via `event.sender.getZoomFactor()` when handling `presentBrowserRuntime`; decision: main-side, so conversion is authoritative and the renderer sends CSS pixels plus nothing else). Display scale is unaffected (DIP handles it). Alternative explicitly rejected: forcing zoom 1 (would break accessibility zoom).
2. Movement without resize (review 7). The surface observes size, window resize and scroll only. The rewritten shell animates sidebars/panels with translation, which changes position but not size. Add: (a) a `transitionstart`/`transitionrun` + `animationstart` listener on ancestors up to the shell root that marks the surface `moving` and immediately hides the native view (`hideBrowserRuntime`), (b) on `transitionend`/`animationend`/`cancel` (plus a 600 ms safety timer, longer than the 420 ms shared-element duration) re-measure and present; (c) a `requestAnimationFrame` position poll while `moving` is not used. Because the occlusion watcher (PLAN L252) already hides native surfaces under overlays, reuse its "occluded" channel rather than adding a second one, and respect `data-starting-style`/`data-ending-style`.

Also confirm the renderer view spans the full content area at y=0 (`renderer-host.ts:166-170`); otherwise the forwarded rect is clipped.

Tests: main unit test for zoom conversion (zoom 0.8, 1, 1.5, 2 with a fake sender, separate from display scale); renderer test that a translation-only move (transform transition) hides then re-presents with the new position; Electron integration test asserts native input at the view's corners lands in the page after a sidebar toggle at zoom 1.25.

Hard requirement: the upgrade lands on a 44.x containing the #53812 backport (verify in that release's notes); the renderer host view itself is its main beneficiary, tested in section 10.

## 9. Electron 43.4.1 -> 44.4.x upgrade checklist

Stack facts (release notes): Chromium 152, V8 15.2, Node 24.18.1 (44.0). Minimum OS: macOS 13+.

1. Bump `package.json:104` to the exact 44.4.x that includes the #53812 backport; update `minimumReleaseAgeExclude` in `pnpm-workspace.yaml` (replace `electron@43.4.1` with the new exact version); `pnpm install`.
2. Breaking changes (44) checked against the repo:
   - Clipboard rearchitected to the W3C model. `clipboard.readImage()` is REMOVED in 44 (43.4.1's `electron.d.ts` still returns `NativeImage`, so the type-checker will not warn until the bump). Our only use is the `read-clipboard-image` handler (`src/main/index.ts:1514-1531`), which swallows errors and returns null, so the failure would silently disable "Paste image". Rewrite it: `const items = await clipboard.read()`, pick the first item whose `types` contains an `image/*` type (prefer `image/png`), `const blob = await item.getType(type)`, `Buffer.from(await blob.arrayBuffer())`, convert to PNG through `nativeImage.createFromBuffer(...).toPNG()` when the type is not PNG, keep the return contract `{ name, data, mimeType: "image/png" } | null`, and log (not swallow) unexpected errors. Tests in `src/main` with a faked `clipboard.read`: image clipboard, empty clipboard, text-only clipboard, non-PNG image, and a rejecting `getType`. Preload does not import `clipboard`; renderer uses `navigator.clipboard`.
   - `net.request` rejects frame destinations without `Sec-Fetch-Mode: navigate`: our use is the spellcheck dictionary download (`src/main/spellcheck-dictionary.ts:23`), not a frame; verify.
   - macOS 12 dropped: update README/site requirements and `electron-builder.yml` mac `minimumSystemVersion` if set (none found by grep; add `13.0`).
   - win32-ia32 and linux-armv7l dropped: confirm no build targets use them (electron-builder.yml `win:`/`linux:` target lists, CI matrix under `.github`); grep found none.
   - `app.isUnityRunning()` removed; `openAsHidden`/`wasOpenedAsHidden`/`restoreState` login item props removed: grep found no usage; re-grep before merging.
   - ANGLE statically linked: nothing in `asarUnpack`/`extraResources` should reference `libEGL`/`libGLESv2`; check packaged-resources script `scripts/check-packaged-resources.js`.
   - 43 changes already in effect on the current base and worth re-testing here: frameless windows get rounded corners on Linux; WCO follows native layout on Linux (this is what makes item 3's Linux path viable); `NativeImage.toBitmap()` colour space; dialogs default to Downloads.
3. Native deps / ABI: `@lydell/node-pty@1.2.0-beta.15` (`apps/desktop/package.json:58`), `@ff-labs/fff-node` via `ffi-rs`, and the ast-grep parser ship prebuilt N-API bindings and `npmRebuild: false` (`electron-builder.yml:108-110`), so the Node 24.17 -> 24.18 patch is ABI-neutral; N-API is stable across Node majors. Run `pnpm why @lydell/node-pty ffi-rs @ff-labs/fff-node @anthropic-ai/sandbox-runtime ghostty-web` and confirm each resolves to a single version and that none pulls a non-N-API addon (`nan`, `node-gyp-build` that compiles against V8). `@anthropic-ai/sandbox-runtime@0.0.76` (`packages/agent/package.json:52`) runs in the spawned agent process (not Electron main); confirm which Node runs the agent (Electron-as-node vs system node) since Electron Node moves to 24.18.1. `ghostty-web@0.4.0` is a WASM/JS bundle with `patches/ghostty-web@0.4.0.patch` (`pnpm-workspace.yaml:71`); it is renderer-side, so retest under Chromium 152 (`main/ghostty-scrollback.browser.test.ts`) and confirm the patch still applies (unchanged version, so it will).
4. electron-builder `^26.15.3`: confirm it resolves Electron 44 headers and prebuilt zip (`electronVersion` is inferred; no `electronDist` override found). No fuses config found in `electron-builder.yml`, `package.json` or `scripts/` (grep negative); if `@electron/fuses`/`electronFuses` is added elsewhere, no fuse semantics changed in 44. Confirm `asarUnpack` globs unchanged and smoke-test `pnpm package:dir` on all three OSs.
5. Full test pass (`vitest`, `main/packaged-startup.test.ts`, `renderer-host.test.ts`, browser runtime tests), then a manual pass on real macOS 13+, Windows 11, and one X11 Linux DE plus one GNOME/Wayland.

## 10. Tests

Main unit (`src/main/window-chrome-options.test.ts`, vitest `main` project, no Electron import):
- `windowChromeOptions` for `darwin`: `titleBarStyle "hidden"`, `titleBarOverlay.height === H`, `vibrancy "under-window"`; with reduced transparency no `vibrancy`; no `frame`.
- `win32`: overlay `{color:"#00000000", symbolColor dark|light, height:H}`, `backgroundMaterial mica|none`.
- `linux` in `overlay` mode: `titleBarStyle "hidden"`, colours differ by theme, opaque `backgroundColor`, no `vibrancy`/`backgroundMaterial`; in `native-frame` mode `frame: true` and no overlay; `linuxChromeMode(env)` table (GNOME/X11, KDE/X11, Wayland, unknown DE, env override).
- `H` from density: 40, 32, clamped. `canSetOverlayLive`: true on win32/linux, false on darwin; a guard test that `applyWindowChrome` never calls `setTitleBarOverlay` on a darwin fake.
- `applyWindowChrome`: theme changes (explicit and `nativeTheme "updated"`) after compact density keep `height 32` and update colours; darwin calls `setVibrancy` only.
- Clipboard handler tests from section 9.
- Zoom conversion tests from section 8.

Renderer unit (jsdom `renderer` project, `src/renderer/lib/`):
- `useTitlebarArea`: stub `navigator.windowControlsOverlay`; assert initial value, update on `geometrychange`, fallback when undefined, and that `visible=false` with a zero-height rect returns the density toolbar height (fullscreen case, comfortable and compact) and 0 reservations.
- Guard test failing if `TITLEBAR_`, `workspace-topbar-height` or `WebkitAppRegion` reappear under `src/renderer`, and the selector-list test for no-drag popups (section 6).
- Browser surface test: translation-only movement hides then re-presents.
- Update `focused-tool-layout.test.tsx`, `secondary-sidebar-panel.test.tsx`, `workspace-view.shell.test.tsx`.

jsdom does not implement `env()`, so computed-layout assertions live only in the Electron integration test below. There is no vitest browser project in the repo (`vitest.config.ts:62` projects: renderer jsdom, main, main-serial, preload, ...); this spec does not add one. It uses the existing pattern of a Node test that spawns Electron (`src/main/ghostty-scrollback.browser.test.ts`), registered in `CONTENDS_FOR_THE_MACHINE` so it runs in `main-serial`.

Electron integration (`src/main/window-chrome.electron.test.ts`, spawns Electron through the same harness as `ghostty-scrollback.browser.test.ts`, one per OS in CI where a display exists; skipped on headless Linux without xvfb):
- Builds a real `BaseWindow` with `windowChromeOptions` and a `RendererHost` (`src/main/renderer-host.ts`) loading a fixture page that reports `navigator.windowControlsOverlay.getTitlebarAreaRect()`, `.visible`, computed `padding-left/right` of the fixture bar, and `getComputedStyle` of `--titlebar-x/--titlebar-end`.
- Cases: initial load (API rect equals env-derived CSS, `visible` true on mac/win/overlay-Linux, bar padding clears the native button rect: `bar.paddingRight >= window.innerWidth - (rect.x + rect.width)` and left clearance on macOS); window resize; entering and leaving fullscreen (macOS: `visible=false`, empty rect, reservations 0, `--toolbar-h` unchanged, then restored); `RendererHost.swap()` (the new view has correct geometry before it is flipped in and after); a popover/dialog positioned over the bar (and on a `_bare` route) can be clicked and dismissed; browser view at zoom 1.25 aligned after a sidebar toggle; Linux `native-frame` fallback path and the "CSS supports `env()`, native controls exist, geometry unavailable" state (forced by a test hook that swallows the forwarding) reach `overlay-unavailable` and trigger recreation.

## 11. Rollout order (review 5)

Native options and renderer geometry consumers ship together. Today `TITLEBAR_END_INSET` only branches on Windows (16px on Linux) and native Windows height is 32px vs a would-be 40px, so enabling overlay/height changes natively before the renderer migration would put content under Linux caption buttons and misalign Windows.

1. Bump Electron, fix breaking changes (clipboard handler included), keep the old chrome and heights unchanged (green, shippable).
2. Single change set: `window-chrome-options.ts`, `applyWindowChrome`, Linux probe/fallback, `tokens.css` vars, `useTitlebarArea`, migration of every consumer in 7 and deletion of the old constants, popup no-drag rule, browser zoom/transition fixes, integration test. Not shippable in halves.
3. Density setting plumbing (default only in this slice).

If step 2 must land before the shell rewrite, it is done against the current layout components (they take the vars), not skipped.

## 12. Acceptance checklist

- [ ] `electron` resolves to a 44.4.x containing #53812; `pnpm why` shows no duplicate/incompatible native dependency.
- [ ] macOS 13+: traffic lights appear inside a 40px bar, vertically centred; bar content starts to their right without a literal inset; vibrancy intact; entering fullscreen removes the left gap with no JS (overlay disabled, toolbar height unchanged); leaving restores it.
- [ ] Windows 11: caption buttons and Snap layouts work; bar height equals overlay height; theme switch (explicit and system) recolours symbols live; mica retained.
- [ ] Linux X11 (GNOME/KDE with CSD-capable WM): buttons rendered inside the bar, colours follow theme, `visible === true`.
- [ ] Linux native-frame fallback: on each allow-list candidate configuration and on SSD and Wayland, the fallback (`frame: true`) provides working close, minimize (where offered), maximize/restore, window move and resize; the overlay path is enabled for a DE only after this and the overlay checks both pass.
- [ ] Startup probe: forcing missing geometry triggers recreation into native-frame and persists the choice.
- [ ] Compact density: comfortable and compact both keep toolbar height in fullscreen, Toaster clears the toolbar; macOS density applies on window recreation.
- [ ] Clipboard "Paste image" works with image, empty and text clipboards on 44, including TIFF copied from macOS Preview.
- [ ] Popups/dialogs over the bar are clickable and dismissable, including on `_bare` routes.
- [ ] Browser view aligned at non-1 zoom and after translation-only transitions.
- [ ] Electron integration test passes on macOS, Windows and Linux CI.
- [ ] `navigator.windowControlsOverlay.getTitlebarAreaRect()` matches the env vars; `geometrychange` fires on maximize, fullscreen, density change.
- [ ] Native browser tab: bounds unchanged from today; no overlap with the bar; input at the top edge of the browser view not eaten by a drag region.
- [ ] The grep in section 7 (including fullscreen names and channels) returns nothing; `src/shared/window-chrome*.ts` gone.
- [ ] New main and renderer tests pass; existing suites pass.
- [ ] `pnpm package:dir` boots on all three OSs; `check-packaged-resources.js` passes.

## 13. Risks

- Backport not in the first 44.4.x, or forwarding otherwise failing: the renderer `WebContentsView` sees no geometry. There is no CSS-only fallback (an `@supports` test on `env()` only checks syntax and never fires here). Mitigation: verified forwarding is a release gate (integration test), plus the explicit `overlay-unavailable` capability state; on Linux it recreates with a native frame, on macOS/Windows it blocks release.
- macOS traffic-light vertical centring with `hidden` + `titleBarOverlay.height` is unverified; `trafficLightPosition` may still be required. Verify on 13, 14, 15, and the current OS.
- Linux: `hidden` may remove native controls with no replacement on unsupported compositors; hence the allow-list and probe. WCO on Wayland was deferred in #41769; GNOME versions differ; hidden maximize/minimize buttons are not honoured on some distros (Fedora report). Windows/Linux `height` differences in caption buttons may look uneven at 32.
- BaseWindow + WebContentsView is a less-travelled path for WCO than BrowserWindow; watch for the rect being clipped if the view does not start at y=0, and for the parked/hidden browser views reporting `visible=false`.
- `nativeTheme "updated"` subscription can fire in bursts; debounce to one `setTitleBarOverlay` per tick.
- `app-region: drag` over WebContentsView boundaries: drag regions only work within the view that declares them; a browser view overlapping the top edge would swallow drags. Keep browser views strictly below the bar.
- Density setting scope creep: ship only the default in this slice.
- macOS 12 users drop off the supported list at this bump; announce in release notes.

## Review responses

Source: `docs/rewrite/specs/reviews/00-window-chrome.codex-r1.md`. All 13 findings accepted; each was checked against the repo and the installed `node_modules/electron/electron.d.ts` (43.4.1) where checkable.

1. Accepted, verified: `setTitleBarOverlay` is `win32,linux` only (`electron.d.ts:3539-3541`). Section 4 rewritten: macOS density is applied on window recreation.
2. Accepted: section 6 splits native overlay geometry from `--toolbar-h`; fullscreen/hidden-overlay behaviour defined; tests added.
3. Accepted: section 9 rewrites the handler around `clipboard.read()`.
4. Accepted: section 3 adds allow-list, probe, and native-frame fallback; acceptance gates enabling overlay per DE.
5. Accepted: section 11 ships native options and renderer consumers together.
6. Accepted: section 8 adds main-side zoom conversion (verified `roundedBounds()` sends CSS px at `browser-runtime-surface.tsx:87-92`).
7. Accepted: section 8 hides the view during transitions.
8. Accepted: section 6 adds the enumerated no-drag rule for portaled overlays.
9. Accepted, verified `vitest.config.ts` has no browser project: layout assertions moved to an Electron integration test using the existing Node-spawns-Electron pattern; no new vitest project is added.
10. Accepted: Electron integration test through `BaseWindow`/`RendererHost` including `swap()`, resize, fullscreen.
11. Accepted, verified `isFullScreen` at `preload/index.ts:74`, `index.d.ts:40`, `main/index.ts:1099`: added to the deletion table and grep.
12. Accepted: `@supports` fallback removed; explicit capability state replaces it.
13. Accepted with a wording change: verified `use-theme.ts:59-66` calls `setThemeSource` on effective-theme change, so the claim of a latent bug is withdrawn; the main-side subscription is justified as removing reliance on the renderer. Tests for explicit and system changes after compact density added.
