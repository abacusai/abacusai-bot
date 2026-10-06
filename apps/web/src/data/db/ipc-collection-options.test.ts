/**
 * B-T1: `ipcCollectionOptions` against a fake table client, with the real
 * `createCollection` from `@tanstack/db`.
 */
import { ORPCError } from "@orpc/client";
import { createCollection } from "@tanstack/db";
import { afterEach, describe, expect, it, vi } from "vitest";

import { untilOpen } from "#renderer/data/queries/notices";
import type { TransportState } from "#renderer/data/transport/lifecycle";

import { FakeTable } from "./fake-table";

/** Main's typed NOT_FOUND as the client receives it (a defined error). */
const typedNotFound = () =>
  new ORPCError("NOT_FOUND", {
    defined: true,
    message: "gone",
    data: { entity: "session", id: "a" },
  });
import {
  ipcCollectionOptions,
  type IpcCollectionConfig,
} from "./ipc-collection-options";

interface Row {
  id: string;
  label: string;
  updatedAt?: string;
}

type Options = Partial<IpcCollectionConfig<Row, string>>;

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const setup = (rows: Row[] = [], options: Options = {}) => {
  const table = new FakeTable<Row>(rows);
  const collection = createCollection(
    ipcCollectionOptions<Row, string>({
      id: `rows-${Math.random()}`,
      table: async () => table.client,
      getKey: (row) => row.id,
      toInsertInput: (row) => row,
      toUpdateInput: (id, changes) => ({ id, patch: changes }),
      toDeleteInput: (id, original) => ({ id, original }),
      retryDelayMs: () => 0,
      echoTimeoutMs: 1_000,
      ...options,
    })
  );
  cleanups.push(() => collection.cleanup());
  const view = () =>
    collection.toArray
      .map((row) => ({ id: row.id, label: row.label }))
      .sort((a, b) => a.id.localeCompare(b.id));
  const server = () =>
    Array.from(table.rows.values())
      .map((row) => ({ id: row.id, label: row.label }))
      .sort((a, b) => a.id.localeCompare(b.id));
  return { table, collection, view, server, utils: collection.utils };
};

const live = async (context: ReturnType<typeof setup>) => {
  await context.collection.preload();
  await vi.waitFor(() => expect(context.utils.status().state).toBe("live"));
};

describe("ipcCollectionOptions (B-T1)", () => {
  it("never tears down a table whose gcTime is Infinity", async () => {
    const context = setup([{ id: "a", label: "A" }], { gcTime: Infinity });
    await live(context);
    vi.useFakeTimers();
    try {
      const subscription = context.collection.subscribeChanges(() => undefined);
      subscription.unsubscribe();
      await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
      expect(context.collection.status).toBe("ready");
    } finally {
      vi.useRealTimers();
    }
  });
  it("(1) applies batches buffered during the snapshot after it, in order", async () => {
    const context = setup([{ id: "a", label: "A" }]);
    const held = context.table.holdSnapshot();
    const ready = context.collection.preload();
    await held.requested;
    context.table.upsert({ id: "a", label: "A1" });
    context.table.upsert({ id: "b", label: "B" });
    context.table.upsert({ id: "a", label: "A2" });
    expect(context.view()).toEqual([]);
    held.release();
    await ready;
    await vi.waitFor(() =>
      expect(context.view()).toEqual([
        { id: "a", label: "A2" },
        { id: "b", label: "B" },
      ])
    );
    expect(context.utils.status()).toMatchObject({
      receivedSeq: 3,
      state: "live",
    });
  });

  it("(2) drops same-epoch batches at or below the snapshot's seq", async () => {
    const context = setup();
    const held = context.table.holdSnapshot();
    void context.collection.preload();
    await held.requested;
    context.table.upsert({ id: "x", label: "from the batch" });
    // The snapshot already folded seq 1 in, with main's newer value.
    held.release({
      seq: 1,
      rows: [{ id: "x", label: "from the snapshot" }],
    });
    await vi.waitFor(() => expect(context.utils.status().state).toBe("live"));
    expect(context.view()).toEqual([{ id: "x", label: "from the snapshot" }]);
  });

  it("(3) a gap resyncs once, with truncate, to the new snapshot", async () => {
    const context = setup([{ id: "a", label: "A" }]);
    await live(context);
    expect(context.table.snapshotCalls).toBe(1);
    const truncates = vi.fn();
    context.collection.on("truncate", truncates);

    // seq 1 is lost in transit; seq 2 arrives.
    context.table.rows.set("gone", { id: "gone", label: "?" });
    context.table.seq += 1;
    context.table.upsert({ id: "b", label: "B" });
    await vi.waitFor(() => expect(context.view()).toEqual(context.server()));
    expect(context.table.snapshotCalls).toBe(2);
    expect(truncates).toHaveBeenCalledTimes(1);
  });

  it("(4) reset truncates and reloads", async () => {
    const context = setup([
      { id: "a", label: "A" },
      { id: "b", label: "B" },
    ]);
    await live(context);
    context.table.rows.delete("a");
    context.table.seq += 1;
    context.table.broadcast({
      kind: "reset",
      epoch: context.table.epoch,
      seq: context.table.seq,
    });
    await vi.waitFor(() =>
      expect(context.view()).toEqual([{ id: "b", label: "B" }])
    );
    expect(context.table.snapshotCalls).toBe(2);
  });

  it("(5) a new epoch on reconnect resets both positions and settles old waiters after its snapshot", async () => {
    const context = setup([{ id: "a", label: "A" }]);
    await live(context);
    context.table.upsert({ id: "a", label: "A1" });
    context.table.upsert({ id: "a", label: "A2" });
    await vi.waitFor(() => expect(context.utils.status().receivedSeq).toBe(2));
    const oldEpoch = context.table.epoch;
    const waiter = vi.fn();
    const applied = vi.fn();
    void context.utils.awaitReceived({ epoch: oldEpoch, seq: 10 }).then(waiter);
    void context.utils.awaitApplied({ epoch: oldEpoch, seq: 10 }).then(applied);

    const held = context.table.holdSnapshot();
    context.table.rows.set("a", { id: "a", label: "after restart" });
    context.table.restart("epoch-2");
    await held.requested;
    expect(context.utils.status()).toMatchObject({
      epoch: "epoch-2",
      receivedSeq: -1,
      appliedSeq: -1,
    });
    await Promise.resolve();
    expect(waiter).not.toHaveBeenCalled();
    held.release();
    await vi.waitFor(() => expect(waiter).toHaveBeenCalled());
    await vi.waitFor(() => expect(applied).toHaveBeenCalled());
    expect(context.view()).toEqual([{ id: "a", label: "after restart" }]);
    expect(context.utils.status()).toMatchObject({
      epoch: "epoch-2",
      receivedSeq: 0,
      appliedSeq: 0,
    });
    // A waiter for an epoch never seen (a newer main) is not settled early.
    const future = vi.fn();
    void context.utils
      .awaitReceived({ epoch: "epoch-3", seq: 0 })
      .then(future, () => undefined);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(future).not.toHaveBeenCalled();
  });

  it("(5b) a buffered batch from another epoch reopens; it is never silently dropped", async () => {
    const context = setup([{ id: "a", label: "A" }]);
    const held = context.table.holdSnapshot();
    void context.collection.preload();
    await held.requested;
    context.table.live.push({
      kind: "changes",
      epoch: "somewhere-else",
      seq: 1,
      changes: [{ type: "delete", key: "a" }],
    });
    held.release();
    await vi.waitFor(() => expect(context.table.connections).toHaveLength(2));
    await vi.waitFor(() => expect(context.utils.status().state).toBe("live"));
    expect(context.view()).toEqual([{ id: "a", label: "A" }]);
  });

  it("(5c) ignores a late batch or snapshot from a superseded connection", async () => {
    const context = setup([{ id: "a", label: "A" }]);
    const stale = context.table.holdSnapshot();
    void context.collection.preload();
    await stale.requested;
    const first = context.table.live;
    first.fail(new Error("port hiccup"));
    await vi.waitFor(() => expect(context.table.connections).toHaveLength(2));
    await vi.waitFor(() => expect(context.utils.status().state).toBe("live"));
    expect(context.utils.status().connection).toBe(2);

    // The first connection's snapshot and a batch turn up late.
    stale.release({ rows: [{ id: "zombie", label: "Z" }] });
    first.push({
      kind: "changes",
      epoch: context.table.epoch,
      seq: 1,
      changes: [{ type: "delete", key: "a" }],
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(context.view()).toEqual([{ id: "a", label: "A" }]);
  });

  it("(6) failure then recovery: error, then ready, then live changes", async () => {
    const context = setup([{ id: "a", label: "A" }], {
      retryDelayMs: () => 5,
    });
    const failing = context.table.holdSnapshot();
    void context.collection.preload().catch(() => undefined);
    await failing.requested;
    const retry = context.table.holdSnapshot();
    failing.fail(new Error("main is starting"));
    await vi.waitFor(() => expect(context.collection.status).toBe("error"));
    await retry.requested;
    retry.release();
    await vi.waitFor(() => expect(context.collection.status).toBe("ready"));
    context.table.upsert({ id: "b", label: "B" });
    await vi.waitFor(() =>
      expect(context.view()).toEqual([
        { id: "a", label: "A" },
        { id: "b", label: "B" },
      ])
    );
  });

  it("(7) cleanup aborts the stream and rejects pending waiters with AbortError", async () => {
    const context = setup();
    await live(context);
    const pending = context.utils.awaitReceived({
      epoch: context.table.epoch,
      seq: 5,
    });
    const applied = context.utils.awaitApplied({
      epoch: context.table.epoch,
      seq: 5,
    });
    await context.collection.cleanup();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await expect(applied).rejects.toMatchObject({ name: "AbortError" });
    expect(context.table.live.signal.aborted).toBe(true);
  });

  it("(8) onInsert resolves once the echo is received, without deadlock", async () => {
    const context = setup();
    await live(context);
    const order: string[] = [];
    context.table.insertHandler = async (input) => {
      const row = input as Row;
      // Main answers with the position first; the batch lands a bit later.
      const position = {
        ...context.table.position(row.id),
        seq: context.table.seq + 1,
      };
      setTimeout(() => {
        order.push("echo sent");
        context.table.upsert(row);
      }, 20);
      return position;
    };
    const tx = context.collection.insert({ id: "n", label: "New" });
    await tx.isPersisted.promise;
    order.push("handler resolved");
    expect(order).toEqual(["echo sent", "handler resolved"]);
    expect(context.view()).toEqual([{ id: "n", label: "New" }]);
  });

  it("(8b) a server-normalised row replaces the optimistic one with no flicker", async () => {
    const context = setup([{ id: "a", label: "old" }]);
    await live(context);
    context.table.insertHandler = async (input) => {
      const row = input as Row;
      context.table.upsert({
        ...row,
        label: row.label.trim(),
        updatedAt: "t1",
      });
      return context.table.position(row.id);
    };
    context.table.updateHandler = async (input) => {
      const { id, patch } = input as { id: string; patch: Partial<Row> };
      const current = context.table.rows.get(id)!;
      context.table.upsert({
        ...current,
        ...patch,
        label: (patch.label ?? current.label).trim(),
        updatedAt: "t2",
      });
      return context.table.position(id);
    };
    const labels = new Map<string, (string | null)[]>();
    const subscription = context.collection.subscribeChanges((changes) => {
      for (const change of changes) {
        const seen = labels.get(String(change.key)) ?? [];
        seen.push(change.type === "delete" ? null : change.value.label);
        labels.set(String(change.key), seen);
      }
    });

    await context.collection.insert({ id: "n", label: "  hi  " }).isPersisted
      .promise;
    expect(context.collection.get("n")).toMatchObject({
      label: "hi",
      updatedAt: "t1",
    });
    await context.collection.update("a", (draft) => {
      draft.label = "  new  ";
    }).isPersisted.promise;
    expect(context.collection.get("a")).toMatchObject({
      label: "new",
      updatedAt: "t2",
    });
    subscription.unsubscribe();
    // Optimistic, then main's value: never back to the old one, never gone.
    expect(labels.get("n")).toEqual(["  hi  ", "hi"]);
    expect(labels.get("a")).toEqual(["  new  ", "new"]);
  });

  it("(8c) awaitApplied resolves only once the commit is visible", async () => {
    const context = setup([{ id: "a", label: "A" }]);
    await live(context);
    let release!: () => void;
    context.table.updateHandler = (input) =>
      new Promise((resolve) => {
        release = () => {
          const { id, patch } = input as { id: string; patch: Partial<Row> };
          context.table.upsert({ ...context.table.rows.get(id)!, ...patch });
          resolve(context.table.position(id));
        };
      });
    // A user transaction is persisting…
    const tx = context.collection.update("a", (draft) => {
      draft.label = "mine";
    });
    await vi.waitFor(() => expect(release).toBeDefined());
    // …when an unrelated server change arrives.
    const batch = context.table.upsert({ id: "b", label: "B" });
    const position = { epoch: batch.epoch, seq: batch.seq };
    await context.utils.awaitReceived(position);
    const applied = vi.fn();
    void context.utils.awaitApplied(position).then(applied);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(applied).not.toHaveBeenCalled();
    expect(context.collection.has("b")).toBe(false);

    release();
    await tx.isPersisted.promise;
    await vi.waitFor(() => expect(applied).toHaveBeenCalled());
    expect(context.view()).toEqual([
      { id: "a", label: "mine" },
      { id: "b", label: "B" },
    ]);
  });

  it("(9) a CONFLICT rolls the optimistic row back", async () => {
    const context = setup();
    await live(context);
    context.table.insertHandler = async () => {
      throw Object.assign(new Error("taken"), { code: "CONFLICT" });
    };
    const tx = context.collection.insert({ id: "dup", label: "D" });
    expect(context.collection.has("dup")).toBe(true);
    await expect(tx.isPersisted.promise).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(context.collection.has("dup")).toBe(false);
  });

  it("(10) on echo timeout the handler resyncs and resolves", async () => {
    const context = setup([], { echoTimeoutMs: 30 });
    await live(context);
    context.table.insertHandler = async (input) => {
      const row = input as Row;
      // The write lands in main, but its batch never arrives.
      context.table.rows.set(row.id, { ...row, label: "stored" });
      context.table.seq += 1;
      return context.table.position(row.id);
    };
    const tx = context.collection.insert({ id: "t", label: "T" });
    await tx.isPersisted.promise;
    expect(context.table.snapshotCalls).toBe(2);
    await vi.waitFor(() =>
      expect(context.view()).toEqual([{ id: "t", label: "stored" }])
    );
  });

  it("(11) deletes by key, and toDeleteInput gets the row as the user saw it", async () => {
    const toDeleteInput = vi.fn((id: string, original: Row) => ({
      id,
      original,
    }));
    const context = setup([{ id: "a", label: "seen" }], { toDeleteInput });
    await live(context);
    context.table.deleteHandler = async (input) => {
      const { id } = input as { id: string };
      context.table.remove(id);
      return context.table.position(id);
    };
    await context.collection.delete("a").isPersisted.promise;
    expect(toDeleteInput).toHaveBeenCalledWith("a", { id: "a", label: "seen" });
    expect(context.table.live.batches.at(-1)).toMatchObject({
      changes: [{ type: "delete", key: "a" }],
    });
    expect(context.view()).toEqual([]);
  });

  it("(11b) idempotentDelete: a NOT_FOUND delete resolves as deleted after a resync (03 §24.5)", async () => {
    const notFound = typedNotFound();
    const context = setup([{ id: "a", label: "A" }], {
      idempotentDelete: true,
    });
    await live(context);
    // Main already dropped it without this client seeing the batch yet.
    context.table.rows.delete("a");
    context.table.deleteHandler = async () => {
      throw notFound;
    };
    await context.collection.delete("a").isPersisted.promise;
    await vi.waitFor(() => expect(context.view()).toEqual([]));
    expect(context.table.snapshotCalls).toBe(2);
  });

  it("(11c) without idempotentDelete a NOT_FOUND delete rolls back", async () => {
    const notFound = typedNotFound();
    const context = setup([{ id: "a", label: "A" }]);
    await live(context);
    context.table.deleteHandler = async () => {
      throw notFound;
    };
    await expect(
      context.collection.delete("a").isPersisted.promise
    ).rejects.toBe(notFound);
    expect(context.view()).toEqual([{ id: "a", label: "A" }]);
  });

  it("(12) overflow: reset then EOF reopens, re-snapshots, and a mutation echoes after", async () => {
    const context = setup([{ id: "a", label: "A" }]);
    await live(context);
    const first = context.table.live;
    context.table.rows.set("b", { id: "b", label: "B" });
    context.table.seq += 5;
    first.push({
      kind: "reset",
      epoch: context.table.epoch,
      seq: context.table.seq,
    });
    first.end();
    await vi.waitFor(() => expect(context.table.connections).toHaveLength(2));
    await vi.waitFor(() =>
      expect(context.view()).toEqual([
        { id: "a", label: "A" },
        { id: "b", label: "B" },
      ])
    );
    context.table.insertHandler = async (input) => {
      context.table.upsert(input as Row);
      return context.table.position((input as Row).id);
    };
    await context.collection.insert({ id: "c", label: "C" }).isPersisted
      .promise;
    expect(context.table.live.batches.at(-1)).toMatchObject({
      changes: [{ key: "c" }],
    });
    expect(context.view().map((row) => row.id)).toEqual(["a", "b", "c"]);
  });

  it("(13) a clean EOF without reset also reopens", async () => {
    const context = setup([{ id: "a", label: "A" }]);
    await live(context);
    context.table.live.end();
    await vi.waitFor(() => expect(context.table.connections).toHaveLength(2));
    context.table.upsert({ id: "a", label: "after" });
    await vi.waitFor(() =>
      expect(context.view()).toEqual([{ id: "a", label: "after" }])
    );
  });

  it("an error after the first snapshot keeps the rows and stays ready", async () => {
    const context = setup([{ id: "a", label: "A" }]);
    await live(context);
    context.table.live.fail(new Error("gone"));
    await vi.waitFor(() => expect(context.table.connections).toHaveLength(2));
    expect(context.collection.status).toBe("ready");
    expect(context.view()).toEqual([{ id: "a", label: "A" }]);
  });

  it("a table without a handler refuses that mutation", async () => {
    const table = new FakeTable<Row>();
    const collection = createCollection(
      ipcCollectionOptions<Row, string>({
        id: "read-only",
        table: async () => table.client,
        getKey: (row) => row.id,
        retryDelayMs: () => 0,
      })
    );
    cleanups.push(() => collection.cleanup());
    await collection.preload();
    expect(() => collection.insert({ id: "x", label: "X" })).toThrow();
  });
});

const tick = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));

describe("ipcCollectionOptions: snapshot loop and echo (impl review r1)", () => {
  it("(1b) resets buffered during a snapshot load, then a later reset and a change, all apply", async () => {
    const context = setup([{ id: "a", label: "A" }]);
    const held = context.table.holdSnapshot();
    const ready = context.collection.preload();
    await held.requested;
    // Two resets while the first snapshot is in flight (sessions-reloaded
    // twice, say), both newer than what the snapshot read.
    context.table.rows.set("b", { id: "b", label: "B" });
    context.table.seq += 1;
    context.table.broadcast({
      kind: "reset",
      epoch: context.table.epoch,
      seq: context.table.seq,
    });
    context.table.seq += 1;
    context.table.broadcast({
      kind: "reset",
      epoch: context.table.epoch,
      seq: context.table.seq,
    });
    held.release();
    await ready;
    await vi.waitFor(() => expect(context.utils.status().state).toBe("live"));
    await vi.waitFor(() => expect(context.view()).toEqual(context.server()));
    const calls = context.table.snapshotCalls;

    // The connection is not wedged: a later reset re-snapshots…
    context.table.rows.set("c", { id: "c", label: "C" });
    context.table.seq += 1;
    context.table.broadcast({
      kind: "reset",
      epoch: context.table.epoch,
      seq: context.table.seq,
    });
    await vi.waitFor(() => expect(context.table.snapshotCalls).toBe(calls + 1));
    await vi.waitFor(() => expect(context.view()).toEqual(context.server()));
    // …a change after it applies…
    context.table.upsert({ id: "a", label: "A2" });
    await vi.waitFor(() =>
      expect(context.utils.status().receivedSeq).toBe(context.table.seq)
    );
    expect(context.view()).toEqual(context.server());
    // …and a resync still settles.
    await expect(
      Promise.race([
        context.utils.resync().then(() => "settled"),
        tick(300).then(() => "hung"),
      ])
    ).resolves.toBe("settled");
  });

  it("(1c) a gap buffered during a snapshot load, then another reset, keeps syncing", async () => {
    const context = setup([{ id: "a", label: "A" }]);
    const held = context.table.holdSnapshot();
    void context.collection.preload();
    await held.requested;
    // seq 1 is lost; seq 2 lands in the buffer: a gap after the snapshot.
    context.table.rows.set("lost", { id: "lost", label: "?" });
    context.table.seq += 1;
    context.table.upsert({ id: "b", label: "B" });
    held.release();
    await vi.waitFor(() => expect(context.utils.status().state).toBe("live"));
    await vi.waitFor(() => expect(context.view()).toEqual(context.server()));
    const calls = context.table.snapshotCalls;
    expect(calls).toBe(2);

    context.table.seq += 1;
    context.table.rows.delete("lost");
    context.table.broadcast({
      kind: "reset",
      epoch: context.table.epoch,
      seq: context.table.seq,
    });
    await vi.waitFor(() => expect(context.table.snapshotCalls).toBe(calls + 1));
    await vi.waitFor(() => expect(context.view()).toEqual(context.server()));
  });

  it("(1d) resync right after preload loads a new snapshot and settles", async () => {
    const context = setup([{ id: "a", label: "A" }]);
    await context.collection.preload();
    const outcome = await Promise.race([
      context.utils.resync().then(() => "settled"),
      tick(300).then(() => "hung"),
    ]);
    expect(outcome).toBe("settled");
    expect(context.table.snapshotCalls).toBe(2);
  });

  it("(1e) a reset the snapshot already covers is dropped", async () => {
    const context = setup([{ id: "a", label: "A" }]);
    const held = context.table.holdSnapshot();
    void context.collection.preload();
    await held.requested;
    context.table.live.push({
      kind: "reset",
      epoch: context.table.epoch,
      seq: 1,
    });
    // The snapshot was read after that reset.
    held.release({ seq: 1 });
    await vi.waitFor(() => expect(context.utils.status().state).toBe("live"));
    await tick();
    expect(context.table.snapshotCalls).toBe(1);
  });

  it("(8d) a delete then a re-create of one key behind a persisting transaction applies", async () => {
    const context = setup([
      { id: "a", label: "A" },
      { id: "k", label: "old" },
    ]);
    await live(context);
    let release!: () => void;
    context.table.updateHandler = (input) =>
      new Promise((resolve) => {
        release = () => {
          const { id, patch } = input as { id: string; patch: Partial<Row> };
          context.table.upsert({ ...context.table.rows.get(id)!, ...patch });
          resolve(context.table.position(id));
        };
      });
    const tx = context.collection.update("a", (draft) => {
      draft.label = "mine";
    });
    await vi.waitFor(() => expect(release).toBeDefined());
    // While "a" persists, main deletes k and creates it again.
    context.table.remove("k");
    context.table.change([
      { type: "insert", key: "k", value: { id: "k", label: "new" } },
    ]);
    await vi.waitFor(() =>
      expect(context.utils.status().receivedSeq).toBe(context.table.seq)
    );
    release();
    await tx.isPersisted.promise;
    await vi.waitFor(() =>
      expect(context.view()).toEqual([
        { id: "a", label: "mine" },
        { id: "k", label: "new" },
      ])
    );
    expect(context.collection.status).toBe("ready");
  });

  it("(9b) a batch that fails to write leaves no pending transaction and resyncs", async () => {
    const context = setup([{ id: "a", label: "A" }]);
    await live(context);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    // A server bug: a row the key function cannot read.
    context.table.seq += 1;
    context.table.live.push({
      kind: "changes",
      epoch: context.table.epoch,
      seq: context.table.seq,
      changes: [{ type: "update", key: "x", value: null as never }],
    });
    await vi.waitFor(() => expect(context.table.snapshotCalls).toBe(2));
    context.table.upsert({ id: "b", label: "B" });
    await vi.waitFor(() =>
      expect(context.view()).toEqual([
        { id: "a", label: "A" },
        { id: "b", label: "B" },
      ])
    );
    expect(errors).toHaveBeenCalled();
    errors.mockRestore();
  });

  it("(10b) an echo timeout during an older in-flight snapshot waits for one that covers the write", async () => {
    const context = setup([], { echoTimeoutMs: 30 });
    await live(context);
    // A resync is in flight, its snapshot read at seq 0.
    const older = context.table.holdSnapshot();
    const earlier = context.utils.resync();
    await older.requested;
    context.table.insertHandler = async (input) => {
      const row = input as Row;
      // Main writes at seq 1; the batch is lost.
      context.table.rows.set(row.id, { ...row, label: "stored" });
      context.table.seq += 1;
      return context.table.position(row.id);
    };
    const tx = context.collection.insert({ id: "t", label: "T" });
    await tick(60);
    older.release();
    await earlier;
    await tx.isPersisted.promise;
    // Settled by a snapshot at or after the write, not the older one.
    expect(context.utils.status().receivedSeq).toBeGreaterThanOrEqual(1);
    expect(context.table.snapshotCalls).toBe(3);
    await vi.waitFor(() =>
      expect(context.view()).toEqual([{ id: "t", label: "stored" }])
    );
  });

  it("(10c) a mutation on a lazy collection never read starts its sync and echoes", async () => {
    const context = setup([], { echoTimeoutMs: 5_000 });
    expect(context.collection.status).toBe("idle");
    context.table.insertHandler = async (input) => {
      context.table.upsert(input as Row);
      return context.table.position((input as Row).id);
    };
    const started = Date.now();
    await context.collection.insert({ id: "n", label: "N" }).isPersisted
      .promise;
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(context.collection.status).toBe("ready");
    expect(context.view()).toEqual([{ id: "n", label: "N" }]);
  });

  it("(10d) an echo that never comes resolves after a bounded wait", async () => {
    const context = setup([], { echoTimeoutMs: 20 });
    await live(context);
    // Every later snapshot hangs: nothing will cover the write.
    context.table.holdSnapshot();
    context.table.insertHandler = async (input) => {
      context.table.seq += 1;
      return context.table.position((input as Row).id);
    };
    await expect(
      Promise.race([
        context.collection
          .insert({ id: "z", label: "Z" })
          .isPersisted.promise.then(() => "resolved"),
        tick(500).then(() => "hung"),
      ])
    ).resolves.toBe("resolved");
  });

  it("(10e) resync with no sync session rejects instead of hanging", async () => {
    const context = setup();
    await expect(context.utils.resync()).rejects.toMatchObject({
      name: "AbortError",
    });
  });

  it("(12b) overflow as the feed sends it: reset, then RESYNC_REQUIRED", async () => {
    const context = setup([{ id: "a", label: "A" }]);
    await live(context);
    const first = context.table.live;
    context.table.rows.set("b", { id: "b", label: "B" });
    context.table.seq += 5;
    first.push({
      kind: "reset",
      epoch: context.table.epoch,
      seq: context.table.seq,
    });
    first.fail(
      Object.assign(new Error("resync required"), {
        code: "RESYNC_REQUIRED",
        defined: true,
        data: { stream: "db.rows.changes" },
      })
    );
    await vi.waitFor(() => expect(context.table.connections).toHaveLength(2));
    await vi.waitFor(() => expect(context.utils.status().state).toBe("live"));
    expect(context.view()).toEqual(context.server());
    expect(context.collection.status).toBe("ready");
    context.table.insertHandler = async (input) => {
      context.table.upsert(input as Row);
      return context.table.position((input as Row).id);
    };
    await context.collection.insert({ id: "c", label: "C" }).isPersisted
      .promise;
    expect(context.view().map((row) => row.id)).toEqual(["a", "b", "c"]);
  });

  it("(14) backs off across failing snapshots; hello alone does not reset it", async () => {
    const attempts: number[] = [];
    const context = setup([{ id: "a", label: "A" }], {
      retryDelayMs: (attempt) => {
        attempts.push(attempt);
        return 0;
      },
    });
    const failures = [1, 2, 3].map(() => context.table.holdSnapshot());
    void context.collection.preload().catch(() => undefined);
    for (const failure of failures) {
      await failure.requested;
      failure.fail(new Error("read failed"));
    }
    await vi.waitFor(() => expect(context.utils.status().state).toBe("live"));
    expect(attempts.slice(0, 3)).toEqual([0, 1, 2]);
    // A good snapshot resets it.
    context.table.live.end();
    await vi.waitFor(() => expect(attempts.length).toBe(4));
    expect(attempts[3]).toBe(0);
  });

  it("(15) a dead connection is not current while the reopen waits", async () => {
    const context = setup([{ id: "a", label: "A" }], {
      retryDelayMs: () => 50,
    });
    await live(context);
    context.table.live.end();
    await tick();
    const pending = context.utils.resync();
    await tick();
    // Nothing asked the dead connection for a snapshot.
    expect(context.table.snapshotCalls).toBe(1);
    await pending;
    expect(context.table.connections).toHaveLength(2);
    expect(context.table.snapshotCalls).toBe(2);
  });
});

describe("across a replaced socket (spec 09 D3)", () => {
  it("is live again within one backoff step once the next socket opens", async () => {
    // As the host transport: a call waits for an open socket, and the
    // socket's streams fail when it drops.
    let state: TransportState = "open";
    const listeners = new Set<() => void>();
    const link = {
      get state() {
        return state;
      },
      onChange(listener: () => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    const set = (next: TransportState) => {
      state = next;
      for (const listener of Array.from(listeners)) listener();
    };
    const table = new FakeTable<Row>([{ id: "a", label: "A" }]);
    const client = {
      ...table.client,
      snapshot: async (...args: Parameters<typeof table.client.snapshot>) => {
        await untilOpen(link);
        return table.client.snapshot(...args);
      },
      changes: async (...args: Parameters<typeof table.client.changes>) => {
        await untilOpen(link, args[1]?.signal);
        return table.client.changes(...args);
      },
    };
    const collection = createCollection(
      ipcCollectionOptions<Row, string>({
        id: `rows-${Math.random()}`,
        table: async () => client,
        getKey: (row) => row.id,
        retryDelayMs: () => 500,
      })
    );
    cleanups.push(() => collection.cleanup());
    await collection.preload();
    await vi.waitFor(() =>
      expect(collection.utils.status().state).toBe("live")
    );
    vi.useFakeTimers();
    try {
      // The socket drops; a row changes while none is open.
      set("reconnecting");
      table.live.fail(new Error("socket closed"));
      table.rows.set("b", { id: "b", label: "B" });
      table.seq += 1;
      await vi.advanceTimersByTimeAsync(5_000);
      expect(collection.utils.status().state).not.toBe("live");
      set("open");
      await vi.advanceTimersByTimeAsync(500);
      await vi.waitFor(() =>
        expect(collection.utils.status().state).toBe("live")
      );
      expect(collection.toArray.map((row) => row.id).sort()).toEqual([
        "a",
        "b",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
});
