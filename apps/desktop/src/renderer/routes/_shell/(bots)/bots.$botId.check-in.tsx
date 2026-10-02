import { createFileRoute } from "@tanstack/react-router";

import { CheckInDialog } from "#renderer/features/bots/check-in/check-in-dialog";
import { loadBot } from "#renderer/features/bots/data/loaders";
const CheckInRoute = () => <CheckInDialog botId={Route.useParams().botId} />;
export const Route = createFileRoute("/_shell/(bots)/bots/$botId/check-in")({
  loader: async ({ context, params }) => {
    await Promise.all([
      loadBot(context.db, params.botId),
      context.db.collections.routines.preload(),
    ]);
  },
  component: CheckInRoute,
});
