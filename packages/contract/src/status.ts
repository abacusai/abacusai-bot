/**
 * The status board's vocabulary (apps/desktop .../status/status-board.ts):
 * whether each long-lived thing (a routine, a chat-app lane, a run, the
 * agent) is running, and if not, why and whether the user was told.
 */

/**
 * `waiting`: held, and the app recovers by itself. `paused-by-app`: the app
 * paused it on purpose. `stopped-needs-user`: nothing happens until the user
 * acts. `missed`: slots passed unrun. `stopped`: died with the app or crashed.
 */
export type StatusState =
  | "running"
  | "waiting"
  | "paused-by-app"
  | "stopped-needs-user"
  | "missed"
  | "stopped";

/** `routine:<id>`, `lane:<platform>`, `run:<sessionId>` or `agent`. */
export type StatusKey =
  | `routine:${string}`
  | `lane:${string}`
  | `run:${string}`
  | "agent";

export type StatusReason =
  | "network"
  | "credits"
  | "credits-out"
  | "asleep"
  | "quiet"
  | "failing"
  | "link-lost"
  | "lane-off"
  | "needs-login"
  | "login-not-finished"
  | "retrying"
  | "gave-up"
  | "needs-user"
  | "slept"
  | "offline"
  | "interrupted"
  | "crashed"
  | "signed-out"
  /** The watchdog's: due twice over with the app online, and never fired. */
  | "unfired"
  | "ok";

export interface StatusDetail {
  /** What the user calls it: a routine's name. */
  name?: string;
  routineId?: string;
  botId?: string | null;
  sessionId?: string;
  /** The chat app it is about, or the one a routine delivers through. */
  platform?: string;
  /** `missed`: slots that passed unrun, and how many of them were made up. */
  count?: number;
  madeUp?: number;
  /** `missed`: when it was found; a new finding is told again. */
  at?: number;
}

export interface StatusItem {
  key: StatusKey;
  state: Exclude<StatusState, "running">;
  reason: StatusReason;
  since: number;
  detail: StatusDetail;
}

export const isStopState = (state: StatusState): boolean =>
  state === "paused-by-app" ||
  state === "stopped-needs-user" ||
  state === "missed" ||
  state === "stopped";
