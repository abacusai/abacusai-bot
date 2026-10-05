import type { Transport } from "#renderer/data/transport";
import type { AppClient } from "#renderer/data/transport/types";
export const platformSystem = (client: AppClient) => client.system;
export const openSharedLink = async (
  client: AppClient,
  input: Parameters<AppClient["messaging"]["openSharedLink"]>[0]
): Promise<void> => {
  await client.messaging.openSharedLink(input);
};
/** Abacus sign-in: PKCE through main on Electron, the web handoff in browsers. */
export const signInAbacus = (
  transport: Transport,
  input: Parameters<AppClient["auth"]["abacus"]["start"]>[0]
) => transport.client.auth.abacus.start(input);
