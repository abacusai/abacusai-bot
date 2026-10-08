import { act, fireEvent, render, screen } from "@testing-library/react";
import { animate } from "motion/react";
import { afterEach, expect, it, vi } from "vitest";

import { setMediaMatches } from "#renderer/test-support/media";

import { TabLabel } from "./tab-label";
const preference = vi.hoisted(() => ({ value: "full" }));
const stop = vi.hoisted(() => vi.fn());
vi.mock("#renderer/lib/motion", () => ({
  durations: { tabTitleDelay: 400 },
  useMotionPreference: () => preference.value,
}));
vi.mock("motion/react", async (original) => ({
  ...(await original<typeof import("motion/react")>()),
  animate: vi.fn(() => ({ stop })),
}));
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  preference.value = "full";
});
const mount = (iconOnly = false) => {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(60);
  vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockReturnValue(240);
  setMediaMatches({ "(hover: hover)": true });
  return render(
    <button role="tab">
      <TabLabel label="A long workspace filename.ts" iconOnly={iconOnly} />
    </button>
  );
};
it("reveals a clipped title after 400ms on hover and stops on leave", () => {
  const view = mount();
  const tab = screen.getByRole("tab");
  fireEvent.pointerEnter(tab);
  expect(animate).toHaveBeenCalledWith(
    expect.anything(),
    [0, -180],
    expect.objectContaining({ delay: 0.4, repeatType: "reverse" })
  );
  expect(view.container.querySelector("[data-marquee-active]")).not.toBeNull();
  fireEvent.pointerLeave(tab);
  expect(stop).toHaveBeenCalled();
  expect(view.container.querySelector("[data-marquee-active]")).toBeNull();
  expect(tab.textContent).toBe("A long workspace filename.ts");
});
it("also reveals on keyboard focus with the same fixed clip", () => {
  const view = mount();
  act(() => screen.getByRole("tab").focus());
  expect(view.container.querySelector("[data-marquee-active]")).not.toBeNull();
  expect(
    view.container.querySelector("[data-slot=tab-label]")!.clientWidth
  ).toBe(60);
});
it.each(["reduced", "icon-only"])("keeps %s labels static", (mode) => {
  preference.value = mode === "reduced" ? "reduced" : "full";
  const view = mount(mode === "icon-only");
  fireEvent.pointerEnter(screen.getByRole("tab"));
  act(() => screen.getByRole("tab").focus());
  expect(animate).not.toHaveBeenCalled();
  expect(view.container.querySelector("[data-marquee-active]")).toBeNull();
});
