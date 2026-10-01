import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, expect, it } from "vitest";

import { completedAttempts, rebuildRestoreIndex } from "./attempt-records";
import { backupsRoot, nodeIo } from "./backup";
import { runMigrations } from "./runner";
import type { MigrationStep } from "./types";
let home: string;
let userData: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "attempt-records-"));
  userData = path.join(home, "electron");
  fs.mkdirSync(userData);
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));
const run = (steps: MigrationStep[], options = {}) =>
  runMigrations({
    home,
    userData,
    appVersion: "test",
    steps,
    log: () => {},
    ...options,
  });
it("R7-T14: three partial commits retain their evidence after cleanup and rebuild a damaged index", async () => {
  let n = 0;
  const step: MigrationStep = {
    id: 4,
    name: "partial-test",
    plan: async (ctx) => {
      const dest = path.join(home, `old-${++n}.json`);
      fs.writeFileSync(dest, `old-${n}`);
      const staged = path.join(ctx.staging, "new");
      fs.writeFileSync(staged, `new-${n}`);
      return {
        writes: [
          {
            dest: path.join(userData, `new-${n}.json`),
            staged,
            kind: "create",
          },
        ],
        removals: [dest],
        stats: {},
        pending: 4 - n,
      };
    },
  };
  for (let i = 0; i < 3; i++) {
    expect(await run([step])).toMatchObject({ partial: [4], failed: null });
    expect(fs.existsSync(path.join(home, ".migrating"))).toBe(false);
    fs.writeFileSync(
      path.join(backupsRoot(home), "restore-index.jsonl"),
      "{torn"
    );
    expect(rebuildRestoreIndex(home)).toHaveLength((i + 1) * 2);
  }
  expect(completedAttempts(home)).toHaveLength(3);
  const first = completedAttempts(home)[0]!;
  fs.appendFileSync(path.join(first.directory, "attempt.json"), " ");
  const notes: string[] = [];
  expect(
    rebuildRestoreIndex(home, nodeIo, (message) => notes.push(message))
  ).toHaveLength(4);
  expect(notes.join("\n")).toMatch(/Manifest digest mismatch/);
});
it("a completion publish failure cannot roll back a recorded commit; restart completes it", async () => {
  const source = path.join(userData, "renderer-state.json");
  fs.writeFileSync(source, "old");
  const step: MigrationStep = {
    id: 3,
    name: "replacement-test",
    plan: async (ctx) => {
      const staged = path.join(ctx.staging, "state");
      fs.writeFileSync(staged, "new");
      return {
        writes: [{ dest: source, staged, kind: "replace-user" }],
        removals: [],
        stats: {},
      };
    },
  };
  const failed = await run([step], {
    io: {
      ...nodeIo,
      renameSync: (from: string, to: string) => {
        if (to.endsWith("completed.json")) throw new Error("completion ENOSPC");
        nodeIo.renameSync(from, to);
      },
    },
  });
  expect(failed.unresolved).toHaveLength(1);
  expect(fs.readFileSync(source, "utf8")).toBe("new");
  expect(completedAttempts(home)).toEqual([]);
  expect(await run([step])).toMatchObject({
    recovered: [expect.objectContaining({ action: "finished" })],
    failed: null,
  });
  expect(completedAttempts(home)).toHaveLength(1);
  const entries = rebuildRestoreIndex(home);
  expect(entries[0]).toMatchObject({
    op: "replace",
    source: "electron/renderer-state.json",
    backup: "home/electron/renderer-state.json",
  });
});
it("attempt records without completion are excluded and removed on rollback", async () => {
  const old = path.join(home, "old.json");
  fs.writeFileSync(old, "old");
  const step: MigrationStep = {
    id: 4,
    name: "removal-test",
    plan: async () => ({ writes: [], removals: [old], stats: {} }),
  };
  expect(
    await run([step], { hooks: { beforeRecord: () => "crash" } })
  ).toMatchObject({ crashed: true });
  expect(completedAttempts(home)).toEqual([]);
  await run([]);
  expect(fs.readFileSync(old, "utf8")).toBe("old");
  expect(
    fs
      .readdirSync(backupsRoot(home))
      .filter((name) => name !== "restore-index.jsonl")
  ).toEqual([]);
});
