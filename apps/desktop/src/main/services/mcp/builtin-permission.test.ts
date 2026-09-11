/**
 * The built-in MCP servers prompt from the desktop process, so they have to be
 * told which session is calling — otherwise "Bypass" (which the agent process
 * enforces on its own tools) means nothing to them, and a device tap still
 * raises a modal. These cover the wiring that carries the session id.
 */
import os from "os";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { isPackaged: false, getPath: () => os.tmpdir() },
}));
vi.mock("../device/sim-input-client", () => ({
  SimInputClient: class {
    isSupported(): boolean {
      return false;
    }
    disposeDevice(): void {
      /* no helper to dispose */
    }
  },
}));
vi.mock("../device/device-service", () => ({
  DeviceService: class {
    isAvailable(): boolean {
      return true;
    }
    getToolchain(): unknown {
      return { ios: false, android: true };
    }
    async listDevices(): Promise<unknown[]> {
      return [];
    }
    async boot(): Promise<{ name: string; id: string }> {
      return { name: "Pixel", id: "emulator-5554" };
    }
  },
}));

let server: import("./mcp-device-server").McpDeviceServer;
let port: number;
let token: string;
const asked: Array<{ tool: string; sessionId?: string }> = [];

const post = async (path: string, body: unknown): Promise<unknown> => {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  return res.json();
};

beforeAll(async () => {
  process.env.ABACUSAI_BOT_HOME = os.tmpdir();
  const { McpDeviceServer } = await import("./mcp-device-server");
  const { localMcpServerToken } = await import("./mcp-config-service");
  token = localMcpServerToken("device");
  server = new McpDeviceServer({
    requestPermission: async (tool, _summary, sessionId) => {
      asked.push({ tool, sessionId });
      // Stand in for the real gate: this session is in Bypass.
      return sessionId === "yolo-session" ? "allow" : "deny";
    },
  });
  port = await server.start();
});

afterAll(() => server.stop());

describe("built-in permission wiring", () => {
  it("hands the calling session id to the permission gate", async () => {
    asked.length = 0;
    await post("/mcp?session=yolo-session", {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "device_boot", arguments: { platform: "android" } },
    });
    expect(asked).toHaveLength(1);
    expect(asked[0]).toEqual({
      tool: "device_boot",
      sessionId: "yolo-session",
    });
  });

  it("leaves the session id undefined when the URL carries none", async () => {
    asked.length = 0;
    await post("/mcp", {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "device_boot", arguments: { platform: "android" } },
    });
    expect(asked[0]?.sessionId).toBeUndefined();
  });

  it("still skips the prompt for read-only tools", async () => {
    asked.length = 0;
    await post("/mcp?session=yolo-session", {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "device_list", arguments: {} },
    });
    expect(asked).toHaveLength(0);
  });

  it("rejects a call with no bearer token", async () => {
    const res = await fetch(
      `http://127.0.0.1:${port}/mcp?session=yolo-session`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/list" }),
      }
    );
    expect(res.status).toBe(401);
  });
});
