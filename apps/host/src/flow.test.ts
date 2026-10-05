import type { Contract } from "@abacus-ai/contract/contract";
import { createFlowControlLinkInterceptor } from "@abacus-ai/contract/contract/flow-control";
import { CUSTOM_JSON_SERIALIZERS } from "@abacus-ai/contract/contract/serializer";
import { sessionConversationKey } from "@abacus-ai/contract/conversation-scope";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/websocket";
import type { ContractRouterClient } from "@orpc/contract";
import { expect, it, vi } from "vitest";
import { WebSocket } from "ws";

import { MainEventBus } from "#main/rpc/event-bus";
import { createRouter } from "#main/rpc/router";
import { fakeDeps } from "#main/rpc/testing";
import { startWebSocketTransport } from "#main/rpc/transports/websocket";
it("a stalled terminal iterator sends only its credit window and resumes after JSON acknowledgements", async () => {
  const bus = new MainEventBus();
  const key = sessionConversationKey("w", "s");
  const deps = fakeDeps({
    bus,
    serviceHost: {
      terminalOutputState: () => ({ data: "", offset: 0, from: 0 }),
    },
  });
  const server = await startWebSocketTransport({
    router: createRouter(),
    deps,
    flowControl: true,
  });
  const socket = new WebSocket(server.url);
  await new Promise<void>((resolve) => socket.once("open", resolve));
  let received = 0;
  socket.on("message", () => received++);
  const client: ContractRouterClient<Contract> = createORPCClient(
    new RPCLink({
      websocket: socket as never,
      customJsonSerializers: CUSTOM_JSON_SERIALIZERS,
      clientInterceptors: [
        createFlowControlLinkInterceptor(
          (ack) => socket.send(JSON.stringify(ack)),
          4
        ),
      ],
    })
  );
  try {
    const output = await client.terminal.output({
      conversationKey: key,
      terminalId: "terminal-1",
      generation: 1,
    });
    await output.next();
    await vi.waitFor(() => expect(bus.listenerCount()).toBeGreaterThan(1));
    for (let i = 0; i < 100; i++)
      bus.dispatch({
        type: "terminal-output",
        conversationKey: key,
        terminalId: "terminal-1",
        generation: 1,
        data: "x".repeat(1024),
        emittedAt: "",
      } as never);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const stalled = received;
    expect(stalled).toBeLessThanOrEqual(7);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(received).toBe(stalled);
    await output.next();
    await vi.waitFor(() => expect(received).toBeGreaterThan(stalled));
    for (let i = 0; i < 10_000; i++)
      bus.dispatch({
        type: "terminal-output",
        conversationKey: key,
        terminalId: "terminal-1",
        generation: 1,
        data: "x".repeat(1024),
        emittedAt: "",
      } as never);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const saturated = received;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(received).toBe(saturated);
    let failure: unknown;
    for (let i = 0; i < 8; i++) {
      try {
        await output.next();
      } catch (error) {
        failure = error;
        break;
      }
    }
    expect(failure).toMatchObject({ code: "RESYNC_REQUIRED" });
    await output.return();
  } finally {
    socket.close();
    await server.close();
  }
});
