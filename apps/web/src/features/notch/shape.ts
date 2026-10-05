import type { NotchLayout } from "@abacus-ai/contract/contract/notch";

import type { NotchPresentation } from "./presenter";
// Wing and body dimensions from the Notch design canvas, spec 06 §11.5.
export const SHAPES = {
  idle: [48, 0],
  quiet: [90, 0],
  working: [150, 0],
  done: [150, 0],
  failed: [170, 0],
  approval: [160, 132],
  reply: [160, 144],
  call: [130, 132],
  hovered: [180, 76],
} as const;
export const shapeFor = (
  p: Pick<NotchPresentation, "route" | "expanded" | "quietUntil">,
  layout: NotchLayout
) => {
  const key = p.quietUntil
    ? "quiet"
    : p.route.startsWith("/approval")
      ? "approval"
      : p.route.startsWith("/reply")
        ? "reply"
        : (p.route.slice(1) as "idle" | "working" | "call" | "done" | "failed");
  const [compactWing, body] = SHAPES[key] ?? SHAPES.idle;
  const wing = p.expanded
    ? Math.max(compactWing, key === "idle" ? SHAPES.hovered[0] : 160)
    : compactWing;
  const gap = layout.notch?.width ?? 0;
  return {
    compactHeight: layout.notch?.height ?? 36,
    width: Math.min(layout.maxShape.width, gap + wing * 2),
    height: Math.min(
      layout.maxShape.height,
      (layout.notch?.height ?? 36) +
        (p.expanded ? body || SHAPES.hovered[1] : 0)
    ),
  };
};
