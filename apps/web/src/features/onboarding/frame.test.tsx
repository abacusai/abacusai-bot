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

const { readFileSync } = (
  globalThis as unknown as {
    process: {
      getBuiltinModule(id: "node:fs"): {
        readFileSync(path: string, encoding: "utf8"): string;
      };
    };
  }
).process.getBuiltinModule("node:fs");
const css = readFileSync("src/features/onboarding/onboarding.css", "utf8");

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

describe("onboarding.css", () => {
  it("pins the pill to the title bar and animates its width", () => {
    const rule = css.match(/\.onboarding-progress \{[^}]*\}/)![0];
    expect(rule).toContain("position: fixed");
    expect(rule).toContain("right: var(--titlebar-end)");
    expect(rule).toContain("height: var(--toolbar-h)");
    const mark = css.match(/\.onboarding-progress span \{[^}]*\}/)![0];
    expect(mark).toMatch(/width 300ms var\(--ease-standard\)/);
    expect(css).toMatch(
      /\.onboarding-progress span\[data-current="true"\] \{[^}]*width: 20px/
    );
  });

  it("uses the canvas type scale, 44 px buttons and the radial wash", () => {
    expect(css).toMatch(/\.onboarding-title \{[^}]*font-size: 28px/);
    expect(css).toMatch(
      /\.onboarding-title\[data-size="hero"\] \{[^}]*font-size: 40px[^}]*line-height: 48px/
    );
    expect(css).toMatch(
      /\.onboarding-title\[data-size="large"\] \{[^}]*font-size: 34px/
    );
    expect(css).toMatch(/\.onboarding-body \{[^}]*font-size: 14px/);
    expect(css).toMatch(/\.onboarding-quiet \{[^}]*font-size: 13px/);
    expect(css).toMatch(
      /\.onboarding-button \{[^}]*height: 44px[^}]*border-radius: 12px/
    );
    expect(css).toMatch(/\.onboarding-link \{[^}]*height: 32px/);
    expect(css).toMatch(/\.onboarding-frame \{[^}]*radial-gradient\(/);
  });

  it("turns rises into fades and stops the bob under reduced motion", () => {
    expect(css).toMatch(
      /\[data-reduced-motion="true"\] \.onboarding-step > \* \{[^}]*onboarding-fade/
    );
    expect(css).toMatch(
      /\[data-reduced-motion="true"\] \.onboarding-glow \{[^}]*animation: none/
    );
  });
});
