import type { AppClient } from "#renderer/data/transport/types";
export const platformSystem = (client: AppClient) => client.system;
export const openSharedLink = async (
  client: AppClient,
  input: Parameters<AppClient["messaging"]["openSharedLink"]>[0]
): Promise<void> => {
  await client.messaging.openSharedLink(input);
};
export const webSignIn: typeof import("#renderer/lib/browser/sign-in").webSignIn =
  async () => {
    throw new Error("Browser sign-in unavailable on Electron");
  };
export const uploadFiles: typeof import("#renderer/lib/browser/files").uploadFiles =
  async () => {
    throw new Error("Browser upload unavailable on Electron");
  };
export const viewHostFile: typeof import("#renderer/lib/browser/files").viewHostFile =
  async () => {
    throw new Error("Browser file viewer unavailable on Electron");
  };
export const claimBrowserAttention = async (_key: string) => false;
export const installBrowserAttention = () => {};
export const requestNotificationPermission = () => {};
export const markActivity = () => {};
export const installLease = (_connected: () => boolean) => () => {};
