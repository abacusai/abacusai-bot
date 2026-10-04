import { expect, it } from "vitest";

import { notchOutline } from "./outline";
import type { NotchPresentation } from "./presenter";
import { shapeFor } from "./shape";

it.each([185, 200, 240])(
  "reserves a %s-point camera and widens idle on hover",
  (width) => {
    const layout = {
      displayId: 1,
      mode: "notch" as const,
      growth: "down" as const,
      notch: { width, height: 40 },
      maxShape: { width: 560, height: 220 },
    };
    const p = {
      route: "/idle",
      quietUntil: null,
      expanded: false,
    } as NotchPresentation;
    const closed = shapeFor(p, layout);
    const open = shapeFor({ ...p, expanded: true }, layout);
    expect(closed.height).toBe(40);
    expect(closed.width - width).toBe(96);
    expect(open.width).toBe(Math.min(layout.maxShape.width, width + 360));
    expect(open.height).toBe(116);
  }
);
it.each([
  [281, 33],
  [445, 101],
  [560, 220],
  [1, 1],
  [0, 0],
])("builds a closed outline at %s × %s", (width, height) => {
  const path = notchOutline(width, height);
  expect(path).toMatch(/^shape\(from 0px 0px/);
  expect(path).toContain(`line to ${width}px 0px`);
  expect(path).toContain("close)");
  expect(path).not.toMatch(/NaN|Infinity/);
  expect(path.match(/curve to/g)).toHaveLength(4);
});
it("uses percentages so every intermediate animation size stays clipped", () => {
  expect(notchOutline()).toContain("calc(100% - 12px)");
  expect(notchOutline()).toContain("min(20px, calc(100% - 12px))");
});
it("gives a notchless capsule enough room for controls", () => {
  const shape = shapeFor(
    { route: "/call", expanded: true } as NotchPresentation,
    {
      displayId: 2,
      mode: "capsule",
      notch: null,
      growth: "down",
      maxShape: { width: 560, height: 220 },
    }
  );
  expect(shape.height).toBe(168);
  expect(shape.compactHeight).toBe(36);
});
