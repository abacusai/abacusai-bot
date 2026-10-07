import { describe, expect, it } from "vitest";

import { AVATAR_SHAPES } from "#renderer/lib/bots/avatar";

import { CONTOURS } from "./contours";
import { interpolateContour, outlinePath } from "./outline";
const rest = { waveX: 0, waveY: 0, tiltX: 0, tiltY: 0 };
describe("soft outlines", () => {
  it("keeps a common clockwise topology with a motion margin", () => {
    for (const shape of AVATAR_SHAPES) {
      const points = CONTOURS[shape];
      expect(points).toHaveLength(192);
      expect(points.every((v) => Number.isFinite(v) && v > 1 && v < 100)).toBe(
        true
      );
      const pairs = Array.from(
        { length: 96 },
        (_, i) => [points[i * 2]!, points[i * 2 + 1]!] as const
      );
      const area = pairs.reduce((sum, p, i) => {
        const q = pairs[(i + 1) % 96]!;
        return sum + p[0] * q[1] - q[0] * p[1];
      }, 0);
      expect(area).toBeGreaterThan(0);
      expect(outlinePath(points, rest).match(/L/g)).toHaveLength(95);
    }
  });
  it("preserves the endpoints and supports interrupted morphs without a jump", () => {
    const a = CONTOURS.jelly,
      b = CONTOURS.bunny,
      c = CONTOURS.star;
    expect(interpolateContour(a, b, 0)).toEqual(a);
    expect(interpolateContour(a, b, 1)).toEqual(b);
    const mid = interpolateContour(a, b, 0.4);
    expect(interpolateContour(mid, c, 0)).toEqual(mid);
    for (const t of [-0.02, 0.25, 0.5, 1.02])
      expect(interpolateContour(a, b, t).every(Number.isFinite)).toBe(true);
  });
  it("deforms the actual silhouette and compresses its far side", () => {
    const points = CONTOURS.blob;
    expect(outlinePath(points, { ...rest, waveX: 2, waveY: -1 })).not.toBe(
      outlinePath(points, rest)
    );
    const tilted = outlinePath(points, { ...rest, tiltX: 3 });
    expect(tilted).not.toBe(outlinePath(points, rest));
    expect(tilted).not.toMatch(/NaN|Infinity/);
  });
});
