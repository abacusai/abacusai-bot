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

/** The loopback callback the last opened browser tab was sent to. */
const lastCallback = (): { url: string; challenge: string } => {
  const url = new URL(String(openExternal.mock.calls.at(-1)?.[0]));
  return {
    url: `http://127.0.0.1:${url.searchParams.get("botPort")}/${url.searchParams.get("botPath")}`,
    challenge: url.searchParams.get("botChallenge") ?? "",
  };
};

/** Let the listener come up and the browser open. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 50));

beforeEach(() => {
  reportFunnelStep.mockClear();
  openExternal.mockReset();
  openExternal.mockResolvedValue(undefined);
});

afterEach(() => {
  cancelAbacusAuth({ everyAttempt: true });
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

  it("lets a tab from an earlier press finish a later one, with that press's verifier", async () => {
    const apiFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, result: { apiKey: "test-key" } }),
    });
    vi.stubGlobal("fetch", apiFetch);
    const first = startAbacusAuth();
    await settle();
    const firstTab = lastCallback();
    // Cancel, then press again: what the connect screen does on a retry.
    cancelAbacusAuth();
    await expect(first).resolves.toMatchObject({ cancelled: true });
    const second = startAbacusAuth();
    await settle();
    const secondTab = lastCallback();
    expect(secondTab.url).not.toBe(firstTab.url);

    const response = await loopbackFetch(`${firstTab.url}?code=first-code`);
    await response.text();
    await expect(second).resolves.toEqual({ ok: true, key: "test-key" });
    const exchange = JSON.parse(apiFetch.mock.calls[0]![1].body);
    expect(exchange.authCode).toBe("first-code");
    expect(
      createHash("sha256").update(exchange.verifier).digest("base64url")
    ).toBe(firstTab.challenge);
    // Single use, and the losing press's listener is gone.
    const replay = await loopbackFetch(`${firstTab.url}?code=first-code`);
    expect(replay.status).toBe(409);
    await expect(
      loopbackFetch(`${secondTab.url}?code=second-code`)
    ).rejects.toThrow();
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });

  it("mints no key for a tab that comes back when no press is waiting", async () => {
    const apiFetch = vi.fn();
    vi.stubGlobal("fetch", apiFetch);
    const attempt = startAbacusAuth();
    await settle();
    const tab = lastCallback();
    cancelAbacusAuth();
    await expect(attempt).resolves.toMatchObject({ cancelled: true });

    const response = await loopbackFetch(`${tab.url}?code=late-code`);
    await response.text();
    const result = await loopbackFetch(`${tab.url}/result`);
    expect(await result.json()).toEqual({
      state: "failed",
      reason: "cancelled",
    });
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("closes every press's listener on sign-out", async () => {
    void startAbacusAuth();
    await settle();
    const tab = lastCallback();
    cancelAbacusAuth({ everyAttempt: true });
    await settle();
    await expect(loopbackFetch(`${tab.url}?code=any`)).rejects.toThrow();
  });
});
