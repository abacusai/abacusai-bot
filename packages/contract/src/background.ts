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
}

/**
 * Asked once, on Windows and Linux, and only when there is something to turn
 * on: the background setting was turned off, or the app does not open at login.
 */
export const backgroundAskWanted = (state: BackgroundAskState): boolean =>
  !state.asked &&
  (state.platform === "win32" || state.platform === "linux") &&
  (!state.keepRunning || state.openAtLogin === false);
