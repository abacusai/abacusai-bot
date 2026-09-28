/**
 * The Abacus.AI sign-up page in an app window rather than the system browser,
 * so a new user never leaves the app to create an account. The page and the
 * PKCE hand-off are the browser flow's own: the connect page still redirects
 * the one-time code to the loopback listener, which this window simply loads.
 *
 * Social sign-in cannot stay here. Google refuses OAuth in embedded browsers,
 * and the providers' popups post back to an opener this window would have to
 * host, so the first step off the Abacus.AI origin (a provider popup, a SAML
 * redirect) hands the whole flow to the system browser: same URL, same
 * listener, the user just presses their provider again there.
 */
import { BrowserWindow, session, shell } from "electron";

import { parentWindow, presentAsDialog } from "../../bring-to-front";
import { isSafeExternalUrl } from "../../external-links";

/** In-memory and cleared per attempt: a sign-out must not sign straight back in. */
const PARTITION = "abacus-signin";

export type SignInWindow = {
  /** Close without reporting a dismissal; the flow has settled or moved on. */
  close: () => void;
};

/** Whether `url` is on an Abacus.AI origin the sign-up funnel may move between. */
export const isAbacusOrigin = (url: string): boolean => {
  try {
    const { protocol, hostname } = new URL(url);
    const host = hostname.toLowerCase();

    return (
      protocol === "https:" &&
      (host === "abacus.ai" || host.endsWith(".abacus.ai"))
    );
  } catch {
    return false;
  }
};

/** The loopback callback this attempt listens on, and its result poll. */
const isOwnCallback = (
  url: string,
  port: number,
  callbackPath: string
): boolean => {
  try {
    const parsed = new URL(url);

    return (
      parsed.protocol === "http:" &&
      parsed.hostname === "127.0.0.1" &&
      parsed.port === String(port) &&
      parsed.pathname.startsWith(`/${callbackPath}`)
    );
  } catch {
    return false;
  }
};

/**
 * Open the sign-up page in a window over the app. Returns null when there is
 * no app window to hang it off (early startup, tests): the caller then uses
 * the browser, which is always correct.
 */
export const openSignInWindow = async ({
  url,
  port,
  callbackPath,
  onHandOff,
  onDismissed,
}: {
  url: string;
  port: number;
  callbackPath: string;
  /** The flow needs the browser; the window is already closing. */
  onHandOff: () => void;
  /** The user closed the window before the flow settled. */
  onDismissed: () => void;
}): Promise<SignInWindow | null> => {
  if (parentWindow() == null) return null;

  const signInSession = session.fromPartition(PARTITION);
  await signInSession.clearStorageData().catch(() => {});

  const win = new BrowserWindow({
    show: false,
    width: 520,
    height: 760,
    title: "Sign up for Abacus.AI",
    autoHideMenuBar: true,
    webPreferences: {
      session: signInSession,
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
    if (!win.isDestroyed()) win.close();
  };

  const handOff = (): void => {
    if (released) return;
    console.log("[abacus-auth] sign-in handed off to the browser");
    release();
    onHandOff();
  };

  const guard = (event: Electron.Event, target: string): void => {
    if (isAbacusOrigin(target) || isOwnCallback(target, port, callbackPath))
      return;
    event.preventDefault();
    handOff();
  };
  win.webContents.on("will-navigate", (event) => guard(event, event.url));
  win.webContents.on("will-redirect", (event) => guard(event, event.url));

  win.webContents.setWindowOpenHandler(({ url: target }) => {
    // Terms, privacy and help links stay readable without leaving the flow.
    if (isAbacusOrigin(target)) {
      if (isSafeExternalUrl(target)) void shell.openExternal(target);
    } else {
      // A provider popup: the sign-in continues in the browser.
      handOff();
    }
    return { action: "deny" };
  });

  win.on("closed", () => {
    if (released) return;
    released = true;
    onDismissed();
  });

  // A page that cannot load here may still load in the browser. -3 is
  // ERR_ABORTED: the funnel's own client-side redirects and the hand-off's
  // cancelled navigations, neither of them a failure.
  win.webContents.on(
    "did-fail-load",
    (_event, errorCode, errorDescription, _url, isMainFrame) => {
      if (!isMainFrame || errorCode === -3) return;
      console.warn(
        `[abacus-auth] sign-in window failed to load: ${errorDescription}`
      );
      handOff();
    }
  );

  presentAsDialog(win);
  // Rejections are the did-fail-load cases above, already handled there.
  void win.loadURL(url).catch(() => {});

  return { close: release };
};
