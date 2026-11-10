import { messagingPlatformSpec } from "@abacus-ai/contract/messaging";
import { ROUTINE_QUIET_RUNS_BEFORE_PAUSE } from "@abacus-ai/contract/routines";
/**
 * The status board's in-app side: one query (`status.list`) kept fresh by
 * one stream (`status.events`), read by every surface that says whether
 * something is running: the routine rail and row dot, the bot row dot, the
 * Messaging lane row, and the banner for what waits on the user.
 */
import type { StatusItem, StatusKey } from "@abacus-ai/contract/status";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { TFunction } from "i18next";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { followNotice } from "#renderer/data/queries/notices";
import { cn } from "#renderer/lib/cn";
import { useAppNavigate } from "#renderer/lib/navigation/use-app-navigate";
import { IS_ELECTRON } from "#renderer/lib/platform";
import { useAppContext } from "#renderer/lib/use-app-context";
import { Button } from "#renderer/ui/button";

const NONE: StatusItem[] = [];

/** A typed discriminant of the board's vocabulary, not error copy. */
export const isReason = (item: StatusItem, reason: StatusItem["reason"]) =>
  item.reason === reason;

/** Everything not running, as the board lists it; empty off the desktop. */
export const useStatusItems = (): StatusItem[] => {
  const { transport } = useAppContext();
  const cache = useQueryClient();
  const options = transport.orpc.status.list.queryOptions({ input: {} });
  const query = useQuery({ ...options, enabled: IS_ELECTRON });
  useEffect(() => {
    if (!IS_ELECTRON) return;
    const abort = new AbortController();
    followNotice(
      "status",
      transport,
      () => void cache.invalidateQueries({ queryKey: options.queryKey }),
      abort.signal
    );
    return () => abort.abort();
  }, [transport, cache, options.queryKey]);
  return query.data ?? NONE;
};

export const useStatusItem = (key: StatusKey): StatusItem | null =>
  useStatusItems().find((item) => item.key === key) ?? null;

const platformName = (platform: string, t: TFunction): string =>
  t(
    `messaging.platforms.${messagingPlatformSpec(platform as never)?.nameKey ?? platform}`
  );

/** The in-app line for an item, worded as its notice is. */
export const statusLine = (item: StatusItem, t: TFunction): string => {
  const lane = item.key.startsWith("lane:");
  const name = lane
    ? platformName(item.key.slice(5), t)
    : (item.detail.name ?? t("status.aRoutine"));
  const platform =
    item.detail.platform != null
      ? platformName(item.detail.platform, t)
      : t("status.yourChatApp");
  if (item.state === "missed")
    return t("routines.alwaysOn.missed", { count: item.detail.count ?? 1 });
  switch (item.reason) {
    case "network":
      return t("status.row.waitingNetwork");
    case "quiet":
      return t("routines.paused.quiet", {
        runs: ROUTINE_QUIET_RUNS_BEFORE_PAUSE,
      });
    case "failing":
      return t("routines.paused.failures");
    case "credits":
    case "credits-out":
      return t("routines.creditHold.note");
    case "signed-out":
      return t("status.body.signedOut");
    case "needs-account":
      return t("status.body.routineNeedsAccount", {
        account: item.detail.account ?? "",
      });
    case "link-lost":
    case "needs-login":
      return lane
        ? t("native.linkLostLane", { platform: name })
        : t("status.body.routineLinkLost", { platform });
    case "login-not-finished":
      return t("status.body.loginNotFinished", { platform: name });
    case "lane-off":
      return t("status.body.routineLaneOff", { platform });
    case "gave-up":
      return t("messaging.recovery.stopped", { platform: name });
    case "needs-user":
      return t("native.laneBlockedBody", { platform: name });
    case "retrying":
      return t("native.laneDownBody", { platform: name });
    default:
      return t("phase5.outcomes.interrupted");
  }
};

const TONE: Record<StatusItem["state"], string> = {
  waiting: "bg-amber-500",
  "paused-by-app": "bg-amber-500",
  "stopped-needs-user": "bg-destructive",
  missed: "bg-amber-500",
  stopped: "bg-muted-foreground",
};

/** The dot on a row whose thing is not running; its words are the title. */
export const StatusDot = ({
  item,
  className,
}: {
  item: StatusItem | null | undefined;
  className?: string;
}) => {
  const { t } = useTranslation();
  if (item == null) return null;
  const line = statusLine(item, t);
  return (
    <span
      role="img"
      aria-label={line}
      title={line}
      data-slot="status-dot"
      data-state={item.state}
      className={cn(
        "size-2 shrink-0 rounded-full",
        TONE[item.state],
        className
      )}
    />
  );
};

/** A chat-app lane's one action: Connect, or Try now once retrying stopped. */
const useLaneAction = (item: StatusItem) => {
  const { t } = useTranslation();
  const { transport } = useAppContext();
  const navigate = useAppNavigate();
  const platform = item.key.slice(5);
  if (isReason(item, "gave-up") || isReason(item, "needs-user"))
    return {
      label: t("messaging.recovery.tryNow"),
      run: () =>
        void transport.client.messaging
          .retryNow({ platformId: platform as never })
          .catch(() => undefined),
    };
  return {
    label: t("phase5.connect"),
    run: () =>
      void navigate({
        to: "/library/messaging",
        search: { platform: platform as never },
      }),
  };
};

/**
 * What waits on the user (a lane that lost or never finished its login, or
 * retrying stopped), on every page until it is fixed or closed for now.
 */
export const StatusBanner = ({
  suppressed = false,
}: {
  suppressed?: boolean;
}) => {
  const { t } = useTranslation();
  const items = useStatusItems();
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set());
  const item = items.find(
    (entry) =>
      entry.state === "stopped-needs-user" &&
      entry.key.startsWith("lane:") &&
      !closed.has(`${entry.key}@${entry.since}`)
  );
  if (!IS_ELECTRON || suppressed || item == null) return null;
  const name = platformName(item.key.slice(5), t);
  return (
    <aside
      role="status"
      data-slot="status-banner"
      className="bg-background fixed right-4 bottom-4 z-40 flex max-w-md items-start gap-3 rounded-xl border p-3 text-sm shadow-sm"
    >
      <StatusDot item={item} className="mt-1.5" />
      <div className="flex min-w-0 flex-col gap-1">
        <p className="font-medium">
          {isReason(item, "link-lost")
            ? t("native.linkLostTitle", { platform: name })
            : isReason(item, "login-not-finished")
              ? t("status.title.laneStopped", { name })
              : t("native.laneDownTitle", { platform: name })}
        </p>
        <p className="text-muted-foreground text-xs">{statusLine(item, t)}</p>
        <div className="mt-1 flex gap-2">
          <BannerAction item={item} />
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              setClosed(new Set([...closed, `${item.key}@${item.since}`]))
            }
          >
            {t("common.close")}
          </Button>
        </div>
      </div>
    </aside>
  );
};

const BannerAction = ({ item }: { item: StatusItem }) => {
  const action = useLaneAction(item);
  return (
    <Button size="sm" onClick={action.run}>
      {action.label}
    </Button>
  );
};
