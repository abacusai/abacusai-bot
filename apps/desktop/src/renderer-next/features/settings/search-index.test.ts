import * as v from "valibot";
import { describe, expect, it } from "vitest";

import enUS from "#locales/en-US.json";

import { SettingsSearch } from "./search";
import { searchSettings, SETTINGS_INDEX } from "./search-index";

describe("R5-T24 settings index", () => {
  it("indexes each cue and both Windows/Linux terminal overrides", () => {
    const ids = SETTINGS_INDEX.map((row) => row.id);
    for (const id of [
      "sound-routine-fired",
      "sound-needs-you",
      "terminalShell",
      "key-close-tab@terminal",
      "key-new-in-area@terminal",
      "changelog",
    ])
      expect(ids).toContain(id);
  });
  it("resolves every static search label and uses the rendered mode and backend labels", () => {
    const lookup = (key: string) =>
      key
        .split(".")
        .reduce<unknown>(
          (value, part) =>
            value && typeof value === "object"
              ? (value as Record<string, unknown>)[part]
              : undefined,
          enUS
        );
    for (const entry of SETTINGS_INDEX)
      if (entry.labelKey)
        expect(typeof lookup(entry.labelKey), entry.id).toBe("string");
    expect(
      SETTINGS_INDEX.find((row) => row.id === "mode-ACCEPTEDITS")?.labelKey
    ).toBe("chat.mode.ACCEPTEDITS");
    expect(
      SETTINGS_INDEX.find((row) => row.id === "device-ios")?.labelKey
    ).toBe("phase5.deviceTools.ios");
  });
  it("matches translated labels without accents", () => {
    const result = searchSettings("resume", (key) => key, [
      { id: "memory-test", page: "memory", labelKey: "", label: "Résumé" },
    ]);
    expect(result.map((row) => row.id)).toEqual(["memory-test"]);
  });
  it("accepts dynamic memory and per-bot row targets while rejecting unrelated ids", () => {
    expect(v.parse(SettingsSearch, { focus: "memory-bot-bot-ada" }).focus).toBe(
      "memory-bot-bot-ada"
    );
    expect(v.parse(SettingsSearch, { focus: "sounds-bot-bot-ada" }).focus).toBe(
      "sounds-bot-bot-ada"
    );
    expect(
      v.parse(SettingsSearch, { focus: "unknown-setting" }).focus
    ).toBeUndefined();
  });
});
