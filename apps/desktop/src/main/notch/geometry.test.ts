import { NOTCH_SPACING as spacing } from "@abacus-ai/contract/contract/notch-spacing";
import { describe, expect, it } from "vitest";

import { capsulePlacement, notchPlacement } from "./geometry";
const display = {
  id: 1,
  bounds: { x: -1000, y: -800, width: 1000, height: 800 },
  workArea: { x: -1000, y: -800, width: 1000, height: 760 },
};
describe("R6-T23 canvas shadow geometry", () => {
  it("centres at the actual display top and clamps both dimensions", () => {
    const p = notchPlacement(
      display,
      { width: 200, height: 32 },
      { width: 900, height: 400 }
    );
    expect(p.bounds).toEqual({ x: -804, y: -800, width: 608, height: 252 });
    expect(p.layout.mode).toBe("notch");
    expect(
      notchPlacement(display, null, { width: 296, height: 32 }).layout.mode
    ).toBe("capsule");
  });
  it.each(["top", "left", "right", "bottom", "auto"])(
    "centers above %s taskbars",
    (edge) => {
      const workArea = { ...display.bounds };
      if (edge === "top") {
        workArea.y += 40;
        workArea.height -= 40;
      }
      if (edge === "left") {
        workArea.x += 40;
        workArea.width -= 40;
      }
      if (edge === "right") workArea.width -= 40;
      if (edge === "bottom") workArea.height -= 40;
      const p = capsulePlacement(
        { ...display, workArea },
        { width: 296, height: 36 }
      );
      expect(p.layout.growth).toBe("down");
      expect(p.bounds.x + p.bounds.width / 2 + (p.layout.offsetX ?? 0)).toBe(
        -500
      );
      expect(p.bounds.y).toBe(display.bounds.y + spacing.floatingGap);
    }
  );
});

it.each([1, 1.5, 2, 3])(
  "keeps measured points at scale %s without double scaling",
  (scaleFactor) => {
    const d = { ...display, scaleFactor };
    const notch = { x: 430, width: 185, height: 40 };
    const collapsed = notchPlacement(d, notch, { width: 281, height: 32 });
    const expanded = notchPlacement(d, notch, { width: 445, height: 180 });
    expect(collapsed.bounds.y).toBe(d.bounds.y);
    expect(collapsed.bounds.height).toBe(252);
    for (const p of [collapsed, expanded]) {
      expect(p.bounds.x + p.bounds.width / 2 + (p.layout.offsetX ?? 0)).toBe(
        d.bounds.x + notch.x + notch.width / 2
      );
      expect(p.bounds.y).toBe(d.bounds.y);
    }
  }
);
it("floats within the menu-bar band without a hardware cutout", () => {
  const d = { ...display, workArea: { ...display.workArea, y: -766 } };
  const p = notchPlacement(d, null, { width: 296, height: 36 });
  expect(p.layout.mode).toBe("capsule");
  expect(p.bounds.y).toBe(-800 + spacing.floatingGap);
});
it("ignores menu-bar auto-hide for hardware anchoring", () => {
  const notch = { x: 430, width: 185, height: 33 };
  const shape = { width: 445, height: 101 };
  expect(
    notchPlacement({ ...display, workArea: display.bounds }, notch, shape)
  ).toEqual(notchPlacement(display, notch, shape));
});

it("retains the half-point hardware center when the native width is even", () => {
  const p = notchPlacement(
    {
      id: 1,
      bounds: { x: 0, y: 0, width: 1710, height: 1107 },
      workArea: { x: 0, y: 34, width: 1710, height: 1073 },
    },
    { x: 763, width: 185, height: 33 },
    { width: 560, height: 220 }
  );
  expect(p.bounds.x + p.bounds.width / 2 + (p.layout.offsetX ?? 0)).toBe(855.5);
});

it.each([null, { x: 430, width: 185, height: 40 }])(
  "keeps an identical envelope for compact and expanded shapes (%j)",
  (notch) => {
    expect(notchPlacement(display, notch, { width: 96, height: 36 })).toEqual(
      notchPlacement(display, notch, { width: 560, height: 220 })
    );
  }
);

it.each([
  { x: 0, y: 0, width: 2560, height: 1080 },
  { x: -1920, y: -1080, width: 1920, height: 1080 },
  { x: 2560, y: 140, width: 320, height: 180 },
])(
  "keeps every floating painted edge inside %j, with one fixed envelope",
  (bounds) => {
    const d = { id: 2, bounds, workArea: { ...bounds, y: bounds.y + 40 } };
    const compact = notchPlacement(d, null, { width: 96, height: 46 });
    const expanded = capsulePlacement(d, { width: 560, height: 220 });
    expect(compact).toEqual(expanded);
    expect(expanded.bounds.y).toBe(bounds.y + spacing.floatingGap);
    const painted = {
      x:
        expanded.bounds.x +
        spacing.envelopeInline +
        (expanded.layout.offsetX ?? 0),
      y: expanded.bounds.y,
      ...expanded.layout.maxShape,
    };
    expect(painted.x).toBeGreaterThan(bounds.x);
    expect(painted.y).toBeGreaterThan(bounds.y);
    expect(painted.x + painted.width).toBeLessThan(bounds.x + bounds.width);
    expect(painted.y + painted.height).toBeLessThan(bounds.y + bounds.height);
    expect(painted.x + painted.width / 2).toBe(bounds.x + bounds.width / 2);
  }
);
