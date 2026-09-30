/**
 * R6-T44 (main side, spec 06 §11.2, §23.6): `ai.attention` over the relay
 * with scripted agent streams, through the real router. A snapshot taken
 * with registration, then revisioned `upsert`/`remove` for every thread's
 * live-incarnation `permission.pending`.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AttentionEvent } from "#shared/contract";

import { AguiRelayService } from "../services/agui/relay-service";
import { ThreadStore } from "../services/session/thread-store";
import { connectInProcess, fakeDeps } from "./testing";

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "agui-attention-"));
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

const setup = () => {
  const runtimes = new Map<string, object>();
  const relay = new AguiRelayService({
    host: {
      workspaceOf: () => "w1",
      runtime: () => ({ wire: "agui", status: "running" }),
      start: async () => true,
      send: () => null,
      markSent: () => undefined,
      markStopped: () => undefined,
    },
    files: new ThreadStore({ home: () => home, log: () => undefined }),
    aguiForEverySpawn: true,
    log: () => undefined,
  });
  const emit = (threadId: string, event: Record<string, unknown>): void =>
    relay.ingest(threadId, event, {
      wire: "agui",
      runtime: runtimes.get(threadId) ?? {},
    });
  const boot = (threadId: string, incarnation: string): object => {
    const runtime = {};
    runtimes.set(threadId, runtime);
    emit(threadId, {
      type: "CUSTOM",
      name: "wire.hello",
      value: { protocol: 1, wire: "agui", compat: "fd", incarnation },
    });
    return runtime;
  };
  const pending = (
    threadId: string,
    incarnation: string,
    items: Array<{ id: string; question?: boolean; message?: string }>
  ): void =>
    emit(threadId, {
      type: "CUSTOM",
      name: "permission.pending",
      value: {
        incarnation,
        items: items.map((item) => ({
          id: item.id,
          reason: item.question ? "abacus:question" : "abacus:permission",
          message: item.message ?? `ask ${item.id}`,
          metadata: {
            abacus: {
              lineage: {
                threadId,
                incarnation,
                turnSeq: 1,
                permissionId: item.id,
              },
              kind: item.question ? "question" : "bash",
              request: {},
              attachedBy: "gate",
              allowed: ["accept", "reject"],
            },
          },
        })),
      },
    });
  const connection = connectInProcess(fakeDeps({ ai: relay }));
  return { relay, emit, boot, pending, client: connection.client, connection };
};

/** A read that gave up waiting keeps its pending `next()` for the next call. */
const parked = new WeakMap<
  AsyncIterator<unknown>,
  Promise<IteratorResult<unknown>>
>();

const next = async (
  stream: AsyncIterator<unknown>
): Promise<AttentionEvent | null> => {
  const read = parked.get(stream) ?? stream.next();
  parked.set(stream, read);
  const result = await Promise.race([
    read,
    new Promise<"idle">((resolve) => setTimeout(() => resolve("idle"), 50)),
  ]);
  if (result === "idle") return null;
  parked.delete(stream);
  if (result.done === true) return null;
  return result.value as AttentionEvent;
};

/** A client reducer: stale revisions ignored, a snapshot replaces state. */
const reducer = () => {
  let revision = -1;
  const state = new Map<string, unknown>();
  return {
    state,
    apply(event: AttentionEvent): boolean {
      if (event.type === "snapshot") {
        state.clear();
        for (const item of event.items) state.set(item.threadId, item);
        revision = event.revision;
        return true;
      }
      if (event.revision <= revision) return false;
      revision = event.revision;
      if (event.type === "upsert") state.set(event.item.threadId, event.item);
      else state.delete(event.threadId);
      return true;
    },
  };
};

describe("ai.attention (spec 06 §11.2)", () => {
  it("snapshots atomically with registration: a change raced with the subscribe is seen exactly once", async () => {
    const { client, boot, pending } = setup();
    boot("s1", "inc-1");
    boot("s2", "inc-1");
    pending("s1", "inc-1", [{ id: "p1" }]);

    const call = client.ai.attention({});
    // Raced: it lands before or after registration, never in both or neither.
    pending("s2", "inc-1", [{ id: "q1", question: true }]);
    const stream = await call;

    const events: AttentionEvent[] = [];
    for (
      let event = await next(stream);
      event != null;
      event = await next(stream)
    )
      events.push(event);
    expect(events[0]!.type).toBe("snapshot");
    const seenS2 = events.flatMap((event) =>
      event.type === "snapshot"
        ? event.items.filter((item) => item.threadId === "s2")
        : event.type === "upsert" && event.item.threadId === "s2"
          ? [event.item]
          : []
    );
    expect(seenS2).toHaveLength(1);
    // Revisions only increase after the snapshot's.
    const revisions = events.map((event) => event.revision);
    expect([...revisions].sort((a, b) => a - b)).toEqual(revisions);
    await stream.return?.(undefined);
  });

  it("counts questions and approvals, removes on zero counts, and revisions increase", async () => {
    const { client, boot, pending } = setup();
    boot("s1", "inc-1");
    const stream = await client.ai.attention({});
    const client1 = reducer();
    const snapshot = (await next(stream))!;
    expect(snapshot).toEqual({ type: "snapshot", revision: 0, items: [] });
    client1.apply(snapshot);

    pending("s1", "inc-1", [
      { id: "p1", message: "Run npm test?" },
      { id: "q1", question: true },
      { id: "p2" },
    ]);
    const upsert = (await next(stream))!;
    expect(upsert).toMatchObject({
      type: "upsert",
      revision: 1,
      item: {
        threadId: "s1",
        incarnation: "inc-1",
        questions: 1,
        approvals: 2,
        firstTitle: "Run npm test?",
      },
    });
    expect(client1.apply(upsert)).toBe(true);
    // A stale event (lower revision) is ignored by the client reducer.
    expect(client1.apply({ type: "remove", revision: 0, threadId: "s1" })).toBe(
      false
    );
    expect(client1.state.has("s1")).toBe(true);

    // The same set again publishes nothing; answering one updates.
    pending("s1", "inc-1", [
      { id: "p1", message: "Run npm test?" },
      { id: "q1", question: true },
      { id: "p2" },
    ]);
    pending("s1", "inc-1", [{ id: "q1", question: true }]);
    const smaller = (await next(stream))!;
    expect(smaller).toMatchObject({
      type: "upsert",
      revision: 2,
      item: { questions: 1, approvals: 0 },
    });

    pending("s1", "inc-1", []);
    expect(await next(stream)).toEqual({
      type: "remove",
      revision: 3,
      threadId: "s1",
    });
    expect(await next(stream)).toBeNull();
    await stream.return?.(undefined);
  });

  it("a respawn with a new string incarnation removes the old item; the new one appears only with its own entries", async () => {
    const { client, relay, boot, pending } = setup();
    const first = boot("s1", "inc-1");
    pending("s1", "inc-1", [{ id: "p1" }]);
    const stream = await client.ai.attention({});
    expect(await next(stream)).toMatchObject({
      type: "snapshot",
      items: [{ threadId: "s1", incarnation: "inc-1", approvals: 1 }],
    });

    // The process ends (the relay clears its pending list), a new one boots.
    relay.runtimeExited("s1", {
      origin: { wire: "agui", runtime: first },
      code: 0,
      signal: null,
      requested: true,
    });
    expect(await next(stream)).toMatchObject({
      type: "remove",
      threadId: "s1",
    });
    boot("s1", "inc-2");
    // The dead incarnation's list, replayed late, is not answerable.
    pending("s1", "inc-1", [{ id: "p-old" }]);
    expect(await next(stream)).toBeNull();
    pending("s1", "inc-2", [{ id: "q9", question: true }]);
    expect(await next(stream)).toMatchObject({
      type: "upsert",
      item: {
        threadId: "s1",
        incarnation: "inc-2",
        questions: 1,
        approvals: 0,
      },
    });

    // A respawn without its process's exit being seen first: the new
    // incarnation's hello alone removes the old item.
    boot("s1", "inc-3");
    expect(await next(stream)).toMatchObject({
      type: "remove",
      threadId: "s1",
    });
    await stream.return?.(undefined);
  });

  it("session deletion removes; a reconnect starts from a fresh snapshot", async () => {
    const { client, relay, boot, pending, connection } = setup();
    boot("s1", "inc-1");
    boot("s2", "inc-1");
    boot("s3", "inc-1");
    pending("s1", "inc-1", [{ id: "a" }]);
    pending("s2", "inc-1", [{ id: "b" }]);
    pending("s3", "inc-1", [{ id: "c", question: true }]);
    const stream = await client.ai.attention({});
    const snapshot = (await next(stream))!;
    expect(snapshot.type === "snapshot" && snapshot.items.length).toBe(3);

    relay.forgetThread("s2");
    expect(await next(stream)).toMatchObject({
      type: "remove",
      threadId: "s2",
    });

    // Transport loss mid-stream, then a new subscription.
    connection.closeClient();
    pending("s1", "inc-1", []);
    const again = connectInProcess(fakeDeps({ ai: relay }));
    const fresh = await again.client.ai.attention({});
    const replaced = (await next(fresh))!;
    expect(replaced.type).toBe("snapshot");
    expect(
      replaced.type === "snapshot" &&
        replaced.items.map((item) => [item.threadId, item.questions])
    ).toEqual([["s3", 1]]);
    expect(replaced.revision).toBeGreaterThan(snapshot.revision);
    await fresh.return?.(undefined);
  });

  it("an overflowing subscriber ends with RESYNC_REQUIRED", async () => {
    const { relay, boot, pending } = setup();
    boot("s1", "inc-1");
    const abort = new AbortController();
    const iterator = relay.attention(abort.signal)[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toMatchObject({ type: "snapshot" });
    for (let index = 0; index <= 10_000; index += 1)
      pending("s1", "inc-1", index % 2 === 0 ? [{ id: "p" }] : []);

    await expect(
      (async () => {
        for (;;) {
          const result = await iterator.next();
          if (result.done === true) return;
        }
      })()
    ).rejects.toMatchObject({ code: "RESYNC_REQUIRED" });
    abort.abort();
  });
});
