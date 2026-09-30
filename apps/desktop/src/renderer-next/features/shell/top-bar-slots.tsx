/**
 * How routes put things in the title bar without the title bar knowing about
 * areas (spec 01 §7.4): the identity is a portal slot; actions are registered
 * as data, so the bar can render them as buttons or fold them into ⋯ at sm.
 */
import { Store, useStore } from "@tanstack/react-store";
import { useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";

export interface TopBarAction {
  id: string;
  label: string;
  icon?: ReactNode;
  onSelect(): void;
}

interface SlotState {
  identity: HTMLElement | null;
  actions: TopBarAction[];
}

const topBarSlots = new Store<SlotState>({
  identity: null,
  actions: [],
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

export const useTopBarActionList = (): TopBarAction[] =>
  useStore(topBarSlots, (state) => state.actions);
