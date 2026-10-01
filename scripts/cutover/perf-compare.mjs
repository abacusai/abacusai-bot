import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { gzipSync } from "node:zlib";

import { extractFile } from "@electron/asar";

import { launch } from "./cdp.mjs";
import { validatePerfProducer, publicProducer } from "./perf-home.mjs";
import {
  probeSource,
  clickLongThreadSource,
  summarize,
} from "./perf-probes.mjs";

const { values } = parseArgs({
  options: {
    old: { type: "string" },
    new: { type: "string" },
    home: { type: "string" },
    producer: { type: "string" },
    "new-home": { type: "string" },
    "new-producer": { type: "string" },
    out: { type: "string" },
    "m6-diagnostic": { type: "boolean", default: false },
  },
});
if (!values.old || !values.new || !values.out)
  throw new Error(
    "Required: --old <packaged executable> --new <packaged executable> --out <new report> --home <perf-home> --producer <producer.json>; or --m6-diagnostic"
  );
if (fs.existsSync(values.out))
  throw new Error("Measurement reports are immutable; choose a new --out");
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
const processTree = (pid) => {
  const rows =
    process.platform === "win32"
      ? JSON.parse(
          execFileSync(
            "powershell.exe",
            [
              "-NoProfile",
              "-Command",
              "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,WorkingSetSize,CommandLine | ConvertTo-Json -Compress",
            ],
            { encoding: "utf8" }
          )
        ).map((row) => ({
          pid: row.ProcessId,
          parent: row.ParentProcessId,
          rssBytes: Number(row.WorkingSetSize),
          command: row.CommandLine ?? "",
        }))
      : execFileSync("ps", ["-axo", "pid=,ppid=,rss=,command="], {
          encoding: "utf8",
        })
          .trim()
          .split("\n")
          .map((line) => {
            const [, pid, parent, rss, command] =
              line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/) ?? [];
            return {
              pid: Number(pid),
              parent: Number(parent),
              rssBytes: Number(rss) * 1024,
              command,
            };
          });
  const included = new Set([pid]),
    excluded = new Set();
  for (let i = 0; i < rows.length; i++)
    for (const row of rows) {
      if (
        excluded.has(row.parent) ||
        /(?:[/\\]agent[/\\]|--thread-id)/.test(row.command)
      )
        excluded.add(row.pid);
      else if (included.has(row.parent)) included.add(row.pid);
    }
  const processes = rows.filter(
    (r) => included.has(r.pid) && !excluded.has(r.pid)
  );
  return {
    rssBytes: processes.reduce((sum, r) => sum + r.rssBytes, 0),
    processes,
    companionRssBytes: null,
  };
};
async function run(name, pair) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cutover-perf-"));
  fs.chmodSync(root, 0o700);
  const home = path.join(root, "home");
  fs.mkdirSync(home);
  let app;
  let run;
  try {
    const sourceHome = name === "new" ? values["new-home"] : values.home;
    const manifest = name === "new" ? candidateProducer : producer;
    if (sourceHome) {
      if (!manifest?.files)
        throw new Error("A supplied home requires its file manifest");
      for (const [relative, expectedHash] of Object.entries(manifest.files)) {
        if (path.isAbsolute(relative) || relative.split(/[\\/]/).includes(".."))
          throw new Error("Unsafe fixture path");
        const source = path.resolve(sourceHome, relative);
        if (
          fs.lstatSync(source).isSymbolicLink() ||
          hash(source) !== expectedHash
        )
          throw new Error(`Fixture hash mismatch: ${relative}`);
        const target = path.join(home, relative);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(source, target);
      }
    }
    fs.writeFileSync(
      path.join(
        home,
        producer?.provenance === "user-login"
          ? ".user-login-cutover-copy"
          : ".synthetic-cutover-home"
      ),
      producer?.provenance === "user-login"
        ? "Private user-login scratch copy; not source-generated\n"
        : "Synthetic comparative measurement\n"
    );
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
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
}
fs.mkdirSync(path.dirname(path.resolve(values.out)), { recursive: true });
try {
  for (let pair = 0; pair < 7; pair++)
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
