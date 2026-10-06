import { BotId } from "@abacus-ai/contract/contract/ids";
import { createFileRoute, Outlet, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import * as v from "valibot";

import { useBotChatActivity } from "#renderer/features/bots/chat/activity";
import {
  BotIdentity as BotChatIdentity,
  BotTranscriptIdentity,
  BotGone,
  BotPending,
} from "#renderer/features/bots/chat/identity";
import { useBotChatSlots } from "#renderer/features/bots/chat/slots";
import { loadBotChat } from "#renderer/features/bots/data/loaders";
import { forgetOpenChat } from "#renderer/features/bots/data/open-chat";
import { useBot } from "#renderer/features/bots/data/queries";
import {
  DetailsTab,
  MemoryTab,
  FilesTab,
} from "#renderer/features/bots/panel/bot-side-panel";
import { useComposerExpanded } from "#renderer/features/chat/composer/composer";
import { loadFixtureRuntime } from "#renderer/features/chat/fixture-runtime";
import { ChatView } from "#renderer/features/chat/kit/lazy-view";
import { useThreadHost } from "#renderer/features/chat/runtime/host";
import { chatLoading } from "#renderer/features/chat/runtime/lazy-runtime";
import { requestBrowserOpen } from "#renderer/features/shell/browser-open";
import { SidePanelContent } from "#renderer/features/shell/side-panel-slot";
import { TopBarSlot } from "#renderer/features/shell/top-bar-slots";
import { accentVars, resolveLook } from "#renderer/lib/bots/avatar";
import { BotSearch } from "#renderer/lib/navigation/search";
import { useAppNavigate } from "#renderer/lib/navigation/use-app-navigate";
import { Button } from "#renderer/ui/button";

import { BotBrowser, BotBrowserRegistration } from "./-browser";
/**
 * The dev fixture build (`VITE_NEXT_DB_FIXTURES=1`, gallery and visual
 * screenshots only): a bot with no forever session yet shows a recorded
 * agent golden replayed through the real chat runtime.
 */
type Fixture = ReturnType<
  Awaited<ReturnType<typeof loadFixtureRuntime>>
> | null;
const fixtureState: { current: Fixture } = { current: null };
const fixtureReady: Promise<void> | null =
  import.meta.env.VITE_NEXT_DB_FIXTURES === "1"
    ? loadFixtureRuntime().then((fixtureRuntime) => {
        fixtureState.current = fixtureRuntime(
          "bot-golden-plain",
          {},
          "fixture-bot"
        );
      })
    : null;

const ReadyChat = ({
  botId,
  sessionId,
}: {
  botId: string;
  sessionId: string;
}) => {
  const bot = useBot(botId);
  const search = Route.useSearch();
  const navigate = useAppNavigate();
  const expanded = useComposerExpanded(sessionId);
  const [docked, setDocked] = useState(false);
  if (!bot) return <BotGone />;
  return (
    <ComposedChat
      bot={bot}
      sessionId={sessionId}
      expanded={expanded}
      docked={docked}
      onDock={setDocked}
      detailsOpen={search.tab === "details"}
      preview={search.preview}
      toggle={() =>
        void navigate({
          to: "/bots/$botId",
          params: { botId },
          search: (previous) => ({
            ...previous,
            tab: previous.tab === "details" ? undefined : "details",
          }),
          transition: "none",
        })
      }
    />
  );
};
const ComposedChat = ({
  bot,
  sessionId,
  expanded,
  docked,
  onDock,
  detailsOpen,
  preview,
  toggle,
}: {
  bot: NonNullable<ReturnType<typeof useBot>>;
  sessionId: string;
  expanded: boolean;
  docked: boolean;
  onDock(value: boolean): void;
  detailsOpen: boolean;
  preview?: string;
  toggle(): void;
}) => {
  const { chat } = Route.useRouteContext();
  const runtime =
    fixtureState.current && bot.sessionId == null
      ? fixtureState.current.runtime
      : chat;
  const host = useThreadHost(runtime.session(sessionId));
  useBotChatActivity(bot.id, host.messages, host.sessionGenerating);
  const slots = useBotChatSlots(bot, sessionId, expanded, false, (url) =>
    requestBrowserOpen({ sessionId, url })
  );
  const navigate = useAppNavigate();
  // The identity itself (header and dock) opens and closes the details
  // panel; the title bar keeps only its panel toggle on the far right.
  return (
    <div
      data-testid="bot-chat"
      className="size-full"
      style={accentVars(resolveLook(bot))}
    >
      <BotBrowserRegistration sessionId={sessionId} />
      <TopBarSlot>
        <BotChatIdentity
          bot={bot}
          docked={docked}
          detailsOpen={detailsOpen}
          onToggle={toggle}
        />
      </TopBarSlot>
      <ChatView
        threadId={sessionId}
        skin="bot"
        authorName={bot.name}
        runtime={runtime}
        workspaceRoot={slots.workspaceRoot}
        onOpenFile={slots.openFile}
        composer={slots.composer}
        slots={{
          ...slots.chat,
          wallpaper: bot.wallpaper ?? null,
          header: (
            <BotTranscriptIdentity
              bot={bot}
              onDock={onDock}
              onToggle={toggle}
              detailsOpen={detailsOpen}
            />
          ),
        }}
      />
      <SidePanelContent tab="details">
        <DetailsTab
          bot={bot}
          binding={slots.binding}
          modelInComposer={expanded}
          setTab={slots.setTab}
        />
      </SidePanelContent>
      <SidePanelContent tab="memory">
        <MemoryTab bot={bot} />
      </SidePanelContent>
      <SidePanelContent tab="browser">
        <BotBrowser sessionId={sessionId} />
      </SidePanelContent>
      <SidePanelContent tab="files">
        <FilesTab
          sessionId={sessionId}
          bot={bot}
          preview={preview}
          workspaceRoot={slots.workspaceRoot}
          onClosePreview={() =>
            void navigate({
              search: (previous) => ({ ...previous, preview: undefined }),
              transition: "none",
            })
          }
        />
      </SidePanelContent>
      <Outlet />
    </div>
  );
};
const BotRoute = () => {
  const data = Route.useLoaderData();
  const { botId } = Route.useParams();
  return data?.ready ? (
    <ReadyChat botId={botId} sessionId={data.sessionId} />
  ) : (
    <BotPending />
  );
};
const BotError = ({ error }: { error: unknown }) => {
  const { t } = useTranslation();
  const router = useRouter();
  const botId = (
    router.state.matches.at(-1)?.params as { botId?: string } | undefined
  )?.botId;
  return (
    <div
      className="flex size-full flex-col items-center justify-center gap-3"
      role="alert"
    >
      <p>{t("bots.chat.openError")}</p>
      <p className="text-muted-foreground text-xs">
        {error instanceof Error ? error.message : String(error)}
      </p>
      <Button
        onClick={() => {
          if (botId) forgetOpenChat(botId);
          void router.invalidate();
        }}
      >
        {t("bots.errors.retry")}
      </Button>
    </div>
  );
};
export const Route = createFileRoute("/_shell/(bots)/bots/$botId")({
  params: { parse: v.parser(v.object({ botId: BotId })) },
  validateSearch: BotSearch,
  loader: async ({ context, params, preload }) => {
    if (fixtureReady != null) await fixtureReady;
    if (fixtureState.current) {
      // A bot with a real session renders the chat runtime, not the fixture.
      await Promise.all([
        context.db.collections.bots.preload(),
        context.prepareChat(),
      ]);
      return {
        ready: true as const,
        botId: params.botId,
        sessionId:
          context.db.collections.bots.get(params.botId)?.sessionId ??
          fixtureState.current.threadId,
      };
    }
    return loadBotChat(
      {
        db: context.db,
        transport: context.transport,
        ...chatLoading(context),
      },
      params.botId,
      preload
    );
  },
  pendingComponent: BotPending,
  errorComponent: BotError,
  notFoundComponent: () => <BotGone />,
  component: BotRoute,
});
