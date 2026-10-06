import * as v from "valibot";
import { describe, expect, it } from "vitest";

import { AVATAR_ACCESSORY_IDS, BOT_WALLPAPER_IDS } from "../bots";
import { BotCreateInputSchema, BotUpdateInputSchema } from "./db";

const wire = <T>(value: T): T => JSON.parse(JSON.stringify(value));

describe("bot accessory contract", () => {
  it.each([...AVATAR_ACCESSORY_IDS, null])(
    "round-trips %s through create and update",
    (avatarAccessory) => {
      const create = { name: "Ada", description: "Counts", avatarAccessory };
      expect(v.parse(BotCreateInputSchema, wire(create))).toEqual(create);
      expect(v.parse(BotUpdateInputSchema, wire({ avatarAccessory }))).toEqual({
        avatarAccessory,
      });
    }
  );

  it("accepts legacy inputs without adding an accessory", () => {
    const create = { name: "Ada", description: "Counts" };
    expect(v.parse(BotCreateInputSchema, wire(create))).toEqual(create);
    expect(v.parse(BotUpdateInputSchema, wire({ title: "Counter" }))).toEqual({
      title: "Counter",
    });
  });

  it.each(["hat", "", 1, {}])(
    "rejects unknown accessories %j",
    (avatarAccessory) => {
      expect(
        v.safeParse(BotCreateInputSchema, {
          name: "Ada",
          description: "Counts",
          avatarAccessory,
        }).success
      ).toBe(false);
      expect(
        v.safeParse(BotUpdateInputSchema, { avatarAccessory }).success
      ).toBe(false);
    }
  );
});

describe("bot wallpaper contract", () => {
  it.each([...BOT_WALLPAPER_IDS, null])(
    "round-trips %s through create and update",
    (wallpaper) => {
      const create = { name: "Ada", description: "Counts", wallpaper };
      expect(v.parse(BotCreateInputSchema, wire(create))).toEqual(create);
      expect(v.parse(BotUpdateInputSchema, wire({ wallpaper }))).toEqual({
        wallpaper,
      });
    }
  );

  it("is off by default: a bot without the field parses unchanged", () => {
    const create = { name: "Ada", description: "Counts" };
    expect(v.parse(BotCreateInputSchema, wire(create))).toEqual(create);
  });

  it.each(["stripes", "", 1, {}])(
    "rejects unknown wallpapers %j",
    (wallpaper) => {
      expect(
        v.safeParse(BotCreateInputSchema, {
          name: "Ada",
          description: "Counts",
          wallpaper,
        }).success
      ).toBe(false);
      expect(v.safeParse(BotUpdateInputSchema, { wallpaper }).success).toBe(
        false
      );
    }
  );
});
