import { beforeEach, expect, it } from "vitest";

import { TOUR_STOPS } from "./stops";
import { startTour, tourStore, tourSignedOut } from "./store";
beforeEach(() => tourSignedOut());
it("four core stops and no replay before completion", () => {
  expect(TOUR_STOPS).toHaveLength(4);
  startTour({});
  expect(tourStore.state.active).toBeNull();
  startTour({ onboarded: true });
  const run = tourStore.state.active?.runId;
  expect(run).toBeDefined();
  startTour({ onboarded: true });
  expect(tourStore.state.active?.runId).toBe(run);
  tourSignedOut();
  expect(tourStore.state.active).toBeNull();
});
