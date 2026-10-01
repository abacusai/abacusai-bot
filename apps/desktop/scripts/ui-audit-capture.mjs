#!/usr/bin/env node
/** Real Electron UI inventory. Build with VITE_UI_GALLERY=1 (no DB fixtures).
 * node apps/desktop/scripts/ui-audit-capture.mjs --source-home /private/home --out /private/ui-audit
 * --probe records private DOM/data diagnostics; --pass selects comma-separated
 * populated,empty,seeded,activity,interactions,notch,gallery passes.
 * --only-loading skips settled captures; --no-loading skips delayed loaders.
 * --routes filters route cases; --flows filters interactive states; --verify
 * checks existing PNG dimensions, indexing, and the four-way capture matrix.
 * Gallery builds use the repository fixture DB, then restore the live build.
 * Outputs may contain account data. Never commit them. The source home is hashed,
 * copied with cutover/perf-home, and checked again after every launch.
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import {
  homeManifest,
  copyPerfHome,
} from "../../../scripts/cutover/perf-home.mjs";

const repo = path.resolve(import.meta.dirname, "../../..");
const desktop = path.join(repo, "apps/desktop");
const commonDir = execFileSync("git", ["rev-parse", "--git-common-dir"], {
  cwd: repo,
  encoding: "utf8",
}).trim();
const mainRepo = path.dirname(path.resolve(repo, commonDir));
const args = process.argv.slice(2);
const opt = (key, fallback) =>
  args.includes(key) ? args[args.indexOf(key) + 1] : fallback;
const out = path.resolve(opt("--out", path.join(mainRepo, ".build/ui-audit")));
const shotsDir = path.join(out, "shots");
const source = opt(
  "--source-home",
  path.join(mainRepo, ".build/cutover/perf-home-real")
);
const port = Number(opt("--port", "9437"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const slug = (s) =>
  s
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
fs.mkdirSync(shotsDir, { recursive: true });
const reportPath = path.join(out, "inventory.json");
const report = fs.existsSync(reportPath)
  ? JSON.parse(fs.readFileSync(reportPath))
  : { shots: [], failures: [], notes: [] };
report.notes = [...new Set(report.notes)];
report.routeTree = fs
  .readdirSync(path.join(desktop, "src/renderer/routes"), { recursive: true })
  .filter(
    (file) => file.endsWith(".tsx") && !path.basename(file).startsWith("-")
  )
  .map((file) => {
    const code = fs.readFileSync(
      path.join(desktop, "src/renderer/routes", file),
      "utf8"
    );
    const id = code.match(/createFileRoute\(\s*["']([^"']+)["']/)?.[1];
    const route = id
      ? "/" +
        id
          .split("/")
          .filter(
            (part) =>
              part &&
              !(part.startsWith("_") && !part.startsWith("__")) &&
              !part.startsWith("(")
          )
          .map((part) => part.replace(/_$/, ""))
          .join("/")
      : "layout";
    return {
      file: "apps/desktop/src/renderer/routes/" + file,
      id: id ?? "root",
      route: route.replace(/\/$/, "") || "/",
    };
  })
  .sort((a, b) => a.file.localeCompare(b.file));
report.notes.push(
  "Settings panes are routes in the main shell on this branch; there is no separate Settings BrowserWindow."
);
let activeCleanup;
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => {
    activeCleanup?.();
    save();
    process.exit(130);
  });
function save() {
  report.notes = [...new Set(report.notes)];
  report.failures = [...new Set(report.failures)];
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  const cell = (s) =>
    String(s ?? "")
      .replaceAll("|", "\\|")
      .replaceAll("\n", " ");
  const counts = Object.entries(
    report.shots.reduce(
      (a, s) => ({ ...a, [s.area]: (a[s.area] ?? 0) + 1 }),
      {}
    )
  ).sort(([a], [b]) => a.localeCompare(b));
  fs.writeFileSync(
    path.join(out, "INDEX.md"),
    `# Desktop UI audit\n\nCaptured ${report.shots.length} PNGs. Live copied-home views and gallery examples are identified in the reach column.\n\n${report.notes.map((n) => `- ${n}`).join("\n")}\n\n| Area | PNGs |\n| --- | ---: |\n${counts.map(([area, count]) => `| ${area} | ${count} |`).join("\n")}\n\n| File | Route/flow | State | How reached |\n| --- | --- | --- | --- |\n${report.shots.map((s) => `| [${s.file}](shots/${s.file}) | ${cell(s.route)}${s.geometry?.href ? " (resolved " + cell(s.geometry.href) + ")" : ""} | ${cell(s.state)} | ${cell(s.reached)} |`).join("\n")}\n\n## Failed or missing coverage\n\n${report.failures.map((f) => `- ${cell(f)}`).join("\n") || "None recorded."}\n`
  );
  if (report.routeTree?.length) {
    const routeRows = report.routeTree.map((entry) => {
      if (entry.route === "layout")
        return `| ${entry.file} | Root/layout | Captured through child routes |`;
      const pattern = entry.route
        .split("/")
        .map((part) =>
          part.startsWith("$")
            ? "[^/]+"
            : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
        )
        .join("/");
      const expression = new RegExp("^" + pattern + "$");
      const count = report.shots.filter((shot) =>
        expression.test(
          (shot.route ?? "").split("?")[0].replace(/\/$/, "") || "/"
        )
      ).length;
      return `| ${entry.file} | ${entry.route} | ${count} PNGs |`;
    });
    fs.appendFileSync(
      path.join(out, "INDEX.md"),
      `\n## Route source inventory\n\nPathless layouts and redirecting index routes share child screens. Counts include settled and pending captures.\n\n| Source | Public route | Captures |\n| --- | --- | --- |\n${routeRows.join("\n")}\n`
    );
  }
}
export async function connect(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    clearTimeout(p.timer);
    if (m.error) p.reject(new Error(JSON.stringify(m.error)));
    else p.resolve(m.result);
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const key = ++id;
      const timer = setTimeout(() => {
        pending.delete(key);
        reject(new Error(`CDP timeout: ${method}`));
      }, 20000);
      pending.set(key, { resolve, reject, timer });
      ws.send(JSON.stringify({ id: key, method, params }));
    });
  const evaluate = async (expression) => {
    const r = await send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.exceptionDetails)
      throw new Error(
        r.exceptionDetails.exception?.description ?? r.exceptionDetails.text
      );
    return r.result.value;
  };
  return { send, evaluate, close: () => ws.close() };
}
async function targets() {
  return (await fetch(`http://127.0.0.1:${port}/json`)).json();
}
async function waitMain() {
  for (let i = 0; i < 120; i++) {
    try {
      const t = (await targets()).find(
        (t) => t.type === "page" && t.url.includes("index.html")
      );
      if (t) return connect(t);
    } catch {}
    await sleep(250);
  }
  throw new Error("No main renderer CDP target");
}
const read = (relative) =>
  fs.readFileSync(path.join(desktop, "src/renderer", relative), "utf8");
const quoted = (text) =>
  [...text.matchAll(/"([a-z][a-z0-9-]+)"/g)].map((m) => m[1]);
const steps = [
  "welcome",
  "connect",
  "connected",
  "models",
  "connectors",
  "first-bot",
  "done",
];
function galleryCases() {
  const sections = quoted(
    read("features/gallery/search.ts")
      .split("const ATOM_SECTIONS = [")[1]
      .split("] as const")[0]
  );
  const overlays = quoted(
    read("features/gallery/search.ts")
      .split("export const GALLERY_OVERLAY_IDS = [")[1]
      .split("] as const")[0]
  );
  const fixtures = [
    ...quoted(
      read("features/bots/gallery/sections.tsx")
        .split("const ids = [")[1]
        .split("] as const")[0]
    ),
    ...quoted(
      read("features/sessions/gallery/sections.tsx")
        .split("const IDS = [")[1]
        .split("] as const")[0]
    ),
    ...quoted(
      read("features/routines/gallery.tsx")
        .split("export const phase5FixtureIds = [")[1]
        .split("] as const")[0]
    ),
    ...steps.map((s) => "onboarding-" + s),
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
      ].map((state) => "notch-" + (mode === "plain" ? "" : mode + "-") + state)
    ),
    ...[...read("features/tour/stops.ts").matchAll(/id: "([^"]+)"/g)].map(
      (m) => "tour-" + m[1]
    ),
    ...[
      ...read("features/chat/fixtures/scenarios.ts")
        .split("export const SCENARIOS")[1]
        .matchAll(/id: "([a-z][a-z0-9-]+)",\s*canvas:/g),
    ].map((m) => m[1]),
  ];
  return [
    ...["tokens", ...sections, "shell", "occlusion", "motion"].map((s) => ({
      area: "gallery",
      state: s,
      route: `/__ui?section=${s}`,
    })),
    ...["tokens", ...sections, "shell", "occlusion", "motion"].map((s) => ({
      area: "gallery",
      state: s + "-bottom",
      route: `/__ui?section=${s}`,
      scrollBottom: true,
    })),
    ...overlays.map((s) => ({
      area: "overlays",
      state: s,
      route: `/__ui?section=${s}&open=${s}`,
    })),
    ...fixtures.map((s) => ({
      area: s.startsWith("onboarding-")
        ? "onboarding-gallery"
        : s.startsWith("tour-")
          ? "tour-gallery"
          : "gallery-fixtures",
      state: s,
      route: `/__ui?fixture=${s}`,
    })),
  ];
}
function prepareSeedHome(home) {
  const now = new Date().toISOString();
  const workspace = path.join(home, "audit-workspace");
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(
    path.join(workspace, "README.md"),
    "# UI audit sample workspace\n\nDisposable capture data.\n"
  );
  fs.writeFileSync(
    path.join(workspace, "sample.ts"),
    'export const greeting = "Hello UI audit";\n'
  );
  execFileSync("git", ["init", "-q"], { cwd: workspace });
  execFileSync("git", ["add", "."], { cwd: workspace });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=UI audit",
      "-c",
      "user.email=ui-audit@example.invalid",
      "commit",
      "-qm",
      "Sample",
    ],
    { cwd: workspace }
  );
  fs.appendFileSync(
    path.join(workspace, "sample.ts"),
    "export const changed = true;\n"
  );
  const file = path.join(home, "local-code.json");
  const data = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file)) : {};
  data.migrated_from_default_v1 = true;
  data.localCode ??= {};
  const botHome = path.join(home, "bot-home");
  fs.mkdirSync(botHome, { recursive: true });
  data.localCode.workspaces = [
    ...(data.localCode.workspaces ?? []),
    {
      id: "ui-audit-workspace",
      label: "UI audit workspace",
      path: workspace,
      description: "Disposable screenshot data",
      status: "ready",
      isRemote: false,
    },
  ];
  data.localCode.activeWorkspaceId = "ui-audit-workspace";
  data.localCode.workspaces.push({
    id: "ui-audit-bot-home",
    label: "Bot home",
    path: botHome,
    description: "",
    status: "ready",
    isRemote: false,
    kind: "bot",
  });
  data.localCode.agentSessions = [
    ...(data.localCode.agentSessions ?? []),
    ...["ui-audit-session", "ui-audit-bot-thread"].map((id) => ({
      id,
      workspaceId: "ui-audit-workspace",
      label:
        id === "ui-audit-session"
          ? "Very long session title " + "overflow ".repeat(40)
          : "UI audit bot conversation",
      conversationId: null,
      createdAt: now,
      updatedAt: now,
      status: "stopped",
      agentStatus: "idle",
      model: null,
      mode: "DEFAULT",
    })),
  ];
  data.localCode.agentSessions.find(
    (s) => s.id === "ui-audit-bot-thread"
  ).workspaceId = "ui-audit-bot-home";
  data.localCode.agentSessions.push({
    id: "ui-audit-sender-thread",
    workspaceId: "ui-audit-bot-home",
    label: "UI audit archived bot chat",
    conversationId: null,
    createdAt: now,
    updatedAt: now,
    status: "stopped",
    agentStatus: "idle",
    model: null,
    mode: "DEFAULT",
    owner: {
      kind: "bot",
      botId: "ui-audit-bot",
      role: "sender",
      key: "ui-audit-sender",
    },
  });
  data.localCode.sessionArtifacts = [
    ...(data.localCode.sessionArtifacts ?? []),
    ...["README.md", "sample.ts"].map((name, i) => ({
      id: "ui-audit-artifact-" + i,
      workspaceId: "ui-audit-workspace",
      sessionId: "ui-audit-session",
      kind: "file",
      title: i
        ? "Overflow artifact " + "long-title ".repeat(40)
        : "UI audit README",
      location: path.join(workspace, name),
      toolName: "write_file",
      createdAt: now,
      updatedAt: now,
    })),
  ];
  fs.writeFileSync(file, JSON.stringify(data));
  const botsFile = path.join(home, "bots.json");
  const bots = fs.existsSync(botsFile)
    ? JSON.parse(fs.readFileSync(botsFile))
    : [];
  for (const [id, name, sessionId] of [
    ["ui-audit-bot", "UI audit assistant", "ui-audit-bot-thread"],
    [
      "ui-audit-overflow",
      "Overflow stress: " +
        "A very long bot name without a short label ".repeat(8),
      null,
    ],
  ])
    bots.push({
      id,
      name,
      sessionId,
      title: "UI audit sample",
      description: "Disposable sample bot for reviewing the desktop UI.",
      persona: "",
      avatarColor: "#60a5fa",
      avatarShape: "blob",
      workspaceId: "ui-audit-bot-home",
      model: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  fs.writeFileSync(botsFile, JSON.stringify(bots));
  const messages = Array.from({ length: 1000 }, (_, i) => ({
    id: `audit-message-${i}`,
    role: i % 2 ? "assistant" : "user",
    parts: [
      {
        type: "text",
        content:
          i === 999
            ? "A long message " +
              "overflow-content ".repeat(500) +
              "\n\n```ts\n" +
              Array.from(
                { length: 20 },
                (_, j) => `export const identifier${j} = "${"x".repeat(500)}";`
              ).join("\n") +
              "\n```"
            : `Sample audit message ${i}.\n\nThis is disposable screenshot data.`,
      },
    ],
  }));
  fs.mkdirSync(path.join(home, "threads"), { recursive: true });
  for (const id of [
    "ui-audit-session",
    "ui-audit-bot-thread",
    "ui-audit-sender-thread",
  ])
    fs.writeFileSync(
      path.join(home, "threads", id + ".json"),
      JSON.stringify({
        version: 2,
        threadId: id,
        updatedAt: now,
        source: { kind: "agui" },
        runs: [],
        messages,
      })
    );
}
async function seed(cdp) {
  if (
    !(await cdp.evaluate(
      `__abacusDev.rows('bots').some(b=>b.id==='ui-audit-bot')`
    ))
  )
    throw new Error("Seeded bots did not load from the copied home");
  await cdp.evaluate(
    `__abacusDev.call('db.routines.insert',{id:'ui-audit-routine',name:'UI audit sample routine',prompt:'Review the disposable sample workspace.',workspaceId:'ui-audit-workspace'})`
  );
  report.notes.push(
    "Seeded pass uses disposable sample bots, sessions, artifacts, and 1,000-message transcripts written before launch. Original account content was preserved."
  );
}

async function liveCases(cdp, empty, seeded = false) {
  for (const route of ["/sessions/new", "/routines", "/artifacts", "/bots/new"])
    await navigate(cdp, route);
  const data = await cdp.evaluate(
    `Object.fromEntries(['bots','sessions','routines','artifacts','workspaces'].map(t=>[t,__abacusDev.rows(t)]))`
  );
  fs.writeFileSync(
    path.join(out, `private-${empty ? "empty" : "populated"}-rows.json`),
    JSON.stringify(data, null, 2)
  );
  if (!empty && !seeded)
    report.notes.push(
      "Copied signed-in home table counts: " +
        ["bots", "sessions", "routines", "artifacts"]
          .map((table) => `${table}=${data[table].length}`)
          .join(", ") +
        ". Populated examples are explicitly labeled as seeded or gallery states."
    );
  const cases = [];
  const add = (area, state, route) =>
    cases.push({ area, state: (seeded ? "seeded-" : "") + state, route });
  for (const [area, route] of [
    ["shell", "/"],
    ["bots", "/bots"],
    ["bots", "/bots/new"],
    ["sessions", "/sessions"],
    ["sessions", "/sessions/new"],
    ["routines", "/routines"],
    ["routines", "/routines/new"],
    ["artifacts", "/artifacts"],
    ["library", "/library"],
    ["settings", "/settings"],
  ])
    add(
      area,
      empty
        ? "fresh-" + (slug(route) || "root")
        : "populated-" + (slug(route) || "root"),
      route
    );
  for (const pane of [
    "general",
    "appearance",
    "notifications",
    "memory",
    "usage",
    "account",
    "models",
    "environment",
    "about",
    "browser",
    "devices",
    "language",
    "keyboard",
    "about/changelog",
  ])
    add("settings", (empty ? "fresh-" : "") + slug(pane), "/settings/" + pane);
  for (const section of ["connectors", "messaging", "mcp", "skills", "tools"])
    add("library", (empty ? "fresh-" : "") + section, "/library/" + section);
  if (empty) {
    for (const step of steps) add("onboarding", step, "/onboarding/" + step);
    add("onboarding", "index", "/onboarding");
  } else {
    const bot =
      data.bots.find((b) => b.id === "ui-audit-bot") ??
      data.bots.find((b) => !b.channel) ??
      data.bots[0];
    if (bot)
      for (const [state, suffix] of [
        ["idle", ""],
        ["editor", "/edit"],
        ["details", "/details"],
        ["check-in", "/check-in"],
      ])
        add("bots", state, `/bots/${bot.id}${suffix}`);
    if (bot)
      for (const tab of ["details", "memory", "files", "browser"])
        add("bots", "settings-" + tab, `/bots/${bot.id}?tab=${tab}`);
    if (seeded) add("bots", "overflow-name", "/bots/ui-audit-overflow");
    const long = data.sessions.reduce(
      (a, b) => ((b.messageCount ?? 0) > (a?.messageCount ?? 0) ? b : a),
      null
    );
    const session =
      data.sessions.find((s) => s.id === "ui-audit-session") ??
      data.sessions.find((s) => s.workspaceId) ??
      data.sessions[0];
    if (session) {
      for (const tab of ["chat", "changes", "device", "files", "agents"])
        add(
          "sessions",
          "workspace-" + tab,
          `/sessions/${session.id}?tab=${tab}`
        );
      add(
        "sessions",
        "full-view",
        `/sessions/${session.id}?view=full&tab=files`
      );
      add("sessions", "diff", `/sessions/${session.id}/diff?path=sample.ts`);
      add("sessions", "review", `/sessions/${session.id}/review`);
    }
    if (long)
      add(
        "sessions",
        "long-session",
        `/sessions/${seeded ? "ui-audit-session" : long.id}`
      );
    if (bot?.sessionId)
      add(
        "bots",
        "long-thread",
        `/bots/${bot.id}/chats/${seeded ? "ui-audit-sender-thread" : bot.sessionId}`
      );
    if (data.routines[0]) {
      add("routines", "detail", `/routines/${data.routines[0].id}`);
      add("routines", "editor", `/routines/${data.routines[0].id}/edit`);
    }
    if (data.artifacts[0])
      add(
        "artifacts",
        "viewer",
        `/artifacts?item=${encodeURIComponent(data.artifacts[0].id)}`
      );
  }
  add(
    "sessions",
    empty ? "fresh-workspace-missing" : "workspace-missing",
    "/sessions/ui-audit-missing"
  );
  add(
    "gallery-route",
    (empty ? "fresh-" : "") + "overview",
    "/__ui?section=tokens"
  );
  for (const id of [
    ...fs
      .readFileSync(path.join(desktop, "src/shared/toolsets.ts"), "utf8")
      .matchAll(/id: "([^"]+)"/g),
  ].map((m) => m[1]))
    add(
      "library",
      (empty ? "fresh-" : "") + "tools-" + slug(id),
      "/library/tools/" + id
    );
  return cases;
}
async function navigate(cdp, route) {
  await cdp.evaluate(`__abacusDev.navigate(${JSON.stringify(route)})`);
  for (let i = 0; i < 100; i++) {
    if (await cdp.evaluate("__abacusDev.idle()")) break;
    await sleep(100);
  }
  await sleep(300);
}
async function capture(cdp, c, size, theme, reached) {
  if (!c.state.endsWith("-pending"))
    await cdp.evaluate(
      `Promise.race([new Promise(r=>setTimeout(r,700)),Promise.all(document.getAnimations().filter(a=>a.playState==='running'&&a.effect?.getComputedTiming().endTime!==Infinity).map(a=>a.finished.catch(()=>undefined)))])`
    );
  const [width, height] = size;
  const file = `${c.area}--${c.state}--${width}x${height}--${theme}.png`;
  const geometry = await cdp.evaluate(
    `({width:innerWidth,height:innerHeight,href:location.hash,theme:document.documentElement.className,pending:!!document.querySelector('[data-testid="pending-pane"]'),shell:!!document.querySelector('[data-slot="shell"]'),scrollWidth:document.documentElement.scrollWidth,text:document.body.innerText.slice(0,2000),dockRects:[...document.querySelectorAll('[data-slot="session-dock"],[data-tab-header],canvas')].map(e=>({slot:e.getAttribute("data-slot"),tag:e.tagName,rect:e.getBoundingClientRect().toJSON()}))})`
  );
  if (geometry.width !== width || geometry.height !== height)
    throw new Error(`Wrong viewport ${geometry.width}x${geometry.height}`);
  const ratio = await cdp.evaluate("devicePixelRatio");
  const shot = await cdp.send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: false,
    clip: { x: 0, y: 0, width, height, scale: 1 / ratio },
  });
  const png = Buffer.from(shot.data, "base64");
  if (png.readUInt32BE(16) !== width || png.readUInt32BE(20) !== height)
    throw new Error("Screenshot PNG dimensions do not match requested size");
  fs.writeFileSync(path.join(shotsDir, file), png);
  const prefix = `${c.area} ${c.state} ${size.join("x")} ${theme}:`;
  const oldActivity =
    c.area === "bots" && c.state.startsWith("live-")
      ? `Live local-provider ${c.state.slice(5)} ${size.join("x")} ${theme}:`
      : null;
  const flowPrefix =
    c.area === "routines" && c.state === "connector-request"
      ? `Routine run/request ${size.join("x")} ${theme}:`
      : c.area === "updates"
        ? `Update banner ${size.join("x")} ${theme}:`
        : null;
  for (const failure of report.failures.filter(
    (f) =>
      f.startsWith(prefix) ||
      (oldActivity && f.startsWith(oldActivity)) ||
      (flowPrefix && f.startsWith(flowPrefix))
  ))
    report.notes.push("Resolved capture attempt: " + failure);
  report.failures = report.failures.filter(
    (f) =>
      !(
        f.startsWith(prefix) ||
        (oldActivity && f.startsWith(oldActivity)) ||
        (flowPrefix && f.startsWith(flowPrefix))
      )
  );
  if (
    c.area === "sessions" &&
    geometry.dockRects?.some(
      (e) => e.slot === null && e.tag === "DIV" && e.rect.width === 0
    )
  )
    report.failures.push(
      `${prefix} Dock tab header has zero width on this branch; PNG records the visible shell, not the hidden pane.`
    );
  if (
    c.state.endsWith("-pending") &&
    (!geometry.pending ||
      (!c.route.startsWith("/onboarding") &&
        !c.route.startsWith("/__ui") &&
        !geometry.shell))
  )
    report.failures.push(
      `${prefix} Pending capture must show the pending pane and shell navigation.`
    );
  if (geometry.scrollWidth > width)
    report.failures.push(
      `${prefix} Page exceeds the viewport by ${geometry.scrollWidth - width}px.`
    );
  report.shots = report.shots.filter((s) => s.file !== file);
  report.shots.push({
    file,
    area: c.area,
    state: c.state,
    route: c.route,
    reached,
    geometry,
  });
  save();
}
async function click(cdp, selector, button = "left") {
  const box = await cdp.evaluate(
    `(() => {const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw new Error('Missing click target '+${JSON.stringify(selector)});e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`
  );
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...box });
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    ...box,
    button,
    clickCount: 1,
  });
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    ...box,
    button,
    clickCount: 1,
  });
  await sleep(450);
}
async function clickText(cdp, text, selector = 'button,[role="menuitem"]') {
  const found = await cdp.evaluate(
    `(() => {const e=[...document.querySelectorAll(${JSON.stringify(selector)})].find(e=>(e.innerText??e.textContent).trim()===${JSON.stringify(text)}&&e.getBoundingClientRect().width>0);if(!e)return false;e.setAttribute('data-audit-target','true');return true;})()`
  );
  if (!found) throw new Error("Missing control " + text);
  try {
    await click(cdp, '[data-audit-target="true"]');
  } finally {
    await cdp.evaluate(
      `document.querySelector('[data-audit-target]')?.removeAttribute('data-audit-target')`
    );
  }
}
async function escape(cdp) {
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Escape",
    code: "Escape",
    windowsVirtualKeyCode: 27,
  });
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Escape",
    code: "Escape",
    windowsVirtualKeyCode: 27,
  });
  await sleep(200);
}
async function interactions(cdp, size, theme) {
  const shot = async (area, state, route, reached, action) => {
    if (opt("--flows") && !opt("--flows").split(",").includes(state)) return;
    try {
      if (route) await navigate(cdp, route);
      await action();
      await capture(
        cdp,
        { area, state, route: route ?? "current flow" },
        size,
        theme,
        reached
      );
    } catch (e) {
      report.failures.push(
        `${area} ${state} ${size.join("x")} ${theme}: ${e.message}`
      );
      save();
    } finally {
      await escape(cdp);
    }
  };
  await shot(
    "bots",
    "search",
    "/bots/new",
    "Click Search bots, type query with Input.insertText",
    async () => {
      await click(cdp, 'button[aria-label="Search bots"]');
      await cdp.send("Input.insertText", { text: "audit" });
    }
  );
  await shot(
    "bots",
    "dropdown-menu",
    "/bots/new",
    "Click bot row options",
    () => click(cdp, 'button[aria-label="Options for UI audit assistant"]')
  );
  await shot("bots", "context-menu", "/bots/new", "Right-click bot row", () =>
    click(cdp, '[data-bot-row="ui-audit-bot"] a', "right")
  );
  await shot(
    "bots",
    "delete-dialog",
    "/bots/new",
    "Open options, click Delete; leave confirmation unsubmitted",
    async () => {
      await click(cdp, 'button[aria-label="Options for UI audit assistant"]');
      await click(cdp, '[data-menu-item="delete"]');
    }
  );
  for (const area of ["bots", "sessions", "routines", "artifacts", "library"]) {
    await shot(
      "sidebar",
      area + "-collapsed",
      "/" + area,
      "Unpin sidebar using prefs API",
      async () => {
        await cdp.evaluate("__abacusDev.setPinned(false)");
        await cdp.send("Input.dispatchMouseEvent", {
          type: "mouseMoved",
          x: size[0] - 50,
          y: 300,
        });
        await sleep(600);
      }
    );
    await shot(
      "sidebar",
      area + "-flyout",
      "/" + area,
      "Unpinned sidebar; mouse hover over rail area",
      async () => {
        await cdp.evaluate("__abacusDev.setPinned(false)");
        const box = await cdp.evaluate(
          `(()=>{const e=[...document.querySelectorAll('a')].find(e=>e.innerText.trim()===${JSON.stringify(area[0].toUpperCase() + area.slice(1))})??document.querySelector('a[href*="#/${area}"]');const r=e?.getBoundingClientRect();return r?{x:r.x+r.width/2,y:r.y+r.height/2}:null})()`
        );
        if (!box) throw new Error("Rail link unavailable");
        await cdp.send("Input.dispatchMouseEvent", {
          type: "mouseMoved",
          ...box,
        });
        await sleep(900);
      }
    );
  }
  await cdp.evaluate("__abacusDev.setPinned(true)");
  await shot("command", "palette", "/bots/new", "Press Command K", async () => {
    await cdp.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "k",
      code: "KeyK",
      modifiers: 4,
      windowsVirtualKeyCode: 75,
    });
    await cdp.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "k",
      code: "KeyK",
      modifiers: 4,
      windowsVirtualKeyCode: 75,
    });
    await sleep(450);
    if (!(await cdp.evaluate(`!!document.querySelector('[role="dialog"]')`)))
      throw new Error("Palette did not open");
  });
  await shot(
    "toasts",
    "stack",
    "/__ui?section=toast",
    "Click shipped gallery toast example",
    () => click(cdp, '[data-testid="gallery-toasts"]')
  );
  await cdp.evaluate(
    `document.querySelectorAll('[data-slot="toast-close"]').forEach(e=>e.click())`
  );
  await sleep(600);
  for (const view of ["split", "full"])
    for (const kind of ["terminal", "browser"])
      await shot(
        "sessions",
        "workspace-" + kind + (view === "full" ? "-full" : ""),
        "/sessions/ui-audit-session?tab=files&view=" + view,
        "Open " +
          view +
          " workspace view; Add tab menu, select " +
          kind +
          ". Below 1100px the dock uses responsive full view.",
        async () => {
          await click(cdp, 'button[aria-label="Add tab"]');
          await clickText(cdp, kind[0].toUpperCase() + kind.slice(1));
          await sleep(3000);
        }
      );
  for (const [state, text] of [
    ["dock-right", "Split right"],
    ["dock-below", "Split below"],
  ])
    await shot(
      "sessions",
      state,
      "/sessions/ui-audit-session?tab=files",
      "Open dock pane menu, select " + text,
      async () => {
        await cdp.evaluate(
          `document.querySelector('button[data-tab-menu]')?.click()`
        );
        await sleep(450);
        await clickText(cdp, text);
      }
    );
  await shot(
    "routines",
    "history",
    "/routines/ui-audit-routine",
    "Scroll Runs history section into view",
    async () => {
      await cdp.evaluate(
        `(()=>{const e=[...document.querySelectorAll('h2')].find(e=>/Runs/.test(e.textContent));e?.scrollIntoView({block:'center'});return !!e;})()`
      );
    }
  );
  await shot(
    "routines",
    "run-report-missing",
    "/routines/ui-audit-routine?run=ui-audit-session",
    "Open a run report via route query; sample session is not a routine run",
    async () => {}
  );
  if (opt("--flows") && !opt("--flows").split(",").includes("tour")) return;
  try {
    await navigate(cdp, "/settings/general");
    await clickText(cdp, "Take the tour");
    const stops = [
      ...read("features/tour/stops.ts").matchAll(/id: "([^"]+)"/g),
    ].map((m) => m[1]);
    for (const stop of stops) {
      await sleep(600);
      await capture(
        cdp,
        { area: "tour", state: stop, route: "guided tour" },
        size,
        theme,
        "Click Take the tour in Settings; advance using Next"
      );
      if (stop !== stops.at(-1)) await clickText(cdp, "Next");
    }
  } catch (e) {
    report.failures.push(`Tour ${size.join("x")} ${theme}: ${e.message}`);
    save();
  } finally {
    await escape(cdp);
  }
}
async function notchCapture(main, size, theme, child) {
  child.stdin.write(JSON.stringify({ op: "window.focus", input: {} }) + "\n");
  await sleep(500);
  await main.evaluate(
    `__abacusDev.call('db.prefs.update',{patch:{notch:{enabled:true,idleVisible:true,showInNotch:true}}})`
  );
  await main.evaluate(`__abacusDev.call('notch.preview')`);
  await sleep(600);
  const target = (await targets()).find((t) => t.url.includes("notch.html"));
  if (!target) {
    report.failures.push("Notch companion CDP target unavailable");
    save();
    return;
  }
  const cdp = await connect(target);
  try {
    // Find the mounted real NotchShell by its context props. The audit changes
    // its local presentation state only; the real director sizes/places the OS
    // window. This permits deterministic attention/listening states without a
    // remote model run. No gallery document is substituted into the window.
    const findShell = `const e=document.querySelector('.notch-shape');let f=e?.[Object.keys(e).find(k=>k.startsWith('__reactFiber'))];while(f&&!f.memoizedProps?.context?.layout)f=f.return;if(!f)throw new Error('NotchShell fiber unavailable');const hooks=[];for(let h=f.memoizedState;h;h=h.next)hooks.push(h);`;
    const layout = await cdp.evaluate(
      `(()=>{${findShell}return f.memoizedProps.context.layout})()`
    );
    report.notes.push(
      `Native companion on display ${layout.displayId}, mode ${layout.mode}, measured notch ${layout.notch?.width}x${layout.notch?.height} CSS pixels. Companion presentation states are injected into the mounted real NotchShell for deterministic captures.`
    );
    if (layout.mode !== "notch")
      report.failures.push(
        `Native display ${layout.displayId} companion mode is ${layout.mode}, not notch`
      );
    const screens = execFileSync(
      "/usr/bin/swift",
      [
        "-e",
        'import AppKit; import CoreGraphics; for s in NSScreen.screens { let id = (s.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as! NSNumber).uint32Value; if CGDisplayIsBuiltin(id) != 0 { print("\\(id) \\(s.frame.width) \\(s.frame.height)") } }',
      ],
      { encoding: "utf8" }
    )
      .trim()
      .split(/\s+/)
      .map(Number);
    await sleep(3100);
    const sessionId = await main.evaluate(
      `__abacusDev.rows('bots').find(b=>b.id==='ui-audit-bot')?.sessionId`
    );
    for (const state of [
      "collapsed",
      "hover-expanded",
      "reply",
      "attention",
      "listening",
    ]) {
      const route =
        state === "reply"
          ? "/reply/$id"
          : state === "listening"
            ? "/call"
            : state === "attention"
              ? "/failed"
              : "/idle";
      const attention =
        state === "attention"
          ? {
              kind: "failed",
              sessionId,
              since: Date.now(),
              botId: "ui-audit-bot",
              errorCode: "UI_AUDIT_SAMPLE",
              runId: "audit-run",
            }
          : null;
      const p = {
        route,
        sessionId:
          state === "collapsed" || state === "hover-expanded"
            ? null
            : sessionId,
        identity: "audit-" + state,
        faces: [
          {
            botId: "ui-audit-bot",
            mood: state === "attention" ? "blocked" : "idle",
          },
        ],
        remaining: 0,
        expanded: !["collapsed", "attention"].includes(state),
        hidden: false,
        quietUntil: null,
        attention,
        queue: attention ? [attention] : [],
      };
      await cdp.evaluate(
        `(()=>{${findShell}const app=hooks.find(h=>h.queue?.dispatch&&h.memoizedState&&typeof h.memoizedState.mainFocused==='boolean');app?.queue.dispatch({mainFocused:false});const index=hooks.findLastIndex(h=>h.queue?.dispatch&&h.memoizedState?.route&&h.memoizedState?.identity);if(index<0)throw new Error('Presentation hook unavailable');const manual=hooks.slice(0,index).reverse().find(h=>h.queue?.dispatch);if(!manual)throw new Error('Manual hook unavailable');manual.queue.dispatch(${JSON.stringify(p)});return true;})()`
      );
      await sleep(state === "listening" ? 250 : 1000);
      await cdp.evaluate(
        `(()=>{${findShell}return f.memoizedProps.context.transport.client.notch.focus({focus:true})})()`
      );
      await sleep(200);
      const file = `notch--${state}--${size.join("x")}--${theme}.png`;
      let reached =
        "Real companion window; local presentation injection; screencapture -x -R of the built-in display top-centre region, downsampled to requested PNG dimensions";
      try {
        const x = Math.round((screens[1] - size[0]) / 2);
        execFileSync(
          "/usr/sbin/screencapture",
          [
            "-x",
            "-R",
            `${x},0,${size[0]},${size[1]}`,
            path.join(shotsDir, file),
          ],
          { stdio: "pipe" }
        );
        execFileSync(
          "/usr/bin/sips",
          ["-z", String(size[1]), String(size[0]), path.join(shotsDir, file)],
          { stdio: "pipe" }
        );
      } catch (e) {
        report.failures.push(
          `Screen Recording/native notch capture ${state}: ${String(e.stderr ?? e.message).slice(0, 500)}. Captured companion page over CDP instead; physical screen relation unavailable.`
        );
        const ratio = await cdp.evaluate("devicePixelRatio");
        const shot = await cdp.send("Page.captureScreenshot", {
          format: "png",
          captureBeyondViewport: true,
          clip: {
            x: 0,
            y: 0,
            width: size[0],
            height: size[1],
            scale: 1 / ratio,
          },
        });
        fs.writeFileSync(
          path.join(shotsDir, file),
          Buffer.from(shot.data, "base64")
        );
        reached =
          "Screen Recording/native capture failed; real companion document via CDP; local presentation injection";
      }
      if (
        c.state.endsWith("-pending") &&
        (!geometry.pending ||
          (!c.route.startsWith("/onboarding") &&
            !c.route.startsWith("/__ui") &&
            !geometry.shell))
      )
        report.failures.push(
          `${prefix} Pending capture must show the pending pane and shell navigation.`
        );
      if (geometry.scrollWidth > width)
        report.failures.push(
          `${prefix} Page exceeds the viewport by ${geometry.scrollWidth - width}px.`
        );
      report.shots = report.shots.filter((s) => s.file !== file);
      report.shots.push({ file, area: "notch", state, route, reached });
      save();
      const ownFile = `notch-page--${state}--${size.join("x")}--${theme}.png`;
      const ratio = await cdp.evaluate("devicePixelRatio");
      const own = await cdp.send("Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: true,
        clip: { x: 0, y: 0, width: size[0], height: size[1], scale: 1 / ratio },
      });
      fs.writeFileSync(
        path.join(shotsDir, ownFile),
        Buffer.from(own.data, "base64")
      );
      report.shots = report.shots.filter((s) => s.file !== ownFile);
      report.shots.push({
        file: ownFile,
        area: "notch-page",
        state,
        route,
        reached:
          "Real companion page via CDP, padded capture clip; supplements native screen crop when other apps overlap the display",
        geometry: await cdp.evaluate(
          `({width:innerWidth,height:innerHeight,text:document.body.innerText.slice(0,700)})`
        ),
      });
      save();
      if (state === "listening") await escape(cdp);
    }
  } finally {
    cdp.close();
  }
}
async function activity(cdp, provider, size, theme) {
  for (const state of ["streaming", "tool-activity", "error"]) {
    const botId = "ui-audit-" + state;
    try {
      await navigate(cdp, "/bots/" + botId);
      const threadId = await cdp.evaluate(
        `__abacusDev.rows('bots').find(b=>b.id===${JSON.stringify(botId)})?.sessionId`
      );
      if (!threadId) throw new Error("Bot did not open a conversation");
      const session = `__abacusDev.chat.session(${JSON.stringify(threadId)})`;
      await cdp.evaluate(
        `${session}.submit(${JSON.stringify("UI audit " + state)})`
      );
      let observed = false;
      for (let i = 0; i < 100; i++) {
        const text = await cdp.evaluate("document.body.innerText");
        if (
          state === "streaming" &&
          text.includes("Streaming audit response")
        ) {
          observed = true;
          break;
        }
        if (
          state === "tool-activity" &&
          /sleep 12|Running.*tool|bash/i.test(text)
        ) {
          observed = true;
          break;
        }
        if (state === "error" && /UI audit provider failure/.test(text)) {
          observed = true;
          break;
        }
        await sleep(150);
      }
      if (!observed) throw new Error("Expected live state did not appear");
      await capture(
        cdp,
        { area: "bots", state: "live-" + state, route: "/bots/" + botId },
        size,
        theme,
        "Real agent process and renderer, with repo test-support localhost OpenAI-compatible provider; disposable sample data"
      );
      await cdp.evaluate(`${session}.cancel()`);
      await sleep(700);
    } catch (e) {
      report.failures.push(
        `Live local-provider ${state} ${size.join("x")} ${theme}: ${e.message}`
      );
      save();
    }
  }
  try {
    await navigate(cdp, "/routines/ui-audit-routine");
    await cdp.evaluate(
      `__abacusDev.call('routines.run',{id:'ui-audit-routine',trigger:'manual'})`
    );
    await sleep(1000);
    await capture(
      cdp,
      {
        area: "routines",
        state: "live-history",
        route: "/routines/ui-audit-routine",
      },
      size,
      theme,
      "Run sample routine through real routine service with localhost provider"
    );
    const run = await cdp.evaluate(
      `__abacusDev.rows('routineRuns').find(r=>r.routineId==='ui-audit-routine')`
    );
    if (!run) throw new Error("Routine run row did not appear");
    await navigate(cdp, "/routines/ui-audit-routine?run=" + run.sessionId);
    const injected = await cdp.evaluate(
      `(()=>{const e=document.querySelector('[data-slot="topbar"]')??document.querySelector('#root>div');let f=e?.[Object.keys(e).find(k=>k.startsWith('__reactFiber'))];while(f?.return)f=f.return;const stack=[f];while(stack.length){const n=stack.pop();if(!n)continue;if(n.memoizedProps?.sessionId===${JSON.stringify(run.sessionId)}&&typeof n.memoizedProps.connect==='function'&&typeof n.memoizedProps.cancel==='function'){let h=n.memoizedState;while(h){if(h.queue?.dispatch&&Array.isArray(h.memoizedState)){h.queue.dispatch([{requestId:'ui-audit-connect',connectorId:'abacus-slack',label:'Slack',reason:'UI audit sample connector request',conversationKey:JSON.stringify({version:1,kind:'session',workspaceId:n.memoizedProps.workspaceId,sessionId:n.memoizedProps.sessionId})}]);return true;}h=h.next;}}if(n.child)stack.push(n.child);if(n.sibling)stack.push(n.sibling);}return false;})()`
    );
    if (!injected)
      throw new Error(
        "RunRequests exists as a component but is not mounted by production routes on this branch"
      );
    await sleep(400);
    await capture(
      cdp,
      {
        area: "routines",
        state: "connector-request",
        route: "/routines/ui-audit-routine?run=" + run.sessionId,
      },
      size,
      theme,
      "Real routine report; local RunRequests state populated with a sample Slack request; no connection submitted"
    );
  } catch (e) {
    report.failures.push(
      `Routine run/request ${size.join("x")} ${theme}: ${e.message}`
    );
    save();
  }
}
async function updateCapture(cdp, size, theme) {
  await navigate(cdp, "/settings/about");
  const setStatus = async (status) =>
    cdp.evaluate(
      `(()=>{const e=document.querySelector('[data-slot="topbar"]')??document.querySelector('#root>div');let f=e?.[Object.keys(e).find(k=>k.startsWith('__reactFiber'))];while(f?.return)f=f.return;const stack=[f];let count=0;while(stack.length){const n=stack.pop();if(!n)continue;for(let h=n.memoizedState;h;h=h.next)if(h.queue?.dispatch&&typeof h.memoizedState?.checking==='boolean'&&typeof h.memoizedState?.downloaded==='boolean'){h.queue.dispatch(${JSON.stringify(status)});count++;}if(n.child)stack.push(n.child);if(n.sibling)stack.push(n.sibling);}return count;})()`
    );
  const status = {
    checking: false,
    available: true,
    downloading: false,
    downloaded: true,
    installing: false,
    error: null,
    progress: null,
    updateInfo: { version: "9.9.9" },
    installStalled: false,
    criticalUpdate: false,
    failedPhase: null,
  };
  try {
    if (!(await setStatus(status)))
      throw new Error("Mounted update-status state unavailable");
    await sleep(500);
    await capture(
      cdp,
      { area: "updates", state: "ready-banner", route: "/settings/about" },
      size,
      theme,
      "Injected sample update status into mounted real components; no install clicked"
    );
    await setStatus({
      ...status,
      installStalled: true,
      error: "UI audit sample install stall",
      failedPhase: "install",
    });
    await sleep(500);
    await capture(
      cdp,
      { area: "updates", state: "stalled-banner", route: "/settings/about" },
      size,
      theme,
      "Injected stalled-update status into mounted real components"
    );
  } catch (e) {
    report.failures.push(
      `Update banner ${size.join("x")} ${theme}: ${e.message}`
    );
    save();
  } finally {
    await setStatus({
      ...status,
      available: false,
      downloaded: false,
      installStalled: false,
    });
  }
}
async function run(pass, size) {
  const require = createRequire(import.meta.url);
  const electron = require("electron");
  if (
    await fetch(`http://127.0.0.1:${port}/json`)
      .then(() => true)
      .catch(() => false)
  )
    throw new Error(`Debugging port ${port} is already in use`);
  const manifest = homeManifest(source);
  const copy = pass === "empty" ? null : copyPerfHome(source, manifest);
  const root = copy?.root ?? fs.mkdtempSync(path.join(out, "scratch-empty-"));
  const home = copy?.home ?? path.join(root, "home");
  fs.mkdirSync(home, { recursive: true });
  if (["seeded", "interactions", "notch", "activity"].includes(pass))
    prepareSeedHome(home);
  let provider;
  if (pass === "activity") {
    const { stripTypeScriptTypes } = await import("node:module");
    const support = path.join(out, "support");
    fs.mkdirSync(support, { recursive: true });
    const modulePath = path.join(support, "fake-provider.mjs");
    fs.writeFileSync(
      modulePath,
      stripTypeScriptTypes(
        fs.readFileSync(
          path.join(repo, "packages/test-support/src/fake-provider.ts"),
          "utf8"
        ),
        { mode: "transform" }
      )
    );
    const { FakeProvider, fakeProviderConfig } = await import(modulePath);
    provider = await FakeProvider.start();
    provider.script((call) => {
      const user = call.userText.at(-1) ?? "";
      if (user.includes("streaming"))
        return {
          stall: { say: "Streaming audit response, still generating..." },
        };
      if (user.includes("error"))
        return { fail: { status: 400, message: "UI audit provider failure" } };
      if (
        user.includes("tool-activity") &&
        !call.messages
          .slice(call.messages.findLastIndex((m) => m.role === "user") + 1)
          .some((m) => m.role === "tool")
      )
        return {
          say: "Running a disposable audit command.",
          call: {
            name: "bash",
            args: { command: 'sleep 12; printf "audit tool result\\n"' },
          },
        };
      return { say: "Audit command completed." };
    });
    fs.writeFileSync(
      path.join(home, "config.json"),
      fakeProviderConfig(provider)
    );
    const bots = JSON.parse(fs.readFileSync(path.join(home, "bots.json")));
    const local = JSON.parse(
      fs.readFileSync(path.join(home, "local-code.json"))
    );
    const now = new Date().toISOString();
    for (const state of ["streaming", "tool-activity", "error"]) {
      const id = "ui-audit-" + state,
        threadId = id + "-thread";
      bots.push({
        ...bots.find((b) => b.id === "ui-audit-bot"),
        id,
        name: "UI audit " + state,
        sessionId: threadId,
        model: "fake/fake-1",
      });
      local.localCode.agentSessions.push({
        id: threadId,
        workspaceId: "ui-audit-bot-home",
        label: state,
        conversationId: null,
        createdAt: now,
        updatedAt: now,
        status: "stopped",
        agentStatus: "idle",
        model: "fake/fake-1",
        mode: "YOLO",
      });
      fs.writeFileSync(
        path.join(home, "threads", threadId + ".json"),
        JSON.stringify({
          version: 2,
          threadId,
          updatedAt: now,
          source: { kind: "agui" },
          messages: [],
        })
      );
    }
    fs.writeFileSync(path.join(home, "bots.json"), JSON.stringify(bots));
    fs.writeFileSync(path.join(home, "local-code.json"), JSON.stringify(local));
    report.notes.push(
      "Live streaming, tool activity, and provider error use the real agent process with the repository FakeProvider on localhost. No external model inference is required."
    );
  }
  const log = fs.openSync(
    path.join(out, `electron-${pass}-${size.join("x")}.log`),
    "w"
  );
  const env = {
    ...process.env,
    ABACUSAI_BOT_HOME: home,
    ABACUSAI_BOT_BASE: home,
    ABACUSAI_BOT_USERDATA: path.join(root, "userdata"),
    ABACUSBOT_RENDERER_GENERATION: "wco",
    ABACUSBOT_DEV_CONTENT_SIZE: size.join("x"),
    ABACUSBOT_DEV_HARNESS: "1",
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electron, [desktop, `--remote-debugging-port=${port}`], {
    env,
    stdio: ["pipe", log, log],
    detached: true,
  });
  const cleanup = () => {
    const rows = execFileSync("ps", ["-axo", "pid=,ppid=,command="], {
      encoding: "utf8",
    })
      .split("\n")
      .map((row) => {
        const match = row.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
        return match
          ? {
              pid: Number(match[1]),
              parent: Number(match[2]),
              command: match[3],
            }
          : null;
      })
      .filter(Boolean);
    const owned = new Set([child.pid]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const row of rows)
        if (owned.has(row.parent) && !owned.has(row.pid)) {
          owned.add(row.pid);
          changed = true;
        }
    }
    for (const row of rows.reverse())
      if (
        owned.has(row.pid) ||
        (row.command.includes(root) &&
          /Electron|chrome_crashpad_handler/.test(row.command))
      ) {
        try {
          process.kill(row.pid, "SIGKILL");
        } catch {}
      }
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {}
    copy?.dispose();
    if (!copy) fs.rmSync(root, { recursive: true, force: true });
  };
  activeCleanup = cleanup;
  let cdp;
  try {
    cdp = await waitMain();
    await cdp.send("Page.enable");
    for (let i = 0; i < 120; i++) {
      if (await cdp.evaluate("!!window.__abacusDev")) break;
      await sleep(250);
    }
    if (pass !== "gallery" && (await cdp.evaluate("__abacusDev.fixtures")))
      throw new Error("Refusing fixture DB build for live pass");
    if (pass === "gallery")
      report.notes.push(
        "Gallery captures use repository component scenarios. The gallery pass may use the synthetic fixture DB; live passes explicitly refuse it."
      );
    await navigate(cdp, pass === "empty" ? "/onboarding/welcome" : "/bots/new");
    if (["seeded", "interactions", "notch", "activity"].includes(pass))
      await seed(cdp, home);
    let cases = ["interactions", "notch", "activity"].includes(pass)
      ? []
      : pass === "gallery"
        ? galleryCases()
        : await liveCases(cdp, pass === "empty", pass === "seeded");
    if (opt("--routes")) {
      const selected = opt("--routes").split(",");
      cases = cases.filter((c) => selected.includes(c.route));
    }
    if (args.includes("--only-gallery-bottom"))
      cases = cases.filter((c) => c.scrollBottom);
    if (args.includes("--probe")) {
      if (opt("--probe-route")) await navigate(cdp, opt("--probe-route"));
      if (opt("--probe-click")) await click(cdp, opt("--probe-click"));
      fs.writeFileSync(
        path.join(out, `probe-${pass}.json`),
        JSON.stringify(
          await cdp.evaluate(
            `({buttons:[...document.querySelectorAll('button,[role="menuitem"]')].map(b=>({text:b.innerText,label:b.getAttribute('aria-label'),title:b.title})),body:document.body.innerText,targets:location.href})`
          ),
          null,
          2
        )
      );
      return;
    }
    for (const theme of ["dark", "light"]) {
      await cdp.evaluate(`__abacusDev.setTheme('${theme}')`);
      await sleep(100);
      if (pass === "interactions") await interactions(cdp, size, theme);
      if (pass === "notch")
        await notchCapture(cdp, size, theme, child).catch((e) => {
          report.failures.push(
            `Native notch sequence ${size.join("x")} ${theme}: ${e.message}`
          );
          save();
        });
      if (pass === "activity") await activity(cdp, provider, size, theme);
      if (pass === "activity") await updateCapture(cdp, size, theme);
      if (!args.includes("--only-loading"))
        for (const c of cases) {
          try {
            await navigate(cdp, c.route);
            await cdp.evaluate(
              `document.querySelector('[data-testid="gallery"]')?.scrollTo({top:${c.scrollBottom ? "100000" : "0"}})`
            );
            await sleep(100);
            await capture(
              cdp,
              c,
              size,
              theme,
              pass === "gallery"
                ? "Gallery example using shipped components; not a live populated flow" +
                    (c.scrollBottom
                      ? "; scroll main gallery region to bottom"
                      : "")
                : pass === "empty"
                  ? "Direct dev-hook navigation on a fresh empty home"
                  : pass === "seeded"
                    ? "Direct dev-hook navigation on copied logged-in home with disposable sample records and transcripts"
                    : "Direct dev-hook navigation on a hash-verified copy of logged-in home"
            );
          } catch (e) {
            report.failures.push(
              `${pass} ${c.route} ${size.join("x")} ${theme}: ${e.message}`
            );
            save();
          }
        }
      if (pass !== "gallery" && !args.includes("--no-loading"))
        for (const c of cases) {
          try {
            await navigate(
              cdp,
              c.route.startsWith("/__ui")
                ? "/bots/new"
                : "/__ui?section=skeleton"
            );
            await cdp.evaluate(
              `__abacusDev.setLoaderDelay(600);void __abacusDev.navigate(${JSON.stringify(c.route)});true`
            );
            await sleep(300);
            await capture(
              cdp,
              { ...c, state: c.state + "-pending" },
              size,
              theme,
              "Dev beforeLoad delayed 600 ms per entering route; captured after 300 ms"
            );
            await cdp.evaluate("__abacusDev.setLoaderDelay(0)");
            for (let i = 0; i < 120; i++) {
              if (await cdp.evaluate("__abacusDev.idle()")) break;
              await sleep(100);
            }
          } catch (e) {
            await cdp.evaluate("__abacusDev.setLoaderDelay(0)").catch(() => {});
            report.failures.push(`Pending ${c.route}: ${e.message}`);
            save();
          }
        }
      console.log(
        `${pass} ${size.join("x")} ${theme}: ${report.shots.length} total captures`
      );
    }
  } finally {
    cdp?.close();
    cleanup();
    activeCleanup = undefined;
    fs.closeSync(log);
    await sleep(400);
    await provider?.close();
    assertHomeUnchanged(source, manifest);
    save();
  }
}
function assertHomeUnchanged(home, manifest) {
  if (JSON.stringify(homeManifest(home)) !== JSON.stringify(manifest))
    throw new Error("Source home changed during capture");
}
function verifyInventory() {
  const groups = new Map();
  const indexed = new Set();
  for (const shot of report.shots) {
    indexed.add(shot.file);
    const match = shot.file.match(/--(\d+)x(\d+)--(dark|light)\.png$/);
    const file = path.join(shotsDir, shot.file);
    const png = fs.readFileSync(file);
    if (
      !match ||
      png.readUInt32BE(16) !== Number(match[1]) ||
      png.readUInt32BE(20) !== Number(match[2])
    )
      throw new Error("Wrong PNG dimensions: " + shot.file);
    const key = shot.area + "--" + shot.state;
    if (!groups.has(key)) groups.set(key, new Set());
    groups.get(key).add(match.slice(1).join(":"));
  }
  for (const [group, values] of groups)
    if (values.size !== 4)
      report.failures.push(
        "Incomplete size/theme matrix: " + group + " (" + values.size + "/4)"
      );
  for (const file of fs.readdirSync(shotsDir))
    if (file.endsWith(".png") && !indexed.has(file))
      report.failures.push("Unindexed screenshot: " + file);
  save();
  console.log(
    "Verified " +
      report.shots.length +
      " PNGs, " +
      groups.size +
      " states; " +
      report.failures.length +
      " recorded failures."
  );
}
if (import.meta.url === `file://${process.argv[1]}`) {
  if (args.includes("--verify")) {
    verifyInventory();
    process.exit(0);
  }
  const passes = opt(
    "--pass",
    "populated,empty,seeded,activity,interactions,notch,gallery"
  ).split(",");
  const sizes = opt("--sizes", "1440x900,960x640")
    .split(",")
    .map((s) => s.split("x").map(Number));
  const buildGallery = (fixtures) =>
    execFileSync(path.join(repo, "node_modules/.bin/vite"), ["build"], {
      cwd: desktop,
      stdio: "inherit",
      env: {
        ...process.env,
        VITE_UI_GALLERY: "1",
        VITE_NEXT_DB_FIXTURES: fixtures ? "1" : "0",
      },
    });
  for (const pass of passes) {
    const rebuild = pass === "gallery" && !args.includes("--no-gallery-build");
    if (rebuild) buildGallery(true);
    try {
      for (const size of sizes) await run(pass, size);
    } finally {
      if (rebuild) buildGallery(false);
    }
  }
  console.log(
    `Inventory: ${report.shots.length} screenshots; ${report.failures.length} failures; ${path.join(out, "INDEX.md")}`
  );
}
