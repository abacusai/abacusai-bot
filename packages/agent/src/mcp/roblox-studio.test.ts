/**
 * Roblox Studio's connector, end to end against a stand-in for Studio's own
 * MCP server: a real stdio process that answers the way Studio's does, with
 * a few of its tools (list_roblox_studios, multi_edit, script_read,
 * start_stop_play, get_console_output, screen_capture, user_mouse_input). Installed as the registry's entry
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
import { afterEach, describe, expect, it, vi } from "vitest";

import { mcpPrompt } from "../session.js";
import {
  connectMcpServers,
  type ConnectedMcp,
  userMcpToolChangesState,
} from "./index.js";
import { buildMcpToolDefinitions } from "./tools.js";

/** Newline-delimited JSON-RPC over stdio, as Studio's server speaks it. */
const STAND_IN = String.raw`
const readline = require("node:readline");
if (process.env.STAND_IN_STARTS != null) require("node:fs").appendFileSync(process.env.STAND_IN_STARTS, "start\n");
const hangs = () => process.env.STAND_IN_HANG_WHEN != null && require("node:fs").existsSync(process.env.STAND_IN_HANG_WHEN);
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
  ["generate_mesh", "Generates a textured 3D mesh from a prompt."],
  ["screen_capture", "Captures the Studio viewport as an image."],
  ["user_mouse_input", "Sends mouse actions to the playtest."],
].map(([name, description]) => ({ name, description, inputSchema: { type: "object" } }));
const text = (value) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
const call = (name, args) => {
  if (name === "list_roblox_studios") return text(studios);
  if (studios.length === 0) return { ...text("No Studio is connected."), isError: true };
  if (name === "multi_edit") { scripts.set(args.path, args.source); return text({ ok: true }); }
  if (name === "script_read") return text(scripts.get(args.path) ?? null);
  if (name === "start_stop_play") return text({ playing: true });
  if (name === "get_console_output") return text(["Hello from Luau"]);
  if (name === "screen_capture") return { content: [{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }] };
  if (name === "user_mouse_input") return text({ ok: true });
  return { ...text("unknown tool"), isError: true };
};
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id == null) return;
  if (message.method === "tools/list" && hangs()) return;
  const result =
    message.method === "initialize"
      ? { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "Roblox_Studio", version: "1" } }
      : message.method === "tools/list"
        ? { tools: process.env.STAND_IN_OPEN_WHEN == null || require("node:fs").existsSync(process.env.STAND_IN_OPEN_WHEN) ? tools : [] }
        : message.method === "tools/call"
          ? call(message.params.name, message.params.arguments ?? {})
          : {};
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\n");
});
`;

const dirs: string[] = [];
const connected: ConnectedMcp[] = [];

const configWith = (
  entry: Record<string, unknown>,
  name = "roblox-studio"
): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "roblox-stand-in-"));
  dirs.push(dir);
  const script = path.join(dir, "studio-mcp.cjs");
  fs.writeFileSync(script, STAND_IN, "utf8");
  const file = path.join(dir, "mcp.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      mcpServers: {
        [name]: {
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

  it("puts Studio's core tools in the agent's list, named by the connector, and leaves the rest out", async () => {
    const roblox = connectorById("roblox-studio");
    if (roblox?.kind !== "mcp") throw new Error("missing");
    const mcp = await connect(
      configWith({ tools: mcpEntryOn(roblox, "darwin")?.tools })
    );
    expect(mcp.statuses).toEqual([
      expect.objectContaining({ id: "roblox-studio", status: "connected" }),
    ]);
    expect(mcp.tools.map((tool) => tool.name).toSorted()).toEqual([
      "roblox-studio_get_console_output",
      "roblox-studio_list_roblox_studios",
      "roblox-studio_multi_edit",
      "roblox-studio_screen_capture",
      "roblox-studio_script_read",
      "roblox-studio_start_stop_play",
      "roblox-studio_user_mouse_input",
    ]);
    expect(mcp.routes.has("roblox-studio_generate_mesh")).toBe(false);
    expect(mcp.routes.has("generate_mesh")).toBe(false);
  });

  it("hands the model the playtest it clicked through as an image", async () => {
    const roblox = connectorById("roblox-studio");
    if (roblox?.kind !== "mcp") throw new Error("missing");
    const mcp = await connect(
      configWith({ tools: mcpEntryOn(roblox, "darwin")?.tools })
    );
    const tools = buildMcpToolDefinitions(() => mcp);
    const tool = (name: string) => {
      const found = tools.find((t) => t.name === `roblox-studio_${name}`);
      if (found == null) throw new Error(`no ${name}`);
      return found;
    };
    await tool("start_stop_play").execute("call-1", {});
    expect((await tool("user_mouse_input").execute("call-2", {})).isError).toBe(
      false
    );
    const shot = await tool("screen_capture").execute("call-3", {});
    expect(shot.content).toContainEqual({
      type: "image",
      data: "iVBORw0KGgo=",
      mimeType: "image/png",
    });
  });

  it("offers every tool of a server whose entry names none", async () => {
    const mcp = await connect(configWith({}));
    expect(mcp.tools).toHaveLength(8);
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

  it("counts its playtest and script tools as changing the place, so a repeat after one is a new look", async () => {
    await connect(configWith({}));
    expect(userMcpToolChangesState("roblox-studio_start_stop_play")).toBe(true);
    expect(userMcpToolChangesState("roblox-studio_multi_edit")).toBe(true);
    expect(userMcpToolChangesState("read")).toBeNull();
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

  it("offers Studio's tools once it serves them, when it connected with none while closed", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "roblox-closed-"));
      dirs.push(dir);
      const open = path.join(dir, "studio-open");
      const mcp = await connect(
        configWith({ env: { STAND_IN_OPEN_WHEN: open } })
      );
      let added = 0;
      let changed = 0;
      mcp.onToolsAdded = () => added++;
      mcp.onStatusChange = () => changed++;
      expect(mcp.statuses).toEqual([
        expect.objectContaining({ status: "connected", toolCount: 0 }),
      ]);
      expect(mcpPrompt(mcp.statuses)).toContain(
        "Connected, but serving no tools yet: `roblox-studio`"
      );

      // Still closed at the first recheck: nothing changes.
      await vi.advanceTimersByTimeAsync(5_000);
      await vi.waitFor(() => expect(mcp.clients).toHaveLength(1));
      expect(added).toBe(0);
      expect(mcp.tools).toEqual([]);

      fs.writeFileSync(open, "");
      await vi.advanceTimersByTimeAsync(10_000);
      await vi.waitFor(() => expect(added).toBe(1));
      expect(changed).toBe(1);
      expect(mcp.statuses).toEqual([
        expect.objectContaining({ status: "connected", toolCount: 8 }),
      ]);
      expect(mcp.tools).toHaveLength(8);
      expect(mcp.clients).toHaveLength(1);
      expect(
        JSON.parse((await callAs(mcp, "list_roblox_studios")).text)
      ).toEqual([expect.objectContaining({ studio_id: "studio-1" })]);
      expect(mcpPrompt(mcp.statuses)).toContain(
        "`roblox-studio` (tools named `roblox-studio_*`)"
      );
      expect(mcpPrompt(mcp.statuses)).not.toContain("serving no tools yet");
    } finally {
      vi.useRealTimers();
    }
  }, 60_000);

  it("asks again at once when a turn starts, so the message after opening Studio has its tools", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "roblox-closed-"));
      dirs.push(dir);
      const open = path.join(dir, "studio-open");
      const mcp = await connect(
        configWith({ env: { STAND_IN_OPEN_WHEN: open } })
      );
      let added = 0;
      mcp.onToolsAdded = () => added++;
      // Nothing to find yet: the ask answers, and nothing changes.
      await mcp.askWaiting?.();
      expect(added).toBe(0);

      fs.writeFileSync(open, "");
      await mcp.askWaiting?.();
      expect(added).toBe(1);
      expect(mcp.tools).toHaveLength(8);
      // Served now: nothing is left waiting.
      await mcp.askWaiting?.();
      expect(added).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  }, 60_000);

  it("never holds a turn on a launcher that hangs, and does not wait on it again", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "roblox-hang-"));
      dirs.push(dir);
      const hang = path.join(dir, "hang");
      const starts = path.join(dir, "starts");
      const mcp = await connect(
        configWith({
          env: {
            STAND_IN_OPEN_WHEN: path.join(dir, "open"),
            STAND_IN_HANG_WHEN: hang,
            STAND_IN_STARTS: starts,
          },
        })
      );
      fs.writeFileSync(hang, "");
      const first = mcp.askWaiting?.();
      await vi.advanceTimersByTimeAsync(1_500);
      await first;
      // The hung ask is still under way: the next turn does not wait on it.
      const started = Date.now();
      await mcp.askWaiting?.();
      expect(Date.now() - started).toBeLessThan(200);
      expect(mcp.tools).toEqual([]);
      // The hung launcher is up (not still booting) before its files go.
      await vi.waitFor(
        () =>
          expect(
            fs.readFileSync(starts, "utf8").trim().split("\n")
          ).toHaveLength(2),
        { timeout: 15_000 }
      );
    } finally {
      vi.useRealTimers();
    }
  }, 60_000);

  it("stops the timed asks after a while, and then asks only when a turn starts", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "roblox-closed-"));
    dirs.push(dir);
    const starts = path.join(dir, "starts");
    // Two short timed asks stand in for the real schedule.
    const mcp = await connectMcpServers(
      configWith({
        env: {
          STAND_IN_OPEN_WHEN: path.join(dir, "open"),
          STAND_IN_STARTS: starts,
        },
      }),
      [20, 20]
    );
    connected.push(mcp);
    const count = () =>
      fs.existsSync(starts)
        ? fs.readFileSync(starts, "utf8").split("\n").length - 1
        : 0;
    // The first connect and the two timed asks; then nothing on its own.
    await vi.waitFor(() => expect(count()).toBe(3), { timeout: 20_000 });
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(count()).toBe(3);
    await mcp.askWaiting?.();
    await vi.waitFor(() => expect(count()).toBe(4), { timeout: 20_000 });
  }, 60_000);

  it("does not ask again a server with no tools that is not an app's own", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "empty-server-"));
      dirs.push(dir);
      const starts = path.join(dir, "starts");
      const mcp = await connect(
        configWith(
          {
            env: {
              STAND_IN_OPEN_WHEN: path.join(dir, "open"),
              STAND_IN_STARTS: starts,
            },
          },
          "notes"
        )
      );
      await vi.advanceTimersByTimeAsync(30 * 60_000);
      await mcp.askWaiting?.();
      expect(fs.readFileSync(starts, "utf8").trim().split("\n")).toHaveLength(
        1
      );
    } finally {
      vi.useRealTimers();
    }
  }, 60_000);

  it("stops asking once the session's servers are replaced", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "roblox-closed-"));
      dirs.push(dir);
      const open = path.join(dir, "studio-open");
      const mcp = await connect(
        configWith({ env: { STAND_IN_OPEN_WHEN: open } })
      );
      let added = 0;
      mcp.onToolsAdded = () => added++;
      mcp.retire?.();
      fs.writeFileSync(open, "");
      await vi.advanceTimersByTimeAsync(60_000);
      expect(added).toBe(0);
      expect(mcp.tools).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  }, 60_000);
});
