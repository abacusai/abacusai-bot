/**
 * The current time as React state, ticking once a minute: relative
 * timestamps stay fresh without an impure `Date.now()` during render.
 */
import { useSyncExternalStore } from "react";

let now = Date.now();
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  if (timer == null) now = Date.now();
  timer ??= setInterval(() => {
    now = Date.now();
    for (const notify of listeners) notify();
  }, 60_000);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer != null) {
      clearInterval(timer);
      timer = null;
    }
  };
};

export const useNow = (): number => useSyncExternalStore(subscribe, () => now);
