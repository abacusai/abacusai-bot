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
