/**
 * The walk, and the three ways it is allowed to stop.
 *
 * A scan that silently skipped half a repository would be indistinguishable
 * from a smaller repository, so every limit here is asserted twice: that it
 * bites, and that it says so.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  collectFiles,
  isIndexableContent,
  parseGitignore,
} from "./workspace-scan.js";

let root: string;

const limits = { maxFiles: 1_000, maxDepth: 16, timeBudgetMs: 5_000 };

/** Everything the walk found, relative to the root and with stable separators. */
function scan(
  overrides: Partial<typeof limits> & { signal?: AbortSignal } = {}
) {
  const result = collectFiles(root, (file) => file.endsWith(".ts"), {
    ...limits,
    ...overrides,
  });

  return {
    ...result,
    files: result.files.map((file) =>
      path.relative(root, file).split(path.sep).join("/")
    ),
  };
}

function write(relative: string, contents = "export const x = 1"): void {
  const full = path.join(root, relative);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, contents);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "code-map-scan-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("what the walk collects", () => {
  it("returns a stable, sorted order so two runs produce the same map", () => {
    write("src/zebra.ts");
    write("src/alpha.ts");
    write("lib/mid.ts");

    expect(scan().files).toEqual([
      "lib/mid.ts",
      "src/alpha.ts",
      "src/zebra.ts",
    ]);
  });

  it("takes only what the caller says it can index", () => {
    write("keep.ts");
    write("skip.md", "# no");
    write("skip.bin", "\u0000");

    expect(scan().files).toEqual(["keep.ts"]);
  });

  it("skips build output, dependencies and dot directories without being told", () => {
    write("src/real.ts");
    write("node_modules/pkg/index.ts");
    write("dist/bundle.ts");
    write(".venv/lib/thing.ts");
    write("vendor/dep.ts");
    write(".github/scripts/ci.ts");

    expect(scan().files).toEqual(["src/real.ts"]);
  });

  it("skips minified and bundled files by name", () => {
    write("src/app.ts");
    write("src/app.min.ts");
    write("src/vendor.bundle.ts");

    expect(scan().files).toEqual(["src/app.ts"]);
  });
});

describe(".gitignore", () => {
  it("honours the root ignore file", () => {
    write(".gitignore", "generated/\n*.gen.ts\n");
    write("src/real.ts");
    write("src/schema.gen.ts");
    write("generated/client.ts");

    expect(scan().files).toEqual(["src/real.ts"]);
  });

  it("honours a nested ignore file, and only below itself", () => {
    write(".gitignore", "");
    write("packages/api/.gitignore", "local.ts\n");
    write("packages/api/local.ts");
    write("packages/api/real.ts");
    write("packages/web/local.ts");

    expect(scan().files).toEqual([
      "packages/api/real.ts",
      "packages/web/local.ts",
    ]);
  });

  it("anchors a nested ignore file to its own directory", () => {
    write("packages/api/.gitignore", "/local.ts\n");
    write("packages/api/local.ts");
    write("packages/api/nested/local.ts");

    expect(scan().files).toEqual(["packages/api/nested/local.ts"]);
  });

  it("honours an ignore file ABOVE the directory being scanned", () => {
    // `code_map path: "packages/agent"` starts below the repository root. The
    // root .gitignore is where the generated directories are actually named, so
    // without this a subdirectory scan returns the machine output that a
    // whole-tree scan correctly hides.
    write(".gitignore", "pkg/generated/\n*.gen.ts\n");
    write("pkg/src/real.ts");
    write("pkg/src/schema.gen.ts");
    write("pkg/generated/client.ts");

    const result = collectFiles(
      path.join(root, "pkg"),
      (file) => file.endsWith(".ts"),
      limits
    );

    expect(
      result.files.map((file) =>
        path.relative(root, file).split(path.sep).join("/")
      )
    ).toEqual(["pkg/src/real.ts"]);
  });

  it("stops climbing at the repository root", () => {
    // A .gitignore outside the repository must not reach in. `.git` marks where
    // to stop; without it the walk would keep climbing towards /.
    fs.mkdirSync(path.join(root, "repo", ".git"), { recursive: true });
    write(".gitignore", "*.ts\n");
    write("repo/src/real.ts");

    const result = collectFiles(
      path.join(root, "repo"),
      (file) => file.endsWith(".ts"),
      limits
    );

    expect(result.files).toHaveLength(1);
  });

  it("re-includes through negation, last rule winning", () => {
    write(".gitignore", "*.ts\n!keep.ts\n");
    write("keep.ts");
    write("drop.ts");

    expect(scan().files).toEqual(["keep.ts"]);
  });

  it("cannot re-include under an excluded directory, which is what git does too", () => {
    write(".gitignore", "build/\n!build/keep.ts\n");
    write("build/keep.ts");

    expect(scan().files).toEqual([]);
  });

  it("anchors a leading slash to the root and leaves the same name deeper alone", () => {
    write(".gitignore", "/config.ts\n");
    write("config.ts");
    write("src/config.ts");

    expect(scan().files).toEqual(["src/config.ts"]);
  });

  it("ignores comments and blank lines rather than treating them as patterns", () => {
    write(".gitignore", "\n# a comment\n\n   \n");
    write("src/real.ts");

    expect(scan().files).toEqual(["src/real.ts"]);
  });

  it("survives an unreadable or absent ignore file", () => {
    write("src/real.ts");

    expect(scan().files).toEqual(["src/real.ts"]);
  });
});

describe("pattern matching", () => {
  const cases: Array<[string, string, boolean]> = [
    ["*.log", "debug.log", true],
    ["*.log", "logs/debug.log", true],
    ["/*.log", "logs/debug.log", false],
    ["docs/*.md", "docs/readme.md", true],
    ["docs/*.md", "docs/deep/readme.md", false],
    ["**/fixtures", "a/b/fixtures", true],
    ["file?.ts", "file1.ts", true],
    ["file?.ts", "file12.ts", false],
    ["a.b.c", "a.b.c", true],
    ["a.b.c", "axbxc", false],
  ];

  it.each(cases)("%s vs %s", (pattern, candidate, expected) => {
    expect(parseGitignore(pattern).ignores(candidate, false)).toBe(expected);
  });

  it("applies a directory-only pattern to directories alone", () => {
    const rules = parseGitignore("build/");

    expect(rules.ignores("build", true)).toBe(true);
    expect(rules.ignores("build", false)).toBe(false);
  });

  it("ignores everything under an ignored directory", () => {
    expect(
      parseGitignore("build/").ignores("build/nested/file.ts", false)
    ).toBe(true);
  });
});

describe("limits", () => {
  it("stops at the file cap and reports that it did", () => {
    for (let index = 0; index < 12; index++) write(`src/file${index}.ts`);

    const result = scan({ maxFiles: 5 });

    expect(result.files).toHaveLength(5);
    expect(result.stoppedEarly).toBe("files");
    expect(result.overflow).toBeGreaterThan(0);
  });

  it("stops at the depth cap and reports that it did", () => {
    write(`${"a/".repeat(6)}deep.ts`);

    const result = scan({ maxDepth: 3 });

    expect(result.files).toEqual([]);
    expect(result.stoppedEarly).toBe("depth");
  });

  it("stops when the time budget is gone", () => {
    write("src/real.ts");

    const result = scan({ timeBudgetMs: -1 });

    expect(result.stoppedEarly).toBe("time");
  });

  it("stops when the caller aborts", () => {
    write("src/real.ts");
    const controller = new AbortController();
    controller.abort();

    expect(scan({ signal: controller.signal }).stoppedEarly).toBe("aborted");
  });

  it("takes files before descending, so a partial scan is the top of the tree", () => {
    write("a.ts");
    write("deep/one/two/b.ts");

    expect(scan({ maxFiles: 1 }).files).toEqual(["a.ts"]);
  });
});

describe("symlinks and unreadable paths", () => {
  it("follows a symlinked directory, and indexes shared content once", () => {
    write("shared/util.ts");
    fs.symlinkSync(path.join(root, "shared"), path.join(root, "linked"));

    // One entry, not two: the same file under two names is noise, and which
    // name wins is decided by the sorted order rather than left to chance.
    expect(scan().files).toEqual(["linked/util.ts"]);
  });

  it("does not loop on a cycle", () => {
    write("src/real.ts");
    fs.symlinkSync(root, path.join(root, "src", "self"));

    expect(scan().files).toEqual(["src/real.ts"]);
  });

  it("skips a dangling symlink instead of throwing", () => {
    write("src/real.ts");
    fs.symlinkSync(
      path.join(root, "missing"),
      path.join(root, "src", "broken.ts")
    );

    expect(scan().files).toEqual(["src/real.ts"]);
  });

  // Skipped on Windows: chmod there cannot make a path unreadable.
  it.skipIf(process.platform === "win32")(
    "walks past a directory it cannot read",
    () => {
      write("src/real.ts");
      const locked = path.join(root, "locked");
      fs.mkdirSync(locked);
      fs.writeFileSync(path.join(locked, "hidden.ts"), "x");
      fs.chmodSync(locked, 0o000);

      try {
        expect(scan().files).toEqual(["src/real.ts"]);
      } finally {
        fs.chmodSync(locked, 0o755);
      }
    }
  );
});

describe("content that only looks like source", () => {
  it("rejects a file with a NUL byte", () => {
    expect(isIndexableContent("const a = 1\u0000")).toEqual({
      ok: false,
      reason: "binary",
    });
  });

  it("rejects a bundle: one enormous line", () => {
    expect(isIndexableContent(`const a=1;${"x".repeat(60_000)}`)).toEqual({
      ok: false,
      reason: "minified",
    });
  });

  it("accepts a large file that is still written by a person", () => {
    const source = "export function f() { return 1 }\n".repeat(5_000);

    expect(isIndexableContent(source)).toEqual({ ok: true });
  });

  it("accepts a short file with one long line, which is a comment, not a bundle", () => {
    expect(
      isIndexableContent(`// ${"a".repeat(2_000)}\nexport const x = 1`)
    ).toEqual({ ok: true });
  });

  it("accepts a big hand-written file holding one enormous data literal", () => {
    // Judged on the longest line alone, this looked minified. It is a real file
    // with a real symbol in it, and rejecting it loses that symbol.
    const source = `export const TABLE = [${"0,".repeat(30_000)}]\n${"export function f() {}\n".repeat(2_000)}`;

    expect(isIndexableContent(source)).toEqual({ ok: true });
  });

  it("still rejects a real bundle, where every line is long", () => {
    const source = `${"var a=1,b=2,c=3;".repeat(200)}\n`.repeat(200);

    expect(isIndexableContent(source)).toEqual({
      ok: false,
      reason: "minified",
    });
  });
});
