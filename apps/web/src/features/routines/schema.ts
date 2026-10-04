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
});
export const nextPreview = (draft: ScheduleDraft, now: Date): Date | null => {
  const x = composeSchedule(draft);
  try {
    return x.runAt != null
      ? new Date(x.runAt)
      : x.schedule
        ? nextRun(x.schedule, now)
        : null;
  } catch {
    return null;
  }
};
export const dirtyPatch = (value: RoutineValues, baseline: RoutineValues) => {
  const patch: Partial<RoutineRow> = {};
  for (const key of ["name", "prompt", "workspaceId"] as const)
    if (value[key] !== baseline[key])
      Object.assign(patch, { [key]: value[key] });
  if (value.webhook !== baseline.webhook)
    patch.webhookToken = value.webhook ? "pending" : null;
  const schedule = composeSchedule(value.schedule);
  if (
    JSON.stringify(schedule) !==
    JSON.stringify(composeSchedule(baseline.schedule))
  )
    Object.assign(patch, schedule);
  return patch;
};
