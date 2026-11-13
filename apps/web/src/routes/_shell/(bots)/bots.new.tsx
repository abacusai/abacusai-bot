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
import { ResumeCard } from "#renderer/features/bots/start/resume-card";
import { openChatWithText } from "#renderer/features/shell";
import { TopBarSlot } from "#renderer/features/shell/top-bar-slots";
import { useAppNavigate } from "#renderer/lib/navigation/use-app-navigate";
const NewRoute = () => {
  const { t } = useTranslation();
  const search = Route.useSearch();
  const { chat, prepareChat, db } = Route.useRouteContext();
  const navigate = useAppNavigate();
  const messagesOf = async (threadId: string) => {
    await prepareChat();
    const session = chat.session(threadId);
    await session.load();
    return session.hostStore.state.messages;
  };
  return (
    <>
      <TopBarSlot>{t("bots.page.newTitle")}</TopBarSlot>
      {search.step === "setup" ? (
        <BotSetupForm
          load={async (id) => {
            await prepareChat();
            return chat.session(id).load();
          }}
        />
      ) : (
        <BotStartPage
          category={search.category}
          resume={
            <ResumeCard
              messagesOf={messagesOf}
              openChat={(sessionId, text) =>
                openChatWithText(sessionId, text, db, navigate)
              }
            />
          }
        />
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
    // Connected connectors only reorder the gallery and the model picker
    // labels the app default until the catalog lands: neither waits.
    const queries = botsQueries(context.transport.orpc);
    void context.queryClient.prefetchQuery(queries.connectorStatuses());
    if (deps.step === "setup")
      void context.queryClient.prefetchQuery(queries.models());
    await context.db.collections.bots.preload();
    if (
      deps.step === "setup" &&
      deps.template &&
      getDraft().templateId !== deps.template
    )
      selectTemplate(
        deps.template,
        context.t(`bots.templates.${deps.template}.name`)
      );
  },
  component: NewRoute,
});
