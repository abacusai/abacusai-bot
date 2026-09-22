import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  isExtensionInstalled,
  PLAYWRIGHT_EXTENSION_ID,
} from "./chrome-executable";

let userDataDir: string;

beforeEach(() => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "chrome-udd-"));
});

afterEach(() => {
  fs.rmSync(userDataDir, { recursive: true, force: true });
});

describe("isExtensionInstalled", () => {
  it("is false for a profile that never had it, or none at all", () => {
    expect(isExtensionInstalled(path.join(userDataDir, "missing"))).toBe(false);
    fs.mkdirSync(path.join(userDataDir, "Default"));
    expect(isExtensionInstalled(userDataDir)).toBe(false);
  });

  it("sees a store install by its unpacked directory, in any profile", () => {
    fs.mkdirSync(path.join(userDataDir, "Default"));
    fs.mkdirSync(
      path.join(
        userDataDir,
        "Profile 2",
        "Extensions",
        PLAYWRIGHT_EXTENSION_ID
      ),
      { recursive: true }
    );
    expect(isExtensionInstalled(userDataDir)).toBe(true);
  });

  it("sees a loaded extension by its populated settings record, not an emptied one", () => {
    const profile = path.join(userDataDir, "Default");
    fs.mkdirSync(profile);
    const prefs = (record: unknown) =>
      JSON.stringify({
        extensions: { settings: { [PLAYWRIGHT_EXTENSION_ID]: record } },
      });
    fs.writeFileSync(path.join(profile, "Preferences"), prefs({}));
    expect(isExtensionInstalled(userDataDir)).toBe(false);
    fs.writeFileSync(
      path.join(profile, "Secure Preferences"),
      prefs({ location: 4, state: 1 })
    );
    expect(isExtensionInstalled(userDataDir)).toBe(true);
  });
});
