/**
 * An agent started without a composed server list falls back to the app's own.
 *
 * The desktop composes a list per spawn and names it in
 * `ABACUSAI_BOT_MCP_CONFIG`. Nothing writes that variable for an agent run
 * outside the app, so a connector installed there — a connector IS an MCP
 * server — would not exist at all. The user's half of that list is a plain file
 * anything can read, so it is read directly.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  FakeMcpServer,
  mcpConfig,
} from "@abacus-ai/test-support/fake-mcp-server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { connectMcpServers } from "./index.js";

let home: string;
let servers: FakeMcpServer[] = [];
const savedHome = process.env.ABACUSAI_BOT_HOME;
const savedConfig = process.env.ABACUSAI_BOT_MCP_CONFIG;

const mcpServer = async (
  tools: Parameters<typeof FakeMcpServer.start>[0]
): Promise<FakeMcpServer> => {
  const server = await FakeMcpServer.start(tools);
  servers.push(server);
  return server;
};

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "abacusai-bot-desktop-mcp-"));
  process.env.ABACUSAI_BOT_HOME = home;
  delete process.env.ABACUSAI_BOT_MCP_CONFIG;
});

afterEach(async () => {
  await Promise.all(servers.map((server) => server.close()));
  servers = [];
  fs.rmSync(home, { recursive: true, force: true });
  if (savedHome != null) process.env.ABACUSAI_BOT_HOME = savedHome;
  else delete process.env.ABACUSAI_BOT_HOME;
  if (savedConfig != null) process.env.ABACUSAI_BOT_MCP_CONFIG = savedConfig;
  else delete process.env.ABACUSAI_BOT_MCP_CONFIG;
});

describe("a terminal run with no config named", () => {
  it("connects the servers the app has configured", async () => {
    const server = await mcpServer([{ name: "goto" }]);
    fs.writeFileSync(
      path.join(home, "mcp-code.json"),
      mcpConfig({ playwright: { url: server.url } }),
      "utf8"
    );

    const connected = await connectMcpServers(undefined);

    expect(connected.statuses).toEqual([
      expect.objectContaining({
        name: "playwright",
        status: "connected",
        toolCount: 1,
      }),
    ]);
    expect(connected.tools.map((tool) => tool.name)).toEqual([
      "playwright_goto",
    ]);
  });

  it("reads the older file name too, for anyone who has not re-added their servers", async () => {
    const server = await mcpServer([{ name: "search" }]);
    fs.writeFileSync(
      path.join(home, "mcp.json"),
      mcpConfig({ docs: { url: server.url } }),
      "utf8"
    );

    const connected = await connectMcpServers(undefined);

    expect(connected.statuses).toEqual([
      expect.objectContaining({ name: "docs", status: "connected" }),
    ]);
  });

  it("prefers the current file name when both exist", async () => {
    const current = await mcpServer([{ name: "current" }]);
    const legacy = await mcpServer([{ name: "legacy" }]);
    fs.writeFileSync(
      path.join(home, "mcp-code.json"),
      mcpConfig({ docs: { url: current.url } }),
      "utf8"
    );
    fs.writeFileSync(
      path.join(home, "mcp.json"),
      mcpConfig({ docs: { url: legacy.url } }),
      "utf8"
    );

    const connected = await connectMcpServers(undefined);

    expect(connected.tools.map((tool) => tool.name)).toEqual(["docs_current"]);
  });

  it("leaves out the servers only the desktop can host", async () => {
    const server = await mcpServer([{ name: "goto" }]);
    // A stale shared config can still name them, and they are loopback URLs
    // served by a process that is not running here.
    fs.writeFileSync(
      path.join(home, "mcp-code.json"),
      JSON.stringify({
        mcpServers: {
          playwright: { url: server.url },
          browser: { url: "http://127.0.0.1:1/mcp" },
          device: { url: "http://127.0.0.1:1/mcp" },
          "agent-tools": { url: "http://127.0.0.1:1/mcp" },
        },
      }),
      "utf8"
    );

    const connected = await connectMcpServers(undefined);

    expect(connected.statuses.map((status) => status.name)).toEqual([
      "playwright",
    ]);
  });

  it("honours a disabled server", async () => {
    const server = await mcpServer([{ name: "goto" }]);
    fs.writeFileSync(
      path.join(home, "mcp-code.json"),
      JSON.stringify({
        mcpServers: { playwright: { url: server.url, disabled: true } },
      }),
      "utf8"
    );

    const connected = await connectMcpServers(undefined);

    expect(connected.statuses).toEqual([
      expect.objectContaining({ name: "playwright", status: "disconnected" }),
    ]);
    expect(connected.tools).toEqual([]);
  });

  it("has no servers, quietly, when the app has never written a list", async () => {
    const connected = await connectMcpServers(undefined);

    expect(connected.statuses).toEqual([]);
    expect(connected.tools).toEqual([]);
  });
});

describe("a desktop run", () => {
  it("uses the file it was given, built-ins and all", async () => {
    const app = await mcpServer([{ name: "snapshot" }]);
    const user = await mcpServer([{ name: "goto" }]);
    const runtime = path.join(home, "runtime.json");
    fs.writeFileSync(
      runtime,
      mcpConfig({
        browser: { url: app.url, isBuiltin: true },
        playwright: { url: user.url },
      }),
      "utf8"
    );
    // A server list of its own must not be consulted when one was named.
    fs.writeFileSync(
      path.join(home, "mcp-code.json"),
      JSON.stringify({ mcpServers: {} }),
      "utf8"
    );

    const connected = await connectMcpServers(runtime);

    expect(connected.statuses.map((status) => status.name).sort()).toEqual([
      "browser",
      "playwright",
    ]);
    // Built-ins keep their own names; user servers are qualified.
    expect(connected.tools.map((tool) => tool.name).sort()).toEqual([
      "playwright_goto",
      "snapshot",
    ]);
  });
});
