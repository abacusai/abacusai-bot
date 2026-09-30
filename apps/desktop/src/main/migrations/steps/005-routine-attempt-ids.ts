/**
 * Step 5 (spec 05 §31.5 f, spec 00 C): every routine history entry in
 * `cronjobs.json` recorded before entries had ids gets its stable id, its
 * kind and, where main's own records say, its session, once:
 *
 * - `sessionId` from main's own `started session <id>` result text, else
 *   from the routine's run records (`routines/<id>/runs/*.md`, in the app's
 *   folder or, for a routine set up for a project, inside that project) whose
 *   start time is within 2 s of the entry;
 * - `kind` from main's exact result strings, `unknown` otherwise;
 * - a legacy timeout joins the attempt with the same session (its record
 *   ended when the timeout was written).
 *
 * The ids are persisted, so prepending new runs never changes one. Entries
 * that already have an id are untouched, which makes the step idempotent:
 * a re-run plans no write. The file is written `replace-user` (it holds the
 * user's routines), so the runner backs it up first.
 */
import fs from "node:fs";
import path from "node:path";

import {
  classifyLegacyRuns,
  parseRunRecord,
  type RunRecordRef,
  type StoredRun,
} from "../../services/agent-tools/routine-attempts";
import type { MigrationStep } from "../types";

export const CRONJOBS_FILE_NAME = "cronjobs.json";
const WORKSPACES_FILE_NAME = "local-code.json";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value != null && typeof value === "object" && !Array.isArray(value);

/** Workspace id → path, from the workspace store (`localCode.workspaces`). */
const readWorkspacePaths = (home: string): Map<string, string> => {
  const paths = new Map<string, string>();
  try {
    const parsed: unknown = JSON.parse(
      fs.readFileSync(path.join(home, WORKSPACES_FILE_NAME), "utf8")
    );
    const localCode = isRecord(parsed) ? parsed.localCode : undefined;
    const workspaces = isRecord(localCode) ? localCode.workspaces : undefined;
    for (const entry of Array.isArray(workspaces) ? workspaces : [])
      if (
        isRecord(entry) &&
        typeof entry.id === "string" &&
        typeof entry.path === "string"
      )
        paths.set(entry.id, entry.path);
  } catch {
    // No store: only the app's own routine folders are read.
  }
  return paths;
};

/** Every run record of a routine, from each folder its records can be in. */
const readRunRecords = (dirs: readonly string[]): RunRecordRef[] => {
  const records: RunRecordRef[] = [];
  for (const dir of dirs) {
    let names: string[];
    try {
      names = fs.readdirSync(dir).filter((name) => name.endsWith(".md"));
    } catch {
      continue;
    }
    for (const name of names) {
      try {
        const record = parseRunRecord(
          fs.readFileSync(path.join(dir, name), "utf8")
        );
        if (record != null) records.push(record);
      } catch {
        // An unreadable record recovers nothing; the entry stays unmatched.
      }
    }
  }
  return records;
};

export const routineAttemptIds = (): MigrationStep => ({
  id: 5,
  name: "routine-attempt-ids",
  plan: async (ctx) => {
    const dest = path.join(ctx.home, CRONJOBS_FILE_NAME);
    let raw: string;
    try {
      raw = fs.readFileSync(dest, "utf8");
    } catch {
      return { writes: [], removals: [], stats: { routines: 0 } };
    }
    let jobs: unknown;
    try {
      jobs = JSON.parse(raw);
    } catch {
      // `cron-store` reads a corrupt file as no routines; left as it is.
      ctx.log("cronjobs.json does not parse; left untouched");
      return { writes: [], removals: [], stats: { corrupt: 1 } };
    }
    if (!Array.isArray(jobs))
      return { writes: [], removals: [], stats: { corrupt: 1 } };

    const workspaces = readWorkspacePaths(ctx.home);
    const stats = {
      routines: jobs.length,
      entries: 0,
      migrated: 0,
      withSession: 0,
      unknown: 0,
      linkedTimeouts: 0,
    };
    const next = jobs.map((job: unknown, index) => {
      ctx.progress(index, jobs.length, "Routine history");
      if (
        !isRecord(job) ||
        typeof job.id !== "string" ||
        !Array.isArray(job.runs)
      )
        return job;
      const runs = (job.runs as unknown[]).filter(
        (run): run is StoredRun =>
          isRecord(run) &&
          typeof run.at === "number" &&
          typeof run.result === "string" &&
          typeof run.trigger === "string"
      );
      stats.entries += runs.length;
      if (runs.every((run) => typeof run.id === "string")) return job;
      const project =
        typeof job.workspaceId === "string"
          ? workspaces.get(job.workspaceId)
          : undefined;
      const records = readRunRecords([
        path.join(ctx.home, "routines", job.id, "runs"),
        ...(project == null
          ? []
          : [path.join(project, ".abacusai-bot", "routines", job.id, "runs")]),
      ]);
      const before = new Set(
        runs.flatMap((run) => (typeof run.id === "string" ? [run.id] : []))
      );
      const classified = classifyLegacyRuns(job.id, runs, records);
      stats.migrated += classified.changed;
      for (const run of classified.runs) {
        if (before.has(run.id)) continue;
        if (run.sessionId != null) stats.withSession += 1;
        if (run.kind === "unknown") stats.unknown += 1;
        if (run.kind === "timed-out" && run.attemptId != null)
          stats.linkedTimeouts += 1;
      }
      return { ...job, runs: classified.runs };
    });
    ctx.progress(jobs.length, jobs.length, "Routine history");

    if (stats.migrated === 0)
      return { writes: [], removals: [], stats: { ...stats, written: 0 } };
    const staged = path.join(ctx.staging, CRONJOBS_FILE_NAME);
    // `cron-store`'s own format.
    fs.writeFileSync(staged, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    ctx.log(`routine history: ${JSON.stringify(stats)}`);
    return {
      writes: [{ dest, staged, kind: "replace-user" }],
      removals: [],
      stats: { ...stats, written: 1 },
    };
  },
});
