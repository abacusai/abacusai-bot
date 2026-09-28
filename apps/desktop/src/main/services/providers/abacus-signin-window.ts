/**
 * The Abacus.AI sign-up page in an app window rather than the system browser,
 * so a new user never leaves the app to create an account. The page and the
 * PKCE hand-off are the browser flow's own: the connect page still redirects
 * the one-time code to the loopback listener, which this window simply loads.
 *
 * Social sign-in stays here too: provider popups (Google, Apple, Microsoft,
 * GitHub, Okta) open as child windows on this window's session, so the
 * page's opener and BroadcastChannel callbacks work as they do in a browser,
 * and SAML redirects load in place.
 *
 * Google is driven from here instead: the page's Google button uses
 * gapi.auth2, which cannot start in an embedded browser and fails silently.
 * So its click is intercepted, Google's standard auth-code popup opens as a
 * child window, the code is caught on its way to abacus.ai's OAuth callback,
 * and the page's own sign-in API (`_googleCodeSignIn`) is called from inside
 * the page so the session lands in this window. The window then goes to the
 * connect page, which hands the one-time code to the loopback listener as
 * every other sign-in does. The user agent is left as Electron's own: Google
 * accepts it, and rejects a window claiming to be Chrome ("This browser or
 * app may not be secure").
 *
 * The browser's own cookies are out of reach (they are encrypted to the
 * browser), so provider sessions are this window's own. Its session is
 * install-wide and persists, and only Abacus.AI's state is cleared per
 * attempt: a sign-out must not sign straight back in, but a provider account
 * the user already signed in to here is offered again, whichever app account
 * they sign out of.
 */
import { randomBytes } from "crypto";
import path from "path";

import { BrowserWindow, session, shell } from "electron";

import { parentWindow, presentAsDialog } from "../../bring-to-front";
import { isSafeExternalUrl } from "../../external-links";
import { profileBaseDir } from "../../profile-home";

/**
 * Install-wide, beside the profile registry: userData lives inside each
 * account's profile, so a partition there would start empty after every
 * sign-out or account switch and no provider account could be remembered.
 */
const signInSessionPath = (): string =>
  path.join(profileBaseDir(), "sign-in-session");

/** Logged by the injected "Use my browser instead" pill; see HINT_JS. */
const BROWSER_MESSAGE = "abacus:sign-in-use-browser";

/** Logged by the injected Google-button interceptor; see GOOGLE_JS. */
const GOOGLE_MESSAGE = "abacus:sign-in-google";

/**
 * Catches a click on the page's Google button (by its label, which always
 * names Google) before gapi.auth2 swallows it. No regex escapes: this is a
 * template literal. Idempotent.
 */
const GOOGLE_JS = `(() => {
  if (window.__abacusGoogleIntercept) return;
  window.__abacusGoogleIntercept = true;
  document.addEventListener('click', (event) => {
    const target = event.target instanceof Element
      ? event.target.closest('button, [role="button"], a') : null;
    const words = (target ? target.textContent || '' : '').split(/[^A-Za-z]+/);
    if (!words.includes('Google')) return;
    event.preventDefault();
    event.stopPropagation();
    console.log('${GOOGLE_MESSAGE}');
  }, true);
})();`;

/** Where Google's auth-code popup returns; registered on the production client. */
const GOOGLE_REDIRECT_URI = "https://abacus.ai/oauth/callback";

/**
 * Runs in the page: its API origin, its cookies, so the session lands here.
 * X-Abacus-Org-Host is what the page's own API client sends (its host's
 * subdomain, `apps` on apps.abacus.ai); without it the backend reads the
 * sign-in as coming from the platform portal and refuses ChatLLM Teams users.
 */
const callPageApi = (method: string, data: unknown): string => `
  (() => {
    const host = location.hostname.toLowerCase();
    const suffix = '.abacus.ai';
    const headers = { 'content-type': 'application/json' };
    if (host.endsWith(suffix)) headers['X-Abacus-Org-Host'] = host.slice(0, -suffix.length);
    return fetch('/api/v1/${method}', {
      method: 'POST',
      credentials: 'include',
      headers,
      body: ${JSON.stringify(JSON.stringify(data))},
    }).then((r) => r.json()).catch(() => null);
  })()`;

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

/**
 * Microsoft's authorize URL with its account picker forced on, or null when
 * `url` is not one or already says what to prompt for.
 */
export const withMicrosoftAccountPicker = (url: string): string | null => {
  try {
    const parsed = new URL(url);
    if (
      parsed.hostname.toLowerCase() !== "login.microsoftonline.com" ||
      !parsed.pathname.endsWith("/authorize") ||
      parsed.searchParams.has("prompt")
    )
      return null;
    parsed.searchParams.set("prompt", "select_account");

    return parsed.toString();
  } catch {
    return null;
  }
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

  const signInSession = session.fromPath(signInSessionPath());
  await forgetAbacusSession(signInSession).catch(() => {});
  // This session remembers provider logins, so Microsoft would silently reuse
  // the last account; its authorize request is rewritten to ask for the
  // picker, as Google's popup does. At the request, not the popup: a reload
  // from did-create-window loses the race with the popup's own first load.
  signInSession.webRequest.onBeforeRequest(
    { urls: ["https://login.microsoftonline.com/*"] },
    (details, callback) => {
      const picker =
        details.resourceType === "mainFrame"
          ? withMicrosoftAccountPicker(details.url)
          : null;
      callback(picker != null ? { redirectURL: picker } : {});
    }
  );

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

  /**
   * Google's auth-code popup, run from here (see the top of the file). Any
   * failure short of the user closing the popup hands off to the browser,
   * where the page's own Google button works.
   */
  let googleInFlight = false;
  const signInWithGoogle = async (): Promise<void> => {
    if (googleInFlight || released) return;
    googleInFlight = true;
    try {
      const ids = (await win.webContents.executeJavaScript(
        callPageApi("_getSSOClientIds", {})
      )) as { result?: { google?: unknown } } | null;
      const clientId = ids?.result?.google;
      if (typeof clientId !== "string" || clientId.length === 0) {
        handOff();
        return;
      }

      const state = randomBytes(16).toString("hex");
      const auth = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      auth.searchParams.set("client_id", clientId);
      auth.searchParams.set("redirect_uri", GOOGLE_REDIRECT_URI);
      auth.searchParams.set("response_type", "code");
      auth.searchParams.set("scope", "openid email profile");
      auth.searchParams.set("prompt", "select_account");
      auth.searchParams.set("state", state);

      const code = await new Promise<string | null>((resolve) => {
        const popup = new BrowserWindow({
          parent: win,
          width: 480,
          height: 640,
          autoHideMenuBar: true,
          webPreferences: {
            session: win.webContents.session,
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
          },
        });
        let done = false;
        const settle = (value: string | null): void => {
          if (done) return;
          done = true;
          if (!popup.isDestroyed()) popup.close();
          resolve(value);
        };
        const watch = (event: Electron.Event, target: string): void => {
          if (!target.startsWith(GOOGLE_REDIRECT_URI)) return;
          event.preventDefault();
          const params = new URL(target).searchParams;
          settle(params.get("state") === state ? params.get("code") : null);
        };
        popup.webContents.on("will-redirect", (event) =>
          watch(event, event.url)
        );
        popup.webContents.on("will-navigate", (event) =>
          watch(event, event.url)
        );
        popup.webContents.setWindowOpenHandler(({ url: target }) => {
          if (isSafeExternalUrl(target)) void shell.openExternal(target);
          return { action: "deny" };
        });
        popup.on("closed", () => settle(null));
        void popup.loadURL(auth.toString()).catch(() => {});
      });
      // Closed by the user: stay on the page, nothing to report.
      if (code == null || released) return;

      const signedIn = (await win.webContents.executeJavaScript(
        callPageApi("_googleCodeSignIn", {
          googleCode: code,
          signupSource: "AbacusAIBot",
        })
      )) as { success?: unknown; error?: unknown } | null;
      if (signedIn?.success !== true) {
        console.warn(
          `[abacus-auth] Google sign-in refused: ${typeof signedIn?.error === "string" ? signedIn.error.slice(0, 120) : "no response"}`
        );
        handOff();
        return;
      }

      // Signed in: the connect page mints the one-time code for the listener.
      const connect = new URL("/chatllm/connect-bot/", url);
      for (const key of ["botChallenge", "botPort", "botPath"]) {
        const value = new URL(url).searchParams.get(key);
        if (value != null) connect.searchParams.set(key, value);
      }
      void win.loadURL(connect.toString()).catch(() => {});
    } catch (error) {
      console.warn(
        `[abacus-auth] Google sign-in failed: ${error instanceof Error ? error.message : String(error)}`
      );
      handOff();
    } finally {
      googleInFlight = false;
    }
  };

  // A provider popup's own links open in the browser.
  win.webContents.on("did-create-window", (popup) => {
    popup.webContents.setWindowOpenHandler(({ url: target }) => {
      if (isSafeExternalUrl(target)) void shell.openExternal(target);
      return { action: "deny" };
    });
  });

  win.webContents.on("did-finish-load", () => {
    void win.webContents.executeJavaScript(HINT_JS, true).catch(() => {});
    void win.webContents.executeJavaScript(GOOGLE_JS, true).catch(() => {});
  });
  win.webContents.on("console-message", (event) => {
    if (event.message === BROWSER_MESSAGE) handOff();
    else if (event.message === GOOGLE_MESSAGE) void signInWithGoogle();
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
