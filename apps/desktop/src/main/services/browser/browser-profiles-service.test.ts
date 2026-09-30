/**
 * Where Chromium-family browsers keep their profiles on Linux.
 *
 * Chromium honors $XDG_CONFIG_HOME; hardcoding ~/.config missed every profile
 * on a machine that sets it.
 */
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: {}, session: {} }));

import {
  linuxConfigRoot,
  matchDefaultBrowser,
  pickDefaultProfileDir,
} from "./browser-profiles-service";

describe("the Linux config root", () => {
  it("honors XDG_CONFIG_HOME when it is set to an absolute path", () => {
    expect(
      linuxConfigRoot({ XDG_CONFIG_HOME: "/data/config" }, "/home/u")
    ).toBe("/data/config");
  });

  it("falls back to ~/.config when the variable is unset", () => {
    expect(linuxConfigRoot({}, "/home/u")).toBe(
      path.join("/home/u", ".config")
    );
  });

  it("ignores a relative XDG_CONFIG_HOME, as the basedir spec requires", () => {
    expect(linuxConfigRoot({ XDG_CONFIG_HOME: "cfg" }, "/home/u")).toBe(
      path.join("/home/u", ".config")
    );
  });
});

describe("the default browser", () => {
  it.each([
    ["Google Chrome", "darwin", "chrome"],
    ["Google Chrome Canary", "darwin", "chrome-canary"],
    ["Brave Browser", "darwin", "brave"],
    ["Arc", "darwin", "arc"],
    ["Microsoft Edge", "win32", "edge"],
    ["Brave", "win32", "brave"],
    ["google-chrome.desktop", "linux", "chrome"],
    ["brave-browser.desktop", "linux", "brave"],
    ["chromium-browser.desktop", "linux", "chromium"],
  ] as const)("is %s on %s", (handler, platform, key) => {
    expect(matchDefaultBrowser(handler, platform)).toBe(key);
  });

  it.each(["Safari", "Firefox", "firefox.desktop", ""])(
    "is none this module can read for %j",
    (handler) => {
      expect(matchDefaultBrowser(handler, "darwin")).toBeNull();
      expect(matchDefaultBrowser(handler, "linux")).toBeNull();
    }
  );

  it("matches launcher names only on Linux, where they are the handler", () => {
    expect(matchDefaultBrowser("google-chrome", "win32")).toBeNull();
  });
});

describe("the profile a browser opens by default", () => {
  const dirs = ["Default", "Profile 1", "Profile 2"];

  it("is Local State's last-used profile", () => {
    expect(
      pickDefaultProfileDir({ profile: { last_used: "Profile 2" } }, dirs)
    ).toBe("Profile 2");
  });

  it("is the most recently active one when last-used is gone", () => {
    const localState = {
      profile: {
        last_used: "Profile 9",
        info_cache: {
          Default: { active_time: 10 },
          "Profile 1": { active_time: 30 },
        },
      },
    };

    expect(pickDefaultProfileDir(localState, dirs)).toBe("Profile 1");
  });

  it("is Default with nothing else to go on, and none without profiles", () => {
    expect(pickDefaultProfileDir(null, dirs)).toBe("Default");
    expect(pickDefaultProfileDir(null, [])).toBeNull();
  });
});
