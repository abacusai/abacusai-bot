import { Store, useStore } from "@tanstack/react-store";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

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

/** Historical notices suppress the general promotion only while in view. */
export const useVisibleContextualUpsell = (eligible: boolean) => {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!ref.current || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) =>
      setVisible(entries.some((entry) => entry.isIntersecting))
    );
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);
  useContextualUpsell(eligible && visible);
  return ref;
};
