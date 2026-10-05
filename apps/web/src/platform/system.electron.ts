import type { AppClient } from "#renderer/data/transport/types";
export const platformSystem = (client: AppClient) => client.system;
export const openSharedLink = async (
  client: AppClient,
  input: Parameters<AppClient["messaging"]["openSharedLink"]>[0]
): Promise<void> => {
  await client.messaging.openSharedLink(input);
};
