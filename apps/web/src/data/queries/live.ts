/**
 * The one place renderer opens a low-rate notice stream (spec 00 A.12):
 * `window.events`, `settings.events`, … Consumed as raw iterators with a
 * signal; a stream that ends or fails is reopened after a short delay while
 * the transport is open. (`experimental_liveOptions` would cache the last
 * event as query data; nothing here needs that yet.)
 */
import type { Transport } from "#renderer/data/transport";

const REOPEN_MS = 1_000;

/**
 * Codes a reopen cannot fix (a transport with no window, a procedure this
 * main does not serve): the loop stops instead of retrying every second for
 * the life of the document (Claude impl r1 #22).
 */
const FINAL_CODES: ReadonlySet<string> = new Set([
  "FORBIDDEN",
  "UNAUTHORIZED",
  "NOT_FOUND",
  "BAD_REQUEST",
  "METHOD_NOT_SUPPORTED",
]);

const isFinal = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  FINAL_CODES.has(String((error as { code?: unknown }).code));

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
    } catch (error) {
      // Reopened below unless it can never succeed; a closed transport
      // stops the loop.
      if (isFinal(error)) return;
    }
    if (signal.aborted || transport.state !== "open") return;
    await new Promise((resolve) => setTimeout(resolve, REOPEN_MS));
  }
};
