import type { ConnectorOutcome } from "@abacus-ai/contract/contracts";

import type { AppClient } from "#renderer/data/transport/types";
import { IS_ELECTRON } from "#renderer/lib/platform";

/** Call before the first await in a click handler. Detach the opener without
 * noopener's intentionally null return value, so blocking remains detectable. */
export const reserveAuthorization = () => {
  const popup = IS_ELECTRON ? null : window.open("about:blank", "_blank");
  if (popup) popup.opener = null;
  let fallback: HTMLDialogElement | undefined;
  let cancelled = false;
  return {
    get cancelled() {
      return cancelled;
    },
    open(url: string) {
      if (!/^https?:/i.test(url)) throw new Error("Invalid authorization URL");
      const blocked = !popup || popup.closed;
      if (!blocked) popup.location.href = url;
      fallback = document.createElement("dialog");
      const link = document.createElement("a");
      link.textContent = blocked
        ? "Popup blocked, click to open"
        : "Continue authorization";
      link.href = url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.onclick = () => fallback?.remove();
      const close = document.createElement("button");
      close.textContent = "Cancel";
      close.onclick = () => {
        cancelled = true;
        popup?.close();
        fallback?.remove();
      };
      fallback.addEventListener("cancel", () => {
        cancelled = true;
        popup?.close();
        fallback?.remove();
      });
      fallback.append(link, close);
      document.body.append(fallback);
      fallback.showModal();
    },
    close() {
      popup?.close();
      fallback?.remove();
    },
  };
};
export const completeConnectorAuthorization = async (
  client: Pick<AppClient, "connectors">,
  connectorId: string,
  outcome: ConnectorOutcome,
  authorization: ReturnType<typeof reserveAuthorization>,
  current = () => true
): Promise<ConnectorOutcome> => {
  try {
    if (IS_ELECTRON || !outcome.ok || !outcome.url) return outcome;
    authorization.open(outcome.url);
    const deadline = Date.now() + 180_000;
    while (current() && !authorization.cancelled) {
      const statuses = await client.connectors.statuses({});
      if (statuses[connectorId]?.state === "connected") return { ok: true };
      if (Date.now() >= deadline)
        return { ok: false, error: "Authorization timed out. Please retry." };
      await new Promise<void>((resolve) => setTimeout(resolve, 3000));
    }
    return { ok: false, cancelled: true, error: "cancelled" };
  } finally {
    authorization.close();
  }
};
