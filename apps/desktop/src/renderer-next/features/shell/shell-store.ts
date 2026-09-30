/**
 * Ephemeral shell UI (spec 01 §8.5). Nothing here is persisted: pinned lives
 * in prefs, the panel tab in the URL.
 */
import { Store } from "@tanstack/react-store";

import type { ShellArea } from "./layout";

export interface OcclusionRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ShellState {
  floating: { open: boolean; reason: null | "hover" | "peek" };
  commandOpen: boolean;
  lastLocationByArea: Partial<Record<ShellArea, string>>;
  occlusion: { any: boolean; rects: OcclusionRect[] };
}

const initialShellState = (): ShellState => ({
  floating: { open: false, reason: null },
  commandOpen: false,
  lastLocationByArea: {},
  occlusion: { any: false, rects: [] },
});

export const shellStore = new Store<ShellState>(initialShellState());

export const openFloating = (reason: "hover" | "peek" = "hover"): void =>
  shellStore.setState((state) => ({
    ...state,
    floating: { open: true, reason },
  }));

export const closeFloating = (): void =>
  shellStore.setState((state) =>
    state.floating.open
      ? { ...state, floating: { open: false, reason: null } }
      : state
  );

/** Pointer left the rail or the floating sidebar: close after a grace. */
const FLOATING_GRACE_MS = 300;
let closeTimer: ReturnType<typeof setTimeout> | null = null;

export const cancelCloseFloating = (): void => {
  if (closeTimer != null) clearTimeout(closeTimer);
  closeTimer = null;
};

export const scheduleCloseFloating = (): void => {
  cancelCloseFloating();
  closeTimer = setTimeout(() => {
    closeTimer = null;
    closeFloating();
  }, FLOATING_GRACE_MS);
};

export const setCommandOpen = (open: boolean): void =>
  shellStore.setState((state) => ({ ...state, commandOpen: open }));

export const rememberLocation = (area: ShellArea, href: string): void =>
  shellStore.setState((state) =>
    state.lastLocationByArea[area] === href
      ? state
      : {
          ...state,
          lastLocationByArea: { ...state.lastLocationByArea, [area]: href },
        }
  );

export const setOcclusion = (rects: OcclusionRect[]): void =>
  shellStore.setState((state) => ({
    ...state,
    occlusion: { any: rects.length > 0, rects },
  }));

export const resetShellStore = (): void =>
  shellStore.setState(() => initialShellState());
