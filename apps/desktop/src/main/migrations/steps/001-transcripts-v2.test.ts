/**
 * C-T4: step 1 against fixture homes. Skip rules (unsafe name, corrupt,
 * not v1, a newer or current v1-derived twin, an `agui` twin), a stale
 * v1-derived twin replaced as `replace-derived`, an unparseable twin replaced
 * as `replace-user` (backed up), stats, idempotence, and the legacy files left
 * byte-identical. Then every C-T1 fixture through the real runner, compared
 * with its golden, and a directory large enough to yield.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { v1ToThreadFile } from "@abacus-ai/contract/transcript/thread-file";

import { fingerprintV1 } from "../../services/session/thread-store";
import { backupsRoot, migratingRoot } from "../backup";
import { readRecord } from "../record";
import { runMigrations } from "../runner";
import type { MigrationContext } from "../types";
import { transcriptsV2 } from "./001-transcripts-v2";

const SHARED_FIXTURES = path.join(
  __dirname,
  "..",
  "..",
  "..",
  "shared",
  "transcript",
  "__fixtures__"
);

let root: string;
let home: string;
let userData: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "transcripts-step-"));
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

const SEGMENTS = [
  { type: "text", id: "u1", source: "user", content: "hi", at: 1 },
  { type: "text", id: "b1", source: "bot", content: "hello", at: 2 },
];

const v1 = (sessionId: string, updatedAt = "2026-09-01T10:00:00.000Z") => ({
  version: 1,
  sessionId,
  updatedAt,
  segments: SEGMENTS,
});

const derived = (sessionId: string, updatedAt: string) =>
  v1ToThreadFile({ threadId: sessionId, updatedAt, segments: [] });

const AGUI = {
  version: 2,
  threadId: "agui",
  updatedAt: "2026-01-01T00:00:00.000Z",
  source: { kind: "agui" },
  messages: [],
  runs: [],
};

/** The C-T4 layout: one file per rule. */
const layOut = () => {
  put(transcripts(), "fresh.json", v1("fresh"));
  put(transcripts(), "stale.json", v1("stale", "2026-09-02T00:00:00.000Z"));
  put(threads(), "stale.json", derived("stale", "2026-09-01T00:00:00.000Z"));
  put(transcripts(), "current.json", v1("current"));
  put(
    threads(),
    "current.json",
    derived("current", "2026-09-01T10:00:00.000Z")
  );
  put(transcripts(), "newer.json", v1("newer"));
  put(threads(), "newer.json", derived("newer", "2026-12-01T00:00:00.000Z"));
  put(transcripts(), "agui.json", v1("agui", "2027-01-01T00:00:00.000Z"));
  put(threads(), "agui.json", AGUI);
  put(transcripts(), "garbage-twin.json", v1("garbage-twin"));
  put(threads(), "garbage-twin.json", "{half");
  put(transcripts(), "corrupt.json", "{not json");
  put(transcripts(), "truncated.json", JSON.stringify(v1("t")).slice(0, 40));
  put(transcripts(), "not-v1.json", { version: 3, segments: [] });
  put(transcripts(), "no-segments.json", { version: 1, sessionId: "x" });
  put(transcripts(), "bad name.json", v1("bad name"));
  put(transcripts(), ".hidden.json", v1(".hidden"));
  put(transcripts(), "notes.txt", "not a transcript");
  const noTime = { ...v1("no-time") } as Record<string, unknown>;
  delete noTime.updatedAt;
  put(transcripts(), "no-time.json", noTime);
  fs.mkdirSync(path.join(transcripts(), "folder.json"));
  // A newer build's twin, and one that cannot be read: never replaced.
  put(transcripts(), "foreign.json", v1("foreign"));
  put(threads(), "foreign.json", { ...AGUI, version: 3 });
  put(transcripts(), "twin-dir.json", v1("twin-dir"));
  fs.mkdirSync(path.join(threads(), "twin-dir.json"));
  // Cleared, but the v1 removal failed: its marker holds these bytes.
  put(transcripts(), "cleared.json", v1("cleared"));
  put(threads(), "cleared.cleared", {
    version: 1,
    token: "t-1",
    clearedAt: "2026-09-02T00:00:00.000Z",
    v1Fingerprint: fingerprintV1(JSON.stringify(v1("cleared"))),
  });
  // Over the cap the classification test sets.
  put(transcripts(), "big.json", {
    ...v1("big"),
    segments: [
      { type: "text", id: "b", source: "bot", content: "x".repeat(3000) },
    ],
  });
};

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
  if (fs.existsSync(dir)) walk(dir);
  return out;
};

const readJson = (file: string) => JSON.parse(fs.readFileSync(file, "utf8"));

const run = (rerun: number[] = []) =>
  runMigrations({
    home,
    userData,
    appVersion: "0.0.0-test",
    steps: [transcriptsV2()],
    rerun,
    log: () => undefined,
  });

const context = (): MigrationContext => {
  const staging = path.join(migratingRoot(home), "1-transcripts-v2");
  fs.mkdirSync(staging, { recursive: true });
  return {
    home,
    userData,
    appVersion: "0.0.0-test",
    staging,
    progress: () => undefined,
    log: () => undefined,
  };
};

describe("C-T4 step 1 transcripts-v2", () => {
  it("classifies every write and skip", async () => {
    layOut();
    const plan = await transcriptsV2({ maxBytes: 2000 }).plan(context());
    expect(
      Object.fromEntries(
        plan.writes.map((write) => [path.basename(write.dest), write.kind])
      )
    ).toEqual({
      "fresh.json": "create",
      "garbage-twin.json": "replace-user",
      "no-time.json": "create",
      "stale.json": "replace-derived",
    });
    for (const write of plan.writes)
      expect(path.dirname(write.dest)).toBe(threads());
    expect(plan.removals).toEqual([]);
    expect(plan.stats).toEqual({
      files: 17,
      converted: 4,
      created: 2,
      replaced: 2,
      upToDate: 2,
      agui: 1,
      foreign: 1,
      twinUnreadable: 1,
      cleared: 1,
      skipped: 6,
      unsafe: 2,
      corrupt: 2,
      notV1: 2,
      unreadable: 0,
      tooLarge: 1,
      vanished: 0,
      failed: 0,
    });
  });

  it("isolates a file that throws, and goes on", async () => {
    for (let index = 0; index < 5; index++)
      put(transcripts(), `s${index}.json`, v1(`s${index}`));
    const write = fs.writeFileSync;
    const spy = vi
      .spyOn(fs, "writeFileSync")
      .mockImplementation((file, ...rest) => {
        if (String(file).endsWith(`${path.sep}s2.json`))
          throw Object.assign(new Error("no space"), { code: "ENOSPC" });
        return write(file, ...rest);
      });
    try {
      const plan = await transcriptsV2().plan(context());
      expect(plan.stats).toMatchObject({ converted: 4, failed: 1 });
      expect(plan.writes.map((entry) => path.basename(entry.dest))).toEqual([
        "s0.json",
        "s1.json",
        "s3.json",
        "s4.json",
      ]);
    } finally {
      spy.mockRestore();
    }
  });

  it("commits, keeps the legacy files byte-identical, and is idempotent", async () => {
    layOut();
    const legacy = hashes(transcripts());
    const aguiBefore = fs.readFileSync(path.join(threads(), "agui.json"));
    const newerBefore = fs.readFileSync(path.join(threads(), "newer.json"));

    const first = await run();
    expect(first).toMatchObject({ applied: [1], failed: null });
    expect(hashes(transcripts())).toEqual(legacy);

    expect(readJson(path.join(threads(), "fresh.json"))).toEqual(
      JSON.parse(
        JSON.stringify(
          v1ToThreadFile({
            threadId: "fresh",
            updatedAt: "2026-09-01T10:00:00.000Z",
            segments: SEGMENTS,
            fingerprint: fingerprintV1(JSON.stringify(v1("fresh"))),
          })
        )
      )
    );
    const stale = readJson(path.join(threads(), "stale.json"));
    expect(stale.source).toEqual({
      kind: "transcript-v1",
      updatedAt: "2026-09-02T00:00:00.000Z",
      segments: 2,
      fingerprint: fingerprintV1(
        JSON.stringify(v1("stale", "2026-09-02T00:00:00.000Z"))
      ),
    });
    // Never replaced, never converted.
    expect(readJson(path.join(threads(), "foreign.json")).version).toBe(3);
    expect(
      fs.statSync(path.join(threads(), "twin-dir.json")).isDirectory()
    ).toBe(true);
    expect(fs.existsSync(path.join(threads(), "cleared.json"))).toBe(false);
    expect(stale.messages).toHaveLength(2);
    // No `updatedAt`: the file's mtime stands in.
    const noTime = readJson(path.join(threads(), "no-time.json"));
    expect(noTime.source.updatedAt).toBe(
      fs.statSync(path.join(transcripts(), "no-time.json")).mtime.toISOString()
    );
    expect(fs.readFileSync(path.join(threads(), "agui.json"))).toEqual(
      aguiBefore
    );
    expect(fs.readFileSync(path.join(threads(), "newer.json"))).toEqual(
      newerBefore
    );
    // Only the unparseable twin was backed up.
    const backups = hashes(backupsRoot(home));
    expect(
      Object.keys(backups)
        .map((file) => path.basename(file))
        .filter(
          (file) =>
            !["attempt.json", "completed.json", "restore-index.jsonl"].includes(
              file
            )
        )
    ).toEqual(["garbage-twin.json"]);
    expect(fs.existsSync(migratingRoot(home))).toBe(false);

    const record = readRecord(home);
    expect(record.applied).toEqual([
      expect.objectContaining({
        id: 1,
        name: "transcripts-v2",
        // `big.json` is under the default cap here.
        stats: expect.objectContaining({ converted: 5, corrupt: 2 }),
      }),
    ]);

    // A second run is a no-op; a forced rerun finds everything current.
    const settled = hashes(home);
    expect(await run()).toMatchObject({ applied: [], failed: null });
    expect(hashes(home)).toEqual(settled);
    expect(await run([1])).toMatchObject({ applied: [1], failed: null });
    expect(readRecord(home).applied.at(-1)?.stats).toMatchObject({
      converted: 0,
      upToDate: 7,
      agui: 1,
      foreign: 1,
      twinUnreadable: 1,
      cleared: 1,
    });
    const after = hashes(home);
    for (const file of Object.keys(settled).filter(
      (file) => file !== "migrations.json"
    ))
      expect({ file, hash: after[file] }).toEqual({
        file,
        hash: settled[file],
      });
  });

  it("does nothing without a transcripts folder", async () => {
    const first = await run();
    expect(first).toMatchObject({ applied: [1], failed: null });
    expect(fs.existsSync(threads())).toBe(false);
    expect(readRecord(home).applied[0]?.stats).toMatchObject({
      files: 0,
      converted: 0,
    });
  });

  it("migrates every C-T1 fixture to its golden", async () => {
    const fixtures = fs
      .readdirSync(path.join(SHARED_FIXTURES, "v1"))
      .filter((name) => name.endsWith(".json"));
    for (const name of fixtures) {
      const source = readJson(path.join(SHARED_FIXTURES, "v1", name));
      // The file name is the thread id.
      put(transcripts(), `${source.sessionId}.json`, source);
    }
    expect(await run()).toMatchObject({ applied: [1], failed: null });
    for (const name of fixtures) {
      const source = readJson(path.join(SHARED_FIXTURES, "v1", name));
      const written = readJson(
        path.join(threads(), `${source.sessionId}.json`)
      );
      // The goldens are fingerprint-free (the mapper's output); the step
      // fingerprints the exact v1 bytes.
      expect(written.source.fingerprint).toBe(
        fingerprintV1(
          fs.readFileSync(
            path.join(transcripts(), `${source.sessionId}.json`),
            "utf8"
          )
        )
      );
      delete written.source.fingerprint;
      expect(written).toEqual(
        readJson(path.join(SHARED_FIXTURES, "expected-v2", name))
      );
    }
  });

  it("streams a large folder, yielding and reporting progress mid-walk", async () => {
    for (let index = 0; index < 45; index++)
      put(transcripts(), `s${index}.json`, v1(`s${index}`));
    const progress = vi.fn();
    const immediates = vi.spyOn(globalThis, "setImmediate");
    const plan = await transcriptsV2().plan({ ...context(), progress });
    const yields = immediates.mock.calls.length;
    immediates.mockRestore();
    expect(plan.writes).toHaveLength(45);
    // Every 20 files: at 20 and 40, before the final report.
    expect(progress.mock.calls.map((call) => call[0])).toEqual([20, 40, 45]);
    expect(progress.mock.calls[0]).toEqual([20, 45, "Upgrading chat history"]);
    expect(yields).toBeGreaterThanOrEqual(2);
    // And through the runner, which scales it.
    const runnerProgress = vi.fn();
    const result = await runMigrations({
      home,
      userData,
      appVersion: "0.0.0-test",
      steps: [transcriptsV2()],
      log: () => undefined,
      onProgress: runnerProgress,
    });
    expect(result).toMatchObject({ applied: [1], failed: null });
    expect(fs.readdirSync(threads())).toHaveLength(45);
    const midway = runnerProgress.mock.calls.filter(
      ([done, total]) => done > 0 && done < total
    );
    expect(midway.length).toBeGreaterThan(0);
  });
});

it("step 1 treats a non-directory transcripts path as empty so later steps can run", async () => {
  fs.writeFileSync(transcripts(), "keep this non-directory");
  const result = await run();
  expect(result.failed).toBeNull();
  expect(result.applied).toContain(1);
  expect(fs.readFileSync(transcripts(), "utf8")).toBe(
    "keep this non-directory"
  );
});

it("step 1 leaves bytes without proof of a post-clear save hidden", async () => {
  put(transcripts(), "clear-race.json", v1("clear-race"));
  put(threads(), "clear-race.cleared", {
    version: 1,
    token: "clear-token",
    clearedAt: "2026-09-02T00:00:00Z",
    v1Fingerprint: "different-pre-clear-bytes",
  });
  await run();
  expect(fs.existsSync(path.join(threads(), "clear-race.json"))).toBe(false);
  expect(
    readRecord(home).applied.find((step) => step.id === 1)?.stats.cleared
  ).toBe(1);
  expect(fs.existsSync(path.join(transcripts(), "clear-race.json"))).toBe(true);
});
