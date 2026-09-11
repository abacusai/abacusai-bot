import { describe, expect, it } from "vitest";

import type { Segment } from "../../conversation";
import { createTool } from "../../conversation";
import { buildChatItems } from "./render-utils";

function bashSegment(
  segmentId: string,
  callId: string,
  status: "executing" | "success"
): Segment {
  const call = {
    id: callId,
    name: "bash",
    args: { command: "pnpm test" },
    status,
  };
  return {
    id: segmentId,
    type: "tool_call",
    source: "bot",
    status: status === "executing" ? "transient" : "completed",
    tool: createTool(
      call as Parameters<typeof createTool>[0],
      status === "success"
        ? { toolCallId: callId, output: "passed" }
        : undefined
    ),
  };
}

describe("buildChatItems tool derivation adapter", () => {
  it("renders one leaf for pending and terminal markers of the same call", () => {
    const chat = buildChatItems(
      [
        bashSegment("pending", "call-1", "executing"),
        bashSegment("terminal", "call-1", "success"),
      ],
      []
    );

    expect(chat).toHaveLength(1);
    const turn = chat[0];
    expect(turn?.kind).toBe("agent");
    if (turn?.kind !== "agent") throw new Error("Expected an agent turn");
    expect(turn.items).toHaveLength(1);
    const group = turn.items[0];
    expect(group?.kind).toBe("tool_group");
    if (group?.kind !== "tool_group") throw new Error("Expected a tool group");
    expect(group.id).toBe("tool-group:call-1");
    expect(group.tools.map((tool) => tool.id)).toEqual(["call-1"]);
    expect(group.state).toBe("done");
  });

  // The upgrade card in the chat hangs off an error's actions; a mapping
  // that dropped them would quietly turn the card back into a red line.
  it("carries an error notification's actions into the render item", () => {
    const items = buildChatItems(
      [
        {
          id: "n1",
          type: "notification",
          status: "completed",
          source: "bot",
          severity: "error",
          message: "Out of included credits.",
          actions: [
            {
              type: "upgrade-abacus",
              link: "https://apps.abacus.ai/chatllm/choose-plan/",
            },
          ],
        } as never,
      ],
      []
    );

    expect(items).toHaveLength(1);
    const turn = items[0];
    if (turn?.kind !== "agent") throw new Error("Expected an agent turn");
    expect(turn.items).toEqual([
      expect.objectContaining({
        kind: "notification",
        message: "Out of included credits.",
        actions: [expect.objectContaining({ type: "upgrade-abacus" })],
      }),
    ]);
  });
});
