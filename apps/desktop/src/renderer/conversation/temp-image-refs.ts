/**
 * Recovers image attachments from a user message's text: the composer's
 * absolute `@`-mentions are the only durable record, so thumbnails are
 * re-derived at render time and nothing extra survives hydration.
 */
import type { UserImageAttachment } from "../components/chat/render-utils";

// Absolute @-mentions: a pasted image saved under .abacusai-bot/temp/, or a
// picked one referenced where it lives (`@/Users/.../photo.png`).
const ABS_TEMP_REF_RE = /@(\/[^\s]*\/([^\s/]+))/g;

const IMAGE_EXT_TO_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  svg: "image/svg+xml",
};

const mimeFromName = (fileName: string): string | null => {
  const dot = fileName.lastIndexOf(".");
  if (dot < 0) return null;
  const ext = fileName.slice(dot + 1).toLowerCase();
  return IMAGE_EXT_TO_MIME[ext] ?? null;
};

export const extractTempImageRefs = (text: string): UserImageAttachment[] => {
  const out: UserImageAttachment[] = [];
  for (const match of text.matchAll(ABS_TEMP_REF_RE)) {
    const absPath = match[1];
    const fileName = match[2];
    if (absPath == null || fileName == null) continue;
    const mimeType = mimeFromName(fileName);
    if (mimeType == null) continue;
    // hostRoot is the temp dir, which the read-image containment check needs.
    const lastSlash = absPath.lastIndexOf("/");
    const hostRoot = lastSlash > 0 ? absPath.slice(0, lastSlash) : absPath;
    out.push({ fileName, absPath, hostRoot, mimeType });
  }
  return out;
};
