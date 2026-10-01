import {
  createFileRoute,
  notFound,
  stripSearchParams,
  Outlet,
  redirect,
} from "@tanstack/react-router";
import { useSelector } from "@tanstack/react-store";
import { useEffect, useEffectEvent } from "react";
import { useTranslation } from "react-i18next";
import * as v from "valibot";

import { useCollections } from "#next/data/db";
import {
  ChatView,
  deriveSessionTitle,
  SubagentDetail,
  useSubagents,
  updateDraft,
  type ChatRuntime,
} from "#next/features/chat";
import {
  SessionIdentity,
  SessionWorkspace,
  useSession,
  useWorkspace,
  useSessionComposerModel,
  SessionContextTray,
  SessionTasks,
  SessionPermissionAction,
  SessionChangesCard,
  openSessionOnce,
  openTab,
} from "#next/features/sessions";
import {
  APP_HOTKEYS,
  shellStore,
  TopBarSlot,
  SidePanelOverride,
  useAppHotkey,
  dispatchAppHotkey,
  nativePresenterFor,
  registerPreviewConsumer,
} from "#next/features/shell";
import { AppLink } from "#next/lib/navigation/app-link";
import { SESSION_DEFAULTS, SessionSearch } from "#next/lib/navigation/search";
import { useAppNavigate } from "#next/lib/navigation/use-app-navigate";
import { Button } from "#next/ui/button";
import type { AgentMode, PermissionRequest } from "#shared/agent-types";
import { SessionId } from "#shared/contract/ids";
import { sessionConversationKey } from "#shared/conversation-scope";

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
        <p>{t("sessions.agents.empty")}</p>
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
              } as never)
            }
          >
            {agent.name} · {agent.status}
          </Button>
        ))
      )}
      {selected ? (
        <>
          <SubagentDetail
            runtime={runtime}
            threadId={threadId}
            subagentRunId={selected}
          />
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
              } as never);
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
}: {
  next: () => void;
  previous: () => void;
  close: () => void;
}) => {
  useAppHotkey(APP_HOTKEYS.nextTab, next);
  useAppHotkey(APP_HOTKEYS.previousTab, previous);
  useAppHotkey(
    document.documentElement.dataset.platform === "darwin"
      ? APP_HOTKEYS.closeTab
      : "Control+Shift+W",
    close,
    { actionId: "closeTab" }
  );
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
  return (
    <div
      role="status"
      className="flex h-full flex-col items-center justify-center gap-3"
    >
      <p>{t("sessions.gone")}</p>
      <AppLink to="/sessions/new">{t("sessions.sidebar.new")}</AppLink>
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
    } as never);
  const openFile = (path: string) => {
    if (!root || !path.startsWith(`${root}/`)) {
      void transport.client.system.openPath({ path });
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
        registerHotkeys={(next, previous, close) => (
          <DockHotkeys next={next} previous={previous} close={close} />
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
              } as never)
            }
            slots={{
              permissionActions: (descriptor) => (
                <SessionPermissionAction
                  request={
                    descriptor.metadata.abacus.request as PermissionRequest
                  }
                  conversationKey={key}
                  open={select}
                />
              ),
              banner:
                model.blocked === "no-model" ? (
                  <Button onClick={model.onBlocked}>
                    {t("sessions.model.configure")}
                  </Button>
                ) : undefined,
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
              placeholder: t("chat.composer.busySession"),
              attachmentsBase: root,
              showModeChip: true,
              model: model.model,
              onBlocked: model.onBlocked,
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
              onFirstSend: (text) => {
                if (row.label.trim() && row.label !== "Untitled") return;
                const label = deriveSessionTitle(text);
                if (label)
                  collections.sessions.update(sessionId, (d) => {
                    d.label = label;
                  });
              },
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
    const session = context.chat.session(params.sessionId);
    // The router also calls parameter changes "stay" for this route id.
    if (!preload && (cause !== "stay" || !session.ready)) await session.load();
  },
  notFoundComponent: SessionGone,
  component: SessionRoute,
});
