/**
 * The sign-in surface experiment: the server picks the arm, and every way the
 * pick can fail lands on the browser, the flow every earlier release shipped.
 * In the in-app arm the window is a convenience, never a dead end: a provider
 * hand-off or no window at all both fall back to the browser on the same
 * listener, and closing the window is a cancel.
 */
import { createHash } from "node:crypto";

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
  seedCookies?: unknown[];
  providerCookies?: Promise<unknown[] | null>;
};
let lastWindow: WindowOptions | null = null;
let windowAvailable = true;
let windowReady: Promise<void> | null = null;
const closeWindow = vi.fn();
vi.mock("./abacus-signin-window", () => ({
  openSignInWindow: async (options: WindowOptions) => {
    lastWindow = options;
    if (windowReady != null) await windowReady;
    return windowAvailable ? { close: closeWindow } : null;
  },
}));

// The cookies a picked browser profile hands over; empty when unreadable.
let profileCookies: unknown[] = [];
// The OS default browser's profile, when it is one the app can read.
let defaultProfile: { id: string; browserName: string } | null = null;
const providerSignInCookies = vi.fn(async (..._args: unknown[]) => [
  { name: "SID", value: "v", domain: ".google.com" },
]);
vi.mock("./abacus-browser-profiles", () => ({
  browserSignInCookies: async () => profileCookies,
  defaultSignInProfile: async () => defaultProfile,
  providerSignInCookies: (...args: unknown[]) => providerSignInCookies(...args),
}));

const { reportFunnelStep } = vi.hoisted(() => ({ reportFunnelStep: vi.fn() }));
vi.mock("../debug-sync/funnel-beacon", () => ({ reportFunnelStep }));

const openExternal = vi.mocked(shell.openExternal);
const loopbackFetch = globalThis.fetch;

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
  reportFunnelStep.mockClear();
  openExternal.mockReset();
  openExternal.mockResolvedValue(undefined);
  closeWindow.mockReset();
  lastWindow = null;
  windowAvailable = true;
  windowReady = null;
  profileCookies = [];
  defaultProfile = null;
  providerSignInCookies.mockClear();
});

afterEach(() => {
  cancelAbacusAuth();
  vi.unstubAllGlobals();
});

describe("sign-in funnel across surfaces", () => {
  it.each([true, false])(
    "reports one start with inAppSignIn=%s, including hand-off",
    async (inAppSignIn) => {
      answer({ success: true, result: { inAppSignIn } });
      void startAbacusAuth();
      await settle();
      expect(
        reportFunnelStep.mock.calls.filter(
          ([step]) => step === "signup_clicked"
        )
      ).toHaveLength(1);
      lastWindow?.onHandOff();
      expect(
        reportFunnelStep.mock.calls.filter(
          ([step]) => step === "signup_clicked"
        )
      ).toHaveLength(1);
      expect(openExternal).toHaveBeenCalledTimes(1);
    }
  );
});

describe("the sign-in path in the funnel", () => {
  const started = (): unknown =>
    reportFunnelStep.mock.calls.find(
      ([step]) => step === "signup_clicked"
    )?.[1];

  it.each([
    ["browser", false, false, null],
    ["window", true, false, null],
    ["window_providers", true, false, "chrome::Default"],
    ["window_session", true, true, "chrome::Default"],
  ] as const)(
    "is reported as %s",
    async (detail, inAppSignIn, withSession, defaultId) => {
      answer({ success: true, result: { inAppSignIn } });
      defaultProfile =
        defaultId == null ? null : { id: defaultId, browserName: "Chrome" };
      if (withSession)
        profileCookies = [{ name: "auth", value: "v", domain: ".abacus.ai" }];
      void startAbacusAuth(
        "signup",
        withSession ? "chrome::Default" : undefined
      );
      await settle();

      expect(started()).toBe(detail);
    }
  );
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

    expect(lastWindow?.url).toMatch(/\/bot\/link\/signin/);
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

  it("brings the default browser's provider sessions to a sign-up", async () => {
    defaultProfile = { id: "chrome::Default", browserName: "Google Chrome" };
    void startAbacusAuth();
    await settle();

    expect(providerSignInCookies).toHaveBeenCalledWith(defaultProfile);
    expect(await lastWindow?.providerCookies).toHaveLength(1);
  });

  it("marks provider sessions unavailable when the default browser is unreadable", async () => {
    void startAbacusAuth();
    await settle();

    expect(providerSignInCookies).not.toHaveBeenCalled();
    expect(await lastWindow?.providerCookies).toBeNull();
  });

  it("keeps a returning user in the window when the default browser is readable", async () => {
    defaultProfile = { id: "chrome::Default", browserName: "Google Chrome" };
    void startAbacusAuth("signin");
    await settle();

    expect(openExternal).not.toHaveBeenCalled();
    expect(new URL(lastWindow!.url).searchParams.has("isSignUp")).toBe(false);
  });

  it("reads no provider session for a picked profile's sign-in", async () => {
    defaultProfile = { id: "chrome::Default", browserName: "Google Chrome" };
    profileCookies = [{ name: "auth", value: "v", domain: ".abacus.ai" }];
    void startAbacusAuth("signin", "chrome::Default");
    await settle();

    expect(lastWindow?.providerCookies).toBeUndefined();
    expect(providerSignInCookies).not.toHaveBeenCalled();
  });

  it("sends a returning user to the browser's sign-in, not the window", async () => {
    void startAbacusAuth("signin");
    await settle();

    expect(lastWindow).toBeNull();
    const url = new URL(String(openExternal.mock.calls.at(-1)?.[0]));
    expect(url.searchParams.has("isSignUp")).toBe(false);
  });

  it("signs in with a picked browser profile's session in the window", async () => {
    profileCookies = [{ name: "auth", value: "v", domain: ".abacus.ai" }];
    // "signin" alone would go to the browser; the picked profile keeps it here.
    void startAbacusAuth("signin", "chrome::Default");
    await settle();

    expect(lastWindow?.seedCookies).toHaveLength(1);
    expect(openExternal).not.toHaveBeenCalled();
  });

  it("falls back to the plain flow when a picked profile has nothing to read", async () => {
    void startAbacusAuth("signin", "chrome::Default");
    await settle();

    expect(lastWindow).toBeNull();
    expect(openExternal).toHaveBeenCalledTimes(1);
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

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

const configResponse = () => ({
  ok: true,
  json: async () => ({ success: true, result: { inAppSignIn: true } }),
});

describe("sign-in startup races", () => {
  it("settles cancellation before config returns and never opens a surface", async () => {
    const config = deferred<ReturnType<typeof configResponse>>();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => config.promise)
    );
    const attempt = startAbacusAuth();
    cancelAbacusAuth();
    await expect(attempt).resolves.toMatchObject({
      ok: false,
      cancelled: true,
    });
    config.resolve(configResponse());
    await settle();
    expect(lastWindow).toBeNull();
    expect(openExternal).not.toHaveBeenCalled();
  });

  it("does not let an older config response supersede the latest attempt", async () => {
    const firstConfig = deferred<ReturnType<typeof configResponse>>();
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockImplementationOnce(() => firstConfig.promise)
        .mockResolvedValue(configResponse())
    );
    const first = startAbacusAuth();
    const second = startAbacusAuth();
    await expect(first).resolves.toMatchObject({ cancelled: true });
    await settle();
    const currentWindow = lastWindow;
    firstConfig.resolve(configResponse());
    await settle();
    expect(lastWindow).toBe(currentWindow);
    expect(closeWindow).not.toHaveBeenCalled();
    cancelAbacusAuth();
    await expect(second).resolves.toMatchObject({ cancelled: true });
  });

  it("launches no browser read for an attempt moved to the browser early", async () => {
    defaultProfile = { id: "chrome::Default", browserName: "Google Chrome" };
    const config = deferred<ReturnType<typeof configResponse>>();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => config.promise)
    );
    void startAbacusAuth();
    openAbacusAuthInBrowser();
    config.resolve(configResponse());
    await settle();

    expect(providerSignInCookies).not.toHaveBeenCalled();
    expect(reportFunnelStep).toHaveBeenCalledWith("signup_clicked", "browser");
  });

  it("remembers a browser request during the config lookup", async () => {
    const config = deferred<ReturnType<typeof configResponse>>();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => config.promise)
    );
    void startAbacusAuth();
    openAbacusAuthInBrowser();
    config.resolve(configResponse());
    await settle();
    expect(lastWindow).toBeNull();
    expect(openExternal).toHaveBeenCalledTimes(1);
  });

  it("closes a late window without cancelling the browser attempt", async () => {
    answer({ success: true, result: { inAppSignIn: true } });
    const ready = deferred<void>();
    windowReady = ready.promise;
    const attempt = startAbacusAuth();
    const finished = vi.fn();
    void attempt.then(finished);
    await settle();
    expect(lastWindow).not.toBeNull();
    openAbacusAuthInBrowser();
    // Dismissal during the pending window open must not cancel the hand-off.
    lastWindow?.onDismissed();
    ready.resolve();
    await settle();
    expect(closeWindow).toHaveBeenCalledTimes(1);
    expect(openExternal).toHaveBeenCalledTimes(1);
    expect(finished).not.toHaveBeenCalled();
    cancelAbacusAuth();
    await expect(attempt).resolves.toMatchObject({ cancelled: true });
  });
});

describe("compatibility with the browser sign-in flow", () => {
  it.each([
    ["flag off", { success: true, result: { inAppSignIn: false } }, true],
    ["older backend without the config endpoint", null, false],
    ["malformed config", { success: true, result: {} }, true],
  ])(
    "completes the existing PKCE exchange with %s",
    async (_case, body, ok) => {
      const apiFetch = vi
        .fn()
        .mockResolvedValueOnce({ ok, json: async () => body })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ success: true, result: { apiKey: "test-key" } }),
        });
      vi.stubGlobal("fetch", apiFetch);
      const attempt = startAbacusAuth();
      await settle();
      expect(lastWindow).toBeNull();
      expect(openExternal).toHaveBeenCalledTimes(1);
      const url = new URL(String(openExternal.mock.calls[0]![0]));
      expect(url.searchParams.get("isSignUp")).toBe("1");
      expect(url.searchParams.get("AbacusAIBot")).toBe("1");
      const callback = `http://127.0.0.1:${url.searchParams.get("botPort")}/${url.searchParams.get("botPath")}`;
      const response = await loopbackFetch(`${callback}?code=test-code`);
      expect(response.ok).toBe(true);
      await response.text();
      await expect(attempt).resolves.toMatchObject({
        ok: true,
        key: "test-key",
      });
      const exchange = JSON.parse(apiFetch.mock.calls[1]![1].body);
      expect(exchange.authCode).toBe("test-code");
      expect(exchange.signinVariant).toBe("browser");
      expect(
        createHash("sha256").update(exchange.verifier).digest("base64url")
      ).toBe(url.searchParams.get("botChallenge"));
      const result = await loopbackFetch(`${callback}/result`);
      expect(await result.json()).toEqual({ state: "ok" });
    }
  );

  it("ignores the developer in-app override in packaged builds", async () => {
    vi.stubEnv("ABACUSAI_BOT_SIGNIN_SURFACE", "in_app");
    try {
      answer({ success: true, result: { inAppSignIn: false } });
      expect(await resolveSignInVariant()).toBe("browser");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("falls back to the browser when the config request times out", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new DOMException("Timed out", "TimeoutError");
      })
    );
    void startAbacusAuth();
    await settle();
    expect(lastWindow).toBeNull();
    expect(openExternal).toHaveBeenCalledTimes(1);
  });
});
