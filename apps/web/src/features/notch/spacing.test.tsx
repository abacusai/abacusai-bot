import type { NotchLayout } from "@abacus-ai/contract/contract/notch";
import { NOTCH_SPACING as spacing } from "@abacus-ai/contract/contract/notch-spacing";
import { render } from "@testing-library/react";
import { expect, it } from "vitest";

import { NotchHeader, NotchSurface } from "./frame";
import { shapeFor } from "./shape";
import { shellClip } from "./shell-clip";
import { contentInset, headerHeight, spacingStyle } from "./spacing";

const layoutFor = (mode: NotchLayout["mode"]): NotchLayout => ({
  displayId: 3,
  mode,
  notch: mode === "notch" ? { width: 185, height: 33 } : null,
  growth: "down",
  maxShape: { width: 560, height: 220 },
});
it.each(["notch", "capsule", "plain"] as const)(
  "%s keeps content tokens constant across states and shell resizing",
  (mode) => {
    const layout = layoutFor(mode);
    const { container, rerender } = render(<div />);
    for (const route of [
      "/idle",
      "/reply/$id",
      "/approval/$id",
      "/call",
    ] as const) {
      for (const expanded of [false, true]) {
        const shape = shapeFor({ route, expanded, quietUntil: null }, layout);
        rerender(
          <NotchSurface
            layout={layout}
            shape={shape}
            expanded={expanded}
            reduced
          >
            <NotchHeader layout={layout} left="Avatar" right="Action" />
          </NotchSurface>
        );
        const root = container.querySelector<HTMLElement>(".notch-surface")!;
        expect(root.style.getPropertyValue("--notch-inset-inline")).toBe(
          `${mode === "notch" ? 24 : 12}px`
        );
        expect(root.style.getPropertyValue("--notch-inset-top")).toBe("8px");
        expect(root.style.getPropertyValue("--notch-inset-bottom")).toBe(
          "10px"
        );
        expect(
          contentInset(layout) - (mode === "notch" ? spacing.shoulder : 0)
        ).toBe(spacing.inline);
        expect(shape.compactHeight).toBe(headerHeight(layout));
        expect(root.style.getPropertyValue("--notch-content-inline")).toBe(
          "12px"
        );
        expect(root.style.getPropertyValue("--notch-control-inset")).toBe(
          "4px"
        );
        expect(root.dataset.floating).toBe(String(mode !== "notch"));
        const camera = container.querySelector<HTMLElement>(
          '[data-slot="notch-camera-clearance"]'
        );
        if (mode === "notch") expect(camera!.style.width).toBe("209px");
        else expect(camera).toBeNull();
      }
    }
  }
);
it("preserves a tall measured camera with body clearance", () => {
  const layout = layoutFor("notch");
  layout.notch!.height = 60;
  expect(headerHeight(layout)).toBe(68);
  expect(spacingStyle(layout)["--notch-inset-inline"]).toBe("24px");
});
it("uses different hardware shoulders and capsule corners at intermediate sizes", () => {
  for (const [width, height] of [
    [96, 54],
    [180, 82],
    [360, 120],
  ]) {
    const hardware = shellClip(width!, height!, 560, true);
    const capsule = shellClip(width!, height!, 560, false);
    expect(hardware).toContain("C ");
    expect(capsule).not.toContain("C ");
    expect(capsule.match(/Q /g)).toHaveLength(4);
    expect(capsule).not.toMatch(/NaN|Infinity/);
  }
});
