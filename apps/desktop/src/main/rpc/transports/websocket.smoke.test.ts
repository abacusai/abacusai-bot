/**
 * A-T5: the same router over a WebSocket, with `electron` made to throw on
 * import: nothing the router reaches may need it. Answers a query, streams
 * `update.events` (current status first, then a change), refuses a window
 * procedure (a socket has no window), and refuses a connection without the
 * token.
 */
import { execFileSync } from "node:child_process";
import { join } from "node:path";

import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/websocket";
import type { ContractRouterClient } from "@orpc/contract";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Contract } from "#shared/contract";
import { CUSTOM_JSON_SERIALIZERS } from "#shared/contract/serializer";

vi.mock("electron", () => {
  throw new Error("the router must not import electron");
});

import { MainEventBus } from "../event-bus";
import { createRouter } from "../router";
import { fakeDeps, IDLE_UPDATE_STATUS } from "../testing";
import { startWebSocketTransport, type WebSocketTransport } from "./websocket";

let server: WebSocketTransport | null = null;
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close();
  await server?.close();
  server = null;
});

const clientFor = (url: string): ContractRouterClient<Contract> => {
  const websocket = new WebSocket(url);
  sockets.push(websocket);
  return createORPCClient(
    new RPCLink({ websocket, customJsonSerializers: CUSTOM_JSON_SERIALIZERS })
  );
};

describe("the router over a WebSocket (A-T5)", () => {
  it("runs where importing electron throws", async () => {
    // Vitest wraps the factory's error in its own ("error when mocking").
    await expect(import("electron")).rejects.toThrow();
  });

  it("serves queries and streams with no Electron anywhere", async () => {
    const bus = new MainEventBus();
    server = await startWebSocketTransport({
      router: createRouter(),
      deps: fakeDeps({
        bus,
        app: {
          appVersion: () => "9.9.9",
          homeDir: () => "/h",
          botHome: () => "/h/.abacusai-bot",
        },
        host: { sessionHomePath: () => "/h/AbacusAI" },
        serviceHost: { getMetadata: () => ({ materialIconsBasePath: null }) },
      }),
    });
    const client = clientFor(server.url);

    await expect(client.system.info()).resolves.toMatchObject({
      appVersion: "9.9.9",
    });

    const updates = await client.update.events();
    await expect(updates.next()).resolves.toMatchObject({
      value: IDLE_UPDATE_STATUS,
    });
    await vi.waitFor(() => expect(bus.listenerCount()).toBeGreaterThan(1));
    bus.dispatchChannel("update", { ...IDLE_UPDATE_STATUS, checking: true });
    await expect(updates.next()).resolves.toMatchObject({
      value: { checking: true },
    });
    await updates.return();
  });

  it("refuses window procedures: a socket has no window", async () => {
    server = await startWebSocketTransport({
      router: createRouter(),
      deps: fakeDeps({ windows: { state: () => ({}) as never } }),
    });
    const client = clientFor(server.url);

    await expect(client.window.state()).rejects.toMatchObject({
      code: "FORBIDDEN",
      defined: true,
    });
  });

  it("binds to loopback and refuses a connection without the token", async () => {
    server = await startWebSocketTransport({
      router: createRouter(),
      deps: fakeDeps(),
    });
    expect(server.url.startsWith("ws://127.0.0.1:")).toBe(true);

    const socket = new WebSocket(`ws://127.0.0.1:${server.port}/?token=wrong`);
    sockets.push(socket);
    const closed = await new Promise<number>((resolve) => {
      socket.addEventListener("close", (event) => resolve(event.code));
    });
    expect(closed).toBe(1008);
  });
});

describe("scripts/rpc-ws-smoke.mjs (A.8)", () => {
  it("bundles the router without Electron and passes its checks", () => {
    const script = join(
      import.meta.dirname,
      "../../../../scripts/rpc-ws-smoke.mjs"
    );
    const output = execFileSync(process.execPath, [script], {
      encoding: "utf8",
      timeout: 60_000,
    });
    expect(output).not.toContain("FAIL");
    expect(output.match(/^ok /gm)).toHaveLength(5);
  }, 60_000);
});
