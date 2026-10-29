/**
 * Scheduled and webhook-fired agent runs (routines), persisted to
 * `cronjobs.json`. A job has a five-field cron schedule, a webhook token for
 * `POST /hooks/<token>`, both, or neither (manual). The cron parser is
 * `shared/routines/cron.ts`: eighty lines beat a dependency.
 */
import crypto from "crypto";
import path from "path";

import {
  recoverFromBackupSync,
  writeFileAtomicSync,
} from "@abacus-ai/agent/atomic-file";
import { ConflictError } from "@abacus-ai/contract/conflict";
import { EntityNotFoundError } from "@abacus-ai/contract/not-found";
import type {
  RoutineMissed,
  RoutineReach,
  RoutineRun,
  RoutineRunKind,
  RoutineTrigger,
} from "@abacus-ai/contract/routines";
import {
  matches,
  nextRun,
  parseCron,
  type ParsedCron,
} from "@abacus-ai/contract/routines/cron";

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
export {
  CronParseError,
  nextRun,
  parseCron,
} from "@abacus-ai/contract/routines/cron";

export type CronTrigger = RoutineTrigger;

/** How an attempt to fire a routine ended before any run began. */
export type RoutineRunStart = "started" | "skipped" | "failed";

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
  /** When the user last resumed it; failures before that do not count toward a pause. */
  resumedAt?: number | null;
  createdAt: number;
  lastRunAt: number | null;
  lastResult: string | null;
  /** Newest first, unbounded; the run's session is the real record. */
  runs: CronRun[];
  /** Absent before runners existed: every job here is local. */
  runner?: "local" | "hosted";
  /** Moved to the server (see routine-migration.ts): its id there. */
  serverId?: string | null;
  /** Full access unless the user made it read-only ("unattended"). */
  access?: "unattended" | "full";
  /** What its unattended runs may reach. */
  reach?: RoutineReach | null;
  /** The server would not take it: it stays here, paused, with this reason. */
  notMoved?: string | null;
  /**
   * When a fire came due with the network down, or was held to make up a
   * missed one; it runs once the network is back. On disk so a restart
   * before then still runs it.
   */
  heldSince?: number | null;
  /** The scheduled moment a held fire stands for, and why it is held. */
  heldSlot?: number | null;
  heldFor?: "network" | "catch-up" | null;
  /**
   * The newest scheduled moment fired, claimed before its session starts:
   * a slot at or before it never fires again, across restarts included.
   */
  firedSlot?: { at: number; attemptId: string } | null;
  /** When its schedule last changed: fires before then were never its to miss. */
  scheduledAt?: number | null;
  /** Fires it last missed while the computer was off, until its next on-time fire. */
  missed?: RoutineMissed | null;
}

const FILE = (): string => path.join(abacusBotHome(), "cronjobs.json");

/**
 * `cronjobs.json` is kept twice (`keepBackup`), so a copy a crash tore can
 * be put back from the other; the journal entries beside it are not.
 */
const writeStoreFile = (file: string, text: string): void =>
  writeFileAtomicSync(file, text, {
    keepBackup: path.resolve(file) === path.resolve(FILE()),
  });

/**
 * `cronjobs.json` is a migration destination (step 5): while an unresolved
 * commit may cover it (spec 00 C.1), a write is journalled beside the
 * thread store's held writes and every read sees it; it reaches the file
 * once the block lifts (the startup replay, or the next read or write).
 */
const held = new HeldFiles({
  requireDurableHolding: true,
  dir: () => path.join(abacusBotHome(), "threads", ".pending"),
  isWriteBlocked: isMigrationWriteBlocked,
  writeFile: writeStoreFile,
  log: (message) => console.warn(`[cron-store] ${message}`),
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value != null && typeof value === "object" && !Array.isArray(value);

/** An entry main can read as a job; any other is kept, never listed. */
const isJobEntry = (
  value: unknown
): value is Record<string, unknown> & { id: string } =>
  isRecord(value) && typeof value.id === "string";

/**
 * A routine saved without an id gets one derived from what it says, so
 * every launch, and a launch after a crash before it was saved, agrees.
 */
const withRecoveredIds = (entries: unknown[]): unknown[] => {
  const taken = new Set(entries.filter(isJobEntry).map((entry) => entry.id));
  return entries.map((entry) => {
    if (
      !isRecord(entry) ||
      entry.id != null ||
      typeof entry.prompt !== "string"
    )
      return entry;
    const hash = crypto
      .createHash("sha256")
      .update(JSON.stringify([entry.name, entry.createdAt, entry.prompt]))
      .digest("hex")
      .slice(0, 12);
    let id = `job-recovered-${hash}`;
    for (let n = 2; taken.has(id); n++) id = `job-recovered-${hash}-${n}`;
    taken.add(id);
    return { ...entry, id };
  });
};

/** The entries `text` holds, or null when it is not a job list. Blank is none. */
const parseEntries = (text: string): unknown[] | null => {
  if (text.trim().length === 0) return [];
  try {
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

/**
 * The last good copy, put back over a `cronjobs.json` whose bytes are not a
 * job list (a crash can leave it NUL-filled; the bad bytes are kept beside
 * it). Null when there is no such copy, or the file is held.
 */
const restoreFromBackup = (): unknown[] | null => {
  if (held.isBlocked(FILE())) return null;
  const text = recoverFromBackupSync(
    FILE(),
    (backup) => backup.trim() !== "" && parseEntries(backup) !== null
  );
  if (text === null) return null;
  console.warn(
    "[cron-store] cronjobs.json was not a job list; restored the routines from its last good copy"
  );
  return parseEntries(text);
};

/**
 * The jobs on disk (or held), or null when the file is there but cannot be
 * read as a job list and has no good copy to restore. A missing or blank
 * file is no jobs; an entry that is not a job is left out (`write` keeps it).
 */
const load = (): CronJob[] | null => {
  const file = held.read(FILE());
  if (file.status === "missing") return [];
  if (file.status !== "ok") return null;
  const parsed = parseEntries(file.text) ?? restoreFromBackup();
  if (parsed === null) return null;
  const recovered = withRecoveredIds(parsed);
  if (recovered.some((entry, index) => entry !== parsed[index])) {
    try {
      if (!held.isBlocked(FILE()))
        held.write(FILE(), `${JSON.stringify(recovered, null, 2)}\n`);
    } catch (error) {
      console.warn("[cron-store] could not save recovered routine ids", error);
    }
  }
  // Older files lack the newer fields; they were all plain cron jobs.
  return (recovered.filter(isJobEntry) as unknown as CronJob[]).map((job) => ({
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
 * list built from nothing: the write is refused and the file kept. The
 * message is read by the agent, so it says what not to do about it.
 */
const readForWrite = (): CronJob[] => {
  const jobs = load();
  if (jobs == null)
    throw new Error(
      "cronjobs.json cannot be read and no good copy of it is kept, so routines cannot be saved; the file was left as it is. It may still hold the user's routines: do not delete, empty, or overwrite it. Tell the user routines cannot be saved until it is recovered."
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
  const raw: unknown[] = withRecoveredIds(
    source.status === "ok" && source.text.trim() !== ""
      ? JSON.parse(source.text)
      : []
  );
  const stored = jobs.map((job) => {
    const old = raw
      .filter(isJobEntry)
      .find((entry) => entry.id === job.id)?.runs;
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
  const unread = raw.filter((entry) => !isJobEntry(entry));
  held.write(FILE(), `${JSON.stringify([...stored, ...unread], null, 2)}\n`);
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
    reach?: RoutineReach | null;
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
    ...(input.reach != null ? { reach: input.reach } : {}),
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
      | "access"
      | "reach"
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
  // A one-time routine that already fired stays done: resumed as it stands
  // it would fire again on the next tick. A new time re-arms it.
  if (
    rest.enabled === true &&
    !jobs[index].enabled &&
    rest.runAt == null &&
    updated.runAt != null &&
    updated.runAt <= Date.now()
  )
    throw new Error(
      "This one-time routine already ran; give it a new time to run it again."
    );
  // Resumed: the failures that led to the pause are history.
  if (rest.enabled === true && !jobs[index].enabled)
    updated.resumedAt = Date.now();

  if (rest.schedule != null && rest.schedule.trim().length === 0)
    updated.schedule = null;
  // Schedule and run-once time are exclusive; a re-armed once job re-enables.
  if (rest.schedule != null && rest.schedule.trim().length > 0)
    updated.runAt = null;
  if (rest.runAt != null) {
    updated.schedule = null;
    if (changes.enabled == null) updated.enabled = true;
  }
  // Fires the old schedule had, or none, are not this one's to miss, and
  // a moment it fired says nothing about the new one's.
  if (updated.schedule !== jobs[index].schedule)
    updated.scheduledAt = Date.now();
  if (updated.schedule !== jobs[index].schedule || rest.runAt != null)
    updated.firedSlot = null;
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

/**
 * The job now runs on the server, as `serverId`: kept as a record, switched
 * off for good here, so an older app on this disk never fires it again.
 */
export const markMovedToServer = (id: string, serverId: string): CronJob => {
  const jobs = readForWrite();
  const index = jobs.findIndex((job) => job.id === id);
  if (index < 0)
    throw new EntityNotFoundError("routine", id, `No job with id "${id}".`);
  const updated: CronJob = {
    ...jobs[index],
    enabled: false,
    runner: "hosted",
    serverId,
  };
  jobs[index] = updated;
  write(jobs);
  return updated;
};

/**
 * The server would not take the job for good (a plan limit, a schedule it
 * refuses): it stays here, paused with the reason, so one scheduler is left.
 */
export const markNotMoved = (id: string, reason: string): CronJob => {
  const jobs = readForWrite();
  const index = jobs.findIndex((job) => job.id === id);
  if (index < 0)
    throw new EntityNotFoundError("routine", id, `No job with id "${id}".`);
  const updated: CronJob = { ...jobs[index], enabled: false, notMoved: reason };
  jobs[index] = updated;
  write(jobs);
  return updated;
};

/**
 * Hold a job (`at`) for the scheduled moment `slot`, or let it go (null).
 * A hold for a missed fire is a catch-up; any other waits for the network.
 */
export const setHeld = (
  id: string,
  at: number | null,
  hold: { slot: number; reason: "network" | "catch-up" } | null = null
): void => {
  const jobs = readForWrite();
  const index = jobs.findIndex((job) => job.id === id);
  if (index < 0) return;
  const job = jobs[index];
  const slot = at == null ? null : (hold?.slot ?? minuteOf(at));
  const reason = at == null ? null : (hold?.reason ?? "network");
  if (
    (job.heldSince ?? null) === at &&
    (job.heldSlot ?? null) === slot &&
    (job.heldFor ?? null) === reason
  )
    return;
  jobs[index] = { ...job, heldSince: at, heldSlot: slot, heldFor: reason };
  write(jobs);
};

/** The start of `at`'s minute: the moment a cron fire stands for. */
export const minuteOf = (at: number): number => {
  const minute = new Date(at);
  minute.setSeconds(0, 0);
  return minute.getTime();
};

/** A claim this far past `now` came from a clock that ran ahead: ignored. */
const FIRED_SLOT_CLOCK_SLACK_MS = 5 * 60_000;

/** The moment last fired, as `now` can believe it; null for none. */
const firedSlotAt = (job: CronJob, now: number): number | null =>
  job.firedSlot != null && job.firedSlot.at <= now + FIRED_SLOT_CLOCK_SLACK_MS
    ? job.firedSlot.at
    : null;

/** Whether the scheduled moment `slot` has already been fired, as of `now`. */
const slotFired = (job: CronJob, slot: number, now: number): boolean => {
  const fired = firedSlotAt(job, now);
  return fired != null && slot <= fired;
};

/**
 * Claims the scheduled moment `slot` for one attempt, written before the
 * run starts, so no restart or second tick fires it again. False when it
 * (or a later one) was already claimed, or the job is gone.
 */
export const claimSlot = (
  id: string,
  slot: number,
  attemptId: string
): boolean => {
  const jobs = readForWrite();
  const index = jobs.findIndex((job) => job.id === id);
  if (index < 0 || slotFired(jobs[index], slot, Date.now())) return false;
  jobs[index] = { ...jobs[index], firedSlot: { at: slot, attemptId } };
  write(jobs);
  return true;
};

/** Record the fires a job missed while the computer was off, or clear them (null). */
export const setMissed = (id: string, missed: RoutineMissed | null): void => {
  const jobs = readForWrite();
  const index = jobs.findIndex((job) => job.id === id);
  if (index < 0 || (jobs[index].missed == null && missed == null)) return;
  jobs[index] = { ...jobs[index], missed };
  write(jobs);
};

/** Jobs held for the network, as of the last write (a restart included). */
export const heldJobs = (): CronJob[] =>
  read().filter((job) => job.heldSince != null);

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
  /** The attempt's id when claimed before the run (a scheduled slot); minted otherwise. */
  id?: string;
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
    id:
      details.id != null &&
      !jobs[index].runs.some((entry) => entry.id === details.id)
        ? details.id
        : mintAttemptId(),
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

/**
 * The scheduled moment a fire at `at` stands for: a one-time job's own
 * moment, or the minute a schedule matched.
 */
export const slotFor = (job: CronJob, at: Date): number =>
  job.runAt ?? minuteOf(at.getTime());

/**
 * Jobs whose schedule matches this minute and whose slot has not fired.
 * Webhook-only jobs never tick.
 */
export const dueJobs = (at: Date = new Date()): CronJob[] =>
  read().filter((job) => {
    if (!job.enabled) return false;
    if (slotFired(job, slotFor(job, at), at.getTime())) return false;
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

/**
 * Since when a job's fires are accounted for, from what is on disk: its last
 * run (fire-on-create included), fired slot, hold, resume, schedule change
 * or creation.
 */
const accountedSince = (job: CronJob, now: number): number =>
  Math.max(
    job.createdAt,
    job.lastRunAt ?? 0,
    firedSlotAt(job, now) ?? 0,
    job.heldSince ?? 0,
    job.resumedAt ?? 0,
    job.scheduledAt ?? 0
  );

/** A missed window longer than this counts only its last year, as nextRun looks ahead. */
const MISSED_WINDOW_MS = 366 * 24 * 60 * 60_000;

/**
 * Fires of `cron` after `from`'s minute and before `to` (a minute start):
 * how many, and the latest.
 */
const firesBetween = (
  cron: ParsedCron,
  from: number,
  to: number
): { count: number; latest: number | null } => {
  const at = new Date(Math.max(from, to - MISSED_WINDOW_MS));
  at.setSeconds(0, 0);
  at.setMinutes(at.getMinutes() + 1);
  let count = 0;
  let latest: number | null = null;
  for (; at.getTime() < to; at.setMinutes(at.getMinutes() + 1))
    if (matches(cron, at)) {
      count++;
      latest = at.getTime();
    }
  return { count, latest };
};

/** No catch-up for a fire older than this, whatever the schedule's period. */
const CATCH_UP_MAX_AGE_MS = 24 * 60 * 60_000;

/** A next fire sooner than this (or half the period) makes a catch-up moot. */
const CATCH_UP_NEAR_NEXT_MS = 30 * 60_000;

/**
 * Whether the missed fire `slot` is still worth making up at `now`: younger
 * than one period (and a day), and not with the next fire about to come.
 */
export const catchUpWorthIt = (
  schedule: string,
  slot: number,
  now: number
): boolean => {
  const next = nextRun(schedule, new Date(slot));
  if (next == null) return now - slot <= CATCH_UP_MAX_AGE_MS;
  const period = next.getTime() - slot;
  if (now - slot > Math.min(period, CATCH_UP_MAX_AGE_MS)) return false;
  const upcoming = nextRun(schedule, new Date(Math.max(now, slot)));
  if (upcoming == null) return true;
  return (
    upcoming.getTime() - now >= Math.min(CATCH_UP_NEAR_NEXT_MS, period / 2)
  );
};

export interface MissedJob {
  job: CronJob;
  /** How many fires it missed. */
  count: number;
  /** The latest of them, the only one a catch-up makes up. */
  latest: number;
}

/**
 * Scheduled jobs with fires before `to`'s minute that never ran: what a
 * machine asleep, or an app closed, missed. Each job counts from its own
 * record on disk, or from `from` (the last tick before a sleep) when later;
 * the current minute is dueJobs'.
 */
export const missedJobs = (from: Date | null, to: Date): MissedJob[] => {
  const minute = new Date(to.getTime());
  minute.setSeconds(0, 0);
  return read().flatMap((job) => {
    if (!job.enabled || job.runAt != null || job.schedule == null) return [];
    try {
      const since = Math.max(
        accountedSince(job, to.getTime()),
        from?.getTime() ?? 0
      );
      const { count, latest } = firesBetween(
        parseCron(job.schedule),
        since,
        minute.getTime()
      );
      return count > 0 && latest != null ? [{ job, count, latest }] : [];
    } catch {
      return [];
    }
  });
};

/** A once job has fired: it is done, and stays in the list as a record. */
export const retireOnceJob = (id: string): void => {
  const job = getJob(id);
  if (job == null || job.runAt == null) return;
  updateJob(id, { enabled: false });
};

export const describeJob = (job: CronJob): string => {
  const next = (() => {
    if (job.runAt != null)
      return job.enabled
        ? `once, at ${new Date(job.runAt).toLocaleString()}`
        : "done (it ran once)";
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
    job.schedule != null ? job.schedule : job.runAt != null ? "once" : null,
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
