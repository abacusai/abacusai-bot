/**
 * The frame (spec 06 §7.1, canvas page 11): the progress pill sits in the
 * title bar's drag strip with five marks, the active one stretched, steps
 * sharing marks as the canvas draws them; the column carries the glow and
 * the type scale from onboarding.css.
 */
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { initI18n } from "#renderer/lib/i18n";
import { ONBOARDING_STEPS } from "#renderer/lib/navigation/areas";

import { OnboardingProgress, PROGRESS_MARK } from "./frame";

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
