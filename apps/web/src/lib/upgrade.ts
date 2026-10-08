import type { AppClient } from "#renderer/data/transport/types";

import { ABACUS_PLAN_URL } from "./abacus-links";
import { openPendingLink } from "./platform-system";

/**
 * Upgrade: the account's own upgrade page, asked for at click time (its link
 * is one-time and short-lived), or the plan page when the account has none.
 */
export const openUpgrade = (client: AppClient): Promise<void> =>
  openPendingLink(
    client,
    async () =>
      (await client.account.upgradeUrl({}).catch(() => null)) ?? ABACUS_PLAN_URL
  );
