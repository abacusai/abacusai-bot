import { getEventMeta } from "@orpc/client";

import { followNotices } from "#next/data/queries/live";
import type { Transport } from "#next/data/transport";
import type { RunFinishedNotice } from "#shared/contract/ai";
interface Feed {
  listeners: Set<(notice: RunFinishedNotice) => void | Promise<void>>;
  abort: AbortController;
}
const resumePoints = new WeakMap<Transport, string>();
const feeds = new WeakMap<Transport, Feed>();
/** Bots, sessions and routines share one resumed subscription per transport. */
export const subscribeRunFinished = (
  transport: Transport,
  listener: (notice: RunFinishedNotice) => void | Promise<void>
): (() => void) => {
  let feed = feeds.get(transport);
  if (!feed) {
    feed = { listeners: new Set(), abort: new AbortController() };
    feeds.set(transport, feed);
    const active = feed;
    let lastEventId = resumePoints.get(transport);
    let delivery = Promise.resolve();
    const queued = new Set<string>();
    void followNotices(
      transport,
      ({ signal }) =>
        transport.client.ai.runFinished(lastEventId ? { lastEventId } : {}, {
          signal,
        }),
      (notice) => {
        if (queued.has(notice.runId)) return;
        queued.add(notice.runId);
        const listeners = [...active.listeners];
        delivery = delivery
          .catch(() => {})
          .then(async () => {
            await Promise.all(listeners.map((fn) => fn(notice)));
            lastEventId = getEventMeta(notice as object)?.id ?? lastEventId;
            if (lastEventId) resumePoints.set(transport, lastEventId);
            if (queued.size > 10_000)
              queued.delete(queued.values().next().value!);
          });
        void delivery.catch((error) =>
          console.warn("Run notice delivery failed", error)
        );
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
