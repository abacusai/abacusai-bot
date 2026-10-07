import { connectorById, connectUi } from "@abacus-ai/connectors/registry";
import type {
  ConnectorConnectOptions,
  ConnectorOutcome,
} from "@abacus-ai/contract/contracts";

import type { AppClient } from "#renderer/data/transport/types";
import { browserConnection } from "#renderer/features/shell/connect/services";
import { pickHostFolder, viewHostFile } from "#renderer/lib/browser/files";
import { browserNotify } from "#renderer/lib/browser/notifications";
import {
  connectPagePath,
  type ConnectTarget,
} from "#renderer/lib/connect-page";
type BrowserSystem = Pick<
  AppClient["system"],
  "openExternal" | "notify" | "openPath" | "showItemInFolder"
> & { dialog: Pick<AppClient["system"]["dialog"], "openFolder"> };

export const platformSystem = (client: AppClient): BrowserSystem => ({
  openExternal: async ({ url }) => {
    if (/^(https?:|mailto:)/i.test(url))
      window.open(url, "_blank", "noopener,noreferrer");
  },
  notify: browserNotify,
  openPath: async ({ path }) => {
    await viewHostFile(client, path);
    return { outcome: "opened" as const };
  },
  showItemInFolder: async () => {},
  dialog: { openFolder: () => pickHostFolder(client) },
});

/** The browser's answer: a page or the host's route for everything a tab can connect. */
export const connectTarget = (name: string, hint?: string): ConnectTarget => {
  const entry = connectorById(name);
  const ui = entry != null ? connectUi(entry) : "browser-hop";
  if (ui === "pairing" || ui === "fields") return { kind: ui };
  if (entry?.kind === "platform")
    return { kind: "connect-page", url: connectPagePath(entry.service, hint) };
  // A registry MCP server, or the user's own by its name.
  return {
    kind: "host-route",
    url: `${browserConnection().base}/mcp/connect/${encodeURIComponent(name)}`,
  };
};

/**
 * Opens the target's tab before this returns, so call it before any await in
 * a click handler; popup blockers allow only that. Null when the connector
 * does not connect in a tab. A connect page is also told to the host, so it
 * follows the connector until it connects; the host route follows its own.
 */
export const openConnectPage = (
  client: Pick<AppClient, "connectors">,
  name: string,
  options?: ConnectorConnectOptions
): Promise<ConnectorOutcome> | null => {
  const target = connectTarget(name, options?.hint);
  switch (target.kind) {
    case "connect-page":
      window.open(target.url, "_blank", "noopener");
      return client.connectors
        .connect({ connectorId: name, ...(options ? { options } : {}) })
        .then((outcome) => (outcome.ok ? { ok: true } : outcome));
    case "host-route":
      window.open(target.url, "_blank", "noopener");
      return Promise.resolve({ ok: true });
    default:
      return null;
  }
};

/** The tab is taken inside the click; the link fills it once the host answers. */
export const openSharedLink = async (
  client: AppClient,
  input: Parameters<AppClient["messaging"]["openSharedLink"]>[0]
): Promise<void> => {
  const tab = window.open("about:blank", "_blank");
  if (tab) tab.opener = null;
  try {
    const url = await client.messaging.openSharedLink(input);
    if (!url || !/^https?:/i.test(url)) tab?.close();
    else if (tab) tab.location.href = url;
    else window.open(url, "_blank", "noopener");
  } catch (error) {
    tab?.close();
    throw error;
  }
};
