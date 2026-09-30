import { createFileRoute, notFound, Outlet } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import * as v from "valibot";

import { BotIdentity, BotPage } from "#next/features/bots";
import { TopBarSlot, useTopBarActions } from "#next/features/shell";
import { ignoreLoadError } from "#next/lib/navigation/loaders";
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
    await context.collections.bots.preload().catch(ignoreLoadError);
    if (!context.collections.bots.has(params.botId)) throw notFound();
  },
  component: BotRoute,
});
