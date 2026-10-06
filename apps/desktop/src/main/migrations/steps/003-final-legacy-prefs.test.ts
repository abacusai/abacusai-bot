import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("electron", () => ({
  app: { getPath: () => os.tmpdir(), on: vi.fn() },
  ipcMain: {},
}));
import { importLegacyPrefsAtStartup } from "../../services/config/legacy-prefs";
import { PrefsStore } from "../../services/config/prefs-store";
import { RETIRED_PREFS_FILE } from "../../services/config/retired-prefs";
import { completedAttempts, rebuildRestoreIndex } from "../attempt-records";
import { runMigrations } from "../runner";
import { finalLegacyPrefs } from "./003-final-legacy-prefs";
import { MIGRATION_STEPS } from "./index";
let home: string;
let userData: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "retired-prefs-"));
  userData = path.join(home, "electron");
  fs.mkdirSync(userData);
});
afterEach(() => fs.rmSync(home, { force: true, recursive: true }));
it("R7-T14: N+1 retires mapped keys with backups; N imports without resetting any bytes", async () => {
  const source = path.join(userData, "renderer-state.json");
  const legacy = {
    theme: "dark",
    "local-code-ui-store": JSON.stringify({
      version: 4,
      state: {
        pinnedBotIds: ["b"],
        pinnedSessionIds: ["s"],
        favoriteModels: ["m"],
      },
    }),
    "browser.homepage": "invalid",
    unmapped: "keep",
    "onboarding.step": 42,
  };
  fs.writeFileSync(source, JSON.stringify(legacy));
  const result = await runMigrations({
    home,
    userData,
    appVersion: "test",
    steps: [finalLegacyPrefs()],
    log: () => {},
  });
  expect(result.failed).toBeNull();
  expect(JSON.parse(fs.readFileSync(source, "utf8"))).toEqual({
    unmapped: "keep",
  });
  const records = completedAttempts(home);
  expect(records).toHaveLength(1);
  expect(records[0]?.manifest.ops).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        op: "replace",
        root: "home",
        source: path.join("electron", "renderer-state.json"),
        backup: path.join("home", "electron", "renderer-state.json"),
        originalSha256: expect.any(String),
      }),
    ])
  );
  const prefsFile = path.join(home, "prefs.json");
  const bytes = fs.readFileSync(prefsFile);
  const prefs = new PrefsStore({ file: prefsFile });
  importLegacyPrefsAtStartup(source, prefs);
  expect(fs.readFileSync(prefsFile)).toEqual(bytes);
  fs.writeFileSync(
    source,
    JSON.stringify({ unmapped: "keep", theme: "light" })
  );
  importLegacyPrefsAtStartup(source, prefs);
  expect(prefs.get().theme).toBe("light");
  const retirement = JSON.parse(
    fs.readFileSync(path.join(userData, RETIRED_PREFS_FILE), "utf8")
  );
  expect(retirement.attempt).toBe(records[0]?.manifest.attempt);
  expect(Object.keys(retirement.keys).sort()).toEqual(
    Object.keys(legacy)
      .filter((k) => k !== "unmapped")
      .sort()
  );
  expect(rebuildRestoreIndex(home)).toHaveLength(
    records[0]?.manifest.ops.length ?? 0
  );
  expect(MIGRATION_STEPS.map((s) => s.id)).toEqual([1, 2, 5, 6]);
});
it("unlisted absent keys retain reset behavior; a damaged retirement record leaves prefs intact", () => {
  const source = path.join(userData, "renderer-state.json");
  const prefsFile = path.join(home, "prefs.json");
  const prefs = new PrefsStore({ file: prefsFile });
  prefs.importLegacy({ theme: "dark" });
  fs.writeFileSync(source, "{}");
  importLegacyPrefsAtStartup(source, prefs);
  expect(prefs.get().theme).toBe("system");
  prefs.importLegacy({ theme: "dark" });
  const bytes = fs.readFileSync(prefsFile);
  fs.writeFileSync(path.join(userData, RETIRED_PREFS_FILE), "{");
  expect(() => importLegacyPrefsAtStartup(source, prefs)).toThrow();
  expect(fs.readFileSync(prefsFile)).toEqual(bytes);
});
