/**
 * TanStack DB collection options over a `db.<table>` procedure family (spec
 * 00 B.3, re-homed per spec 01 F12). The protocol: `changes()` yields
 * `hello`, then contiguous batches; `snapshot()` is the table at a seq.
 *
 * INTERIM: the full adapter (every B-T1 case) is spec 00 sub-slice B, being
 * built in `data/db/`. This one implements the same signature and the core of
 * the algorithm (connection generations, hello → snapshot → buffered flush,
 * seq dedupe, gap/reset resync, reopen with backoff, markReady/markError,
 * received/applied waiters, mutation echo waits), so the shell runs on it
 * until the import switches to `data/db`.
 */
import type {
  ChangeMessageOrDeleteKeyMessage,
  CollectionConfig,
  SyncConfig,
} from "@tanstack/db";

import type {
  ChangeBatch,
  TablePosition,
  TableSnapshot,
} from "#shared/contract";

type CallOptions = { signal?: AbortSignal };

/** `transport.client.db.<table>`, as far as this adapter uses it. */
export interface IpcTableClient<Row, Key extends string> {
  snapshot(
    input?: Record<string, never>,
    options?: CallOptions
  ): Promise<TableSnapshot<Row>>;
  changes(
    input?: Record<string, never>,
    options?: CallOptions
  ): Promise<AsyncIterable<ChangeBatch<Row, Key>>>;
  // oRPC's typed inputs differ per table; the adapter passes what the
  // table's own `to*Input` built.
  insert?(input: never): Promise<TablePosition<Key>>;
  update?(input: never): Promise<TablePosition<Key>>;
  delete?(input: never): Promise<TablePosition<Key>>;
}

interface IpcCollectionStatus {
  epoch: string | null;
  receivedSeq: number;
  appliedSeq: number;
  connection: number;
  state: "connecting" | "live" | "resyncing";
}

// A type alias, not an interface: TanStack DB's utils record needs every
// member to be a function, which an alias satisfies without an index type.
export type IpcCollectionUtils = {
  awaitReceived: (position: { epoch: string; seq: number }) => Promise<void>;
  awaitApplied: (position: { epoch: string; seq: number }) => Promise<void>;
  resync: () => Promise<void>;
  status: () => IpcCollectionStatus;
};

export interface IpcCollectionConfig<Row extends object, Key extends string> {
  id: string;
  table: () => Promise<IpcTableClient<Row, Key>>;
  getKey: (row: Row) => Key;
  toInsertInput?: (row: Row) => unknown;
  toUpdateInput?: (key: Key, changes: Partial<Row>, modified: Row) => unknown;
  toDeleteInput?: (key: Key, original: Row) => unknown;
  echoTimeoutMs?: number;
  startSync?: boolean;
  gcTime?: number;
  /** Reopen delays in ms; the last repeats. Tests shorten it. */
  backoffMs?: readonly number[];
}

const DEFAULT_BACKOFF = [500, 1_000, 2_000, 5_000] as const;

class AbortError extends Error {
  override name = "AbortError";
}

interface Waiter {
  kind: "received" | "applied";
  epoch: string;
  seq: number;
  resolve(): void;
  reject(error: unknown): void;
}

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
  });

export const ipcCollectionOptions = <Row extends object, Key extends string>(
  cfg: IpcCollectionConfig<Row, Key>
): CollectionConfig<Row, Key, never, IpcCollectionUtils> & {
  utils: IpcCollectionUtils;
} => {
  const backoff = cfg.backoffMs ?? DEFAULT_BACKOFF;
  const echoTimeoutMs = cfg.echoTimeoutMs ?? 10_000;

  // Adapter state, shared by the sync function and the utils.
  let epoch: string | null = null;
  let receivedSeq = -1;
  let appliedSeq = -1;
  let connection = 0;
  let state: IpcCollectionStatus["state"] = "connecting";
  const waiters = new Set<Waiter>();
  /** Set while a sync session is running. */
  let resyncNow: (() => Promise<void>) | null = null;
  /** Resolved each time a snapshot is applied (resync completions). */
  let snapshotListeners: Array<() => void> = [];

  const settleWaiters = (): void => {
    for (const waiter of waiters) {
      if (waiter.epoch !== epoch) continue;
      const position = waiter.kind === "received" ? receivedSeq : appliedSeq;
      if (position >= waiter.seq) {
        waiters.delete(waiter);
        waiter.resolve();
      }
    }
  };

  /** A new epoch's first snapshot is authoritative for old-epoch waiters. */
  const settleOldEpochWaiters = (): void => {
    for (const waiter of waiters) {
      if (waiter.epoch === epoch) continue;
      waiters.delete(waiter);
      waiter.resolve();
    }
  };

  const wait = (
    kind: Waiter["kind"],
    position: { epoch: string; seq: number }
  ): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      waiters.add({ kind, ...position, resolve, reject });
      settleWaiters();
    });

  const sync: SyncConfig<Row, Key>["sync"] = ({
    begin,
    write,
    commit,
    markReady,
    markError,
    truncate,
    collection,
  }) => {
    const abort = new AbortController();
    let connectionAbort = new AbortController();
    let hasSnapshot = false;
    /** Batches that arrive while a snapshot for this connection loads. */
    let buffer: Array<ChangeBatch<Row, Key>> | null = null;
    let loading: Promise<void> | null = null;

    const trackApplied = (seq: number, receipt: true | Promise<void>): void => {
      const at = epoch;
      if (receipt === true) {
        appliedSeq = Math.max(appliedSeq, seq);
        settleWaiters();
        return;
      }
      receipt.then(
        () => {
          if (epoch !== at) return;
          appliedSeq = Math.max(appliedSeq, seq);
          settleWaiters();
        },
        () => undefined
      );
    };

    const reopen = (): void => {
      connectionAbort.abort();
    };

    const applyChanges = (
      batch: Extract<ChangeBatch<Row, Key>, { kind: "changes" }>
    ): void => {
      begin();
      for (const change of batch.changes) {
        const message: ChangeMessageOrDeleteKeyMessage<Row, Key> =
          change.type === "delete"
            ? { type: "delete", key: change.key }
            : { type: change.type, value: change.value };
        write(message);
      }
      const receipt = commit();
      receivedSeq = batch.seq;
      trackApplied(batch.seq, receipt);
      settleWaiters();
    };

    /** Returns false when the batch ended this connection's processing. */
    const process = (batch: ChangeBatch<Row, Key>, gen: number): boolean => {
      if (gen !== connection) return false;
      if (buffer !== null) {
        buffer.push(batch);
        return true;
      }
      if (batch.epoch !== epoch) {
        reopen();
        return false;
      }
      if (batch.kind === "hello") return true;
      if (batch.kind === "reset") {
        void resync(gen);
        return true;
      }
      if (batch.seq <= receivedSeq) return true;
      if (batch.seq !== receivedSeq + 1) {
        void resync(gen);
        return true;
      }
      applyChanges(batch);
      return true;
    };

    const loadSnapshot = async (gen: number): Promise<void> => {
      const table = await cfg.table();
      const snapshot = await table.snapshot({}, { signal: abort.signal });
      if (gen !== connection || snapshot.epoch !== epoch) return;
      begin();
      if (hasSnapshot) truncate();
      for (const row of snapshot.rows) write({ type: "insert", value: row });
      const receipt = commit();
      hasSnapshot = true;
      receivedSeq = snapshot.seq;
      trackApplied(snapshot.seq, receipt);
      if (collection.status === "loading" || collection.status === "error")
        markReady();
      settleWaiters();
      settleOldEpochWaiters();
      state = "live";
      const pending = buffer ?? [];
      buffer = null;
      for (const batch of pending) if (!process(batch, gen)) break;
      const listeners = snapshotListeners;
      snapshotListeners = [];
      for (const listener of listeners) listener();
    };

    /** Single-flight per connection: buffer, then re-snapshot. */
    const resync = (gen: number): Promise<void> => {
      if (loading !== null) return loading;
      buffer ??= [];
      state = hasSnapshot ? "resyncing" : "connecting";
      loading = loadSnapshot(gen)
        .catch((error: unknown) => {
          if (abort.signal.aborted) return;
          if (collection.status === "loading") markError(error);
          reopen();
        })
        .finally(() => {
          loading = null;
        });
      return loading;
    };

    resyncNow = () =>
      new Promise<void>((resolve) => {
        snapshotListeners.push(resolve);
        void resync(connection);
      });

    const run = async (): Promise<void> => {
      let attempt = 0;
      while (!abort.signal.aborted) {
        connectionAbort = new AbortController();
        const signal = AbortSignal.any([abort.signal, connectionAbort.signal]);
        const gen = ++connection;
        buffer = [];
        loading = null;
        state = "connecting";
        try {
          const table = await cfg.table();
          const stream = await table.changes({}, { signal });
          for await (const batch of stream) {
            if (gen !== connection || signal.aborted) break;
            if (batch.kind === "hello") {
              attempt = 0;
              if (batch.epoch !== epoch) {
                epoch = batch.epoch;
                receivedSeq = -1;
                appliedSeq = -1;
              }
              buffer ??= [];
              void resync(gen);
              continue;
            }
            process(batch, gen);
          }
        } catch (error) {
          if (abort.signal.aborted) return;
          if (
            !connectionAbort.signal.aborted &&
            collection.status === "loading"
          )
            markError(error);
        }
        if (abort.signal.aborted) return;
        const delay = backoff[Math.min(attempt, backoff.length - 1)] ?? 5_000;
        attempt += 1;
        await sleep(delay, abort.signal);
      }
    };
    void run();

    return () => {
      abort.abort();
      connectionAbort.abort();
      resyncNow = null;
      for (const waiter of waiters) waiter.reject(new AbortError("aborted"));
      waiters.clear();
    };
  };

  const utils: IpcCollectionUtils = {
    awaitReceived: (position) => wait("received", position),
    awaitApplied: (position) => wait("applied", position),
    resync: async () => {
      if (resyncNow != null) await resyncNow();
    },
    status: () => ({
      epoch,
      receivedSeq,
      appliedSeq,
      connection,
      state,
    }),
  };

  /** Mutation echo: wait for *received* (applied would deadlock, B.3). */
  const awaitEcho = async (position: TablePosition<Key>): Promise<void> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), echoTimeoutMs);
    });
    try {
      const result = await Promise.race([
        utils.awaitReceived(position).then(() => "echo" as const),
        timeout,
      ]);
      if (result === "timeout") await utils.resync();
    } finally {
      clearTimeout(timer);
    }
  };

  const config: CollectionConfig<Row, Key, never, IpcCollectionUtils> & {
    utils: IpcCollectionUtils;
  } = {
    id: cfg.id,
    getKey: cfg.getKey,
    startSync: cfg.startSync ?? false,
    ...(cfg.gcTime === undefined ? {} : { gcTime: cfg.gcTime }),
    sync: { sync, rowUpdateMode: "full" },
    utils,
  };

  if (cfg.toInsertInput != null) {
    const toInput = cfg.toInsertInput;
    config.onInsert = async ({ transaction }) => {
      const table = await cfg.table();
      for (const mutation of transaction.mutations) {
        const position = await table.insert!(
          toInput(mutation.modified) as never
        );
        await awaitEcho(position);
      }
    };
  }
  if (cfg.toUpdateInput != null) {
    const toInput = cfg.toUpdateInput;
    config.onUpdate = async ({ transaction }) => {
      const table = await cfg.table();
      for (const mutation of transaction.mutations) {
        const position = await table.update!(
          toInput(
            mutation.key as Key,
            mutation.changes as Partial<Row>,
            mutation.modified
          ) as never
        );
        await awaitEcho(position);
      }
    };
  }
  if (cfg.toDeleteInput != null) {
    const toInput = cfg.toDeleteInput;
    config.onDelete = async ({ transaction }) => {
      const table = await cfg.table();
      for (const mutation of transaction.mutations) {
        const position = await table.delete!(
          toInput(mutation.key as Key, mutation.original as Row) as never
        );
        await awaitEcho(position);
      }
    };
  }

  return config;
};
