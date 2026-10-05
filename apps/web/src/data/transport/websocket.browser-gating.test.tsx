import { afterEach, expect, it, vi } from "vitest";

import { awaitWebSocketOpen, connectWebSocketTransport } from "./websocket";
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
it("awaits open and passes the token only as a subprotocol", async () => {
  let socket: Socket;
  vi.stubGlobal(
    "WebSocket",
    class extends Socket {
      constructor(url: string, protocols: string[]) {
        super(url, protocols);
        socket = Object.assign(this, {});
      }
    }
  );
  let resolved = false;
  const pending = connectWebSocketTransport("wss://pod/rpc", [
    "abacus-rpc",
    "abacus-token.secret",
  ]).then((value) => {
    resolved = true;
    return value;
  });
  await Promise.resolve();
  expect(resolved).toBe(false);
  expect(socket!.url).toBe("wss://pod/rpc");
  expect(socket!.protocols).toEqual(["abacus-rpc", "abacus-token.secret"]);
  socket!.readyState = 1;
  socket!.dispatchEvent(new Event("open"));
  const transport = await pending;
  expect(transport.kind).toBe("websocket");
  transport.close();
});
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
