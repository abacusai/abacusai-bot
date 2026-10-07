import { afterEach, describe, expect, it, vi } from "vitest";

import {
  claimAnimation,
  MAX_ANIMATED_AVATARS,
  observeAvatar,
  subscribeClock,
} from "./clock";
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
describe("avatar scheduling", () => {
  it("shares one timer, suspends it when hidden, and removes it after the last avatar", () => {
    vi.useFakeTimers();
    let hidden = false;
    vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
    const first = vi.fn();
    const second = vi.fn();
    const a = subscribeClock(first);
    const b = subscribeClock(second);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(100);
    expect(first).toHaveBeenCalled();
    expect(second).toHaveBeenCalled();
    hidden = true;
    document.dispatchEvent(new Event("visibilitychange"));
    expect(vi.getTimerCount()).toBe(0);
    expect(first.mock.lastCall?.[1]).toBe(false);
    hidden = false;
    document.dispatchEvent(new Event("visibilitychange"));
    expect(vi.getTimerCount()).toBe(1);
    a();
    expect(vi.getTimerCount()).toBe(1);
    b();
    expect(vi.getTimerCount()).toBe(0);
    vi.restoreAllMocks();
  });
  it("pauses the clock on blur and resumes on focus", () => {
    vi.useFakeTimers();
    const listener = vi.fn();
    const dispose = subscribeClock(listener);
    window.dispatchEvent(new Event("blur"));
    expect(vi.getTimerCount()).toBe(0);
    expect(listener.mock.lastCall?.[1]).toBe(false);
    window.dispatchEvent(new Event("focus"));
    expect(vi.getTimerCount()).toBe(1);
    dispose();
  });
  it("caps ambient avatars and admits speech before idle", () => {
    const active = new Map<number, boolean>();
    const releases = Array.from({ length: 60 }, (_, i) =>
      claimAnimation((value) => active.set(i, value), 0)
    );
    expect([...active.values()].filter(Boolean)).toHaveLength(
      MAX_ANIMATED_AVATARS
    );
    const speech = claimAnimation((value) => active.set(60, value), 2);
    expect(active.get(60)).toBe(true);
    expect([...active.values()].filter(Boolean)).toHaveLength(
      MAX_ANIMATED_AVATARS
    );
    speech();
    releases.forEach((dispose) => dispose());
    active.delete(60);
    const returning = Array.from({ length: 60 }, (_, i) =>
      claimAnimation((value) => active.set(i, value), 0)
    );
    expect([...active.values()].filter(Boolean)).toHaveLength(
      MAX_ANIMATED_AVATARS
    );
    returning.forEach((dispose) => dispose());
  });
  it("shares an observer and unobserves removed avatars", () => {
    const disconnect = vi.fn();
    const unobserve = vi.fn();
    const observe = vi.fn();
    const constructor = vi.fn(function () {
      return { observe, unobserve, disconnect };
    });
    vi.stubGlobal("IntersectionObserver", constructor);
    const a = observeAvatar(document.createElement("span"), vi.fn());
    const b = observeAvatar(document.createElement("span"), vi.fn());
    expect(constructor).toHaveBeenCalledTimes(1);
    expect(observe).toHaveBeenCalledTimes(2);
    a();
    expect(disconnect).not.toHaveBeenCalled();
    b();
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(unobserve).toHaveBeenCalledTimes(2);
  });
});
