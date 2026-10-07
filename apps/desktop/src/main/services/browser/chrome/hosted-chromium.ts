/**
 * The hosted computer's browser: a headless Chromium the app launches and
 * drives over CDP on a pipe. It serves the same browser tools the desktop's
 * own view does, through the tab pages the user's-Chrome engine uses.
 *
 * - `HostedChromiumLauncher` owns the executable path (and its background
 *   lookup), the sandbox decision and launch failures (typed, never raw text).
 * - `ChromiumProfileLock` decides whether the profile's owner is still live.
 * - `CdpBrowser` is one running Chromium as a tab driver.
 * - `HostedChromiumService` is what the browser tools see: launch on first use.
 */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Readable, Writable } from "node:stream";

import type { BrowserTargetSource } from "../browser-target";
import type { ChromeRelayEvents, ChromeTabInfo } from "./chrome-relay";
import { ChromeTargetSource, tabMethodsOf } from "./chrome-target-source";

/** Names the Chromium to use, read at once; without it the Playwright lookup below runs. */
const HOSTED_CHROMIUM_ENV = "ABACUSAI_BOT_CHROMIUM";

const PYTHON_LOOKUP_TIMEOUT_MS = 20_000;
const PYTHON_LOOKUP = [
  "from playwright.sync_api import sync_playwright",
  "with sync_playwright() as p: print(p.chromium.executable_path)",
].join("\n");

/** Where Playwright keeps browsers: the env override, then its Linux cache. */
const playwrightCacheRoots = (env: NodeJS.ProcessEnv): string[] =>
  [
    env.PLAYWRIGHT_BROWSERS_PATH,
    path.join(os.homedir(), ".cache", "ms-playwright"),
  ].filter((root): root is string => root != null && root.length > 1);

/** Playwright's Chromium builds by cache folder prefix, full browser first. */
const CACHED_CHROMIUM = [
  {
    prefix: "chromium-",
    binaries: ["chrome-linux64/chrome", "chrome-linux/chrome"],
  },
  {
    prefix: "chromium_headless_shell-",
    binaries: [
      "chrome-headless-shell-linux64/chrome-headless-shell",
      "chrome-linux/headless_shell",
    ],
  },
];

/** The newest Chromium in a Playwright browser cache, if any. */
export function chromiumInCache(roots: readonly string[]): string | null {
  for (const { prefix, binaries } of CACHED_CHROMIUM)
    for (const root of roots) {
      let names: string[];
      try {
        names = readdirSync(root);
      } catch {
        continue;
      }
      const revisions = names
        .filter((name) => name.startsWith(prefix))
        .map((name) => ({ name, rev: Number(name.slice(prefix.length)) }))
        .filter(({ rev }) => Number.isInteger(rev))
        .sort((a, b) => b.rev - a.rev);
      for (const { name } of revisions)
        for (const binary of binaries) {
          const candidate = path.join(root, name, binary);
          if (existsSync(candidate)) return candidate;
        }
    }
  return null;
}

const pythonChromium = (): Promise<string | null> =>
  new Promise((resolve) => {
    execFile(
      "python3",
      ["-c", PYTHON_LOOKUP],
      { timeout: PYTHON_LOOKUP_TIMEOUT_MS },
      (error, stdout) => {
        const found = error == null ? stdout.trim() : "";
        resolve(found.length > 0 && existsSync(found) ? found : null);
      }
    );
  });

/** The Chromium Python Playwright launches, or null when there is none. */
export async function findHostedChromium(
  env: NodeJS.ProcessEnv = process.env
): Promise<string | null> {
  return (await pythonChromium()) ?? chromiumInCache(playwrightCacheRoots(env));
}

/** Launch flags: headless, software GL, the CDP pipe, and the profile. */
export const hostedChromiumArgs = (
  userDataDir: string,
  sandboxed: boolean
): string[] => [
  "--headless=new",
  ...(sandboxed ? [] : ["--no-sandbox"]),
  "--use-gl=swiftshader",
  "--enable-unsafe-swiftshader",
  "--remote-debugging-pipe",
  `--user-data-dir=${userDataDir}`,
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-dev-shm-usage",
  "--window-size=1280,900",
  "about:blank",
];

/**
 * Profile preferences that keep what the browser fills off disk: no saved
 * passwords, no saved addresses or cards. Chromium reads them at start.
 */
const PROFILE_PREFS: Record<string, Record<string, unknown> | boolean> = {
  credentials_enable_service: false,
  credentials_enable_autosignin: false,
  profile: { password_manager_enabled: false },
  autofill: {
    enabled: false,
    profile_enabled: false,
    credit_card_enabled: false,
  },
};

/** Writes `PROFILE_PREFS` into the profile's preferences, keeping the rest. */
export function writeHostedChromiumPrefs(userDataDir: string): void {
  const dir = path.join(userDataDir, "Default");
  const file = path.join(dir, "Preferences");
  let prefs: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (parsed != null && typeof parsed === "object")
      prefs = parsed as Record<string, unknown>;
  } catch {
    // None yet, or unreadable: Chromium writes the rest on start.
  }
  for (const [key, value] of Object.entries(PROFILE_PREFS)) {
    const existing = prefs[key];
    prefs[key] =
      typeof value === "object" &&
      existing != null &&
      typeof existing === "object"
        ? { ...(existing as Record<string, unknown>), ...value }
        : value;
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, JSON.stringify(prefs));
}

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

type Tab = ChromeTabInfo & { targetId: string; sessionId: string };

type CdpMessage = {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { message?: string };
  sessionId?: string;
};

/** A cross-origin frame inside a tab, attached on its own session. */
type Frame = { tabId: number; sessionId: string; url: string };

/** Auto-attach for a page or frame session: its cross-origin frames, flattened. */
const AUTO_ATTACH = {
  autoAttach: true,
  waitForDebuggerOnStart: false,
  flatten: true,
};

/**
 * One launched Chromium as the tab driver `ChromeTargetSource` reads. Every
 * page the browser opens after launch is attached (a popup with its opener),
 * so `BrowserTabs` can decide whose it is; each tab's cross-origin frames
 * (a payment provider's card fields) are attached too, for their origins.
 */
export class CdpBrowser extends EventEmitter<ChromeRelayEvents> {
  private child: ChildProcess | null = null;
  private input: Writable | null = null;
  private nextId = 0;
  private nextTabId = 0;
  private readonly pending = new Map<number, Pending>();
  private readonly tabs = new Map<number, Tab>();
  /** Cross-origin frames by target id, which is the frame's id. */
  private readonly frames = new Map<string, Frame>();
  /** Targets on their way to being attached, so none is attached twice. */
  private readonly attaching = new Set<string>();
  /** Pages `createTab` is making; their own attach follows. */
  private creating = 0;
  /** Pages that opened while one was being made, attached once it is. */
  private deferred: Array<{
    targetId: string;
    url: string;
    openerId?: string;
  }> = [];
  /** Pages from before launch (the start page) are not tabs anyone opened. */
  private launched = false;
  private readonly preexisting = new Set<string>();
  private buffer = "";
  private open = false;

  constructor(
    private readonly options: {
      executable: string;
      args: string[];
      spawn?: typeof spawn;
    }
  ) {
    super();
  }

  get connected(): boolean {
    return this.open;
  }

  async launch(): Promise<void> {
    const child = (this.options.spawn ?? spawn)(
      this.options.executable,
      this.options.args,
      { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] }
    );
    this.child = child;
    this.input = child.stdio[3] as Writable;
    const output = child.stdio[4] as Readable;
    output.setEncoding("utf8");
    output.on("data", (chunk: string) => this.onData(chunk));
    child.once("exit", (code) => this.onClose(`exited (${code ?? "signal"})`));
    child.once("error", (error) => this.onClose(error.message));
    this.open = true;
    await this.send("Target.setDiscoverTargets", { discover: true });
    const { targetInfos } = (await this.send("Target.getTargets", {})) as {
      targetInfos?: Array<{ targetId?: string }>;
    };
    for (const info of targetInfos ?? [])
      if (info.targetId != null) this.preexisting.add(info.targetId);
    this.launched = true;
  }

  attachedTabs(): ChromeTabInfo[] {
    return [...this.tabs.values()];
  }

  tab(tabId: number): ChromeTabInfo | undefined {
    return this.tabs.get(tabId);
  }

  isAttached(tabId: number): boolean {
    return this.tabs.has(tabId);
  }

  async createTab(url: string): Promise<ChromeTabInfo> {
    this.creating += 1;
    let targetId: string;
    try {
      ({ targetId } = (await this.send("Target.createTarget", {
        url,
      })) as { targetId: string });
    } catch (error) {
      this.creating -= 1;
      this.attachDeferred(null);
      throw error;
    }
    this.creating -= 1;
    this.attachDeferred(targetId);
    return this.attachTarget(targetId, url);
  }

  /** The pages that opened while `createTab` ran, but for the one it made. */
  private attachDeferred(made: string | null): void {
    if (this.creating > 0) return;
    for (const page of this.deferred.splice(0))
      if (page.targetId !== made) this.attachPage(page);
  }

  /** A page opened since launch, attached with its opener if that is one of ours. */
  private attachPage(page: {
    targetId: string;
    url: string;
    openerId?: string;
  }): void {
    if (
      this.attaching.has(page.targetId) ||
      this.tabWhere((tab) => tab.targetId === page.targetId) != null
    )
      return;
    const opener =
      page.openerId == null
        ? undefined
        : this.tabWhere((tab) => tab.targetId === page.openerId);
    void this.attachTarget(page.targetId, page.url, opener?.id).catch(
      () => undefined
    );
  }

  async closeTab(tabId: number): Promise<void> {
    const tab = this.tabs.get(tabId);
    if (tab == null) return;
    await this.send("Target.closeTarget", { targetId: tab.targetId });
  }

  /** Brings the tab to the front: a background page may not paint or run its timers. */
  async activateTab(tabId: number): Promise<void> {
    const tab = this.tabs.get(tabId);
    if (tab == null) return;
    await this.send("Target.activateTarget", { targetId: tab.targetId });
    for (const other of this.tabs.values()) other.active = other === tab;
  }

  frameOrigin(tabId: number, frameId: string): string | null {
    const frame = this.frames.get(frameId);
    if (frame?.tabId !== tabId) return null;
    try {
      const origin = new URL(frame.url).origin;
      return origin === "null" ? null : origin;
    } catch {
      return null;
    }
  }

  cdp(
    tabId: number,
    method: string,
    params?: Record<string, unknown>
  ): Promise<unknown> {
    const tab = this.tabs.get(tabId);
    if (tab == null) return Promise.reject(new Error("the tab is gone"));
    return this.send(method, params ?? {}, tab.sessionId);
  }

  close(): void {
    this.child?.kill();
    this.onClose("closed");
  }

  private async attachTarget(
    targetId: string,
    url: string,
    openerTabId?: number
  ): Promise<Tab> {
    this.attaching.add(targetId);
    let sessionId: string;
    try {
      ({ sessionId } = (await this.send("Target.attachToTarget", {
        targetId,
        flatten: true,
      })) as { sessionId: string });
    } finally {
      this.attaching.delete(targetId);
    }
    const tab: Tab = {
      id: ++this.nextTabId,
      url,
      targetId,
      sessionId,
      ...(openerTabId != null ? { openerTabId } : {}),
    };
    this.tabs.set(tab.id, tab);
    void this.send("Target.setAutoAttach", AUTO_ATTACH, sessionId).catch(
      () => undefined
    );
    this.emit("tabAttached", tab);
    return tab;
  }

  /**
   * A page or frame session attached a child: a cross-origin frame is kept
   * (and its own frames attached); anything else (a worker) is left alone.
   */
  private onChildAttached(
    tabId: number,
    params: Record<string, unknown>
  ): void {
    const info = params.targetInfo as
      | { targetId?: string; type?: string; url?: string }
      | undefined;
    const sessionId = params.sessionId;
    if (
      info?.type !== "iframe" ||
      info.targetId == null ||
      typeof sessionId !== "string"
    )
      return;
    this.frames.set(info.targetId, { tabId, sessionId, url: info.url ?? "" });
    void this.send("Target.setAutoAttach", AUTO_ATTACH, sessionId).catch(
      () => undefined
    );
  }

  private dropFrames(match: (frame: Frame) => boolean): void {
    for (const [frameId, frame] of this.frames)
      if (match(frame)) this.frames.delete(frameId);
  }

  private tabWhere(match: (tab: Tab) => boolean): Tab | undefined {
    for (const tab of this.tabs.values()) if (match(tab)) return tab;
    return undefined;
  }

  private send(
    method: string,
    params: Record<string, unknown>,
    sessionId?: string
  ): Promise<unknown> {
    const input = this.input;
    if (!this.open || input == null)
      return Promise.reject(new Error("the browser is not running"));
    const id = ++this.nextId;
    const answered = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    input.write(
      `${JSON.stringify({ id, method, params, ...(sessionId != null ? { sessionId } : {}) })}\0`
    );
    return answered;
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let end = this.buffer.indexOf("\0");
    while (end !== -1) {
      const raw = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 1);
      end = this.buffer.indexOf("\0");
      let message: CdpMessage;
      try {
        message = JSON.parse(raw) as CdpMessage;
      } catch {
        continue;
      }
      this.onMessage(message);
    }
  }

  private onMessage(message: CdpMessage): void {
    if (message.id != null) {
      const pending = this.pending.get(message.id);
      if (pending == null) return;
      this.pending.delete(message.id);
      if (message.error != null)
        pending.reject(
          new Error(message.error.message ?? "the browser refused the command")
        );
      else pending.resolve(message.result);
      return;
    }
    const params = message.params ?? {};
    if (message.sessionId != null) {
      const tab = this.tabWhere((item) => item.sessionId === message.sessionId);
      const tabId =
        tab?.id ??
        [...this.frames.values()].find(
          (frame) => frame.sessionId === message.sessionId
        )?.tabId;
      if (tabId == null || message.method == null) return;
      if (message.method === "Target.attachedToTarget") {
        this.onChildAttached(tabId, params);
        return;
      }
      if (message.method === "Target.detachedFromTarget") {
        this.dropFrames((frame) => frame.sessionId === params.sessionId);
        return;
      }
      // A frame's own events are not the page's.
      if (tab != null) this.emit("cdpEvent", tab.id, message.method, params);
      return;
    }
    const info = params.targetInfo as
      | {
          targetId?: string;
          type?: string;
          url?: string;
          title?: string;
          openerId?: string;
        }
      | undefined;
    switch (message.method) {
      case "Target.targetCreated": {
        // A page opened since launch joins the tabs, with its opener if it is
        // one of ours; `BrowserTabs` decides whose it is. Pages `createTab`
        // makes are attached there.
        if (info?.type !== "page" || info.targetId == null) return;
        if (!this.launched) this.preexisting.add(info.targetId);
        if (this.preexisting.has(info.targetId)) return;
        const page = {
          targetId: info.targetId,
          url: info.url ?? "",
          ...(info.openerId != null ? { openerId: info.openerId } : {}),
        };
        if (this.creating > 0) this.deferred.push(page);
        else this.attachPage(page);
        return;
      }
      case "Target.targetInfoChanged": {
        const frame =
          info?.targetId == null ? undefined : this.frames.get(info.targetId);
        if (frame != null && info?.url != null) frame.url = info.url;
        const tab = this.tabWhere((item) => item.targetId === info?.targetId);
        if (tab == null) return;
        if (info?.url != null) tab.url = info.url;
        if (info?.title != null) tab.title = info.title;
        return;
      }
      case "Target.targetDestroyed":
      case "Target.detachedFromTarget": {
        const tab = this.tabWhere(
          (item) =>
            item.targetId === params.targetId ||
            item.sessionId === params.sessionId
        );
        if (tab == null) {
          if (typeof params.targetId === "string")
            this.frames.delete(params.targetId);
          return;
        }
        this.tabs.delete(tab.id);
        this.dropFrames((frame) => frame.tabId === tab.id);
        this.emit("tabDetached", tab.id);
        this.emit("tabRemoved", tab.id);
        return;
      }
      default:
        return;
    }
  }

  private onClose(reason: string): void {
    if (!this.open) return;
    this.open = false;
    this.child = null;
    this.input = null;
    for (const pending of this.pending.values())
      pending.reject(new Error(`the browser ${reason}`));
    this.pending.clear();
    const tabs = [...this.tabs.keys()];
    this.tabs.clear();
    this.frames.clear();
    for (const tabId of tabs) this.emit("tabDetached", tabId);
    this.emit("disconnected", reason);
  }
}

export type HostedChromiumFailure =
  | "not-found"
  | "profile-in-use"
  | "launch-failed";

/** What the model sees for each failure: stable and generic; details go to the log. */
const FAILURE_MESSAGES: Record<HostedChromiumFailure, string> = {
  "not-found": "No browser is available on this computer.",
  "profile-in-use":
    "The browser profile is in use by another browser. Try again shortly.",
  "launch-failed": "The browser could not start.",
};

export class HostedChromiumLaunchError extends Error {
  constructor(readonly code: HostedChromiumFailure) {
    super(FAILURE_MESSAGES[code]);
    this.name = "HostedChromiumLaunchError";
  }
}

export type HostedChromiumLaunch =
  | { ok: true; browser: CdpBrowser }
  | { ok: false; error: HostedChromiumLaunchError };

const LAUNCH_TIMEOUT_MS = 30_000;
const PROFILE_RETRY_MS = 2_000;
const LOOKUP_RETRY_FIRST_MS = 30_000;
const LOOKUP_RETRY_MAX_MS = 10 * 60_000;
const SINGLETON_FILES = ["SingletonLock", "SingletonSocket", "SingletonCookie"];

/** A process's argv from /proc: `undefined` where /proc is unavailable, null when the pid has none. */
export type ProcCmdline = (pid: number) => string[] | null | undefined;

const readProcCmdline: ProcCmdline = (pid) => {
  if (!existsSync("/proc/self/cmdline")) return undefined;
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8")
      .split("\0")
      .filter((arg) => arg.length > 0);
  } catch {
    return null;
  }
};

const isPidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

type ProfileLockOptions = {
  readCmdline?: ProcCmdline;
  /** When this process started, in epoch ms. */
  processStart?: () => number;
};

/**
 * Chromium's own SingletonLock, a `host-pid` symlink. Its owner counts as live
 * only if it is a Chromium on this profile, so a recycled pid never holds it.
 */
export class ChromiumProfileLock {
  private readonly lockPath: string;

  constructor(
    private readonly userDataDir: string,
    private readonly options: ProfileLockOptions = {}
  ) {
    this.lockPath = path.join(userDataDir, "SingletonLock");
  }

  /** True when the profile is free, clearing a stale owner's files first. */
  claim(): boolean {
    let owner: string;
    try {
      owner = readlinkSync(this.lockPath);
    } catch {
      return true;
    }
    if (this.ownerIsLive(owner)) return false;
    for (const name of SINGLETON_FILES)
      rmSync(path.join(this.userDataDir, name), { force: true });
    return true;
  }

  private ownerIsLive(owner: string): boolean {
    const match = /^(.+)-(\d+)$/.exec(owner);
    if (match?.[1] !== os.hostname()) return false;
    const pid = Number(match[2]);
    if (!isPidAlive(pid)) return false;
    const argv = (this.options.readCmdline ?? readProcCmdline)(pid);
    if (argv === undefined) return this.lockedSinceStart();
    if (argv == null || !(argv[0] ?? "").toLowerCase().includes("chrom"))
      return false;
    const profile = path.resolve(this.userDataDir);
    return argv.some(
      (arg) =>
        arg.startsWith("--user-data-dir=") &&
        path.resolve(arg.slice("--user-data-dir=".length)) === profile
    );
  }

  /** Without /proc: a lock made since this process started is a live one. */
  private lockedSinceStart(): boolean {
    const processStart =
      this.options.processStart ?? (() => Date.now() - process.uptime() * 1000);
    try {
      return lstatSync(this.lockPath).mtimeMs >= processStart();
    } catch {
      return false;
    }
  }
}

type LauncherOptions = ProfileLockOptions & {
  userDataDir: () => string;
  /** The hosted computer, which is itself the sandbox. */
  hosted: () => boolean;
  env?: NodeJS.ProcessEnv;
  find?: (env: NodeJS.ProcessEnv) => Promise<string | null>;
  isRoot?: () => boolean;
  spawn?: typeof spawn;
  log?: (line: string) => void;
  launchTimeoutMs?: number;
  /** Waits out a held profile before its one retry. */
  delay?: (ms: number) => Promise<void>;
};

/**
 * Finds and launches the Chromium; every failure is a typed result. The path
 * comes from the env var at once, else from one lookup at start, retried in
 * the background with backoff while it finds nothing.
 */
export class HostedChromiumLauncher {
  private executable: string | null;
  private lookup: Promise<boolean> | null = null;
  private retryMs = LOOKUP_RETRY_FIRST_MS;
  private retryTimer: NodeJS.Timeout | null = null;
  private disposed = false;

  constructor(private readonly options: LauncherOptions) {
    this.executable = this.configured();
  }

  get found(): boolean {
    return this.executable != null;
  }

  /** Starts the lookup once; resolves with whether the first one found a Chromium. */
  prepare(): Promise<boolean> {
    if (this.executable != null) return Promise.resolve(true);
    this.lookup ??= this.lookUp();
    return this.lookup;
  }

  /** Chromium refuses its sandbox as root; on the hosted computer it adds nothing. */
  sandboxed(): boolean {
    const isRoot = this.options.isRoot ?? (() => process.getuid?.() === 0);
    return !(isRoot() || this.options.hosted());
  }

  async launch(): Promise<HostedChromiumLaunch> {
    const executable = this.executable;
    if (executable == null) return this.failure("not-found");
    const userDataDir = this.options.userDataDir();
    let browser: CdpBrowser | null = null;
    try {
      mkdirSync(userDataDir, { recursive: true });
      if (!(await this.claimProfile(userDataDir)))
        return this.failure("profile-in-use");
      writeHostedChromiumPrefs(userDataDir);
      browser = new CdpBrowser({
        executable,
        args: hostedChromiumArgs(userDataDir, this.sandboxed()),
        ...(this.options.spawn != null ? { spawn: this.options.spawn } : {}),
      });
      await this.withinTimeout(browser.launch());
      return { ok: true, browser };
    } catch (error) {
      browser?.close();
      this.log(
        `[browser] launch failed: ${error instanceof Error ? error.message : String(error)}`
      );
      return this.failure("launch-failed");
    }
  }

  /** Stops the background lookup. */
  dispose(): void {
    this.disposed = true;
    if (this.retryTimer != null) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  /** A held profile gets one more look after a short wait, then is reported. */
  private async claimProfile(userDataDir: string): Promise<boolean> {
    const lock = new ChromiumProfileLock(userDataDir, this.options);
    if (lock.claim()) return true;
    this.log(`[browser] ${userDataDir} is held by a live Chromium; waiting`);
    const delay =
      this.options.delay ??
      ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
    await delay(PROFILE_RETRY_MS);
    if (lock.claim()) return true;
    this.log(`[browser] ${userDataDir} is still held`);
    return false;
  }

  private configured(): string | null {
    const configured = (this.options.env ?? process.env)[HOSTED_CHROMIUM_ENV];
    if (configured == null || configured.length === 0) return null;
    if (existsSync(configured)) {
      this.log(`[browser] Chromium from ${HOSTED_CHROMIUM_ENV}: ${configured}`);
      return configured;
    }
    this.log(
      `[browser] ${HOSTED_CHROMIUM_ENV} is not a file (${configured}); looking elsewhere`
    );
    return null;
  }

  private async lookUp(): Promise<boolean> {
    const found = await (this.options.find ?? findHostedChromium)(
      this.options.env ?? process.env
    ).catch(() => null);
    if (this.disposed) return false;
    if (found != null) {
      this.log(`[browser] Chromium from the Playwright lookup: ${found}`);
      this.executable = found;
      return true;
    }
    this.log(
      `[browser] no Chromium found; looking again in ${this.retryMs / 1000} s`
    );
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.lookUp();
    }, this.retryMs);
    this.retryTimer.unref();
    this.retryMs = Math.min(this.retryMs * 2, LOOKUP_RETRY_MAX_MS);
    return false;
  }

  private withinTimeout(launched: Promise<void>): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error("no answer on the CDP pipe")),
        this.options.launchTimeoutMs ?? LAUNCH_TIMEOUT_MS
      );
    });
    return Promise.race([launched, timeout]).finally(() => clearTimeout(timer));
  }

  private failure(code: HostedChromiumFailure): HostedChromiumLaunch {
    return { ok: false, error: new HostedChromiumLaunchError(code) };
  }

  private log(line: string): void {
    (this.options.log ?? console.log)(line);
  }
}

/**
 * The hosted browser for the browser tools: launched on first use and again
 * after it exits. Without a Chromium it is simply unavailable.
 */
export class HostedChromiumService {
  private browser: CdpBrowser | null = null;
  private source: ChromeTargetSource | null = null;
  private launching: Promise<ChromeTargetSource> | null = null;

  constructor(private readonly launcher: HostedChromiumLauncher) {}

  /** Host start: finds the Chromium, then keeps looking in the background while there is none. */
  prepare(): Promise<boolean> {
    return this.launcher.prepare();
  }

  /** Sync and cached: never starts a lookup. */
  available(): boolean {
    return this.launcher.found;
  }

  targetSource(): BrowserTargetSource {
    return {
      presentsInApp: false,
      candidates: () => this.source?.candidates() ?? [],
      webContents: (id) => this.source?.webContents(id) ?? null,
      ...tabMethodsOf(() => this.source),
      materialize: async (sessionId, url) =>
        (await this.start()).materialize(sessionId, url),
    };
  }

  private start(): Promise<ChromeTargetSource> {
    if (this.browser?.connected === true && this.source != null)
      return Promise.resolve(this.source);
    this.launching ??= this.launch().finally(() => {
      this.launching = null;
    });
    return this.launching;
  }

  private async launch(): Promise<ChromeTargetSource> {
    const launched = await this.launcher.launch();
    if ("error" in launched) throw launched.error;
    this.browser = launched.browser;
    this.source = new ChromeTargetSource(launched.browser);
    return this.source;
  }

  dispose(): void {
    this.launcher.dispose();
    this.browser?.close();
    this.browser = null;
    this.source = null;
  }
}
