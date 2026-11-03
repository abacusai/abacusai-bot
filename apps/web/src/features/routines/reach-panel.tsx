import type { RoutineRow } from "@abacus-ai/contract/contract/rows";
import {
  ROUTINE_QUIET_RUNS_BEFORE_PAUSE,
  routinePauseReason,
} from "@abacus-ai/contract/routines";
import { useTranslation } from "react-i18next";

import { isHosted } from "./hosted";

/** A connector read, in words. */
export const readKey = (read: string): string =>
  read === "gmail.search"
    ? "routines.reach.gmailSearch"
    : read === "gmail.read"
      ? "routines.reach.gmailRead"
      : "routines.reach.calendarRead";

/** A paused routine's reason, in words, by the server's code or main's (`routinePauseReason`). */
export const pausedReasonKey = (reason: string): string => {
  switch (reason) {
    case "payment_required":
    case "credits":
      return "routines.paused.credits";
    case "quiet":
      return "routines.paused.quiet";
    case "plan_limit":
    case "limit":
      return "routines.paused.planLimit";
    case "no_host":
      return "routines.paused.noHost";
    case "approval_denied":
      return "routines.paused.denied";
    case "user_inactive":
    case "suspended":
      return "routines.paused.account";
    case "failures":
    case "failed":
    case "execution_error":
    case "timeout":
      return "routines.paused.failures";
    default:
      return "routines.paused.other";
  }
};

/**
 * Why a paused routine is paused, when it paused itself: the server's code
 * for a hosted one, main's newest history note for one on this computer.
 */
export const RoutinePausedReason = ({ row }: { row: RoutineRow }) => {
  const { t } = useTranslation();
  if (row.enabled) return null;
  const code = isHosted(row)
    ? (row.hosted?.pausedReason ?? null)
    : routinePauseReason(row.recentRuns);
  if (code == null) return null;
  return (
    <p className="text-muted-foreground text-xs">
      {t(pausedReasonKey(code), { runs: ROUTINE_QUIET_RUNS_BEFORE_PAUSE })}
    </p>
  );
};

/**
 * What a hosted routine's runs may reach. A routine on this computer always
 * runs with full access, so it has nothing to show here.
 */
export const RoutineReachPanel = ({ row }: { row: RoutineRow }) => {
  const { t } = useTranslation();
  if (!isHosted(row) || row.hosted == null) return null;
  const reach = row.hosted;
  const watchUrl = reach.watchUrl ?? null;
  const items = [
    ...reach.reads.map((read) => t(readKey(read))),
    ...reach.sources,
  ];
  return (
    <section className="flex flex-col gap-2 text-[13px]">
      <p>
        <span className="text-muted-foreground">
          {t("routines.reach.reads")}{" "}
        </span>
        {items.length > 0 ? items.join(", ") : t("routines.reach.searchOnly")}
      </p>
      {watchUrl != null && (
        <p className="min-w-0 break-all">
          <span className="text-muted-foreground">
            {t("routines.reach.watches")}{" "}
          </span>
          {watchUrl}
        </p>
      )}
      <RoutinePausedReason row={row} />
    </section>
  );
};
