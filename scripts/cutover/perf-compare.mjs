import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { gzipSync } from "node:zlib";

import { extractFile } from "@electron/asar";

import { launch } from "./cdp.mjs";
import {
  validatePerfProducer,
  publicProducer,
  copyPerfHome,
} from "./perf-home.mjs";
import {
  probeSource,
  clickLongThreadSource,
  summarize,
} from "./perf-probes.mjs";
import { processTree } from "./perf-processes.mjs";

const { values } = parseArgs({
  options: {
    old: { type: "string" },
    new: { type: "string" },
    home: { type: "string" },
    producer: { type: "string" },
    "new-home": { type: "string" },
    "new-producer": { type: "string" },
    out: { type: "string" },
    pairs: { type: "string", default: "7" },
    "m6-diagnostic": { type: "boolean", default: false },
  },
});
if (!values.old || !values.new || !values.out)
  throw new Error(
    "Required: --old <packaged executable> --new <packaged executable> --out <new report> --home <perf-home> --producer <producer.json>; or --m6-diagnostic"
  );
if (fs.existsSync(values.out))
  throw new Error("Measurement reports are immutable; choose a new --out");
const pairs = Number(values.pairs);
if (!Number.isInteger(pairs) || pairs < 4)
  throw new Error(
    "At least four pairs are required: one warm-up and three retained pairs"
  );
const diagnostic = values["m6-diagnostic"];
const producer = values.producer
  ? JSON.parse(fs.readFileSync(values.producer, "utf8"))
  : null;
if (!diagnostic && (!values.home || !validatePerfProducer(producer)))
  throw new Error(
    "M1–M5 require a completed, source-produced perf-home or labeled user-login perf-home; onboarding or incomplete fixtures are refused"
  );
const candidateProducer = values["new-producer"]
  ? JSON.parse(fs.readFileSync(values["new-producer"], "utf8"))
  : null;
if (
  !diagnostic &&
  (!values["new-home"] ||
    !candidateProducer?.files ||
    !candidateProducer.alreadyMigrated)
)
  throw new Error(
    "The candidate needs --new-home and --new-producer with alreadyMigrated evidence; migration is measured separately from M1–M6"
  );
const fixture = producer?.fixture ?? {
  botName: "Fixture bot 01",
  longSessionName: "Fixture session 05",
  lastMessage: "Fixture final message",
};
const output = {
  mode: diagnostic
    ? "M6 diagnostic on fresh onboarding homes; not R7-T24 acceptance"
    : producer.provenance === "user-login"
      ? "comparative packaged probe on user-login scratch copies"
      : "comparative packaged probe",
  machine: {
    platform: process.platform,
    arch: process.arch,
    cpus: os.cpus()[0]?.model,
    ramBytes: os.totalmem(),
  },
  producer: publicProducer(producer),
  builds: {},
  runs: [],
  metrics: {},
  gaps: [
    "Signed artifacts, Windows reference machine and packaged phase-budget checks are separate evidence.",
    "M2 wrong-theme frame classification is not yet implemented; no M2 acceptance is claimed.",
    "M3 companion RSS attribution is not implemented; process-tree RSS includes the companion and cannot establish its separate cap.",
  ],
};
const hash = (file) =>
  createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const asarFor = (executable) =>
  process.platform === "darwin"
    ? path.resolve(executable, "../../Resources/app.asar")
    : path.join(path.dirname(executable), "resources/app.asar");
for (const name of ["old", "new"])
  output.builds[name] = {
    executable: path.resolve(values[name]),
    executableSha256: hash(values[name]),
    asarSha256: hash(asarFor(values[name])),
  };
const resourceBytes = (executable, resources, paintAt) => {
  const urls = [
    ...new Set(
      resources.filter((r) => r.loadedAt <= paintAt).map((r) => r.url)
    ),
  ];
  let bytes = 0;
  const files = [];
  for (const url of urls) {
    const parsed = new URL(url);
    const resource = decodeURIComponent(parsed.pathname);
    const marker = resource.indexOf("/dist/renderer/");
    const relative =
      marker >= 0
        ? resource.slice(marker + 1)
        : `dist/renderer/${resource.replace(/^\//, "")}`;
    if (!relative.startsWith("dist/renderer/") || relative.includes(".."))
      throw new Error(`Unexpected resource: ${url}`);
    const data = extractFile(asarFor(executable), relative);
    const gzipBytes = gzipSync(data).length;
    bytes += gzipBytes;
    files.push({ url, asarPath: relative, gzipBytes });
  }
  if (!files.length)
    throw new Error("M6 has no observed JS/CSS resources before FCP");
  return { gzipBytes: bytes, resources: files };
};
async function run(name, pair) {
  const sourceHome = name === "new" ? values["new-home"] : values.home;
  const manifest = name === "new" ? candidateProducer : producer;
  const copy = copyPerfHome(
    sourceHome,
    manifest?.files ?? {},
    producer?.provenance
  );
  const { home } = copy;
  let app;
  let run;
  try {
    const log = path.resolve(
      path.dirname(values.out),
      `perf-${name}-${pair}.log`
    );
    app = await launch({
      executable: path.resolve(values[name]),
      home,
      port: 9350,
      log,
      initScript: probeSource(fixture),
      directPage: true,
    });
    const source = probeSource(fixture);
    await app.cdp.send("Page.enable");
    await app.cdp.send("Page.addScriptToEvaluateOnNewDocument", { source });
    await app.cdp.evaluate(source);
    let state;
    for (let i = 0; i < 900; i++) {
      state = await app.cdp.evaluate("window.__cutoverProbe");
      if (state?.paintAt && (diagnostic || state.interactiveAt)) break;
      await delay(100);
    }
    if (!state?.paintAt || (!diagnostic && !state.interactiveAt))
      throw new Error(`Fixture shell/paint probe did not complete: ${log}`);
    run = {
      build: name,
      pair,
      discarded: pair === 0,
      initialRoute: state.initialRoute,
      M2: state.paintAt - app.spawnedAt,
      M6: resourceBytes(
        values[name],
        [...app.resources.values()].filter((r) =>
          /\.(js|css)(?:[?#]|$)/.test(r.url)
        ),
        state.paintAt
      ),
    };
    if (!diagnostic) {
      run.M1 = state.interactiveAt - app.spawnedAt;
      app.stopResourceTracking?.();
      await delay(Math.max(0, state.interactiveAt + 60_000 - Date.now()));
      run.M3 = processTree(app.child.pid);
      await app.cdp.send("HeapProfiler.enable");
      await app.cdp.send("HeapProfiler.collectGarbage");
      run.M4 = (await app.cdp.send("Runtime.getHeapUsage")).usedSize;
      let clicked = false;
      for (let i = 0; i < 40; i++) {
        clicked = await app.cdp.evaluate(clickLongThreadSource(fixture));
        if (clicked) break;
        await delay(50);
      }
      if (!clicked) throw new Error("Fixture long-session control is absent");
      for (let i = 0; i < 300; i++) {
        state = await app.cdp.evaluate("window.__cutoverProbe");
        if (state.longThreadAt) break;
        await delay(100);
      }
      if (!state.longThreadAt)
        throw new Error("Long-thread last-message visibility probe timed out");
      run.M5 = state.longThreadAt - state.threadClickedAt;
    }
    output.runs.push(run);
    console.log(
      `${name} pair ${pair + 1}: M6=${run.M6.gzipBytes} bytes${diagnostic ? "" : ` M1=${run.M1}ms M5=${run.M5}ms`}`
    );
  } finally {
    try {
      app?.cdp.close();
      await app?.stop();
    } finally {
      copy.dispose();
    }
  }
}
fs.mkdirSync(path.dirname(path.resolve(values.out)), { recursive: true });
try {
  for (let pair = 0; pair < pairs; pair++)
    for (const name of ["old", "new"]) await run(name, pair);
  for (const metric of diagnostic
    ? ["M6"]
    : ["M1", "M2", "M3", "M4", "M5", "M6"]) {
    const sample = (name) =>
      output.runs
        .filter((r) => !r.discarded && r.build === name)
        .map((r) =>
          metric === "M6"
            ? r.M6.gzipBytes
            : metric === "M3"
              ? r.M3.rssBytes
              : r[metric]
        );
    const old = summarize(sample("old")),
      next = summarize(sample("new"));
    const limit = old.median * (metric === "M6" ? 1 : 1.1);
    output.metrics[metric] = {
      old,
      new: next,
      changePercent: (next.median / old.median - 1) * 100,
      budget: limit,
      numericBudgetMet:
        next.median <= limit && (metric !== "M5" || next.median < 600),
      acceptance: diagnostic
        ? "diagnostic only"
        : "requires complete gate evidence",
    };
  }
} catch (error) {
  output.gaps.push(String(error));
  process.exitCode = 1;
} finally {
  fs.writeFileSync(values.out, JSON.stringify(output, null, 2) + "\n");
}
