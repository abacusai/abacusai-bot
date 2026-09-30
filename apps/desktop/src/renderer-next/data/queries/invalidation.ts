/**
 * `eventType → queryKey[]` (spec 01 §8.4; spec 00 A-T11): the table that
 * replaces the old renderer's refresh map. `useInvalidationBridge()` in
 * `__root` follows the notice streams it names and invalidates.
 */
import { useQueryClient, type QueryKey } from "@tanstack/react-query";
import { useEffect } from "react";

import type { AppQueryUtils, Transport } from "#next/data/transport";
import type { SettingsEvent, WindowEvent } from "#shared/contract";

import { followNotices } from "./live";
import { settingsKeys } from "./settings";
import { windowChromeQuery } from "./window";

export type Notice =
  | { source: "window"; event: WindowEvent }
  | { source: "settings"; event: SettingsEvent };

/** The keys a notice invalidates. Pure; tested as a table. */
export const keysFor = (orpc: AppQueryUtils, notice: Notice): QueryKey[] => {
  if (notice.source === "window")
    return notice.event.type === "chrome"
      ? [windowChromeQuery(orpc).queryKey]
      : [];
  if (notice.event.type === "credentials-changed") {
    const keys = settingsKeys(orpc);
    return [keys.providers, keys.account, keys.models];
  }
  return [];
};

export const useInvalidationBridge = (transport: Transport): void => {
  const queryClient = useQueryClient();
  useEffect(() => {
    const abort = new AbortController();
    const invalidate = (notice: Notice): void => {
      for (const queryKey of keysFor(transport.orpc, notice))
        void queryClient.invalidateQueries({ queryKey });
    };
    void followNotices(
      transport,
      ({ signal }) => transport.client.window.events({}, { signal }),
      (event) => {
        // The chrome state rides the notice: no round trip needed.
        if (event.type === "chrome")
          queryClient.setQueryData(
            windowChromeQuery(transport.orpc).queryKey,
            event.chrome
          );
        invalidate({ source: "window", event });
      },
      abort.signal
    );
    void followNotices(
      transport,
      ({ signal }) => transport.client.settings.events({}, { signal }),
      (event) => invalidate({ source: "settings", event }),
      abort.signal
    );
    return () => abort.abort();
  }, [queryClient, transport]);
};
