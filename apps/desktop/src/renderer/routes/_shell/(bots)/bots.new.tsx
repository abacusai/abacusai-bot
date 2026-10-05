import { createFileRoute, stripSearchParams } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import { botsQueries } from "#renderer/features/bots/data/queries";
import {
  NewBotSearch,
  NEW_BOT_DEFAULTS,
} from "#renderer/features/bots/data/search";
import { BotSetupForm } from "#renderer/features/bots/form/bot-form";
import {
  selectTemplate,
  getDraft,
} from "#renderer/features/bots/form/draft-store";
import { BotStartPage } from "#renderer/features/bots/start/bot-start-page";
import { TopBarSlot } from "#renderer/features/shell/top-bar-slots";
const NewRoute = () => {
  const { t } = useTranslation();
  const search = Route.useSearch();
  const { chat } = Route.useRouteContext();
  return (
    <>
      <TopBarSlot>{t("bots.page.newTitle")}</TopBarSlot>
      {search.step === "setup" ? (
        <BotSetupForm load={(id) => chat.session(id).load()} />
      ) : (
        <BotStartPage category={search.category} />
      )}
    </>
  );
};
export const Route = createFileRoute("/_shell/(bots)/bots/new")({
  validateSearch: NewBotSearch,
  search: { middlewares: [stripSearchParams(NEW_BOT_DEFAULTS)] },
  loaderDeps: ({ search }) => ({
    step: search.step,
    template: search.template,
  }),
  loader: async ({ context, deps }) => {
    await context.db.collections.bots.preload();
    const queries = botsQueries(context.transport.orpc);
    await context.queryClient.ensureQueryData(queries.connectorStatuses());
    if (deps.step === "setup") {
      await context.queryClient.ensureQueryData(queries.models());
      if (deps.template && getDraft().templateId !== deps.template)
        selectTemplate(
          deps.template,
          context.t(`bots.templates.${deps.template}.name`)
        );
    }
  },
  component: NewRoute,
});
