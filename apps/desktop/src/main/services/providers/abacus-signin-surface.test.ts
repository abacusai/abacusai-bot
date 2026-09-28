/**
 * The sign-in surface experiment: the server picks the arm, and every way the
 * pick can fail lands on the browser, the flow every earlier release shipped.
 * In the in-app arm the window is a convenience, never a dead end: a provider
 * hand-off or no window at all both fall back to the browser on the same
 * listener, and closing the window is a cancel.
 */
import { shell } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { isPackaged: true, userAgentFallback: "" },
  shell: { openExternal: vi.fn() },
}));
vi.mock("../debug-sync/device-id", () => ({ deviceId: () => "device-1" }));

type WindowOptions = {
  url: string;
  onHandOff: () => void;
  onDismissed: () => void;
};
let lastWindow: WindowOptions | null = null;
let windowAvailable = true;
const closeWindow = vi.fn();
vi.mock("./abacus-signin-window", () => ({
  openSignInWindow: async (options: WindowOptions) => {
    lastWindow = options;
    return windowAvailable ? { close: closeWindow } : null;
  },
}));

const openExternal = vi.mocked(shell.openExternal);

const { resolveSignInVariant, resetSignInVariantCache } =
  await import("./abacus-signin-config");
const { startAbacusAuth, cancelAbacusAuth, openAbacusAuthInBrowser } =
  await import("./abacus-auth-service");

const answer = (body: unknown, ok = true): void => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok, json: async () => body }))
  );
};

/** Let the listener come up and the surface open. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 50));

beforeEach(() => {
  resetSignInVariantCache();
  openExternal.mockReset();
  openExternal.mockResolvedValue(undefined);
  closeWindow.mockReset();
  lastWindow = null;
  windowAvailable = true;
});

afterEach(() => {
  cancelAbacusAuth();
  vi.unstubAllGlobals();
});

describe("the assigned sign-in arm", () => {
  it("is the app window when the server says so", async () => {
    answer({ success: true, result: { inAppSignIn: true } });

    expect(await resolveSignInVariant()).toBe("in_app");
  });

  it.each([
    [
      "the server says no",
      { success: true, result: { inAppSignIn: false } },
      true,
    ],
    ["the call fails", { success: false }, true],
    ["the response is an error", null, false],
  ])("is the browser when %s", async (_case, body, ok) => {
    answer(body, ok);

    expect(await resolveSignInVariant()).toBe("browser");
  });

  it("is the browser when the server cannot be reached", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("offline");
      })
    );

    expect(await resolveSignInVariant()).toBe("browser");
  });
});

describe("an in-app sign-in", () => {
  beforeEach(() => answer({ success: true, result: { inAppSignIn: true } }));

  it("opens the sign-up page in the app, not the browser", async () => {
    void startAbacusAuth();
    await settle();

    expect(lastWindow?.url).toMatch(/\/chatllm\/signin/);
    expect(openExternal).not.toHaveBeenCalled();
  });

  it("continues in the browser when a provider needs it", async () => {
    void startAbacusAuth();
    await settle();
    lastWindow?.onHandOff();

    expect(openExternal).toHaveBeenCalledWith(lastWindow?.url);
  });

  it("moves to the browser on request, closing the window", async () => {
    void startAbacusAuth();
    await settle();
    openAbacusAuthInBrowser();

    expect(closeWindow).toHaveBeenCalled();
    expect(openExternal).toHaveBeenCalledWith(lastWindow?.url);
  });

  it("uses the browser when there is no window to open", async () => {
    windowAvailable = false;
    void startAbacusAuth();
    await settle();

    expect(openExternal).toHaveBeenCalledTimes(1);
  });

  it("is cancelled when the user closes the window", async () => {
    const attempt = startAbacusAuth();
    await settle();
    lastWindow?.onDismissed();

    const result = await attempt;
    expect(result.ok === false && result.cancelled).toBe(true);
  });
});
