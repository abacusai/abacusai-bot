/**
 * Routines on the wire: scheduled and webhook-fired agent runs. Stored by main
 * (cron-store.ts, whose CronJob is structurally this Routine); list items carry
 * what a row shows, resolved in main because the renderer can know none of it.
 */
import { ROUTINE_BUDGET_STOPS_BEFORE_PAUSE } from "@abacus-ai/agent/spend-policy";

/**
 * `catch-up`: a scheduled fire made up after the computer was off or asleep;
 * `interrupted`: a scheduled run made up once after the app closed under it;
 * `agent`: the agent ran it from a conversation, not the user's Run now.
 */
export type RoutineTrigger =
  | "schedule"
  | "catch-up"
  | "interrupted"
  | "webhook"
  | "manual"
  | "create"
  | "agent";

/**
 * One entry of a routine's history (spec 05 §31.5 f). **Attempt kinds** are
 * one per fire: `started` and `start-failed` (a session exists), `skipped`,
 * `skipped-offline` (held for the network, and its next fire came first),
 * `skipped-credits` (the account is out of credits: nothing ran, nothing was
 * billed) and `no-workspace` (none), and `unknown` (a legacy entry main could
 * not classify). **Follow-up kinds** are not fires: `timed-out` (the reaper
 * stopped a started run; it names that attempt) and `paused` (an
 * administrative note, no session).
 */
export type RoutineRunKind =
  | "started"
  | "start-failed"
  | "skipped"
  | "skipped-offline"
  | "skipped-credits"
  | "skipped-link"
  | "no-workspace"
  | "unknown"
  | "timed-out"
  | "paused";

export interface RoutineRun {
  /** `attempt-<uuid>`, minted once when recorded (legacy: by migration step 5). */
  id: string;
  at: number;
  trigger: RoutineTrigger;
  result: string;
  kind: RoutineRunKind;
  /** The run's session: set for `started`, `start-failed`, and a timeout. */
  sessionId: string | null;
  /** A follow-up's attempt (a timeout's `started` entry); null otherwise. */
  attemptId: string | null;
}

/** Consecutive failed runs before a local routine pauses itself. */
export const ROUTINE_FAILURES_BEFORE_PAUSE = 3;

/** Completed runs in a row that found nothing new before it pauses itself. */
export const ROUTINE_QUIET_RUNS_BEFORE_PAUSE = 3;

/**
 * Local routines are waiting for credits: their fires skip, unbilled, until
 * the credits are back. Main stamps it and clears it when the wall goes; the
 * status board tells the user, once.
 */
export interface RoutineCreditHold {
  at: number;
  /** The routine that first skipped: where the notice opens. */
  routineId: string;
}

/**
 * The `paused` history note main writes when it pauses a local routine, by
 * reason. Persisted on users' disks: existing texts never change. `credits`
 * is history: out of credits a routine now skips, it no longer pauses.
 */
export const ROUTINE_PAUSE_NOTES = {
  credits: "paused: out of Abacus.AI credits",
  budget: `paused after ${ROUTINE_BUDGET_STOPS_BEFORE_PAUSE} runs in a row stopped at their credit budget`,
  failures: `paused after ${ROUTINE_FAILURES_BEFORE_PAUSE} failed runs in a row`,
  quiet: `paused after ${ROUTINE_QUIET_RUNS_BEFORE_PAUSE} runs in a row found nothing new`,
  done: "finished: what it was waiting for happened",
} as const;

export type RoutinePauseReason = keyof typeof ROUTINE_PAUSE_NOTES;

/**
 * Why main paused a routine, when its newest history entry (newest first) is
 * one of main's own pause notes; null for any other entry or note.
 */
export const routinePauseReason = (
  history: readonly Pick<RoutineRun, "kind" | "result">[]
): RoutinePauseReason | null => {
  const newest = history[0];
  if (newest?.kind !== "paused") return null;
  const reasons = Object.keys(ROUTINE_PAUSE_NOTES) as RoutinePauseReason[];
  return (
    reasons.find((reason) => ROUTINE_PAUSE_NOTES[reason] === newest.result) ??
    null
  );
};

/**
 * Where a routine runs: `local`, on this computer's own scheduler while the
 * app runs; `hosted`, kept and timed by the server and run on the user's
 * hosted bot (a reminder is sent by the server itself).
 */
export type RoutineRunner = "local" | "hosted";

/** A hosted routine's kind: a reminder sends fixed text and runs nothing. */
export type HostedRoutineKind = "reminder" | "task" | "watch" | "event";

/** `relevant`: delivered only when the run says its condition holds. */
export type HostedRoutineNotify = "always" | "relevant";

export type HostedRoutineDelivery = "default" | "whatsapp" | "email" | "panel";

/** One finished hosted run, as the server reports it. */
export interface HostedRoutineRun {
  id: string;
  /** The routine's id in the Routines table, when the server names it. */
  routineId: string | null;
  name: string | null;
  /**
   * `queued`, `running` or `done`; for a failed run, why (`missed`,
   * `timeout`, `payment_required`, `plan_limit`, `no_host`, ...).
   */
  status: string;
  at: number | null;
  /** `whatsapp`, `email` or `panel`. */
  deliveredVia: string | null;
  /** A done run whose answer was not worth sending (`notify: relevant`) is false. */
  delivered: boolean | null;
  /** What the run reported. */
  summary: string | null;
}

/**
 * Account data a routine may read unattended, by connector read: none unless
 * declared, and only what the routine needs.
 */
export type RoutineRead = "gmail.search" | "gmail.read" | "calendar.read";

/** What an unattended run of a routine may reach, as the user confirmed it. */
export interface RoutineReach {
  /** URL prefixes its runs may read pages under. */
  sources: string[];
  /** Account data its runs may read. */
  reads: RoutineRead[];
}

/** What a hosted routine row carries beyond a local one. */
export interface HostedRoutineInfo {
  kind: HostedRoutineKind;
  /** The IANA zone its schedule is read in. */
  timezone: string | null;
  notify: HostedRoutineNotify;
  delivery: HostedRoutineDelivery;
  /** URL prefixes its runs may read pages under. */
  sources: string[];
  /** Account data its runs may read. */
  reads: RoutineRead[];
  watchUrl: string | null;
  /** Its runs have full access: `sources` and `reads` no longer apply. */
  fullAccess?: boolean;
  /** Why the server paused it, when it did. */
  pausedReason: string | null;
  lastRun: HostedRoutineRun | null;
  /**
   * The id it was created under in this app (an optimistic insert's), so the
   * form that made it can find it; null once the app restarted.
   */
  createdAs?: string | null;
}

/**
 * Abacus AI Agent on the web, where paid plans keep scheduled tasks that run
 * on the server, with the computer off.
 */
export const ABACUS_AGENT_ROUTINES_URL = "https://apps.abacus.ai/chatllm/agent";

/** Fires a local routine missed while the computer was off (asleep or the app closed). */
export interface RoutineMissed {
  count: number;
  /** When the scheduler found them, on the next tick back. */
  at: number;
}

export interface Routine {
  id: string;
  name: string;
  /** Five-field cron in local time, or null for webhook-only routines. */
  schedule: string | null;
  /** A single fire at this instant (epoch ms) instead of a schedule. */
  runAt: number | null;
  /**
   * What a local routine waits for: the run that finds it holds ends the
   * routine. Absent or null: it never ends on its own.
   */
  until?: string | null;
  /** Secret path segment of the webhook URL, or null when not POST-firable. */
  webhookToken: string | null;
  prompt: string;
  workspaceId: string | null;
  /** The bot that made this routine, if a bot did. Provenance, not a target. */
  botId: string | null;
  enabled: boolean;
  createdAt: number;
  lastRunAt: number | null;
  lastResult: string | null;
  runs: RoutineRun[];
  /** Absent on routines from before runners: local. */
  runner?: RoutineRunner;
  /** A local routine moved to the server: its id there. It no longer fires here. */
  serverId?: string | null;
  /** The fires it last missed while the computer was off; cleared by its next on-time fire. */
  missed?: RoutineMissed | null;
  /**
   * The model a local routine runs on, its own: no chat's pick moves it. Null
   * is the plan's default. Absent on a routine saved before routines had one.
   */
  model?: string | null;
  /**
   * The chat a local routine was made from, or opened by "Reply to this run":
   * its runs' reports are delivered there. Absent on older routines.
   */
  originSessionId?: string | null;
}

export interface RoutineListItem extends Routine {
  nextRunAt: number | null;
  webhookUrl: string | null;
  /**
   * Relay still minting the public URL; webhookUrl is the loopback fallback.
   */
  webhookPublicPending: boolean;
  botName: string | null;
  /** Set on a hosted routine's row. */
  hosted?: HostedRoutineInfo;
  /** A fire came due with the network down: it runs once the network is back. */
  waitingForConnection?: boolean;
  /** Its runs' reports reach a chat, where the user replies to a run (not on the hosted computer). */
  repliesInChat?: boolean;
}

export interface RoutineCreateInput {
  name?: string;
  schedule?: string | null;
  runAt?: number | null;
  /** Local only: the condition that ends it (see `Routine.until`). */
  until?: string | null;
  /** True mints a webhook token, making the routine POST-firable. */
  webhook?: boolean;
  prompt: string;
  workspaceId?: string | null;
  botId?: string | null;
  /** Where it runs; absent picks this app's default (see createRoutine). */
  runner?: RoutineRunner;
  /** Hosted only. */
  kind?: HostedRoutineKind;
  timezone?: string | null;
  notify?: HostedRoutineNotify;
  delivery?: HostedRoutineDelivery;
  /** URL prefixes its runs may read pages under. */
  sources?: string[];
  /** Account data its runs may read; none unless declared. */
  reads?: RoutineRead[];
  /** The one page a hosted watch run opens. */
  watchUrl?: string | null;
  /** A reminder's fixed text, sent as written. */
  reminderText?: string | null;
}

export type RoutineUpdateInput = Partial<
  Pick<
    Routine,
    | "schedule"
    | "runAt"
    | "until"
    | "prompt"
    | "enabled"
    | "name"
    | "botId"
    | "workspaceId"
    | "model"
  >
> & {
  webhook?: boolean;
};
