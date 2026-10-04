/**
 * The bounded streaming v1 reader (cut-over review r2 #8, #9): the same
 * segments and fingerprint as reading the whole file, whatever the chunk
 * boundaries (inside strings, escapes and multi-byte characters).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { parseTranscriptV1 } from "@abacus-ai/contract/transcript/thread-file";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { streamTranscriptV1 } from "./stream-v1";
import { fingerprintV1 } from "./thread-store";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "stream-v1-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const write = (text: string) => {
  const file = path.join(dir, "t.json");
  fs.writeFileSync(file, text);
  return file;
};

const TRICKY = JSON.stringify({
  version: 1,
  sessionId: 's "quoted" [x]',
  extra: { nested: [1, { a: "]}" }] },
  updatedAt: "2026-09-01T10:00:00.000Z",
  segments: [
    {
      type: "text",
      id: "u1",
      source: "user",
      content: 'brackets ]}[{ and \\" escapes \\\\',
    },
    null,
    7,
    "str,ing",
    [1, [2, 3]],
    {
      type: "text",
      id: "b1",
      source: "bot",
      content: "émoji 🎉 ünïcode ✓".repeat(20),
    },
    {
      type: "tool_call",
      id: "t",
      toolCall: { id: "c", name: "bash", args: { command: 'echo "}"' } },
    },
  ],
  after: "tail",
});

describe("streamTranscriptV1", () => {
  it.each([1, 2, 3, 7, 64, 1 << 20])(
    "matches a whole-file parse with %i-byte chunks",
    (chunkBytes) => {
      const file = write(TRICKY);
      const parsed = parseTranscriptV1(TRICKY);
      if (parsed.status !== "ok") throw new Error("fixture");
      expect(streamTranscriptV1(file, { chunkBytes })).toEqual({
        status: "ok",
        updatedAt: "2026-09-01T10:00:00.000Z",
        segments: parsed.file.segments,
        fingerprint: fingerprintV1(TRICKY),
      });
    }
  );

  it("reports what is not a v1 file", () => {
    expect(
      streamTranscriptV1(write('{"version":2,"segments":[]}')).status
    ).toBe("invalid");
    expect(streamTranscriptV1(write('{"version":1}')).status).toBe("invalid");
    expect(
      streamTranscriptV1(write('{"version":1,"segments":[{"a":')).status
    ).toBe("invalid");
    expect(streamTranscriptV1(write("[1,2]")).status).toBe("invalid");
    expect(streamTranscriptV1(path.join(dir, "none.json")).status).toBe(
      "missing"
    );
  });
});
