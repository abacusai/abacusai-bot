/**
 * Chrome's tabs as the browser tools' target source: a session gets its own
 * tab, the user's picked tab belongs to nobody, and tabs that leave the group
 * stop being offered.
 */
import { EventEmitter } from "node:events";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import { pickBrowserTarget } from "../browser-target";
import type { ChromeRelay, ChromeTabInfo } from "./chrome-relay";
import { ChromeTargetSource } from "./chrome-target-source";

class FakeRelay extends EventEmitter {
  connected = true;
  tabs = new Map<number, ChromeTabInfo>();
  attached = new Set<number>();
  next = 100;
  cdp = vi.fn(
    async (
      _tabId: number,
      method: string,
      _params?: unknown
    ): Promise<unknown> =>
      method === "Page.getFrameTree"
        ? { frameTree: { frame: { id: "main" } } }
        : {}
  );
  tab(id: number) {
    return this.tabs.get(id);
  }
  isAttached(id: number) {
    return this.attached.has(id);
  }
  attachedTabs() {
    return [...this.attached].map((id) => this.tabs.get(id)!);
  }
  async createTab(url: string) {
    const tab = { id: this.next++, url };
    this.tabs.set(tab.id, tab);
    this.attached.add(tab.id);
    this.emit("tabAttached", tab);
    return tab;
  }
  closeTab = vi.fn(async (id: number) => {
    this.attached.delete(id);
    this.tabs.delete(id);
    this.emit("tabRemoved", id);
  });
  /** A page the browser opened by itself (a popup), attached as the driver does. */
  open(tab: ChromeTabInfo) {
    this.tabs.set(tab.id, tab);
    this.attached.add(tab.id);
    this.emit("tabAttached", tab);
  }
  /** What the extension does when the user allows a tab. */
  allow(tab: ChromeTabInfo) {
    this.tabs.set(tab.id, tab);
    this.attached.add(tab.id);
  }
}

const setup = () => {
  const clock = { now: 1_000_000 };
  const relay = new FakeRelay();
  const source = new ChromeTargetSource(relay as unknown as ChromeRelay, {
    now: () => clock.now,
  });
  return { relay, source, clock };
};

describe("ChromeTargetSource", () => {
  it("offers the attached tabs, the user's own without an owner", () => {
    const { relay, source } = setup();
    relay.allow({ id: 7, url: "https://picked.test/", active: true });

    expect(source.candidates()).toEqual([
      { id: 7, url: "https://picked.test/", sessionId: null, presented: true },
    ]);
    // A session drives only its own tabs, so it gets none of this one.
    expect(
      pickBrowserTarget(source.candidates(), { id: null, url: null }, "s1")
    ).toBeNull();
    // A caller with no session takes the tab on screen.
    expect(
      pickBrowserTarget(source.candidates(), { id: null, url: null }, null)
    ).toBe(7);
  });

  it("makes a session its own tab and remembers whose it is", async () => {
    const { relay, source } = setup();

    const id = await source.materialize("s1", "https://start.test/");

    expect(id).toBe(100);
    expect(source.candidates()).toEqual([
      {
        id: 100,
        url: "https://start.test/",
        sessionId: "s1",
        presented: false,
        current: true,
      },
    ]);
    expect(source.sessionTabs("s1").map((tab) => tab.id)).toEqual([100]);
    expect(source.webContents(100)?.getURL()).toBe("https://start.test/");
    // The page's domains were enabled so its events flow from the start.
    expect(relay.cdp).toHaveBeenCalledWith(100, "Page.enable");
  });

  it("routes a tab's CDP events to its page", async () => {
    const { relay, source } = setup();
    await source.materialize("s1", "https://start.test/");
    const page = source.webContents(100)!;

    relay.emit("cdpEvent", 100, "Page.frameNavigated", {
      frame: { id: "main", url: "https://next.test/" },
    });

    expect(page.getURL()).toBe("https://next.test/");
  });

  it("drops a tab that left the group or closed", async () => {
    const { relay, source } = setup();
    await source.materialize("s1", "https://start.test/");
    const page = source.webContents(100)!;

    relay.attached.delete(100);
    relay.emit("tabDetached", 100);

    expect(page.isDestroyed()).toBe(true);
    expect(source.candidates()).toEqual([]);
    expect(source.webContents(100)).toBeNull();
    expect(source.sessionTabs("s1")).toEqual([]);
  });

  describe("tabs a session's page opens", () => {
    it("drives a popup its page opened, and goes back to the opener when it closes", async () => {
      const { relay, source } = setup();
      await source.materialize("s1", "https://flights.test/");
      // The tools remember the opener; the popup still wins.
      const memory = { id: 100, url: "https://flights.test/" };

      relay.open({ id: 7, url: "https://airline.test/book", openerTabId: 100 });

      expect(pickBrowserTarget(source.candidates(), memory, "s1")).toBe(7);
      expect(source.sessionTabs("s1")).toEqual([
        expect.objectContaining({ id: 100, current: false, openerId: null }),
        expect.objectContaining({ id: 7, current: true, openerId: 100 }),
      ]);
      // Another session's popup is never this session's.
      expect(pickBrowserTarget(source.candidates(), memory, "s2")).toBeNull();

      relay.emit("tabRemoved", 7);

      expect(pickBrowserTarget(source.candidates(), memory, "s1")).toBe(100);
      expect(source.sessionTabs("s1")).toEqual([
        expect.objectContaining({ id: 100, current: true }),
      ]);
    });

    it("takes an opener-less tab opened within the window after the session's click, and no other", async () => {
      const { relay, source, clock } = setup();
      await source.materialize("s1", "https://flights.test/");

      relay.open({ id: 8, url: "https://stray.test/" });
      expect(source.candidates().find((tab) => tab.id === 8)?.sessionId).toBe(
        null
      );

      source.noteClick("s1");
      clock.now += 2_000;
      relay.open({ id: 9, url: "https://airline.test/" });
      expect(
        source.sessionTabs("s1").map((tab) => [tab.id, tab.current])
      ).toEqual([
        [100, false],
        [9, true],
      ]);

      clock.now += 3_001;
      relay.open({ id: 10, url: "https://late.test/" });
      expect(source.candidates().find((tab) => tab.id === 10)?.sessionId).toBe(
        null
      );
    });

    it("switches and closes on request, and only the session's own tabs", async () => {
      const { relay, source } = setup();
      await source.materialize("s1", "https://a.test/");
      relay.open({ id: 7, url: "https://b.test/", openerTabId: 100 });

      expect(await source.activateTab("s1", 100)).toBe(true);
      expect(
        pickBrowserTarget(source.candidates(), { id: 7, url: null }, "s1")
      ).toBe(100);
      expect(await source.activateTab("s2", 7)).toBe(false);
      expect(await source.closeTab("s2", 7)).toBe(false);
      expect(relay.closeTab).not.toHaveBeenCalled();

      expect(await source.closeTab("s1", 7)).toBe(true);
      expect(relay.closeTab).toHaveBeenCalledWith(7);
      expect(source.sessionTabs("s1").map((tab) => tab.id)).toEqual([100]);
    });

    it("keeps at most six tabs, closing the oldest off the active tab's opener chain", async () => {
      const { relay, source } = setup();
      await source.materialize("s1", "https://0.test/");
      // 100 opens 1, which opens 2; 3..5 come from 100 too.
      relay.open({ id: 1, url: "https://1.test/", openerTabId: 100 });
      relay.open({ id: 2, url: "https://2.test/", openerTabId: 1 });
      for (const id of [3, 4, 5])
        relay.open({ id, url: `https://${id}.test/`, openerTabId: 100 });
      expect(relay.closeTab).not.toHaveBeenCalled();
      // The seventh opens from 2, so 100 → 1 → 2 → 6 is the chain to keep.
      await source.activateTab("s1", 2);
      relay.open({ id: 6, url: "https://6.test/", openerTabId: 2 });

      await vi.waitFor(() => expect(relay.closeTab).toHaveBeenCalledWith(3));
      expect(source.sessionTabs("s1").map((tab) => tab.id)).toEqual([
        100, 1, 2, 4, 5, 6,
      ]);
    });

    it("closes every tab of a session that ended, and nobody else's", async () => {
      const { relay, source } = setup();
      await source.materialize("s1", "https://a.test/");
      relay.open({ id: 7, url: "https://b.test/", openerTabId: 100 });
      await source.materialize("s2", "https://c.test/");

      await source.closeSession("s1");

      expect(
        relay.closeTab.mock.calls.map(([id]) => id).sort((a, b) => a - b)
      ).toEqual([7, 100]);
      expect(source.sessionTabs("s2").map((tab) => tab.id)).toEqual([101]);
    });

    it("reads the live origin of a tab and of its frames", async () => {
      const { relay, source } = setup();
      await source.materialize("s1", "https://shop.test/cart");
      relay.cdp.mockImplementation(async (_tabId: number, method: string) => {
        if (method === "Runtime.evaluate")
          return { result: { value: "https://shop.test" } };
        if (method === "Page.getFrameTree")
          return {
            frameTree: {
              frame: { id: "main", url: "https://shop.test/cart" },
              childFrames: [
                { frame: { id: "pay", url: "https://pay.test/card?x=1" } },
              ],
            },
          };
        return {};
      });

      expect(await source.tabs.origin(100)).toBe("https://shop.test");
      expect(await source.tabs.origin(100, "pay")).toBe("https://pay.test");
      expect(await source.tabs.origin(100, "gone")).toBeNull();
    });
  });

  describe("secret fields", () => {
    it("locks scripts on a tab holding a filled field until its main frame navigates", async () => {
      const { relay, source } = setup();
      await source.materialize("s1", "https://shop.test/login");
      const secrets = source.secrets(100)!;
      relay.cdp.mockImplementation(async (_tabId: number, method: string) =>
        method === "Runtime.evaluate" ? { result: { value: true } } : {}
      );

      expect(secrets.executeRefusal()).toBeNull();
      expect(
        await secrets.markFilled(source.webContents(100)!, "#password")
      ).toBe(true);
      expect(secrets.executeRefusal()).toContain("cannot run");

      // A frame inside the page navigating is not the page leaving.
      relay.emit("cdpEvent", 100, "Page.frameNavigated", {
        frame: { id: "ad", parentId: "main", url: "https://ads.test/" },
      });
      expect(secrets.executeRefusal()).not.toBeNull();
      relay.emit("cdpEvent", 100, "Page.frameNavigated", {
        frame: { id: "main", url: "https://shop.test/account" },
      });
      expect(secrets.executeRefusal()).toBeNull();
    });

    it("captures only with the fields hidden, covers cross-origin frames once one is filled, and shows them again", async () => {
      const { relay, source } = setup();
      await source.materialize("s1", "https://shop.test/pay");
      const expressions: string[] = [];
      relay.cdp.mockImplementation(
        async (_tabId: number, method: string, params?: unknown) => {
          if (method === "Runtime.evaluate") {
            expressions.push(
              String((params as { expression?: string }).expression)
            );
            return { result: { value: true } };
          }
          if (method === "Page.captureScreenshot")
            return { data: Buffer.from("jpeg").toString("base64") };
          return {};
        }
      );

      expect(await source.captureMasked(100)).toEqual({
        data: Buffer.from("jpeg").toString("base64"),
        mimeType: "image/jpeg",
      });
      const masks = expressions.filter((e) => e.includes("data-abacusai-mask"));
      expect(masks[0]).toContain("input[type=password]");
      expect(masks[0]).toContain("if (!false) continue;");
      // Shown again after.
      expect(masks.at(-1)).toContain(".remove()");

      await source.secrets(100)!.markFilled(source.webContents(100)!, "#card");
      expressions.length = 0;
      await source.captureMasked(100);
      expect(
        expressions.find((e) => e.includes("data-abacusai-mask"))
      ).toContain("if (!true) continue;");
    });

    it("takes no screenshot when the fields cannot be hidden", async () => {
      const { relay, source } = setup();
      await source.materialize("s1", "https://shop.test/pay");
      relay.cdp.mockImplementation(async (_tabId: number, method: string) => {
        if (method === "Runtime.evaluate")
          return { exceptionDetails: { text: "blocked" } };
        if (method === "Page.captureScreenshot")
          return { data: Buffer.from("jpeg").toString("base64") };
        return {};
      });

      expect(await source.captureMasked(100)).toBeNull();
      expect(relay.cdp).not.toHaveBeenCalledWith(
        100,
        "Page.captureScreenshot",
        expect.anything()
      );
    });
  });

  it("has nothing to make when Chrome is not connected", async () => {
    const { relay, source } = setup();
    relay.connected = false;
    expect(await source.materialize("s1", "https://x.test/")).toBeNull();
  });
});

describe("the hosted computer's own Chromium", () => {
  /** A Chromium on the CDP pipe: answers what the driver asks, raises what a tab does. */
  const fakeChromium = () => {
    const toBrowser = new PassThrough();
    const fromBrowser = new PassThrough();
    const child = Object.assign(new EventEmitter(), {
      stdio: [null, null, null, toBrowser, fromBrowser],
      kill: vi.fn(),
    });
    const sent: Array<{ method: string; sessionId?: string }> = [];
    const raise = (message: Record<string, unknown>) =>
      fromBrowser.write(`${JSON.stringify(message)}\0`);
    let buffer = "";
    toBrowser.setEncoding("utf8");
    toBrowser.on("data", (chunk: string) => {
      buffer += chunk;
      for (
        let end = buffer.indexOf("\0");
        end !== -1;
        end = buffer.indexOf("\0")
      ) {
        const message = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        sent.push(message);
        const result =
          message.method === "Target.createTarget"
            ? { targetId: "T1" }
            : message.method === "Target.attachToTarget"
              ? {
                  sessionId: String(message.params.targetId).replace(/^T/, "S"),
                }
              : {};
        raise({ id: message.id, result });
      }
    });
    return {
      child,
      sent,
      raise,
      spawn: vi.fn((_command: string, _args: string[]) => child),
    };
  };

  it("launches headless, gives each session a tab, and drops it when it closes", async () => {
    const { CdpBrowser, hostedChromiumArgs } =
      await import("./hosted-chromium");
    const chromium = fakeChromium();
    const args = hostedChromiumArgs("/p", true);
    const browser = new CdpBrowser({
      executable: "/opt/chromium/chrome",
      args,
      spawn: chromium.spawn as never,
    });
    const source = new ChromeTargetSource(browser);
    await browser.launch();

    expect(chromium.spawn.mock.calls[0]?.[1]).toEqual(args);
    expect(args).toEqual(
      expect.arrayContaining(["--headless=new", "--user-data-dir=/p"])
    );
    const id = await source.materialize("session-1", "https://example.test/");
    expect(id).not.toBeNull();
    expect(source.candidates()).toEqual([
      expect.objectContaining({ id, sessionId: "session-1" }),
    ]);
    // Commands for the tab go on its session; its events come back as the tab's.
    expect(chromium.sent).toContainEqual(
      expect.objectContaining({ method: "Page.enable", sessionId: "S1" })
    );
    const page = source.webContents(id!)!;
    chromium.raise({
      method: "Page.frameNavigated",
      sessionId: "S1",
      params: { frame: { id: "F", url: "https://example.test/next" } },
    });
    await vi.waitFor(() =>
      expect(page.getURL()).toBe("https://example.test/next")
    );

    chromium.raise({
      method: "Target.targetDestroyed",
      params: { targetId: "T1" },
    });
    await vi.waitFor(() => expect(source.candidates()).toEqual([]));
    expect(page.isDestroyed()).toBe(true);

    chromium.child.emit("exit", 0);
    expect(browser.connected).toBe(false);
  });

  const launched = async () => {
    const { CdpBrowser } = await import("./hosted-chromium");
    const chromium = fakeChromium();
    const browser = new CdpBrowser({
      executable: "/opt/chromium/chrome",
      args: [],
      spawn: chromium.spawn as never,
    });
    const source = new ChromeTargetSource(browser);
    await browser.launch();
    const id = (await source.materialize(
      "session-1",
      "https://flights.test/"
    ))!;
    return { chromium, browser, source, id };
  };

  it("drives the tab a page opens, brought to the front, and its opener again once it closes", async () => {
    const { chromium, source, id } = await launched();
    // Each tab's cross-origin frames are attached on its own session.
    expect(chromium.sent).toContainEqual(
      expect.objectContaining({
        method: "Target.setAutoAttach",
        sessionId: "S1",
        params: expect.objectContaining({ autoAttach: true, flatten: true }),
      })
    );

    chromium.raise({
      method: "Target.targetCreated",
      params: {
        targetInfo: {
          targetId: "POP",
          type: "page",
          url: "https://airline.test/book",
          openerId: "T1",
        },
      },
    });

    await vi.waitFor(() =>
      expect(source.sessionTabs("session-1")).toEqual([
        expect.objectContaining({ id, current: false }),
        expect.objectContaining({ current: true, openerId: id }),
      ])
    );
    const popup = source.sessionTabs("session-1")[1]!.id;
    expect(
      pickBrowserTarget(source.candidates(), { id, url: null }, "session-1")
    ).toBe(popup);
    expect(chromium.sent).toContainEqual(
      expect.objectContaining({
        method: "Target.activateTarget",
        params: { targetId: "POP" },
      })
    );

    chromium.raise({
      method: "Target.targetDestroyed",
      params: { targetId: "POP" },
    });
    await vi.waitFor(() =>
      expect(
        pickBrowserTarget(
          source.candidates(),
          { id: popup, url: null },
          "session-1"
        )
      ).toBe(id)
    );
  });

  it("attaches an opener-less page and gives it to the session that just clicked", async () => {
    const { chromium, source } = await launched();
    source.noteClick("session-1");

    chromium.raise({
      method: "Target.targetCreated",
      params: {
        targetInfo: { targetId: "NOOPENER", type: "page", url: "" },
      },
    });

    await vi.waitFor(() =>
      expect(source.sessionTabs("session-1")).toHaveLength(2)
    );
    expect(chromium.sent).toContainEqual(
      expect.objectContaining({
        method: "Target.attachToTarget",
        params: expect.objectContaining({ targetId: "NOOPENER" }),
      })
    );
  });

  it("knows a cross-origin frame's live origin from its own attach", async () => {
    const { chromium, source, id } = await launched();

    chromium.raise({
      method: "Target.attachedToTarget",
      sessionId: "S1",
      params: {
        sessionId: "FRAME-SESSION",
        targetInfo: {
          targetId: "CARD",
          type: "iframe",
          url: "https://pay.test/card",
        },
      },
    });
    await vi.waitFor(async () =>
      expect(await source.tabs.origin(id, "CARD")).toBe("https://pay.test")
    );

    chromium.raise({
      method: "Target.targetInfoChanged",
      params: {
        targetInfo: {
          targetId: "CARD",
          type: "iframe",
          url: "https://other-pay.test/card",
        },
      },
    });
    await vi.waitFor(async () =>
      expect(await source.tabs.origin(id, "CARD")).toBe(
        "https://other-pay.test"
      )
    );
  });

  it("turns off saved passwords and autofill in the profile, keeping its other preferences", async () => {
    const { writeHostedChromiumPrefs } = await import("./hosted-chromium");
    const profile = mkdtempSync(path.join(os.tmpdir(), "hosted-profile-"));
    mkdirSync(path.join(profile, "Default"));
    writeFileSync(
      path.join(profile, "Default/Preferences"),
      JSON.stringify({ homepage: "x", profile: { name: "Me" } })
    );

    writeHostedChromiumPrefs(profile);

    const prefs = JSON.parse(
      readFileSync(path.join(profile, "Default/Preferences"), "utf8")
    );
    expect(prefs).toMatchObject({
      homepage: "x",
      credentials_enable_service: false,
      profile: { name: "Me", password_manager_enabled: false },
      autofill: {
        enabled: false,
        profile_enabled: false,
        credit_card_enabled: false,
      },
    });
    rmSync(profile, { recursive: true, force: true });
  });

  it("finds Playwright's Chromium in its cache, the full browser ahead of the shell", async () => {
    const { chromiumInCache } = await import("./hosted-chromium");
    const root = mkdtempSync(path.join(os.tmpdir(), "ms-playwright-"));
    const touch = (relative: string) => {
      mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
      writeFileSync(path.join(root, relative), "");
    };
    expect(chromiumInCache([root])).toBeNull();
    touch(
      "chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell"
    );
    expect(chromiumInCache([root])).toContain("chrome-headless-shell");
    touch("chromium-1200/chrome-linux64/chrome");
    touch("chromium-1243/chrome-linux64/chrome");
    expect(chromiumInCache([root])).toBe(
      path.join(root, "chromium-1243/chrome-linux64/chrome")
    );
  });

  describe("the launcher", () => {
    const profile = () => mkdtempSync(path.join(os.tmpdir(), "chromium-"));
    const launcherWith = async (
      options: Partial<
        ConstructorParameters<
          typeof import("./hosted-chromium").HostedChromiumLauncher
        >[0]
      > = {}
    ) => {
      const { HostedChromiumLauncher } = await import("./hosted-chromium");
      const chromium = fakeChromium();
      const lines: string[] = [];
      const launcher = new HostedChromiumLauncher({
        userDataDir: profile,
        hosted: () => false,
        isRoot: () => false,
        env: {},
        find: async () => "/found/chrome",
        spawn: chromium.spawn as never,
        log: (line) => lines.push(line),
        ...options,
      });
      return { launcher, chromium, lines };
    };

    it("takes the path from ABACUSAI_BOT_CHROMIUM at once, with no lookup, and says so", async () => {
      const executable = path.join(profile(), "chrome");
      writeFileSync(executable, "");
      const find = vi.fn(async () => "/found/chrome");
      const { launcher, chromium, lines } = await launcherWith({
        env: { ABACUSAI_BOT_CHROMIUM: executable },
        find,
      });

      expect(launcher.found).toBe(true);
      expect((await launcher.launch()).ok).toBe(true);
      expect(await launcher.prepare()).toBe(true);
      expect(chromium.spawn.mock.calls[0]?.[0]).toBe(executable);
      expect(find).not.toHaveBeenCalled();
      expect(lines).toContain(
        `[browser] Chromium from ABACUSAI_BOT_CHROMIUM: ${executable}`
      );
    });

    it("looks up once at start, then in the background with backoff; launch never looks", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        const find = vi
          .fn<() => Promise<string | null>>()
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce(null)
          .mockResolvedValue("/found/chrome");
        const { launcher, chromium } = await launcherWith({ find });

        expect(await launcher.prepare()).toBe(false);
        const missed = await launcher.launch();
        expect("error" in missed && missed.error.code).toBe("not-found");
        expect(find).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(30_000);
        expect(find).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(59_999);
        expect(find).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(1);
        expect(find).toHaveBeenCalledTimes(3);
        expect(launcher.found).toBe(true);

        expect((await launcher.launch()).ok).toBe(true);
        expect(chromium.spawn.mock.calls[0]?.[0]).toBe("/found/chrome");
        await vi.advanceTimersByTimeAsync(20 * 60_000);
        expect(find).toHaveBeenCalledTimes(3);
      } finally {
        vi.useRealTimers();
      }
    });

    it("stops looking once disposed", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        const find = vi.fn(async () => null);
        const { launcher } = await launcherWith({ find });
        await launcher.prepare();
        launcher.dispose();
        await vi.advanceTimersByTimeAsync(20 * 60_000);
        expect(find).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("drops the sandbox only as root or on the hosted computer", async () => {
      for (const [isRoot, hosted, noSandbox] of [
        [false, false, false],
        [true, false, true],
        [false, true, true],
      ] as const) {
        const { launcher, chromium } = await launcherWith({
          isRoot: () => isRoot,
          hosted: () => hosted,
        });
        await launcher.prepare();
        await launcher.launch();
        expect(chromium.spawn.mock.calls[0]?.[1].includes("--no-sandbox")).toBe(
          noSandbox
        );
      }
    });

    describe("the profile lock", () => {
      /** The lock is a dangling symlink, so `existsSync` cannot see it. */
      const locked = (lock: string) => {
        try {
          lstatSync(lock);
          return true;
        } catch {
          return false;
        }
      };
      /** A profile whose SingletonLock names this host and a pid that is alive. */
      const lockedProfile = () => {
        const dir = profile();
        const lock = path.join(dir, "SingletonLock");
        symlinkSync(`${os.hostname()}-${process.pid}`, lock);
        return { dir, lock };
      };
      const launchOn = async (
        dir: string,
        options: Parameters<typeof launcherWith>[0] = {}
      ) => {
        const delay = vi.fn(async () => {});
        const made = await launcherWith({
          userDataDir: () => dir,
          delay,
          ...options,
        });
        await made.launcher.prepare();
        return { ...made, delay, launched: await made.launcher.launch() };
      };

      it("blocks on a live Chromium on this profile, after one retry", async () => {
        const { dir, lock } = lockedProfile();
        const readCmdline = vi.fn(() => [
          "/opt/chromium/chrome",
          "--headless=new",
          `--user-data-dir=${dir}`,
        ]);

        const { launched, chromium, delay } = await launchOn(dir, {
          readCmdline,
        });

        expect("error" in launched && launched.error.code).toBe(
          "profile-in-use"
        );
        expect(delay).toHaveBeenCalledOnce();
        expect(delay).toHaveBeenCalledWith(2_000);
        expect(readCmdline).toHaveBeenCalledTimes(2);
        expect(chromium.spawn).not.toHaveBeenCalled();
        expect(locked(lock)).toBe(true);
      });

      it("launches when the retry finds the profile free", async () => {
        const { dir, lock } = lockedProfile();
        const delay = vi.fn(async () => rmSync(lock));
        const { launched } = await launchOn(dir, {
          readCmdline: () => ["/opt/chromium/chrome", `--user-data-dir=${dir}`],
          delay,
        });
        expect(launched.ok).toBe(true);
        expect(delay).toHaveBeenCalledOnce();
      });

      it("clears a recycled pid's lock: alive, but not a Chromium on this profile", async () => {
        for (const argv of [
          ["/usr/bin/node", "server.js"],
          ["/opt/chromium/chrome", "--user-data-dir=/elsewhere"],
        ]) {
          const { dir, lock } = lockedProfile();
          const { launched, delay } = await launchOn(dir, {
            readCmdline: () => argv,
          });
          expect(launched.ok).toBe(true);
          expect(delay).not.toHaveBeenCalled();
          expect(locked(lock)).toBe(false);
        }
      });

      it("clears a dead owner's lock", async () => {
        const dir = profile();
        const lock = path.join(dir, "SingletonLock");
        symlinkSync(`${os.hostname()}-999999999`, lock);
        const { launched } = await launchOn(dir);
        expect(launched.ok).toBe(true);
        expect(locked(lock)).toBe(false);
      });

      it("without /proc, holds to a lock made since this process started and clears an older one", async () => {
        const { dir, lock } = lockedProfile();
        const held = await launchOn(dir, {
          readCmdline: () => undefined,
          processStart: () => Date.now() - 60_000,
        });
        expect("error" in held.launched && held.launched.error.code).toBe(
          "profile-in-use"
        );
        expect(locked(lock)).toBe(true);

        const stale = await launchOn(dir, {
          readCmdline: () => undefined,
          processStart: () => Date.now() + 60_000,
        });
        expect(stale.launched.ok).toBe(true);
        expect(locked(lock)).toBe(false);
      });
    });

    it("reports a failed launch as its typed error, the raw cause only in the log", async () => {
      const { HostedChromiumLaunchError, HostedChromiumService } =
        await import("./hosted-chromium");
      const { launcher, chromium, lines } = await launcherWith();
      chromium.spawn.mockImplementation(() => {
        throw new Error("spawn /found/chrome EACCES secret-detail");
      });
      const service = new HostedChromiumService(launcher);
      await service.prepare();

      const failure = await service
        .targetSource()
        .materialize("s1", "https://x.test/")
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(HostedChromiumLaunchError);
      expect(
        (failure as InstanceType<typeof HostedChromiumLaunchError>).code
      ).toBe("launch-failed");
      expect((failure as Error).message).not.toContain("secret-detail");
      expect(lines.some((line) => line.includes("secret-detail"))).toBe(true);
    });
  });
});
