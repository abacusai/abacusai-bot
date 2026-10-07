import { connectorById, connectUi } from "@abacus-ai/connectors/registry";
import type {
  ConnectorConnectOptions,
  ConnectorOutcome,
} from "@abacus-ai/contract/contracts";

import type { Transport } from "#renderer/data/transport";
import type { AppClient } from "#renderer/data/transport/types";
import type { ConnectTarget } from "#renderer/lib/connect-page";
export const platformSystem = (client: AppClient) => client.system;
/** The desktop's answer: main mints platform pages, and connects MCP servers itself. */
// The hint is main's to pass on; it travels with the connect call.
export const connectTarget = (name: string, _hint?: string): ConnectTarget => {
  const entry = connectorById(name);
  const ui = entry != null ? connectUi(entry) : "browser-hop";
  if (ui === "pairing" || ui === "fields") return { kind: ui };
  return entry?.kind === "platform"
    ? { kind: "connect-link" }
    : { kind: "in-app" };
};

/** Main hands back the platform connector's connect page; it opens in the default browser. Null otherwise. */
export const openConnectPage = (
  client: Pick<AppClient, "connectors" | "system">,
  name: string,
  options?: ConnectorConnectOptions
): Promise<ConnectorOutcome> | null => {
  if (connectTarget(name).kind !== "connect-link") return null;
  return client.connectors
    .connect({ connectorId: name, ...(options ? { options } : {}) })
    .then(async (outcome) => {
      if (!outcome.ok) return outcome;
      if (outcome.url) await client.system.openExternal({ url: outcome.url });
      return { ok: true };
    });
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
