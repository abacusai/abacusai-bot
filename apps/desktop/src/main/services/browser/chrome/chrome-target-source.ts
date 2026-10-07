/**
 * A CDP-driven browser's tabs (the user's Chrome over the relay, or the
 * hosted Chromium) as the browser tools' target source. It keeps the page
 * over each tab; `BrowserTabs` decides whose each tab is and which one each
 * session drives. The tab the user picked when allowing the connection
 * belongs to no session and serves callers with none.
 */
import type {
  BrowserTab,
  BrowserTargetSource,
  BrowserViewCandidate,
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

  async materialize(sessionId: string, url: string): Promise<number | null> {
    if (!this.relay.connected) return null;
    const tab = await this.tabs.create(sessionId, url);
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

  closeSession(sessionId: string): Promise<void> {
    return this.tabs.closeSession(sessionId);
  }

  noteClick(sessionId: string): void {
    this.tabs.noteClick(sessionId);
  }

  secrets(id: number): SecretFields | null {
    return this.tabs.secrets(id);
  }

  captureMasked(id: number): Promise<CapturedImage | null> {
    return this.tabs.captureMasked(id);
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
  | "closeSession"
  | "noteClick"
  | "secrets"
  | "captureMasked"
> => ({
  sessionTabs: (sessionId) => source()?.sessionTabs(sessionId) ?? [],
  activateTab: async (sessionId, tabId) =>
    (await source()?.activateTab(sessionId, tabId)) ?? false,
  closeTab: async (sessionId, tabId) =>
    (await source()?.closeTab(sessionId, tabId)) ?? false,
  closeSession: async (sessionId) => {
    await source()?.closeSession(sessionId);
  },
  noteClick: (sessionId) => source()?.noteClick(sessionId),
  secrets: (id) => source()?.secrets(id) ?? null,
  captureMasked: async (id) => (await source()?.captureMasked(id)) ?? null,
});
