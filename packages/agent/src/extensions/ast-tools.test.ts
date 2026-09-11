/**
 * The structural edit tool, which writes to the user's files.
 *
 * The failure worth guarding is not a crash — it is a rewrite that parses. An
 * unbound metavariable is emitted literally, `$NAME` is a legal identifier in
 * JavaScript and TypeScript, so the post-edit syntax check sees nothing wrong
 * and the file is written with a reference to a variable that does not exist.
 * These pin the check that happens before anything is written.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { fakePi, type FakePi } from "@abacus-ai/test-support/fake-pi";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { parseSource } from "../lang.js";
import astTools, {
  metaVarsIn,
  substituteMetaVars,
  unboundMetaVars,
} from "./ast-tools.js";

const substitute = (
  source: string,
  pattern: string,
  rewrite: string
): string => {
  const match = parseSource("TypeScript", source).root().findAll!({
    rule: { pattern },
  })[0];

  return substituteMetaVars(source, match!, rewrite);
};

describe("reading metavariables out of a template", () => {
  it("separates single captures from list captures", () => {
    const { single, multi } = metaVarsIn("foo($A, $$$REST)");

    expect([...single]).toEqual(["A"]);
    expect([...multi]).toEqual(["REST"]);
  });

  it("does not mistake the list form for the single form", () => {
    // $$$ARGS must not also register ARGS as a single capture, or a rewrite
    // using $ARGS would look bound when it is not.
    const { single, multi } = metaVarsIn("f($$$ARGS)");

    expect(single.has("ARGS")).toBe(false);
    expect(multi.has("ARGS")).toBe(true);
  });

  it("ignores lowercase and non-metavariable dollars", () => {
    const { single, multi } = metaVarsIn("const price = `$${amount}`");

    expect(single.size).toBe(0);
    expect(multi.size).toBe(0);
  });
});

describe("catching a rewrite the pattern cannot satisfy", () => {
  it("accepts a rewrite that only uses what the pattern binds", () => {
    expect(unboundMetaVars("foo($A)", "bar($A)")).toEqual([]);
    expect(unboundMetaVars("f($$$ARGS)", "g($$$ARGS)")).toEqual([]);
  });

  it("rejects a mistyped single capture", () => {
    // The corruption case: without this the file is written containing
    // `bar($TYPO)`, which is valid TypeScript and so passes the syntax check.
    expect(unboundMetaVars("foo($A)", "bar($TYPO)")).toEqual(["$TYPO"]);
  });

  it("rejects a mistyped list capture, which would silently delete", () => {
    // An unbound $$$NAME expands to nothing, so the edit drops the arguments
    // it was written to preserve.
    expect(unboundMetaVars("f($$$ARGS)", "g($$$ARG)")).toEqual(["$$$ARG"]);
  });

  it("accepts a list capture used in the single form", () => {
    // $$$ARGS binds ARGS; referring to it as $ARGS is a different arity, not an
    // unbound name, and ast-grep resolves it.
    expect(unboundMetaVars("f($$$ARGS)", "g($ARGS)")).toEqual([]);
  });

  it("reports every unbound name, not just the first", () => {
    expect(unboundMetaVars("foo($A)", "bar($X, $Y)")).toEqual(["$X", "$Y"]);
  });

  it("is unbothered by a rewrite with no metavariables at all", () => {
    expect(unboundMetaVars("foo($A)", "bar()")).toEqual([]);
  });
});

describe("splicing the capture into the rewrite", () => {
  it("substitutes a single capture", () => {
    expect(substitute("foo(1)", "foo($A)", "bar($A)")).toBe("bar(1)");
  });

  it("preserves the separators inside a list capture", () => {
    // Sliced out of the original source rather than rejoined, so commas and
    // spacing survive exactly as written.
    expect(substitute("f(1, 2,  3)", "f($$$ARGS)", "g($$$ARGS)")).toBe(
      "g(1, 2,  3)"
    );
  });

  it("expands an empty list capture to nothing", () => {
    expect(substitute("f()", "f($$$ARGS)", "g($$$ARGS)")).toBe("g()");
  });

  it("substitutes the same capture more than once", () => {
    expect(substitute("foo(1)", "foo($A)", "bar($A, $A)")).toBe("bar(1, 1)");
  });
});

/**
 * The tool itself, as opposed to the helpers above.
 *
 * Everything up to this point tests functions in isolation, which left the part
 * that actually TOUCHES A FILE with no coverage at all: whether a refusal really
 * leaves the file alone, whether a rewrite that would break the syntax is really
 * reverted, whether the success path writes what it says it wrote. Those are the
 * claims the tool's description makes to the model, and until now nothing
 * checked that the code keeps them.
 */
describe("the ast_edit tool", () => {
  let cwd: string;
  let pi: FakePi;

  interface EditResult {
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
    details?: { count?: number; lines?: number[] };
  }

  const astEdit = async (params: {
    path: string;
    pattern: string;
    rewrite: string;
  }): Promise<EditResult> => {
    const tool = pi.tools.get("ast_edit")!;
    const execute = tool.execute as unknown as (
      id: string,
      params: unknown,
      signal: undefined,
      onUpdate: undefined,
      ctx: { cwd: string }
    ) => Promise<EditResult>;

    return execute("call-1", params, undefined, undefined, { cwd });
  };

  const textOf = (result: EditResult): string =>
    result.content.map((part) => part.text).join("\n");
  const write = (name: string, contents: string): void =>
    fs.writeFileSync(path.join(cwd, name), contents);
  const read = (name: string): string =>
    fs.readFileSync(path.join(cwd, name), "utf8");

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ast-edit-"));
    pi = fakePi();
    astTools(pi.api as never);
  });

  afterEach(() => {
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it("rewrites every occurrence and reports the lines it touched", async () => {
    write("a.ts", 'console.log("one")\nconsole.log("two", 2)\n');

    const result = await astEdit({
      path: "a.ts",
      pattern: "console.log($$$ARGS)",
      rewrite: "logger.debug($$$ARGS)",
    });

    expect(textOf(result)).toContain("Replaced 2 occurrence(s)");
    expect(result.details?.lines).toEqual([1, 2]);
    expect(read("a.ts")).toBe('logger.debug("one")\nlogger.debug("two", 2)\n');
  });

  it("summarises a large rewrite instead of listing every line", async () => {
    write(
      "a.ts",
      Array.from({ length: 8 }, (_, index) => `console.log(${index})`).join(
        "\n"
      )
    );

    const text = textOf(
      await astEdit({
        path: "a.ts",
        pattern: "console.log($A)",
        rewrite: "track($A)",
      })
    );

    expect(text).toContain("Replaced 8 occurrence(s)");
    expect(text).toContain("… and 3 more");
  });

  it("refuses a file type it has no parser for, without touching it", async () => {
    write("notes.md", '# console.log("x")');

    const result = await astEdit({
      path: "notes.md",
      pattern: "console.log($A)",
      rewrite: "x($A)",
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("does not support this file type");
    expect(read("notes.md")).toBe('# console.log("x")');
  });

  it("reports a file it cannot read", async () => {
    const result = await astEdit({
      path: "absent.ts",
      pattern: "a($A)",
      rewrite: "b($A)",
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Cannot read absent.ts");
  });

  it.each([
    ["an empty pattern", ""],
    ["whitespace only", "   "],
    ["several statements at once", "a b c d"],
  ])(
    "reports %s as an invalid pattern rather than as no matches",
    async (_label, pattern) => {
      // These are the inputs ast-grep actually rejects. `((((` does NOT throw — it
      // parses to something that simply matches nothing — so a test using it
      // passed through the no-match path and proved nothing about this one.
      write("a.ts", "const a = 1");

      const result = await astEdit({ path: "a.ts", pattern, rewrite: "x" });

      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("Invalid pattern");
      expect(read("a.ts")).toBe("const a = 1");
    }
  );

  it("treats a pattern that merely matches nothing as no matches", async () => {
    write("a.ts", "const a = 1");

    expect(
      textOf(await astEdit({ path: "a.ts", pattern: "((((", rewrite: "x" }))
    ).toContain("No matches");
  });

  it("says a pattern matched nothing, and leaves the file alone", async () => {
    write("a.ts", "const a = 1");

    const result = await astEdit({
      path: "a.ts",
      pattern: "console.log($A)",
      rewrite: "x($A)",
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("No matches for pattern");
    expect(read("a.ts")).toBe("const a = 1");
  });

  it("refuses a rewrite naming a capture the pattern never binds", async () => {
    // The corruption case the helpers above describe, checked end to end: the
    // file has to still be on disk unchanged.
    write("a.ts", "foo(1)");

    const result = await astEdit({
      path: "a.ts",
      pattern: "foo($A)",
      rewrite: "bar($TYPO)",
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("$TYPO");
    expect(read("a.ts")).toBe("foo(1)");
  });

  it("reverts a rewrite that would leave the file unparseable", async () => {
    write("a.ts", "call(1)\n");

    const result = await astEdit({
      path: "a.ts",
      pattern: "call($A)",
      rewrite: "call($A",
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("syntax errors");
    expect(read("a.ts")).toBe("call(1)\n");
  });

  it("still edits a file that was already broken before the edit", async () => {
    // The check compares error counts rather than requiring zero, so a file the
    // user is midway through editing is not frozen against further edits.
    write("a.ts", "call(1)\nfunction broken( {\n");

    const result = await astEdit({
      path: "a.ts",
      pattern: "call($A)",
      rewrite: "invoke($A)",
    });

    expect(result.isError).toBeFalsy();
    expect(read("a.ts")).toContain("invoke(1)");
  });

  it("edits Python as readily as TypeScript", async () => {
    write("a.py", 'print("one")\nprint("two")\n');

    await astEdit({ path: "a.py", pattern: "print($A)", rewrite: "log($A)" });

    expect(read("a.py")).toBe('log("one")\nlog("two")\n');
  });
});
