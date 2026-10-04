import type { BrowserRuntimeState } from "@abacus-ai/contract/contracts";

import type { Transport } from "#renderer/data/transport";

type Runtime = Transport["client"]["browser"]["runtime"];
interface Materialization {
  owners: number;
  promise: Promise<BrowserRuntimeState>;
  state?: BrowserRuntimeState;
}
const transports = new WeakMap<Transport, Map<string, Materialization>>();

/** A dock move can release a viewer before its replacement acquires the same lease. */
export const acquireLocalFile = (
  transport: Transport,
  input: Parameters<Runtime["materializeFile"]>[0]
) => {
  const runtime = transport.client.browser.runtime;
  let entries = transports.get(transport);
  if (!entries) {
    entries = new Map();
    transports.set(transport, entries);
  }
  const key = JSON.stringify([
    input.conversationKey,
    input.resourceId,
    input.filePath,
    input.hostRoot,
  ]);
  const existing = entries.get(key);
  const entry = existing ?? {
    owners: 0,
    promise: runtime.materializeFile(input),
  };
  const closeUnused = () => {
    if (entry.owners || !entry.state || entries.get(key) !== entry) return;
    entries.delete(key);
    void runtime.close(entry.state.lease).catch(() => {});
  };
  if (!existing) {
    entries.set(key, entry);
    void entry.promise.then(
      (state) => {
        entry.state = state;
        closeUnused();
      },
      () => {
        if (entries.get(key) === entry) entries.delete(key);
      }
    );
  }
  entry.owners++;
  let released = false;
  return {
    promise: entry.promise,
    release: () => {
      if (released) return;
      released = true;
      entry.owners--;
      // Let the replacement effect acquire an already materialized lease too.
      queueMicrotask(closeUnused);
    },
  };
};
