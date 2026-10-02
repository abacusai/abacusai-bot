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
      navigate: vi.fn(async () => {}),
    };
    deps[stage] = vi.fn(() => pending);
    startTour({ origin: "/old", onboarded: true });
    const work = completeTour("done", deps);
    await Promise.resolve();
    tourSignedOut();
    startTour({ origin: "/new", onboarded: true });
    resolve();
    await work;
    expect(deps.navigate).not.toHaveBeenCalled();
    expect(tourStore.state.active?.origin).toBe("/new");
    if (stage === "persist") expect(deps.telemetry).not.toHaveBeenCalled();
  }
);
it("valid completion persists and reports before returning to its origin", async () => {
  const calls: string[] = [];
  startTour({ origin: "/origin", onboarded: true });
  await completeTour("skipped", {
    persist: async () => {
      calls.push("persist");
    },
    telemetry: async () => {
      calls.push("telemetry");
    },
    navigate: async (origin) => {
      calls.push(origin);
    },
  });
  expect(calls).toEqual(["persist", "telemetry", "/origin"]);
  expect(tourStore.state.active).toBeNull();
});
