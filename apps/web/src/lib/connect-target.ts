/**
 * What connecting a connector takes on this platform, decided in one place
 * per platform (`connectTarget` in platform-system) and acted on by
 * `ConnectAttempt` (connect-page). Kept apart so the platform files can use
 * it without importing the attempt.
 */

export const CONNECT_PAGE_PATH = "/chatllm/connect-connector";

/** The connect page for one service, same-origin relative, starting consent on load. */
export const connectPagePath = (service: string, hint?: string): string => {
  const params = new URLSearchParams({ service, autostart: "1" });
  if (hint) params.set("hint", hint);
  return `${CONNECT_PAGE_PATH}?${params}`;
};

/** The query key the host's connect route comes back with: the connector id. */
export const CONNECTED_PARAM = "connected";

/**
 * The host's connect link to open from this page: the route under `hostBase`
 * gets `return` set to the page the click came from (this app's own path,
 * else the Library), so the tab comes back here once the provider's consent
 * lands. Any other URL is answered as it is.
 */
export const withConnectReturn = (url: string, hostBase: string): string => {
  if (!url.startsWith(`${hostBase}/mcp/connect/`)) return url;
  const base = import.meta.env.BASE_URL;
  const here = new URL(window.location.href);
  here.searchParams.delete(CONNECTED_PARAM);
  const link = new URL(url);
  link.searchParams.set(
    "return",
    here.pathname.startsWith(base)
      ? `${here.pathname}${here.search}`
      : `${base}library/connectors`
  );
  return link.toString();
};

/** What connecting a connector (or an MCP server by name) takes on this platform. */
export type ConnectTarget =
  /** Browser: the platform's connect page, opened in the click; the host watches. */
  | { kind: "connect-page"; url: string }
  /** Desktop: main mints the platform's page and opens it in the default browser. */
  | { kind: "connect-link" }
  /** Browser: the host's connect route: the provider's consent, then the install. */
  | { kind: "host-route"; url: string }
  /** Desktop: main installs and signs in, and answers once done. */
  | { kind: "in-app" }
  /** The app collects the connector's fields first. */
  | { kind: "fields" }
  /** A chat app, paired from its own dialog. */
  | { kind: "pairing" };

/**
 * A new tab, detectably: `noopener` would make `window.open` answer null
 * either way, so the opener is cut after the fact. False when blocked.
 */
export const openTab = (url: string): boolean => {
  const tab = window.open(url, "_blank");
  if (tab == null) return false;
  tab.opener = null;
  return true;
};
