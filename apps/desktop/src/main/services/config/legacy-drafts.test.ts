import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expect, it } from "vitest";

import { acknowledgeLegacyDrafts, pendingLegacyDrafts } from "./legacy-drafts";

it("reads synthetic v1.0.85 durable draft text and remembers successful imports across launches", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-drafts-"));
  try {
    fs.mkdirSync(path.join(home, "electron"));
    fs.writeFileSync(
      path.join(home, "electron", "renderer-state.json"),
      JSON.stringify({
        "composer.draft:thread-1": "unsent words",
        "composer.draft:thread-2": "retry words",
        unrelated: "retained",
      })
    );
    expect(pendingLegacyDrafts(home)).toEqual({
      "thread-1": "unsent words",
      "thread-2": "retry words",
    });
    acknowledgeLegacyDrafts(home, ["thread-1"]);
    expect(pendingLegacyDrafts(home)).toEqual({ "thread-2": "retry words" });
    expect(
      fs.readFileSync(
        path.join(home, "electron", "renderer-state.json"),
        "utf8"
      )
    ).toContain("unsent words");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
