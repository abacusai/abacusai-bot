/**
 * What the old UI derives from a user message's text before showing it
 * (`renderer/components/chat/injected-text.ts`,
 * `renderer/conversation/{user-file-refs,temp-image-refs}.ts`), as pure
 * functions both the v1 mapper (which tags migrated messages with the result)
 * and the chat kit (which renders them) can share. The stored text is never
 * changed: these are display derivations.
 */

const SYSTEM_REMINDER = /<system_reminder>[\s\S]*?<\/system_reminder>/g;

/** The scheduler's envelope. Its whole message is machine text. */
const ROUTINE_FIRE = /^\[routine\] "/;

/** Absolute `@`-mentions the composer appends per attachment (non-image). */
const FILE_REF = /(^|\s)@(\/[^\s]*\/([^\s/]+))/g;

/** Absolute `@`-mentions of images (pasted into temp, or picked). */
const IMAGE_REF = /@(\/[^\s]*\/([^\s/]+))/g;

const IMAGE_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  svg: "image/svg+xml",
};

const imageMime = (fileName: string): string | undefined => {
  const dot = fileName.lastIndexOf(".");
  return dot < 0
    ? undefined
    : IMAGE_MIME[fileName.slice(dot + 1).toLowerCase()];
};

export interface AttachmentRef {
  /** The absolute path as written after `@`. */
  path: string;
  name: string;
  /** Set for an image (rendered as a thumbnail rather than a pill). */
  mimeType?: string;
}

/** Whether the text holds a `<system_reminder>` block. */
export const hasSystemReminder = (text: string): boolean =>
  text.search(SYSTEM_REMINDER) >= 0;

/** The user's own words, or "" when the message was entirely the app's. */
export const visibleUserText = (text: string): string => {
  const withoutReminders = text.replaceAll(SYSTEM_REMINDER, "").trim();
  if (ROUTINE_FIRE.test(withoutReminders)) return "";
  return withoutReminders;
};

/** A routine firing: the message is hidden entirely in the old UI. */
export const isRoutineFire = (text: string): boolean =>
  ROUTINE_FIRE.test(text.replaceAll(SYSTEM_REMINDER, "").trim());

/** The attachments the old UI rebuilds as pills and thumbnails. */
export const attachmentRefs = (text: string): AttachmentRef[] => {
  const refs: AttachmentRef[] = [];
  for (const match of text.matchAll(FILE_REF)) {
    const [, , path, name] = match;
    if (path === undefined || name === undefined || imageMime(name)) continue;
    refs.push({ path, name });
  }
  for (const match of text.matchAll(IMAGE_REF)) {
    const [, path, name] = match;
    const mimeType = name === undefined ? undefined : imageMime(name);
    if (path === undefined || name === undefined || mimeType === undefined)
      continue;
    refs.push({ path, name, mimeType });
  }
  return refs;
};

/** The text without its attachment mentions, as the bubble shows it. */
export const stripAttachmentRefs = (text: string): string =>
  text
    .replace(FILE_REF, "$1")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
