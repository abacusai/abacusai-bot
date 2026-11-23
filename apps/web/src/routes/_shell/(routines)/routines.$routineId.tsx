import { sessionConversationKey } from "@abacus-ai/contract/conversation-scope";
import {
  createFileRoute,
  Outlet,
  notFound,
  useNavigate,
} from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { hasInAppViewer, isUrl } from "#renderer/components/file-preview";
import { TitleBarIconButton } from "#renderer/components/title-bar";
import { loadFixtureRuntime } from "#renderer/features/chat/fixture-runtime";
import { ChatView } from "#renderer/features/chat/kit/lazy-view";
import { chatLoading } from "#renderer/features/chat/runtime/lazy-runtime";
import { useConnectFlow } from "#renderer/features/library/connect-flow";
import { ConnectorFieldsDialog } from "#renderer/features/library/connectors";
import { runsView } from "#renderer/features/routines/data";
import {
  RoutinePage,
  RoutineGone,
  type RoutineAction,
} from "#renderer/features/routines/page";
import { RunRequests } from "#renderer/features/routines/run-requests";
import {
  deliverablesAfter,
  rowEndIndex,
  sessionDeliverablesCard,
  type SessionDeliverablesOptions,
} from "#renderer/features/sessions/chat/deliverables";
import {
  openTab,
  panelTabsStore,
} from "#renderer/features/sessions/dock/panel-tabs-store";
import {
  isAbsolutePreviewPath,
  previewTargetPath,
} from "#renderer/features/sessions/files/preview-target";
import {
  TopBarSlot,
  useTopBarActions,
} from "#renderer/features/shell/top-bar-slots";
import { RoutineSearch } from "#renderer/lib/navigation/search";
import { openHostPath } from "#renderer/lib/open-host-path";
import { IS_ELECTRON } from "#renderer/lib/platform";
import { platformSystem } from "#renderer/lib/platform-system";
/** The routine in the title bar: its identity, and its actions as icons. */
const RoutineTitle = ({
  identity,
  actions,
}: {
  identity: ReactNode;
  actions: RoutineAction[];
}) => {
  useTopBarActions(
    actions.map((action) => ({
      ...action,
      render: (
        <TitleBarIconButton label={action.label} onClick={action.onSelect}>
          {action.icon}
        </TitleBarIconButton>
      ),
    }))
  );
  return <TopBarSlot>{identity}</TopBarSlot>;
};
const RoutineRoute = () => {
  const { t } = useTranslation();
  const { transport, db, chat } = Route.useRouteContext();
  const flow = useConnectFlow();
  const navigate = useNavigate();
  // A run has no dock of its own: what its tools open (a file, a page, a
  // subagent, a diff) opens in the run's session, where the dock shows it.
  const handoff = (runId: string, root: string | null) => {
    const row = db.collections.sessions.get(runId);
    const key = row ? sessionConversationKey(row.workspaceId, runId) : null;
    const openSessionTab = (tab: Parameters<typeof openTab>[1]) => {
      if (key) openTab(key, tab);
      void navigate({
        to: "/sessions/$sessionId",
        params: { sessionId: runId },
        search: { tab: tab.ref },
      });
    };
    const openUrl = (url: string) =>
      openSessionTab({
        ref:
          (key
            ? panelTabsStore.state[key]?.tabs.find(
                (tab) => tab.ref.startsWith("browser:") && tab.url === url
              )?.ref
            : undefined) ?? `browser:${crypto.randomUUID()}`,
        title: url,
        url,
      });
    const openFile = (path: string) => {
      if (isUrl(path)) return openUrl(path);
      const target = previewTargetPath(path, root);
      const inside = target !== null && !isAbsolutePreviewPath(target);
      if (target === null || (!inside && !hasInAppViewer(target)))
        return void openHostPath(transport.client, path);
      openSessionTab({
        ref:
          (key
            ? panelTabsStore.state[key]?.tabs.find(
                (tab) => tab.ref.startsWith("preview:") && tab.path === target
              )?.ref
            : undefined) ?? `preview:${crypto.randomUUID()}`,
        title: path.split("/").at(-1) ?? path,
        path: target,
      });
    };
    return {
      openUrl,
      openFile,
      openSubagent: (agent: string) =>
        void navigate({
          to: "/sessions/$sessionId",
          params: { sessionId: runId },
          search: { tab: "agents", agent },
        }),
      openDiff: (path: string, toolKey?: string) =>
        void navigate({
          to: "/sessions/$sessionId/diff",
          params: { sessionId: runId },
          search: { path, toolKey, source: toolKey ? "tool" : "git" },
        }),
    };
  };
  const requests = (sessionIds: ReadonlySet<string>, className?: string) => (
    <RunRequests
      sessionIds={sessionIds}
      className={className}
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
  );
  return (
    <>
      <RoutinePage
        renderTitle={(title) => <RoutineTitle {...title} />}
        renderRequests={(sessionIds) =>
          requests(sessionIds, "mx-0 mb-0 max-w-none")
        }
        renderRunReport={(runId) => {
          const root =
            db.collections.workspaces.get(
              db.collections.sessions.get(runId)?.workspaceId ?? ""
            )?.path ?? null;
          const open = handoff(runId, root);
          const deliverables: SessionDeliverablesOptions = {
            workspaceRoot: root,
            onOpenFile: open.openFile,
            onOpenUrl: open.openUrl,
            onOpenExternal: (url) =>
              void platformSystem(transport.client).openExternal({ url }),
            onReveal: IS_ELECTRON
              ? (path) =>
                  void transport.client.system.showItemInFolder({ path })
              : undefined,
          };
          return (
            <ChatView
              threadId={runId}
              skin="session"
              runtime={chat}
              composer={{
                mode: "full",
                placeholder: "",
                attachmentsBase: null,
                showModeChip: false,
                model: null,
                readOnly: { reason: t("phase5.readOnlyRun") },
              }}
              onOpenFile={open.openFile}
              onOpenSubagent={open.openSubagent}
              onOpenDiff={open.openDiff}
              slots={{
                decorateMessage: (message, context) => {
                  if (message.role !== "assistant") return null;
                  const at = rowEndIndex(message, context);
                  const files =
                    at < 0
                      ? null
                      : deliverablesAfter(
                          context.messages,
                          at,
                          context.runActive
                        );
                  return files == null
                    ? null
                    : {
                        after: sessionDeliverablesCard(files, deliverables),
                      };
                },
                renderDeliverables: (items) =>
                  sessionDeliverablesCard(items, deliverables),
                banner: requests(new Set([runId])),
              }}
              workspaceRoot={root}
            />
          );
        }}
      />
      <ConnectorFieldsDialog />
      <Outlet />
    </>
  );
};
export const Route = createFileRoute("/_shell/(routines)/routines/$routineId")({
  validateSearch: RoutineSearch,
  // Fixture rows have no main-side run. Replay the fixture run through the
  // same chat runtime as the gallery instead of asking main for it.
  beforeLoad: async ({ context }) => {
    if (import.meta.env.VITE_NEXT_DB_FIXTURES !== "1")
      return { chat: context.chat };
    const create = await loadFixtureRuntime();
    const { fixtureRoutineRuns } =
      await import("#renderer/data/fixture-db/rows");
    const fixture = create(
      "bot-golden-plain",
      {},
      fixtureRoutineRuns()[0]!.sessionId
    );
    if (fixture === null) throw new Error("Missing bot-golden-plain fixture");
    return { chat: fixture.runtime };
  },
  loaderDeps: ({ search }) => ({ run: search.run }),
  loader: async ({ context, params, deps, preload }) => {
    await Promise.all([
      context.db.collections.routines.preload(),
      context.db.collections.routineRuns.preload(),
      // A run report is a chat view.
      preload ? undefined : context.prepareChat(),
    ]);
    const routine = context.db.collections.routines.get(params.routineId);
    if (!routine) throw notFound();
    // The page opens the picked run, else the newest.
    const runs = context.db.collections.routineRuns.toArray;
    const has = (id: string | null | undefined) =>
      runs.some((row) => row.sessionId === id && row.routineId === routine.id);
    const run = has(deps.run)
      ? deps.run
      : runsView(routine, runs).find((a) => !a.note && has(a.sessionId))
          ?.sessionId;
    if (run) {
      const chat = chatLoading(context);
      // A hover fetches the run's first page only; the click loads it.
      if (preload) chat.warm(run);
      else await chat.load(run);
    }
  },
  notFoundComponent: RoutineGone,
  component: RoutineRoute,
});
