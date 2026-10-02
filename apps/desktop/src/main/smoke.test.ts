import { expect, it, vi } from "vitest";

import { runSmoke } from "./smoke";
it.each([
  "ready",
  "n/a",
  "disabled: probe failed",
  "disabled: no internal display",
  "disabled: no cut-out",
  "disabled: off by pref",
] as const)(
  "R7-T16: ready renderer and %s companion exit successfully",
  async (companion) => {
    const log = vi.fn();
    expect(
      await runSmoke({
        renderer: async () => "ready",
        companion: () => companion,
        log,
      })
    ).toBe(0);
    expect(log).toHaveBeenCalledWith(`[smoke] notch ${companion}`);
  }
);
it("a failed renderer includes the readiness reason and fails", async () => {
  const log = vi.fn();
  expect(
    await runSmoke({
      renderer: async () => "failed",
      rendererReason: () => "tables unavailable",
      companion: () => "ready",
      log,
    })
  ).toBe(1);
  expect(log).toHaveBeenCalledWith(
    "[smoke] renderer failed: tables unavailable"
  );
});
it("both never-ready surfaces are bounded", async () => {
  vi.useFakeTimers();
  try {
    const log = vi.fn();
    const result = runSmoke({
      renderer: () => new Promise(() => {}),
      companion: () => "pending",
      timeoutMs: 90000,
      log,
    });
    await vi.advanceTimersByTimeAsync(90000);
    expect(await result).toBe(1);
    expect(log).toHaveBeenCalledWith("[smoke] renderer timeout");
    expect(log).toHaveBeenCalledWith("[smoke] notch failed");
  } finally {
    vi.useRealTimers();
  }
});
