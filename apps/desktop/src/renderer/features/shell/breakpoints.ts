/**
 * The width band from three `(min-width)` queries (spec 01 §7.1): exact at
 * the boundaries, and testable with the controllable matchMedia stub.
 */
import { useSyncExternalStore } from "react";

import { BAND_MIN, BAND_XS_MAX, type Band } from "./layout";

const XS_QUERY = `(max-width: ${BAND_XS_MAX}px)`;
const QUERIES = [
  XS_QUERY,
  ...[BAND_MIN.md, BAND_MIN.lg, BAND_MIN.xl].map(
    (px) => `(min-width: ${px}px)`
  ),
];

const subscribe = (onChange: () => void): (() => void) => {
  const lists = QUERIES.map((query) => window.matchMedia(query));
  for (const list of lists) list.addEventListener("change", onChange);
  return () => {
    for (const list of lists) list.removeEventListener("change", onChange);
  };
};

const currentBand = (): Band => {
  const [xs, md, lg, xl] = QUERIES.map(
    (query) => window.matchMedia(query).matches
  );
  return xs ? "xs" : xl ? "xl" : lg ? "lg" : md ? "md" : "sm";
};

/** A width in the band, for the pure layout function. */
export const BAND_WIDTH: Record<Band, number> = {
  xs: BAND_XS_MAX,
  sm: BAND_MIN.sm,
  md: BAND_MIN.md,
  lg: BAND_MIN.lg,
  xl: BAND_MIN.xl,
};

export const useShellBand = (): Band =>
  useSyncExternalStore(subscribe, currentBand, () => "xl");
