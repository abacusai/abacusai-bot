/**
 * The user's Chrome as the browser tools' target source: each agent session
 * gets a tab of its own in the app's tab group, created on first use; the tab
 * the user picked when allowing the connection serves callers with no session.
 */
import type {
  BrowserTargetSource,
  BrowserViewCandidate,
} from "../browser-target";
import { ChromePage } from "./chrome-page";
import type { ChromeRelay } from "./chrome-relay";

export class ChromeTargetSource implements BrowserTargetSource {
  readonly presentsInApp = false;
  private readonly pages = new Map<number, ChromePage>();
  /** Which session opened which tab; a tab nobody opened belongs to no session. */
  private readonly owners = new Map<number, string>();

  constructor(private readonly relay: ChromeRelay) {
    relay.on("cdpEvent", (tabId, method, params) => {
      this.pages.get(tabId)?.onCdpEvent(method, params);
    });
    relay.on("tabDetached", (tabId) => this.forget(tabId));
    relay.on("tabRemoved", (tabId) => this.forget(tabId));
    relay.on("disconnected", () => {
      for (const tabId of Array.from(this.pages.keys())) this.forget(tabId);
    });
  }

  private forget(tabId: number): void {
    this.pages.get(tabId)?.markDestroyed();
    this.pages.delete(tabId);
    this.owners.delete(tabId);
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
    return this.relay.attachedTabs().map((tab) => ({
      id: tab.id,
      url: this.pages.get(tab.id)?.getURL() ?? tab.url ?? "",
      sessionId: this.owners.get(tab.id) ?? null,
      presented: tab.active === true,
    }));
  }

  webContents(id: number): ChromePage | null {
    return this.pageFor(id);
  }

  async materialize(sessionId: string, url: string): Promise<number | null> {
    if (!this.relay.connected) return null;
    const tab = await this.relay.createTab(url);
    this.owners.set(tab.id, sessionId);
    const page = this.pageFor(tab.id);
    await page?.prime();
    return tab.id;
  }

  /** Tabs a session opened, for closing when it ends. */
  tabsOf(sessionId: string): number[] {
    return [...this.owners]
      .filter(([, owner]) => owner === sessionId)
      .map(([tabId]) => tabId);
  }
}
