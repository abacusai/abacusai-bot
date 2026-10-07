import fs from "node:fs";
import path from "node:path";

import spdx from "spdx-license-list/full.js";

import { licenseData, policyFailures, repositoryUrl } from "./license-data.mjs";
const graphOnly = process.argv.includes("--graph");

const root = path.resolve(import.meta.dirname, "../../..");
const desktop = path.join(root, "apps/desktop");
const packages = new Map();
// pnpm explicitly removes these backends from the installed/shipped graph.
const removed = new Set(
  [
    ...fs
      .readFileSync(path.join(root, "pnpm-workspace.yaml"), "utf8")
      .matchAll(/^  ([\w@/.-]+): ["']-["']$/gm),
  ].map((match) => match[1])
);
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
// Desktop and web builds can run concurrently. Publish only complete assets.
function writeOutput(file, text) {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, text);
  fs.renameSync(temporary, file);
}
function copyOutput(source, file) {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.copyFileSync(source, temporary);
  fs.renameSync(temporary, file);
}

function resolvePackage(name, from) {
  for (let dir = from; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, "node_modules", name, "package.json");
    if (fs.existsSync(candidate)) return path.dirname(candidate);
    if (dir === path.dirname(dir)) return undefined;
  }
}

/**
 * `bundled`: reached through a source map rather than a declared dependency.
 * A dependency of such a package that is not installed was not bundled
 * either (a platform-specific runtime the bundle never imports), so it is
 * skipped rather than treated as a broken install.
 */
function visit(directory, bundled = false) {
  const dir = fs.realpathSync(directory);
  if (packages.has(dir)) return;
  const pkg = readJson(path.join(dir, "package.json"));
  packages.set(dir, pkg);
  for (const name of Object.keys({
    ...pkg.dependencies,
    ...pkg.optionalDependencies,
    ...pkg.peerDependencies,
  })) {
    if (
      removed.has(name) ||
      (name.startsWith("@types/") && !pkg.dependencies?.[name])
    )
      continue;
    const dependency = resolvePackage(name, dir);
    if (dependency) visit(dependency, bundled);
    else if (
      !bundled &&
      !pkg.optionalDependencies?.[name] &&
      !pkg.peerDependencies?.[name]
    ) {
      throw new Error(
        `Missing dependency ${name} of ${pkg.name}; run pnpm install.`
      );
    }
  }
}

// Source maps identify dependencies bundled into the desktop's own bundles and
// the shared agent, including their devDependencies. No separate list of
// bundled packages to maintain.
function record(directory) {
  const dir = fs.realpathSync(directory);
  if (!packages.has(dir))
    packages.set(dir, readJson(path.join(dir, "package.json")));
}

function visitSourceMaps(directory, { optional = false } = {}) {
  // An optional directory (main's lazy chunks) may be absent or hold no maps
  // once nothing is split off; that is not a missing build.
  if (optional && !fs.existsSync(directory)) return;
  const maps = fs
    .readdirSync(directory)
    .filter((name) => name.endsWith(".map"));
  if (maps.length === 0) {
    if (optional) return;
    throw new Error(`Build before packaging: no source maps in ${directory}`);
  }
  for (const file of maps) {
    const map = readJson(path.join(directory, file));
    for (const source of map.sources) {
      if (!source.includes("node_modules/")) continue;
      let found = false;
      // Relative to the map's directory, or to the build's outDir for a
      // bundle written into a subdirectory of it (the renderer's assets/).
      for (const base of [directory, path.dirname(directory)]) {
        let dir = path.dirname(
          path.resolve(base, map.sourceRoot ?? "", source)
        );
        while (dir.includes(`${path.sep}node_modules${path.sep}`)) {
          const manifest = path.join(dir, "package.json");
          if (fs.existsSync(manifest) && readJson(manifest).name) {
            visit(dir, true);
            found = true;
            break;
          }
          dir = path.dirname(dir);
        }
        if (found) break;
      }
      if (!found)
        throw new Error(`Cannot resolve bundled dependency source: ${source}`);
    }
  }
}

// Packages the desktop source imports for their files rather than their code
// (fonts, icons, avatar styles) become emitted assets that no source map
// names. The import statements name them: a side-effect import of a package
// (JS `import "pkg"` or CSS `@import "pkg"`), or an import of a file with an
// asset extension from one. Test files are left out; nothing they import ships.
const ASSET_IMPORT =
  /(?:^|[\s;{}(@])import\s+["']([^"'.][^"']*)["']|\bfrom\s*["']([^"'.][^"']*\.(?:svg|png|jpe?g|gif|webp|css|woff2?|ttf|otf|wasm|json))["']/g;
function visitSourceImports(directory) {
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "test-support") walk(file);
      } else if (
        /\.(?:[cm]?[jt]sx?|css)$/.test(entry.name) &&
        !/\.test\.[cm]?[jt]sx?$/.test(entry.name)
      ) {
        for (const match of fs
          .readFileSync(file, "utf8")
          .matchAll(ASSET_IMPORT)) {
          const specifier = match[1] ?? match[2];
          if (specifier.startsWith("node:") || specifier.startsWith("#"))
            continue;
          const parts = specifier.split("/");
          const name = specifier.startsWith("@")
            ? parts.slice(0, 2).join("/")
            : parts[0];
          const dependency = resolvePackage(name, path.dirname(file));
          // The package alone: what it depends on is its build tooling, not
          // part of the files copied out of it.
          if (dependency) record(dependency);
        }
      }
    }
  };
  walk(directory);
}

visit(desktop);
visit(path.join(root, "apps/web"));
visit(path.join(root, "apps/updater"));
for (const entry of fs.readdirSync(path.join(root, "packages"))) {
  if (!["config", "test-support"].includes(entry))
    visit(path.join(root, "packages", entry));
}
if (!graphOnly) {
  visit(path.join(root, "packages/agent"));
  visitSourceMaps(path.join(root, "packages/agent/dist"));
  for (const bundle of ["main", "preload", "renderer/assets"])
    visitSourceMaps(path.join(desktop, "dist", bundle));
  visitSourceMaps(path.join(desktop, "dist", "main/assets"), {
    optional: true,
  });
}
visitSourceImports(path.join(desktop, "src"));
visitSourceImports(path.join(root, "apps/web/src"));

const supplements = readJson(path.join(desktop, "build/licenses/sources.json"));
const sections = [];
const dataEntries = [];
const missing = [];
const fallback = [];
for (const [dir, pkg] of [...packages].sort((a, b) =>
  `${a[1].name}@${a[1].version}`.localeCompare(
    `${b[1].name}@${b[1].version}`,
    "en"
  )
)) {
  if (!dir.includes(`${path.sep}node_modules${path.sep}`)) continue;
  const names = fs.readdirSync(dir);
  const files = names.filter(
    (name) =>
      /(?:^|[-_.])(licen[sc]e|copying|notice|copyright)(?:$|[-_.])/i.test(
        name
      ) && fs.statSync(path.join(dir, name)).isFile()
  );
  const texts = files
    .sort()
    .map((name) => fs.readFileSync(path.join(dir, name), "utf8"));
  if (!files.some((name) => /licen[sc]e|copying/i.test(name))) {
    const readme = names.find((name) => /^readme(?:\.|$)/i.test(name));
    const text = readme ? fs.readFileSync(path.join(dir, readme), "utf8") : "";
    if (/Permission (?:is hereby granted|to use, copy)/i.test(text)) {
      // Preserve the original copyright statement along with an embedded license.
      texts.push(text);
    } else {
      // Some npm tarballs supply an SPDX declaration without a license file.
      // Keep their attribution metadata and include the standard declared terms.
      const expression =
        typeof pkg.license === "string" ? pkg.license : pkg.license?.type;
      const ids = expression?.replace(/[()]/g, "").split(/\s+(?:OR|AND)\s+/);
      const licenses = ids?.map((id) =>
        Object.keys(spdx).find(
          (key) => key.toLowerCase() === id.trim().toLowerCase()
        )
      );
      if (!licenses?.length || licenses.some((id) => !id))
        missing.push(`${pkg.name}@${pkg.version}`);
      else {
        texts.push(
          `Upstream declares ${expression}; no separate license file is included in its npm package.\n` +
            licenses
              .map((id) =>
                ["MIT", "ISC"].includes(id)
                  ? spdx[id].licenseText.replace(/^Copyright[^\n]*\n/gm, "")
                  : spdx[id].licenseText
              )
              .join("\n\n")
        );
        fallback.push(`${pkg.name}@${pkg.version}`);
        // Readmes may carry attribution even when the license itself is omitted.
        if (text) texts.push(text);
      }
    }
  }
  const attribution = JSON.stringify(
    {
      author: pkg.author,
      contributors: pkg.contributors,
      repository: pkg.repository,
      homepage: pkg.homepage,
    },
    null,
    2
  );
  dataEntries.push({
    name: pkg.name,
    version: pkg.version,
    license: (typeof pkg.license === "string"
      ? pkg.license
      : (pkg.license?.type ?? "UNKNOWN")
    ).replace(
      /[A-Za-z0-9.-]+/g,
      (id) =>
        Object.keys(spdx).find(
          (key) => key.toLowerCase() === id.toLowerCase()
        ) ?? id
    ),
    url: repositoryUrl(pkg.repository, pkg.homepage),
    text: texts.join("\n\n"),
  });
  sections.push(
    `${pkg.name}@${pkg.version}\nLicense: ${pkg.license ?? "See license text"}\n${attribution}\n\n${texts.join("\n\n")}`
  );
}
if (missing.length)
  throw new Error(`Upstream license text missing for: ${missing.join(", ")}`);
for (const entry of supplements) {
  if (entry.pin) {
    const source = fs.readFileSync(path.join(root, entry.pin.file), "utf8");
    const pattern = new RegExp(
      `const ${entry.pin.constant}\\s*=\\s*(?:\\{[\\s\\S]*?version:\\s*)?["']([^"']+)`
    );
    const version = pattern.exec(source)?.[1];
    if (version !== entry.version)
      throw new Error(
        `Update license attribution for ${entry.name}: pinned ${version}, notices ${entry.version}`
      );
  }
  dataEntries.push({
    name: entry.name,
    version: entry.version,
    license: entry.license,
    url: entry.source,
    text: fs.readFileSync(
      path.join(desktop, "build/licenses", entry.file),
      "utf8"
    ),
  });
  sections.push(
    `${entry.asset}\nSource: ${entry.source}\n\n${fs.readFileSync(path.join(desktop, "build/licenses", entry.file), "utf8")}`
  );
}
for (const file of [
  "resources/decks/TEMPLATES-LICENSE",
  ...fs
    .readdirSync(path.join(desktop, "resources/pdf/fonts"))
    .filter((name) => name.startsWith("LICENSE-"))
    .map((name) => `resources/pdf/fonts/${name}`),
]) {
  dataEntries.push({
    name: file,
    version: "asset",
    license: file.includes("TEMPLATES") ? "MIT" : "OFL-1.1",
    text: fs.readFileSync(path.join(desktop, file), "utf8"),
  });
  sections.push(
    `${file}\n\n${fs.readFileSync(path.join(desktop, file), "utf8")}`
  );
}
sections.push(
  `Connector icon paths from simple-icons\nSource: https://github.com/simple-icons/simple-icons\n\n${spdx["CC0-1.0"].licenseText}`
);
dataEntries.push({
  name: "simple-icons connector paths",
  version: "asset",
  license: "CC0-1.0",
  url: "https://github.com/simple-icons/simple-icons",
  text: spdx["CC0-1.0"].licenseText,
});
const electronDir = resolvePackage("electron", desktop);
if (!electronDir) throw new Error("Electron is not installed");
const electronPkg = readJson(path.join(electronDir, "package.json"));
const electronLicense = fs.readFileSync(
  path.join(electronDir, "dist/LICENSE"),
  "utf8"
);
dataEntries.push({
  name: "Electron",
  version: electronPkg.version,
  license: "MIT",
  url: "https://github.com/electron/electron",
  text: electronLicense,
});
sections.push(
  `Electron ${electronPkg.version}\n${electronLicense}\nChromium and embedded Node.js notices: LICENSES.chromium.html (included alongside these notices).`
);
const reviews = readJson(path.join(desktop, "build/licenses/reviews.json"));
const failures = policyFailures(dataEntries, reviews);
if (failures.length)
  throw new Error(`License policy rejected:\n${failures.join("\n")}`);
for (const entry of dataEntries) {
  const review = reviews[`${entry.name}@${entry.version}`];
  if (review) entry.review = review.reason;
}
console.log(`Pinned policy review entries: ${Object.keys(reviews).join(", ")}`);
const data = licenseData(dataEntries);
const publicDir = path.join(root, "apps/web/public/licenses");
fs.mkdirSync(publicDir, { recursive: true });
writeOutput(path.join(publicDir, "licenses.json"), JSON.stringify(data));
copyOutput(
  path.join(electronDir, "dist/LICENSES.chromium.html"),
  path.join(publicDir, "LICENSES.chromium.html")
);
const entries = [...new Set(sections)];
const output = path.join(desktop, "dist/THIRD_PARTY_NOTICES.txt");
fs.mkdirSync(path.dirname(output), { recursive: true });
writeOutput(
  output,
  `Third-party software in AbacusAI Bot\nGenerated from installed desktop dependencies, desktop source imports and bundled desktop and agent source maps.\nDependencies may include code removed by tree shaking.\n\n${entries.join("\n\n" + "=".repeat(72) + "\n\n")}\n`
);
console.log(
  `Generated desktop notices for ${entries.length} dependency and asset entries (${fallback.length} use declared SPDX terms).`
);

copyOutput(output, path.join(publicDir, "THIRD_PARTY_NOTICES.txt"));
copyOutput(
  path.join(electronDir, "dist/LICENSES.chromium.html"),
  path.join(desktop, "dist/LICENSES.chromium.html")
);
console.log(
  `License policy passed: ${data.packages.length} entries, ${Object.keys(data.texts).length} unique texts.`
);

if (!graphOnly) {
  const rendererLicenses = path.join(desktop, "dist/renderer/licenses");
  fs.mkdirSync(rendererLicenses, { recursive: true });
  for (const file of [
    "licenses.json",
    "THIRD_PARTY_NOTICES.txt",
    "LICENSES.chromium.html",
  ])
    copyOutput(path.join(publicDir, file), path.join(rendererLicenses, file));
}
