/**
 * The registered steps against a legacy home laid out as a shipped build
 * leaves it (`__fixtures__/legacy-home`: `local-code.json`, `bots.json`,
 * `cronjobs.json`, `transcripts/`, `electron/` as userData with
 * `renderer-state.json` and `window-state.json`; synthetic values). The run
 * derives `threads/` and `prefs.json` and records itself, never touches a
 * legacy file, is a no-op the second time, and the live sync keeps
 * `prefs.json` following the old UI afterwards.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { getPath: () => os.tmpdir(), on: vi.fn() },
  ipcMain: { on: vi.fn() },
}));

import { AgentMode } from "#shared/agent-types";

import { installLegacyPrefsSync } from "../services/config/legacy-prefs";
import { PrefsStore } from "../services/config/prefs-store";
import { RendererStateStore } from "../services/config/renderer-state";
import { ThreadStore } from "../services/session/thread-store";
import { backupsRoot, migratingRoot } from "./backup";
import { readRecord } from "./record";
import { runMigrations } from "./runner";
import { MIGRATION_STEPS } from "./steps";

const FIXTURE = path.join(__dirname, "__fixtures__", "legacy-home");

let root: string;
let home: string;
let userData: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-home-"));
  home = path.join(root, ".abacusai-bot");
  userData = path.join(home, "electron");
  fs.cpSync(FIXTURE, home, { recursive: true });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const hashes = (dir: string): Record<string, string> => {
  const out: Record<string, string> = {};
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else
        out[path.relative(dir, full)] = crypto
          .createHash("sha256")
          .update(fs.readFileSync(full))
          .digest("hex");
    }
  };
  walk(dir);
  return out;
};

const migrate = () =>
  runMigrations({
    home,
    userData,
    appVersion: "1.2.3",
    steps: MIGRATION_STEPS,
    log: () => undefined,
  });

describe("migrating a legacy home", () => {
  it("derives threads/ and prefs.json, touches nothing else, and is a no-op the second time", async () => {
    // A launch that died before committing left staging behind.
    const leftover = path.join(
      migratingRoot(home),
      "2-prefs-from-renderer-state"
    );
    fs.mkdirSync(leftover, { recursive: true });
    fs.writeFileSync(path.join(leftover, "prefs.json"), "{half");
    const before = hashes(home);
    delete before[path.relative(home, path.join(leftover, "prefs.json"))];

    const first = await migrate();
    expect(first).toMatchObject({ applied: [1, 2], failed: null });
    expect(first.recovered).toEqual([
      { staging: leftover, action: "discarded" },
    ]);

    const after = hashes(home);
    for (const [file, hash] of Object.entries(before))
      expect({ file, hash: after[file] }).toEqual({ file, hash });
    expect(
      Object.keys(after)
        .filter((file) => !(file in before))
        .sort()
    ).toEqual([
      "migrations.json",
      "prefs.json",
      path.join("threads", "sess-fixture-1.json"),
    ]);
    expect(fs.existsSync(migratingRoot(home))).toBe(false);
    expect(fs.existsSync(backupsRoot(home))).toBe(false);

    // What the old UI shows, read through the prefs store.
    const row = new PrefsStore({ file: path.join(home, "prefs.json") }).get();
    expect(row).toMatchObject({
      theme: "dark",
      language: "ja-JP",
      sidebar: { pinned: true, openSection: "sessions" },
      pinned: { sessionIds: ["sess-fixture-1"], botIds: ["bot-fixture-1"] },
      models: {
        selectedModelId: "abacus/route-llm-code",
        favoriteModelIds: ["abacus/route-llm-code"],
        perWorkspace: {},
      },
      defaultMode: AgentMode.Auto,
      workspaceExpanded: { "00000000-0000-4000-8000-000000000003": true },
    });
    // The transcript, through the thread store as `ai.hydrate` reads it.
    const thread = new ThreadStore({ home: () => home }).readCurrentFile(
      "sess-fixture-1"
    );
    expect(thread?.source).toEqual({
      kind: "transcript-v1",
      updatedAt: "2026-09-01T10:00:00.000Z",
      segments: 2,
      fingerprint: expect.any(String),
    });
    expect(
      thread?.messages.map((message) => [
        message.role,
        message.parts.map((part) => (part.type === "text" ? part.content : "")),
      ])
    ).toEqual([
      ["user", ["hello"]],
      ["assistant", ["hi there"]],
    ]);
    expect(readRecord(home).applied).toEqual([
      expect.objectContaining({
        id: 1,
        name: "transcripts-v2",
        appVersion: "1.2.3",
        stats: expect.objectContaining({ files: 1, converted: 1, skipped: 0 }),
      }),
      expect.objectContaining({
        id: 2,
        name: "prefs-from-renderer-state",
        appVersion: "1.2.3",
        stats: expect.objectContaining({ keys: 4, invalid: 0, written: 1 }),
      }),
    ]);

    const settled = hashes(home);
    const second = await migrate();
    expect(second).toMatchObject({ applied: [], failed: null, recovered: [] });
    expect(hashes(home)).toEqual(settled);
  });

  it("keeps prefs.json following the old UI after the migration", async () => {
    await migrate();
    const prefs = new PrefsStore({ file: path.join(home, "prefs.json") });
    const legacy = new RendererStateStore(
      path.join(userData, "renderer-state.json")
    );
    installLegacyPrefsSync(legacy, prefs);

    // The old UI switches theme, unpins the bot and changes language.
    legacy.set("theme", "light");
    legacy.set(
      "local-code-ui-store",
      JSON.stringify({
        state: {
          isSidebarVisible: true,
          selectedModelId: "abacus/route-llm-code",
          favoriteModelIds: [],
          globalSelectedMode: "PLAN",
          pinnedSessionIds: ["sess-fixture-1"],
          pinnedBotIds: [],
        },
        version: 4,
      })
    );
    legacy.set(
      "abacusai-bot-language",
      JSON.stringify({ state: { languageCode: "ko-KR" }, version: 0 })
    );

    const reread = new PrefsStore({
      file: path.join(home, "prefs.json"),
    }).get();
    expect(reread).toMatchObject({
      theme: "light",
      language: "ko-KR",
      defaultMode: AgentMode.PlanMode,
      pinned: { sessionIds: ["sess-fixture-1"], botIds: [] },
      models: { favoriteModelIds: [] },
      workspaceExpanded: {},
    });
    legacy.flushSync();
  });

  it("does not record step 2 when renderer-state.json exists but cannot be read; the next launch imports it", async () => {
    const state = path.join(userData, "renderer-state.json");
    const aside = path.join(root, "state-aside.json");
    fs.renameSync(state, aside);
    fs.mkdirSync(state); // EISDIR, as EACCES or EBUSY would be

    const first = await migrate();
    expect(first.failed).toMatchObject({ id: 2 });
    expect(readRecord(home).applied.map((entry) => entry.id)).toEqual([1]);

    fs.rmdirSync(state);
    fs.renameSync(aside, state);
    const second = await migrate();
    expect(second).toMatchObject({ applied: [2], failed: null });
    expect(readRecord(home).applied.at(-1)?.stats.keys).toBeGreaterThan(0);
  });
});
