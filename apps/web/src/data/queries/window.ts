import type { QueryClient } from "@tanstack/react-query";

import type { AppQueryUtils, Transport } from "#renderer/data/transport";
import { IS_ELECTRON } from "#renderer/lib/platform";

import { followNotice } from "./notices";

/**
 * The native chrome's state (spec 00-window-chrome §6): capability mode,
 * full screen, density and toolbar height. Kept current by `window.events`
 * `chrome` notices.
 */
export const windowChromeQuery = (orpc: AppQueryUtils) =>
  orpc.window.chrome.queryOptions({ input: {}, enabled: IS_ELECTRON });

export const windowStateQuery = (orpc: AppQueryUtils) =>
  orpc.window.state.queryOptions({ input: {}, enabled: IS_ELECTRON });

/**
 * Until `signal` aborts: a `chrome` notice carries the whole state, written
 * straight into the query; invalidating it too would refetch `window.chrome`
 * for nothing (Claude impl r1 #22). The stream also carries `state` notices,
 * so it is not one query's live value. Electron only: a host has no window.
 */
export const followWindowNotices = (
  transport: Transport,
  queryClient: Pick<QueryClient, "setQueryData">,
  signal: AbortSignal
): void => {
  if (!IS_ELECTRON) return;
  followNotice(
    "window",
    transport,
    (event) => {
      if (event.type === "chrome")
        queryClient.setQueryData(
          windowChromeQuery(transport.orpc).queryKey,
          event.chrome
        );
      else if (event.type === "state")
        queryClient.setQueryData(
          windowStateQuery(transport.orpc).queryKey,
          event.state
        );
    },
    signal
  );
};
