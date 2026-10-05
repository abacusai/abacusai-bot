import type { Root } from "react-dom/client";

import { getTransport } from "#renderer/data/transport";
import { ConnectScreen } from "#renderer/features/shell/connect";
import {
  resolveBrowserHost,
  type ConnectStage,
} from "#renderer/features/shell/connect/services";
import {
  installBrowserAttention,
  requestNotificationPermission,
} from "#renderer/lib/browser/notifications";

/** Browser boot: start and reach the host, showing each stage, then open the socket. */
export const connectHost = async (
  root: Root,
  restart: () => void,
  forceRestart: boolean
): Promise<void> => {
  installBrowserAttention();
  window.addEventListener("pointerdown", requestNotificationPermission, {
    once: true,
  });
  let stage: ConnectStage = "starting";
  try {
    await resolveBrowserHost((value) => {
      stage = value;
      root.render(<ConnectScreen stage={stage} restart={restart} />);
    }, forceRestart);
    await getTransport();
  } catch (error) {
    root.render(
      <ConnectScreen
        stage={stage}
        error={error instanceof Error ? error : new Error(String(error))}
        restart={restart}
      />
    );
    throw error;
  }
};
