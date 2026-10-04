import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { Transport } from "#renderer/data/transport";
import {
  onboardingStore,
  startSignIn,
} from "#renderer/features/onboarding/store";

beforeEach(() => {
  onboardingStore.setState(() => ({ signIn: null, createdBotId: null }));
});
afterEach(() => vi.unstubAllGlobals());

it.each([
  ["host-start", "UNAUTHORIZED", "host-start:rejected:UNAUTHORIZED"],
  ["host-complete", "UNAUTHORIZED", "host-complete:rejected:UNAUTHORIZED"],
  ["host-complete", "secret-token", "host-complete:rejected:UNKNOWN"],
  ["host-start", "network", "host-start:network:UNKNOWN"],
  ["host-complete", "network", "host-complete:network:UNKNOWN"],
  ["auth-code", "rejected", "auth-code:rejected:UNKNOWN"],
  ["auth-code", "invalid", "auth-code:rejected:UNKNOWN"],
  ["auth-code", "session", "auth-code:session:UNKNOWN"],
  ["auth-code", "network", "auth-code:network:UNKNOWN"],
])(
  "preserves sanitized %s failures (%s) in the attempt",
  async (stage, reason, expected) => {
    const rawError =
      reason === "network"
        ? new Error("WebSocket closed: secret-token")
        : Object.assign(
            new Error("secret-token secret-code secret-challenge"),
            { code: reason, data: { token: "secret-token" } }
          );
    const start = vi.fn(async () => ({ challenge: "secret-challenge" }));
    const complete = vi.fn(async () => ({}));
    if (stage === "host-start") start.mockRejectedValue(rawError);
    if (stage === "host-complete") complete.mockRejectedValue(rawError);
    const fetch = vi.fn(async () =>
      Response.json({ success: true, result: { authCode: "secret-code" } })
    );
    if (stage === "auth-code") {
      if (reason === "network")
        fetch.mockRejectedValue(new TypeError("secret-token"));
      else
        fetch.mockResolvedValue(
          Response.json(
            reason === "invalid"
              ? { success: true, result: {} }
              : {
                  success: false,
                  error: "secret-token",
                  errorType: reason === "session" ? "NotLoggedIn" : "Failure",
                },
            { status: reason === "session" ? 401 : 200 }
          )
        );
    }
    vi.stubGlobal("fetch", fetch);
    const transport = {
      client: { auth: { web: { start, complete } } },
    } as unknown as Transport;
    const settled = vi.fn();
    expect(startSignIn(transport, "signin", undefined, settled)).toBe(true);
    expect(onboardingStore.state.signIn?.status).toBe("pending");
    await vi.waitFor(() =>
      expect(onboardingStore.state.signIn?.status).toBe("failed")
    );
    expect(onboardingStore.state.signIn?.outcome).toEqual({
      ok: false,
      error: expected,
    });
    expect(settled).toHaveBeenCalledWith({ ok: false, error: expected });
    expect(JSON.stringify(onboardingStore.state)).not.toContain("secret-");
    if (stage !== "host-complete") expect(complete).not.toHaveBeenCalled();
  }
);
