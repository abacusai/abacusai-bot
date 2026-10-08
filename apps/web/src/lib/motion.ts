/**
 * The motion system's numbers, once (spec 01 §7.8, PLAN motion table). Every
 * `motion/react` usage takes its transition from here; tokens.css mirrors the
 * view-transition durations and a test keeps the two equal.
 */
import { useSyncExternalStore } from "react";

import { useOptionalDb } from "#renderer/data/db";

export const durations = {
  crossFade: 200,
  /** Hover/focus title reveal and pause at each end (workspace tabs). */
  tabTitleDelay: 400,
  /** Route view transitions: drills and area changes (`inferNavType`). */
  route: 120,
  sharedElement: 420,
  layout: 240,
  /** The composer surface's spring, as a perceptual duration (`springs.surface`). */
  surface: 320,
  childFade: 120,
  reduced: 120,
} as const;

export const easings = {
  standard: [0.2, 0.8, 0.2, 1],
  notch: [0.22, 1, 0.36, 1],
} as const;

export const springs = {
  /** Small character rig, retargeted with velocity preserved. */
  character: { type: "spring", stiffness: 260, damping: 22, mass: 1 },
  sidebar: { type: "spring", stiffness: 500, damping: 40 },
  panel: { type: "spring", stiffness: 500, damping: 40 },
  /**
   * A soft, critically damped spring for a surface that changes shape (the
   * composer growing, morphing between pages): no overshoot, settles in
   * about `durations.surface`.
   */
  surface: {
    type: "spring",
    visualDuration: durations.surface / 1000,
    bounce: 0,
  },
  /**
   * The onboarding avatars travelling between steps (canvas OnboardMotion's
   * 420 ms shared-element flight, as a spring so an interrupted step change
   * keeps its velocity). A little bounce: first-run is the delight tier.
   */
  avatar: {
    type: "spring",
    visualDuration: durations.sharedElement / 1000,
    bounce: 0.18,
  },
  /** The connected check badge popping onto the avatar. */
  badge: { type: "spring", visualDuration: 0.32, bounce: 0.3 },
} as const;

export const offsets = { drill: 12 } as const;

/** The view-transition types `useAppNavigate` and the seam add (§6.7). */
export type NavType =
  | "nav-lateral"
  | "nav-forward"
  | "nav-back"
  | "settings-in"
  | "settings-out"
  | "notch-expand"
  | "notch-contract"
  | "notch-swap";

export const NAV_TYPES: readonly NavType[] = [
  "nav-lateral",
  "nav-forward",
  "nav-back",
  "settings-in",
  "settings-out",
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
  const db = useOptionalDb();
  const pref = useSyncExternalStore(
    (notify) => {
      const subscription = db?.collections.prefs.subscribeChanges(notify);
      return () => subscription?.unsubscribe();
    },
    () => db?.collections.prefs.get("app")?.motion.reduce ?? "system"
  );
  const system = useSyncExternalStore(subscribeReduced, systemReduced);
  return resolveMotionPreference(pref, system);
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
  // Same spring family as the composer, with a finite duration: shell completion
  // gates the content reveal, so a long physics tail must not hold controls back.
  surfaceSpring: {
    type: springs.surface.type,
    duration: durations.surface / 1000,
    bounce: springs.surface.bounce,
  },
  shape: 350,
  contentFade: 120,
  reaction: 600,
  doneDwell: 5000,
  replyExpanded: 6000,
  ackExpiry: 600_000,
} as const;
