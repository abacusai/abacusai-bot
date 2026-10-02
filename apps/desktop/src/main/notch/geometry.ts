import type { NotchLayout } from "#shared/contract/notch";
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface DisplayGeometry {
  id: number;
  bounds: Rect;
  workArea: Rect;
}
export const MAX_SHAPE = { width: 560, height: 220 } as const;
export const clampShape = (shape: { width: number; height: number }) => ({
  width: Math.min(MAX_SHAPE.width, Math.max(0, Math.ceil(shape.width))),
  height: Math.min(MAX_SHAPE.height, Math.max(0, Math.ceil(shape.height))),
});
export interface Placement {
  bounds: Rect;
  layout: NotchLayout;
}
// Canvas shadow blur 24 + downward offset 8: 24 on each side, 32 below.
export const notchPlacement = (
  display: DisplayGeometry,
  notch: NotchLayout["notch"],
  requested: { width: number; height: number }
): Placement => {
  const shape = clampShape(requested);
  const width = shape.width + 48;
  return {
    bounds: {
      x: Math.round(display.bounds.x + (display.bounds.width - width) / 2),
      y: display.bounds.y,
      width,
      height: shape.height + 32,
    },
    layout: {
      displayId: display.id,
      mode: notch ? "notch" : "plain",
      notch,
      growth: "down",
      maxShape: MAX_SHAPE,
    },
  };
};
export const capsulePlacement = (
  display: DisplayGeometry,
  requested: { width: number; height: number }
): Placement => {
  const shape = clampShape(requested);
  const b = display.bounds;
  const w = display.workArea;
  const top = w.y > b.y;
  const left = w.x > b.x;
  const autoHidden =
    w.x === b.x && w.y === b.y && w.width === b.width && w.height === b.height;
  const width = shape.width + 48;
  const height = shape.height + 32;
  return {
    bounds: {
      x: left ? w.x + 12 : w.x + w.width - width - 12,
      y: top ? w.y + 8 : w.y + w.height - height - 8 - (autoHidden ? 48 : 0),
      width,
      height,
    },
    layout: {
      displayId: display.id,
      mode: "capsule",
      notch: null,
      growth: top ? "down" : "up",
      maxShape: MAX_SHAPE,
    },
  };
};
