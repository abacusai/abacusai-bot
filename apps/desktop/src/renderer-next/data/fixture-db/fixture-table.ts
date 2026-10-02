/**
 * An in-memory table that speaks the `db.*` wire protocol (spec 00 B.1):
 * `snapshot()` at a seq, `subscribe()` yielding `hello` then contiguous
 * change batches. Tests use it as the fake table; the dev fixture router
 * (./router.ts) serves it over the memory transport while main's own feeds
 * (spec 00 sub-slice B) are not there yet.
 *
 * Test controls: `failSnapshot`, `holdSnapshot()`, `reset()`, `endStreams()`,
 * `setEpoch()`.
 */
import type {
  Change,
  ChangeBatch,
  TablePosition,
  TableSnapshot,
} from "#shared/contract";

interface Subscriber<Row, Key> {
  push(batch: ChangeBatch<Row, Key>): void;
  end(): void;
}

const newEpoch = (): string =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `epoch-${Math.random().toString(36).slice(2)}`;

export class FixtureTable<Row extends object, Key extends string = string> {
  epoch = newEpoch();
  seq = 0;
  readonly rows = new Map<Key, Row>();
  private readonly subscribers = new Set<Subscriber<Row, Key>>();
  /** When set, `snapshot()` rejects with it. */
  failSnapshot: unknown = null;
  private snapshotGate: Promise<void> | null = null;

  constructor(
    readonly getKey: (row: Row) => Key,
    initial: readonly Row[] = []
  ) {
    for (const row of initial) this.rows.set(getKey(row), row);
  }

  async snapshot(): Promise<TableSnapshot<Row>> {
    if (this.snapshotGate !== null) await this.snapshotGate;
    if (this.failSnapshot != null) throw this.failSnapshot;
    return { epoch: this.epoch, seq: this.seq, rows: [...this.rows.values()] };
  }

  /** Park snapshots until the returned release is called. */
  holdSnapshot(): () => void {
    let release!: () => void;
    this.snapshotGate = new Promise<void>((resolve) => {
      release = () => {
        this.snapshotGate = null;
        resolve();
      };
    });
    return release;
  }

  /** `hello`, then every batch until the signal aborts or streams end. */
  async *subscribe(
    signal?: AbortSignal
  ): AsyncGenerator<ChangeBatch<Row, Key>, void, unknown> {
    const queue: Array<ChangeBatch<Row, Key>> = [
      { kind: "hello", epoch: this.epoch, seq: this.seq },
    ];
    let wake: (() => void) | null = null;
    let ended = false;
    const subscriber: Subscriber<Row, Key> = {
      push: (batch) => {
        queue.push(batch);
        wake?.();
      },
      end: () => {
        ended = true;
        wake?.();
      },
    };
    this.subscribers.add(subscriber);
    const onAbort = (): void => subscriber.end();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      while (true) {
        const next = queue.shift();
        if (next !== undefined) {
          yield next;
          continue;
        }
        if (ended || signal?.aborted) return;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        wake = null;
      }
    } finally {
      signal?.removeEventListener("abort", onAbort);
      this.subscribers.delete(subscriber);
    }
  }

  /** Publish one batch of changes; returns the position that carries it. */
  apply(changes: Array<Change<Row, Key>>): number {
    for (const change of changes) {
      if (change.type === "delete") this.rows.delete(change.key);
      else this.rows.set(change.key, change.value);
    }
    this.seq += 1;
    const batch: ChangeBatch<Row, Key> = {
      kind: "changes",
      epoch: this.epoch,
      seq: this.seq,
      changes,
    };
    for (const subscriber of this.subscribers) subscriber.push(batch);
    return this.seq;
  }

  upsert(row: Row): TablePosition<Key> {
    const key = this.getKey(row);
    const type = this.rows.has(key) ? "update" : "insert";
    const seq = this.apply([{ type, key, value: row }]);
    return { epoch: this.epoch, seq, key };
  }

  remove(key: Key): TablePosition<Key> {
    const seq = this.apply([{ type: "delete", key }]);
    return { epoch: this.epoch, seq, key };
  }

  /** Main's "your copy is invalid" (overflow): `reset`, then EOF. */
  reset(): void {
    this.seq += 1;
    for (const subscriber of this.subscribers) {
      subscriber.push({ kind: "reset", epoch: this.epoch, seq: this.seq });
      subscriber.end();
    }
  }

  /** A main restart: new epoch, streams end. */
  setEpoch(epoch = newEpoch()): void {
    this.epoch = epoch;
    this.seq = 0;
    this.endStreams();
  }

  endStreams(): void {
    for (const subscriber of this.subscribers) subscriber.end();
  }

  get subscriberCount(): number {
    return this.subscribers.size;
  }
}
