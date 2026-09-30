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
}));

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
  constructor(readonly options: { parent?: FakeWindow }) {
    super();
    windows.push(this);
  }
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
    constructor(options: { parent?: FakeWindow }) {
      return new FakeWindow(options);
    }
  },
  session: {
    fromPath: () => ({
      ...mocks,
      webRequest: { onBeforeRequest: mocks.onBeforeRequest },
    }),
  },
  shell: { openExternal: vi.fn() },
}));
vi.mock("../../bring-to-front", () => ({
  parentWindow: () => ({}),
  presentAsDialog: vi.fn(),
}));
vi.mock("../../profile-home", () => ({
  profileBaseDir: () => "/tmp/signin-window-test",
}));
const { openSignInWindow } = await import("./abacus-signin-window");
const options = () => ({
  url: "https://apps.abacus.ai/chatllm/signin?botChallenge=test&botPort=1234&botPath=callback",
  port: 1234,
  callbackPath: "callback",
  onHandOff: vi.fn(),
  onDismissed: vi.fn(),
});
const flush = async () => {
  await new Promise((resolve) => setImmediate(resolve));
};

beforeEach(() => {
  windows.length = 0;
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

  it("are removed when the window closes", async () => {
    const opts = { ...options(), providerCookies: Promise.resolve([sid]) };
    const handle = await openSignInWindow(opts);
    providerRequest(google);
    await flush();

    handle!.close();

    expect(mocks.cookies.remove).toHaveBeenCalledWith(
      "https://google.com/",
      "SID"
    );
  });
});
