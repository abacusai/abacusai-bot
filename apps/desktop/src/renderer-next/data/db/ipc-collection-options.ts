/**
 * TanStack DB collection options over one `db.<table>` (spec 00 B.3): a
 * custom `sync` that mirrors main's table through its `hello` → snapshot →
 * contiguous `{ epoch, seq }` batches, and mutation handlers that resolve
 * once main's echo of the write has been received.
 *
 * The sync, per connection generation:
 *
 * 1. Open `changes()` and read it at once. Every batch after `hello` is
 *    buffered until this connection has applied a snapshot.
 * 2. On `hello`: a new epoch (first connect, or main restarted) resets both
 *    positions. Then load a snapshot.
 * 3. Snapshot: discarded if its epoch is not the stream's or its connection
 *    was replaced. Otherwise `begin`, `truncate` when a copy is already held,
 *    one write per row, `commit`, then flush the buffer (epoch first, then
 *    drop `seq <= received`, then apply in order), then `markReady` while
 *    loading or errored.
 * 4. A batch: another epoch reopens; `reset` or a gap resyncs (single
 *    flight); an old seq is dropped; the next one is applied.
 * 5. A stream error or an end we did not ask for reopens, with backoff.
 *
 * Positions: `received` is the highest seq committed to the collection's
 * sync queue; `applied` the highest whose commit is visible. Mutation
 * handlers wait for *received*: while a handler runs its own transaction is
 * persisting, and TanStack holds every synced commit until it settles, so
 * waiting for *applied* would deadlock. `awaitApplied` is for loaders.
 *
 * No Electron: the table client comes from the transport.
 */
import type {
  ChangeMessageOrDeleteKeyMessage,
  CollectionConfig,
  SyncConfig,
  UtilsRecord,
} from "@tanstack/db";

import type {
  ChangeBatch,
  TablePosition,
  TableSnapshot,
} from "#shared/contract/rows";

/** What `transport.client.db.<table>` offers; mutations only where they exist. */
export interface IpcTableClient<Row, Key extends string> {
  snapshot(
    input?: Record<string, never>,
    options?: { signal?: AbortSignal }
  ): Promise<TableSnapshot<Row>>;
  changes(
    input?: Record<string, never>,
    options?: { signal?: AbortSignal }
  ): Promise<AsyncIterable<ChangeBatch<Row, Key>>>;
  insert?(input: never): Promise<TablePosition<Key>>;
  update?(input: never): Promise<TablePosition<Key>>;
  delete?(input: never): Promise<TablePosition<Key>>;
}

export type TablePositionLike = { epoch: string; seq: number };

export type SyncState = "connecting" | "live" | "resyncing";

export interface IpcCollectionStatus {
  epoch: string | null;
  receivedSeq: number;
  appliedSeq: number;
  /** Connection generation: +1 per `changes()` opened. */
  connection: number;
  state: SyncState;
}

export interface IpcCollectionUtils extends UtilsRecord {
  /** Main's batch at `pos` is in the sync queue (mutation echo). */
  awaitReceived(pos: TablePositionLike): Promise<void>;
  /** Main's batch at `pos` is visible in the collection (loaders, tests). */
  awaitApplied(pos: TablePositionLike): Promise<void>;
  /** Re-snapshot now; resolves once the snapshot is received. */
  resync(): Promise<void>;
  status(): IpcCollectionStatus;
}

export interface IpcCollectionConfig<Row extends object, Key extends string> {
  /** "sessions", …; also the collection id. */
  id: string;
  /** Resolves `transport.client.db.<table>`; called per connection. */
  table: () => Promise<IpcTableClient<Row, Key>>;
  getKey: (row: Row) => Key;
  toInsertInput?: (row: Row) => unknown;
  toUpdateInput?: (key: Key, changes: Partial<Row>, modified: Row) => unknown;
  toDeleteInput?: (key: Key, original: Row) => unknown;
  /** How long a handler waits for its echo before it resyncs. */
  echoTimeoutMs?: number;
  /** Sync on creation (the shell's tables), not on first use. */
  startSync?: boolean;
  /** Delay before reconnect attempt `n` (0-based) after an error or EOF. */
  retryDelayMs?: (attempt: number) => number;
}

export type IpcCollectionOptions<
  Row extends object,
  Key extends string,
> = CollectionConfig<Row, Key, never, IpcCollectionUtils> & {
  utils: IpcCollectionUtils;
};

export const DEFAULT_ECHO_TIMEOUT_MS = 10_000;

/** 0.5 s, 1 s, 2 s, then every 5 s. */
export const defaultRetryDelayMs = (attempt: number): number =>
  [500, 1_000, 2_000][attempt] ?? 5_000;

const abortError = (): Error => {
  const error = new Error("The collection's sync was cleaned up");
  error.name = "AbortError";
  return error;
};

class EchoTimeout extends Error {}

interface Waiter {
  epoch: string;
  seq: number;
  resolve: () => void;
  reject: (error: unknown) => void;
}

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
}

const deferred = (): Deferred => {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // A waiter nobody awaits must not surface as an unhandled rejection.
  promise.catch(() => undefined);
  return { promise, resolve, reject };
};

type Batch<Row, Key> = ChangeBatch<Row, Key>;
type Applied = "ok" | "resync" | "reopen";

interface Connection<Row, Key> {
  generation: number;
  abort: AbortController;
  /** Batches held while no snapshot has been applied (or a resync runs). */
  buffering: boolean;
  buffer: Batch<Row, Key>[];
  /** The in-flight snapshot load: single flight per connection. */
  loading: Promise<void> | null;
  /** Hello seen on this connection: a snapshot may be loaded. */
  helloed: boolean;
  /** Closed by us to reopen at once (epoch mismatch), not by a failure. */
  deliberate: boolean;
}

export function ipcCollectionOptions<Row extends object, Key extends string>(
  config: IpcCollectionConfig<Row, Key>
): IpcCollectionOptions<Row, Key> {
  const echoTimeoutMs = config.echoTimeoutMs ?? DEFAULT_ECHO_TIMEOUT_MS;
  const retryDelayMs = config.retryDelayMs ?? defaultRetryDelayMs;

  // Positions outlive a sync session only as far as the waiters go; each
  // `sync()` call (a restart after cleanup) starts from nothing.
  let epoch: string | null = null;
  let receivedSeq = -1;
  let appliedSeq = -1;
  let connectionCount = 0;
  let state: SyncState = "connecting";
  /** Epochs this collection has been in, to tell an old one from a new one. */
  const seenEpochs = new Set<string>();
  /** The epoch whose snapshot has been received / applied. */
  let snapshotReceivedEpoch: string | null = null;
  let snapshotAppliedEpoch: string | null = null;
  let receivedWaiters: Waiter[] = [];
  let appliedWaiters: Waiter[] = [];
  let snapshotWaiters: Deferred[] = [];
  /** The live session's resync, or null between sessions. */
  let requestResync: (() => void) | null = null;

  /**
   * A waiter's position is reached, or it belongs to an epoch this
   * collection has left and the current epoch's snapshot (authoritative,
   * whether or not the old write survived) is in.
   */
  const reached = (
    waiter: Waiter,
    seq: number,
    snapshotEpoch: string | null
  ): boolean =>
    waiter.epoch === epoch
      ? seq >= waiter.seq
      : seenEpochs.has(waiter.epoch) &&
        epoch != null &&
        snapshotEpoch === epoch;

  const settleReceived = (): void => {
    receivedWaiters = receivedWaiters.filter((waiter) => {
      if (!reached(waiter, receivedSeq, snapshotReceivedEpoch)) return true;
      waiter.resolve();
      return false;
    });
  };

  const settleApplied = (): void => {
    appliedWaiters = appliedWaiters.filter((waiter) => {
      if (!reached(waiter, appliedSeq, snapshotAppliedEpoch)) return true;
      waiter.resolve();
      return false;
    });
  };

  const wait = (list: "received" | "applied", pos: TablePositionLike) =>
    new Promise<void>((resolve, reject) => {
      const waiter = { epoch: pos.epoch, seq: pos.seq, resolve, reject };
      if (list === "received") {
        receivedWaiters.push(waiter);
        settleReceived();
      } else {
        appliedWaiters.push(waiter);
        settleApplied();
      }
    });

  const nextSnapshot = (): Promise<void> => {
    const next = deferred();
    snapshotWaiters.push(next);
    return next.promise;
  };

  const utils: IpcCollectionUtils = {
    awaitReceived: (pos) => wait("received", pos),
    awaitApplied: (pos) => wait("applied", pos),
    resync: () => {
      const next = nextSnapshot();
      requestResync?.();
      return next;
    },
    status: () => ({
      epoch,
      receivedSeq,
      appliedSeq,
      connection: connectionCount,
      state,
    }),
  };

  /** The echo is in the queue, or after `echoTimeoutMs` a resync is. */
  const awaitEcho = async (pos: TablePositionLike): Promise<void> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        utils.awaitReceived(pos),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new EchoTimeout()), echoTimeoutMs);
        }),
      ]);
    } catch (error) {
      if (!(error instanceof EchoTimeout)) throw error;
      // The write happened; the snapshot replaces the optimistic state.
      await utils.resync();
    } finally {
      clearTimeout(timer);
    }
  };

  const sync: SyncConfig<Row, Key>["sync"] = ({
    begin,
    write,
    commit,
    markReady,
    markError,
    truncate,
    collection,
  }) => {
    const session = new AbortController();
    let current: Connection<Row, Key> | null = null;
    let holdsSnapshot = false;
    let attempt = 0;

    receivedSeq = -1;
    appliedSeq = -1;
    epoch = null;
    snapshotReceivedEpoch = null;
    snapshotAppliedEpoch = null;
    state = "connecting";

    const isCurrent = (connection: Connection<Row, Key>): boolean =>
      !session.signal.aborted && current === connection;

    const trackApplied = (
      receipt: ReturnType<typeof commit>,
      atEpoch: string,
      seq: number,
      isSnapshot: boolean
    ): void => {
      const mark = (): void => {
        if (epoch !== atEpoch) return;
        appliedSeq = Math.max(seq, appliedSeq);
        if (isSnapshot) snapshotAppliedEpoch = atEpoch;
        settleApplied();
      };
      if (receipt === true) mark();
      else receipt.then(mark, () => undefined);
    };

    const reopen = (connection: Connection<Row, Key>): void => {
      if (!isCurrent(connection)) return;
      connection.deliberate = true;
      connection.abort.abort();
    };

    const failWhileLoading = (error: unknown): void => {
      if (collection.status === "loading") markError(error);
    };

    const applyBatch = (
      connection: Connection<Row, Key>,
      batch: Batch<Row, Key>
    ): Applied => {
      if (batch.epoch !== epoch) return "reopen";
      if (batch.kind === "reset") return "resync";
      if (batch.kind === "hello") return "reopen";
      if (batch.seq <= receivedSeq) return "ok";
      if (batch.seq !== receivedSeq + 1) return "resync";
      begin();
      for (const change of batch.changes) {
        const message: ChangeMessageOrDeleteKeyMessage<Row, Key> =
          change.type === "delete"
            ? { type: "delete", key: change.key }
            : // Full rows (rowUpdateMode "full"), so an update is an upsert.
              // An insert is written as one too: TanStack checks inserts
              // against its *applied* rows, which lag a delete still queued
              // behind a persisting transaction, and would call a re-created
              // row a duplicate.
              { type: "update", value: change.value };
        write(message);
      }
      const receipt = commit();
      receivedSeq = batch.seq;
      trackApplied(receipt, batch.epoch, batch.seq, false);
      settleReceived();
      return "ok";
    };

    const handle = (
      connection: Connection<Row, Key>,
      result: Applied
    ): void => {
      if (result === "resync") void resync(connection);
      else if (result === "reopen") reopen(connection);
    };

    const loadSnapshot = async (
      connection: Connection<Row, Key>
    ): Promise<void> => {
      connection.buffering = true;
      state = holdsSnapshot ? "resyncing" : "connecting";
      let snapshot: TableSnapshot<Row>;
      try {
        const table = await config.table();
        snapshot = await table.snapshot(
          {},
          { signal: connection.abort.signal }
        );
      } catch (error) {
        if (!isCurrent(connection)) return;
        // Keep the last good rows; the reopen retries.
        failWhileLoading(error);
        connection.abort.abort();
        return;
      }
      if (!isCurrent(connection)) return;
      if (snapshot.epoch !== epoch) {
        // Main restarted between hello and snapshot: its new hello follows.
        reopen(connection);
        return;
      }

      begin();
      if (holdsSnapshot) truncate();
      for (const row of snapshot.rows) write({ type: "insert", value: row });
      const receipt = commit();
      holdsSnapshot = true;
      receivedSeq = snapshot.seq;
      snapshotReceivedEpoch = snapshot.epoch;
      trackApplied(receipt, snapshot.epoch, snapshot.seq, true);
      settleReceived();

      // Flush, in order, until done or something needs another pass.
      let next: Applied = "ok";
      while (connection.buffer.length > 0 && next === "ok") {
        const batch = connection.buffer.shift()!;
        next = applyBatch(connection, batch);
      }
      if (!isCurrent(connection)) return;
      if (next === "reopen") {
        reopen(connection);
        return;
      }
      if (next === "resync") {
        connection.loading = loadSnapshot(connection);
        return;
      }
      connection.buffering = false;
      state = "live";
      if (collection.status === "loading" || collection.status === "error")
        markReady();
      const waiters = snapshotWaiters;
      snapshotWaiters = [];
      for (const waiter of waiters) waiter.resolve();
    };

    const resync = (connection: Connection<Row, Key>): Promise<void> => {
      if (!isCurrent(connection) || !connection.helloed)
        return Promise.resolve();
      if (connection.loading != null) return connection.loading;
      const loading = loadSnapshot(connection).finally(() => {
        if (connection.loading === loading) connection.loading = null;
      });
      connection.loading = loading;
      return loading;
    };

    requestResync = () => {
      if (current != null && current.helloed) void resync(current);
    };

    const onBatch = (
      connection: Connection<Row, Key>,
      batch: Batch<Row, Key>
    ): void => {
      if (!isCurrent(connection)) return;
      if (batch.kind === "hello" && !connection.helloed) {
        connection.helloed = true;
        attempt = 0;
        if (batch.epoch !== epoch) {
          epoch = batch.epoch;
          seenEpochs.add(batch.epoch);
          receivedSeq = -1;
          appliedSeq = -1;
        }
        void resync(connection);
        return;
      }
      if (connection.buffering) {
        connection.buffer.push(batch);
        return;
      }
      handle(connection, applyBatch(connection, batch));
    };

    const sleep = (ms: number): Promise<void> =>
      new Promise((resolve) => {
        if (ms <= 0 || session.signal.aborted) return resolve();
        const timer = setTimeout(done, ms);
        session.signal.addEventListener("abort", done, { once: true });
        function done(): void {
          clearTimeout(timer);
          session.signal.removeEventListener("abort", done);
          resolve();
        }
      });

    const run = async (): Promise<void> => {
      while (!session.signal.aborted) {
        const connection: Connection<Row, Key> = {
          generation: ++connectionCount,
          abort: new AbortController(),
          buffering: true,
          buffer: [],
          loading: null,
          helloed: false,
          deliberate: false,
        };
        current = connection;
        state = holdsSnapshot ? "resyncing" : "connecting";
        const onSessionAbort = (): void => connection.abort.abort();
        session.signal.addEventListener("abort", onSessionAbort, {
          once: true,
        });
        try {
          const table = await config.table();
          const stream = await table.changes(
            {},
            { signal: connection.abort.signal }
          );
          for await (const batch of stream) {
            if (!isCurrent(connection) || connection.abort.signal.aborted)
              break;
            onBatch(connection, batch);
          }
          // Returned without our abort: the server ended it (an overflow
          // reset, a closed port). Reopen as for an error.
        } catch (error) {
          if (!connection.deliberate && !session.signal.aborted)
            failWhileLoading(error);
        } finally {
          session.signal.removeEventListener("abort", onSessionAbort);
          connection.abort.abort();
        }
        if (session.signal.aborted) return;
        if (connection.deliberate) continue;
        await sleep(retryDelayMs(attempt));
        attempt += 1;
      }
    };

    void run();

    return () => {
      session.abort();
      requestResync = null;
      current = null;
      const error = abortError();
      for (const waiter of [...receivedWaiters, ...appliedWaiters])
        waiter.reject(error);
      receivedWaiters = [];
      appliedWaiters = [];
      for (const waiter of snapshotWaiters) waiter.reject(error);
      snapshotWaiters = [];
    };
  };

  const table = async (): Promise<IpcTableClient<Row, Key>> => config.table();

  const options: IpcCollectionOptions<Row, Key> = {
    id: config.id,
    getKey: config.getKey,
    startSync: config.startSync ?? false,
    sync: { sync, rowUpdateMode: "full" },
    utils,
  };

  if (config.toInsertInput != null) {
    const toInput = config.toInsertInput;
    options.onInsert = async ({ transaction }) => {
      for (const mutation of transaction.mutations) {
        const { insert } = await table();
        if (insert == null) throw new Error(`${config.id} has no insert`);
        await awaitEcho(await insert(toInput(mutation.modified) as never));
      }
    };
  }
  if (config.toUpdateInput != null) {
    const toInput = config.toUpdateInput;
    options.onUpdate = async ({ transaction }) => {
      for (const mutation of transaction.mutations) {
        const { update } = await table();
        if (update == null) throw new Error(`${config.id} has no update`);
        await awaitEcho(
          await update(
            toInput(
              mutation.key as Key,
              mutation.changes as Partial<Row>,
              mutation.modified
            ) as never
          )
        );
      }
    };
  }
  if (config.toDeleteInput != null) {
    const toInput = config.toDeleteInput;
    options.onDelete = async ({ transaction }) => {
      for (const mutation of transaction.mutations) {
        const { delete: remove } = await table();
        if (remove == null) throw new Error(`${config.id} has no delete`);
        await awaitEcho(
          await remove(toInput(mutation.key as Key, mutation.original) as never)
        );
      }
    };
  }

  return options;
}
