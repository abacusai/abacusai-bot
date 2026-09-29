/**
 * The `code_map` contract, as the model experiences it.
 *
 * ast_edit, the other tool this extension registers, is covered in
 * ast-tools.test.ts: that one is about writing files, this one about reading
 * them.
 *
 * The symbol classification is tested in symbols.test.ts and the walk in
 * workspace-scan.test.ts. What is left, and what these cover, is everything
 * the model has to be told rather than shown: which limit stopped the scan, why
 * a file type produced nothing, and whether "no result" means "not there" or
 * "not looked at". A bare "No symbols found" says the same thing for all four.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { fakePi, type FakePi } from "@abacus-ai/test-support/fake-pi";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import astTools from "./ast-tools.js";

let cwd: string;
let pi: FakePi;

interface ToolResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
  details?: {
    files?: number;
    symbols?: number;
    scanned?: number;
    truncated?: boolean;
  };
}

/** Call `code_map` the way pi does: five arguments, the last carrying the cwd. */
async function codeMap(
  params: { path?: string; query?: string } = {},
  signal?: AbortSignal
): Promise<ToolResult> {
  const tool = pi.tools.get("code_map");
  if (!tool) throw new Error("code_map was not registered");

  const execute = tool.execute as unknown as (
    id: string,
    params: unknown,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    ctx: { cwd: string }
  ) => Promise<ToolResult>;

  return execute("call-1", params, signal, undefined, { cwd });
}

const textOf = (result: ToolResult): string =>
  result.content.map((part) => part.text).join("\n");

function write(relative: string, contents: string): void {
  const full = path.join(cwd, relative);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, contents);
}

beforeEach(() => {
  cwd = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "code-map-tool-"))
  );
  pi = fakePi();
  astTools(pi.api as never);
});

afterEach(() => {
  fs.rmSync(cwd, { recursive: true, force: true });
});

describe("mapping a workspace", () => {
  it("indexes a directory, grouped by file and rooted at the workspace", async () => {
    write("src/session.ts", "export class Session {\n  close() {}\n}\n");
    write("src/util.py", "def helper():\n    pass\n");

    const result = await codeMap();
    const text = textOf(result);

    expect(text).toContain("src/session.ts");
    expect(text).toContain("export class Session");
    expect(text).toContain("close()");
    expect(text).toContain("src/util.py");
    expect(result.details?.files).toBe(2);
    expect(result.isError).toBeFalsy();
  });

  it("indexes one file when pointed at one", async () => {
    write("src/a.ts", "export function a() {}");
    write("src/b.ts", "export function b() {}");

    const text = textOf(await codeMap({ path: "src/a.ts" }));

    expect(text).toContain("a()");
    expect(text).not.toContain("b()");
  });

  it("produces byte-identical output on a second call", async () => {
    write("src/a.ts", "export function a() {}");
    write("src/b.ts", "export const B = 1");

    expect(textOf(await codeMap())).toBe(textOf(await codeMap()));
  });

  it("indexes a const-bound arrow function, which is how most of this codebase declares one", async () => {
    write("src/a.ts", "const helper = (input: string) => input.trim()\n");

    const text = textOf(await codeMap());

    expect(text).toContain("const helper = (input: string)");
  });

  it("leaves an ordinary value constant out, so the map stays a map of callables", async () => {
    write(
      "src/a.ts",
      'const MAX = 5\nconst label = "hello"\nconst run = () => {}\n'
    );

    const text = textOf(await codeMap());

    // A local plain value earns no entry. SCREAMING_SNAKE is the one naming
    // convention that marks a module constant, so MAX stays.
    expect(text).not.toContain("label");
    expect(text).toContain("const MAX = 5");
    expect(text).toContain("const run");
  });

  it("gives an exported const arrow its own line number, not the arrow body’s", async () => {
    write(
      "src/a.ts",
      [
        "// a leading comment",
        "",
        "export const load = async (",
        "  path: string,",
        "): Promise<void> => {}",
        "",
      ].join("\n")
    );

    const text = textOf(await codeMap());

    // The declaration starts on line 3, and a signature wrapped over three lines
    // still has to print as one readable line.
    expect(text).toContain(
      "3  export const load = async ( path: string, ): Promise<void>"
    );
  });

  it("filters by query across name and container", async () => {
    write(
      "src/a.ts",
      "export class Session {\n  close() {}\n}\nexport function unrelated() {}"
    );

    const text = textOf(await codeMap({ query: "session close" }));

    expect(text).toContain("close()");
    expect(text).not.toContain("unrelated");
  });
});

describe("saying what happened", () => {
  it("distinguishes an unindexable file type from an empty one", async () => {
    write("notes.md", "# not code");

    const result = await codeMap({ path: "notes.md" });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("does not index");
    expect(textOf(result)).toContain(".ts");
  });

  it("says a query found nothing, and how much it looked at", async () => {
    write("src/a.ts", "export function present() {}");

    const result = await codeMap({ query: "absent" });

    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain('No symbols matching "absent"');
    expect(textOf(result)).toContain("1 symbol(s) indexed");
  });

  it('says a directory held nothing it can index, rather than "no symbols"', async () => {
    write("README.md", "# docs");

    expect(textOf(await codeMap())).toContain(
      "Nothing here has an extension code_map indexes"
    );
  });

  it("reports a missing path instead of returning an empty map", async () => {
    const result = await codeMap({ path: "nowhere" });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Cannot access nowhere");
  });

  it("caps the output and says how much it left out", async () => {
    for (let file = 0; file < 60; file++) {
      const body = Array.from(
        { length: 40 },
        (_, index) => `export function fn${file}_${index}() {}`
      ).join("\n");
      write(`src/file${file}.ts`, body);
    }

    const result = await codeMap();
    const text = textOf(result);

    expect(text).toMatch(/output capped after \d+ of \d+ file\(s\)/);
    expect(result.details?.truncated).toBe(true);
    // The files it never opened are not reported as files without symbols.
    expect(result.details?.files).toBeLessThan(60);
  });

  it("does not let one enormous file spend the whole output budget", async () => {
    // A map of a 1,900-file repository that describes five of them reads as a
    // five-file repository. Every file gets a share.
    write(
      "src/aaa-huge.ts",
      Array.from(
        { length: 600 },
        (_, i) => `export function huge${i}() {}`
      ).join("\n")
    );
    for (let file = 0; file < 30; file++)
      write(`src/normal${file}.ts`, `export function normal${file}() {}`);

    const result = await codeMap();
    const text = textOf(result);

    expect(text).toContain("more in this file");
    expect(text).toContain("trimmed from files that are shown");
    // The small files after the huge one are still reached.
    expect(text).toContain("normal20()");
    expect(result.details?.files).toBeGreaterThan(20);
  });

  it("gives a file asked for by name the whole budget", async () => {
    write(
      "src/huge.ts",
      Array.from(
        { length: 600 },
        (_, i) => `export function huge${i}() {}`
      ).join("\n")
    );

    const text = textOf(await codeMap({ path: "src/huge.ts" }));

    expect(text).not.toContain("more in this file");
    expect(text).toContain("huge599()");
  });

  it("counts every match when a query is given, even past the cap", async () => {
    for (let file = 0; file < 60; file++) {
      const body = Array.from(
        { length: 40 },
        (_, index) => `export function target${file}_${index}() {}`
      ).join("\n");
      write(`src/file${file}.ts`, body);
    }

    const text = textOf(await codeMap({ query: "target" }));

    expect(text).toMatch(/\d+ more match\(es\) in \d+ unshown file\(s\)/);
  });

  it("notes files it skipped as generated or unreadable", async () => {
    write("src/real.ts", "export function real() {}");
    write("src/huge.ts", `const a = 1;${"x".repeat(60_000)}`);

    const text = textOf(await codeMap());

    expect(text).toContain("src/real.ts");
    expect(text).toContain("skipped as generated, minified or too large");
  });

  it("gives the watchdog longer than the tool spends on itself", async () => {
    // code_map stops at 20s and returns a partial map. If the watchdog fired
    // first that map would be replaced by a killed call, which returns nothing,
    // so the ordering between the two numbers is the thing worth pinning.
    const { budgetSecondsFor } = await import("./tool-timeouts.js");

    expect(budgetSecondsFor("code_map")).toBeGreaterThan(20);
  });

  it("stops and says so when the caller aborts partway through reading files", async () => {
    // Aborting BEFORE the walk is a different code path from aborting after it,
    // and the second is the one that happens in practice: the user presses Stop
    // while files are being parsed. The signal flips on its third reading so the
    // break lands mid-loop rather than depending on timing.
    for (let file = 0; file < 5; file++)
      write(`src/file${file}.ts`, `export function fn${file}() {}`);

    let reads = 0;
    const flipping = {
      get aborted() {
        reads++;

        return reads > 3;
      },
      // Present because AbortSignal has them; the tool only reads `aborted`.
      addEventListener: undefined,
      removeEventListener: undefined,
    } as unknown as AbortSignal;

    const text = textOf(await codeMap({}, flipping));

    expect(text).toContain("interrupted");
  });

  it("stops at its own time budget and returns what it has", async () => {
    // The walk had a budget and the parse loop did not, so a big tree could sit
    // there until the watchdog killed the call, and a killed call returns
    // nothing. The clock is moved rather than waited on: a test that really
    // took twenty seconds would be a test nobody runs.
    for (let file = 0; file < 6; file++)
      write(`src/file${file}.ts`, `export function fn${file}() {}`);

    const realNow = Date.now.bind(Date);
    let calls = 0;
    vi.spyOn(Date, "now").mockImplementation(() => {
      calls++;

      // Real time until the scan is done, then far past the budget.
      return calls > 8 ? realNow() + 60_000 : realNow();
    });

    try {
      const text = textOf(await codeMap());

      expect(text).toContain("budget");
      expect(text).toContain("index a subdirectory");
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("skips a file too large to parse and counts it", async () => {
    write("src/small.ts", "export function small() {}");
    write(
      "src/enormous.ts",
      `${"export function padding() {}\n".repeat(60_000)}`
    );

    const text = textOf(await codeMap());

    expect(text).toContain("small()");
    expect(text).toContain("skipped as generated, minified or too large");
  });

  // Writes 2,100 real files first, which a cold CI disk can take longer than
  // the default 5s over, seen flaking on the macOS runner.
  it(
    "says when the walk stopped at its file limit, and how much it missed",
    { timeout: 30_000 },
    async () => {
      // 2,000 is the cap. A repository past it must be told it was truncated,
      // because a map of the first 2,000 files is indistinguishable from a map of
      // a 2,000-file repository.
      fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
      for (let file = 0; file < 2_100; file++) {
        fs.writeFileSync(
          path.join(cwd, "src", `f${file}.ts`),
          `export const x${file} = 1`
        );
      }

      const text = textOf(await codeMap({ query: "x1999" }));

      expect(text).toContain("scan stopped at 2000 files");
      expect(text).toContain("index a subdirectory");
    }
  );

  it("says when the walk stopped at its depth limit", async () => {
    write(`${"nested/".repeat(30)}deep.ts`, "export function deep() {}");

    const text = textOf(await codeMap());

    expect(text).toContain("scan stopped at depth");
  });

  it("reports a partial result when the caller aborts before the scan", async () => {
    write("src/a.ts", "export function a() {}");
    const controller = new AbortController();
    controller.abort();

    expect(textOf(await codeMap({}, controller.signal))).toContain(
      "interrupted"
    );
  });
});

describe("paths", () => {
  it("accepts a trailing slash", async () => {
    write("src/a.ts", "export function a() {}");

    expect(textOf(await codeMap({ path: "src/" }))).toContain("a()");
  });

  it("reports a dangling symlink rather than an empty map", async () => {
    fs.symlinkSync(path.join(cwd, "missing"), path.join(cwd, "broken.ts"));

    const result = await codeMap({ path: "broken.ts" });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Cannot access");
  });

  it("indexes through a symlink to a real file", async () => {
    write("real/a.ts", "export function throughLink() {}");
    fs.symlinkSync(path.join(cwd, "real", "a.ts"), path.join(cwd, "link.ts"));

    expect(textOf(await codeMap({ path: "link.ts" }))).toContain(
      "throughLink()"
    );
  });

  // Skipped on Windows: chmod there cannot make a path unreadable.
  it.skipIf(process.platform === "win32")(
    "walks past a file it cannot read and still returns the rest",
    async () => {
      write("src/readable.ts", "export function readable() {}");
      write("src/locked.ts", "export function locked() {}");
      fs.chmodSync(path.join(cwd, "src", "locked.ts"), 0o000);

      try {
        const text = textOf(await codeMap());

        expect(text).toContain("readable()");
        expect(text).toContain("could not be read or parsed");
      } finally {
        fs.chmodSync(path.join(cwd, "src", "locked.ts"), 0o644);
      }
    }
  );

  it("honours an ignore file above the directory it was pointed at", async () => {
    write(".gitignore", "pkg/generated/\n");
    write("pkg/src/real.ts", "export function real() {}");
    write("pkg/generated/client.ts", "export function generated() {}");

    const text = textOf(await codeMap({ path: "pkg" }));

    expect(text).toContain("real()");
    expect(text).not.toContain("generated()");
  });

  it("honours a file named explicitly even where the walk would skip it", async () => {
    write("dist/bundle.ts", "export function shipped() {}");

    expect(textOf(await codeMap({ path: "dist/bundle.ts" }))).toContain(
      "shipped()"
    );
    // The same file is invisible to a directory scan, which is the point of the
    // skip list: asking for it by name is a decision, finding it by accident
    // is not.
    expect(textOf(await codeMap())).not.toContain("shipped()");
  });

  it("labels a path outside the workspace absolutely, so it is still openable", async () => {
    const outside = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "code-map-outside-"))
    );
    fs.writeFileSync(path.join(outside, "far.ts"), "export function far() {}");

    try {
      const text = textOf(await codeMap({ path: outside }));

      // Slash-normalised, like every path the tool prints, so the assertion has
      // to normalise too rather than assume the platform separator.
      expect(text).toContain(
        path.join(outside, "far.ts").split(path.sep).join("/")
      );
      expect(text).toContain("far()");
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});
