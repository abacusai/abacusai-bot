import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

import { followNotices } from "#next/data/queries/live";
import { useAppContext } from "#next/lib/use-app-context";
/** Library snapshots have separate notice streams; table resync is not a notice. */
export const LibraryGlobals = () => {
  const { transport, db } = useAppContext();
  const cache = useQueryClient();
  useEffect(() => {
    const abort = new AbortController();
    const invalidate = (key: readonly unknown[]) =>
      void cache.invalidateQueries({ queryKey: key });
    const messaging = () => {
      invalidate(transport.orpc.messaging.snapshot.queryKey({ input: {} }));
      invalidate(transport.orpc.connectors.statuses.queryKey({ input: {} }));
      invalidate(transport.orpc.bots.senderChats.queryKey());
    };
    void followNotices(
      transport,
      ({ signal }) => transport.client.messaging.events({}, { signal }),
      messaging,
      abort.signal
    );
    void followNotices(
      transport,
      ({ signal }) => transport.client.connectors.events({}, { signal }),
      (event) => {
        if (event.type === "status-changed") {
          invalidate(
            transport.orpc.connectors.statuses.queryKey({ input: {} })
          );
          invalidate(
            transport.orpc.mcp.list.queryKey({ input: { mode: "code" } })
          );
        }
      },
      abort.signal
    );
    void followNotices(
      transport,
      ({ signal }) => transport.client.memory.events({}, { signal }),
      () => invalidate(transport.orpc.memory.bots.queryKey({ input: {} })),
      abort.signal
    );
    void followNotices(
      transport,
      ({ signal }) => transport.client.browser.events({}, { signal }),
      (event) => {
        if (event.type === "status")
          cache.setQueryData(
            transport.orpc.browser.status.queryKey({ input: {} }),
            event.status
          );
      },
      abort.signal
    );
    void followNotices(
      transport,
      ({ signal }) => transport.client.devices.events({}, { signal }),
      (event) => {
        if (event.type === "status" || event.type === "snapshot")
          cache.setQueryData(
            transport.orpc.devices.status.queryKey({ input: {} }),
            event.status
          );
      },
      abort.signal
    );
    void followNotices(
      transport,
      ({ signal }) => transport.client.settings.events({}, { signal }),
      (event) => {
        if (event.type === "credentials-changed") {
          invalidate(transport.orpc.connectors.statuses.key());
          invalidate(transport.orpc.models.list.key());
          invalidate(transport.orpc.settings.keys.listProviders.key());
        }
      },
      abort.signal
    );
    void followNotices(
      transport,
      ({ signal }) => transport.client.bots.events({}, { signal }),
      messaging,
      abort.signal
    );
    const sessions = db.collections.sessions.subscribeChanges(messaging);
    const unsubscribe = db.collections.bots.subscribeChanges(() =>
      invalidate(transport.orpc.memory.bots.queryKey({ input: {} }))
    );
    return () => {
      abort.abort();
      unsubscribe.unsubscribe();
      sessions.unsubscribe();
    };
  }, [transport, db, cache]);
  return null;
};
