/**
 * A connector's browser hop, run in a window over the app on the sign-in
 * session. The account signed in there, so the platform's connect page
 * recognises it and, asked to, goes straight to the provider's consent; the
 * user's own browser may know nothing of the account and would show the
 * page's sign-in first. Everything else follows the sign-in window: https
 * only, provider popups on the same session, the app's loopback callback let
 * through, and the browser as the fallback when the page cannot load here.
 */
import { BrowserWindow, session, shell } from "electron";

import { parentWindow, presentAsDialog } from "../../bring-to-front";
import { isSafeExternalUrl } from "../../external-links";
import { isOwnCallback, signInSessionPath } from "./abacus-signin-window";

export interface ConnectWindow {
  /** The hop settled elsewhere; take the window down. */
  close: () => void;
}

export const openConnectWindow = ({
  url,
  port,
  callbackPath,
  onHandOff,
  onDismissed,
}: {
  url: string;
  port: number;
  callbackPath: string;
  /** The page could not load here; the caller opens the browser instead. */
  onHandOff: () => void;
  /** The user closed the window before the hop settled. */
  onDismissed: () => void;
}): ConnectWindow | null => {
  if (parentWindow() == null) return null;

  const win = new BrowserWindow({
    show: false,
    width: 520,
    height: 760,
    title: "Connect to Abacus.AI",
    autoHideMenuBar: true,
    webPreferences: {
      session: session.fromPath(signInSessionPath()),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  if (process.platform !== "darwin") win.removeMenu();

  // Set once the window is ours to close: a close after this is not the user's.
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    for (const popup of win.getChildWindows())
      if (!popup.isDestroyed()) popup.close();
    if (!win.isDestroyed()) win.close();
  };

  const guard = (event: Electron.Event, target: string): void => {
    if (isOwnCallback(target, port, callbackPath)) return;
    if (target.startsWith("https:")) return;
    event.preventDefault();
    if (isSafeExternalUrl(target)) void shell.openExternal(target);
  };
  win.webContents.on("will-navigate", (event) => guard(event, event.url));
  win.webContents.on("will-redirect", (event) => guard(event, event.url));
  win.webContents.setWindowOpenHandler(({ url: target, disposition }) => {
    const blank = target === "" || target === "about:blank";
    if (
      disposition === "new-window" &&
      (blank || target.startsWith("https:"))
    ) {
      return {
        action: "allow",
        overrideBrowserWindowOptions: {
          parent: win,
          autoHideMenuBar: true,
          webPreferences: {
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
          },
        },
      };
    }
    if (isSafeExternalUrl(target)) void shell.openExternal(target);
    return { action: "deny" };
  });

  win.on("closed", () => {
    if (released) return;
    released = true;
    onDismissed();
  });
  // -3 is ERR_ABORTED: the page's own client-side redirects, not a failure.
  win.webContents.on(
    "did-fail-load",
    (_event, errorCode, errorDescription, _url, isMainFrame) => {
      if (!isMainFrame || errorCode === -3 || released) return;
      console.warn(
        `[abacus-connectors] connect window failed to load: ${errorDescription}`
      );
      release();
      onHandOff();
    }
  );

  presentAsDialog(win);
  void win.loadURL(url).catch(() => {});
  return { close: release };
};
