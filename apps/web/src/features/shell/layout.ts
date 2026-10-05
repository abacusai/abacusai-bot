/**
 * The shell's layout as a pure function of window width, area, the user's
 * pinned preference and whether the side panel is open (spec 01 §7.1, canvas
 * `WidthRules`, `BW1000/BW900/BW800`, `W900/W800`). Never writes prefs:
 * growing the window restores the user's choice.
 */
import { SHELL_GEOMETRY } from "./geometry";

/** `xs`: a phone browser, below the desktop window minimum. */
export type Band = "xs" | "sm" | "md" | "lg" | "xl";

/** Lower bounds, px. 800 is the desktop window minimum; below it is `xs`. */
export const BAND_MIN = { sm: 800, md: 900, lg: 1000, xl: 1100 } as const;

export const bandFor = (width: number): Band =>
  width >= BAND_MIN.xl
    ? "xl"
    : width >= BAND_MIN.lg
      ? "lg"
      : width >= BAND_MIN.md
        ? "md"
        : width >= BAND_MIN.sm
          ? "sm"
          : "xs";

export type ShellArea =
  | "bots"
  | "sessions"
  | "routines"
  | "artifacts"
  | "library"
  | "settings";

export type SidebarMode =
  /** In layout, 280 wide. */
  | "pinned"
  /** Out of layout; floats over the content on rail hover. */
  | "floating"
  /** Bots at 800: the 88 px avatar strip. */
  | "strip";

export interface ShellLayoutState {
  band: Band;
  sidebar: SidebarMode;
  /** What the sidebar column occupies in layout, px (TopBar alignment). */
  sidebarOccupied: number;
  /**
   * Floating although the user pinned it (sessions at 800): the title-bar
   * toggle and ⌘B reveal it instead of unpinning (Codex impl r1 #7).
   */
  forcedFloating: boolean;
  /** `null`: closed. */
  sidePanel: null | "layout" | "drawer";
  titleBar: {
    /** Status text beside the identity (hidden from md down). */
    status: boolean;
    /** Actions fold into ⋯ at sm. */
    actionsFolded: boolean;
    /** The app name shows only while the sidebar is pinned. */
    appName: boolean;
  };
}

export const shellLayout = (input: {
  width: number;
  area: ShellArea | undefined;
  pinned: boolean;
  panelOpen: boolean;
  view?: string;
}): ShellLayoutState => {
  const band = bandFor(input.width);
  let sidebar: SidebarMode = input.pinned ? "pinned" : "floating";
  if (band === "sm" && input.area === "bots" && input.pinned) sidebar = "strip";
  if (band === "md" || (band === "sm" && input.area !== "bots"))
    sidebar = "floating";
  // Below the window minimum (a phone browser): the `sm` rules, with every
  // sidebar floating (the canvas's unpinned mode) so none takes the pane's width.
  if (band === "xs") sidebar = "floating";

  if (
    input.area === "sessions" &&
    band === "xl" &&
    input.panelOpen &&
    input.view !== "full"
  )
    sidebar = "floating";

  return {
    band,
    sidebar,
    sidebarOccupied:
      sidebar === "pinned"
        ? SHELL_GEOMETRY.sidebarW
        : sidebar === "strip"
          ? SHELL_GEOMETRY.sidebarStripW
          : 0,
    forcedFloating: sidebar === "floating" && input.pinned,
    sidePanel: input.panelOpen ? (band === "xl" ? "layout" : "drawer") : null,
    titleBar: {
      status: band === "xl" || band === "lg",
      actionsFolded: band === "sm" || band === "xs",
      appName: sidebar === "pinned",
    },
  };
};
