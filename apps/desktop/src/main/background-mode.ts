/**
 * What closing the main window does. macOS always hides (dock convention).
 * Windows and Linux hide into the tray while "Keep running in the background"
 * is on and the tray icon is up, so routines and notices keep working;
 * otherwise the close quits the app, asking first while a task runs.
 */
import { keepsRunningInBackground } from "@abacus-ai/contract/background";
import type { PrefsRow } from "@abacus-ai/contract/contract/rows";

export type CloseAction = "close" | "hide" | "ask";

export interface CloseState {
  platform: string;
  /** A real quit (menu, tray, update, shutdown) is underway. */
  quitting: boolean;
  keepRunning: boolean;
  trayShown: boolean;
  taskRunning: boolean;
}

export const closeAction = (state: CloseState): CloseAction => {
  if (state.quitting) return "close";
  if (state.platform === "darwin") return "hide";
  if (state.keepRunning && state.trayShown) return "hide";
  return state.taskRunning ? "ask" : "close";
};

/** The tray icon is wanted: Windows and Linux, with the setting on. */
export const wantsTray = (
  platform: string,
  prefs: Pick<PrefsRow, "keepRunningInBackground">
): boolean => platform !== "darwin" && keepsRunningInBackground(prefs);

/**
 * The once-per-install notice that the app is still running: on the first
 * close into the tray. macOS users expect a hidden window, so it never shows.
 */
export const backgroundNoticeDue = (
  action: CloseAction,
  platform: string,
  dismissals: Pick<PrefsRow["dismissals"], "backgroundNoticeAt">
): boolean =>
  action === "hide" &&
  platform !== "darwin" &&
  dismissals.backgroundNoticeAt == null;
