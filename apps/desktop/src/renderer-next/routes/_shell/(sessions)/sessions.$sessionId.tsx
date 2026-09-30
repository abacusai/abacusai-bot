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
} from "#next/features/chat";
import {
  SessionIdentity,
  SessionWorkspace,
  useSession,
  useWorkspace,
  useSessionComposerModel,
  SessionContextTray,
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
import type { AgentMode } from "#shared/agent-types";
import { SessionId } from "#shared/contract/ids";
import { sessionConversationKey } from "#shared/conversation-scope";

import { sessionRuntime } from "./-runtime";
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
const SessionRoute = () => {
  const { sessionId } = Route.useParams();
  const { transport } = Route.useRouteContext();
  const { t } = useTranslation();
  const navigate = useAppNavigate();
  const collections = useCollections();
  const row = useSession(sessionId);
  const workspace = useWorkspace(row?.workspaceId ?? "");
  const model = useSessionComposerModel(row);
  const runtime = sessionRuntime(transport, sessionId);
  const session = runtime.session(sessionId);
  const host = useSelector(session.hostStore, (s) => s);
  const incarnation = useSelector(host.store, (s) => s.incarnation);
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
        renderAgent={(id) => (
          <SubagentDetail
            runtime={runtime}
            threadId={sessionId}
            subagentRunId={id}
          />
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
              composerContext: (
                <SessionContextTray
                  workspaceId={row.workspaceId}
                  sessionId={sessionId}
                  mode={row.mode}
                  busy={row.turn?.isBusy === true}
                />
              ),
            }}
            composer={{
              mode: "full",
              placeholder: t("chat.composer.busySession"),
              attachmentsBase: root,
              showModeChip: true,
              model: model.model,
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
                ? { readOnly: { reason: t("chat.composer.routineRun") } }
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
    if (!preload && cause !== "stay")
      await sessionRuntime(context.transport, params.sessionId)
        .session(params.sessionId)
        .load();
  },
  notFoundComponent: SessionGone,
  component: SessionRoute,
});
