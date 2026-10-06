import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

import { followNotice } from "#renderer/data/queries/notices";
import type { AppQueryUtils } from "#renderer/data/transport";
import { IS_ELECTRON } from "#renderer/lib/platform";
import { useAppContext } from "#renderer/lib/use-app-context";

/** What a messaging change makes stale: snapshot, statuses, sender chats. */
const messagingKeys = (orpc: AppQueryUtils) => [
  orpc.messaging.snapshot.queryKey({ input: {} }),
  orpc.connectors.statuses.queryKey({ input: {} }),
  orpc.bots.senderChats.queryKey({ input: {} }),
];

/**
 * The library snapshots' notice streams and the table changes that feed
 * them (a table resync is not a notice).
 */
export const LibraryGlobals = () => {
  const { transport, db } = useAppContext();
  const cache = useQueryClient();
  useEffect(() => {
    const { orpc } = transport;
    const abort = new AbortController();
    const invalidate = (...keys: (readonly unknown[])[]) => {
      for (const queryKey of keys) void cache.invalidateQueries({ queryKey });
    };
    const messaging = () => invalidate(...messagingKeys(orpc));
    const memory = () => invalidate(orpc.memory.bots.queryKey({ input: {} }));
    followNotice("messaging", transport, messaging, abort.signal);
    followNotice("bots", transport, messaging, abort.signal);
    followNotice("memory", transport, memory, abort.signal);
    followNotice(
      "connectors",
      transport,
      (event) => {
        if (event.type === "status-changed")
          invalidate(
            orpc.connectors.statuses.queryKey({ input: {} }),
            orpc.mcp.list.queryKey({ input: { mode: "code" } })
          );
      },
      abort.signal
    );
    if (IS_ELECTRON) {
      followNotice(
        "browser",
        transport,
        (event) => {
          if (event.type === "status")
            cache.setQueryData(
              orpc.browser.status.queryKey({ input: {} }),
              event.status
            );
        },
        abort.signal
      );
      followNotice(
        "devices",
        transport,
        (event) => {
          if (event.type === "status" || event.type === "snapshot")
            cache.setQueryData(
              orpc.devices.status.queryKey({ input: {} }),
              event.status
            );
        },
        abort.signal
      );
    }
    const sessions = db.collections.sessions.subscribeChanges(messaging);
    const bots = db.collections.bots.subscribeChanges(memory);
    return () => {
      abort.abort();
      sessions.unsubscribe();
      bots.unsubscribe();
    };
  }, [transport, db, cache]);
  return null;
};
