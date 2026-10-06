import { BotId, SessionId } from "@abacus-ai/contract/contract/ids";
import { createFileRoute } from "@tanstack/react-router";
import * as v from "valibot";

import { useBotChatActivity } from "#renderer/features/bots/chat/activity";
import {
  BotGone,
  BotPending,
  BotIdentity as BotChatIdentity,
} from "#renderer/features/bots/chat/identity";
import { useBotChatSlots } from "#renderer/features/bots/chat/slots";
import { loadSenderChat } from "#renderer/features/bots/data/loaders";
import { useBot } from "#renderer/features/bots/data/queries";
import { FilesTab } from "#renderer/features/bots/panel/bot-side-panel";
import { ChatView } from "#renderer/features/chat/kit/lazy-view";
import { useThreadHost } from "#renderer/features/chat/runtime/host";
import { chatLoading } from "#renderer/features/chat/runtime/lazy-runtime";
import { requestBrowserOpen } from "#renderer/features/shell/browser-open";
import { SidePanelContent } from "#renderer/features/shell/side-panel-slot";
import { TopBarSlot } from "#renderer/features/shell/top-bar-slots";
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
  const host = useThreadHost(chat.session(sessionId));
  useBotChatActivity(bot.id, host.messages, host.sessionGenerating);
  const slots = useBotChatSlots(bot, sessionId, false, true, (url) =>
    requestBrowserOpen({ sessionId, url })
  );
  const search = Route.useSearch();
  if (!slots.session) return <BotGone chat />;
  return (
    <div className="size-full" style={accentVars(resolveLook(bot))}>
      <BotBrowserRegistration sessionId={sessionId} />
      <TopBarSlot>
        <BotChatIdentity
          bot={bot}
          detailsOpen={false}
          onToggle={() => slots.setTab("files")}
        />
      </TopBarSlot>
      <ChatView
        threadId={sessionId}
        skin="bot"
        authorName={bot.name}
        runtime={chat}
        workspaceRoot={slots.workspaceRoot}
        onOpenFile={slots.openFile}
        slots={{ ...slots.chat, wallpaper: bot.wallpaper ?? null }}
        composer={slots.composer}
      />
      <SidePanelContent tab="browser">
        <BotBrowser sessionId={sessionId} />
      </SidePanelContent>
      <SidePanelContent tab="files">
        <FilesTab
          sessionId={sessionId}
          bot={bot}
          preview={search.preview}
          workspaceRoot={slots.workspaceRoot}
          onClosePreview={() => slots.setTab("files")}
        />
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
