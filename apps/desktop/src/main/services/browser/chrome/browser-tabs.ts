/**
 * The one owner of a CDP-driven browser's tabs (the hosted Chromium, or the
 * user's Chrome over the relay): which session owns each tab, which tab each
 * session drives now (its active tab), which tab opened which, and each tab's
 * secret fields.
 *
 * A session acts the way a person would see it:
 * - A tab one of its tabs opens (`window.open`, a `target=_blank` link) is
 *   the session's and becomes active. A new tab the browser names no opener
 *   for, opened within `ADOPT_WINDOW_MS` of the session's click, is taken as
 *   the click's.
 * - The tab that opened it stays open as it was, no longer driven. When the
 *   active tab closes, the tab that opened it is active again.
 * - At most `MAX_TABS_PER_SESSION`: past that, the oldest tab that is neither
 *   active nor on the active tab's opener chain closes.
 * - The session's tabs close when the session ends.
 */
import type { BrowserPage, BrowserTab } from "../browser-target";
import { type CapturedImage, SecretFields } from "../secret-fields";
import type { ChromeTabDriver, ChromeTabInfo } from "./chrome-relay";

export const MAX_TABS_PER_SESSION = 6;
/** How soon after a click an opener-less new tab is taken as the click's. */
export const ADOPT_WINDOW_MS = 3_000;

interface TabRecord {
  owner: string;
  openerId: number | null;
  joinedAt: number;
  secrets: SecretFields;
}

export interface BrowserTabsOptions {
  /** The page over a tab, for capture; owned by the target source. */
  page: (tabId: number) => BrowserPage | null;
  now?: () => number;
}

export class BrowserTabs {
  private readonly records = new Map<number, TabRecord>();
  private readonly active = new Map<string, number>();
  private readonly clicks = new Map<string, number>();
  /** Tabs being made by `create`: their attach is not a popup. */
  private creating = 0;
  private joined = 0;

  constructor(
    private readonly driver: ChromeTabDriver,
    private readonly options: BrowserTabsOptions
  ) {
    driver.on("tabAttached", (tab) => this.onAttached(tab));
    driver.on("tabDetached", (tabId) => this.forget(tabId));
    driver.on("tabRemoved", (tabId) => this.forget(tabId));
    driver.on("disconnected", () => {
      for (const tabId of Array.from(this.records.keys())) this.forget(tabId);
    });
    driver.on("cdpEvent", (tabId, method, params) => {
      // A new document in the main frame: its filled fields went with the old one.
      if (
        method === "Page.frameNavigated" &&
        (params as { frame?: { parentId?: string } } | null)?.frame?.parentId ==
          null
      )
        this.records.get(tabId)?.secrets.navigated();
    });
  }

  /** A new tab of the session's own, active from the start. */
  async create(sessionId: string, url: string): Promise<ChromeTabInfo> {
    this.creating += 1;
    let tab: ChromeTabInfo;
    try {
      tab = await this.driver.createTab(url);
    } finally {
      this.creating -= 1;
    }
    this.join(tab.id, sessionId, null);
    return tab;
  }

  /** The session acted on its page; a tab opening right after is the act's. */
  noteClick(sessionId: string): void {
    this.clicks.set(sessionId, this.now());
  }

  ownerOf(tabId: number): string | null {
    return this.records.get(tabId)?.owner ?? null;
  }

  activeTab(sessionId: string): number | null {
    return this.active.get(sessionId) ?? null;
  }

  /** The session's tabs in the order they joined it, the active one marked. */
  tabs(sessionId: string): BrowserTab[] {
    const active = this.active.get(sessionId);
    return [...this.records]
      .filter(([, record]) => record.owner === sessionId)
      .sort(([, a], [, b]) => a.joinedAt - b.joinedAt)
      .flatMap(([tabId, record]) => {
        const tab = this.driver.tab(tabId);
        if (tab == null || !this.driver.isAttached(tabId)) return [];
        const page = this.options.page(tabId);
        return [
          {
            id: tabId,
            url: page?.getURL() || tab.url || "",
            title: page?.getTitle() || tab.title || "",
            current: tabId === active,
            openerId: record.openerId,
          },
        ];
      });
  }

  /** Makes one of the session's tabs the one it drives; false when it has no such tab. */
  async activate(sessionId: string, tabId: number): Promise<boolean> {
    if (this.records.get(tabId)?.owner !== sessionId) return false;
    this.active.set(sessionId, tabId);
    await this.driver.activateTab?.(tabId).catch(() => undefined);
    return true;
  }

  /** Closes one of the session's tabs; false when it has no such tab. */
  async close(sessionId: string, tabId: number): Promise<boolean> {
    if (this.records.get(tabId)?.owner !== sessionId) return false;
    await this.driver.closeTab(tabId);
    // The driver's own report may come later; the session moves on now.
    this.forget(tabId);
    return true;
  }

  /** The session ended: every tab it owns closes. */
  async closeSession(sessionId: string): Promise<void> {
    const owned = [...this.records]
      .filter(([, record]) => record.owner === sessionId)
      .map(([tabId]) => tabId);
    await Promise.all(owned.map((tabId) => this.close(sessionId, tabId)));
    this.clicks.delete(sessionId);
  }

  /**
   * The live origin of the tab's page, or of one of its frames: asked of the
   * browser now, never remembered. Null when it has none (an opaque origin).
   */
  async origin(tabId: number, frameId?: string): Promise<string | null> {
    if (!this.driver.isAttached(tabId)) return null;
    if (frameId != null) {
      const attached = this.driver.frameOrigin?.(tabId, frameId);
      if (attached != null) return attached;
      const tree = (await this.driver
        .cdp(tabId, "Page.getFrameTree")
        .catch(() => null)) as { frameTree?: FrameTree } | null;
      const url = findFrame(tree?.frameTree, frameId)?.frame.url;
      return url == null ? null : originOf(url);
    }
    const evaluated = (await this.driver
      .cdp(tabId, "Runtime.evaluate", {
        expression: "location.origin",
        returnByValue: true,
      })
      .catch(() => null)) as { result?: { value?: unknown } } | null;
    const origin = evaluated?.result?.value;
    return typeof origin === "string" && origin !== "null" ? origin : null;
  }

  /** The tab's secret fields; null for a tab this class does not hold. */
  secrets(tabId: number): SecretFields | null {
    return this.records.get(tabId)?.secrets ?? null;
  }

  /** The tab's page with its secret fields hidden: the one screenshot path. */
  async captureMasked(tabId: number): Promise<CapturedImage | null> {
    const page = this.options.page(tabId);
    if (page == null) return null;
    return (this.secrets(tabId) ?? new SecretFields()).captureMasked(page);
  }

  private onAttached(tab: ChromeTabInfo): void {
    if (this.records.has(tab.id) || this.creating > 0) return;
    const opener =
      tab.openerTabId == null ? null : this.records.get(tab.openerTabId);
    if (opener != null) {
      this.join(tab.id, opener.owner, tab.openerTabId ?? null);
      return;
    }
    // No opener we know: the newest click within the window claims it.
    const now = this.now();
    let claimant: string | null = null;
    let latest = -Infinity;
    for (const [sessionId, at] of this.clicks)
      if (now - at <= ADOPT_WINDOW_MS && at > latest) {
        claimant = sessionId;
        latest = at;
      }
    if (claimant == null) return;
    this.join(tab.id, claimant, this.active.get(claimant) ?? null);
  }

  private join(tabId: number, owner: string, openerId: number | null): void {
    this.records.set(tabId, {
      owner,
      openerId,
      joinedAt: (this.joined += 1),
      secrets: new SecretFields(),
    });
    this.active.set(owner, tabId);
    void this.driver.activateTab?.(tabId).catch(() => undefined);
    // Its page and domains on now, so the page's own load is seen from the start.
    this.options.page(tabId);
    this.enforceCap(owner);
  }

  /** Past the cap, the oldest tab off the active tab's opener chain closes. */
  private enforceCap(owner: string): void {
    const owned = [...this.records]
      .filter(([, record]) => record.owner === owner)
      .sort(([, a], [, b]) => a.joinedAt - b.joinedAt);
    if (owned.length <= MAX_TABS_PER_SESSION) return;
    const chain = new Set<number>();
    for (
      let tabId: number | null = this.active.get(owner) ?? null;
      tabId != null && !chain.has(tabId);
      tabId = this.records.get(tabId)?.openerId ?? null
    )
      chain.add(tabId);
    const oldest = owned.find(([tabId]) => !chain.has(tabId));
    if (oldest != null)
      void this.close(owner, oldest[0]).catch(() => undefined);
  }

  private forget(tabId: number): void {
    const record = this.records.get(tabId);
    if (record == null) return;
    this.records.delete(tabId);
    // A tab it opened now counts as opened by its own opener.
    for (const other of this.records.values())
      if (other.openerId === tabId) other.openerId = record.openerId;
    if (this.active.get(record.owner) !== tabId) return;
    const back =
      record.openerId != null &&
      this.records.get(record.openerId)?.owner === record.owner
        ? record.openerId
        : this.newestOf(record.owner);
    if (back == null) this.active.delete(record.owner);
    else {
      this.active.set(record.owner, back);
      void this.driver.activateTab?.(back).catch(() => undefined);
    }
  }

  private newestOf(owner: string): number | null {
    let newest: [number, TabRecord] | null = null;
    for (const entry of this.records)
      if (
        entry[1].owner === owner &&
        entry[1].joinedAt > (newest?.[1].joinedAt ?? -1)
      )
        newest = entry;
    return newest?.[0] ?? null;
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }
}

interface FrameTree {
  frame: { id: string; url?: string };
  childFrames?: FrameTree[];
}

const findFrame = (
  tree: FrameTree | undefined,
  frameId: string
): FrameTree | null => {
  if (tree == null) return null;
  if (tree.frame.id === frameId) return tree;
  for (const child of tree.childFrames ?? []) {
    const found = findFrame(child, frameId);
    if (found != null) return found;
  }
  return null;
};

const originOf = (url: string): string | null => {
  try {
    const origin = new URL(url).origin;
    return origin === "null" ? null : origin;
  } catch {
    return null;
  }
};
