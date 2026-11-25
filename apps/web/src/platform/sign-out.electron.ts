import { tourSignedOut } from "#renderer/features/tour/store";
import { resetPaymentConfirmWatch } from "#renderer/lib/payment-confirming";
import type { RouterContext } from "#renderer/router";

export const signOutAbacus = async (
  context: RouterContext,
  keepOtherApiKeys: boolean
): Promise<void> => {
  await context.transport.client.auth.abacus.signOut({ keepOtherApiKeys });
  await context.transport.client.account.signOut({});
  tourSignedOut();
  // The payment watch was this account's.
  resetPaymentConfirmWatch();
  await context.credentialsChanged();
};
