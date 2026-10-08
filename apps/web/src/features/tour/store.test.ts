import { beforeEach, expect, it } from "vitest";

import { TOUR_STOPS } from "./stops";
import { startTour, tourStore, tourSignedOut } from "./store";
beforeEach(() => tourSignedOut());
it("four core stops and no replay before completion", () => {
  expect(TOUR_STOPS).toHaveLength(4);
  startTour({ origin: "/bots/new" });
  expect(tourStore.state.active).toBeNull();
  startTour({ origin: "/bots/new", onboarded: true });
  expect(tourStore.state.active?.origin).toBe("/bots/new");
  startTour({ origin: "/settings/general", onboarded: true });
  expect(tourStore.state.active?.origin).toBe("/bots/new");
  tourSignedOut();
  expect(tourStore.state.active).toBeNull();
});
