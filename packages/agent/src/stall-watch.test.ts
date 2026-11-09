/**
 * The model-stall watch counts awake time: a call the machine slept through
 * gets its whole window again on wake instead of being read as silent.
 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { setHostConnectivity } from "./connectivity.js";
import { StallWatch } from "./stall-watch.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const watch = () => {
  const stalls: number[] = [];
  const stall = new StallWatch({
    turnRunning: () => true,
    toolsRunning: () => 0,
    onStall: () => stalls.push(Date.now()),
    stallMs: () => 120_000,
  });
  return { stall, stalls };
};

it("restarts an armed window on wake", () => {
  const { stall, stalls } = watch();
  stall.note("message_start");
  vi.advanceTimersByTime(100_000);
  setHostConnectivity("online", true);
  vi.advanceTimersByTime(100_000);
  expect(stalls).toEqual([]);
  vi.advanceTimersByTime(20_000);
  expect(stalls).toHaveLength(1);
});

it("does not arm a window nobody is waiting on", () => {
  const { stalls } = watch();
  setHostConnectivity("online", true);
  vi.advanceTimersByTime(10 * 60_000);
  expect(stalls).toEqual([]);
});
