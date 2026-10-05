import { BotId } from "@abacus-ai/contract/contract/ids";
import { createFileRoute, redirect } from "@tanstack/react-router";
import * as v from "valibot";

import { BotGone } from "#renderer/features/bots/chat/identity";
import { loadBot } from "#renderer/features/bots/data/loaders";
import { botsQueries } from "#renderer/features/bots/data/queries";
import { BotEditorPage } from "#renderer/features/bots/form/bot-form";
const EditRoute = () => {
  const { botId } = Route.useParams();
  const { chat, prepareChat } = Route.useRouteContext();
  return (
    <BotEditorPage
      botId={botId}
      load={async (id) => {
        await prepareChat();
        return chat.session(id).load();
      }}
    />
  );
};
export const Route = createFileRoute("/_shell/(bots)/bots/$botId_/edit")({
  params: { parse: v.parser(v.object({ botId: BotId })) },
  loader: async ({ context, params }) => {
    void context.queryClient.prefetchQuery(
      botsQueries(context.transport.orpc).models()
    );
    const [bot] = await Promise.all([
      loadBot(context.db, params.botId),
      context.db.collections.routines.preload(),
    ]);
    if (bot.channel) throw redirect({ to: "/bots/$botId", params });
  },
  notFoundComponent: () => <BotGone />,
  component: EditRoute,
});
