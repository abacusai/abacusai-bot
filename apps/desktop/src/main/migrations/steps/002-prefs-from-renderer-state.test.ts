/**
 * C-T5: step 2 golden. `__fixtures__/renderer-state/*` (a real captured file,
 * v2/v3/v4 `local-code-ui-store`, every key, missing keys, invalid values, a
 * corrupt file) → `__fixtures__/expected-prefs/*.json` (the step's stats and
 * the committed `prefs.json`, or null when nothing is written). Compared
 * after stable key ordering; `UPDATE_GOLDEN=1` rewrites the expectations.
 * Then provenance against an existing `prefs.json`. The source file stays
 * byte-identical throughout.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AgentMode } from "#shared/agent-types";

import { backupsRoot } from "../backup";
import { readRecord } from "../record";
import { runMigrations } from "../runner";
import { prefsFromRendererState } from "./002-prefs-from-renderer-state";

const FIXTURES = path.join(__dirname, "__fixtures__", "renderer-state");
const EXPECTED = path.join(__dirname, "__fixtures__", "expected-prefs");
const NOW = new Date("2026-09-30T12:00:00.000Z");
const UPDATE = process.env.UPDATE_GOLDEN === "1";

let root: string;
let home: string;
let userData: string;
let source: string;
let prefs: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "prefs-step-"));
  home = path.join(root, "home");
  userData = path.join(home, "electron");
  fs.mkdirSync(userData, { recursive: true });
  source = path.join(userData, "renderer-state.json");
  prefs = path.join(home, "prefs.json");
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const step = prefsFromRendererState({ now: () => NOW });

const run = (rerun: number[] = []) =>
  runMigrations({
    home,
    userData,
    appVersion: "0.0.0-test",
    steps: [step],
    rerun,
    now: () => NOW,
    log: () => undefined,
  });

const sortKeys = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])])
    );
  return value;
};

const readJson = (file: string): unknown =>
  fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;

const storedPrefs = () =>
  readJson(prefs) as {
    row: Record<string, unknown> & { sounds: { enabled: boolean } };
    provenance: Record<string, string>;
  };

describe("C-T5 step 2 golden", () => {
  const fixtures = fs
    .readdirSync(FIXTURES)
    .filter((name) => /\.(json|txt)$/.test(name))
    .sort();

  it("has the fixtures the spec lists", () => {
    expect(fixtures).toEqual([
      "code-store-v2.json",
      "code-store-v3.json",
      "corrupt-file.txt",
      "every-key-v4.json",
      "invalid-values.json",
      "missing-keys.json",
      "real-captured.txt",
    ]);
  });

  it.each(fixtures)("%s", async (name) => {
    const bytes = fs.readFileSync(path.join(FIXTURES, name));
    fs.writeFileSync(source, bytes);

    const result = await run();
    expect(result.failed).toBeNull();
    const actual = sortKeys({
      stats: readRecord(home).applied[0]?.stats,
      prefs: readJson(prefs),
    });

    const expectedFile = path.join(
      EXPECTED,
      `${name.replace(/\.(json|txt)$/, "")}.json`
    );
    if (UPDATE) {
      fs.mkdirSync(EXPECTED, { recursive: true });
      fs.writeFileSync(expectedFile, `${JSON.stringify(actual, null, 2)}\n`);
    }
    expect(actual).toEqual(sortKeys(readJson(expectedFile)));
    expect(fs.readFileSync(source).equals(bytes)).toBe(true);
  });
});

describe("C-T5 provenance", () => {
  const legacy = (state: Record<string, string>) =>
    fs.writeFileSync(source, JSON.stringify(state));

  it("keeps a user theme of system against a legacy dark, and backs prefs.json up", async () => {
    const existing = `${JSON.stringify({
      row: { theme: "system", language: "system" },
      provenance: { theme: "user" },
    })}\n`;
    fs.writeFileSync(prefs, existing);
    legacy({ theme: "dark", "onboarding.step": "welcome" });

    await run();

    // The legacy "welcome" is the new "connected" (spec 06 F10).
    expect(storedPrefs().row).toMatchObject({
      theme: "system",
      onboardingStep: "connected",
      onboardingFlow: 2,
    });
    expect(storedPrefs().provenance).toMatchObject({
      theme: "user",
      onboardingStep: "legacy",
      onboardingFlow: "legacy",
      language: "default",
    });
    const [backup] = fs.readdirSync(backupsRoot(home));
    expect(
      fs.readFileSync(
        path.join(backupsRoot(home), backup ?? "", "home", "prefs.json"),
        "utf8"
      )
    ).toBe(existing);
  });

  it("a default field takes the legacy value; a legacy field takes a newer one", async () => {
    legacy({
      theme: "dark",
      "local-code-ui-store": JSON.stringify({
        state: { globalSelectedMode: "PLAN" },
        version: 4,
      }),
    });
    await run();
    expect(storedPrefs().row).toMatchObject({
      theme: "dark",
      defaultMode: AgentMode.PlanMode,
    });
    expect(storedPrefs().provenance.theme).toBe("legacy");

    // The old UI changed the theme and dropped the code store since.
    legacy({ theme: "light" });
    await run([2]);
    expect(storedPrefs().row).toMatchObject({
      theme: "light",
      defaultMode: AgentMode.Yolo,
    });
    expect(storedPrefs().provenance).toMatchObject({
      theme: "legacy",
      defaultMode: "default",
    });
  });

  // R5-T28 (main): an old sound opt-out survives the change of mechanism.
  it("imports config.json's sound opt-out as legacy, never over a user choice", async () => {
    const config = path.join(home, "config.json");
    fs.writeFileSync(
      config,
      JSON.stringify({ notificationSoundDisabled: true })
    );
    legacy({ theme: "dark" });
    await run();
    expect(storedPrefs().row.sounds).toMatchObject({ enabled: false });
    expect(storedPrefs().provenance["sounds.enabled"]).toBe("legacy");
    // Idempotent: a rerun writes nothing new.
    const before = fs.readFileSync(prefs);
    await run([2]);
    expect(fs.readFileSync(prefs).equals(before)).toBe(true);

    // The user turned sound on in the new UI: a later opt-out cannot move it.
    const stored = storedPrefs();
    stored.row.sounds.enabled = true;
    stored.provenance["sounds.enabled"] = "user";
    fs.writeFileSync(prefs, JSON.stringify(stored));
    await run([2]);
    expect(storedPrefs().row.sounds.enabled).toBe(true);
    expect(storedPrefs().provenance["sounds.enabled"]).toBe("user");
  });

  it("leaves sounds at the default without an opt-out", async () => {
    fs.writeFileSync(
      path.join(home, "config.json"),
      JSON.stringify({ notificationSoundDisabled: false })
    );
    legacy({ theme: "dark" });
    await run();
    expect(storedPrefs().row.sounds.enabled).toBe(true);
    expect(storedPrefs().provenance["sounds.enabled"]).toBe("default");
  });

  it("writes nothing when the import changes nothing", async () => {
    legacy({ theme: "dark" });
    await run();
    const before = fs.readFileSync(prefs);
    await run([2]);
    expect(fs.readFileSync(prefs).equals(before)).toBe(true);
    expect(readRecord(home).applied[0]?.stats).toMatchObject({ written: 0 });
    // No legacy file backup; the empty commit still retains its manifest.
    expect(
      fs.readdirSync(backupsRoot(home)).some((name) => name.endsWith(".jsonl"))
    ).toBe(true);
  });

  it("replaces a corrupt prefs.json, keeping a copy", async () => {
    fs.writeFileSync(prefs, "{corrupt");
    legacy({ theme: "dark" });
    await run();
    expect(storedPrefs().row.theme).toBe("dark");
    const [backup] = fs.readdirSync(backupsRoot(home));
    expect(
      fs.readFileSync(
        path.join(backupsRoot(home), backup ?? "", "home", "prefs.json"),
        "utf8"
      )
    ).toBe("{corrupt");
  });

  it("runs with no renderer-state.json at all", async () => {
    const result = await run();
    expect(result.applied).toEqual([2]);
    expect(fs.existsSync(prefs)).toBe(false);
    expect(fs.existsSync(source)).toBe(false);
  });
});
