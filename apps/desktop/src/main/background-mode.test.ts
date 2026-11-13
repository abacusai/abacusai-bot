import { describe, expect, it } from "vitest";

import {
  backgroundNoticeDue,
  closeAction,
  hiddenRelaunchStays,
  wantsTray,
} from "./background-mode";

describe("closeAction", () => {
  it.each([
    // platform, setting on, tray up, task running, quitting → action
    ["darwin", true, false, false, false, "hide"],
    ["darwin", false, false, true, false, "hide"],
    ["darwin", true, false, true, true, "close"],
    ["win32", true, true, false, false, "hide"],
    ["win32", true, true, true, false, "hide"],
    ["win32", true, true, true, true, "close"],
    ["win32", false, false, false, false, "close"],
    ["win32", false, false, true, false, "ask"],
    ["win32", false, false, true, true, "close"],
    ["linux", true, true, false, false, "hide"],
    ["linux", true, false, false, false, "close"],
    ["linux", true, false, true, false, "ask"],
    ["linux", false, true, false, false, "close"],
    ["linux", false, false, true, false, "ask"],
    ["linux", true, true, true, true, "close"],
  ] as const)(
    "%s, setting %s, tray %s, task %s, quitting %s: %s",
    (platform, keepRunning, trayShown, taskRunning, quitting, action) =>
      expect(
        closeAction({ platform, keepRunning, trayShown, taskRunning, quitting })
      ).toBe(action)
  );
});

describe("wantsTray", () => {
  it.each([
    ["win32", {}, true],
    ["linux", { keepRunningInBackground: true }, true],
    ["linux", { keepRunningInBackground: false }, false],
    ["darwin", {}, false],
  ] as const)("%s %j: %s", (platform, prefs, wanted) =>
    expect(wantsTray(platform, prefs)).toBe(wanted)
  );
});

describe("backgroundNoticeDue", () => {
  it.each([
    ["hide", "win32", null, true],
    ["hide", "linux", undefined, true],
    ["hide", "win32", 1_700_000_000_000, false],
    ["hide", "darwin", null, false],
    ["close", "win32", null, false],
    ["ask", "linux", null, false],
  ] as const)("%s on %s, noticed at %s: %s", (action, platform, at, due) =>
    expect(
      backgroundNoticeDue(action, platform, { backgroundNoticeAt: at })
    ).toBe(due)
  );
});

describe("hiddenRelaunchStays", () => {
  it.each([
    ["darwin", false, true],
    ["win32", true, true],
    ["win32", false, false],
    ["linux", true, true],
    ["linux", false, false],
  ] as const)("%s, tray shown %s: %s", (platform, trayShown, stays) =>
    expect(hiddenRelaunchStays(platform, trayShown)).toBe(stays)
  );
});
