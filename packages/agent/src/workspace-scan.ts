/**
 * Finding the files worth indexing for `code_map`. The walk reads `.gitignore`
 * as it descends and stops on too many files, too deep, or too long; each
 * limit reports itself, since a map that silently stopped halfway reads like
 * a map of a smaller repository.
 */
import * as fs from "node:fs";
import * as path from "node:path";

/** Never worth indexing, and present in enough repositories to hardcode. */
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".hg",
  ".svn",
  "dist",
  "build",
  "out",
  "target",
  "__pycache__",
  ".venv",
  "venv",
  ".tox",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  "coverage",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".turbo",
  ".parcel-cache",
  "vendor",
  "third_party",
  "Pods",
  ".gradle",
  ".terraform",
  "bower_components",
]);

/** Generated or bundled sources: parse fine, tell you nothing. */
const GENERATED_FILE = /\.(min|bundle|chunk)\.[cm]?[jt]sx?$/i;

export interface ScanLimits {
  maxFiles: number;
  maxDepth: number;
  /** Wall clock for the walk itself, so a huge tree cannot hang a tool call. */
  timeBudgetMs: number;
  signal?: AbortSignal;
}

export interface ScanResult {
  files: string[];
  /** Files found beyond `maxFiles`; non-zero means the map is partial. */
  overflow: number;
  stoppedEarly: "files" | "depth" | "time" | "aborted" | null;
}

/**
 * One `.gitignore`, reduced to a predicate. A deliberate subset (no `\`
 * escapes, no character classes): the missing pieces are rare and a wrong
 * match here only costs coverage, never correctness.
 */
export interface IgnoreRules {
  ignores(relativePath: string, isDirectory: boolean): boolean;
}

interface Rule {
  matches(
    relativePath: string,
    segments: string[],
    isDirectory: boolean
  ): boolean;
  negated: boolean;
}

/** A pattern segment as a predicate: literal comparison when it has no wildcards. */
function segmentMatcher(segment: string): (value: string) => boolean {
  if (!/[*?]/.test(segment)) return (value) => value === segment;

  const regex = new RegExp(
    `^${segment
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, "[^/]*")
      .replace(/\?/g, "[^/]")}$`
  );

  return (value) => regex.test(value);
}

export function parseGitignore(contents: string): IgnoreRules {
  const rules: Rule[] = [];

  for (const raw of contents.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;

    let pattern = line;
    let negated = false;

    if (pattern.startsWith("!")) {
      negated = true;
      pattern = pattern.slice(1);
    }

    const directoryOnly = pattern.endsWith("/");
    if (directoryOnly) pattern = pattern.slice(0, -1);
    if (pattern === "") continue;

    // A pattern with no slash matches a path COMPONENT at any depth; one with a
    // slash is a path anchored to the directory holding the .gitignore.
    const anchored = pattern.includes("/");
    if (pattern.startsWith("/")) pattern = pattern.slice(1);

    if (!anchored) {
      // The common case: compare one component rather than run an
      // `.*`-prefixed regex over the whole path, which dominates a big walk.
      const matchesSegment = segmentMatcher(pattern);

      rules.push({
        negated,
        matches(_relativePath, segments, isDirectory) {
          for (let index = 0; index < segments.length; index++) {
            if (!matchesSegment(segments[index]!)) continue;
            // A non-final component is a directory, so `build/` covers its contents.
            if (!directoryOnly || isDirectory || index < segments.length - 1)
              return true;
          }

          return false;
        },
      });

      continue;
    }

    const body = pattern
      .split("/")
      .map((segment) =>
        segment === "**"
          ? "(?:.+)"
          : segment
              .replace(/[.+^${}()|[\]\\]/g, "\\$&")
              .replace(/\*/g, "[^/]*")
              .replace(/\?/g, "[^/]")
      )
      .join("/");

    const self = new RegExp(`^${body}$`);
    const under = new RegExp(`^${body}/`);

    rules.push({
      negated,
      matches(relativePath, _segments, isDirectory) {
        if (under.test(relativePath)) return true;

        return (!directoryOnly || isDirectory) && self.test(relativePath);
      },
    });
  }

  return {
    ignores(relativePath, isDirectory) {
      const segments = relativePath.split("/");
      let ignored = false;

      // Last matching rule wins, which is how negation re-includes a path.
      for (const rule of rules) {
        if (rule.matches(relativePath, segments, isDirectory))
          ignored = !rule.negated;
      }

      return ignored;
    },
  };
}

const EMPTY_RULES: IgnoreRules = { ignores: () => false };

/**
 * A `.gitignore` and the directory it governs. Anchored patterns are relative
 * to the file's own directory, so paths are rebased before matching.
 */
interface ScopedRules {
  base: string;
  rules: IgnoreRules;
}

function readGitignore(dir: string, base: string): ScopedRules {
  try {
    return {
      base,
      rules: parseGitignore(
        fs.readFileSync(path.join(dir, ".gitignore"), "utf8")
      ),
    };
  } catch {
    return { base, rules: EMPTY_RULES };
  }
}

/**
 * The ignore files ABOVE the directory being scanned: a walk started below
 * the repository root must still honour the root `.gitignore`. Climbing stops
 * at the repository root or after `maxUp` levels, never reaching `/`.
 */
export function ancestorRules(target: string, maxUp = 24): ScopedRules[] {
  const root = path.resolve(target);

  // At the repository root a stray .gitignore above the checkout must not
  // reach in.
  if (fs.existsSync(path.join(root, ".git"))) return [];

  const ancestors: string[] = [];
  let dir = root;

  for (let up = 0; up < maxUp; up++) {
    const parent = path.dirname(dir);
    if (parent === dir) break;

    ancestors.push(parent);
    dir = parent;

    // The repository root is where an ignore file stops applying to us.
    if (fs.existsSync(path.join(parent, ".git"))) break;
  }

  // Outermost first, so a nearer rule is applied last and wins.
  return ancestors.reverse().map((ancestor) => {
    // Ancestor patterns are relative to the ancestor; put the prefix back.
    const prefix = path.relative(ancestor, root).split(path.sep).join("/");
    const rules = readGitignore(ancestor, "").rules;

    return {
      base: "",
      rules:
        prefix === ""
          ? rules
          : { ignores: (p, isDir) => rules.ignores(`${prefix}/${p}`, isDir) },
    };
  });
}

function ignoredBy(
  scoped: ScopedRules[],
  relativePath: string,
  isDirectory: boolean
): boolean {
  return scoped.some(({ base, rules }) =>
    rules.ignores(
      base === "" ? relativePath : relativePath.slice(base.length + 1),
      isDirectory
    )
  );
}

/**
 * Every indexable file under `root`. Breadth-first so a partial scan is a
 * shallow map rather than one deep branch; sorted per level so an unchanged
 * tree gives byte-identical output. Symlinked directories are followed, each
 * resolved to its real path so a cycle ends and a shared tree is indexed once.
 */
export function collectFiles(
  root: string,
  isIndexable: (file: string) => boolean,
  limits: ScanLimits
): ScanResult {
  const deadline = Date.now() + limits.timeBudgetMs;
  const files: string[] = [];
  const visited = new Set<string>();
  let overflow = 0;
  let stoppedEarly: ScanResult["stoppedEarly"] = null;

  interface Pending {
    dir: string;
    relative: string;
    depth: number;
    rules: ScopedRules[];
  }

  // A moving index rather than `shift()`: with tens of thousands of
  // directories queued, shifting once per directory is quadratic.
  const queue: Pending[] = [
    { dir: root, relative: "", depth: 0, rules: ancestorRules(root) },
  ];
  let next = 0;

  while (next < queue.length) {
    if (limits.signal?.aborted) {
      stoppedEarly = "aborted";
      break;
    }

    if (Date.now() > deadline) {
      stoppedEarly = "time";
      break;
    }

    const current = queue[next]!;
    next++;

    if (current.depth > limits.maxDepth) {
      stoppedEarly = "depth";
      continue;
    }

    let real: string;
    try {
      real = fs.realpathSync(current.dir);
    } catch {
      continue;
    }

    if (visited.has(real)) continue;
    visited.add(real);

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current.dir, { withFileTypes: true });
    } catch {
      // A permission-denied subtree is normal and not worth failing the scan.
      continue;
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));

    // Only open .gitignore when the listing has one; a blind failed open per
    // directory is most of the cost of walking a directory-heavy tree.
    const rules = entries.some((entry) => entry.name === ".gitignore")
      ? [...current.rules, readGitignore(current.dir, current.relative)]
      : current.rules;

    const ignored = (candidate: string, isDirectory: boolean): boolean =>
      ignoredBy(rules, candidate, isDirectory);

    for (const entry of entries) {
      const full = path.join(current.dir, entry.name);
      const childRelative =
        current.relative === ""
          ? entry.name
          : `${current.relative}/${entry.name}`;

      // A symlink is neither isFile() nor isDirectory(); stat resolves it.
      let isDirectory = entry.isDirectory();
      let isFile = entry.isFile();

      if (entry.isSymbolicLink()) {
        try {
          const stats = fs.statSync(full);
          isDirectory = stats.isDirectory();
          isFile = stats.isFile();
        } catch {
          continue;
        }
      }

      if (isDirectory) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
        if (ignored(childRelative, true)) continue;

        queue.push({
          dir: full,
          relative: childRelative,
          depth: current.depth + 1,
          rules,
        });

        continue;
      }

      if (!isFile) continue;
      if (GENERATED_FILE.test(entry.name)) continue;
      if (!isIndexable(full)) continue;
      if (ignored(childRelative, false)) continue;

      if (files.length >= limits.maxFiles) {
        overflow++;
        stoppedEarly = "files";
        continue;
      }

      files.push(full);
    }

    if (stoppedEarly === "files") break;
  }

  // Level order is not path order; sort once at the end.
  files.sort();

  return { files, overflow, stoppedEarly };
}

/**
 * Whether a file's *contents* are worth parsing. Extension is a claim, not a
 * fact: a one-line 300KB `.js` is a bundle and a `.py` with a NUL is not
 * Python, and both parse slowly into meaningless nodes.
 */
export function isIndexableContent(
  source: string
): { ok: true } | { ok: false; reason: "binary" | "minified" } {
  if (source.includes("\0")) return { ok: false, reason: "binary" };

  const lines = source.split("\n");
  const longest = lines.reduce((max, line) => Math.max(max, line.length), 0);

  // Bundles are long lines ON AVERAGE; the longest line alone would reject a
  // hand-written file with one enormous data literal.
  const mean = source.length / lines.length;
  const bundled = source.length > 50_000 && longest > 1_000 && mean > 200;

  return bundled ? { ok: false, reason: "minified" } : { ok: true };
}
