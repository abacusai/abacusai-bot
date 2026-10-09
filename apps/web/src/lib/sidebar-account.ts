import type { AbacusAccountInfo } from "@abacus-ai/contract/contracts";
import { isPayingAbacusTier } from "@abacus-ai/contract/models";

import { accountTier, creditsTier } from "./credits";

export const sidebarAccount = (
  account: AbacusAccountInfo | null | undefined
) => {
  const tier = accountTier(account);
  const selfServe = isPayingAbacusTier(tier);
  const paid = selfServe || creditsTier(account) === "paid";
  const free = tier === "free";
  return {
    paid,
    billing: free
      ? "upgrade"
      : selfServe && (account?.org_user_count ?? 1) <= 1
        ? "manage"
        : null,
  } as const;
};
