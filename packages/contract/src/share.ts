/**
 * Share on the files card: a public link to one file the bot made. The
 * platform renders the file to a static page once and keeps it; this app only
 * sends the file after the user saw the page, and can take it down again.
 */

/** Rendered to a page. Anything else (folders, sites, code, slides) has no link. */
export const SHAREABLE_EXTENSIONS = [
  "md",
  "markdown",
  "txt",
  "docx",
  "html",
  "htm",
  "png",
  "jpg",
  "jpeg",
  "webp",
  "gif",
  "pdf",
] as const;

/** Sent as text, so keys are taken out here before the file leaves. */
export const SHARE_TEXT_EXTENSIONS = ["md", "markdown", "txt", "html", "htm"];

/** The platform's limit for one share. */
export const SHARE_MAX_BYTES = 5 * 1024 * 1024;

/** Why a share did not happen; each has its own words in the dialog. */
export const SHARE_REFUSALS = [
  "TOO_LARGE",
  "TOO_MANY",
  "RATE_LIMITED",
  /** Keys or passwords in the file, or a local path in a PDF, which cannot be masked. */
  "SENSITIVE",
  "UNSUPPORTED",
  "FAILED",
] as const;
export type ShareRefusal = (typeof SHARE_REFUSALS)[number];

export interface SharedLink {
  shareId: string;
  url: string;
  title: string;
  /** Hash of the local path: the same file finds its link again. */
  sourceKey: string;
  createdAt: string;
  /** Ends after 90 days without a view. */
  canExpire: boolean;
}

export type SharePreview =
  | {
      ok: true;
      title: string;
      /** The page exactly as it would go public. */
      document: string;
      /** This file's link, when it already has one. */
      existing: SharedLink | null;
    }
  | { ok: false; code: ShareRefusal };

export type ShareCreated =
  | { ok: true; link: SharedLink }
  | { ok: false; code: ShareRefusal };

export const shareExtension = (path: string): string => {
  const name = path.split(/[\\/]/).pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
};

export const isShareableFile = (path: string): boolean =>
  (SHAREABLE_EXTENSIONS as readonly string[]).includes(shareExtension(path));
