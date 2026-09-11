/**
 * The sidebar title derived from a first message.
 *
 * Small, but it is the only text identifying a session in a list of them, and
 * it is built by stripping syntax and cutting on a length — two things that go
 * wrong quietly. A title that ends mid-word, or in a broken character, is the
 * kind of defect nobody files and everybody sees.
 */
import { describe, expect, it } from "vitest";

import { deriveSessionTitle } from "./transport";

/** A high surrogate with no low surrogate after it — renders as `�`. */
const LONE_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe("stripping syntax that means nothing in a list", () => {
  it("keeps a short message as it is", () => {
    expect(deriveSessionTitle("fix the failing test")).toBe(
      "fix the failing test"
    );
  });

  it("drops the slash from a command", () => {
    expect(deriveSessionTitle("/help me with this")).toBe("help me with this");
  });

  it("keeps only the filename of an @ mention", () => {
    expect(deriveSessionTitle("look at @src/main/index.ts please")).toBe(
      "look at index.ts please"
    );
  });

  it("unwraps inline code and removes fenced blocks", () => {
    expect(deriveSessionTitle("run `npm test` now")).toBe("run npm test now");
    expect(deriveSessionTitle("```js\nconst a = 1\n```")).toBe("");
  });

  it("collapses newlines and runs of whitespace", () => {
    expect(deriveSessionTitle("first line\n\n   second   line")).toBe(
      "first line second line"
    );
  });

  it("returns empty for a message with nothing left in it", () => {
    expect(deriveSessionTitle("")).toBe("");
    expect(deriveSessionTitle("    \n  ")).toBe("");
  });
});

describe("cutting it to length", () => {
  it("leaves a message that already fits alone, with no ellipsis", () => {
    const exact = "a".repeat(48);

    expect(deriveSessionTitle(exact)).toBe(exact);
    expect(deriveSessionTitle(exact)).not.toContain("…");
  });

  it("breaks on a word boundary rather than mid-word", () => {
    // The property is that the kept text ends where a word ends — so the
    // original continues with a space at exactly that point. Asserting on the
    // character before the ellipsis instead would be wrong: breaking cleanly
    // after "and" still leaves a letter there.
    const source =
      "the quick brown fox jumps over the lazy dog and keeps running";
    const title = deriveSessionTitle(source);
    const kept = title.slice(0, -1);

    expect(title.endsWith("…")).toBe(true);
    expect(source.startsWith(kept)).toBe(true);
    expect(source[kept.length]).toBe(" ");
  });

  it("cuts hard when there is no sensible word boundary", () => {
    // A single long token has no space to break on, and a title of one word
    // truncated at 20 characters would be less useful than the full 48.
    const title = deriveSessionTitle("a".repeat(80));

    expect(title).toBe(`${"a".repeat(48)}…`);
  });

  it("never leaves half of an emoji at the cut", () => {
    // slice() counts UTF-16 code units, so a cut can land between the halves of
    // a surrogate pair. Every offset around the boundary is checked because
    // only one of them lands in the middle.
    for (let pad = 40; pad <= 50; pad++) {
      const title = deriveSessionTitle(`${"x".repeat(pad)}🎉${"y".repeat(40)}`);

      expect(LONE_SURROGATE.test(title), `emoji at index ${pad}`).toBe(false);
    }
  });

  it("keeps an emoji that fits whole", () => {
    expect(deriveSessionTitle("ship it 🎉")).toBe("ship it 🎉");
  });
});
