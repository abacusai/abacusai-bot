#!/usr/bin/env node
/**
 * Screenshots of renderer-next in the real Electron window (spec 01 §10.2):
 * every route at each width, light and dark, plus the gallery's overlay
 * examples, with axe (WCAG 2 A/AA) on each capture once it has settled. No
 * Playwright: Electron with an isolated profile and the Chrome DevTools
 * Protocol.
 *
 *   node scripts/screenshots-next.mjs [--no-build] [--widths 1280,900]
 *        [--routes /bots/new,/__ui?section=shell] [--no-overlays]
 *        [--require-native-frame]
 *
 * Output: .build/screenshots/<git-sha>/<route-slug>@<W>-<theme>.png,
 * axe.json, shots.json (every capture's geometry, the checks that failed
 * and the run's exit status) and index.html (a contact sheet).
 *
 * The gate (Codex impl r1 #13) programs and asserts, besides the routes:
 * - collapsed (sidebar unpinned) and hover (the floating sidebar) states:
 *   each waits for stable sidebar and pane rectangles and fails on timeout;
 *   collapsed asserts a 0 px sidebar column with the pane against the rail,
 *   floating asserts its place and that the pane kept its left edge and
 *   width (Codex impl r2 #6);
 * - the side panel in layout at the 1100 minimum: pane and panel ≥ 360 px,
 *   an 8 px gutter;
 * - compact density (a second launch with the stored setting): a 32 px
 *   title bar and 24 px rows;
 * - full screen: no traffic-light reservation, the bar still whole;
 * - Linux native frame (Codex impl r2 #5): on Linux, a second launch per
 *   width with ABACUSBOT_NATIVE_FRAME=1 asserts `data-titlebar="native-frame"`,
 *   zero reservations, the bar at the top of the content at --toolbar-h, no
 *   visible overlay and the band, then captures it; a probe that cannot run
 *   fails the run. Elsewhere it is recorded as "skipped: not linux", which
 *   fails when the probe is required (`--require-native-frame` or
 *   ABACUSBOT_REQUIRE_NATIVE_FRAME=1, set by the Linux CI job);
 * - axe: any serious or critical violation fails the run.
 *
 * This is the visual run: the build reads the dev fixture tables
 * (VITE_NEXT_DB_FIXTURES=1), the canvas home as rows. Acceptance against
 * main's real db.* is the Electron suite (src/main/dev/renderer-next.electron.test.ts).
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const desktop = join(import.meta.dirname, "..");
const repo = join(desktop, "../..");
const require = createRequire(import.meta.url);

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
};

export const WIDTHS = option("--widths", "1280,1100,1000,900,800")
  .split(",")
  .map(Number);
export const HEIGHT = 800;
export const THEMES = ["light", "dark"];
const PORT = Number(option("--port", "9392"));

/** §7.1 */
export const bandFor = (width) =>
  width >= 1100 ? "xl" : width >= 1000 ? "lg" : width >= 900 ? "md" : "sm";

export const PHASE6_ROUTES = [
  ...[
    "welcome",
    "connect",
    "connected",
    "models",
    "connectors",
    "first-bot",
    "done",
  ].map((step) => `/__ui?fixture=onboarding-${step}`),
  ...[
    "welcome",
    "rail",
    "make-bot",
    "workspaces",
    "start-session",
    "connectors",
    "talk",
    "changes",
    "preview-terminal",
    "memory",
    "artifacts",
    "notch",
  ].map((stop) => `/__ui?fixture=tour-${stop}`),
  ...["plain", "notch", "capsule"].flatMap((mode) =>
    [
      "hidden",
      "idle",
      "working",
      "approval",
      "question",
      "truncated",
      "reply",
      "reply-readonly",
      "call",
      "done",
      "failed",
      "several",
      "hovered",
      "quiet",
      "reaction",
    ].map(
      (state) =>
        `/__ui?fixture=notch-${mode === "plain" ? "" : mode + "-"}${state}`
    )
  ),
];
export const ROUTES = option(
  "--routes",
  flag("--phase6")
    ? PHASE6_ROUTES.join(",")
    : [
        "/bots/new",
        "/bots/chief-of-staff",
        "/sessions/new",
        "/sessions/review-prs?tab=terminal",
        "/routines",
        "/routines/new",
        "/artifacts",
        "/library/connectors",
        "/settings/general",
        "/settings/models",
        "/__ui?fixture=routine-report",
        "/settings/appearance",
        "/onboarding/welcome",
        "/__ui?section=shell",
      ].join(",")
).split(",");

const OVERLAYS = [
  "dialog",
  "alert-dialog",
  "sheet",
  "drawer",
  "dropdown-menu",
  "context-menu",
  "popover",
  "tooltip",
  "hover-card",
  "combobox",
  "command",
  "select",
];

/** Which axe impacts fail the run (Claude impl r1 #9/#10). */
export const FAILING_IMPACTS = new Set(["serious", "critical"]);

export const axeFailures = (name, violations) =>
  violations
    .filter((violation) => FAILING_IMPACTS.has(violation.impact))
    .map(
      (violation) =>
        `${name}: axe ${violation.impact} ${violation.id} ${violation.nodes.join(", ")}`
    );

const near = (a, b, tolerance = 1) => Math.abs(a - b) <= tolerance;

/** The in-layout split at 1100: both sides ≥ 360, an 8 px gutter. */
export const panelSplitProblems = (name, split) => {
  const problems = [];
  if (split?.pane == null || split?.panel == null)
    return [`${name}: side panel not in layout`];
  if (split.pane.width < 360 - 0.5)
    problems.push(`${name}: pane ${split.pane.width} < 360`);
  if (split.panel.width < 360 - 0.5)
    problems.push(`${name}: panel ${split.panel.width} < 360`);
  const gutter = split.panel.left - split.pane.right;
  if (!near(gutter, 8))
    problems.push(`${name}: pane/panel gutter ${gutter} (want 8)`);
  if (!near(split.panel.right, split.innerWidth - 8))
    problems.push(`${name}: panel right ${split.panel.right} (want inset 8)`);
  return problems;
};

/** The floating sidebar over the content, which does not reflow (canvas `HoverSidebar`). */
export const floatingProblems = (name, floating) => {
  const problems = [];
  if (floating?.rect == null) return [`${name}: no floating sidebar on hover`];
  if (floating.stable === false)
    problems.push(`${name}: the floating sidebar never held still`);
  const want = {
    left: floating.railW + 4,
    width: 280,
    top: floating.toolbar + 4,
  };
  for (const key of Object.keys(want))
    if (!near(floating.rect[key], want[key]))
      problems.push(
        `${name}: floating ${key} ${floating.rect[key]} (want ${want[key]})`
      );
  if (floating.paneBefore == null || floating.paneAfter == null)
    problems.push(`${name}: no pane to compare`);
  else
    for (const key of ["left", "width"])
      if (!near(floating.paneBefore[key], floating.paneAfter[key]))
        problems.push(
          `${name}: the pane reflowed (${key} ${floating.paneBefore[key]} → ${floating.paneAfter[key]})`
        );
  return problems;
};

/** Collapsed (unpinned, not hovered): no sidebar column, the pane against the rail. */
export const collapsedProblems = (name, collapsed) => {
  const problems = [];
  if (!collapsed?.floating)
    return [`${name}: the shell never reached the collapsed (floating) mode`];
  if (!collapsed.stable)
    problems.push(`${name}: sidebar and pane never held still`);
  if (
    collapsed.slot == null ||
    collapsed.pane == null ||
    collapsed.rail == null
  )
    return [...problems, `${name}: missing sidebar slot, pane or rail`];
  if (!near(collapsed.slot.width, 0))
    problems.push(
      `${name}: collapsed sidebar column ${collapsed.slot.width} (want 0)`
    );
  if (collapsed.occupied !== "0px")
    problems.push(
      `${name}: --sidebar-occupied-w ${collapsed.occupied} (want 0px)`
    );
  if (!near(collapsed.pane.left, collapsed.rail.right))
    problems.push(
      `${name}: pane left ${collapsed.pane.left} (want the rail's right ${collapsed.rail.right})`
    );
  if (
    collapsed.pinnedPane != null &&
    !(collapsed.pane.width > collapsed.pinnedPane.width)
  )
    problems.push(
      `${name}: pane width ${collapsed.pane.width} did not grow from pinned ${collapsed.pinnedPane.width}`
    );
  return problems;
};

/** Whether the native-frame probe runs here, and what a skip means. */
export const nativeFrameStatus = (platform, required) =>
  platform === "linux"
    ? { run: true }
    : {
        run: false,
        record: "skipped: not linux",
        failures: required
          ? [`native-frame: required but skipped: not linux (${platform})`]
          : [],
      };

/** Linux native frame: the OS title bar above, the app bar whole, no reservations. */
export const nativeFrameProblems = (name, probe) => {
  const problems = [];
  if (probe == null) return [`${name}: no native-frame probe`];
  if (probe.titlebar !== "native-frame")
    problems.push(
      `${name}: data-titlebar ${probe.titlebar} (want native-frame)`
    );
  if (probe.overlayVisible === true)
    problems.push(`${name}: the window controls overlay is visible`);
  for (const key of ["titlebarX", "titlebarEnd", "paddingLeft"])
    if (!near(probe[key], 0))
      problems.push(`${name}: ${key} ${probe[key]} (want 0)`);
  if (!near(probe.toolbar, 40))
    problems.push(`${name}: --toolbar-h ${probe.toolbar} (want 40)`);
  if (!near(probe.topbar?.height, probe.toolbar))
    problems.push(
      `${name}: title bar height ${probe.topbar?.height} (want ${probe.toolbar})`
    );
  if (!near(probe.topbar?.top, 0))
    problems.push(`${name}: title bar top ${probe.topbar?.top} (want 0)`);
  if (!near(probe.topbar?.width, probe.innerWidth))
    problems.push(
      `${name}: title bar width ${probe.topbar?.width} (want ${probe.innerWidth})`
    );
  if (probe.innerWidth !== probe.width)
    problems.push(
      `${name}: innerWidth ${probe.innerWidth} (want ${probe.width})`
    );
  if (probe.band !== bandFor(probe.width))
    problems.push(`${name}: band ${probe.band} (want ${bandFor(probe.width)})`);
  return problems;
};

/** Compact density: a 32 px bar, 24 px rows. */
export const compactProblems = (name, compact) => {
  const problems = [];
  if (!near(compact.toolbar, 32))
    problems.push(`${name}: --toolbar-h ${compact.toolbar} (want 32)`);
  if (!near(compact.topbar, 32))
    problems.push(`${name}: title bar ${compact.topbar} (want 32)`);
  for (const row of compact.rows)
    if (!near(row, 24)) problems.push(`${name}: row ${row} (want 24)`);
  if (compact.rows.length === 0) problems.push(`${name}: no sidebar rows`);
  return problems;
};

/** Full screen: no traffic-light reservation, the bar still its height. */
export const fullScreenProblems = (name, probe) => {
  const problems = [];
  if (!probe.fullScreen)
    problems.push(`${name}: the window is not full screen`);
  if (!near(probe.paddingLeft, 0))
    problems.push(
      `${name}: title bar keeps a ${probe.paddingLeft} px reservation`
    );
  if (!near(probe.topbar, probe.toolbar))
    problems.push(`${name}: title bar ${probe.topbar} (want ${probe.toolbar})`);
  return problems;
};

const slug = (route) =>
  route
    .replace(/^\//, "")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/-$/, "") || "root";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A minimal CDP client over Node's WebSocket. */
const connect = async (port) => {
  let page = null;
  for (let attempt = 0; attempt < 120 && page == null; attempt += 1) {
    try {
      const targets = await (
        await fetch(`http://127.0.0.1:${port}/json`)
      ).json();
      page = targets.find(
        (target) =>
          target.type === "page" && target.url.includes("index.html")
      );
    } catch {
      // Not listening yet.
    }
    if (page == null) await sleep(500);
  }
  if (page == null) throw new Error("no renderer-next page appeared");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    const waiter = pending.get(message.id);
    if (waiter == null) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
    else waiter.resolve(message.result);
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      id += 1;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails)
      throw new Error(
        `${expression.slice(0, 80)}: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`
      );
    return result.result.value;
  };
  return { send, evaluate, close: () => ws.close() };
};

const launch = (width, scratch, home, tag = `${width}`, env = {}) => {
  const electron = join(
    repo,
    "node_modules/electron/dist",
    readFileSync(join(repo, "node_modules/electron/path.txt"), "utf8").trim()
  );
  const log = join(scratch, `electron-${tag}.log`);
  const child = spawn(electron, [".", `--remote-debugging-port=${PORT}`], {
    cwd: desktop,
    env: {
      ...process.env,
      ABACUSAI_BOT_HOME: home,
      ABACUSAI_BOT_USERDATA: join(scratch, `ud-${tag}`),
      ABACUSBOT_RENDERER_GENERATION: "wco",
      ABACUSBOT_DEV_CONTENT_SIZE: `${width}x${HEIGHT}`,
      ABACUSBOT_DEV_HARNESS: "1",
      ...env,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines = [];
  child.stdout.on("data", (chunk) => lines.push(String(chunk)));
  child.stderr.on("data", (chunk) => lines.push(String(chunk)));
  child.on("exit", () => writeFileSync(log, lines.join("")));
  child.harness = (op, input) =>
    child.stdin.write(`${JSON.stringify({ op, input })}\n`);
  return child;
};

const settle = (cdp, href) =>
  cdp.evaluate(`window.__abacusDev.navigateAndSettle(${JSON.stringify(href)})`);

/** Every finite animation done (dialogs fade in; axe must see the end state). */
const animationsDone = (cdp) =>
  cdp.evaluate(`(async () => {
    for (let round = 0; round < 10; round += 1) {
      const running = document.getAnimations().filter((a) =>
        a.playState === "running" && a.effect?.getComputedTiming().endTime !== Infinity);
      if (running.length === 0) return true;
      await Promise.all(running.map((a) => a.finished.catch(() => undefined)));
    }
    return true;
  })()`);

const waitFor = async (cdp, expression, timeoutMs = 5_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cdp.evaluate(expression)) return true;
    await sleep(100);
  }
  return false;
};

/**
 * Poll `expression` until it returns the same JSON three reads in a row, 50
 * ms apart (springs run on frames, not the Animations API). `stable: false`
 * on timeout.
 */
const waitStable = async (cdp, expression, timeoutMs = 4_000) => {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  let same = 0;
  let value = null;
  while (Date.now() < deadline) {
    value = await cdp.evaluate(expression);
    const now = JSON.stringify(value);
    same = now === last ? same + 1 : 0;
    last = now;
    if (same >= 2) return { value, stable: true };
    await sleep(50);
  }
  return { value, stable: false };
};

const rect = (selector) =>
  `(() => { const r = document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect(); return r && { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; })()`;

const main = async () => {
  if (!flag("--no-build")) {
    execFileSync(join(repo, "node_modules/.bin/vite"), ["build"], {
      cwd: desktop,
      stdio: "inherit",
      env: { ...process.env, VITE_UI_GALLERY: "1", VITE_NEXT_DB_FIXTURES: "1" },
    });
  }
  const sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
    cwd: desktop,
    encoding: "utf8",
  }).trim();
  const out = join(repo, ".build/screenshots", sha);
  mkdirSync(out, { recursive: true });
  const scratch = mkdtempSync(join(tmpdir(), "screenshots-next-"));
  const home = join(scratch, "home");
  mkdirSync(home, { recursive: true });
  writeFileSync(
    join(home, "account.json"),
    JSON.stringify({ account: null, apps: [], onboarded: true })
  );
  const axeSource = readFileSync(
    require.resolve("axe-core/axe.min.js"),
    "utf8"
  );

  const shots = [];
  const axeReport = [];
  const failures = [];
  const probes = {};

  /** Capture the current state as `name`, after axe on the settled page. */
  const capture = async (cdp, name, extra = {}) => {
    await animationsDone(cdp);
    await cdp.evaluate(
      `new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`
    );
    const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(out, name), Buffer.from(shot.data, "base64"));
    const axe = await cdp.evaluate(
      `axe.run(document, { runOnly: ["wcag2a", "wcag2aa"] }).then((r) => r.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.slice(0, 5).map((n) => n.target.join(" ")), html: v.nodes.slice(0, 2).map((n) => n.html.slice(0, 160)) })))`
    );
    axeReport.push({ file: name, violations: axe });
    failures.push(...axeFailures(name, axe));
    const notchText = flag("--phase6")
      ? await cdp.evaluate(`(() => {
      const region = document.querySelector('.notch-shape');
      if (!region) return null;
      return [...region.querySelectorAll('span,h2,p,button')].filter((node) => node.textContent).map((node) => {
        const css = getComputedStyle(node);
        return { tag: node.tagName, text: node.textContent.slice(0,80), color: css.color, background: css.backgroundColor, opacity: css.opacity, visibility: css.visibility, mix: css.mixBlendMode };
      });
    })()`)
      : undefined;
    shots.push({ file: name, ...extra, ...(notchText ? { notchText } : {}) });
  };

  for (const width of WIDTHS) {
    const child = launch(width, scratch, home);
    try {
      const cdp = await connect(PORT);
      await cdp.send("Page.enable");
      for (let i = 0; i < 60; i += 1) {
        if (await cdp.evaluate("typeof window.__abacusDev === 'object'")) break;
        await sleep(500);
      }
      await waitFor(
        cdp,
        `document.documentElement.dataset.band === ${JSON.stringify(bandFor(width))}`
      );
      const size = await cdp.evaluate(
        "({ w: innerWidth, band: document.documentElement.dataset.band })"
      );
      if (size.w !== width || size.band !== bandFor(width))
        failures.push(
          `${width}: innerWidth ${size.w}, band ${size.band} (want ${bandFor(width)})`
        );

      // Both sides of each boundary flip the band exactly there.
      if ([1100, 1000, 900].includes(width)) {
        for (const probe of [width - 1, width]) {
          await cdp.send("Emulation.setDeviceMetricsOverride", {
            width: probe,
            height: HEIGHT,
            deviceScaleFactor: 0,
            mobile: false,
          });
          await sleep(150);
          const band = await cdp.evaluate(
            "document.documentElement.dataset.band"
          );
          if (band !== bandFor(probe))
            failures.push(`${probe}: band ${band} (want ${bandFor(probe)})`);
        }
        await cdp.send("Emulation.clearDeviceMetricsOverride");
        await sleep(150);
      }

      await cdp.evaluate(axeSource);
      const routes = [
        ...ROUTES,
        ...(flag("--no-overlays") || width !== WIDTHS[0]
          ? []
          : OVERLAYS.map((id) => `/__ui?section=${id}&open=${id}`)),
      ];
      for (const theme of THEMES) {
        await cdp.send("Emulation.setEmulatedMedia", {
          features: [{ name: "prefers-color-scheme", value: theme }],
        });
        for (const route of routes) {
          await settle(cdp, route);
          if (flag("--phase6")) {
            const selector = route.includes("onboarding-")
              ? `[data-onboarding-step="${route.split("onboarding-")[1]}"]`
              : route.includes("fixture=tour")
                ? '[data-slot="tour-spotlight"]'
                : ".notch-shape";
            if (
              !(await waitFor(
                cdp,
                `!!document.querySelector(${JSON.stringify(selector)})`
              ))
            )
              throw new Error(`phase-6 surface did not mount: ${route}`);
            await cdp.evaluate("document.fonts.ready.then(() => true)");
            await animationsDone(cdp);
            await sleep(180);
          }
          const geometry = await cdp.evaluate(`(() => {
            const pane = document.querySelector('[data-slot="pane"]')?.getBoundingClientRect();
            const identity = document.querySelector('[data-slot="topbar-identity"]')?.getBoundingClientRect();
            const leading = document.querySelector('[data-slot="topbar-leading"]')?.getBoundingClientRect();
            const popup = document.querySelector('[data-slot="drawer-popup"][data-side-panel]')?.getBoundingClientRect();
            const scrim = document.querySelector('[data-slot="side-panel-scrim"]')?.getBoundingClientRect();
            const toolbar = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--toolbar-h'));
            return {
              occupied: document.querySelector('[data-slot="shell"]')?.style.getPropertyValue('--sidebar-occupied-w'),
              pane: pane && { left: pane.left, width: pane.width },
              identity: identity && { left: identity.left },
              leading: leading && { right: leading.right },
              popup: popup && { width: popup.width, top: popup.top, right: popup.right, bottom: popup.bottom },
              scrim: scrim && { top: scrim.top },
              toolbar, innerWidth, innerHeight,
              supports: CSS.supports('width', 'calc(var(--rail-w) + var(--sidebar-occupied-w) - var(--titlebar-x))'),
              dark: document.documentElement.classList.contains('dark'),
            };
          })()`);
          const name = `${slug(route)}@${width}-${theme}.png`;

          if (geometry.dark !== (theme === "dark"))
            failures.push(`${name}: wrong theme`);
          if (!geometry.supports)
            failures.push(`${name}: leading width declaration unsupported`);
          if (
            geometry.occupied === "280px" &&
            geometry.pane &&
            geometry.identity &&
            Math.abs(geometry.identity.left - geometry.pane.left) > 1
          )
            failures.push(
              `${name}: identity ${geometry.identity.left} != pane ${geometry.pane.left}`
            );
          if (
            geometry.occupied === "88px" &&
            geometry.identity &&
            geometry.leading &&
            geometry.identity.left < geometry.leading.right - 0.5
          )
            failures.push(`${name}: identity overlaps the leading buttons`);
          if (geometry.popup) {
            const want = {
              width: 356,
              top: geometry.toolbar + 8,
              right: geometry.innerWidth - 8,
              bottom: geometry.innerHeight - 8,
            };
            for (const key of Object.keys(want))
              if (Math.abs(geometry.popup[key] - want[key]) > 1)
                failures.push(
                  `${name}: drawer ${key} ${geometry.popup[key]} (want ${want[key]})`
                );
            if (
              geometry.scrim &&
              Math.abs(geometry.scrim.top - geometry.toolbar) > 1
            )
              failures.push(
                `${name}: scrim top ${geometry.scrim.top} (want ${geometry.toolbar})`
              );
          }
          // The 1100 minimum with the panel in layout (Codex impl r1 #13).
          if (width === 1100 && route.includes("tab=")) {
            const split = await cdp.evaluate(`({
              pane: ${rect('[data-slot="pane"]')},
              panel: ${rect('[data-slot="side-panel"][data-mode="layout"]')},
              innerWidth,
            })`);
            failures.push(...panelSplitProblems(name, split));
            geometry.split = split;
          }
          await capture(cdp, name, { route, width, theme, geometry });
        }

        if (flag("--phase6")) continue;
        // Collapsed, then the floating sidebar on rail hover (V9).
        if (width >= 900) {
          await cdp.evaluate("window.__abacusDev.setPinned(true)");
          await settle(cdp, "/bots/chief-of-staff");
          const pinnedPane = (await waitStable(cdp, rect('[data-slot="pane"]')))
            .value;
          await cdp.evaluate("window.__abacusDev.setPinned(false)");
          await settle(cdp, "/bots/chief-of-staff");
          const collapsed = `collapsed@${width}-${theme}.png`;
          const floatingMode = await waitFor(
            cdp,
            `document.querySelector('[data-slot="shell"]')?.dataset.sidebar === "floating"`
          );
          const settled = await waitStable(
            cdp,
            `({
              slot: ${rect('[data-slot="sidebar-slot"]')},
              pane: ${rect('[data-slot="pane"]')},
              rail: ${rect('[data-slot="rail"]')},
              occupied: document.querySelector('[data-slot="shell"]')?.style.getPropertyValue('--sidebar-occupied-w'),
            })`
          );
          const collapsedState = {
            ...settled.value,
            floating: floatingMode,
            stable: settled.stable,
            pinnedPane,
          };
          failures.push(...collapsedProblems(collapsed, collapsedState));
          const paneBefore = settled.value?.pane ?? null;
          await capture(cdp, collapsed, {
            state: "collapsed",
            width,
            theme,
            collapsed: collapsedState,
          });
          const rail = await cdp.evaluate(rect('[data-slot="rail"]'));
          await cdp.send("Input.dispatchMouseEvent", {
            type: "mouseMoved",
            x: rail.left + rail.width / 2,
            y: rail.top + 120,
          });
          const opened = await waitFor(
            cdp,
            `document.querySelector('[data-slot="sidebar-floating"]') != null`
          );
          if (opened)
            await waitFor(
              cdp,
              `(() => {
            const floating = document.querySelector('[data-slot="sidebar-floating"]');
            const expected = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--rail-w')) + 4;
            return floating && Math.abs(floating.getBoundingClientRect().left - expected) < 0.5;
          })()`
            );
          const hovered = await waitStable(
            cdp,
            `({
              rect: ${rect('[data-slot="sidebar-floating"]')},
              pane: ${rect('[data-slot="pane"]')},
            })`
          );
          const floating = await cdp.evaluate(`({
            railW: parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--rail-w')),
            toolbar: parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--toolbar-h')),
          })`);
          floating.rect = opened ? (hovered.value?.rect ?? null) : null;
          floating.stable = hovered.stable;
          const name = `floating@${width}-${theme}.png`;
          failures.push(
            ...floatingProblems(name, {
              ...floating,
              paneBefore,
              paneAfter: hovered.value?.pane ?? null,
            })
          );
          await capture(cdp, name, {
            state: "floating",
            width,
            theme,
            floating,
          });
          await cdp.send("Input.dispatchMouseEvent", {
            type: "mouseMoved",
            x: width - 40,
            y: HEIGHT - 40,
          });
          await cdp.evaluate("window.__abacusDev.setPinned(true)");
          await waitFor(
            cdp,
            `document.querySelector('[data-slot="sidebar-floating"]') == null`
          );
        }
      }

      // The frosted chrome (V1) exists only in the composited window: the
      // page capture above has no vibrancy behind it. On macOS, capture the
      // window from the screen as well (needs Screen Recording permission;
      // recorded as skipped when the capture fails).
      if (
        !flag("--phase6") &&
        width === WIDTHS[0] &&
        process.platform === "darwin"
      ) {
        probes.vibrancy = [];
        for (const theme of THEMES) {
          await cdp.send("Emulation.setEmulatedMedia", {
            features: [{ name: "prefers-color-scheme", value: theme }],
          });
          await settle(cdp, "/bots/new");
          const name = `os-window-bots-new@${width}-${theme}.png`;
          try {
            child.harness("window.focus", {});
            const bounds = await cdp.evaluate(
              "({ left: screenX, top: screenY, width: outerWidth, height: outerHeight })"
            );
            await sleep(800);
            execFileSync("screencapture", [
              "-x",
              "-o",
              "-R",
              `${bounds.left},${bounds.top},${bounds.width},${bounds.height}`,
              join(out, name),
            ]);
            const surface = await cdp.evaluate(`({
              html: getComputedStyle(document.documentElement).backgroundColor,
              shell: getComputedStyle(document.querySelector('[data-slot="shell"]')).backgroundColor,
              platform: document.documentElement.dataset.platform,
              titlebar: document.documentElement.dataset.titlebar,
            })`);
            probes.vibrancy.push({ theme, file: name, bounds, surface });
            if (!/rgba\(0, 0, 0, 0\)|transparent/.test(surface.html))
              failures.push(
                `${name}: html is opaque (${surface.html}) under vibrancy`
              );
            shots.push({ file: name, state: "os-window", width, theme });
          } catch (error) {
            probes.vibrancy.push({ theme, skipped: String(error) });
          }
        }
      }

      // Full screen (the first width only): no traffic-light reservation.
      if (!flag("--phase6") && width === WIDTHS[0]) {
        await cdp.send("Emulation.setEmulatedMedia", {
          features: [{ name: "prefers-color-scheme", value: "light" }],
        });
        await settle(cdp, "/bots/new");
        child.harness("window.fullScreen", { on: true });
        const entered = await waitFor(
          cdp,
          `innerHeight > ${HEIGHT} && document.documentElement.dataset.titlebar !== undefined`,
          8_000
        );
        await sleep(1_200);
        const probe = await cdp.evaluate(`({
          fullScreen: ${entered} && innerHeight > ${HEIGHT},
          paddingLeft: parseFloat(getComputedStyle(document.querySelector('[data-slot="topbar"]')).paddingLeft),
          topbar: document.querySelector('[data-slot="topbar"]').getBoundingClientRect().height,
          toolbar: parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--toolbar-h')),
          overlayVisible: navigator.windowControlsOverlay?.visible ?? null,
        })`);
        probes.fullScreen = probe;
        const name = `fullscreen@${width}-light.png`;
        failures.push(...fullScreenProblems(name, probe));
        await capture(cdp, name, { state: "fullscreen", width, probe });
        child.harness("window.fullScreen", { on: false });
        await waitFor(cdp, `innerHeight === ${HEIGHT}`, 8_000);
        await sleep(800);
      }
      cdp.close();
    } finally {
      child.kill("SIGKILL");
      await sleep(800);
    }
  }

  // Compact density: a launch with the stored setting (main reads it at
  // window creation).
  if (!flag("--phase6")) {
    const compactHome = join(scratch, "home-compact");
    mkdirSync(compactHome, { recursive: true });
    writeFileSync(
      join(compactHome, "settings.json"),
      JSON.stringify({ titlebarDensity: "compact" })
    );
    const width = WIDTHS[0];
    const child = launch(width, scratch, compactHome, `${width}-compact`);
    try {
      const cdp = await connect(PORT);
      await cdp.send("Page.enable");
      for (let i = 0; i < 60; i += 1) {
        if (await cdp.evaluate("typeof window.__abacusDev === 'object'")) break;
        await sleep(500);
      }
      await cdp.evaluate(axeSource);
      for (const theme of THEMES) {
        await cdp.send("Emulation.setEmulatedMedia", {
          features: [{ name: "prefers-color-scheme", value: theme }],
        });
        for (const route of ["/sessions/new", "/bots/new"]) {
          await settle(cdp, route);
          await waitFor(
            cdp,
            `document.documentElement.dataset.density === "compact"`
          );
          const compact = await cdp.evaluate(`({
            toolbar: parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--toolbar-h')),
            topbar: document.querySelector('[data-slot="topbar"]').getBoundingClientRect().height,
            rows: [...document.querySelectorAll('[data-slot="nav-list"] a[data-slot="item"]')].slice(0, 4).map((a) => a.getBoundingClientRect().height),
          })`);
          const name = `compact-${slug(route)}@${width}-${theme}.png`;
          failures.push(...compactProblems(name, compact));
          await capture(cdp, name, {
            state: "compact",
            route,
            width,
            theme,
            compact,
          });
        }
      }
      cdp.close();
    } finally {
      child.kill("SIGKILL");
      await sleep(800);
    }
  }

  // Linux native frame (spec 01 §10.2, window-chrome §3): the bands again
  // under the fallback, the chrome geometry asserted, one capture per width.
  const nativeFrame = nativeFrameStatus(
    process.platform,
    flag("--require-native-frame") ||
      process.env.ABACUSBOT_REQUIRE_NATIVE_FRAME === "1"
  );
  if (!nativeFrame.run) {
    probes.nativeFrame = nativeFrame.record;
    failures.push(...nativeFrame.failures);
  } else {
    probes.nativeFrame = [];
    for (const width of WIDTHS) {
      const name = `native-frame-bots-new@${width}-light.png`;
      const child = launch(width, scratch, home, `${width}-native-frame`, {
        ABACUSBOT_NATIVE_FRAME: "1",
      });
      try {
        const cdp = await connect(PORT);
        await cdp.send("Page.enable");
        let booted = false;
        for (let i = 0; i < 60 && !booted; i += 1) {
          booted = await cdp.evaluate("typeof window.__abacusDev === 'object'");
          if (!booted) await sleep(500);
        }
        if (!booted) throw new Error("renderer-next never booted");
        await cdp.evaluate(axeSource);
        await cdp.send("Emulation.setEmulatedMedia", {
          features: [{ name: "prefers-color-scheme", value: "light" }],
        });
        await settle(cdp, "/bots/new");
        await waitFor(
          cdp,
          `document.documentElement.dataset.titlebar === "native-frame"`
        );
        const probe = await cdp.evaluate(`(() => {
          const measure = (value) => {
            const el = document.createElement('div');
            el.style.cssText = 'position:absolute;visibility:hidden;width:' + value;
            document.body.append(el);
            const width = el.getBoundingClientRect().width;
            el.remove();
            return width;
          };
          const bar = document.querySelector('[data-slot="topbar"]');
          const box = bar?.getBoundingClientRect();
          return {
            titlebar: document.documentElement.dataset.titlebar,
            overlayVisible: navigator.windowControlsOverlay?.visible ?? null,
            titlebarX: measure('var(--titlebar-x)'),
            titlebarEnd: measure('var(--titlebar-end)'),
            paddingLeft: bar ? parseFloat(getComputedStyle(bar).paddingLeft) : null,
            topbar: box && { top: box.top, height: box.height, width: box.width },
            toolbar: parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--toolbar-h')),
            frame: { outer: outerHeight, inner: innerHeight },
            innerWidth,
            band: document.documentElement.dataset.band,
          };
        })()`);
        probe.width = width;
        probes.nativeFrame.push({ width, file: name, probe });
        failures.push(...nativeFrameProblems(name, probe));
        await capture(cdp, name, { state: "native-frame", width, probe });
        cdp.close();
      } catch (error) {
        probes.nativeFrame.push({ width, error: String(error) });
        failures.push(`${name}: native-frame probe failed: ${error}`);
      } finally {
        child.kill("SIGKILL");
        await sleep(800);
      }
    }
  }

  const status = failures.length > 0 ? 1 : 0;
  writeFileSync(
    join(out, "axe.json"),
    `${JSON.stringify(axeReport, null, 2)}\n`
  );
  writeFileSync(
    join(out, "shots.json"),
    `${JSON.stringify({ sha, exitStatus: status, failures, probes, shots }, null, 2)}\n`
  );
  const cells = shots
    .map(
      (shot) =>
        `<figure><img src="${shot.file}" loading="lazy"><figcaption>${shot.file}</figcaption></figure>`
    )
    .join("");
  writeFileSync(
    join(out, "index.html"),
    `<!doctype html><meta charset="utf-8"><title>renderer-next ${sha}</title><style>body{font:13px system-ui;margin:16px}figure{display:inline-block;margin:0 12px 16px 0}img{width:420px;border:1px solid #8884;display:block}</style><h1>renderer-next ${sha} — exit ${status}</h1>${cells}\n`
  );
  console.log(`screenshots-next: ${shots.length} captures in ${out}`);
  if (status !== 0) {
    console.error(`screenshots-next: ${failures.length} check(s) failed:`);
    for (const failure of failures) console.error(`  ${failure}`);
    process.exit(status);
  }
};

if (import.meta.url === `file://${process.argv[1]}`) await main();
