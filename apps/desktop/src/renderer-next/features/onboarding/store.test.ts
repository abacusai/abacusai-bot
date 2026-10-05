import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Transport } from "#next/data/transport";
import type { AbacusAuthOutcome } from "#shared/contracts";

import { onboardingStore, startSignIn, cancelSignIn } from "./store";
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
beforeEach(() =>
  onboardingStore.setState(() => ({ signIn: null, createdBotId: null }))
);
describe("R6-T7 sign-in tokens", () => {
  it("mints the attempt synchronously and refuses double start", async () => {
    const gate = deferred<AbacusAuthOutcome>();
    const start = vi.fn(() => gate.promise);
    const transport = {
      client: { auth: { abacus: { start, cancel: async () => {} } } },
    } as unknown as Transport;
    expect(startSignIn(transport, "signin", undefined, vi.fn())).toBe(true);
    expect(onboardingStore.state.signIn?.status).toBe("pending");
    expect(startSignIn(transport, "signup", undefined, vi.fn())).toBe(false);
    expect(start).toHaveBeenCalledOnce();
    gate.resolve({ ok: true });
    await gate.promise;
  });
  it("ignores a cancelled attempt delivered after a new attempt", async () => {
    const old = deferred<AbacusAuthOutcome>();
    const fresh = deferred<AbacusAuthOutcome>();
    const start = vi
      .fn()
      .mockReturnValueOnce(old.promise)
      .mockReturnValueOnce(fresh.promise);
    const settled = vi.fn();
    const transport = {
      client: { auth: { abacus: { start, cancel: async () => {} } } },
    } as unknown as Transport;
    startSignIn(transport, "signin", undefined, settled);
    const oldId = onboardingStore.state.signIn!.id;
    await cancelSignIn(transport);
    startSignIn(transport, "signin", undefined, settled);
    expect(onboardingStore.state.signIn!.id).not.toBe(oldId);
    old.resolve({ ok: true });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    fresh.resolve({ ok: false, error: "unidentified-account" });
    await vi.waitFor(() =>
      expect(onboardingStore.state.signIn?.status).toBe("failed")
    );
    expect(settled).toHaveBeenCalledOnce();
  });
});
