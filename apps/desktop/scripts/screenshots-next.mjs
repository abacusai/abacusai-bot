#!/usr/bin/env node
/**
 * Screenshots of renderer-next in the real Electron window (spec 01 §10.2):
 * every route at each width, light and dark, plus the gallery's overlay
 * examples, with axe (WCAG 2 A/AA) on each capture. No Playwright: Electron
 * with an isolated profile and the Chrome DevTools Protocol.
 *
 *   node scripts/screenshots-next.mjs [--no-build] [--widths 1280,900]
 *        [--routes /bots/new,/__ui?section=shell] [--no-overlays]
 *
 * Output: .build/screenshots/<git-sha>/<route-slug>@<W>-<theme>.png,
 * axe.json, and index.html (a contact sheet, light and dark side by side).
 *
 * Until spec 00 sub-slice B serves the db.* tables, the build uses the dev
 * fixture tables (VITE_NEXT_DB_FIXTURES=1): the canvas home as rows.
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

export const ROUTES = option(
  "--routes",
  [
    "/bots/new",
    "/bots/chief-of-staff",
    "/sessions/new",
    "/sessions/review-prs?tab=terminal",
    "/routines",
    "/routines/new",
    "/artifacts",
    "/library/connectors",
    "/settings/general",
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
          target.type === "page" && target.url.includes("index-next.html")
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

const launch = (width, scratch) => {
  const electron = join(
    repo,
    "node_modules/electron/dist",
    readFileSync(join(repo, "node_modules/electron/path.txt"), "utf8").trim()
  );
  const log = join(scratch, `electron-${width}.log`);
  const child = spawn(
    electron,
    [
      ".",
      `--remote-debugging-port=${PORT}`,
      "--disable-renderer-backgrounding",
      "--disable-backgrounding-occluded-windows",
      "--disable-background-timer-throttling",
    ],
    {
      cwd: desktop,
      env: {
        ...process.env,
        ABACUSAI_BOT_HOME: join(scratch, "home"),
        ABACUSAI_BOT_USERDATA: join(scratch, `ud-${width}`),
        ABACUSBOT_RENDERER_GENERATION: "wco",
        ABACUSBOT_DEV_CONTENT_SIZE: `${width}x${HEIGHT}`,
      },
      stdio: ["pipe", "pipe", "pipe"],
    }
  );
  const lines = [];
  child.stdout.on("data", (chunk) => lines.push(String(chunk)));
  child.stderr.on("data", (chunk) => lines.push(String(chunk)));
  child.on("exit", () => writeFileSync(log, lines.join("")));
  return child;
};

const settle = (cdp, href) =>
  cdp.evaluate(`window.__abacusDev.navigateAndSettle(${JSON.stringify(href)})`);

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
  mkdirSync(join(scratch, "home"), { recursive: true });
  const axeSource = readFileSync(
    require.resolve("axe-core/axe.min.js"),
    "utf8"
  );

  const shots = [];
  const axeReport = [];
  const failures = [];

  for (const width of WIDTHS) {
    const child = launch(width, scratch);
    try {
      const cdp = await connect(PORT);
      await cdp.send("Page.enable");
      // Wait for boot: the dev hooks exist once the router is mounted.
      for (let i = 0; i < 60; i += 1) {
        if (await cdp.evaluate("typeof window.__abacusDev === 'object'")) break;
        await sleep(500);
      }
      // A remembered bare settings route has no shell band until it is mounted.
      await settle(cdp, "/bots/new");
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
          await waitFor(
            cdp,
            `document.documentElement.classList.contains('dark') === ${theme === "dark"}`
          );
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
          const shot = await cdp.send("Page.captureScreenshot", {
            format: "png",
          });
          writeFileSync(join(out, name), Buffer.from(shot.data, "base64"));
          shots.push({ route, width, theme, file: name, geometry });

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

          const axe = await cdp.evaluate(
            `axe.run(document, { runOnly: ["wcag2a", "wcag2aa"] }).then((r) => r.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.slice(0, 5).map((n) => n.target.join(" ")) })))`
          );
          axeReport.push({ file: name, violations: axe });
          for (const violation of axe)
            if (violation.id === "color-contrast")
              failures.push(`${name}: contrast ${violation.nodes.join(", ")}`);
        }
      }
      cdp.close();
    } finally {
      child.kill("SIGKILL");
      await sleep(800);
    }
  }

  writeFileSync(
    join(out, "axe.json"),
    `${JSON.stringify(axeReport, null, 2)}\n`
  );
  writeFileSync(join(out, "shots.json"), `${JSON.stringify(shots, null, 2)}\n`);
  const rows = [
    ...new Set(shots.map((shot) => `${shot.route}|${shot.width}`)),
  ].map((key) => {
    const [route, width] = key.split("|");
    const cell = (theme) => {
      const shot = shots.find(
        (s) =>
          s.route === route && String(s.width) === width && s.theme === theme
      );
      return shot
        ? `<td><img src="${shot.file}" loading="lazy"><br>${theme}</td>`
        : "<td></td>";
    };
    return `<tr><th>${route}<br>${width}px</th>${cell("light")}${cell("dark")}</tr>`;
  });
  writeFileSync(
    join(out, "index.html"),
    `<!doctype html><meta charset="utf-8"><title>renderer-next ${sha}</title><style>body{font:13px system-ui;margin:16px}img{width:640px;border:1px solid #8884}th{text-align:left;vertical-align:top;padding-right:12px}</style><h1>renderer-next ${sha}</h1><table>${rows.join("")}</table>\n`
  );
  console.log(`screenshots-next: ${shots.length} captures in ${out}`);
  if (failures.length > 0) {
    console.error(`screenshots-next: ${failures.length} check(s) failed:`);
    for (const failure of failures) console.error(`  ${failure}`);
    process.exit(1);
  }
};

if (import.meta.url === `file://${process.argv[1]}`) await main();
