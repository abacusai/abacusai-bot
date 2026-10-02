import { useLiveQuery } from "@tanstack/react-db";
import type { TFunction } from "i18next";

import { useCollections } from "#renderer/data/db";
import {
  decomposeSchedule,
  formatTime,
  weekdayName,
} from "#renderer/lib/bots/schedule";
import type {
  RoutineRow,
  RoutineRunRow,
  SessionRow,
} from "#shared/contract/rows";
export const useRoutinesData = () => {
  const c = useCollections();
  const routines = useLiveQuery(c.routines).data ?? [];
  const runs = useLiveQuery(c.routineRuns).data ?? [];
  const sessions = useLiveQuery(c.sessions).data ?? [];
  const bots = useLiveQuery(c.bots).data ?? [];
  const workspaces = useLiveQuery(c.workspaces).data ?? [];
  return { routines, runs, sessions, bots, workspaces };
};
export const stats = (rows: readonly RoutineRow[], now: Date) => {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return {
    active: rows.filter((r) => r.enabled).length,
    paused: rows.filter((r) => !r.enabled).length,
    fireToday: rows.filter(
      (r) =>
        r.enabled &&
        (r.recentRuns.some(
          (a) =>
            a.kind !== "paused" &&
            a.kind !== "timed-out" &&
            a.at >= +start &&
            a.at < +end
        ) ||
          (r.nextRunAt != null && r.nextRunAt >= +start && r.nextRunAt < +end))
    ).length,
  };
};
export const routineState = (
  r: RoutineRow,
  runs: readonly RoutineRunRow[],
  sessions: readonly SessionRow[],
  asks: ReadonlySet<string> = new Set()
) => {
  if (
    sessions.some(
      (s) =>
        s.routineId === r.id &&
        (s.turn?.phase === "waiting_permission" || asks.has(s.id))
    )
  )
    return "needs-you";
  const own = runs
    .filter((a) => a.routineId === r.id)
    .toSorted((a, b) => b.startedAt.localeCompare(a.startedAt));
  if (own.some((a) => a.outcome === "running")) return "running";
  if (own[0]?.outcome === "failed" && r.enabled) return "failed";
  if (!r.enabled) return "paused";
  if (r.runAt != null && r.schedule == null) return "once";
  if (r.schedule == null && r.webhookToken != null) return "webhook";
  return r.schedule == null ? "manual" : "scheduled";
};
export interface RunView {
  id: string;
  at: number;
  sessionId: string | null;
  outcome: string;
  result: string | null;
  trigger: string;
  note: boolean;
}
export const runsView = (
  routine: RoutineRow,
  rows: readonly RoutineRunRow[]
): RunView[] => {
  const own = rows.filter((r) => r.routineId === routine.id);
  const bySession = new Map(own.map((r) => [r.sessionId, r]));
  const named = new Set<string>();
  const follow = new Map(
    routine.recentRuns
      .filter((a) => a.kind === "timed-out" && a.attemptId)
      .map((a) => [a.attemptId, a])
  );
  const result: RunView[] = [];
  for (const a of routine.recentRuns) {
    if (a.kind === "timed-out") continue;
    if (a.sessionId) named.add(a.sessionId);
    const row = a.sessionId ? bySession.get(a.sessionId) : undefined;
    const ended = follow.get(a.id);
    result.push({
      id: a.id,
      at: a.at,
      sessionId: a.sessionId,
      note: a.kind === "paused",
      outcome: ended
        ? "failed"
        : (row?.outcome ??
          {
            started: "running",
            "start-failed": "failed",
            skipped: "skipped",
            "no-workspace": "failed",
            unknown: "unknown",
            paused: "paused",
          }[a.kind] ??
          "unknown"),
      result: ended?.result ?? row?.result ?? a.result,
      trigger: a.trigger,
    });
  }
  for (const row of own)
    if (!named.has(row.sessionId))
      result.push({
        id: row.sessionId,
        at: Date.parse(row.startedAt),
        sessionId: row.sessionId,
        outcome: row.outcome,
        result: row.result,
        trigger: row.trigger ?? "schedule",
        note: false,
      });
  return result.toSorted((a, b) => b.at - a.at);
};
export const scheduleLabel = (
  r: Pick<RoutineRow, "schedule" | "runAt">,
  t: TFunction,
  locale: string
): string => {
  const d = decomposeSchedule(r.schedule, r.runAt);
  if (d.preset === "once")
    return t("phase5.onceOn", {
      date: new Intl.DateTimeFormat(locale, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(r.runAt!),
    });
  if (d.preset === "manual") return t("routines.onDemand");
  if (d.preset === "custom")
    return t("phase5.customCron", { cron: r.schedule });
  if (d.preset === "hourly")
    return t("phase5.hourlyMinute", { minute: d.time.split(":")[1] });
  return t(`phase5.schedule.${d.preset}`, {
    time: formatTime(d.time, locale),
    day: weekdayName(d.weekday, locale),
  });
};
