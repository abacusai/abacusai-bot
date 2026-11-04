import type { RoutineRow } from "@abacus-ai/contract/contract/rows";
import {
  ROUTINE_QUIET_RUNS_BEFORE_PAUSE,
  routinePauseReason,
  type RoutineRead,
} from "@abacus-ai/contract/routines";
import { useTranslation } from "react-i18next";

import { usePrefs } from "#renderer/data/db/prefs";
import { requestUpgradeDialog } from "#renderer/lib/upgrade-dialog";
import { useAppContext } from "#renderer/lib/use-app-context";
import { Button } from "#renderer/ui/button";
import { Checkbox } from "#renderer/ui/checkbox";

import { isHosted } from "./hosted";
import { showSaveFailure } from "./hosted-sync";

const READS: readonly RoutineRead[] = [
  "gmail.search",
  "gmail.read",
  "calendar.read",
];

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
 * A routine on this computer that keeps its schedule but skips its runs while
 * the account is out of credits, with the way on: the upgrade dialog.
 */
export const RoutineCreditHoldNote = ({ row }: { row: RoutineRow }) => {
  const { t } = useTranslation();
  const hold = usePrefs().routineCreditHold;
  if (hold == null || !row.enabled) return null;
  return (
    <div className="flex items-center justify-between gap-3 text-xs">
      <p className="text-muted-foreground">{t("routines.creditHold.note")}</p>
      <Button
        size="sm"
        variant="outline"
        className="shrink-0"
        onClick={() =>
          requestUpgradeDialog(
            {
              kind: "credits",
              key: `routine-credits:${hold.at}:${Date.now()}`,
              threadId: row.id,
            },
            true
          )
        }
      >
        {t("routines.creditHold.cta")}
      </Button>
    </div>
  );
};

/**
 * What a hosted routine's runs may reach, and the user's way to change what
 * they read of the account. A routine on this computer always runs with full
 * access, so it has nothing to show here.
 */
export const RoutineReachPanel = ({ row }: { row: RoutineRow }) => {
  const { t } = useTranslation();
  const { db, transport } = useAppContext();
  if (!isHosted(row) || row.hosted == null) return null;
  const reach = row.hosted;
  const watchUrl = reach.watchUrl ?? null;
  const setRead = (read: RoutineRead, allowed: boolean) => {
    const reads = READS.filter((item) =>
      item === read ? allowed : reach.reads.includes(item)
    );
    void db.collections.routines
      .update(row.id, (draft) => {
        draft.reach = { sources: reach.sources, reads };
      })
      .isPersisted.promise.catch((error: unknown) =>
        showSaveFailure(error, transport, t)
      );
  };
  return (
    <section className="flex flex-col gap-2 text-[13px]">
      <p className="text-muted-foreground">{t("routines.reach.reads")}</p>
      {READS.map((read) => (
        <label key={read} className="flex items-center gap-2">
          <Checkbox
            checked={reach.reads.includes(read)}
            onCheckedChange={(checked) => setRead(read, checked === true)}
          />
          {t(readKey(read))}
        </label>
      ))}
      {reach.sources.length > 0 && (
        <p className="min-w-0 break-all">{reach.sources.join(", ")}</p>
      )}
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
