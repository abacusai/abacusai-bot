/**
 * The lifecycle McpHttpServer owns for all three built-in servers: a stop()
 * must win over a start() still in progress, a stopped server must be
 * restartable, and a response already being produced when stop() lands must
 * still reach the client.
 */
import http from "http";

import { afterEach, describe, expect, it, vi } from "vitest";

import { localMcpServerToken } from "./mcp-config-service";
import { McpHttpServer, type McpToolResult } from "./mcp-http-server";

class TestServer extends McpHttpServer {
  /** Resolves the tool call the test is holding open. */
  release: ((result: McpToolResult) => void) | null = null;
  private markCalled: () => void = () => {};
  /** Settles when the held tool call has arrived. */
  readonly called = new Promise<void>((resolve) => {
    this.markCalled = resolve;
  });

  constructor() {
    super({ name: "test", version: "1.0.0" });
  }

  protected listTools() {
    return [];
  }

  protected executeTool(): Promise<McpToolResult> {
    this.markCalled();
    return new Promise((resolve) => {
      this.release = resolve;
    });
  }
}

const servers: TestServer[] = [];
const build = (): TestServer => {
  const server = new TestServer();
  servers.push(server);
  return server;
};

afterEach(() => {
  vi.restoreAllMocks();
  for (const server of servers.splice(0)) server.stop();
});

/** Calls stop() the moment the listen is under way, before it completes. */
const stopDuringListen = (server: TestServer): void => {
  const listen = http.Server.prototype.listen;
  vi.spyOn(http.Server.prototype, "listen").mockImplementationOnce(function (
    this: http.Server,
    ...args: unknown[]
  ) {
    const result = listen.apply(this, args as never);
    server.stop();
    return result;
  });
};

describe("start and stop", () => {
  it("gives up a start that a stop overtook while it was listening", async () => {
    const server = build();
    stopDuringListen(server);

    await expect(server.start()).rejects.toThrow(/stopped while starting/);
    expect(server.isRunning()).toBe(false);
    expect(server.getPort()).toBeNull();
  });

  it("starts again after a stop that overtook a start", async () => {
    const server = build();
    stopDuringListen(server);
    await server.start().catch(() => undefined);

    const port = await server.start();

    expect(server.isRunning()).toBe(true);
    expect(server.getPort()).toBe(port);
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
  });

  it("shares one start between concurrent callers", async () => {
    const server = build();
    const [a, b] = await Promise.all([server.start(), server.start()]);

    expect(a).toBe(b);
  });

  it("lets a response being produced at stop() reach the client", async () => {
    const server = build();
    const port = await server.start();
    const response = fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${localMcpServerToken("test")}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "anything", arguments: {} },
      }),
    });
    await server.called;

    // What setBrowserEnabled(false) does: deny the prompt, then stop.
    server.release!({
      content: [{ type: "text", text: "denied" }],
      isError: true,
    });
    server.stop();

    expect(server.isRunning()).toBe(false);
    expect(await (await response).json()).toMatchObject({
      id: 1,
      result: { isError: true, content: [{ text: "denied" }] },
    });
  });
});

describe("a start overtaken while the SDK is still loading", () => {
  it("gives up, and the next start works", async () => {
    // A fresh module, so the SDK has not been loaded yet.
    vi.resetModules();
    const { McpHttpServer: FreshBase } = await import("./mcp-http-server");
    class Fresh extends FreshBase {
      constructor() {
        super({ name: "test", version: "1.0.0" });
      }
      protected listTools() {
        return [];
      }
      protected executeTool(): Promise<McpToolResult> {
        return Promise.resolve({ content: [] });
      }
    }
    const server = new Fresh();

    const first = server.start();
    server.stop();

    await expect(first).rejects.toThrow(/stopped while starting/);
    expect(server.isRunning()).toBe(false);
    expect(await server.start()).toBe(server.getPort());
    expect(server.isRunning()).toBe(true);
    server.stop();
  });
});

describe("DNS rebinding", () => {
  /** A raw request, since fetch will not send a Host of the caller's choosing. */
  const send = (
    port: number,
    method: string,
    headers: Record<string, string>
  ): Promise<number> =>
    new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port,
          path: "/mcp",
          method,
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
            Authorization: `Bearer ${localMcpServerToken("test")}`,
            ...headers,
          },
        },
        (res) => {
          resolve(res.statusCode ?? 0);
          res.destroy();
        }
      );
      req.on("error", reject);
      req.end(
        method === "POST"
          ? JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" })
          : undefined
      );
    });

  it.each(["POST", "GET", "DELETE"])(
    "refuses %s with a foreign Host or Origin, before anything else",
    async (method) => {
      const server = build();
      const port = await server.start();

      expect(await send(port, method, { Host: "attacker.example" })).toBe(403);
      expect(
        await send(port, method, { Host: `attacker.example:${port}` })
      ).toBe(403);
      expect(
        await send(port, method, {
          Host: `127.0.0.1:${port}`,
          Origin: "http://attacker.example",
        })
      ).toBe(403);
    }
  );

  it("accepts the loopback authorities the agent and the tests use", async () => {
    const server = build();
    const port = await server.start();

    // The runtime MCP config names localhost; the tests use 127.0.0.1.
    expect(await send(port, "POST", { Host: `localhost:${port}` })).toBe(200);
    expect(await send(port, "POST", { Host: `127.0.0.1:${port}` })).toBe(200);
  });
});
