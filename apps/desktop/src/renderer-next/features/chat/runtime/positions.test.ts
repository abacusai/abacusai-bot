/**
 * R2-T1 (spec 02 §3.3): positions start at `startSeq − 1` with an active
 * run (inclusive replay, `RUN_STARTED` replayed) and at `N` without; busy,
 * the Stop target and `sessionGenerating` hold before any replayed content;
 * `reconstructed` flips only at `appliedSeq ≥ N`; a stale hydrate is dropped.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { golden } from "../fixtures/goldens";
import { FakeRelay } from "../fixtures/relay";
import { ThreadSession } from "./session";

const sessions: ThreadSession[] = [];
const open = (
  relay: FakeRelay,
  extra: Partial<ConstructorParameters<typeof ThreadSession>[0]> = {}
) => {
  const session = new ThreadSession({
    ai: relay.ai,
    threadId: relay.threadId,
    recoveryDelaysMs: [0, 0, 0],
    ...extra,
  });
  sessions.push(session);
  return session;
};

afterEach(() => {
  for (const session of sessions.splice(0)) session.retire();
});

const textOf = (message: { parts: Array<{ type: string }> } | undefined) =>
  (message?.parts ?? [])
    .filter((part) => part.type === "text")
    .map((part) => (part as unknown as { content: string }).content)
    .join("");

describe("R2-T1 positions", () => {
  it("starts at N with no active run and is ready at once", async () => {
    const relay = new FakeRelay({ events: golden("plain-text") });
    const session = open(relay);
    await session.load();
    const positions = session.positions()!;
    expect(positions.checkpoint).toBe(relay.lastSeq);
    expect(positions.receivedSeq).toBe(relay.lastSeq);
    expect(positions.reconstructed).toBe(true);
    expect(relay.stats.joinRun).toBe(0);
    const host = session.hostStore.state;
    expect(host.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(textOf(host.messages[1])).toBe("Hello there.");
    expect(session.store.state.runs.outcomes).toHaveLength(1);
    expect(session.store.state.runs.active).toBeNull();
    expect(host.sessionGenerating).toBe(false);
  });

  it("replays the active run inclusively from RUN_STARTED", async () => {
    const events = golden("plain-text");
    const cut = events.findIndex(
      (item) =>
        item.event.type === "TEXT_MESSAGE_CONTENT" &&
        (item.event as { messageId: string }).messageId !== "u-1"
    );
    const relay = new FakeRelay({ events: events.slice(0, cut + 1) });
    const startSeq = relay.activeRun()!.startSeq;
    const session = open(relay);
    await session.load();
    const positions = session.positions()!;
    expect(positions.appliedSeq).toBeGreaterThanOrEqual(positions.checkpoint);
    expect(relay.stats.joinRun).toBe(1);
    const host = session.hostStore.state;
    // The hydrate excludes the run; the replay rebuilt its echo and text.
    expect(host.messages.map((m) => m.id)).toEqual(["u-1", "<MSG_1>"]);
    expect(textOf(host.messages[1])).toBe("Hello there.");
    expect(session.store.state.runs.active?.runId).toBe("run-1");
    expect(host.sessionGenerating).toBe(true);
    expect(startSeq).toBeGreaterThan(0);

    // The rest streams live into the same client.
    relay.emitAll(events.slice(cut + 1).map((item) => item.event));
    await vi.waitFor(() =>
      expect(session.store.state.runs.outcomes).toHaveLength(1)
    );
    expect(session.store.state.runs.active).toBeNull();
    expect(session.hostStore.state.messages).toHaveLength(2);
  });

  it("is busy with a Stop target before any replayed content", async () => {
    const events = golden("plain-text");
    const cut = events.findIndex(
      (item) => item.event.type === "TEXT_MESSAGE_END"
    );
    const relay = new FakeRelay({ events: events.slice(0, cut + 1) });
    relay.faults.joinRun = () => "stall";
    const session = open(relay, { readyCapMs: 20 });
    await session.load();
    expect(session.hostStore.state.partial).toBe(true);
    expect(session.positions()!.reconstructed).toBe(false);
    expect(session.hostStore.state.messages).toEqual([]);
    expect(session.store.state.runs.active?.runId).toBe("run-1");
    expect(session.stopTarget()).toBe("run-1");
    expect(session.hostStore.state.sessionGenerating).toBe(true);
  });

  it("drops a superseded generation's hydrate", async () => {
    const relay = new FakeRelay({ events: golden("plain-text") });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    relay.faults.hydrate = (call) => (call === 1 ? gate : null);
    const session = open(relay);
    const first = session.load();
    await vi.waitFor(() => expect(relay.stats.hydrate).toBe(1));
    const second = session.reconnect();
    await second;
    release();
    await first;
    expect(session.gen).toBe(2);
    expect(session.hostStore.state.gen).toBe(2);
  });
});
