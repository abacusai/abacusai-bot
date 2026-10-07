import type {
  ConnectorConnectOptions,
  ConnectorOutcome,
} from "@abacus-ai/contract/contracts";

import type { Transport } from "#renderer/data/transport";
import type { AppClient } from "#renderer/data/transport/types";
export const platformSystem = (client: AppClient) => client.system;
/** Main hands back the platform connector's connect page; it opens in the default browser. */
export const openConnectPage = async (
  client: Pick<AppClient, "connectors" | "system">,
  connectorId: string,
  options?: ConnectorConnectOptions
): Promise<ConnectorOutcome> => {
  const outcome = await client.connectors.connect({
    connectorId,
    ...(options ? { options } : {}),
  });
  if (!outcome.ok) return outcome;
  if (outcome.url) await client.system.openExternal({ url: outcome.url });
  return { ok: true };
};
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
