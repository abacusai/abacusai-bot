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
 * The tray can hold a closed window. Windows has one unless creating the icon
 * failed; on Linux it depends on the desktop, so an unanswered probe is a no.
 */
const trayUsable = (
  platform: string | null,
  trayAvailable: boolean | null
): boolean =>
  platform === "win32"
    ? trayAvailable !== false
    : platform === "linux" && trayAvailable === true;

/**
 * Asked once, on Windows and Linux, and only when there is something to turn
 * on: the background setting was turned off, or the app does not open at
 * login. Never on a desktop with no tray, where a close still quits.
 */
export const backgroundAskWanted = (state: BackgroundAskState): boolean =>
  !state.asked &&
  trayUsable(state.platform, state.trayAvailable) &&
  (!state.keepRunning || state.openAtLogin === false);

/** The "Keep running in the background" switch: only where a tray can hold the window. */
export const keepRunningSettingShown = (
  platform: string | null,
  trayAvailable: boolean | null
): boolean => trayUsable(platform, trayAvailable);
