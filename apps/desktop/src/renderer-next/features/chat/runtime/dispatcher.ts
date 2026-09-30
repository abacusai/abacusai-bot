/**
 * The wakeable dispatcher (spec 02 §3.4): one per generation, the client's
 * only source. The pump pushes `{ seq, event }` in seq order; `stream()` is
 * the adapter's `subscribe()`. `push`, `close` and the abort signal each
 * resolve one wake-up the stream awaits, so nothing waits behind an idle
 * server read.
 *
 * `ChatClient.consumeSubscription` processes each chunk synchronously before
 * it pulls the next, so "the generator resumed" means "the previous chunk
 * was processed": post-apply hooks run then, in consumer order.
 */
import type { StreamChunk } from "@tanstack/ai";

import { deferred, type Deferred } from "./deferred";

export interface DispatchItem {
  seq: number;
  event: StreamChunk;
}

export interface DispatcherHooks {
  /** Before the chunk is yielded: pre-apply store slices. */
  pre(item: DispatchItem): void;
  /** After the client processed it: terminal records, `appliedSeq`, readiness. */
  post(item: DispatchItem): void;
  error?(error: unknown): void;
}

export interface Dispatcher {
  push(item: DispatchItem): void;
  close(): void;
  stream(signal?: AbortSignal): AsyncGenerator<StreamChunk>;
  /** Items pushed and not yet yielded. */
  readonly pending: number;
}

export const createDispatcher = (hooks: DispatcherHooks): Dispatcher => {
  const queue: DispatchItem[] = [];
  let closed = false;
  let wake: Deferred<void> | null = null;
  const poke = (): void => wake?.resolve();

  async function* stream(signal?: AbortSignal): AsyncGenerator<StreamChunk> {
    const onAbort = (): void => poke();
    signal?.addEventListener("abort", onAbort);
    let previous: DispatchItem | null = null;
    try {
      for (;;) {
        // Resumed: the client processed `previous`.
        if (previous != null) {
          try {
            hooks.post(previous);
          } catch (error) {
            hooks.error?.(error);
          }
          previous = null;
        }
        if (signal?.aborted === true) return;
        const item = queue.shift();
        if (item != null) {
          try {
            hooks.pre(item);
          } catch (error) {
            hooks.error?.(error);
          }
          previous = item;
          yield item.event;
          continue;
        }
        if (closed) return;
        wake = deferred<void>();
        await wake.promise;
        wake = null;
      }
    } finally {
      signal?.removeEventListener("abort", onAbort);
      closed = true;
      queue.length = 0;
    }
  }

  return {
    push: (item) => {
      if (closed) return;
      queue.push(item);
      poke();
    },
    close: () => {
      closed = true;
      queue.length = 0;
      poke();
    },
    stream,
    get pending() {
      return queue.length;
    },
  };
};
