import {
  createFileRoute,
  Outlet,
  notFound,
  redirect,
} from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import { ChatView, chatRuntimeFor } from "#next/features/chat";
import { useConnectFlow, ConnectorFieldsDialog } from "#next/features/library";
import { RoutinePage, RoutineGone, RunRequests } from "#next/features/routines";
import { TopBarSlot } from "#next/features/shell";
import { RoutineSearch } from "#next/lib/navigation/search";
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
  loader: {
    staleReloadMode: "blocking",
    handler: async ({ context, params, deps, preload }) => {
      await Promise.all([
        context.db.collections.routines.preload(),
        context.db.collections.routineRuns.preload(),
      ]);
      if (!context.db.collections.routines.get(params.routineId))
        throw notFound();
      if (deps.run) {
        if (
          context.db.collections.routineRuns.get(deps.run)?.routineId !==
          params.routineId
        )
          throw redirect({
            to: "/routines/$routineId",
            params,
            search: { run: undefined },
            replace: true,
          });
        if (!preload)
          await chatRuntimeFor(context.transport).session(deps.run).load();
      }
    },
  },
  notFoundComponent: RoutineGone,
  component: RoutineRoute,
});
