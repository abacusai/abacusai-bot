import { describe, expect, it } from "vitest";

import { parseChangelog } from "./changelog";

describe("parseChangelog", () => {
  it("splits the file into releases, newest first as written, with their bullets", () => {
    const releases = parseChangelog(
      [
        "# Changelog",
        "",
        "## 1.0.60 (2026-09-07)",
        "",
        "- One thing ([#1](https://example.com/pull/1))",
        "- Another",
        "",
        "## 1.0.59",
        "",
        "- Older",
        "",
      ].join("\n")
    );

    expect(releases).toEqual([
      {
        version: "1.0.60",
        date: "2026-09-07",
        body: "- One thing ([#1](https://example.com/pull/1))\n- Another",
      },
      { version: "1.0.59", date: null, body: "- Older" },
    ]);
  });

  it("is empty for a file with no releases", () => {
    expect(parseChangelog("# Changelog\n")).toEqual([]);
  });
});
