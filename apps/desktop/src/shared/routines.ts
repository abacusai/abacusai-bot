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
}

export interface RoutineListItem extends Routine {
  nextRunAt: number | null;
  webhookUrl: string | null;
  /**
   * Relay still minting the public URL; webhookUrl is the loopback fallback.
   */
  webhookPublicPending: boolean;
  botName: string | null;
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
  >
> & { webhook?: boolean };
