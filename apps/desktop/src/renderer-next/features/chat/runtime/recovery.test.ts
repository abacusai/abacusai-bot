/**
 * R2-T4 (spec 02 §3.3, §3.2, §12.2): recovery before and after the
 * checkpoint, `abacus.resync`, ring eviction across a reset, and readiness
 * chaining across superseded generations.
 */
import type { StreamChunk } from "@tanstack/ai";
import { ORPCError } from "@orpc/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { golden } from "../fixtures/goldens";
import { FakeRelay, type RelayEvent } from "../fixtures/relay";
import { ThreadRetiredError, ThreadSession } from "./session";

const sessions: ThreadSession[] = [];
const open = (relay: FakeRelay, extra: Partial<ConstructorParameters<typeof ThreadSession>[0]> = {}) => {
  const session = new ThreadSession({
    ai: relay.ai,
    threadId: relay.threadId,
    recoveryDelaysMs: [0, 0, 0, 0, 0, 0],
    pumpRetryDelaysMs: [1, 1],
    ...extra,
  });
  sessions.push(session);
  return session;
};
afterEach(() => {
  for (const session of sessions.splice(0)) session.retire();
});

const timeless = (value: unknown): unknown =>
  JSON.parse(JSON.stringify(value, (key, v: unknown) => (key === "createdAt" ? undefined : v)));

/** The golden cut inside its run (after the tool call ended). */
const midRun = (): { before: RelayEvent[]; after: RelayEvent[] } => {
  const events = golden("tool-bash");
  const cut = events.findIndex((item) => item.event.type === "TOOL_CALL_RESULT");
  return { before: events.slice(0, cut), after: events.slice(cut) };
};

const reference = async (): Promise<unknown> => {
  const relay = new FakeRelay({ events: golden("tool-bash") });
  const session = open(relay);
  await session.load();
  return timeless(session.hostStore.state.messages);
};

describe("R2-T4 recovery", () => {
  it("a join failure after every replay chunk before N rebuilds identically", async () => {
    const expected = await reference();
    const { before, after } = midRun();
    const startIndex = before.findIndex((item) => item.event.type === "RUN_STARTED");
    const replayLength = before.length - startIndex;
    for (let failAt = 1; failAt < replayLength; failAt += 1) {
      const relay = new FakeRelay({ events: before });
      relay.faults.joinRun = (call, delivered) =>
        call === 1 && delivered === failAt ? new Error("port lost") : null;
      const session = open(relay);
      await session.load();
      expect(session.gen).toBe(2);
      relay.emitAll(after.map((item) => item.event));
      await vi.waitFor(() => expect(session.store.state.runs.outcomes).toHaveLength(1));
      expect(timeless(session.hostStore.state.messages)).toEqual(expected);
      session.retire();
    }
  });

  it("a join ending after N switches to subscribe seamlessly", async () => {
    const expected = await reference();
    const { before, after } = midRun();
    const relay = new FakeRelay({ events: before });
    const replay = before.length - before.findIndex((item) => item.event.type === "RUN_STARTED");
    relay.faults.joinRun = (_call, delivered) => (delivered === replay ? "end" : null);
    const session = open(relay);
    await session.load();
    relay.emitAll(after.map((item) => item.event));
    await vi.waitFor(() => expect(session.store.state.runs.outcomes).toHaveLength(1));
    expect(session.gen).toBe(1);
    expect(relay.stats.subscribe).toBeGreaterThanOrEqual(1);
    expect(timeless(session.hostStore.state.messages)).toEqual(expected);
  });

  it("abacus.resync starts a new generation and disposes the old client", async () => {
    const relay = new FakeRelay({ events: golden("plain-text") });
    const clients: Array<{ g: number; disposed: boolean }> = [];
    const session = open(relay, {
      onClient: (client, g) => {
        const entry = { g, disposed: false };
        clients.push(entry);
        const dispose = client.dispose.bind(client);
        client.dispose = () => {
          entry.disposed = true;
          dispose();
        };
      },
    });
    await session.load();
    await vi.waitFor(() => expect(session.hostStore.state.connection).toBe("connected"));
    // The ring moved past our resume point while the port blipped.
    relay.dropSubscriptions();
    relay.emit({ type: "CUSTOM", name: "agent.status", value: { status: "idle" } } as unknown as StreamChunk);
    relay.floor = relay.lastSeq;
    await vi.waitFor(() => expect(session.gen).toBe(2));
    await session.load();
    expect(clients.find((c) => c.g === 1)?.disposed).toBe(true);
    await vi.waitFor(() => expect(relay.stats.openIterators).toBe(1));
  });

  it("an epoch mismatch answers resync and rebuilds", async () => {
    const relay = new FakeRelay({ events: golden("plain-text") });
    const session = open(relay);
    await session.load();
    await vi.waitFor(() => expect(session.hostStore.state.connection).toBe("connected"));
    relay.setEpoch("epoch-2");
    relay.dropSubscriptions();
    await vi.waitFor(() => expect(session.gen).toBe(2));
    await session.load();
    expect(session.hostStore.state.messages).toHaveLength(2);
  });

  it("ring eviction with a reset in the gap shows the empty transcript", async () => {
    const relay = new FakeRelay({ events: golden("plain-text") });
    const session = open(relay);
    await session.load();
    expect(session.hostStore.state.messages).toHaveLength(2);
    relay.emit({ type: "CUSTOM", name: "session.cleared", value: {} } as unknown as StreamChunk);
    await vi.waitFor(() => expect(session.gen).toBe(2));
    await session.load();
    expect(session.hostStore.state.messages).toEqual([]);
    expect(session.rev).toBe(1);
  });

  it("chains readiness across superseded generations; retire rejects every waiter", async () => {
    const { before } = midRun();
    const relay = new FakeRelay({ events: before });
    relay.faults.joinRun = (call, delivered) => (call <= 2 && delivered === 1 ? new Error("lost") : null);
    const session = open(relay);
    const a = session.load();
    const b = session.load();
    expect(a).toBe(b);
    await expect(Promise.all([a, b])).resolves.toEqual([undefined, undefined]);
    expect(session.gen).toBe(3);
    expect(session.ready).toBe(true);

    const relay2 = new FakeRelay({ events: before });
    relay2.faults.joinRun = (_call, delivered) => (delivered === 1 ? new Error("lost") : null);
    const session2 = open(relay2, { recoveryDelaysMs: [30, 30, 30] });
    const c = session2.load();
    const d = session2.load();
    await vi.waitFor(() => expect(session2.gen).toBeGreaterThanOrEqual(2));
    session2.retire();
    await expect(c).rejects.toBeInstanceOf(ThreadRetiredError);
    await expect(d).rejects.toBeInstanceOf(ThreadRetiredError);
  });

  it("a failed hydrate rejects readiness; NOT_FOUND marks the thread gone", async () => {
    const relay = new FakeRelay({ events: golden("plain-text") });
    relay.faults.hydrate = (call) =>
      call === 1 ? new ORPCError("NOT_FOUND", { data: { entity: "thread", id: "t-1" } }) : null;
    const session = open(relay);
    await expect(session.load()).rejects.toBeInstanceOf(ORPCError);
    expect(session.hostStore.state.notFound).toBe(true);
    expect(session.hostStore.state.phase).toBe("error");
    await session.load();
    expect(session.ready).toBe(true);
  });
});
