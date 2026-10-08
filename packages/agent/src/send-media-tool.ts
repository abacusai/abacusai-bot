/**
 * `send_media`: an image or file the app holds for this session, to the user's chat,
 * with a caption, at once or with the final answer. The tool only checks the
 * request; the app that carries the chat sees the call, checks it the same
 * way (`parseSendMedia`) and sends the media it names. Offered only where
 * the channel takes media.
 */
import { type PhoneToolDefinition, toolText } from "./phone/phone-tool.js";
import {
  MEDIA_HELD,
  parseSendMedia,
  SEND_MEDIA_TOOL_NAME,
} from "./send-media.js";

/** Ids a ledger remembers; each media id lives 30 minutes anyway. */
const MAX_LEDGER_IDS = 1_000;

/**
 * The media ids one browser run asked to send, so the run sends each once and
 * its result can name them to the loop. Only the app that carries the chat
 * knows what reached the user: it sends an id once, after the server took it.
 */
export class DeliveredMedia {
  private readonly ids = new Set<string>();

  has(id: string): boolean {
    return this.ids.has(id);
  }

  add(id: string): void {
    this.ids.delete(id);
    this.ids.add(id);
    if (this.ids.size > MAX_LEDGER_IDS)
      this.ids.delete(this.ids.values().next().value!);
  }

  /** Every id, oldest first. */
  list(): string[] {
    return [...this.ids];
  }
}

/**
 * Whether the app holds `media` for this session: false when it says it does
 * not, true when it does or cannot be asked (the app's own check at send time
 * still stands).
 */
export type MediaCheck = (media: string) => Promise<boolean>;

/** A `MediaCheck` over the browser's `browser_media` tool, as `mcpToolCaller` calls it. */
export function mediaCheckFrom(
  call: (
    args: Record<string, unknown>
  ) => Promise<{ text: string; isError: boolean } | null>
): MediaCheck {
  return async (media) => {
    const answer = await call({ media });
    return answer == null || answer.isError || answer.text === MEDIA_HELD;
  };
}

const NOT_HELD =
  "Not sent: unknown or expired media id; take a new screenshot.";

/**
 * `sent`: a browser run's ledger; the loop's own tool has none. `held`: asked
 * before the tool says an image went, so a made-up or expired id is refused
 * in the same turn.
 */
export function buildSendMediaTool(
  sent?: DeliveredMedia,
  held?: MediaCheck
): PhoneToolDefinition {
  return {
    name: SEND_MEDIA_TOOL_NAME,
    label: SEND_MEDIA_TOOL_NAME,
    description: [
      "Send the user an image or file in this chat, with a short caption in their language.",
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
          description: "One or two lines shown under it.",
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
      if (sent?.has(parsed.request.media) === true)
        return toolText("This run already sent it; not sent again.");
      if (held != null && !(await held(parsed.request.media)))
        return toolText(NOT_HELD, true);
      sent?.add(parsed.request.media);
      return toolText(
        parsed.request.when === "now" ? "Sent." : "It goes with your answer."
      );
    },
  };
}
