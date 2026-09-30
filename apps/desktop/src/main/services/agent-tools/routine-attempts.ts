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
  /** The record's `- Outcome:` line; null when it has none. */
  outcome?: "completed" | "failed" | null;
}

/**
 * A routine's session from the session store (`localCode.agentSessions`).
 * A legacy `session failed to start: …` entry names none, but the session
 * it made was stored just before the start was tried.
 */
export interface RoutineSessionRef {
  sessionId: string;
  createdAt: number;
  runOutcome: string | null;
}

/** Within this, a record and a history entry are the same fire. */
export const RECORD_MATCH_MS = 2_000;

/**
 * The longest a start may take between its session being stored and the
 * `session failed to start` entry being written.
 */
export const START_FAILURE_MATCH_MS = 5 * 60_000;

/** A stored entry that predates ids, as read from `cronjobs.json`. */
export type StoredRun = Partial<RoutineRun> & {
  at: number;
  trigger: RoutineRun["trigger"];
  result: string;
};

/**
 * The shape an entry must have to be classified (migration step 5's guard,
 * shared with `cron-store`'s read). Anything else is not a history entry
 * main can read, and is never given an id.
 */
export const isStoredRun = (run: unknown): run is StoredRun =>
  run != null &&
  typeof run === "object" &&
  !Array.isArray(run) &&
  typeof (run as { at?: unknown }).at === "number" &&
  typeof (run as { result?: unknown }).result === "string" &&
  typeof (run as { trigger?: unknown }).trigger === "string";

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
 * The run a legacy timeout stopped. The reaper writes a `failed` record and
 * the timeout together, so a failed record ending within 2 s wins over one
 * that finished normally, and a record another timeout holds is never
 * reused.
 */
const timedOutSession = (
  records: readonly RunRecordRef[],
  at: number,
  claimed: ReadonlySet<string>
): string | null =>
  closest(
    records.filter((record) => record.outcome === "failed"),
    at,
    (record) => record.endedAt,
    claimed
  ) ??
  closest(
    records.filter((record) => record.outcome == null),
    at,
    (record) => record.endedAt,
    claimed
  );

/**
 * The session a legacy start failure made: the newest unclaimed one of the
 * routine stored before the entry (within `START_FAILURE_MATCH_MS`) that
 * did not complete.
 */
const startFailedSession = (
  sessions: readonly RoutineSessionRef[],
  at: number,
  taken: ReadonlySet<string>
): string | null => {
  let best: RoutineSessionRef | null = null;
  for (const session of sessions) {
    if (taken.has(session.sessionId)) continue;
    if (session.runOutcome === "completed") continue;
    if (session.createdAt > at + RECORD_MATCH_MS) continue;
    if (at - session.createdAt > START_FAILURE_MATCH_MS) continue;
    if (best == null || session.createdAt > best.createdAt) best = session;
  }
  return best?.sessionId ?? null;
};

const contentKey = (run: StoredRun): string =>
  [run.at, run.trigger, run.result].join("\u0000");

const hasId = (run: StoredRun): run is StoredRun & { id: string } =>
  typeof run.id === "string" && run.id.length > 0;

/**
 * Gives every entry without an id its id, kind and links (spec 05 §31.5 f):
 * a `started session <id>` result names its session; a started or unknown
 * entry without one takes the run record that started within 2 s of it; a
 * legacy timeout takes the (preferably failed) record that ended within 2 s
 * of it, one record per timeout, and links to the `started` attempt with
 * that session; a legacy start failure takes the session it stored just
 * before.
 *
 * The id is derived from the entry's content and its ordinal among every
 * identical entry, with an id or not, counted from the oldest (prepends
 * never move it); an id another entry already holds is skipped. An entry
 * whose id is such a derived id (the read fallback persisted it before the
 * run records were read) keeps it and gets only its missing session and
 * link filled. Any other entry with an id is returned unchanged. Pure.
 */
export const classifyLegacyRuns = (
  routineId: string,
  runs: readonly StoredRun[],
  records: readonly RunRecordRef[] = [],
  sessions: readonly RoutineSessionRef[] = []
): { runs: RoutineRun[]; changed: number; changedIds: Set<string> } => {
  // Sessions an entry already names (a field, or main's own `started
  // session <id>`), so a record is never claimed by a second entry. A
  // timeout shares its session with its attempt, so it takes none.
  const taken = new Set<string>(
    runs.flatMap((run) => {
      if (run.kind === "timed-out") return [];
      if (typeof run.sessionId === "string") return [run.sessionId];
      const named = namedSession(run.result);
      return named == null ? [] : [named];
    })
  );
  // Records that already serve a timeout.
  const claimedByTimeouts = new Set<string>(
    runs.flatMap((run) =>
      run.kind === "timed-out" && typeof run.sessionId === "string"
        ? [run.sessionId]
        : []
    )
  );
  const ids = new Set<string>(runs.filter(hasId).map((run) => run.id));
  const identical = new Map<string, number>();
  for (const run of runs)
    identical.set(contentKey(run), (identical.get(contentKey(run)) ?? 0) + 1);
  /** Whether `id` is one `legacyAttemptId` gives this entry's content. */
  const isDerived = (run: StoredRun, id: string): boolean => {
    // An ordinal is skipped only for an identical entry holding it, so no
    // ordinal given reaches twice the identical count.
    const bound = 2 * (identical.get(contentKey(run)) ?? 1);
    for (let ordinal = 0; ordinal < bound; ordinal += 1)
      if (legacyAttemptId(routineId, run, ordinal) === id) return true;
    return false;
  };

  const changedIds = new Set<string>();
  const seen = new Map<string, number>();
  const out: RoutineRun[] = Array.from({ length: runs.length });
  const legacy: number[] = [];
  // Oldest first: ordinals count from the oldest identical entry.
  for (let index = runs.length - 1; index >= 0; index -= 1) {
    const run = runs[index]!;
    const key = contentKey(run);
    let ordinal = seen.get(key) ?? 0;
    seen.set(key, ordinal + 1);
    const attemptId = run.attemptId ?? null;
    let id: string;
    let kind: RoutineRunKind;
    let sessionId: string | null;
    if (hasId(run)) {
      if (!isDerived(run, run.id)) {
        out[index] = {
          ...run,
          id: run.id,
          kind: run.kind ?? "unknown",
          sessionId: run.sessionId ?? null,
          attemptId,
        };
        continue;
      }
      id = run.id;
      kind = run.kind ?? legacyKind(run.result);
      sessionId = run.sessionId ?? null;
    } else {
      id = legacyAttemptId(routineId, run, ordinal);
      while (ids.has(id)) {
        ordinal += 1;
        id = legacyAttemptId(routineId, run, ordinal);
      }
      ids.add(id);
      changedIds.add(id);
      kind = legacyKind(run.result);
      sessionId = null;
    }
    legacy.push(index);
    const before = sessionId;
    if (sessionId == null && kind === "started")
      sessionId = namedSession(run.result);
    if (sessionId == null && (kind === "started" || kind === "unknown"))
      sessionId = closest(records, run.at, (record) => record.startedAt, taken);
    if (sessionId == null && kind === "start-failed")
      sessionId = startFailedSession(sessions, run.at, taken);
    if (sessionId == null && kind === "timed-out") {
      sessionId = timedOutSession(records, run.at, claimedByTimeouts);
      if (sessionId != null) claimedByTimeouts.add(sessionId);
    }
    if (sessionId != null && kind !== "timed-out") taken.add(sessionId);
    if (sessionId !== before) changedIds.add(id);
    out[index] = {
      id,
      at: run.at,
      trigger: run.trigger,
      result: run.result,
      kind,
      sessionId,
      attemptId,
    };
  }
  // A legacy timeout joins the attempt that started its session.
  for (const index of legacy) {
    const run = out[index]!;
    if (run.kind !== "timed-out" || run.attemptId != null) continue;
    if (run.sessionId == null) continue;
    const attempt = out.find(
      (candidate) =>
        isAttempt(candidate) && candidate.sessionId === run.sessionId
    );
    if (attempt == null) continue;
    run.attemptId = attempt.id;
    changedIds.add(run.id);
  }
  return { runs: out, changed: changedIds.size, changedIds };
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
  const outcome = /^- Outcome: (.+)$/m.exec(text)?.[1]?.trim();
  if (heading == null || session == null || session.length === 0) return null;
  const startedAt = Date.parse(heading);
  if (!Number.isFinite(startedAt)) return null;
  const endedAt = ended == null ? Number.NaN : Date.parse(ended);
  return {
    sessionId: session,
    startedAt,
    endedAt: Number.isFinite(endedAt) ? endedAt : null,
    outcome: outcome === "failed" || outcome === "completed" ? outcome : null,
  };
};
