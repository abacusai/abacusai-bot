import { getEventMeta } from "@orpc/client";

import { followNotices } from "#renderer/data/queries/live";
import type { Transport } from "#renderer/data/transport";
import type { RunFinishedNotice } from "@abacus-ai/contract/contract/ai";

type Listener = (notice: RunFinishedNotice) => void | Promise<void>;
const feeds = new WeakMap<Transport, ReturnType<typeof createFeed>>();

const createFeed = (transport: Transport) => {
  const listeners = new Set<Listener>();
  const seen = new Set<string>();
  let abort: AbortController | null = null;
  let lastEventId: string | undefined;
  let delivery = Promise.resolve();
  return {
    subscribe(listener: Listener): () => void {
      listeners.add(listener);
      if (!abort) {
        abort = new AbortController();
        void followNotices(
          transport,
          ({ signal }) =>
            transport.client.ai.runFinished(
              lastEventId ? { lastEventId } : {},
              {
                signal,
              }
            ),
          (notice) => {
            if (seen.has(notice.runId)) return;
            seen.add(notice.runId);
            const recipients = [...listeners];
            delivery = delivery
              .catch(() => {})
              .then(async () => {
                await Promise.all(
                  recipients.map(async (receive) => {
                    try {
                      await receive(notice);
                    } catch (error) {
                      console.warn("[run-finished] consumer failed", error);
                    }
                  })
                );
                lastEventId = getEventMeta(notice as object)?.id ?? lastEventId;
                if (seen.size > 10_000)
                  seen.delete(seen.values().next().value!);
              });
            void delivery.catch((error) =>
              console.warn("Run notice delivery failed", error)
            );
          },
          abort.signal
        );
      }
      let subscribed = true;
      return () => {
        if (!subscribed) return;
        subscribed = false;
        listeners.delete(listener);
        if (!listeners.size) {
          abort?.abort();
          abort = null;
        }
      };
    },
  };
};

/** Bots, sessions, routines and notch share one stream and persistent resume state. */
export const runFinishedFeed = (transport: Transport) => {
  let feed = feeds.get(transport);
  if (!feed) {
    feed = createFeed(transport);
    feeds.set(transport, feed);
  }
  return feed;
};

export const subscribeRunFinished = (
  transport: Transport,
  listener: Listener
): (() => void) => runFinishedFeed(transport).subscribe(listener);
