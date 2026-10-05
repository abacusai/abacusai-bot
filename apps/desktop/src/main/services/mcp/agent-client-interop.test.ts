/**
 * The agent's own MCP client against McpHttpServer.
 *
 * The SDK client in mcp-wire.test.ts proves the server follows the spec; this
 * proves it still serves the client that actually calls it, the hand-written
 * one in packages/agent (protocol 2024-11-05, no MCP-Protocol-Version header,
 * POST only). It is loaded from source by path: the agent package does not
 * export it, and the desktop does not depend on its internals otherwise.
 */
import { resolve } from "path";
import { pathToFileURL } from "url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { localMcpServerToken } from "./mcp-config-service";
import {
  McpHttpServer,
  type McpToolListing,
  type McpToolResult,
} from "./mcp-http-server";

interface AgentTransport {
  request(method: string, params?: unknown): Promise<unknown>;
  notify(method: string, params?: unknown): Promise<void>;
  close(): void;
}

interface AgentClient {
  tools: Array<{ name: string; inputSchema?: unknown }>;
  callTool(
    name: string,
    args: Record<string, unknown>
  ): Promise<{
    text: string;
    isError: boolean;
    blocks: Array<Record<string, unknown>>;
  }>;
  close(): void;
}

interface AgentClientModule {
  McpClient: {
    connect(name: string, transport: AgentTransport): Promise<AgentClient>;
    httpTransport(
      url: string,
      headers?: Record<string, string>
    ): AgentTransport;
  };
}

/** A 1x1 PNG, the shape browser_snapshot's screenshot returns. */
const PIXEL =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

class Fixture extends McpHttpServer {
  constructor() {
    super({ name: "interop", version: "1.0.0" });
  }

  protected listTools(): McpToolListing[] {
    return [
      {
        name: "echo",
        description: "Echo the text back.",
        inputSchema: {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
        },
      },
      { name: "boom", description: "Throws.", inputSchema: { type: "object" } },
      {
        name: "screenshot",
        description: "An image and where it was saved.",
        inputSchema: { type: "object" },
      },
    ];
  }

  protected async executeTool(
    name: string,
    args: Record<string, unknown>
  ): Promise<McpToolResult> {
    switch (name) {
      case "echo":
        return { content: [{ type: "text", text: String(args.text) }] };
      case "screenshot":
        return {
          content: [
            { type: "image", data: PIXEL, mimeType: "image/png" },
            { type: "text", text: "/tmp/screenshot-1.png" },
          ],
        };
      default:
        throw new Error("boom from the tool");
    }
  }
}

const server = new Fixture();
let transport: AgentTransport;
let client: AgentClient;

beforeAll(async () => {
  const port = await server.start();
  const { McpClient } = (await import(
    pathToFileURL(
      resolve(
        import.meta.dirname,
        "../../../../../../packages/agent/src/mcp/client.ts"
      )
    ).href
  )) as AgentClientModule;
  // The URL and header the runtime MCP config gives the agent.
  transport = McpClient.httpTransport(
    `http://localhost:${port}/mcp?session=interop-session`,
    { Authorization: `Bearer ${localMcpServerToken("interop")}` }
  );
  // initialize, then the notifications/initialized notification.
  client = await McpClient.connect("interop", transport);
});

afterAll(() => {
  client?.close();
  server.stop();
});

describe("the agent's MCP client", () => {
  it("handshakes and lists the tools as written", () => {
    expect(client.tools.map((tool) => tool.name)).toEqual([
      "echo",
      "boom",
      "screenshot",
    ]);
    expect(client.tools[0]?.inputSchema).toEqual({
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    });
  });

  it("sends a notification the server accepts without answering", async () => {
    await expect(
      transport.notify("notifications/initialized")
    ).resolves.toBeUndefined();
    // Still serving afterwards: the notification left nothing pending.
    await expect(transport.request("ping")).resolves.toEqual({});
  });

  it("calls a tool", async () => {
    expect(await client.callTool("echo", { text: "hello" })).toEqual({
      text: "hello",
      isError: false,
      blocks: [{ type: "text", text: "hello" }],
    });
  });

  it("surfaces a tool that threw as an error carrying its message", async () => {
    await expect(client.callTool("boom", {})).rejects.toThrow(
      "boom from the tool"
    );
  });

  it("passes an image result through intact", async () => {
    const result = await client.callTool("screenshot", {});

    expect(result.isError).toBe(false);
    expect(result.blocks).toEqual([
      { type: "image", data: PIXEL, mimeType: "image/png" },
      { type: "text", text: "/tmp/screenshot-1.png" },
    ]);
    expect(result.text).toBe("[image]\n/tmp/screenshot-1.png");
  });
});
