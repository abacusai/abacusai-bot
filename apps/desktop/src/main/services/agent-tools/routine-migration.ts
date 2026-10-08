/**
 * Moving a hosted bot's routines to the server, once, when the server says it
 * keeps routines. Each local job with a schedule, a one-time moment or a
 * webhook is created there (idempotent on the job's id), then switched off
 * here for good and kept as a record, so an older app on this disk never
 * fires it again. Crons go up in UTC, the zone they fired in on the hosted
 * computer; the bot offers once to move them to the user's own zone.
 *
 * The marker file says this computer moved: from then on its own scheduler
 * and webhook relay stay off, and every new routine is created hosted.
 */
import fs from "fs";
import path from "path";

import { abacusBotHome } from "../../paths";
import type { CronJob } from "./cron-store";
import type { HostedRoutineCreate } from "./hosted-routines";

const MARKER = (): string =>
  path.join(abacusBotHome(), "routines-migration.json");

export interface MigrationMarker {
  migratedAt: number;
  /** The one note about the move, while it is still owed to the chat. */
  note: string | null;
}

export const readMigrationMarker = (
  file: string = MARKER()
): MigrationMarker | null => {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    if (parsed == null || typeof parsed !== "object") return null;
    const record = parsed as Record<string, unknown>;
    return typeof record.migratedAt === "number"
      ? {
          migratedAt: record.migratedAt,
          note: typeof record.note === "string" ? record.note : null,
        }
      : null;
  } catch {
    return null;
  }
};

export const writeMigrationMarker = (
  marker: MigrationMarker,
  file: string = MARKER()
): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(marker), "utf8");
  fs.renameSync(temp, file);
};

/** A one-time job that already fired: it is done, and stays a local record. */
const isSpentOnce = (job: CronJob): boolean =>
  job.schedule == null &&
  job.runAt != null &&
  !job.enabled &&
  (job.lastRunAt != null || job.runs.length > 0);

/**
 * Whether a local job is one the server should take: anything that fires on
 * its own, paused ones included (they move paused, a one-time one too), but
 * not a one-time job that already ran, nor one the server already refused.
 */
export const isMovable = (job: CronJob): boolean =>
  job.serverId == null &&
  job.notMoved == null &&
  !isSpentOnce(job) &&
  (job.schedule != null || job.runAt != null || job.webhookToken != null);

/**
 * What the server is asked to create for one local job. It may read only
 * what the user already confirmed for it here; nothing is read off its
 * instruction, and it keeps its bot.
 */
export const migrationRequest = (job: CronJob): HostedRoutineCreate => {
  const webhookOnly =
    job.schedule == null && job.runAt == null && job.webhookToken != null;
  return {
    kind: webhookOnly ? "event" : "task",
    name: job.name,
    prompt: job.prompt,
    cron: job.schedule,
    at: job.schedule == null ? job.runAt : null,
    // How it fired on the hosted computer, whose clock is UTC; an event has no schedule.
    timezone: webhookOnly ? null : "UTC",
    delivery: "default",
    sources: job.reach?.sources ?? [],
    reads: job.reach?.reads ?? [],
    ownerBotId: job.botId,
    migrated: true,
    ...(job.webhookToken != null
      ? { event: { source: "webhook" as const, localToken: job.webhookToken } }
      : {}),
    idempotencyKey: job.id,
  };
};

/**
 * Refusals that will not change by trying again: the job stays here, paused
 * with the reason, and the move counts it as settled.
 */
export const PERMANENT_REFUSALS: readonly string[] = [
  "plan_limit",
  "limit",
  "invalid_schedule",
  "interval_too_short",
  "invalid_timezone",
  "invalid_source_url",
  "invalid_url",
  "invalid_connector_reads",
  "invalid_bot_id",
  "invalid_event",
  "unsupported_kind",
  "prompt_required",
  "name_required",
];

const refusalCode = (error: unknown): string | null => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : null;
};

export interface MigrationDeps {
  jobs: () => CronJob[];
  create: (request: HostedRoutineCreate) => Promise<{ id: string }>;
  /** Pause a moved routine that was paused here, so it stays paused. */
  pause: (id: string) => Promise<unknown>;
  /** Delete a routine just created there, when it could not be paused. */
  remove: (id: string) => Promise<unknown>;
  /** Switch the job off here and record where it went. */
  moved: (jobId: string, serverId: string) => void;
  /** The server will not take it: pause it here with the reason. */
  notMoved: (jobId: string, reason: string) => void;
  log?: (line: string) => void;
}

export interface MigrationResult {
  moved: number;
  /** Failures worth another try on the next start (network, server busy). */
  failed: number;
  /** Jobs the server will not take, now paused here: the owner hears once. */
  notMoved: Array<{ name: string; reason: string }>;
  /** Crons moved in UTC: the zone offer is owed. */
  crons: number;
}

/**
 * Move every movable job. A job the server refuses for good is paused here
 * with the reason (one scheduler, the server's); one that failed for now
 * stays as it is and is tried again on the next start. A job already moved
 * is skipped, so a second run does nothing new.
 */
export async function migrateRoutines(
  deps: MigrationDeps
): Promise<MigrationResult> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const result: MigrationResult = {
    moved: 0,
    failed: 0,
    notMoved: [],
    crons: 0,
  };
  for (const job of deps.jobs().filter(isMovable)) {
    let created: { id: string };
    try {
      created = await deps.create(migrationRequest(job));
    } catch (error) {
      const code = refusalCode(error);
      if (code != null && PERMANENT_REFUSALS.includes(code)) {
        deps.notMoved(job.id, code);
        result.notMoved.push({ name: job.name, reason: code });
      } else result.failed += 1;
      log(`[routines] could not move ${job.id}: ${code ?? describe(error)}`);
      continue;
    }
    // Paused here, paused there: or not there at all.
    if (!job.enabled && !(await pausedOrRemoved(deps, created.id))) {
      result.failed += 1;
      continue;
    }
    deps.moved(job.id, created.id);
    result.moved += 1;
    if (job.schedule != null) result.crons += 1;
  }
  return result;
}

/** Pause it, twice if need be; else take it back. True when it is paused. */
async function pausedOrRemoved(
  deps: MigrationDeps,
  id: string
): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await deps.pause(id);
      return true;
    } catch {
      // Once more, then give it back.
    }
  }
  await deps.remove(id).catch(() => undefined);
  return false;
}

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * The bot's one note about the move, for its chat: what moved, the offer to
 * change zone, and what could not move; said by the model in the user's
 * language.
 */
export const migrationNote = (
  crons: number,
  notMoved: ReadonlyArray<{ name: string; reason: string }>,
  /** The server's one review link: how many wait, and whether it went. */
  review: { sent: boolean; pending: number } = { sent: false, pending: 0 }
): string =>
  [
    "[routines moved] The user's routines moved to the server, to run on their own even while",
    "this computer sleeps. Their runs only read: search, and only the sites and account data",
    "the user approves for each; they no longer send messages, change files or use the browser.",
    ...(review.pending > 0
      ? [
          `${review.pending} of them are paused until the user reviews them`,
          review.sent
            ? "(the server sent them a link to review them, on WhatsApp or else by email)."
            : '(a link to review them could not be sent yet; "approval_link" with a routine\'s id sends one).',
          "Never write a link yourself.",
        ]
      : []),
    ...(crons > 0
      ? [
          `${crons} of them run on a clock at the same UTC times as before: offer once to move`,
          "them to the user's own time zone (cronjob update with timezone).",
        ]
      : []),
    ...(notMoved.length > 0
      ? [
          `These could not move and are paused: ${notMoved
            .map((job) => `"${job.name}" (${job.reason})`)
            .join(
              ", "
            )}. Say why in plain words (plan_limit or limit: the plan's routines`,
          "are used up; the rest: something in it the server cannot take) and offer to set it up again.",
        ]
      : []),
    "This is background, not what the user asked: always answer their message first, exactly as",
    "you would without this note. Only when the conversation is about routines, or as one short",
    "closing line after a full answer, mention it once in their language, naming the routine (for",
    "example: \"By the way, your routine 'Morning summary' now runs on its own; it waits for your OK",
    'from the link we sent."). Never reply with only this, and do not repeat it.',
  ].join(" ");
