/**
 * How routes put things in the title bar without the title bar knowing about
 * areas (spec 01 §7.4): the identity is a portal slot; actions are registered
 * as data, so the bar can render them as buttons or fold them into ⋯ at sm.
 */
import { Store, useStore } from "@tanstack/react-store";
import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

export interface TopBarAction {
  id: string;
  label: string;
  icon?: ReactNode;
  /** Custom expanded control; folding uses label/icon/onSelect. */
  render?: ReactNode;
  onSelect(): void;
}

interface SlotState {
  identity: HTMLElement | null;
  actions: TopBarAction[];
  endActions: Map<symbol, TopBarAction[]>;
  /** Status beside the identity; only an entity route sets one (V4). */
  status: string | null;
}

const topBarSlots = new Store<SlotState>({
  identity: null,
  actions: [],
  endActions: new Map(),
  status: null,
});

export const setIdentityTarget = (element: HTMLElement | null): void =>
  topBarSlots.setState((state) =>
    state.identity === element ? state : { ...state, identity: element }
  );

/** Render children into the title bar's identity area. */
export const TopBarSlot = ({ children }: { children: ReactNode }) => {
  const target = useStore(topBarSlots, (state) => state.identity);
  return target == null ? null : createPortal(children, target);
};

/** Register the route's title-bar actions while it is mounted. */
export const useTopBarActions = (actions: TopBarAction[]): void => {
  // The compiler keeps `actions` stable while its inputs are; the route does
  // not subscribe to the store, so re-registering cannot loop.
  useEffect(() => {
    topBarSlots.setState((state) => ({ ...state, actions }));
    return () =>
      topBarSlots.setState((state) =>
        state.actions === actions ? { ...state, actions: [] } : state
      );
  }, [actions]);
};

/** Global controls appended after route actions, with independent lifetimes. */
export const useTopBarEndActions = (actions: TopBarAction[]): void => {
  const [owner] = useState(() => Symbol("top-bar-end"));
  useEffect(() => {
    topBarSlots.setState((state) => ({
      ...state,
      endActions: new Map(state.endActions).set(owner, actions),
    }));
    return () =>
      topBarSlots.setState((state) => {
        const endActions = new Map(state.endActions);
        endActions.delete(owner);
        return { ...state, endActions };
      });
  }, [owner, actions]);
};

export const useTopBarActionList = (): TopBarAction[] => {
  const actions = useStore(topBarSlots, (state) => state.actions);
  const endActions = useStore(topBarSlots, (state) => state.endActions);
  return [...actions, ...[...endActions.values()].flat()];
};

/**
 * Show `status` beside the identity while the route is mounted (a running
 * session, a bot's state). Nothing is shown when no route sets one.
 */
export const useTopBarStatusText = (status: string | null): void => {
  useEffect(() => {
    topBarSlots.setState((state) => ({ ...state, status }));
    return () =>
      topBarSlots.setState((state) =>
        state.status === status ? { ...state, status: null } : state
      );
  }, [status]);
};

export const useTopBarStatus = (): string | null =>
  useStore(topBarSlots, (state) => state.status);

const panelTarget = new Store<HTMLElement | null>(null);
const setPanelTarget = (element: HTMLElement | null): void => {
  panelTarget.setState(() => element);
};
export const TopBarPanelOutlet = () => (
  <div
    className="titlebar-nodrag flex min-w-0 items-center empty:hidden"
    ref={setPanelTarget}
  />
);
export const TopBarPanelSlot = ({ children }: { children: ReactNode }) => {
  const target = useStore(panelTarget);
  return target == null ? null : createPortal(children, target);
};
