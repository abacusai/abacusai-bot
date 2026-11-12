import { describe, expect, it } from "vitest";

import { backgroundAskWanted, keepsRunningInBackground } from "./background";

describe("keepsRunningInBackground", () => {
  it.each([
    [{}, true],
    [{ keepRunningInBackground: true }, true],
    [{ keepRunningInBackground: false }, false],
  ] as const)("%j: %s", (prefs, on) =>
    expect(keepsRunningInBackground(prefs)).toBe(on)
  );
});

describe("backgroundAskWanted", () => {
  it.each([
    // platform, background on, open at login, asked → wanted
    ["win32", true, true, false, false],
    ["win32", true, false, false, true],
    ["win32", false, true, false, true],
    ["win32", false, false, false, true],
    ["win32", false, false, true, false],
    ["linux", true, false, false, true],
    ["linux", true, null, false, false],
    ["linux", false, null, false, true],
    ["linux", true, true, false, false],
    ["darwin", false, false, false, false],
    [null, false, false, false, false],
  ] as const)(
    "%s, background %s, login %s, asked %s: %s",
    (platform, keepRunning, openAtLogin, asked, wanted) =>
      expect(
        backgroundAskWanted({ platform, keepRunning, openAtLogin, asked })
      ).toBe(wanted)
  );
});
