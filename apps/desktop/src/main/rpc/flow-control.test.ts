/**
 * Backpressure through the real oRPC adapters (Codex impl-r1 #1). oRPC
 * 1.15.4's server peer drains an iterator into the port as fast as it can and
 * the client peer queues without bound, so without flow control a renderer
 * that stops reading holds main's whole backlog. With it, main sends at most
 * the flow window ahead of what the consumer took from `next()`, and the rest
 * waits in main's subscriber queue, where the delivery class's cap applies.
 */
import { isDefinedError } from "@orpc/client";
import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_FLOW_WINDOW,
  FLOW_ACK,
  FlowRegistry,
  parseFlowHeader,
} from "@abacus-ai/contract/contract/flow-control";
import type { IpcEvent } from "@abacus-ai/contract/contracts";

import { MainEventBus } from "./event-bus";
import { LOSSLESS_ACTIONABLE_MAX_EVENTS } from "./subscriber-queue";
import {
  connectInProcess,
  fakeDeps,
  type ConnectInProcessOptions,
  type InProcessConnection,
} from "./testing";

const at = new Date(0).toISOString();
const connections: InProcessConnection[] = [];

afterEach(() => {
  for (const connection of connections.splice(0)) {
    connection.closeClient();
    connection.closeServer();
  }
});

/** Lets queued port messages and microtasks run. */
const settle = async (rounds = 20): Promise<void> => {
  for (let i = 0; i < rounds; i += 1)
    await new Promise((resolve) => setImmediate(resolve));
};

const EVENT_ITERATOR = 3;

/** `count` events in batches, letting the ports run between them. */
const flood = async (
  build: (phase: string) => void,
  count: number
): Promise<void> => {
  for (let i = 0; i < count; i += 1) {
    build(`phase-${i}`);
    if (i % 500 === 499) await settle(2);
  }
  await settle();
};

const setup = (options: ConnectInProcessOptions = {}) => {
  const bus = new MainEventBus();
  const deps = fakeDeps({
    bus,
    serviceHost: { getDeviceStatus: () => ({ available: true }) },
  });
  let sentEvents = 0;
  const connection = connectInProcess(
    deps,
    {},
    {
      ...options,
      onServerMessage: (message) => {
        const decoded =
          typeof message === "string"
            ? (JSON.parse(message) as { t?: number })
            : (message as { t?: number });
        if (decoded?.t === EVENT_ITERATOR) sentEvents += 1;
      },
    }
  );
  connections.push(connection);
  const build = (phase: string): void =>
    bus.dispatch({
      type: "device-build-state",
      phase,
      emittedAt: at,
    } as IpcEvent);
  return { bus, connection, build, sent: () => sentEvents };
};

describe("event iterator flow control (real adapters)", () => {
  it("without it, oRPC drains 20,000 events to a consumer that never reads", async () => {
    const { connection, build, sent } = setup({ flowControl: false });
    const events = await connection.client.devices.events();
    await flood(build, 20_000);
    // The finding, reproduced: every event crossed the port with zero next(),
    // and main's queue never saw a backlog, so its cap never applied.
    expect(sent()).toBe(20_001);
    await events.return();
  });

  it("sends no more than the window ahead of a stalled consumer", async () => {
    const { bus, connection, build, sent } = setup();
    const baseline = bus.listenerCount();
    const events = await connection.client.devices.events();
    await flood(build, 20_000);

    expect(sent()).toBeLessThanOrEqual(DEFAULT_FLOW_WINDOW);
    // Main's queue overflowed (its cap, not the renderer's heap, bounded the
    // backlog) and it stopped listening at once.
    expect(bus.listenerCount()).toBe(baseline);

    // The consumer resumes: what was sent arrives, then RESYNC_REQUIRED.
    const received: string[] = [];
    let failure: unknown = null;
    try {
      for (;;) {
        const result = await events.next();
        if (result.done === true) break;
        received.push(result.value.type);
      }
    } catch (error) {
      failure = error;
    }
    expect(received.length).toBeLessThanOrEqual(DEFAULT_FLOW_WINDOW);
    expect(received[0]).toBe("snapshot");
    expect(isDefinedError(failure)).toBe(true);
    expect((failure as { code?: string }).code).toBe("RESYNC_REQUIRED");
    await settle();
    expect(connection.flows.size).toBe(0);
  });

  it("delivers everything, in order, to a consumer that keeps reading", async () => {
    const { connection, build, sent } = setup({ flowWindow: 4 });
    const events = await connection.client.devices.events();
    await expect(events.next()).resolves.toMatchObject({
      value: { type: "snapshot" },
    });
    const total = 500;
    for (let i = 0; i < total; i += 1) build(`phase-${i}`);

    for (let i = 0; i < total; i += 1) {
      const result = await events.next();
      expect(result.value).toMatchObject({ phase: `phase-${i}` });
      // Never more than the window in flight past what was consumed.
      expect(sent() - (i + 2)).toBeLessThanOrEqual(4);
    }
    await events.return();
    await settle();
    expect(connection.flows.size).toBe(0);
  });

  it("stays within the queue's cap below it: a slow reader loses nothing", async () => {
    const { connection, build } = setup();
    const events = await connection.client.devices.events();
    const total = LOSSLESS_ACTIONABLE_MAX_EVENTS - 1;
    for (let i = 0; i < total; i += 1) build(`phase-${i}`);
    await settle();
    await events.next(); // snapshot
    for (let i = 0; i < total; i += 1) {
      const result = await events.next();
      expect(result.value).toMatchObject({ phase: `phase-${i}` });
    }
    await events.return();
  });

  it("releases a parked iterator when the port closes", async () => {
    const { bus, connection, build } = setup({ flowWindow: 1 });
    const baseline = bus.listenerCount();
    await connection.client.devices.events();
    build("a");
    build("b");
    await settle();
    expect(connection.flows.size).toBe(1);
    connection.closeServer();
    await settle();
    expect(connection.flows.size).toBe(0);
    expect(bus.listenerCount()).toBe(baseline);
  });
});

describe("the flow protocol", () => {
  it("parses only well-formed headers", () => {
    expect(parseFlowHeader("f1;64")).toEqual({ flow: "f1", window: 64 });
    expect(parseFlowHeader(["f2;8"])).toEqual({ flow: "f2", window: 8 });
    expect(parseFlowHeader("f1;0")).toBeNull();
    expect(parseFlowHeader("f1")).toBeNull();
    expect(parseFlowHeader(undefined)).toBeNull();
  });

  it("ignores malformed and unknown acknowledgements", () => {
    const flows = new FlowRegistry();
    const flow = flows.open("f1", 1);
    flows.ack({
      type: FLOW_ACK,
      acks: [
        ["f1", 2],
        ["f9", 5],
        ["f1", -3],
        ["f1", 1.5],
      ] as Array<[string, number]>,
    });
    expect(flow.credits).toBe(3);
    flows.close();
    expect(flows.size).toBe(0);
  });
});
