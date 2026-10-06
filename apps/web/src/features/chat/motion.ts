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
  springs,
  type MotionPreference,
} from "#renderer/lib/motion";

/** Children fade in once the surface has settled (§9.1). */
export const CHILD_FADE_DELAY_MS = durations.surface;

/**
 * The composer surface: one critically damped spring for every change of
 * shape (grow on focus, attachments, the start → chat morph), a cut under
 * reduced motion.
 */
export const composerSurface = (pref: MotionPreference): Transition =>
  motionFor<Transition>(
    pref,
    { layout: { ...springs.surface } },
    { layout: { duration: 0 } }
  );

/**
 * The surface's layout props: the shared-element morph (`layoutId`) joins
 * the start composer to the chat composer only with full motion; reduced
 * motion gets no morph at all.
 */
export const composerMorph = (
  pref: MotionPreference,
  threadId: string
): { layout: boolean; layoutId?: string } =>
  pref === "full"
    ? { layout: true, layoutId: `composer:${threadId}` }
    : { layout: false };

export const composerChildren = (pref: MotionPreference): Transition =>
  motionFor<Transition>(
    pref,
    { duration: durations.childFade / 1000, delay: CHILD_FADE_DELAY_MS / 1000 },
    { ...reducedTransition }
  );

/**
 * A row revealed inside or above the surface (the reply preview, the
 * attachment strip): height rides the surface spring, opacity follows, so
 * the surface never jumps.
 */
export const composerReveal = (pref: MotionPreference): Transition =>
  motionFor<Transition>(
    pref,
    {
      height: { ...springs.surface },
      opacity: { duration: durations.childFade / 1000 },
    },
    { height: { duration: 0 }, opacity: { ...reducedTransition } }
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
