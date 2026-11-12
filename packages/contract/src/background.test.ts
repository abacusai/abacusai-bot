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
    // platform, background on, open at login, asked, tray available → wanted
    ["win32", true, true, false, true, false],
    ["win32", true, false, false, true, true],
    ["win32", false, true, false, true, true],
    ["win32", false, false, false, true, true],
    ["win32", false, false, true, true, false],
    ["win32", false, false, false, null, true],
    ["linux", true, false, false, true, true],
    ["linux", true, null, false, true, false],
    ["linux", false, null, false, true, true],
    ["linux", true, true, false, true, false],
    ["linux", false, false, false, false, false],
    ["linux", true, false, false, false, false],
    ["linux", false, false, false, null, true],
    ["darwin", false, false, false, true, false],
    [null, false, false, false, true, false],
  ] as const)(
    "%s, background %s, login %s, asked %s, tray %s: %s",
    (platform, keepRunning, openAtLogin, asked, trayAvailable, wanted) =>
      expect(
        backgroundAskWanted({
          platform,
          keepRunning,
          openAtLogin,
          asked,
          trayAvailable,
        })
      ).toBe(wanted)
  );
});
