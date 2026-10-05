import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { specifiers } from "./parsed-source.mjs";

export const gitBlob = (data) =>
  createHash("sha1").update(`blob ${data.length}\0`).update(data).digest("hex");
export const resolveLocal = (specifier, importer, desktop) => {
  const clean = specifier.split("?")[0];
  const aliases = {
    "#main/": path.join(desktop, "src/main"),
    "@abacus-ai/contract/": path.resolve(
      desktop,
      "../../packages/contract/src"
    ),
    "#preload/": path.join(desktop, "src/preload"),
    "#renderer/": path.resolve(desktop, "../web/src"),
    "#locales/": path.resolve(desktop, "../web/src/locales"),
  };
  let target;
  for (const [alias, tree] of Object.entries(aliases))
    if (clean.startsWith(alias))
      target = path.join(tree, clean.slice(alias.length));
  if (clean.startsWith("."))
    target = path.resolve(path.dirname(importer), clean);
  if (!target) return null;
  const found = [
    target,
    ...[".ts", ".tsx", ".js", ".mjs", ".d.ts", "/index.ts", "/index.tsx"].map(
      (suffix) => target + suffix
    ),
  ].find((file) => fs.existsSync(file) && fs.statSync(file).isFile());
  if (!found)
    throw new Error(`Deleted or missing import ${specifier} in ${importer}`);
  return found;
};
export const checkDeletions = (repo) => {
  const desktop = path.join(repo, "apps/desktop");
  const inventory = JSON.parse(
    fs.readFileSync(
      path.join(repo, "scripts/cutover/legacy-renderer-inventory.json")
    )
  );
  const moved = JSON.parse(
    fs.readFileSync(
      path.join(repo, "scripts/cutover/renderer-move-inventory.json")
    )
  );
  for (const { path: file, blob } of inventory.files) {
    const target = path.join(repo, file);
    if (
      fs.existsSync(target) &&
      gitBlob(fs.readFileSync(target)) === blob &&
      !moved.files.some((entry) => entry.path === file && entry.blob === blob)
    )
      throw new Error(`Legacy blob remains: ${file}`);
  }
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (/\.(?:ts|tsx|js|mjs)$/.test(file))
        for (const value of specifiers(file))
          resolveLocal(value, file, desktop);
    }
  };
  for (const tree of [
    "apps/desktop/src",
    "apps/web/src",
    "packages/contract/src",
  ])
    visit(path.join(repo, tree));
};
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  checkDeletions(process.cwd());
  console.log("Legacy inventory and resolved imports pass.");
}
