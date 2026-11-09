/**
 * The power clock: suspend and resume are logged and kept, so a deadline can
 * leave out the time the machine slept; a tick while still "asleep" means the
 * OS never sent its resume.
 */
import { describe, expect, it } from "vitest";

import { ConnectivityService } from "./connectivity-service";

const clock = () => {
  const state = { now: 1_000_000, log: [] as string[] };
  const service = new ConnectivityService({
    probe: async () => true,
    now: () => state.now,
    log: (line) => state.log.push(line),
  });
  return { state, service };
};

describe("the power clock", () => {
  it("counts only the sleep inside the window, the current one included", () => {
    const { state, service } = clock();
    const start = state.now;
    state.now += 10 * 60_000;
    service.suspended();
    state.now += 40 * 60_000;
    // Still asleep: the open sleep counts up to now.
    expect(service.asleepBetween(start, state.now)).toBe(40 * 60_000);
    service.resumed();
    state.now += 5 * 60_000;
    expect(service.asleepBetween(start, state.now)).toBe(40 * 60_000);
    // A window that starts mid-sleep counts only its part.
    expect(service.asleepBetween(start + 30 * 60_000, state.now)).toBe(
      20 * 60_000
    );
    expect(service.asleepBetween(state.now - 60_000, state.now)).toBe(0);
    expect(state.log[0]).toMatch(/^\[power\] suspend at /);
    expect(state.log[1]).toMatch(/^\[power\] resume at .* after 2400s asleep$/);
  });

  it("a second suspend before the resume does not restart the sleep", () => {
    const { state, service } = clock();
    const start = state.now;
    service.suspended();
    state.now += 60_000;
    service.suspended();
    state.now += 60_000;
    service.resumed();
    expect(service.asleepBetween(start, state.now)).toBe(120_000);
  });

  it("says a resume was lost once a tick finds it asleep for over a minute", () => {
    const { state, service } = clock();
    expect(service.missedResume()).toBe(false);
    service.suspended();
    state.now += 30_000;
    expect(service.missedResume()).toBe(false);
    state.now += 60_000;
    expect(service.missedResume()).toBe(true);
    service.resumed();
    expect(service.missedResume()).toBe(false);
  });

  it("forgets sleeps older than a day", () => {
    const { state, service } = clock();
    const start = state.now;
    service.suspended();
    state.now += 60_000;
    service.resumed();
    state.now += 25 * 60 * 60_000;
    service.suspended();
    state.now += 60_000;
    service.resumed();
    expect(service.asleepBetween(start, state.now)).toBe(60_000);
  });
});
