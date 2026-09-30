import { eq } from "@tanstack/db";
/**
 * Bots pages, phase 1: empty states (canvas `BotsEmpty`/`BotNew`), the
 * masked details sheet, and the title-bar identity (dot + name).
 */
import { useLiveQuery } from "@tanstack/react-db";
import type { CSSProperties } from "react";
import { useTranslation } from "react-i18next";

import { EmptyState } from "#next/components/empty-state";
import { RouteSheet } from "#next/components/route-sheet";
import { useCollections } from "#next/data/db";
import { botAccentStyle } from "#next/lib/theme";

const useBot = (botId: string) => {
  const collections = useCollections();
  const { data } = useLiveQuery({
    query: (q) =>
      q
        .from({ b: collections.bots })
        .where(({ b }) => eq(b.id, botId))
        .findOne(),
  });
  return data;
};

export const BotsNewPage = () => {
  const { t } = useTranslation();
  return (
    <EmptyState
      icon="bots"
      title={t("bots.page.newTitle")}
      description={t("bots.page.newDescription")}
    />
  );
};

export const BotPage = ({ botId }: { botId: string }) => {
  const { t } = useTranslation();
  const bot = useBot(botId);
  return (
    <div
      className="flex size-full items-center justify-center"
      style={
        bot == null
          ? undefined
          : (botAccentStyle(bot.avatarColor) as CSSProperties)
      }
    >
      <EmptyState
        icon="bots"
        title={t("bots.page.chatTitle")}
        description={t("bots.page.chatDescription")}
      />
    </div>
  );
};

export const BotEditPage = () => {
  const { t } = useTranslation();
  return (
    <EmptyState
      icon="bots"
      title={t("bots.page.editTitle")}
      description={t("bots.page.editDescription")}
    />
  );
};

export const BotDetailsSheet = ({ botId }: { botId: string }) => {
  const { t } = useTranslation();
  const bot = useBot(botId);
  return (
    <RouteSheet
      title={bot?.name ?? t("bots.page.detailsTitle")}
      description={t("bots.page.detailsDescription")}
      fallbackHref={`/bots/${encodeURIComponent(botId)}`}
    />
  );
};

export const BotIdentity = ({ botId }: { botId: string }) => {
  const bot = useBot(botId);
  if (bot == null) return null;
  return (
    <span className="flex min-w-0 items-center gap-2">
      <span
        aria-hidden
        className="size-2.5 rounded-full"
        style={{ background: bot.avatarColor }}
      />
      <span className="text-sidebar-foreground truncate font-medium">
        {bot.name}
      </span>
    </span>
  );
};
