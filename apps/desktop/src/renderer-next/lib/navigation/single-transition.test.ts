/** The single-transition guard (spec 01 §6.7 amendment, R1-T11b's check). */
import { describe, expect, it, vi } from "vitest";

import { guardSingleViewTransition } from "./single-transition";

const fakeDocument = () => {
  const updates: Array<() => void> = [];
  const doc = {
    startViewTransition: () => {
      let finish!: () => void;
      const updateCallbackDone = new Promise<void>((resolve) => {
        finish = resolve;
      });
      updates.push(finish);
      return {
        updateCallbackDone,
        ready: updateCallbackDone,
        finished: updateCallbackDone,
      };
    },
  } as unknown as Document;
  return { doc, updates };
};

describe("guardSingleViewTransition", () => {
  it("counts a transition started inside another's update (one commit)", async () => {
    const { doc, updates } = fakeDocument();
    const onOverlap = vi.fn();
    const report = guardSingleViewTransition(doc, onOverlap)!;
    doc.startViewTransition(() => undefined);
    doc.startViewTransition(() => undefined);
    expect(report.overlaps).toBe(1);
    expect(onOverlap).toHaveBeenCalledOnce();
    for (const finish of updates) finish();
  });

  it("does not count a new navigation after the previous commit's update", async () => {
    const { doc, updates } = fakeDocument();
    const report = guardSingleViewTransition(doc, () => undefined)!;
    doc.startViewTransition(() => undefined);
    updates[0]!();
    await Promise.resolve();
    await Promise.resolve();
    doc.startViewTransition(() => undefined);
    expect(report.overlaps).toBe(0);
  });

  it("installs once per document", () => {
    const { doc } = fakeDocument();
    const first = guardSingleViewTransition(doc, () => undefined);
    expect(guardSingleViewTransition(doc, () => undefined)).toBe(first);
  });
});
