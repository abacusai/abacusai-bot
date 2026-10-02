import { createFileRoute } from "@tanstack/react-router";

import { BotEditPage, BotIdentity } from "#next/features/bots";
import { TopBarSlot } from "#next/features/shell";

const BotEditRoute = () => {
  const { botId } = Route.useParams();
  return (
    <>
      <TopBarSlot>
        <BotIdentity botId={botId} />
      </TopBarSlot>
      <BotEditPage />
    </>
  );
};

/** A full page, not a pop-up (PLAN route tree). */
export const Route = createFileRoute("/_shell/(bots)/bots/$botId_/edit")({
  component: BotEditRoute,
});
