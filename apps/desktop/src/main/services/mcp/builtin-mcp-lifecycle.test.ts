/**
 * Switching the browser off while a browser call waits on its permission
 * prompt: the call must come back "denied", not as a dropped connection the
 * agent reports as "fetch failed".
 */
import fs from "fs";
import os from "os";
import path from "path";

import { afterAll, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { isPackaged: false, getPath: () => os.tmpdir() },
}));

const home = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-lifecycle-"));
process.env.ABACUSAI_BOT_HOME = home;

afterAll(() => fs.rmSync(home, { recursive: true, force: true }));

describe("turning the browser off", () => {
  it("answers a call waiting on its prompt with the denial", async () => {
    const { McpBrowserServer } = await import("./mcp-browser-server");
    const { BuiltinMcpLifecycle } = await import("./builtin-mcp-lifecycle");
    const { localMcpServerToken } = await import("./mcp-config-service");

    let markAsked: () => void = () => {};
    const asked = new Promise<void>((resolve) => {
      markAsked = resolve;
    });
    let answer: ((decision: "allow" | "deny") => void) | null = null;
    const browserServer = new McpBrowserServer({
      target: () => null,
      requestPermission: () => {
        markAsked();
        return new Promise((resolve) => {
          answer = resolve;
        });
      },
    });
    const lifecycle = new BuiltinMcpLifecycle({
      mcpConfigService: {
        isBuiltinBrowserDisabled: () => false,
        setBuiltinBrowserDisabled: () => {},
        readState: () => ({}),
      },
      browserServer,
      chromeBrowser: { status: () => ({}) },
      deviceServer: {},
      agentToolsServer: {},
      emitEvent: () => {},
      flushPermissions: (decision: "allow" | "deny") => answer?.(decision),
    } as never);
    const port = await browserServer.start();

    const response = fetch(`http://127.0.0.1:${port}/mcp?session=s1`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${localMcpServerToken("browser")}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "browser_navigate",
          arguments: { action: "goto", url: "https://example.test/" },
        },
      }),
    });
    await asked;

    await lifecycle.setBrowserEnabled(false);

    expect(browserServer.isRunning()).toBe(false);
    const body = (await (await response).json()) as {
      result: { isError: boolean; content: Array<{ text: string }> };
    };
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0]?.text).toContain("denied");
  });
});

describe("the built-in browser on every platform", () => {
  const lifecycleFor = async (
    platform: "electron" | "web-host",
    chromium: boolean,
    disabledByUser = false
  ) => {
    const { BuiltinMcpLifecycle } = await import("./builtin-mcp-lifecycle");
    const written: Array<Record<string, unknown>> = [];
    let found = chromium;
    const ready = vi.fn(async () => found);
    const lifecycle = new BuiltinMcpLifecycle({
      platform: () => platform,
      hostedBrowser: { ready, available: () => found },
      mcpConfigService: {
        isBuiltinBrowserDisabled: () => disabledByUser,
        isBuiltinDevicesDisabled: () => true,
        readState: () => ({}),
        writeRuntimeMcp: (_mode: string, builtins: Record<string, unknown>) => {
          written.push(builtins);
          return "/tmp/runtime-mcp.json";
        },
      },
      browserServer: {
        isRunning: () => true,
        start: async () => 4100,
        getPort: () => 4100,
      },
      chromeBrowser: { status: () => ({}) },
      deviceServer: {},
      agentToolsServer: { hasEnabledTools: () => false },
      emitEvent: () => {},
      flushPermissions: () => {},
    } as never);
    const install = () => {
      found = true;
    };
    return { lifecycle, written, ready, install };
  };

  it("web-host always has it when the computer has a Chromium, whatever the setting", async () => {
    const { lifecycle, written, ready } = await lifecycleFor(
      "web-host",
      true,
      true
    );

    await lifecycle.getRuntimeMcpPathForSpawn("code", "s1");

    expect(ready).toHaveBeenCalled();
    expect(lifecycle.isBrowserEnabled()).toBe(true);
    expect(Object.keys(written[0] ?? {})).toEqual(["browser"]);
  });

  it("web-host without a Chromium runs on, browserless", async () => {
    const { lifecycle, written } = await lifecycleFor("web-host", false);

    await lifecycle.getRuntimeMcpPathForSpawn("code", "s1");

    expect(lifecycle.isBrowserEnabled()).toBe(false);
    expect(written[0]).toEqual({});
  });

  it("web-host looks for a Chromium again on the next session while it has none", async () => {
    const { lifecycle, written, ready, install } = await lifecycleFor(
      "web-host",
      false
    );
    await lifecycle.getRuntimeMcpPathForSpawn("code", "s1");
    install();

    await lifecycle.getRuntimeMcpPathForSpawn("code", "s2");

    expect(ready).toHaveBeenCalledTimes(2);
    expect(written.map((builtins) => Object.keys(builtins))).toEqual([
      [],
      ["browser"],
    ]);
  });

  it("the desktop keeps its own view and the user's switch", async () => {
    const on = await lifecycleFor("electron", false);
    await on.lifecycle.getRuntimeMcpPathForSpawn("code", "s1");
    expect(on.ready).not.toHaveBeenCalled();
    expect(Object.keys(on.written[0] ?? {})).toEqual(["browser"]);

    const off = await lifecycleFor("electron", true, true);
    expect(off.lifecycle.isBrowserEnabled()).toBe(false);
  });
});
