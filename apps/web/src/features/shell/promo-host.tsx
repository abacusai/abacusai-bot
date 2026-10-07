import { Store, useStore } from "@tanstack/react-store";
import { useIsPresent } from "motion/react";
import { useLayoutEffect, useRef } from "react";

import { shellStore } from "./shell-store";

interface Host {
  element: HTMLElement;
  floating: boolean;
}
let lastRect: DOMRect | null = null;
export const consumePromoRect = () => {
  const rect = lastRect;
  lastRect = null;
  return rect;
};
const hosts = new Store<Host[]>([]);
const preferredHost = (items: Host[]) =>
  items.findLast((host) => host.floating) ?? items.at(-1) ?? null;
export const usePromoHost = () => useStore(hosts, preferredHost);
/** Hand the card back before the exiting sidebar fades it out. */
export const PromoOutlet = ({ floating }: { floating: boolean }) => {
  const element = useRef<HTMLDivElement>(null);
  const present = useIsPresent();
  const open = useStore(shellStore, (state) => state.floating.open);
  useLayoutEffect(() => {
    if (!present || (floating && !open) || !element.current) return;
    const host = { element: element.current, floating };
    hosts.setState((items) => [...items, host]);
    return () => {
      lastRect =
        host.element
          .querySelector('[data-slot="upgrade-promo"]')
          ?.getBoundingClientRect() ?? null;
      hosts.setState((items) => items.filter((item) => item !== host));
    };
  }, [floating, present, open]);
  return (
    <div
      ref={element}
      data-slot="promo-outlet"
      className="mx-2 mb-2 shrink-0 empty:hidden has-[>[data-slot=promo-portal]:empty]:hidden"
    />
  );
};
