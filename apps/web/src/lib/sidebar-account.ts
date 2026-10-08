import type { AbacusAccountInfo } from "@abacus-ai/contract/contracts";
import { isPayingAbacusTier } from "@abacus-ai/contract/models";

import { creditsTier } from "./credits";

export const sidebarAccount = (
  account: AbacusAccountInfo | null | undefined
) => {
  const tier = account?.subscription_tier?.trim().toLowerCase();
  const selfServe = isPayingAbacusTier(tier);
  const paid = selfServe || creditsTier(account) === "paid";
  const free = tier === "free";
  return {
    paid,
    free,
    plan: account?.plan?.trim() || account?.subscription_tier?.trim() || "",
    billing: free
      ? "upgrade"
      : selfServe && (account?.org_user_count ?? 1) <= 1
        ? "manage"
        : null,
  } as const;
};
