import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, expect, it } from "vitest";

import { completedAttempts } from "./attempt-records";
import { backupsRoot, nodeIo } from "./backup";
import { readRecord } from "./record";
import {
  restoreLegacyFiles,
  restoreLegacyHome,
  profileHomes,
} from "./restore-legacy";
import { runMigrations } from "./runner";
import type { MigrationStep } from "./types";
let base: string;
beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "restore-legacy-"));
});
afterEach(() => fs.rmSync(base, { force: true, recursive: true }));
const write = (file: string, text: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
const seed = (home: string, text = "original") => {
  write(path.join(home, "electron/renderer-state.json"), text);
  write(path.join(home, "prefs.json"), "authoritative");
  write(path.join(home, "transcripts/s1.json"), text);
  write(
    path.join(home, "threads/.archive-index.json"),
    JSON.stringify({
      version: 1,
      archived: {
        s1: { fingerprint: "hash", updatedAt: "date" },
        untouched: { fingerprint: "hash", updatedAt: "date" },
      },
    })
  );
  write(path.join(home, "electron/renderer-state.retired.json"), "retired");
};
const steps = (home: string): MigrationStep[] => [
  {
    id: 3,
    name: "restore-state-test",
    plan: async (ctx) => {
      const staged = path.join(ctx.staging, "new");
      write(staged, "stripped");
      const pref = path.join(ctx.staging, "prefs");
      write(pref, "new preference");
      return {
        writes: [
          {
            dest: path.join(home, "electron/renderer-state.json"),
            staged,
            kind: "replace-user",
          },
          {
            dest: path.join(home, "prefs.json"),
            staged: pref,
            kind: "replace-user",
          },
        ],
        removals: [],
        stats: {},
      };
    },
  },
  {
    id: 4,
    name: "restore-transcript-test",
    plan: async () => ({
      writes: [],
      removals: [path.join(home, "transcripts/s1.json")],
      stats: {},
    }),
  },
];
const migrate = (home: string, io = nodeIo) =>
  runMigrations({
    home,
    userData: path.join(home, "electron"),
    appVersion: "test",
    steps: steps(home),
    log: () => {},
    io,
  });
it("R7-T15 restores both profiles through two cycles from each cycle's latest evidence", async () => {
  const secondary = path.join(base, "profiles/second");
  write(
    path.join(base, "profiles.json"),
    JSON.stringify({ profiles: { first: ".", second: "profiles/second" } })
  );
  for (const home of [base, secondary]) {
    seed(home);
    expect((await migrate(home)).failed).toBeNull();
    write(path.join(backupsRoot(home), "restore-index.jsonl"), "{torn");
  }
  const first = await restoreLegacyFiles(base);
  expect(first).toHaveLength(2);
  for (const home of [base, secondary]) {
    expect(
      fs.readFileSync(path.join(home, "transcripts/s1.json"), "utf8")
    ).toBe("original");
    expect(
      fs.readFileSync(path.join(home, "electron/renderer-state.json"), "utf8")
    ).toBe("original");
    expect(fs.readFileSync(path.join(home, "prefs.json"), "utf8")).toBe(
      "new preference"
    );
    expect(
      fs.existsSync(path.join(home, "electron/renderer-state.retired.json"))
    ).toBe(false);
    expect(readRecord(home).applied.every((e) => e.restoredAt)).toBe(true);
    const index = JSON.parse(
      fs.readFileSync(path.join(home, "threads/.archive-index.json"), "utf8")
    );
    expect(index.archived.s1).toBeUndefined();
    expect(index.archived.untouched).toBeDefined();
    expect((await restoreLegacyHome(home)).restored).toEqual([]);
    seed(home, "cycle two");
    expect((await migrate(home)).applied).toEqual([3, 4]);
  }
  await restoreLegacyFiles(base);
  for (const home of [base, secondary]) {
    expect(
      fs.readFileSync(path.join(home, "transcripts/s1.json"), "utf8")
    ).toBe("cycle two");
    expect(
      fs.readFileSync(path.join(home, "electron/renderer-state.json"), "utf8")
    ).toBe("cycle two");
    expect(
      fs
        .readFileSync(
          path.join(backupsRoot(home), "restorations.jsonl"),
          "utf8"
        )
        .trim()
        .split("\n")
    ).toHaveLength(2);
  }
});
it("preserves conflicting destinations and reports their restored sibling", async () => {
  seed(base);
  await migrate(base);
  write(path.join(base, "transcripts/s1.json"), "legacy edit");
  const result = await restoreLegacyHome(base);
  expect(result.collisions).toHaveLength(1);
  expect(fs.readFileSync(result.collisions[0]!, "utf8")).toBe("original");
  expect(fs.readFileSync(path.join(base, "transcripts/s1.json"), "utf8")).toBe(
    "legacy edit"
  );
});
it("skips damaged backups without consuming their destination", async () => {
  seed(base);
  await migrate(base);
  const attempt = completedAttempts(base).find((a) => a.manifest.step === 4)!;
  write(
    path.join(attempt.directory, attempt.manifest.ops[0]!.backup!),
    "damaged"
  );
  const result = await restoreLegacyHome(base);
  expect(result.skipped).toHaveLength(1);
  expect(fs.existsSync(path.join(base, "transcripts/s1.json"))).toBe(false);
});
it("settles an interrupted completion before restoring", async () => {
  seed(base);
  const failed = await migrate(base, {
    ...nodeIo,
    renameSync: (from, to) => {
      if (to.endsWith("completed.json")) throw new Error("interrupted");
      nodeIo.renameSync(from, to);
    },
  });
  expect(failed.unresolved).toHaveLength(1);
  const result = await restoreLegacyHome(base);
  expect(result.restored).toContain(
    path.join(base, "electron/renderer-state.json")
  );
});
it("rejects profile traversal and corrupt restoration generations", async () => {
  write(
    path.join(base, "profiles.json"),
    JSON.stringify({ profiles: { bad: "../other" } })
  );
  expect(() => profileHomes(base)).toThrow(/outside/);
  seed(base);
  await migrate(base);
  write(path.join(backupsRoot(base), "restorations.jsonl"), "{torn");
  await expect(restoreLegacyHome(base)).rejects.toThrow();
});
it("latest completed partial attempt wins per destination", async () => {
  seed(base);
  let cycle = 0;
  const partial: MigrationStep = {
    id: 3,
    name: "partial-state-test",
    plan: async (ctx) => {
      const staged = path.join(ctx.staging, "state");
      write(staged, "stripped " + ++cycle);
      return {
        writes: [
          {
            dest: path.join(base, "electron/renderer-state.json"),
            staged,
            kind: "replace-user",
          },
        ],
        removals: [],
        stats: {},
        pending: 3 - cycle,
      };
    },
  };
  for (let i = 0; i < 3; i++)
    await runMigrations({
      home: base,
      userData: path.join(base, "electron"),
      appVersion: "test",
      steps: [partial],
      log: () => {},
    });
  const result = await restoreLegacyHome(base);
  expect(result.restored).toHaveLength(1);
  expect(
    fs.readFileSync(path.join(base, "electron/renderer-state.json"), "utf8")
  ).toBe("stripped 2");
});
it("keeps renderer retirement and canonical evidence until a conflict is resolved", async () => {
  seed(base);
  await migrate(base);
  const destination = path.join(base, "electron/renderer-state.json");
  const marker = path.join(base, "electron/renderer-state.retired.json");
  write(destination, "unrelated retained state edit");
  const result = await restoreLegacyHome(base);
  expect(result.collisions).toHaveLength(1);
  expect(fs.existsSync(marker)).toBe(true);
  const journal = fs.readFileSync(
    path.join(backupsRoot(base), "restorations.jsonl"),
    "utf8"
  );
  expect(JSON.parse(journal.trim()).destinations).not.toContain(destination);
  expect(
    readRecord(base).applied.find((entry) => entry.id === 3)?.restoredAt
  ).toBeUndefined();
  fs.rmSync(destination);
  expect((await restoreLegacyHome(base)).restored).toContain(destination);
  expect(fs.readFileSync(destination, "utf8")).toBe("original");
  expect(fs.existsSync(marker)).toBe(false);
});
it("R18 preserves a corrupt archive index and reconstructs completed archive evidence", async () => {
  seed(base);
  await migrate(base);
  write(path.join(base, "threads/.archive-index.json"), "{");
  const result = await restoreLegacyHome(base);
  expect(result.skipped).toEqual([]);
  expect(fs.readFileSync(path.join(base, "transcripts/s1.json"), "utf8")).toBe(
    "original"
  );
  const names = fs.readdirSync(path.join(base, "threads"));
  const preserved = names.find((name) =>
    name.startsWith(".archive-index.json.corrupt-")
  );
  expect(preserved).toBeDefined();
  expect(fs.readFileSync(path.join(base, "threads", preserved!), "utf8")).toBe(
    "{"
  );
  expect(
    JSON.parse(
      fs.readFileSync(path.join(base, "threads/.archive-index.json"), "utf8")
    ).archived.s1
  ).toBeUndefined();
});
for (const damage of ["manifest", "completion", "directory"] as const) {
  it(`aborts restore with ${damage} evidence missing or invalid without replacing the index`, async () => {
    seed(base);
    await migrate(base);
    const attempt = completedAttempts(base).find((a) => a.manifest.step === 4)!;
    const index = path.join(backupsRoot(base), "restore-index.jsonl");
    const before = fs.readFileSync(index, "utf8");
    if (damage === "manifest")
      write(path.join(attempt.directory, "attempt.json"), "{");
    else
      fs.rmSync(
        damage === "directory"
          ? attempt.directory
          : path.join(attempt.directory, "completed.json"),
        { recursive: true }
      );
    await expect(restoreLegacyHome(base)).rejects.toThrow(/evidence/i);
    expect(fs.readFileSync(index, "utf8")).toBe(before);
    expect(fs.existsSync(path.join(base, "transcripts/s1.json"))).toBe(false);
  });
}
it("R18 reconstruction does not re-archive destinations consumed by an earlier restore", async () => {
  seed(base);
  await migrate(base);
  await restoreLegacyHome(base);
  write(path.join(base, "threads/.archive-index.json"), "{");
  expect((await restoreLegacyHome(base)).restored).toEqual([]);
  expect(
    JSON.parse(
      fs.readFileSync(path.join(base, "threads/.archive-index.json"), "utf8")
    ).archived.s1
  ).toBeUndefined();
});
