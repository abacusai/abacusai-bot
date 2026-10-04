import type { AppClient } from "#renderer/data/transport/types";
import { reserveAuthorization } from "#renderer/lib/browser/authorization";
type BrowserSystem = Pick<
  AppClient["system"],
  "openExternal" | "notify" | "openPath" | "showItemInFolder"
> & { dialog: Pick<AppClient["system"]["dialog"], "openFolder"> };

export const platformSystem = (client: AppClient): BrowserSystem => ({
  openExternal: async ({ url }) => {
    if (/^(https?:|mailto:)/i.test(url))
      window.open(url, "_blank", "noopener,noreferrer");
  },
  notify: async (input) =>
    (await import("#renderer/lib/browser/notifications")).browserNotify(input),
  openPath: async ({ path }) => {
    await (
      await import("#renderer/lib/browser/files")
    ).viewHostFile(client, path);
    return { outcome: "opened" as const };
  },
  showItemInFolder: async () => {},
  dialog: {
    openFolder: async () =>
      (await import("#renderer/lib/browser/files")).pickHostFolder(client),
  },
});

export const openSharedLink = async (
  client: AppClient,
  input: Parameters<AppClient["messaging"]["openSharedLink"]>[0]
): Promise<void> => {
  const authorization = reserveAuthorization();
  try {
    const url = await client.messaging.openSharedLink(input);
    if (url) authorization.open(url);
    else authorization.close();
  } catch (error) {
    authorization.close();
    throw error;
  }
};
