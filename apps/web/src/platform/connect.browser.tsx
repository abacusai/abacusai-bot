import type { Root } from "react-dom/client";

import { untilOpen } from "#renderer/data/queries/live";
import { createHostTransport } from "#renderer/data/transport/websocket";
import { ConnectScreen } from "#renderer/features/shell/connect";
import {
  hostConnection,
  identifyHost,
  runHostConnection,
  setPageTransport,
} from "#renderer/features/shell/connect/services";
import {
  installBrowserAttention,
  requestNotificationPermission,
} from "#renderer/lib/browser/notifications";

/**
 * Browser boot: identify the user's host, then open the page's one host
 * transport (spec 09 D2) and wait for its first socket, showing each stage.
 * The connection loop keeps replacing dropped sockets for the life of the
 * page; the transport closes only on a sign-in, tier or contract refusal.
 */
export const connectHost = async (
  root: Root,
  restart: () => void,
  forceRestart: boolean
): Promise<void> => {
  installBrowserAttention();
  window.addEventListener("pointerdown", requestNotificationPermission, {
    once: true,
  });
  const show = (): void => {
    const { stage, error } = hostConnection.state;
    root.render(
      <ConnectScreen
        stage={stage === "open" ? "connecting" : stage}
        error={error}
        restart={restart}
      />
    );
  };
  let identity;
  try {
    identity = await identifyHost();
  } catch (error) {
    root.render(
      <ConnectScreen
        stage="starting"
        error={error instanceof Error ? error : new Error(String(error))}
        restart={restart}
      />
    );
    throw error;
  }
  // No sign-in gate holds writes yet: they go out as soon as a socket does.
  const transport = createHostTransport({
    writesConfirmed: true,
    reauthorize: false,
  });
  setPageTransport(transport);
  const shown = hostConnection.subscribe(show);
  show();
  void runHostConnection(transport, identity, { forceRestart });
  const open = await untilOpen(transport);
  shown.unsubscribe();
  if (!open) {
    show();
    throw hostConnection.state.error ?? new Error("The host refused the page");
  }
};
