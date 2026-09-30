/**
 * The prefs row and its provenance (spec 00 B.2): defaults on first read,
 * atomic persistence, `update` marks `user`, a legacy import never overwrites
 * a `user` field.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AgentMode } from "#shared/agent-types";

import { PREFS_DEFAULTS, PrefsStore } from "./prefs-store";

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "prefs-"));
  file = path.join(dir, "prefs.json");
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("PrefsStore", () => {
  it("starts from defaults and writes nothing until a change", () => {
    const store = new PrefsStore({ file });
    expect(store.get()).toMatchObject({
      id: "app",
      theme: "system",
      language: "system",
      defaultMode: AgentMode.Yolo,
      sounds: { enabled: true, perEvent: {} },
    });
    expect(fs.existsSync(file)).toBe(false);
    expect(new Set(Object.values(store.provenance()))).toEqual(
      new Set(["default"])
    );
  });

  it("persists an update, marks it user, and reloads it", () => {
    const now = new Date("2026-09-30T10:00:00.000Z");
    const store = new PrefsStore({ file, now: () => now });
    const listener = vi.fn();
    store.onChanged(listener);

    const row = store.update({ theme: "dark", panes: { left: 280 } });
    expect(row).toMatchObject({
      theme: "dark",
      panes: { left: 280 },
      updatedAt: now.toISOString(),
    });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0]![1]).toMatchObject({ theme: "system" });

    const stored = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(stored.row.theme).toBe("dark");
    expect(stored.provenance).toMatchObject({ theme: "user", panes: "user" });

    const reloaded = new PrefsStore({ file });
    expect(reloaded.get()).toEqual(row);
    expect(reloaded.provenance()).toMatchObject({
      theme: "user",
      language: "default",
    });
  });

  it("an explicit choice equal to the default is still the user's", () => {
    const store = new PrefsStore({ file });
    const listener = vi.fn();
    store.onChanged(listener);
    store.update({ theme: "system" });
    // Nothing visible changed, so no change is announced.
    expect(listener).not.toHaveBeenCalled();
    expect(store.provenance().theme).toBe("user");
    expect(store.importLegacy({ theme: "dark" }).row.theme).toBe("system");
  });

  it("a legacy import takes default and legacy fields, never user ones", () => {
    const store = new PrefsStore({ file });
    store.update({ language: "de-DE" });

    const first = store.importLegacy({
      theme: "dark",
      language: "fr-FR",
      recentFolders: ["/a"],
    });
    expect(first.row).toMatchObject({
      theme: "dark",
      language: "de-DE",
      recentFolders: ["/a"],
    });
    expect(store.provenance()).toMatchObject({
      theme: "legacy",
      language: "user",
      recentFolders: "legacy",
    });

    // A newer legacy value replaces an older legacy one.
    expect(store.importLegacy({ theme: "light" }).row.theme).toBe("light");
  });

  it("skips invalid legacy fields and counts them", () => {
    const store = new PrefsStore({ file });
    const result = store.importLegacy({
      theme: "purple" as never,
      recentFolders: ["1", "2", "3", "4", "5", "6"],
      browserHomepage: "https://example.com",
    });
    expect(result.invalid).toBe(2);
    expect(result.row).toMatchObject({
      theme: "system",
      recentFolders: [],
      browserHomepage: "https://example.com",
    });
  });

  it("resetLegacy resets legacy fields only, back to default provenance", () => {
    const store = new PrefsStore({ file });
    store.importLegacy({ theme: "dark", onboardingStep: "welcome" });
    store.update({ onboardingStep: "done" });
    const changes: string[] = [];
    store.onChanged((row) => changes.push(row.theme));

    expect(
      store.resetLegacy(["theme", "onboardingStep", "browserHomepage"])
    ).toEqual(["theme"]);
    expect(store.get()).toMatchObject({
      theme: "system",
      onboardingStep: "done",
    });
    expect(store.provenance()).toMatchObject({
      theme: "default",
      onboardingStep: "user",
      browserHomepage: "default",
    });
    expect(changes).toEqual(["system"]);
    expect(store.resetLegacy(["theme"])).toEqual([]);
    expect(new PrefsStore({ file }).provenance().theme).toBe("default");
  });

  it("refuses unknown keys on update", () => {
    const store = new PrefsStore({ file });
    expect(() => store.update({ nope: 1 } as never)).toThrow();
  });

  it("falls back per field on a corrupt or partial file", () => {
    fs.writeFileSync(
      file,
      JSON.stringify({
        row: { theme: "dark", sidebar: "broken", language: "xx" },
        provenance: { theme: "user", sidebar: "user" },
      })
    );
    const store = new PrefsStore({ file });
    expect(store.get()).toMatchObject({
      theme: "dark",
      sidebar: PREFS_DEFAULTS.sidebar,
      language: "system",
    });
    expect(store.provenance()).toMatchObject({
      theme: "user",
      sidebar: "default",
    });

    fs.writeFileSync(file, "{not json");
    expect(new PrefsStore({ file }).get().theme).toBe("system");
  });

  it("keeps everything in memory with no file", () => {
    const store = new PrefsStore({ file: null });
    store.update({ theme: "light" });
    expect(store.get().theme).toBe("light");
    expect(fs.readdirSync(dir)).toEqual([]);
  });
});
