import type { Transport } from "#renderer/data/transport";
import { webSignIn } from "#renderer/lib/browser/sign-in";
import { resetPaymentConfirmWatch } from "#renderer/lib/payment-confirming";
export const signInAbacus = (transport: Transport, _input: unknown) => {
  // A sign-in may bring another account: the payment watch was the last one's.
  resetPaymentConfirmWatch();
  return webSignIn(transport);
};
