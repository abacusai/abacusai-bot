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
  reply: [130, 84],
  call: [110, 0],
  hovered: [130, 46],
} as const;
export const shapeFor = (p: NotchPresentation, layout: NotchLayout) => {
  const key = p.quietUntil
    ? "quiet"
    : p.route.startsWith("/approval")
      ? "approval"
      : p.route.startsWith("/reply")
        ? "reply"
        : (p.route.slice(1) as "idle" | "working" | "call" | "done" | "failed");
  const [wing, body] = SHAPES[key] ?? SHAPES.idle;
  const gap = layout.notch?.width ?? 0;
  return {
    width: Math.min(layout.maxShape.width, gap + wing * 2),
    height: Math.min(
      layout.maxShape.height,
      Math.max(layout.notch?.height ?? 0, layout.mode === "capsule" ? 36 : 32) +
        (p.expanded ? body || SHAPES.hovered[1] : 0)
    ),
  };
};
