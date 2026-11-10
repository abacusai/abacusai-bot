/**
 * Roblox Studio's server ships inside Studio, so the connector follows that
 * app: hidden where Studio does not run, "not installed" until it is, and
 * "not ready" while the running agent cannot reach Studio. The card, the
 * Connect button and the model read these same answers.
 */
import { connectorById } from "@abacus-ai/connectors/registry";
import type { McpServerEntry } from "@abacus-ai/contract/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  APP_MISSING,
  ConnectorFlowService,
  OTHER_OS,
} from "./connector-flow-service";
import {
  buildConnectorStatuses,
  type StatusInputs,
} from "./connector-status-service";
import { expandEnv, localAppState, type LocalAppProbe } from "./local-app";

const roblox = connectorById("roblox-studio")!;
const WIN_BAT = "C:\\Users\\ada\\AppData\\Local\\Roblox\\mcp.bat";
const MAC_BIN = "/Applications/RobloxStudio.app/Contents/MacOS/StudioMCP";

const probe = (
  os: string,
  files: readonly string[] = [],
  env: Record<string, string> = {
    LOCALAPPDATA: "C:\\Users\\ada\\AppData\\Local",
  }
): LocalAppProbe => ({ os, env, exists: (path) => files.includes(path) });

describe("expandEnv", () => {
  it("fills %NAME% from the environment and leaves an unset one as written", () => {
    expect(
      expandEnv("%LOCALAPPDATA%\\Roblox\\mcp.bat", { LOCALAPPDATA: "C:\\L" })
    ).toBe("C:\\L\\Roblox\\mcp.bat");
    expect(expandEnv("%NOPE%\\x", {})).toBe("%NOPE%\\x");
  });
});

describe("localAppState", () => {
  it("is other-os on Linux, where Studio does not exist", () => {
    expect(localAppState(roblox, probe("linux", [MAC_BIN, WIN_BAT]))).toBe(
      "other-os"
    );
  });

  it("finds Studio's server where Roblox installs it on Windows and macOS", () => {
    expect(localAppState(roblox, probe("win32", [WIN_BAT]))).toBe("installed");
    expect(localAppState(roblox, probe("darwin", [MAC_BIN]))).toBe("installed");
    expect(localAppState(roblox, probe("win32"))).toBe("missing");
    expect(localAppState(roblox, probe("darwin"))).toBe("missing");
  });

  it("reads missing when LOCALAPPDATA is unset, never a literal %path%", () => {
    expect(localAppState(roblox, probe("win32", [WIN_BAT], {}))).toBe(
      "missing"
    );
  });

  it("is none for every connector that is not an app's own server", () => {
    expect(localAppState(connectorById("notion")!, probe("linux"))).toBe(
      "none"
    );
  });
});

describe("Roblox Studio statuses", () => {
  const server = {
    id: "roblox-studio",
    name: "roblox-studio",
    config: { command: MAC_BIN },
    isBuiltin: false,
  };
  const statusOn = (
    os: string,
    files: readonly string[],
    extra: Partial<StatusInputs> = {}
  ) =>
    buildConnectorStatuses({
      platform: null,
      storedProviders: new Set(),
      messaging: null,
      mcpServers: [],
      mcpTokens: new Map(),
      localApp: (connector) => localAppState(connector, probe(os, files)),
      ...extra,
    })["roblox-studio"];

  it("is unavailable as other-os on Linux, so no surface offers it", () => {
    expect(statusOn("linux", [])).toEqual({
      state: "unavailable",
      reason: "other-os",
    });
  });

  it("says Studio is not installed before connecting, and after it was removed", () => {
    expect(statusOn("darwin", [])).toEqual({
      state: "available",
      reason: "app-missing",
    });
    expect(statusOn("darwin", [], { mcpServers: [server] })).toEqual({
      state: "pending",
      reason: "app-missing",
    });
  });

  it("is available with Studio installed, connected once added", () => {
    expect(statusOn("darwin", [MAC_BIN])).toEqual({ state: "available" });
    expect(statusOn("darwin", [MAC_BIN], { mcpServers: [server] })).toEqual({
      state: "connected",
    });
  });

  it("is not ready while a running agent cannot reach Studio, connected again once it can", () => {
    for (const live of ["error", "disconnected"] as const)
      expect(
        statusOn("darwin", [MAC_BIN], {
          mcpServers: [server],
          mcpRuntime: new Map([["roblox-studio", live]]),
        })
      ).toEqual({ state: "pending", reason: "app-not-ready" });
    expect(
      statusOn("darwin", [MAC_BIN], {
        mcpServers: [server],
        mcpRuntime: new Map([["roblox-studio", "connected"]]),
      })
    ).toEqual({ state: "connected" });
  });

  it("leaves other MCP servers' statuses to their sign-in alone", () => {
    const statuses = buildConnectorStatuses({
      platform: null,
      storedProviders: new Set(),
      messaging: null,
      mcpServers: [
        {
          id: "huggingface",
          name: "huggingface",
          config: { url: "https://huggingface.co/mcp" },
          isBuiltin: false,
        },
      ],
      mcpTokens: new Map(),
      mcpRuntime: new Map([["huggingface", "error"]]),
      localApp: () => "none",
    });
    expect(statuses.huggingface).toEqual({ state: "connected" });
  });
});

describe("connecting Roblox Studio", () => {
  const flowOn = (os: string, files: readonly string[]) => {
    const installed = new Map<string, McpServerEntry>();
    const add = vi.fn((name: string, entry: McpServerEntry) => {
      installed.set(name, entry);
      return { success: true };
    });
    const flow = new ConnectorFlowService({
      platform: {
        connect: async () => ({ ok: false, error: "no" }),
        disconnect: async () => ({ ok: true }),
        watch: () => undefined,
      },
      pastedGithubToken: { held: async () => false, remove: () => undefined },
      mcp: {
        entry: (name) => installed.get(name),
        add,
        remove: () => ({ success: true }),
        signIn: async () => ({ kind: "open" }),
        connectUrl: () => null,
      },
      homeDir: () => "/home/ada",
      os,
      localApp: (connector) => localAppState(connector, probe(os, files)),
    });
    return { flow, add, installed };
  };

  it("installs Studio's own stdio server for this system in one click, with no sign-in", async () => {
    const mac = flowOn("darwin", [MAC_BIN]);
    expect(await mac.flow.connect("roblox-studio")).toEqual({ ok: true });
    expect(mac.installed.get("roblox-studio")).toEqual({ command: MAC_BIN });

    const win = flowOn("win32", [WIN_BAT]);
    expect(await win.flow.connect("roblox-studio")).toEqual({ ok: true });
    expect(win.installed.get("roblox-studio")).toEqual({
      command: "cmd.exe",
      args: ["/c", "%LOCALAPPDATA%\\Roblox\\mcp.bat"],
    });
  });

  it("installs nothing and answers with a code the app words when Studio is missing", async () => {
    const { flow, add } = flowOn("win32", []);
    expect(await flow.connect("roblox-studio")).toEqual({
      ok: false,
      error: APP_MISSING,
    });
    expect(add).not.toHaveBeenCalled();
  });

  it("refuses on Linux without installing a server that cannot start", async () => {
    const { flow, add } = flowOn("linux", []);
    expect(await flow.connect("roblox-studio")).toEqual({
      ok: false,
      error: OTHER_OS,
    });
    expect(flow.mcpConnectPlan("roblox-studio")).toEqual({
      kind: "app",
      label: "Roblox Studio",
      reason: OTHER_OS,
    });
    expect(add).not.toHaveBeenCalled();
  });
});
