import { connectorById, connectUi } from "@abacus-ai/connectors/registry";

import type { Transport } from "#renderer/data/transport";
import type { AppClient } from "#renderer/data/transport/types";
import type { ConnectTarget } from "#renderer/lib/connect-target";
export const platformSystem = (client: AppClient) => client.system;
/**
 * The desktop's answer: main mints platform pages, and connects MCP servers
 * itself. The hint travels with the connect call instead.
 */
export const connectTarget = (name: string, _hint?: string): ConnectTarget => {
  const entry = connectorById(name);
  const ui = entry != null ? connectUi(entry) : "browser-hop";
  if (ui === "pairing" || ui === "fields") return { kind: ui };
  return entry?.kind === "platform"
    ? { kind: "connect-link" }
    : { kind: "in-app" };
};

export const openSharedLink = async (
  client: AppClient,
  input: Parameters<AppClient["messaging"]["openSharedLink"]>[0]
): Promise<void> => {
  await client.messaging.openSharedLink(input);
};
/** A link the host has to look up first, opened once it answers. */
export const openPendingLink = async (
  client: AppClient,
  resolve: () => Promise<string>
): Promise<void> => {
  await client.system.openExternal({ url: await resolve() });
};
/** Abacus sign-in: PKCE through main on Electron, the web handoff in browsers. */
export const signInAbacus = (
  transport: Transport,
  input: Parameters<AppClient["auth"]["abacus"]["start"]>[0]
) => transport.client.auth.abacus.start(input);
