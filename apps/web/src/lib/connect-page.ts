/**
 * How a connector connects is decided once per platform (`connectTarget` in
 * platform-system): a platform connector through the platform's connect page,
 * an MCP server in the browser through the host's own connect route, a
 * desktop MCP server in the app. A page or route opens inside the click
 * (`openConnectPage`), and the app waits here for the connector to read
 * connected.
 */
import type { ConnectorOutcome } from "@abacus-ai/contract/contracts";

import type { AppClient } from "#renderer/data/transport/types";

export const CONNECT_PAGE_PATH = "/chatllm/connect-connector";
export const CONNECT_WAIT_MS = 180_000;
const CONNECT_POLL_MS = 3_000;

/** What connecting a connector (or an MCP server by name) takes on this platform. */
export type ConnectTarget =
  /** Browser: the platform's connect page, opened in the click; the host watches. */
  | { kind: "connect-page"; url: string }
  /** Desktop: main mints the platform's page and opens it in the default browser. */
  | { kind: "connect-link" }
  /** Browser: the host's connect route, which installs, signs in, and watches. */
  | { kind: "host-route"; url: string }
  /** Desktop: main installs and signs in, and answers once done. */
  | { kind: "in-app" }
  /** The app collects the connector's fields first. */
  | { kind: "fields" }
  /** A chat app, paired from its own dialog. */
  | { kind: "pairing" };

/** The page for one service, same-origin relative, starting consent on load. */
export const connectPagePath = (service: string, hint?: string): string => {
  const params = new URLSearchParams({ service, autostart: "1" });
  if (hint) params.set("hint", hint);
  return `${CONNECT_PAGE_PATH}?${params}`;
};

/**
 * Resolves once the connector reads connected: polled every few seconds and
 * on window focus, for up to three minutes. Aborting stops waiting (cancelled).
 */
export const waitForConnected = (
  client: Pick<AppClient, "connectors">,
  connectorId: string,
  signal: AbortSignal
): Promise<ConnectorOutcome> =>
  new Promise((resolve) => {
    const deadline = Date.now() + CONNECT_WAIT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let checking = false;
    let done = false;
    const finish = (outcome: ConnectorOutcome): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      window.removeEventListener("focus", check);
      signal.removeEventListener("abort", abort);
      resolve(outcome);
    };
    const abort = (): void =>
      finish({ ok: false, cancelled: true, error: "cancelled" });
    async function check(): Promise<void> {
      if (checking || done) return;
      checking = true;
      clearTimeout(timer);
      try {
        const statuses = await client.connectors.statuses({});
        if (statuses[connectorId]?.state === "connected")
          return finish({ ok: true });
      } catch {
        // A failed read is retried on the next tick.
      } finally {
        checking = false;
      }
      if (done) return;
      if (Date.now() >= deadline)
        return finish({
          ok: false,
          error: "Connecting timed out. Please try again.",
        });
      timer = setTimeout(() => void check(), CONNECT_POLL_MS);
    }
    if (signal.aborted) return abort();
    signal.addEventListener("abort", abort);
    window.addEventListener("focus", check);
    timer = setTimeout(() => void check(), CONNECT_POLL_MS);
  });
