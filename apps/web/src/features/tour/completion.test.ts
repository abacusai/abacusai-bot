import { afterEach, expect, it, vi } from "vitest";

import { completeTour } from "./completion";
import { startTour, tourSignedOut, tourStore } from "./store";
afterEach(tourSignedOut);
it.each(["persist", "telemetry"] as const)(
  "sign-out during %s invalidates completion and preserves a replacement run",
  async (stage) => {
    let resolve!: () => void;
    const pending = new Promise<void>((r) => {
      resolve = r;
    });
    const deps = {
      persist: vi.fn(async () => {}),
      telemetry: vi.fn(async () => {}),
    };
    deps[stage] = vi.fn(() => pending);
    startTour({ onboarded: true });
    const work = completeTour("done", deps);
    await Promise.resolve();
    tourSignedOut();
    startTour({ onboarded: true });
    resolve();
    await work;
    expect(tourStore.state.active?.stopIndex).toBe(0);
    if (stage === "persist") expect(deps.telemetry).not.toHaveBeenCalled();
  }
);
it("valid completion persists and reports before clearing its run", async () => {
  const calls: string[] = [];
  startTour({ onboarded: true });
  await completeTour("skipped", {
    persist: async () => {
      calls.push("persist");
    },
    telemetry: async () => {
      calls.push("telemetry");
    },
  });
  expect(calls).toEqual(["persist", "telemetry"]);
  expect(tourStore.state.active).toBeNull();
});
