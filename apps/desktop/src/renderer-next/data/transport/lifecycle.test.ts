/**
 * The Transport's port lifecycle and flow control, over the real oRPC link
 * and handler (Codex impl-r1 #1, #2).
 *
 * `close()`: the HTML spec fires `close` only at the *other* end of a
 * disentangled channel, and Node's MessagePort fires it at both, which would
 * hide the bug. The port here drops local close events, as Chromium does, so
 * only the transport's own notification can end pending calls.
 */
import { implement, type Router } from "@orpc/server";
import { RPCHandler } from "@orpc/server/message-port";
import { afterEach, describe, expect, it } from "vitest";

import { contract } from "#shared/contract";
import {
  DEFAULT_FLOW_WINDOW,
  FLOW_CONTEXT_KEY,
  FlowRegistry,
  flowControlHandlerInterceptor,
  withFlowAcks,
} from "#shared/contract/flow-control";
import { CUSTOM_JSON_SERIALIZERS } from "#shared/contract/serializer";

import { createTransport, type TransportPort } from "./create-transport";
import { createMemoryTransport } from "./memory";
import type { Transport } from "./types";

const impl = implement(contract).$context<{ pulled: number[] }>();

const never = new Promise<never>(() => undefined);

const router = {
  system: {
    // Never answers: a call stays pending until the transport closes.
    info: impl.system.info.handler(() => never),
  },
  devices: {
    events: impl.devices.events.handler(async function* ({ context }) {
      for (let i = 0; i < 1_000; i += 1) {
        context.pulled[0] = i + 1;
        yield { type: "build-state" as const, phase: `phase-${i}` as never };
      }
    }),
  },
} as unknown as Router<any, { pulled: number[] }>;

const settle = async (rounds = 20): Promise<void> => {
  for (let i = 0; i < rounds; i += 1)
    await new Promise((resolve) => setTimeout(resolve, 0));
};

const open: Array<() => void> = [];
afterEach(() => {
  for (const close of open.splice(0)) close();
});

/** A client port that, like a DOM MessagePort, never hears its own close. */
const chromiumLikePort = (port: MessagePort): TransportPort => ({
  addEventListener: ((type: string, listener: EventListener) => {
    if (type !== "close") port.addEventListener(type, listener);
  }) as TransportPort["addEventListener"],
  postMessage: ((message: unknown) =>
    port.postMessage(message)) as TransportPort["postMessage"],
  start: () => port.start(),
  close: () => port.close(),
});

const connect = (): Transport => {
  const { port1: server, port2: client } = new MessageChannel();
  const flows = new FlowRegistry();
  new RPCHandler<any>(router, {
    customJsonSerializers: CUSTOM_JSON_SERIALIZERS,
    interceptors: [flowControlHandlerInterceptor],
  }).upgrade(withFlowAcks(server, flows), {
    context: { pulled: [0], [FLOW_CONTEXT_KEY]: flows },
  });
  server.start();
  const transport = createTransport(chromiumLikePort(client), {
    kind: "memory",
  });
  open.push(() => server.close());
  return transport;
};

describe("Transport.close", () => {
  it("rejects a pending call without waiting for the other end", async () => {
    const transport = connect();
    const pending = transport.client.system.info();
    await settle(2);
    transport.close();
    await expect(pending).rejects.toBeDefined();
  });

  it("ends a pending iterator read", async () => {
    const transport = connect();
    const events = await transport.client.devices.events();
    // Drain what the window allowed, then park on a read.
    for (let i = 0; i < DEFAULT_FLOW_WINDOW; i += 1) await events.next();
    const parked = events.next().then(
      () => "settled",
      () => "settled"
    );
    transport.close();
    await expect(parked).resolves.toBe("settled");
  });
});

describe("flow control from the renderer's side", () => {
  it("main pulls no further than the window ahead of the consumer", async () => {
    const pulled = [0];
    const transport = createMemoryTransport(router, { pulled });
    open.push(() => transport.close());

    const events = await transport.client.devices.events();
    await settle();
    // One pull past the window: the iterator is parked waiting for credit.
    expect(pulled[0]).toBeLessThanOrEqual(DEFAULT_FLOW_WINDOW + 1);

    let received = 0;
    for await (const event of events) {
      expect(event).toMatchObject({ phase: `phase-${received}` });
      received += 1;
    }
    expect(received).toBe(1_000);
  });
});
