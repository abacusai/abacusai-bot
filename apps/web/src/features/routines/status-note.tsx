import type { RoutineRow } from "@abacus-ai/contract/contract/rows";
import { useTranslation } from "react-i18next";

import {
  isReason,
  StatusDot,
  statusLine,
  useStatusItem,
} from "#renderer/components/status-board";
import { useAppNavigate } from "#renderer/lib/navigation/use-app-navigate";
import { useAppContext } from "#renderer/lib/use-app-context";
import { Button } from "#renderer/ui/button";

import { MissedRunsNote } from "./always-on";
import { showSaveFailure } from "./hosted-sync";
import { RoutineCreditHoldNote } from "./reach-panel";

/**
 * Why a routine on this computer is not running, as the status board says,
 * with the one action that brings it back: Resume an app pause, Connect a
 * lost chat app, credits for the wall, the always-on offer for missed runs.
 */
export const RoutineStatusNote = ({ row }: { row: RoutineRow }) => {
  const { t } = useTranslation();
  const { db, transport } = useAppContext();
  const navigate = useAppNavigate();
  const item = useStatusItem(`routine:${row.id}`);
  if (item == null) return null;
  // A paused-by-app "credits" is the budget pause (its runs kept stopping at
  // their credit budget): Resume, like any app pause. The wall is credits-out.
  if (
    isReason(item, "credits-out") ||
    (isReason(item, "credits") && item.state !== "paused-by-app")
  )
    return <RoutineCreditHoldNote row={row} />;
  if (item.state === "missed")
    return (
      <MissedRunsNote
        missed={{ count: item.detail.count ?? 1, at: item.since }}
      />
    );
  const action =
    item.state === "paused-by-app" && !row.enabled
      ? {
          label: t("phase5.resume"),
          run: () =>
            void db.collections.routines
              .update(row.id, (draft) => {
                draft.enabled = true;
              })
              .isPersisted.promise.catch((error: unknown) =>
                showSaveFailure(error, transport, t)
              ),
        }
      : (isReason(item, "link-lost") || isReason(item, "lane-off")) &&
          item.detail.platform != null
        ? {
            label: t("phase5.connect"),
            run: () =>
              void navigate({
                to: "/library/messaging",
                search: { platform: item.detail.platform as never },
              }),
          }
        : isReason(item, "needs-account") && item.detail.accountId != null
          ? {
              label: t("phase5.connect"),
              run: () =>
                void navigate({
                  to: "/library/connectors",
                  search: { connector: item.detail.accountId as never },
                }),
            }
          : null;
  // An app pause's reason is the history line above (RoutinePausedReason); here its way back.
  if (item.state === "paused-by-app" && action != null && !row.enabled)
    return (
      <div
        className="flex items-center gap-2"
        data-slot="routine-status"
        data-state={item.state}
      >
        <StatusDot item={item} />
        <Button size="sm" variant="outline" onClick={action.run}>
          {action.label}
        </Button>
      </div>
    );
  return (
    <div
      className="flex items-center justify-between gap-3 text-xs"
      data-slot="routine-status"
      data-state={item.state}
    >
      <p className="text-muted-foreground flex items-start gap-2">
        <StatusDot item={item} className="mt-1" />
        {statusLine(item, t)}
      </p>
      {action != null && (
        <Button
          size="sm"
          variant="outline"
          className="shrink-0"
          onClick={action.run}
        >
          {action.label}
        </Button>
      )}
    </div>
  );
};
