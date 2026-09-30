# Review of a059a113 (Claude/Opus) — verdict NEEDS FIXES

1. High — Linux probe recreate quits the app: `mainWindow.destroy()` (index.ts:796-797) fires `window-all-closed` → `app.quit()` before `createWindow` (awaits electron-store import). Fix: create the replacement before destroying, or a `recreatingMainWindow` flag checked by window-all-closed; extract `recreateMainWindow()`; unit test with fake app+window.
2. Medium — probe false negatives permanently disable overlay on Linux: rAF polling stops when occluded/minimized; `RendererHost.swap()` rejects executeJavaScript → false → `persistLinuxNativeFrame()` forever. Fix: setTimeout polling, probe current webContents, treat rejection/minimized as retry-later, key the persisted flag by Electron version + DE.
3. Medium — macOS density recreate not built: `settings:set-titlebar-density` returns appliesOnRestart but no `recreateMainWindow()` exists. Fix: extract and expose it (shared with 1).
4. Low — `window-chrome-settings.ts:10` `new Store({name:"settings"})` at import time lands in default userData (before app.setPath) and ignores ABACUSAI_BOT_USERDATA; written even in legacy. Fix: `cwd: abacusBotHome()` like workspace-store, or lazy creation.
5. Low — legacy not identical: `subscribeWindowChromeTheme` active in legacy → theme:set applies chrome twice, OS theme changes call setVibrancy/setTitleBarOverlay from main. Fix: subscribe only when RENDERER_GENERATION === "wco".
6. Low — capability state incomplete: mac/win unavailable overlay only console.warn; no event to renderer; legacy `window:chrome` reports native-frame + toolbarHeight 40 while win32 bar is 32. Fix: event + log store; correct legacy values.
7. Low — Linux WCO background `#ffffff/#0a0a0a` vs spec opaque `#2a2a28`-style; host view background not updated on theme change.
8. Low — clipboard: `continue` on empty PNG data instead of returning null; add TIFF (Preview copy) to manual checks.
9. Info — deferred to renderer switch: integration test (all todo), §7 deletions, tokens.css/useTitlebarArea, popup no-drag, browser-view zoom/transition fixes.
