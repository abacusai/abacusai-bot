#!/usr/bin/env node
/**
 * Stops a pull request from losing work without saying so. A stale copy of a
 * file can remove a fix and the tests that guard it together, and CI stays
 * green because nothing is left to fail. Two checks, on the diff from BASE:
 *
 * - tests: a test file ends with fewer test cases, and their titles did not
 *   move to another file in this change.
 * - undone: most of what one recent commit added is removed here.
 *
 * Either one fails until the pull request body says why, on a line of its own:
 *   Removes on purpose: <reason>
 */
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const RECENT_DAYS = 14;
const UNDONE_SHARE = 0.7;
const UNDONE_MIN_LINES = 8;
// Regenerated, so a dependency bump in it reads as undoing the last one.
const LOCKFILE = "pnpm-lock.yaml";
const ACK = /^Removes on purpose:\s*\S/m;
const TEST_FILE = /\.test\.[cm]?[jt]sx?$/;
const TEST_CASE = /^\s*(?:it|test)(?:\.\w+)*\(\s*(["'`])(.+?)\1/gm;

const git = (...args) =>
  execFileSync("git", args, {
    encoding: "utf8",
    maxBuffer: 1 << 28,
    stdio: ["ignore", "pipe", "ignore"],
  });

const fileAt = (rev, file) => {
  try {
    return git("show", `${rev}:${file}`);
  } catch {
    return "";
  }
};

export const testTitles = (source) =>
  [...source.matchAll(TEST_CASE)].map((match) => match[2]);

/** Test cases `before` has that `after` does not, by count of each title. */
export const lostTests = (files) => {
  const kept = new Set(files.flatMap(({ after }) => testTitles(after)));
  return files.flatMap(({ file, before, after }) => {
    const titles = testTitles(before);
    const shortBy = titles.length - testTitles(after).length;
    if (shortBy <= 0) return [];
    const gone = titles.filter((title) => !kept.has(title));
    return gone.slice(0, shortBy).map((title) => ({ file, title }));
  });
};

/** Hunks of `base..head` as removed line ranges of each file at `base`. */
const removedRanges = (base, head) => {
  const ranges = new Map();
  let file = null;
  const diff = git("diff", "-U0", "--no-renames", base, head);
  for (const line of diff.split("\n")) {
    if (line.startsWith("--- ")) {
      const path = line.slice(6);
      file = line === "--- /dev/null" || path === LOCKFILE ? null : path;
      continue;
    }
    const hunk = /^@@ -(\d+)(?:,(\d+))? /.exec(line);
    if (hunk == null || file == null) continue;
    const count = hunk[2] == null ? 1 : Number(hunk[2]);
    if (count === 0) continue;
    const start = Number(hunk[1]);
    ranges.set(file, [...(ranges.get(file) ?? []), [start, start + count - 1]]);
  }
  return ranges;
};

const addedLines = (commit) => {
  const diff = git("show", "--format=", "-U0", commit, "--", `:!${LOCKFILE}`);
  return diff.split("\n").filter((line) => /^\+(?!\+\+ )\s*\S/.test(line))
    .length;
};

const undoneWork = (base, head) => {
  const since = Date.parse(git("log", "-1", "--format=%cI", base).trim());
  const removed = new Map();
  for (const [file, ranges] of removedRanges(base, head)) {
    const spans = ranges.flatMap(([a, b]) => ["-L", `${a},${b}`]);
    const blame = git("blame", "--line-porcelain", ...spans, base, "--", file);
    let commit = null;
    let time = 0;
    for (const line of blame.split("\n")) {
      const header = /^([0-9a-f]{40}) \d+ \d+/.exec(line);
      if (header != null) commit = header[1];
      else if (line.startsWith("committer-time "))
        time = Number(line.slice(15));
      else if (line.startsWith("\t") && line.trim() !== "") {
        if (since - time * 1000 > RECENT_DAYS * 86_400_000) continue;
        const key = `${commit}\0${file}`;
        removed.set(key, (removed.get(key) ?? 0) + 1);
      }
    }
  }
  const byCommit = new Map();
  for (const [key, lines] of removed) {
    const [commit, file] = key.split("\0");
    byCommit.set(commit, [...(byCommit.get(commit) ?? []), { file, lines }]);
  }
  return [...byCommit]
    .map(([commit, files]) => ({
      commit,
      files,
      lines: files.reduce((sum, { lines }) => sum + lines, 0),
    }))
    .filter(
      ({ commit, lines }) =>
        lines >= UNDONE_MIN_LINES &&
        lines / Math.max(addedLines(commit), 1) >= UNDONE_SHARE
    );
};

export const findLostWork = (base, head) => {
  const changed = git("diff", "--name-only", "--no-renames", base, head)
    .split("\n")
    .filter((file) => TEST_FILE.test(file));
  return {
    tests: lostTests(
      changed.map((file) => ({
        file,
        before: fileAt(base, file),
        after: fileAt(head, file),
      }))
    ),
    undone: undoneWork(base, head),
  };
};

const main = () => {
  const head = process.env.HEAD_SHA ?? "HEAD";
  const base = git(
    "merge-base",
    process.env.BASE_SHA ?? "origin/main",
    head
  ).trim();
  const { tests, undone } = findLostWork(base, head);
  for (const { file, title } of tests)
    console.log(`test case removed: ${file}: ${title}`);
  for (const { commit, files, lines } of undone) {
    const subject = git("log", "-1", "--format=%s", commit).trim();
    const where = files.map(({ file }) => file).join(", ");
    console.log(
      `undoes ${lines} lines of ${commit.slice(0, 8)} ${subject}: ${where}`
    );
  }
  if (tests.length === 0 && undone.length === 0) return;
  if (ACK.test(process.env.PR_BODY ?? "")) {
    console.log("Accepted: the pull request says why.");
    return;
  }
  console.error(
    "This change removes tests or recent work. If that is meant, add a line to " +
      'the pull request body: "Removes on purpose: <reason>". If not, it is ' +
      "probably a stale copy: rebase and put the work back."
  );
  process.exitCode = 1;
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
