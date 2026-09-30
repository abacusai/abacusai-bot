#!/usr/bin/env node
/**
 * The old renderer stays behaviour-identical (spec 01 §12, Codex r1 #24):
 * against the base ref, the only files under src/renderer that may change
 * are the locale JSON files, and there only by adding keys. A removed key or
 * a changed value fails.
 *
 *   node scripts/check-legacy-renderer-diff.mjs [base-ref]
 *   (default: $LEGACY_BASE or rewrite/renderer)
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const desktop = join(import.meta.dirname, "..");
const base = process.argv[2] ?? process.env.LEGACY_BASE ?? "rewrite/renderer";

const git = (...args) =>
  execFileSync("git", args, { cwd: desktop, encoding: "utf8" });

const mergeBase = git("merge-base", "HEAD", base).trim();
const changed = git("diff", "--name-only", mergeBase, "--", "src/renderer")
  .split("\n")
  .filter(Boolean)
  // git prints paths relative to the repository root.
  .map((path) => path.replace(/^apps\/desktop\//, ""));

const problems = [];
const LOCALE = /^src\/renderer\/locales\/[^/]+\.json$/;

const flatten = (object, prefix = "", out = new Map()) => {
  for (const [key, value] of Object.entries(object)) {
    const full = prefix === "" ? key : `${prefix}.${key}`;
    if (value !== null && typeof value === "object" && !Array.isArray(value))
      flatten(value, full, out);
    else out.set(full, value);
  }
  return out;
};

for (const file of changed) {
  if (!LOCALE.test(file)) {
    problems.push(`${file}: only locale JSON may change under src/renderer`);
    continue;
  }
  let before;
  try {
    before = JSON.parse(git("show", `${mergeBase}:apps/desktop/${file}`));
  } catch {
    problems.push(`${file}: new locale file`);
    continue;
  }
  const after = JSON.parse(readFileSync(join(desktop, file), "utf8"));
  const was = flatten(before);
  const now = flatten(after);
  for (const [key, value] of was) {
    if (!now.has(key)) problems.push(`${file}: removed ${key}`);
    else if (now.get(key) !== value) problems.push(`${file}: changed ${key}`);
  }
}

if (problems.length > 0) {
  console.error(`check-legacy-renderer-diff (base ${base}):`);
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}
console.log(
  `check-legacy-renderer-diff: ${changed.length} file(s) under src/renderer changed, additions only (base ${base})`
);
