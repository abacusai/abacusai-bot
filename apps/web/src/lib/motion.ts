/**
 * The motion system's numbers, once (spec 01 §7.8, PLAN motion table). Every
 * `motion/react` usage takes its transition from here; tokens.css mirrors the
 * view-transition durations and a test keeps the two equal.
 */
import { useSyncExternalStore } from "react";

import { usePrefs } from "#renderer/data/db/prefs";

export const durations = {
  crossFade: 200,
  drill: 200,
  sharedElement: 420,
  layout: 240,
  childFade: 120,
  reduced: 120,
} as const;

export const easings = {
  standard: [0.2, 0.8, 0.2, 1],
  notch: [0.22, 1, 0.36, 1],
} as const;

export const springs = {
  sidebar: { type: "spring", stiffness: 500, damping: 40 },
  panel: { type: "spring", stiffness: 500, damping: 40 },
} as const;

export const offsets = { drill: 12 } as const;

/** The view-transition types `useAppNavigate` and the seam add (§6.7). */
export type NavType =
  | "nav-lateral"
  | "nav-forward"
  | "nav-back"
  | "settings-in"
  | "settings-out"
  | "onboarding-step"
  | "onboarding-finish"
  | "notch-expand"
  | "notch-contract"
  | "notch-swap";

export const NAV_TYPES: readonly NavType[] = [
  "nav-lateral",
  "nav-forward",
  "nav-back",
  "settings-in",
  "settings-out",
  "onboarding-step",
  "onboarding-finish",
  "notch-expand",
  "notch-contract",
  "notch-swap",
];

export type MotionPreference = "full" | "reduced";

const REDUCED_QUERY = "(prefers-reduced-motion: reduce)";

const subscribeReduced = (onChange: () => void): (() => void) => {
  const list = window.matchMedia(REDUCED_QUERY);
  list.addEventListener("change", onChange);
  return () => list.removeEventListener("change", onChange);
};

const systemReduced = (): boolean => window.matchMedia(REDUCED_QUERY).matches;

/** `prefs.motion.reduce` ("on"/"off" win) over `prefers-reduced-motion`. */
const resolveMotionPreference = (
  pref: "system" | "on" | "off",
  systemReduce: boolean
): MotionPreference =>
  pref === "on" || (pref === "system" && systemReduce) ? "reduced" : "full";

export const useMotionPreference = (): MotionPreference => {
  const prefs = usePrefs();
  const system = useSyncExternalStore(subscribeReduced, systemReduced);
  return resolveMotionPreference(prefs.motion.reduce, system);
};

export const motionFor = <T>(pref: MotionPreference, full: T, reduced: T): T =>
  pref === "reduced" ? reduced : full;

/** A reduced transition: a 120 ms fade, never a spring or a slide. */
export const reducedTransition = {
  duration: durations.reduced / 1000,
} as const;

// Design canvas OnboardMotion and NotchRules. Dwell limits are spec 06 policy.
/** @public Canvas motion tokens and their CSS mirrors. */
export const onboarding = {
  stepExit: 160,
  stepEnter: 320,
  stagger: 60,
  rise: 12,
  shellScaleFrom: 0.98,
} as const;
/** @public Canvas motion tokens and their CSS mirrors. */
export const spotlight = {
  mask: { type: "spring", mass: 1, stiffness: 80, damping: 14 },
  cardLag: 40,
} as const;
/** @public Canvas motion tokens and their CSS mirrors. */
export const hatch = {
  wobbleCycles: 3,
  wobbleMs: 220,
  squash: 0.9,
  pop: 1.08,
  settle: { type: "spring", mass: 1, stiffness: 420, damping: 18 },
  confettiMs: 2400,
  confettiPieces: 7,
} as const;
/** @public Canvas motion tokens and their CSS mirrors. */
export const notch = {
  shape: 350,
  contentFade: 120,
  reaction: 600,
  doneDwell: 5000,
  replyExpanded: 6000,
  ackExpiry: 600_000,
} as const;
