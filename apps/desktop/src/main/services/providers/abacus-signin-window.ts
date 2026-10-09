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
 * Provider sessions come from the user's default browser when it can hand
 * them over: its provider login cookies are copied in while the page loads,
 * and a provider page waits for that copy, so the provider's account chooser
 * already knows the user. They are session cookies, never written with an
 * expiry, so they last until the app quits: the Gmail hop that follows a
 * sign-in runs on this session and needs the same Google login. A default browser that cannot hand them over (Safari, Firefox, a
 * failed read) sends a provider sign-in to the browser, where the user is
 * already signed in to that provider.
 *
 * When the user picks a Chromium
 * profile on the sign-in screen, that profile's Abacus.AI cookies are copied
 * in first (the in-app browser's import, filtered to Abacus.AI) and the
 * window goes straight to the connect page, which finishes on the session
 * it finds; it only shows itself if that session turns out to be gone. Its session is
 * install-wide and persists, and only Abacus.AI's state is cleared per
 * attempt: a sign-out must not sign straight back in, but a provider account
 * the user already signed in to here is offered again, whichever app account
 * they sign out of.
 */
import { randomBytes } from "crypto";

import { BrowserWindow, nativeTheme, shell } from "electron";

import { parentWindow } from "../../bring-to-front";
import { isSafeExternalUrl } from "../../external-links";
import type { CDPCookie } from "../browser/browser-profiles-service";
import { forgetAbacusSession, signInSession } from "./sign-in-session";

/** Logged by the injected "Use my browser instead" pill; see HINT_JS. */
const BROWSER_MESSAGE = "abacus:sign-in-use-browser";

/** Logged by the injected Cancel pill; see HINT_JS. */
const CANCEL_MESSAGE = "abacus:sign-in-cancel";

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
const callPageApi = (origin: string, method: string, data: unknown): string => `
  (() => {
    if (location.origin !== ${JSON.stringify(origin)}) return null;
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
 * Pills on the sign-in page itself: the modal window covers the app's own
 * Cancel and "Use my browser instead", and a macOS sheet has no close button.
 * A console message is the one channel a sandboxed third-party page can reach
 * the main process through. Idempotent.
 */
const HINT_JS = `(() => {
  if (document.getElementById('abacus-sign-in-pills')) return;
  const row = document.createElement('div');
  row.id = 'abacus-sign-in-pills';
  row.style.cssText = [
    'position:fixed', 'bottom:14px', 'left:50%',
    'transform:translateX(-50%)', 'z-index:2147483647',
    'display:flex', 'gap:8px', 'white-space:nowrap',
  ].join(';');
  const pill = (id, label, message) => {
    const button = document.createElement('button');
    button.id = id;
    button.type = 'button';
    button.textContent = label;
    button.style.cssText = [
      'padding:6px 14px', 'border:none', 'border-radius:999px',
      'background:rgba(20,20,20,0.72)', 'color:#fff',
      'font:500 12px system-ui,sans-serif', 'cursor:pointer',
    ].join(';');
    button.addEventListener('click', () => console.log(message));
    row.appendChild(button);
  };
  pill('abacus-cancel-sign-in', 'Cancel', '${CANCEL_MESSAGE}');
  pill('abacus-use-browser', 'Use my browser instead', '${BROWSER_MESSAGE}');
  document.body.appendChild(row);
})();`;

type Size = { width: number; height: number };

// Sized for the sign-up form and a provider's account chooser; the minimums
// keep either page from collapsing into a narrow column.
const SHEET_SIZE: Size = { width: 520, height: 760 };
const SHEET_MIN: Size = { width: 380, height: 480 };
const POPUP_SIZE: Size = { width: 480, height: 640 };
const POPUP_MIN: Size = { width: 360, height: 420 };

/** `size` shrunk to fit inside `parent`, centred over it, never below `min`. */
const fitOver = (
  parent: Electron.BaseWindow,
  size: Size,
  min: Size
): Electron.Rectangle => {
  const home = parent.getBounds();
  const width = Math.max(min.width, Math.min(size.width, home.width - 40));
  const height = Math.max(min.height, Math.min(size.height, home.height - 40));

  return {
    width,
    height,
    x: Math.round(home.x + (home.width - width) / 2),
    y: Math.round(home.y + (home.height - height) / 2),
  };
};

/**
 * A sheet on macOS, a modal dialog centred on its parent elsewhere: nothing
 * to minimize, maximize or full-screen away from the flow. The background
 * follows the system theme so the window never flashes white in dark mode
 * before the page paints.
 */
const sheetOptions = (
  parent: Electron.BaseWindow,
  size: Size,
  min: Size
): Electron.BrowserWindowConstructorOptions => ({
  ...fitOver(parent, size, min),
  minWidth: min.width,
  minHeight: min.height,
  parent,
  modal: true,
  minimizable: false,
  maximizable: false,
  fullscreenable: false,
  skipTaskbar: true,
  autoHideMenuBar: true,
  backgroundColor: nativeTheme.shouldUseDarkColors ? "#1c1c1c" : "#ffffff",
});

/**
 * Escape, or Cmd/Ctrl+W, closes `win`: a sheet has no title-bar close button.
 * IME composition keeps its Escape.
 */
const closeOnEscape = (win: BrowserWindow, close: () => void): void => {
  win.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown" || input.isComposing || !win.isVisible())
      return;
    const chord =
      input.key.toLowerCase() === "w" && (input.meta || input.control);
    if (input.key !== "Escape" && !chord) return;
    event.preventDefault();
    close();
  });
};

/**
 * Show `win` over `parent`, surfacing the parent first: a sheet on a
 * minimized or hidden window is itself invisible.
 */
const presentOver = (
  win: BrowserWindow,
  parent: Electron.BaseWindow,
  size: Size,
  min: Size
): void => {
  if (!parent.isDestroyed()) {
    if (parent.isMinimized()) parent.restore();
    if (!parent.isVisible()) parent.show();
    // The parent may have moved or shrunk since construction. AppKit places
    // a sheet itself, so only the size matters there.
    if (!win.isVisible()) win.setBounds(fitOver(parent, size, min));
  }
  if (!win.isVisible()) win.show();
  win.focus();
};

// One sign-in window at a time: a second sheet on the same parent would
// displace the first without closing it.
let live: BrowserWindow | null = null;

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

const cookieUrl = (cookie: CDPCookie): string =>
  `https://${cookie.domain.replace(/^\./, "")}${cookie.path || "/"}`;

/**
 * Copy browser cookies into the sign-in session, as the in-app browser's
 * import does. A cookie stored without a leading dot is host-only and stays
 * so: naming a domain would widen it to subdomains. `persist: false` drops the
 * expiry, so the copy never reaches disk.
 */
const seedSession = async (
  target: Electron.Session,
  cookies: CDPCookie[],
  { persist }: { persist: boolean }
): Promise<void> => {
  await Promise.allSettled(
    cookies.map((cookie) =>
      target.cookies.set({
        url: cookieUrl(cookie),
        name: cookie.name,
        value: cookie.value,
        ...(cookie.domain.startsWith(".") ? { domain: cookie.domain } : {}),
        path: cookie.path,
        secure: cookie.secure,
        httpOnly: cookie.httpOnly,
        expirationDate: persist && !cookie.session ? cookie.expires : undefined,
        sameSite: seedSameSite(cookie.sameSite),
      })
    )
  );
};

/** The provider login pages that wait for the default browser's cookies. */
const PROVIDER_LOGIN_PATTERNS = [
  "https://accounts.google.com/*",
  "https://login.microsoftonline.com/*",
  "https://login.live.com/*",
  "https://appleid.apple.com/*",
  "https://idmsa.apple.com/*",
  "https://github.com/login*",
];

// A provider page waits this long for the browser's cookies, then loads
// without them: a slow browser costs a password, never a stuck popup.
const PROVIDER_SEED_WAIT_MS = 10_000;

/**
 * `seeded` covers an empty copy too; `unavailable` sends provider sign-ins to
 * the browser; `skipped` leaves them in this window with no copy at all.
 */
type ProviderSeed = "seeded" | "unavailable" | "skipped";

const seedSameSite = (
  value?: string
): "unspecified" | "no_restriction" | "lax" | "strict" => {
  switch (value?.toLowerCase()) {
    case "none":
      return "no_restriction";
    case "lax":
      return "lax";
    case "strict":
      return "strict";
    default:
      return "unspecified";
  }
};

// A seeded window stays hidden while the connect page finishes; past this it
// shows itself, so a stalled page is never an invisible wait.
const SEEDED_REVEAL_MS = 8000;

/** The connect page for this attempt, which mints the code for a live session. */
const connectUrlFor = (signInUrl: string): string => {
  const connect = new URL("/bot/link/connect-bot/", signInUrl);
  for (const key of ["botChallenge", "botPort", "botPath"]) {
    const value = new URL(signInUrl).searchParams.get(key);
    if (value != null) connect.searchParams.set(key, value);
  }
  return connect.toString();
};

/** The loopback callback this attempt listens on, and its result poll. */
export const isOwnCallback = (
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
  seedCookies,
  providerCookies,
}: {
  url: string;
  port: number;
  callbackPath: string;
  /** A picked browser profile's Abacus.AI cookies: sign in with its session. */
  seedCookies?: CDPCookie[];
  /**
   * The default browser's provider login cookies, arriving while the page
   * loads; null when that browser would not hand them over.
   */
  providerCookies?: Promise<CDPCookie[] | null>;
  /** The flow needs the browser (asked for, or the page failed); the window is already closing. */
  onHandOff: () => void;
  /** The user closed the window before the flow settled. */
  onDismissed: () => void;
}): Promise<SignInWindow | null> => {
  const parent = parentWindow();
  if (parent == null) return null;

  const partition = signInSession();
  await forgetAbacusSession(partition);
  const seeded = seedCookies != null && seedCookies.length > 0;
  if (seeded) await seedSession(partition, seedCookies, { persist: true });
  const signInOrigin = new URL(url).origin;

  if (live != null && !live.isDestroyed()) live.close();
  const win = new BrowserWindow({
    show: false,
    ...sheetOptions(parent, SHEET_SIZE, SHEET_MIN),
    title: "Abacus.AI",
    webPreferences: {
      session: partition,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  if (process.platform !== "darwin") win.removeMenu();
  live = win;
  // The page's own titles name whichever step or provider page it is on.
  win.on("page-title-updated", (event) => event.preventDefault());

  // Set once the window is ours to close: a close after this is not the user's.
  let released = false;

  /** The user's way out; the "closed" handler reports it as a dismissal. */
  const dismiss = (): void => {
    if (!released && !win.isDestroyed()) win.close();
  };
  closeOnEscape(win, dismiss);

  const closePopups = (): void => {
    for (const popup of win.getChildWindows()) {
      if (!popup.isDestroyed()) popup.close();
    }
  };

  const release = (): void => {
    if (released) return;
    released = true;
    closePopups();
    if (!win.isDestroyed()) win.close();
  };

  const handOff = (): void => {
    if (released) return;
    console.log("[abacus-auth] sign-in handed off to the browser");
    release();
    onHandOff();
  };

  const providerSeed: Promise<ProviderSeed> =
    providerCookies == null
      ? Promise.resolve("skipped")
      : Promise.race([
          providerCookies.then(async (cookies): Promise<ProviderSeed> => {
            if (cookies == null) return "unavailable";
            if (released) return "seeded";
            await seedSession(partition, cookies, { persist: false });
            console.log(
              `[abacus-auth] provider sessions from the default browser: ${cookies.length} cookies`
            );
            return "seeded";
          }),
          new Promise<ProviderSeed>((resolve) =>
            setTimeout(() => resolve("seeded"), PROVIDER_SEED_WAIT_MS)
          ),
        ]).catch((): ProviderSeed => "unavailable");

  // A provider login page waits for the copy above, or goes to the browser
  // when there is none to be had. At the request, not the popup: a reload from
  // did-create-window loses the race with the popup's own first load. This
  // session remembers provider logins, so Microsoft would silently reuse the
  // last account; its authorize request is rewritten to ask for the picker,
  // as Google's popup does.
  partition.webRequest.onBeforeRequest(
    { urls: PROVIDER_LOGIN_PATTERNS },
    (details, callback) => {
      if (details.resourceType !== "mainFrame") {
        callback({});
        return;
      }
      void providerSeed.then((seed) => {
        if (seed === "unavailable" && !released) {
          callback({ cancel: true });
          handOff();
          return;
        }
        const picker = withMicrosoftAccountPicker(details.url);
        callback(picker != null ? { redirectURL: picker } : {});
      });
    }
  );

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
          ...sheetOptions(win, POPUP_SIZE, POPUP_MIN),
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
    if (
      googleInFlight ||
      released ||
      new URL(win.webContents.getURL()).origin !== signInOrigin
    )
      return;
    googleInFlight = true;
    try {
      if ((await providerSeed) === "unavailable") {
        handOff();
        return;
      }
      const ids = (await win.webContents.executeJavaScript(
        callPageApi(signInOrigin, "_getSSOClientIds", {})
      )) as { result?: { google?: unknown } } | null;
      if (released) return;
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
          ...sheetOptions(win, POPUP_SIZE, POPUP_MIN),
          webPreferences: {
            session: win.webContents.session,
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
          },
        });
        if (process.platform !== "darwin") popup.removeMenu();
        closeOnEscape(popup, () => popup.close());
        let done = false;
        const settle = (value: string | null): void => {
          if (done) return;
          done = true;
          if (!popup.isDestroyed()) popup.close();
          resolve(value);
        };
        const watch = (event: Electron.Event, target: string): void => {
          const callback = new URL(target);
          const expected = new URL(GOOGLE_REDIRECT_URI);
          if (
            callback.origin !== expected.origin ||
            callback.pathname !== expected.pathname
          ) {
            guard(event, target);
            return;
          }
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
        void popup.loadURL(auth.toString()).catch(() => {
          if (done) return;
          settle(null);
          handOff();
        });
      });
      // Closed by the user: stay on the page, nothing to report.
      if (code == null || released) return;

      const signedIn = (await win.webContents.executeJavaScript(
        callPageApi(signInOrigin, "_googleCodeSignIn", {
          googleCode: code,
          signupSource: "AbacusAIBot",
          // A new account's organization starts on the bot's free plan.
          abacusaibotSignup: true,
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
      void win.loadURL(connectUrlFor(url)).catch(() => {});
    } catch (error) {
      console.warn(
        `[abacus-auth] Google sign-in failed: ${error instanceof Error ? error.message : String(error)}`
      );
      handOff();
    } finally {
      googleInFlight = false;
    }
  };

  // A provider popup's own links open in the browser; Escape closes only it.
  win.webContents.on("did-create-window", (popup) => {
    if (process.platform !== "darwin") popup.removeMenu();
    closeOnEscape(popup, () => {
      if (!popup.isDestroyed()) popup.close();
    });
    popup.webContents.on("will-navigate", (event) => guard(event, event.url));
    popup.webContents.on("will-redirect", (event) => guard(event, event.url));
    popup.webContents.setWindowOpenHandler(({ url: target }) => {
      if (isSafeExternalUrl(target)) void shell.openExternal(target);
      return { action: "deny" };
    });
  });

  win.webContents.on("did-finish-load", () => {
    if (released || new URL(win.webContents.getURL()).origin !== signInOrigin)
      return;
    void win.webContents
      .executeJavaScript(
        `if (location.origin === ${JSON.stringify(signInOrigin)}) { ${HINT_JS} }`,
        true
      )
      .catch(() => {});
    void win.webContents
      .executeJavaScript(
        `if (location.origin === ${JSON.stringify(signInOrigin)}) { ${GOOGLE_JS} }`,
        true
      )
      .catch(() => {});
  });
  win.webContents.on("console-message", (event) => {
    if (
      released ||
      event.frame !== win.webContents.mainFrame ||
      new URL(win.webContents.getURL()).origin !== signInOrigin
    )
      return;
    if (event.message === BROWSER_MESSAGE) handOff();
    else if (event.message === CANCEL_MESSAGE) dismiss();
    else if (event.message === GOOGLE_MESSAGE) void signInWithGoogle();
  });

  win.on("close", closePopups);
  win.on("closed", () => {
    if (live === win) live = null;
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

  // Rejections are the did-fail-load cases above, already handled there.
  if (!seeded) {
    presentOver(win, parent, SHEET_SIZE, SHEET_MIN);
    void win.loadURL(url).catch(() => {});
    return { close: release };
  }

  // Seeded: the connect page either finishes out of sight or, with no live
  // session, sends the user on to sign in, which is when the window is needed.
  let shown = false;
  const reveal = (): void => {
    if (shown || released || win.isDestroyed()) return;
    shown = true;
    presentOver(win, parent, SHEET_SIZE, SHEET_MIN);
  };
  const revealTimer = setTimeout(reveal, SEEDED_REVEAL_MS);
  win.on("closed", () => clearTimeout(revealTimer));
  win.webContents.on("did-navigate", (_event, target) => {
    if (URL.canParse(target) && new URL(target).pathname.includes("/signin")) {
      reveal();
    }
  });
  void win.loadURL(connectUrlFor(url)).catch(() => {});

  return { close: release };
};
