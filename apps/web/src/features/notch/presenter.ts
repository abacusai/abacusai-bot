import type {
  AttentionSummary,
  BotRow,
  PrefsRow,
  RoutineRow,
  RunFinishedNotice,
  SessionRow,
} from "@abacus-ai/contract/contract";

import { isQuietNow } from "#renderer/lib/notify";
export type AttentionKind =
  | "question"
  | "approval"
  | "connector-ask"
  | "failed"
  | "working"
  | "reply"
  | "done";
export interface Attention {
  kind: AttentionKind;
  sessionId: string;
  since: number;
  descriptorId?: string;
  errorCode?: string;
  runId?: string;
  botId: string | null;
  canReply?: boolean;
  snoozed?: boolean;
}
export interface NotchInputs {
  now?: number;
  sessions: readonly SessionRow[];
  bots: readonly BotRow[];
  routines: readonly RoutineRow[];
  summaries: ReadonlyMap<string, AttentionSummary>;
  asks: readonly { id: string; sessionId: string; since: number }[];
  notices: readonly { notice: RunFinishedNotice; age: number }[];
  prefs: PrefsRow;
  mainFocused: boolean;
  hovered: boolean;
  listening?: string;
  acks: ReadonlySet<string>;
  snoozed: ReadonlySet<string>;
}
export interface NotchPresentation {
  route:
    | "/idle"
    | "/working"
    | "/approval/$id"
    | "/reply/$id"
    | "/call"
    | "/done"
    | "/failed";
  sessionId: string | null;
  identity: string;
  faces: {
    botId: string | null;
    mood: "idle" | "working" | "waiting" | "blocked" | "done" | "asleep";
  }[];
  remaining: number;
  expanded: boolean;
  hidden: boolean;
  quietUntil: string | null;
  attention: Attention | null;
  queue: Attention[];
}
const rank: Record<AttentionKind, number> = {
  question: 0,
  approval: 1,
  "connector-ask": 2,
  failed: 3,
  working: 4,
  reply: 5,
  done: 6,
};
export const botForSession = (
  session: Pick<SessionRow, "owner" | "routineId">,
  routines: readonly RoutineRow[]
): string | null =>
  session.owner?.botId ??
  routines.find((r) => r.id === session.routineId)?.botId ??
  null;
export const presentNotch = (
  inputs: NotchInputs,
  now: number
): NotchPresentation => {
  const queue: Attention[] = [];
  const byId = new Map(inputs.sessions.map((s) => [s.id, s]));
  const add = (item: Attention) => {
    const level = item.botId ? inputs.prefs.sounds.perBot?.[item.botId] : "all";
    if (
      level === "nothing" ||
      (level === "needs-me" &&
        !["question", "approval", "connector-ask"].includes(item.kind))
    )
      return;
    queue.push(item);
  };
  for (const session of inputs.sessions) {
    const botId = botForSession(session, inputs.routines);
    const summary = inputs.summaries.get(session.id);
    if (summary || session.turn?.phase === "waiting_permission") {
      const key = summary
        ? (summary.firstDescriptorId ??
          `${session.id}:${summary.incarnation}:${summary.oldestAt}`)
        : session.id;
      add({
        snoozed: inputs.snoozed.has(key),
        kind: summary?.questions ? "question" : "approval",
        sessionId: session.id,
        since:
          summary?.oldestAt ?? (Date.parse(session.turn?.updatedAt ?? "") || 0),
        botId,
        descriptorId: key,
      });
    } else if (session.turn?.isBusy)
      add({
        kind: "working",
        sessionId: session.id,
        since: Date.parse(session.turn.updatedAt) || 0,
        botId,
      });
  }
  for (const ask of inputs.asks) {
    const s = byId.get(ask.sessionId);
    if (s)
      add({
        kind: "connector-ask",
        snoozed: inputs.snoozed.has(ask.id),
        sessionId: s.id,
        since: ask.since,
        botId: botForSession(s, inputs.routines),
        descriptorId: ask.id,
      });
  }
  for (const { notice, age } of inputs.notices) {
    const s = byId.get(notice.threadId);
    if (
      !s ||
      notice.outcome === "cancelled" ||
      inputs.acks.has(notice.runId) ||
      age >= 600_000 ||
      s.turn?.isBusy ||
      Date.parse(s.turn?.updatedAt ?? "") > notice.at
    )
      continue;
    const kind =
      notice.outcome === "error"
        ? "failed"
        : notice.owner && notice.hasVisibleAssistantText
          ? "reply"
          : notice.owner && !notice.hasVisibleAssistantText
            ? null
            : "done";
    if (!kind || (kind === "done" && age >= 5000)) continue;
    add({
      kind,
      sessionId: s.id,
      since: notice.at,
      runId: notice.runId,
      errorCode: notice.errorCode,
      botId: botForSession(s, inputs.routines),
      canReply: s.owner?.role === "forever",
    });
  }
  queue.sort(
    (a, b) =>
      rank[a.kind] - rank[b.kind] ||
      a.since - b.since ||
      a.sessionId.localeCompare(b.sessionId)
  );
  const attention = queue.find((item) => !item.snoozed) ?? null;
  const quiet = isQuietNow(inputs.prefs.sounds.quietHours, new Date(now));
  const calm = inputs.mainFocused || quiet;
  const route =
    calm || !attention
      ? "/idle"
      : inputs.listening
        ? "/call"
        : attention.kind === "question" ||
            attention.kind === "approval" ||
            attention.kind === "connector-ask"
          ? "/approval/$id"
          : attention.kind === "reply"
            ? "/reply/$id"
            : (`/${attention.kind}` as NotchPresentation["route"]);
  const replyAge = attention?.runId
    ? (inputs.notices.find((n) => n.notice.runId === attention.runId)?.age ??
      Infinity)
    : Infinity;
  const expanded =
    !calm &&
    (inputs.hovered ||
      !!inputs.listening ||
      ["question", "approval", "connector-ask"].includes(
        attention?.kind ?? ""
      ) ||
      (attention?.kind === "reply" && replyAge < 6000));
  const faces: NotchPresentation["faces"] = [];
  for (const item of queue)
    if (!faces.some((f) => f.botId === item.botId) && faces.length < 3)
      faces.push({
        botId: item.botId,
        mood: quiet
          ? "asleep"
          : ["question", "approval", "connector-ask"].includes(item.kind)
            ? "waiting"
            : item.kind === "failed"
              ? "blocked"
              : item.kind === "done"
                ? "done"
                : "working",
      });
  if (!faces.length)
    for (const bot of inputs.bots
      .filter((bot) => inputs.prefs.sounds.perBot?.[bot.id] !== "nothing")
      .slice(0, 3))
      faces.push({ botId: bot.id, mood: quiet ? "asleep" : "idle" });
  return {
    route,
    sessionId: attention?.sessionId ?? null,
    identity: `${route}:${attention?.sessionId ?? ""}:${attention?.descriptorId ?? attention?.runId ?? ""}`,
    faces,
    remaining: Math.max(0, queue.length - (attention ? 1 : 0)),
    expanded,
    hidden:
      (!inputs.bots.length && !queue.length) ||
      (route === "/idle" && inputs.prefs.notch?.idleVisible === false),
    quietUntil: quiet ? (inputs.prefs.sounds.quietHours?.end ?? null) : null,
    attention,
    queue,
  };
};
