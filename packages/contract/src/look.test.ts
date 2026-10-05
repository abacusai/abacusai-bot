import * as v from "valibot";
import { describe, expect, it } from "vitest";

import { PREFS_GROUP_ENTRIES } from "./contract/db";
import { effectiveScheme, lookSchemes, nativeThemeSource } from "./look";

const custom = PREFS_GROUP_ENTRIES.appearance.custom;

describe("effectiveScheme", () => {
  it("follows the mode for two-scheme themes and forces one-scheme ones", () => {
    expect(
      effectiveScheme("system", { palette: "grove" } as never, true)
    ).toEqual({
      scheme: "dark",
      forced: false,
    });
    expect(
      effectiveScheme("light", { palette: "midnight" } as never, false)
    ).toEqual({
      scheme: "dark",
      forced: true,
    });
    const light = {
      palette: "custom",
      custom: { name: "x", light: { bg: "#ffffff" } },
    };
    expect(effectiveScheme("dark", light as never, true)).toEqual({
      scheme: "light",
      forced: true,
    });
  });

  it("treats a custom theme with no usable variant as the default", () => {
    expect(lookSchemes({ palette: "custom", custom: null })).toEqual([
      "light",
      "dark",
    ]);
    expect(
      lookSchemes({
        palette: "custom",
        custom: { name: "x", dark: {} as never },
      })
    ).toEqual(["light", "dark"]);
    expect(nativeThemeSource({ theme: "system", appearance: undefined })).toBe(
      "system"
    );
    expect(
      nativeThemeSource({
        theme: "system",
        appearance: { palette: "midnight" } as never,
      })
    ).toBe("dark");
  });
});

describe("the custom theme schema", () => {
  it("requires a variant with a background and only known keys", () => {
    const ok = (value: unknown) => v.safeParse(custom, value).success;
    expect(
      ok({ name: "A", dark: { bg: "#000000", "th-keyword": "#ff00ff" } })
    ).toBe(true);
    expect(ok({ name: "A" })).toBe(false);
    expect(ok({ name: "A", dark: { fg: "#ffffff" } })).toBe(false);
    expect(ok({ name: "A", dark: { bg: "#000000", radius: "#000000" } })).toBe(
      false
    );
    expect(ok({ name: "A", dark: { bg: "#000000", fg: "white" } })).toBe(false);
    expect(ok(null)).toBe(true);
  });
});
