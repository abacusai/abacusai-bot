/**
 * One shared once-a-second clock for elapsed times (spec 02 §5.6: a single
 * interval, no per-row timers). It ticks only while someone reads it.
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
  }, 1000);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer != null) {
      clearInterval(timer);
      timer = null;
    }
  };
};

const noop = () => () => {};

/** `active: false` reads the time once without ticking. */
export const useSeconds = (active = true): number =>
  useSyncExternalStore(active ? subscribe : noop, () => now);

export const formatElapsed = (ms: number): string => {
  const seconds = Math.max(0, ms / 1000);
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${Math.floor(seconds % 60)}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
};
