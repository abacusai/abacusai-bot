import { describe, expect, it } from "vitest";

import { extractUserFileRefs } from "./user-file-refs";

describe("file refs on a user message", () => {
  it("lifts absolute non-image mentions out of the text", () => {
    const { files, text } = extractUserFileRefs(
      "whats here\n\n@/Users/me/Downloads/Notes.pdf\n@/Users/me/a.png"
    );

    expect(files).toEqual([
      { fileName: "Notes.pdf", absPath: "/Users/me/Downloads/Notes.pdf" },
    ]);
    expect(text).toBe("whats here");
  });

  it("leaves workspace-relative mentions alone", () => {
    const { files, text } = extractUserFileRefs("look at @src/app.ts please");

    expect(files).toEqual([]);
    expect(text).toBe("look at @src/app.ts please");
  });
});
