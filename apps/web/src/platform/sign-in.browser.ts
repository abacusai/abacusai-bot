import type { Transport } from "#renderer/data/transport";
import { webSignIn } from "#renderer/lib/browser/sign-in";
export { webSignIn };
export const signInAbacus = (transport: Transport, _input: unknown) =>
  webSignIn(transport);
