/**
 * The Electron acceptance harness the chat gates share (spec 02 §13, the
 * foundation's R1-T11b pattern): the real app from `dist/` built with
 * `VITE_UI_GALLERY=1` (dev hooks, no fixture tables), an isolated profile,
 * the dev mutation harness over a private file, and CDP on the renderer-next page.
 *
 * Without a display or a usable build a suite skips locally, and fails loudly
 * where it is required (`CI`, or `ABACUSBOT_REQUIRE_ELECTRON_SUITES=1`); a
 * required run builds `dist/` itself when it is missing or a fixture build.
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { harnessAvailability } from "../services/browser/browser-snapshot-harness";

export const DESKTOP = resolve(import.meta.dirname, "../../..");
export const REPO = resolve(DESKTOP, "../..");
const FIXTURE_MARKER = "renderer-next fixture-db: dev fixture tables";

export const REQUIRED =
  process.env.ABACUSBOT_REQUIRE_ELECTRON_SUITES === "1" ||
  (process.env.CI != null && process.env.CI !== "" && process.env.CI !== "0");

const assets = (): string[] => {
  const dir = join(DESKTOP, "dist/renderer/assets");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".js"))
    .map((name) => readFileSync(join(dir, name), "utf8"));
};

/** "ok", or why the current dist/ cannot serve an acceptance run. */
const buildState = (): string => {
  if (!existsSync(join(DESKTOP, "dist/renderer/index-next.html")))
    return "no renderer-next build";
  if (!existsSync(join(DESKTOP, "dist/main/index.js"))) return "no main build";
  const sources = assets();
  if (!sources.some((source) => source.includes("__abacusDev")))
    return "the build has no dev hooks (VITE_UI_GALLERY=1 missing)";
  if (sources.some((source) => source.includes(FIXTURE_MARKER)))
    return "a fixture build (VITE_NEXT_DB_FIXTURES=1)";
  if (!sources.some((source) => source.includes("__chatBench")))
    return "the build predates the chat bench";
  return "ok";
};

export interface Readiness {
  runnable: boolean;
  skipReason: string;
  /** Builds dist/ when required and unusable; throws when that fails. */
  prepare(): void;
}

export const readiness = (): Readiness => {
  const availability = harnessAvailability();
  let state = buildState();
  const buildable = REQUIRED && availability.usable;
  return {
    runnable: availability.usable && (state === "ok" || buildable),
    skipReason: !availability.usable
      ? `no display: ${availability.reason ?? "unavailable"}`
      : `dist/ unusable: ${state}`,
    prepare: () => {
      if (state === "ok") return;
      execFileSync(
        process.execPath,
        [
          join(
            dirname(
              createRequire(import.meta.url).resolve("vite/package.json")
            ),
            "bin/vite.js"
          ),
          "build",
        ],
        {
          cwd: DESKTOP,
          stdio: "inherit",
          env: {
            ...process.env,
            // Vitest sets NODE_ENV=test; acceptance must measure the shipped React build.
            NODE_ENV: "production",
            VITE_UI_GALLERY: "1",
            VITE_NEXT_DB_FIXTURES: "",
          },
        }
      );
      state = buildState();
      if (state !== "ok")
        throw new Error(`acceptance build unusable: ${state}`);
    },
  };
};

export const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface App {
  readonly scratch: string;
  readonly home: string;
  readonly output: string[];
  send(method: string, params?: object): Promise<any>;
  /** Evaluates in the renderer-next page, awaiting promises, by value. */
  evaluate<T>(expression: string): Promise<T>;
  until(expression: string, timeoutMs?: number, what?: string): Promise<void>;
  /** A dev mutation harness op (`src/main/dev/mutation-harness.ts`). */
  harness(op: string, input: object): void;
  /** CDP events of this method, as they arrive. */
  on(method: string, listener: (params: any) => void): () => void;
  close(): Promise<void>;
}

/**
 * Starts the app with an isolated home and user data. `prepareHome` writes
 * into the home before launch (a provider config, say). Background
 * throttling is off so rAF-driven measurements hold with the window behind
 * another one.
 */
export const launch = async (options: {
  port: number;
  env?: Record<string, string>;
  prepareHome?: (home: string) => void;
}): Promise<App> => {
  const scratch = mkdtempSync(join(tmpdir(), "chat-accept-"));
  const home = join(scratch, "home");
  const harnessFile = join(scratch, "harness.jsonl");
  writeFileSync(harnessFile, "");
  mkdirSync(home, { recursive: true });
  options.prepareHome?.(home);
  const electron = createRequire(import.meta.url)(
    "electron"
  ) as unknown as string;
  const output: string[] = [];
  const child: ChildProcess = spawn(
    electron,
    [
      ".",
      `--remote-debugging-port=${options.port}`,
      "--disable-renderer-backgrounding",
      "--disable-backgrounding-occluded-windows",
      "--disable-background-timer-throttling",
    ],
    {
      cwd: DESKTOP,
      env: {
        ...process.env,
        ABACUSAI_BOT_HOME: home,
        ABACUSAI_BOT_USERDATA: join(scratch, "ud"),
        ABACUSBOT_RENDERER_GENERATION: "wco",
        ABACUSBOT_DEV_CONTENT_SIZE: "1280x800",
        ABACUSBOT_DEV_HARNESS: "1",
        ABACUSBOT_DEV_HARNESS_FILE: harnessFile,
        ...options.env,
      },
      stdio: ["pipe", "pipe", "pipe"],
    }
  );
  child.stdout?.on("data", (chunk) => output.push(String(chunk)));
  child.stderr?.on("data", (chunk) => output.push(String(chunk)));
  const close = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = new Promise<void>((resolve) =>
        child.once("close", () => resolve())
      );
      child.kill("SIGKILL");
      await closed;
    }
    rmSync(scratch, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  };

  let url: string | null = null;
  for (let i = 0; i < 120 && url == null; i += 1) {
    try {
      const targets = (await (
        await fetch(`http://127.0.0.1:${options.port}/json`)
      ).json()) as Array<{
        type: string;
        url: string;
        webSocketDebuggerUrl: string;
      }>;
      url =
        targets.find((t) => t.type === "page" && t.url.includes("index-next"))
          ?.webSocketDebuggerUrl ?? null;
    } catch {
      // not yet
    }
    if (url == null) await sleep(500);
  }
  if (url == null) {
    await close();
    throw new Error(
      `renderer-next page never appeared\n${output.join("").slice(-4000)}`
    );
  }
  const ws = new WebSocket(url);
  await new Promise((r) => (ws.onopen = r));
  let id = 0;
  const pending = new Map<number, (value: any) => void>();
  const listeners = new Map<string, Set<(params: any) => void>>();
  ws.onmessage = (event) => {
    const message = JSON.parse(String(event.data));
    if (message.method != null) {
      for (const listener of listeners.get(message.method) ?? [])
        listener(message.params);
      return;
    }
    pending.get(message.id)?.(message.result ?? message);
    pending.delete(message.id);
  };
  const send = (method: string, params: object = {}) =>
    new Promise<any>((r) => {
      id += 1;
      pending.set(id, r);
      ws.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async <T>(expression: string): Promise<T> => {
    const result = await send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails)
      throw new Error(JSON.stringify(result.exceptionDetails).slice(0, 2000));
    return result.result?.value as T;
  };
  const until = async (
    expression: string,
    timeoutMs = 10_000,
    what = expression
  ): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        if (await evaluate<boolean>(expression)) return;
      } catch {
        // The document may be reloading.
      }
      await sleep(100);
    }
    throw new Error(`timed out waiting for ${what}`);
  };
  await send("Page.enable");
  // Keep frame-driven acceptance tests active when their window is occluded.
  await send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await send("Runtime.enable");
  await until("typeof window.__abacusDev === 'object'", 30_000, "dev hooks");
  return {
    scratch,
    home,
    output,
    send,
    evaluate,
    until,
    harness: (op, input) =>
      appendFileSync(harnessFile, `${JSON.stringify({ op, input })}\n`),
    on: (method, listener) => {
      const set = listeners.get(method) ?? new Set();
      set.add(listener);
      listeners.set(method, set);
      return () => set.delete(listener);
    },
    close: async () => {
      ws.close();
      await close();
    },
  };
};

/** Writes a file under the app home before launch. */
export const writeHomeFile = (home: string, name: string, text: string) => {
  writeFileSync(join(home, name), text);
};

/** Median and p95 of a list of numbers. */
export const stats = (values: readonly number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) =>
    sorted.length === 0
      ? Number.NaN
      : sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
  return { median: at(0.5), p95: at(0.95), max: sorted.at(-1) ?? Number.NaN };
};
