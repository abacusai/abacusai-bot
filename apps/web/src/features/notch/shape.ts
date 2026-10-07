import type { NotchLayout } from "@abacus-ai/contract/contract/notch";
import { NOTCH_SPACING as spacing } from "@abacus-ai/contract/contract/notch-spacing";

import type { NotchPresentation } from "./presenter";
import { hasCamera, headerHeight } from "./spacing";
// Compact ear content width and expanded body budget. Insets are added once.
export const SHAPES = {
  idle: [20, 0],
  quiet: [64, 0],
  working: [120, 0],
  done: [120, 0],
  failed: [140, 0],
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
  const camera = hasCamera(layout);
  const gap = camera ? layout.notch!.width + spacing.cameraClearance * 2 : 0;
  const edge = spacing.inline + (camera ? spacing.shoulder : 0);
  const compactWidth = Math.max(96, gap + 2 * (compactWing + edge));
  const expandedWidth = camera ? layout.maxShape.width : 360;
  const compactHeight = headerHeight(layout);
  return {
    compactHeight,
    width: Math.min(
      layout.maxShape.width,
      p.expanded ? expandedWidth : compactWidth
    ),
    height: Math.min(
      layout.maxShape.height,
      compactHeight + (p.expanded ? body || SHAPES.hovered[1] : 0)
    ),
  };
};
