/**
 * Deploying a site the agent built: the chat's latest site (stamped by main
 * when a turn closes) and the project zip main makes of it for Abacus AI
 * Agent on the web, which hosts and deploys it.
 */
import { type KeepKind, keepThingKey } from "./success-pitch";

/**
 * A session's latest finished turn that left something to keep on: a site
 * (also when `kind` is absent, as older builds wrote it), a server or bot
 * started in the background, or a routine. `siteDir` is its folder, null
 * when unknown or for a routine; `name` is what the card calls it.
 */
export interface SiteReadyMark {
  turnId: string;
  siteDir: string | null;
  at: number;
  kind?: KeepKind;
  name?: string | null;
}

/** The mark's kind; a mark from before kinds is a site. */
export const markKind = (mark: SiteReadyMark): KeepKind => mark.kind ?? "site";

/** What a closed card remembers: the thing, so it never comes back for it. */
export const markThing = (mark: SiteReadyMark): string =>
  keepThingKey(markKind(mark), mark.siteDir ?? mark.name);

/** The card for `mark` was closed: older builds kept its turn, newer ones its thing. */
export const markClosed = (
  closed: string | undefined,
  mark: SiteReadyMark
): boolean => closed === mark.turnId || closed === markThing(mark);

/** Sessions whose latest site is kept: the newest, by `at`. */
export const SITE_READY_KEEP = 10;

/** What a project zip may hold; the web agent's upload takes 50 MB. */
export const SITE_ZIP_LIMITS = {
  zipBytes: 50 * 1024 * 1024,
  totalBytes: 200 * 1024 * 1024,
  files: 5_000,
  fileBytes: 25 * 1024 * 1024,
} as const;

/** The conversation, inside the zip, for the web agent to read. */
export const SITE_ZIP_CONVERSATION = "abacusai-bot-conversation.md";

export type SitePack =
  | {
      state: "ready";
      /** The zip on disk. */
      path: string;
      /** The project folder's own name. */
      name: string;
      files: number;
      /** The zip's size. */
      bytes: number;
      /** Folders and files never sent (node_modules, .git, …), by name. */
      leftOut: string[];
      /** Files held back because they may hold keys, relative to the folder. */
      heldBack: string[];
    }
  | { state: "too-big"; name: string }
  /** The site is not in a folder of its own (a workspace root, the home folder). */
  | { state: "too-broad" }
  /** The chat has no site, or its folder is gone. */
  | { state: "none" }
  | { state: "cancelled" }
  | { state: "failed" };

export interface SitePackProgress {
  files: number;
  bytes: number;
}

/** The latest marks, newest first, at most SITE_READY_KEEP of them. */
export const keepSiteMarks = (
  marks: Record<string, SiteReadyMark>
): Record<string, SiteReadyMark> =>
  Object.fromEntries(
    Object.entries(marks)
      .sort(([, a], [, b]) => b.at - a.at)
      .slice(0, SITE_READY_KEEP)
  );
