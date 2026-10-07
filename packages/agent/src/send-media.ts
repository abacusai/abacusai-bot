/**
 * Media for the user's chat: an image (and its caption) a tool or the run
 * produced. A leaf module: the hosted app and the desktop's main process read
 * it (`@abacus-ai/agent/send-media`) without the agent runtime.
 *
 * Media is named by a media id (`media-…`, a handle the app's media store
 * gave a screenshot) or by the absolute path of an image file. Only JPEG and
 * PNG, by their bytes, and at most `MEDIA_MAX_BYTES`, the most a chat takes.
 */
import { readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";

export const SEND_MEDIA_TOOL_NAME = "send_media";

/** WhatsApp's limit for an image. */
export const MEDIA_MAX_BYTES = 5 * 1024 * 1024;

/** When it goes: at once, or together with the final answer. */
export type SendMediaWhen = "now" | "with_answer";

export type MediaMimeType = "image/jpeg" | "image/png";

/** An image ready to send, or why it cannot go, in words the model can act on. */
export type ResolvedMedia =
  | { ok: true; data: Buffer; mimeType: MediaMimeType }
  | { ok: false; reason: string };

const MEDIA_ID = /^media-[0-9a-f]{16,64}$/;

export const isMediaId = (ref: string): boolean => MEDIA_ID.test(ref);

const SIGNATURES: Array<{ mimeType: MediaMimeType; bytes: number[] }> = [
  { mimeType: "image/jpeg", bytes: [0xff, 0xd8, 0xff] },
  { mimeType: "image/png", bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a] },
];

/** JPEG or PNG by its first bytes; null for anything else. */
export function imageMimeType(data: Uint8Array): MediaMimeType | null {
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
    return { ok: false, reason: "The file is not a JPEG or PNG image." };
  return { ok: true, data, mimeType };
}

/** The JPEG or PNG at an absolute path; nothing else on the computer goes out. */
export function readImageFile(file: string): ResolvedMedia {
  if (!isAbsolute(file))
    return {
      ok: false,
      reason: "Give a media id or the absolute path of an image file.",
    };
  try {
    const stat = statSync(file);
    if (!stat.isFile())
      return { ok: false, reason: "That path is not a file." };
    // Checked before the read, so a huge file is never loaded.
    if (stat.size > MEDIA_MAX_BYTES)
      return { ok: false, reason: "The image is larger than 5 MB." };
    return checkedImage(readFileSync(file));
  } catch {
    return { ok: false, reason: "There is no readable file at that path." };
  }
}
