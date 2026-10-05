/**
 * The Electron main process for A-T12 (rpc-handshake.electron.test.ts),
 * bundled by that test and run in a real Electron. It mounts the real router
 * (over fake services) on the real MessagePort transport, loads a page whose
 * preload runs the real handshake and whose script uses the real renderer
 * Transport, then drives reloads and a renderer swap and writes what it saw.
 *
 * Environment: RPC_E2E_RESULT (the JSON file to write), RPC_E2E_PAGE,
 * RPC_E2E_PRELOAD, RPC_E2E_MODE ("normal" | "delayed"; the delayed run also
 * sets ABACUS_TEST_HANDSHAKE_DELAY_MS for the preload).
 */
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { app, BaseWindow, ipcMain, type WebContents } from "electron";

import { RendererHost } from "../../renderer-host";
import { MainEventBus } from "../event-bus";
import { RendererReadiness } from "../readiness";
import { createRouter } from "../router";
import { fakeDeps } from "../testing";
import { installMessagePortTransport } from "./message-port";

type PageReport = { ok: boolean; [key: string]: unknown };

const env = (name: string): string => {
  const value = process.env[name];
  if (value == null) throw new Error(`${name} is not set`);
  return value;
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Where the run is, for RPC_E2E_DEBUG=1 and for the watchdog's report. */
let step = "starting";
const at = (next: string): void => {
  step = next;
  if (process.env.RPC_E2E_DEBUG === "1") console.log(`[e2e] ${next}`);
};

/** Poll `probe` until it returns non-null, or fail after `timeoutMs`. */
const until = async <T>(
  what: string,
  probe: () => Promise<T | null> | T | null,
  timeoutMs = 15_000
): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value != null) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
};

const pageReport = (contents: WebContents): Promise<PageReport> =>
  until("the page's report", async () => {
    if (contents.isDestroyed()) return null;
    return (await contents.executeJavaScript(
      "window.__rpc ?? null"
    )) as PageReport | null;
  });

const run = async (): Promise<Record<string, unknown>> => {
  const mode = env("RPC_E2E_MODE");
  const bus = new MainEventBus();
  const readiness = new RendererReadiness();
  let host: RendererHost | null = null;

  const deps = fakeDeps({
    bus,
    app: {
      appVersion: () => "e2e",
      homeDir: () => "/home",
      botHome: () => "/home/.abacusai-bot",
    },
    host: { sessionHomePath: () => "/home/AbacusAI" },
    serviceHost: { getMetadata: () => ({ materialIconsBasePath: null }) },
    windows: {
      mainRendererId: () => host?.webContents.id ?? null,
      reportReady: (id, report) => readiness.report(id, report),
      state: () => ({ fullScreen: false, focused: false, maximized: false }),
    },
  });
  // The device-build tracker's listener; each page adds one iterator.
  const baseline = bus.listenerCount();
  const transport = installMessagePortTransport({
    ipcMain,
    router: createRouter(),
    deps,
    readiness,
  });

  const window = new BaseWindow({ show: false, width: 480, height: 320 });
  host = new RendererHost({
    backgroundColor: "#000000",
    webPreferences: {
      preload: env("RPC_E2E_PRELOAD"),
      sandbox: false,
      contextIsolation: true,
    },
    window,
    wire: (contents) => transport.registerRendererContents(contents, "main"),
    readiness,
  });
  const pageUrl = pathToFileURL(env("RPC_E2E_PAGE")).href;
  const state = () => ({
    ports: transport.livePorts(),
    iterators: bus.listenerCount() - baseline,
  });
  /** Iterators end asynchronously after their port closes. */
  const settled = (iterators: number) =>
    until(`${iterators} live iterator(s)`, () => {
      const now = state();
      return now.iterators === iterators ? now : null;
    }).catch(() => state());

  at("loading the page");
  await host.webContents.loadURL(pageUrl);

  if (mode === "delayed") {
    await sleep(1_000);
    const whileWaiting = state();
    at("waiting for the page to give up");
    const page = await pageReport(host.webContents);
    // The preload hands the page its port at 6 s; the page, timed out at
    // 5 s, closes it on arrival, which closes main's end.
    await sleep(2_500);
    return { mode, whileWaiting, page, afterLatePort: state() };
  }

  at("waiting for the first load's report");
  const firstLoad = {
    page: await pageReport(host.webContents),
    ...(await settled(1)),
  };

  const reloads: unknown[] = [];
  for (let i = 0; i < 5; i += 1) {
    at(`reload ${i + 1}`);
    const contents = host.webContents;
    const loaded = new Promise<void>((resolve) => {
      contents.once("did-finish-load", () => resolve());
    });
    contents.reload();
    await loaded;
    const page = await pageReport(contents);
    reloads.push({ page, ...(await settled(1)) });
  }

  at("swapping");
  const before = host.webContents;
  const swapped = await host.swap(new URL(pageUrl), {
    barrier: "subscriptions",
  });
  at("after the swap");
  // The old view's contents close asynchronously after the flip.
  const oldDestroyed = await until("the old renderer to close", () =>
    before.isDestroyed() ? true : null
  ).catch(() => false);
  const afterSwap = {
    swapped,
    replaced: host.webContents !== before,
    oldDestroyed,
    page: await pageReport(host.webContents),
    ...(await settled(1)),
  };

  return { mode, firstLoad, reloads, afterSwap };
};

// A hang is a failure with a place, never a test timeout with none.
const watchdog = setTimeout(() => {
  writeFileSync(
    env("RPC_E2E_RESULT"),
    JSON.stringify({ error: `watchdog: stuck at "${step}"` })
  );
  app.exit(2);
}, 75_000);

app.whenReady().then(async () => {
  let result: Record<string, unknown>;
  try {
    result = await run();
  } catch (error) {
    result = {
      error: `${step}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
    };
  }
  clearTimeout(watchdog);
  writeFileSync(env("RPC_E2E_RESULT"), JSON.stringify(result, null, 2));
  app.exit(0);
});
