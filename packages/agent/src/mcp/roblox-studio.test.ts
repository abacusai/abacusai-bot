/**
 * Roblox Studio's connector, end to end against a stand-in for Studio's own
 * MCP server: a real stdio process that answers the way Studio's does, with
 * a few of its tools (list_roblox_studios, multi_edit, script_read,
 * start_stop_play, get_console_output). Installed as the registry's entry
 * would install it, it reaches the agent's tool list and answers calls; a
 * server that cannot start (Studio closed or its MCP switch off) is an
 * error the app shows as "not ready", not a hang.
 *
 * Studio itself only runs on Windows and macOS, so this is the transport and
 * the agent's side; the registry test pins the real command per system.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { connectorById, mcpEntryOn } from "@abacus-ai/connectors/registry";
import { afterEach, describe, expect, it } from "vitest";

import { connectMcpServers, type ConnectedMcp } from "./index.js";

/** Newline-delimited JSON-RPC over stdio, as Studio's server speaks it. */
const STAND_IN = String.raw`
const readline = require("node:readline");
const studios = process.env.STAND_IN_STUDIOS === "0" ? [] : [
  { studio_id: "studio-1", name: "Obby.rbxl", place_id: 1 },
];
const scripts = new Map();
const tools = [
  ["list_roblox_studios", "Lists connected Studio instances."],
  ["multi_edit", "Applies edits to a script, creating it if missing."],
  ["script_read", "Reads a script by its dot-path."],
  ["start_stop_play", "Starts or stops a playtest."],
  ["get_console_output", "Reads Studio's output log."],
].map(([name, description]) => ({ name, description, inputSchema: { type: "object" } }));
const text = (value) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
const call = (name, args) => {
  if (name === "list_roblox_studios") return text(studios);
  if (studios.length === 0) return { ...text("No Studio is connected."), isError: true };
  if (name === "multi_edit") { scripts.set(args.path, args.source); return text({ ok: true }); }
  if (name === "script_read") return text(scripts.get(args.path) ?? null);
  if (name === "start_stop_play") return text({ playing: true });
  if (name === "get_console_output") return text(["Hello from Luau"]);
  return { ...text("unknown tool"), isError: true };
};
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id == null) return;
  const result =
    message.method === "initialize"
      ? { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "Roblox_Studio", version: "1" } }
      : message.method === "tools/list"
        ? { tools }
        : message.method === "tools/call"
          ? call(message.params.name, message.params.arguments ?? {})
          : {};
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\n");
});
`;

const dirs: string[] = [];
const connected: ConnectedMcp[] = [];

const configWith = (entry: Record<string, unknown>): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "roblox-stand-in-"));
  dirs.push(dir);
  const script = path.join(dir, "studio-mcp.cjs");
  fs.writeFileSync(script, STAND_IN, "utf8");
  const file = path.join(dir, "mcp.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      mcpServers: {
        "roblox-studio": {
          command: process.execPath,
          args: [script],
          ...entry,
        },
      },
    }),
    "utf8"
  );
  return file;
};

const connect = async (config: string): Promise<ConnectedMcp> => {
  const mcp = await connectMcpServers(config);
  connected.push(mcp);
  return mcp;
};

afterEach(() => {
  for (const mcp of connected.splice(0)) {
    mcp.retire?.();
    for (const client of mcp.clients) client.close?.();
  }
  for (const dir of dirs.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
});

const callAs = async (
  mcp: ConnectedMcp,
  tool: string,
  args: Record<string, unknown> = {}
) => {
  const route = mcp.routes.get(`roblox-studio_${tool}`);
  if (route == null) throw new Error(`no route for ${tool}`);
  return await route.client.callTool(route.toolName, args);
};

describe("Roblox Studio over stdio", () => {
  it("installs as a plain stdio command with nothing to sign in to", () => {
    const roblox = connectorById("roblox-studio");
    if (roblox?.kind !== "mcp") throw new Error("missing");
    for (const system of ["darwin", "win32"]) {
      const entry = mcpEntryOn(roblox, system);
      expect(entry?.command).toBeTruthy();
      expect(entry?.url).toBeUndefined();
    }
  });

  it("puts Studio's tools in the agent's list, named by the connector", async () => {
    const mcp = await connect(configWith({}));
    expect(mcp.statuses).toEqual([
      expect.objectContaining({ id: "roblox-studio", status: "connected" }),
    ]);
    expect(mcp.tools.map((tool) => tool.name).toSorted()).toEqual([
      "roblox-studio_get_console_output",
      "roblox-studio_list_roblox_studios",
      "roblox-studio_multi_edit",
      "roblox-studio_script_read",
      "roblox-studio_start_stop_play",
    ]);
  });

  it("writes a script into the place and playtests it, the loop the model is told to run", async () => {
    const mcp = await connect(configWith({}));
    const studios = await callAs(mcp, "list_roblox_studios");
    expect(JSON.parse(studios.text)).toEqual([
      expect.objectContaining({ studio_id: "studio-1" }),
    ]);
    const source = 'print("Hello from Luau")';
    const path = "game.ServerScriptService.Hello";
    expect((await callAs(mcp, "multi_edit", { path, source })).isError).toBe(
      false
    );
    expect(JSON.parse((await callAs(mcp, "script_read", { path })).text)).toBe(
      source
    );
    await callAs(mcp, "start_stop_play");
    expect((await callAs(mcp, "get_console_output")).text).toContain(
      "Hello from Luau"
    );
  });

  it("answers with no Studio, and an error per call, while Studio is not reachable", async () => {
    const mcp = await connect(configWith({ env: { STAND_IN_STUDIOS: "0" } }));
    expect(JSON.parse((await callAs(mcp, "list_roblox_studios")).text)).toEqual(
      []
    );
    const edit = await callAs(mcp, "multi_edit", { path: "x", source: "" });
    expect(edit.isError).toBe(true);
  });

  it("reports an error, not a hang, when Studio's server cannot start", async () => {
    const mcp = await connect(configWith({ args: ["-e", "process.exit(1)"] }));
    expect(mcp.statuses).toEqual([
      expect.objectContaining({ id: "roblox-studio", status: "error" }),
    ]);
    expect(mcp.tools).toEqual([]);
  }, 60_000);
});
