/**
 * The frame (spec 06 §7.1, canvas page 11): the progress pill sits in the
 * title bar's drag strip with five marks, the active one stretched, steps
 * sharing marks as the canvas draws them; the column carries the glow and
 * the type scale from onboarding.css.
 */
import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { initI18n } from "#renderer/lib/i18n";
import { ONBOARDING_STEPS } from "#renderer/lib/navigation/areas";

import {
  OnboardingFrame,
  OnboardingProgress,
  PROGRESS_MARK,
  stepDirection,
} from "./frame";

vi.mock("./sound", () => ({
  useOnboardingSound: () => ({
    enabled: false,
    play: () => {},
    toggle: () => {},
  }),
}));

describe("OnboardingProgress", () => {
  it("maps the seven steps onto five marks; paired steps share one", () => {
    expect(ONBOARDING_STEPS.map((step) => PROGRESS_MARK[step])).toEqual([
      1, 2, 2, 3, 4, 5, 5,
    ]);
  });

  it("renders five marks in the drag strip with the active one stretched", async () => {
    await initI18n();
    const { container } = render(<OnboardingProgress step="connectors" />);
    const bar = container.querySelector('[role="progressbar"]')!;
    expect(bar.className).toContain("titlebar-drag");
    expect(bar.getAttribute("aria-valuenow")).toBe("4");
    expect(bar.getAttribute("aria-valuemax")).toBe("5");
    expect(bar.getAttribute("aria-valuetext")).toBe("Step 4 of 5");
    const marks = [...bar.querySelectorAll("span")];
    expect(marks).toHaveLength(5);
    expect(marks.map((m) => m.getAttribute("data-current"))).toEqual([
      "false",
      "false",
      "false",
      "true",
      "false",
    ]);
    expect(marks.map((m) => m.getAttribute("data-done"))).toEqual([
      "true",
      "true",
      "true",
      "false",
      "false",
    ]);
  });
});

it("uses one direction for the content of a step", () => {
  expect(stepDirection("models", "connectors")).toBe("forward");
  expect(stepDirection("connectors", "models")).toBe("back");
});

it("moves the whole content in one direction while keeping the cast mounted", async () => {
  await initI18n();
  const view = render(
    <OnboardingFrame step="models">
      <p>Models</p>
    </OnboardingFrame>
  );
  const avatars = [
    ...view.container.querySelectorAll('[data-slot="bot-avatar"]'),
  ];
  view.rerender(
    <OnboardingFrame step="connectors">
      <p>Connectors</p>
    </OnboardingFrame>
  );
  expect(
    view.container
      .querySelector('[data-slot="onboarding-content"]')
      ?.getAttribute("data-direction")
  ).toBe("forward");
  expect([
    ...view.container.querySelectorAll('[data-slot="bot-avatar"]'),
  ]).toEqual(avatars);
  view.rerender(
    <OnboardingFrame step="models">
      <p>Models</p>
    </OnboardingFrame>
  );
  expect(
    view.container
      .querySelector('[data-slot="onboarding-content"]')
      ?.getAttribute("data-direction")
  ).toBe("back");
});

it("starts a new step at the top after scrolling a short window", async () => {
  await initI18n();
  const view = render(
    <OnboardingFrame step="models">
      <p>Models</p>
    </OnboardingFrame>
  );
  const frame = view.container.querySelector<HTMLElement>(".onboarding-frame")!;
  frame.scrollTop = 248;
  view.rerender(
    <OnboardingFrame step="connectors">
      <p>Connectors</p>
    </OnboardingFrame>
  );
  expect(frame.scrollTop).toBe(0);
});

it("moves one product brand from welcome to the header without duplicating it", async () => {
  await initI18n();
  const view = render(
    <OnboardingFrame step="welcome">
      <p>Welcome</p>
    </OnboardingFrame>
  );
  const brand = view.container.querySelector('[data-slot="onboarding-brand"]');
  expect(brand?.getAttribute("data-welcome")).toBe("true");
  view.rerender(
    <OnboardingFrame step="connect">
      <p>Connect</p>
    </OnboardingFrame>
  );
  expect(
    view.container.querySelectorAll('[data-slot="onboarding-brand"]')
  ).toHaveLength(1);
  expect(view.container.querySelector('[data-slot="onboarding-brand"]')).toBe(
    brand
  );
  expect(brand?.getAttribute("data-welcome")).toBe("false");
});
