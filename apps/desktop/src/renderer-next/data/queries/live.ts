/**
 * The one place renderer-next opens a low-rate notice stream (spec 00 A.12):
 * `window.events`, `settings.events`, … Consumed as raw iterators with a
 * signal; a stream that ends or fails is reopened after a short delay while
 * the transport is open. (`experimental_liveOptions` would cache the last
 * event as query data; nothing here needs that yet.)
 */
import type { Transport } from "#next/data/transport";

const REOPEN_MS = 1_000;

/**
 * Consume `open()`'s iterator until `signal` aborts, calling `onEvent` per
 * event. Resolves when aborted or when the transport closed.
 */
export const followNotices = async <T>(
  transport: Pick<Transport, "state">,
  open: (options: { signal: AbortSignal }) => Promise<AsyncIterable<T>>,
  onEvent: (event: T) => void,
  signal: AbortSignal
): Promise<void> => {
  while (!signal.aborted && transport.state === "open") {
    try {
      const events = await open({ signal });
      for await (const event of events) {
        if (signal.aborted) return;
        onEvent(event);
      }
    } catch {
      // Reopened below; a closed transport stops the loop.
    }
    if (signal.aborted || transport.state !== "open") return;
    await new Promise((resolve) => setTimeout(resolve, REOPEN_MS));
  }
};
