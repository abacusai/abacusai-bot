/**
 * The onboarding offer test's arm (billing plan `onboardingOffer`): when the
 * platform puts the account's offer after its first result, onboarding holds
 * the plan offer screen back and stamps the held offer for the chat's card
 * (features/chat/kit/first-result-offer.tsx). Asked only where the screen
 * would show; a failed plan read keeps the screen, which goes on by itself.
 */
import type { QueryClient } from "@tanstack/react-query";

import type { Db } from "#renderer/data/db";
import { currentPrefs } from "#renderer/data/db/prefs";
import type { Transport } from "#renderer/data/transport";

export const holdOnboardingOffer = async (context: {
  transport: Transport;
  db: Db;
  queryClient: QueryClient;
}): Promise<boolean> => {
  const { transport, db, queryClient } = context;
  // Held once for this account: the screen never comes back for it.
  if (currentPrefs(db).dismissals.firstResultOffer != null) return true;
  let placement: string | undefined;
  try {
    const billing = await queryClient.ensureQueryData({
      ...transport.orpc.account.billingPlan.queryOptions({ input: {} }),
      retry: false,
    });
    placement = billing?.onboardingOffer;
  } catch {
    // Today's flow on a failed read: the screen itself goes on without a plan.
    return false;
  }
  if (placement !== "after_first_result") return false;
  await db.updatePrefs({
    dismissals: {
      firstResultOffer: { heldAt: Date.now(), shownOn: null, answered: null },
    },
  });
  void transport.client.system
    .funnelStep({ step: "onboarding_offer_held" })
    .catch(() => {});
  return true;
};
