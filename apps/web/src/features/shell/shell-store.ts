/**
 * Ephemeral shell UI (spec 01 §8.5). Nothing here is persisted: pinned lives
 * in prefs, the panel tab in the URL.
 */
import { Store } from "@tanstack/react-store";

import type { SidePanelTabId } from "#renderer/lib/navigation/search";

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
  floating: {
    open: boolean;
    reason: null | "hover" | "peek";
    /** The area the floating sidebar previews: the rail item under the pointer, else the current area. */
    area: ShellArea | null;
  };
  commandOpen: boolean;
  lastLocationOutsideSettings: AreaLocation;
  lastLocationByArea: Partial<Record<ShellArea, AreaLocation>>;
  /** The side-panel tab last shown per area (⌘⌥B reopens it). */
  lastTabByArea: Partial<Record<ShellArea, SidePanelTabId>>;
  occlusion: { any: boolean; rects: OcclusionRect[] };
}

const initialShellState = (): ShellState => ({
  floating: { open: false, reason: null, area: null },
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
      : { ...state, floating: { ...state.floating, open: true, reason } }
  );

/**
 * The pointer is over a rail item: the floating sidebar shows that area's
 * sidebar, so the rail reads as one menu rather than five destinations. A
 * closed sidebar remembers nothing; `null` goes back to the current area.
 */
export const previewFloatingArea = (area: ShellArea | null): void =>
  shellStore.setState((state) =>
    state.floating.area === area
      ? state
      : { ...state, floating: { ...state.floating, area } }
  );

export const closeFloating = (): void =>
  shellStore.setState((state) =>
    state.floating.open
      ? { ...state, floating: { open: false, reason: null, area: null } }
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
