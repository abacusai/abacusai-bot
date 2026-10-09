import {
  createFileRoute,
  notFound,
  stripSearchParams,
  Outlet,
  redirect,
} from "@tanstack/react-router";
import { useSelector } from "@tanstack/react-store";
import { lazy, Suspense, useEffect, useEffectEvent } from "react";
import { useTranslation } from "react-i18next";
import * as v from "valibot";

import { useCollections } from "#renderer/data/db";
import { loadFixtureRuntime } from "#renderer/features/chat/fixture-runtime";
import { ChatView } from "#renderer/features/chat/kit/lazy-view";
import { useSubagents } from "#renderer/features/chat/kit/subagents/use-subagents";
import { openStartDraft } from "#renderer/features/sessions/start/start-session";
import { updateDraft } from "#renderer/lib/continuity/composer-drafts";
import { platformSystem } from "#renderer/lib/platform-system";
const SubagentDetail = lazy(() =>
  import("#renderer/features/chat/kit/subagents/detail").then((m) => ({
    default: m.SubagentDetail,
  }))
);

import type {
  AgentMode,
  PermissionRequest,
} from "@abacus-ai/contract/agent-types";
import { SessionId } from "@abacus-ai/contract/contract/ids";
import { sessionConversationKey } from "@abacus-ai/contract/conversation-scope";

import { EmptyState } from "#renderer/components/empty-state";
import { MessageFeedback } from "#renderer/components/message-feedback";
import { chatLoading } from "#renderer/features/chat/runtime/lazy-runtime";
import { type ChatRuntime } from "#renderer/features/chat/runtime/runtime";
import { SessionChangesCard } from "#renderer/features/sessions/changes/changes-card";
import { SessionContextTray } from "#renderer/features/sessions/context/context-tray";
import { SessionPermissionAction } from "#renderer/features/sessions/context/permission-terminal-action";
import { SessionTasks } from "#renderer/features/sessions/context/tasks";
import { useSessionComposerModel } from "#renderer/features/sessions/data/composer-model";
import {
  useSession,
  useWorkspace,
} from "#renderer/features/sessions/data/queries";
import { openSessionOnce } from "#renderer/features/sessions/data/unread-store";
import { openTab } from "#renderer/features/sessions/dock/panel-tabs-store";
import { SessionWorkspace } from "#renderer/features/sessions/session-workspace";
import { SessionIdentity } from "#renderer/features/sessions/sessions-pages";
import {
  APP_HOTKEYS,
  useAppHotkey,
  dispatchAppHotkey,
} from "#renderer/features/shell/hotkeys";
import { nativePresenterFor } from "#renderer/features/shell/platform-presenter";
import { registerPreviewConsumer } from "#renderer/features/shell/preview-consumers";
import { shellStore } from "#renderer/features/shell/shell-store";
import { SidePanelOverride } from "#renderer/features/shell/side-panel-slot";
import { TopBarSlot } from "#renderer/features/shell/top-bar-slots";
import { AppLink } from "#renderer/lib/navigation/app-link";
import {
  SESSION_DEFAULTS,
  SessionSearch,
} from "#renderer/lib/navigation/search";
import { useAppNavigate } from "#renderer/lib/navigation/use-app-navigate";
import { Button } from "#renderer/ui/button";

const SessionAgents = ({
  runtime,
  threadId,
  selected,
}: {
  runtime: ChatRuntime;
  threadId: string;
  selected: string | undefined;
}) => {
  const agents = useSubagents(runtime, threadId);
  const { t } = useTranslation();
  const navigate = useAppNavigate();
  return (
    <div className="flex size-full min-h-0 flex-col overflow-auto p-3">
      <h2>{t("sessions.dock.agents")}</h2>
      {agents.length === 0 ? (
        <EmptyState
          title={t("sessions.agents.empty")}
          className="my-auto [&_[data-slot=empty-title]]:text-sm"
        />
      ) : (
        agents.map((agent) => (
          <Button
            key={agent.id}
            variant={selected === agent.id ? "secondary" : "ghost"}
            onClick={() =>
              void navigate({
                to: ".",
                search: (p: Record<string, unknown>) => ({
                  ...p,
                  agent: agent.id,
                }),
                replace: true,
                transition: "none",
              })
            }
          >
            {agent.name} · {agent.status}
          </Button>
        ))
      )}
      {selected ? (
        <>
          <Suspense fallback={null}>
            <SubagentDetail
              runtime={runtime}
              threadId={threadId}
              subagentRunId={selected}
            />
          </Suspense>
          <Button
            onClick={() => {
              updateDraft(threadId, (d) => ({
                ...d,
                text: t("sessions.agents.continuePrompt", {
                  name: agents.find((a) => a.id === selected)?.name ?? selected,
                }),
              }));
              void navigate({
                to: ".",
                search: (p: Record<string, unknown>) => ({ ...p, tab: "chat" }),
                replace: true,
                transition: "none",
              });
            }}
          >
            {t("sessions.agents.continue")}
          </Button>
        </>
      ) : null}
    </div>
  );
};
const DockHotkeys = ({
  next,
  previous,
  close,
  newTerminal,
}: {
  next: () => void;
  previous: () => void;
  close: () => void;
  newTerminal: () => void;
}) => {
  useAppHotkey("Mod+`", newTerminal, { actionId: "new-terminal-tab" });
  useAppHotkey(APP_HOTKEYS.nextTab, next, { actionId: "next-tab" });
  useAppHotkey(APP_HOTKEYS.previousTab, previous, { actionId: "previous-tab" });
  useAppHotkey(APP_HOTKEYS.closeTab, close, { actionId: "close-tab" });
  return null;
};
const PreviewRegistration = ({
  conversationKey,
  open,
}: {
  conversationKey: string;
  open: (path?: string, url?: string) => void;
}) => {
  const receive = useEffectEvent(open);
  useEffect(
    () =>
      registerPreviewConsumer({
        owns: (key) => key === undefined || key === conversationKey,
        open: (event) => receive(event.path, event.url),
      }),
    [conversationKey]
  );
  return null;
};
const SessionGone = () => {
  const { t } = useTranslation();
  const navigate = useAppNavigate();
  return (
    <div
      role="status"
      className="flex h-full flex-col items-center justify-center gap-3"
    >
      <EmptyState
        title={t("sessions.gone")}
        action={
          <Button
            onClick={() =>
              void navigate({
                to: "/sessions/new",
                search: { draft: openStartDraft() },
              })
            }
          >
            {t("sessions.sidebar.new")}
          </Button>
        }
      />
    </div>
  );
};
const SessionBeside = ({ id }: { id: string }) => {
  const { chat } = Route.useRouteContext();
  const row = useSession(id);
  const workspace = useWorkspace(row?.workspaceId ?? "");
  const { t } = useTranslation();
  useEffect(() => {
    void chat.session(id).load();
  }, [chat, id]);
  if (!row) return <SessionGone />;
  return (
    <ChatView
      threadId={id}
      skin="session"
      runtime={chat}
      focused={false}
      workspaceRoot={row.worktreePath ?? workspace?.path ?? null}
      composer={{
        mode: "mini",
        attachmentsBase: null,
        showModeChip: false,
        placeholder: t("sessions.sidebar.openBeside"),
        model: null,
        turnBusy: false,
        readOnly: { reason: row.label },
      }}
    />
  );
};
const SessionRoute = () => {
  const { sessionId } = Route.useParams();
  const { transport, chat: runtime } = Route.useRouteContext();
  const { t } = useTranslation();
  const navigate = useAppNavigate();
  const collections = useCollections();
  const observedRow = useSession(sessionId);
  // The loader has already admitted this collection row. A new live-query
  // subscription catches up after commit; do not flash Gone in that interval.
  const row =
    observedRow?.id === sessionId
      ? observedRow
      : collections.sessions.get(sessionId);
  const observedWorkspace = useWorkspace(row?.workspaceId ?? "");
  const workspace =
    observedWorkspace ??
    (row ? collections.workspaces.get(row.workspaceId) : undefined);
  const model = useSessionComposerModel(row);
  const session = runtime.session(sessionId);
  const host = useSelector(session.hostStore, (s) => s);
  const incarnation = useSelector(host.store, (s) => s.incarnation);
  const outcomes = useSelector(host.store, (s) => s.runs.outcomes);
  const completed = useSelector(
    host.store,
    (s) => s.runs.active === null && s.runs.outcomes.at(-1)?.kind === "success"
  );
  const presenter = nativePresenterFor(transport.client);
  useEffect(() => {
    openSessionOnce(sessionId);
  }, [sessionId]);
  if (!row) return <SessionGone />;
  const root = row.worktreePath ?? workspace?.path ?? null;
  const checkout = { workspaceId: row.workspaceId, sessionId };
  const key = sessionConversationKey(row.workspaceId, sessionId);
  const select = (tab: string, extra: Record<string, unknown> = {}) =>
    void navigate({
      to: ".",
      search: (p: Record<string, unknown>) => ({ ...p, tab, ...extra }),
      replace: true,
      transition: "none",
    });
  const openFile = (path: string) => {
    if (!root || !path.startsWith(`${root}/`)) {
      void platformSystem(transport.client).openPath({ path });
      return;
    }
    const ref = `preview:${crypto.randomUUID()}`;
    openTab(key, {
      ref,
      title: path.split("/").at(-1) ?? path,
      path: path.slice(root.length + 1),
    });
    select(ref);
  };
  return (
    <>
      <PreviewRegistration
        conversationKey={key}
        open={(path, url) => {
          if (path) openFile(path);
          else {
            const ref = `browser:${crypto.randomUUID()}`;
            openTab(key, {
              ref,
              title: url ?? t("sessions.dock.browser"),
              url,
            });
            select(ref);
          }
        }}
      />
      <TopBarSlot>
        <SessionIdentity sessionId={sessionId} />
      </TopBarSlot>
      <SidePanelOverride />
      <SessionWorkspace
        row={row}
        incarnation={incarnation}
        presenter={presenter}
        blocked={(rect: DOMRect) =>
          document.querySelector('[role="dialog"]') !== null ||
          shellStore.state.occlusion.rects.some(
            (r) =>
              r.x < rect.right &&
              r.x + r.width > rect.left &&
              r.y < rect.bottom &&
              r.y + r.height > rect.top
          )
        }
        dispatch={dispatchAppHotkey}
        registerHotkeys={(next, previous, close, newTerminal) => (
          <DockHotkeys
            next={next}
            previous={previous}
            close={close}
            newTerminal={newTerminal}
          />
        )}
        renderSession={(id) => <SessionBeside id={id} />}
        renderAgent={(id) => (
          <SessionAgents runtime={runtime} threadId={sessionId} selected={id} />
        )}
        chat={
          <ChatView
            threadId={sessionId}
            skin="session"
            runtime={runtime}
            workspaceRoot={root}
            onOpenFile={openFile}
            onOpenSubagent={(id) => select("agents", { agent: id })}
            onOpenDiff={(path, toolKey) =>
              void navigate({
                to: "/sessions/$sessionId/diff",
                params: { sessionId },
                search: (p: Record<string, unknown>) => ({
                  ...p,
                  path,
                  toolKey,
                  source: toolKey ? "tool" : "git",
                }),
                transition: "none",
              })
            }
            slots={{
              decorateMessage: (message, context) => {
                if (
                  message.role !== "assistant" ||
                  (context.runActive &&
                    context.index === context.messages.length - 1)
                )
                  return null;
                const source = message.metadata?.abacus?.segmentId;
                const segmentId =
                  typeof source === "string" ? source : message.id;
                return {
                  actions: (
                    <MessageFeedback
                      id={`${sessionId}:${segmentId}`}
                      send={(rating, comment) =>
                        transport.client.agent.feedback({
                          sessionId,
                          segmentId,
                          rating,
                          ...(comment ? { comment } : {}),
                        })
                      }
                    />
                  ),
                };
              },
              permissionActions: (descriptor) => (
                <SessionPermissionAction
                  request={
                    descriptor.metadata.abacus.request as PermissionRequest
                  }
                  conversationKey={key}
                  open={select}
                />
              ),
              runTail: (
                <SessionChangesCard
                  row={row}
                  finished={completed}
                  messages={host.messages}
                  outcomes={outcomes}
                  root={root ?? ""}
                  review={() => select("changes")}
                />
              ),
              composerContext: (
                <>
                  <SessionTasks messages={host.messages} />
                  <SessionContextTray
                    workspaceId={row.workspaceId}
                    sessionId={sessionId}
                    mode={row.mode}
                    busy={row.turn?.isBusy === true}
                    agentRunning={
                      row.status === "running" || row.status === "starting"
                    }
                  />
                </>
              ),
            }}
            composer={{
              mode: "full",
              sharedElement: true,
              placeholder: t("chat.composer.busySession"),
              attachmentsBase: root,
              attachmentContext: async () => ({
                workspaceId: row.workspaceId,
                sessionId: row.id,
              }),
              showModeChip: true,
              model: model.model,
              onResumeOnFreePool: model.onResumeOnFreePool,
              availableModes: model.availableModes,
              blocked: model.blocked,
              turnBusy: row.turn?.isBusy === true,
              mentions: {
                search: async (query) =>
                  (
                    await transport.client.files.search({ checkout, query })
                  ).items.map((item) => item.relativePath),
              },
              history: {
                list: () =>
                  transport.client.settings.promptHistory.list({ scope: key }),
                add: async (text) => {
                  await transport.client.settings.promptHistory.add({
                    scope: key,
                    prompt: text,
                  });
                },
              },
              setMode: async (mode: AgentMode) => {
                await collections.sessions.update(sessionId, (d) => {
                  d.mode = mode;
                }).isPersisted.promise;
                await transport.client.agent.setMode({
                  workspaceId: row.workspaceId,
                  sessionId,
                  mode,
                });
              },
              ...(row.routineId
                ? {
                    readOnly: {
                      reason: t("chat.composer.routineRun"),
                      action: (
                        <AppLink
                          to="/routines/$routineId"
                          params={{ routineId: row.routineId }}
                        >
                          {t("sessions.routine.talk")}
                        </AppLink>
                      ),
                    },
                  }
                : workspace?.status === "deleted" || model.missing
                  ? { readOnly: { reason: t("sessions.missing.folder") } }
                  : {}),
            }}
          />
        }
      />
      <Outlet />
    </>
  );
};
export const Route = createFileRoute("/_shell/(sessions)/sessions/$sessionId")({
  params: { parse: v.parser(v.object({ sessionId: SessionId })) },
  // Fixture rows have no main-side agent session. Replay them through the same
  // chat runtime as the gallery instead of asking main to load a missing id.
  beforeLoad: async ({ context, params }) => {
    if (import.meta.env.VITE_NEXT_DB_FIXTURES !== "1")
      return { chat: context.chat };
    const create = await loadFixtureRuntime();
    const fixture = create("session-review", {}, params.sessionId);
    if (fixture === null) throw new Error("Missing session-review fixture");
    return { chat: fixture.runtime };
  },
  validateSearch: SessionSearch,
  search: { middlewares: [stripSearchParams(SESSION_DEFAULTS)] },
  loader: async ({ context, params, preload, cause }) => {
    const { sessions, workspaces } = context.db.collections;
    await Promise.all([sessions.preload(), workspaces.preload()]);
    const row = sessions.get(params.sessionId);
    if (!row || row.editorFor) throw notFound();
    if (row.owner?.kind === "bot")
      throw redirect({
        to: "/bots/$botId",
        params: { botId: row.owner.botId },
        replace: true,
      });
    const chat = chatLoading(context);
    // A hover fetches the first page only; the click builds the session.
    if (preload) chat.warm(params.sessionId);
    else {
      await context.prepareChat();
      // The router also calls parameter changes "stay" for this route id.
      if (cause !== "stay" || !context.chat.session(params.sessionId).ready)
        await chat.load(params.sessionId);
    }
  },
  notFoundComponent: SessionGone,
  component: SessionRoute,
});
