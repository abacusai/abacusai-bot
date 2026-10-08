import type { RoutineRow } from "@abacus-ai/contract/contract/rows";
import { useTranslation } from "react-i18next";

import { ConfirmAction } from "#renderer/components/form-kit/confirm";
import { showError, showInfo } from "#renderer/lib/toast";
import { useAppContext } from "#renderer/lib/use-app-context";
import { Button } from "#renderer/ui/button";
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
 * What a routine's runs may reach, and what waits on the user: a hosted
 * routine's approval (at the server's one-time link), the reach the agent
 * asked a local one for, and a local one's full access. Each is the user's
 * own click; the agent cannot make it.
 */
export const RoutineReachPanel = ({ row }: { row: RoutineRow }) => {
  const { t } = useTranslation();
  const { db, transport } = useAppContext();
  // A local routine's reach is what main kept of what was asked.
  const reach = row.hosted ?? row.reach ?? { sources: [], reads: [] };
  const watchUrl = row.hosted?.watchUrl ?? null;
  const items = [
    ...reach.reads.map((read) => t(readKey(read))),
    ...reach.sources,
  ];
  const decide = (allow: boolean) =>
    transport.client.db.routines
      .update({ id: row.id, patch: { confirmPendingReach: allow } })
      .catch(() => showError(t("phase5.failed")));
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
      {row.hosted?.pendingConfirmation === true && (
        <Item
          variant="muted"
          role="status"
          className="flex-col items-start rounded-(--pane-radius)"
        >
          <p>{t("routines.reach.awaitingApproval")}</p>
          <Button
            size="sm"
            onClick={() =>
              // The server sends a fresh link to the owner's WhatsApp or email.
              void transport.client.routines
                .approvalLink({ id: row.id })
                .then(({ sent }) =>
                  showInfo(
                    t(
                      sent
                        ? "routines.reach.approvalSent"
                        : "routines.reach.notWaiting"
                    )
                  )
                )
                .catch(() => showError(t("phase5.failed")))
            }
          >
            {t("routines.reach.approve")}
          </Button>
        </Item>
      )}
      {row.pendingReach != null && (
        <Item
          variant="muted"
          role="status"
          className="flex-col items-start rounded-(--pane-radius)"
        >
          <p>
            {t("routines.reach.asked", {
              items: [
                ...row.pendingReach.reads.map((read) => t(readKey(read))),
                ...row.pendingReach.sources,
              ].join(", "),
            })}
          </p>
          <span className="flex flex-wrap gap-2">
            <ConfirmAction
              title={t("routines.reach.allowTitle")}
              description={t("routines.reach.allowDescription")}
              label={t("routines.reach.allow")}
              onConfirm={() => decide(true)}
            />
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void decide(false)}
            >
              {t("routines.reach.decline")}
            </Button>
          </span>
        </Item>
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
