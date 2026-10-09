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
  const personal =
    account?.org_user_count != null
      ? account.org_user_count <= 1
      : !account?.organization?.trim();
  return {
    paid,
    billing: free ? "upgrade" : selfServe && personal ? "manage" : null,
  } as const;
};
