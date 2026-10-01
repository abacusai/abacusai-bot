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
 * 3. Snapshot loop (single flight per connection, one `finally`): each pass
 *    is discarded if its epoch is not the stream's or its connection was
 *    replaced. Otherwise `begin`, `truncate` when a copy is already held, one
 *    write per row, `commit`, then flush the buffer (epoch first, then drop
 *    `seq <= received`, then apply in order), then `markReady` while loading
 *    or errored. A reset or gap met in the flush, or a resync asked for
 *    during the pass, runs another pass in the same loop.
 * 4. A batch: another epoch reopens; an old seq (a `reset` included) is
 *    dropped; a newer `reset` or a gap resyncs; the next one is applied.
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

type TablePositionLike = { epoch: string; seq: number };

type SyncState = "connecting" | "live" | "resyncing";

interface IpcCollectionStatus {
  epoch: string | null;
  receivedSeq: number;
  appliedSeq: number;
  /** Connection generation: +1 per `changes()` opened. */
  connection: number;
  state: SyncState;
}

/** What a mutation handler's `collection` offers the echo wait. */
interface SyncStarter {
  readonly status: string;
  startSyncImmediate(): void;
}

export interface IpcCollectionUtils extends UtilsRecord {
  /** Main's batch at `pos` is in the sync queue (mutation echo). */
  awaitReceived(pos: TablePositionLike): Promise<void>;
  /** Main's batch at `pos` is visible in the collection (loaders, tests). */
  awaitApplied(pos: TablePositionLike): Promise<void>;
  /**
   * Re-snapshot now; resolves once a snapshot requested after this call is
   * received. Rejects (`AbortError`) when the collection is not syncing.
   */
  resync(): Promise<void>;
  /**
   * A write's echo, for writes made outside the collection handlers (such
   * as `updatePrefs`): `pos` received, or after `echoTimeoutMs` a covering
   * resync, bounded the same way. Starts a lazy collection's sync.
   */
  awaitEcho(pos: TablePositionLike, collection?: SyncStarter): Promise<void>;
  status(): IpcCollectionStatus;
}

export interface IpcCollectionConfig<Row extends object, Key extends string> {
  /** "sessions", …; also the collection id. */
  id: string;
  /** Resolves `transport.client.db.<table>`; called per connection. */
  table: () => Promise<IpcTableClient<Row, Key>>;
  getKey: (row: Row) => Key;
  toInsertInput?: (row: Row) => unknown;
  toUpdateInput?: (
    key: Key,
    changes: Partial<Row>,
    modified: Row,
    original: Row
  ) => unknown;
  toDeleteInput?: (key: Key, original: Row) => unknown;
  /**
   * A delete main answers `NOT_FOUND` (the row is already gone: another
   * window, main itself) resolves after a resync instead of rolling back
   * (spec 03 §24.5). Bots and routines set it.
   */
  idempotentDelete?: boolean;
  /** How long a handler waits for its echo before it resyncs. */
  echoTimeoutMs?: number;
  /** Sync on creation (the shell's tables), not on first use. */
  startSync?: boolean;
  /** Delay before reconnect attempt `n` (0-based) after an error or EOF. */
  retryDelayMs?: (attempt: number) => number;
  /**
   * Stops the sync for good once aborted (the document's transport is gone,
   * spec 01 §8.6 step 8): the stream is closed, no reopen or retry follows,
   * and a later subscriber or `preload()` does not start another session.
   * Unlike `collection.cleanup()`, which TanStack restarts on the next
   * subscription.
   */
  signal?: AbortSignal;
}

export type IpcCollectionOptions<
  Row extends object,
  Key extends string,
> = CollectionConfig<Row, Key, never, IpcCollectionUtils> & {
  utils: IpcCollectionUtils;
};

const DEFAULT_ECHO_TIMEOUT_MS = 10_000;

/** A typed `NOT_FOUND` from main (oRPC error `code`), never a message match. */
const isNotFoundError = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  (error as { code?: unknown }).code === "NOT_FOUND";

/** 0.5 s, 1 s, 2 s, then every 5 s. */
const defaultRetryDelayMs = (attempt: number): number =>
  [500, 1_000, 2_000][attempt] ?? 5_000;

const abortError = (message: string): Error => {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
};

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

/** A `resync()` caller: settled by the first snapshot pass started after it. */
interface SnapshotWaiter extends Deferred {
  /** Passes already started when it asked; none of those can answer it. */
  after: number;
}

/** True if `promise` settles within `ms`; its rejection is rethrown. */
const settlesWithin = async (
  promise: Promise<void>,
  ms: number
): Promise<boolean> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

type Batch<Row, Key> = ChangeBatch<Row, Key>;
type Applied = "ok" | "resync" | "reopen";

interface Connection<Row, Key> {
  generation: number;
  abort: AbortController;
  /** Batches held while no snapshot has been applied (or a resync runs). */
  buffering: boolean;
  buffer: Batch<Row, Key>[];
  /**
   * The snapshot loop in flight: single flight per connection. It runs
   * passes while `again` is set and clears itself in one `finally`.
   */
  loading: Promise<void> | null;
  /** Another pass is wanted (a reset, a gap, a resync call). */
  again: boolean;
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
  let snapshotWaiters: SnapshotWaiter[] = [];
  /** Snapshot passes started, across connections and sessions. */
  let passesStarted = 0;
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

  const stopped = (): boolean => config.signal?.aborted === true;

  const resync = (): Promise<void> => {
    // No session: nothing would ever answer it.
    if (requestResync == null || stopped())
      return Promise.reject(abortError("The collection is not syncing"));
    const next: SnapshotWaiter = { ...deferred(), after: passesStarted };
    snapshotWaiters.push(next);
    requestResync();
    return next.promise;
  };

  /** Mutating a lazy collection nobody has read yet must still see its echo. */
  const ensureSyncing = (collection: SyncStarter | undefined): void => {
    if (collection == null || stopped()) return;
    if (collection.status === "idle" || collection.status === "cleaned-up")
      collection.startSyncImmediate();
  };

  /**
   * Main's batch at `pos` is in the sync queue. After `echoTimeoutMs` the
   * write happened but its batch is late or lost: ask for a snapshot started
   * after now, which therefore covers `pos`, and wait (bounded again) for
   * `pos` to be received. Past that, resolve anyway; the next snapshot
   * reconciles.
   */
  const awaitEcho = async (
    pos: TablePositionLike,
    collection?: SyncStarter
  ): Promise<void> => {
    ensureSyncing(collection);
    // Through `utils`, so a caller that wraps it (a test) sees the wait.
    const received = utils.awaitReceived(pos);
    if (await settlesWithin(received, echoTimeoutMs)) return;
    ensureSyncing(collection);
    utils.resync().catch(() => undefined);
    await settlesWithin(received, echoTimeoutMs);
  };

  const utils: IpcCollectionUtils = {
    awaitReceived: (pos) => wait("received", pos),
    awaitApplied: (pos) => wait("applied", pos),
    resync,
    awaitEcho,
    status: () => ({
      epoch,
      receivedSeq,
      appliedSeq,
      connection: connectionCount,
      state,
    }),
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
    // Stopped for good: no session at all, so nothing reopens on a dead
    // transport however often TanStack restarts the sync.
    if (stopped()) return () => undefined;
    const endSession = (reason: string): void => {
      session.abort();
      requestResync = null;
      current = null;
      const error = abortError(reason);
      for (const waiter of [...receivedWaiters, ...appliedWaiters])
        waiter.reject(error);
      receivedWaiters = [];
      appliedWaiters = [];
      for (const waiter of snapshotWaiters) waiter.reject(error);
      snapshotWaiters = [];
    };
    const stopSession = (): void =>
      endSession("The collection's sync was stopped");
    config.signal?.addEventListener("abort", stopSession, { once: true });
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

    /**
     * One sync transaction. A throw between `begin` and `commit` (a server
     * bug such as a duplicate key) cancels it, so no half-written
     * transaction stays pending; null tells the caller to resync.
     */
    const transaction = (
      writes: () => void
    ): ReturnType<typeof commit> | null => {
      begin();
      try {
        writes();
      } catch (error) {
        const cancelled = new AbortController();
        cancelled.abort();
        const receipt = commit(cancelled.signal);
        if (receipt !== true) receipt.catch(() => undefined);
        console.error(`[db] ${config.id}: a sync write failed`, error);
        return null;
      }
      return commit();
    };

    const reopen = (connection: Connection<Row, Key>): void => {
      if (!isCurrent(connection)) return;
      connection.deliberate = true;
      connection.abort.abort();
    };

    const failWhileLoading = (error: unknown): void => {
      if (collection.status === "loading") markError(error);
    };

    const applyBatch = (batch: Batch<Row, Key>): Applied => {
      if (batch.epoch !== epoch) return "reopen";
      if (batch.kind === "hello") return "reopen";
      // Already covered, a `reset` included: the snapshot that brought us
      // here was read after it. An overflow reset carries the feed's current
      // seq, above anything its stream lost, so it is still honoured.
      if (batch.seq <= receivedSeq) return "ok";
      if (batch.kind === "reset") return "resync";
      if (batch.seq !== receivedSeq + 1) return "resync";
      const receipt = transaction(() => {
        for (const change of batch.changes) {
          const message: ChangeMessageOrDeleteKeyMessage<Row, Key> =
            change.type === "delete"
              ? { type: "delete", key: change.key }
              : // Full rows (rowUpdateMode "full"), so an update is an
                // upsert. An insert is written as one too: TanStack checks
                // inserts against its *applied* rows, which lag a delete
                // still queued behind a persisting transaction, and would
                // call a re-created row a duplicate.
                { type: "update", value: change.value };
          write(message);
        }
      });
      if (receipt == null) return "resync";
      receivedSeq = batch.seq;
      trackApplied(receipt, batch.epoch, batch.seq, false);
      settleReceived();
      return "ok";
    };

    /** One snapshot pass: fetch, replace, flush the buffer. */
    const snapshotPass = async (
      connection: Connection<Row, Key>
    ): Promise<void> => {
      const pass = ++passesStarted;
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

      const replace = holdsSnapshot;
      const receipt = transaction(() => {
        if (replace) truncate();
        for (const row of snapshot.rows) write({ type: "insert", value: row });
      });
      if (receipt == null) {
        failWhileLoading(new Error(`${config.id}: the snapshot did not apply`));
        connection.abort.abort();
        return;
      }
      holdsSnapshot = true;
      receivedSeq = snapshot.seq;
      snapshotReceivedEpoch = snapshot.epoch;
      trackApplied(receipt, snapshot.epoch, snapshot.seq, true);
      settleReceived();

      // Flush, in order, until done or something needs another pass.
      let next: Applied = "ok";
      while (connection.buffer.length > 0 && next === "ok") {
        const batch = connection.buffer.shift()!;
        next = applyBatch(batch);
      }
      if (!isCurrent(connection)) return;
      if (next === "reopen") {
        reopen(connection);
        return;
      }
      if (next === "resync") {
        connection.again = true;
        return;
      }
      connection.buffering = false;
      state = "live";
      // Back off from zero again only once a snapshot has applied.
      attempt = 0;
      if (collection.status === "loading" || collection.status === "error")
        markReady();
      snapshotWaiters = snapshotWaiters.filter((waiter) => {
        if (waiter.after >= pass) return true;
        waiter.resolve();
        return false;
      });
    };

    const load = (connection: Connection<Row, Key>): Promise<void> => {
      if (!isCurrent(connection) || !connection.helloed)
        return Promise.resolve();
      connection.again = true;
      if (connection.loading != null) return connection.loading;
      const loading = (async () => {
        // Let the assignment below happen before any pass can finish.
        await Promise.resolve();
        try {
          while (connection.again && isCurrent(connection)) {
            connection.again = false;
            await snapshotPass(connection);
          }
        } catch (error) {
          console.error(`[db] ${config.id}: the snapshot failed`, error);
          if (isCurrent(connection)) connection.abort.abort();
        } finally {
          connection.loading = null;
        }
      })();
      connection.loading = loading;
      return loading;
    };

    requestResync = () => {
      if (current != null && current.helloed) void load(current);
    };

    const onBatch = (
      connection: Connection<Row, Key>,
      batch: Batch<Row, Key>
    ): void => {
      if (!isCurrent(connection)) return;
      if (batch.kind === "hello" && !connection.helloed) {
        connection.helloed = true;
        if (batch.epoch !== epoch) {
          epoch = batch.epoch;
          seenEpochs.add(batch.epoch);
          receivedSeq = -1;
          appliedSeq = -1;
        }
        void load(connection);
        return;
      }
      if (connection.buffering) {
        connection.buffer.push(batch);
        return;
      }
      const result = applyBatch(batch);
      if (result === "resync") void load(connection);
      else if (result === "reopen") reopen(connection);
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
          again: false,
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
          // A dead connection is never current, not even while we sleep.
          if (current === connection) current = null;
        }
        if (session.signal.aborted) return;
        if (connection.deliberate) continue;
        await sleep(retryDelayMs(attempt));
        attempt += 1;
      }
    };

    void run();

    return () => {
      config.signal?.removeEventListener("abort", stopSession);
      endSession("The collection's sync was cleaned up");
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
    options.onInsert = async ({ transaction, collection }) => {
      ensureSyncing(collection);
      for (const mutation of transaction.mutations) {
        const { insert } = await table();
        if (insert == null) throw new Error(`${config.id} has no insert`);
        await awaitEcho(
          await insert(toInput(mutation.modified) as never),
          collection
        );
      }
    };
  }
  if (config.toUpdateInput != null) {
    const toInput = config.toUpdateInput;
    options.onUpdate = async ({ transaction, collection }) => {
      ensureSyncing(collection);
      for (const mutation of transaction.mutations) {
        // Built before the table resolves, so a refused field throws first.
        const input = toInput(
          mutation.key as Key,
          mutation.changes as Partial<Row>,
          mutation.modified,
          mutation.original as Row
        );
        const { update } = await table();
        if (update == null) throw new Error(`${config.id} has no update`);
        await awaitEcho(await update(input as never), collection);
      }
    };
  }
  if (config.toDeleteInput != null) {
    const toInput = config.toDeleteInput;
    options.onDelete = async ({ transaction, collection }) => {
      ensureSyncing(collection);
      for (const mutation of transaction.mutations) {
        const { delete: remove } = await table();
        if (remove == null) throw new Error(`${config.id} has no delete`);
        let position: TablePositionLike;
        try {
          position = await remove(
            toInput(mutation.key as Key, mutation.original) as never
          );
        } catch (error) {
          if (config.idempotentDelete !== true || !isNotFoundError(error))
            throw error;
          // Already gone in main: the snapshot drops it for real.
          await utils.resync().catch(() => undefined);
          continue;
        }
        await awaitEcho(position, collection);
      }
    };
  }

  return options;
}
