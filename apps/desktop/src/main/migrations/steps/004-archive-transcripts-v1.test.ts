/**
 * C-T9: step 4 (registered in this test only) after step 1. Archives per
 * file with v1-derived twins and with `agui` twins (with and without
 * `migratedFrom`), keeps a v1 file newer than its `agui` takeover,
 * quarantines what step 1 skipped, and converts then archives a file with no
 * twin across two runs (the first is committed but not recorded).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { backupsRoot, pruneBackups, quarantineRoot } from "../backup";
import { readRecord } from "../record";
import { runMigrations } from "../runner";
import type { MigrationStep } from "../types";
import { transcriptsV2 } from "./001-transcripts-v2";
import { archiveTranscriptsV1 } from "./004-archive-transcripts-v1";
import { MIGRATION_STEPS } from "./index";

let root: string;
let home: string;
let userData: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "archive-step-"));
  home = path.join(root, ".abacusai-bot");
  userData = path.join(home, "electron");
  fs.mkdirSync(userData, { recursive: true });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const transcripts = () => path.join(home, "transcripts");
const threads = () => path.join(home, "threads");

const put = (dir: string, name: string, contents: unknown) => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, name),
    typeof contents === "string" ? contents : JSON.stringify(contents)
  );
};

const v1 = (sessionId: string, updatedAt = "2026-09-01T10:00:00.000Z") => ({
  version: 1,
  sessionId,
  updatedAt,
  segments: [{ type: "text", id: "u1", source: "user", content: "hi" }],
});

const agui = (migratedFrom?: string) => ({
  version: 2,
  threadId: "x",
  updatedAt: "2027-01-01T00:00:00.000Z",
  source: {
    kind: "agui",
    ...(migratedFrom === undefined
      ? {}
      : { migratedFrom: { updatedAt: migratedFrom } }),
  },
  messages: [],
  runs: [],
});

const run = (steps: readonly MigrationStep[]) =>
  runMigrations({
    home,
    userData,
    appVersion: "0.0.0-test",
    steps,
    log: () => undefined,
  });

/** Every file under the step's backup directories, relative to home. */
const archived = (): string[] => {
  const root = backupsRoot(home);
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root)
    .filter((name) => name.endsWith("-4-archive-transcripts-v1"))
    .flatMap((name) => {
      const dir = path.join(root, name, "home", "transcripts");
      return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
    })
    .sort();
};

describe("C-T9 step 4 archive-transcripts-v1", () => {
  it("is not registered in the shipped steps", () => {
    expect(MIGRATION_STEPS.map((step) => step.id)).not.toContain(4);
  });

  it("archives per file, keeps, quarantines, and converts then archives over two runs", async () => {
    // Converted by step 1, so their twins are current v1-derived files.
    put(transcripts(), "derived.json", v1("derived"));
    put(transcripts(), "agui-migrated.json", v1("agui-migrated"));
    put(
      transcripts(),
      "agui-newer-v1.json",
      v1("agui-newer-v1", "2026-10-01T00:00:00.000Z")
    );
    put(transcripts(), "agui-orphan.json", v1("agui-orphan"));
    // Skipped by step 1.
    put(transcripts(), "corrupt.json", "{nope");
    put(transcripts(), "not-v1.json", { version: 7 });
    put(transcripts(), "bad name.json", v1("bad name"));
    expect(await run([transcriptsV2()])).toMatchObject({ applied: [1] });

    // AG-UI took three threads over after step 1.
    put(threads(), "agui-migrated.json", agui("2026-09-01T10:00:00.000Z"));
    put(threads(), "agui-newer-v1.json", agui("2026-09-01T10:00:00.000Z"));
    put(threads(), "agui-orphan.json", agui());
    // Written after step 1 by an old build: no twin, and a stale one.
    put(transcripts(), "late.json", v1("late"));
    put(transcripts(), "stale.json", v1("stale", "2026-12-01T00:00:00.000Z"));
    put(threads(), "stale.json", {
      version: 2,
      threadId: "stale",
      updatedAt: "2026-09-01T10:00:00.000Z",
      source: {
        kind: "transcript-v1",
        updatedAt: "2026-09-01T10:00:00.000Z",
        segments: 1,
      },
      messages: [],
    });
    const corruptBytes = fs.readFileSync(
      path.join(transcripts(), "corrupt.json")
    );

    const step4 = archiveTranscriptsV1();
    const first = await run([transcriptsV2(), step4]);
    expect(first).toMatchObject({ applied: [], partial: [4], failed: null });
    expect(readRecord(home).applied.map((entry) => entry.id)).toEqual([1]);

    expect(archived()).toEqual([
      "agui-migrated.json",
      "agui-orphan.json",
      "bad name.json",
      "corrupt.json",
      "derived.json",
      "not-v1.json",
    ]);
    expect(
      fs.readdirSync(path.join(quarantineRoot(home), "transcripts")).sort()
    ).toEqual(["bad name.json", "corrupt.json", "not-v1.json"]);
    expect(
      fs.readFileSync(
        path.join(quarantineRoot(home), "transcripts", "corrupt.json")
      )
    ).toEqual(corruptBytes);
    // Converted, not yet archived; the takeover's newer v1 stays.
    expect(fs.readdirSync(transcripts()).sort()).toEqual([
      "agui-newer-v1.json",
      "late.json",
      "stale.json",
    ]);
    expect(
      JSON.parse(fs.readFileSync(path.join(threads(), "late.json"), "utf8"))
        .source
    ).toEqual({
      kind: "transcript-v1",
      updatedAt: "2026-09-01T10:00:00.000Z",
      segments: 1,
    });
    expect(
      JSON.parse(fs.readFileSync(path.join(threads(), "stale.json"), "utf8"))
        .source.updatedAt
    ).toBe("2026-12-01T00:00:00.000Z");
    // AG-UI's files are untouched.
    expect(
      JSON.parse(
        fs.readFileSync(path.join(threads(), "agui-orphan.json"), "utf8")
      ).source
    ).toEqual({ kind: "agui" });

    // The next launch finishes the job and records the step.
    const second = await run([transcriptsV2(), step4]);
    expect(second).toMatchObject({ applied: [4], partial: [], failed: null });
    expect(readRecord(home).applied.at(-1)).toMatchObject({
      id: 4,
      stats: { archived: 2, kept: 1, converted: 0, quarantined: 0 },
    });
    expect(fs.readdirSync(transcripts())).toEqual(["agui-newer-v1.json"]);
    expect(archived()).toEqual(
      expect.arrayContaining(["late.json", "stale.json"])
    );

    // A third launch has nothing to do.
    expect(await run([transcriptsV2(), step4])).toMatchObject({
      applied: [],
      partial: [],
    });
  });

  it("keeps quarantined files 90 days", async () => {
    put(transcripts(), "corrupt.json", "{nope");
    await run([archiveTranscriptsV1()]);
    const file = path.join(quarantineRoot(home), "transcripts", "corrupt.json");
    expect(fs.existsSync(file)).toBe(true);
    const day = 24 * 60 * 60 * 1000;
    pruneBackups(home, { now: new Date(Date.now() + 89 * day) });
    expect(fs.existsSync(file)).toBe(true);
    pruneBackups(home, { now: new Date(Date.now() + 91 * day) });
    expect(fs.existsSync(file)).toBe(false);
  });
});
