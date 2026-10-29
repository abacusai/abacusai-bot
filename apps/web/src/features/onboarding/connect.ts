import { connectorById } from "@abacus-ai/connectors/registry";

import type { Db } from "#renderer/data/db";
import { DEFAULT_PREFS } from "#renderer/data/db/prefs";
import type { Transport } from "#renderer/data/transport";
import { ConnectAttempt } from "#renderer/lib/connect-page";
import { connectTarget } from "#renderer/lib/platform-system";

/** A connect that did not finish, with the outcome's reason for the step to show. */
export class ConnectFailed extends Error {}

/** The step's pending connect. */
let waiting: { id: string; attempt: ConnectAttempt } | null = null;

/** Leaving the step stops waiting; the host still finishes a sign-in left open in the browser. */
export const releaseOnboardingConnect = (): void => {
  waiting?.attempt.release();
  waiting = null;
};

/** The tile's Cancel: the host drops the connect too. */
export const cancelOnboardingConnect = (id: string): void => {
  if (waiting?.id !== id) return;
  waiting.attempt.cancel();
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
  waiting?.attempt.cancel();
  const attempt = new ConnectAttempt(transport, id);
  waiting = { id, attempt };
  try {
    const outcome = await attempt.result;
    if (!outcome.ok && !outcome.cancelled)
      throw new ConnectFailed(outcome.error);
    return outcome;
  } finally {
    if (waiting?.attempt === attempt) waiting = null;
  }
};
