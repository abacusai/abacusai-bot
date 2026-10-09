import { Store, useStore } from "@tanstack/react-store";
import { useLayoutEffect } from "react";

const active = new Store(0);
export const useContextualUpsell = (visible: boolean) => {
  useLayoutEffect(() => {
    if (!visible) return;
    active.setState((count) => count + 1);
    return () => active.setState((count) => count - 1);
  }, [visible]);
};
export const useHasContextualUpsell = () =>
  useStore(active, (count) => count > 0);
