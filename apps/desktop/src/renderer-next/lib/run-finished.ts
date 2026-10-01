import { getEventMeta } from "@orpc/client";

import { followNotices } from "#next/data/queries/live";
import type { Transport } from "#next/data/transport";
import type { RunFinishedNotice } from "#shared/contract/ai";
/** One stream per transport for consumers that opt into this public fan-out. */
const resumePoints = new WeakMap<Transport, string>();
const sources = new WeakMap<
  Transport,
  {
    listeners: Set<(notice: RunFinishedNotice) => void>;
    abort: AbortController;
  }
>();
export const subscribeRunFinished = (
  transport: Transport,
  listener: (notice: RunFinishedNotice) => void
) => {
  let source = sources.get(transport);
  if (!source) {
    source = { listeners: new Set(), abort: new AbortController() };
    sources.set(transport, source);
    const live = source;
    let lastEventId: string | undefined = resumePoints.get(transport);
    void followNotices(
      transport,
      ({ signal }) =>
        transport.client.ai.runFinished(lastEventId ? { lastEventId } : {}, {
          signal,
        }),
      (notice) => {
        lastEventId = getEventMeta(notice as object)?.id ?? lastEventId;
        if (lastEventId) resumePoints.set(transport, lastEventId);
        for (const fn of live.listeners) fn(notice);
      },
      source.abort.signal
    );
  }
  source.listeners.add(listener);
  const current = source;
  return () => {
    current.listeners.delete(listener);
    if (!current.listeners.size) {
      current.abort.abort();
      sources.delete(transport);
    }
  };
};
