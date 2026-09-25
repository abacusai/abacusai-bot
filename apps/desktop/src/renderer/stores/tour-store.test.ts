/**
 * The tour runs when it is started, and at no other time.
 *
 * There is deliberately no persisted "already seen" flag to assert on. One
 * used to exist, and the gate started a lap whenever it was missing, so a
 * cleared localStorage looked exactly like a new user, and the launch that
 * moved Electron's userData showed the welcome tour to everybody who
 * took the update. Signing out or in changes nothing but closing an open lap.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { useTourStore } from "./tour-store";

const state = () => useTourStore.getState();

beforeEach(() => {
  useTourStore.setState({ isOpen: false, runId: 0 });
});

describe("starting and leaving", () => {
  it("treats a skip exactly like finishing: the lap is over either way", () => {
    state().open();
    state().close();

    expect(state().isOpen).toBe(false);
  });

  it("gives every start a run of its own, so no stale instance survives", () => {
    state().open();
    const first = state().runId;
    state().close();
    state().open();

    expect(state().runId).toBeGreaterThan(first);
  });

  it("persists nothing: a tour is never owed across a launch", () => {
    state().open();
    state().close();

    expect(window.localStorage.getItem("abacusai-bot-tour")).toBeNull();
  });
});

describe("signing out", () => {
  it("closes a tour of an app being left, and owes nothing after", () => {
    state().open();
    state().signedOut();

    expect(state().isOpen).toBe(false);
  });
});

describe("restarting onboarding", () => {
  it("drops a replay still up, and re-runs Tourlight for the new flow", () => {
    state().open();
    const first = state().runId;
    state().reset();

    expect(state().isOpen).toBe(false);
    expect(state().runId).toBeGreaterThan(first);
  });
});
