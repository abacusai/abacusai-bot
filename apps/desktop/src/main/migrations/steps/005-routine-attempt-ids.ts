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
 *   ended when the timeout was written);
 * - a legacy start failure takes the session the session store holds for
 *   the routine, made just before the entry.
 *
 * The ids are persisted, so prepending new runs never changes one. An entry
 * with a derived id `cron-store`'s read fallback already persisted (the step
 * had not run yet) keeps it and gets only its missing session and link; any
 * other entry with an id is untouched, and an entry of another shape keeps
 * its place. So the step is idempotent: a re-run plans no write. The file is
 * written `replace-user` (it holds the user's routines), so the runner
 * backs it up first.
 */
import fs from "node:fs";
import path from "node:path";

import {
  classifyLegacyRuns,
  parseRunRecord,
  type RunRecordRef,
  isStoredRun,
  type RoutineSessionRef,
} from "../../services/agent-tools/routine-attempts";
import type { MigrationStep } from "../types";

export const CRONJOBS_FILE_NAME = "cronjobs.json";
const WORKSPACES_FILE_NAME = "local-code.json";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value != null && typeof value === "object" && !Array.isArray(value);

/**
 * From the workspace store: workspace id → path (`localCode.workspaces`),
 * and each routine's sessions (`localCode.agentSessions`).
 */
const readWorkspaceStore = (
  home: string
): {
  paths: Map<string, string>;
  sessions: Map<string, RoutineSessionRef[]>;
} => {
  const paths = new Map<string, string>();
  const sessions = new Map<string, RoutineSessionRef[]>();
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
    const records = isRecord(localCode) ? localCode.agentSessions : undefined;
    for (const entry of Array.isArray(records) ? records : []) {
      if (
        !isRecord(entry) ||
        typeof entry.id !== "string" ||
        typeof entry.routineId !== "string" ||
        typeof entry.createdAt !== "string" ||
        entry.editorFor != null
      )
        continue;
      const createdAt = Date.parse(entry.createdAt);
      if (!Number.isFinite(createdAt)) continue;
      const list = sessions.get(entry.routineId) ?? [];
      list.push({
        sessionId: entry.id,
        createdAt,
        runOutcome:
          typeof entry.runOutcome === "string" ? entry.runOutcome : null,
      });
      sessions.set(entry.routineId, list);
    }
  } catch {
    // No store: only the app's own routine folders are read.
  }
  return { paths, sessions };
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

    const store = readWorkspaceStore(ctx.home);
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
      // An entry of another shape is not main's to read: it keeps its place
      // and its content, in every job alike.
      const all = job.runs as unknown[];
      const runs = all.filter(isStoredRun);
      stats.entries += runs.length;
      const project =
        typeof job.workspaceId === "string"
          ? store.paths.get(job.workspaceId)
          : undefined;
      const records = readRunRecords([
        path.join(ctx.home, "routines", job.id, "runs"),
        ...(project == null
          ? []
          : [path.join(project, ".abacusai-bot", "routines", job.id, "runs")]),
      ]);
      const classified = classifyLegacyRuns(
        job.id,
        runs,
        records,
        store.sessions.get(job.id) ?? []
      );
      if (classified.changed === 0) return job;
      stats.migrated += classified.changed;
      for (const run of classified.runs) {
        if (!classified.changedIds.has(run.id)) continue;
        if (run.sessionId != null) stats.withSession += 1;
        if (run.kind === "unknown") stats.unknown += 1;
        if (run.kind === "timed-out" && run.attemptId != null)
          stats.linkedTimeouts += 1;
      }
      const queue = [...classified.runs];
      return {
        ...job,
        runs: all.map((run) => (isStoredRun(run) ? queue.shift()! : run)),
      };
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
