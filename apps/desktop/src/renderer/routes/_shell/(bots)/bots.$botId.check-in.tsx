import { createFileRoute } from "@tanstack/react-router";

import { CheckInDialog, loadBot } from "#renderer/features/bots";
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
