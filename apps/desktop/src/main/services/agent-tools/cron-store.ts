/**
 * Scheduled and webhook-fired agent runs (routines), persisted to
 * `cronjobs.json`. A job has a five-field cron schedule, a webhook token for
 * `POST /hooks/<token>`, both, or neither (manual). The cron parser is
 * `shared/routines/cron.ts`: eighty lines beat a dependency.
 */
import crypto from "crypto";
import fs from "fs";
import path from "path";

import { ConflictError } from "#shared/conflict";
import { EntityNotFoundError } from "#shared/not-found";
import type { RoutineRun, RoutineRunKind } from "#shared/routines";
import { matches, nextRun, parseCron } from "#shared/routines/cron";

import {
  isMigrationWriteBlocked,
  isMigrationWriteBlockedTree,
} from "../../migrations/write-block";
import { abacusBotHome } from "../../paths";
import { HeldFiles } from "../session/held-files";
import {
  classifyLegacyRuns,
  isAttempt,
  legacyKind,
  mintAttemptId,
  isStoredRun,
} from "./routine-attempts";

// One parser for main and the new renderer (spec 05 §31.7).
export { CronParseError, nextRun, parseCron } from "#shared/routines/cron";

export type CronTrigger = "schedule" | "webhook" | "manual" | "create";

/**
 * One history entry (spec 05 §31.5 f): its id is minted once when recorded
 * and never recomputed; `result` is the short outcome, capped ("started
 * session x", or why it did not).
 */
export type CronRun = RoutineRun;

export interface CronJob {
  id: string;
  /** Display name. Derived from the prompt when not given. */
  name: string;
  /** Five-field cron expression in local time, or null for webhook-only jobs. */
  schedule: string | null;
  /**
   * Epoch ms for a run-once job, set instead of `schedule`. A fire the app
   * slept through still happens on the next tick.
   */
  runAt: number | null;
  /** Secret path segment for `POST /hooks/<token>`, or null for cron-only jobs. */
  webhookToken: string | null;
  /** What to ask the agent when it fires. */
  prompt: string;
  /** Workspace the run happens in. Null means the active one at fire time. */
  workspaceId: string | null;
  /** Bot that made this routine. Provenance, not ownership: it outlives the bot. */
  botId: string | null;
  enabled: boolean;
  createdAt: number;
  lastRunAt: number | null;
  lastResult: string | null;
  /** Newest first, unbounded; the run's session is the real record. */
  runs: CronRun[];
}

const FILE = (): string => path.join(abacusBotHome(), "cronjobs.json");

const writeFileAtomic = (file: string, text: string): void => {
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, text, "utf8");
  fs.renameSync(temp, file);
};

/**
 * `cronjobs.json` is a migration destination (step 5): while an unresolved
 * commit may cover it (spec 00 C.1), a write is journalled beside the
 * thread store's held writes and every read sees it; it reaches the file
 * once the block lifts (the startup replay, or the next read or write).
 */
const held = new HeldFiles({
  dir: () => path.join(abacusBotHome(), "threads", ".pending"),
  isWriteBlocked: isMigrationWriteBlocked,
  writeFile: writeFileAtomic,
  log: (message) => console.warn(`[cron-store] ${message}`),
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value != null && typeof value === "object" && !Array.isArray(value);

/**
 * The jobs on disk (or held), or null when the file is there but cannot be
 * read as a job list. A missing or blank file is no jobs.
 */
const load = (): CronJob[] | null => {
  const file = held.read(FILE());
  if (file.status === "missing") return [];
  if (file.status !== "ok") return null;
  if (file.text.trim().length === 0) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(file.text);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  if (!parsed.every((job) => isRecord(job) && typeof job.id === "string"))
    return null;
  // Older files lack the newer fields; they were all plain cron jobs.
  return (parsed as CronJob[]).map((job) => ({
    ...job,
    name:
      job.name ?? deriveName(typeof job.prompt === "string" ? job.prompt : ""),
    schedule: job.schedule ?? null,
    runAt: job.runAt ?? null,
    webhookToken: job.webhookToken ?? null,
    botId: job.botId ?? null,
    // Entries from before ids are given theirs by migration step 5; one
    // it has not reached (the step failed) gets the same derived id here,
    // persisted by the next write (the step still fills its links later).
    // An entry main cannot read is left out of what the app sees.
    runs: Array.isArray(job.runs)
      ? classifyLegacyRuns(job.id, (job.runs as unknown[]).filter(isStoredRun))
          .runs
      : [],
  }));
};

/** What the app lists: an unreadable file lists as no routines. */
const read = (): CronJob[] => load() ?? [];

/**
 * The jobs a write starts from. An unreadable file is never replaced by a
 * list built from nothing: the write is refused and the file kept.
 */
const readForWrite = (): CronJob[] => {
  const jobs = load();
  if (jobs == null)
    throw new Error(
      "cronjobs.json cannot be read, so routines cannot be saved; the file was left as it is."
    );
  return jobs;
};

const writeListeners = new Set<() => void>();

/**
 * Called after every write of `cronjobs.json`, whoever made it: the routines
 * table's direct hook (spec 00 B.2), beside the `cronjobs-updated` events.
 */
export const onCronStoreWrite = (listener: () => void): (() => void) => {
  writeListeners.add(listener);
  return () => {
    writeListeners.delete(listener);
  };
};

const write = (jobs: CronJob[]): void => {
  if (
    isMigrationWriteBlocked(FILE()) &&
    isMigrationWriteBlockedTree(
      path.join(abacusBotHome(), "threads", ".pending")
    )
  )
    throw new Error(
      "Routines cannot be saved while migration recovery holds their write journal."
    );
  // The public list omits entries it cannot interpret. Keep those bytes as
  // JSON values when saving another edit instead of silently deleting them.
  const source = held.read(FILE());
  const raw: Array<{ id: string; runs?: unknown[] }> =
    source.status === "ok" && source.text.trim() !== ""
      ? JSON.parse(source.text)
      : [];
  const stored = jobs.map((job) => {
    const old = raw.find((entry) => entry.id === job.id)?.runs;
    if (!Array.isArray(old)) return job;
    const malformed = old.filter((entry) => !isStoredRun(entry));
    if (malformed.length === 0) return job;
    const previous = classifyLegacyRuns(job.id, old.filter(isStoredRun)).runs;
    const existing = new Set(previous.map((run) => run.id));
    const current = new Map(job.runs.map((run) => [run.id, run]));
    let ordinal = 0;
    const preserved = old.flatMap((entry) => {
      if (!isStoredRun(entry)) return [entry];
      const updated = current.get(previous[ordinal++]!.id);
      return updated == null ? [] : [updated];
    });
    return {
      ...job,
      runs: [...job.runs.filter((run) => !existing.has(run.id)), ...preserved],
    };
  });
  held.write(FILE(), `${JSON.stringify(stored, null, 2)}\n`);
  for (const listener of Array.from(writeListeners)) {
    try {
      listener();
    } catch (error) {
      console.error("[cron-store] write listener threw", error);
    }
  }
};

const deriveName = (prompt: string): string => {
  const line = prompt.trim().split("\n")[0] ?? "";
  return line.length > 60 ? `${line.slice(0, 57)}…` : line;
};

// ── Job storage ────────────────────────────────────────────────────────────

let counter = 0;

export const listJobs = (): CronJob[] => read();

export const getJob = (id: string): CronJob | null =>
  read().find((job) => job.id === id) ?? null;

export const jobForWebhookToken = (token: string): CronJob | null =>
  token.length === 0
    ? null
    : (read().find((job) => job.webhookToken === token) ?? null);

/** `id`: the caller's own (an optimistic insert); a taken one is refused. */
export const createJob = (
  input: {
    schedule?: string | null;
    runAt?: number | null;
    /** True mints a webhook token, making the job POST-firable. */
    webhook?: boolean;
    prompt: string;
    name?: string;
    workspaceId?: string | null;
    botId?: string | null;
  },
  id?: string
): CronJob => {
  const schedule = input.schedule?.trim() ?? "";
  const hasSchedule = schedule.length > 0;
  const runAt = input.runAt ?? null;

  // Validated before saving, so a bad expression fails where the user sees it.
  if (hasSchedule) parseCron(schedule);
  if (runAt != null && !Number.isFinite(runAt))
    throw new Error("A run-once time must be a moment in time.");

  if (input.prompt.trim().length === 0)
    throw new Error("A prompt is required.");

  const existing = readForWrite();
  if (id != null && existing.some((job) => job.id === id))
    throw new ConflictError(`A routine with id "${id}" already exists.`);

  const taken = new Set(existing.map((job) => job.id));
  let generated = `job-${Date.now()}-${++counter}`;
  // A caller id may look like a minted one (same clock, same counter).
  while (id == null && taken.has(generated))
    generated = `job-${Date.now()}-${++counter}`;

  const prompt = input.prompt.trim();
  const job: CronJob = {
    id: id ?? generated,
    name: (input.name ?? "").trim() || deriveName(prompt),
    schedule: hasSchedule ? schedule : null,
    // One or the other: a time to run once wins over a repeating schedule.
    runAt: runAt != null && !hasSchedule ? runAt : null,
    // 24 random bytes: the token is the only secret guarding the endpoint.
    webhookToken:
      input.webhook === true ? crypto.randomBytes(24).toString("hex") : null,
    prompt,
    workspaceId: input.workspaceId ?? null,
    botId: input.botId ?? null,
    enabled: true,
    createdAt: Date.now(),
    lastRunAt: null,
    lastResult: null,
    runs: [],
  };

  write([...existing, job]);

  return job;
};

export const updateJob = (
  id: string,
  changes: Partial<
    Pick<
      CronJob,
      | "schedule"
      | "runAt"
      | "prompt"
      | "enabled"
      | "name"
      | "botId"
      | "workspaceId"
    >
  > & { webhook?: boolean }
): CronJob => {
  const jobs = readForWrite();
  const index = jobs.findIndex((job) => job.id === id);

  if (index < 0)
    throw new EntityNotFoundError("routine", id, `No job with id "${id}".`);

  if (changes.schedule != null && changes.schedule.trim().length > 0)
    parseCron(changes.schedule);

  const { webhook, ...rest } = changes;
  const updated: CronJob = { ...jobs[index], ...rest };

  if (rest.schedule != null && rest.schedule.trim().length === 0)
    updated.schedule = null;
  // Schedule and run-once time are exclusive; a re-armed once job re-enables.
  if (rest.schedule != null && rest.schedule.trim().length > 0)
    updated.runAt = null;
  if (rest.runAt != null) {
    updated.schedule = null;
    if (changes.enabled == null) updated.enabled = true;
  }
  if (rest.name != null)
    updated.name = rest.name.trim() || deriveName(updated.prompt);

  // Turning the webhook off revokes the token; old URLs must stop working.
  if (webhook === true && updated.webhookToken == null)
    updated.webhookToken = crypto.randomBytes(24).toString("hex");
  if (webhook === false) updated.webhookToken = null;

  jobs[index] = updated;
  write(jobs);

  return updated;
};

export const removeJob = (id: string): void => {
  const jobs = readForWrite();
  const remaining = jobs.filter((job) => job.id !== id);

  if (remaining.length === jobs.length)
    throw new EntityNotFoundError("routine", id, `No job with id "${id}".`);

  write(remaining);
};

/** What a `started` attempt announces (`routines.events`, spec 05 §31.5 j). */
export interface RoutineRunStarted {
  routineId: string;
  attemptId: string;
  trigger: CronTrigger;
  startedAt: number;
}

const runStartedListeners = new Set<(event: RoutineRunStarted) => void>();

/** Called after a `started` attempt is persisted. */
export const onRoutineRunStarted = (
  listener: (event: RoutineRunStarted) => void
): (() => void) => {
  runStartedListeners.add(listener);
  return () => {
    runStartedListeners.delete(listener);
  };
};

export interface RecordRunDetails {
  /** Defaults to what `result` says (main's own strings). */
  kind?: RoutineRunKind;
  sessionId?: string | null;
  /** A follow-up's attempt. */
  attemptId?: string | null;
}

/**
 * Records one history entry, newest first, with a freshly minted id.
 * Returns it, or null for a routine that is gone. An attempt also sets the
 * routine's `lastRunAt`/`lastResult`; so does a follow-up, as before.
 */
export const recordRun = (
  id: string,
  result: string,
  trigger: CronTrigger = "schedule",
  details: RecordRunDetails = {}
): CronRun | null => {
  const jobs = readForWrite();
  const index = jobs.findIndex((job) => job.id === id);

  if (index < 0) return null;

  const at = Date.now();
  const run: CronRun = {
    id: mintAttemptId(),
    at,
    trigger,
    result: result.slice(0, 300),
    kind: details.kind ?? legacyKind(result),
    sessionId: details.sessionId ?? null,
    attemptId: details.attemptId ?? null,
  };
  jobs[index] = {
    ...jobs[index],
    lastRunAt: at,
    lastResult: result.slice(0, 500),
    runs: [run, ...jobs[index].runs],
  };
  write(jobs);
  if (run.kind === "started" && isAttempt(run))
    for (const listener of Array.from(runStartedListeners)) {
      try {
        listener({ routineId: id, attemptId: run.id, trigger, startedAt: at });
      } catch (error) {
        console.error("[cron-store] run-started listener threw", error);
      }
    }
  return run;
};

/** The attempt that started `sessionId`, if the routine recorded one. */
export const attemptOfSession = (
  routineId: string,
  sessionId: string
): CronRun | null =>
  getJob(routineId)?.runs.find(
    (run) => isAttempt(run) && run.sessionId === sessionId
  ) ?? null;

/** Jobs whose schedule matches this minute. Webhook-only jobs never tick. */
export const dueJobs = (at: Date = new Date()): CronJob[] =>
  read().filter((job) => {
    if (!job.enabled) return false;
    // Once: due from its moment until fired, so a slept-through fire happens.
    if (job.runAt != null) return job.runAt <= at.getTime();
    if (job.schedule == null) return false;

    try {
      return matches(parseCron(job.schedule), at);
    } catch {
      // A job whose expression became invalid should not stop the others.
      return false;
    }
  });

/** A once job has fired: it is done, and stays in the list as a record. */
export const retireOnceJob = (id: string): void => {
  const job = getJob(id);
  if (job == null || job.runAt == null) return;
  updateJob(id, { enabled: false });
};

export const describeJob = (job: CronJob): string => {
  const next = (() => {
    if (job.schedule == null) return "on webhook";
    try {
      return nextRun(job.schedule)?.toLocaleString() ?? "never";
    } catch {
      return "invalid schedule";
    }
  })();

  const last =
    job.lastRunAt != null ? new Date(job.lastRunAt).toLocaleString() : "never";
  const triggers = [
    job.schedule != null ? job.schedule : null,
    job.webhookToken != null ? "webhook" : null,
  ]
    .filter((part) => part != null)
    .join(" + ");

  return [
    `${job.id}  [${job.enabled ? "enabled" : "paused"}]  ${triggers}  ${job.name}`,
    `  ${job.prompt}`,
    `  next: ${next}   last: ${last}${job.lastResult != null ? ` (${job.lastResult})` : ""}`,
  ].join("\n");
};
