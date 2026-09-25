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
import { describe, expect, it } from "vitest";

import { findSyntaxErrors, langForFile } from "./lang.js";

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
