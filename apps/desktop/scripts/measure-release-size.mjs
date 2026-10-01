import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
const desktop = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const root = path.resolve(desktop, "../..");
const dist = path.join(desktop, "dist/renderer");
const files = fs
  .readdirSync(path.join(dist, "assets"))
  .filter((f) => f.endsWith(".js"));
const gzip = (file) => gzipSync(fs.readFileSync(path.join(dist, file))).length;
const initial = (html) =>
  [
    ...fs
      .readFileSync(path.join(dist, html), "utf8")
      .matchAll(/(?:src|href)="([^"?#]+\.(?:js|css))"/g),
  ].map((m) => m[1].replace(/^\//, ""));
const mainHtml = fs.existsSync(path.join(dist, "index-next.html"))
  ? "index-next.html"
  : "index.html";
const entryResources = new Set(
  [mainHtml, "index.html", "notch.html"]
    .flatMap((file) => initial(file))
    .map((file) => file.replace(/^\.\//, ""))
);
const largest = files
  .filter(
    (file) =>
      !/worker|ort-wasm/.test(file) && !entryResources.has(`assets/${file}`)
  )
  .toSorted((a, b) => gzip(`assets/${b}`) - gzip(`assets/${a}`))[0];
if (!largest) throw new Error("No lazy JavaScript chunk was emitted");
const entries = [
  {
    name: "Main initial",
    path: initial(
      fs.existsSync(path.join(dist, "index-next.html"))
        ? "index-next.html"
        : "index.html"
    ),
  },
  { name: "Notch initial", path: initial("notch.html") },
  { name: "Largest lazy chunk", path: [`assets/${largest}`] },
  {
    name: "Math lazy chunk",
    path: files.filter((f) => f.startsWith("temml-")).map((f) => `assets/${f}`),
  },
].map((e) => ({ ...e, gzipBytes: e.path.reduce((n, f) => n + gzip(f), 0) }));
const report = {
  commit: JSON.parse(fs.readFileSync(path.join(dist, "build.json"))).commit,
  measuredAt: new Date().toISOString(),
  entries,
};
const target =
  process.argv[2] ??
  path.join(root, "docs/rewrite/reports/07-size-baseline.json");
fs.writeFileSync(target, JSON.stringify(report, null, 2) + "\n");
fs.writeFileSync(
  path.join(root, ".size-limit.json"),
  JSON.stringify(
    entries.map((e) => ({
      name: e.name,
      gzip: true,
      path: e.path.map((f) =>
        path.relative(root, path.join(dist, f)).replaceAll("\\", "/")
      ),
    })),
    null,
    2
  ) + "\n"
);
console.log(JSON.stringify(report, null, 2));
