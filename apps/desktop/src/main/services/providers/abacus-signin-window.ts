/**
 * The Abacus.AI sign-up page in an app window rather than the system browser,
 * so a new user never leaves the app to create an account. The page and the
 * PKCE hand-off are the browser flow's own: the connect page still redirects
 * the one-time code to the loopback listener, which this window simply loads.
 *
 * Social sign-in stays here too: provider popups (Google, Apple, Microsoft,
 * GitHub, Okta) open as child windows on this window's session, so the
 * page's opener and BroadcastChannel callbacks work as they do in a browser,
 * and SAML redirects load in place. For Google that needs the page's
 * auth-code popup rather than its gapi.auth2 button, which cannot start in
 * an embedded browser; `botSurface=in_app` on the URL asks the page for it.
 * The user agent is left as Electron's own: Google accepts it, and rejects a
 * window that claims to be Chrome ("This browser or app may not be secure").
 *
 * The browser's own cookies are out of reach (they are encrypted to the
 * browser), so provider sessions are this window's own. Its partition
 * persists and only Abacus.AI's state is cleared per attempt: a sign-out
 * must not sign straight back in, but a provider the user already signed in
 * to here is remembered.
 */
import { BrowserWindow, session, shell } from "electron";

import { parentWindow, presentAsDialog } from "../../bring-to-front";
import { isSafeExternalUrl } from "../../external-links";

const PARTITION = "persist:abacus-signin";

/** Logged by the injected "Use my browser instead" pill; see HINT_JS. */
const BROWSER_MESSAGE = "abacus:sign-in-use-browser";

/**
 * A pill on the sign-in page itself: the app's own "Use my browser instead"
 * link sits behind this window. A console message is the one channel a
 * sandboxed third-party page can reach the main process through. Idempotent.
 */
const HINT_JS = `(() => {
  if (document.getElementById('abacus-use-browser')) return;
  const pill = document.createElement('button');
  pill.id = 'abacus-use-browser';
  pill.type = 'button';
  pill.textContent = 'Use my browser instead';
  pill.style.cssText = [
    'position:fixed', 'bottom:14px', 'left:50%',
    'transform:translateX(-50%)', 'z-index:2147483647',
    'padding:6px 14px', 'border:none', 'border-radius:999px',
    'background:rgba(20,20,20,0.72)', 'color:#fff',
    'font:500 12px system-ui,sans-serif', 'cursor:pointer',
  ].join(';');
  pill.addEventListener('click', () => console.log('${BROWSER_MESSAGE}'));
  document.body.appendChild(pill);
})();`;

export type SignInWindow = {
  /** Close without reporting a dismissal; the flow has settled or moved on. */
  close: () => void;
};

/** Drop Abacus.AI's cookies and storage, keeping every provider's session. */
const forgetAbacusSession = async (
  signInSession: Electron.Session
): Promise<void> => {
  const cookies = await signInSession.cookies.get({});
  await Promise.all(
    cookies
      .filter(({ domain }) => {
        const host = (domain ?? "").replace(/^\./, "").toLowerCase();
        return host === "abacus.ai" || host.endsWith(".abacus.ai");
      })
      .map(({ domain, path, name, secure }) =>
        signInSession.cookies.remove(
          `${secure === true ? "https" : "http"}://${(domain ?? "").replace(/^\./, "")}${path ?? "/"}`,
          name
        )
      )
  );
  const storages: Array<
    "localstorage" | "indexdb" | "serviceworkers" | "cachestorage"
  > = ["localstorage", "indexdb", "serviceworkers", "cachestorage"];
  for (const origin of ["https://abacus.ai", "https://apps.abacus.ai"])
    await signInSession.clearStorageData({ origin, storages });
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
  /** The flow needs the browser (asked for, or the page failed); the window is already closing. */
  onHandOff: () => void;
  /** The user closed the window before the flow settled. */
  onDismissed: () => void;
}): Promise<SignInWindow | null> => {
  if (parentWindow() == null) return null;

  const signInSession = session.fromPartition(PARTITION);
  await forgetAbacusSession(signInSession).catch(() => {});

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

  // The page may move between Abacus.AI origins and through a SAML IdP;
  // nothing but https (and this attempt's own loopback callback) loads here.
  const guard = (event: Electron.Event, target: string): void => {
    if (isOwnCallback(target, port, callbackPath)) return;
    if (target.startsWith("https:")) return;
    event.preventDefault();
    if (isSafeExternalUrl(target)) void shell.openExternal(target);
  };
  win.webContents.on("will-navigate", (event) => guard(event, event.url));
  win.webContents.on("will-redirect", (event) => guard(event, event.url));

  win.webContents.setWindowOpenHandler(({ url: target, disposition }) => {
    // Host only: the query carries OAuth state.
    const host = URL.canParse(target) ? new URL(target).host : target;
    console.log(
      `[abacus-auth] sign-in popup: ${disposition} ${host || "blank"}`
    );
    // window.open with features is a provider popup: it runs here, on this
    // session, so it can post back to its opener. Some providers open it
    // blank and navigate it after.
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
    // Terms, privacy and help links open in the browser without leaving the flow.
    if (isSafeExternalUrl(target)) void shell.openExternal(target);
    return { action: "deny" };
  });

  // A provider popup's own links open in the browser.
  win.webContents.on("did-create-window", (popup) => {
    popup.webContents.setWindowOpenHandler(({ url: target }) => {
      if (isSafeExternalUrl(target)) void shell.openExternal(target);
      return { action: "deny" };
    });
  });

  win.webContents.on("did-finish-load", () => {
    void win.webContents.executeJavaScript(HINT_JS, true).catch(() => {});
  });
  win.webContents.on("console-message", (event) => {
    if (event.message === BROWSER_MESSAGE) handOff();
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

  // Asks the page for its popup-based Google button (see the top of the file).
  const pageUrl = new URL(url);
  pageUrl.searchParams.set("botSurface", "in_app");

  presentAsDialog(win);
  // Rejections are the did-fail-load cases above, already handled there.
  void win.loadURL(pageUrl.toString()).catch(() => {});

  return { close: release };
};
