/** R3-T8 (pure half): the look scheme, the legacy map and the contrast rule. */
import { describe, expect, it } from "vitest";

import { accentForeground, contrastRatio } from "#next/lib/theme";

import {
  AVATAR_PALETTE,
  AVATAR_SHAPES,
  DEFAULT_SHAPES,
  LEGACY_COLORS,
  LEGACY_SHAPES,
  NEUTRAL_LOOK,
  defaultLook,
  isSupportedAvatarColor,
  nameHash,
  resolveLook,
} from "./avatar";

const bot = (
  avatarShape: string,
  avatarColor: string,
  name = "Scout",
  avatarAccessory?: string
) => ({ name, avatarShape, avatarColor, avatarAccessory });

describe("avatar look", () => {
  it("has 24 shapes and a 10-colour palette", () => {
    expect(AVATAR_SHAPES).toHaveLength(24);
    expect(new Set(AVATAR_SHAPES).size).toBe(24);
    expect(AVATAR_PALETTE).toHaveLength(10);
    expect(DEFAULT_SHAPES).toEqual(AVATAR_SHAPES.slice(0, 16));
  });

  it("every palette colour and legacy target reaches 4.5:1 with its foreground", () => {
    for (const hex of [
      ...AVATAR_PALETTE.map((c) => c.hex),
      ...Object.values(LEGACY_COLORS),
    ]) {
      const fg = accentForeground(hex);
      expect(fg).toBe("#171717");
      expect(contrastRatio(hex, fg)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("maps legacy shapes and colours", () => {
    for (const [old, next] of Object.entries(LEGACY_SHAPES))
      expect(resolveLook(bot(old, "#4ade80")).shape).toBe(next);
    for (const shared of ["pebble", "cloud", "squircle", "drop", "blob"])
      expect(resolveLook(bot(shared, "#4ade80")).shape).toBe(shared);
    for (const [old, next] of Object.entries(LEGACY_COLORS))
      expect(resolveLook(bot("blob", old)).color).toBe(next);
    expect(resolveLook(bot("blob", "#A855F7")).color).toBe("#c084fc");
  });

  it("keeps current ids and compliant custom colours", () => {
    expect(resolveLook(bot("ghost", "#60a5fa", "x", "crown"))).toEqual({
      shape: "ghost",
      color: "#60a5fa",
      accessory: "crown",
    });
    // A light custom colour passes 4.5:1 with the dark foreground.
    expect(resolveLook(bot("blob", "#ffd0e0")).color).toBe("#ffd0e0");
  });

  it("falls back to defaultLook for unknown shapes and failing colours", () => {
    const fallback = defaultLook("Scout");
    const look = resolveLook(bot("spaceship", "#767676"));
    expect(look.shape).toBe(fallback.shape);
    expect(look.color).toBe(fallback.color);
    expect(resolveLook(bot("blob", "not-a-colour")).color).toBe(fallback.color);
    expect(resolveLook(bot("blob", "#4ade80", "x", "cape")).accessory).toBe(
      "none"
    );
  });

  it("never resolves to a colour failing the contrast rule", () => {
    for (const color of ["#000000", "#767676", "#1d4ed8", "#ffffff", "bad"]) {
      const { color: out } = resolveLook(bot("blob", color, ""));
      expect(contrastRatio(out, accentForeground(out))).toBeGreaterThanOrEqual(
        4.5
      );
    }
  });

  it("hashes unsigned, so high-bit names still pick a shape (review r1 #15)", () => {
    expect(nameHash("Assistant")).toBe(3_433_796_286);
    // The canvas's `>> 4` would give a negative index here.
    expect((3_433_796_286 >> 4) % 16).toBe(-5);
    const look = defaultLook("Assistant");
    expect(DEFAULT_SHAPES).toContain(look.shape);
    expect(defaultLook("Assistant")).toEqual(look);
    expect(defaultLook("")).toEqual(NEUTRAL_LOOK);
    expect(defaultLook("   ")).toEqual(NEUTRAL_LOOK);
  });

  it("isSupportedAvatarColor agrees with resolveLook", () => {
    const samples = [
      ...AVATAR_PALETTE.map((c) => c.hex),
      "#ffd0e0",
      "#404040",
      "#000000",
      "#fef08a",
      "#7c3aed",
      "nope",
    ];
    for (const color of samples)
      expect(isSupportedAvatarColor(color)).toBe(
        resolveLook(bot("blob", color)).color === color
      );
  });
});
