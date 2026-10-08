/**
 * Hosted routines in the panel: which rows run on their own, how a hosted
 * run's status reads, and the results that arrived since the user last
 * looked (the unread badge). Unread lives for the tab's lifetime: a result
 * is also delivered by WhatsApp or email, so nothing is lost when it goes.
 */
import type { RoutineRow } from "@abacus-ai/contract/contract/rows";
import type { HostedRoutineRun } from "@abacus-ai/contract/routines";

export const isHosted = (row: Pick<RoutineRow, "runner">): boolean =>
  row.runner === "hosted";

/** Statuses that mean the run did not do its work. */
const FAILED = new Set([
  "failed",
  "execution_error",
  "timeout",
  "no_host",
  "infra_failure",
  "host_outdated",
  "payment_required",
  "plan_limit",
  "missed",
  "delivery_lost",
  "user_inactive",
]);

export const hostedRunFailed = (run: Pick<HostedRoutineRun, "status">) =>
  FAILED.has(run.status);

/** The i18n key for a hosted run's status; literal keys, one per status. */
export const hostedStatusKey = (
  status: string,
  delivered: boolean | null = null
): string => {
  switch (status) {
    case "done":
      // A `relevant` routine whose condition did not hold sent nothing.
      return delivered === false
        ? "routines.hosted.status.quiet"
        : "routines.hosted.status.done";
    case "deleted":
      return "routines.hosted.status.deleted";
    case "timeout":
      return "routines.hosted.status.timeout";
    case "missed":
      return "routines.hosted.status.missed";
    case "payment_required":
      return "routines.hosted.status.credits";
    case "plan_limit":
      return "routines.hosted.status.planLimit";
    case "queued":
    case "running":
      return "routines.hosted.status.running";
    default:
      return FAILED.has(status)
        ? "routines.hosted.status.failed"
        : "routines.hosted.status.unknown";
  }
};

/** Where a result went, as an i18n key, or null when it was not delivered. */
export const deliveredKey = (via: string | null): string | null =>
  via === "whatsapp"
    ? "routines.hosted.via.whatsapp"
    : via === "email"
      ? "routines.hosted.via.email"
      : via === "panel"
        ? "routines.hosted.via.panel"
        : null;

/** The browser's own time zone, for a hosted routine made here. */
export const browserTimeZone = (): string | null => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
};

type Listener = () => void;

/** New hosted results by routine id, until that routine's page is seen. */
export const createUnreadStore = () => {
  let unread = new Map<string, Set<string>>();
  const listeners = new Set<Listener>();
  const changed = () => {
    unread = new Map(unread);
    for (const listener of listeners) listener();
  };
  return {
    add(routineId: string, runId: string): void {
      const runs = new Set(unread.get(routineId));
      if (runs.has(runId)) return;
      runs.add(runId);
      unread.set(routineId, runs);
      changed();
    },
    read(routineId: string): void {
      if (!unread.has(routineId)) return;
      unread.delete(routineId);
      changed();
    },
    count(routineId?: string): number {
      if (routineId != null) return unread.get(routineId)?.size ?? 0;
      let total = 0;
      for (const runs of unread.values()) total += runs.size;
      return total;
    },
    subscribe(listener: Listener): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    snapshot: () => unread,
  };
};

/** The app's one store. */
export const hostedUnread = createUnreadStore();
