/**
 * Which browser view the tools drive. The pane is a native `WebContentsView`
 * per conversation, not a `<webview>`: the only `<webview>` tags in the app
 * are previews and charts, so the tools pick by session, never by type.
 */
import type { WebContents } from "electron";

export interface BrowserViewCandidate {
  id: number;
  url: string;
  /** The agent session whose conversation owns the view; null for a draft. */
  sessionId: string | null;
  presented: boolean;
}

export interface BrowserTargetMemory {
  id: number | null;
  /** The last URL this server navigated, used to re-find a remounted view. */
  url: string | null;
}

/** What the browser server needs from the runtime; injected for tests. */
export interface BrowserTargetSource {
  candidates(): BrowserViewCandidate[];
  webContents(id: number): WebContents | null;
  /** A hidden view for a session, or null when the desktop does not know it. */
  materialize(sessionId: string, url: string): Promise<number | null>;
}

/**
 * The id to drive, or null. A session only drives its own views, since another
 * session's page would be someone else's browser; a caller with no session id
 * (the CLI, tests) takes the view on screen.
 */
export function pickBrowserTarget(
  candidates: readonly BrowserViewCandidate[],
  memory: BrowserTargetMemory,
  sessionId?: string | null
): number | null {
  const own =
    sessionId == null
      ? candidates
      : candidates.filter((candidate) => candidate.sessionId === sessionId);

  if (own.length === 0) return null;

  if (memory.id != null) {
    const remembered = own.find((candidate) => candidate.id === memory.id);
    if (remembered != null) return remembered.id;
  }

  const presented = own.find((candidate) => candidate.presented);
  if (presented != null) return presented.id;

  if (memory.url != null && memory.url.length > 0) {
    const sameUrl = own.find((candidate) => candidate.url === memory.url);
    if (sameUrl != null) return sameUrl.id;
  }

  return own[0]!.id;
}
