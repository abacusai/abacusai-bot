import { describe, expect, it } from "vitest";

import { AVATAR_SHAPES } from "#renderer/lib/bots/avatar";

import {
  faceProportions,
  personalityFromIdentity,
  personalityIdentity,
  TRAIT_BOUNDS,
} from "./personality";

describe("stable avatar personality", () => {
  const ids = Array.from({ length: 200 }, (_, i) => `bot-${i}`);
  const people = ids.map(personalityFromIdentity);
  it("is deterministic, independent of mounts, look edits and names", () => {
    expect(ids.map(personalityFromIdentity)).toEqual(people);
    expect(
      personalityIdentity({
        identity: "bot-7",
        shape: "heart",
        color: "red",
        accessory: "cap",
      })
    ).toBe("bot-7");
    expect(new Set(people.map((p) => JSON.stringify(p))).size).toBe(200);
  });
  it("covers the tastefully bounded trait ranges without correlated IDs", () => {
    for (const [key, [lo, hi]] of Object.entries(TRAIT_BOUNDS)) {
      const values = people.map((p) => p[key as keyof typeof TRAIT_BOUNDS]);
      expect(Math.min(...values)).toBeGreaterThanOrEqual(lo);
      expect(Math.max(...values)).toBeLessThanOrEqual(hi);
      expect(Math.max(...values) - Math.min(...values)).toBeGreaterThan(
        (hi - lo) * 0.8
      );
      expect(values.reduce((a, b) => a + b, 0) / values.length).toBeGreaterThan(
        lo + (hi - lo) * 0.35
      );
      expect(values.reduce((a, b) => a + b, 0) / values.length).toBeLessThan(
        lo + (hi - lo) * 0.65
      );
    }
    expect(people.filter((p) => p.handedness === 1).length).toBeGreaterThan(70);
    expect(people.filter((p) => p.handedness === 1).length).toBeLessThan(130);
  });
  it("keeps pupils, brows and cheeks inside the face island on all 24 silhouettes", () => {
    for (const shape of AVATAR_SHAPES)
      for (const p of people) {
        const f = faceProportions(shape, p);
        expect(50 - 14 * f.eyeSpacing - 7 * f.eyeSize).toBeGreaterThan(26);
        expect(50 + 14 * f.eyeSpacing + 7 * f.eyeSize).toBeLessThan(74);
        expect(47 + f.faceY).toBeGreaterThan(45);
        expect(47 + f.faceY).toBeLessThan(49);
      }
  });
});
