import fs from "node:fs/promises";

import WebSocket from "ws";

// Run against an isolated, seeded VITE_UI_GALLERY desktop instance.
const port = process.env.ABACUSAI_BOT_DEBUG_PORT ?? "9560";
const targets = await fetch(`http://127.0.0.1:${port}/json`).then((r) =>
  r.json()
);
const page = targets.find((target) => target.url.includes("index.html"));
if (!page) throw new Error("No desktop renderer on the requested debug port");
const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve) => socket.once("open", resolve));
let next = 0;
const pending = new Map();
socket.on("message", (raw) => {
  const message = JSON.parse(String(raw));
  const callback = pending.get(message.id);
  if (!callback) return;
  pending.delete(message.id);
  if (message.error) callback.reject(message.error);
  else callback.resolve(message.result);
});
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++next;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
const evaluate = async (expression) => {
  const result = await send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
  return result.result.value;
};
const routes = [
  "bots/new",
  "routines",
  "artifacts",
  ...["skills", "mcp", "messaging", "tools", "connectors"].map(
    (page) => `library/${page}`
  ),
  ...[
    "general",
    "appearance",
    "notifications",
    "memory",
    "usage",
    "account",
    "models",
    "environment",
    "browser",
    "devices",
    "language",
    "keyboard",
    "about",
    "about/changelog",
  ].map((page) => `settings/${page}`),
];
const results = [];
try {
  for (const width of [640, 800, 1000, 1280, 1710, 2560]) {
    await send("Emulation.setDeviceMetricsOverride", {
      width,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
    for (const route of routes) {
      await evaluate(
        `void __abacusDev.navigate(${JSON.stringify(`/${route}`)})`
      );
      for (let i = 0; i < 100; i++) {
        if (await evaluate("__abacusDev.idle()")) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
      const issues = await evaluate(`(() => {
        const root = document.querySelector('[data-slot="pane"]') ?? document.body;
        const bounds = root.getBoundingClientRect();
        return [...root.querySelectorAll('*')].flatMap(element => {
          const rect = element.getBoundingClientRect();
          if (!rect.width || getComputedStyle(element).position === 'fixed') return [];
          let ancestor = element.parentElement;
          // Deliberately scrollable or clipped content is not page overflow.
          while (ancestor && ancestor !== root) {
            if (['hidden','clip'].includes(getComputedStyle(ancestor).overflowX)) return [];
            ancestor = ancestor.parentElement;
          }
          if (rect.right <= bounds.right + 2 && rect.left >= bounds.left - 2) return [];
          return [{tag:element.tagName, slot:element.dataset.slot, className:String(element.className), left:rect.left, right:rect.right}];
        });
      })()`);
      results.push({ route, width, issues });
    }
  }
} finally {
  await send("Emulation.clearDeviceMetricsOverride");
  socket.close();
}
if (process.env.LAYOUT_REPORT)
  await fs.writeFile(
    process.env.LAYOUT_REPORT,
    JSON.stringify(results, null, 2)
  );
const failed = results.filter((cell) => cell.issues.length);
console.log(JSON.stringify({ cells: results.length, failed }, null, 2));
if (failed.length) process.exitCode = 1;
