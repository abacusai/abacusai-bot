/**
 * The matching cascade is the part of the edit tool that decides what gets
 * overwritten, so its failure mode is silent corruption rather than a visible
 * error. These tests pin down two things in particular: that an exact quote
 * always wins outright (so nothing that worked before starts matching loosely),
 * and that a relaxed strategy is never allowed to swallow more than it was
 * asked for.
 */
import { describe, expect, it } from "vitest";

import {
  lineOf,
  normalizeUnicode,
  resolveEdit,
  spliceRanges,
} from "./edit-resolve.js";

/** The text a successful resolve points at, for readable assertions. */
function matched(
  content: string,
  oldText: string,
  newText = "REPLACED",
  replaceAll = false
) {
  const result = resolveEdit(content, oldText, newText, replaceAll);
  if (!result.ok)
    throw new Error(`expected a match, got ${result.failure.kind}`);
  return {
    strategy: result.strategy,
    relaxed: result.relaxed,
    spans: result.ranges.map((r) => content.slice(r.start, r.end)),
  };
}

function failure(
  content: string,
  oldText: string,
  newText = "REPLACED",
  replaceAll = false
) {
  const result = resolveEdit(content, oldText, newText, replaceAll);
  if (result.ok)
    throw new Error(
      `expected a failure, matched ${result.ranges.length} span(s)`
    );
  return result.failure;
}

describe("exact matching", () => {
  it("finds the text verbatim", () => {
    const found = matched("const a = 1\nconst b = 2\n", "const b = 2");

    expect(found.strategy).toBe("exact");
    expect(found.relaxed).toBe(false);
    expect(found.spans).toEqual(["const b = 2"]);
  });

  it("wins outright, so a file quoted correctly never matches loosely", () => {
    // `  x = 1` appears exactly; a relaxed strategy would also match `x = 1`
    // on the other line. Exact must take the exact span, unambiguously.
    const content = "if (a) {\n  x = 1\n}\nx = 1\n";
    const found = matched(content, "  x = 1");

    expect(found.strategy).toBe("exact");
    expect(found.spans).toEqual(["  x = 1"]);
  });

  it("treats a repeated quote as ambiguous rather than guessing", () => {
    const content = "log(a)\nlog(a)\nlog(a)\n";
    const result = failure(content, "log(a)");

    expect(result).toMatchObject({
      kind: "ambiguous",
      count: 3,
      lines: [1, 2, 3],
    });
  });

  it("returns every occurrence when replaceAll is set", () => {
    const content = "log(a)\nlog(a)\nlog(a)\n";
    const found = matched(content, "log(a)", "trace(a)", true);

    expect(found.spans).toEqual(["log(a)", "log(a)", "log(a)"]);
  });
});

describe("recovering from a near-miss", () => {
  it("tolerates indentation drift", () => {
    const content = "function f() {\n  return 1\n}\n";
    // The model indented four where the file indents two. Quoting *less*
    // indentation than the file has would still be an exact substring match,
    // so over-indenting is the case that actually needs recovering from.
    const found = matched(content, "    return 1");

    expect(found.relaxed).toBe(true);
    expect(found.spans).toEqual(["  return 1"]);
  });

  it("tolerates a tab where the file has spaces", () => {
    const content = "def f():\n    return 1\n";
    const found = matched(content, "\treturn 1");

    expect(found.relaxed).toBe(true);
    expect(found.spans).toEqual(["    return 1"]);
  });

  it("tolerates smart quotes, preserving pi’s old fuzzy behaviour", () => {
    const content = "const label = 'hi'\n";
    const found = matched(content, "const label = ‘hi’");

    expect(found.strategy).toBe("unicode-normalized");
    expect(found.spans).toEqual(["const label = 'hi'"]);
  });

  it("tolerates a Unicode dash", () => {
    const content = "const range = 1-2\n";
    const found = matched(content, "const range = 1–2");

    expect(found.strategy).toBe("unicode-normalized");
  });

  it("tolerates trailing whitespace in the file", () => {
    const content = "const a = 1   \nconst b = 2\n";
    const found = matched(content, "const a = 1");

    // `const a = 1` is a prefix of the real line, so exact finds it directly.
    expect(found.spans).toEqual(["const a = 1"]);
  });

  it("tolerates whitespace redistributed inside a line", () => {
    const content = "const  a   =    1\n";
    const found = matched(content, "const a = 1");

    expect(found.relaxed).toBe(true);
    expect(found.spans).toEqual(["const  a   =    1"]);
  });

  it("tolerates a whole block shifted right", () => {
    const content = "class C {\n    def a(self):\n        return 1\n";
    const found = matched(content, "def a(self):\n    return 1");

    expect(found.relaxed).toBe(true);
    expect(found.spans).toEqual(["    def a(self):\n        return 1"]);
  });

  it("tolerates escaped newlines from a hand-built payload", () => {
    const content = "a = 1\nb = 2\n";
    const found = matched(content, "a = 1\\nb = 2");

    expect(found.strategy).toBe("escape-normalized");
    expect(found.spans).toEqual(["a = 1\nb = 2"]);
  });

  it("tolerates blank lines padded around the block", () => {
    const content = "x\nconst a = 1\ny\n";
    const found = matched(content, "\n\nconst a = 1\n\n");

    expect(found.relaxed).toBe(true);
    expect(found.spans).toEqual(["const a = 1"]);
  });

  it("rescues a block whose middle the model misremembered", () => {
    const content = [
      "function f() {",
      "  const x = compute()",
      "  return x",
      "}",
    ].join("\n");
    // Middle line paraphrased; the anchors and the shape still hold.
    const found = matched(
      content,
      ["function f() {", "  const x = calculate()", "  return x", "}"].join(
        "\n"
      )
    );

    expect(found.relaxed).toBe(true);
    expect(found.spans[0]).toContain("compute()");
  });
});

describe("the strategies that only win in narrow cases", () => {
  // These sit late in the cascade and earlier strategies claim most inputs, so
  // it is worth pinning a shape each one actually wins, or a later refactor
  // could strand them without any test noticing.

  it("matches a multi-line block whose whitespace was redistributed", () => {
    const found = matched("const  a =\n   1\n", "const a =\n 1");

    expect(found.strategy).toBe("whitespace-normalized");
  });

  it("matches a padded quote whose interior spans lines", () => {
    const found = matched("x\n  foo(\n  bar)\ny\n", "\n  foo(\n  bar)\n\n");

    expect(found.strategy).toBe("trimmed-boundary");
    expect(found.spans).toEqual(["foo(\n  bar)"]);
  });

  it("matches on surrounding context when a decoy anchor defeats the block anchors", () => {
    // The `}` on line 3 is the first closing anchor block-anchor finds, and the
    // block it forms is the wrong size, so block-anchor gives up there. The
    // exact-height block still ends on the real anchor.
    const content = ["fn {", "  a()", "}", "  c()", "}"].join("\n");
    const found = matched(
      content,
      ["fn {", "  a()", "  b()", "  c()", "}"].join("\n")
    );

    expect(found.strategy).toBe("context-anchored");
  });
});

describe("refusing to overreach", () => {
  it("will not let anchors swallow an unrelated span", () => {
    // Both `}` lines are plausible closers; matching from the first `{` to the
    // last `}` would replace the entire file.
    const content = [
      "function a() {",
      "  one()",
      "}",
      "function b() {",
      "  two()",
      "  three()",
      "  four()",
      "  five()",
      "  six()",
      "  seven()",
      "}",
    ].join("\n");

    const result = resolveEdit(
      content,
      "function a() {\n  ONE()\n}",
      "x",
      false
    );

    // Either it declines to match, or it matches the small correct block —
    // what it must never do is return the whole file.
    if (result.ok) {
      expect(
        content
          .slice(result.ranges[0]!.start, result.ranges[0]!.end)
          .split("\n").length
      ).toBeLessThanOrEqual(4);
    } else {
      expect(["not-found", "disproportionate"]).toContain(result.failure.kind);
    }
  });

  it("refuses a match whose character span dwarfs the request", () => {
    // Same tokens and the same number of lines, but the file's copy carries an
    // enormous whitespace run. Whitespace-normalized matching would happily
    // splice over all three thousand characters for a seven-character quote.
    const content = `a${" ".repeat(3_000)}b\nc d\n`;

    expect(failure(content, "a b\nc d")).toMatchObject({
      kind: "disproportionate",
    });
  });

  it("never proposes a span twice the height of the request", () => {
    // This is the invariant that keeps the anchor strategies safe: block-anchor
    // caps its size drift at a quarter, so a runaway match cannot be built in
    // the first place. If a future strategy loosens that, this fails.
    const content = [
      "function a() {",
      ...Array.from({ length: 60 }, (_, i) => `  step${i}()`),
      "}",
    ].join("\n");

    for (const quote of [
      "function a() {\n  stepX()\n}",
      "function a() {\n  step0()\n  stepX()\n}",
      "  stepZZ()",
    ]) {
      const result = resolveEdit(content, quote, "x", false);
      if (!result.ok) continue;
      const span = content.slice(
        result.ranges[0]!.start,
        result.ranges[0]!.end
      );
      expect(span.split("\n").length).toBeLessThan(
        quote.split("\n").length * 2
      );
    }
  });

  it("reports text that simply is not there", () => {
    expect(failure("const a = 1\n", "const zzz = 9")).toMatchObject({
      kind: "not-found",
    });
  });
});

describe("declining rather than guessing", () => {
  // These exercise the paths where a strategy looks at something and decides
  // it is not a match. They matter because the alternative to declining is a
  // confident splice in the wrong place.

  it("walks past blocks that do not match when normalizing Unicode", () => {
    const content = "let a = 'x'\nconst label = 'hi'\nlet b = 'y'\n";
    const found = matched(content, "const label = \u2018hi\u2019");

    expect(found.strategy).toBe("unicode-normalized");
    expect(found.spans).toEqual(["const label = 'hi'"]);
  });

  it("holds anchor matches to a stricter bar when several blocks could fit", () => {
    // Two blocks share the anchors and neither middle really matches, so the
    // anchors alone must not be enough to pick one.
    const content = [
      "open {",
      "  aa()",
      "close }",
      "open {",
      "  bb()",
      "close }",
    ].join("\n");

    expect(
      failure(content, ["open {", "  ZZ()", "close }"].join("\n"))
    ).toMatchObject({
      kind: "not-found",
    });
  });

  it("gives up on a quote that is only whitespace", () => {
    expect(failure("const a = 1\n", "   ")).toMatchObject({
      kind: "not-found",
    });
  });

  it("does not invent a match when unescaping produces text the file lacks", () => {
    expect(failure("const a = 1\n", "nothing\\nlike this")).toMatchObject({
      kind: "not-found",
    });
  });

  it("ignores blank lines on both sides when scoring surrounding context", () => {
    // The blank line at the same position in both is "nothing to compare", not
    // a mismatch — counting it against the score would sink an honest match.
    const content = ["fn {", "  a()", "}", "", "}"].join("\n");
    const found = matched(
      content,
      ["fn {", "  a()", "  b()", "", "}"].join("\n")
    );

    expect(found.strategy).toBe("context-anchored");
  });

  it("tolerates a trailing newline on the quote", () => {
    // A quote copied out of a file usually carries the newline that ended it,
    // which would otherwise read as an extra empty line that matches nothing.
    const content = ["fn {", "  a()", "}", "  c()", "}"].join("\n");
    const found = matched(
      content,
      `${["fn {", "  a()", "  b()", "  c()", "}"].join("\n")}\n`
    );

    expect(found.strategy).toBe("context-anchored");
  });
});

describe("rejecting edits that mean nothing", () => {
  it("refuses an empty oldText", () => {
    expect(failure("anything", "")).toMatchObject({ kind: "empty" });
  });

  it("refuses an edit that replaces text with itself", () => {
    expect(
      failure("const a = 1\n", "const a = 1", "const a = 1")
    ).toMatchObject({
      kind: "identical",
    });
  });
});

describe("splicing", () => {
  it("preserves a dollar sign, which String.replace would treat as syntax", () => {
    // `$&` in a replacement means "the whole match" to replace/replaceAll. The
    // splice must write the literal characters instead.
    const content = "const price = 0\n";
    const out = spliceRanges(content, [
      { start: 14, end: 15, text: '"$& $1 $$"' },
    ]);

    expect(out).toBe('const price = "$& $1 $$"\n');
  });

  it("applies several disjoint patches against the original offsets", () => {
    const content = "aaa bbb ccc";
    const out = spliceRanges(content, [
      { start: 8, end: 11, text: "Z" },
      { start: 0, end: 3, text: "X" },
    ]);

    expect(out).toBe("X bbb Z");
  });

  it("drops a patch that overlaps one already applied rather than interleaving", () => {
    const content = "abcdef";
    const out = spliceRanges(content, [
      { start: 0, end: 4, text: "X" },
      { start: 2, end: 6, text: "Y" },
    ]);

    expect(out).toBe("Xef");
  });

  it("leaves content untouched when there is nothing to splice", () => {
    expect(spliceRanges("abc", [])).toBe("abc");
  });
});

describe("helpers", () => {
  it("reports 1-based line numbers", () => {
    const content = "a\nb\nc\n";

    expect(lineOf(content, 0)).toBe(1);
    expect(lineOf(content, 2)).toBe(2);
    expect(lineOf(content, 4)).toBe(3);
  });

  it("normalizes only the characters it claims to", () => {
    expect(normalizeUnicode("a’b")).toBe("a'b");
    expect(normalizeUnicode("a  \nb")).toBe("a\nb");
    expect(normalizeUnicode("plain")).toBe("plain");
  });
});

/**
 * The relaxed strategies each scan the whole file, so their cost is the thing
 * most likely to regress quietly. The common case must stay free, and the worst
 * case — nothing matches, so all nine strategies run — must stay far inside the
 * tool's 30s budget.
 */
describe("cost on a large file", () => {
  // The default 5s timeout is shorter than the budget this asserts, so a slow
  // run died as "Test timed out" — the harness failing before the assertion
  // could say what the measurement actually was. The ceiling is generous for
  // the same reason: on a CI runner sharing its cores with the rest of the
  // suite this takes seconds, not the ~1s it takes on an idle machine, and a
  // threshold tight enough to catch that variance catches nothing else.
  it("worst case (nothing matches, every strategy runs) stays well inside the tool budget", () => {
    const content = Array.from(
      { length: 50_000 },
      (_, i) => `  const line${i} = compute(${i})`
    ).join("\n");
    const find = Array.from(
      { length: 100 },
      (_, i) => `  const nope${i} = absent(${i})`
    ).join("\n");

    const started = performance.now();
    const result = resolveEdit(content, find, "x", false);
    const elapsed = performance.now() - started;

    expect(result.ok).toBe(false);
    console.log(`worst case on 50k lines: ${elapsed.toFixed(0)}ms`);
    expect(elapsed).toBeLessThan(20_000);
  }, 30_000);

  it("the common case (exact match) is immediate", () => {
    const content = Array.from(
      { length: 50_000 },
      (_, i) => `  const line${i} = compute(${i})`
    ).join("\n");

    const started = performance.now();
    const result = resolveEdit(
      content,
      "  const line49999 = compute(49999)",
      "x",
      false
    );
    const elapsed = performance.now() - started;

    expect(result.ok).toBe(true);
    console.log(`exact match on 50k lines: ${elapsed.toFixed(0)}ms`);
    expect(elapsed).toBeLessThan(500);
  });
});
