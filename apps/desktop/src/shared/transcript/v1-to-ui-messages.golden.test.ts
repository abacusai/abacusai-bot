/**
 * C-T1: `__fixtures__/v1/*.json` (synthetic v1 transcript files, one per case
 * of spec 00 C.7) → `__fixtures__/expected-v2/*.json` (the v2 thread file),
 * compared after stable key ordering. `UPDATE_GOLDEN=1` rewrites the
 * expectations.
 */
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { stableJson } from "./test-support";
import { parseTranscriptV1, v1ToThreadFile } from "./thread-file";

const FIXTURES = path.join(__dirname, "__fixtures__", "v1");
const EXPECTED = path.join(__dirname, "__fixtures__", "expected-v2");
const UPDATE = process.env.UPDATE_GOLDEN === "1";

const names = fs
  .readdirSync(FIXTURES)
  .filter((name) => name.endsWith(".json"))
  .sort();

/** The cases C.7 lists, so a deleted fixture fails here. */
const REQUIRED = [
  "compaction",
  "credits",
  "display-segments",
  "empty",
  "legacy-protocol-tool",
  "media",
  "missing-at",
  "notification",
  "plain-chat",
  "subtask-edges",
  "subtasks",
  "tool-calls",
  "tool-group",
  "tool-result-states",
  "unknown-segments",
  "user-inside-bracket",
  "versions-regenerate",
  "web-search",
];

const convertFixture = (name: string) => {
  const parsed = parseTranscriptV1(
    fs.readFileSync(path.join(FIXTURES, name), "utf8")
  );
  if (parsed.status !== "ok") throw new Error(`${name}: ${parsed.status}`);
  return v1ToThreadFile({
    threadId: parsed.file.sessionId,
    updatedAt: parsed.file.updatedAt ?? "",
    segments: parsed.file.segments,
  });
};

describe("C-T1 v1 → v2 golden", () => {
  it("has every fixture the spec lists", () => {
    expect(names.map((name) => name.replace(/\.json$/, ""))).toEqual(
      expect.arrayContaining(REQUIRED)
    );
  });

  it.each(names)("%s", (name) => {
    const actual = stableJson(convertFixture(name));
    const expectedFile = path.join(EXPECTED, name);
    if (UPDATE) {
      fs.mkdirSync(EXPECTED, { recursive: true });
      fs.writeFileSync(expectedFile, actual);
      return;
    }
    // Parsed on both sides, so the formatter's layout never matters.
    expect(JSON.parse(actual)).toEqual(
      JSON.parse(fs.readFileSync(expectedFile, "utf8"))
    );
  });
});
