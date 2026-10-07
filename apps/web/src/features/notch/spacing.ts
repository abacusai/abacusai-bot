import type { NotchLayout } from "@abacus-ai/contract/contract/notch";
import { NOTCH_SPACING as spacing } from "@abacus-ai/contract/contract/notch-spacing";

export const hasCamera = (layout: NotchLayout): boolean =>
  layout.mode === "notch" && layout.notch !== null;

export const MIN_HEADER_HEIGHT =
  spacing.top + spacing.controlHeight + spacing.bottom;

export const headerHeight = (layout: NotchLayout): number =>
  Math.max(
    MIN_HEADER_HEIGHT,
    hasCamera(layout) ? layout.notch!.height + spacing.top : 0
  );

/** Hardware shoulders sit inside nominal bounds. Insets start at painted edges. */
export const contentInset = (layout: NotchLayout): number =>
  spacing.inline + (hasCamera(layout) ? spacing.shoulder : 0);

export const spacingStyle = (layout: NotchLayout) => ({
  "--notch-inset-inline": `${contentInset(layout)}px`,
  "--notch-inset-top": `${spacing.top}px`,
  "--notch-inset-bottom": `${spacing.bottom}px`,
  "--notch-gap": `${spacing.gap}px`,
});
