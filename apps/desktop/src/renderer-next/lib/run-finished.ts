import { getEventMeta } from "@orpc/client";

import { followNotices } from "#next/data/queries/live";
import type { Transport } from "#next/data/transport";
import type { RunFinishedNotice } from "#shared/contract";
const feeds = new WeakMap<Transport, ReturnType<typeof createFeed>>();
const createFeed = (transport: Transport) => {
  const listeners = new Set<(notice: RunFinishedNotice) => void>();
  let abort: AbortController | null = null;
  let lastEventId: string | undefined;
  const seen = new Set<string>();
  return {
    subscribe(listener: (notice: RunFinishedNotice) => void): () => void {
      listeners.add(listener);
      if (!abort) {
        abort = new AbortController();
        void followNotices(
          transport,
          ({ signal }) =>
            transport.client.ai.runFinished(
              lastEventId ? { lastEventId } : {},
              { signal }
            ),
          (notice) => {
            lastEventId = getEventMeta(notice as object)?.id ?? lastEventId;
            if (seen.has(notice.runId)) return;
            seen.add(notice.runId);
            if (seen.size > 500) seen.delete(seen.values().next().value!);
            for (const receive of listeners) {
              try {
                receive(notice);
              } catch (error) {
                console.warn("[run-finished] consumer failed", error);
              }
            }
          },
          abort.signal
        );
      }
      return () => {
        listeners.delete(listener);
        if (!listeners.size) {
          abort?.abort();
          abort = null;
        }
      };
    },
  };
};
export const runFinishedFeed = (transport: Transport) => {
  let feed = feeds.get(transport);
  if (!feed) {
    feed = createFeed(transport);
    feeds.set(transport, feed);
  }
  return feed;
};

/** All completion consumers share the same resumable stream. */
export const subscribeRunFinished = (
  transport: Transport,
  listener: (notice: RunFinishedNotice) => void
): (() => void) => runFinishedFeed(transport).subscribe(listener);
