/**
 * R2-T34 (spec 02 §3.4, review r2-13): the connection state comes from the
 * pump, not from the client's chunk-driven state. Also R2-T7 (§12.3): a run
 * finishing while unmounted, remount from the LRU or after retirement, no
 * leaked iterators.
 */
import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as b from "../fixtures/builders";
import { golden } from "../fixtures/goldens";
import { FakeRelay } from "../fixtures/relay";
import { useThreadHost } from "./host";
import { createChatRuntime } from "./runtime";
import { ThreadSession } from "./session";

const sessions: ThreadSession[] = [];
afterEach(() => {
  for (const session of sessions.splice(0)) session.retire();
});

describe("R2-T34 connection", () => {
  it("connected after abacus.subscribed on an idle thread; reconnecting; error after three failures", async () => {
    const relay = new FakeRelay();
    relay.emitAll(b.sessionReady());
    const session = new ThreadSession({
      ai: relay.ai,
      threadId: "t-1",
      pumpRetryDelaysMs: [30, 30],
    });
    sessions.push(session);
    await session.load();
    await vi.waitFor(() => expect(session.hostStore.state.connection).toBe("connected"));
    const host = renderHook(() => useThreadHost(session));
    expect(host.result.current.connectionStatus).toBe("connected");

    relay.faults.subscribe = () => new Error("down");
    relay.dropSubscriptions();
    await vi.waitFor(() => expect(session.hostStore.state.connection).toBe("reconnecting"));
    host.rerender();
    expect(host.result.current.connectionStatus).toBe("connecting");
    await vi.waitFor(() => expect(session.hostStore.state.connection).toBe("error"));
    host.rerender();
    expect(host.result.current.connectionStatus).toBe("error");
    expect(host.result.current.isSubscribed).toBe(false);
    host.unmount();
  });
});

describe("R2-T7 unmounted", () => {
  it("a run finishing while unmounted shows at remount, from the LRU and after eviction", async () => {
    const events = golden("plain-text");
    const cut = events.findIndex((item) => item.event.type === "TEXT_MESSAGE_CONTENT") + 1;
    const relay = new FakeRelay({ events: events.slice(0, cut) });
    const runtime = createChatRuntime(relay.ai, { capacity: 1 });
    const session = runtime.session("t-1");
    const release = session.pin();
    await session.load();
    expect(session.store.state.runs.active).not.toBeNull();
    release();
    relay.emitAll(events.slice(cut).map((item) => item.event));
    await vi.waitFor(() => expect(session.store.state.runs.active).toBeNull());
    // Same session within the LRU: live state at once.
    expect(runtime.session("t-1")).toBe(session);
    expect(session.store.state.runs.outcomes).toHaveLength(1);

    // Another thread evicts it: retired, iterators closed.
    runtime.session("t-2");
    expect(session.retired).toBe(true);
    await vi.waitFor(() => expect(relay.stats.openIterators).toBe(0));
    const again = runtime.session("t-1");
    expect(again).not.toBe(session);
    await again.load();
    expect(again.hostStore.state.messages).toHaveLength(2);
    expect(again.store.state.runs.outcomes).toHaveLength(1);
    expect(again.store.state.runs.active).toBeNull();
    runtime.forget("t-1");
    runtime.forget("t-2");
    await vi.waitFor(() => expect(relay.stats.openIterators).toBe(0));
  });
});
