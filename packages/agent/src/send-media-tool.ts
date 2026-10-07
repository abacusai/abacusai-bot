import {
  type PhoneToolDefinition,
  stringParam,
  toolText,
} from "./phone/phone-tool.js";
/**
 * `send_media`: an image to the user's chat, with a caption, at once or with
 * the final answer. The tool only checks the request; the app that carries
 * the chat sees the call and sends the media it names (see send-media.ts).
 * Offered only where the channel takes media.
 */
import {
  isMediaId,
  readImageFile,
  SEND_MEDIA_TOOL_NAME,
} from "./send-media.js";

/** One or two lines under the picture; WhatsApp allows 1,024 characters. */
const MAX_CAPTION_CHARS = 500;

export function buildSendMediaTool(): PhoneToolDefinition {
  return {
    name: SEND_MEDIA_TOOL_NAME,
    label: SEND_MEDIA_TOOL_NAME,
    description: [
      "Send the user an image in this chat, with a short caption in their language.",
      'media: a media id a tool gave you (browser_snapshot action:"screenshot" gives one,',
      "with secret fields already hidden) or the absolute path of a JPEG or PNG file.",
      'when: "now" (default) sends it at once while you keep working; "with_answer" sends it',
      "with your final answer, which then needs no caption of its own.",
    ].join("\n"),
    parameters: {
      type: "object",
      properties: {
        media: {
          type: "string",
          description: "A media id, or an absolute image path.",
        },
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
      const media = stringParam(params.media).trim();
      const caption = stringParam(params.caption).trim();
      const when = stringParam(params.when) || "now";
      if (when !== "now" && when !== "with_answer")
        return toolText('when is "now" or "with_answer".', true);
      if (caption.length > MAX_CAPTION_CHARS)
        return toolText(
          `The caption is too long (${caption.length} characters, at most ${MAX_CAPTION_CHARS}). Shorten it.`,
          true
        );
      if (!isMediaId(media)) {
        const file = readImageFile(media);
        if (!file.ok) return toolText(`Not sent: ${file.reason}`, true);
      }
      return toolText(when === "now" ? "Sent." : "It goes with your answer.");
    },
  };
}
