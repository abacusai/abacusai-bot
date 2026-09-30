import { describe, expect, it } from "vitest";

import { capsulePlacement, notchPlacement } from "./geometry";
const display = {
  id: 1,
  bounds: { x: -1000, y: -800, width: 1000, height: 800 },
  workArea: { x: -1000, y: -800, width: 1000, height: 760 },
};
describe("R6-T23 canvas shadow geometry", () => {
  it("centres at the actual display top and clamps both dimensions", () => {
    const p = notchPlacement(
      display,
      { width: 200, height: 32 },
      { width: 900, height: 400 }
    );
    expect(p.bounds).toEqual({ x: -804, y: -800, width: 608, height: 252 });
    expect(p.layout.mode).toBe("notch");
    expect(
      notchPlacement(display, null, { width: 296, height: 32 }).layout.mode
    ).toBe("plain");
  });
  it("keeps the bottom growth edge fixed for mixed shape changes", () => {
    const a = capsulePlacement(display, { width: 500, height: 36 });
    const b = capsulePlacement(display, { width: 440, height: 108 });
    expect(a.bounds.y + a.bounds.height).toBe(b.bounds.y + b.bounds.height);
    expect(b.layout.growth).toBe("up");
  });
  it.each(["top", "left", "right", "auto"])("places %s taskbars", (edge) => {
    const workArea = { ...display.bounds };
    if (edge === "top") {
      workArea.y += 40;
      workArea.height -= 40;
    }
    if (edge === "left") {
      workArea.x += 40;
      workArea.width -= 40;
    }
    if (edge === "right") workArea.width -= 40;
    const p = capsulePlacement(
      { ...display, workArea },
      { width: 296, height: 36 }
    );
    expect(p.layout.growth).toBe(edge === "top" ? "down" : "up");
    if (edge === "left") expect(p.bounds.x).toBe(workArea.x + 12);
    if (edge === "auto") expect(p.bounds.y + p.bounds.height).toBe(-56);
  });
});
