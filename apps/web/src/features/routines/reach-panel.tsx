import type { RoutineRow } from "@abacus-ai/contract/contract/rows";
import { useTranslation } from "react-i18next";

import { ConfirmAction } from "#renderer/components/form-kit/confirm";
import { showError } from "#renderer/lib/toast";
import { useAppContext } from "#renderer/lib/use-app-context";
import { Item } from "#renderer/ui/item";
import { Switch } from "#renderer/ui/switch";

import { isHosted } from "./hosted";

/** A connector read, in words. */
export const readKey = (read: string): string =>
  read === "gmail.search"
    ? "routines.reach.gmailSearch"
    : read === "gmail.read"
      ? "routines.reach.gmailRead"
      : "routines.reach.calendarRead";

/** A paused routine's reason, in words, by the server's code. */
export const pausedReasonKey = (reason: string): string => {
  switch (reason) {
    case "payment_required":
      return "routines.paused.credits";
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
 * What a routine's runs may reach, and a local one's full access: the user's
 * own click; the agent cannot make it.
 */
export const RoutineReachPanel = ({ row }: { row: RoutineRow }) => {
  const { t } = useTranslation();
  const { db } = useAppContext();
  // A local routine's reach is what main kept of what was asked.
  const reach = row.hosted ?? row.reach ?? { sources: [], reads: [] };
  const watchUrl = row.hosted?.watchUrl ?? null;
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
      {row.hosted?.pausedReason != null && !row.enabled && (
        <p className="text-muted-foreground text-xs">
          {t(pausedReasonKey(row.hosted.pausedReason))}
        </p>
      )}
      {!isHosted(row) && (
        <Item size="sm" className="rounded-(--pane-radius)">
          {row.access === "full" ? (
            <Switch
              aria-label={t("routines.reach.fullAccess")}
              checked
              onCheckedChange={() =>
                void db.collections.routines
                  .update(row.id, (d) => {
                    d.access = "unattended";
                  })
                  .isPersisted.promise.catch(() =>
                    showError(t("phase5.failed"))
                  )
              }
            />
          ) : (
            <ConfirmAction
              title={t("routines.reach.fullAccessTitle")}
              description={t("routines.reach.fullAccessDescription")}
              label={t("routines.reach.fullAccessConfirm")}
              onConfirm={async () => {
                await db.collections.routines.update(row.id, (d) => {
                  d.access = "full";
                }).isPersisted.promise;
              }}
            />
          )}
          <span className="min-w-0 flex-1">
            {t(
              row.access === "full"
                ? "routines.reach.fullAccessOn"
                : "routines.reach.unattended"
            )}
          </span>
        </Item>
      )}
    </section>
  );
};
