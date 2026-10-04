/**
 * The hosted web app: the same renderer, served from our servers under a base
 * path (`/bot/`) and talking to them over a WebSocket. Everything that differs
 * from the desktop asks this module, so the desktop build never takes a web
 * branch: `VITE_WEB_APP` is only defined in vite.web.config.ts.
 *
 * `<base>/code/` is the same app pointed at the user's own desktop, which does
 * coding work (sessions, terminals, files) on their machine.
 */
export const isWebApp = import.meta.env.VITE_WEB_APP === "1";

/** `/bot/`, with its trailing slash. */
const basePath = (): string => import.meta.env.BASE_URL;

/** This tab is the coding view, served by the user's desktop. */
export const isRunnerView = (): boolean =>
  isWebApp && window.location.pathname.startsWith(`${basePath()}code`);

export const webAppUrl = (): string => `${window.location.origin}${basePath()}`;

export const codingViewUrl = (): string => `${webAppUrl()}code/#/sessions`;

/** The socket this tab's transport opens. */
export const webSocketUrl = (): string => {
  const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
  const endpoint = isRunnerView() ? "runner-rpc" : "rpc";
  return `${scheme}//${window.location.host}${basePath()}${endpoint}`;
};

/**
 * The website's AbacusAI Bot sign-up (with a sign-in link for existing
 * accounts). `botWeb=1` brings the visitor back to this app afterwards
 * instead of handing off to the desktop app.
 */
export const signInUrl = (): string => {
  const url = new URL("/app/signup", window.location.origin);
  url.searchParams.set("AbacusAIBot", "1");
  url.searchParams.set("botWeb", "1");
  return url.toString();
};

export type WebSession =
  | "signed-in"
  | "signed-out"
  | "not-allowed"
  | "no-runner"
  | "down";

/**
 * Whether this browser's session may use the app, asked before any socket
 * opens (a refused socket says nothing about why). `runner`: the coding view
 * also needs the user's desktop attached.
 */
export const checkWebSession = async ({
  runner,
}: {
  runner: boolean;
}): Promise<WebSession> => {
  try {
    const response = await fetch(
      `${basePath()}session${runner ? "?runner=1" : ""}`,
      { credentials: "same-origin", cache: "no-store" }
    );
    if (response.ok) return "signed-in";
    if (response.status === 401) return "signed-out";
    if (response.status === 403) return "not-allowed";
    if (response.status === 404) return "no-runner";
    return "down";
  } catch {
    return "down";
  }
};

/**
 * A lost socket is a page reload in this app (lib/bootstrap), which a phone
 * triggers every time its screen locks. Reload once the tab is visible and
 * online again, not into a dead network.
 */
export const whenTabCanReconnect = (): Promise<void> =>
  new Promise((resolve) => {
    const ready = (): boolean =>
      document.visibilityState === "visible" && navigator.onLine;
    if (ready()) {
      resolve();
      return;
    }
    const check = (): void => {
      if (!ready()) return;
      document.removeEventListener("visibilitychange", check);
      window.removeEventListener("online", check);
      resolve();
    };
    document.addEventListener("visibilitychange", check);
    window.addEventListener("online", check);
  });

/**
 * Phones: the page's height is the visible viewport's, so the composer sits
 * above the keyboard (iOS overlays the keyboard instead of resizing), and
 * `data-keyboard` says when it is up so the tab bar can step aside.
 */
export const installViewportTracking = (): void => {
  const viewport = window.visualViewport;
  if (!isWebApp || viewport == null) return;
  const root = document.documentElement;
  const update = (): void => {
    root.style.setProperty("--app-h", `${Math.round(viewport.height)}px`);
    root.dataset.keyboard =
      window.innerHeight - viewport.height > 120 ? "open" : "closed";
  };
  viewport.addEventListener("resize", update);
  update();
};
