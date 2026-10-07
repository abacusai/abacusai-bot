import { connectorById, connectUi } from "@abacus-ai/connectors/registry";

import type { AppClient } from "#renderer/data/transport/types";
import { browserConnection } from "#renderer/features/shell/connect/services";
import { pickHostFolder, viewHostFile } from "#renderer/lib/browser/files";
import { browserNotify } from "#renderer/lib/browser/notifications";
import {
  connectPagePath,
  openTab,
  type ConnectTarget,
} from "#renderer/lib/connect-target";
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
    else openTab(url);
  } catch (error) {
    tab?.close();
    throw error;
  }
};
