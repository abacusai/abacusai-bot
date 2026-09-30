/**
 * The theme main applies from `prefs.theme` (spec 00 B.2 side effect; spec 01
 * §7.7 startup theme). Electron-free: `nativeTheme` is passed in.
 *
 * - Startup (wco generation only): before the window exists, set
 *   `nativeTheme.themeSource` from the stored pref, so Chromium's
 *   `prefers-color-scheme` equals the stored choice from the first frame, and
 *   give the window an opaque background in the resolved scheme.
 * - Live: a prefs change of `theme` sets `themeSource` and re-applies the
 *   window chrome, replacing `theme:set` for the new renderer.
 */
import type { PrefsRow } from "#shared/contract/rows";

import type { PrefsStore } from "./services/config/prefs-store";
import { WINDOW_SURFACE } from "./window-chrome-options";

export interface ThemeTarget {
  themeSource: PrefsRow["theme"];
  readonly shouldUseDarkColors: boolean;
}

const TRANSPARENT = "#00000000";

/** Sets `themeSource` from prefs; true when the resolved scheme is dark. */
export const applyStartupTheme = (
  prefs: Pick<PrefsStore, "get">,
  nativeTheme: ThemeTarget
): boolean => {
  nativeTheme.themeSource = prefs.get().theme;
  return nativeTheme.shouldUseDarkColors;
};

/**
 * The window's first background: a transparent one stays (vibrancy and mica
 * paint the backdrop); an opaque one takes the resolved scheme's surface.
 */
export const startupBackgroundColor = (
  chromeBackground: string,
  dark: boolean
): string =>
  chromeBackground === TRANSPARENT
    ? chromeBackground
    : dark
      ? WINDOW_SURFACE.dark
      : WINDOW_SURFACE.light;

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
