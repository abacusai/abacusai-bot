/**
 * Properties that must hold for EVERY file, not just the ones someone thought
 * to write a case for.
 *
 * The unit tests pin behaviour against source strings a person chose. That
 * catches what was anticipated. This runs the indexer over this repository's own
 * source (several thousand real files, including the awkward ones) and asserts
 * the invariants a caller relies on. It is the difference between "the cases I
 * imagined pass" and "nothing in a real tree makes it lie or throw".
 *
 * Every invariant here corresponds to a way the output would mislead:
 *   - a line number past the end of the file sends the reader nowhere
 *   - a signature with a newline in it breaks the one-symbol-per-line contract
 *   - a name that is not actually on the line it claims is a fabricated location
 *   - an ordering that changes between runs makes two calls impossible to diff
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import { langForFile, parseSource } from "./lang.js";
import {
  familyFor,
  symbolsIn,
  renderSymbols,
  type CodeSymbol,
} from "./symbols.js";
import { collectFiles, isIndexableContent } from "./workspace-scan.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");

interface Indexed {
  file: string;
  source: string;
  symbols: CodeSymbol[];
}

/** The whole repository, indexed once and shared by every assertion below. */
const corpus: Indexed[] = (() => {
  const { files } = collectFiles(
    REPO_ROOT,
    (file) => familyFor(langForFile(file) ?? "") != null,
    {
      maxFiles: 5_000,
      maxDepth: 24,
      timeBudgetMs: 60_000,
    }
  );

  const out: Indexed[] = [];

  for (const file of files) {
    let source: string;
    try {
      source = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }

    if (source.length > 1_500_000 || !isIndexableContent(source).ok) continue;

    const lang = langForFile(file)!;
    const family = familyFor(lang)!;

    out.push({
      file,
      source,
      symbols: symbolsIn(family, source, parseSource(lang, source).root()),
    });
  }

  return out;
})();

/** Reported for every failure, so a break names the file rather than a count. */
function report(failures: string[], limit = 8): string {
  return `${failures.length} failure(s):\n${failures.slice(0, limit).join("\n")}`;
}

describe(`indexing this repository (${corpus.length} files, ${corpus.reduce((n, f) => n + f.symbols.length, 0)} symbols)`, () => {
  it("indexed a corpus big enough for these assertions to mean something", () => {
    // A guard on the guard: if the walk broke, every invariant below would pass
    // vacuously over an empty list.
    expect(corpus.length).toBeGreaterThan(200);
    expect(corpus.reduce((n, f) => n + f.symbols.length, 0)).toBeGreaterThan(
      2_000
    );
  });

  it("never reports a line outside the file", () => {
    const failures: string[] = [];

    for (const { file, source, symbols } of corpus) {
      const lines = source.split("\n").length;
      for (const symbol of symbols) {
        if (symbol.line < 1 || symbol.line > lines) {
          failures.push(
            `${path.relative(REPO_ROOT, file)}:${symbol.line}: file has ${lines} lines`
          );
        }
      }
    }

    expect(failures, report(failures)).toEqual([]);
  });

  it("puts every symbol on the line it claims", () => {
    const failures: string[] = [];

    for (const { file, source, symbols } of corpus) {
      const lines = source.split("\n");
      for (const symbol of symbols) {
        if (symbol.name === "" || symbol.name === "default") continue;

        // A CSS selector list legitimately spans lines: `*,\n*::before,\n*::after {`
        // starts on the line holding `*,`, so the first component is what has
        // to be there, not the joined text.
        const head = symbol.name
          .split(",")[0]!
          .trim()
          .replace(/^['"`]|['"`]$/g, "");

        // The identifier has to appear on that line. A signature is built from
        // the source, so anything else means the position is invented.
        if (head !== "" && !lines[symbol.line - 1]?.includes(head)) {
          failures.push(
            `${path.relative(REPO_ROOT, file)}:${symbol.line}: "${symbol.name}" not on that line`
          );
        }
      }
    }

    expect(failures, report(failures)).toEqual([]);
  });

  it("emits single-line signatures, so one symbol is one line of output", () => {
    const failures: string[] = [];

    for (const { file, symbols } of corpus) {
      for (const symbol of symbols) {
        if (
          symbol.signature.includes("\n") ||
          symbol.signature.includes("\r")
        ) {
          failures.push(
            `${path.relative(REPO_ROOT, file)}:${symbol.line}: multi-line signature`
          );
        }
      }
    }

    expect(failures, report(failures)).toEqual([]);
  });

  it("never emits an empty or runaway signature", () => {
    const failures: string[] = [];

    for (const { file, symbols } of corpus) {
      for (const symbol of symbols) {
        if (symbol.signature.trim() === "") {
          failures.push(
            `${path.relative(REPO_ROOT, file)}:${symbol.line}: empty signature`
          );
        }
        if (symbol.signature.length > 200) {
          failures.push(
            `${path.relative(REPO_ROOT, file)}:${symbol.line}: ${symbol.signature.length} chars`
          );
        }
      }
    }

    expect(failures, report(failures)).toEqual([]);
  });

  it("returns symbols in source order", () => {
    const failures: string[] = [];

    for (const { file, symbols } of corpus) {
      for (let index = 1; index < symbols.length; index++) {
        if (symbols[index]!.line < symbols[index - 1]!.line) {
          failures.push(
            `${path.relative(REPO_ROOT, file)}: line ${symbols[index]!.line} after ${symbols[index - 1]!.line}`
          );
        }
      }
    }

    expect(failures, report(failures)).toEqual([]);
  });

  it("produces the same index twice for the same input", () => {
    const failures: string[] = [];

    for (const { file, source } of corpus.slice(0, 300)) {
      const lang = langForFile(file)!;
      const family = familyFor(lang)!;
      const first = renderSymbols(
        symbolsIn(family, source, parseSource(lang, source).root()) ?? []
      );
      const second = renderSymbols(
        symbolsIn(family, source, parseSource(lang, source).root()) ?? []
      );

      if (first !== second) failures.push(path.relative(REPO_ROOT, file));
    }

    expect(failures, report(failures)).toEqual([]);
  });

  it("never nests a symbol under an unnamed container", () => {
    const failures: string[] = [];

    for (const { file, symbols } of corpus) {
      for (const symbol of symbols) {
        if (symbol.container.some((name) => name.trim() === "")) {
          failures.push(
            `${path.relative(REPO_ROOT, file)}:${symbol.line}: empty container name`
          );
        }
      }
    }

    expect(failures, report(failures)).toEqual([]);
  });

  it("finds every exported declaration the parser can see", () => {
    // Ground truth from the parser rather than from a regex over the text: this
    // file and its neighbours hold TypeScript samples inside string literals,
    // and a declaration quoted in a string is not one the index should find.
    // Asking the tree instead of the characters makes the check immune to that.
    const failures: string[] = [];

    for (const { file, source, symbols } of corpus) {
      const lang = langForFile(file)!;
      if (familyFor(lang) !== "ts") continue;

      const root = parseSource(lang, source).root();
      const lines = new Set(symbols.map((symbol) => symbol.line));

      for (const statement of root.findAll!({
        rule: { kind: "export_statement" },
      })) {
        const line = statement.range().start.line + 1;
        const end = statement.range().end.line + 1;

        // `export { a }` and `export * from './x'` re-export rather than
        // declare, so they are correctly absent from a map of definitions.
        if (/^export\s*(\*|\{|type\s*\{)/.test(statement.text())) continue;

        // Anywhere in the statement, not only its first line: a destructuring
        // export writes its names on the lines below the one that opens it,
        // and each is indexed where it is written rather than where the
        // `export` keyword sits.
        const covered = [...lines].some(
          (indexed) => indexed >= line && indexed <= end
        );

        if (!covered) {
          failures.push(
            `${path.relative(REPO_ROOT, file)}:${line}: ${statement.text().split("\n")[0]!.slice(0, 60)}`
          );
        }
      }
    }

    expect(failures, report(failures)).toEqual([]);
  });
});
