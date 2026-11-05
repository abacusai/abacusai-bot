import { BotId, SessionId } from "@abacus-ai/contract/contract/ids";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import * as v from "valibot";

import { ComposerUpdateNotice } from "#platform/updates";
import { BotFace } from "#renderer/features/bots/avatar";
import { useBotChatActivity } from "#renderer/features/bots/chat/activity";
import {
  BotGone,
  BotPending,
  BotIdentity as BotChatIdentity,
} from "#renderer/features/bots/chat/identity";
import { useBotChatSlots } from "#renderer/features/bots/chat/slots";
import { loadSenderChat } from "#renderer/features/bots/data/loaders";
import {
  botsQueries,
  useBot,
  useBots,
} from "#renderer/features/bots/data/queries";
import { useBotsTransport } from "#renderer/features/bots/data/transport";
import {
  DetailsTab,
  MemoryTab,
  FilesTab,
} from "#renderer/features/bots/panel/bot-side-panel";
import { ChatView } from "#renderer/features/chat/kit/lazy-view";
import { useThreadHost } from "#renderer/features/chat/runtime/host";
import { chatLoading } from "#renderer/features/chat/runtime/lazy-runtime";
import { requestBrowserOpen } from "#renderer/features/shell/browser-open";
import {
  openPanelTab,
  panelScopeKey,
  updatePanelTab,
  setPanelOpen,
} from "#renderer/features/shell/panel-store";
import { SidePanelContent } from "#renderer/features/shell/side-panel-slot";
import { TopBarSlot } from "#renderer/features/shell/top-bar-slots";
import { activeTabOf, usePanelScope } from "#renderer/features/shell/use-panel";
import { accentVars, resolveLook } from "#renderer/lib/bots/avatar";
import { BotSearch } from "#renderer/lib/navigation/search";

import { BotBrowser, BotBrowserRegistration } from "./-browser";
const ReadySender = () => {
  const { botId, sessionId } = Route.useParams();
  const bot = useBot(botId);
  return bot ? <Sender bot={bot} sessionId={sessionId} /> : <BotGone chat />;
};
const Sender = ({
  bot,
  sessionId,
}: {
  bot: NonNullable<ReturnType<typeof useBot>>;
  sessionId: string;
}) => {
  const { chat } = Route.useRouteContext();
  const { t } = useTranslation();
  const host = useThreadHost(chat.session(sessionId));
  useBotChatActivity(bot.id, host.messages, host.sessionGenerating);
  // A chat with another of the user's bots (ask_bot) says so in the title
  // bar, the way a group chat names who is in it; it is read-only.
  const transport = useBotsTransport();
  const senders = useQuery(botsQueries(transport.orpc).senderChats());
  const info = senders.data?.find((row) => row.sessionId === sessionId);
  const { bots } = useBots();
  const asker =
    info?.platform === "bot"
      ? (bots.find((row) => row.name === info.senderName) ?? null)
      : null;
  const slots = useBotChatSlots(bot, sessionId, false, true, (url) =>
    requestBrowserOpen({ sessionId, url })
  );
  const panelKey = panelScopeKey("bots", bot.id)!;
  const panel = usePanelScope(panelKey);
  const detailsOpen = panel.open && activeTabOf(panel)?.kind === "details";
  const toggle = () => {
    if (detailsOpen) setPanelOpen(panelKey, false);
    else openPanelTab(panelKey, { kind: "details" });
  };
  if (!slots.session) return <BotGone chat />;
  return (
    <div className="size-full" style={accentVars(resolveLook(bot))}>
      <BotBrowserRegistration botId={bot.id} sessionId={sessionId} />
      <TopBarSlot>
        <BotChatIdentity
          bot={bot}
          detailsOpen={detailsOpen}
          onToggle={toggle}
        />
        {info?.platform === "bot" && (
          <span
            data-slot="pair-with"
            className="text-muted-foreground flex min-w-0 shrink items-center gap-1.5 text-xs"
          >
            {asker != null && (
              <BotFace bot={asker} size={16} interactive={false} />
            )}
            <span className="truncate">
              {t("bots.chat.pairWith", { bot: info.senderName })}
            </span>
            <span className="bg-muted shrink-0 rounded-full px-1.5 py-0.5 text-[10px]">
              {t("bots.chat.pairReadOnly")}
            </span>
          </span>
        )}
      </TopBarSlot>
      <ChatView
        threadId={sessionId}
        skin="bot"
        authorName={bot.name}
        runtime={chat}
        workspaceRoot={slots.workspaceRoot}
        onOpenFile={slots.openFile}
        slots={{
          composerNotice: <ComposerUpdateNotice />,
          ...slots.chat,
          wallpaper: bot.wallpaper ?? null,
        }}
        composer={slots.composer}
      />
      <SidePanelContent kind="details">
        {(_, active) => (
          <DetailsTab
            bot={bot}
            binding={{
              ...slots.binding,
              layoutId: active ? slots.binding.layoutId : undefined,
            }}
            modelInComposer={false}
            setTab={slots.setTab}
          />
        )}
      </SidePanelContent>
      <SidePanelContent kind="memory">
        <MemoryTab bot={bot} />
      </SidePanelContent>
      <SidePanelContent kind="browser">
        {(tab, active) => (
          <BotBrowser
            botId={bot.id}
            sessionId={sessionId}
            tab={tab}
            active={active}
          />
        )}
      </SidePanelContent>
      <SidePanelContent kind="files">
        {(tab) => (
          <FilesTab
            sessionId={sessionId}
            bot={bot}
            tab={tab}
            workspaceRoot={slots.workspaceRoot}
            onOpen={(path, where) =>
              where === "tab" && path != null
                ? openPanelTab(
                    panelKey,
                    { kind: "files", path, title: path.split("/").at(-1) },
                    { fresh: true }
                  )
                : updatePanelTab(panelKey, tab.id, {
                    path,
                    title: path?.split("/").at(-1),
                  })
            }
          />
        )}
      </SidePanelContent>
    </div>
  );
};
export const Route = createFileRoute(
  "/_shell/(bots)/bots/$botId_/chats/$sessionId"
)({
  params: { parse: v.parser(v.object({ botId: BotId, sessionId: SessionId })) },
  validateSearch: BotSearch,
  loader: ({ context, params, preload }) =>
    loadSenderChat(
      {
        db: context.db,
        ...chatLoading(context),
      },
      params.botId,
      params.sessionId,
      preload
    ),
  pendingComponent: BotPending,
  notFoundComponent: () => <BotGone chat />,
  component: SenderRoute,
});

function SenderRoute() {
  return Route.useLoaderData().ready ? <ReadySender /> : <BotPending />;
}
