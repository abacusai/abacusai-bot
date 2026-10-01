import type { NotchLayout } from "#shared/contract/notch";

import type { NotchPresentation } from "./presenter";
// Wing and body dimensions from the Notch design canvas, spec 06 §11.5.
export const SHAPES = {
  idle: [48, 0],
  quiet: [90, 0],
  working: [150, 0],
  done: [150, 0],
  failed: [140, 0],
  approval: [120, 76],
  reply: [130, 132],
  call: [130, 132],
  hovered: [180, 76],
} as const;
export const shapeFor = (p: NotchPresentation, layout: NotchLayout) => {
  const key = p.quietUntil
    ? "quiet"
    : p.route.startsWith("/approval")
      ? "approval"
      : p.route.startsWith("/reply")
        ? "reply"
        : (p.route.slice(1) as "idle" | "working" | "call" | "done" | "failed");
  const [compactWing, body] = SHAPES[key] ?? SHAPES.idle;
  const wing = p.expanded
    ? Math.max(compactWing, SHAPES.hovered[0])
    : compactWing;
  const gap = layout.notch?.width ?? 0;
  return {
    compactHeight: layout.notch?.height ?? 36,
    width: Math.min(layout.maxShape.width, gap + wing * 2),
    height: Math.min(
      layout.maxShape.height,
      (layout.notch?.height ?? 36) +
        (p.expanded
          ? key === "approval"
            ? layout.maxShape.height
            : body || SHAPES.hovered[1]
          : 0)
    ),
  };
};
