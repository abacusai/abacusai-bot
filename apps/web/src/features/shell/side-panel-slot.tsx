/**
 * Route-provided side-panel contents (spec 01 §7.5; 03-bots §11.1): a route
 * renders `<SidePanelContent kind="details">…</SidePanelContent>` for each
 * kind it fills; the shell's panel (in layout or the drawer) portals the
 * contents for the scope's tabs into its body. A kind that may be open more
 * than once (browser, files) takes a render function and is mounted once per
 * tab, inactive ones hidden, so each keeps its own state (a browser's
 * history, a file's scroll). A tab no mounted route fills shows the shell's
 * placeholder. Portals keep the route's React context (the bots
 * `LayoutGroup` crosses into the panel).
 */
import { Store, useStore } from "@tanstack/react-store";
import { useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { PaneBoundary } from "#renderer/components/page-state";

import { type PanelTab, type PanelTabKind } from "./panel-store";
import { usePanelScope, usePanelScopeKey } from "./use-panel";

interface PanelSlotState {
  target: HTMLElement | null;
  /** Kinds some mounted route fills, with a mount count. */
  filled: Partial<Record<PanelTabKind, number>>;
}

const panelSlot = new Store<PanelSlotState>({ target: null, filled: {} });

/**
 * Move one stable portal target between the layout and drawer outlets.
 * Closing detaches it without replacing it, preserving the tabs' state.
 */
const attachOutlet = (element: HTMLElement | null): void => {
  if (element == null) return;
  let target = panelSlot.state.target;
  if (target == null) {
    target = document.createElement("div");
    target.className = "flex size-full min-h-0 min-w-0 flex-col";
    panelSlot.setState((state) => ({ ...state, target }));
  }
  element.append(target);
};

const count = (kind: PanelTabKind, delta: number): void =>
  panelSlot.setState((state) => {
    const next = (state.filled[kind] ?? 0) + delta;
    const filled = { ...state.filled };
    if (next <= 0) delete filled[kind];
    else filled[kind] = next;
    return { ...state, filled };
  });

/** Whether a mounted route fills `kind`. */
export const useSidePanelFilled = (kind: PanelTabKind | undefined): boolean =>
  useStore(panelSlot, (state) => kind != null && (state.filled[kind] ?? 0) > 0);

/** The panel body's portal target (the shell mounts exactly one). */
export const SidePanelOutlet = ({ className }: { className?: string }) => (
  <div
    ref={attachOutlet}
    data-slot="side-panel-outlet"
    className={
      className ??
      "flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto overscroll-contain"
    }
  />
);

/**
 * Fill the panel's `kind` while this route is mounted. A render function
 * receives the tab (its id, url or path); plain children fill a
 * single-instance kind.
 */
export const SidePanelContent = ({
  kind,
  children,
}: {
  kind: PanelTabKind;
  children: ReactNode | ((tab: PanelTab, active: boolean) => ReactNode);
}) => {
  const target = useStore(panelSlot, (state) => state.target);
  const key = usePanelScopeKey();
  const scope = usePanelScope(key);
  useEffect(() => {
    count(kind, 1);
    return () => count(kind, -1);
  }, [kind]);
  if (target == null) return null;
  const tabs = scope.tabs.filter((tab) => tab.kind === kind);
  if (tabs.length === 0) return null;
  return createPortal(
    tabs.map((tab) => {
      const active = scope.open && tab.id === scope.active;
      return (
        <div
          key={tab.id}
          data-panel-tab={tab.id}
          data-active={active}
          hidden={!active}
          style={{ display: active ? undefined : "none" }}
          className="flex min-h-0 min-w-0 flex-1 flex-col"
        >
          <PaneBoundary resetKey={tab.id}>
            {typeof children === "function" ? children(tab, active) : children}
          </PaneBoundary>
        </div>
      );
    }),
    target
  );
};

const overrides = new Store(0);
export const useSidePanelOverride = (): boolean =>
  useStore(overrides, (n) => n > 0);
/**
 * A route that takes the whole pane (the sessions dock, the bot editor):
 * the shell hides the panel while it is mounted and leaves the store alone,
 * so the panel comes back as it was.
 */
export const SidePanelOverride = (): null => {
  useEffect(() => {
    overrides.setState((n) => n + 1);
    return () => {
      overrides.setState((n) => Math.max(0, n - 1));
    };
  }, []);
  return null;
};
