import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
/**
 * The relay against a stand-in for the Playwright Extension: the same wire
 * protocol the real one speaks: `chrome.*` calls with positional arguments,
 * `chrome.*` events back, `extension.initialized` to end the handshake.
 */
import { WebSocket } from "ws";

import {
  BrowserTabs,
  SESSION_TABS_KEPT_MS,
  UNCLAIMED_TAB_GRACE_MS,
} from "./browser-tabs";
import { ChromeRelay, DETACH_TIMEOUT_MS } from "./chrome-relay";

/** Plays the extension's background worker. */
class FakeExtension {
  ws!: WebSocket;
  readonly commands: Array<{ id: number; method: string; params: unknown[] }> =
    [];
  nextTabId = 100;
  /** Refuse a method, as the extension does for anything not allow-listed. */
  refuse = new Set<string>();
  /** Never answer a method, as a stuck extension would. */
  ignore = new Set<string>();

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
      if (this.ignore.has(message.method)) return;
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

  it("never lets go of the picked tab, even when the handshake ends before its attach lands", async () => {
    const tabs = new BrowserTabs(relay, { page: () => null });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const ready = vi.fn();
      relay.on("ready", ready);
      const attached = vi.fn();
      relay.on("tabAttached", attached);
      await extension.connect(relayUrl());
      // `allow` sends the tab and then `initialized` at once: `ready` fires
      // while the relay is still waiting on the tab's attach.
      extension.allow({ id: 7, url: "https://picked.test/" });
      await vi.waitFor(() => expect(attached).toHaveBeenCalled());
      expect(ready.mock.invocationCallOrder[0]).toBeLessThan(
        attached.mock.invocationCallOrder[0]!
      );

      await vi.advanceTimersByTimeAsync(UNCLAIMED_TAB_GRACE_MS * 2);

      expect(relay.isAttached(7)).toBe(true);
      expect(relay.tab(7)?.preexisting).toBe(true);
      expect(extension.commands.map((c) => c.method)).not.toContain(
        "chrome.debugger.detach"
      );
      expect(tabs.ownerOf(7)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
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

  it("lets a tab go even when the extension never answers the detach, and says so once", async () => {
    await vi.waitFor(() => expect(relay.isAttached(7)).toBe(true));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const detached = vi.fn();
    relay.on("tabDetached", detached);
    extension.ignore.add("chrome.debugger.detach");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const letGo = relay.detachTab(7);
      await vi.advanceTimersByTimeAsync(DETACH_TIMEOUT_MS);
      await letGo;
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
      warn.mockRestore();
    }

    expect(relay.isAttached(7)).toBe(false);
    expect(detached).toHaveBeenCalledWith(7);
  });

  it("lets a tab go even when the extension refuses the detach", async () => {
    await vi.waitFor(() => expect(relay.isAttached(7)).toBe(true));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const tabs = new BrowserTabs(relay, { page: () => null });
    extension.refuse.add("chrome.debugger.detach");
    // A tab a session opened, then let go when the session's hold ran out.
    const made = await tabs.create("s1", "https://a.test/");
    try {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      expect(tabs.ownerOf(made.id)).toBe("s1");
      tabs.releaseSession("s1");
      await vi.advanceTimersByTimeAsync(SESSION_TABS_KEPT_MS);
      vi.useRealTimers();
      await vi.waitFor(() => expect(relay.isAttached(made.id)).toBe(false));
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
      warn.mockRestore();
    }

    expect(tabs.tabs("s1")).toEqual([]);
    expect(tabs.ownerOf(made.id)).toBeNull();
    expect(
      extension.commands.filter((c) => c.method === "chrome.tabs.remove")
    ).toEqual([]);
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
