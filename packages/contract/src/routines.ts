/**
 * Routines on the wire: scheduled and webhook-fired agent runs. Stored by main
 * (cron-store.ts, whose CronJob is structurally this Routine); list items carry
 * what a row shows, resolved in main because the renderer can know none of it.
 */

export type RoutineTrigger = "schedule" | "webhook" | "manual" | "create";

/**
 * One entry of a routine's history (spec 05 §31.5 f). **Attempt kinds** are
 * one per fire: `started` and `start-failed` (a session exists), `skipped`
 * and `no-workspace` (none), and `unknown` (a legacy entry main could not
 * classify). **Follow-up kinds** are not fires: `timed-out` (the reaper
 * stopped a started run; it names that attempt) and `paused` (an
 * administrative note, no session).
 */
export type RoutineRunKind =
  | "started"
  | "start-failed"
  | "skipped"
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
  /**
   * Made or changed by the agent and not yet confirmed by the user: it does
   * not run until they allow it, at a link the server sends them itself.
   */
  pendingConfirmation: boolean;
  /** The server sent the owner this version's approval link (WhatsApp, else email). */
  approvalSent: boolean;
  /** Why the server paused it, when it did. */
  pausedReason: string | null;
  lastRun: HostedRoutineRun | null;
}

export interface Routine {
  id: string;
  name: string;
  /** Five-field cron in local time, or null for webhook-only routines. */
  schedule: string | null;
  /** A single fire at this instant (epoch ms) instead of a schedule. */
  runAt: number | null;
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
  /**
   * How a local routine runs: unattended (the default; no shell, no writes,
   * no sends, and only `reach`) or with full access, which only the user
   * turns on, confirming it.
   */
  access?: "unattended" | "full";
  /** What a local routine's unattended runs may reach, as the user confirmed it. */
  reach?: RoutineReach | null;
  /** Reach the agent asked for and the user has not confirmed: not used until they do. */
  pendingReach?: RoutineReach | null;
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
}

export interface RoutineCreateInput {
  name?: string;
  schedule?: string | null;
  runAt?: number | null;
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
    | "prompt"
    | "enabled"
    | "name"
    | "botId"
    | "workspaceId"
    | "access"
    | "reach"
  >
> & {
  webhook?: boolean;
  /** The user allows the reach the agent asked for (`pendingReach`). */
  confirmPendingReach?: boolean;
};
