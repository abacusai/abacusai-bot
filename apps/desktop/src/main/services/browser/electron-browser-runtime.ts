import {
  BaseWindow,
  session,
  WebContentsView,
  type BrowserWindow,
  type Rectangle,
  type WebContents,
} from "electron";

import { IpcChannels } from "#shared/channels";
import type {
  BrowserRuntimeBounds,
  BrowserRuntimeCapture,
  BrowserRuntimeLease as BrowserRuntimeLeaseContract,
  BrowserRuntimeState,
  HideBrowserRuntimeRequest,
  IpcEvent,
  MaterializeBrowserRuntimeRequest,
  NavigateBrowserRuntimeRequest,
  PresentBrowserRuntimeRequest,
  PromoteBrowserRuntimeScopeRequest,
} from "#shared/contracts";
import {
  AGENT_BROWSER_RESOURCE_ID,
  conversationRefFromKey,
  sessionConversationKey,
  type ConversationKey,
} from "#shared/conversation-scope";

import {
  BrowserRuntimeRegistry,
  browserResourceId,
  type BrowserRuntimeLease,
} from "./browser-runtime-registry";

type MaterializeOptions = { profileId?: string };
type CrashRecovery = {
  attempts: number;
  windowStartedAt: number;
  timer: ReturnType<typeof setTimeout> | null;
};

const DEFAULT_PARTITION = "persist:browser-runtime";

const runtimeMapKey = (
  conversationKey: ConversationKey,
  resourceId: string
): string => JSON.stringify([conversationKey, resourceId]);

const importedProfilePartition = (profileId: string): string =>
  `persist:bp-${profileId.replace(/[^a-zA-Z0-9_-]/g, "_")}`;

/**
 * The pane presents as plain Chrome: bot walls read the `abacusai-bot/` and
 * `Electron/` UA tokens and answer with an HTTP/2 RST_STREAM. Dropping the
 * tokens leaves Chromium's own UA for the real platform, so it still agrees
 * with the client hints sent beside it.
 */
const plainChromeUserAgent = (userAgent: string): string =>
  userAgent.replace(/\S+\/\S+ (?=Chrome\/)/, "").replace(/ Electron\/\S+/, "");

const checkedUrl = (value?: string): string => {
  if (value == null || value.trim().length === 0) return "about:blank";
  const url = new URL(value);
  if (
    url.protocol !== "http:" &&
    url.protocol !== "https:" &&
    !(url.protocol === "about:" && url.href === "about:blank")
  ) {
    throw new TypeError(`Unsupported browser URL protocol: ${url.protocol}`);
  }
  return url.href;
};

const checkedConversationKey = (value: ConversationKey): ConversationKey => {
  if (conversationRefFromKey(value) == null) {
    throw new TypeError("Invalid conversation key");
  }
  return value;
};

const checkedProfileId = (value?: string): string | undefined => {
  if (value == null) return undefined;
  const normalized = value.trim();
  if (normalized.length === 0) throw new TypeError("profileId cannot be empty");
  return normalized;
};

const checkedBounds = (
  bounds: BrowserRuntimeBounds,
  contentBounds: Rectangle
): Rectangle => {
  for (const [name, value] of Object.entries(bounds)) {
    if (!Number.isFinite(value)) {
      throw new TypeError(`Browser bounds ${name} must be finite`);
    }
  }
  if (bounds.width <= 0 || bounds.height <= 0) {
    throw new TypeError("Browser bounds must have positive width and height");
  }

  const x = Math.max(
    0,
    Math.min(Math.round(bounds.x), Math.max(0, contentBounds.width - 1))
  );
  const y = Math.max(
    0,
    Math.min(Math.round(bounds.y), Math.max(0, contentBounds.height - 1))
  );
  return {
    x,
    y,
    width: Math.max(
      1,
      Math.min(Math.round(bounds.width), contentBounds.width - x)
    ),
    height: Math.max(
      1,
      Math.min(Math.round(bounds.height), contentBounds.height - y)
    ),
  };
};

const contractLease = (
  lease: BrowserRuntimeLease
): BrowserRuntimeLeaseContract => ({
  conversationKey: lease.conversationKey,
  resourceId: lease.resourceId,
  generation: lease.generation,
});

const registryLease = (
  lease: BrowserRuntimeLeaseContract
): BrowserRuntimeLease => ({
  conversationKey: checkedConversationKey(lease.conversationKey),
  resourceId: browserResourceId(lease.resourceId),
  generation: lease.generation as BrowserRuntimeLease["generation"],
});

export type BrowserRuntimeWindow = Pick<
  BrowserWindow,
  "contentView" | "getContentBounds" | "isDestroyed" | "webContents"
>;

/** The viewport a parked view lays out against: a common laptop window. */
const PARKED_BOUNDS = { x: 0, y: 0, width: 1280, height: 900 };

export class ElectronBrowserRuntime {
  private readonly attached = new WeakSet<WebContentsView>();
  /** Views parked in the hidden host window. */
  private readonly parked = new WeakSet<WebContentsView>();
  private parkingWindow: BaseWindow | null = null;

  /**
   * A hidden window hosting views nobody is looking at. A view attached
   * nowhere has a 0×0 viewport: phone layout, lazy lists that never load, an
   * empty snapshot. Created on first use; tests without BaseWindow just hide.
   */
  private parkingHost(): BaseWindow | null {
    if (typeof BaseWindow !== "function") return null;
    if (this.parkingWindow != null && !this.parkingWindow.isDestroyed())
      return this.parkingWindow;
    try {
      this.parkingWindow = new BaseWindow({
        show: false,
        width: PARKED_BOUNDS.width,
        height: PARKED_BOUNDS.height,
        skipTaskbar: true,
        focusable: false,
      });
    } catch {
      this.parkingWindow = null;
    }
    return this.parkingWindow;
  }

  private park(view: WebContentsView): void {
    const host = this.parkingHost();
    if (host == null) {
      view.setVisible(false);
      return;
    }
    if (!this.parked.has(view)) {
      host.contentView.addChildView(view);
      this.parked.add(view);
    }
    view.setBounds(PARKED_BOUNDS);
    view.setVisible(true);
  }

  private unpark(view: WebContentsView): void {
    if (!this.parked.has(view)) return;
    this.parked.delete(view);
    const host = this.parkingWindow;
    if (host != null && !host.isDestroyed()) {
      try {
        host.contentView.removeChildView(view);
      } catch {
        // Already gone with the window.
      }
    }
  }
  private readonly currentLease = new WeakMap<
    WebContentsView,
    BrowserRuntimeLease
  >();
  private readonly leases = new Map<string, BrowserRuntimeLease>();
  private readonly profiles = new Map<string, string | undefined>();
  private readonly errors = new WeakMap<WebContentsView, string>();
  private readonly crashed = new WeakSet<WebContentsView>();
  private readonly crashRecovery = new WeakMap<
    WebContentsView,
    CrashRecovery
  >();
  private presentedLease: BrowserRuntimeLease | null = null;
  private presentedBy: string | null = null;
  private readonly registry = new BrowserRuntimeRegistry<
    WebContentsView,
    MaterializeOptions,
    BrowserRuntimeBounds
  >(
    {
      create: (lease, options) => this.createView(lease, options),
    },
    {
      present: (view, _lease, bounds) => this.presentView(view, bounds),
      hide: (view) => this.hideView(view),
      detach: (view) => this.detachView(view),
    }
  );

  constructor(private readonly getWindow: () => BrowserRuntimeWindow | null) {}

  async materialize(
    request: MaterializeBrowserRuntimeRequest
  ): Promise<BrowserRuntimeState> {
    const conversationKey = checkedConversationKey(request.conversationKey);
    const resourceId = browserResourceId(request.resourceId);
    const key = runtimeMapKey(conversationKey, resourceId);
    const profileId = checkedProfileId(request.profileId);
    let url = request.url == null ? undefined : checkedUrl(request.url);
    const existingProfile = this.profiles.get(key);
    if (this.leases.has(key) && existingProfile !== profileId) {
      const previousLease = this.leases.get(key)!;
      url ??= this.state(previousLease).url;
      if (this.sameLease(this.presentedLease, previousLease)) {
        this.presentedLease = null;
        this.presentedBy = null;
      }
      this.registry.close(previousLease);
      this.leases.delete(key);
      this.profiles.delete(key);
    }

    // Only a fresh view gets the URL: the renderer calls materialize on every
    // mount with the last URL it knew, and re-loading a live view would drag
    // the agent's browser back to a page it left. That is `navigate`'s job.
    const fresh = !this.leases.has(key);
    const lease = this.registry.materialize(conversationKey, resourceId, {
      profileId,
    });
    this.leases.set(key, lease);
    this.profiles.set(key, profileId);
    if (url != null && fresh) await this.loadUrlQuietly(lease, url);
    return this.state(lease);
  }

  async present(
    request: PresentBrowserRuntimeRequest
  ): Promise<BrowserRuntimeState> {
    const lease = this.resolveLease(request.lease);
    const url = request.url == null ? undefined : checkedUrl(request.url);
    const previous = this.presentedLease;
    if (previous != null && !this.sameLease(previous, lease)) {
      this.registry.hide(previous);
    }
    this.registry.present(lease, request.bounds);
    this.presentedLease = lease;
    this.presentedBy = request.presentationId;
    if (url != null) await this.loadUrlQuietly(lease, url);
    return this.state(lease);
  }

  async navigate(
    request: NavigateBrowserRuntimeRequest
  ): Promise<BrowserRuntimeState> {
    const lease = this.resolveLease(request.lease);
    const contents = this.registry.nativeView(lease).webContents;
    const { navigation } = request;
    switch (navigation.action) {
      case "url":
        // An unsupported protocol is the caller's error; a page that will not
        // load is pane state (the error overlay), not a rejected IPC call.
        await this.loadUrlQuietly(lease, checkedUrl(navigation.url));
        break;
      case "back":
        if (contents.navigationHistory.canGoBack()) {
          contents.navigationHistory.goBack();
        }
        break;
      case "forward":
        if (contents.navigationHistory.canGoForward()) {
          contents.navigationHistory.goForward();
        }
        break;
      case "reload":
        contents.reload();
        break;
      case "hard-reload":
        contents.reloadIgnoringCache();
        break;
      case "stop":
        contents.stop();
        break;
      case "focus": {
        const window = this.getWindow();
        if (window != null && !window.isDestroyed()) contents.focus();
        break;
      }
      case "open-devtools":
        contents.openDevTools({ mode: "detach", activate: true });
        break;
      case "zoom-in":
        contents.setZoomFactor(Math.min(5, contents.getZoomFactor() + 0.1));
        break;
      case "zoom-out":
        contents.setZoomFactor(Math.max(0.25, contents.getZoomFactor() - 0.1));
        break;
      case "zoom-reset":
        contents.setZoomFactor(1);
        break;
      case "clear-site-data":
        await this.clearSiteData(contents);
        break;
    }
    return this.state(lease);
  }

  async capture(
    leaseContract: BrowserRuntimeLeaseContract
  ): Promise<BrowserRuntimeCapture> {
    const lease = this.resolveLease(leaseContract);
    const contents = this.registry.nativeView(lease).webContents;
    let lastError: unknown;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        const image = await contents.capturePage(undefined, {
          stayHidden: true,
        });
        return {
          dataUrl: `data:image/jpeg;base64,${image.toJPEG(78).toString("base64")}`,
        };
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 16));
      }
    }
    throw lastError;
  }

  hide(request: HideBrowserRuntimeRequest): void {
    const lease = this.resolveLease(request.lease);
    if (
      !this.sameLease(this.presentedLease, lease) ||
      this.presentedBy !== request.presentationId
    ) {
      return;
    }
    this.registry.hide(lease);
    this.presentedLease = null;
    this.presentedBy = null;
  }

  close(leaseContract: BrowserRuntimeLeaseContract): void {
    const lease = this.resolveLease(leaseContract);
    this.leases.delete(runtimeMapKey(lease.conversationKey, lease.resourceId));
    this.profiles.delete(
      runtimeMapKey(lease.conversationKey, lease.resourceId)
    );
    if (this.sameLease(this.presentedLease, lease)) {
      this.presentedLease = null;
      this.presentedBy = null;
    }
    this.registry.close(lease);
  }

  promoteScope(
    request: PromoteBrowserRuntimeScopeRequest
  ): BrowserRuntimeLeaseContract[] {
    const draftKey = checkedConversationKey(request.draftConversationKey);
    const sessionKey = checkedConversationKey(request.sessionConversationKey);
    const promoted = this.registry.promoteDraftScope(draftKey, sessionKey);

    for (const lease of promoted) {
      const oldKey = runtimeMapKey(draftKey, lease.resourceId);
      const newKey = runtimeMapKey(sessionKey, lease.resourceId);
      const profileId = this.profiles.get(oldKey);
      const view = this.registry.nativeView(lease);
      this.leases.delete(oldKey);
      this.profiles.delete(oldKey);
      this.leases.set(newKey, lease);
      this.profiles.set(newKey, profileId);
      this.currentLease.set(view, lease);
      if (
        this.presentedLease?.conversationKey === draftKey &&
        this.presentedLease.resourceId === lease.resourceId
      ) {
        this.presentedLease = lease;
      }
    }
    return promoted.map(contractLease);
  }

  disposeScope(conversationKey: ConversationKey): void {
    const checked = checkedConversationKey(conversationKey);
    try {
      this.registry.disposeScope(checked);
    } finally {
      if (this.presentedLease?.conversationKey === checked) {
        this.presentedLease = null;
        this.presentedBy = null;
      }
      this.deleteTracked((lease) => lease.conversationKey === checked);
    }
  }

  disposeWorkspace(workspaceId: string): void {
    const normalized = workspaceId.trim();
    if (normalized.length === 0)
      throw new TypeError("workspaceId cannot be empty");
    try {
      this.registry.disposeWorkspace(normalized);
    } finally {
      if (
        this.presentedLease != null &&
        conversationRefFromKey(this.presentedLease.conversationKey)
          ?.workspaceId === normalized
      ) {
        this.presentedLease = null;
        this.presentedBy = null;
      }
      this.deleteTracked(
        (lease) =>
          conversationRefFromKey(lease.conversationKey)?.workspaceId ===
          normalized
      );
    }
  }

  /**
   * The live views, for the browser tools. Each carries the session whose
   * conversation owns it, so a tool call drives its own session's page.
   */
  agentViews(): Array<{
    id: number;
    url: string;
    sessionId: string | null;
    presented: boolean;
  }> {
    const out: Array<{
      id: number;
      url: string;
      sessionId: string | null;
      presented: boolean;
    }> = [];
    for (const lease of this.leases.values()) {
      let contents: WebContents;
      try {
        contents = this.registry.nativeView(lease).webContents;
      } catch {
        continue;
      }
      if (contents.isDestroyed()) continue;
      const ref = conversationRefFromKey(lease.conversationKey);
      out.push({
        id: contents.id,
        url: contents.getURL(),
        sessionId: ref?.kind === "session" ? ref.sessionId : null,
        presented: this.sameLease(this.presentedLease, lease),
      });
    }
    return out;
  }

  webContentsById(id: number): WebContents | null {
    for (const lease of this.leases.values()) {
      try {
        const contents = this.registry.nativeView(lease).webContents;
        if (contents.id === id && !contents.isDestroyed()) return contents;
      } catch {
        continue;
      }
    }
    return null;
  }

  /**
   * A hidden view for an agent session's conversation, created on demand so a
   * bot or a background chat can browse without touching what is on screen.
   * Returns the existing one when the conversation already has it.
   */
  async materializeForSession(
    workspaceId: string,
    sessionId: string,
    url: string
  ): Promise<{
    id: number;
    conversationKey: ConversationKey;
    resourceId: string;
  }> {
    const conversationKey = sessionConversationKey(workspaceId, sessionId);
    const state = await this.materialize({
      conversationKey,
      resourceId: AGENT_BROWSER_RESOURCE_ID,
      url,
    });
    const contents = this.registry.nativeView(
      this.resolveLease(state.lease)
    ).webContents;
    return {
      id: contents.id,
      conversationKey,
      resourceId: AGENT_BROWSER_RESOURCE_ID,
    };
  }

  disposeAll(): void {
    try {
      this.registry.disposeAll();
    } finally {
      this.leases.clear();
      this.profiles.clear();
      this.presentedLease = null;
      this.presentedBy = null;
    }
  }

  private createView(
    lease: BrowserRuntimeLease,
    options?: MaterializeOptions
  ): WebContentsView {
    const partition =
      options?.profileId == null
        ? DEFAULT_PARTITION
        : importedProfilePartition(options.profileId);
    const partitionSession = session.fromPartition(partition);
    partitionSession.setUserAgent(
      plainChromeUserAgent(partitionSession.getUserAgent())
    );
    const view = new WebContentsView({
      webPreferences: {
        partition,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        focusOnNavigation: false,
      },
    });
    view.setBounds(PARKED_BOUNDS);
    this.park(view);
    this.currentLease.set(view, lease);
    const contents = view.webContents;
    const emit = (): void => this.emitState(view);
    contents.on("did-start-loading", () => {
      this.errors.delete(view);
      this.crashed.delete(view);
      emit();
    });
    contents.on("did-stop-loading", emit);
    contents.on("did-finish-load", () => this.resetCrashRecovery(view));
    contents.on("did-navigate", emit);
    contents.on("did-navigate-in-page", emit);
    contents.on("page-title-updated", emit);
    contents.on(
      "did-fail-load",
      (_event, errorCode, errorDescription, _url, isMainFrame) => {
        if (isMainFrame && errorCode !== -3) {
          this.errors.set(view, errorDescription);
          emit();
        }
      }
    );
    contents.on("render-process-gone", (_event, details) => {
      this.crashed.add(view);
      this.errors.set(view, `Renderer stopped (${details.reason})`);
      emit();
      this.scheduleCrashRecovery(view);
    });
    contents.on("destroyed", () => this.resetCrashRecovery(view));
    contents.on("focus", emit);
    contents.on("blur", emit);
    contents.on("devtools-opened", emit);
    contents.on("devtools-closed", emit);
    contents.setWindowOpenHandler(({ url }) => {
      void this.loadUrlForView(view, url).catch(() => undefined);
      return { action: "deny" };
    });
    return view;
  }

  private presentView(
    view: WebContentsView,
    bounds?: BrowserRuntimeBounds
  ): void {
    if (bounds == null) throw new TypeError("Browser bounds are required");
    const window = this.getWindow();
    if (window == null || window.isDestroyed()) {
      throw new Error("The browser runtime has no owner window");
    }
    if (!this.attached.has(view)) {
      this.unpark(view);
      window.contentView.addChildView(view);
      this.attached.add(view);
    }
    const nextBounds = checkedBounds(bounds, window.getContentBounds());
    const currentBounds = view.getBounds();
    if (
      currentBounds.x !== nextBounds.x ||
      currentBounds.y !== nextBounds.y ||
      currentBounds.width !== nextBounds.width ||
      currentBounds.height !== nextBounds.height
    ) {
      view.setBounds(nextBounds);
    }
    view.setVisible(true);
  }

  private detachView(view: WebContentsView): void {
    const window = this.getWindow();
    if (window != null && !window.isDestroyed() && this.attached.has(view)) {
      window.contentView.removeChildView(view);
    }
    this.attached.delete(view);
    this.unpark(view);
  }

  private hideView(view: WebContentsView): void {
    const window = this.getWindow();
    if (
      view.webContents.isFocused() &&
      window != null &&
      !window.isDestroyed() &&
      !window.webContents.isDestroyed()
    ) {
      window.webContents.focus();
    }
    // Into the hidden host, where it keeps a real viewport.
    if (window != null && !window.isDestroyed() && this.attached.has(view)) {
      window.contentView.removeChildView(view);
      this.attached.delete(view);
    }
    this.park(view);
  }

  /**
   * Load a URL and answer with the view's state either way: a page that will
   * not load is the pane's error overlay, not a raw IPC error toast.
   */
  private async loadUrlQuietly(
    lease: BrowserRuntimeLease,
    url: string
  ): Promise<void> {
    try {
      await this.loadUrlForView(this.registry.nativeView(lease), url);
    } catch {
      // did-fail-load has already recorded the error for state().
    }
  }

  private async loadUrlForView(
    view: WebContentsView,
    url: string
  ): Promise<void> {
    await view.webContents.loadURL(checkedUrl(url));
  }

  private state(lease: BrowserRuntimeLease): BrowserRuntimeState {
    const contents = this.registry.nativeView(lease).webContents;
    return {
      lease: contractLease(lease),
      url: contents.getURL(),
      title: contents.getTitle(),
      loading: contents.isLoading(),
      canGoBack: contents.navigationHistory.canGoBack(),
      canGoForward: contents.navigationHistory.canGoForward(),
      focused: contents.isFocused(),
      crashed: this.crashed.has(this.registry.nativeView(lease)),
      ...(this.errors.get(this.registry.nativeView(lease)) == null
        ? {}
        : { error: this.errors.get(this.registry.nativeView(lease)) }),
      devToolsOpen: contents.isDevToolsOpened(),
      zoomFactor: contents.getZoomFactor(),
    };
  }

  private async clearSiteData(contents: Electron.WebContents): Promise<void> {
    const url = contents.getURL();
    if (!url.startsWith("http://") && !url.startsWith("https://")) return;
    const origin = new URL(url).origin;
    const cookies = await contents.session.cookies.get({ url });
    await Promise.all(
      cookies.map((cookie) =>
        contents.session.cookies.remove(origin, cookie.name)
      )
    );
    await contents.session.clearCache();
    await contents.session.clearStorageData({ origin });
    contents.reload();
  }

  private scheduleCrashRecovery(view: WebContentsView): void {
    const now = Date.now();
    let recovery = this.crashRecovery.get(view);
    if (recovery == null || now - recovery.windowStartedAt >= 30_000) {
      recovery = { attempts: 0, windowStartedAt: now, timer: null };
      this.crashRecovery.set(view, recovery);
    }
    if (recovery.timer != null || recovery.attempts >= 3) return;
    const delay = [250, 500, 1000][recovery.attempts] ?? 1000;
    recovery.attempts += 1;
    recovery.timer = setTimeout(() => {
      recovery!.timer = null;
      if (!view.webContents.isDestroyed()) view.webContents.reload();
    }, delay);
  }

  private resetCrashRecovery(view: WebContentsView): void {
    const recovery = this.crashRecovery.get(view);
    if (recovery?.timer != null) clearTimeout(recovery.timer);
    this.crashRecovery.delete(view);
  }

  private emitState(view: WebContentsView): void {
    const lease = this.currentLease.get(view);
    const window = this.getWindow();
    if (
      lease == null ||
      view.webContents.isDestroyed() ||
      window == null ||
      window.isDestroyed() ||
      window.webContents.isDestroyed()
    ) {
      return;
    }
    const event: IpcEvent = {
      type: "browser-runtime-state-updated",
      state: this.state(lease),
      emittedAt: new Date().toISOString(),
    };
    window.webContents.send(IpcChannels.Event, event);
  }

  private deleteTracked(
    predicate: (lease: BrowserRuntimeLease) => boolean
  ): void {
    for (const [key, lease] of this.leases) {
      if (!predicate(lease)) continue;
      this.leases.delete(key);
      this.profiles.delete(key);
    }
  }

  private sameLease(
    left: BrowserRuntimeLease | null,
    right: BrowserRuntimeLease
  ): boolean {
    return (
      left?.conversationKey === right.conversationKey &&
      left.resourceId === right.resourceId &&
      left.generation === right.generation
    );
  }

  private resolveLease(
    leaseContract: BrowserRuntimeLeaseContract
  ): BrowserRuntimeLease {
    const requested = registryLease(leaseContract);
    const direct = this.leases.get(
      runtimeMapKey(requested.conversationKey, requested.resourceId)
    );
    if (direct != null && this.sameLease(direct, requested)) return direct;

    const requestedWorkspace = conversationRefFromKey(
      requested.conversationKey
    )?.workspaceId;
    for (const current of this.leases.values()) {
      if (
        current.resourceId === requested.resourceId &&
        current.generation > requested.generation &&
        conversationRefFromKey(current.conversationKey)?.workspaceId ===
          requestedWorkspace
      ) {
        return current;
      }
    }
    return requested;
  }
}
