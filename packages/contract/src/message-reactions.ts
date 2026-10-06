import type { UIMessage } from "@tanstack/ai";
export const MESSAGE_REACTION_EMOJIS = [
  "👍",
  "❤️",
  "😂",
  "🎉",
  "🔥",
  "😮",
  "😢",
  "🙏",
  "👀",
  "🤗",
  "😊",
  "💪",
  "🤔",
] as const;
export const isMessageReaction = (value: unknown): value is string =>
  typeof value === "string" &&
  MESSAGE_REACTION_EMOJIS.some((emoji) => emoji === value);

export interface MessageReactionChange {
  messageId: string;
  emoji: string;
  selected: boolean;
}

export const applyMessageReaction = (
  messages: readonly UIMessage[],
  change: MessageReactionChange
): UIMessage[] =>
  messages.map((message) => {
    if (message.id !== change.messageId || !isMessageReaction(change.emoji))
      return message;
    const abacus = message.metadata?.abacus ?? {};
    const previous: string[] = abacus.reactions ?? [];
    const reactions = change.selected
      ? [...new Set([...previous, change.emoji])]
      : previous.filter((emoji) => emoji !== change.emoji);
    return {
      ...message,
      reactions,
      metadata: { ...message.metadata, abacus: { ...abacus, reactions } },
    };
  });
