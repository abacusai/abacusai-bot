import { EventEmitter } from "node:events";
import vm from "node:vm";

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  cookies: {
    get: vi.fn(async () => []),
    set: vi.fn(async (_cookie: Record<string, unknown>) => {}),
    remove: vi.fn(async (_url: string, _name: string) => {}),
  },
  clearStorageData: vi.fn(async () => {}),
  onBeforeRequest: vi.fn(),
  parent: {
    minimized: false,
    visible: true,
    isDestroyed: () => false,
    getBounds: () => ({ x: 0, y: 0, width: 1400, height: 900 }),
    isMinimized() {
      return this.minimized;
    },
    isVisible() {
      return this.visible;
    },
    restore: vi.fn(),
    show: vi.fn(),
  },
}));

type FakeWindowOptions = {
  parent?: unknown;
  show?: boolean;
  modal?: boolean;
  minimizable?: boolean;
  maximizable?: boolean;
  fullscreenable?: boolean;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
};
const windows: FakeWindow[] = [];
class FakeWindow extends EventEmitter {
  destroyed = false;
  url = "about:blank";
  webContents = Object.assign(new EventEmitter(), {
    mainFrame: {},
    session: {},
    getURL: () => this.url,
    executeJavaScript: vi.fn(async (_script: string) => null as unknown),
    setWindowOpenHandler: vi.fn(),
  });
  visible = false;
  bounds = { x: 0, y: 0, width: 0, height: 0 };
  constructor(readonly options: FakeWindowOptions) {
    super();
    windows.push(this);
    const { x = 0, y = 0, width = 0, height = 0 } = options;
    this.bounds = { x, y, width, height };
    this.visible = options.show !== false;
  }
  isVisible() {
    return this.visible;
  }
  show = vi.fn(() => {
    this.visible = true;
  });
  focus = vi.fn();
  getBounds() {
    return this.bounds;
  }
  setBounds = vi.fn((bounds: typeof this.bounds) => {
    this.bounds = bounds;
  });
  getChildWindows() {
    return windows.filter(
      (win) => win.options.parent === this && !win.destroyed
    );
  }
  removeMenu() {}
  isDestroyed() {
    return this.destroyed;
  }
  close() {
    this.emit("close");
    this.destroyed = true;
    this.emit("closed");
  }
  loadURL = vi.fn(async (url: string) => {
    this.url = url;
  });
}
vi.mock("electron", () => ({
  BrowserWindow: class {
    constructor(options: FakeWindowOptions) {
      return new FakeWindow(options);
    }
  },
  session: {
    fromPath: () => ({
      ...mocks,
      webRequest: { onBeforeRequest: mocks.onBeforeRequest },
    }),
  },
  nativeTheme: { shouldUseDarkColors: false },
  shell: { openExternal: vi.fn() },
}));
vi.mock("../../bring-to-front", () => ({
  parentWindow: () => mocks.parent,
}));
vi.mock("../../profile-home", () => ({
  profileBaseDir: () => "/tmp/signin-window-test",
}));
const { openSignInWindow } = await import("./abacus-signin-window");
const options = () => ({
  url: "https://apps.abacus.ai/bot/link/signin?botChallenge=test&botPort=1234&botPath=callback",
  port: 1234,
  callbackPath: "callback",
  onHandOff: vi.fn(),
  onDismissed: vi.fn(),
});
const flush = async () => {
  await new Promise((resolve) => setImmediate(resolve));
};

beforeEach(() => {
  for (const win of windows) win.destroyed = true;
  windows.length = 0;
  mocks.parent.minimized = false;
  mocks.parent.visible = true;
  vi.clearAllMocks();
});

describe("sign-in window trust and lifecycle", () => {
  it("never injects controls or handles Google requests on an external IdP", async () => {
    await openSignInWindow(options());
    const win = windows[0]!;
    win.url = "https://idp.example/signin";
    win.webContents.emit("did-finish-load");
    win.webContents.emit("console-message", {
      message: "abacus:sign-in-google",
      frame: win.webContents.mainFrame,
    });
    expect(win.webContents.executeJavaScript).not.toHaveBeenCalled();
  });

  it("ignores subframe requests even on the trusted page", async () => {
    const opts = options();
    await openSignInWindow(opts);
    windows[0]!.webContents.emit("console-message", {
      message: "abacus:sign-in-use-browser",
      frame: {},
    });
    expect(opts.onHandOff).not.toHaveBeenCalled();
  });

  it("rechecks the origin inside the injected API script after navigation", async () => {
    await openSignInWindow(options());
    const win = windows[0]!;
    win.webContents.emit("console-message", {
      message: "abacus:sign-in-google",
      frame: win.webContents.mainFrame,
    });
    await flush();
    const script = win.webContents.executeJavaScript.mock.calls[0]![0];
    const fetch = vi.fn();
    vm.runInNewContext(script, {
      location: { origin: "https://idp.example" },
      fetch,
    });
    expect(fetch).not.toHaveBeenCalled();
    await flush();
  });

  it("falls back if clearing the previous account session fails", async () => {
    mocks.clearStorageData.mockRejectedValueOnce(
      new Error("storage unavailable")
    );
    await expect(openSignInWindow(options())).rejects.toThrow(
      "storage unavailable"
    );
    expect(windows).toHaveLength(0);
  });

  it("closes provider popups when the attempt is released", async () => {
    const opts = options();
    const handle = await openSignInWindow(opts);
    const popup = new FakeWindow({ parent: windows[0]! });
    handle!.close();
    expect(popup.destroyed).toBe(true);
    expect(opts.onDismissed).not.toHaveBeenCalled();
  });

  it("does not open a late Google popup after cancellation", async () => {
    const handle = await openSignInWindow(options());
    const win = windows[0]!;
    let resolve!: (value: unknown) => void;
    win.webContents.executeJavaScript.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      })
    );
    win.webContents.emit("console-message", {
      message: "abacus:sign-in-google",
      frame: win.webContents.mainFrame,
    });
    handle!.close();
    resolve({ result: { google: "client" } });
    await flush();
    expect(windows).toHaveLength(1);
  });
  it("matches the exact Google callback path before consuming a code", async () => {
    await openSignInWindow(options());
    const win = windows[0]!;
    win.webContents.executeJavaScript.mockResolvedValueOnce({
      result: { google: "client" },
    });
    win.webContents.emit("console-message", {
      message: "abacus:sign-in-google",
      frame: win.webContents.mainFrame,
    });
    await flush();
    const popup = windows[1]!;
    const state = new URL(popup.url).searchParams.get("state");
    const event = {
      url: `https://abacus.ai/oauth/callback-other?state=${state}&code=wrong`,
      preventDefault: vi.fn(),
    };
    popup.webContents.emit("will-redirect", event);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(popup.destroyed).toBe(false);
    event.url = `https://abacus.ai/oauth/callback?state=${state}&code=correct`;
    popup.webContents.emit("will-redirect", event);
    await flush();
    expect(event.preventDefault).toHaveBeenCalled();
    expect(popup.destroyed).toBe(true);
    expect(win.webContents.executeJavaScript.mock.calls[1]![0]).toContain(
      "correct"
    );
  });

  it("guards provider popups against file navigations", async () => {
    await openSignInWindow(options());
    const win = windows[0]!;
    const popup = new FakeWindow({ parent: win });
    win.webContents.emit("did-create-window", popup);
    const event = { url: "file:///tmp/private", preventDefault: vi.fn() };
    popup.webContents.emit("will-navigate", event);
    expect(event.preventDefault).toHaveBeenCalled();
  });
});

describe("provider sessions from the default browser", () => {
  type Callback = (response: Record<string, unknown>) => void;
  const providerRequest = (url: string, resourceType = "mainFrame") => {
    const handler = mocks.onBeforeRequest.mock.calls.at(-1)![1] as (
      details: { url: string; resourceType: string },
      callback: Callback
    ) => void;
    const callback = vi.fn<Callback>();
    handler({ url, resourceType }, callback);
    return callback;
  };
  const google = "https://accounts.google.com/o/oauth2/v2/auth?client_id=x";
  const sid = {
    name: "SID",
    value: "v",
    domain: ".google.com",
    path: "/",
    expires: 2_000_000_000,
    size: 1,
    httpOnly: true,
    secure: true,
    session: false,
  };

  it("hold a provider page until the copy lands, as session cookies", async () => {
    let deliver!: (cookies: (typeof sid)[]) => void;
    await openSignInWindow({
      ...options(),
      providerCookies: new Promise((done) => {
        deliver = done;
      }),
    });

    const callback = providerRequest(google);
    await flush();
    expect(callback).not.toHaveBeenCalled();

    deliver([sid]);
    await flush();
    expect(mocks.cookies.set).toHaveBeenCalledWith(
      expect.objectContaining({ name: "SID", expirationDate: undefined })
    );
    expect(callback).toHaveBeenCalledWith({});
  });

  it("send a provider sign-in to the browser when there is no copy to be had", async () => {
    const opts = { ...options(), providerCookies: Promise.resolve(null) };
    await openSignInWindow(opts);

    const callback = providerRequest(google);
    await flush();

    expect(callback).toHaveBeenCalledWith({ cancel: true });
    expect(opts.onHandOff).toHaveBeenCalledTimes(1);
  });

  it("leave provider sign-ins in the window when none was asked for", async () => {
    const opts = options();
    await openSignInWindow(opts);

    const callback = providerRequest(
      "https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=x"
    );
    await flush();

    expect(opts.onHandOff).not.toHaveBeenCalled();
    expect(String(callback.mock.calls[0]![0].redirectURL)).toContain(
      "prompt=select_account"
    );
  });

  it("never hold a provider's scripts or images", async () => {
    await openSignInWindow({
      ...options(),
      providerCookies: new Promise(() => {}),
    });

    expect(providerRequest(google, "script")).toHaveBeenCalledWith({});
  });

  it("outlive the window, for the Gmail hop that follows on this session", async () => {
    const opts = { ...options(), providerCookies: Promise.resolve([sid]) };
    const handle = await openSignInWindow(opts);
    providerRequest(google);
    await flush();

    handle!.close();

    expect(mocks.cookies.remove).not.toHaveBeenCalledWith(
      "https://google.com/",
      "SID"
    );
  });
});

describe("sign-in window presentation", () => {
  const press = (win: FakeWindow, input: Record<string, unknown>) => {
    const event = { preventDefault: vi.fn() };
    win.webContents.emit("before-input-event", event, {
      type: "keyDown",
      isComposing: false,
      ...input,
    });
    return event;
  };

  it("opens as a modal sheet over the app, fitted and centred, with nowhere to minimize to", async () => {
    await openSignInWindow(options());
    const win = windows[0]!;

    expect(win.options).toMatchObject({
      parent: mocks.parent,
      modal: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      width: 520,
      height: 760,
      x: (1400 - 520) / 2,
      y: (900 - 760) / 2,
    });
    expect(win.show).toHaveBeenCalled();
    expect(win.focus).toHaveBeenCalled();
  });

  it("shrinks to fit a small app window without dropping below its minimum", async () => {
    const getBounds = mocks.parent.getBounds;
    mocks.parent.getBounds = () => ({ x: 0, y: 0, width: 400, height: 500 });
    try {
      await openSignInWindow(options());
    } finally {
      mocks.parent.getBounds = getBounds;
    }

    expect(windows[0]!.bounds).toMatchObject({ width: 380, height: 480 });
  });

  it("surfaces a minimized or hidden app before showing a sheet on it", async () => {
    mocks.parent.minimized = true;
    mocks.parent.visible = false;

    await openSignInWindow(options());

    expect(mocks.parent.restore).toHaveBeenCalled();
    expect(mocks.parent.show).toHaveBeenCalled();
  });

  it("dismisses on Escape, as the user's cancel", async () => {
    const opts = options();
    await openSignInWindow(opts);
    const win = windows[0]!;

    press(win, { key: "Enter" });
    press(win, { key: "Escape", isComposing: true });
    expect(win.destroyed).toBe(false);

    expect(press(win, { key: "Escape" }).preventDefault).toHaveBeenCalled();
    expect(win.destroyed).toBe(true);
    expect(opts.onDismissed).toHaveBeenCalledTimes(1);
    expect(opts.onHandOff).not.toHaveBeenCalled();
  });

  it("dismisses from the page's Cancel pill on the trusted page only", async () => {
    const opts = options();
    await openSignInWindow(opts);
    const win = windows[0]!;
    win.url = "https://apps.abacus.ai/bot/link/signin";

    win.webContents.emit("console-message", {
      message: "abacus:sign-in-cancel",
      frame: {},
    });
    expect(win.destroyed).toBe(false);

    win.webContents.emit("console-message", {
      message: "abacus:sign-in-cancel",
      frame: win.webContents.mainFrame,
    });
    expect(win.destroyed).toBe(true);
    expect(opts.onDismissed).toHaveBeenCalledTimes(1);
  });

  it("puts Cancel beside the browser pill", async () => {
    await openSignInWindow(options());
    const win = windows[0]!;
    win.url = "https://apps.abacus.ai/bot/link/signin";
    win.webContents.emit("did-finish-load");

    const script = win.webContents.executeJavaScript.mock.calls[0]![0];
    expect(script).toContain("abacus-cancel-sign-in");
    expect(script).toContain("abacus-use-browser");
  });

  it("keeps its own title over the page's", async () => {
    await openSignInWindow(options());
    const event = { preventDefault: vi.fn() };

    windows[0]!.emit("page-title-updated", event, "Google Accounts");

    expect(event.preventDefault).toHaveBeenCalled();
  });

  it("opens provider popups as modal sheets over the sign-in window", async () => {
    await openSignInWindow(options());
    const win = windows[0]!;
    const handler = win.webContents.setWindowOpenHandler.mock
      .calls[0]![0] as (details: { url: string; disposition: string }) => {
      action: string;
      overrideBrowserWindowOptions?: FakeWindowOptions;
    };

    const result = handler({
      url: "https://appleid.apple.com/auth/authorize",
      disposition: "new-window",
    });

    expect(result.overrideBrowserWindowOptions).toMatchObject({
      parent: win,
      modal: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
    });
  });

  it("closes only the popup on Escape in a provider popup", async () => {
    const opts = options();
    await openSignInWindow(opts);
    const win = windows[0]!;
    const popup = new FakeWindow({ parent: win });
    win.webContents.emit("did-create-window", popup);

    press(popup, { key: "Escape" });

    expect(popup.destroyed).toBe(true);
    expect(win.destroyed).toBe(false);
    expect(opts.onDismissed).not.toHaveBeenCalled();
  });

  it("closes only Google's popup on Escape, leaving the page as it was", async () => {
    const opts = options();
    await openSignInWindow(opts);
    const win = windows[0]!;
    win.webContents.executeJavaScript.mockResolvedValueOnce({
      result: { google: "client" },
    });
    win.webContents.emit("console-message", {
      message: "abacus:sign-in-google",
      frame: win.webContents.mainFrame,
    });
    await flush();
    const popup = windows[1]!;
    expect(popup.options).toMatchObject({ parent: win, modal: true });

    press(popup, { key: "Escape" });
    await flush();

    expect(popup.destroyed).toBe(true);
    expect(win.destroyed).toBe(false);
    expect(opts.onDismissed).not.toHaveBeenCalled();
    expect(opts.onHandOff).not.toHaveBeenCalled();
  });

  it("stays hidden while seeded, then presents as a sheet when the page needs the user", async () => {
    mocks.parent.visible = false;
    await openSignInWindow({
      ...options(),
      seedCookies: [
        {
          name: "sid",
          value: "v",
          domain: ".abacus.ai",
          path: "/",
          expires: 2_000_000_000,
          size: 1,
          httpOnly: true,
          secure: true,
          session: false,
        },
      ],
    });
    const win = windows[0]!;
    expect(win.show).not.toHaveBeenCalled();
    expect(mocks.parent.show).not.toHaveBeenCalled();

    win.webContents.emit(
      "did-navigate",
      {},
      "https://apps.abacus.ai/bot/link/signin"
    );

    expect(mocks.parent.show).toHaveBeenCalled();
    expect(win.show).toHaveBeenCalled();
    win.close();
  });

  it("closes a sign-in window still up when another opens", async () => {
    const first = options();
    await openSignInWindow(first);
    await openSignInWindow(options());

    expect(windows[0]!.destroyed).toBe(true);
    expect(first.onDismissed).toHaveBeenCalledTimes(1);
    expect(windows[1]!.destroyed).toBe(false);
  });
});
