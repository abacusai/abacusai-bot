import { createFileRoute, Outlet, notFound } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import { ChatView } from "#renderer/features/chat/kit/lazy-view";
import {
  chatLoading,
  chatRuntimeFor,
} from "#renderer/features/chat/runtime/runtime";
import { useConnectFlow } from "#renderer/features/library/connect-flow";
import { ConnectorFieldsDialog } from "#renderer/features/library/connectors";
import { RoutinePage, RoutineGone } from "#renderer/features/routines/page";
import { RunRequests } from "#renderer/features/routines/run-requests";
import { TopBarSlot } from "#renderer/features/shell/top-bar-slots";
import { RoutineSearch } from "#renderer/lib/navigation/search";
const RoutineRoute = () => {
  const { t } = useTranslation();
  const { transport, db } = Route.useRouteContext();
  const flow = useConnectFlow();
  return (
    <>
      <TopBarSlot>{t("shell.rail.routines")}</TopBarSlot>
      <RoutinePage
        renderRunReport={(runId) => (
          <ChatView
            threadId={runId}
            skin="bot"
            runtime={chatRuntimeFor(transport)}
            composer={{
              mode: "full",
              placeholder: "",
              attachmentsBase: null,
              showModeChip: false,
              model: null,
              readOnly: { reason: t("phase5.readOnlyRun") },
            }}
            slots={{
              decorateMessage: (message, ctx) => ({
                hidden: message.role === "user" && ctx.index === 0,
              }),
              banner: (
                <RunRequests
                  sessionId={runId}
                  workspaceId={
                    db.collections.sessions.get(runId)?.workspaceId ?? ""
                  }
                  connect={(id, values) =>
                    values
                      ? transport.client.connectors.submitFields({
                          connectorId: id,
                          values,
                        })
                      : flow.start(id)
                  }
                  cancel={flow.cancel}
                />
              ),
            }}
            workspaceRoot={
              db.collections.workspaces.get(
                db.collections.sessions.get(runId)?.workspaceId ?? ""
              )?.path ?? null
            }
          />
        )}
      />
      <ConnectorFieldsDialog />
      <Outlet />
    </>
  );
};
export const Route = createFileRoute("/_shell/(routines)/routines/$routineId")({
  validateSearch: RoutineSearch,
  loaderDeps: ({ search }) => ({ run: search.run }),
  loader: async ({ context, params, deps, preload }) => {
    await Promise.all([
      context.db.collections.routines.preload(),
      context.db.collections.routineRuns.preload(),
    ]);
    if (!context.db.collections.routines.get(params.routineId))
      throw notFound();
    if (
      deps.run &&
      context.db.collections.routineRuns.toArray.some(
        (run) =>
          run.sessionId === deps.run && run.routineId === params.routineId
      )
    ) {
      const chat = chatLoading({
        ...context,
        chat: chatRuntimeFor(context.transport),
      });
      // A hover fetches the run's first page only; the click loads it.
      if (preload) chat.warm(deps.run);
      else await chat.load(deps.run);
    }
  },
  notFoundComponent: RoutineGone,
  component: RoutineRoute,
});
