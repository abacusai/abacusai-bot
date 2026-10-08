import { describe, expect, it } from "vitest";

import type { StoredTranscript } from "../session/transcript-service";
import {
  buildSyncPayload,
  emptySyncState,
  shouldSync,
  syncStateFromCount,
  type SyncState,
} from "./debug-sync.core";

const meta = {
  clientVersion: "1.0.0",
  deviceId: "device",
  environment: { platform: "darwin" } as never,
};

const transcript = (...ids: string[]): StoredTranscript => ({
  version: 1,
  sessionId: "sess",
  updatedAt: "",
  segments: ids.map((id) => ({ id, type: "text" })),
});

const upload = (
  current: StoredTranscript,
  state: SyncState
): { sent: Array<[number, unknown]>; after: SyncState } => {
  const { payload, after } = buildSyncPayload(current, meta, state);
  return {
    sent: payload.events.map((event) => [
      event.event_sequence_number,
      (event.segment as { id: string }).id,
    ]),
    after,
  };
};

describe("uploading a transcript that is rewritten in place", () => {
  it("keeps each reply at the sequence it was first uploaded under", () => {
    const first = upload(transcript("u1", "tool-a", "b1"), emptySyncState());
    // The turn settles: a placeholder goes, and a call lands mid-list.
    const second = upload(
      transcript("u1", "call", "b1", "u2", "b2"),
      first.after
    );

    expect(second.sent).toEqual([
      [3, "call"],
      [4, "u2"],
      [5, "b2"],
    ]);
    expect(second.after.sequences.b1).toBe(2);
    expect(second.after.sequences.b2).toBe(5);
    expect(
      shouldSync(transcript("u1", "call", "b1", "u2", "b2"), second.after)
    ).toBe(false);
  });

  it("sends both frames of a sub-agent bracket", () => {
    const { sent } = upload(
      {
        ...transcript(),
        segments: [
          { id: "sub", type: "subtask", status: "created" },
          { id: "sub", type: "subtask", status: "completed" },
        ],
      },
      emptySyncState()
    );

    expect(sent).toHaveLength(2);
  });

  it("reads a plain count marker as the segments already uploaded in place", () => {
    const current = transcript("u1", "b1", "u2", "b2");
    const state = syncStateFromCount(current, 2);

    expect(state.sequences).toEqual({ u1: 0, b1: 1 });
    expect(upload(current, state).sent).toEqual([
      [2, "u2"],
      [3, "b2"],
    ]);
  });
});

describe("what an upload carries", () => {
  it("scrubs keys out of every segment's text, keys and shape untouched", () => {
    const current: StoredTranscript = {
      version: 1,
      sessionId: "sess",
      updatedAt: "",
      segments: [
        {
          id: "tool",
          type: "tool",
          output:
            "ABACUS_API_KEY=s2_0123456789abcdef0123 and sk-proj-abcdefghij",
        } as never,
      ],
    };
    const { payload } = buildSyncPayload(current, meta, emptySyncState());
    const segment = payload.events[0]!.segment as Record<string, string>;

    expect(Object.keys(segment)).toEqual(["id", "type", "output"]);
    expect(segment.output).not.toContain("s2_0123456789abcdef0123");
    expect(segment.output).not.toContain("sk-proj-abcdefghij");
  });
});
