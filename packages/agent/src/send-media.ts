/**
 * Media for the user's chat. A leaf module: the hosted app and the desktop's
 * main process read it (`@abacus-ai/agent/send-media`) without the agent
 * runtime.
 *
 * Media is named only by a media id (`media-…`): a handle the app's media
 * store gave, under the session it belongs to, to what it holds: an image (a
 * screenshot taken with secret fields hidden, or one `present_deliverable`
 * handed over) or a document `present_deliverable` handed over. The model
 * never names a path to `send_media`. Images are JPEG or PNG by their bytes
 * (WebP too, for a file handed over), at most `MEDIA_MAX_BYTES`; documents
 * carry an allowed extension, at most `DOCUMENT_MAX_BYTES`, the most the chat
 * takes.
 *
 * The tool and the app that sends read one request through `parseSendMedia`,
 * so the app never sends what the tool refused.
 */
export const SEND_MEDIA_TOOL_NAME = "send_media";

/**
 * The browser's tool that says whether its media store holds an id for the
 * calling session: the agent runtime's own, never offered to a model.
 */
export const MEDIA_CHECK_TOOL_NAME = "browser_media";

/** `browser_media`'s answer for an id the store holds. */
export const MEDIA_HELD = "held";

/** WhatsApp's limit for an image. */
export const MEDIA_MAX_BYTES = 5 * 1024 * 1024;

/** One or two lines under the picture; WhatsApp allows 1,024 characters. */
export const MAX_MEDIA_CAPTION_CHARS = 500;

/** When it goes: at once, or together with the final answer. */
export type SendMediaWhen = "now" | "with_answer";

/** WhatsApp's limit for a document. */
export const DOCUMENT_MAX_BYTES = 16 * 1024 * 1024;

/** The file types the chat takes as documents, by extension. */
export const DOCUMENT_EXTENSIONS: readonly string[] = [
  "pdf",
  "docx",
  "xlsx",
  "pptx",
  "csv",
  "txt",
  "md",
  "json",
  "zip",
  "html",
];

export type MediaMimeType = "image/jpeg" | "image/png" | "image/webp";

/** Media ready to send, or why it cannot go, in words the model can act on. */
export type ResolvedMedia =
  | { ok: true; kind: "image"; data: Buffer; mimeType: MediaMimeType }
  | { ok: true; kind: "document"; data: Buffer; filename: string }
  | { ok: false; reason: string };

export interface SendMediaRequest {
  media: string;
  caption: string;
  when: SendMediaWhen;
}

const MEDIA_ID = /^media-[0-9a-f]{16,64}$/;

export const isMediaId = (ref: string): boolean => MEDIA_ID.test(ref);

/** Marks each media id a tool result hands to the chat, one per line. */
const MEDIA_MARKER = "[media]";

export const mediaLine = (id: string): string => `${MEDIA_MARKER} ${id}`;

/** The media ids a tool result hands to the chat, in order. */
export function declaredMedia(resultText: string): string[] {
  return resultText
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith(`${MEDIA_MARKER} `))
    .map((line) => line.slice(MEDIA_MARKER.length).trim())
    .filter(isMediaId);
}

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
  return { ok: true, kind: "image", data, mimeType };
}

/** "RIFF", four bytes of size, then "WEBP". */
const isWebp = (data: Uint8Array): boolean =>
  data.length >= 12 &&
  Buffer.from(data.subarray(0, 4)).toString("latin1") === "RIFF" &&
  Buffer.from(data.subarray(8, 12)).toString("latin1") === "WEBP";

/** An image file handed over: JPEG or PNG as above, or WebP. */
export function checkedImageFile(data: Buffer): ResolvedMedia {
  if (data.length <= MEDIA_MAX_BYTES && isWebp(data))
    return { ok: true, kind: "image", data, mimeType: "image/webp" };
  return checkedImage(data);
}

/** The file's extension, lowercased, without the dot; "" for none. */
const extensionOf = (filename: string): string => {
  const dot = filename.lastIndexOf(".");
  return dot <= 0 ? "" : filename.slice(dot + 1).toLowerCase();
};

/** Spellings the chat takes under another name. */
const EXTENSION_ALIASES: Record<string, string> = { htm: "html" };

/** The bytes, checked: a document of a type and size the chat takes. */
export function checkedDocument(data: Buffer, filename: string): ResolvedMedia {
  const extension = extensionOf(filename);
  const alias = EXTENSION_ALIASES[extension];
  const name =
    alias == null
      ? filename
      : `${filename.slice(0, -extension.length)}${alias}`;
  if (!DOCUMENT_EXTENSIONS.includes(alias ?? extension))
    return {
      ok: false,
      reason:
        `The chat takes only these files as documents: ${DOCUMENT_EXTENSIONS.join(", ")}. ` +
        "Convert it to one of them (a PDF, say) and send that.",
    };
  if (data.length === 0) return { ok: false, reason: "The file is empty." };
  if (data.length > DOCUMENT_MAX_BYTES)
    return { ok: false, reason: "The file is larger than 16 MB." };
  return { ok: true, kind: "document", data, filename: name };
}
