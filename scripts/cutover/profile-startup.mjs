// CPU profiles and app logs are private scratch artifacts, never release evidence.
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";

import { connect, launch } from "./cdp.mjs";
import { copyPerfHome } from "./perf-home.mjs";
import { probeSource } from "./perf-probes.mjs";

const { values } = parseArgs({
  options: {
    executable: { type: "string" },
    home: { type: "string" },
    producer: { type: "string" },
    out: { type: "string" },
  },
});
if (!values.executable || !values.home || !values.producer || !values.out)
  throw new Error(
    "Required: --executable --home --producer --out <fresh private directory>"
  );
fs.mkdirSync(values.out, { mode: 0o700 });
const producer = JSON.parse(fs.readFileSync(values.producer, "utf8"));
const copy = copyPerfHome(values.home, producer.files, producer.provenance);
let inspector, app;
const started = launch({
  executable: path.resolve(values.executable),
  home: copy.home,
  port: 9350,
  args: ["--inspect-brk=9360"],
  directPage: true,
  log: path.join(values.out, "main.log"),
  initScript: probeSource(producer.fixture),
});
// Attach before module evaluation, then resume with CPU sampling enabled.
try {
  for (let i = 0; i < 100 && !inspector; i++) {
    try {
      const targets = await fetch("http://127.0.0.1:9360/json/list").then((r) =>
        r.json()
      );
      inspector = await connect(targets[0].webSocketDebuggerUrl);
    } catch {
      await delay(100);
    }
  }
  if (!inspector) throw new Error("Main inspector did not start");
  await inspector.send("Profiler.enable");
  await inspector.send("Profiler.start");
  await inspector.send("Runtime.runIfWaitingForDebugger");
  app = await started;
  await app.cdp.evaluate(probeSource(producer.fixture));
  const timeline = [];
  for (let i = 0; i < 900; i++) {
    const state = await app.cdp.evaluate(
      "({ probe: window.__cutoverProbe, route: location.hash })"
    );
    timeline.push({ sinceSpawnMs: Date.now() - app.spawnedAt, ...state });
    if (state.probe?.interactiveAt) break;
    await delay(100);
  }
  const { profile } = await inspector.send("Profiler.stop");
  fs.writeFileSync(
    path.join(values.out, "main.cpuprofile"),
    JSON.stringify(profile)
  );
  fs.writeFileSync(
    path.join(values.out, "timeline.json"),
    JSON.stringify(timeline)
  );
  // Inspector overhead makes this a diagnostic timeline, not an M1 sample.
  await inspector.evaluate(
    "(() => { const {app} = process.getBuiltinModule('module').createRequire(process.execPath)('electron'); setTimeout(() => app.quit(), 0); return true; })()"
  );
  await delay(500);
} finally {
  inspector?.close();
  app?.cdp.close();
  try {
    await app?.stop();
  } finally {
    copy.dispose();
  }
}
