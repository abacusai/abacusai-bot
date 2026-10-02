/**
 * One event iterator's queue (spec 00 A.4.3). Events are filtered by the
 * iterator's own predicate before they get here, so only its own traffic can
 * fill it. What happens when the renderer falls behind depends on the
 * iterator's declared delivery class:
 *
 * - lossless-replayable: unbounded until `maxBytes` of pending data, then the
 *   stream ends with `RESYNC_REQUIRED`; the client resumes from an offset.
 * - lossless-actionable: unbounded until `maxEvents`, then the same; the
 *   client reopens and the first yield re-snapshots what is still pending.
 * - coalescing: an event with a coalesce key replaces a pending event with the
 *   same key, so the queue is bounded by the number of keys.
 *
 * An actionable iterator may also coalesce some of its event types (the
 * browser's cursor and status alongside its permission asks): any event whose
 * key is non-null coalesces, whatever the class.
 */
import { ORPCError } from "@orpc/server";

export type DeliveryClass =
  | "lossless-replayable"
  | "lossless-actionable"
  | "coalescing";

export const LOSSLESS_REPLAYABLE_MAX_BYTES = 8 * 1024 * 1024;
export const LOSSLESS_ACTIONABLE_MAX_EVENTS = 10_000;

export interface SubscriberQueueOptions<T> {
  /** Named in `RESYNC_REQUIRED`, so the client knows what to reopen. */
  stream: string;
  delivery: DeliveryClass;
  /** Non-null coalesces with any pending event of the same key. */
  coalesceKey?: (event: T) => string | null;
  /** The pending size of an event, for the byte cap. */
  sizeOf?: (event: T) => number;
  maxEvents?: number;
  maxBytes?: number;
}

interface Entry<T> {
  key: string | null;
  event: T;
  size: number;
}

export const resyncRequired = (stream: string): ORPCError<string, unknown> =>
  new ORPCError("RESYNC_REQUIRED", {
    status: 409,
    message: `The ${stream} subscriber fell too far behind; reopen it.`,
    data: { stream },
  });

export class SubscriberQueue<T> {
  readonly #options: SubscriberQueueOptions<T>;
  readonly #maxEvents: number;
  readonly #maxBytes: number;
  #entries: Entry<T>[] = [];
  #bytes = 0;
  #ended = false;
  #failure: unknown = null;
  #wake: (() => void) | null = null;

  constructor(options: SubscriberQueueOptions<T>) {
    this.#options = options;
    this.#maxEvents =
      options.maxEvents ??
      (options.delivery === "lossless-replayable"
        ? Number.POSITIVE_INFINITY
        : LOSSLESS_ACTIONABLE_MAX_EVENTS);
    this.#maxBytes =
      options.maxBytes ??
      (options.delivery === "lossless-replayable"
        ? LOSSLESS_REPLAYABLE_MAX_BYTES
        : Number.POSITIVE_INFINITY);
  }

  get pending(): number {
    return this.#entries.length;
  }

  get pendingBytes(): number {
    return this.#bytes;
  }

  get ended(): boolean {
    return this.#ended;
  }

  /** Ended by `fail` (an overflow): nothing more will be delivered. */
  get failed(): boolean {
    return this.#failure != null;
  }

  push(event: T): void {
    if (this.#ended) return;

    const key = this.#options.coalesceKey?.(event) ?? null;
    const size = this.#options.sizeOf?.(event) ?? 0;

    if (key != null) {
      const index = this.#entries.findIndex((entry) => entry.key === key);
      if (index !== -1) {
        const previous = this.#entries[index]!;
        this.#bytes += size - previous.size;
        this.#entries[index] = { key, event, size };
        this.#notify();
        return;
      }
    }

    this.#entries.push({ key, event, size });
    this.#bytes += size;

    if (this.#entries.length > this.#maxEvents || this.#bytes > this.#maxBytes)
      this.fail(resyncRequired(this.#options.stream));
    else this.#notify();
  }

  /** A benign end: what is queued is still delivered, then the stream returns. */
  end(): void {
    this.#ended = true;
    this.#notify();
  }

  /** Ends the stream with `error` once reached; what is queued is dropped. */
  fail(error: unknown): void {
    if (this.#failure != null) return;
    this.#failure = error;
    this.#entries = [];
    this.#bytes = 0;
    this.#ended = true;
    this.#notify();
  }

  /**
   * The next event, or done once ended and drained. Resolves done when
   * `signal` aborts, so a generator parked here can run its `finally`.
   */
  async next(signal?: AbortSignal): Promise<IteratorResult<T, undefined>> {
    for (;;) {
      if (this.#failure != null) throw this.#failure;
      if (signal?.aborted === true) return { done: true, value: undefined };

      const entry = this.#entries.shift();
      if (entry != null) {
        this.#bytes -= entry.size;
        return { done: false, value: entry.event };
      }
      if (this.#ended) return { done: true, value: undefined };

      await new Promise<void>((resolve) => {
        const onAbort = (): void => resolve();
        this.#wake = () => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        };
        signal?.addEventListener("abort", onAbort, { once: true });
      });
      this.#wake = null;
    }
  }

  #notify(): void {
    const wake = this.#wake;
    this.#wake = null;
    wake?.();
  }
}

/**
 * Drain `queue` as an async generator. `cleanup` runs exactly once, however
 * the stream ends: drained, failed, aborted, or returned early by the client.
 */
export async function* drain<T>(
  queue: SubscriberQueue<T>,
  signal: AbortSignal | undefined,
  cleanup: () => void
): AsyncGenerator<T, void, unknown> {
  try {
    for (;;) {
      const result = await queue.next(signal);
      if (result.done === true) return;
      yield result.value;
    }
  } finally {
    cleanup();
  }
}
