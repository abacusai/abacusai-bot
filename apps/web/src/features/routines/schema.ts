import type { RoutineRow } from "@abacus-ai/contract/contract/rows";
import { parseCron, nextRun } from "@abacus-ai/contract/routines/cron";
import * as v from "valibot";

import {
  composeSchedule,
  decomposeSchedule,
  type ScheduleDraft,
} from "#renderer/lib/bots/schedule";
export const ScheduleSchema = v.pipe(
  v.object({
    preset: v.picklist([
      "hourly",
      "daily",
      "weekdays",
      "weekly",
      "once",
      "manual",
      "custom",
    ]),
    time: v.string(),
    weekday: v.picklist([0, 1, 2, 3, 4, 5, 6]),
    custom: v.string(),
    runAt: v.string(),
  }),
  v.check((d) => {
    if (d.preset === "manual") return true;
    const x = composeSchedule(d);
    if (d.preset === "once") return x.runAt != null && x.runAt > Date.now();
    if (x.schedule == null) return false;
    try {
      parseCron(x.schedule);
      return true;
    } catch {
      return false;
    }
  }, "schedule-invalid")
);
export const RoutineFormSchema = v.object({
  name: v.pipe(v.string(), v.trim(), v.maxLength(80, "too-long")),
  prompt: v.pipe(
    v.string(),
    v.trim(),
    v.minLength(1, "instruction-required"),
    v.maxLength(16000, "too-long")
  ),
  schedule: ScheduleSchema,
  workspaceId: v.nullable(v.string()),
  webhook: v.boolean(),
  testRun: v.boolean(),
  /** The pages its runs may read under, one per line. */
  sources: v.string(),
  /** The account data its runs may read. */
  reads: v.array(v.picklist(["gmail.search", "gmail.read", "calendar.read"])),
});
export type RoutineValues = v.InferOutput<typeof RoutineFormSchema>;
export const valuesForRoutine = (row?: RoutineRow): RoutineValues => ({
  name: row?.name ?? "",
  prompt: row?.prompt ?? "",
  schedule: row
    ? decomposeSchedule(row.schedule, row.runAt)
    : decomposeSchedule("0 9 * * 1-5", null),
  workspaceId: row?.workspaceId ?? null,
  webhook: row?.webhookToken != null,
  testRun: true,
  sources: (row?.hosted?.sources ?? row?.reach?.sources ?? []).join("\n"),
  reads: [...(row?.hosted?.reads ?? row?.reach?.reads ?? [])],
});

/** The form's reach as the routine carries it. */
export const reachOf = (
  value: Pick<RoutineValues, "sources" | "reads">
): {
  sources: string[];
  reads: Array<"gmail.search" | "gmail.read" | "calendar.read">;
} => ({
  sources: value.sources
    .split(/\s+/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0),
  reads: [...new Set(value.reads)],
});
/** `at`'s wall clock in `zone`, as a local Date (a cron reads wall time). */
export const wallTimeIn = (at: Date, zone: string): Date => {
  const parts: Record<string, number> = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    })
      .formatToParts(at)
      .map((part) => [part.type, Number(part.value)])
  );
  const part = (type: string) => parts[type] ?? 0;
  return new Date(
    part("year"),
    part("month") - 1,
    part("day"),
    part("hour"),
    part("minute"),
    part("second")
  );
};

/**
 * The next fire, for the form. A cron in another zone (a hosted routine's)
 * is read from that zone's wall clock, so the preview is its wall time there.
 */
export const nextPreview = (
  draft: ScheduleDraft,
  now: Date,
  zone: string | null = null
): Date | null => {
  const x = composeSchedule(draft);
  try {
    return x.runAt != null
      ? new Date(x.runAt)
      : x.schedule
        ? nextRun(x.schedule, zone != null ? wallTimeIn(now, zone) : now)
        : null;
  } catch {
    return null;
  }
};

/** A typed source as a URL prefix's text, the way main keeps it; null when it is none. */
const sourceHref = (line: string): string | null => {
  try {
    const url = new URL(
      /^[a-z][a-z0-9+.-]*:/i.test(line) ? line : `https://${line}/`
    );
    url.search = "";
    url.hash = "";
    return url.href;
  } catch {
    return null;
  }
};

/** The typed sources a local routine did not keep (main drops what it cannot read). */
export const droppedSources = (
  typed: readonly string[],
  kept: readonly string[]
): string[] =>
  typed.filter((line) => {
    const href = sourceHref(line);
    return href == null || !kept.includes(href);
  });
export const dirtyPatch = (value: RoutineValues, baseline: RoutineValues) => {
  const patch: Partial<RoutineRow> = {};
  for (const key of ["name", "prompt", "workspaceId"] as const)
    if (value[key] !== baseline[key])
      Object.assign(patch, { [key]: value[key] });
  if (value.webhook !== baseline.webhook)
    patch.webhookToken = value.webhook ? "pending" : null;
  if (JSON.stringify(reachOf(value)) !== JSON.stringify(reachOf(baseline)))
    patch.reach = reachOf(value);
  const schedule = composeSchedule(value.schedule);
  if (
    JSON.stringify(schedule) !==
    JSON.stringify(composeSchedule(baseline.schedule))
  )
    Object.assign(patch, schedule);
  return patch;
};
