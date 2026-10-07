/**
 * The hosted computer's browser: a headless Chromium the app launches and
 * drives over CDP on a pipe. It serves the same browser tools the desktop's
 * own view does, through the tab pages the user's-Chrome engine uses.
 *
 * - `HostedChromiumLauncher` owns the executable path, the sandbox decision,
 *   the profile lock and launch failures (a typed result, never raw text).
 * - `CdpBrowser` is one running Chromium as a tab driver.
 * - `HostedChromiumService` is what the browser tools see: launch on first use.
 */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  rmSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Readable, Writable } from "node:stream";

import type { BrowserTargetSource } from "../browser-target";
import type { ChromeRelayEvents, ChromeTabInfo } from "./chrome-relay";
import { ChromeTargetSource } from "./chrome-target-source";

/** Names the Chromium to use; without it the Playwright lookup below runs. */
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

/** One launched Chromium as the tab driver `ChromeTargetSource` reads. */
export class CdpBrowser extends EventEmitter<ChromeRelayEvents> {
  private child: ChildProcess | null = null;
  private input: Writable | null = null;
  private nextId = 0;
  private nextTabId = 0;
  private readonly pending = new Map<number, Pending>();
  private readonly tabs = new Map<number, Tab>();
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
    const { targetId } = (await this.send("Target.createTarget", {
      url,
    })) as { targetId: string };
    return this.attachTarget(targetId, url);
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
    const { sessionId } = (await this.send("Target.attachToTarget", {
      targetId,
      flatten: true,
    })) as { sessionId: string };
    const tab: Tab = {
      id: ++this.nextTabId,
      url,
      targetId,
      sessionId,
      ...(openerTabId != null ? { openerTabId } : {}),
    };
    this.tabs.set(tab.id, tab);
    this.emit("tabAttached", tab);
    return tab;
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
      if (tab != null && message.method != null)
        this.emit("cdpEvent", tab.id, message.method, params);
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
        // A popup one of ours opened joins the tabs, as the relay's do.
        const opener =
          info?.openerId == null
            ? undefined
            : this.tabWhere((tab) => tab.targetId === info.openerId);
        if (info?.type === "page" && info.targetId != null && opener != null)
          void this.attachTarget(
            info.targetId,
            info.url ?? "",
            opener.id
          ).catch(() => undefined);
        return;
      }
      case "Target.targetInfoChanged": {
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
        if (tab == null) return;
        this.tabs.delete(tab.id);
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
const SINGLETON_FILES = ["SingletonLock", "SingletonSocket", "SingletonCookie"];

const isPidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

/**
 * The profile lock is Chromium's own SingletonLock, a `host-pid` symlink: a
 * live owner here keeps the profile; a dead one, or another host's, is cleared.
 */
const claimChromiumProfile = (userDataDir: string): boolean => {
  let owner: string;
  try {
    owner = readlinkSync(path.join(userDataDir, "SingletonLock"));
  } catch {
    return true;
  }
  const match = /^(.+)-(\d+)$/.exec(owner);
  if (match?.[1] === os.hostname() && isPidAlive(Number(match[2])))
    return false;
  for (const name of SINGLETON_FILES)
    rmSync(path.join(userDataDir, name), { force: true });
  return true;
};

type LauncherOptions = {
  userDataDir: () => string;
  /** The hosted computer, which is itself the sandbox. */
  hosted: () => boolean;
  env?: NodeJS.ProcessEnv;
  find?: (env: NodeJS.ProcessEnv) => Promise<string | null>;
  isRoot?: () => boolean;
  spawn?: typeof spawn;
  log?: (line: string) => void;
  launchTimeoutMs?: number;
};

/** Finds and launches the Chromium; every failure is a typed result. */
export class HostedChromiumLauncher {
  private executable: string | null = null;
  private resolving: Promise<string | null> | null = null;

  constructor(private readonly options: LauncherOptions) {}

  get found(): boolean {
    return this.executable != null;
  }

  /** The executable: resolved once, and looked up again on each call while none was found. */
  resolve(): Promise<string | null> {
    if (this.executable != null) return Promise.resolve(this.executable);
    this.resolving ??= this.lookUp().finally(() => {
      this.resolving = null;
    });
    return this.resolving;
  }

  /** Chromium refuses its sandbox as root; on the hosted computer it adds nothing. */
  sandboxed(): boolean {
    const isRoot = this.options.isRoot ?? (() => process.getuid?.() === 0);
    return !(isRoot() || this.options.hosted());
  }

  async launch(): Promise<HostedChromiumLaunch> {
    const executable = await this.resolve();
    if (executable == null) return this.failure("not-found");
    const userDataDir = this.options.userDataDir();
    let browser: CdpBrowser | null = null;
    try {
      mkdirSync(userDataDir, { recursive: true });
      if (!claimChromiumProfile(userDataDir)) {
        this.log(`[browser] ${userDataDir} is held by a live Chromium`);
        return this.failure("profile-in-use");
      }
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

  private async lookUp(): Promise<string | null> {
    const env = this.options.env ?? process.env;
    const configured = env[HOSTED_CHROMIUM_ENV];
    if (configured != null && configured.length > 0) {
      if (existsSync(configured)) {
        this.log(
          `[browser] Chromium from ${HOSTED_CHROMIUM_ENV}: ${configured}`
        );
        this.executable = configured;
        return configured;
      }
      this.log(
        `[browser] ${HOSTED_CHROMIUM_ENV} is not a file (${configured}); looking elsewhere`
      );
    }
    const found = await (this.options.find ?? findHostedChromium)(env).catch(
      () => null
    );
    this.log(
      found == null
        ? "[browser] no Chromium found; the built-in browser is off for now"
        : `[browser] Chromium from the Playwright lookup: ${found}`
    );
    this.executable = found;
    return found;
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

  /** True once there is a Chromium; looks again while there is none. */
  async ready(): Promise<boolean> {
    return (await this.launcher.resolve()) != null;
  }

  available(): boolean {
    return this.launcher.found;
  }

  targetSource(): BrowserTargetSource {
    return {
      presentsInApp: false,
      candidates: () => this.source?.candidates() ?? [],
      webContents: (id) => this.source?.webContents(id) ?? null,
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
    this.browser?.close();
    this.browser = null;
    this.source = null;
  }
}
