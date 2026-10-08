/**
 * A CDP-driven browser's tabs (the user's Chrome over the relay, or the
 * hosted Chromium) as the browser tools' target source. It keeps the page
 * over each tab; `BrowserTabs` decides whose each tab is and which one each
 * session drives. The tab the user picked when allowing the connection
 * belongs to no session and serves callers with none.
 */
import {
  framePageOf,
  type BrowserFrame,
  type BrowserPage,
  type BrowserTab,
  type BrowserTargetSource,
  type BrowserViewCandidate,
} from "../browser-target";
import type { CapturedImage, SecretFields } from "../secret-fields";
import { BrowserTabs } from "./browser-tabs";
import { ChromePage } from "./chrome-page";
import type { ChromeTabDriver } from "./chrome-relay";

export class ChromeTargetSource implements BrowserTargetSource {
  readonly presentsInApp = false;
  private readonly pages = new Map<number, ChromePage>();
  readonly tabs: BrowserTabs;

  constructor(
    private readonly relay: ChromeTabDriver,
    options: { now?: () => number } = {}
  ) {
    relay.on("cdpEvent", (tabId, method, params) => {
      this.pages.get(tabId)?.onCdpEvent(method, params);
    });
    relay.on("tabDetached", (tabId) => this.forget(tabId));
    relay.on("tabRemoved", (tabId) => this.forget(tabId));
    relay.on("disconnected", () => {
      for (const tabId of Array.from(this.pages.keys())) this.forget(tabId);
    });
    this.tabs = new BrowserTabs(relay, {
      page: (tabId) => this.pageFor(tabId),
      ...options,
    });
  }

  private forget(tabId: number): void {
    this.pages.get(tabId)?.markDestroyed();
    this.pages.delete(tabId);
  }

  private pageFor(tabId: number): ChromePage | null {
    const tab = this.relay.tab(tabId);
    if (tab == null || !this.relay.isAttached(tabId)) return null;
    let page = this.pages.get(tabId);
    if (page == null) {
      page = new ChromePage(this.relay, tab);
      this.pages.set(tabId, page);
      void page.prime().catch(() => undefined);
    }
    return page;
  }

  candidates(): BrowserViewCandidate[] {
    return this.relay.attachedTabs().map((tab) => {
      const owner = this.tabs.ownerOf(tab.id);
      return {
        id: tab.id,
        url: this.pages.get(tab.id)?.getURL() ?? tab.url ?? "",
        sessionId: owner,
        presented: tab.active === true,
        ...(owner != null && this.tabs.activeTab(owner) === tab.id
          ? { current: true }
          : {}),
      };
    });
  }

  webContents(id: number): ChromePage | null {
    return this.pageFor(id);
  }

  async materialize(
    sessionId: string,
    url: string,
    options: { isolated?: boolean } = {}
  ): Promise<number | null> {
    if (!this.relay.connected) return null;
    const tab = await this.tabs.create(sessionId, url, options);
    const page = this.pageFor(tab.id);
    await page?.prime();
    return tab.id;
  }

  sessionTabs(sessionId: string): BrowserTab[] {
    return this.tabs.tabs(sessionId);
  }

  activateTab(sessionId: string, tabId: number): Promise<boolean> {
    return this.tabs.activate(sessionId, tabId);
  }

  closeTab(sessionId: string, tabId: number): Promise<boolean> {
    return this.tabs.close(sessionId, tabId);
  }

  releaseSession(sessionId: string): void {
    this.tabs.releaseSession(sessionId);
  }

  noteAction(sessionId: string): void {
    this.tabs.noteAction(sessionId);
  }

  noteUse(sessionId: string): void {
    this.tabs.noteUse(sessionId);
  }

  secrets(id: number): SecretFields | null {
    return this.tabs.secrets(id);
  }

  captureMasked(
    id: number,
    secrets: SecretFields
  ): Promise<CapturedImage | null> {
    return this.tabs.captureMasked(id, secrets);
  }

  liveOrigin(id: number, frameId?: string): Promise<string | null> {
    return this.tabs.liveOrigin(id, frameId);
  }

  frames(id: number): BrowserFrame[] {
    return this.tabs.frames(id);
  }

  framePage(id: number, frameId: string): BrowserPage | null {
    const page = this.pageFor(id);
    if (page == null || !this.frames(id).some((f) => f.frameId === frameId))
      return null;
    return framePageOf(page, frameId, (method, params) =>
      this.tabs.frameCdp(id, frameId, method, params)
    );
  }
}

/**
 * The tab methods of whichever source is current, for a service whose source
 * comes and goes with the browser connection.
 */
export const tabMethodsOf = (
  source: () => ChromeTargetSource | null
): Pick<
  Required<BrowserTargetSource>,
  | "sessionTabs"
  | "activateTab"
  | "closeTab"
  | "releaseSession"
  | "noteAction"
  | "noteUse"
  | "secrets"
  | "captureMasked"
  | "liveOrigin"
  | "frames"
  | "framePage"
> => ({
  sessionTabs: (sessionId) => source()?.sessionTabs(sessionId) ?? [],
  activateTab: async (sessionId, tabId) =>
    (await source()?.activateTab(sessionId, tabId)) ?? false,
  closeTab: async (sessionId, tabId) =>
    (await source()?.closeTab(sessionId, tabId)) ?? false,
  releaseSession: (sessionId) => source()?.releaseSession(sessionId),
  noteAction: (sessionId) => source()?.noteAction(sessionId),
  noteUse: (sessionId) => source()?.noteUse(sessionId),
  secrets: (id) => source()?.secrets(id) ?? null,
  captureMasked: async (id, secrets) =>
    (await source()?.captureMasked(id, secrets)) ?? null,
  liveOrigin: async (id, frameId) =>
    (await source()?.liveOrigin(id, frameId)) ?? null,
  frames: (id) => source()?.frames(id) ?? [],
  framePage: (id, frameId) => source()?.framePage(id, frameId) ?? null,
});
