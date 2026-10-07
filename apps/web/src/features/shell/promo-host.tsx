import { Store, useStore } from "@tanstack/react-store";
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
/** Exit presence keeps the peek host registered until its sidebar leaves. */
export const PromoOutlet = ({ floating }: { floating: boolean }) => {
  const ref = (element: HTMLDivElement | null) => {
    if (!element) return;
    const host = { element, floating };
    hosts.setState((items) => [...items, host]);
    return () => {
      lastRect =
        element
          .querySelector('[data-slot="upgrade-promo"]')
          ?.getBoundingClientRect() ?? null;
      hosts.setState((items) => items.filter((item) => item !== host));
    };
  };
  return (
    <div
      ref={ref}
      data-slot="promo-outlet"
      className="mx-2 mb-2 shrink-0 empty:hidden has-[>[data-slot=promo-portal]:empty]:hidden"
    />
  );
};
