/**
 * Recovers the absolute `@`-mentions the composer appends per attachment, and
 * the text without them, so the bubble can show pills instead. Display only;
 * the message the agent got is untouched.
 */
import type { UserFileAttachment } from "../components/chat/render-utils";

const ABS_REF_RE = /(^|\s)@(\/[^\s]*\/([^\s/]+))/g;

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"]);

const isImageName = (fileName: string): boolean => {
  const dot = fileName.lastIndexOf(".");
  return dot >= 0 && IMAGE_EXTS.has(fileName.slice(dot + 1).toLowerCase());
};

export const extractUserFileRefs = (
  text: string
): { files: UserFileAttachment[]; text: string } => {
  const files: UserFileAttachment[] = [];
  for (const match of text.matchAll(ABS_REF_RE)) {
    const absPath = match[2];
    const fileName = match[3];
    if (absPath == null || fileName == null || isImageName(fileName)) continue;
    files.push({ fileName, absPath });
  }
  const stripped = text
    .replace(ABS_REF_RE, "$1")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { files, text: stripped };
};
