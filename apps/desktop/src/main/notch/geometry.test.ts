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
  it("keeps the bottom growth edge fixed for mixed shape changes", () => {
    const a = capsulePlacement(display, { width: 500, height: 36 });
    const b = capsulePlacement(display, { width: 440, height: 108 });
    expect(a.bounds.y + a.bounds.height).toBe(b.bounds.y + b.bounds.height);
    expect(b.layout.growth).toBe("up");
  });
  it.each(["top", "left", "right", "auto"])("places %s taskbars", (edge) => {
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
    const p = capsulePlacement(
      { ...display, workArea },
      { width: 296, height: 36 }
    );
    expect(p.layout.growth).toBe(edge === "top" ? "down" : "up");
    if (edge === "left") expect(p.bounds.x).toBe(workArea.x + 12);
    if (edge === "auto") expect(p.bounds.y + p.bounds.height).toBe(-56);
  });
});

it.each([1, 1.5, 2, 3])(
  "keeps measured points at scale %s without double scaling",
  (scaleFactor) => {
    const d = { ...display, scaleFactor };
    const notch = { x: 430, width: 185, height: 40 };
    const collapsed = notchPlacement(d, notch, { width: 281, height: 32 });
    const expanded = notchPlacement(d, notch, { width: 445, height: 180 });
    expect(collapsed.bounds.y).toBe(d.bounds.y);
    expect(collapsed.bounds.height).toBe(72);
    for (const p of [collapsed, expanded]) {
      expect(p.bounds.x + p.bounds.width / 2).toBe(
        d.bounds.x + notch.x + notch.width / 2
      );
      expect(p.bounds.y).toBe(d.bounds.y);
    }
  }
);
it("floats below the menu bar without a hardware cutout", () => {
  const d = { ...display, workArea: { ...display.workArea, y: -766 } };
  const p = notchPlacement(d, null, { width: 296, height: 36 });
  expect(p.layout.mode).toBe("capsule");
  expect(p.bounds.y).toBe(-758);
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
