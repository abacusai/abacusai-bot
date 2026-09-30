import * as v from "valibot";
import { describe, expect, it } from "vitest";

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
