/**
 * Ephemeral shell UI (spec 01 §8.5). Nothing here is persisted: pinned lives
 * in prefs, the panel tab in the URL.
 */
import { Store } from "@tanstack/react-store";

import type { SidePanelTabId } from "#next/lib/navigation/search";

import type { ShellArea } from "./layout";

export interface OcclusionRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Where the rail takes you back to: a route location, never an href (Claude
 * impl r1 #6). For a masked pop-up it is the background the mask shows.
 */
export interface AreaLocation {
  pathname: string;
  search: Record<string, unknown>;
}

export interface ShellState {
  floating: { open: boolean; reason: null | "hover" | "peek" };
  commandOpen: boolean;
  lastLocationOutsideSettings: AreaLocation;
  lastLocationByArea: Partial<Record<ShellArea, AreaLocation>>;
  /** The side-panel tab last shown per area (⌘⌥B reopens it). */
  lastTabByArea: Partial<Record<ShellArea, SidePanelTabId>>;
  occlusion: { any: boolean; rects: OcclusionRect[] };
}

const initialShellState = (): ShellState => ({
  floating: { open: false, reason: null },
  commandOpen: false,
  lastLocationOutsideSettings: { pathname: "/bots/new", search: {} },
  lastLocationByArea: {},
  lastTabByArea: {},
  occlusion: { any: false, rects: [] },
});

export const shellStore = new Store<ShellState>(initialShellState());

export const openFloating = (reason: "hover" | "peek" = "hover"): void =>
  shellStore.setState((state) =>
    state.floating.open && state.floating.reason === reason
      ? state
      : { ...state, floating: { open: true, reason } }
  );

export const closeFloating = (): void =>
  shellStore.setState((state) =>
    state.floating.open
      ? { ...state, floating: { open: false, reason: null } }
      : state
  );

export const setCommandOpen = (open: boolean): void =>
  shellStore.setState((state) => ({ ...state, commandOpen: open }));

const sameLocation = (a: AreaLocation | undefined, b: AreaLocation): boolean =>
  a != null &&
  a.pathname === b.pathname &&
  JSON.stringify(a.search) === JSON.stringify(b.search);

export const rememberLocation = (
  area: ShellArea,
  location: AreaLocation
): void =>
  shellStore.setState((state) =>
    sameLocation(state.lastLocationByArea[area], location)
      ? state
      : {
          ...state,
          lastLocationByArea: { ...state.lastLocationByArea, [area]: location },
          lastLocationOutsideSettings:
            area === "settings" ? state.lastLocationOutsideSettings : location,
        }
  );

export const rememberTab = (area: ShellArea, tab: SidePanelTabId): void =>
  shellStore.setState((state) =>
    state.lastTabByArea[area] === tab
      ? state
      : { ...state, lastTabByArea: { ...state.lastTabByArea, [area]: tab } }
  );

export const setOcclusion = (rects: OcclusionRect[]): void =>
  shellStore.setState((state) => ({
    ...state,
    occlusion: { any: rects.length > 0, rects },
  }));

export const resetShellStore = (): void =>
  shellStore.setState(() => initialShellState());

/** Pointer intent before the floating sidebar opens, ms. */
export const HOVER_INTENT_MS = 120;
/** Pointer left the rail or the floating sidebar: close after a grace, ms. */
const FLOATING_GRACE_MS = 300;

/**
 * The floating sidebar's pointer timers, one set per shell (Claude impl r1
 * #15): the rail's hover intent and the leave grace. `cancel()` drops both;
 * the shell calls it on navigation, when floating stops applying, and on
 * unmount, so a timer never reopens the sidebar on the next page.
 */
export interface FloatingIntent {
  /** Pointer entered the rail. */
  hover(): void;
  /** Pointer entered the floating sidebar itself. */
  hold(): void;
  /** Pointer left the rail or the sidebar. */
  leave(): void;
  cancel(): void;
}

export const createFloatingIntent = (
  isFocusInside: () => boolean = () => false
): FloatingIntent => {
  let openTimer: ReturnType<typeof setTimeout> | null = null;
  let closeTimer: ReturnType<typeof setTimeout> | null = null;
  const clear = (): void => {
    if (openTimer != null) clearTimeout(openTimer);
    if (closeTimer != null) clearTimeout(closeTimer);
    openTimer = null;
    closeTimer = null;
  };
  return {
    hover: () => {
      clear();
      openTimer = setTimeout(() => {
        openTimer = null;
        openFloating("hover");
      }, HOVER_INTENT_MS);
    },
    hold: () => {
      clear();
      openFloating(shellStore.state.floating.reason ?? "hover");
    },
    leave: () => {
      clear();
      closeTimer = setTimeout(() => {
        closeTimer = null;
        // Keyboard focus inside keeps it open (Codex impl r1 #7).
        if (!isFocusInside()) closeFloating();
      }, FLOATING_GRACE_MS);
    },
    cancel: clear,
  };
};
