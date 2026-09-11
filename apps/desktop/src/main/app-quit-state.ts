/**
 * Shared "a real quit is underway" flag, outside index.ts so the updater can
 * set it too. On macOS the window 'close' handler hides instead of destroying
 * (background agent work must survive), but Squirrel.Mac's quitAndInstall()
 * only proceeds once every window is GONE; if close is still intercepting,
 * the install deadlocks and ShipIt aborts with "App Still Running Error".
 */
let quitting = false;

/** Declare that a real quit is underway. Idempotent; never unset. */
export function markQuitting(): void {
  quitting = true;
}

/** True once a real quit (Cmd-Q, menu Quit, app.quit(), update) has begun. */
export function isQuitting(): boolean {
  return quitting;
}

/**
 * Undo a quit intent that turned out not to be one. Only the updater's
 * hand-off failure path may call this: it sets the flag before quitAndInstall()
 * closes windows, and if that throws, a still-set flag would make the next
 * window close kill background agent work instead of hiding.
 */
export function clearQuitting(): void {
  quitting = false;
}
