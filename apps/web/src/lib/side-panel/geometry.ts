import { SHELL_GEOMETRY } from "#renderer/lib/shell-geometry";

export const PANEL_MIN_PX = SHELL_GEOMETRY.sidePanelMin;
/** The in-layout panel never grows past this, nor past `panelMaxFor`. */
export const PANEL_MAX_PX = SHELL_GEOMETRY.sidePanelMax;
export const PANE_MIN_PX = 360;
export const SPLIT_MIN_PX =
  PANE_MIN_PX + PANEL_MIN_PX + SHELL_GEOMETRY.paneInset;
export const PANEL_DEFAULT_PX = 400;
/** The panel's share of the split at most (the pane keeps the rest). */
const PANEL_MAX_FRACTION = 0.6;

/**
 * The widest the in-layout panel may be inside a split `groupWidth` px wide
 * (pane + gutter + panel): 60 % of the group or 960 px, whichever is less,
 * never leaving the pane under its minimum, never under the panel's own
 * minimum. `Infinity` (unmeasured) gives the absolute cap.
 */
export const panelMaxFor = (groupWidth: number): number => {
  if (!Number.isFinite(groupWidth)) return PANEL_MAX_PX;
  const byFraction = Math.floor(groupWidth * PANEL_MAX_FRACTION);
  const byPane = groupWidth - PANE_MIN_PX - SHELL_GEOMETRY.paneInset;
  return Math.max(PANEL_MIN_PX, Math.min(PANEL_MAX_PX, byFraction, byPane));
};

/** A stored or dragged width, held within the panel's clamp. */
export const clampPanelWidth = (
  px: number,
  max: number = PANEL_MAX_PX
): number => Math.min(max, Math.max(PANEL_MIN_PX, px));
