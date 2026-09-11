/** Classify a source change into the smallest safe client release. */

export type ReleaseKind = "experience" | "foundation" | "none";

/**
 * Hot-swappable code that ships in the signed experience archive. package.json,
 * the lockfile and patches/ are deliberately absent: the experience bundles
 * resolve dependencies from the foundation's node_modules, so a dependency
 * update is a foundation release by construction.
 */
const EXPERIENCE_PREFIXES = [
  "apps/desktop/index.html",
  "apps/desktop/src/renderer/",
  "packages/agent/src/",
];

/** Paths that never reach a desktop install through either release unit. */
const IGNORED_PREFIXES = [
  ".claude/",
  ".github/",
  ".vscode/",
  "apps/updater/",
  "docs/",
  "packages/test-support/",
];
const IGNORED_FILES = new Set([
  ".editorconfig",
  ".git-blame-ignore-revs",
  ".gitignore",
  ".nvmrc",
  "AGENTS.md",
  "CLAUDE.md",
  "CODE_OF_CONDUCT.md",
  "CONTRIBUTING.md",
  "LICENSE",
  "NOTICE",
  "README.md",
  "SECURITY.md",
  "renovate.json",
]);

export const classify = (paths: Iterable<string>): ReleaseKind => {
  let kind: ReleaseKind = "none";
  for (const raw of paths) {
    const cleaned = raw.trim().replaceAll("\\", "/").replace(/^\.\//u, "");
    if (
      cleaned === "" ||
      IGNORED_FILES.has(cleaned) ||
      IGNORED_PREFIXES.some((prefix) => cleaned.startsWith(prefix))
    ) {
      continue;
    }
    if (EXPERIENCE_PREFIXES.some((prefix) => cleaned.startsWith(prefix))) {
      kind = "experience";
      continue;
    }
    // Unknown files fail toward the signed foundation release, keeping
    // dependency, protocol, preload and native changes out of hot-swappable
    // code.
    return "foundation";
  }
  return kind;
};

if (/classify\.(?:m?ts|m?js)$/u.test(process.argv[1] ?? "")) {
  const args = process.argv.slice(2);
  let paths = args;
  if (paths.length === 0) {
    let text = "";
    process.stdin.setEncoding("utf-8");
    for await (const chunk of process.stdin) {
      text += String(chunk);
    }
    paths = text.split("\n").filter((line) => line !== "");
  }
  console.log(JSON.stringify({ kind: classify(paths), paths }));
}
