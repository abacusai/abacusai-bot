import type { NotchLayout } from "@abacus-ai/contract/contract/notch";
import { NOTCH_SPACING as spacing } from "@abacus-ai/contract/contract/notch-spacing";

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
// Transparent envelope margins stay fixed across every presentation.
export const notchPlacement = (
  display: DisplayGeometry,
  notch: NotchLayout["notch"],
  _requested: { width: number; height: number }
): Placement => {
  const shape = clampShape(MAX_SHAPE);
  const width =
    Math.max(shape.width, notch?.width ?? 0) + spacing.envelopeInline * 2;
  const center =
    notch?.x === undefined
      ? display.bounds.x + display.bounds.width / 2
      : display.bounds.x + notch.x + notch.width / 2;
  const x = Math.round(center - width / 2);
  return {
    bounds: {
      x,
      y: display.bounds.y,
      width,
      height:
        Math.max(shape.height, notch?.height ?? 0) + spacing.envelopeBottom,
    },
    layout: {
      displayId: display.id,
      offsetX: center - (x + width / 2),
      mode: notch ? "notch" : "capsule",
      notch,
      growth: "down",
      maxShape: MAX_SHAPE,
    },
  };
};
// Windows reserves a top taskbar, but side/bottom taskbars do not move the notch.
export const capsulePlacement = (
  display: DisplayGeometry,
  requested: { width: number; height: number }
): Placement => {
  const placement = notchPlacement(display, null, requested);
  placement.bounds.y = Math.max(display.bounds.y, display.workArea.y);
  return placement;
};
