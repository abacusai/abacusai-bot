import { createFileRoute } from "@tanstack/react-router";
import * as v from "valibot";

import {
  BotGone,
  BotPending,
  BotChatIdentity,
  useBot,
  useBotChatSlots,
  loadSenderChat,
  FilesTab,
} from "#next/features/bots";
import { chatRuntimeFor, ChatView } from "#next/features/chat";
import { TopBarSlot, SidePanelContent } from "#next/features/shell";
import { accentVars, resolveLook } from "#next/lib/bots/avatar";
import { BotSearch } from "#next/lib/navigation/search";
import { BotId, SessionId } from "#shared/contract/ids";
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
  const { transport } = Route.useRouteContext();
  const slots = useBotChatSlots(bot, sessionId, false, true);
  const search = Route.useSearch();
  if (!slots.session) return <BotGone chat />;
  return (
    <div className="size-full" style={accentVars(resolveLook(bot))}>
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
        runtime={chatRuntimeFor(transport)}
        workspaceRoot={slots.workspaceRoot}
        onOpenFile={slots.openFile}
        slots={slots.chat}
        composer={slots.composer}
      />
      <SidePanelContent tab="files">
        <FilesTab
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
  loader: {
    staleReloadMode: "blocking",
    handler: ({ context, params, preload }) =>
      loadSenderChat(
        {
          db: context.db,
          load: (id) => chatRuntimeFor(context.transport).session(id).load(),
        },
        params.botId,
        params.sessionId,
        preload
      ),
  },
  pendingComponent: BotPending,
  notFoundComponent: () => <BotGone chat />,
  component: SenderRoute,
});

function SenderRoute() {
  return Route.useLoaderData().ready ? <ReadySender /> : <BotPending />;
}
