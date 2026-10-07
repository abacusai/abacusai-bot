/**
 * Which browser view the tools drive. The pane is a native `WebContentsView`
 * per conversation, not a `<webview>`: the only `<webview>` tags in the app
 * are previews and charts, so the tools pick by session, never by type.
 */
import type { CapturedImage, SecretFields } from "./secret-fields";

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
  /**
   * Set on a page that is one cross-origin frame of tab `id` (see
   * `framePageOf`): commands go to that frame's own document.
   */
  readonly frameId?: string;
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
  /**
   * The source's word that this is the session's active tab (say, one its
   * page just opened); it wins over the remembered one. Only sources that
   * keep several tabs per session set it.
   */
  current?: boolean;
}

/** One of a session's tabs, as the tools describe it to the model. */
export interface BrowserTab {
  id: number;
  url: string;
  title: string;
  /** The session's active tab: the one its tools drive. */
  current: boolean;
  /** The session's tab that opened this one, or null. */
  openerId: number | null;
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
  /**
   * Sources that keep several tabs per session (`BrowserTabs`) offer these;
   * the built-in view has one page per conversation and none of them.
   */
  sessionTabs?(sessionId: string): BrowserTab[];
  activateTab?(sessionId: string, tabId: number): Promise<boolean>;
  closeTab?(sessionId: string, tabId: number): Promise<boolean>;
  /** The session ended: the tabs it owns are kept a while for it, then let go. */
  releaseSession?(sessionId: string): void;
  /** The session acted (click, key, pick, select); a tab opening right after may be the act's. */
  noteAction?(sessionId: string): void;
  /** The session drives its page: it is alive, and its kept tabs are its again. */
  noteUse?(sessionId: string): void;
  /** The page's secret fields, where the source keeps them per tab. */
  secrets?(id: number): SecretFields | null;
  /** The page through its `secrets`, with foreign frames covered; see `SecretFields.captureMasked`. */
  captureMasked?(
    id: number,
    secrets: SecretFields
  ): Promise<CapturedImage | null>;
  /**
   * The origin of the tab's document, or of one of its cross-origin frames,
   * evaluated in that document now (never a remembered URL). Null when it
   * cannot be asked or is opaque; a vault fill then refuses.
   */
  liveOrigin?(id: number, frameId?: string): Promise<string | null>;
  /** The tab's cross-origin frames this source can drive, outermost first. */
  frames?(id: number): BrowserFrame[];
  /** One of those frames as a page of its own, or null when it is gone. */
  framePage?(id: number, frameId: string): BrowserPage | null;
}

/** A cross-origin frame of a tab that the tools can read and type into. */
export interface BrowserFrame {
  frameId: string;
  /** Its origin as last reported; `origin()` asks for the live one. */
  origin: string | null;
}

/**
 * Frame `frameId` of `page` as a page of its own: its commands go to the
 * frame's document through `send`; everything else is the tab's.
 */
export function framePageOf(
  page: BrowserPage,
  frameId: string,
  send: (method: string, params?: Record<string, unknown>) => Promise<unknown>
): BrowserPage {
  return {
    id: page.id,
    frameId,
    isDestroyed: () => page.isDestroyed(),
    getURL: () => page.getURL(),
    getTitle: () => page.getTitle(),
    isLoading: () => page.isLoading(),
    loadURL: (url) => page.loadURL(url),
    canGoBack: () => page.canGoBack(),
    canGoForward: () => page.canGoForward(),
    goBack: () => page.goBack(),
    goForward: () => page.goForward(),
    reload: () => page.reload(),
    focus: () => page.focus(),
    on: (event, listener) => page.on(event, listener),
    off: (event, listener) => page.off(event, listener),
    capturePage: () =>
      Promise.reject(new Error("a frame is captured with its tab")),
    debugger: {
      isAttached: () => true,
      attach: () => undefined,
      sendCommand: send,
    },
  };
}

/**
 * The id to drive, or null. A session only drives its own views, since another
 * session's page would be someone else's browser; a caller with no session id
 * (tests, for one) takes the view on screen.
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

  const current = own.find((candidate) => candidate.current === true);
  if (current != null) return current.id;

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
