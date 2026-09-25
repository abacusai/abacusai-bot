import { describe, expect, it } from "vitest";

import { deriveGroupedTranscript } from "./derivations";
import type { Segment } from "./types";
import { createTool } from "./types";

function toolSegment({
  segmentId,
  callId,
  name = "bash",
  status = "success",
  subtaskId,
  error,
}: {
  segmentId: string;
  callId: string;
  name?: string;
  status?: "executing" | "success" | "error";
  subtaskId?: string;
  error?: string;
}): Segment {
  const call = {
    id: callId,
    name,
    args: name === "bash" ? { command: "pnpm test" } : { path: "src/a.ts" },
    status,
  };
  const result =
    status === "executing"
      ? undefined
      : { toolCallId: callId, output: "done", ...(error ? { error } : {}) };
  return {
    id: segmentId,
    type: "tool_call",
    source: "bot",
    status: status === "executing" ? "transient" : "completed",
    ...(subtaskId ? { subtaskId } : {}),
    tool: createTool(call as Parameters<typeof createTool>[0], result),
  };
}

function botText(id: string, content = "Finished."): Segment {
  return {
    id,
    type: "text",
    source: "bot",
    status: "completed",
    content,
  };
}

describe("deriveGroupedTranscript", () => {
  it("replaces superseded lifecycle markers instead of rendering both", () => {
    const pending = toolSegment({
      segmentId: "pending",
      callId: "call-1",
      status: "executing",
    });
    const completed = toolSegment({
      segmentId: "completed",
      callId: "call-1",
    });

    const result = deriveGroupedTranscript([pending, completed]);

    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]?.memberIds).toEqual(["completed"]);
    expect(result.groups[0]?.id).toBe("tool-group:call-1");
  });

  it("is not split by the blank lines a model streams around its calls", () => {
    // Providers emit a "\n\n" text segment between tool calls. It draws
    // nothing, and it used to end the run: a chat that called one tool
    // nineteen times showed nineteen "Used 1 tool" rows separated by
    // whitespace nobody could see.
    const result = deriveGroupedTranscript([
      toolSegment({ segmentId: "one", callId: "call-1", name: "list_chats" }),
      botText("gap-1", "\n\n"),
      toolSegment({ segmentId: "two", callId: "call-2", name: "list_chats" }),
      botText("gap-2", "   "),
      toolSegment({ segmentId: "three", callId: "call-3", name: "list_chats" }),
    ]);

    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]?.callIds).toEqual(["call-1", "call-2", "call-3"]);
    // The blanks are not members of the group either; nothing to reveal.
    expect(result.groups[0]?.memberIds).toEqual(["one", "two", "three"]);
  });

  it("still stops at text the user can actually read", () => {
    const result = deriveGroupedTranscript([
      toolSegment({ segmentId: "one", callId: "call-1" }),
      botText("said", "Let me check without a filter."),
      toolSegment({ segmentId: "two", callId: "call-2" }),
    ]);

    expect(result.groups.map((group) => group.callIds)).toEqual([
      ["call-1"],
      ["call-2"],
    ]);
  });

  it("combines adjacent work but stops at conversational content", () => {
    const result = deriveGroupedTranscript([
      toolSegment({ segmentId: "read", callId: "read-1", name: "read" }),
      toolSegment({ segmentId: "bash", callId: "bash-1" }),
      botText("answer"),
      toolSegment({ segmentId: "later", callId: "bash-2" }),
    ]);

    expect(result.groups.map((group) => group.callIds)).toEqual([
      ["read-1", "bash-1"],
      ["bash-2"],
    ]);
  });

  it("exposes only the newest running call as the live row", () => {
    const result = deriveGroupedTranscript([
      toolSegment({
        segmentId: "first",
        callId: "call-1",
        status: "executing",
      }),
      toolSegment({
        segmentId: "second",
        callId: "call-2",
        status: "executing",
      }),
    ]);

    expect(result.groups[0]?.status).toBe("executing");
    expect(result.groups[0]?.activeCallId).toBe("call-2");
  });

  it("settles a result-less call once later transcript content supersedes it", () => {
    const result = deriveGroupedTranscript([
      toolSegment({
        segmentId: "pending",
        callId: "call-1",
        status: "executing",
      }),
      botText("answer"),
    ]);

    expect(result.groups[0]?.status).toBe("success");
    expect(result.groups[0]?.activeCallId).toBeNull();
  });

  it("keeps failures explicit on a completed group", () => {
    const result = deriveGroupedTranscript([
      toolSegment({
        segmentId: "failed",
        callId: "call-1",
        status: "error",
        error: "boom",
      }),
    ]);

    expect(result.groups[0]?.status).toBe("error");
  });

  it("does not merge work across sub-agent scope boundaries", () => {
    const result = deriveGroupedTranscript([
      toolSegment({ segmentId: "main", callId: "call-main" }),
      toolSegment({
        segmentId: "agent",
        callId: "call-agent",
        subtaskId: "subtask-1",
      }),
    ]);

    expect(result.groups.map((group) => group.callIds)).toEqual([
      ["call-main"],
      ["call-agent"],
    ]);
  });
});
