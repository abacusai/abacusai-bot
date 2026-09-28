/** Reactions are persisted as tool results alongside the turn they acknowledge. */
export const BOT_REACTION_TOOL_NAME = "react_to_message";
export const BOT_REACTION_EMOJIS = [
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

export function buildBotReactionTool() {
  return {
    name: BOT_REACTION_TOOL_NAME,
    label: BOT_REACTION_TOOL_NAME,
    description:
      "Attach one emoji reaction badge to the user's message in this turn. Invoke this tool to react; never send an emoji-only assistant message or use reply text as a substitute. Use this proactively for clear feelings, praise, thanks, humor, achievements, or dissatisfaction with your work, in any language, even when the same message also requests a task. Match the tone: support for distress, appreciation for praise, acknowledgement for criticism. Skip neutral task-only, automated, scheduled, or internal messages. A reaction supplements your answer or work; it never replaces it. Calling again replaces the reaction.",
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
