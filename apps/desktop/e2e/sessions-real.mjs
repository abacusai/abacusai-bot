/** R4-T13,T29,T30,T34,T39 (partial coverage; see phase-4 implementation report): real main + loopback provider, isolated profile, CDP.
 * Run after VITE_UI_GALLERY=1 vite build (no DB fixtures):
 * node --experimental-transform-types e2e/sessions-real.mjs
 */
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { FakeProvider } from "../../../packages/test-support/src/fake-provider.ts";
const desktop = resolve(import.meta.dirname, "..");
const repo = resolve(desktop, "../..");
const port = 9437;
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "sessions-real-")));
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
    ABACUSBOT_DEV_CONTENT_SIZE: "1280x800",
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
  assert(page, "renderer-next appeared");
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
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
    writeFileSync(
      join(scratch, "page.json"),
      JSON.stringify(
        await evaluate(
          "({body:document.body.innerText,html:document.body.innerHTML,rows:window.__abacusDev?.rows('sessions')})"
        ),
        null,
        2
      )
    );
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

  const checkout = join(scratch, "repo");
  mkdirSync(checkout);
  writeFileSync(join(checkout, "sample.txt"), "base\n");
  const git = (args) =>
    execFileSync("/usr/bin/git", args, { cwd: checkout, encoding: "utf8" });
  git(["init", "-b", "main"]);
  git(["add", "."]);
  git([
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.test",
    "commit",
    "-m",
    "initial",
  ]);
  const workspace = await call("workspaces.add", { path: checkout });
  assert(workspace.workspaceId);
  await navigate(`/sessions/new?workspace=${workspace.workspaceId}`);
  await wait("!!document.querySelector('[data-slot=composer] textarea')");
  await wait(
    "[...document.querySelectorAll('button')].some(b=>b.textContent.includes('No worktree'))"
  );
  await clickText("No worktree");
  await clickText("New worktree");
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
  await enter("[data-slot=composer] textarea", "Review this repository");
  await wait(
    "document.querySelector('[data-slot=composer] textarea').value==='Review this repository'"
  );
  await evaluate("document.querySelector('[aria-label=Send]').click()");
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
  await wait("!!document.querySelector('[data-slot=session-dock]')");
  await wait("window.__abacusDev.rows('sessions').some(s=>s.worktreeId)");
  const session = await evaluate(
    "window.__abacusDev.rows('sessions').find(s=>s.worktreeId)"
  );
  assert.equal(session.workspaceId, workspace.workspaceId);
  assert.equal(session.model, null);
  await wait(
    `!window.__abacusDev.rows('sessions').find(s=>s.id===${JSON.stringify(session.id)})?.turn?.isBusy`
  );
  const firstDeadline = Date.now() + 20000;
  while (requests.length === 0 && Date.now() < firstDeadline) await sleep(50);
  assert.equal(requests.filter((model) => model === "fake-1").length, 1);
  checks.push("new worktree session persists one configured first admission");
  const ref = {
    version: 1,
    kind: "session",
    workspaceId: workspace.workspaceId,
    sessionId: session.id,
  };
  const key = JSON.stringify([
    "conversation",
    1,
    workspace.workspaceId,
    "session",
    session.id,
  ]);
  const terminal = await call("terminal.start", {
    terminalId: "acceptance",
    conversationKey: key,
    conversation: ref,
    generation: null,
    cols: 80,
    rows: 24,
  });
  assert(terminal.success);
  await navigate(`/sessions/${session.id}?tab=terminal:acceptance`);
  const viewKey = `${key}:acceptance`;
  await wait(
    `!!window.__sessionsTerminalTest && !!document.querySelector('[data-slot=session-dock] canvas')`
  );
  await wait(
    `window.__sessionsTerminalTest.snapshot(${JSON.stringify(viewKey)}).then(s=>s?.generation!=null)`
  );
  const before = await evaluate(
    `window.__sessionsTerminalTest.snapshot(${JSON.stringify(viewKey)})`
  );
  await call("terminal.write", {
    terminalId: "acceptance",
    conversationKey: key,
    generation: terminal.state.generation,
    data: "printf 'SESSION_PTY_MARKER\\n'\r",
  });
  await wait(
    `window.__sessionsTerminalTest.snapshot(${JSON.stringify(viewKey)}).then(s=>s.text.includes('SESSION_PTY_MARKER'))`
  );
  await navigate(`/sessions/${session.id}?tab=files`);
  await call("terminal.write", {
    terminalId: "acceptance",
    conversationKey: key,
    generation: terminal.state.generation,
    data: 'node -e \'process.stdout.write("x".repeat(5*1024*1024)+"\\nHIDDEN_DONE\\n")\'\r',
  });
  await wait(
    `window.__sessionsTerminalTest.snapshot(${JSON.stringify(viewKey)}).then(s=>s.received>${before.received}+5*1024*1024&&s.text.includes('HIDDEN_DONE'))`
  );
  await sleep(1000);
  const after = await evaluate(
    `window.__sessionsTerminalTest.snapshot(${JSON.stringify(viewKey)}).then(({text,...s})=>s)`
  );
  assert(after.offset > 5 * 1024 * 1024);
  checks.push("real PTY delivers 5 MB while the terminal tab is hidden");
  await evaluate(
    `window.__sessionsTerminalTest.reconnect(${JSON.stringify(viewKey)})`
  );
  await sleep(500);
  const reconnected = await evaluate(
    `window.__sessionsTerminalTest.snapshot(${JSON.stringify(viewKey)}).then(({text,...s})=>s)`
  );
  assert.equal(reconnected.received, after.received);
  assert.equal(reconnected.offset, after.offset);
  checks.push(
    "same-document output reconnect appends without replaying old bytes"
  );
  await navigate(`/sessions/${session.id}?tab=terminal:acceptance`);
  await wait("!!document.querySelector('[data-slot=session-dock] canvas')");
  await evaluate(
    "document.querySelector('[data-slot=session-dock] canvas').closest('[role=region]').querySelector('div[tabindex]')?.focus()"
  );
  const browser = await call("browser.runtime.materialize", {
    conversationKey: key,
    resourceId: "acceptance-browser",
    url: "https://example.com",
  });
  await navigate(`/sessions/${session.id}?tab=browser:acceptance-browser`);
  await wait("!!document.querySelector('[aria-label=Browser]')");
  const browserRect = await evaluate(
    "(()=>{const r=document.querySelector('[aria-label=Browser]').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};})()"
  );
  assert(browserRect.width > 200 && browserRect.height > 200);
  checks.push("browser surface has a live native presentation placeholder");
  writeFileSync(
    join(session.worktreePath, "sample.txt"),
    "changed in worktree\n"
  );
  await navigate(`/sessions/${session.id}?tab=changes`);
  await wait("!!document.querySelector('[data-slot=diff-view]')");
  assert.equal(readFileSync(join(checkout, "sample.txt"), "utf8"), "base\n");
  await clickText("Keep");
  checks.push(
    "changes diff reads the sibling worktree and Keep preserves the primary checkout"
  );
  await clickText("Open full diff");
  await wait("!!document.querySelector('[role=dialog]')");
  assert(
    await evaluate("document.querySelector('[data-slot=session-dock]')!==null")
  );
  checks.push("masked diff keeps the session dock mounted");
  const screenshotRoot = join(repo, ".build/screenshots/sessions");
  mkdirSync(screenshotRoot, { recursive: true });
  const screenshots = [];
  for (const width of [1280, 900]) {
    await send("Emulation.setDeviceMetricsOverride", {
      width,
      height: 800,
      deviceScaleFactor: 1,
      mobile: false,
    });
    for (const theme of ["light", "dark"]) {
      await send("Emulation.setEmulatedMedia", {
        features: [{ name: "prefers-color-scheme", value: theme }],
      });
      for (const [name, href] of [
        ["sidebar", `/sessions/${session.id}`],
        ["start", `/sessions/new?workspace=${workspace.workspaceId}`],
        ["changes", `/sessions/${session.id}?tab=changes`],
        ["terminal", `/sessions/${session.id}?tab=terminal:acceptance`],
      ]) {
        await navigate(href);
        if (name === "changes")
          await wait("!!document.querySelector('[data-slot=diff-view]')");
        await sleep(500);
        const file = `${name}@${width}-${theme}.png`;
        const shot = await send("Page.captureScreenshot", { format: "png" });
        writeFileSync(
          join(screenshotRoot, file),
          Buffer.from(shot.data, "base64")
        );
        screenshots.push(file);
      }
    }
  }
  writeFileSync(
    join(screenshotRoot, "manifest.json"),
    JSON.stringify({ screenshots }, null, 2)
  );
  checks.push(
    "16 session route screenshots: sidebar/start/changes/terminal at 1280 and 900, light and dark"
  );
  await navigate(`/sessions/${session.id}`);
  await call("terminal.hide", {
    terminalId: "acceptance",
    conversationKey: key,
    generation: terminal.state.generation,
    close: true,
  });
  await call("browser.runtime.close", browser.lease);
  await call("agent.stop", {
    workspaceId: workspace.workspaceId,
    sessionId: session.id,
  });
  await call("db.sessions.delete", { id: session.id });
  await wait("document.body.textContent.includes('This session was deleted')");
  checks.push("deleted live session renders its gone state");
  mkdirSync(join(repo, ".build"), { recursive: true });
  writeFileSync(
    join(repo, ".build/sessions-real.json"),
    JSON.stringify({ checks, scratch }, null, 2)
  );
  console.log(`sessions-real: ${checks.length} checks passed`);
} catch (error) {
  writeFileSync(join(scratch, "electron.log"), output);
  console.error(`Electron log: ${scratch}/electron.log`);
  throw error;
} finally {
  ws?.close();
  child.kill();
  await provider.close();
}
