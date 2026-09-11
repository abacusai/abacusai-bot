import { windowChromeMetrics } from "../../shared/window-chrome";

// The preload value is authoritative. The fallback only exists for renderer
// tests and for opening the built HTML outside Electron.
const platform =
  window.api?.platform ??
  (navigator.platform.toLowerCase().includes("mac")
    ? "darwin"
    : navigator.platform.toLowerCase().includes("win")
      ? "win32"
      : "linux");
const metrics = windowChromeMetrics(platform);

export const isMacOS = platform === "darwin";
export const isWindows = platform === "win32";

export const TITLEBAR_HEIGHT = metrics.titlebarHeight;
export const TITLEBAR_DEFAULT_START_INSET = metrics.contentStartInset;
export const TITLEBAR_START_INSET = "var(--titlebar-start-inset)";
export const titlebarStartInset = (offset = 0): string =>
  offset === 0
    ? TITLEBAR_START_INSET
    : `calc(${TITLEBAR_START_INSET} + ${offset}px)`;
export const TITLEBAR_CONTENT_END_INSET = isWindows ? 12 : 16;
// Window Controls Overlay exposes the usable title-bar rectangle. Deriving the
// right inset from it keeps content clear of Windows' native minimize,
// maximize/Snap, and close buttons at every display scale. The fallback covers
// renderer tests and older Windows WebView implementations.
export const TITLEBAR_END_INSET = isWindows
  ? "calc(100vw - env(titlebar-area-x, 0px) - env(titlebar-area-width, calc(100vw - 138px)) + 12px)"
  : 16;
export const TITLEBAR_CONTROL_CLEARANCE = 32;
export const TITLEBAR_ICON_SIZE = 14;
