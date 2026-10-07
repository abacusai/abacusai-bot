import { connectorById } from "@abacus-ai/connectors/registry";

import type { Db } from "#renderer/data/db";
import { DEFAULT_PREFS } from "#renderer/data/db/prefs";
import type { Transport } from "#renderer/data/transport";
import { ConnectAttempt } from "#renderer/lib/connect-page";
import { connectTarget } from "#renderer/lib/platform-system";

/** The step's pending connect; leaving the step cancels it. */
let waiting: ConnectAttempt | null = null;

export const cancelOnboardingConnect = (): void => {
  waiting?.cancel();
  waiting = null;
};

/** Pairing is deferred; enabling and persisting the queue happen on the click. */
export const connectOnboarding = async (
  db: Db,
  transport: Transport,
  id: string
) => {
  const connector = connectorById(id);
  if (connectTarget(id).kind === "pairing" && connector?.kind === "messaging") {
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
  // Inside the click, before any await.
  waiting?.cancel();
  const attempt = new ConnectAttempt(transport, id);
  waiting = attempt;
  try {
    const outcome = await attempt.result;
    if (!outcome.ok && !outcome.cancelled)
      throw new Error("connector-connect-failed");
    return outcome;
  } finally {
    if (waiting === attempt) waiting = null;
  }
};
