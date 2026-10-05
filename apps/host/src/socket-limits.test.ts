import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createFlowControlLinkInterceptor,
  FlowRegistry,
} from "@abacus-ai/contract/contract/flow-control";
import { createORPCClient, isDefinedError } from "@orpc/client";
import { RPCLink } from "@orpc/client/websocket";
import { expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";

import { nodeFileOperations } from "#main/app-operations/node";
import { MainEventBus } from "#main/rpc/event-bus";
import { createRouter } from "#main/rpc/router";
import { fakeDeps } from "#main/rpc/testing";
import {
  isRpcRequestFrame,
  startWebSocketTransport,
} from "#main/rpc/transports/websocket";

const setup = async (serviceHost: any = {}) => {
  let peer!: WebSocket;
  const emit = WebSocketServer.prototype.emit;
  const spy = vi
    .spyOn(WebSocketServer.prototype, "emit")
    .mockImplementation(function (
      this: WebSocketServer,
      event: string | symbol,
      ...args: any[]
    ) {
      if (event === "connection") peer = args[0];
      return emit.call(this, event, ...args);
    });
  const server = await startWebSocketTransport({
    router: createRouter(),
    deps: fakeDeps({ app: nodeFileOperations, serviceHost }),
    platform: "web-host",
    flowControl: true,
  });
  const socket = new WebSocket(server.url);
  await new Promise<void>((resolve) => socket.once("open", resolve));
  spy.mockRestore();
  const closed = new Promise<number>((resolve) =>
    socket.once("close", resolve)
  );
  return { server, socket, peer, closed };
};
it.each(["inbound", "outbound"])(
  "closes a real socket with 1009 for oversized %s frames",
  async (direction) => {
    const { server, socket, peer, closed } = await setup();
    peer.on("error", () => {});
    try {
      (direction === "inbound" ? socket : peer).send(
        "x".repeat(1024 * 1024 + 1)
      );
      expect(await closed).toBe(1009);
    } finally {
      socket.terminate();
      await server.close();
    }
  }
);
it("returns a defined size error for a normal large image while keeping the connection usable", async () => {
  const home = await mkdtemp(join(tmpdir(), "rpc-image-"));
  await writeFile(join(home, "large.png"), Buffer.alloc(4 * 1024 * 1024));
  const { server, socket } = await setup();
  const client: any = createORPCClient(
    new RPCLink({ websocket: socket as never })
  );
  try {
    try {
      await client.files.readImageAsDataUrl({
        hostRoot: home,
        filePath: "large.png",
      });
      throw new Error("expected size error");
    } catch (error) {
      expect(error).toMatchObject({
        code: "PAYLOAD_TOO_LARGE",
        data: { alternative: expect.stringContaining("/files?") },
      });
      expect(isDefinedError(error)).toBe(true);
    }
    await writeFile(join(home, "small.txt"), "download works");
    expect(
      await client.files.readText({ hostRoot: home, filePath: "small.txt" })
    ).toMatchObject({ content: "download works" });
  } finally {
    socket.terminate();
    await server.close();
    await rm(home, { recursive: true, force: true });
  }
});
it("the real backlog timer closes a stalled socket with 1013 and releases flow state and timer", async () => {
  const closeFlow = vi.spyOn(FlowRegistry.prototype, "close");
  const clear = vi.spyOn(globalThis, "clearInterval");
  const { server, socket, peer, closed } = await setup();
  const close = vi.spyOn(peer, "close");
  try {
    (socket as any)._socket.pause();
    for (let i = 0; i < 100; i++) peer.send(Buffer.alloc(512 * 1024));
    await vi.waitFor(() =>
      expect(close).toHaveBeenCalledWith(1013, "consumer stalled")
    );
    (socket as any)._socket.resume();
    expect(await closed).toBe(1013);
    await vi.waitFor(() => expect(closeFlow).toHaveBeenCalled());
    expect(clear).toHaveBeenCalled();
    for (const registry of closeFlow.mock.instances)
      expect((registry as FlowRegistry).size).toBe(0);
  } finally {
    socket.terminate();
    await server.close();
    vi.restoreAllMocks();
  }
});

it("returns a pending channel URL through the real host socket", async () => {
  const { AbacusChannelsConnector } =
    await import("#main/services/messaging/abacus-channels-connector");
  const connector = new AbacusChannelsConnector(
    {} as never,
    "discord",
    "web-host"
  );
  const url = "https://discord.com/oauth2/authorize?client_id=fixture";
  (connector as any).link = { status: "pending", deepLink: url };
  const server = await startWebSocketTransport({
    router: createRouter(),
    deps: fakeDeps({
      serviceHost: { openSharedChannelLink: async () => connector.openLink() },
    }),
    platform: "web-host",
    flowControl: true,
  });
  const socket = new WebSocket(server.url);
  await new Promise<void>((resolve) => socket.once("open", resolve));
  const client: any = createORPCClient(
    new RPCLink({ websocket: socket as never })
  );
  try {
    expect(
      await client.messaging.openSharedLink({
        platformId: "abacus_discord",
        target: "install",
      })
    ).toBe(url);
  } finally {
    socket.terminate();
    await server.close();
  }
});

it("caps terminal scrollback iterator snapshots with a defined size error", async () => {
  const { server, socket } = await setup({
    terminalOutputState: () => ({
      data: "x".repeat(2 * 1024 * 1024),
      offset: 2 * 1024 * 1024,
      from: 0,
    }),
  });
  const client: any = createORPCClient(
    new RPCLink({ websocket: socket as never })
  );
  try {
    const iterator = await client.terminal.output({
      conversationKey: (
        await import("@abacus-ai/contract/conversation-scope")
      ).sessionConversationKey("w", "s"),
      terminalId: "terminal-1",
      generation: 1,
    });
    await expect(iterator.next()).rejects.toMatchObject({
      code: "PAYLOAD_TOO_LARGE",
    });
    expect(socket.readyState).toBe(WebSocket.OPEN);
    await iterator.return();
  } finally {
    socket.terminate();
    await server.close();
  }
});

it("cancels a real socket subscription and releases listeners and flow state", async () => {
  const bus = new MainEventBus();
  const open = vi.spyOn(FlowRegistry.prototype, "open");
  const server = await startWebSocketTransport({
    router: createRouter(),
    deps: fakeDeps({ bus }),
    platform: "web-host",
    flowControl: true,
  });
  const socket = new WebSocket(server.url);
  await new Promise<void>((resolve) => socket.once("open", resolve));
  const client: any = createORPCClient(
    new RPCLink({
      websocket: socket as never,
      clientInterceptors: [
        createFlowControlLinkInterceptor(
          (ack) => socket.send(JSON.stringify(ack)),
          1
        ),
      ],
    })
  );
  const baseline = bus.listenerCount();
  try {
    const pending = client.system.events();
    await vi.waitFor(() => expect(bus.listenerCount()).toBe(baseline + 1));
    bus.dispatchChannel("system", {
      type: "notification",
      title: "test",
      body: "test",
    });
    const iterator = await pending;
    await iterator.next();
    expect(open).toHaveBeenCalled();
    const registry = open.mock.instances[0] as FlowRegistry;
    expect(registry.size).toBe(1);
    await iterator.return();
    await vi.waitFor(() => {
      expect(bus.listenerCount()).toBe(baseline);
      expect(registry.size).toBe(0);
    });
    expect(socket.readyState).toBe(WebSocket.OPEN);
  } finally {
    socket.terminate();
    await server.close();
    open.mockRestore();
  }
});

it("denies whisper RPC before loading model bytes", async () => {
  const fetchFile = vi.fn();
  const { server, socket } = await setup({
    whisperModelService: { fetchFile },
  });
  const client: any = createORPCClient(
    new RPCLink({ websocket: socket as never })
  );
  try {
    await expect(
      client.voice.whisper.fetch({ url: "https://huggingface.co/model" })
    ).rejects.toMatchObject({ code: "UNSUPPORTED" });
    expect(fetchFile).not.toHaveBeenCalled();
  } finally {
    socket.terminate();
    await server.close();
  }
});

const invalidFrames = [
  null,
  [],
  {},
  { i: 1, p: { u: "/system/info" } },
  { i: "junk" },
  { i: "junk", p: {} },
  { i: "junk", t: 3 },
  ...[0, 5, "1", null].map((t) => ({ i: "junk", t, p: { u: "/system/info" } })),
  ...[null, [], "payload", 1].map((p) => ({ i: "junk", p })),
  { i: "junk", p: { u: 1 } },
  { i: "junk", p: { u: "invalid URL" } },
  { i: "junk", p: { u: "/system/info", extra: true } },
  { i: "junk", p: { u: "/system/info" }, extra: true },
  { i: "junk", t: 3, p: {} },
  { i: "junk", t: 3, p: { e: "invalid" } },
  { i: "junk", t: 4, p: {} },
];

it.each(
  invalidFrames.flatMap((frame) =>
    [false, true].map((binary) => [JSON.stringify(frame), binary] as const)
  )
)(
  "closes malformed JSON frame %s (binary=%s) with 1008 before the RPC decoder",
  async (frame, binary) => {
    expect(isRpcRequestFrame(JSON.parse(frame))).toBe(false);
    const errors = vi.spyOn(console, "error");
    const { server, socket, closed } = await setup();
    try {
      socket.send(frame, { binary });
      expect(await closed).toBe(1008);
      expect(errors).not.toHaveBeenCalled();
    } finally {
      socket.terminate();
      await server.close();
      errors.mockRestore();
    }
  }
);

it("accepts the oRPC request, iterator and payload-free abort grammar", () => {
  const frames = [
    { i: "1", p: { u: "/system/info" } },
    { i: "1", t: 1, p: { u: "http://orpc/system/info", b: { json: null } } },
    // The installed request decoder treats both 1 and 2 as requests.
    { i: "1", t: 2, p: { u: "/system/info" } },
    {
      i: "1",
      p: {
        u: "/files/readText",
        b: {},
        h: { "x-abacus-flow": "f;1" },
        m: "GET",
      },
    },
    ...["message", "error", "done"].flatMap((e) => [
      { i: "1", t: 3, p: { e } },
      { i: "1", t: 3, p: { e, d: null, m: { id: "event", retry: 10 } } },
    ]),
    { i: "1", t: 4 },
  ];
  for (const frame of frames) expect(isRpcRequestFrame(frame)).toBe(true);
});

it("closes invalid JSON text with 1008", async () => {
  const { server, socket, closed } = await setup();
  try {
    socket.send("{");
    expect(await closed).toBe(1008);
  } finally {
    socket.terminate();
    await server.close();
  }
});

it("accepts valid JSON requests and aborts carried by binary frames", async () => {
  const home = await mkdtemp(join(tmpdir(), "rpc-binary-json-"));
  await writeFile(join(home, "file.txt"), "binary JSON works");
  const { server, socket } = await setup();
  const send = socket.send.bind(socket);
  socket.send = ((data: Parameters<typeof socket.send>[0]) =>
    send(data, { binary: true })) as typeof socket.send;
  const client: any = createORPCClient(
    new RPCLink({ websocket: socket as never })
  );
  try {
    socket.send(JSON.stringify({ i: "unused", t: 4 }));
    expect(
      await client.files.readText({ hostRoot: home, filePath: "file.txt" })
    ).toMatchObject({ content: "binary JSON works" });
    expect(socket.readyState).toBe(WebSocket.OPEN);
  } finally {
    socket.terminate();
    await server.close();
    await rm(home, { recursive: true, force: true });
  }
});
