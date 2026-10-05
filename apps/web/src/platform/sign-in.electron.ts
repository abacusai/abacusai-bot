import type { Transport } from "#renderer/data/transport";
import type { AppClient } from "#renderer/data/transport/types";
export const webSignIn: typeof import("#renderer/lib/browser/sign-in").webSignIn =
  async () => {
    throw new Error("Browser sign-in unavailable on Electron");
  };
/** Abacus sign-in: PKCE through main on Electron, the web handoff in browsers. */
export const signInAbacus = (
  transport: Transport,
  input: Parameters<AppClient["auth"]["abacus"]["start"]>[0]
) => transport.client.auth.abacus.start(input);
