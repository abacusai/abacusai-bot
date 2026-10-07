/**
 * `send_media`: an image the app holds for this session, to the user's chat,
 * with a caption, at once or with the final answer. The tool only checks the
 * request; the app that carries the chat sees the call, checks it the same
 * way (`parseSendMedia`) and sends the media it names. Offered only where
 * the channel takes media.
 */
import { type PhoneToolDefinition, toolText } from "./phone/phone-tool.js";
import { parseSendMedia, SEND_MEDIA_TOOL_NAME } from "./send-media.js";

export function buildSendMediaTool(): PhoneToolDefinition {
  return {
    name: SEND_MEDIA_TOOL_NAME,
    label: SEND_MEDIA_TOOL_NAME,
    description: [
      "Send the user an image in this chat, with a short caption in their language.",
      'media: a media id a tool gave you; browser_snapshot action:"screenshot" gives one, with',
      "secret fields already hidden.",
      'when: "now" (default) sends it at once while you keep working; "with_answer" sends it',
      "with your final answer, which then needs no caption of its own.",
    ].join("\n"),
    parameters: {
      type: "object",
      properties: {
        media: { type: "string", description: "A media id." },
        caption: {
          type: "string",
          description: "One or two lines shown under the image.",
        },
        when: {
          type: "string",
          enum: ["now", "with_answer"],
          description: "now (default) or with_answer",
        },
      },
      required: ["media"],
      additionalProperties: false,
    },
    execute: async (_toolCallId, params) => {
      const parsed = parseSendMedia(params);
      if (parsed.ok === false)
        return toolText(`Not sent: ${parsed.reason}`, true);
      return toolText(
        parsed.request.when === "now" ? "Sent." : "It goes with your answer."
      );
    },
  };
}
