#!/usr/bin/env node
/**
 * The old renderer stays behaviour-identical (spec 01 §12, Codex r1 #24):
 * against the merge-base with `main` (where the rewrite lands), the only
 * files under src/renderer that may change are the locale JSON files, and
 * there only by adding keys. A removed key or a changed value fails.
 *
 *   node scripts/check-legacy-renderer-diff.mjs [base-ref]
 *   (default: $LEGACY_BASE, else origin/$GITHUB_BASE_REF in CI, else main,
 *   else origin/main)
 *
 * Never the rewrite branch itself: the merge-base of HEAD with the branch it
 * is on is HEAD, which compares the tree with itself and passes everything
 * (Claude impl r1 #11). Wired into the root `check`.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const desktop = join(import.meta.dirname, "..");

const run = (...args) =>
  execFileSync("git", args, {
    cwd: desktop,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

const refExists = (ref) => {
  try {
    run("rev-parse", "--verify", "--quiet", `${ref}^{commit}`);
    return true;
  } catch {
    return false;
  }
};

/** The ref to diff against (exported for the test). */
export const resolveBase = (argv, env, exists = refExists) => {
  if (argv[0] != null) return argv[0];
  if (env.LEGACY_BASE) return env.LEGACY_BASE;
  const candidates = [
    ...(env.GITHUB_BASE_REF ? [`origin/${env.GITHUB_BASE_REF}`] : []),
    "main",
    "origin/main",
  ];
  const found = candidates.find((ref) => exists(ref));
  if (found == null)
    throw new Error(
      `check-legacy-renderer-diff: none of ${candidates.join(", ")} exists`
    );
  return found;
};

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

/** Problems in `changed` locale files against `read(file)` at the base. */
export const localeProblems = (file, before, after) => {
  const problems = [];
  const was = flatten(before);
  const now = flatten(after);
  for (const [key, value] of was) {
    if (!now.has(key)) problems.push(`${file}: removed ${key}`);
    else if (now.get(key) !== value) problems.push(`${file}: changed ${key}`);
  }
  return problems;
};

const main = () => {
  const base = resolveBase(process.argv.slice(2), process.env);
  const mergeBase = run("merge-base", "HEAD", base).trim();
  const changed = run("diff", "--name-only", mergeBase, "--", "src/renderer")
    .split("\n")
    .filter(Boolean)
    // Paths come relative to the repository root.
    .map((path) => path.replace(/^apps\/desktop\//, ""));

  const { allow } = JSON.parse(
    readFileSync(
      join(import.meta.dirname, "legacy-renderer-allow.json"),
      "utf8"
    )
  );
  const sanctioned = (file) =>
    allow.some(
      (entry) =>
        entry.path === file &&
        run("diff", "--name-only", entry.commit, "--", file).trim() === ""
    );

  const problems = [];
  for (const file of changed) {
    if (sanctioned(file)) continue;
    if (!LOCALE.test(file)) {
      problems.push(`${file}: only locale JSON may change under src/renderer`);
      continue;
    }
    let before;
    try {
      before = JSON.parse(run("show", `${mergeBase}:apps/desktop/${file}`));
    } catch {
      problems.push(`${file}: new locale file`);
      continue;
    }
    const after = JSON.parse(readFileSync(join(desktop, file), "utf8"));
    problems.push(...localeProblems(file, before, after));
  }

  if (problems.length > 0) {
    console.error(`check-legacy-renderer-diff (base ${base} @ ${mergeBase}):`);
    for (const problem of problems) console.error(`  ${problem}`);
    process.exit(1);
  }
  console.log(
    `check-legacy-renderer-diff: ${changed.length} file(s) under src/renderer changed, additions only (base ${base} @ ${mergeBase.slice(0, 8)})`
  );
};

if (import.meta.url === `file://${process.argv[1]}`) main();
