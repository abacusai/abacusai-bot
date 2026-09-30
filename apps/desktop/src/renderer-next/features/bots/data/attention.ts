/**
 * One pure function behind the avatar mood, the sidebar row, the badge and
 * the needs-you group (spec 03 §6.6; PLAN "waiting > routine > working >
 * unread"), so they never disagree. R3-T12 is its table test.
 *
 * Needs-you counts are per session: main's `ai.attention` summary for that
 * thread when it has one (questions + approvals of the live incarnation;
 * spec 06 §11.2, which replaced the chat kit's cached descriptors here),
 * else 1 while the session's turn waits on a permission, plus that
 * session's pending connector asks.
 */
import type { SessionRow } from "#shared/contract/rows";

export type LifecycleMood =
  | "idle"
  | "thinking"
  | "working"
  | "waiting"
  | "blocked"
  | "done"
  | "asleep";

export interface ThreadAttention {
  count: number;
  firstTitle: string | null;
  /** When main first saw the oldest ask (epoch ms). */
  oldestAt: number;
}

export type AttentionSession = Pick<
  SessionRow,
  "id" | "owner" | "routineId" | "turn"
>;

export interface BotAttentionInput {
  /** The bot's sessions, check-in runs included, in session order. */
  sessions: readonly AttentionSession[];
  checkInRoutineId: string | null;
  /** `ai.attention` by thread id. */
  permissions: Readonly<Record<string, ThreadAttention>>;
  /** Pending connector asks by session id. */
  connectorAsks: Readonly<Record<string, number>>;
  unread: boolean;
  checkIn: { enabled: boolean } | null;
  /** The running tool's title, when the chat kit holds the thread. */
  runningTool: string | null;
}

export type BotAttention =
  | { kind: "needs-you"; count: number; title: string | null; since: number }
  | { kind: "routine" }
  | { kind: "working"; caption: string | null }
  | { kind: "error" }
  | { kind: "unread" }
  | { kind: "paused" }
  | { kind: "idle" };

const busy = (session: AttentionSession): boolean =>
  session.turn?.isBusy === true ||
  session.turn?.phase === "pending" ||
  session.turn?.phase === "streaming";

const isForever = (session: AttentionSession): boolean =>
  session.owner?.role === "forever";

export const botAttention = (input: BotAttentionInput): BotAttention => {
  let count = 0;
  let title: string | null = null;
  let since = Number.POSITIVE_INFINITY;
  for (const session of input.sessions) {
    const summary = input.permissions[session.id];
    const waiting =
      summary != null
        ? summary.count
        : session.turn?.phase === "waiting_permission"
          ? 1
          : 0;
    const asks = input.connectorAsks[session.id] ?? 0;
    if (waiting + asks === 0) continue;
    count += waiting + asks;
    title ??= summary?.firstTitle ?? null;
    const at =
      summary?.oldestAt ??
      (session.turn != null ? Date.parse(session.turn.updatedAt) : Number.NaN);
    if (Number.isFinite(at)) since = Math.min(since, at);
  }
  if (count > 0)
    return {
      kind: "needs-you",
      count,
      title,
      since: Number.isFinite(since) ? since : 0,
    };
  const checkInId = input.checkInRoutineId;
  if (
    checkInId != null &&
    input.sessions.some(
      (session) => session.routineId === checkInId && busy(session)
    )
  )
    return { kind: "routine" };
  if (
    input.sessions.some(
      (session) =>
        session.routineId == null && session.owner != null && busy(session)
    )
  )
    return { kind: "working", caption: input.runningTool };
  if (
    input.sessions.some(
      (session) => isForever(session) && session.turn?.phase === "error"
    )
  )
    return { kind: "error" };
  if (input.unread) return { kind: "unread" };
  if (input.checkIn != null && !input.checkIn.enabled)
    return { kind: "paused" };
  return { kind: "idle" };
};

export const moodFor = (attention: BotAttention): LifecycleMood => {
  switch (attention.kind) {
    case "needs-you":
      return "waiting";
    case "routine":
    case "working":
      return "working";
    case "error":
      return "blocked";
    case "paused":
      return "asleep";
    case "unread":
    case "idle":
      return "idle";
  }
};
