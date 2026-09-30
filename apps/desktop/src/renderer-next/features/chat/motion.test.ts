/**
 * R2-T27 (spec 02 §9): the `motion/react` exports the kit uses type-check
 * against the pinned `motion`; reduced motion makes layout a cut and every
 * other transition a 120 ms fade; the composer's children wait
 * `layout - childFade`.
 */
import { AnimatePresence, LayoutGroup, motion, useReducedMotion, type Transition } from "motion/react";
import { describe, expect, expectTypeOf, it } from "vitest";

import { durations } from "#next/lib/motion";

import { cardEnter, CHILD_FADE_DELAY_MS, composerChildren, composerExit, composerSurface, queueRow } from "./motion";

describe("R2-T27 motion", () => {
  it("uses the pinned motion/react API", () => {
    expectTypeOf(motion.div).not.toBeAny();
    expectTypeOf(AnimatePresence).toBeFunction();
    expectTypeOf(LayoutGroup).toBeFunction();
    expectTypeOf(useReducedMotion).returns.toEqualTypeOf<boolean | null>();
    expectTypeOf(composerSurface).returns.toEqualTypeOf<Transition>();
  });

  it("full motion: 240 ms layout, children after the surface settles", () => {
    expect(composerSurface("full")).toMatchObject({ layout: { duration: durations.layout / 1000 } });
    expect(CHILD_FADE_DELAY_MS).toBe(durations.layout - durations.childFade);
    expect(composerChildren("full")).toMatchObject({ duration: 0.12, delay: 0.12 });
  });

  it("reduced motion: layout cuts, everything else a 120 ms fade", () => {
    expect(composerSurface("reduced")).toEqual({ layout: { duration: 0 } });
    for (const transition of [composerChildren, cardEnter, composerExit, queueRow])
      expect(transition("reduced")).toEqual({ duration: durations.reduced / 1000 });
  });
});
