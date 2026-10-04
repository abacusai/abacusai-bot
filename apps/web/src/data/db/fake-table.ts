/**
 * Test double for one `db.<table>`: main's wire protocol (hello → snapshot →
 * contiguous batches) with every step under the test's control. Each
 * `changes()` call is a connection the test can feed, end or fail; snapshots
 * answer at once from the server's state, or wait for the test to release
 * them.
 */
import type {
  Change,
  ChangeBatch,
  TablePosition,
  TableSnapshot,
} from "@abacus-ai/contract/contract/rows";

import type { IpcTableClient } from "./ipc-collection-options";

type Batch<Row> = ChangeBatch<Row, string>;

export interface FakeConnection<Row> {
  readonly signal: AbortSignal;
  readonly batches: Batch<Row>[];
  push(batch: Batch<Row>): void;
  /** A clean end (EOF), as after an overflow reset. */
  end(): void;
  fail(error: unknown): void;
  readonly closed: boolean;
}

interface Hold<Row> {
  resolve: (snapshot?: TableSnapshot<Row>) => void;
  reject: (error: unknown) => void;
}

export interface HeldSnapshot<Row> {
  /** The state captured when main was asked, or one given here. */
  release(override?: Partial<TableSnapshot<Row>>): void;
  fail(error: unknown): void;
  /** Resolves once the adapter has asked for this snapshot. */
  requested: Promise<void>;
}

type Handler = (input: unknown) => Promise<TablePosition<string>>;

export class FakeTable<Row extends { id: string }> {
  epoch = "epoch-1";
  seq = 0;
  readonly rows = new Map<string, Row>();
  readonly connections: FakeConnection<Row>[] = [];
  snapshotCalls = 0;
  readonly #holds: {
    hold: Hold<Row> | null;
    requested: () => void;
    install: (hold: Hold<Row>) => void;
  }[] = [];
  insertHandler: Handler | null = null;
  updateHandler: Handler | null = null;
  deleteHandler: Handler | null = null;

  constructor(rows: Row[] = []) {
    for (const row of rows) this.rows.set(row.id, row);
  }

  /** The latest connection. */
  get live(): FakeConnection<Row> {
    const connection = this.connections.at(-1);
    if (connection == null) throw new Error("no connection yet");
    return connection;
  }

  /** Apply changes to the server rows and publish them as the next batch. */
  change(changes: Change<Row, string>[]): Batch<Row> {
    for (const change of changes) {
      if (change.type === "delete") this.rows.delete(change.key);
      else this.rows.set(change.key, change.value);
    }
    this.seq += 1;
    const batch: Batch<Row> = {
      kind: "changes",
      epoch: this.epoch,
      seq: this.seq,
      changes,
    };
    this.broadcast(batch);
    return batch;
  }

  upsert(row: Row): Batch<Row> {
    const type = this.rows.has(row.id) ? "update" : "insert";
    return this.change([{ type, key: row.id, value: row }]);
  }

  remove(id: string): Batch<Row> {
    return this.change([{ type: "delete", key: id }]);
  }

  broadcast(batch: Batch<Row>): void {
    for (const connection of this.connections)
      if (!connection.closed) connection.push(batch);
  }

  /** Main restarted: a new epoch, seq 0, every stream ended. */
  restart(epoch: string): void {
    this.epoch = epoch;
    this.seq = 0;
    for (const connection of this.connections)
      if (!connection.closed) connection.end();
  }

  position(key: string): TablePosition<string> {
    return { epoch: this.epoch, seq: this.seq, key };
  }

  /** The next snapshot request waits for `release`. */
  holdSnapshot(): HeldSnapshot<Row> {
    let requested!: () => void;
    const requestedPromise = new Promise<void>((resolve) => {
      requested = resolve;
    });
    const slot = {
      hold: null as Hold<Row> | null,
      requested,
      install: (hold: Hold<Row>) => {
        slot.hold = hold;
      },
    };
    this.#holds.push(slot);
    return {
      requested: requestedPromise,
      release: (override) => {
        const captured = (slot as { captured?: TableSnapshot<Row> }).captured;
        slot.hold?.resolve(
          override == null ? captured : { ...captured!, ...override }
        );
      },
      fail: (error) => slot.hold?.reject(error),
    };
  }

  readonly client: IpcTableClient<Row, string> = {
    snapshot: async () => {
      this.snapshotCalls += 1;
      const captured: TableSnapshot<Row> = {
        epoch: this.epoch,
        seq: this.seq,
        rows: Array.from(this.rows.values()),
      };
      const slot = this.#holds.shift();
      if (slot == null) return captured;
      (slot as { captured?: TableSnapshot<Row> }).captured = captured;
      return new Promise<TableSnapshot<Row>>((resolve, reject) => {
        slot.install({
          resolve: (snapshot) => resolve(snapshot ?? captured),
          reject,
        });
        slot.requested();
      });
    },
    changes: async (_input, options) => {
      const connection = openConnection<Row>(options?.signal);
      this.connections.push(connection);
      // As main: registered, then hello at the current position.
      connection.push({ kind: "hello", epoch: this.epoch, seq: this.seq });
      return connection as FakeConnection<Row> & AsyncIterable<Batch<Row>>;
    },
    insert: (input: never) => this.#call(this.insertHandler, "insert", input),
    update: (input: never) => this.#call(this.updateHandler, "update", input),
    delete: (input: never) => this.#call(this.deleteHandler, "delete", input),
  };

  #call(
    handler: Handler | null,
    name: string,
    input: unknown
  ): Promise<TablePosition<string>> {
    if (handler == null) throw new Error(`no ${name} handler faked`);
    return handler(input);
  }
}

const openConnection = <Row>(
  signal: AbortSignal | undefined
): FakeConnection<Row> & AsyncIterable<Batch<Row>> => {
  const controller = new AbortController();
  const own = signal ?? controller.signal;
  const batches: Batch<Row>[] = [];
  const pending: Batch<Row>[] = [];
  let ended = false;
  let failure: { error: unknown } | null = null;
  let wake: (() => void) | null = null;
  const notify = (): void => {
    const resolve = wake;
    wake = null;
    resolve?.();
  };
  own.addEventListener("abort", notify);

  const connection = {
    signal: own,
    batches,
    get closed() {
      return ended || failure != null || own.aborted;
    },
    push: (batch: Batch<Row>) => {
      if (connection.closed) return;
      batches.push(batch);
      pending.push(batch);
      notify();
    },
    end: () => {
      ended = true;
      notify();
    },
    fail: (error: unknown) => {
      failure = { error };
      notify();
    },
    [Symbol.asyncIterator]: () => ({
      next: async (): Promise<IteratorResult<Batch<Row>>> => {
        for (;;) {
          if (own.aborted) {
            const error = new Error("aborted");
            error.name = "AbortError";
            throw error;
          }
          const batch = pending.shift();
          if (batch != null) return { done: false, value: batch };
          if (failure != null) throw failure.error;
          if (ended) return { done: true, value: undefined };
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        }
      },
      return: async (): Promise<IteratorResult<Batch<Row>>> => {
        ended = true;
        return { done: true, value: undefined };
      },
    }),
  };
  return connection;
};
