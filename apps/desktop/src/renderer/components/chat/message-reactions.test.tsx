import { describe, expect, it } from "vitest";

import { agentReactions } from "./message-reactions";
import type { ChatRenderItem, ToolRenderItem } from "./render-utils";

const user = (id: string): ChatRenderItem => ({
  kind: "user",
  id,
  text: "Hello",
});
const reaction = (
  emoji: string,
  state: ToolRenderItem["state"] = "done"
): ChatRenderItem => ({
  kind: "agent",
  id: "agent",
  items: [
    {
      kind: "tool_group",
      id: "group",
      summary: "",
      state,
      tools: [
        {
          id: "tool",
          name: "react_to_message",
          streamingArgs: false,
          input: { emoji },
          state,
          result: { id: "tool", content: JSON.stringify({ emoji }) },
        },
      ],
    },
  ],
});

describe("message reactions", () => {
  it("attaches successful reactions to their own user turn, including a reaction-only turn", () => {
    expect([
      ...agentReactions([
        user("first"),
        reaction("❤️"),
        user("second"),
        reaction("🎉"),
      ]),
    ]).toEqual([
      ["first", "❤️"],
      ["second", "🎉"],
    ]);
  });
  it("ignores pending, failed, invalid, and unassociated reactions", () => {
    expect(
      agentReactions([reaction("❤️"), user("one"), reaction("👍", "running")])
        .size
    ).toBe(0);
    expect(agentReactions([user("one"), reaction("👍", "error")]).size).toBe(0);
    expect(agentReactions([user("one"), reaction("not an emoji")]).size).toBe(
      0
    );
    expect([
      ...agentReactions([user("one"), reaction("👍"), reaction("❤️")]),
    ]).toEqual([["one", "👍"]]);
  });
});
