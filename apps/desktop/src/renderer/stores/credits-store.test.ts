import { beforeEach, describe, expect, it } from "vitest";

import {
  CREDITS_EXHAUSTED_TTL_MS,
  isExhaustedMarkLive,
  useCreditsStore,
} from "./credits-store";

const state = () => useCreditsStore.getState();

beforeEach(() => {
  useCreditsStore.setState({ exhaustedAt: null });
});

describe("the credits store", () => {
  it("marks the moment the credits ran out, and clears it", () => {
    expect(state().exhaustedAt).toBeNull();
    state().markExhausted();
    expect(state().exhaustedAt).toBeTypeOf("number");
    state().clearExhausted();
    expect(state().exhaustedAt).toBeNull();
  });

  it("lets a mark lapse after a day", () => {
    const now = 1_000_000_000_000;
    expect(isExhaustedMarkLive(null, now)).toBe(false);
    expect(isExhaustedMarkLive(now - 60_000, now)).toBe(true);
    expect(isExhaustedMarkLive(now - CREDITS_EXHAUSTED_TTL_MS, now)).toBe(
      false
    );
  });
});
