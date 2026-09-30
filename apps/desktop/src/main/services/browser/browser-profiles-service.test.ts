/**
 * Where Chromium-family browsers keep their profiles on Linux.
 *
 * Chromium honors $XDG_CONFIG_HOME; hardcoding ~/.config missed every profile
 * on a machine that sets it.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: {}, session: {} }));

import {
  copyCookieStore,
  linuxConfigRoot,
  matchDefaultBrowser,
  pickDefaultProfileDir,
  profileMentionsHost,
  type BrowserProfileInfo,
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
    ["Microsoft Edge", "darwin", "edge"],
    ["Opera", "darwin", "opera"],
    ["Opera GX", "darwin", "opera-gx"],
    ["Vivaldi", "darwin", "vivaldi"],
    ["Google Chrome", "win32", "chrome"],
    ["Opera Stable", "win32", "opera"],
    ["Microsoft Edge", "win32", "edge"],
    ["Brave", "win32", "brave"],
    ["google-chrome.desktop", "linux", "chrome"],
    ["brave-browser.desktop", "linux", "brave"],
    ["chromium-browser.desktop", "linux", "chromium"],
    ["chromium.desktop", "linux", "chromium"],
    ["microsoft-edge.desktop", "linux", "edge"],
    ["vivaldi-stable.desktop", "linux", "vivaldi"],
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

  // Sandboxed builds cannot see a temp profile outside their sandbox, so they
  // stay unmatched and their provider sign-ins go to the browser itself.
  it.each([
    "com.google.Chrome.desktop",
    "org.chromium.Chromium.desktop",
    "com.brave.Browser.desktop",
    "com.microsoft.Edge.desktop",
    "chromium_chromium.desktop",
  ])("leaves the sandboxed %s to the browser", (handler) => {
    expect(matchDefaultBrowser(handler, "linux")).toBeNull();
  });

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

describe("a profile's cookie store", () => {
  let root: string;
  let temp: string;
  const profile = (): Pick<
    BrowserProfileInfo,
    "profileDir" | "profileDataPath"
  > => ({ profileDir: "Default", profileDataPath: path.join(root, "Default") });

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "bp-root-"));
    temp = fs.mkdtempSync(path.join(os.tmpdir(), "bp-copy-"));
    fs.mkdirSync(path.join(root, "Default", "Network"), { recursive: true });
    fs.writeFileSync(path.join(root, "Local State"), "{}");
  });

  afterEach(() => {
    for (const dir of [root, temp]) {
      fs.chmodSync(dir, 0o755);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is copied with its journal and the key file beside it", async () => {
    const db = path.join(root, "Default", "Network", "Cookies");
    fs.writeFileSync(db, "db");
    fs.writeFileSync(`${db}-journal`, "journal");

    expect(await copyCookieStore(root, profile(), temp)).toBe(true);
    const copied = path.join(temp, "Default", "Network", "Cookies");
    expect(fs.readFileSync(copied, "utf8")).toBe("db");
    expect(fs.readFileSync(`${copied}-journal`, "utf8")).toBe("journal");
    expect(fs.existsSync(path.join(temp, "Local State"))).toBe(true);
  });

  it("is absent, not a failure, for a profile that never stored a cookie", async () => {
    expect(await copyCookieStore(root, profile(), temp)).toBe(false);
  });

  // Stands in for the lock a running browser holds on Windows: reading the
  // copy would otherwise answer "no cookies" rather than "could not read".
  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "fails the read when it exists but cannot be copied",
    async () => {
      const db = path.join(root, "Default", "Network", "Cookies");
      fs.writeFileSync(db, "db");
      fs.chmodSync(db, 0o000);

      await expect(copyCookieStore(root, profile(), temp)).rejects.toThrow();
    }
  );

  it("is searched across chunk boundaries, and again once it changes", async () => {
    const db = path.join(root, "Default", "Network", "Cookies");
    const filler = Buffer.alloc((1 << 20) - 4, 0x20);
    fs.writeFileSync(db, Buffer.concat([filler, Buffer.from("abacus.ai")]));
    const info = { ...profile() } as BrowserProfileInfo;

    expect(await profileMentionsHost(info, "abacus.ai")).toBe(true);

    fs.writeFileSync(db, "nothing here, and a different size");
    expect(await profileMentionsHost(info, "abacus.ai")).toBe(false);
  });
});
