/**
 * What happens to the server process when a connection ends badly.
 *
 * Both cases here used to leak a child: a connect that failed left its
 * spawned transport running for the life of the agent (one more per MCP
 * refresh), and close() never closed stdin, so a server waiting for EOF
 * never saw one.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  McpClient,
  killServerTree,
  type McpTransport,
  type SpawnLike,
} from "./client.js";
import { connectMcpServers } from "./index.js";

const configs: string[] = [];

const configFile = (servers: Record<string, unknown>): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "abacusai-bot-mcp-cfg-"));
  const file = path.join(dir, "mcp.json");

  configs.push(dir);
  fs.writeFileSync(file, JSON.stringify({ mcpServers: servers }), "utf8");

  return file;
};

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of configs.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
});

describe("a server whose connect fails", () => {
  it("closes the transport, so the spawned child does not outlive the attempt", async () => {
    const close = vi.fn();
    const failing: McpTransport = {
      request: vi.fn().mockRejectedValue(new Error("handshake failed")),
      notify: vi.fn().mockResolvedValue(undefined),
      close,
    };

    vi.spyOn(McpClient, "stdioTransport").mockReturnValue(failing);

    const result = await connectMcpServers(
      configFile({ broken: { command: "some-server", args: [] } })
    );

    expect(result.statuses).toEqual([
      expect.objectContaining({ id: "broken", status: "error" }),
    ]);
    expect(close).toHaveBeenCalledOnce();
  });

  it("does not close a transport that connected", async () => {
    const close = vi.fn();
    const working: McpTransport = {
      request: vi.fn().mockImplementation(async (method: string) => {
        return method === "tools/list" ? { tools: [] } : {};
      }),
      notify: vi.fn().mockResolvedValue(undefined),
      close,
    };

    vi.spyOn(McpClient, "stdioTransport").mockReturnValue(working);

    const result = await connectMcpServers(
      configFile({ fine: { command: "some-server", args: [] } })
    );

    expect(result.statuses).toEqual([
      expect.objectContaining({ id: "fine", status: "connected" }),
    ]);
    expect(close).not.toHaveBeenCalled();
  });
});

describe("closing a stdio transport", () => {
  // The Windows half of close() is a taskkill spawn, which needs a real
  // process tree to mean anything; the EOF ordering is what a unit test can
  // hold, and it matters on every platform.
  it.skipIf(process.platform === "win32")(
    "ends the child's stdin, so a server that exits on EOF gets to",
    async () => {
      // Ignores the kill signal on purpose: the only way out is the EOF that
      // close() sends first. Without it, this child never exits.
      const script = [
        'process.on("SIGTERM", () => {});',
        "process.stdin.resume();",
        'process.stdin.on("end", () => process.exit(0));',
        "setInterval(() => {}, 1000);",
      ].join("");
      const transport = McpClient.stdioTransport(
        process.execPath,
        ["-e", script],
        {}
      );

      // Never answered; its rejection is how the child's exit is observed.
      const pending = transport
        .request("tools/list")
        .then(() => null)
        .catch((error: unknown) => error);

      transport.close();

      const error = await pending;

      expect(String(error)).toContain("MCP server exited");
    },
    15_000
  );
});

describe("killing a server that runs behind a cmd.exe wrapper", () => {
  /** A child that only records whether it was signalled. */
  const child = (): { pid: number; kill: () => void; killed: boolean } => {
    const state = {
      pid: 4242,
      killed: false,
      kill: (): void => {
        state.killed = true;
      },
    };

    return state;
  };

  /** A taskkill stand-in that reports `outcome` on its next tick. */
  const taskkill = (
    outcome: { event: "error" | "exit"; arg: unknown } | "hangs"
  ): { spawn: SpawnLike; calls: unknown[][] } => {
    const calls: unknown[][] = [];

    return {
      calls,
      spawn: (file, args, options) => {
        calls.push([file, args, options]);
        const listeners = new Map<string, (arg: unknown) => void>();

        if (outcome !== "hangs") {
          queueMicrotask(() => listeners.get(outcome.event)?.(outcome.arg));
        }

        return {
          on: (event: "error" | "exit", listener: (arg: unknown) => void) => {
            listeners.set(event, listener);

            return undefined;
          },
        };
      },
    };
  };

  it("takes the tree with taskkill, hidden and without signalling", async () => {
    const target = child();
    const killer = taskkill({ event: "exit", arg: 0 });

    killServerTree(target, "win32", killer.spawn);
    await Promise.resolve();

    expect(killer.calls[0]?.[0]).toBe("taskkill");
    expect(killer.calls[0]?.[1]).toEqual(["/pid", "4242", "/T", "/F"]);
    // A console window must not flash on every teardown.
    expect(killer.calls[0]?.[2]).toMatchObject({ windowsHide: true });
    expect(target.killed).toBe(false);
  });

  it("kills the child itself when taskkill is not on PATH", async () => {
    // Without this the server was never signalled at all: the leak the tree
    // kill was added to close.
    const target = child();

    killServerTree(
      target,
      "win32",
      taskkill({
        event: "error",
        arg: new Error("ENOENT"),
      }).spawn
    );
    await Promise.resolve();

    expect(target.killed).toBe(true);
  });

  it("kills the child itself when taskkill exits non-zero", async () => {
    // Access denied on an elevated child reports failure this way.
    const target = child();

    killServerTree(target, "win32", taskkill({ event: "exit", arg: 1 }).spawn);
    await Promise.resolve();

    expect(target.killed).toBe(true);
  });

  it("does not spawn taskkill off Windows", () => {
    const target = child();
    const killer = taskkill("hangs");

    killServerTree(target, "darwin", killer.spawn);

    expect(killer.calls).toHaveLength(0);
    expect(target.killed).toBe(true);
  });
});
