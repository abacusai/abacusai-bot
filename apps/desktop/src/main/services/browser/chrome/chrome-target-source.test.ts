/**
 * Chrome's tabs as the browser tools' target source: a session gets its own
 * tab, the user's picked tab belongs to nobody, and tabs that leave the group
 * stop being offered.
 */
import { EventEmitter } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
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
  cdp = vi.fn(async (_tabId: number, method: string) =>
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
    return tab;
  }
  /** What the extension does when the user allows a tab. */
  allow(tab: ChromeTabInfo) {
    this.tabs.set(tab.id, tab);
    this.attached.add(tab.id);
  }
}

const setup = () => {
  const relay = new FakeRelay();
  const source = new ChromeTargetSource(relay as unknown as ChromeRelay);
  return { relay, source };
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
      },
    ]);
    expect(source.tabsOf("s1")).toEqual([100]);
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
    expect(source.tabsOf("s1")).toEqual([]);
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
              ? { sessionId: "S1" }
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

    it("takes the path from ABACUSAI_BOT_CHROMIUM over the lookup, and says so", async () => {
      const executable = path.join(profile(), "chrome");
      writeFileSync(executable, "");
      const find = vi.fn(async () => "/found/chrome");
      const { launcher, chromium, lines } = await launcherWith({
        env: { ABACUSAI_BOT_CHROMIUM: executable },
        find,
      });

      expect(await launcher.resolve()).toBe(executable);
      expect((await launcher.launch()).ok).toBe(true);
      expect(chromium.spawn.mock.calls[0]?.[0]).toBe(executable);
      expect(find).not.toHaveBeenCalled();
      expect(lines).toContain(
        `[browser] Chromium from ABACUSAI_BOT_CHROMIUM: ${executable}`
      );
    });

    it("looks again on the next use when the start lookup found nothing", async () => {
      const find = vi
        .fn<() => Promise<string | null>>()
        .mockResolvedValueOnce(null)
        .mockResolvedValue("/found/chrome");
      const { launcher, chromium } = await launcherWith({ find });

      expect(await launcher.resolve()).toBeNull();
      expect(launcher.found).toBe(false);
      expect(find).toHaveBeenCalledTimes(1);

      expect((await launcher.launch()).ok).toBe(true);
      expect(chromium.spawn.mock.calls[0]?.[0]).toBe("/found/chrome");
      await launcher.resolve();
      expect(find).toHaveBeenCalledTimes(2);
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
        await launcher.launch();
        expect(chromium.spawn.mock.calls[0]?.[1].includes("--no-sandbox")).toBe(
          noSandbox
        );
      }
    });

    it("never launches on a profile a live Chromium holds, and clears a dead one's lock", async () => {
      const dir = profile();
      const lock = path.join(dir, "SingletonLock");
      symlinkSync(`${os.hostname()}-${process.pid}`, lock);
      const live = await launcherWith({ userDataDir: () => dir });

      const held = await live.launcher.launch();
      expect(held.ok).toBe(false);
      expect("error" in held && held.error.code).toBe("profile-in-use");
      expect(live.chromium.spawn).not.toHaveBeenCalled();

      rmSync(lock);
      symlinkSync(`${os.hostname()}-999999999`, lock);
      const stale = await launcherWith({ userDataDir: () => dir });
      expect((await stale.launcher.launch()).ok).toBe(true);
      expect(existsSync(lock)).toBe(false);
    });

    it("reports a failed launch as its typed error, the raw cause only in the log", async () => {
      const { HostedChromiumLaunchError, HostedChromiumService } =
        await import("./hosted-chromium");
      const { launcher, chromium, lines } = await launcherWith();
      chromium.spawn.mockImplementation(() => {
        throw new Error("spawn /found/chrome EACCES secret-detail");
      });
      const service = new HostedChromiumService(launcher);
      await service.ready();

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
