/**
 * One tab in the user's Chrome, presented to the browser tools as the page
 * surface they already drive (`BrowserPage`). Everything goes over CDP through
 * the relay; the synchronous reads — URL, title, loading, history — come from
 * state kept current by the tab's own CDP events.
 */
import type { BrowserPage, DidFailLoadListener } from "../browser-target";
import type { ChromeRelay, ChromeTabInfo } from "./chrome-relay";

const HISTORY_TIMEOUT_MS = 5_000;

export class ChromePage implements BrowserPage {
  readonly id: number;
  private url: string;
  private title: string;
  private loading = false;
  private destroyed = false;
  private history = { index: 0, length: 1 };
  private readonly failListeners = new Set<DidFailLoadListener>();
  private enabled: Promise<void> | null = null;

  constructor(
    private readonly relay: ChromeRelay,
    tab: ChromeTabInfo
  ) {
    this.id = tab.id;
    this.url = tab.url ?? "about:blank";
    this.title = tab.title ?? "";
  }

  /** The tab's CDP events, routed here by whoever owns the relay. */
  onCdpEvent(method: string, params: unknown): void {
    const p = (params ?? {}) as Record<string, unknown>;
    switch (method) {
      case "Page.frameStartedLoading":
        if (this.isMainFrame(p)) this.loading = true;
        return;
      case "Page.frameStoppedLoading":
      case "Page.loadEventFired":
        if (method === "Page.loadEventFired" || this.isMainFrame(p)) {
          this.loading = false;
          void this.refreshTitle();
          void this.refreshHistory();
        }
        return;
      case "Page.frameNavigated": {
        const frame = p.frame as
          | { parentId?: string; url?: string; id?: string }
          | undefined;
        if (frame?.parentId == null && typeof frame?.url === "string") {
          this.url = frame.url;
          this.mainFrameId = frame.id ?? this.mainFrameId;
          void this.refreshTitle();
          void this.refreshHistory();
        }
        return;
      }
      default:
        return;
    }
  }

  private mainFrameId: string | null = null;

  private isMainFrame(params: Record<string, unknown>): boolean {
    const frameId = params.frameId;
    return (
      this.mainFrameId == null ||
      typeof frameId !== "string" ||
      frameId === this.mainFrameId
    );
  }

  /** The tab closed under us or the debugger let go. */
  markDestroyed(): void {
    this.destroyed = true;
  }

  isDestroyed(): boolean {
    return this.destroyed || !this.relay.isAttached(this.id);
  }

  getURL(): string {
    return this.url;
  }

  getTitle(): string {
    return this.title;
  }

  isLoading(): boolean {
    return this.loading;
  }

  canGoBack(): boolean {
    return this.history.index > 0;
  }

  canGoForward(): boolean {
    return this.history.index < this.history.length - 1;
  }

  focus(): void {
    // Input events reach a tab whether or not it is on screen; nothing to do.
  }

  on(_event: "did-fail-load", listener: DidFailLoadListener): void {
    this.failListeners.add(listener);
  }

  off(_event: "did-fail-load", listener: DidFailLoadListener): void {
    this.failListeners.delete(listener);
  }

  readonly debugger = {
    isAttached: (): boolean => this.relay.isAttached(this.id),
    attach: (): void => {
      // Attached by the relay when the tab joined; nothing to do here.
    },
    sendCommand: (
      method: string,
      commandParams?: Record<string, unknown>
    ): Promise<unknown> => this.relay.cdp(this.id, method, commandParams),
  };

  /** Page and Runtime domains on, once, so the events above arrive. */
  private ensureEnabled(): Promise<void> {
    this.enabled ??= (async () => {
      await this.relay.cdp(this.id, "Page.enable");
      await this.relay.cdp(this.id, "Runtime.enable").catch(() => undefined);
      const tree = (await this.relay
        .cdp(this.id, "Page.getFrameTree")
        .catch(() => null)) as {
        frameTree?: { frame?: { id?: string; url?: string } };
      } | null;
      const frame = tree?.frameTree?.frame;
      if (frame?.id != null) this.mainFrameId = frame.id;
      if (typeof frame?.url === "string" && frame.url.length > 0)
        this.url = frame.url;
      await this.refreshTitle();
      await this.refreshHistory();
    })();
    return this.enabled;
  }

  private async refreshTitle(): Promise<void> {
    try {
      const result = (await this.relay.cdp(this.id, "Runtime.evaluate", {
        expression: "document.title",
        returnByValue: true,
      })) as { result?: { value?: unknown } };
      if (typeof result.result?.value === "string")
        this.title = result.result.value;
    } catch {
      // A page mid-navigation has no document to ask.
    }
  }

  private async refreshHistory(): Promise<void> {
    try {
      const result = (await this.relay.cdp(
        this.id,
        "Page.getNavigationHistory"
      )) as { currentIndex?: number; entries?: unknown[] };
      if (
        typeof result.currentIndex === "number" &&
        Array.isArray(result.entries)
      )
        this.history = {
          index: result.currentIndex,
          length: result.entries.length,
        };
    } catch {
      // Left as it was.
    }
  }

  async loadURL(url: string): Promise<void> {
    await this.ensureEnabled();
    this.loading = true;
    const result = (await this.relay.cdp(this.id, "Page.navigate", {
      url,
    })) as {
      errorText?: string;
      frameId?: string;
    };
    if (result.frameId != null) this.mainFrameId = result.frameId;
    if (result.errorText != null && result.errorText.length > 0) {
      // Chromium's error page is served at the URL that failed, as the
      // built-in view reports it: the listeners hear the failure, the URL
      // reads as the target.
      this.url = url;
      this.loading = false;
      for (const listener of this.failListeners)
        listener({}, -2, result.errorText, url, true);
      throw new Error(result.errorText);
    }
  }

  goBack(): void {
    void this.historyStep(-1);
  }

  goForward(): void {
    void this.historyStep(1);
  }

  reload(): void {
    void this.ensureEnabled()
      .then(() => {
        this.loading = true;
        return this.relay.cdp(this.id, "Page.reload");
      })
      .catch(() => undefined);
  }

  private async historyStep(delta: number): Promise<void> {
    try {
      await this.ensureEnabled();
      const history = (await this.relay.cdp(
        this.id,
        "Page.getNavigationHistory"
      )) as { currentIndex: number; entries: Array<{ id: number }> };
      const entry = history.entries[history.currentIndex + delta];
      if (entry == null) return;
      this.loading = true;
      await Promise.race([
        this.relay.cdp(this.id, "Page.navigateToHistoryEntry", {
          entryId: entry.id,
        }),
        new Promise((resolve) => setTimeout(resolve, HISTORY_TIMEOUT_MS)),
      ]);
    } catch {
      this.loading = false;
    }
  }

  async capturePage(): Promise<{
    toJPEG: (quality: number) => Buffer;
    toPNG: () => Buffer;
  }> {
    await this.ensureEnabled();
    const shot = (await this.relay.cdp(this.id, "Page.captureScreenshot", {
      format: "jpeg",
      quality: 70,
    })) as { data?: string };
    const jpeg = Buffer.from(shot.data ?? "", "base64");
    return {
      toJPEG: () => jpeg,
      // The tools take JPEG first; a PNG is only asked for when that is empty.
      toPNG: () => Buffer.alloc(0),
    };
  }

  /** Wire the domains up before the first tool call, so events already flow. */
  prime(): Promise<void> {
    return this.ensureEnabled();
  }
}
