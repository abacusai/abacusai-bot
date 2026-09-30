/**
 * The shell's geometry, once (canvas `Rail`, `TopBar`, `BotsSidebar`,
 * `SessionsSidebar`, `WidthRules`). tokens.css declares the same values as
 * custom properties for the styles; `geometry.test.ts` keeps the two equal
 * (Claude impl r1 #18), so JS layout maths and CSS never drift. Everything
 * sits on the 8 px grid (V5).
 */
export const SHELL_GEOMETRY = {
  /** `--rail-w`: the rail column. */
  railW: 56,
  /** `--rail-item`: one rail item; items stack with no gap (48 px pitch). */
  railItem: 48,
  /** `--sidebar-w`: the pinned sidebar column. */
  sidebarW: 280,
  /** `--sidebar-strip-w`: the bots avatar strip at 800. */
  sidebarStripW: 88,
  /** `--sidebar-header-h`: the sidebar's title row. */
  sidebarHeaderH: 40,
  /** `--row-h`: a sidebar row; rows stack with no gap (32 px pitch). */
  rowH: 32,
  /** `--side-panel-min`: both sides of the in-layout split. */
  sidePanelMin: 360,
  /** `--side-panel-drawer-w`: the drawer below 1100. */
  sidePanelDrawerW: 356,
  /** `--pane-inset`: the pane's right and bottom inset, and the pane/panel gutter. */
  paneInset: 8,
  /** `--pane-radius`. */
  paneRadius: 12,
  /** `--drawer-padding`: the drawer's content padding. */
  drawerPadding: 16,
} as const;

type ShellGeometryKey = keyof typeof SHELL_GEOMETRY;

/** tokens.css custom property for each key. */
export const GEOMETRY_VARS: Record<ShellGeometryKey, `--${string}`> = {
  railW: "--rail-w",
  railItem: "--rail-item",
  sidebarW: "--sidebar-w",
  sidebarStripW: "--sidebar-strip-w",
  sidebarHeaderH: "--sidebar-header-h",
  rowH: "--row-h",
  sidePanelMin: "--side-panel-min",
  sidePanelDrawerW: "--side-panel-drawer-w",
  paneInset: "--pane-inset",
  paneRadius: "--pane-radius",
  drawerPadding: "--drawer-padding",
};
