import type { AppClient } from "#renderer/data/transport/types";

import { IS_ELECTRON } from "./platform";
export const platformSystem = (client: AppClient) =>
  IS_ELECTRON
    ? client.system
    : {
        ...client.system,
        openExternal: IS_ELECTRON
          ? client.system.openExternal
          : async ({ url }: { url: string }) => {
              if (/^(https?:|mailto:)/i.test(url))
                window.open(url, "_blank", "noopener,noreferrer");
            },
        notify: IS_ELECTRON
          ? client.system.notify
          : async (input: Parameters<AppClient["system"]["notify"]>[0]) =>
              (await import("./browser/notifications")).browserNotify(input),
        openPath: IS_ELECTRON
          ? client.system.openPath
          : async ({ path }: { path: string }) => {
              await (
                await import("./browser/files")
              ).viewHostFile(client, path);
              return { outcome: "opened" as const };
            },
        showItemInFolder: IS_ELECTRON
          ? client.system.showItemInFolder
          : async () => {},
        dialog: {
          ...client.system.dialog,
          openFolder: IS_ELECTRON
            ? client.system.dialog.openFolder
            : async () =>
                (await import("./browser/files")).pickHostFolder(client),
        },
      };

export const openSharedLink = async (
  client: AppClient,
  input: Parameters<AppClient["messaging"]["openSharedLink"]>[0]
): Promise<void> => {
  const url = await client.messaging.openSharedLink(input);
  if (!IS_ELECTRON && url) await platformSystem(client).openExternal({ url });
};
