import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { connect } from "./cutover/cdp.mjs";
// Usage: node scripts/perf-transcript.mjs <label> <debug-port> <output-dir>
// Requires the isolated Electron gallery build described in docs/performance/t3-transcript.md.
const [label, port, output] = process.argv.slice(2);
if (
  !/^[a-z0-9-]+$/.test(label ?? "") ||
  !/^\d+$/.test(port ?? "") ||
  Number(port) === 9333 ||
  Number(port) < 1 ||
  Number(port) > 65535 ||
  !output ||
  !path.isAbsolute(output)
)
  throw Error(
    "Supply a label, an isolated debug port other than 9333, and an absolute output directory"
  );
fs.mkdirSync(output, { recursive: true });
const root = fileURLToPath(new URL("../", import.meta.url));
const instrumentation = [
  [
    "apps/web/src/features/chat/scroller/transcript.tsx",
    "  const ids = toolRows(message);",
    "abacus-perf:row",
  ],
  [
    "apps/web/src/features/chat/markdown/markdown.tsx",
    "  const mathVersion = useMathVersion();",
    "abacus-perf:markdown",
  ],
].map(([file, needle, name]) => {
  const filename = path.join(root, file);
  const original = fs.readFileSync(filename, "utf8");
  if (original.split(needle).length !== 2)
    throw Error("Instrumentation target changed: " + file);
  const instrumented = original.replace(
    needle,
    `  if (import.meta.env.DEV) performance.mark(${JSON.stringify(name)});\n${needle}`
  );
  return { filename, original, instrumented };
});
for (const item of instrumentation)
  fs.writeFileSync(item.filename, item.instrumented);
function restore() {
  for (const item of instrumentation) {
    if (fs.readFileSync(item.filename, "utf8") === item.instrumented)
      fs.writeFileSync(item.filename, item.original);
    else
      console.error(
        "Source changed during measurement; restore manually:",
        item.filename
      );
  }
}
process.once("SIGINT", () => {
  restore();
  process.exit(130);
});
process.once("SIGTERM", () => {
  restore();
  process.exit(143);
});
let connection;
try {
  const pages = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) =>
    r.json()
  );
  const page = pages.find((p) => p.type === "page" && !p.url.includes("notch"));
  if (!page) throw Error("Missing isolated renderer");
  const c = await connect(page.webSocketDebuggerUrl);
  connection = c;
  let contextId;
  c.onEvent((e) => {
    if (
      e.method === "Runtime.executionContextCreated" &&
      e.params.context.auxData?.isDefault
    )
      contextId = e.params.context.id;
  });
  await c.send("Runtime.enable");
  c.evaluate = async (expression) => {
    const r = await c.send("Runtime.evaluate", {
      expression,
      contextId,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.exceptionDetails) throw Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  };
  const wait = async (expr) => {
    for (let n = 0; n < 400; n++) {
      if (await c.evaluate(expr)) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw Error("Timed out: " + expr);
  };
  const hook = `window.__REACT_DEVTOOLS_GLOBAL_HOOK__={supportsFiber:true,inject:()=>1,onCommitFiberUnmount(){},onPostCommitFiberRoot(){},onCommitFiberRoot(){}};`;
  await c.send("Page.addScriptToEvaluateOnNewDocument", { source: hook });
  await c.send("Page.setBypassCSP", { enabled: true });
  await c.send("Tracing.end").catch(() => {});
  await c.send("Page.reload");
  await new Promise((r) => setTimeout(r, 1000));
  await wait("!!window.__abacusDev");
  await c.send("Page.bringToFront");
  await c.evaluate('__abacusDev.setMotion("on")');
  const stats = (a) => {
    a.sort((x, y) => x - y);
    return {
      n: a.length,
      p50: a[Math.floor(a.length * 0.5)] ?? 0,
      p95: a[Math.floor(a.length * 0.95)] ?? 0,
      max: a.at(-1) ?? 0,
    };
  };
  await c.evaluate(`__abacusDev.navigate('/__ui?fixture=bench-stream')`);
  await wait('window.__chatBench?.id==="bench-stream"');
  const results = [];
  for (let trial = 0; trial < 3; trial++) {
    await c.evaluate(`__abacusDev.navigate('/__ui?fixture=bench-rich')`);
    await wait(
      'window.__chatBench?.id==="bench-rich" && __chatBench.firstPaintMs!=null'
    );
    await c.evaluate(
      `(async()=>{const b=__chatBench;while(b.session.hostStore.state.messages.length<300&&b.session.hostStore.state.hasOlderMessages)await b.session.loadOlder()})()`
    );
    await new Promise((r) => setTimeout(r, 500));
    const initial = await c.evaluate(
      "({loadMs:__chatBench.loadMs,paintMs:__chatBench.firstPaintMs,rows:__chatBench.rows(),messages:__chatBench.session.hostStore.state.messages.length})"
    );
    await c.send("Performance.enable");
    const before = await c.send("Performance.getMetrics");
    await c.evaluate(
      `performance.clearMarks("abacus-perf:row");performance.clearMarks("abacus-perf:markdown");window.__sample={frames:[],long:[],updates:0};window.__off=__chatBench.session.hostStore.subscribe(()=>__sample.updates++);window.__po=new PerformanceObserver(l=>__sample.long.push(...l.getEntries().map(e=>e.duration)));__po.observe({type:'longtask'});window.__running=true;window.__lastFrame=performance.now();window.__tick=now=>{__sample.frames.push(now-__lastFrame);__lastFrame=now;if(__running)requestAnimationFrame(__tick)};requestAnimationFrame(__tick);`
    );
    const events = [];
    let resolveEnd;
    const end = new Promise((r) => (resolveEnd = r));
    const off = c.onEvent((e) => {
      if (e.method === "Tracing.dataCollected") events.push(...e.params.value);
      if (e.method === "Tracing.tracingComplete") resolveEnd();
    });
    await c.send("Tracing.start", {
      transferMode: "ReportEvents",
      traceConfig: {
        includedCategories: ["devtools.timeline", "toplevel", "__metadata"],
      },
    });
    const tokens = await c.evaluate(
      `__chatBench.stream({intervalMs:4,bytes:20480})`
    );
    await new Promise((r) => setTimeout(r, 250));
    const sample = await c.evaluate(
      `(()=>{__running=false;__po.disconnect();__off.unsubscribe();return {...__sample,renders:{row:performance.getEntriesByName("abacus-perf:row").length,markdown:performance.getEntriesByName("abacus-perf:markdown").length},rows:__chatBench.rows()}})()`
    );
    const after = await c.send("Performance.getMetrics");
    await c.send("Tracing.end");
    await end;
    off();
    fs.writeFileSync(
      path.join(output, `${label}-${trial}.trace.json`),
      JSON.stringify({ traceEvents: events })
    );
    const main = events.find(
      (e) => e.name === "thread_name" && e.args?.name === "CrRendererMain"
    );
    const tasks = events
      .filter(
        (e) =>
          e.ph === "X" &&
          (e.name === "RunTask" ||
            e.name === "ThreadControllerImpl::RunTask") &&
          e.pid === main?.pid &&
          e.tid === main?.tid &&
          e.dur
      )
      .map((e) => e.dur / 1000);
    const delta = {};
    for (const x of after.metrics) {
      const prev = before.metrics.find((y) => x.name === y.name);
      if (prev) delta[x.name] = x.value - prev.value;
    }
    const result = {
      trial,
      initial,
      tokens,
      updates: sample.updates,
      frames: stats(sample.frames),
      busyTasks: stats(tasks.filter((n) => n >= 1)),
      longTasks: sample.long,
      renders: sample.renders,
      metrics: delta,
      rows: sample.rows,
    };
    results.push(result);
    fs.writeFileSync(
      path.join(output, `${label}.json`),
      JSON.stringify(results, null, 2)
    );
    console.log(JSON.stringify(result));
    await c.evaluate(`__abacusDev.navigate('/__ui?fixture=bench-stream')`);
    await wait('__chatBench?.id==="bench-stream"');
  }
  fs.writeFileSync(
    path.join(output, `${label}.json`),
    JSON.stringify(results, null, 2)
  );
  c.close();
} finally {
  await connection?.send("Tracing.end").catch(() => {});
  connection?.close();
  restore();
}
