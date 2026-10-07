/**
 * The hosted computer's browser: the Chromium its Python Playwright install
 * brought, launched headless by the app and driven over CDP on a pipe. It
 * serves the same browser tools the desktop's own view does, through the tab
 * pages the user's-Chrome engine uses.
 */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Readable, Writable } from "node:stream";

import type { BrowserTargetSource } from "../browser-target";
import type { ChromeRelayEvents, ChromeTabInfo } from "./chrome-relay";
import { ChromeTargetSource } from "./chrome-target-source";

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

/** Launch flags: headless, no sandbox (the computer is the sandbox), software GL. */
export const hostedChromiumArgs = (userDataDir: string): string[] => [
  "--headless=new",
  "--no-sandbox",
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
      userDataDir: string;
      spawn?: typeof spawn;
    }
  ) {
    super();
  }

  get connected(): boolean {
    return this.open;
  }

  async launch(): Promise<void> {
    mkdirSync(this.options.userDataDir, { recursive: true });
    const child = (this.options.spawn ?? spawn)(
      this.options.executable,
      hostedChromiumArgs(this.options.userDataDir),
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

/**
 * The hosted browser for the browser tools: found once, launched on first
 * use and again after it exits. Without a Chromium it is simply unavailable.
 */
export class HostedChromiumService {
  private lookup: Promise<string | null> | null = null;
  private executable: string | null = null;
  private browser: CdpBrowser | null = null;
  private source: ChromeTargetSource | null = null;
  private launching: Promise<ChromeTargetSource> | null = null;

  constructor(
    private readonly options: {
      userDataDir: () => string;
      find?: () => Promise<string | null>;
      spawn?: typeof spawn;
      log?: (line: string) => void;
    }
  ) {}

  /** Looks for the executable once; true when there is one. */
  async ready(): Promise<boolean> {
    this.lookup ??= (this.options.find ?? findHostedChromium)()
      .catch(() => null)
      .then((found) => {
        this.executable = found;
        (this.options.log ?? console.log)(
          found == null
            ? "[browser] no Chromium found; the built-in browser is off"
            : `[browser] built-in browser: ${found}`
        );
        return found;
      });
    return (await this.lookup) != null;
  }

  available(): boolean {
    return this.executable != null;
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
    const executable = this.executable;
    if (executable == null) throw new Error("No browser on this computer.");
    const browser = new CdpBrowser({
      executable,
      userDataDir: this.options.userDataDir(),
      ...(this.options.spawn != null ? { spawn: this.options.spawn } : {}),
    });
    const source = new ChromeTargetSource(browser);
    await browser.launch();
    this.browser = browser;
    this.source = source;
    return source;
  }

  dispose(): void {
    this.browser?.close();
    this.browser = null;
    this.source = null;
  }
}
