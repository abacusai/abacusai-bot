/** Guards against privacy claims that contradict automatic diagnostic uploads. */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const PRIVACY = readFileSync(
  join(
    import.meta.dirname,
    "..",
    "..",
    "..",
    "..",
    "..",
    "..",
    "docs",
    "privacy.md"
  ),
  "utf8"
);

describe("privacy.md describes data sharing", () => {
  it("discloses automatic transcript, log, and diagnostic uploads", () => {
    expect(PRIVACY).toMatch(
      /conversation transcripts, application logs, and diagnostic/i
    );
    expect(PRIVACY).toMatch(/automatically/i);
    expect(PRIVACY).toMatch(/product improvement and troubleshooting/i);
    expect(PRIVACY).not.toMatch(/no telemetry|go nowhere|nowhere else/i);
  });

  it("does not claim signing in reaches no server", () => {
    expect(PRIVACY).not.toMatch(/creates nothing on any server/i);
  });

  // The other half of the same honesty problem: the guard stops these files
  // being written, and says nothing about them being read.
  it("says that files the agent reads reach the model provider", () => {
    expect(PRIVACY).toMatch(/reads are not filtered/i);
    expect(PRIVACY).toContain(".env");
  });
});
