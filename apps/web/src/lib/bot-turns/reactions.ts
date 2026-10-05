import { isMessageReaction } from "@abacus-ai/contract/message-reactions";
/**
 * The bot's reaction to a user message (spec 03 §11.3, parity P56), a port of
 * the old `agentReactions`: only a successful `react_to_message` result
 * carrying a known emoji is a reaction. Proposed, failed, denied or rejected
 * calls are not. Live results carry the agent's JSON envelope; migrated ones
 * the legacy content (and possibly `metadata.abacus.data`).
 */
import type { UIMessage } from "@tanstack/ai-client";

import { messageTools, parseJsonRecord, type MessageTool } from "./tool-parts";

const REACT_TOOL = "react_to_message";

const isReactTool = (name: string): boolean =>
  name === REACT_TOOL || name.endsWith(`_${REACT_TOOL}`);

const emojiOf = (tool: MessageTool): string | null => {
  for (const candidate of [
    parseJsonRecord(tool.text)?.emoji,
    parseJsonRecord(tool.raw)?.emoji,
    tool.data?.emoji,
  ])
    if (isMessageReaction(candidate)) return candidate;
  return null;
};

/** The reaction a turn's assistant messages made, or null (the last wins). */
export function turnReaction(
  assistantMessages: readonly UIMessage[]
): string | null {
  let reaction: string | null = null;
  for (const message of assistantMessages)
    for (const tool of messageTools(message)) {
      if (!isReactTool(tool.name) || !tool.settled) continue;
      const emoji = emojiOf(tool);
      if (emoji != null) reaction = emoji;
    }
  return reaction;
}

/** Text that is exactly one reaction emoji (trimmed). */
export const isEmojiOnly = (text: string): boolean =>
  isMessageReaction(text.trim());
