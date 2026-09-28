export const MESSAGE_REACTION_EMOJIS = [
  "👍",
  "❤️",
  "😂",
  "🎉",
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
