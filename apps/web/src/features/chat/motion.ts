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

/** Brief discoverability feedback anchored to the message's top corner. */
export const actionBarTransition = (pref: MotionPreference): Transition =>
  motionFor(
    pref,
    { duration: durations.childFade / 1000, ease: [...easings.standard] },
    { ...reducedTransition }
  );
