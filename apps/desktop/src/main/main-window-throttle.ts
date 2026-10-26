import type { BaseWindow, WebContents } from "electron";

/** How often a hidden window looks for a turn starting or ending. */
const TURN_POLL_MS = 1_000;
/** Full speed this long after the last turn, for its notification and sound. */
const AFTER_TURN_MS = 10_000;

interface MainWindowThrottleOptions {
  window: BaseWindow;
  /** The page on screen; a renderer swap replaces it. */
  contents: () => WebContents | null;
  /** A reply or a routine is running. */
  busy: () => boolean;
}

/**
 * Lets Chromium throttle the app's page (timers, animation frames, painting)
 * while the window is minimized or hidden. Never while a turn runs, nor just
 * after one: the page plays the reply's sound and raises its notification.
 * Visible, it runs at full speed, as it always has.
 *
 * Only window events start it: the window is built hidden and must paint its
 * first frame before it is shown.
 */
export const throttleMainWindowWhileHidden = (
  options: MainWindowThrottleOptions
): void => {
  const { window, contents, busy } = options;
  let poll: ReturnType<typeof setInterval> | null = null;
  let busyUntil = 0;
  let applied: { contents: WebContents; allowed: boolean } | null = null;

  const hidden = (): boolean => !window.isVisible() || window.isMinimized();
  const stopPolling = (): void => {
    if (poll != null) clearInterval(poll);
    poll = null;
  };
  const apply = (): void => {
    if (window.isDestroyed()) return stopPolling();
    const target = contents();
    if (target == null || target.isDestroyed()) return;
    let allowed = false;
    if (hidden()) {
      if (busy()) busyUntil = Date.now() + AFTER_TURN_MS;
      allowed = Date.now() >= busyUntil;
    }
    if (applied?.contents === target && applied.allowed === allowed) return;
    applied = { contents: target, allowed };
    target.setBackgroundThrottling(allowed);
  };
  const update = (): void => {
    apply();
    if (window.isDestroyed() || !hidden()) stopPolling();
    else poll ??= setInterval(apply, TURN_POLL_MS);
  };

  window.on("minimize", update);
  window.on("hide", update);
  window.on("restore", update);
  window.on("show", update);
  window.once("closed", stopPolling);
};
