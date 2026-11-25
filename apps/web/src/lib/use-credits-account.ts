import { useEffect } from "react";

import { usePrefs } from "#renderer/data/db/prefs";
import { useAccount } from "#renderer/lib/use-account";

/**
 * The account, read afresh when the credit wall lands so its counters are
 * the wall's. Only main lifts the wall (credit-wall.ts): a read moments after
 * it can still carry the platform's cached balance.
 */
export const useCreditsAccount = () => {
  const prefs = usePrefs();
  const account = useAccount();
  const { refetch } = account;
  useEffect(() => {
    if (prefs.creditsExhaustedAt === null) return;
    void refetch({ cancelRefetch: false });
  }, [prefs.creditsExhaustedAt, refetch]);
  return account;
};
