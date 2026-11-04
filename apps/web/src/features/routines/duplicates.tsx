/**
 * Routines a user already has twice: flagged in the list and on the routine's
 * page, for the user to settle. Nothing here removes or pauses one by itself.
 */
import type { RoutineRow } from "@abacus-ai/contract/contract/rows";
import { duplicateRoutines } from "@abacus-ai/contract/routines/same-routine";
import { CopyPlus } from "lucide-react";
import { useTranslation } from "react-i18next";

import { usePrefs, useUpdatePrefs } from "#renderer/data/db/prefs";
import { AppLink } from "#renderer/lib/navigation/app-link";
import { showError } from "#renderer/lib/toast";
import { Button } from "#renderer/ui/button";

/** A pair the user said to keep, whichever way round it is read. */
const pairKey = (a: string, b: string): string => [a, b].toSorted().join("|");

/** Each routine with the others it looks like a copy of. */
export const flaggedDuplicates = (
  routines: readonly RoutineRow[],
  kept: readonly string[]
): Map<string, RoutineRow[]> => {
  const facts = routines.map((row) => ({
    ...row,
    webhook: row.webhookToken != null || row.webhookUrl != null,
    timezone: row.hosted?.timezone ?? null,
    watchUrl: row.hosted?.watchUrl ?? null,
  }));
  const flagged = new Map<string, RoutineRow[]>();
  for (const [id, twins] of duplicateRoutines(facts)) {
    const open = twins.filter((twin) => !kept.includes(pairKey(id, twin.id)));
    if (open.length > 0) flagged.set(id, open);
  }
  return flagged;
};

export const useRoutineDuplicates = (
  routines: readonly RoutineRow[]
): Map<string, RoutineRow[]> => {
  return flaggedDuplicates(
    routines,
    usePrefs().dismissals.routineDuplicatesKept
  );
};

/** On a flagged routine's page: what it repeats, and the ways to settle it. */
export const RoutineDuplicateNotice = ({
  row,
  twins,
  onPause,
  onDelete,
}: {
  row: RoutineRow;
  twins: readonly RoutineRow[];
  onPause(): void;
  onDelete(): void;
}) => {
  const { t } = useTranslation();
  const prefs = usePrefs();
  const update = useUpdatePrefs();
  const keepBoth = () =>
    void update({
      dismissals: {
        routineDuplicatesKept: [
          ...prefs.dismissals.routineDuplicatesKept,
          ...twins.map((twin) => pairKey(row.id, twin.id)),
        ],
      },
    }).catch(() => showError(t("phase5.failed")));
  return (
    <section
      aria-label={t("routines.duplicate.badge")}
      data-testid="routine-duplicate-notice"
      className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b bg-(--bots-attention)/10 px-4 py-2.5"
    >
      <CopyPlus
        aria-hidden
        className="size-4 shrink-0 text-(--bots-attention)"
      />
      <div className="min-w-0 flex-1 basis-64 text-[13px]">
        <p className="font-medium">
          {t("routines.duplicate.title")}{" "}
          {twins.map((twin, index) => (
            <span key={twin.id}>
              {index > 0 && ", "}
              <AppLink
                to="/routines/$routineId"
                params={{ routineId: twin.id }}
                className="underline underline-offset-2"
              >
                {twin.name}
              </AppLink>
            </span>
          ))}
        </p>
        <p className="text-muted-foreground text-xs">
          {t("routines.duplicate.description")}
        </p>
      </div>
      <div className="flex flex-wrap gap-1">
        <Button size="sm" variant="secondary" onClick={onPause}>
          {t("routines.duplicate.pause")}
        </Button>
        <Button size="sm" variant="ghost" onClick={onDelete}>
          {t("routines.duplicate.delete")}
        </Button>
        <Button size="sm" variant="ghost" onClick={keepBoth}>
          {t("routines.duplicate.keepBoth")}
        </Button>
      </div>
    </section>
  );
};
