export type { ConnectStage } from "#renderer/features/shell/connect/services";
export const ConnectScreen = (
  _props: import("react").ComponentProps<
    typeof import("#renderer/features/shell/connect").ConnectScreen
  >
) => null;
export const resolveBrowserHost: typeof import("#renderer/features/shell/connect/services").resolveBrowserHost =
  async () => {
    throw new Error("Browser connection is unavailable on Electron");
  };
