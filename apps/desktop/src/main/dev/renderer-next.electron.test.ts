/**
 * The renderer-next acceptance suite in the real Electron app (spec 01 §12),
 * against main's real `db.*` tables, never the dev fixtures:
 *
 * - R1-T11b: route-level view transitions are the router's document
 *   transition. Each started transition is observed on its own: its types,
 *   and whether tokens.css animated the pane (`app-pane`) and the sidebar
 *   (`app-sidebar`) groups. Typed navigations (rail, Settings in/out,
 *   nav-forward into a bot, browser back, a loader slower than the pending
 *   threshold) start exactly one; untyped commits (masked pop-up, search
 *   change) start none; never two transitions at once.
 * - R1-T23 live data: a bot created through the dev mutation harness (the
 *   legacy service path) appears in the renderer's sidebar; a theme written
 *   from the renderer reaches main's nativeTheme.
 * - R1-T22: main drops the renderer's port: before any reconnection the
 *   renderer stops its collection syncs and shows the connection-lost
 *   notification, then reloads exactly once (counted from CDP navigations)
 *   and reconnects; a second loss within 10 s shows the error screen.
 *
 * Runs `dist/` built with `VITE_UI_GALLERY=1` (no fixtures; the suite builds
 * it when missing or when it finds a fixture build). Without a display or a
 * build it skips locally, and fails loudly where the suite is required
 * (`CI`, or `ABACUSBOT_REQUIRE_ELECTRON_SUITES=1`).
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { harnessAvailability } from "../services/browser/browser-snapshot-harness";

const DESKTOP = resolve(import.meta.dirname, "../../..");
const PORT = 9393;
const FIXTURE_MARKER = "renderer-next fixture-db: dev fixture tables";
/** `shell.connectionLost` in the bundled English copy. */
const CONNECTION_LOST = (
  JSON.parse(
    readFileSync(join(DESKTOP, "src/renderer/locales/en-US.json"), "utf8")
  ) as { shell: { connectionLost: string } }
).shell.connectionLost;
const REQUIRED =
  process.env.ABACUSBOT_REQUIRE_ELECTRON_SUITES === "1" ||
  (process.env.CI != null && process.env.CI !== "" && process.env.CI !== "0");

const assets = (): string[] => {
  const dir = join(DESKTOP, "dist/renderer/assets");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".js"))
    .map((name) => readFileSync(join(dir, name), "utf8"));
};

/** "ok", or why the current dist/ cannot serve the acceptance run. */
const buildState = (): string => {
  if (!existsSync(join(DESKTOP, "dist/renderer/index-next.html")))
    return "no renderer-next build";
  if (!existsSync(join(DESKTOP, "dist/main/index.js"))) return "no main build";
  const sources = assets();
  if (!sources.some((source) => source.includes("__abacusDev")))
    return "the build has no dev hooks (VITE_UI_GALLERY=1 missing)";
  if (sources.some((source) => source.includes(FIXTURE_MARKER)))
    return "a fixture build (VITE_NEXT_DB_FIXTURES=1)";
  return "ok";
};

const availability = harnessAvailability();
let state = buildState();
const buildable = REQUIRED && availability.usable;
const runnable = availability.usable && (state === "ok" || buildable);
const skipReason = !availability.usable
  ? `no display: ${availability.reason ?? "unavailable"}`
  : `dist/ unusable: ${state}`;

let child: ChildProcess | null = null;
let scratch = "";
let send: (method: string, params?: object) => Promise<any> = async () => null;
const output: string[] = [];
/** Top-frame document navigations (CDP `Page.frameNavigated`), in order. */
const navigations: Array<{ url: string; at: number }> = [];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const evaluate = async <T>(expression: string): Promise<T> => {
  const result = await send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails)
    throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value as T;
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

const harness = (op: string, input: object): void => {
  appendFileSync(
    join(scratch, "harness.jsonl"),
    `${JSON.stringify({ op, input })}\n`
  );
};

/**
 * Wraps `document.startViewTransition` (after the app's own single-transition
 * guard) and records each transition separately: types, and the pseudo
 * elements tokens.css animated once it was ready.
 */
const RECORDER = `(() => {
  if (window.__vtRecorder) return;
  window.__vtRecorder = true;
  window.__vt = [];
  const start = document.startViewTransition.bind(document);
  document.startViewTransition = (arg) => {
    const entry = {
      types: arg && arg.types ? [...arg.types] : [],
      pane: false,
      sidebar: false,
      animated: [],
      done: false,
    };
    window.__vt.push(entry);
    const transition = start(arg);
    transition.ready.then(() => {
      const ours = document.getAnimations().filter((a) =>
        String(a.animationName || "").startsWith("vt-")
      );
      entry.animated = ours.map((a) => String(a.effect && a.effect.pseudoElement));
      entry.pane = entry.animated.some((p) => p.includes("app-pane"));
      entry.sidebar = entry.animated.some((p) => p.includes("app-sidebar"));
    }).catch((error) => { entry.error = String(error); });
    transition.finished.finally(() => { entry.done = true; });
    return transition;
  };
})()`;

type Recorded = {
  types: string[];
  pane: boolean;
  sidebar: boolean;
  animated: string[];
  done: boolean;
  error?: string;
};

const booted = () => until("typeof window.__abacusDev === 'object'", 30_000);

const go = (href: string) =>
  evaluate(`window.__abacusDev.navigateAndSettle(${JSON.stringify(href)})`);

/**
 * The transitions since the last call, once the router is idle and every
 * one has finished (checked twice, a frame apart, so a commit that starts
 * right after a URL change is not missed).
 */
const transitions = async (timeoutMs = 5_000): Promise<Recorded[]> => {
  const quiet = "window.__abacusDev.idle() && window.__vt.every((t) => t.done)";
  await sleep(50);
  try {
    await until(quiet, timeoutMs, "router idle, transitions done");
  } catch (error) {
    console.error(
      "RENDERER_SETTLE",
      await evaluate(
        "({idle: window.__abacusDev.idle(), href: location.href, transitions: window.__vt})"
      )
    );
    throw error;
  }
  await sleep(100);
  await until(quiet, 5_000, "router idle, transitions done");
  return evaluate<Recorded[]>("window.__vt.splice(0)");
};

const click = (selector: string) =>
  evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);

beforeAll(async () => {
  if (!runnable) return;
  if (state !== "ok") {
    // Required and wrong or missing: make the acceptance build (no fixtures).
    execFileSync(
      process.execPath,
      [
        join(
          dirname(createRequire(import.meta.url).resolve("vite/package.json")),
          "bin/vite.js"
        ),
        "build",
      ],
      {
        cwd: DESKTOP,
        stdio: "inherit",
        env: {
          ...process.env,
          NODE_ENV: "production",
          VITE_UI_GALLERY: "1",
          VITE_NEXT_DB_FIXTURES: "",
        },
      }
    );
    state = buildState();
    if (state !== "ok") throw new Error(`acceptance build unusable: ${state}`);
  }
  scratch = mkdtempSync(join(tmpdir(), "renderer-next-accept-"));
  const harnessFile = join(scratch, "harness.jsonl");
  writeFileSync(harnessFile, "");
  mkdirSync(join(scratch, "home"), { recursive: true });
  writeFileSync(
    join(scratch, "home", "account.json"),
    JSON.stringify({ account: null, apps: [], onboarded: true })
  );
  const electron = createRequire(import.meta.url)(
    "electron"
  ) as unknown as string;
  child = spawn(
    electron,
    [
      ".",
      `--remote-debugging-port=${PORT}`,
      "--disable-renderer-backgrounding",
      "--disable-backgrounding-occluded-windows",
      "--disable-background-timer-throttling",
    ],
    {
      cwd: DESKTOP,
      env: {
        ...process.env,
        ABACUSAI_BOT_HOME: join(scratch, "home"),
        ABACUSAI_BOT_USERDATA: join(scratch, "ud"),
        ABACUSBOT_RENDERER_GENERATION: "wco",
        ABACUSBOT_DEV_CONTENT_SIZE: "1280x800",
        ABACUSBOT_DEV_HARNESS: "1",
        ABACUSBOT_DEV_HARNESS_FILE: harnessFile,
      },
      stdio: ["pipe", "pipe", "pipe"],
    }
  );
  child.stdout?.on("data", (chunk) => output.push(String(chunk)));
  child.stderr?.on("data", (chunk) => output.push(String(chunk)));
  let url: string | null = null;
  for (let i = 0; i < 120 && url == null; i += 1) {
    try {
      const targets = (await (
        await fetch(`http://127.0.0.1:${PORT}/json`)
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
  if (url == null) throw new Error("renderer-next page never appeared");
  const ws = new WebSocket(url);
  await new Promise((r) => (ws.onopen = r));
  let id = 0;
  const pending = new Map<number, (value: any) => void>();
  ws.onmessage = (event) => {
    const message = JSON.parse(String(event.data));
    if (
      message.method === "Page.frameNavigated" &&
      message.params?.frame?.parentId == null
    ) {
      navigations.push({ url: message.params.frame.url, at: Date.now() });
      return;
    }
    if (!Number.isSafeInteger(message.id) || message.id < 1 || message.id > id)
      return;
    for (const [requestId, resolve] of pending) {
      if (requestId !== message.id) continue;
      resolve(message.result ?? message);
      pending.delete(requestId);
      break;
    }
  };
  send = (method, params = {}) =>
    new Promise((r) => {
      id += 1;
      pending.set(id, r);
      ws.send(JSON.stringify({ id, method, params }));
    });
  await send("Page.enable");
  // Exercise frame-driven transitions even when the desktop occludes this window.
  await send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await booted();
  await evaluate(RECORDER);
}, 600_000);

afterAll(async () => {
  if (child != null && child.exitCode === null && child.signalCode === null) {
    const closed = new Promise<void>((resolve) =>
      child!.once("close", () => resolve())
    );
    child.kill("SIGKILL");
    await closed;
  }
  if (scratch !== "")
    rmSync(scratch, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
});

if (!runnable && REQUIRED)
  describe("renderer-next acceptance (Electron)", () => {
    it("has what it needs to run", () => {
      throw new Error(
        `required (CI / ABACUSBOT_REQUIRE_ELECTRON_SUITES) but cannot run: ${skipReason}`
      );
    });
  });

describe.skipIf(!runnable)("renderer-next acceptance (Electron)", () => {
  it("reads main's real db.*, not the fixture tables", async () => {
    expect(await evaluate<boolean>("window.__abacusDev.fixtures")).toBe(false);
    expect(output.join("")).not.toContain(FIXTURE_MARKER);
  });

  describe("R1-T11b view transitions", () => {
    it("a rail navigation starts one, typed nav-lateral, animating pane and sidebar", async () => {
      await go("/bots/new");
      await transitions();
      await click('[data-slot="rail"] a[data-area="sessions"]');
      await until(
        "window.location.hash.startsWith('#/sessions')",
        5_000,
        "sessions"
      );
      const started = await transitions();
      expect(started).toHaveLength(1);
      expect(started[0]!.types).toEqual(["nav-lateral"]);
      expect(started[0]!.pane).toBe(true);
      expect(started[0]!.sidebar).toBe(true);
    });

    it("a masked pop-up opening and closing starts none", async () => {
      await go("/routines");
      await transitions();
      await go("/routines/new");
      await evaluate("history.back()");
      await until("window.location.hash === '#/routines'", 5_000);
      await sleep(400);
      expect(await transitions()).toEqual([]);
    });

    it("a search-only change starts none", async () => {
      await go("/artifacts");
      await transitions();
      await go("/artifacts?type=file");
      expect(await transitions()).toEqual([]);
    });

    it("entering and leaving Settings each start their own, animating pane and sidebar", async () => {
      await go("/bots/new");
      await transitions();
      await go("/settings/general");
      const into = await transitions();
      await go("/bots/new");
      const out = await transitions();
      expect(into.map((t) => t.types)).toEqual([["settings-in"]]);
      expect(out.map((t) => t.types)).toEqual([["settings-out"]]);
      for (const t of [...into, ...out]) {
        expect(t.pane).toBe(true);
        expect(t.sidebar).toBe(true);
      }
    });

    it("a harness-created bot shows in the live sidebar; opening it is nav-forward, browser back is nav-back", async () => {
      await go("/bots/new");
      await transitions();
      harness("bots.create", {
        name: "Harness Bot",
        description: "Created through the legacy service path",
      });
      await until(
        `[...document.querySelectorAll('[data-slot="nav-list"] a')].some((a) => a.textContent.includes("Harness Bot"))`,
        10_000,
        "the harness bot in the sidebar"
      );
      const rows = await evaluate<Array<{ id: string; name: string }>>(
        "window.__abacusDev.rows('bots')"
      );
      const bot = rows.find((row) => row.name === "Harness Bot");
      expect(bot).toBeDefined();

      await evaluate(
        `[...document.querySelectorAll('[data-slot="nav-list"] a')].find((a) => a.textContent.includes("Harness Bot")).click()`
      );
      await until(
        `window.location.hash === ${JSON.stringify(`#/bots/${bot!.id}`)}`,
        5_000
      );
      // A fresh bot starts an agent and then hydrates through the chat
      // runtime's 5 s readiness cap. Leave time for IPC and the transition
      // after that cap; this case checks transition types, not load latency.
      const forward = await transitions(10_000);
      expect(forward.map((t) => t.types)).toEqual([["nav-forward"]]);
      expect(forward[0]!.pane).toBe(true);

      await evaluate("history.back()");
      await until("window.location.hash === '#/bots/new'", 5_000);
      const back = await transitions();
      expect(back.map((t) => t.types)).toEqual([["nav-back"]]);
      expect(back[0]!.pane).toBe(true);
    });

    it("a loader slower than the pending threshold commits its pending screen without one, then starts exactly one", async () => {
      await go("/bots/new");
      await transitions();
      await evaluate("window.__abacusDev.setLoaderDelay(600)");
      try {
        await click('[data-slot="rail"] a[data-area="routines"]');
        await until(
          "document.querySelector('[data-testid=\"pending-pane\"]') != null",
          2_000,
          "the pending pane"
        );
        expect(
          await evaluate<number>("window.__vt.length"),
          "no transition while pending"
        ).toBe(0);
        await until("window.location.hash.startsWith('#/routines')", 5_000);
        await until(
          "document.querySelector('[data-testid=\"pending-pane\"]') == null",
          5_000
        );
      } finally {
        await evaluate("window.__abacusDev.setLoaderDelay(0)");
      }
      const started = await transitions();
      expect(started.map((t) => t.types)).toEqual([["nav-lateral"]]);
      expect(started[0]!.pane).toBe(true);
    });

    it("never starts two transitions at once, a route with a React <ViewTransition> included", async () => {
      await go("/__ui?section=motion");
      await go("/bots/new");
      await transitions();
      expect(
        await evaluate<number>("window.__abacusVtOverlaps?.overlaps ?? -1")
      ).toBe(0);
    });
  });

  it("a theme written from the renderer reaches main's nativeTheme", async () => {
    const dark = "matchMedia('(prefers-color-scheme: dark)').matches";
    await evaluate("window.__abacusDev.setTheme('dark')");
    await until(dark, 5_000, "nativeTheme dark");
    await evaluate("window.__abacusDev.setTheme('light')");
    await until(`!${dark}`, 5_000, "nativeTheme light");
    await evaluate("window.__abacusDev.setTheme('system')");
  });

  it("R5 appearance preferences change rendered transcript, composer and user bubble styles", async () => {
    await go("/__ui?fixture=bot-golden-plain");
    await until(
      '!!(document.querySelector(".chat-prose") && document.querySelector("[data-slot=composer] textarea"))',
      10000,
      "chat appearance fixture"
    ).catch(async () => {
      throw new Error(
        await evaluate<string>(
          "JSON.stringify({ prose: document.querySelector('.chat-prose')?.outerHTML, textarea: document.querySelector('textarea')?.outerHTML, chat: document.querySelector('[data-slot=chat-layout]')?.outerHTML.slice(0,3000) })"
        )
      );
    });
    const original = await evaluate(
      "window.__abacusDev.rows('prefs')[0].appearance"
    );
    const tintBefore = await evaluate<string>(
      'getComputedStyle(document.querySelector("[data-role=user] > div")).backgroundColor'
    );
    try {
      await evaluate(
        "window.__abacusDev.call('db.prefs.update', { patch: { appearance: { textSize: 15, bubbleTint: false } } })"
      );
      await until(
        'getComputedStyle(document.querySelector(".chat-prose")).fontSize === "15px"',
        5000,
        "transcript text size"
      );
      expect(
        await evaluate(
          'getComputedStyle(document.querySelector("[data-slot=composer] textarea")).fontSize'
        )
      ).toBe("15px");
      expect(
        await evaluate(
          'getComputedStyle(document.querySelector("[data-role=user] > div")).backgroundColor'
        )
      ).not.toBe(tintBefore);
    } finally {
      await evaluate(
        `window.__abacusDev.call('db.prefs.update', { patch: { appearance: ${JSON.stringify(original)} } })`
      );
      await go("/bots/new");
    }
  });

  it("R1-T22: a lost port stops the syncs and says so, reloads exactly once and reconnects; a second loss within 10 s shows the error screen", async () => {
    const first = await evaluate<number>("performance.timeOrigin");
    // Watches the first document from inside it: the moment the
    // connection-lost toast appears, whether the syncs were already stopped,
    // and in which document. sessionStorage carries it across the reload.
    await evaluate(`(() => {
      sessionStorage.removeItem("__lossProbe");
      const seen = () =>
        [...document.querySelectorAll('[data-slot="toast"]')].some((toast) =>
          (toast.textContent || "").includes(${JSON.stringify(CONNECTION_LOST)})
        );
      const record = () => {
        if (sessionStorage.getItem("__lossProbe") != null || !seen()) return;
        sessionStorage.setItem("__lossProbe", JSON.stringify({
          timeOrigin: performance.timeOrigin,
          stopped: window.__abacusDev.stopped(),
          at: Date.now(),
        }));
      };
      new MutationObserver(record).observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true,
      });
    })()`);
    const before = navigations.length;
    const dropped = Date.now();
    harness("renderer.dropPort", {});
    // The reload comes 1.5 s later: a new document that boots again.
    await until(
      `performance.timeOrigin !== ${first} && typeof window.__abacusDev === 'object'`,
      15_000,
      "a reloaded, booted document"
    );
    const second = await evaluate<number>("performance.timeOrigin");
    await until(
      "document.querySelector('[data-slot=\"shell\"]') != null",
      10_000
    );
    // Reconnected: the new document's collections sync again.
    expect(await evaluate<boolean>("window.__abacusDev.stopped()")).toBe(false);
    await until(
      "window.__abacusDev.syncStatus('prefs')?.state === 'live'",
      10_000,
      "prefs live again"
    );

    const probe = JSON.parse(
      (await evaluate<string | null>(
        "sessionStorage.getItem('__lossProbe')"
      )) ?? "null"
    ) as { timeOrigin: number; stopped: boolean; at: number } | null;
    expect(probe, "the connection-lost notification").not.toBeNull();
    // In the first document, before the reload, with the syncs stopped.
    expect(probe!.timeOrigin).toBe(first);
    expect(probe!.stopped).toBe(true);
    expect(probe!.at).toBeGreaterThanOrEqual(dropped);
    expect(probe!.at).toBeLessThan(second);

    // Exactly one reload, and no later one.
    await sleep(3_000);
    const reloads = navigations.slice(before);
    expect(reloads, JSON.stringify(reloads)).toHaveLength(1);
    expect(reloads[0]!.url).toContain("index-next");
    expect(await evaluate<number>("performance.timeOrigin")).toBe(second);

    harness("renderer.dropPort", {});
    await until(
      "document.querySelector('[data-slot=\"boot-failure\"]') != null",
      10_000,
      "the error screen"
    );
    await sleep(3_000);
    // No reload loop: still the same document, still the error screen.
    expect(navigations.slice(before)).toHaveLength(1);
    expect(await evaluate<number>("performance.timeOrigin")).toBe(second);
    expect(
      await evaluate<boolean>(
        "document.querySelector('[data-slot=\"boot-failure\"]') != null"
      )
    ).toBe(true);
  });
});
