/** R3-T14,T25,T26,T31 (partial coverage; see phase-3 implementation report): real main + loopback provider, isolated profile, CDP.
 * Run after VITE_UI_GALLERY=1 vite build (no DB fixtures):
 * node --experimental-transform-types e2e/bots-real.mjs
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { FakeProvider } from "../../../packages/test-support/src/fake-provider.ts";
const desktop = resolve(import.meta.dirname, "..");
const repo = resolve(desktop, "../..");
const port = 9427;
const canvasWidth = Number(process.env.ABACUSBOT_BOTS_TEST_WIDTH ?? 1280);
const scratch = mkdtempSync(join(tmpdir(), "bots-real-"));
const home = join(scratch, "home");
mkdirSync(home);
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
let holdRun = false;
provider.script(async (call) => {
  if (holdRun) await new Promise((resolve) => setTimeout(resolve, 1200));
  const last = call.messages.at(-1);
  if (
    last?.role === "user" &&
    call.userText.at(-1)?.includes("remember integration")
  )
    return {
      call: {
        name: "memory",
        args: {
          action: "remember",
          content: "Integration memory",
        },
      },
    };
  return { say: "Integration reply" };
});
writeFileSync(
  join(home, "config.json"),
  JSON.stringify({
    defaultModel: "fake/fake-1",
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
  for (let i = 0; i < 120 && !page; i++) {
    try {
      page = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find(
        (p) => p.type === "page" && p.url.includes("index-next.html")
      );
    } catch {}
    if (!page) await sleep(100);
  }
  assert(page, "renderer appeared");
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
  const call = (path, input = {}) =>
    evaluate(
      `window.__abacusDev.call(${JSON.stringify(path)},${JSON.stringify(input)})`
    );
  const clickText = (text) =>
    evaluate(
      `(()=>{const buttons=[...document.querySelectorAll('button')];const element=buttons.find(b=>b.textContent.trim()===${JSON.stringify(text)})??buttons.find(b=>b.textContent.trim().startsWith(${JSON.stringify(text)}));if(!element)throw new Error('No button '+${JSON.stringify(text)});element.click();})()`
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
  await navigate("/bots/new?step=setup&template=chief-of-staff");
  await clickText("Weekdays");
  // Capture the shared-element groups in the transition's ready snapshot.
  await evaluate(
    `window.__botTransitions=[];window.__originalVT=document.startViewTransition.bind(document);document.startViewTransition=(options)=>{const vt=window.__originalVT(options);vt.ready.then(()=>window.__botTransitions.push(document.getAnimations().map(a=>a.effect?.pseudoElement).filter(Boolean))).catch(()=>{});return vt;};`
  );
  await clickText("Create bot");
  await wait("!!document.querySelector('[data-testid=bot-chat]')");
  const bots = await evaluate("window.__abacusDev.rows('bots')");
  assert.equal(bots.length, 1);
  const bot = bots[0];
  const routines = await evaluate("window.__abacusDev.rows('routines')");
  assert.equal(routines.length, 1);
  const routine = routines[0];
  assert.equal(routine.botId, bot.id);
  assert.equal(routine.schedule, "0 9 * * 1-5");
  checks.push("template creation persists bot and weekday check-in");
  const transitions = await evaluate("window.__botTransitions");
  assert(
    transitions.flat().some((name) => name.includes(`bot-identity-${bot.id}`)),
    JSON.stringify(transitions)
  );
  checks.push("create has one shared bot identity group");
  await wait("document.body.textContent.includes('Integration reply')");
  await wait(
    `!window.__abacusDev.rows('sessions').find(s=>s.id===${JSON.stringify(bot.sessionId)})?.turn?.isBusy`
  );
  for (const key of [
    { key: "ContextMenu", code: "ContextMenu", windowsVirtualKeyCode: 93 },
    { key: "F10", code: "F10", windowsVirtualKeyCode: 121, modifiers: 8 },
  ]) {
    await evaluate(
      "document.querySelector('[data-bot-row] a[data-slot=item]').focus()"
    );
    await send("Input.dispatchKeyEvent", { type: "keyDown", ...key });
    await send("Input.dispatchKeyEvent", { type: "keyUp", ...key });
    await wait("!!document.querySelector('[data-slot=context-menu-content]')");
    await send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "Escape",
      code: "Escape",
      windowsVirtualKeyCode: 27,
    });
    await send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "Escape",
      code: "Escape",
      windowsVirtualKeyCode: 27,
    });
    await wait("!document.querySelector('[data-slot=context-menu-content]')");
  }
  checks.push("ContextMenu key and Shift+F10 open bot row options");
  await navigate(`/bots/${bot.id}?tab=details`);
  const modelCount = () =>
    evaluate(
      "[...document.querySelectorAll('[data-slot=bot-model-value], [data-slot=composer] button span')].filter(e=>e.textContent.trim()==='Integration One'||e.textContent.trim()==='App default').length"
    );
  assert.equal(await modelCount(), 1);
  await evaluate(
    "document.querySelector('[data-slot=composer] textarea').focus()"
  );
  await wait("!document.querySelector('[data-slot=bot-model-value]')");
  assert.equal(await modelCount(), 1);
  checks.push("expanded composer moves the single model value from Details");
  // Record the native shared-layout move in the pane and in the drawer.
  for (const width of [canvasWidth]) {
    await wait(`innerWidth===${width}`);
    await evaluate(
      "document.querySelector('[data-slot=composer] textarea').blur()"
    );
    await wait("!!document.querySelector('[data-slot=bot-model-value]')");
    assert.equal(await modelCount(), 1);
    recording = width;
    await send("Page.startScreencast", { format: "jpeg", quality: 75 });
    await evaluate(
      "document.querySelector('[data-slot=composer] textarea').focus()"
    );
    await wait("!document.querySelector('[data-slot=bot-model-value]')");
    assert.equal(await modelCount(), 1);
    await sleep(400);
    await send("Page.stopScreencast");
    recording = null;
  }
  const frameDirectory = join(repo, ".build/bots-model-morph");
  mkdirSync(frameDirectory, { recursive: true });
  frames.forEach((frame, index) =>
    writeFileSync(
      join(
        frameDirectory,
        `${frame.width}-${String(index).padStart(3, "0")}.jpg`
      ),
      Buffer.from(frame.data, "base64")
    )
  );
  writeFileSync(
    join(frameDirectory, `frames-${canvasWidth}.json`),
    JSON.stringify(
      frames.map(({ data: _data, ...frame }) => frame),
      null,
      2
    )
  );
  assert(frames.some((frame) => frame.width === canvasWidth));
  checks.push(`native model morph recorded at ${canvasWidth} with one value`);
  await clickText("Integration One");
  await clickText("Integration Two");
  await wait(`window.__abacusDev.rows('bots')[0].model==='fake/fake-2'`);
  await wait(
    `window.__abacusDev.rows('sessions').find(s=>s.id===${JSON.stringify(bot.sessionId)})?.model==='fake/fake-2'`
  );
  await wait(
    `!window.__abacusDev.rows('sessions').find(s=>s.id===${JSON.stringify(bot.sessionId)})?.turn?.isBusy`
  );
  const before = requests.length;
  await enter("[data-slot=composer] textarea", "model check");
  await send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
  });
  await send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
  });
  const deadline = Date.now() + 20000;
  while (requests.length <= before && Date.now() < deadline) await sleep(100);
  assert.equal(requests.at(-1), "fake-2");
  checks.push("composer model change reaches next provider admission");
  await wait(
    `!window.__abacusDev.rows('sessions').find(s=>s.id===${JSON.stringify(bot.sessionId)})?.turn?.isBusy`
  );
  await evaluate(
    "document.querySelector('[data-slot=composer] textarea').focus()"
  );
  const forever = await evaluate(
    `window.__abacusDev.rows('sessions').find(s=>s.id===${JSON.stringify(bot.sessionId)})`
  );
  await call("agent.stop", {
    workspaceId: forever.workspaceId,
    sessionId: forever.id,
  });
  await clickText("Integration Two");
  await clickText("App default");
  await wait("window.__abacusDev.rows('bots')[0].model===null");
  await call("agent.start", {
    workspaceId: forever.workspaceId,
    sessionId: forever.id,
  });
  checks.push(
    "App default writes null while stopped and next start re-pins the default"
  );
  await evaluate("window.__botTransitions=[]");
  await navigate(`/bots/${bot.id}/edit`);
  await clickText("Save changes");
  await wait("!!document.querySelector('[data-testid=bot-chat]')");
  assert(
    (await evaluate("window.__botTransitions"))
      .flat()
      .some((name) => name.includes(`bot-identity-${bot.id}`))
  );
  checks.push("editor save has a shared bot identity group");
  holdRun = true;
  await call("routines.run", { id: routine.id });
  await wait(
    `window.__abacusDev.rows('sessions').some(s=>s.routineId===${JSON.stringify(routine.id)})`
  );
  const run = await evaluate(
    `window.__abacusDev.rows('sessions').find(s=>s.routineId===${JSON.stringify(routine.id)})`
  );
  assert.equal(run.owner, null);
  await wait(
    "document.querySelector('[data-bot-row]')?.textContent.includes('Checking in')"
  );
  await navigate(`/bots/${bot.id}?tab=details`);
  await wait(
    `!!document.querySelector('a[href*="/bots/${bot.id}/chats/${run.id}"]')`
  );
  checks.push(
    "ownerless check-in drives routine attention and appears in Details"
  );
  await navigate(`/bots/${bot.id}/chats/${run.id}`);
  assert.equal(
    await evaluate(
      "document.querySelectorAll('[data-slot=composer] textarea').length"
    ),
    0
  );
  checks.push("ownerless check-in session opens read-only");
  holdRun = false;
  await navigate(`/bots/${bot.id}`);
  await wait("!!document.querySelector('[data-slot=composer] textarea')");
  await enter("[data-slot=composer] textarea", "remember integration");
  await send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
  });
  await send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
  });
  await navigate(`/bots/${bot.id}?tab=memory`);
  await wait(
    "window.__abacusDev.rows('memories').some(m=>m.entry.includes('Integration memory'))"
  );
  await clickText("Forget");
  await wait("window.__abacusDev.rows('memories').length===0");
  assert.equal(requests.at(-1), "fake-1");
  checks.push(
    "agent memory is forgotten through the collection; restarted agent uses App default"
  );
  if (canvasWidth >= 1100) {
    await wait("window.__abacusDev.rows('sessions').every(s=>!s.turn?.isBusy)");
    await navigate("/bots/new");
    if (!(await evaluate("!!document.querySelector('.accent-outline')"))) {
      await evaluate(
        `document.querySelector('[aria-label="Options for Chief of Staff"]').click()`
      );
      await wait(
        "[...document.querySelectorAll('[role=menuitem]')].some(el=>el.textContent.includes('Mark as unread'))"
      );
      await evaluate(
        "[...document.querySelectorAll('[role=menuitem]')].find(el=>el.textContent.includes('Mark as unread')).click()"
      );
    }
    await navigate("/bots/new?step=setup&template=chief-of-staff");
    await wait("!!document.querySelector('[data-slot=toggle-group] button')");
    await evaluate(
      "document.querySelector('[data-slot=toggle-group] button').click()"
    );
    await wait("!!document.querySelector('.accent-outline')");
    const boundaryProbe = `(() => {
    const canvas = document.createElement('canvas'); canvas.width=canvas.height=1;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const rgba = color => { ctx.clearRect(0,0,1,1); ctx.fillStyle=color; ctx.fillRect(0,0,1,1); return [...ctx.getImageData(0,0,1,1).data].map((v,i)=>i===3?v/255:v); };
    const over = (a,b) => [0,1,2].map(i=>a[i]*a[3]+b[i]*(1-a[3])).concat(1);
    const luminance = rgb => rgb.slice(0,3).map(c=>{c/=255;return c<=.04045?c/12.92:((c+.055)/1.055)**2.4}).reduce((v,c,i)=>v+c*[.2126,.7152,.0722][i],0);
    const contrast = (a,b) => { const x=luminance(a), y=luminance(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05); };
    const backdrop = el => { const parents=[];for(let p=el.parentElement;p;p=p.parentElement)parents.unshift(p);return parents.reduce((bg,p)=>over(rgba(getComputedStyle(p).backgroundColor),bg),[255,255,255,1]); };
    return [...document.querySelectorAll('.bot-accent-control,.accent-outline')].filter(el=>el.getBoundingClientRect().width>0).map(el=>{const css=getComputedStyle(el), bg=backdrop(el), border=rgba(css.borderTopColor), fill=over(rgba(css.backgroundColor),bg), dark=document.documentElement.classList.contains('dark');return {label:el.getAttribute('aria-label')??el.textContent.trim(),kind:el.classList.contains('accent-outline')?'dot':el.getAttribute('aria-pressed')==='true'?'selected':'control',width:css.borderTopWidth,ratio:contrast(dark?fill:over(border,bg),bg),borderAlpha:border[3],borderColor:css.borderTopColor,background:css.backgroundColor,backdrop:bg,dark};});
  })()`;
    const boundaries = [];
    for (const theme of ["light", "dark"]) {
      await call("db.prefs.update", { patch: { theme } });
      await wait(
        `document.documentElement.classList.contains('dark')===${theme === "dark"}`
      );
      await sleep(400);
      const measured = await evaluate(boundaryProbe);
      assert(
        measured.some((row) => row.kind === "dot"),
        "real unread dots measured"
      );
      assert(
        measured.some((row) => row.kind === "selected"),
        "selected shape measured"
      );
      assert(measured.length >= 12, "swatches and submit control measured");
      for (const row of measured) {
        assert(row.ratio >= 3, `${theme} ${row.label}: ${row.ratio}`);
        if (theme === "light") {
          assert.equal(row.width, "1px");
          assert(row.borderAlpha > 0);
        }
      }
      boundaries.push(...measured);
    }
    await call("db.prefs.update", { patch: { theme: "light" } });
    await wait("!document.documentElement.classList.contains('dark')");
    await evaluate(
      "{const style=document.createElement('style');style.id='boundary-mutation';style.textContent='.bot-accent-control,.accent-outline{border:0!important}';document.head.append(style);}"
    );
    assert(
      (await evaluate(boundaryProbe)).some((row) => row.width !== "1px"),
      "removing borders fails the rendered-boundary assertion"
    );
    await evaluate("document.getElementById('boundary-mutation').remove()");
    mkdirSync(join(repo, ".build"), { recursive: true });
    writeFileSync(
      join(repo, ".build/bots-boundaries.json"),
      JSON.stringify(boundaries, null, 2)
    );
    checks.push(
      "rendered composited swatch, selected-shape, dot and accent-control boundaries pass light/dark"
    );
  }
  await navigate(`/bots/${bot.id}?tab=details`);
  await clickText("Delete bot");
  await wait("!!document.querySelector('[role=alertdialog]')");
  await clickText("Delete");
  await wait("window.__abacusDev.rows('bots').length===0");
  await wait(
    `window.__abacusDev.rows('routines').some(r=>r.id===${JSON.stringify(routine.id)}&&r.botId===null)`
  );
  checks.push("delete leaves the check-in with cleared provenance");
  mkdirSync(join(repo, ".build"), { recursive: true });
  writeFileSync(
    join(repo, `.build/bots-real-${canvasWidth}.json`),
    JSON.stringify({ checks, scratch }, null, 2)
  );
  console.log(`bots-real: ${checks.length} checks passed`);
} catch (error) {
  writeFileSync(join(scratch, "electron.log"), output);
  console.error(`Electron log: ${scratch}/electron.log`);
  throw error;
} finally {
  ws?.close();
  child.kill();
  await provider.close();
}
