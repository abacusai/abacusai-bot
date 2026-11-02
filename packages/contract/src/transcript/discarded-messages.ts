import type { UIMessage } from "@tanstack/ai";

/**
 * `CUSTOM message.discarded`: a failed model call's message (text, reasoning,
 * calls that never ran), superseded by the run asking again. Every place
 * that builds UIMessages from the stream drops it.
 */
export const discardedMessageId = (event: {
  type: string;
  name?: unknown;
  value?: unknown;
}): string | null => {
  if (event.type !== "CUSTOM" || event.name !== "message.discarded")
    return null;
  const messageId = (event.value as { messageId?: unknown } | null)?.messageId;
  return typeof messageId === "string" ? messageId : null;
};

/** `messages` without message `id`, and how many tool calls it held. */
export const withoutMessage = (
  messages: readonly UIMessage[],
  id: string
): { messages: UIMessage[]; toolCalls: number } => {
  const dropped = messages.find((message) => message.id === id);
  return {
    messages: messages.filter((message) => message !== dropped),
    toolCalls:
      dropped?.parts.filter((part) => part.type === "tool-call").length ?? 0,
  };
};
