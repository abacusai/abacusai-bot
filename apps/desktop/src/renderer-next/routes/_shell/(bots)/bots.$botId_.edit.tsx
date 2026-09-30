import { createFileRoute, redirect } from "@tanstack/react-router";
import * as v from "valibot";

import {
  BotEditorPage,
  BotGone,
  loadBot,
  botsQueries,
} from "#next/features/bots";
import { chatRuntimeFor } from "#next/features/chat";
import { BotId } from "#shared/contract/ids";
const EditRoute = () => {
  const { botId } = Route.useParams();
  const { transport } = Route.useRouteContext();
  return (
    <BotEditorPage
      botId={botId}
      load={(id) => chatRuntimeFor(transport).session(id).load()}
    />
  );
};
export const Route = createFileRoute("/_shell/(bots)/bots/$botId_/edit")({
  params: { parse: v.parser(v.object({ botId: BotId })) },
  loader: async ({ context, params }) => {
    const [bot] = await Promise.all([
      loadBot(context.db, params.botId),
      context.db.collections.routines.preload(),
      context.queryClient.ensureQueryData(
        botsQueries(context.transport.orpc).models()
      ),
    ]);
    if (bot.channel) throw redirect({ to: "/bots/$botId", params });
  },
  notFoundComponent: () => <BotGone />,
  component: EditRoute,
});
