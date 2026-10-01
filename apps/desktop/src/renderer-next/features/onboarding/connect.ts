import { connectorById } from "@abacus-ai/connectors/registry";

import type { Db } from "#next/data/db";
import { DEFAULT_PREFS } from "#next/data/db/prefs";
import type { Transport } from "#next/data/transport";

/** Pairing is deferred; enabling and persisting the queue happen on the click. */
export const connectOnboarding = async (
  db: Db,
  transport: Transport,
  id: string
) => {
  const connector = connectorById(id);
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
  const abort = new AbortController();
  const timer = setTimeout(() => {
    abort.abort();
    void transport.client.connectors.cancelConnect({});
  }, 180_000);
  let outcome;
  try {
    outcome = await transport.client.connectors.connect(
      { connectorId: id },
      { signal: abort.signal }
    );
  } finally {
    clearTimeout(timer);
  }
  if (!outcome.ok && !outcome.cancelled)
    throw new Error("connector-connect-failed");
  return outcome;
};
