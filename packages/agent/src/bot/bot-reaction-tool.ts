/** Reactions are persisted as tool results alongside the turn they acknowledge. */
export const BOT_REACTION_TOOL_NAME = "react_to_message";
export const BOT_REACTION_EMOJIS = [
  "👍",
  "❤️",
  "😂",
  "🎉",
  "😮",
  "😢",
  "🙏",
  "👀",
] as const;

export function buildBotReactionTool() {
  return {
    name: BOT_REACTION_TOOL_NAME,
    label: BOT_REACTION_TOOL_NAME,
    description:
      "React to the user's message in this turn with one emoji. Use sparingly when a warm acknowledgement fits the meaning and tone, in any language. Do not react to automated messages or use a reaction instead of answering a question or doing requested work. Calling again replaces the reaction.",
    parameters: {
      type: "object",
      properties: { emoji: { type: "string", enum: [...BOT_REACTION_EMOJIS] } },
      required: ["emoji"],
      additionalProperties: false,
    },
    execute: async (_toolCallId: string, params: Record<string, unknown>) => {
      const emoji = params.emoji;
      if (
        typeof emoji !== "string" ||
        !BOT_REACTION_EMOJIS.some((value) => value === emoji)
      ) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Choose one of the supported reaction emojis.",
            },
          ],
          details: null,
          isError: true,
        };
      }
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ emoji }) }],
        details: { emoji },
      };
    },
  };
}
