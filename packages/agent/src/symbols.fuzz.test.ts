/**
 * Malformed, truncated and adversarial input.
 *
 * `code_map` runs over whatever is on disk, which includes half-written files
 * the user is in the middle of editing, files in a language the extension lies
 * about, and generated files no person ever read. A parser handles those by
 * producing a partial tree; the risk is in what the classifier then does with
 * one — an unwrapped `undefined`, a slice with a backwards range, a recursion
 * that does not bottom out.
 *
 * The generator is seeded rather than random so that a failure here reproduces
 * on the next run instead of vanishing.
 */
import { describe, expect, it } from "vitest";

import { parseSource } from "./lang.js";
import { symbolsIn, renderSymbols, type SymbolFamily } from "./symbols.js";

/** Deterministic PRNG (mulberry32), so a red run is a repeatable one. */
function seeded(seed: number): () => number {
  let state = seed;

  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;

    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FRAGMENTS = [
  "export function ",
  "const x = () => {",
  "class A {",
  "}",
  "{",
  "(",
  ")",
  "=>",
  "...",
  "async ",
  "export default ",
  "interface I {",
  "type T =",
  "namespace N {",
  "`${",
  "def f(",
  "class B(",
  ":",
  "lambda",
  "@decorator\n",
  ".rule {",
  "@media (",
  ";",
  "/*",
  "*/",
  "//",
  '"unterminated',
  "'",
  "\\",
  "é中文",
  "😀",
  "\t",
  "\n",
  "  ",
];

/** Every family, with a parser language that actually accepts it. */
const FAMILIES: Array<[SymbolFamily, string]> = [
  ["ts", "TypeScript"],
  ["ts", "Tsx"],
  ["ts", "JavaScript"],
  ["python", "python"],
  ["css", "Css"],
];

function index(family: SymbolFamily, lang: string, source: string) {
  return symbolsIn(family, source, parseSource(lang, source).root());
}

/** The properties that must hold for any input at all, however broken. */
function checkInvariants(
  family: SymbolFamily,
  lang: string,
  source: string
): string[] {
  const problems: string[] = [];
  const symbols = index(family, lang, source);
  const lineCount = source.split("\n").length;

  for (const symbol of symbols) {
    if (
      !Number.isInteger(symbol.line) ||
      symbol.line < 1 ||
      symbol.line > lineCount
    ) {
      problems.push(`line ${symbol.line} outside 1..${lineCount}`);
    }
    if (/[\r\n]/.test(symbol.signature))
      problems.push(`multi-line signature ${JSON.stringify(symbol.signature)}`);
    if (symbol.signature.length > 141)
      problems.push(`signature ${symbol.signature.length} chars`);
    if (typeof symbol.name !== "string") problems.push("name is not a string");
    if (symbol.container.some((name) => typeof name !== "string"))
      problems.push("container holds a non-string");
  }

  for (let index = 1; index < symbols.length; index++) {
    if (symbols[index]!.line < symbols[index - 1]!.line)
      problems.push("out of source order");
  }

  // Rendering must not throw either — it is what the model actually receives.
  if (symbols.length > 0) renderSymbols(symbols);

  return problems;
}

describe("input that does not parse", () => {
  it.each(FAMILIES)(
    "survives 400 random fragment soups (%s/%s)",
    (family, lang) => {
      const random = seeded(0xc0de);
      const failures: string[] = [];

      for (let attempt = 0; attempt < 400; attempt++) {
        const length = 1 + Math.floor(random() * 30);
        const source = Array.from(
          { length },
          () => FRAGMENTS[Math.floor(random() * FRAGMENTS.length)]!
        ).join("");

        let problems: string[];
        try {
          problems = checkInvariants(family, lang, source);
        } catch (error) {
          failures.push(
            `threw on ${JSON.stringify(source)}: ${(error as Error).message}`
          );
          continue;
        }

        if (problems.length > 0)
          failures.push(
            `${problems.join("; ")} — on ${JSON.stringify(source)}`
          );
      }

      expect(failures.slice(0, 5), `${failures.length} failures`).toEqual([]);
    }
  );

  it.each(FAMILIES)(
    "survives every truncation of a real file (%s/%s)",
    (family, lang) => {
      const source = `
export const load = async (path: string): Promise<Config> => read(path)
export abstract class Base<T> {
  handle = () => {}
  async run(first: number, second: string): Promise<void> {}
}
class A(Base):
    def method(self):
        ...
.card { color: red; .title { font-weight: 700 } }
export default () => {}
module.exports.run = function () {}
(function () { function inner() {} })()
`;
      const failures: string[] = [];

      // Cutting at every position produces the half-written files an editor shows
      // mid-keystroke, which is exactly when a model tends to call this.
      for (let cut = 0; cut <= source.length; cut += 3) {
        const partial = source.slice(0, cut);

        try {
          const problems = checkInvariants(family, lang, partial);
          if (problems.length > 0)
            failures.push(`${problems.join("; ")} — cut at ${cut}`);
        } catch (error) {
          failures.push(`threw at cut ${cut}: ${(error as Error).message}`);
        }
      }

      expect(failures.slice(0, 5), `${failures.length} failures`).toEqual([]);
    }
  );

  it.each(FAMILIES)(
    "survives content in the wrong language (%s/%s)",
    (family, lang) => {
      // An extension is a claim. A `.py` holding TypeScript parses into something,
      // and the classifier must not assume the shape it hoped for.
      const samples = [
        "export class A { m() {} }",
        "def f():\n    return 1",
        ".a { color: red }",
        "<html><body><script>var a = 1</script></body></html>",
        '{"json": [1, 2, {"nested": true}]}',
        "#!/bin/bash\nfor i in 1 2 3; do echo $i; done",
      ];

      for (const sample of samples) {
        expect(() => checkInvariants(family, lang, sample)).not.toThrow();
      }
    }
  );
});

describe("input that is merely extreme", () => {
  it("handles a deeply nested expression without blowing the stack", () => {
    // 2,000 levels. A recursive walk that does not bottom out shows up here as
    // a RangeError rather than as a wrong answer in production.
    const source = `const x = ${"(".repeat(2_000)}1${")".repeat(2_000)}`;

    expect(() => index("ts", "TypeScript", source)).not.toThrow();
  });

  it("handles deeply nested blocks", () => {
    const source = `${"if (a) {".repeat(500)}${"}".repeat(500)}\nexport function after() {}`;

    expect(() => index("ts", "TypeScript", source)).not.toThrow();
  });

  it("handles a file that is one very long line", () => {
    const source = `export const A = ${"1 + ".repeat(5_000)}1`;

    expect(() => index("ts", "TypeScript", source)).not.toThrow();
  });

  /**
   * Tree depth follows source shape: `1 + 1 + …` nests one node per term, so
   * this line is 60,000 levels deep. Walked with one call frame per level it
   * threw `RangeError: Maximum call stack size exceeded`, and at the 5,000 of
   * the case above it depended on how much stack the rest of the suite had
   * already used — a real crash that presented as a flaky test.
   */
  it("indexes a line too deep for the call stack", () => {
    const source = `export const A = ${"1 + ".repeat(60_000)}1`;

    expect(() => index("ts", "TypeScript", source)).not.toThrow();
    expect(
      index("ts", "TypeScript", source).map((symbol) => symbol.name)
    ).toEqual(["A"]);
  });

  it("indexes deeply nested blocks without recursing into the stack", () => {
    const source = `${"if (a) {".repeat(20_000)}${"}".repeat(20_000)}\nexport function after() {}`;

    expect(
      index("ts", "TypeScript", source).map((symbol) => symbol.name)
    ).toContain("after");
  });

  it("handles many thousands of small declarations", () => {
    const source = Array.from(
      { length: 5_000 },
      (_, index) => `export const f${index} = () => {}`
    ).join("\n");
    const symbols = index("ts", "TypeScript", source);

    expect(symbols).toHaveLength(5_000);
    expect(symbols[4_999]!.line).toBe(5_000);
  });

  it("counts lines correctly with Windows line endings", () => {
    const symbols = index(
      "ts",
      "TypeScript",
      "const a = 1\r\nexport function onLineTwo() {}\r\n"
    );

    expect(symbols.find((symbol) => symbol.name === "onLineTwo")?.line).toBe(2);
    expect(symbols.every((symbol) => !symbol.signature.includes("\r"))).toBe(
      true
    );
  });

  it("handles a byte-order mark and non-ASCII identifiers", () => {
    const symbols = index(
      "ts",
      "TypeScript",
      "﻿export function élément() {}\nexport const 中文 = () => {}"
    );

    expect(symbols.map((symbol) => symbol.name)).toEqual(["élément", "中文"]);
  });

  it("handles an empty file and a file of only whitespace", () => {
    expect(index("ts", "TypeScript", "")).toEqual([]);
    expect(index("python", "python", "\n\n   \n")).toEqual([]);
    expect(index("css", "Css", "   ")).toEqual([]);
  });
});
