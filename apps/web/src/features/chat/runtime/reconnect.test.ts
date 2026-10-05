/**
 * Chat across a replaced connection (spec 09 D2, D3): the pump keeps its
 * retry budget while the socket is down and resumes from its position on the
 * next one, a session that gave up is restarted when a socket opens, the
 * readiness cap does not run while the host is still starting, a send
 * that never left the page stays "Not sent" instead of being re-sent, an
 * uncertain send waits for the thread to be subscribed again before its
 * re-send (answered `duplicate` by the same host, dropped when a restarted
 * host's history already holds it), and a stream that a 1009 close cut off
 * twice is not replayed again.
 */
import type { AiSendInput } from "@abacus-ai/contract/contract/ai";
import type { StreamChunk } from "@tanstack/ai";
import { afterEach, describe, expect, it, vi } from "vitest";

import { eventSeq, type AiClient } from "#renderer/data/ai";
import {
  hostUnavailable,
  type TransportState,
} from "#renderer/data/transport/lifecycle";

import * as b from "../fixtures/builders";
import { FakeRelay } from "../fixtures/relay";
import { createChatRuntime } from "./runtime";
import { ThreadSession } from "./session";

/** The transport's connection, driven by the test. */
interface TestConnection {
  state: TransportState;
  generation: number;
  onChange(listener: () => void): () => void;
  set(next: TransportState, generation?: number): void;
  /** The close code each ended generation recorded. */
  codes: Map<number, number>;
  closeCode(generation: number): number | undefined;
}

const connection = (state: TransportState = "open"): TestConnection => {
  const listeners = new Set<() => void>();
  const source: TestConnection = {
    state,
    generation: state === "open" ? 1 : 0,
    codes: new Map(),
    closeCode: (generation) => source.codes.get(generation),
    onChange(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    set(next: TransportState, generation = source.generation) {
      source.state = next;
      source.generation = generation;
      for (const listener of Array.from(listeners)) listener();
    },
  };
  return source;
};

/** `relay.ai`, recording every `ai.subscribe` input. */
const recording = (relay: FakeRelay) => {
  const inputs: Array<Parameters<AiClient["subscribe"]>[0]> = [];
  const ai = new Proxy(relay.ai, {
    get(target, key) {
      if (key === "subscribe")
        return (...args: Parameters<AiClient["subscribe"]>) => {
          inputs.push(args[0]);
          return target.subscribe(...args);
        };
      return target[key as keyof AiClient];
    },
  });
  return { ai, inputs };
};

const sessions: ThreadSession[] = [];
afterEach(() => {
  for (const session of sessions.splice(0)) session.retire();
});

describe("the pump across sockets", () => {
  it("does not spend its budget while the socket is down and resumes by lastEventId and epoch", async () => {
    const relay = new FakeRelay();
    relay.emitAll(b.sessionReady());
    const { ai, inputs } = recording(relay);
    const link = connection();
    const session = new ThreadSession({
      ai,
      threadId: "t-1",
      pumpRetryDelaysMs: [10, 10],
      connection: link,
    });
    sessions.push(session);
    await session.load();
    await vi.waitFor(() =>
      expect(session.hostStore.state.connection).toBe("connected")
    );
    const before = relay.lastSeq;

    link.set("reconnecting");
    relay.faults.subscribe = () => new Error("socket closed");
    relay.dropSubscriptions();
    await vi.waitFor(() =>
      expect(session.hostStore.state.connection).toBe("reconnecting")
    );
    // Far past the budget: still waiting, not "error".
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(session.hostStore.state.connection).toBe("reconnecting");

    relay.faults.subscribe = undefined;
    link.set("open", 2);
    await vi.waitFor(() =>
      expect(session.hostStore.state.connection).toBe("connected")
    );
    expect(inputs.at(-1)).toMatchObject({
      threadId: "t-1",
      lastEventId: String(before),
      epoch: relay.epoch,
    });
  });

  it("restarts a session whose budget ran out when the next socket opens", async () => {
    const relay = new FakeRelay();
    relay.emitAll(b.sessionReady());
    const link = connection();
    const runtime = createChatRuntime(relay.ai, {
      connection: link,
      sessionOptions: { pumpRetryDelaysMs: [10, 10] },
    });
    const session = runtime.session("t-1");
    sessions.push(session);
    await session.load();
    relay.faults.subscribe = () => new Error("host restarting");
    relay.dropSubscriptions();
    await vi.waitFor(() =>
      expect(session.hostStore.state.connection).toBe("error")
    );

    relay.faults.subscribe = undefined;
    link.set("reconnecting");
    link.set("open", 2);
    await vi.waitFor(() =>
      expect(session.hostStore.state.connection).toBe("connected")
    );
  });
});

describe("a cold start longer than every timeout", () => {
  it("loads once the host is up, without the readiness cap failing it", async () => {
    const relay = new FakeRelay();
    relay.emitAll(b.sessionReady());
    const link = connection("connecting");
    let release!: () => void;
    const hostUp = new Promise<void>((resolve) => {
      release = resolve;
    });
    // As the transport would: hydrate waits for the first socket.
    relay.faults.hydrate = () => hostUp;
    const session = new ThreadSession({
      ai: relay.ai,
      threadId: "t-1",
      readyCapMs: 20,
      recoveryDelaysMs: [0],
      pumpRetryDelaysMs: [10],
      connection: link,
    });
    sessions.push(session);
    const loading = session.load();
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(session.hostStore.state.phase).toBe("loading");

    link.set("open", 1);
    release();
    await loading;
    expect(session.hostStore.state.phase).toBe("ready");
    await vi.waitFor(() =>
      expect(session.hostStore.state.connection).toBe("connected")
    );
  });
});

describe("HOST_UNAVAILABLE", () => {
  it("leaves the outbox entry unsent: no re-send, Retry sends the same ids", async () => {
    const relay = new FakeRelay();
    relay.emitAll(b.sessionReady());
    let down = true;
    relay.faults.sendLost = () =>
      down ? hostUnavailable("not connected") : null;
    const session = new ThreadSession({
      ai: relay.ai,
      threadId: "t-1",
      reconcileDelaysMs: [10, 20],
    });
    sessions.push(session);
    await session.load();

    await expect(session.submit("hello")).resolves.toEqual({ kind: "unsent" });
    const [entry] = session.hostStore.state.outbox;
    expect(entry).toMatchObject({ text: "hello", state: "failed" });
    await new Promise((resolve) => setTimeout(resolve, 80));
    // The reconcile path (uncertain delivery) never ran.
    expect(relay.stats.send).toHaveLength(1);

    down = false;
    await expect(session.retryOutbox(entry!.id)).resolves.toMatchObject({
      kind: "started",
    });
    const resent = relay.stats.send.at(-1) as AiSendInput;
    expect(resent.runId).toBe(entry!.runId);
    expect(resent.messages[0]!.id).toBe(entry!.id);
  });
});

describe("an uncertain send across a replaced socket", () => {
  const setup = (relay: FakeRelay, ai: AiClient = relay.ai) => {
    const link = connection();
    const session = new ThreadSession({
      ai,
      threadId: "t-1",
      reconcileDelaysMs: [10, 20],
      pumpRetryDelaysMs: [10],
      recoveryDelaysMs: [0, 0],
      connection: link,
    });
    sessions.push(session);
    return { link, session };
  };

  /** The socket drops: the stream fails, and stays down until reopened. */
  const drop = (relay: FakeRelay, link: TestConnection) => {
    link.set("reconnecting");
    relay.faults.subscribe = () => new Error("socket closed");
    relay.dropSubscriptions();
  };

  it("re-sends the same ids once the same host is back, which answers duplicate", async () => {
    const relay = new FakeRelay();
    relay.emitAll(b.sessionReady());
    // The host records the send; its answer is lost with the socket.
    relay.faults.send = (call) =>
      call === 1 ? new Error("socket closed") : null;
    const { link, session } = setup(relay);
    await session.load();
    await vi.waitFor(() =>
      expect(session.hostStore.state.connection).toBe("connected")
    );
    drop(relay, link);
    await expect(session.submit("hello")).resolves.toEqual({
      kind: "unconfirmed",
    });
    // Past every re-send delay: held while the thread is not subscribed.
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(relay.stats.send).toHaveLength(1);

    relay.faults.subscribe = undefined;
    link.set("open", 2);
    await vi.waitFor(() => expect(relay.stats.send).toHaveLength(2));
    const [first, again] = relay.stats.send as AiSendInput[];
    expect(again!.runId).toBe(first!.runId);
    expect(again!.messages[0]!.id).toBe(first!.messages[0]!.id);
    await vi.waitFor(() =>
      expect(session.hostStore.state.outbox[0]?.state).toBe("accepted")
    );
  });

  it("reconciles against a restarted host's history before any re-send", async () => {
    const relay = new FakeRelay({
      onSend: (input, self) => {
        // Delivered and persisted, then the host restarts.
        self.history.push(input.messages[0] as never);
        return { runId: input.runId, status: "started" };
      },
    });
    relay.emitAll(b.sessionReady());
    relay.faults.send = (call) =>
      call === 1 ? new Error("socket closed") : null;
    const { link, session } = setup(relay);
    await session.load();
    await vi.waitFor(() =>
      expect(session.hostStore.state.connection).toBe("connected")
    );
    drop(relay, link);
    await session.submit("hello");
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(relay.stats.send).toHaveLength(1);

    relay.setEpoch("epoch-2");
    relay.faults.subscribe = undefined;
    const hydrates = relay.stats.hydrate;
    link.set("open", 2);
    // The resync re-hydrates; the history holds the message: no re-send.
    await vi.waitFor(() =>
      expect(relay.stats.hydrate).toBeGreaterThan(hydrates)
    );
    await vi.waitFor(() => expect(session.hostStore.state.outbox).toEqual([]));
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(relay.stats.send).toHaveLength(1);
  });

  it("reconciles again when the socket drops after the thread settled but before the held re-send left", async () => {
    const relay = new FakeRelay({
      onSend: (input, self) => {
        self.history.push(input.messages[0] as never);
        return { runId: input.runId, status: "started" };
      },
    });
    relay.emitAll(b.sessionReady());
    relay.faults.send = (call) =>
      call === 1 ? new Error("socket closed") : null;
    // As the transport would: a write waits (here, until released) and an
    // aborted one never goes out.
    let hold = false;
    const held: Array<() => void> = [];
    const ai = new Proxy(relay.ai, {
      get(target, key) {
        if (key !== "send") return target[key as keyof AiClient];
        return (async (...args: Parameters<AiClient["send"]>) => {
          const signal = args[1]?.signal;
          if (hold)
            await new Promise<void>((resolve, reject) => {
              held.push(resolve);
              signal?.addEventListener("abort", () =>
                reject(new DOMException("aborted", "AbortError"))
              );
            });
          if (signal?.aborted) throw new DOMException("aborted", "AbortError");
          return target.send(...args);
        }) as AiClient["send"];
      },
    });
    const { link, session } = setup(relay, ai);
    await session.load();
    await vi.waitFor(() =>
      expect(session.hostStore.state.connection).toBe("connected")
    );
    drop(relay, link);
    await session.submit("hello");
    hold = true;
    // The same host comes back: the thread settles and the re-send is
    // released into the transport, where it waits for authorization.
    relay.faults.subscribe = undefined;
    link.set("open", 2);
    await vi.waitFor(() => expect(held).toHaveLength(1));
    // That socket dies and the host restarts before the re-send leaves.
    drop(relay, link);
    relay.setEpoch("epoch-2");
    relay.faults.subscribe = undefined;
    await new Promise((resolve) => setTimeout(resolve, 20));
    hold = false;
    for (const release of held) release();
    link.set("open", 3);
    await vi.waitFor(() => expect(session.hostStore.state.outbox).toEqual([]));
    await new Promise((resolve) => setTimeout(resolve, 80));
    // Only the first send ever reached the host.
    expect(relay.stats.send).toHaveLength(1);
  });

  it("keeps a re-send that never left as uncertain, not Not sent", async () => {
    const relay = new FakeRelay();
    relay.emitAll(b.sessionReady());
    let lost = 0;
    relay.faults.send = (call) =>
      call === 1 ? new Error("socket closed") : null;
    relay.faults.sendLost = (call) =>
      call === 2 && lost++ === 0 ? hostUnavailable("not connected") : null;
    const { session } = setup(relay);
    await session.load();
    await vi.waitFor(() =>
      expect(session.hostStore.state.connection).toBe("connected")
    );
    await session.submit("hello");
    await vi.waitFor(() => expect(relay.stats.send.length).toBeGreaterThan(2));
    expect(session.hostStore.state.outbox[0]?.state).not.toBe("failed");
  });
});

describe("a 1009 close (an event larger than a frame)", () => {
  /**
   * `ai` whose `method` streams are cut, while `armed`, by a 1009 close
   * right before their first sequenced event: the frame the host could not
   * send. The next socket opens shortly after.
   */
  const cutting = (
    relay: FakeRelay,
    link: TestConnection,
    method: "subscribe" | "joinRun"
  ) => {
    const state = { armed: false, calls: 0 };
    const ai = new Proxy(relay.ai, {
      get(target, key) {
        if (key !== method) return target[key as keyof AiClient];
        return (async (...args: [never, never]) => {
          state.calls += 1;
          const inner = await (
            target[method] as (
              ...a: [never, never]
            ) => Promise<AsyncIterable<StreamChunk>>
          )(...args);
          return (async function* () {
            for await (const event of inner) {
              if (state.armed && eventSeq(event) != null) {
                const generation = link.generation;
                link.codes.set(generation, 1009);
                link.set("reconnecting");
                setTimeout(() => link.set("open", generation + 1), 5);
                throw new Error("socket closed");
              }
              yield event;
            }
          })();
        }) as never;
      },
    });
    return { ai, state };
  };

  it("keeps an idle, caught-up thread live through 1009 closes it cannot be blamed for", async () => {
    const relay = new FakeRelay();
    relay.emitAll(b.sessionReady());
    const { ai, inputs } = recording(relay);
    const link = connection();
    const runtime = createChatRuntime(ai, {
      connection: link,
      sessionOptions: { pumpRetryDelaysMs: [10] },
    });
    const session = runtime.session("t-1");
    sessions.push(session);
    await session.load();
    await vi.waitFor(() =>
      expect(session.hostStore.state.connection).toBe("connected")
    );
    // Another frame (a diff, a query answer) closes the socket, twice.
    for (const generation of [1, 2]) {
      link.codes.set(generation, 1009);
      link.set("reconnecting");
      relay.dropSubscriptions();
      link.set("open", generation + 1);
      await vi.waitFor(() => expect(inputs).toHaveLength(generation + 1));
    }
    await vi.waitFor(() =>
      expect(session.hostStore.state.connection).toBe("connected")
    );
  });

  it("stops a replay that a 1009 cut off twice, across sockets; only Retry restarts it", async () => {
    const relay = new FakeRelay();
    relay.emitAll(b.sessionReady());
    const link = connection();
    const { ai, state } = cutting(relay, link, "subscribe");
    const runtime = createChatRuntime(ai, {
      connection: link,
      sessionOptions: { pumpRetryDelaysMs: [10] },
    });
    const session = runtime.session("t-1");
    sessions.push(session);
    await session.load();
    await vi.waitFor(() =>
      expect(session.hostStore.state.connection).toBe("connected")
    );
    // Events it has not seen yet, then a drop: the resubscribe replays.
    link.set("reconnecting");
    relay.dropSubscriptions();
    relay.emit(b.custom("abacus.progress", {}));
    state.armed = true;
    link.set("open", 2);
    await vi.waitFor(() =>
      expect(session.hostStore.state.connection).toBe("error")
    );
    expect(state.calls).toBe(3);
    // Later sockets do not replay it.
    link.set("reconnecting");
    link.set("open", 9);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(state.calls).toBe(3);
    state.armed = false;
    await session.reconnect();
    await vi.waitFor(() =>
      expect(session.hostStore.state.connection).toBe("connected")
    );
  });

  it("stops an active run whose replay below the checkpoint cuts every socket, without recovering forever", async () => {
    const relay = new FakeRelay();
    relay.emitAll(b.sessionReady());
    relay.emitAll([
      b.runStarted("run-1"),
      b.custom("abacus.progress", {}),
      b.custom("abacus.progress", {}),
    ]);
    const link = connection();
    const { ai, state } = cutting(relay, link, "joinRun");
    state.armed = true;
    const runtime = createChatRuntime(ai, {
      connection: link,
      sessionOptions: {
        pumpRetryDelaysMs: [10],
        recoveryDelaysMs: [0, 0, 0, 0],
        readyCapMs: 50,
      },
    });
    const session = runtime.session("t-1");
    sessions.push(session);
    void session.load().catch(() => undefined);
    await vi.waitFor(() =>
      expect(session.hostStore.state.connection).toBe("error")
    );
    expect(state.calls).toBe(2);
    // New sockets and recoveries do not join it again.
    link.set("reconnecting");
    link.set("open", 9);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(state.calls).toBe(2);
  });

  it("does not count a stream that delivered events before the close", async () => {
    const relay = new FakeRelay();
    relay.emitAll(b.sessionReady());
    const { ai, inputs } = recording(relay);
    const link = connection();
    const session = new ThreadSession({
      ai,
      threadId: "t-1",
      connection: link,
    });
    sessions.push(session);
    await session.load();
    await vi.waitFor(() =>
      expect(session.hostStore.state.connection).toBe("connected")
    );
    for (const generation of [1, 2, 3]) {
      relay.emit(b.custom("abacus.progress", {}));
      await new Promise((resolve) => setTimeout(resolve, 10));
      link.codes.set(generation, 1009);
      link.set("reconnecting");
      relay.dropSubscriptions();
      link.set("open", generation + 1);
      await vi.waitFor(() => expect(inputs).toHaveLength(generation + 1));
    }
    await vi.waitFor(() =>
      expect(session.hostStore.state.connection).toBe("connected")
    );
  });
});
