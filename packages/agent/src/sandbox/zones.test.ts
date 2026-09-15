import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import { canonicalize } from "./policy.js";
import { existingToolHomes, zoneOf, type ZoneContext } from "./zones.js";

const HOME = "/Users/dev";
const context: ZoneContext = {
  workspaceRoot: "/Users/dev/proj",
  // Canonical, as the policy's are: /tmp is /private/tmp on macOS.
  writableTemp: [canonicalize("/tmp")],
  toolHomes: ["/Users/dev/.npm"],
  home: HOME,
};

const onPosix = process.platform !== "win32";

describe.skipIf(!onPosix)("where a path lands", () => {
  it.each([
    ["/Users/dev/proj/src/a.ts", "workspace"],
    ["/Users/dev/proj", "workspace"],
    ["/tmp/x", "scratch"],
    ["/Users/dev/.npm/_cacache/x", "toolhome"],
    ["/Users/dev/Desktop/a.txt", "user"],
    ["/Users/dev/Documents/x/y", "user"],
    ["/Users/dev/proj_evil/a.ts", "user"],
    ["/Users/dev/a.txt", "sensitive"],
    ["/Users/dev", "sensitive"],
    ["/Users/dev/.zshrc", "sensitive"],
    ["/Users/dev/.ssh/id_rsa", "sensitive"],
    ["/Users/dev/.config/x", "sensitive"],
    ["/Users/dev/Library/Preferences/x", "sensitive"],
    ["/etc/hosts", "sensitive"],
    ["/usr/local/bin/x", "sensitive"],
    ["/Applications/X.app", "sensitive"],
    ["/Volumes/Backup/x", "other"],
    ["/srv/x", "other"],
  ])("%s is %s", (target, zone) => {
    expect(zoneOf(target, context)).toBe(zone);
  });

  it("a directory made straight under home is a project of the user's", () => {
    expect(zoneOf("/Users/dev/app", context)).toBe("sensitive");
    expect(zoneOf("/Users/dev/app", context, true)).toBe("user");
  });
});

describe("tool homes", () => {
  it("lists only the ones that exist, canonical", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "zones-home-"));
    try {
      fs.mkdirSync(path.join(home, ".npm"));
      fs.mkdirSync(path.join(home, ".cache"));
      const found = existingToolHomes(home, {});

      // Compared canonical, as the list is: on Windows realpath's plain and
      // native forms differ (a short `RUNNER~1` against the long name).
      expect(found.sort()).toEqual(
        [
          canonicalize(path.join(home, ".npm")),
          canonicalize(path.join(home, ".cache")),
        ].sort()
      );
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("honours XDG cache and data homes when set", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "zones-home-"));
    try {
      const cache = path.join(home, "xdg-cache");
      fs.mkdirSync(cache);
      expect(
        existingToolHomes(home, {
          XDG_CACHE_HOME: cache,
          XDG_DATA_HOME: "relative",
        })
      ).toEqual([canonicalize(cache)]);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
