/**
 * One DB table's feed (spec 00 B.4): a cached baseline of rows, re-read and
 * diffed on `notify`, published as contiguous `{ epoch, seq }` batches to
 * every `changes()` subscriber.
 *
 * - `seq` starts at 0 per epoch and advances by exactly 1 per published
 *   batch (`changes` or `reset`). A diff that changes nothing publishes
 *   nothing and does not advance it.
 * - `snapshot()` re-diffs first, so its rows are current and its `seq` is the
 *   batch that made them so; a subscriber drops batches at or below it.
 * - A subscriber is registered before its `hello` is yielded, so every batch
 *   after `hello.seq` reaches it.
 * - Each subscriber's queue is lossless up to `MAX_PENDING_BATCHES`. Past
 *   that (a stuck renderer) its backlog is dropped, it is sent `reset`, and
 *   the stream ends with `RESYNC_REQUIRED`: the client re-snapshots on the
 *   reset and reopens on the error, so nothing is silently lost.
 *
 * No Electron and no services here: `read` and the triggers are injected.
 */
import { randomUUID } from "node:crypto";

import type {
  Change,
  ChangeBatch,
  Epoch,
  TableSnapshot,
} from "@abacus-ai/contract/contract/rows";

import { SubscriberQueue } from "../subscriber-queue";

export const MAX_PENDING_BATCHES = 5_000;

export interface TableFeedOptions<Row, Key extends string> {
  name: string;
  read: () => Row[];
  getKey: (row: Row) => Key;
  /** Defaults to comparing stable JSON. */
  equals?: (a: Row, b: Row) => boolean;
  /** Per-subscriber cap before the overflow reset (tests lower it). */
  maxPendingBatches?: number;
}

/** JSON with sorted object keys, so key order never reads as a change. */
export const stableJson = (value: unknown): string =>
  JSON.stringify(value, (_key, inner: unknown) => {
    if (inner == null || typeof inner !== "object" || Array.isArray(inner))
      return inner;
    return Object.fromEntries(
      Object.entries(inner as Record<string, unknown>).sort(([a], [b]) =>
        a < b ? -1 : a > b ? 1 : 0
      )
    );
  });

type Published<Row, Key> = ChangeBatch<Row, Key>;

export class TableFeed<Row, Key extends string = string> {
  readonly name: string;
  readonly epoch: Epoch = randomUUID();
  readonly #read: () => Row[];
  readonly #getKey: (row: Row) => Key;
  readonly #equals: (a: Row, b: Row) => boolean;
  readonly #maxPending: number;
  readonly #subscribers = new Set<SubscriberQueue<Published<Row, Key>>>();
  readonly #afterPublish = new Set<() => void>();
  readonly #activators = new Set<{
    activate: () => () => void;
    stop: (() => void) | null;
  }>();
  #rows: Map<Key, Row> | null = null;
  #seq = 0;
  #scheduled = false;

  constructor(options: TableFeedOptions<Row, Key>) {
    this.name = options.name;
    this.#read = options.read;
    this.#getKey = options.getKey;
    this.#equals =
      options.equals ?? ((a, b) => stableJson(a) === stableJson(b));
    this.#maxPending = options.maxPendingBatches ?? MAX_PENDING_BATCHES;
  }

  /** The seq of the last published batch. */
  get seq(): number {
    return this.#seq;
  }

  /** Live `changes()` streams; a leak shows as a count that never drops. */
  get subscriberCount(): number {
    return this.#subscribers.size;
  }

  /** Re-read and diff soon: at most once per event-loop turn. */
  notify(): void {
    if (this.#scheduled) return;
    this.#scheduled = true;
    setImmediate(() => {
      this.#scheduled = false;
      try {
        this.#diff();
      } catch (error) {
        // The baseline stays; the next notify or snapshot reads again.
        console.error(`[db] ${this.name} read failed`, error);
      }
    });
  }

  /** Re-read and diff now; the seq of the batch that holds any change. */
  notifyNow(): number {
    this.#diff();
    return this.#seq;
  }

  /** "Your copy is invalid": publish `reset` and re-baseline. */
  reset(): void {
    this.#rows = this.#readRows();
    this.#publish({ kind: "reset", epoch: this.epoch, seq: this.#seq + 1 });
  }

  snapshot(): TableSnapshot<Row> {
    this.#diff();
    return {
      epoch: this.epoch,
      seq: this.#seq,
      rows: Array.from(this.#baseline().values()),
    };
  }

  /**
   * Runs `activate` while this table has at least one `changes()`
   * subscriber, and its returned stop when the last one leaves: watchers
   * and clocks cost nothing while no renderer reads the table.
   */
  whileSubscribed(activate: () => () => void): () => void {
    const entry = { activate, stop: null as (() => void) | null };
    this.#activators.add(entry);
    if (this.#subscribers.size > 0) entry.stop = activate();
    return () => {
      this.#activators.delete(entry);
      entry.stop?.();
      entry.stop = null;
    };
  }

  /** Runs after every published batch (derived tables chain on this). */
  onPublish(listener: () => void): () => void {
    this.#afterPublish.add(listener);
    return () => {
      this.#afterPublish.delete(listener);
    };
  }

  async *subscribe(
    signal?: AbortSignal
  ): AsyncGenerator<Published<Row, Key>, void, unknown> {
    const stream = `db.${this.name}.changes`;
    const queue = new SubscriberQueue<Published<Row, Key>>({
      stream,
      delivery: "lossless-actionable",
      maxEvents: this.#maxPending,
    });
    // Registered before `hello`, so nothing after hello.seq is missed.
    this.#subscribers.add(queue);
    if (this.#subscribers.size === 1) this.#activate();
    try {
      yield { kind: "hello", epoch: this.epoch, seq: this.#seq };
      for (;;) {
        let result: IteratorResult<Published<Row, Key>, undefined>;
        try {
          result = await queue.next(signal);
        } catch (error) {
          // Overflowed: the backlog is gone. Tell the client its copy is
          // invalid, then end with the typed error so it reopens. The reset
          // reuses the feed's current seq (it is this subscriber's alone and
          // advances nothing): every batch this stream lost is at or below
          // it, so a client that has not seen it re-snapshots, and one whose
          // snapshot already reached it may drop it.
          yield { kind: "reset", epoch: this.epoch, seq: this.#seq };
          throw error;
        }
        if (result.done === true) return;
        yield result.value;
      }
    } finally {
      this.#detach(queue);
    }
  }

  #detach(queue: SubscriberQueue<Published<Row, Key>>): void {
    if (!this.#subscribers.delete(queue)) return;
    if (this.#subscribers.size === 0) this.#deactivate();
  }

  #activate(): void {
    for (const entry of this.#activators) {
      if (entry.stop != null) continue;
      try {
        entry.stop = entry.activate();
      } catch (error) {
        console.error(`[db] ${this.name} activation failed`, error);
      }
    }
  }

  #deactivate(): void {
    for (const entry of this.#activators) {
      const stop = entry.stop;
      entry.stop = null;
      try {
        stop?.();
      } catch (error) {
        console.error(`[db] ${this.name} deactivation failed`, error);
      }
    }
  }

  #baseline(): Map<Key, Row> {
    this.#rows ??= this.#readRows();
    return this.#rows;
  }

  #readRows(): Map<Key, Row> {
    const rows = new Map<Key, Row>();
    for (const row of this.#read()) rows.set(this.#getKey(row), row);
    return rows;
  }

  #diff(): void {
    if (this.#rows == null) {
      // Nothing was ever read, so nobody holds a copy to update; the first
      // snapshot reads it fresh.
      if (this.#subscribers.size > 0) this.#rows = this.#readRows();
      return;
    }
    const previous = this.#rows;
    const next = this.#readRows();
    const changes: Change<Row, Key>[] = [];
    for (const [key, value] of next) {
      const before = previous.get(key);
      if (before === undefined) changes.push({ type: "insert", key, value });
      else if (!this.#equals(before, value))
        changes.push({ type: "update", key, value });
      // Equal but not identical (a read-time stamp): keep what subscribers
      // hold, so a snapshot never differs from the batches before it.
      else next.set(key, before);
    }
    for (const key of previous.keys())
      if (!next.has(key)) changes.push({ type: "delete", key });
    this.#rows = next;
    if (changes.length === 0) return;
    this.#publish({
      kind: "changes",
      epoch: this.epoch,
      seq: this.#seq + 1,
      changes,
    });
  }

  #publish(batch: Published<Row, Key>): void {
    this.#seq = batch.seq;
    for (const queue of Array.from(this.#subscribers)) {
      queue.push(batch);
      // Overflowed: stop feeding it now; its reader ends with a reset.
      if (queue.failed) this.#detach(queue);
    }
    for (const listener of Array.from(this.#afterPublish)) {
      try {
        listener();
      } catch (error) {
        console.error(`[db] ${this.name} publish listener threw`, error);
      }
    }
  }
}
