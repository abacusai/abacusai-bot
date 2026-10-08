import { act, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { PromoCharacter } from "./promo-character";

const state = vi.hoisted(() => ({ admitted: true, preference: "full" }));
vi.mock("@tanstack/react-db", () => ({
  eq: vi.fn(),
  useLiveQuery: () => ({ data: undefined }),
}));
vi.mock("@tanstack/react-router", () => ({ useRouterState: () => "" }));
vi.mock("#renderer/data/db", () => ({ useCollections: () => ({}) }));
vi.mock("#renderer/lib/motion", () => ({
  useMotionPreference: () => state.preference,
}));
vi.mock("#renderer/components/bot-avatar", () => ({
  BotAvatar: ({ mood }: { mood: string }) => (
    <span
      data-testid="avatar"
      data-slot="bot-avatar"
      data-animate={state.admitted ? "" : undefined}
      data-mood={mood}
    />
  ),
}));
afterEach(() => {
  vi.useRealTimers();
  state.admitted = true;
  state.preference = "full";
});
const props = { remaining: 30, total: 100, excited: false, upgraded: false };
it("greets once and winks only while the shared rig admits its animation", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const view = render(<PromoCharacter {...props} />);
  const mood = () => screen.getByTestId("avatar").dataset.mood;
  expect(mood()).toBe("happy");
  act(() => vi.advanceTimersByTime(600));
  expect(mood()).toBe("idle");
  act(() => vi.advanceTimersByTime(30_000));
  expect(mood()).toBe("wink");
  state.admitted = false;
  await act(async () => {
    screen
      .getByTestId("avatar")
      .toggleAttribute("data-animate", state.admitted);
  });
  expect(mood()).toBe("idle");
  expect(vi.getTimerCount()).toBe(0);
  state.admitted = true;
  await act(async () => {
    screen
      .getByTestId("avatar")
      .toggleAttribute("data-animate", state.admitted);
  });
  expect(mood()).toBe("idle");
  state.preference = "reduced";
  view.rerender(<PromoCharacter {...props} />);
  expect(vi.getTimerCount()).toBe(0);
  act(() => vi.advanceTimersByTime(60_000));
  expect(mood()).toBe("idle");
});
it("credit exhaustion and CTA/upgrade reactions take precedence and unmount stops timers", () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const view = render(<PromoCharacter {...props} remaining={0} />);
  expect(screen.getByTestId("avatar").dataset.mood).toBe("asleep");
  expect(vi.getTimerCount()).toBe(0);
  view.rerender(<PromoCharacter {...props} excited />);
  expect(screen.getByTestId("avatar").dataset.mood).toBe("excited");
  view.rerender(<PromoCharacter {...props} upgraded />);
  expect(screen.getByTestId("avatar").dataset.mood).toBe("happy");
  view.unmount();
  expect(vi.getTimerCount()).toBe(0);
});
