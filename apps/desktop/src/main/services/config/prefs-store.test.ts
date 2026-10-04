/**
 * The prefs row and its provenance (spec 00 B.2): defaults on first read,
 * atomic persistence, `update` marks `user`, a legacy import never overwrites
 * a `user` field.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { AgentMode } from "@abacus-ai/contract/agent-types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
      "sidebar.pinned": "default",
      "sidebar.openSection": "default",
    });

    fs.writeFileSync(file, "{not json");
    expect(new PrefsStore({ file }).get().theme).toBe("system");
  });

  it("a failed write changes nothing; the retry writes, and a reload has it", () => {
    // Block the parent with a file: a real write failure on Windows as well
    // as POSIX, where directory chmod would also work.
    const locked = path.join(dir, "locked");
    fs.mkdirSync(locked);
    const lockedFile = path.join(locked, "prefs.json");
    const saved = path.join(dir, "locked-saved");
    const setWritable = (writable: boolean) => {
      if (writable) {
        fs.rmSync(locked);
        fs.renameSync(saved, locked);
      } else {
        fs.renameSync(locked, saved);
        fs.writeFileSync(locked, "blocks the prefs directory");
      }
    };
    const store = new PrefsStore({ file: lockedFile });
    const listener = vi.fn();
    store.onChanged(listener);

    setWritable(false);
    expect(() => store.update({ theme: "dark" })).toThrow();
    expect(store.get().theme).toBe("system");
    expect(store.provenance().theme).toBe("default");
    expect(listener).not.toHaveBeenCalled();
    // The rejected choice does not block the old renderer's value either.
    setWritable(true);
    expect(store.importLegacy({ theme: "light" }).row.theme).toBe("light");
    expect(store.provenance().theme).toBe("legacy");

    setWritable(false);
    expect(() => store.update({ theme: "dark" })).toThrow();
    setWritable(true);
    // Same patch again: persisted this time, not answered from memory.
    expect(store.update({ theme: "dark" }).theme).toBe("dark");
    const reloaded = new PrefsStore({ file: lockedFile });
    expect(reloaded.get().theme).toBe("dark");
    expect(reloaded.provenance().theme).toBe("user");
  });

  it("keeps provenance per leaf: a user leaf stays, its legacy sibling still flows", () => {
    const store = new PrefsStore({ file });
    store.update({ sidebar: { pinned: false } });
    expect(store.provenance()).toMatchObject({
      "sidebar.pinned": "user",
      "sidebar.openSection": "default",
    });

    // C.4: `local-code-ui-store` and `sidebar-accordion` both feed sidebar.
    const imported = store.importLegacy({
      sidebar: { pinned: true, openSection: "bots" },
    });
    expect(imported.row.sidebar).toEqual({
      pinned: false,
      openSection: "bots",
    });
    expect(
      store.importLegacy({ sidebar: { openSection: "routines" } }).row
    ).toMatchObject({ sidebar: { pinned: false, openSection: "routines" } });
    expect(store.provenance()).toMatchObject({
      "sidebar.pinned": "user",
      "sidebar.openSection": "legacy",
    });

    // One legacy key sets one dismissal; its sibling is not invented.
    store.importLegacy({ dismissals: { upsell: true } });
    expect(store.get().dismissals).toEqual({
      referralCardUntil: null,
      upsell: true,
    });
    expect(store.provenance()).toMatchObject({
      "dismissals.upsell": "legacy",
      "dismissals.referralCardUntil": "default",
    });

    const reloaded = new PrefsStore({ file });
    expect(reloaded.get().sidebar).toEqual({
      pinned: false,
      openSection: "routines",
    });
    expect(reloaded.provenance()["sidebar.pinned"]).toBe("user");
  });

  it("counts an invalid leaf of a group and keeps its valid siblings", () => {
    const store = new PrefsStore({ file });
    const result = store.importLegacy({
      sidebar: { pinned: "yes" as never, openSection: "bots" },
      motion: "fast" as never,
    });
    expect(result.invalid).toBe(2);
    expect(result.row.sidebar).toEqual({ pinned: true, openSection: "bots" });
  });

  it("reads a group-level mark as the mark of each of its leaves", () => {
    fs.writeFileSync(
      file,
      JSON.stringify({
        row: { sidebar: { pinned: false, openSection: "bots" } },
        provenance: { sidebar: "user" },
      })
    );
    expect(new PrefsStore({ file }).provenance()).toMatchObject({
      "sidebar.pinned": "user",
      "sidebar.openSection": "user",
    });
  });

  it("keeps everything in memory with no file", () => {
    const store = new PrefsStore({ file: null });
    store.update({ theme: "light" });
    expect(store.get().theme).toBe("light");
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  // Spec 05 §31.5 a, spec 06 §23.5 b: every new leaf has a default, its own
  // provenance, and validates.
  it("carries the phase 5/6 leaves with their defaults and per-leaf provenance", () => {
    const store = new PrefsStore({ file });
    expect(store.get()).toMatchObject({
      keymap: {},
      appearance: { textSize: 14, bubbleTint: true },
      sounds: {
        enabled: true,
        perEvent: {},
        perBot: {},
        quietHours: { enabled: false, start: "22:00", end: "08:00" },
      },
      notch: {
        enabled: true,
        haptics: true,
        idleVisible: true,
        extraDisplays: false,
        showInNotch: true,
      },
      tour: { status: "unseen", at: null },
      onboardingFlow: null,
      onboardingExit: null,
      onboardingPairing: [],
    });
    store.update({
      sounds: {
        perBot: { "bot-1": "needs-me" },
        quietHours: { enabled: true, start: "23:30", end: "07:00" },
      },
      appearance: { textSize: 15 },
      keymap: { "new-bot": "Mod+Shift+B", "close-tab@terminal": null },
      notch: { haptics: false },
      tour: { status: "done", at: 5 },
      onboardingFlow: 2,
      onboardingExit: { to: "bot", botId: "b1", edit: true },
      onboardingPairing: ["whatsapp", "telegram"],
    });
    const provenance = new PrefsStore({ file }).provenance();
    expect(provenance).toMatchObject({
      "sounds.perBot": "user",
      "sounds.quietHours": "user",
      "sounds.enabled": "default",
      "appearance.textSize": "user",
      "appearance.bubbleTint": "default",
      keymap: "user",
      "notch.haptics": "user",
      "notch.enabled": "default",
      "tour.status": "user",
      onboardingExit: "user",
      onboardingPairing: "user",
    });
    expect(new PrefsStore({ file }).get().appearance).toEqual({
      textSize: 15,
      bubbleTint: true,
    });
  });

  it("refuses invalid values for the new leaves", () => {
    const store = new PrefsStore({ file: null });
    for (const patch of [
      { appearance: { textSize: 16 } },
      {
        sounds: { quietHours: { enabled: true, start: "25:00", end: "07:00" } },
      },
      { sounds: { perBot: { b: "loud" } } },
      { onboardingPairing: ["whatsapp", "whatsapp"] },
      { onboardingPairing: ["slack"] },
      { onboardingExit: { to: "bot" } },
      { tour: { status: "maybe" } },
    ])
      expect(() => store.update(patch as never)).toThrow();
  });
});
