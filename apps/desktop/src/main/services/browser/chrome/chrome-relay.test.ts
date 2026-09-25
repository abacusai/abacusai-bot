import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
/**
 * The relay against a stand-in for the Playwright Extension: the same wire
 * protocol the real one speaks: `chrome.*` calls with positional arguments,
 * `chrome.*` events back, `extension.initialized` to end the handshake.
 */
import { WebSocket } from "ws";

import { ChromeRelay } from "./chrome-relay";

/** Plays the extension's background worker. */
class FakeExtension {
  ws!: WebSocket;
  readonly commands: Array<{ id: number; method: string; params: unknown[] }> =
    [];
  nextTabId = 100;
  /** Refuse a method, as the extension does for anything not allow-listed. */
  refuse = new Set<string>();

  async connect(relayUrl: string): Promise<void> {
    this.ws = new WebSocket(relayUrl);
    await new Promise<void>((resolve, reject) => {
      this.ws.once("open", () => resolve());
      this.ws.once("error", reject);
    });
    this.ws.on("message", (data) => {
      const message = JSON.parse(String(data)) as {
        id: number;
        method: string;
        params: unknown[];
      };
      this.commands.push(message);
      if (this.refuse.has(message.method)) {
        this.send({
          id: message.id,
          error: `Unknown method: ${message.method}`,
        });
        return;
      }
      let result: unknown = {};
      if (message.method === "chrome.tabs.create") {
        const tab = {
          id: this.nextTabId++,
          url: (message.params[0] as { url: string }).url,
        };
        result = tab;
      }
      if (message.method === "chrome.debugger.sendCommand") {
        const [, cdpMethod] = message.params as [unknown, string, unknown];
        result = { echoed: cdpMethod };
      }
      this.send({ id: message.id, result });
    });
  }

  send(message: unknown): void {
    this.ws.send(JSON.stringify(message));
  }

  /** What the extension does once the user clicks Allow on a tab. */
  allow(tab: { id: number; url: string }): void {
    this.send({ method: "chrome.tabs.onCreated", params: [tab] });
    this.send({ method: "extension.initialized", params: [] });
  }

  cdpEvent(
    tabId: number,
    method: string,
    params: unknown,
    sessionId?: string
  ): void {
    this.send({
      method: "chrome.debugger.onEvent",
      params: [{ tabId, ...(sessionId ? { sessionId } : {}) }, method, params],
    });
  }

  close(): void {
    this.ws.close(1000, "user disconnected");
  }
}

let relay: ChromeRelay;
let extension: FakeExtension;

const relayUrl = (): string => {
  const url = new URL(relay.connectUrl("extid", "AbacusAI Bot"));
  return url.searchParams.get("mcpRelayUrl")!;
};

beforeEach(async () => {
  relay = new ChromeRelay();
  await relay.listen();
  extension = new FakeExtension();
});

afterEach(() => {
  relay.close();
});

describe("the connect page URL", () => {
  it("names the relay, the client and the protocol, and the token only when there is one", () => {
    const url = new URL(
      relay.connectUrl("mmlmfjhmonkocbjadbfplnigmagldckm", "AbacusAI Bot")
    );

    expect(url.protocol).toBe("chrome-extension:");
    expect(url.host).toBe("mmlmfjhmonkocbjadbfplnigmagldckm");
    expect(url.pathname).toBe("/connect.html");
    expect(url.searchParams.get("mcpRelayUrl")).toMatch(
      /^ws:\/\/127\.0\.0\.1:\d+\/extension\/[0-9a-f-]{36}$/
    );
    expect(JSON.parse(url.searchParams.get("client")!)).toEqual({
      name: "AbacusAI Bot",
    });
    expect(url.searchParams.get("protocolVersion")).toBe("2");
    expect(url.searchParams.has("token")).toBe(false);
    expect(
      new URL(relay.connectUrl("x", "y", "secret")).searchParams.get("token")
    ).toBe("secret");
  });

  it("refuses a socket on any other path", async () => {
    const wrong = relayUrl().replace(/\/extension\/.*$/, "/extension/nope");
    const ws = new WebSocket(wrong);
    await expect(
      new Promise((resolve, reject) => {
        ws.once("open", () => resolve("open"));
        ws.once("error", reject);
      })
    ).rejects.toThrow();
  });
});

describe("the handshake", () => {
  it("is connected once the user's tab arrives and the extension says it is initialised", async () => {
    const ready = vi.fn();
    relay.on("ready", ready);
    const waiting = relay.waitForConnection(2_000);

    await extension.connect(relayUrl());
    expect(relay.connected).toBe(false);
    extension.allow({ id: 7, url: "https://example.test/" });

    await waiting;
    expect(relay.connected).toBe(true);
    expect(ready).toHaveBeenCalledTimes(1);
    // The picked tab is attached on the extension's behalf, as it expects.
    await vi.waitFor(() => expect(relay.isAttached(7)).toBe(true));
    expect(extension.commands.map((c) => c.method)).toContain(
      "chrome.debugger.attach"
    );
    expect(relay.attachedTabs().map((tab) => tab.id)).toEqual([7]);
  });

  it("gives up waiting after the timeout", async () => {
    await expect(relay.waitForConnection(50)).rejects.toThrow(
      /did not connect/
    );
  });
});

describe("driving tabs", () => {
  beforeEach(async () => {
    const waiting = relay.waitForConnection(2_000);
    await extension.connect(relayUrl());
    extension.allow({ id: 7, url: "https://example.test/" });
    await waiting;
  });

  it("creates a tab through the extension and attaches to it", async () => {
    const tab = await relay.createTab("https://example.test/new");

    expect(tab.id).toBe(100);
    expect(relay.isAttached(100)).toBe(true);
    const create = extension.commands.find(
      (c) => c.method === "chrome.tabs.create"
    );
    expect(create?.params).toEqual([{ url: "https://example.test/new" }]);
    const attach = extension.commands.find(
      (c) =>
        c.method === "chrome.debugger.attach" &&
        (c.params[0] as { tabId: number }).tabId === 100
    );
    expect(attach?.params).toEqual([{ tabId: 100 }, "1.3"]);
  });

  it("sends CDP commands with the tab as the debuggee, and returns the result", async () => {
    const result = await relay.cdp(7, "Page.navigate", {
      url: "https://a.test/",
    });

    expect(result).toEqual({ echoed: "Page.navigate" });
    const sent = extension.commands.find(
      (c) => c.method === "chrome.debugger.sendCommand"
    );
    expect(sent?.params).toEqual([
      { tabId: 7 },
      "Page.navigate",
      { url: "https://a.test/" },
    ]);
  });

  it("surfaces the extension's refusal as an error", async () => {
    extension.refuse.add("chrome.tabs.remove");
    await expect(relay.closeTab(7)).rejects.toThrow(/Unknown method/);
  });

  it("routes a tab's own CDP events by tab and drops child sessions'", async () => {
    const events: Array<[number, string, unknown]> = [];
    relay.on("cdpEvent", (tabId, method, params) =>
      events.push([tabId, method, params])
    );

    extension.cdpEvent(7, "Page.loadEventFired", { timestamp: 1 });
    extension.cdpEvent(7, "Runtime.consoleAPICalled", {}, "worker-session");
    await vi.waitFor(() => expect(events).toHaveLength(1));

    expect(events[0]).toEqual([7, "Page.loadEventFired", { timestamp: 1 }]);
  });

  it("forgets a tab the user closed or dragged out", async () => {
    const detached = vi.fn();
    relay.on("tabDetached", detached);
    await vi.waitFor(() => expect(relay.isAttached(7)).toBe(true));

    extension.send({
      method: "chrome.debugger.onDetach",
      params: [{ tabId: 7 }, "canceled_by_user"],
    });
    await vi.waitFor(() => expect(detached).toHaveBeenCalledWith(7));
    expect(relay.isAttached(7)).toBe(false);
    expect(relay.tab(7)).toBeDefined();

    extension.send({ method: "chrome.tabs.onRemoved", params: [7, {}] });
    await vi.waitFor(() => expect(relay.tab(7)).toBeUndefined());
  });

  it("fails what is in flight and reports when the extension goes away", async () => {
    const disconnected = vi.fn();
    relay.on("disconnected", disconnected);
    extension.refuse.add("chrome.tabs.create"); // never answered below: we close first
    extension.ws.removeAllListeners("message");
    const pending = relay.createTab("https://x.test/");

    extension.close();

    await expect(pending).rejects.toThrow(/disconnected/);
    await vi.waitFor(() =>
      expect(disconnected).toHaveBeenCalledWith("user disconnected")
    );
    expect(relay.connected).toBe(false);
    expect(relay.attachedTabs()).toEqual([]);
    await expect(relay.cdp(7, "Page.enable")).rejects.toThrow(/not connected/);
  });

  it("admits one extension at a time", async () => {
    const second = new WebSocket(relayUrl());
    const closed = await new Promise<{ code: number; reason: string }>(
      (resolve) => {
        second.once("close", (code, reason) =>
          resolve({ code, reason: reason.toString() })
        );
      }
    );
    expect(closed.reason).toMatch(/already open/);
    expect(relay.connected).toBe(true);
  });
});
