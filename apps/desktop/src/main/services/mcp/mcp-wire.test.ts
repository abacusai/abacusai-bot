/**
 * What the agent sees on the wire from the three built-in MCP servers.
 *
 * The agent hands every tool's name, description and input schema to the
 * model as they arrive, so a transport change that reorders, drops or
 * rewrites any of them changes what the model is told. The listings are
 * pinned here as raw `tools/list` bodies, posted the way the agent's own
 * client posts them. The protocol around them is checked end to end with the
 * SDK's own client.
 */
import fs from "fs";
import os from "os";
import path from "path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { isPackaged: false, getPath: () => os.tmpdir() },
}));

type Started = { port: number; stop: () => void; token: string };

const home = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-wire-"));
const servers: Started[] = [];
let browser: Started;
let device: Started;
let agentTools: Started;

/** The headers the agent's MCP client sends on every POST. */
const agentHeaders = (token: string): Record<string, string> => ({
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
  Authorization: `Bearer ${token}`,
});

const listTools = async (
  server: Started,
  session?: string
): Promise<unknown[]> => {
  const query = session != null ? `?session=${session}` : "";
  const res = await fetch(`http://127.0.0.1:${server.port}/mcp${query}`, {
    method: "POST",
    headers: agentHeaders(server.token),
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  const body = (await res.json()) as { result: { tools: unknown[] } };
  return body.result.tools;
};

const pretty = (value: unknown): string =>
  `${JSON.stringify(value, null, 2)}\n`;

beforeAll(async () => {
  process.env.ABACUSAI_BOT_HOME = home;
  const { McpBrowserServer } = await import("./mcp-browser-server");
  const { McpDeviceServer } = await import("./mcp-device-server");
  const { McpAgentToolsServer } = await import("./mcp-agent-tools-server");
  const { localMcpServerToken } = await import("./mcp-config-service");

  const start = async (
    server: { start: () => Promise<number>; stop: () => void },
    name: string
  ): Promise<Started> => {
    const started = {
      port: await server.start(),
      stop: () => server.stop(),
      token: localMcpServerToken(name),
    };
    servers.push(started);
    return started;
  };

  browser = await start(
    new McpBrowserServer({ target: () => null }),
    "browser"
  );
  device = await start(
    new McpDeviceServer({
      deviceService: {
        isAvailable: () => true,
        listDevices: async () => [],
      } as never,
    }),
    "device"
  );
  agentTools = await start(
    new McpAgentToolsServer({
      skillsService: {} as never,
      enabledToolsets: () => new Set(["todo", "memory", "cronjob"]),
      workspacePath: () => null,
      botIdForSession: (session: string) =>
        session === "bot-session" ? "bot-1" : null,
    } as never),
    "agent-tools"
  );
});

afterAll(() => {
  for (const server of servers) server.stop();
  fs.rmSync(home, { recursive: true, force: true });
});

describe("the tool listings on the wire", () => {
  it("keeps the browser tools byte for byte", async () => {
    await expect(pretty(await listTools(browser))).toMatchFileSnapshot(
      "./__snapshots__/browser-tools.snap"
    );
  });

  it("keeps the device tools byte for byte", async () => {
    await expect(pretty(await listTools(device))).toMatchFileSnapshot(
      "./__snapshots__/device-tools.snap"
    );
  });

  it("keeps the agent tools byte for byte, for a session and for a bot", async () => {
    await expect(
      pretty({
        session: await listTools(agentTools, "ui-session"),
        bot: await listTools(agentTools, "bot-session"),
      })
    ).toMatchFileSnapshot("./__snapshots__/agent-tools.snap");
  });
});

const post = async (
  server: Started,
  body: unknown
): Promise<{ status: number; text: string }> => {
  const res = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
    method: "POST",
    headers: agentHeaders(server.token),
    body: JSON.stringify(body),
  });
  return { status: res.status, text: await res.text() };
};

describe("the protocol, end to end", () => {
  it("serves the SDK client over Streamable HTTP", async () => {
    const client = new Client({ name: "wire-test", version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${device.port}/mcp`),
        {
          requestInit: {
            headers: { Authorization: `Bearer ${device.token}` },
          },
        }
      )
    );

    expect(client.getServerVersion()).toEqual({
      name: "device",
      version: "1.0.0",
    });
    expect(client.getServerCapabilities()).toMatchObject({
      tools: { listChanged: false },
    });
    await expect(client.ping()).resolves.toEqual({});

    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toContain("device_list");

    const result = await client.callTool({ name: "device_list" });
    expect(result).toMatchObject({
      content: [{ type: "text", text: expect.stringContaining("No devices") }],
    });

    await client.close();
  });

  it("answers a notification with a bare 202 and no JSON-RPC response", async () => {
    expect(
      await post(device, {
        jsonrpc: "2.0",
        method: "notifications/initialized",
      })
    ).toEqual({ status: 202, text: "" });
  });

  it("negotiates the protocol version instead of pinning one", async () => {
    const initialize = async (protocolVersion: string): Promise<string> => {
      const { text } = await post(agentTools, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion,
          capabilities: {},
          clientInfo: { name: "wire-test", version: "1.0.0" },
        },
      });
      return (JSON.parse(text) as { result: { protocolVersion: string } })
        .result.protocolVersion;
    };

    // The agent's client asks for 2024-11-05 and keeps it.
    expect(await initialize("2024-11-05")).toBe("2024-11-05");
    expect(await initialize(LATEST_PROTOCOL_VERSION)).toBe(
      LATEST_PROTOCOL_VERSION
    );
    // One the server does not know gets the newest it does.
    expect(await initialize("1999-01-01")).toBe(LATEST_PROTOCOL_VERSION);
  });
});
