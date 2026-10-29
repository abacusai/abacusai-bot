import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

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
} from "@abacus-ai/contract/contracts";
import {
  AGENT_BROWSER_RESOURCE_ID,
  conversationRefFromKey,
  sessionConversationKey,
  type ConversationKey,
} from "@abacus-ai/contract/conversation-scope";
import { ForbiddenError } from "@abacus-ai/contract/forbidden";
import {
  BaseWindow,
  session,
  WebContentsView,
  type BrowserWindow,
  type Rectangle,
  type WebContents,
} from "electron";

import { publishIpcEvent } from "#main/rpc/emit";

import {
  BrowserRuntimeRegistry,
  browserResourceId,
  type BrowserRuntimeLease,
} from "./browser-runtime-registry";
import { isInsideRoot } from "./local-preview-file";
import {
  PAGE_ERROR_COLLECTOR,
  PAGE_ERRORS_READ,
  pageCheckOf,
  type ServedPageCheck,
} from "./page-errors";

/** A local PDF/HTML file's view (spec 04 §12.8): real paths, checked. */
type LocalFile = { file: string; root: string };
type MaterializeOptions = { profileId?: string; localFile?: LocalFile };

const localFileIdentity = (localFile: LocalFile): string =>
  `${localFile.file}\0${localFile.root}`;

/** What a runtime was made from: a present rebuilds a closed one from it. */
type RuntimeSource =
  | { kind: "web"; url?: string; profileId?: string }
  | { kind: "file"; file: string; root: string };

/** A remount releases before its replacement acquires: the close waits this long for it. */
const RELEASE_GRACE_MS = 1_000;
/** Sources kept for runtimes that are no longer open, oldest dropped first. */
const MAX_SOURCES = 256;

/** What the local-file view's session lets through (spec 04 §12.8). */
export const localFileRequestAllowed = (
  localFile: LocalFile,
  url: string
): boolean => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  switch (parsed.protocol) {
    case "file:": {
      let requested: string;
      try {
        requested = fileURLToPath(parsed);
      } catch {
        return false;
      }
      let real = requested;
      try {
        real = realpathSync(requested);
      } catch {
        // Not there (yet): judged by the path as written.
      }
      return isInsideRoot(localFile.root, real);
    }
    case "data:":
    case "blob:":
    case "http:":
    case "https:":
    // Chromium's own PDF viewer and devtools.
    case "chrome-extension:":
    case "chrome:":
    case "devtools:":
      return true;
    default:
      return false;
  }
};

/** A navigation that stays on `fileUrl` (a fragment change of the same file). */
export const sameLocalDocument = (fileUrl: string, url: string): boolean => {
  try {
    const next = new URL(url);
    const current = new URL(fileUrl);
    next.hash = "";
    current.hash = "";
    return next.href === current.href;
  } catch {
    return false;
  }
};

const isHttpUrl = (url: string): boolean =>
  url.startsWith("http://") || url.startsWith("https://");

export interface ElectronBrowserRuntimeOptions {
  /** `system.openExternal`'s path: a local file's http(s) links go there. */
  openExternal?: (url: string) => void;
  /**
   * The URL to load for `url`: a served directory's URL whose server died
   * with an earlier run is served again first (on another port if its own
   * was taken, which the answer then names). Every load and reload of a
   * page asks it, so a files card or tab opened after a restart works.
   */
  revivePreview?: (url: string) => Promise<string>;
}
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

const keyParts = (key: string): [ConversationKey, string] =>
  JSON.parse(key) as [ConversationKey, string];

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
/** How long a checked page gets to load, then to run its start-up code. */
const PAGE_CHECK_LOAD_MS = 15_000;
const PAGE_CHECK_SETTLE_MS = 1_500;

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

  /** Local-file views (spec 04 §12.8), by view. */
  private readonly localFiles = new WeakMap<
    WebContentsView,
    LocalFile & { url: string }
  >();
  /**
   * runtime key → the local file its view shows and the root its
   * sub-resources are locked to (`localFileIdentity`).
   */
  private readonly localKeys = new Map<string, string>();
  /**
   * runtime key → the viewers holding it open. Main owns the lifetime: the
   * runtime closes when the last one releases, or with its conversation.
   */
  private readonly holders = new Map<string, Set<string>>();
  private readonly releaseTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  /** runtime key → its source; outlives a released runtime, not an explicit close. */
  private readonly sources = new Map<string, RuntimeSource>();

  constructor(
    private readonly getWindow: () => BrowserRuntimeWindow | null,
    private readonly options: ElectronBrowserRuntimeOptions = {}
  ) {}

  /** Closes the key's runtime (a different profile or kind is wanted). */
  private replace(key: string): void {
    const previousLease = this.leases.get(key);
    if (previousLease == null) return;
    if (this.sameLease(this.presentedLease, previousLease)) {
      this.presentedLease = null;
      this.presentedBy = null;
    }
    this.registry.close(previousLease);
    this.leases.delete(key);
    this.profiles.delete(key);
    this.localKeys.delete(key);
  }

  async materialize(
    request: MaterializeBrowserRuntimeRequest
  ): Promise<BrowserRuntimeState> {
    const conversationKey = checkedConversationKey(request.conversationKey);
    const resourceId = browserResourceId(request.resourceId);
    const key = runtimeMapKey(conversationKey, resourceId);
    const profileId = checkedProfileId(request.profileId);
    let url = request.url == null ? undefined : checkedUrl(request.url);
    const existingProfile = this.profiles.get(key);
    if (
      this.leases.has(key) &&
      (existingProfile !== profileId || this.localKeys.has(key))
    ) {
      // A local file's URL never carries over into a web view.
      if (!this.localKeys.has(key))
        url ??= this.state(this.leases.get(key)!).url;
      this.replace(key);
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
    if (fresh)
      this.keepSource(key, {
        kind: "web",
        ...(url == null ? {} : { url }),
        ...(profileId == null ? {} : { profileId }),
      });
    if (url != null && fresh) await this.loadUrlQuietly(lease, url);
    return this.state(lease);
  }

  /**
   * A local PDF or HTML file on the native surface (spec 04 §12.8). The
   * caller has checked `file` (real path) against `root` (real path) with
   * the readers' containment guard. The view gets its own non-persistent
   * partition, no preload and no node, and is locked to the file: every
   * top-level navigation but a fragment change is refused (http(s) links go
   * to the system browser), and sub-resources are `file:` inside `root`,
   * `data:`, `blob:` or http(s).
   */
  async materializeFile(request: {
    conversationKey: ConversationKey;
    resourceId: string;
    file: string;
    root: string;
    holder?: string;
  }): Promise<BrowserRuntimeState> {
    const conversationKey = checkedConversationKey(request.conversationKey);
    const resourceId = browserResourceId(request.resourceId);
    const key = runtimeMapKey(conversationKey, resourceId);
    // The view's lock is fixed when it is built: another file, or the same
    // file under another root (a narrower one included), needs a new view.
    const identity = localFileIdentity(request);
    if (this.leases.has(key) && this.localKeys.get(key) !== identity)
      this.replace(key);
    const fresh = !this.leases.has(key);
    const lease = this.registry.materialize(conversationKey, resourceId, {
      localFile: { file: request.file, root: request.root },
    });
    this.leases.set(key, lease);
    this.profiles.set(key, undefined);
    this.localKeys.set(key, identity);
    this.hold(key, request.holder);
    if (fresh) {
      this.keepSource(key, {
        kind: "file",
        file: request.file,
        root: request.root,
      });
      const view = this.registry.nativeView(lease);
      try {
        await view.webContents.loadURL(pathToFileURL(request.file).href);
      } catch {
        // did-fail-load has recorded the error for state().
      }
    }
    return this.state(lease);
  }

  /** A local-file view refuses any URL of its own choosing. */
  private refuseLocalUrl(lease: BrowserRuntimeLease): void {
    if (this.localFiles.has(this.registry.nativeView(lease)))
      throw new ForbiddenError(
        "local-file",
        "A local file's view shows only that file"
      );
  }

  /**
   * Viewer `holder` lets go of the resource. The last one out closes it
   * (after `RELEASE_GRACE_MS`, so a remount's re-acquire keeps it); its
   * source stays, so a surface still showing it is rebuilt, not blank.
   */
  release(request: {
    conversationKey: ConversationKey;
    resourceId: string;
    holder: string;
  }): void {
    const resourceId = browserResourceId(request.resourceId);
    const direct = runtimeMapKey(
      checkedConversationKey(request.conversationKey),
      resourceId
    );
    // Promotion moves a draft's holders to the session's key.
    const key = this.holders.get(direct)?.has(request.holder)
      ? direct
      : [...this.holders].find(
          ([candidate, held]) =>
            held.has(request.holder) && keyParts(candidate)[1] === resourceId
        )?.[0];
    const held = key == null ? undefined : this.holders.get(key);
    if (key == null || held == null) return;
    held.delete(request.holder);
    if (held.size > 0) return;
    this.holders.delete(key);
    this.scheduleClose(key);
  }

  async present(
    request: PresentBrowserRuntimeRequest
  ): Promise<BrowserRuntimeState> {
    const lease = await this.presentable(request.lease);
    if (request.url != null) this.refuseLocalUrl(lease);
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
        this.refuseLocalUrl(lease);
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
      case "hard-reload": {
        // Chromium keeps a page that failed at its URL: retrying a served
        // page whose server is down brings the server back first.
        const current = contents.getURL();
        const live = await this.revived(current);
        if (live !== current) await this.loadUrlQuietly(lease, live);
        else if (navigation.action === "reload") contents.reload();
        else contents.reloadIgnoringCache();
        break;
      }
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
    const requested = registryLease(leaseContract);
    const lease = this.resolveLease(leaseContract);
    // A lease whose runtime was replaced names nothing open: never close
    // the replacement, or another conversation's runtime (only a draft's
    // lease follows its runtime, to the session it was promoted to).
    if (
      lease.generation !== requested.generation &&
      (lease.conversationKey === requested.conversationKey ||
        conversationRefFromKey(requested.conversationKey)?.kind !== "draft")
    )
      return;
    // Closed on purpose: nothing rebuilds it.
    this.forget(runtimeMapKey(lease.conversationKey, lease.resourceId));
    this.leases.delete(runtimeMapKey(lease.conversationKey, lease.resourceId));
    this.profiles.delete(
      runtimeMapKey(lease.conversationKey, lease.resourceId)
    );
    this.localKeys.delete(
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
      const localFile = this.localKeys.get(oldKey);
      this.leases.delete(oldKey);
      this.profiles.delete(oldKey);
      this.localKeys.delete(oldKey);
      this.leases.set(newKey, lease);
      this.profiles.set(newKey, profileId);
      if (localFile != null) this.localKeys.set(newKey, localFile);
      this.moveOwnership(oldKey, newKey);
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
      this.localKeys.clear();
      for (const timer of this.releaseTimers.values()) clearTimeout(timer);
      this.releaseTimers.clear();
      this.holders.clear();
      this.sources.clear();
      this.presentedLease = null;
      this.presentedBy = null;
    }
  }

  private createView(
    lease: BrowserRuntimeLease,
    options?: MaterializeOptions
  ): WebContentsView {
    const localFile = options?.localFile;
    // A local file gets a partition of its own that is never written to
    // disk (no `persist:`), so nothing it stores outlives it.
    const partition =
      localFile != null
        ? `local-preview:${randomUUID()}`
        : options?.profileId == null
          ? DEFAULT_PARTITION
          : importedProfilePartition(options.profileId);
    const partitionSession = session.fromPartition(partition);
    if (localFile == null)
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
        // Chromium's PDF viewer is a plugin.
        ...(localFile != null && { plugins: true }),
      },
    });
    if (localFile != null)
      this.lockToLocalFile(view, localFile, partitionSession);
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
    if (localFile == null)
      contents.setWindowOpenHandler(({ url }) => {
        void this.loadUrlForView(view, url).catch(() => undefined);
        return { action: "deny" };
      });
    return view;
  }

  /** §12.8's lock: the file, its fragments, and nothing else on top. */
  private lockToLocalFile(
    view: WebContentsView,
    localFile: LocalFile,
    partitionSession: Electron.Session
  ): void {
    const url = pathToFileURL(localFile.file).href;
    this.localFiles.set(view, { ...localFile, url });
    const handOff = (target: string): void => {
      if (isHttpUrl(target)) this.options.openExternal?.(target);
    };
    const contents = view.webContents;
    contents.on("will-navigate", (event: Electron.Event, target: string) => {
      if (sameLocalDocument(url, target)) return;
      event.preventDefault();
      handOff(target);
    });
    contents.setWindowOpenHandler(({ url: target }) => {
      handOff(target);
      return { action: "deny" };
    });
    partitionSession.webRequest.onBeforeRequest((details, callback) => {
      callback({ cancel: !localFileRequestAllowed(localFile, details.url) });
    });
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
    await view.webContents.loadURL(await this.revived(checkedUrl(url)));
  }

  /**
   * Loads a local page in a view of its own, parked and never shown, on a
   * partition nothing persists, and reports what it threw as it loaded (see
   * page-errors.ts): `present_deliverable`'s proof that an app runs. Null
   * when that could not be found out (the page went to another origin, the
   * view could not be driven): the HTTP answer is all that is known then.
   */
  async checkServedPage(url: string): Promise<ServedPageCheck | null> {
    const origin = new URL(checkedUrl(url)).origin;
    const view = new WebContentsView({
      webPreferences: {
        partition: `page-check-${randomUUID()}`,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        focusOnNavigation: false,
      },
    });
    const contents = view.webContents;
    // Only did-fail-load knows a page did not load: Chromium shows its error
    // page at the very URL that failed.
    let failure: string | null = null;
    contents.on(
      "did-fail-load",
      (_event, errorCode, errorDescription, _url, isMainFrame) => {
        if (isMainFrame && errorCode !== -3)
          failure = `${errorDescription} (${errorCode})`;
      }
    );
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
    view.setBounds(PARKED_BOUNDS);
    this.park(view);
    try {
      contents.debugger.attach("1.3");
      await contents.debugger.sendCommand(
        "Page.addScriptToEvaluateOnNewDocument",
        { source: PAGE_ERROR_COLLECTOR }
      );
      await Promise.race([
        contents.loadURL(url).catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, PAGE_CHECK_LOAD_MS)),
      ]);
      if (failure != null) return { loaded: false, reason: failure };
      await new Promise((resolve) => setTimeout(resolve, PAGE_CHECK_SETTLE_MS));
      if (new URL(contents.getURL()).origin !== origin) return null;
      return pageCheckOf(await contents.executeJavaScript(PAGE_ERRORS_READ));
    } catch (error) {
      console.warn(
        `[browser-runtime] could not check a served page: ${(error as Error).message}`
      );
      return null;
    } finally {
      this.unpark(view);
      contents.close();
    }
  }

  /** `url`, or the URL its served directory answers on again; see `revivePreview`. */
  private async revived(url: string): Promise<string> {
    const revive = this.options.revivePreview;
    if (revive == null || !isHttpUrl(url)) return url;
    try {
      return checkedUrl(await revive(url));
    } catch (error) {
      // The page is loaded as it was: its own error overlay says the rest.
      console.warn(
        `[browser-runtime] could not bring a served page back: ${(error as Error).message}`
      );
      return url;
    }
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
    publishIpcEvent(event);
  }

  private deleteTracked(
    predicate: (lease: BrowserRuntimeLease) => boolean
  ): void {
    for (const [key, lease] of this.leases) {
      if (!predicate(lease)) continue;
      this.leases.delete(key);
      this.profiles.delete(key);
      this.localKeys.delete(key);
    }
    // Released runtimes' sources and holders go with their conversation.
    for (const key of new Set([
      ...this.sources.keys(),
      ...this.holders.keys(),
      ...this.releaseTimers.keys(),
    ])) {
      const [conversationKey, resourceId] = keyParts(key);
      if (
        predicate({
          conversationKey,
          resourceId: browserResourceId(resourceId),
          generation: 0 as BrowserRuntimeLease["generation"],
        })
      )
        this.forget(key);
    }
  }

  private keepSource(key: string, source: RuntimeSource): void {
    this.sources.delete(key);
    this.sources.set(key, source);
    for (const old of this.sources.keys()) {
      if (this.sources.size <= MAX_SOURCES) break;
      if (!this.leases.has(old)) this.sources.delete(old);
    }
  }

  private hold(key: string, holder: string | undefined): void {
    if (holder == null) return;
    const timer = this.releaseTimers.get(key);
    if (timer != null) clearTimeout(timer);
    this.releaseTimers.delete(key);
    this.holders.set(key, (this.holders.get(key) ?? new Set()).add(holder));
  }

  private scheduleClose(key: string): void {
    const pending = this.releaseTimers.get(key);
    if (pending != null) clearTimeout(pending);
    this.releaseTimers.set(
      key,
      setTimeout(() => {
        this.releaseTimers.delete(key);
        if (this.holders.has(key) || !this.leases.has(key)) return;
        try {
          const source = this.sources.get(key);
          // A rebuilt page reopens where it was, not where it started.
          if (source?.kind === "web") {
            const url = this.state(this.leases.get(key)!).url;
            if (isHttpUrl(url)) source.url = url;
          }
          this.replace(key);
        } catch (error) {
          console.warn("[browser-runtime] release cleanup failed", error);
        }
      }, RELEASE_GRACE_MS)
    );
  }

  /** Holders, a pending close and the source of `key`: an explicit close or a gone conversation. */
  private forget(key: string): void {
    const timer = this.releaseTimers.get(key);
    if (timer != null) clearTimeout(timer);
    this.releaseTimers.delete(key);
    this.holders.delete(key);
    this.sources.delete(key);
  }

  private moveOwnership(oldKey: string, newKey: string): void {
    const holders = this.holders.get(oldKey);
    const source = this.sources.get(oldKey);
    const releasing = this.releaseTimers.has(oldKey);
    this.forget(oldKey);
    if (holders != null) this.holders.set(newKey, holders);
    if (source != null) this.sources.set(newKey, source);
    if (releasing) this.scheduleClose(newKey);
  }

  /**
   * The runtime the lease's resource has now, whatever its generation; a
   * draft's moved to its session on promotion. One closed underneath is
   * rebuilt from its source (paths `materializeFile` checked; the view's
   * own lock re-checks every load), so the pane is never left blank.
   */
  private async presentable(
    leaseContract: BrowserRuntimeLeaseContract
  ): Promise<BrowserRuntimeLease> {
    const requested = registryLease(leaseContract);
    const key = runtimeMapKey(requested.conversationKey, requested.resourceId);
    const direct = this.leases.get(key);
    if (direct != null) return direct;
    if (conversationRefFromKey(requested.conversationKey)?.kind === "draft") {
      const moved = this.resolveLease(leaseContract);
      const live = this.leases.get(
        runtimeMapKey(moved.conversationKey, moved.resourceId)
      );
      if (live != null && this.sameLease(live, moved)) return live;
    }
    const source = this.sources.get(key);
    if (source == null) return requested;
    const { conversationKey, resourceId } = requested;
    const state =
      source.kind === "file"
        ? await this.materializeFile({
            conversationKey,
            resourceId,
            file: source.file,
            root: source.root,
          })
        : await this.materialize({
            conversationKey,
            resourceId,
            ...(source.url == null ? {} : { url: source.url }),
            ...(source.profileId == null
              ? {}
              : { profileId: source.profileId }),
          });
    return this.leases.get(key) ?? registryLease(state.lease);
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
