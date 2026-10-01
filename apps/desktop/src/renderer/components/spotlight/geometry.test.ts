import { describe, expect, it } from "vitest";

import { placeCard, waitForAnchor } from "./geometry";
describe("R6-T11 spotlight geometry", () => {
  it.each([
    { x: 56, y: 80, width: 40, height: 40 },
    { x: 730, y: 80, width: 40, height: 40 },
    { x: 300, y: 450, width: 100, height: 40 },
    { x: 0, y: 0, width: 800, height: 600 },
    null,
  ])("keeps the card on screen for %j", (anchor) => {
    const p = placeCard(
      anchor,
      { width: 340, height: 240 },
      { width: 800, height: 600 }
    );
    expect(p.x).toBeGreaterThanOrEqual(16);
    expect(p.x + 340).toBeLessThanOrEqual(784);
    expect(p.y).toBeGreaterThanOrEqual(56);
    expect(p.y + 240).toBeLessThanOrEqual(584);
  });
  it("resolves a late-mounted measurable anchor", async () => {
    const pending = waitForAnchor("late", 500);
    const node = document.createElement("div");
    node.dataset.tour = "late";
    node.getBoundingClientRect = () =>
      ({ x: 1, y: 1, width: 100, height: 40 }) as DOMRect;
    document.body.append(node);
    expect(await pending).toBe(node);
    node.remove();
  });
  it("aborted preparation returns a centred fallback immediately", async () => {
    const abort = new AbortController();
    const pending = waitForAnchor("missing", 2000, abort.signal);
    abort.abort();
    expect(await pending).toBeNull();
  });
});
