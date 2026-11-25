/**
 * What the old UI derives from a user message's text before showing it
 * (`renderer/components/chat/injected-text.ts`,
 * `renderer/conversation/{user-file-refs,temp-image-refs}.ts`), as pure
 * functions both the v1 mapper (which tags migrated messages with the result)
 * and the chat kit (which renders them) can share. The stored text is never
 * changed: these are display derivations.
 */

export {
  hasSystemReminder,
  isRoutineFire,
  isHiddenUserText,
  legacyOperator,
  USER_TEXT_INLINE_MAX,
  visibleUserText,
} from "@abacus-ai/agent/user-text";

/**
 * The name a long text gets when it goes in as a file (a composer paste, a
 * long feedback note): the chat draws such a file as "Pasted text" titled
 * by its first line, and the model reads it.
 */
export const pastedTextName = (id: string): string => `pasted-text-${id}.txt`;

/** A file saved from pasted text, by its name or path. */
export const isPastedText = (pathOrName: string): boolean =>
  /^pasted-text-[\w-]+\.txt$/.test(pathOrName.split(/[\\/]/).at(-1) ?? "");

/** A paste's chip title: its first line with text, whitespace folded. */
export const pastedTextTitle = (head: string): string =>
  head
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .find((line) => line !== "")
    ?.slice(0, 120) ?? "";

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
