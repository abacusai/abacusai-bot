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

/** A page the `artifact` tool made: it runs live, so it shares live. */
export const isArtifactPage = (path: string): boolean =>
  /[\\/]artifacts[\\/][^\\/]+[\\/]index\.html$/.test(path);

/** A web page shares live, as the app shows it: scripts, buttons and the files beside it come along. */
export const isLivePage = (path: string): boolean =>
  ["html", "htm"].includes(shareExtension(path));

export const ARTIFACT_ACCESS = ["private", "public"] as const;
export type ArtifactAccess = (typeof ARTIFACT_ACCESS)[number];

export type ArtifactPublished =
  | {
      ok: true;
      url: string;
      access: ArtifactAccess;
      updated: boolean;
      /** The page's key: the same file publishes to, and stops, this link. */
      identifier: string;
    }
  | { ok: false; code: ShareRefusal };

/** A web page as its live link will show it, files beside it folded in. */
export type PagePreview =
  | { ok: true; document: string }
  | { ok: false; code: ShareRefusal };

/** A page shared live, as the platform lists it. */
export interface LivePage {
  identifier: string;
  title: string;
  url: string;
  access: ArtifactAccess;
  updatedAt: string;
}

/** Where Share was opened: a files card row, the chat's header, or the card under a reply. */
export const SHARE_ENTRIES = ["row", "header", "card"] as const;
export type ShareEntry = (typeof SHARE_ENTRIES)[number];

/**
 * The one file a chat offers to share, from its files oldest first: the
 * latest artifact page, else the latest html page, else the latest document
 * or image. A page is what people most often want to send.
 */
export const preferredShare = (paths: readonly string[]): string | null => {
  const shareable = paths.filter(isShareableFile);
  return (
    shareable.findLast(isArtifactPage) ??
    shareable.findLast((path) =>
      ["html", "htm"].includes(shareExtension(path))
    ) ??
    shareable.at(-1) ??
    null
  );
};

/**
 * The "Send it to anyone" card under a reply that made something shareable
 * (prefs `dismissals.shareOffer`). Once per chat: a chat it showed in never
 * gets it again.
 */
export interface ShareOfferCard {
  /** The reply it last showed under (its message id), and where it was. */
  shownOffer: string | null;
  shownThread: string | null;
  /** The reply whose card was answered (Get a link, Not now, or a link made). */
  answered: string | null;
  /** Chats it has shown in, newest last. */
  threads: string[];
}

export const EMPTY_SHARE_OFFER_CARD: ShareOfferCard = {
  shownOffer: null,
  shownThread: null,
  answered: null,
  threads: [],
};

/** Chats remembered; an older one could show it again, which is harmless. */
export const SHARE_OFFER_KEPT_THREADS = 100;

/** Whether the card may show under the reply `offerId` of `threadId`. */
export const shareOfferAllowed = (
  card: ShareOfferCard | null | undefined,
  offer: { id: string; threadId: string }
): boolean =>
  card == null ||
  (card.shownOffer === offer.id
    ? card.answered !== offer.id
    : !card.threads.includes(offer.threadId));

/** The card's chats with `threadId` added, newest last. */
export const shareOfferThreads = (
  card: ShareOfferCard,
  threadId: string
): string[] =>
  [...card.threads.filter((id) => id !== threadId), threadId].slice(
    -SHARE_OFFER_KEPT_THREADS
  );
