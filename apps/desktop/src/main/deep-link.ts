/**
 * `abacusai-bot://open`: the web's way back into the app once a browser hop
 * (paying for a plan) is done. The link only brings the window forward, so
 * nothing in it is read. macOS delivers it as `open-url`; Windows and Linux
 * start a second instance with it in argv, which the first instance hears as
 * `second-instance`.
 */
import { app } from "electron";

export const DEEP_LINK_SCHEME = "abacusai-bot";

/** Whether a command line carries one of the app's links. */
export const hasDeepLink = (argv: readonly string[]): boolean =>
  argv.some((arg) => arg.toLowerCase().startsWith(`${DEEP_LINK_SCHEME}:`));

/**
 * Makes this install the scheme's handler. A packaged macOS build declares it
 * in Info.plist (electron-builder `protocols`); registering makes it the
 * default when another copy claimed it. Windows has no installer keys, so the
 * app writes its own under HKCU at every launch. Linux is left to the package's
 * .desktop file: Electron's call there runs xdg-settings on the main thread.
 */
export const registerDeepLinkProtocol = (): void => {
  // A dev build would register the bare Electron binary.
  if (!app.isPackaged) return;
  if (process.platform !== "darwin" && process.platform !== "win32") return;
  try {
    const registered = app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME);
    if (!registered)
      console.warn(`[deep-link] ${DEEP_LINK_SCHEME}: registration refused`);
  } catch (error) {
    console.warn(
      `[deep-link] ${DEEP_LINK_SCHEME}: not registered: ${error instanceof Error ? error.message : String(error)}`
    );
  }
};
