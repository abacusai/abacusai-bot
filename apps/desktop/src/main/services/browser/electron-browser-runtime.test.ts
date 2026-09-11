import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  type Listener = (...args: unknown[]) => void;
  /** URLs the fake refuses to load, the way a site that rejects Chromium does. */
  const refusedUrls = new Set<string>();

  class FakeWebContents {
    readonly listeners = new Map<string, Listener[]>();
    readonly close = vi.fn();
    readonly reload = vi.fn();
    readonly reloadIgnoringCache = vi.fn();
    readonly stop = vi.fn();
    readonly focus = vi.fn();
    readonly openDevTools = vi.fn();
    readonly capturePage = vi.fn(async () => ({
      toJPEG: vi.fn(() => Buffer.from("screenshot")),
    }));
    readonly setZoomFactor = vi.fn((factor: number) => {
      this.zoomFactor = factor;
    });
    readonly setWindowOpenHandler = vi.fn();
    readonly session = {
      clearCache: vi.fn(),
      clearStorageData: vi.fn(),
      cookies: { get: vi.fn(async () => []), remove: vi.fn() },
    };
    readonly navigationHistory = {
      canGoBack: vi.fn(() => false),
      canGoForward: vi.fn(() => false),
      goBack: vi.fn(),
      goForward: vi.fn(),
    };
    private url = "about:blank";
    private zoomFactor = 1;

    on(event: string, listener: Listener): void {
      this.listeners.set(event, [
        ...(this.listeners.get(event) ?? []),
        listener,
      ]);
    }

    emit(event: string, ...args: unknown[]): void {
      for (const listener of this.listeners.get(event) ?? []) listener(...args);
    }

    async loadURL(url: string): Promise<void> {
      if (refusedUrls.has(url)) {
        this.emit(
          "did-fail-load",
          {},
          -337,
          "ERR_HTTP2_PROTOCOL_ERROR",
          url,
          true
        );
        throw new Error(`ERR_HTTP2_PROTOCOL_ERROR (-337) loading '${url}'`);
      }
      this.url = url;
      this.emit("did-navigate");
    }

    getURL(): string {
      return this.url;
    }

    getTitle(): string {
      return this.url === "about:blank" ? "" : "Example";
    }

    isLoading(): boolean {
      return false;
    }

    isDestroyed(): boolean {
      return false;
    }

    isFocused(): boolean {
      return false;
    }

    isDevToolsOpened(): boolean {
      return false;
    }

    getZoomFactor(): number {
      return this.zoomFactor;
    }
  }

  const views: FakeWebContentsView[] = [];
  class FakeWebContentsView {
    readonly webContents = new FakeWebContents();
    private bounds = { x: 0, y: 0, width: 0, height: 0 };
    readonly setBounds = vi.fn((bounds: typeof this.bounds) => {
      this.bounds = bounds;
    });
    readonly setVisible = vi.fn();

    constructor(readonly options: unknown) {
      views.push(this);
    }

    getBounds(): typeof this.bounds {
      return this.bounds;
    }
  }
  /** The hidden window views are parked in while nobody looks at them. */
  const parking = {
    addChildView: vi.fn(),
    removeChildView: vi.fn(),
    created: 0,
  };
  class FakeBaseWindow {
    readonly contentView = {
      addChildView: parking.addChildView,
      removeChildView: parking.removeChildView,
    };
    constructor(readonly options: unknown) {
      parking.created += 1;
    }
    isDestroyed(): boolean {
      return false;
    }
  }
  /** The partition sessions, keyed by partition name. */
  const sessions = new Map<
    string,
    { userAgent: string; setUserAgent: (value: string) => void }
  >();
  const fromPartition = vi.fn((partition: string) => {
    const existing = sessions.get(partition);
    if (existing != null) return existing;
    const created = {
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) abacusai-bot/1.0.63 Chrome/150.0.7871.224 " +
        "Electron/43.4.1 Safari/537.36",
      setUserAgent(value: string) {
        this.userAgent = value;
      },
      getUserAgent(): string {
        return this.userAgent;
      },
    };
    sessions.set(partition, created);
    return created;
  });
  return {
    FakeWebContentsView,
    FakeBaseWindow,
    views,
    parking,
    refusedUrls,
    sessions,
    fromPartition,
  };
});

vi.mock("electron", () => ({
  WebContentsView: mocks.FakeWebContentsView,
  BaseWindow: mocks.FakeBaseWindow,
  session: { fromPartition: mocks.fromPartition },
}));

import { IpcChannels } from "#shared/channels";
import {
  draftConversationKey,
  sessionConversationKey,
} from "#shared/conversation-scope";

import { ElectronBrowserRuntime } from "./electron-browser-runtime";

describe("Electron browser runtime", () => {
  const addChildView = vi.fn();
  const removeChildView = vi.fn();
  const send = vi.fn();
  const owner = {
    contentView: { addChildView, removeChildView },
    getContentBounds: () => ({ x: 0, y: 0, width: 1200, height: 800 }),
    isDestroyed: () => false,
    webContents: { id: 42, isDestroyed: () => false, send },
  };

  beforeEach(() => {
    mocks.views.length = 0;
    mocks.refusedUrls.clear();
    mocks.parking.created = 0;
    vi.clearAllMocks();
  });

  it("leaves an existing view on its page when materialized again with a URL", async () => {
    // The renderer's surface materializes on every mount with the last URL
    // it knew. That must not move a view the agent is driving: on one
    // machine it dragged the browser back to a dead page six times in a
    // minute and aborted the sub-agent's own navigations.
    const runtime = new ElectronBrowserRuntime(() => owner as never);
    const request = {
      conversationKey: sessionConversationKey("workspace-one", "chat-one"),
      resourceId: "agent-browser",
    };
    await runtime.materialize({ ...request, url: "https://a.example/" });
    const view = mocks.views[0]!;
    await view.webContents.loadURL("https://b.example/");

    const state = await runtime.materialize({
      ...request,
      url: "https://a.example/",
    });

    expect(state.url).toBe("https://b.example/");
    expect(mocks.views).toHaveLength(1);
  });

  it("answers with the error state instead of throwing when the first page will not load", async () => {
    const runtime = new ElectronBrowserRuntime(() => owner as never);
    mocks.refusedUrls.add("https://www.makemytrip.com/");

    const state = await runtime.materialize({
      conversationKey: sessionConversationKey("workspace-one", "chat-one"),
      resourceId: "agent-browser",
      url: "https://www.makemytrip.com/",
    });

    expect(state.error).toBe("ERR_HTTP2_PROTOCOL_ERROR");
    expect(state.url).toBe("about:blank");
  });

  it("creates a sandboxed profile view, presents it, and emits its state", async () => {
    const runtime = new ElectronBrowserRuntime(() => owner as never);
    const state = await runtime.materialize({
      conversationKey: draftConversationKey("workspace-one"),
      resourceId: "browser-one",
      profileId: "chrome/Profile 1",
      url: "https://example.com",
    });

    expect(mocks.views[0]?.options).toEqual({
      webPreferences: {
        partition: "persist:bp-chrome_Profile_1",
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        focusOnNavigation: false,
      },
    });
    await runtime.present({
      lease: state.lease,
      presentationId: "surface-one",
      bounds: { x: 300.4, y: 40.6, width: 1000, height: 900 },
    });
    expect(addChildView).toHaveBeenCalledWith(mocks.views[0]);
    expect(mocks.views[0]?.setBounds).toHaveBeenCalledWith({
      x: 300,
      y: 41,
      width: 900,
      height: 759,
    });
    expect(mocks.views[0]?.setVisible).toHaveBeenLastCalledWith(true);
    await expect(runtime.capture(state.lease)).resolves.toEqual({
      dataUrl: "data:image/jpeg;base64,c2NyZWVuc2hvdA==",
    });
    expect(send).toHaveBeenCalledWith(
      IpcChannels.Event,
      expect.objectContaining({
        type: "browser-runtime-state-updated",
        state: expect.objectContaining({ url: "https://example.com/" }),
      })
    );
  });

  it("keeps the native view through promotion and closes it explicitly", async () => {
    const runtime = new ElectronBrowserRuntime(() => owner as never);
    const draftKey = draftConversationKey("workspace-one");
    const state = await runtime.materialize({
      conversationKey: draftKey,
      resourceId: "browser-one",
    });
    await runtime.present({
      lease: state.lease,
      presentationId: "surface-one",
      bounds: { x: 300, y: 40, width: 600, height: 500 },
    });
    const [promoted] = runtime.promoteScope({
      draftConversationKey: draftKey,
      sessionConversationKey: sessionConversationKey(
        "workspace-one",
        "session-one"
      ),
    });

    expect(promoted?.generation).toBeGreaterThan(state.lease.generation);
    const resolved = await runtime.navigate({
      lease: state.lease,
      navigation: { action: "reload" },
    });
    expect(resolved.lease).toEqual(promoted);
    expect(mocks.views[0]?.webContents.reload).toHaveBeenCalledOnce();
    runtime.close(promoted!);
    expect(removeChildView).toHaveBeenCalledWith(mocks.views[0]);
    expect(mocks.views[0]?.webContents.close).toHaveBeenCalledOnce();
    expect(mocks.views).toHaveLength(1);
  });

  it("keeps inactive views alive while presenting only one surface", async () => {
    const runtime = new ElectronBrowserRuntime(() => owner as never);
    const conversationKey = draftConversationKey("workspace-one");
    const first = await runtime.materialize({
      conversationKey,
      resourceId: "browser-one",
    });
    const second = await runtime.materialize({
      conversationKey,
      resourceId: "browser-two",
    });

    await runtime.present({
      lease: first.lease,
      presentationId: "surface-one",
      bounds: { x: 300, y: 40, width: 600, height: 500 },
    });
    await runtime.present({
      lease: second.lease,
      presentationId: "surface-two",
      bounds: { x: 300, y: 40, width: 600, height: 500 },
    });

    // The view nobody is looking at is parked in the hidden window, visible
    // there, so its page keeps a real viewport instead of a 0×0 one.
    expect(removeChildView).toHaveBeenCalledWith(mocks.views[0]);
    expect(mocks.parking.addChildView).toHaveBeenLastCalledWith(mocks.views[0]);
    expect(mocks.views[0]?.setVisible).toHaveBeenLastCalledWith(true);
    expect(mocks.views[0]?.getBounds()).toEqual({
      x: 0,
      y: 0,
      width: 1280,
      height: 900,
    });
    expect(mocks.views[1]?.setVisible).toHaveBeenLastCalledWith(true);
    expect(mocks.views[0]?.webContents.close).not.toHaveBeenCalled();
    // One hidden window for all parked views.
    expect(mocks.parking.created).toBe(1);
  });

  it("parks a new view until it is presented, then moves it to the owner window", async () => {
    const runtime = new ElectronBrowserRuntime(() => owner as never);
    const conversationKey = draftConversationKey("workspace-one");
    const state = await runtime.materialize({
      conversationKey,
      resourceId: "browser-one",
    });

    expect(mocks.parking.addChildView).toHaveBeenCalledWith(mocks.views[0]);
    expect(addChildView).not.toHaveBeenCalled();

    await runtime.present({
      lease: state.lease,
      presentationId: "surface-one",
      bounds: { x: 0, y: 0, width: 600, height: 500 },
    });

    expect(mocks.parking.removeChildView).toHaveBeenCalledWith(mocks.views[0]);
    expect(addChildView).toHaveBeenCalledWith(mocks.views[0]);
  });

  it("ignores cleanup from a stale presentation owner", async () => {
    const runtime = new ElectronBrowserRuntime(() => owner as never);
    const state = await runtime.materialize({
      conversationKey: draftConversationKey("workspace-one"),
      resourceId: "browser-one",
    });
    const bounds = { x: 300, y: 40, width: 600, height: 500 };

    await runtime.present({
      lease: state.lease,
      presentationId: "old-surface",
      bounds,
    });
    await runtime.present({
      lease: state.lease,
      presentationId: "current-surface",
      bounds,
    });
    runtime.hide({
      lease: state.lease,
      presentationId: "old-surface",
    });

    expect(mocks.views[0]?.setVisible).toHaveBeenLastCalledWith(true);
  });

  it("presents as plain Chrome, without the app and Electron tokens", async () => {
    const runtime = new ElectronBrowserRuntime(() => owner as never);
    await runtime.materialize({
      conversationKey: draftConversationKey("workspace-one"),
      resourceId: "browser-one",
      url: "https://example.com",
    });

    expect(mocks.sessions.get("persist:browser-runtime")?.userAgent).toBe(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/150.0.7871.224 Safari/537.36"
    );
  });

  it("answers with the error state when the address bar's page will not load", async () => {
    const runtime = new ElectronBrowserRuntime(() => owner as never);
    const state = await runtime.materialize({
      conversationKey: sessionConversationKey("workspace-one", "chat-one"),
      resourceId: "agent-browser",
    });
    mocks.refusedUrls.add("https://www.makemytrip.com/");

    const navigated = await runtime.navigate({
      lease: state.lease,
      navigation: { action: "url", url: "https://www.makemytrip.com/" },
    });

    expect(navigated.error).toBe("ERR_HTTP2_PROTOCOL_ERROR");
  });

  it("recreates a resource when its imported profile changes", async () => {
    const runtime = new ElectronBrowserRuntime(() => owner as never);
    const conversationKey = draftConversationKey("workspace-one");
    const first = await runtime.materialize({
      conversationKey,
      resourceId: "browser-one",
      url: "https://example.com",
    });

    const second = await runtime.materialize({
      conversationKey,
      resourceId: "browser-one",
      profileId: "chrome/Profile 2",
    });

    expect(second.lease.generation).toBeGreaterThan(first.lease.generation);
    expect(second.url).toBe("https://example.com/");
    expect(mocks.views[0]?.webContents.close).toHaveBeenCalledOnce();
    expect(mocks.views[1]?.options).toEqual(
      expect.objectContaining({
        webPreferences: expect.objectContaining({
          partition: "persist:bp-chrome_Profile_2",
        }),
      })
    );
  });

  it("rejects active content URLs that Chromium must not interpret", async () => {
    const runtime = new ElectronBrowserRuntime(() => owner as never);
    await expect(
      runtime.materialize({
        conversationKey: draftConversationKey("workspace-one"),
        resourceId: "browser-one",
        url: "javascript:alert(1)",
      })
    ).rejects.toThrow("Unsupported browser URL protocol");
  });
});
