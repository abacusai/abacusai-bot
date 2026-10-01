/** R5 native performance, sound and real-layout axe: real main + loopback provider, isolated profile, CDP.
 * Run after VITE_UI_GALLERY=1 vite build (no DB fixtures):
 * node --experimental-transform-types e2e/phase5-real.mjs
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { FakeProvider } from "../../../packages/test-support/src/fake-provider.ts";
const desktop = resolve(import.meta.dirname, "..");
const repo = resolve(desktop, "../..");
const port = Number(process.env.ABACUSBOT_PHASE5_CDP_PORT ?? 9475);
const canvasWidth = Number(process.env.ABACUSBOT_PHASE5_TEST_WIDTH ?? 1280);
const scratch = mkdtempSync(join(tmpdir(), "phase5-real-"));
const home = join(scratch, "home");
mkdirSync(home);
mkdirSync(join(home, "gallery"));
writeFileSync(
  join(home, "gallery/image.png"),
  readFileSync(join(desktop, "src/renderer/assets/icon2.png"))
);

const provider = await FakeProvider.start();
const requests = [];
provider.server.on("request", (request) => {
  let body = "";
  request.on("data", (chunk) => (body += chunk));
  request.on("end", () => {
    try {
      requests.push(JSON.parse(body).model);
    } catch {}
  });
});
const mcpScript = join(scratch, "mcp.mjs");
writeFileSync(
  mcpScript,
  `import readline from 'node:readline';const input=readline.createInterface({input:process.stdin});input.on('line',line=>{const request=JSON.parse(line);if(request.id==null)return;const result=request.method==='initialize'?{protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'phase5-native',version:'1'}}:request.method==='tools/list'?{tools:[{name:'ping',description:'Native test ping',inputSchema:{type:'object',properties:{}}}]}:{};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result})+'\\n');});`
);
provider.script(async (call) => {
  const last = call.messages.at(-1);
  const text =
    call.userText.find((text) =>
      text.includes("You are the editor for the routine")
    ) ??
    call.userText.at(-1) ??
    "";
  if (
    last?.role === "user" &&
    text.includes("You are the editor for the routine")
  ) {
    const id = text.match(/\(id ([^)]+)\)/)?.[1];
    assert(id);
    return {
      call: {
        name: "cronjob",
        args: { action: "update", id, schedule: "0 7 * * *" },
      },
    };
  }
  if (last?.role === "user" && text.includes("phase5-report"))
    return {
      call: {
        name: "write",
        args: {
          path: "phase5-report.md",
          content: "# Phase five report\nNative integration artifact.\n",
        },
      },
    };
  return { say: "Phase five integration reply" };
});
writeFileSync(
  join(home, "config.json"),
  JSON.stringify({
    defaultModel: "fake/fake-1",
    defaultMode: "YOLO",
    customProviders: [
      {
        id: "fake",
        name: "Integration provider",
        baseUrl: provider.baseUrl,
        apiKey: "test-key",
        models: [
          { id: "fake-1", name: "Integration One", contextWindow: 131072 },
          { id: "fake-2", name: "Integration Two", contextWindow: 131072 },
        ],
      },
    ],
  })
);
const electron = join(
  repo,
  "node_modules/electron/dist",
  readFileSync(join(repo, "node_modules/electron/path.txt"), "utf8").trim()
);
const environment = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.endsWith("_API_KEY"))
);
const child = spawn(electron, [".", `--remote-debugging-port=${port}`], {
  cwd: desktop,
  env: {
    ...environment,
    ABACUSAI_BOT_HOME: home,
    ABACUSAI_BOT_USERDATA: join(scratch, "userdata"),
    ABACUSBOT_RENDERER_GENERATION: "wco",
    ABACUSBOT_DEV_CONTENT_SIZE: `${canvasWidth}x800`,
    ABACUSBOT_DEV_HARNESS: "1",
  },
  stdio: ["pipe", "pipe", "pipe"],
});
let output = "";
child.stdout.on("data", (chunk) => (output += chunk));
child.stderr.on("data", (chunk) => (output += chunk));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let ws;
const checks = [];
checks.push = (...values) => {
  console.log(values.join("; "));
  return Array.prototype.push.apply(checks, values);
};
try {
  let page;
  for (let i = 0; i < 600 && !page; i++) {
    try {
      page = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find(
        (p) => p.type === "page" && p.url.includes("index-next.html")
      );
    } catch {}
    if (!page) await sleep(100);
  }
  assert(page, "renderer-next appeared");
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  const frames = [];
  let recording = null;
  let id = 0;
  const pending = new Map();
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.method === "Page.screencastFrame") {
      if (recording)
        frames.push({
          width: recording,
          data: msg.params.data,
          timestamp: msg.params.metadata.timestamp,
        });
      void send("Page.screencastFrameAck", { sessionId: msg.params.sessionId });
      return;
    }
    const waiter = pending.get(msg.id);
    if (!waiter) return;
    pending.delete(msg.id);
    if (msg.error) waiter.reject(new Error(JSON.stringify(msg.error)));
    else waiter.resolve(msg.result);
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      pending.set(++id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression) => {
    const result = await Promise.race([
      send("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
      }),
      new Promise((_, reject) =>
        setTimeout(
          () =>
            reject(
              new Error(`Evaluation timeout: ${expression.slice(0, 120)}`)
            ),
          25000
        )
      ),
    ]);
    if (result.exceptionDetails)
      throw new Error(
        result.exceptionDetails.exception?.description ??
          result.exceptionDetails.text
      );
    return result.result.value;
  };
  const wait = async (expression) => {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      if (await evaluate(expression)) return;
      await sleep(50);
    }
    throw new Error(`Timed out: ${expression}`);
  };
  const navigate = (href) =>
    evaluate(`window.__abacusDev.navigate(${JSON.stringify(href)})`);
  const clickText = (text) =>
    evaluate(
      `(()=>{const buttons=[...(document.querySelector('[role=alertdialog]')??document.querySelector('[role=dialog]')??document).querySelectorAll('button')];const element=buttons.find(b=>b.textContent.trim()===${JSON.stringify(text)})??buttons.find(b=>b.textContent.trim().startsWith(${JSON.stringify(text)}));if(!element)throw new Error('No button '+${JSON.stringify(text)});element.click();})()`
    );
  const enter = async (selector, text) => {
    await evaluate(
      `document.querySelector(${JSON.stringify(selector)}).focus()`
    );
    await send("Input.insertText", { text });
  };
  await wait("!!window.__abacusDev");
  child.stdin.write(`${JSON.stringify({ op: "window.focus", input: {} })}\n`);
  await send("Page.bringToFront");
  assert.equal(await evaluate("window.__abacusDev.fixtures"), false);
  await navigate("/routines/new?template=morning-brief");
  await enter("textarea", "phase5-report");
  await clickText("Create");
  await wait("window.__abacusDev.rows('routines').length===1");
  const routine = (await evaluate("window.__abacusDev.rows('routines')"))[0];
  assert.equal(routine.schedule, "30 8 * * 1-5");
  await wait(
    `window.__abacusDev.rows('routineRuns').some(r=>r.routineId===${JSON.stringify(routine.id)})`
  );
  const run = await evaluate(
    `window.__abacusDev.rows('routineRuns').find(r=>r.routineId===${JSON.stringify(routine.id)})`
  );
  await navigate(`/routines/${routine.id}?run=${run.sessionId}`);
  await wait(
    "document.body.textContent.includes('Phase five integration reply')"
  );
  assert.equal(
    await evaluate(
      "document.querySelectorAll('[data-slot=composer] textarea').length"
    ),
    0
  );
  checks.push("template weekday create-and-run streams a read-only report");
  await navigate(`/routines/${routine.id}`);
  await enter(
    'input[aria-label="Tell the routine how to change"]',
    "every day at 7 instead"
  );
  await clickText("Send");
  await wait(`window.__abacusDev.rows('routines')[0].schedule==='0 7 * * *'`);
  checks.push("real editor chat updates the routine through cronjob");
  await evaluate(`document.querySelector('[aria-label="Routine on"]').click()`);
  await wait("window.__abacusDev.rows('routines')[0].enabled===false");
  checks.push("pause persists through the routine collection");
  await navigate("/artifacts");
  await wait("document.querySelectorAll('[data-artifact-card]').length>0");
  await evaluate(
    `document.querySelector('[data-artifact-card] button').click()`
  );
  await wait(
    "document.body.textContent.includes('Native integration artifact')"
  );
  checks.push("routine-written artifact renders in its preview");
  await evaluate(
    `window.__transitions=[];const original=document.startViewTransition.bind(document);document.startViewTransition=options=>{const vt=original(options);const entry={types:options?.types??[],groups:[]};window.__transitions.push(entry);vt.ready.then(()=>{entry.groups=document.getAnimations().map(a=>a.effect?.pseudoElement).filter(Boolean)}).catch(()=>{});return vt;};window.__abacusDev.navTypes()`
  );
  const transitions = [];
  for (const [path, expected] of [
    ["/settings/general", "settings-in"],
    ["/settings/appearance", "nav-lateral"],
    ["/artifacts", "settings-out"],
  ]) {
    await evaluate("window.__transitions=[];window.__abacusDev.navTypes()");
    await navigate(path);
    await sleep(350);
    const types = await evaluate("window.__abacusDev.navTypes()");
    const captured = await evaluate("window.__transitions");
    assert.deepEqual(types, [expected]);
    assert.equal(captured.length, 1);
    assert(
      captured[0].groups.some((name) => name.includes("app-pane")),
      JSON.stringify(captured)
    );
    assert(
      captured[0].groups.some((name) => name.includes("app-sidebar")),
      JSON.stringify(captured)
    );
    transitions.push({ path, types, captured });
  }
  for (const path of [
    `/routines/${routine.id}`,
    "/artifacts",
    "/library/mcp",
    "/routines",
  ]) {
    await navigate(path);
    await sleep(250);
    await evaluate("window.__transitions=[];window.__abacusDev.navTypes()");
    const href = path.startsWith("/routines/")
      ? `${path}?run=${run.sessionId}`
      : path === "/artifacts"
        ? `/artifacts?item=${encodeURIComponent((await evaluate("window.__abacusDev.rows('artifacts')"))[0].id)}`
        : path === "/library/mcp"
          ? "/library/mcp?server=new"
          : "/routines/new";
    await navigate(href);
    await sleep(250);
    assert.equal((await evaluate("window.__transitions")).length, 0, href);
  }
  checks.push(
    "native Settings enter/leave/lateral use one pane+sidebar transition; report, preview and dialogs use none"
  );
  await navigate("/library/connectors");
  await evaluate(
    `document.querySelector('[data-setting-id=github] button').click()`
  );
  await wait("!!document.getElementById('connector-GH_TOKEN')");
  await enter("#connector-GH_TOKEN", "ghp_phase5_integration_token");
  await clickText("Connect");
  await wait(
    "document.querySelector('[data-setting-id=github]')?.textContent.includes('Connected')"
  );
  checks.push(
    "credential connector fields persist and its card becomes Connected"
  );
  await navigate("/library/mcp?server=new");
  await enter("#mcp-name", "phase5-native");
  await enter("#mcp-command", process.execPath);
  await enter("#mcp-args", mcpScript);
  await clickText("Save");
  await wait(
    "[...document.querySelectorAll('[data-setting-id]')].some(row=>row.textContent.includes('phase5-native')&&row.textContent.includes('Connected'))"
  );
  await evaluate(
    `(()=>{const row=[...document.querySelectorAll('[data-setting-id]')].find(row=>row.textContent.includes('phase5-native'));[...row.querySelectorAll('button')].find(button=>button.textContent.trim()==='Disable').click();})()`
  );
  await wait(
    "[...document.querySelectorAll('[data-setting-id]')].some(row=>row.textContent.includes('phase5-native')&&row.textContent.includes('Disabled'))"
  );
  await evaluate(
    `(()=>{const row=[...document.querySelectorAll('[data-setting-id]')].find(row=>row.textContent.includes('phase5-native'));[...row.querySelectorAll('button')].find(button=>button.textContent.trim()==='Remove').click();})()`
  );
  await clickText("Remove");
  await wait(
    "![...document.querySelectorAll('[data-setting-id]')].some(row=>row.textContent.includes('phase5-native'))"
  );
  checks.push(
    "local STDIO MCP becomes Connected in a running session, then disables and removes"
  );
  const axeSource = readFileSync(
    join(repo, "node_modules/axe-core/axe.min.js"),
    "utf8"
  );
  await evaluate(axeSource);
  const axe = [];
  for (const path of [
    "/routines/new",
    "/artifacts",
    "/library/connectors",
    "/library/mcp",
    "/library/messaging",
    "/settings/general",
    "/settings/appearance",
    "/settings/notifications",
    "/settings/keyboard",
    "/settings/models",
    "/settings/memory",
    "/settings/usage",
    "/settings/account",
    "/settings/environment",
    "/settings/browser",
    "/settings/devices",
    "/settings/language",
    "/settings/about",
  ]) {
    await navigate(path);
    await sleep(350);
    const violations = await evaluate(
      `axe.run(document, {runOnly:["wcag2a","wcag2aa"]}).then(r=>r.violations.map(v=>({id:v.id,impact:v.impact,nodes:v.nodes.map(n=>n.target)})))`
    );
    axe.push({ path, violations });
    console.log(path, JSON.stringify(violations));
  }
  // Capture performance with the production card implementation in its stress fixture.
  const paints = [];
  for (let i = 0; i < 3; i++) {
    await navigate("/artifacts");
    const before = performance.now();
    await navigate("/__ui?fixture=artifacts-stress");
    await wait("document.querySelectorAll('[data-artifact-card]').length>0");
    paints.push(performance.now() - before);
  }
  await wait(
    "document.querySelectorAll('[data-artifact-thumbnail][data-requested=true]').length>0"
  );
  await wait(
    "document.querySelectorAll('[data-artifact-thumbnail] img').length>0"
  );
  const thumbnails = await evaluate(
    `({decoded:document.querySelectorAll('[data-artifact-thumbnail] img').length,near:document.querySelectorAll('[data-artifact-thumbnail][data-requested=true]').length, mounted:document.querySelectorAll('[data-artifact-thumbnail=image]').length})`
  );
  assert(
    thumbnails.near > 0 && thumbnails.near < thumbnails.mounted,
    JSON.stringify(thumbnails)
  );
  const scroll = await evaluate(`new Promise(resolve=>{
    const card=document.querySelector('[data-artifact-card]');const viewport=card.closest('.overflow-auto');
    const intervals=[];let previous=performance.now(),maxCards=0;const until=previous+1500;
    const tick=now=>{intervals.push(now-previous);previous=now;maxCards=Math.max(maxCards,document.querySelectorAll('[data-artifact-card]').length);viewport.scrollTop+=100;if(now<until)requestAnimationFrame(tick);else resolve({intervals,maxCards,images:document.querySelectorAll('img').length,requested:document.querySelectorAll('[data-artifact-thumbnail][data-requested=true]').length});};requestAnimationFrame(tick);
  })`);
  const median = (xs) =>
    xs.toSorted((a, b) => a - b)[Math.floor(xs.length / 2)];
  const performanceResult = {
    paints,
    medianPaint: median(paints),
    medianFps: 1000 / median(scroll.intervals.slice(1)),
    ...scroll,
  };
  checks.push("native stress fixture measured");
  await navigate("/settings/notifications");
  await evaluate(
    `window.__tones=[];const soundOriginal=AudioContext.prototype.createOscillator;AudioContext.prototype.createOscillator=function(){const o=soundOriginal.call(this),start=o.start.bind(o);o.start=(...args)=>{window.__tones.push(o.frequency.value);return start(...args)};return o;};`
  );
  await evaluate(
    `const preview=[...document.querySelectorAll('button')].find(b=>b.getAttribute('aria-label')?.includes('Routine fired'));if(!preview)throw new Error('No routine preview');preview.click()`
  );
  await wait("window.__tones.length>=2");
  checks.push("native routine-fired preview schedules two audible tones");
  await navigate("/__ui?fixture=sound-synthesis");
  await wait(
    "document.querySelector('[data-sound-rms]')?.dataset.soundRms !== 'pending' && !!document.querySelector('[data-sound-rms]')"
  );
  const rms = await evaluate(
    "Number(document.querySelector('[data-sound-rms]').dataset.soundRms)"
  );
  assert(rms > 0.001, `routine-fired RMS ${rms}`);
  checks.push(
    "production routine-fired synthesis renders nonzero native OfflineAudioContext output"
  );
  mkdirSync(join(repo, ".build"), { recursive: true });
  const result = {
    checks,
    transitions,
    axe,
    performance: performanceResult,
    tones: await evaluate("window.__tones"),
    rms,
    thumbnails,
    scratch,
  };
  writeFileSync(
    join(repo, ".build/phase5-real.json"),
    JSON.stringify(result, null, 2)
  );
  assert.equal(
    axe.flatMap((row) =>
      row.violations.filter(
        (v) => v.impact === "serious" || v.impact === "critical"
      )
    ).length,
    0,
    "real-layout axe"
  );
  assert(
    performanceResult.medianPaint < 400,
    `paint ${performanceResult.medianPaint}`
  );
  assert(
    performanceResult.medianFps >= 50,
    `fps ${performanceResult.medianFps}`
  );
  assert(scroll.maxCards <= 400);
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  writeFileSync(join(scratch, "electron.log"), output);
  if (ws) {
    /* CDP errors are retained above. */
  }
  console.error(`Electron log: ${scratch}/electron.log`);
  throw error;
} finally {
  ws?.close();
  child.kill("SIGKILL");
  await provider.close();
}
