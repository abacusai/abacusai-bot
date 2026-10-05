import { afterEach, expect, it, vi } from "vitest";

import { awaitWebSocketOpen } from "./websocket";
class Socket extends EventTarget {
  readyState = 0;
  close = vi.fn();
  send = vi.fn();
  constructor(
    readonly url: string,
    readonly protocols: string[]
  ) {
    super();
  }
}
afterEach(() => vi.unstubAllGlobals());
it("reports a handshake error before any boot calls", async () => {
  const socket = new Socket("wss://pod/rpc", []);
  const pending = awaitWebSocketOpen(socket as unknown as WebSocket);
  socket.dispatchEvent(new Event("error"));
  await expect(pending).rejects.toThrow("handshake failed");
  expect(socket.close).toHaveBeenCalledOnce();
});

it("the real RPC link sends flow headers and JSON acknowledgements only for consumed events", async () => {
  const { contract } = await import("@abacus-ai/contract/contract");
  const { FLOW_ACK, FLOW_HEADER, DEFAULT_FLOW_WINDOW, parseFlowHeader } =
    await import("@abacus-ai/contract/contract/flow-control");
  const { implement } = await import("@orpc/server");
  const { RPCHandler } = await import("@orpc/server/ws");
  const { WebSocketServer, WebSocket: NodeSocket } = await import("ws");
  const { createWebSocketTransport } = await import("./websocket");
  const impl = implement(contract);
  const status = {
    checking: false,
    available: false,
    downloading: false,
    downloaded: false,
    installing: false,
    error: null,
    progress: null,
    updateInfo: null,
    installStalled: false,
    criticalUpdate: false,
    failedPhase: null,
  };
  const router = {
    update: {
      events: impl.update.events.handler(async function* () {
        yield status;
        yield status;
        yield status;
      }),
    },
  };
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const messages: Array<{
    type?: string;
    acks?: Array<[string, number]>;
    p?: { h?: Record<string, string> };
  }> = [];
  const handler = new RPCHandler(router);
  server.on("connection", (socket) => {
    socket.on("message", (data) => {
      const value = JSON.parse(data.toString());
      messages.push(value);
    });
    handler.upgrade({
      send: socket.send.bind(socket),
      addEventListener(
        type: string,
        listener: (event: { data: unknown }) => void
      ) {
        socket.addEventListener(type as "message", (event) => {
          if (
            type === "message" &&
            JSON.parse(String((event as { data: unknown }).data)).type ===
              FLOW_ACK
          )
            return;
          listener(event as never);
        });
      },
    } as never);
  });
  const url = `ws://127.0.0.1:${(server.address() as { port: number }).port}`;
  const socket = new NodeSocket(url) as unknown as WebSocket;
  await awaitWebSocketOpen(socket);
  const transport = createWebSocketTransport(socket, {});
  try {
    const iterator = await transport.client.update.events({});
    await new Promise((resolve) => setTimeout(resolve, 10));
    const header = messages.find((message) => message.p?.h)?.p?.h?.[
      FLOW_HEADER
    ];
    const flow = parseFlowHeader(header);
    expect(flow?.window).toBe(DEFAULT_FLOW_WINDOW);
    expect(messages.filter((message) => message.type === FLOW_ACK)).toEqual([]);
    await Promise.all([iterator.next(), iterator.next()]);
    await vi.waitFor(() =>
      expect(
        messages
          .filter((message) => message.type === FLOW_ACK)
          .flatMap((message) => message.acks ?? [])
          .reduce((count, [, consumed]) => count + consumed, 0)
      ).toBe(2)
    );
    const acks = messages.filter((message) => message.type === FLOW_ACK);
    expect(acks.flatMap((ack) => ack.acks ?? [])).toEqual([
      [flow!.flow, 1],
      [flow!.flow, 1],
    ]);
    await iterator.return?.();
    transport.close();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(
      messages.filter((message) => message.type === FLOW_ACK)
    ).toHaveLength(acks.length);
  } finally {
    transport.close();
    server.clients.forEach((socket) => socket.terminate());
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it("batches simultaneous consumption in one JSON frame and tolerates a closed socket", async () => {
  const { createFlowControlLinkInterceptor, FLOW_ACK } =
    await import("@abacus-ai/contract/contract/flow-control");
  const socket = new Socket("wss://pod/rpc", []);
  const interceptor = createFlowControlLinkInterceptor((ack) =>
    socket.send(JSON.stringify(ack))
  );
  const inner = {
    next: async () => ({ done: false, value: "event" }),
    [Symbol.asyncIterator]() {
      return this;
    },
  };
  const response = await interceptor({
    request: { headers: {} },
    next: async () => ({ body: async () => inner }),
  });
  const iterator = (await response.body()) as typeof inner;
  await Promise.all([iterator.next(), iterator.next()]);
  expect(socket.send).toHaveBeenCalledExactlyOnceWith(
    JSON.stringify({ type: FLOW_ACK, acks: [["f1", 2]] })
  );
  socket.send.mockImplementation(() => {
    throw new Error("closed");
  });
  await expect(iterator.next()).resolves.toEqual({
    done: false,
    value: "event",
  });
});

it("acknowledges each event on the socket that delivered it, across a replacement", async () => {
  const { contract } = await import("@abacus-ai/contract/contract");
  const { FLOW_ACK } =
    await import("@abacus-ai/contract/contract/flow-control");
  const { implement } = await import("@orpc/server");
  const { RPCHandler } = await import("@orpc/server/ws");
  const { WebSocketServer, WebSocket: NodeSocket } = await import("ws");
  const { createHostTransport } = await import("./websocket");
  const impl = implement(contract);
  const status = {
    checking: false,
    available: false,
    downloading: false,
    downloaded: false,
    installing: false,
    error: null,
    progress: null,
    updateInfo: null,
    installStalled: false,
    criticalUpdate: false,
    failedPhase: null,
  };
  const router = {
    update: {
      events: impl.update.events.handler(async function* () {
        for (let i = 0; i < 4; i += 1) yield status;
        await new Promise(() => undefined);
      }),
    },
  };
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const acksBySocket: Array<Array<[string, number]>> = [];
  const serverSockets: Array<import("ws").WebSocket> = [];
  const handler = new RPCHandler(router);
  server.on("connection", (socket) => {
    const acks: Array<[string, number]> = [];
    acksBySocket.push(acks);
    serverSockets.push(socket);
    socket.on("message", (data) => {
      const value = JSON.parse(data.toString()) as {
        type?: string;
        acks?: Array<[string, number]>;
      };
      if (value.type === FLOW_ACK) acks.push(...(value.acks ?? []));
    });
    handler.upgrade({
      send: socket.send.bind(socket),
      addEventListener(
        type: string,
        listener: (event: { data: unknown }) => void
      ) {
        socket.addEventListener(type as "message", (event) => {
          if (
            type === "message" &&
            JSON.parse(String((event as { data: unknown }).data)).type ===
              FLOW_ACK
          )
            return;
          listener(event as never);
        });
      },
    } as never);
  });
  const url = `ws://127.0.0.1:${(server.address() as { port: number }).port}`;
  const open = async () => {
    const socket = new NodeSocket(url) as unknown as WebSocket;
    await awaitWebSocketOpen(socket);
    return socket;
  };
  const transport = createHostTransport({ writesConfirmed: true });
  const abort = new AbortController();
  try {
    transport.attach(await open());
    const old = await transport.client.update.events(
      {},
      { signal: abort.signal }
    );
    await old.next();
    await vi.waitFor(() => expect(acksBySocket[0]).toEqual([["f1", 1]]));
    // The first socket drops; the next generation opens its own stream.
    serverSockets[0]!.terminate();
    await vi.waitFor(() => expect(transport.state).toBe("reconnecting"));
    transport.attach(await open());
    await old.next().catch(() => undefined);
    const fresh = await transport.client.update.events(
      {},
      { signal: abort.signal }
    );
    await fresh.next();
    await vi.waitFor(() => expect(acksBySocket[1]).toEqual([["f1", 1]]));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(acksBySocket[0]).toEqual([["f1", 1]]);
    expect(acksBySocket[1]).toEqual([["f1", 1]]);
  } finally {
    abort.abort();
    // The abort reaches the host before the socket closes.
    await new Promise((resolve) => setTimeout(resolve, 20));
    transport.close();
    server.clients.forEach((socket) => socket.terminate());
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
