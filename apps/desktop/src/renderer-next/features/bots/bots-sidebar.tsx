/**
 * The Bots sidebar (spec 01 §7.3, canvas `BotsSidebar`): live from the `bots`
 * collection, pinned bots first, then by last update. A colour dot stands in
 * for BotAvatar until phase 3.
 */
import { useLiveQuery } from "@tanstack/react-db";
import { useParams } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { useTranslation } from "react-i18next";

import { NavList } from "#next/components/nav-list";
import { useCollections } from "#next/data/db";
import { usePrefs } from "#next/data/db/prefs";
import { useCollectionStatus } from "#next/data/db/status";
import { formatWhen } from "#next/lib/format-time";
import { AppLink } from "#next/lib/navigation/app-link";
import { useNow } from "#next/lib/use-now";
import type { BotRow } from "#shared/contract";

/** Pinned (in pin order) first, then newest first. */
export const orderBots = (
  bots: readonly BotRow[],
  pinnedIds: readonly string[]
): BotRow[] => {
  const pinned = pinnedIds
    .map((id) => bots.find((bot) => bot.id === id))
    .filter((bot): bot is BotRow => bot != null);
  const rest = bots
    .filter((bot) => !pinnedIds.includes(bot.id))
    .toSorted((a, b) => b.updatedAt - a.updatedAt);
  return [...pinned, ...rest];
};

export const BotDot = ({
  color,
  size = 10,
}: {
  color: string;
  size?: number;
}) => (
  <span
    aria-hidden="true"
    className="inline-block shrink-0 rounded-full"
    style={{ background: color, width: size, height: size }}
  />
);

const useBots = () => {
  const collections = useCollections();
  const prefs = usePrefs();
  const { data } = useLiveQuery({
    query: (q) =>
      q.from({ b: collections.bots }).orderBy(({ b }) => b.updatedAt, "desc"),
  });
  const status = useCollectionStatus(collections.bots);
  return {
    bots: orderBots(data ?? [], prefs.pinned.botIds),
    status,
    retry: () => void collections.bots.utils.resync(),
  };
};

export const BotsSidebar = () => {
  const { t, i18n } = useTranslation();
  const { bots, status, retry } = useBots();
  const params = useParams({ strict: false }) as { botId?: string };
  const now = useNow();

  return (
    <NavList.Root label={t("bots.sidebar.label")}>
      <NavList.Header title={t("bots.sidebar.label")}>
        <NavList.Action
          label={t("bots.sidebar.new")}
          render={<AppLink to="/bots/new" transition="nav-lateral" />}
        >
          <Plus />
        </NavList.Action>
      </NavList.Header>
      {status === "error" ? (
        <NavList.Error
          message={t("shell.sidebar.loadError")}
          retryLabel={t("shell.sidebar.retry")}
          onRetry={retry}
        />
      ) : status !== "ready" ? (
        <NavList.Skeleton />
      ) : bots.length === 0 ? (
        <p className="text-muted-foreground px-2 pt-2 text-xs">
          {t("bots.sidebar.empty")}
        </p>
      ) : (
        <NavList.Rows>
          {bots.map((bot) => (
            <NavList.Item
              key={bot.id}
              to="/bots/$botId"
              params={{ botId: bot.id }}
              active={params.botId === bot.id}
              media={<BotDot color={bot.avatarColor} />}
              title={bot.name}
              meta={formatWhen(bot.updatedAt, now, i18n.language)}
              hint={bot.title || undefined}
            />
          ))}
        </NavList.Rows>
      )}
    </NavList.Root>
  );
};

/** At 800 px (canvas `BW800`): 56×56 tiles, the name on hover. */
export const BotsStrip = () => {
  const { t } = useTranslation();
  const { bots, status } = useBots();
  const params = useParams({ strict: false }) as { botId?: string };

  return (
    <nav
      aria-label={t("bots.sidebar.label")}
      data-slot="bots-strip"
      className="flex flex-col items-center gap-2 px-4 pt-2"
    >
      <AppLink
        to="/bots/new"
        transition="nav-lateral"
        aria-label={t("bots.sidebar.new")}
        title={t("bots.sidebar.new")}
        className="text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-foreground flex size-14 items-center justify-center rounded-xl"
      >
        <Plus className="size-4" />
      </AppLink>
      {status === "ready" &&
        bots.map((bot) => (
          <AppLink
            key={bot.id}
            to="/bots/$botId"
            params={{ botId: bot.id }}
            transition="nav-lateral"
            title={bot.name}
            aria-label={bot.name}
            aria-current={params.botId === bot.id ? "page" : undefined}
            className="hover:bg-sidebar-accent/60 aria-[current=page]:bg-sidebar-accent flex size-14 items-center justify-center rounded-xl"
          >
            <BotDot color={bot.avatarColor} size={28} />
          </AppLink>
        ))}
    </nav>
  );
};
