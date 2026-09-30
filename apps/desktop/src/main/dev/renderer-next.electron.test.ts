/**
 * R1-T11b: view transitions in the real Electron renderer. With a real
 * `document.startViewTransition`, a typed navigation starts a view transition
 * carrying its type and an untyped commit (a masked pop-up opening or closing,
 * a search-only change) starts none; entering and leaving Settings animate.
 *
 * Runs the built app (dist/ from `VITE_UI_GALLERY=1 VITE_NEXT_DB_FIXTURES=1
 * vite build`, which scripts/screenshots-next.mjs also makes) with the wco
 * generation and an isolated profile, driven over CDP. Skips when that build
 * is missing or no display is available.
 */
import { spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { harnessAvailability } from "../services/browser/browser-snapshot-harness";

const DESKTOP = resolve(import.meta.dirname, "../../..");
const PORT = 9393;
const built = join(DESKTOP, "dist/renderer/index-next.html");
const galleryBuild =
  existsSync(built) &&
  readdirJs(join(DESKTOP, "dist/renderer/assets")).some((source) =>
    source.includes("__abacusDev")
  );
const availability = harnessAvailability();
const runnable = galleryBuild && availability.usable;

function readdirJs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".js"))
    .map((name) => readFileSync(join(dir, name), "utf8"));
}

let child: ChildProcess | null = null;
let scratch = "";
let send: (method: string, params?: object) => Promise<any> = async () => null;

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  if (!runnable) return;
  scratch = mkdtempSync(join(tmpdir(), "renderer-next-vt-"));
  const electron = createRequire(import.meta.url)(
    "electron"
  ) as unknown as string;
  child = spawn(electron, [".", `--remote-debugging-port=${PORT}`], {
    cwd: DESKTOP,
    env: {
      ...process.env,
      ABACUSAI_BOT_HOME: join(scratch, "home"),
      ABACUSAI_BOT_USERDATA: join(scratch, "ud"),
      ABACUSBOT_RENDERER_GENERATION: "wco",
      ABACUSBOT_DEV_CONTENT_SIZE: "1280x800",
    },
    stdio: "ignore",
  });
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
    pending.get(message.id)?.(message.result ?? message);
    pending.delete(message.id);
  };
  send = (method, params = {}) =>
    new Promise((r) => {
      id += 1;
      pending.set(id, r);
      ws.send(JSON.stringify({ id, method, params }));
    });
  for (let i = 0; i < 60; i += 1) {
    if (await evaluate<boolean>("typeof window.__abacusDev === 'object'"))
      break;
    await sleep(500);
  }
  // Record every view transition and its types.
  await evaluate(`(() => {
    window.__vt = [];
    const start = document.startViewTransition.bind(document);
    document.startViewTransition = (arg) => {
      const transition = start(arg);
      window.__vt.push({ types: arg && arg.types ? [...arg.types] : [] });
      transition.ready.then(() => {
        const last = window.__vt.at(-1);
        last.types = last.types.length ? last.types : [...(transition.types ?? [])];
        last.pane = document.getAnimations().some((a) => String(a.effect?.pseudoElement ?? "").includes("pane"));
      }).catch(() => undefined);
      return transition;
    };
  })()`);
}, 120_000);

afterAll(() => {
  child?.kill("SIGKILL");
  if (scratch !== "") rmSync(scratch, { recursive: true, force: true });
});

const go = (href: string) =>
  evaluate(`window.__abacusDev.navigateAndSettle(${JSON.stringify(href)})`);
const transitions = () =>
  evaluate<Array<{ types: string[]; pane?: boolean }>>("window.__vt.splice(0)");

describe.skipIf(!runnable)("renderer-next view transitions (Electron)", () => {
  it("a typed navigation starts one, carrying its type", async () => {
    await go("/bots/new");
    await transitions();
    await evaluate(
      `document.querySelector('[data-slot="rail"] a[data-area="sessions"]').click()`
    );
    await sleep(600);
    const started = await transitions();
    expect(started).toHaveLength(1);
    expect(started[0]!.types).toContain("nav-lateral");
  });

  it("a masked pop-up opening and closing starts none", async () => {
    await go("/routines");
    await transitions();
    await go("/routines/new");
    await evaluate("history.back()");
    await sleep(600);
    expect(await transitions()).toEqual([]);
  });

  it("a search-only change starts none", async () => {
    await go("/artifacts");
    await transitions();
    await go("/artifacts?type=deck");
    expect(await transitions()).toEqual([]);
  });

  it("entering and leaving Settings animate the pane", async () => {
    await go("/bots/new");
    await transitions();
    await go("/settings/general");
    await go("/bots/new");
    const started = await transitions();
    expect(started.map((t) => t.types).flat()).toEqual([
      "settings-in",
      "settings-out",
    ]);
    expect(started.every((t) => t.pane !== false)).toBe(true);
  });
});
