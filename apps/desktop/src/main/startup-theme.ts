import type { PrefsRow } from "@abacus-ai/contract/contract/rows";
/**
 * The theme main applies from `prefs.theme` (spec 00 B.2 side effect; spec 01
 * §7.7 startup theme). Electron-free: `nativeTheme` is passed in.
 *
 * - Startup (wco generation only): before the window exists, set
 *   `nativeTheme.themeSource` from the stored pref, so Chromium's
 *   `prefers-color-scheme` equals the stored choice from the first frame, and
 *   give the window a background in the resolved scheme. `mainWindowOptions`
 *   is the whole of `createWindow`'s option assembly, so it is what the tests
 *   check.
 * - Live: a prefs change of `theme` sets `themeSource` and re-applies the
 *   window chrome, replacing `theme:set` for the new renderer; the window's
 *   and view's background follow (`applyThemedBackground`).
 *
 * The legacy generation is untouched: no theme is applied and the options
 * are what they were.
 */
import type { BaseWindowConstructorOptions } from "electron";

import type { PrefsStore } from "./services/config/prefs-store";
import {
  WINDOW_SURFACE,
  windowChromeOptions,
  type WindowChromeInput,
} from "./window-chrome-options";

export interface ThemeTarget {
  themeSource: PrefsRow["theme"];
  readonly shouldUseDarkColors: boolean;
}

const TRANSPARENT = "#00000000";
/** The legacy Linux backdrop (and the wco overlay's, before the theme). */
const LEGACY_LINUX_BACKGROUND = "#2a2a28";

/** Sets `themeSource` from prefs; true when the resolved scheme is dark. */
export const applyStartupTheme = (
  prefs: Pick<PrefsStore, "get">,
  nativeTheme: ThemeTarget
): boolean => {
  nativeTheme.themeSource = prefs.get().theme;
  return nativeTheme.shouldUseDarkColors;
};

/**
 * The wco window's background: transparent only where vibrancy (macOS) or
 * mica (Windows) paints the backdrop, which reduced transparency turns off;
 * otherwise the resolved scheme's surface. Null for the legacy generation,
 * which keeps its own.
 */
export const themedBackground = (input: WindowChromeInput): string | null => {
  const surface = input.dark ? WINDOW_SURFACE.dark : WINDOW_SURFACE.light;
  if (input.platform === "darwin" || input.platform === "win32")
    return input.reducedTransparency ? surface : TRANSPARENT;
  return surface;
};

/**
 * Everything `new BaseWindow` gets: `base`, then the chrome options, then
 * the background, last, so the chrome's fixed Linux backdrop cannot
 * overwrite the resolved one. In wco the stored theme is applied first, so
 * `chromeInput()` (read after it) sees the stored scheme.
 */
export function mainWindowOptions(options: {
  prefs: Pick<PrefsStore, "get">;
  nativeTheme: ThemeTarget;
  /** Read after the theme is applied. */
  chromeInput: () => WindowChromeInput;
  base: BaseWindowConstructorOptions;
}): BaseWindowConstructorOptions & { backgroundColor: string } {
  applyStartupTheme(options.prefs, options.nativeTheme);
  const input = options.chromeInput();
  const chrome = windowChromeOptions(input);
  const backgroundColor =
    themedBackground(input) ??
    chrome.backgroundColor ??
    (input.platform === "darwin" || input.platform === "win32"
      ? TRANSPARENT
      : LEGACY_LINUX_BACKGROUND);
  return { ...options.base, ...chrome, backgroundColor };
}

/**
 * After the chrome is re-applied (a theme or transparency change), give the
 * window and the renderer's view the themed background, so a reload or a
 * swap candidate paints in the current scheme. No-op for legacy.
 */
export function applyThemedBackground(
  window: { isDestroyed(): boolean; setBackgroundColor(value: string): void },
  input: WindowChromeInput,
  host?: { setBackgroundColor(value: string): void }
): void {
  const background = themedBackground(input);
  if (background == null || window.isDestroyed()) return;
  window.setBackgroundColor(background);
  host?.setBackgroundColor(background);
}

/** Keeps `themeSource` on `prefs.theme`; returns the unsubscribe. */
export const followPrefsTheme = (
  prefs: Pick<PrefsStore, "onChanged">,
  nativeTheme: ThemeTarget,
  refreshChrome: () => void
): (() => void) =>
  prefs.onChanged((row, previous) => {
    if (row.theme === previous.theme) return;
    nativeTheme.themeSource = row.theme;
    refreshChrome();
  });
