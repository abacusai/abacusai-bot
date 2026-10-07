/**
 * Every platform connector connects through the platform's connect page: the
 * page mints a link bound to the signed-in user and starts the provider's
 * consent. The app opens it (`openConnectPage` in platform-system) and waits here for the
 * connector to read connected.
 */
import type { ConnectorOutcome } from "@abacus-ai/contract/contracts";

import type { AppClient } from "#renderer/data/transport/types";

export const CONNECT_PAGE_PATH = "/chatllm/connect-connector";
export const CONNECT_WAIT_MS = 180_000;
const CONNECT_POLL_MS = 3_000;

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
