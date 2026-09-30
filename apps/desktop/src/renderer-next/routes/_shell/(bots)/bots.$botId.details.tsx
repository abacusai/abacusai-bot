import { createFileRoute } from "@tanstack/react-router";

import { BotDetailsSheet } from "#next/features/bots";

const BotDetailsRoute = () => {
  const { botId } = Route.useParams();
  return <BotDetailsSheet botId={botId} />;
};

/** Masked pop-up: the URL shows /bots/$botId (router.tsx routeMasks). */
export const Route = createFileRoute("/_shell/(bots)/bots/$botId/details")({
  component: BotDetailsRoute,
});
