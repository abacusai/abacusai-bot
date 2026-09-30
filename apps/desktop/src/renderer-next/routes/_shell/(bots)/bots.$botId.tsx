import { eq } from "@tanstack/db";
import { useLiveQuery } from "@tanstack/react-db";
import { createFileRoute, notFound, Outlet } from "@tanstack/react-router";
import { useMemo, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import * as v from "valibot";

import { useCollections } from "#next/data/db";
import { BotIdentity, BotPage } from "#next/features/bots";
import { ChatView, loadFixtureRuntime } from "#next/features/chat";
import { TopBarSlot, useTopBarActions } from "#next/features/shell";
import { ignoreLoadError, isMissing } from "#next/lib/navigation/loaders";
import { BotSearch } from "#next/lib/navigation/search";
import { useAppNavigate } from "#next/lib/navigation/use-app-navigate";
import { botAccentStyle } from "#next/lib/theme";
import { AgentMode } from "#shared/agent-types";
import { BotId } from "#shared/contract/ids";

/**
 * The dev fixture build (`VITE_NEXT_DB_FIXTURES=1`, gallery and visual
 * screenshots only): a bot with no forever session yet shows a recorded
 * agent golden replayed through the real chat runtime.
 */
type Fixture = ReturnType<
  Awaited<ReturnType<typeof loadFixtureRuntime>>
> | null;
let fixture: Fixture = null;
const fixtureReady: Promise<void> | null =
  import.meta.env.VITE_NEXT_DB_FIXTURES === "1"
    ? loadFixtureRuntime().then((fixtureRuntime) => {
        fixture = fixtureRuntime("bot-golden-plain", {}, "fixture-bot");
      })
    : null;

const useBotRow = (botId: string) => {
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

const BotChat = ({ botId }: { botId: string }) => {
  const { t } = useTranslation();
  const { chat } = Route.useRouteContext();
  const bot = useBotRow(botId);
  const readOnlyReason =
    bot?.channel != null ? t("chat.composer.channelBot") : null;
  const composer = useMemo(
    () => ({
      mode: "full" as const,
      placeholder: t("chat.composer.botPlaceholder", { name: bot?.name }),
      attachmentsBase: null,
      showModeChip: false,
      model: null,
      fixedMode: AgentMode.Yolo,
      ...(readOnlyReason != null
        ? { readOnly: { reason: readOnlyReason } }
        : {}),
    }),
    [t, bot?.name, readOnlyReason]
  );
  const threadId =
    bot?.sessionId ?? (fixture != null ? fixture.threadId : null);
  if (bot == null || threadId == null) return <BotPage botId={botId} />;
  const runtime =
    bot.sessionId == null && fixture != null ? fixture.runtime : chat;
  return (
    <div
      className="size-full"
      style={botAccentStyle(bot.avatarColor) as CSSProperties}
    >
      <ChatView
        threadId={threadId}
        skin="bot"
        runtime={runtime}
        workspaceRoot={null}
        composer={composer}
      />
    </div>
  );
};

const BotRoute = () => {
  const { t } = useTranslation();
  const { botId } = Route.useParams();
  const navigate = useAppNavigate();
  useTopBarActions([
    {
      id: "details",
      label: t("bots.page.detailsTitle"),
      onSelect: () =>
        void navigate({
          to: "/bots/$botId/details",
          params: { botId },
          transition: "none",
        }),
    },
  ]);
  return (
    <>
      <TopBarSlot>
        <BotIdentity botId={botId} />
      </TopBarSlot>
      <BotChat botId={botId} />
      <Outlet />
    </>
  );
};

export const Route = createFileRoute("/_shell/(bots)/bots/$botId")({
  params: { parse: v.parser(v.object({ botId: BotId })) },
  validateSearch: BotSearch,
  loader: async ({ context, params, preload }) => {
    if (fixtureReady != null) await fixtureReady;
    const { bots } = context.db.collections;
    await bots.preload().catch(ignoreLoadError);
    // Only a loaded table can say the bot is gone; a failed load is the
    // sidebar's to show, with its Retry.
    if (isMissing(bots, params.botId)) throw notFound();
    // The chat commits with its transcript present (spec 02 §3.2); a hover
    // preload never starts a thread's streams.
    const sessionId = bots.get(params.botId)?.sessionId;
    if (preload || sessionId == null) return;
    await context.chat.session(sessionId).load().catch(ignoreLoadError);
  },
  component: BotRoute,
});
