/**
 * Media for the user's chat. A leaf module: the hosted app and the desktop's
 * main process read it (`@abacus-ai/agent/send-media`) without the agent
 * runtime.
 *
 * Media is named only by a media id (`media-…`): a handle the app's media
 * store gave, under the session it belongs to, to an image it holds (a
 * screenshot taken with secret fields hidden). Nothing else on the computer
 * can be named, so nothing else can reach the chat. Only JPEG and PNG, by
 * their bytes, and at most `MEDIA_MAX_BYTES`, the most a chat takes.
 *
 * The tool and the app that sends read one request through `parseSendMedia`,
 * so the app never sends what the tool refused.
 */
export const SEND_MEDIA_TOOL_NAME = "send_media";

/** WhatsApp's limit for an image. */
export const MEDIA_MAX_BYTES = 5 * 1024 * 1024;

/** One or two lines under the picture; WhatsApp allows 1,024 characters. */
export const MAX_MEDIA_CAPTION_CHARS = 500;

/** When it goes: at once, or together with the final answer. */
export type SendMediaWhen = "now" | "with_answer";

export type MediaMimeType = "image/jpeg" | "image/png";

/** An image ready to send, or why it cannot go, in words the model can act on. */
export type ResolvedMedia =
  | { ok: true; data: Buffer; mimeType: MediaMimeType }
  | { ok: false; reason: string };

export interface SendMediaRequest {
  media: string;
  caption: string;
  when: SendMediaWhen;
}

const MEDIA_ID = /^media-[0-9a-f]{16,64}$/;

export const isMediaId = (ref: string): boolean => MEDIA_ID.test(ref);

/** A `send_media` call's input as a request, or why it is refused. */
export function parseSendMedia(
  input: Record<string, unknown>
): { ok: true; request: SendMediaRequest } | { ok: false; reason: string } {
  const media = typeof input.media === "string" ? input.media.trim() : "";
  const caption = typeof input.caption === "string" ? input.caption.trim() : "";
  const when = input.when ?? "now";
  if (!isMediaId(media))
    return {
      ok: false,
      reason:
        'media must be a media id a tool gave you (browser_snapshot action:"screenshot" gives one).',
    };
  if (when !== "now" && when !== "with_answer")
    return { ok: false, reason: 'when is "now" or "with_answer".' };
  if (caption.length > MAX_MEDIA_CAPTION_CHARS)
    return {
      ok: false,
      reason: `The caption is too long (${caption.length} characters, at most ${MAX_MEDIA_CAPTION_CHARS}). Shorten it.`,
    };
  return { ok: true, request: { media, caption, when } };
}

const SIGNATURES: Array<{ mimeType: MediaMimeType; bytes: number[] }> = [
  { mimeType: "image/jpeg", bytes: [0xff, 0xd8, 0xff] },
  { mimeType: "image/png", bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a] },
];

/** JPEG or PNG by its first bytes; null for anything else. */
function imageMimeType(data: Uint8Array): MediaMimeType | null {
  return (
    SIGNATURES.find(({ bytes }) =>
      bytes.every((byte, index) => data[index] === byte)
    )?.mimeType ?? null
  );
}

/** The bytes, checked: an image of a kind and size a chat takes. */
export function checkedImage(data: Buffer): ResolvedMedia {
  if (data.length > MEDIA_MAX_BYTES)
    return { ok: false, reason: "The image is larger than 5 MB." };
  const mimeType = imageMimeType(data);
  if (mimeType == null)
    return { ok: false, reason: "The data is not a JPEG or PNG image." };
  return { ok: true, data, mimeType };
}
