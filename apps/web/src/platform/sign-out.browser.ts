import { webSignOut } from "#renderer/lib/browser/sign-out";
import { resetPaymentConfirmWatch } from "#renderer/lib/payment-confirming";
import type { RouterContext } from "#renderer/router";

export const signOutAbacus = (
  context: RouterContext,
  _keepOtherApiKeys: boolean
) => {
  // The payment watch was this account's.
  resetPaymentConfirmWatch();
  return webSignOut(context);
};
