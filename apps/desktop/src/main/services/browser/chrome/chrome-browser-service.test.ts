/**
 * The service behind "use my Chrome": finds the browser and the extension,
 * opens the allow page, waits for the extension, and connects lazily on the
 * first tab a session asks for.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";

import { ChromeBrowserService } from "./chrome-browser-service";
import type { ChromeInstall } from "./chrome-executable";

const install: ChromeInstall = {
  key: "chrome",
  name: "Google Chrome",
  executable: "/usr/bin/google-chrome",
  userDataDir: "/home/me/.config/google-chrome",
};

/** Plays the extension: opens the relay URL from the connect page and allows a tab. */
const fakeChrome = (allowTab = true) => {
  const opened: string[] = [];
  let socket: WebSocket | null = null;
  const openInBrowser = (_install: ChromeInstall, url: string): void => {
    opened.push(url);
    if (!allowTab) return;
    const relayUrl = new URL(url).searchParams.get("mcpRelayUrl")!;
    socket = new WebSocket(relayUrl);
    socket.on("open", () => {
      socket!.send(
        JSON.stringify({
          method: "chrome.tabs.onCreated",
          params: [{ id: 7, url: "https://picked.test/" }],
        })
      );
      socket!.send(
        JSON.stringify({ method: "extension.initialized", params: [] })
      );
    });
    socket.on("message", (data) => {
      const message = JSON.parse(String(data)) as {
        id: number;
        method: string;
        params: unknown[];
      };
      const result =
        message.method === "chrome.tabs.create"
          ? { id: 100, url: (message.params[0] as { url: string }).url }
          : {};
      socket!.send(JSON.stringify({ id: message.id, result }));
    });
  };
  return { opened, openInBrowser, close: () => socket?.close() };
};

let service: ChromeBrowserService | null = null;

afterEach(() => {
  service?.dispose();
  service = null;
});

describe("ChromeBrowserService", () => {
  it("reports the browser, the extension and the install link before anything is connected", () => {
    service = new ChromeBrowserService({
      onStatusChanged: () => {},
      token: () => undefined,
      findChrome: () => install,
      isExtensionInstalled: () => false,
    });

    expect(service.status()).toEqual({
      browser: "Google Chrome",
      extensionInstalled: false,
      installUrl:
        "https://chromewebstore.google.com/detail/playwright-extension/mmlmfjhmonkocbjadbfplnigmagldckm",
      connecting: false,
      connected: false,
      tabs: 0,
      error: null,
    });
  });

  it("says why it cannot connect without a browser or the extension", async () => {
    service = new ChromeBrowserService({
      onStatusChanged: () => {},
      token: () => undefined,
      findChrome: () => null,
    });
    expect((await service.connect()).error).toMatch(/not found/);

    service.dispose();
    service = new ChromeBrowserService({
      onStatusChanged: () => {},
      token: () => undefined,
      findChrome: () => install,
      isExtensionInstalled: () => false,
    });
    expect((await service.connect()).error).toMatch(
      /Extension is not installed/
    );
  });

  it("opens the allow page in Chrome, with the token when there is one, and is connected once allowed", async () => {
    const chrome = fakeChrome();
    const changes = vi.fn();
    service = new ChromeBrowserService({
      onStatusChanged: changes,
      token: () => "tok",
      findChrome: () => install,
      isExtensionInstalled: () => true,
      openInBrowser: chrome.openInBrowser,
    });

    const status = await service.connect();

    expect(status.connected).toBe(true);
    expect(status.error).toBeNull();
    expect(chrome.opened).toHaveLength(1);
    const url = new URL(chrome.opened[0]!);
    expect(url.host).toBe("mmlmfjhmonkocbjadbfplnigmagldckm");
    expect(url.searchParams.get("token")).toBe("tok");
    expect(JSON.parse(url.searchParams.get("client")!).name).toBe(
      "AbacusAI Bot"
    );
    // Connecting, then connected: the settings page saw both.
    expect(changes.mock.calls.length).toBeGreaterThanOrEqual(2);
    await vi.waitFor(() => expect(service!.status().tabs).toBe(1));
    chrome.close();
  });

  it("gives up when nobody allows it, and says so", async () => {
    const chrome = fakeChrome(false);
    service = new ChromeBrowserService({
      onStatusChanged: () => {},
      token: () => undefined,
      findChrome: () => install,
      isExtensionInstalled: () => true,
      openInBrowser: chrome.openInBrowser,
      connectTimeoutMs: 50,
    });

    const status = await service.connect();

    expect(status.connected).toBe(false);
    expect(status.error).toMatch(/did not connect/);
    expect(status.connecting).toBe(false);
  });

  it("connects on the first tab a session asks for, and makes the tab in Chrome", async () => {
    const chrome = fakeChrome();
    service = new ChromeBrowserService({
      onStatusChanged: () => {},
      token: () => undefined,
      findChrome: () => install,
      isExtensionInstalled: () => true,
      openInBrowser: chrome.openInBrowser,
    });
    const source = service.targetSource();
    expect(source.presentsInApp).toBe(false);
    expect(source.candidates()).toEqual([]);

    const id = await source.materialize("s1", "https://start.test/");

    expect(id).toBe(100);
    expect(service.status().connected).toBe(true);
    expect(source.candidates().map((c) => c.sessionId)).toContain("s1");
    expect(source.webContents(100)?.getURL()).toBe("https://start.test/");
    chrome.close();
  });

  it("drops everything on disconnect", async () => {
    const chrome = fakeChrome();
    service = new ChromeBrowserService({
      onStatusChanged: () => {},
      token: () => undefined,
      findChrome: () => install,
      isExtensionInstalled: () => true,
      openInBrowser: chrome.openInBrowser,
    });
    await service.connect();

    service.disconnect();

    expect(service.status().connected).toBe(false);
    expect(service.targetSource().candidates()).toEqual([]);
    chrome.close();
  });
});
