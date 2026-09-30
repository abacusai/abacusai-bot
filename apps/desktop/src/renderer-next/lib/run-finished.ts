import { getEventMeta } from "@orpc/client";

import { followNotices } from "#next/data/queries/live";
import type { Transport } from "#next/data/transport";
import type { RunFinishedNotice } from "#shared/contract/ai";
interface Feed {
  listeners: Set<(notice: RunFinishedNotice) => void>;
  abort: AbortController;
}
const feeds = new WeakMap<Transport, Feed>();
/** Both areas share one lossless resumed subscription in each document. */
export const subscribeRunFinished = (
  transport: Transport,
  listener: (notice: RunFinishedNotice) => void
): (() => void) => {
  let feed = feeds.get(transport);
  if (!feed) {
    feed = { listeners: new Set(), abort: new AbortController() };
    feeds.set(transport, feed);
    const active = feed;
    let lastEventId: string | undefined;
    void followNotices(
      transport,
      ({ signal }) =>
        transport.client.ai.runFinished(lastEventId ? { lastEventId } : {}, {
          signal,
        }),
      (notice) => {
        lastEventId = getEventMeta(notice as object)?.id ?? lastEventId;
        for (const fn of active.listeners) fn(notice);
      },
      feed.abort.signal
    );
  }
  feed.listeners.add(listener);
  const active = feed;
  return () => {
    active.listeners.delete(listener);
    if (active.listeners.size === 0) {
      active.abort.abort();
      feeds.delete(transport);
    }
  };
};
