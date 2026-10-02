/**
 * Whether history has an entry ahead of the current one (Claude impl r1 #16):
 * the router offers `useCanGoBack` only. Tracked from the history's own
 * events: a push truncates everything ahead, so the furthest index is the
 * pushed one; traversals and replaces keep it. Entries ahead of the app's
 * first location (before a reload) are not counted, so Forward can only be
 * disabled too eagerly, never enabled on nothing.
 */
import { useRouter, type RouterHistory } from "@tanstack/react-router";
import { useSyncExternalStore } from "react";

const indexOf = (history: RouterHistory): number =>
  (history.location.state as { __TSR_index?: number }).__TSR_index ?? 0;

interface ForwardTracker {
  canGoForward(): boolean;
  subscribe(onChange: () => void): () => void;
}

const TRACKERS = new WeakMap<RouterHistory, ForwardTracker>();

const forwardTracker = (history: RouterHistory): ForwardTracker => {
  const existing = TRACKERS.get(history);
  if (existing != null) return existing;
  let furthest = indexOf(history);
  const listeners = new Set<() => void>();
  history.subscribe(({ action }) => {
    const index = indexOf(history);
    furthest = action.type === "PUSH" ? index : Math.max(furthest, index);
    for (const listener of listeners) listener();
  });
  const tracker: ForwardTracker = {
    canGoForward: () => indexOf(history) < furthest,
    subscribe: (onChange) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
  };
  TRACKERS.set(history, tracker);
  return tracker;
};

export const useCanGoForward = (): boolean => {
  const tracker = forwardTracker(useRouter().history);
  return useSyncExternalStore(tracker.subscribe, tracker.canGoForward);
};
