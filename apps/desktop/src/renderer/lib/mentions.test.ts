import { describe, expect, it } from "vitest";

import { formatFileMention, getMentionAtCursor, tokenize } from "./mentions";

describe("file mentions", () => {
  it("keeps paths with spaces in one quoted mention", () => {
    expect(formatFileMention("docs/My file.md")).toBe('@"docs/My file.md"');
    expect(getMentionAtCursor('@"docs/My f', 11)).toEqual({
      query: "docs/My f",
      startPos: 0,
      endPos: 11,
    });
    expect(tokenize('Read @"docs/My file.md" next')).toEqual([
      { type: "text", value: "Read " },
      { type: "mention", value: '@"docs/My file.md"' },
      { type: "text", value: " next" },
    ]);
  });

  it("does not treat an email address as a file mention", () => {
    expect(getMentionAtCursor("me@example.com", 14)).toBeNull();
    expect(tokenize("me@example.com")).toEqual([
      { type: "text", value: "me@example.com" },
    ]);
  });
});
