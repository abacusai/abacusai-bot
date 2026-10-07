import { connectorById } from "@abacus-ai/connectors/registry";
import type {
  ConnectorConnectOptions,
  ConnectorOutcome,
} from "@abacus-ai/contract/contracts";

import type { AppClient } from "#renderer/data/transport/types";
import { pickHostFolder, viewHostFile } from "#renderer/lib/browser/files";
import { browserNotify } from "#renderer/lib/browser/notifications";
import { connectPagePath } from "#renderer/lib/connect-page";
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

/**
 * The connect page opens in a new tab before this returns, so call it before
 * any await in a click handler; popup blockers allow only that. The host is
 * still told, so it follows the connector until it connects. An MCP sign-in's
 * tab is taken now and sent to the host's start link once it answers.
 */
export const openConnectPage = (
  client: Pick<AppClient, "connectors">,
  connectorId: string,
  options?: ConnectorConnectOptions
): Promise<ConnectorOutcome> => {
  const entry = connectorById(connectorId);
  let tab: Window | null = null;
  if (entry?.kind === "platform")
    window.open(
      connectPagePath(entry.service, options?.hint),
      "_blank",
      "noopener"
    );
  else if (entry?.kind === "mcp") {
    tab = window.open("about:blank", "_blank");
    if (tab) tab.opener = null;
  }
  return client.connectors
    .connect({ connectorId, ...(options ? { options } : {}) })
    .then(
      (outcome): ConnectorOutcome => {
        const url = outcome.ok ? outcome.url : undefined;
        if (url && /^https?:/i.test(url)) {
          if (tab) tab.location.href = url;
          else window.open(url, "_blank", "noopener");
        } else tab?.close();
        return outcome.ok ? { ok: true } : outcome;
      },
      (error: unknown) => {
        tab?.close();
        throw error;
      }
    );
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
