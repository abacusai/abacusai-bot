/**
 * What the agent sees on the wire from the three built-in MCP servers.
 *
 * The agent hands every tool's name, description and input schema to the
 * model as they arrive, so a transport change that reorders, drops or
 * rewrites any of them changes what the model is told. The listings are
 * pinned here as raw `tools/list` bodies, posted the way the agent's own
 * client posts them.
 */
import fs from "fs";
import os from "os";
import path from "path";

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
