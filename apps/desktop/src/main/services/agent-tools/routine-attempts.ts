/**
 * Routine run attempts (spec 05 §31.5 f): what each history entry is, and
 * the one-time classification of legacy entries written before entries had
 * ids. Main's own result strings are the only producer of legacy entries, so
 * parsing them here is main reading its own record, never the UI's job.
 */
import crypto from "node:crypto";

import type { RoutineRun, RoutineRunKind } from "#shared/routines";

/** Every result string main records, verbatim or as a prefix. */
export const ROUTINE_RESULTS = {
  skipped: "skipped: the previous run is still going",
  noWorkspace: "no workspace to run in",
  timedOut: "failed: the run was stopped after 30 minutes",
  /** `paused: out of Abacus.AI credits`, `paused after N failed runs…`. */
  pausedPrefix: "paused",
  startFailedPrefix: "session failed to start: ",
  startedPrefix: "started session ",
} as const;

export const started = (sessionId: string): string =>
  `${ROUTINE_RESULTS.startedPrefix}${sessionId}`;

export const ATTEMPT_KINDS: ReadonlySet<RoutineRunKind> = new Set([
  "started",
  "start-failed",
  "skipped",
  "no-workspace",
  "unknown",
]);

export const isAttempt = (run: Pick<RoutineRun, "kind">): boolean =>
  ATTEMPT_KINDS.has(run.kind);

/** A fresh attempt id: minted once, when the entry is recorded. */
export const mintAttemptId = (): string => `attempt-${crypto.randomUUID()}`;

const uuidShape = (hex: string): string =>
  `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;

/**
 * A legacy entry's id, derived from what it holds and its position among
 * identical entries (counted from the oldest, so prepends never move it).
 * The migration step and `cron-store`'s read-time fallback derive the same
 * id, and it is persisted by whichever writes first.
 */
export const legacyAttemptId = (
  routineId: string,
  run: { at: number; trigger: string; result: string },
  ordinal: number
): string =>
  `attempt-${uuidShape(
    crypto
      .createHash("sha256")
      .update(
        [routineId, run.at, run.trigger, run.result, ordinal].join("\u0000")
      )
      .digest("hex")
  )}`;

/** The kind main's exact result strings mean; `unknown` otherwise. */
export const legacyKind = (result: string): RoutineRunKind => {
  if (result === ROUTINE_RESULTS.skipped) return "skipped";
  if (result === ROUTINE_RESULTS.noWorkspace) return "no-workspace";
  if (result === ROUTINE_RESULTS.timedOut) return "timed-out";
  if (result.startsWith(ROUTINE_RESULTS.startFailedPrefix))
    return "start-failed";
  if (result.startsWith(ROUTINE_RESULTS.startedPrefix)) return "started";
  if (result.startsWith(ROUTINE_RESULTS.pausedPrefix)) return "paused";
  return "unknown";
};

/** The session main's own `started session <id>` names, if any. */
const namedSession = (result: string): string | null => {
  if (!result.startsWith(ROUTINE_RESULTS.startedPrefix)) return null;
  const named = result.slice(ROUTINE_RESULTS.startedPrefix.length).trim();
  return named.length > 0 ? named : null;
};

/** A finished run's record file (`routine-runs-store.ts`), as parsed. */
export interface RunRecordRef {
  sessionId: string;
  startedAt: number;
  endedAt: number | null;
}

/** Within this, a record and a history entry are the same fire. */
export const RECORD_MATCH_MS = 2_000;

/** A timeout shares its session with its attempt: nothing is off limits. */
const NONE: ReadonlySet<string> = new Set();

/** A stored entry that predates ids, as read from `cronjobs.json`. */
export type StoredRun = Partial<RoutineRun> & {
  at: number;
  trigger: RoutineRun["trigger"];
  result: string;
};

const closest = (
  records: readonly RunRecordRef[],
  at: number,
  time: (record: RunRecordRef) => number | null,
  taken: ReadonlySet<string>
): string | null => {
  let best: { sessionId: string; distance: number } | null = null;
  for (const record of records) {
    const when = time(record);
    if (when == null || taken.has(record.sessionId)) continue;
    const distance = Math.abs(when - at);
    if (distance > RECORD_MATCH_MS) continue;
    if (best == null || distance < best.distance)
      best = { sessionId: record.sessionId, distance };
  }
  return best?.sessionId ?? null;
};

/**
 * Gives every entry without an id its id, kind and links (spec 05 §31.5 f):
 * a `started session <id>` result names its session; a started or unknown
 * entry without one takes the run record that started within 2 s of it; a
 * legacy timeout takes the record that ended within 2 s of it (the reaper
 * writes both together) and links to the `started` attempt with that
 * session. Entries that already have an id are returned unchanged. Pure.
 */
export const classifyLegacyRuns = (
  routineId: string,
  runs: readonly StoredRun[],
  records: readonly RunRecordRef[] = []
): { runs: RoutineRun[]; changed: number } => {
  let changed = 0;
  const seen = new Map<string, number>();
  // Sessions an entry already names (a field, or main's own `started
  // session <id>`), so a record is never claimed by a second entry.
  const taken = new Set<string>(
    runs.flatMap((run) => {
      if (typeof run.sessionId === "string") return [run.sessionId];
      const named = namedSession(run.result);
      return named == null ? [] : [named];
    })
  );
  const out: RoutineRun[] = Array.from({ length: runs.length });
  // Oldest first: ordinals count from the oldest identical entry.
  for (let index = runs.length - 1; index >= 0; index -= 1) {
    const run = runs[index]!;
    if (typeof run.id === "string" && run.id.length > 0) {
      out[index] = {
        ...run,
        id: run.id,
        kind: run.kind ?? "unknown",
        sessionId: run.sessionId ?? null,
        attemptId: run.attemptId ?? null,
      };
      continue;
    }
    changed += 1;
    const key = [run.at, run.trigger, run.result].join("\u0000");
    const ordinal = seen.get(key) ?? 0;
    seen.set(key, ordinal + 1);
    const kind = legacyKind(run.result);
    let sessionId = kind === "started" ? namedSession(run.result) : null;
    if (sessionId == null && (kind === "started" || kind === "unknown"))
      sessionId = closest(records, run.at, (record) => record.startedAt, taken);
    if (sessionId == null && kind === "timed-out")
      sessionId = closest(records, run.at, (record) => record.endedAt, NONE);
    if (sessionId != null && kind !== "timed-out") taken.add(sessionId);
    out[index] = {
      id: legacyAttemptId(routineId, run, ordinal),
      at: run.at,
      trigger: run.trigger,
      result: run.result,
      kind,
      sessionId,
      attemptId: null,
    };
  }
  // A legacy timeout joins the attempt that started its session.
  for (const run of out) {
    if (run.kind !== "timed-out" || run.attemptId != null) continue;
    if (run.sessionId == null) continue;
    const attempt = out.find(
      (candidate) =>
        isAttempt(candidate) && candidate.sessionId === run.sessionId
    );
    if (attempt != null) run.attemptId = attempt.id;
  }
  return { runs: out, changed };
};

/**
 * `RoutineRunRow`'s join (spec 05 §31.5 f): the attempt that holds the
 * session, and the result to show: the latest follow-up for that attempt
 * (runs are newest first), else the attempt's own.
 */
export const attemptForSession = (
  runs: readonly RoutineRun[],
  sessionId: string
): { attemptId: string | null; result: string | null } => {
  const attempt = runs.find(
    (run) => isAttempt(run) && run.sessionId === sessionId
  );
  if (attempt == null) return { attemptId: null, result: null };
  const followUp = runs.find(
    (run) => !isAttempt(run) && run.attemptId === attempt.id
  );
  return {
    attemptId: attempt.id,
    result: (followUp ?? attempt).result,
  };
};

/** Parses one run record (`routine-runs-store.ts` `recordRoutineRun`). */
export const parseRunRecord = (text: string): RunRecordRef | null => {
  const heading = /^# Run at (.+)$/m.exec(text)?.[1]?.trim();
  const session = /^- Session: (.+)$/m.exec(text)?.[1]?.trim();
  const ended = /^- Ended: (.+)$/m.exec(text)?.[1]?.trim();
  if (heading == null || session == null || session.length === 0) return null;
  const startedAt = Date.parse(heading);
  if (!Number.isFinite(startedAt)) return null;
  const endedAt = ended == null ? Number.NaN : Date.parse(ended);
  return {
    sessionId: session,
    startedAt,
    endedAt: Number.isFinite(endedAt) ? endedAt : null,
  };
};
