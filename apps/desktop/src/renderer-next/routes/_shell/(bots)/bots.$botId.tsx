import { createFileRoute, notFound, Outlet } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import * as v from "valibot";

import { BotIdentity, BotPage } from "#next/features/bots";
import { TopBarSlot, useTopBarActions } from "#next/features/shell";
import { ignoreLoadError, isMissing } from "#next/lib/navigation/loaders";
import { BotSearch } from "#next/lib/navigation/search";
import { useAppNavigate } from "#next/lib/navigation/use-app-navigate";
import { BotId } from "#shared/contract/ids";

const BotRoute = () => {
  const { t } = useTranslation();
  const { botId } = Route.useParams();
  const navigate = useAppNavigate();
  useTopBarActions([
    {
      id: "details",
      label: t("bots.page.detailsTitle"),
      onSelect: () =>
        void navigate({
          to: "/bots/$botId/details",
          params: { botId },
          transition: "none",
        }),
    },
  ]);
  return (
    <>
      <TopBarSlot>
        <BotIdentity botId={botId} />
      </TopBarSlot>
      <BotPage botId={botId} />
      <Outlet />
    </>
  );
};

export const Route = createFileRoute("/_shell/(bots)/bots/$botId")({
  params: { parse: v.parser(v.object({ botId: BotId })) },
  validateSearch: BotSearch,
  loader: async ({ context, params }) => {
    const { bots } = context.db.collections;
    await bots.preload().catch(ignoreLoadError);
    // Only a loaded table can say the bot is gone; a failed load is the
    // sidebar's to show, with its Retry.
    if (isMissing(bots, params.botId)) throw notFound();
  },
  component: BotRoute,
});
