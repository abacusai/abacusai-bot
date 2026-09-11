/**
 * The confirmation a browser sign-in cannot give itself.
 *
 * The hop happens in the browser, so the app is not the window the user is
 * watching while it finishes. Coming back to a step that has quietly advanced
 * is not the same as being told the account is connected.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const success = vi.fn();
vi.mock("sonner", () => ({ toast: { success } }));
vi.mock("../i18n", () => ({ default: { t: (key: string) => key } }));

const { signInToAbacus } = await import("./abacus-sign-in");

const startAbacusAuth = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  (globalThis.window as unknown as { api: unknown }).api = {
    agent: { startAbacusAuth },
  };
});

describe("signing in to Abacus.AI", () => {
  it("says so once it worked", async () => {
    startAbacusAuth.mockResolvedValue({ ok: true });

    await expect(signInToAbacus()).resolves.toEqual({ ok: true });
    expect(success).toHaveBeenCalledWith("onboarding.abacusConnected");
  });

  it("stays quiet when the user cancelled, which is a decision", async () => {
    startAbacusAuth.mockResolvedValue({ ok: false, cancelled: true });

    await signInToAbacus();

    expect(success).not.toHaveBeenCalled();
  });

  it("stays quiet on a failure, which the caller already reports", async () => {
    startAbacusAuth.mockResolvedValue({ ok: false, error: "nope" });

    const result = await signInToAbacus();

    expect(success).not.toHaveBeenCalled();
    // The caller needs the reason, so it is handed back untouched.
    expect(result).toEqual({ ok: false, error: "nope" });
  });
});
