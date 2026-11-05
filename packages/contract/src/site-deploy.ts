/**
 * Deploying a site the agent built: the chat's latest site (stamped by main
 * when a turn closes) and the project zip main makes of it for Abacus AI
 * Agent on the web, which hosts and deploys it.
 */

/** A session's latest finished turn that built a site; `siteDir` null when its folder is unknown. */
export interface SiteReadyMark {
  turnId: string;
  siteDir: string | null;
  at: number;
}

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
