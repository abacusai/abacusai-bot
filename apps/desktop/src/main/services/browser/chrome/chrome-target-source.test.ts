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
