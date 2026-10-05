import type { SettingsEvent, WindowEvent } from "@abacus-ai/contract/contract";
/**
 * `eventType → queryKey[]` (spec 01 §8.4; spec 00 A-T11): the table that
 * replaces the old renderer's refresh map. `useInvalidationBridge()` in
 * `__root` follows the notice streams it names and invalidates.
 */
import { useQueryClient, type QueryKey } from "@tanstack/react-query";
import { useEffect } from "react";

import type { AppQueryUtils, Transport } from "#renderer/data/transport";
import { IS_ELECTRON } from "#renderer/lib/platform";

import { followNotices } from "./live";
import { settingsKeys } from "./settings";
import { windowChromeQuery } from "./window";

type Notice =
  | { source: "window"; event: WindowEvent }
  | { source: "settings"; event: SettingsEvent };

/**
 * The keys a notice invalidates. Pure; tested as a table. A `chrome` notice
 * carries the whole state, written straight into the query: invalidating it
 * too would refetch `window.chrome` for nothing (Claude impl r1 #22).
 */
export const keysFor = (orpc: AppQueryUtils, notice: Notice): QueryKey[] => {
  if (notice.source === "window") return [];
  if (notice.event.type === "exec-backend") return execBackendKeys(orpc);
  if (notice.event.type === "credentials-changed")
    return Object.values(settingsKeys(orpc));
  return [];
};

const execBackendKeys = (orpc: AppQueryUtils): QueryKey[] => [
  orpc.settings.execBackend.get.queryOptions({ input: {} }).queryKey,
  orpc.settings.sandboxSupport.queryOptions({ input: {} }).queryKey,
];

export const useInvalidationBridge = (transport: Transport): void => {
  const queryClient = useQueryClient();
  useEffect(() => {
    const abort = new AbortController();
    const invalidate = (notice: Notice): void => {
      for (const queryKey of keysFor(transport.orpc, notice))
        void queryClient.invalidateQueries({ queryKey });
    };
    if (IS_ELECTRON)
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
    // `settings.events` has no snapshot: a notice sent while the stream was
    // down is lost, so every reopen invalidates what a notice could have.
    let opened = false;
    void followNotices(
      transport,
      async ({ signal }) => {
        const events = await transport.client.settings.events({}, { signal });
        if (opened)
          for (const queryKey of [
            ...Object.values(settingsKeys(transport.orpc)),
            ...execBackendKeys(transport.orpc),
          ])
            void queryClient.invalidateQueries({ queryKey });
        opened = true;
        return events;
      },
      (event) => invalidate({ source: "settings", event }),
      abort.signal
    );
    return () => abort.abort();
  }, [queryClient, transport]);
};
