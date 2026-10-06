/**
 * R2-T27 (spec 02 §9): the `motion/react` exports the kit uses type-check
 * against the pinned `motion`; reduced motion makes layout a cut and every
 * other transition a 120 ms fade; the composer surface is one critically
 * damped spring and its children wait for it to settle.
 */
import {
  AnimatePresence,
  LayoutGroup,
  motion,
  useReducedMotion,
  type Transition,
} from "motion/react";
import { describe, expect, expectTypeOf, it } from "vitest";

import { durations, springs } from "#renderer/lib/motion";

import {
  cardEnter,
  CHILD_FADE_DELAY_MS,
  composerChildren,
  composerExit,
  composerMorph,
  composerReveal,
  composerSurface,
  queueRow,
} from "./motion";

describe("R2-T27 motion", () => {
  it("uses the pinned motion/react API", () => {
    expectTypeOf(motion.div).not.toBeAny();
    expectTypeOf(AnimatePresence).toBeFunction();
    expectTypeOf(LayoutGroup).toBeFunction();
    expectTypeOf(useReducedMotion).returns.toEqualTypeOf<boolean | null>();
    expectTypeOf(composerSurface).returns.toEqualTypeOf<Transition>();
  });

  it("full motion: one critically damped spring for the surface, children after it settles", () => {
    expect(springs.surface).toEqual({
      type: "spring",
      visualDuration: durations.surface / 1000,
      bounce: 0,
    });
    expect(composerSurface("full")).toEqual({ layout: springs.surface });
    expect(CHILD_FADE_DELAY_MS).toBe(durations.surface);
    expect(composerChildren("full")).toMatchObject({
      duration: durations.childFade / 1000,
      delay: durations.surface / 1000,
    });
    // Rows revealed in the surface ride the same spring for height.
    expect(composerReveal("full")).toEqual({
      height: springs.surface,
      opacity: { duration: durations.childFade / 1000 },
    });
  });

  it("morphs start → chat with a shared layoutId only under full motion", () => {
    expect(composerMorph("full", "t1")).toEqual({
      layout: true,
      layoutId: "composer:t1",
    });
    expect(composerMorph("reduced", "t1")).toEqual({ layout: false });
  });

  it("reduced motion: layout cuts, everything else a 120 ms fade", () => {
    expect(composerSurface("reduced")).toEqual({ layout: { duration: 0 } });
    expect(composerReveal("reduced")).toEqual({
      height: { duration: 0 },
      opacity: { duration: durations.reduced / 1000 },
    });
    for (const transition of [
      composerChildren,
      cardEnter,
      composerExit,
      queueRow,
    ])
      expect(transition("reduced")).toEqual({
        duration: durations.reduced / 1000,
      });
  });
});
