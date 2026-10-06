import { useSyncExternalStore } from "react";

type Subscribe = (listener: () => void) => () => void;

/** One subscribe function per query, so a render never re-subscribes. */
const subscribers = new Map<string, Subscribe>();
const subscribeTo = (query: string): Subscribe => {
  let subscribe = subscribers.get(query);
  if (!subscribe) {
    subscribe = (listener) => {
      const media = window.matchMedia(query);
      media.addEventListener("change", listener);
      return () => media.removeEventListener("change", listener);
    };
    subscribers.set(query, subscribe);
  }
  return subscribe;
};

/** Browser media state with the same snapshot during React's subscriptions. */
export const useMediaQuery = (query: string): boolean =>
  useSyncExternalStore(
    subscribeTo(query),
    () => window.matchMedia(query).matches,
    () => false
  );
