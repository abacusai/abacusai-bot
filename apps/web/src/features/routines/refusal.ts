import { isRpcError } from "#renderer/data/query-client";

/** A refused routine save, in words: its i18n key, and an upgrade when the free plan is why. */
export interface RoutineRefusalText {
  key: string;
  /** The free plan's limit: an upgrade is on offer, at the server's link when it sent one. */
  upgrade: boolean;
  upgradeUrl: string | null;
  /** The form field it belongs to, when it is one value. */
  field: string | null;
}

/** The free plan's limits, by cause. */
const PLAN_KEYS: Record<string, string> = {
  "plan-required": "routines.hosted.planRequired",
  "plan-interval": "routines.refused.planInterval",
  "plan-kind": "routines.refused.planKind",
};

const REASON_KEYS: Record<string, string> = {
  "routine-limit": "routines.hosted.atLimit",
  "no-host": "routines.refused.noHost",
  "routine-not-active": "routines.refused.notActive",
  "routine-busy": "routines.refused.busy",
  "queue-full": "routines.refused.queueFull",
  "wrong-bot": "routines.refused.wrongBot",
  "routines-off": "routines.refused.off",
};

const VALUE_KEYS: Record<string, string> = {
  schedule: "routines.refused.schedule",
  interval: "routines.refused.interval",
  timezone: "routines.refused.timezone",
  sources: "routines.refused.sources",
  reads: "routines.refused.reads",
  text: "routines.refused.text",
  other: "routines.refused.other",
};

/**
 * Why the server would not create, change or resume a hosted routine, as
 * the app words it; null for any other failure.
 */
export const routineRefusal = (error: unknown): RoutineRefusalText | null => {
  if (!isRpcError(error)) return null;
  if (error.code === "PRECONDITION_FAILED") {
    const data = error.data as { reason?: string; detail?: unknown };
    const reason = data?.reason ?? "";
    const plan = PLAN_KEYS[reason];
    if (plan != null)
      return {
        key: plan,
        upgrade: true,
        upgradeUrl:
          typeof data.detail === "string" && data.detail.startsWith("https://")
            ? data.detail
            : null,
        field: null,
      };
    const key = REASON_KEYS[reason];
    return key != null
      ? { key, upgrade: false, upgradeUrl: null, field: null }
      : null;
  }
  if (error.code === "BAD_REQUEST") {
    const data = error.data as { refusal?: string; field?: string };
    const key = VALUE_KEYS[data?.refusal ?? ""];
    return key != null
      ? { key, upgrade: false, upgradeUrl: null, field: data.field ?? null }
      : null;
  }
  return null;
};
