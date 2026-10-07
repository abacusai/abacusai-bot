/**
 * The width band from three `(min-width)` queries (spec 01 §7.1): exact at
 * the boundaries, and testable with the controllable matchMedia stub.
 */
import { useSyncExternalStore } from "react";

import { BAND_MIN, type Band } from "./layout";

const QUERIES = [BAND_MIN.sm, BAND_MIN.md, BAND_MIN.lg, BAND_MIN.xl].map(
  (px) => `(min-width: ${px}px)`
);

const subscribe = (onChange: () => void): (() => void) => {
  const lists = QUERIES.map((query) => window.matchMedia(query));
  for (const list of lists) list.addEventListener("change", onChange);
  return () => {
    for (const list of lists) list.removeEventListener("change", onChange);
  };
};

const currentBand = (): Band => {
  const [sm, md, lg, xl] = QUERIES.map(
    (query) => window.matchMedia(query).matches
  );
  return xl ? "xl" : lg ? "lg" : md ? "md" : sm ? "sm" : "xs";
};

/** A width in the band, for the pure layout function. */
export const BAND_WIDTH: Record<Band, number> = {
  xs: 390,
  sm: BAND_MIN.sm,
  md: BAND_MIN.md,
  lg: BAND_MIN.lg,
  xl: BAND_MIN.xl,
};

export const useShellBand = (): Band =>
  useSyncExternalStore(subscribe, currentBand, () => "xl");

const subscribeWidth = (changed: () => void) => {
  const unsubscribe = subscribe(changed);
  window.addEventListener("resize", changed);
  return () => {
    unsubscribe();
    window.removeEventListener("resize", changed);
  };
};
/** Exact available width, including changes within a band. */
export const useShellWidth = () =>
  useSyncExternalStore(
    subscribeWidth,
    () => window.innerWidth,
    () => 1280
  );
