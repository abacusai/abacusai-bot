/**
 * What the post-edit syntax check can actually see.
 *
 * This is the layer that promises a broken edit is "caught by parsing the file,
 * immediately, at the line". It is worth pinning what that covers, because the
 * answer is grammar-dependent and not obvious: tree-sitter is error-tolerant by
 * design, and recovers from some breakage without producing an ERROR node at
 * all. Those cases are recorded here rather than left to be discovered by
 * someone wondering why their broken file went unmentioned.
 */
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  findSyntaxErrors,
  langForFile,
  probeGrammar,
  type GrammarProbeRun,
} from "./lang.js";

const require = createRequire(import.meta.url);
const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grammar-probe-"));
  dirs.push(dir);
  return dir;
}

/** A grammar module shaped like @ast-grep/lang-python, whose library is `bytes`. */
function grammarModule(bytes: Buffer): { module: string; library: string } {
  const dir = tempDir();
  const library = path.join(dir, "parser.so");
  fs.writeFileSync(library, bytes);
  const module = path.join(dir, "index.js");
  fs.writeFileSync(
    module,
    `module.exports = { libraryPath: ${JSON.stringify(library)}, extensions: ["py"], languageSymbol: "tree_sitter_python", expandoChar: "µ" };`
  );
  return { module, library };
}

describe("picking a grammar from the filename", () => {
  it("recognises the languages the agent edits most", () => {
    expect(langForFile("/x/a.py")).toBe("python");
    expect(langForFile("/x/a.ts")).toBe("TypeScript");
    expect(langForFile("/x/a.js")).toBeDefined();
  });

  it("is case-insensitive about the extension", () => {
    expect(langForFile("/x/A.PY")).toBe("python");
  });

  it("returns undefined for a file it has no grammar for", () => {
    // The checker must stay silent here rather than guess: a false parse error
    // on a file it cannot read would be worse than saying nothing.
    expect(langForFile("/x/notes.txt")).toBeUndefined();
    expect(langForFile("/x/Makefile")).toBeUndefined();
  });
});

describe("catching broken code", () => {
  it("finds a broken TypeScript function and reports its line", () => {
    const errors = findSyntaxErrors("TypeScript", "function f( { return 1 }");

    expect(errors).toHaveLength(1);
    expect(errors[0]?.line).toBe(1);
  });

  it("reports the line a later error is on, not the first line", () => {
    const errors = findSyntaxErrors(
      "TypeScript",
      "const a = 1\nconst b = 2\nfunction f( {\n"
    );

    expect(errors[0]?.line).toBeGreaterThan(1);
  });

  it("says nothing about code that parses", () => {
    expect(findSyntaxErrors("TypeScript", "export const a = 1\n")).toEqual([]);
    expect(findSyntaxErrors("python", "def f():\n    return 1\n")).toEqual([]);
  });

  it("finds the python breakage it can see", () => {
    expect(findSyntaxErrors("python", "x = (1 + 2").length).toBeGreaterThan(0);
    expect(
      findSyntaxErrors("python", "class A\n    pass").length
    ).toBeGreaterThan(0);
    expect(
      findSyntaxErrors("python", "if True\n    pass").length
    ).toBeGreaterThan(0);
  });

  it("caps how much it reports, so one broken file cannot flood the result", () => {
    const many = Array.from({ length: 30 }, () => "function f( {").join("\n");

    expect(findSyntaxErrors("TypeScript", many).length).toBeLessThanOrEqual(5);
  });
});

describe("what it does NOT catch, recorded deliberately", () => {
  // tree-sitter recovers from these without an ERROR node, so the check stays
  // silent and the model finds out from the interpreter instead. Not a
  // regression to fix by loosening the parser: these assertions exist so that
  // if a grammar upgrade starts catching them, someone notices and can promote
  // them to the block above rather than being surprised.
  it("misses a malformed def that the grammar recovers from", () => {
    expect(findSyntaxErrors("python", "def f(: pass")).toEqual([]);
  });

  it("misses python indentation errors", () => {
    // `return` outside the body is an IndentationError at runtime, but a valid
    // parse: two statements, one after the other.
    expect(findSyntaxErrors("python", "def f():\nreturn 1")).toEqual([]);
  });
});

describe("loading a grammar library only once a child survived it", () => {
  const DAY = 24 * 60 * 60 * 1000;

  it.each<{
    name: string;
    cached?: { ok: boolean; age: number; changed?: boolean };
    answer: boolean | undefined;
    ok: boolean;
    spawns: number;
    kept: boolean | undefined;
  }>([
    { name: "first use asks", answer: true, ok: true, spawns: 1, kept: true },
    {
      name: "a refusal is kept",
      answer: false,
      ok: false,
      spawns: 1,
      kept: false,
    },
    {
      name: "a pass is reused",
      cached: { ok: true, age: 30 * DAY },
      answer: false,
      ok: true,
      spawns: 0,
      kept: true,
    },
    {
      name: "a fresh refusal is reused",
      cached: { ok: false, age: DAY - 1 },
      answer: true,
      ok: false,
      spawns: 0,
      kept: false,
    },
    {
      name: "a day-old refusal is asked again",
      cached: { ok: false, age: DAY },
      answer: true,
      ok: true,
      spawns: 1,
      kept: true,
    },
    {
      name: "a changed library is asked again",
      cached: { ok: false, age: 0, changed: true },
      answer: true,
      ok: true,
      spawns: 1,
      kept: true,
    },
    {
      name: "no answer skips and keeps nothing",
      answer: undefined,
      ok: false,
      spawns: 1,
      kept: undefined,
    },
  ])("$name", async ({ cached, answer, ok, spawns, kept }) => {
    const { module, library } = grammarModule(Buffer.from("grammar"));
    const cacheFile = path.join(tempDir(), "grammar-probes.json");
    const now = 10 * DAY;
    if (cached) {
      const { mtimeMs, size } = fs.statSync(library);
      fs.writeFileSync(
        cacheFile,
        JSON.stringify({
          [library]: {
            mtimeMs,
            size: size + (cached.changed ? 1 : 0),
            ok: cached.ok,
            at: now - cached.age,
          },
        })
      );
    }
    const run = vi.fn<GrammarProbeRun>(async () => answer);

    expect(await probeGrammar(module, run, cacheFile, now)).toBe(ok);
    expect(run).toHaveBeenCalledTimes(spawns);
    const file = fs.existsSync(cacheFile)
      ? (JSON.parse(fs.readFileSync(cacheFile, "utf8")) as Record<
          string,
          { ok: boolean }
        >)
      : {};
    expect(file[library]?.ok).toBe(kept);
  });

  it("survives a library the OS cannot load, and passes the real one", async () => {
    // Loaded in this process, the first would abort it (ast-grep panics).
    const cacheFile = path.join(tempDir(), "grammar-probes.json");
    const broken = grammarModule(randomBytes(4096));

    expect(await probeGrammar(broken.module, undefined, cacheFile)).toBe(false);
    expect(
      await probeGrammar(
        require.resolve("@ast-grep/lang-python"),
        undefined,
        cacheFile
      )
    ).toBe(true);
  });

  it("leaves Python out and every other language working when the grammar was refused", async () => {
    const home = tempDir();
    const { libraryPath } = require("@ast-grep/lang-python") as {
      libraryPath: string;
    };
    const { mtimeMs, size } = fs.statSync(libraryPath);
    fs.mkdirSync(path.join(home, "agent"));
    fs.writeFileSync(
      path.join(home, "agent/grammar-probes.json"),
      JSON.stringify({
        [libraryPath]: { mtimeMs, size, ok: false, at: Date.now() },
      })
    );
    vi.stubEnv("ABACUSAI_BOT_HOME", home);
    vi.resetModules();
    const lang = await import("./lang.js");

    await lang.probeGrammars();
    expect(lang.langForFile("/x/a.py")).toBeUndefined();
    expect(lang.supportedExtensions()).not.toContain(".py");
    expect(lang.findSyntaxErrors("TypeScript", "function f( {")).toHaveLength(
      1
    );
  });
});
