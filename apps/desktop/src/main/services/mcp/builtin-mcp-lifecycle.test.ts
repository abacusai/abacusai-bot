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
    hostedBrowser: { available: () => boolean },
    disabledByUser = false
  ) => {
    const { BuiltinMcpLifecycle } = await import("./builtin-mcp-lifecycle");
    const written: Array<Record<string, unknown>> = [];
    const lifecycle = new BuiltinMcpLifecycle({
      platform: () => platform,
      hostedBrowser,
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
    return { lifecycle, written };
  };

  it("web-host always has it when the computer has a Chromium, whatever the setting", async () => {
    const { lifecycle, written } = await lifecycleFor(
      "web-host",
      { available: () => true },
      true
    );

    await lifecycle.getRuntimeMcpPathForSpawn("code", "s1");

    expect(lifecycle.isBrowserEnabled()).toBe(true);
    expect(Object.keys(written[0] ?? {})).toEqual(["browser"]);
  });

  it("web-host without a Chromium runs on, browserless", async () => {
    const { lifecycle, written } = await lifecycleFor("web-host", {
      available: () => false,
    });

    await lifecycle.getRuntimeMcpPathForSpawn("code", "s1");

    expect(lifecycle.isBrowserEnabled()).toBe(false);
    expect(written[0]).toEqual({});
  });

  it("web-host spawns never wait on the lookup; the background retry brings the browser in", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const { HostedChromiumLauncher, HostedChromiumService } =
        await import("../browser/chrome/hosted-chromium");
      let answer: (found: string | null) => void = () => {};
      const find = vi.fn(
        () =>
          new Promise<string | null>((resolve) => {
            answer = resolve;
          })
      );
      const service = new HostedChromiumService(
        new HostedChromiumLauncher({
          userDataDir: () => home,
          hosted: () => true,
          env: {},
          find,
          log: () => {},
        })
      );
      const { lifecycle, written } = await lifecycleFor("web-host", service);
      const started = service.prepare();

      // The start lookup is still out: spawns go ahead browserless.
      await lifecycle.getRuntimeMcpPathForSpawn("code", "s1");
      answer(null);
      expect(await started).toBe(false);
      await lifecycle.getRuntimeMcpPathForSpawn("code", "s2");
      expect(find).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(30_000);
      expect(find).toHaveBeenCalledTimes(2);
      answer("/found/chrome");
      await vi.waitFor(() => expect(service.available()).toBe(true));
      await lifecycle.getRuntimeMcpPathForSpawn("code", "s3");

      expect(find).toHaveBeenCalledTimes(2);
      expect(written.map((builtins) => Object.keys(builtins))).toEqual([
        [],
        [],
        ["browser"],
      ]);
      service.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("the desktop keeps its own view and the user's switch", async () => {
    const available = vi.fn(() => false);
    const on = await lifecycleFor("electron", { available });
    await on.lifecycle.getRuntimeMcpPathForSpawn("code", "s1");
    expect(available).not.toHaveBeenCalled();
    expect(Object.keys(on.written[0] ?? {})).toEqual(["browser"]);

    const off = await lifecycleFor("electron", { available: () => true }, true);
    expect(off.lifecycle.isBrowserEnabled()).toBe(false);
  });
});
