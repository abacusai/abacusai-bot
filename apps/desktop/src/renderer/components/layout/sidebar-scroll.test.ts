/**
 * Bringing the active row into its section's view moves one scroller, and
 * only when the row is out of view.
 */
import { describe, expect, it } from "vitest";

import { scrollRowIntoSection } from "./sidebar-scroll";

const scrollerAt = (scrollTop: number, clientHeight: number) => {
  const scroller = {
    scrollTop,
    clientHeight,
    getBoundingClientRect: () => ({ top: 100, height: clientHeight }),
  };
  return scroller as unknown as HTMLElement;
};

/** A row whose top sits `offset` px into the scroller's content. */
const rowAt = (offset: number, scroller: HTMLElement, height = 32) =>
  ({
    getBoundingClientRect: () => ({
      top: 100 + offset - scroller.scrollTop,
      height,
    }),
  }) as unknown as HTMLElement;

describe("scrollRowIntoSection", () => {
  it("leaves a row that is already in view where it is", () => {
    const scroller = scrollerAt(200, 300);
    scrollRowIntoSection(scroller, rowAt(250, scroller));
    expect(scroller.scrollTop).toBe(200);
  });

  it("centres a row below the fold", () => {
    const scroller = scrollerAt(0, 300);
    scrollRowIntoSection(scroller, rowAt(1000, scroller));
    expect(scroller.scrollTop).toBe(1000 - (300 - 32) / 2);
  });

  it("centres a row above the fold, never past the top", () => {
    const scroller = scrollerAt(900, 300);
    scrollRowIntoSection(scroller, rowAt(10, scroller));
    expect(scroller.scrollTop).toBe(0);
  });
});
