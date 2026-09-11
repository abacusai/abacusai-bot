/**
 * Scheduled and webhook-fired agent runs (routines), persisted to
 * `cronjobs.json`. A job has a five-field cron schedule, a webhook token for
 * `POST /hooks/<token>`, both, or neither (manual). The cron parser is local:
 * eighty lines beat a dependency. Seconds, names and `L`/`W`/`#` are rejected
 * explicitly rather than silently misread.
 */
import crypto from "crypto";
import fs from "fs";
import path from "path";

import { abacusBotHome } from "../../paths";

export type CronTrigger = "schedule" | "webhook" | "manual" | "create";

export interface CronRun {
  at: number;
  trigger: CronTrigger;
  /** Short outcome, capped — "started session x", or why it did not. */
  result: string;
}

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

const read = (): CronJob[] => {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(FILE(), "utf8"));

    if (!Array.isArray(parsed)) return [];
    // Older files lack the newer fields; they were all plain cron jobs.
    return (parsed as CronJob[]).map((job) => ({
      ...job,
      name: job.name ?? deriveName(job.prompt),
      schedule: job.schedule ?? null,
      runAt: job.runAt ?? null,
      webhookToken: job.webhookToken ?? null,
      botId: job.botId ?? null,
      runs: Array.isArray(job.runs) ? job.runs : [],
    }));
  } catch {
    return [];
  }
};

const write = (jobs: CronJob[]): void => {
  const file = FILE();
  fs.mkdirSync(path.dirname(file), { recursive: true });

  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(jobs, null, 2)}\n`, "utf8");
  fs.renameSync(temp, file);
};

const deriveName = (prompt: string): string => {
  const line = prompt.trim().split("\n")[0] ?? "";
  return line.length > 60 ? `${line.slice(0, 57)}…` : line;
};

// ── Cron parsing ───────────────────────────────────────────────────────────

interface Field {
  min: number;
  max: number;
  values: Set<number>;
}

const parseField = (
  raw: string,
  min: number,
  max: number,
  label: string
): Field => {
  const values = new Set<number>();

  for (const part of raw.split(",")) {
    const [range, stepRaw] = part.split("/");
    const step = stepRaw != null ? Number(stepRaw) : 1;

    if (!Number.isInteger(step) || step < 1)
      throw new Error(`Bad step "${stepRaw}" in the ${label} field.`);

    let from: number;
    let to: number;

    if (range === "*") {
      from = min;
      to = max;
    } else if (range.includes("-")) {
      const [a, b] = range.split("-").map(Number);

      if (!Number.isInteger(a) || !Number.isInteger(b))
        throw new Error(`Bad range "${range}" in the ${label} field.`);

      from = a;
      to = b;
    } else {
      const single = Number(range);

      if (!Number.isInteger(single))
        throw new Error(`Bad value "${range}" in the ${label} field.`);

      from = single;
      to = single;
    }

    if (from < min || to > max || from > to) {
      throw new Error(
        `The ${label} field must be between ${min} and ${max}; got "${part}".`
      );
    }

    for (let value = from; value <= to; value += step) values.add(value);
  }

  return { min, max, values };
};

interface ParsedCron {
  minute: Field;
  hour: Field;
  dayOfMonth: Field;
  month: Field;
  dayOfWeek: Field;
  /** True when both day fields are restricted, which cron treats as OR, not AND. */
  bothDaysRestricted: boolean;
}

export const parseCron = (expression: string): ParsedCron => {
  const fields = expression.trim().split(/\s+/);

  if (fields.length === 6) {
    throw new Error(
      "Six-field expressions (with seconds) are not supported. Use five fields: minute hour day month weekday."
    );
  }

  if (fields.length !== 5) {
    throw new Error(
      `Expected five fields (minute hour day month weekday), got ${fields.length}.`
    );
  }

  if (/[a-zA-Z]/.test(expression)) {
    throw new Error(
      "Names like MON or JAN are not supported. Use numbers: 0-6 for weekday, 1-12 for month."
    );
  }

  // 7 is Sunday, folded onto 0 after expansion: a textual rewrite would
  // corrupt "*/7" and "0-7".
  const dayOfWeek = parseField(fields[4], 0, 7, "weekday");

  if (dayOfWeek.values.has(7)) {
    dayOfWeek.values.delete(7);
    dayOfWeek.values.add(0);
  }
  dayOfWeek.max = 6;

  return {
    minute: parseField(fields[0], 0, 59, "minute"),
    hour: parseField(fields[1], 0, 23, "hour"),
    dayOfMonth: parseField(fields[2], 1, 31, "day-of-month"),
    month: parseField(fields[3], 1, 12, "month"),
    dayOfWeek,
    bothDaysRestricted: fields[2] !== "*" && fields[4] !== "*",
  };
};

const matches = (cron: ParsedCron, at: Date): boolean => {
  if (!cron.minute.values.has(at.getMinutes())) return false;
  if (!cron.hour.values.has(at.getHours())) return false;
  if (!cron.month.values.has(at.getMonth() + 1)) return false;

  const dayMatch = cron.dayOfMonth.values.has(at.getDate());
  const weekdayMatch = cron.dayOfWeek.values.has(at.getDay());

  // Standard cron quirk: both day fields restricted means EITHER matches.
  return cron.bothDaysRestricted
    ? dayMatch || weekdayMatch
    : dayMatch && weekdayMatch;
};

/**
 * Next fire strictly after `from`, or null within a year. Minute-by-minute:
 * 525,600 set lookups is milliseconds, and clearer than solving the fields.
 */
export const nextRun = (
  expression: string,
  from: Date = new Date()
): Date | null => {
  const cron = parseCron(expression);
  const at = new Date(from.getTime());

  at.setSeconds(0, 0);
  at.setMinutes(at.getMinutes() + 1);

  for (let i = 0; i < 366 * 24 * 60; i++) {
    if (matches(cron, at)) return at;

    at.setMinutes(at.getMinutes() + 1);
  }

  // Reachable for impossible dates like "30 2 30 2 *" — February 30th.
  return null;
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

export const createJob = (input: {
  schedule?: string | null;
  runAt?: number | null;
  /** True mints a webhook token, making the job POST-firable. */
  webhook?: boolean;
  prompt: string;
  name?: string;
  workspaceId?: string | null;
  botId?: string | null;
}): CronJob => {
  const schedule = input.schedule?.trim() ?? "";
  const hasSchedule = schedule.length > 0;
  const runAt = input.runAt ?? null;

  // Validated before saving, so a bad expression fails where the user sees it.
  if (hasSchedule) parseCron(schedule);
  if (runAt != null && !Number.isFinite(runAt))
    throw new Error("A run-once time must be a moment in time.");

  if (input.prompt.trim().length === 0)
    throw new Error("A prompt is required.");

  const prompt = input.prompt.trim();
  const job: CronJob = {
    id: `job-${Date.now()}-${++counter}`,
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

  write([...read(), job]);

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
  const jobs = read();
  const index = jobs.findIndex((job) => job.id === id);

  if (index < 0) throw new Error(`No job with id "${id}".`);

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
  const jobs = read();
  const remaining = jobs.filter((job) => job.id !== id);

  if (remaining.length === jobs.length)
    throw new Error(`No job with id "${id}".`);

  write(remaining);
};

export const recordRun = (
  id: string,
  result: string,
  trigger: CronTrigger = "schedule"
): void => {
  const jobs = read();
  const index = jobs.findIndex((job) => job.id === id);

  if (index < 0) return;

  const at = Date.now();
  jobs[index] = {
    ...jobs[index],
    lastRunAt: at,
    lastResult: result.slice(0, 500),
    runs: [{ at, trigger, result: result.slice(0, 300) }, ...jobs[index].runs],
  };
  write(jobs);
};

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
