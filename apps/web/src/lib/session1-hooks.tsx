/**
 * The session-1 coin toss (the billing plan's `session1Hooks`): the arm read
 * and the picker beacon, shared by the composer chips and the bot picker.
 * The chat's retry line lives in features/chat/kit/session1-hooks.tsx. The
 * control arm and every paid plan get nothing from here.
 */
import { useQuery } from "@tanstack/react-query";
import { useEffect, useEffectEvent } from "react";

import { creditsTier } from "#renderer/lib/credits";
import { useAccount } from "#renderer/lib/use-account";
import { useAppContext } from "#renderer/lib/use-app-context";

/** The account is a free one in the hooks arm; false until the plan is read. */
export const useSession1Hooks = (): boolean => {
  const { transport } = useAppContext();
  const { data: account } = useAccount();
  const free = creditsTier(account) === "free";
  const { data: billing } = useQuery({
    ...transport.orpc.account.billingPlan.queryOptions({ input: {} }),
    enabled: free,
    staleTime: 60_000,
  });
  return free && billing?.session1Hooks === true;
};

/** Counts a picker opened with locked top-model rows, once per opening. Draws nothing. */
export const LockedShownBeacon = ({
  open,
  groups,
  where,
}: {
  open: boolean;
  groups: readonly { items: readonly { locked?: unknown }[] }[];
  where: "composer" | "picker";
}) => {
  const { transport } = useAppContext();
  const hooks = useSession1Hooks();
  const locked =
    open &&
    hooks &&
    groups.some((group) => group.items.some((item) => item.locked != null));
  const shown = useEffectEvent(() => {
    void transport.client.system
      .funnelStep({ step: "session1_locked_shown", detail: where })
      .catch(() => undefined);
  });
  useEffect(() => {
    if (locked) shown();
  }, [locked]);
  return null;
};
