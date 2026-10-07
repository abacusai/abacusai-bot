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
