/**
 * Registry `data-slot`s that matter to the window chrome (spec 01 §7.6).
 * Three lists, explicit (never `[data-slot$="-content"]`: the registry has
 * dozens of `*-content` slots that are plain layout). R1-T9 checks them
 * against the installed `ui/` and keeps tokens.css's no-drag rule equal to
 * NO_DRAG_SELECTOR.
 */

/** Portaled surfaces installed in phase 1 that can cover a native view or the title bar. */
export const OCCLUDER_SLOTS = [
  "tour-spotlight",
  "dialog-content",
  "dialog-overlay",
  "alert-dialog-content",
  "alert-dialog-overlay",
  "sheet-content",
  "sheet-overlay",
  "drawer-popup",
  "drawer-overlay",
  "popover-content",
  "dropdown-menu-content",
  "dropdown-menu-sub-content",
  "context-menu-content",
  "context-menu-sub-content",
  "select-content",
  "combobox-content",
  "hover-card-content",
  "tooltip-content",
  // Each visible toast root, not the viewport (Codex r1 #10).
  "toast",
] as const;

/** Registry overlays not installed yet; covered by CSS so adding them is safe. */
export const RESERVED_OCCLUDER_SLOTS = [
  "menubar-content",
  "menubar-sub-content",
  "navigation-menu-content",
] as const;

/** Never occlude by themselves, but must not be drag regions. */
export const NO_DRAG_ONLY_SLOTS = ["toast-viewport"] as const;

/**
 * Installed slots matching `-(content|overlay|popup|viewport)$` that are
 * plain layout: a new registry overlay has to be sorted into one of the lists.
 */
export const NON_OCCLUDING_SLOTS = [
  "attachment-content",
  "card-content",
  "collapsible-content",
  // Inside drawer-popup, which is what occludes.
  "drawer-content",
  "drawer-viewport",
  "empty-content",
  "field-content",
  "field-separator-content",
  "item-content",
  "marker-content",
  "message-content",
  "message-scroller-content",
  "message-scroller-viewport",
  "scroll-area-viewport",
  "tabs-content",
  // Inside each toast root, which is what occludes.
  "toast-content",
] as const;

const selector = (slots: readonly string[]): string =>
  slots.map((slot) => `[data-slot="${slot}"]`).join(",");

export const NO_DRAG_SELECTOR = selector([
  ...OCCLUDER_SLOTS,
  ...RESERVED_OCCLUDER_SLOTS,
  ...NO_DRAG_ONLY_SLOTS,
]);

export const OCCLUDER_SELECTOR = selector([
  ...OCCLUDER_SLOTS,
  ...RESERVED_OCCLUDER_SLOTS,
]);
