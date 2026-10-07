/**
 * The one owner of a CDP-driven browser's tabs (the hosted Chromium, or the
 * user's Chrome over the relay): which session owns each tab, which tab each
 * session drives now (its active tab), which tab opened which, and each tab's
 * secret fields.
 *
 * A session acts the way a person would see it:
 * - A tab one of its tabs opens (`window.open`, a `target=_blank` link, a
 *   `noopener` link the browser still names the opening frame for) is the
 *   session's and becomes active. A tab opened from a tab no session owns
 *   stays unowned.
 * - A new tab the browser names no opener for at all is taken as an action's
 *   (a click, key, pick or select) only when exactly one session acted within
 *   `ADOPT_WINDOW_MS` before it; otherwise it stays unowned. The residual
 *   risk: an unrelated opener-less tab (one the user opened by hand) that
 *   appears right after a single session's action is taken by that session.
 * - The tab that opened it stays open as it was, no longer driven. When the
 *   active tab closes, the tab that opened it is active again.
 * - At most `MAX_TABS_PER_SESSION`: past that, the oldest tab that is neither
 *   active nor on the active tab's opener chain is let go.
 * - When the session ends its tabs are kept `SESSION_TABS_KEPT_MS`, so a run
 *   that paused (or whose agent restarted) finds its page again, then let go.
 * - Let go means closed in a browser the app owns (`ownsTabs`) and only
 *   detached in the user's own Chrome. A tab no session claims is let go
 *   after `UNCLAIMED_TAB_GRACE_MS`.
 */
import type { BrowserPage, BrowserTab } from "../browser-target";
import { type CapturedImage, SecretFields } from "../secret-fields";
import type { ChromeTabDriver, ChromeTabInfo } from "./chrome-relay";

export const MAX_TABS_PER_SESSION = 6;
/** How soon after an action an opener-less new tab is taken as the action's. */
export const ADOPT_WINDOW_MS = 3_000;
/** How long an ended session's tabs are kept for it to come back to. */
export const SESSION_TABS_KEPT_MS = 60 * 60_000;
/** How long a tab no session claimed stays before it is let go. */
export const UNCLAIMED_TAB_GRACE_MS = 10_000;

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
  /** When each session last acted in a way that may open a tab. */
  private readonly actions = new Map<string, number>();
  /** The `create` calls in flight. */
  private readonly creating = new Set<Promise<ChromeTabInfo>>();
  /** Opener-less tabs that attached while a `create` ran, any of which may be its own. */
  private held: Array<{ tabId: number; at: number }> = [];
  /** Ended sessions whose tabs are being kept, with the timer that lets them go. */
  private readonly ended = new Map<string, ReturnType<typeof setTimeout>>();
  /** Unclaimed tabs, with the timer that lets each go. */
  private readonly unclaimed = new Map<number, ReturnType<typeof setTimeout>>();
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
      for (const tabId of Array.from(this.unclaimed.keys())) this.forget(tabId);
      for (const timer of this.ended.values()) clearTimeout(timer);
      this.ended.clear();
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

  /**
   * A new tab of the session's own, active from the start. Only the tab this
   * returns is skipped by the attach logic; any other that attaches meanwhile
   * is decided once the creates in flight are done.
   */
  async create(sessionId: string, url: string): Promise<ChromeTabInfo> {
    this.noteUse(sessionId);
    const making = this.driver.createTab(url);
    this.creating.add(making);
    try {
      const tab = await making;
      this.join(tab.id, sessionId, null);
      return tab;
    } finally {
      this.creating.delete(making);
      if (this.creating.size === 0)
        for (const { tabId, at } of this.held.splice(0)) this.adopt(tabId, at);
    }
  }

  /** The session acted on its page in a way that may open a tab. */
  noteAction(sessionId: string): void {
    this.noteUse(sessionId);
    this.actions.set(sessionId, this.now());
  }

  /** The session drives its page: tabs kept since it ended are its again. */
  noteUse(sessionId: string): void {
    const timer = this.ended.get(sessionId);
    if (timer == null) return;
    clearTimeout(timer);
    this.ended.delete(sessionId);
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
    this.noteUse(sessionId);
    this.active.set(sessionId, tabId);
    await this.driver.activateTab?.(tabId).catch(() => undefined);
    return true;
  }

  /** Closes one of the session's tabs, as it asked; false when it has no such tab. */
  async close(sessionId: string, tabId: number): Promise<boolean> {
    if (this.records.get(tabId)?.owner !== sessionId) return false;
    this.noteUse(sessionId);
    await this.driver.closeTab(tabId);
    // The driver's own report may come later; the session moves on now.
    this.forget(tabId);
    return true;
  }

  /**
   * The session ended (or its agent stopped): its tabs stay its own for
   * `SESSION_TABS_KEPT_MS`, then are let go unless it came back.
   */
  releaseSession(sessionId: string): void {
    this.actions.delete(sessionId);
    if (this.ended.has(sessionId) || this.ownedBy(sessionId).length === 0)
      return;
    const timer = setTimeout(() => {
      this.ended.delete(sessionId);
      for (const tabId of this.ownedBy(sessionId))
        void this.letGo(tabId).catch(() => undefined);
    }, SESSION_TABS_KEPT_MS);
    timer.unref?.();
    this.ended.set(sessionId, timer);
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
      const frame = findFrame(
        (await this.frameTree(tabId)) ?? undefined,
        frameId
      )?.frame;
      return frame == null ? null : this.frameNodeOrigin(tabId, frame);
    }
    return this.liveOrigin(tabId);
  }

  /**
   * The origin of the tab's document, or of one of its attached cross-origin
   * frames, evaluated in that document now: never a remembered URL, so it is
   * the one to decide what a value may be typed into. Null when it cannot be
   * asked (a frame the driver cannot reach, a failed evaluation) or is
   * opaque, and the caller refuses.
   */
  async liveOrigin(tabId: number, frameId?: string): Promise<string | null> {
    if (!this.driver.isAttached(tabId)) return null;
    if (frameId == null)
      return locationOrigin(
        this.driver.cdp(tabId, "Runtime.evaluate", {
          expression: "location.origin",
          returnByValue: true,
        })
      );
    if (
      this.driver.frameCdp == null ||
      !(this.driver.childFrames?.(tabId) ?? []).includes(frameId)
    )
      return null;
    return locationOrigin(
      this.driver.frameCdp(tabId, frameId, "Runtime.evaluate", {
        expression: "location.origin",
        returnByValue: true,
      })
    );
  }

  /**
   * The tab's cross-origin frames the driver attached whose owner is in the
   * tab's own page, with their origins as last reported.
   */
  frames(tabId: number): Array<{ frameId: string; origin: string | null }> {
    if (!this.driver.isAttached(tabId)) return [];
    return (this.driver.childFrames?.(tabId) ?? []).map((frameId) => ({
      frameId,
      origin: this.driver.frameOrigin?.(tabId, frameId) ?? null,
    }));
  }

  /** A CDP command in one of those frames' own session. */
  frameCdp(
    tabId: number,
    frameId: string,
    method: string,
    params?: Record<string, unknown>
  ): Promise<unknown> {
    if (this.driver.frameCdp == null)
      return Promise.reject(new Error("this browser cannot reach frames"));
    return this.driver.frameCdp(tabId, frameId, method, params);
  }

  /** The tab's secret fields; null for a tab this class does not hold. */
  secrets(tabId: number): SecretFields | null {
    return this.records.get(tabId)?.secrets ?? null;
  }

  /**
   * The tab's page as a screenshot, with its secret fields hidden and every
   * frame whose live origin is not the tab's covered: the one screenshot
   * path, through the page's `secrets`. Null, with nothing captured, when
   * either cannot be done.
   */
  async captureMasked(
    tabId: number,
    secrets: SecretFields
  ): Promise<CapturedImage | null> {
    const page = this.options.page(tabId);
    if (page == null) return null;
    const foreign = await this.foreignFrames(tabId);
    if (foreign == null) return null;
    return secrets.captureMasked(page, foreign);
  }

  /**
   * The outermost frames whose live origin is not the tab's (a frame inside
   * one is covered with it), by id; null when the tab's frames are unknown.
   */
  private async foreignFrames(tabId: number): Promise<string[] | null> {
    const top = await this.origin(tabId);
    const tree = await this.frameTree(tabId);
    if (tree == null) return null;
    const differs = (origin: string | null): boolean =>
      top == null || origin == null || origin !== top;
    const foreign: string[] = [];
    const seen = new Set<string>([tree.frame.id]);
    const visit = (node: FrameTree, inForeign: boolean): void => {
      for (const child of node.childFrames ?? []) {
        seen.add(child.frame.id);
        const outer =
          !inForeign && differs(this.frameNodeOrigin(tabId, child.frame));
        if (outer) foreign.push(child.frame.id);
        visit(child, inForeign || outer);
      }
    };
    visit(tree, false);
    // Out-of-process frames the page's own tree may not list.
    for (const frameId of this.driver.childFrames?.(tabId) ?? [])
      if (
        !seen.has(frameId) &&
        differs(this.driver.frameOrigin?.(tabId, frameId) ?? null)
      )
        foreign.push(frameId);
    return foreign;
  }

  private async frameTree(tabId: number): Promise<FrameTree | null> {
    const tree = (await this.driver
      .cdp(tabId, "Page.getFrameTree")
      .catch(() => null)) as { frameTree?: FrameTree } | null;
    return tree?.frameTree ?? null;
  }

  /** A frame's live origin: the driver's for one it attached, else the frame tree's. */
  private frameNodeOrigin(
    tabId: number,
    frame: FrameTree["frame"]
  ): string | null {
    return (
      this.driver.frameOrigin?.(tabId, frame.id) ??
      originOf(frame.securityOrigin || frame.url || "")
    );
  }

  private onAttached(tab: ChromeTabInfo): void {
    if (this.records.has(tab.id)) return;
    if (tab.openerTabId != null || tab.hasOpener === true) {
      // The browser named an opener: its owner's, or nobody's.
      const opener =
        tab.openerTabId == null ? null : this.records.get(tab.openerTabId);
      if (opener != null) this.join(tab.id, opener.owner, tab.openerTabId!);
      else this.leaveUnclaimed(tab.id);
      return;
    }
    // No opener at all: it may be the tab a `create` in flight is making.
    if (this.creating.size > 0)
      this.held.push({ tabId: tab.id, at: this.now() });
    else this.adopt(tab.id, this.now());
  }

  /** An opener-less tab that attached `at`: the one session that just acted takes it. */
  private adopt(tabId: number, at: number): void {
    if (this.records.has(tabId) || !this.driver.isAttached(tabId)) return;
    const acted = [...this.actions]
      .filter(([, when]) => when <= at && at - when <= ADOPT_WINDOW_MS)
      .map(([sessionId]) => sessionId);
    if (acted.length !== 1) {
      this.leaveUnclaimed(tabId);
      return;
    }
    const claimant = acted[0]!;
    // One action, one tab.
    this.actions.delete(claimant);
    this.join(tabId, claimant, this.active.get(claimant) ?? null);
  }

  /** A tab no session owns: let go after a grace, unless it was there before the app was. */
  private leaveUnclaimed(tabId: number): void {
    if (this.driver.tab(tabId)?.preexisting === true) return;
    if (this.unclaimed.has(tabId)) return;
    const timer = setTimeout(() => {
      this.unclaimed.delete(tabId);
      if (!this.records.has(tabId) && this.driver.isAttached(tabId))
        void this.letGo(tabId).catch(() => undefined);
    }, UNCLAIMED_TAB_GRACE_MS);
    timer.unref?.();
    this.unclaimed.set(tabId, timer);
  }

  /** Closes the tab in a browser the app owns; elsewhere stops driving it and leaves it open. */
  private async letGo(tabId: number): Promise<void> {
    try {
      if (this.driver.ownsTabs) await this.driver.closeTab(tabId);
      else await this.driver.detachTab?.(tabId);
    } finally {
      // No longer any session's, whatever the browser made of it.
      this.forget(tabId);
    }
  }

  private ownedBy(sessionId: string): number[] {
    return [...this.records]
      .filter(([, record]) => record.owner === sessionId)
      .map(([tabId]) => tabId);
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
    if (oldest != null) void this.letGo(oldest[0]).catch(() => undefined);
  }

  private forget(tabId: number): void {
    const timer = this.unclaimed.get(tabId);
    if (timer != null) {
      clearTimeout(timer);
      this.unclaimed.delete(tabId);
    }
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
  frame: { id: string; url?: string; securityOrigin?: string };
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

/** What a `location.origin` evaluation answered, or null for none or an opaque origin. */
const locationOrigin = async (
  evaluation: Promise<unknown>
): Promise<string | null> => {
  const evaluated = (await evaluation.catch(() => null)) as {
    result?: { value?: unknown };
  } | null;
  const origin = evaluated?.result?.value;
  return typeof origin === "string" && origin !== "null" ? origin : null;
};

const originOf = (url: string): string | null => {
  try {
    const origin = new URL(url).origin;
    return origin === "null" ? null : origin;
  } catch {
    return null;
  }
};
