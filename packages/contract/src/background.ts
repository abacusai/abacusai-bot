/**
 * Keeping the desktop app running with its window closed (Windows and Linux;
 * macOS always does), and the one ask, after a result, to turn that on
 * together with open at login.
 */
import type { PrefsRow } from "./contract/rows";

/** The setting; absent reads as on. */
export const keepsRunningInBackground = (
  prefs: Pick<PrefsRow, "keepRunningInBackground">
): boolean => prefs.keepRunningInBackground !== false;

export interface BackgroundAskState {
  /** Node's platform name; null until read. */
  platform: string | null;
  keepRunning: boolean;
  /** Null while unread, or where this build cannot open at login. */
  openAtLogin: boolean | null;
  /** The ask has shown once already. */
  asked: boolean;
  /** The desktop can show the tray icon; null while unknown. */
  trayAvailable: boolean | null;
}

/**
 * Asked once, on Windows and Linux, and only when there is something to turn
 * on: the background setting was turned off, or the app does not open at
 * login. Never on a desktop with no tray, where a close still quits.
 */
export const backgroundAskWanted = (state: BackgroundAskState): boolean =>
  !state.asked &&
  (state.platform === "win32" || state.platform === "linux") &&
  state.trayAvailable !== false &&
  (!state.keepRunning || state.openAtLogin === false);
