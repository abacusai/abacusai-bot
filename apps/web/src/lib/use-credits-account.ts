import { useEffect, useEffectEvent } from "react";

import { usePrefs, useUpdatePrefs } from "#renderer/data/db/prefs";
import { creditMarkState } from "#renderer/lib/credits";
import { useAccount } from "#renderer/lib/use-account";

/** Share counters and deduplicate refreshes without caching an exhaustion marker. */
export const useCreditsAccount = () => {
  const prefs = usePrefs();
  const update = useUpdatePrefs();
  const account = useAccount();
  const clearFreshMark = useEffectEvent(
    (mark: number, data: typeof account.data) => {
      if (
        prefs.creditsExhaustedAt === mark &&
        creditMarkState(data, mark, Date.now(), true) === "clear"
      )
        void update({ creditsExhaustedAt: null }).catch(() => undefined);
    }
  );
  const { refetch } = account;
  useEffect(() => {
    const mark = prefs.creditsExhaustedAt;
    if (mark === null) return;
    let active = true;
    void refetch({ cancelRefetch: false }).then((result) => {
      if (active && !result.isError) clearFreshMark(mark, result.data);
    });
    return () => {
      active = false;
    };
  }, [prefs.creditsExhaustedAt, refetch]);
  return account;
};
