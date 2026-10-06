/**
 * The chat's motion (spec 02 §9), from the foundation's numbers
 * (`lib/motion.ts`): every `motion/react` transition goes through
 * `motionFor`, and reduced motion turns layout into cuts and everything
 * else into a 120 ms fade.
 */
import type { Transition } from "motion/react";

import {
  durations,
  easings,
  motionFor,
  reducedTransition,
  type MotionPreference,
} from "#renderer/lib/motion";

/** Children fade in 120 ms after the surface settles (§9.1). */
export const CHILD_FADE_DELAY_MS = durations.layout - durations.childFade;

export const composerSurface = (pref: MotionPreference): Transition =>
  motionFor<Transition>(
    pref,
    {
      layout: {
        duration: durations.layout / 1000,
        ease: [...easings.standard],
      },
    },
    { layout: { duration: 0 } }
  );

export const composerChildren = (pref: MotionPreference): Transition =>
  motionFor<Transition>(
    pref,
    { duration: durations.childFade / 1000, delay: CHILD_FADE_DELAY_MS / 1000 },
    { ...reducedTransition }
  );

/** The permission card taking over the composer slot (§9.1). */
export const cardEnter = (pref: MotionPreference): Transition =>
  motionFor<Transition>(
    pref,
    { duration: 0.2, ease: [...easings.standard] },
    { ...reducedTransition }
  );

export const composerExit = (pref: MotionPreference): Transition =>
  motionFor<Transition>(
    pref,
    { duration: durations.childFade / 1000 },
    { ...reducedTransition }
  );

/** Queue rows in/out: height + opacity 160 ms. */
export const queueRow = (pref: MotionPreference): Transition =>
  motionFor<Transition>(pref, { duration: 0.16 }, { ...reducedTransition });

/** The hover action bar: a 140 ms fade with a 2 px rise; reduced: fade only. */
export const ACTION_BAR_RISE_PX = 2;
export const actionBarTransition = (pref: MotionPreference): Transition =>
  motionFor(
    pref,
    { duration: 0.14, ease: [...easings.standard] },
    { ...reducedTransition }
  );

/** A reaction pill popping onto the bubble edge (scale 0.6 → 1, overshoot). */
export const reactionPillEnter = (pref: MotionPreference): Transition =>
  motionFor<Transition>(
    pref,
    { type: "spring", stiffness: 520, damping: 20, mass: 0.8 },
    { duration: 0 }
  );
export const reactionPillExit = (pref: MotionPreference): Transition =>
  motionFor<Transition>(
    pref,
    { duration: durations.childFade / 1000, ease: [...easings.standard] },
    { duration: 0 }
  );

/** The reply preview growing inside the composer, on the surface's curve. */
export const replyPreviewTransition = (pref: MotionPreference): Transition =>
  motionFor<Transition>(
    pref,
    { duration: durations.layout / 1000, ease: [...easings.standard] },
    { duration: 0 }
  );
