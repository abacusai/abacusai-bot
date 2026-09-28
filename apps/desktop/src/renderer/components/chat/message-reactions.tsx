import { isMessageReaction } from "#shared/message-reactions";

import type { ChatRenderItem } from "./render-utils";

/** Read only successful tool results; proposed or rejected tool calls are not reactions. */
export function agentReactions(items: ChatRenderItem[]): Map<string, string> {
  const reactions = new Map<string, string>();
  let userId: string | undefined;
  for (const item of items) {
    if (item.kind === "user") {
      userId = item.id;
      continue;
    }
    if (userId == null) continue;
    for (const part of item.items) {
      if (part.kind !== "tool_group") continue;
      for (const tool of part.tools) {
        if (
          tool.name !== "react_to_message" ||
          tool.state !== "done" ||
          tool.result?.rejected
        )
          continue;
        try {
          const result: unknown = JSON.parse(tool.result?.content ?? "");
          if (
            result != null &&
            typeof result === "object" &&
            "emoji" in result &&
            isMessageReaction(result.emoji)
          )
            reactions.set(userId, result.emoji);
        } catch {
          /* Older or failed tool results carry no reaction. */
        }
      }
    }
    userId = undefined;
  }
  return reactions;
}
