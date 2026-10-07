import { connectorById } from "@abacus-ai/connectors/registry";
import type { ConnectorOutcome } from "@abacus-ai/contract/contracts";

import type { Db } from "#renderer/data/db";
import { DEFAULT_PREFS } from "#renderer/data/db/prefs";
import type { Transport } from "#renderer/data/transport";
import { CONNECT_WAIT_MS, waitForConnected } from "#renderer/lib/connect-page";
import { openConnectPage } from "#renderer/lib/platform-system";

/** The step's pending connect; leaving the step stops waiting on it. */
let waiting: AbortController | null = null;

export const cancelOnboardingConnect = (): void => {
  waiting?.abort();
  waiting = null;
};

/** Pairing is deferred; enabling and persisting the queue happen on the click. */
export const connectOnboarding = async (
  db: Db,
  transport: Transport,
  id: string
) => {
  const connector = connectorById(id);
  // Opened inside the click, before any await.
  const opened = openConnectPage(transport.client, id);
  if (connector?.kind === "messaging") {
    await transport.client.messaging.updatePlatform({
      platformId: connector.platform,
      enabled: true,
    });
    const prefs = db.collections.prefs.get("app") ?? DEFAULT_PREFS;
    await db.updatePrefs({
      onboardingPairing: [
        ...new Set([...(prefs.onboardingPairing ?? []), connector.platform]),
      ],
    });
    return { ok: false, deferred: true } as const;
  }
  waiting?.abort();
  const abort = new AbortController();
  waiting = abort;
  const timer = setTimeout(() => abort.abort(), CONNECT_WAIT_MS);
  let outcome: ConnectorOutcome;
  try {
    if (opened != null) {
      outcome = await opened;
      if (outcome.ok)
        outcome = await waitForConnected(transport.client, id, abort.signal);
    } else
      outcome = await transport.client.connectors.connect(
        { connectorId: id },
        { signal: abort.signal }
      );
  } finally {
    clearTimeout(timer);
    if (waiting === abort) waiting = null;
  }
  if (!outcome.ok && !outcome.cancelled)
    throw new Error("connector-connect-failed");
  return outcome;
};
