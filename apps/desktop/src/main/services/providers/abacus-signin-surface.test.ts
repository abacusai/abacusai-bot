/**
 * The sign-in opens in the system browser, every time, and completes the PKCE
 * exchange on the loopback listener it told the browser to come back to.
 */
import { createHash } from "node:crypto";

import { shell } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { isPackaged: true, userAgentFallback: "" },
  shell: { openExternal: vi.fn() },
}));

const { reportFunnelStep } = vi.hoisted(() => ({ reportFunnelStep: vi.fn() }));
vi.mock("../debug-sync/funnel-beacon", () => ({ reportFunnelStep }));

const openExternal = vi.mocked(shell.openExternal);
const loopbackFetch = globalThis.fetch;

const { startAbacusAuth, cancelAbacusAuth } =
  await import("./abacus-auth-service");

/** Let the listener come up and the browser open. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 50));

beforeEach(() => {
  reportFunnelStep.mockClear();
  openExternal.mockReset();
  openExternal.mockResolvedValue(undefined);
});

afterEach(() => {
  cancelAbacusAuth();
  vi.unstubAllGlobals();
});

describe("the browser sign-in", () => {
  it("reports one start, in the browser", async () => {
    void startAbacusAuth();
    await settle();

    expect(
      reportFunnelStep.mock.calls.filter(([step]) => step === "signup_clicked")
    ).toEqual([["signup_clicked", "browser"]]);
    expect(openExternal).toHaveBeenCalledTimes(1);
  });

  it("sends a returning user to the sign-in form, not sign-up", async () => {
    void startAbacusAuth("signin");
    await settle();

    const url = new URL(String(openExternal.mock.calls.at(-1)?.[0]));
    expect(url.searchParams.has("isSignUp")).toBe(false);
  });

  it("settles a cancel before the browser opens and never opens it", async () => {
    const attempt = startAbacusAuth();
    cancelAbacusAuth();
    await expect(attempt).resolves.toMatchObject({
      ok: false,
      cancelled: true,
    });
    await settle();
    expect(openExternal).not.toHaveBeenCalled();
  });

  it("completes the PKCE exchange", async () => {
    const apiFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true, result: { apiKey: "test-key" } }),
    });
    vi.stubGlobal("fetch", apiFetch);
    const attempt = startAbacusAuth();
    await settle();
    expect(openExternal).toHaveBeenCalledTimes(1);
    const url = new URL(String(openExternal.mock.calls[0]![0]));
    expect(url.searchParams.get("isSignUp")).toBe("1");
    expect(url.searchParams.get("AbacusAIBot")).toBe("1");
    const callback = `http://127.0.0.1:${url.searchParams.get("botPort")}/${url.searchParams.get("botPath")}`;
    const response = await loopbackFetch(`${callback}?code=test-code`);
    expect(response.ok).toBe(true);
    await response.text();
    await expect(attempt).resolves.toEqual({ ok: true, key: "test-key" });
    const exchange = JSON.parse(apiFetch.mock.calls[0]![1].body);
    expect(exchange.authCode).toBe("test-code");
    expect(
      createHash("sha256").update(exchange.verifier).digest("base64url")
    ).toBe(url.searchParams.get("botChallenge"));
    const result = await loopbackFetch(`${callback}/result`);
    expect(await result.json()).toEqual({ state: "ok" });
  });
});

describe("a failed exchange", () => {
  /** Run one sign-in whose exchange request fails with `error`. */
  const failedReason = async (error: Error): Promise<unknown> => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValueOnce(error));
    const attempt = startAbacusAuth();
    await settle();
    const url = new URL(String(openExternal.mock.calls.at(-1)![0]));
    const callback = `http://127.0.0.1:${url.searchParams.get("botPort")}/${url.searchParams.get("botPath")}`;
    await (await loopbackFetch(`${callback}?code=test-code`)).text();
    await attempt;
    const result = await loopbackFetch(`${callback}/result`);
    return ((await result.json()) as { reason?: unknown }).reason;
  };

  it.each([
    [
      "Chromium's reason",
      new TypeError("fetch failed", {
        cause: new Error("net::ERR_NAME_NOT_RESOLVED"),
      }),
      "fetch_ERR_NAME_NOT_RESOLVED",
    ],
    [
      "Node's code",
      new TypeError("fetch failed", {
        cause: Object.assign(new Error("getaddrinfo"), { code: "ENOTFOUND" }),
      }),
      "fetch_ENOTFOUND",
    ],
    ["the error class alone", new TypeError("fetch failed"), "fetch_TypeError"],
  ])("names %s", async (_, error, reason) => {
    await expect(failedReason(error)).resolves.toBe(reason);
  });
});
