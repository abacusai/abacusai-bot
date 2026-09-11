import fs from "node:fs";
import path from "node:path";

import spdx from "spdx-license-list/full.js";

const root = path.resolve(import.meta.dirname, "../../..");
const desktop = path.join(root, "apps/desktop");
const packages = new Map();
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

function resolvePackage(name, from) {
  for (let dir = from; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, "node_modules", name, "package.json");
    if (fs.existsSync(candidate)) return path.dirname(candidate);
    if (dir === path.dirname(dir)) return undefined;
  }
}

function visit(directory) {
  const dir = fs.realpathSync(directory);
  if (packages.has(dir)) return;
  const pkg = readJson(path.join(dir, "package.json"));
  packages.set(dir, pkg);
  for (const name of Object.keys({
    ...pkg.dependencies,
    ...pkg.optionalDependencies,
    ...pkg.peerDependencies,
  })) {
    const dependency = resolvePackage(name, dir);
    if (dependency) visit(dependency);
    else if (
      !pkg.optionalDependencies?.[name] &&
      !pkg.peerDependencies?.[name]
    ) {
      throw new Error(
        `Missing dependency ${name} of ${pkg.name}; run pnpm install.`
      );
    }
  }
}

// Source maps identify dependencies bundled into the shared desktop agent,
// including its devDependencies. No separate list of bundled packages to maintain.
function visitSourceMaps(directory) {
  const maps = fs
    .readdirSync(directory)
    .filter((name) => name.endsWith(".js.map"));
  if (maps.length === 0)
    throw new Error(
      `Build the agent before packaging: no source maps in ${directory}`
    );
  for (const file of maps) {
    const map = readJson(path.join(directory, file));
    for (const source of map.sources) {
      if (!source.includes("node_modules/")) continue;
      let dir = path.dirname(
        path.resolve(directory, map.sourceRoot ?? "", source)
      );
      let found = false;
      while (dir.includes(`${path.sep}node_modules${path.sep}`)) {
        const manifest = path.join(dir, "package.json");
        if (fs.existsSync(manifest) && readJson(manifest).name) {
          visit(dir);
          found = true;
          break;
        }
        dir = path.dirname(dir);
      }
      if (!found)
        throw new Error(`Cannot resolve bundled dependency source: ${source}`);
    }
  }
}

visit(desktop);
visit(path.join(root, "packages/agent"));
visit(path.join(root, "apps/updater"));
visitSourceMaps(path.join(root, "packages/agent/dist"));

const supplements = readJson(path.join(desktop, "build/licenses/sources.json"));
const sections = [];
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
  sections.push(
    `${pkg.name}@${pkg.version}\nLicense: ${pkg.license ?? "See license text"}\n${attribution}\n\n${texts.join("\n\n")}`
  );
}
if (missing.length)
  throw new Error(`Upstream license text missing for: ${missing.join(", ")}`);
for (const entry of supplements) {
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
  sections.push(
    `${file}\n\n${fs.readFileSync(path.join(desktop, file), "utf8")}`
  );
}
sections.push(
  `Connector icon paths from simple-icons\nSource: https://github.com/simple-icons/simple-icons\n\n${spdx["CC0-1.0"].licenseText}`
);
const entries = [...new Set(sections)];
const output = path.join(desktop, "dist/THIRD-PARTY-NOTICES.txt");
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(
  output,
  `Third-party software in AbacusAI-Bot\nGenerated from installed desktop dependencies and bundled agent source maps.\nDependencies may include code removed by tree shaking.\n\n${entries.join("\n\n" + "=".repeat(72) + "\n\n")}\n`
);
console.log(
  `Generated desktop notices for ${entries.length} dependency and asset entries (${fallback.length} use declared SPDX terms).`
);
