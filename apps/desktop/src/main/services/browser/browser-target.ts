/**
 * Which browser view the tools drive. The pane is a native `WebContentsView`
 * per conversation, not a `<webview>`: the only `<webview>` tags in the app
 * are previews and charts, so the tools pick by session, never by type.
 */
export type DidFailLoadListener = (
  event: unknown,
  errorCode: number,
  errorDescription: string,
  validatedURL: string,
  isMainFrame: boolean
) => void;

/**
 * The page the browser tools drive: the slice of Electron's `WebContents`
 * they use, so that a tab in the user's own Chrome (services/browser/chrome)
 * can stand in for the built-in view without the tools knowing which it is.
 */
export interface BrowserPage {
  readonly id: number;
  isDestroyed(): boolean;
  getURL(): string;
  getTitle(): string;
  isLoading(): boolean;
  loadURL(url: string): Promise<void>;
  canGoBack(): boolean;
  canGoForward(): boolean;
  goBack(): void;
  goForward(): void;
  reload(): void;
  focus(): void;
  on(event: "did-fail-load", listener: DidFailLoadListener): unknown;
  off(event: "did-fail-load", listener: DidFailLoadListener): unknown;
  capturePage(
    rect?: undefined,
    options?: { stayHidden?: boolean }
  ): Promise<{ toJPEG?: (quality: number) => Buffer; toPNG: () => Buffer }>;
  readonly debugger: {
    isAttached(): boolean;
    attach(protocolVersion?: string): void;
    sendCommand(
      method: string,
      commandParams?: Record<string, unknown>
    ): Promise<unknown>;
  };
}

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
  webContents(id: number): BrowserPage | null;
  /** A hidden view for a session, or null when the desktop does not know it. */
  materialize(sessionId: string, url: string): Promise<number | null>;
  /**
   * False when the pages live outside this app (the user's own Chrome): the
   * renderer then has no pane to open and no cursor to animate.
   */
  presentsInApp?: boolean;
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
