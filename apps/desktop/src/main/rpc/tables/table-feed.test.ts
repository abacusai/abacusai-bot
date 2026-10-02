/**
 * B-T2: the table feed's wire guarantees, without a transport.
 */
import { describe, expect, it } from "vitest";

import type { ChangeBatch } from "#shared/contract/rows";

import { TableFeed } from "./table-feed";

interface Row {
  id: string;
  label: string;
}

const feedOver = (rows: Row[], maxPendingBatches?: number) => {
  let current = rows;
  let reads = 0;
  const feed = new TableFeed<Row>({
    name: "things",
    read: () => {
      reads += 1;
      return current;
    },
    getKey: (row) => row.id,
    maxPendingBatches,
  });
  return {
    feed,
    set: (next: Row[]) => {
      current = next;
    },
    reads: () => reads,
  };
};

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

type Batch = ChangeBatch<Row, string>;

const take = async (
  stream: AsyncGenerator<Batch, void, unknown>,
  count: number
): Promise<Batch[]> => {
  const out: Batch[] = [];
  for (let i = 0; i < count; i++) {
    const next = await stream.next();
    if (next.done === true) break;
    out.push(next.value);
  }
  return out;
};

describe("TableFeed (B-T2)", () => {
  it("diffs into insert, update and delete with contiguous seqs", async () => {
    const { feed, set } = feedOver([
      { id: "a", label: "A" },
      { id: "b", label: "B" },
    ]);
    expect(feed.snapshot()).toMatchObject({ seq: 0, epoch: feed.epoch });

    const stream = feed.subscribe();
    const [hello] = await take(stream, 1);
    expect(hello).toEqual({ kind: "hello", epoch: feed.epoch, seq: 0 });

    set([
      { id: "a", label: "A2" },
      { id: "c", label: "C" },
    ]);
    expect(feed.notifyNow()).toBe(1);
    set([{ id: "c", label: "C" }]);
    expect(feed.notifyNow()).toBe(2);

    const batches = await take(stream, 2);
    expect(batches).toEqual([
      {
        kind: "changes",
        epoch: feed.epoch,
        seq: 1,
        changes: [
          { type: "update", key: "a", value: { id: "a", label: "A2" } },
          { type: "insert", key: "c", value: { id: "c", label: "C" } },
          { type: "delete", key: "b" },
        ],
      },
      {
        kind: "changes",
        epoch: feed.epoch,
        seq: 2,
        changes: [{ type: "delete", key: "a" }],
      },
    ]);
    await stream.return();
  });

  it("publishes nothing for a diff with no change, key order included", async () => {
    const { feed, set } = feedOver([{ id: "a", label: "A" }]);
    feed.snapshot();
    const stream = feed.subscribe();
    await take(stream, 1);
    set([{ label: "A", id: "a" }]);
    expect(feed.notifyNow()).toBe(0);
    set([{ id: "a", label: "B" }]);
    expect(feed.notifyNow()).toBe(1);
    const [batch] = await take(stream, 1);
    expect(batch).toMatchObject({ kind: "changes", seq: 1 });
    await stream.return();
  });

  it("yields hello before any batch, at the seq it registered at", async () => {
    const { feed, set } = feedOver([{ id: "a", label: "A" }]);
    feed.snapshot();
    set([{ id: "a", label: "1" }]);
    feed.notifyNow();
    set([{ id: "a", label: "2" }]);
    feed.notifyNow();

    const stream = feed.subscribe();
    const first = stream.next();
    // A change between registration and the first read is queued after hello.
    set([{ id: "a", label: "3" }]);
    feed.notifyNow();
    await expect(first).resolves.toMatchObject({
      value: { kind: "hello", seq: 2 },
    });
    // The hello was taken at first read; the batch that followed is seq 3.
    const [next] = await take(stream, 1);
    expect(next).toMatchObject({ kind: "changes", seq: 3 });
    await stream.return();
  });

  it("keeps snapshot rows and seq in agreement under concurrent notifies", async () => {
    const { feed, set } = feedOver([{ id: "a", label: "0" }]);
    feed.snapshot();
    for (let i = 1; i <= 5; i++) {
      set([{ id: "a", label: String(i) }]);
      feed.notify();
      const snapshot = feed.snapshot();
      expect(snapshot.rows).toEqual([{ id: "a", label: String(i) }]);
      expect(snapshot.seq).toBe(i);
    }
    // The coalesced notifies find nothing left to publish.
    await tick();
    expect(feed.seq).toBe(5);
  });

  it("coalesces a burst of 100 notifies into one diff and one batch", async () => {
    const { feed, set, reads } = feedOver([{ id: "a", label: "0" }]);
    feed.snapshot();
    const stream = feed.subscribe();
    await take(stream, 1);
    const before = reads();
    for (let i = 1; i <= 100; i++) {
      set([{ id: "a", label: String(i) }]);
      feed.notify();
    }
    await tick();
    expect(reads() - before).toBe(1);
    expect(feed.seq).toBe(1);
    const [batch] = await take(stream, 1);
    expect(batch).toMatchObject({
      seq: 1,
      changes: [{ type: "update", value: { label: "100" } }],
    });
    await stream.return();
  });

  it("notifyNow returns the seq of the batch that holds the change", () => {
    const { feed, set } = feedOver([]);
    feed.snapshot();
    set([{ id: "x", label: "X" }]);
    const seq = feed.notifyNow();
    expect(seq).toBe(1);
    expect(feed.snapshot()).toMatchObject({
      seq,
      rows: [{ id: "x", label: "X" }],
    });
    // Idempotent: nothing changed, the current position comes back.
    expect(feed.notifyNow()).toBe(1);
  });

  it("reset publishes a reset batch and advances seq", async () => {
    const { feed } = feedOver([{ id: "a", label: "A" }]);
    feed.snapshot();
    const stream = feed.subscribe();
    await take(stream, 1);
    feed.reset();
    const [batch] = await take(stream, 1);
    expect(batch).toEqual({ kind: "reset", epoch: feed.epoch, seq: 1 });
    await stream.return();
  });

  it("ends an overflowed stream with reset, then RESYNC_REQUIRED", async () => {
    const { feed, set } = feedOver([{ id: "a", label: "0" }], 3);
    feed.snapshot();
    const stuck = feed.subscribe();
    await take(stuck, 1);
    const healthy = feed.subscribe();
    await take(healthy, 1);
    for (let i = 1; i <= 4; i++) {
      set([{ id: "a", label: String(i) }]);
      feed.notifyNow();
      // The healthy reader keeps up.
      await expect(healthy.next()).resolves.toMatchObject({
        value: { seq: i },
      });
    }
    // The stuck one was detached at once and hears only the reset.
    expect(feed.subscriberCount).toBe(1);
    await expect(stuck.next()).resolves.toMatchObject({
      value: { kind: "reset", epoch: feed.epoch, seq: 4 },
    });
    await expect(stuck.next()).rejects.toMatchObject({
      code: "RESYNC_REQUIRED",
      data: { stream: "db.things.changes" },
    });
    await healthy.return();
    expect(feed.subscriberCount).toBe(0);
  });

  it("unsubscribes in finally when the signal aborts", async () => {
    const { feed } = feedOver([]);
    const controller = new AbortController();
    const stream = feed.subscribe(controller.signal);
    await take(stream, 1);
    expect(feed.subscriberCount).toBe(1);
    const parked = stream.next();
    controller.abort();
    await expect(parked).resolves.toMatchObject({ done: true });
    expect(feed.subscriberCount).toBe(0);
  });

  it("runs publish listeners after each batch (derived tables)", () => {
    const { feed, set } = feedOver([]);
    feed.snapshot();
    let calls = 0;
    const off = feed.onPublish(() => {
      calls += 1;
    });
    set([{ id: "a", label: "A" }]);
    feed.notifyNow();
    feed.notifyNow();
    feed.reset();
    off();
    feed.reset();
    expect(calls).toBe(2);
  });
});
