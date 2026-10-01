import { useSearch } from "@tanstack/react-router";
/**
 * Route-provided side-panel contents (spec 01 §7.5; 03-bots §11.1): a route
 * renders `<SidePanelContent tab="details">…</SidePanelContent>` for each
 * tab it fills; the shell's panel (in layout or the drawer) portals the one
 * for the open tab into its body. A tab no mounted route fills shows the
 * shell's placeholder. Portals keep the route's React context (the bots
 * `LayoutGroup` crosses into the panel).
 */
import { Store, useStore } from "@tanstack/react-store";
import { useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";

import type { SidePanelTabId } from "#renderer/lib/navigation/search";

interface PanelSlotState {
  target: HTMLElement | null;
  /** Tabs some mounted route fills, with a mount count. */
  filled: Partial<Record<SidePanelTabId, number>>;
}

const panelSlot = new Store<PanelSlotState>({ target: null, filled: {} });

/**
 * The latest outlet wins; an outlet leaving clears the target only while it
 * is still the target (the drawer's exit can outlive the in-layout frame's
 * mount when the window crosses 1100 px).
 */
const attachOutlet = (element: HTMLElement | null): (() => void) | void => {
  if (element == null) return;
  panelSlot.setState((state) => ({ ...state, target: element }));
  return () =>
    panelSlot.setState((state) =>
      state.target === element ? { ...state, target: null } : state
    );
};

const count = (tab: SidePanelTabId, delta: number): void =>
  panelSlot.setState((state) => {
    const next = (state.filled[tab] ?? 0) + delta;
    const filled = { ...state.filled };
    if (next <= 0) delete filled[tab];
    else filled[tab] = next;
    return { ...state, filled };
  });

/** Whether a mounted route fills `tab`. */
export const useSidePanelFilled = (tab: SidePanelTabId | undefined): boolean =>
  useStore(panelSlot, (state) => tab != null && (state.filled[tab] ?? 0) > 0);

/** The panel body's portal target (the shell mounts exactly one). */
export const SidePanelOutlet = ({ className }: { className?: string }) => (
  <div
    ref={attachOutlet}
    data-slot="side-panel-outlet"
    className={className ?? "flex min-h-0 flex-1 flex-col overflow-y-auto"}
  />
);

/** Fill the panel's `tab` while this route is mounted. */
export const SidePanelContent = ({
  tab,
  children,
}: {
  tab: SidePanelTabId;
  children: ReactNode;
}) => {
  const target = useStore(panelSlot, (state) => state.target);
  const search = useSearch({ strict: false }) as { tab?: SidePanelTabId };
  useEffect(() => {
    count(tab, 1);
    return () => count(tab, -1);
  }, [tab]);
  if (target == null || search.tab !== tab) return null;
  return createPortal(children, target);
};

const overrides = new Store(0);
export const useSidePanelOverride = (): boolean =>
  useStore(overrides, (n) => n > 0);
export const SidePanelOverride = (): null => {
  useEffect(() => {
    overrides.setState((n) => n + 1);
    return () => {
      overrides.setState((n) => Math.max(0, n - 1));
    };
  }, []);
  return null;
};
