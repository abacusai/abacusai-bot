import { connectorById, connectUi } from "@abacus-ai/connectors/registry";

import type { Transport } from "#renderer/data/transport";
import type { AppClient } from "#renderer/data/transport/types";
import type { ConnectTarget } from "#renderer/lib/connect-target";
export const platformSystem = (client: AppClient) => client.system;
/** The desktop's answer: main mints platform links, and connects MCP servers itself. */
export const connectTarget = (name: string): ConnectTarget => {
  const entry = connectorById(name);
  const ui = entry != null ? connectUi(entry) : "browser-hop";
  if (ui === "pairing" || ui === "fields") return { kind: ui };
  return entry?.kind === "platform"
    ? { kind: "connect-link", opens: "external" }
    : { kind: "in-app" };
};

/** A link the host has to look up first, opened once it answers. */
export const openPendingLink = async (
  client: AppClient,
  resolve: () => Promise<string>
): Promise<void> => {
  await client.system.openExternal({ url: await resolve() });
};
/**
 * The upgrade page's way back once paid: `back=desktop` asks it to open the
 * app again (its abacusai-bot:// link) instead of the web app. Only the bot's
 * own page reads it; the plan page the account falls back to does not.
 */
export const withUpgradeReturn = (url: string): string => {
  // An unparseable link is left for openExternal to refuse.
  if (!URL.canParse(url)) return url;
  const parsed = new URL(url);
  if (!parsed.pathname.endsWith("/bot/link/upgrade")) return url;
  parsed.searchParams.set("back", "desktop");
  return parsed.toString();
};
/** Abacus sign-in: PKCE through main on Electron, the web handoff in browsers. */
export const signInAbacus = (
  transport: Transport,
  input: Parameters<AppClient["auth"]["abacus"]["start"]>[0]
) => transport.client.auth.abacus.start(input);
