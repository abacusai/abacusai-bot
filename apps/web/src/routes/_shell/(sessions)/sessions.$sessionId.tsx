import {
  createFileRoute,
  notFound,
  stripSearchParams,
  Outlet,
  redirect,
} from "@tanstack/react-router";
import { useSelector } from "@tanstack/react-store";
import {
  lazy,
  Suspense,
  useEffect,
  useEffectEvent,
  type ComponentProps,
} from "react";
import { useTranslation } from "react-i18next";
import * as v from "valibot";

import { ComposerUpdateNotice } from "#platform/updates";
import { useCollections } from "#renderer/data/db";
import { usePrefs } from "#renderer/data/db/prefs";
import { loadFixtureRuntime } from "#renderer/features/chat/fixture-runtime";
import { ChatView } from "#renderer/features/chat/kit/lazy-view";
import { AgentsList } from "#renderer/features/chat/kit/subagents/agents-list";
import { useSubagents } from "#renderer/features/chat/kit/subagents/use-subagents";
import {
  AGENT_BROWSER_TAB,
  hasAgentBrowserTab,
} from "#renderer/features/sessions/dock/agent-browser";
import { openStartDraft } from "#renderer/features/sessions/start/start-session";
import { updateDraft } from "#renderer/lib/continuity/composer-drafts";
import { IS_ELECTRON } from "#renderer/lib/platform";
import { platformSystem } from "#renderer/lib/platform-system";
/**
 * The chat's Markdown for text a dock tab shows (a PR's description and
 * conversation). That text is anyone's, so it renders untrusted: no
 * visualizers or math, and only http(s)/mailto links open, outside.
 */
const TabMarkdown = lazy(() =>
  import("#renderer/features/chat/markdown/markdown").then((m) => ({
    default: ({
      text,
      openExternal,
    }: {
      text: string;
      openExternal(url: string): void;
    }) => (
      <m.MarkdownLinksProvider value={{ openFile: () => {}, openExternal }}>
        <m.Markdown content={text} role="user" untrusted />
      </m.MarkdownLinksProvider>
    ),
  }))
);
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
import { feedbackSegmentId } from "@abacus-ai/contract/transcript/feedback-target";

import { EmptyState } from "#renderer/components/empty-state";
import { hasInAppViewer, isUrl } from "#renderer/components/file-preview";
import { MessageFeedback } from "#renderer/components/message-feedback";
import { chatLoading } from "#renderer/features/chat/runtime/lazy-runtime";
import { type ChatRuntime } from "#renderer/features/chat/runtime/runtime";
import { SessionChangesCard } from "#renderer/features/sessions/changes/changes-card";
import {
  deliverablesAfter,
  rowEndIndex,
  sessionDeliverablesCard,
  type SessionDeliverablesOptions,
} from "#renderer/features/sessions/chat/deliverables";
import { SessionKnownFiles } from "#renderer/features/sessions/chat/known-files";
import { SessionContextTray } from "#renderer/features/sessions/context/context-tray";
import { SessionPermissionAction } from "#renderer/features/sessions/context/permission-terminal-action";
import { SessionTasks } from "#renderer/features/sessions/context/tasks";
import { useSessionComposerModel } from "#renderer/features/sessions/data/composer-model";
import {
  useSession,
  useWorkspace,
} from "#renderer/features/sessions/data/queries";
import { openSessionOnce } from "#renderer/features/sessions/data/unread-store";
import {
  awaitTabDraw,
  openTab,
  panelTabsStore,
} from "#renderer/features/sessions/dock/panel-tabs-store";
import {
  isAbsolutePreviewPath,
  previewTargetPath,
} from "#renderer/features/sessions/files/preview-target";
import { SessionWorkspace } from "#renderer/features/sessions/session-workspace";
import { SessionIdentity } from "#renderer/features/sessions/sessions-pages";
import {
  APP_HOTKEYS,
  useAppHotkey,
  dispatchAppHotkey,
} from "#renderer/features/shell/hotkeys";
import { nativePresenterFor } from "#renderer/features/shell/platform-presenter";
import {
  claimStoredPreview,
  registerPreviewConsumer,
} from "#renderer/features/shell/preview-consumers";
import { shellStore } from "#renderer/features/shell/shell-store";
import { SidePanelOverride } from "#renderer/features/shell/side-panel-slot";
import { TopBarSlot } from "#renderer/features/shell/top-bar-slots";
import { AppLink } from "#renderer/lib/navigation/app-link";
import {
  SESSION_DEFAULTS,
  SessionSearch,
} from "#renderer/lib/navigation/search";
import { useAppNavigate } from "#renderer/lib/navigation/use-app-navigate";
import { useVisibleThread } from "#renderer/lib/navigation/visible-thread";
import { Button } from "#renderer/ui/button";

const SessionAgents = ({
  runtime,
  threadId,
  selected,
  workspaceRoot,
  onOpenFile,
  onOpenDiff,
}: {
  runtime: ChatRuntime;
  threadId: string;
  selected: string | undefined;
  workspaceRoot: string | null;
  onOpenFile: (path: string) => void;
  onOpenDiff: (path: string, toolKey?: string) => void;
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
        <AgentsList
          runtime={runtime}
          threadId={threadId}
          selected={selected}
          onSelect={(id) =>
            void navigate({
              to: ".",
              search: (p: Record<string, unknown>) => ({ ...p, agent: id }),
              replace: true,
              transition: "none",
            })
          }
        />
      )}
      {selected ? (
        <>
          <Suspense fallback={null}>
            <SubagentDetail
              runtime={runtime}
              threadId={threadId}
              subagentRunId={selected}
              workspaceRoot={workspaceRoot}
              onOpenFile={onOpenFile}
              onOpenDiff={onOpenDiff}
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
  files,
  open,
}: {
  conversationKey: string;
  files: Parameters<typeof claimStoredPreview>[0];
  open: (path?: string, url?: string) => boolean | Promise<boolean>;
}) => {
  const receive = useEffectEvent(open);
  const claim = useEffectEvent(
    (open: Parameters<typeof claimStoredPreview>[2], signal: AbortSignal) =>
      claimStoredPreview(files, conversationKey, open, signal)
  );
  useEffect(() => {
    const consumer = {
      owns: (key: string | undefined) =>
        key === undefined || key === conversationKey,
      open: (event: { path?: string; url?: string }) =>
        receive(event.path, event.url),
    };
    const unregister = registerPreviewConsumer(consumer);
    // What `present_deliverable` stored while this pane was not mounted.
    const abort = new AbortController();
    void claim(consumer.open, abort.signal);
    return () => {
      abort.abort();
      unregister();
    };
  }, [conversationKey]);
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
/** Messages stream in here, not in the route, so the dock is not re-rendered per tick. */
const LiveChangesCard = ({
  session,
  ...props
}: { session: ReturnType<ChatRuntime["session"]> } & Omit<
  ComponentProps<typeof SessionChangesCard>,
  "messages"
>) => (
  <SessionChangesCard
    {...props}
    messages={useSelector(session.hostStore, (s) => s.messages)}
  />
);
const LiveTasks = ({
  session,
  plan,
}: {
  session: ReturnType<ChatRuntime["session"]>;
  plan: ComponentProps<typeof SessionTasks>["plan"];
}) => (
  <SessionTasks
    messages={useSelector(session.hostStore, (s) => s.messages)}
    plan={plan}
  />
);
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
  const prefs = usePrefs();
  const session = runtime.session(sessionId);
  // Only the inner store handle: the host state also carries the streaming
  // messages, and subscribing to it here would re-render the route (and the
  // dock under it) on every stream tick.
  const hostCore = useSelector(session.hostStore, (s) => s.store);
  const incarnation = useSelector(hostCore, (s) => s.incarnation);
  const outcomes = useSelector(hostCore, (s) => s.runs.outcomes);
  const plan = useSelector(hostCore, (s) => s.agent?.plan);
  const completed = useSelector(
    hostCore,
    (s) => s.runs.active === null && s.runs.outcomes.at(-1)?.kind === "success"
  );
  const presenter = nativePresenterFor(transport.client);
  useEffect(() => {
    openSessionOnce(sessionId);
  }, [sessionId]);
  // The primary pane's thread (never a read-only beside pane) is the one the
  // user sees: completion neither marks it unread nor sounds, and the agent
  // browser's adoption reads the same fact.
  useVisibleThread(row ? sessionId : null);
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
  const openDiff = (path: string, toolKey?: string) =>
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
    });
  const openUrl = (url?: string) => {
    const existing = url
      ? panelTabsStore.state[key]?.tabs.find(
          (tab) => tab.ref.startsWith("browser:") && tab.url === url
        )
      : undefined;
    const ref = existing?.ref ?? `browser:${crypto.randomUUID()}`;
    openTab(key, { ref, title: url ?? t("sessions.dock.browser"), url });
    select(ref);
    return ref;
  };
  const openFile = (path: string): string | undefined => {
    if (isUrl(path)) return openUrl(path);
    // Inside the checkout, or any absolute file the panel has a viewer for
    // (guest `/workspace/...` paths map onto the checkout). What it cannot
    // show goes to the OS: only reached from an explicit click.
    const target = previewTargetPath(path, root);
    const inside = target !== null && !isAbsolutePreviewPath(target);
    if (target === null || (!inside && !hasInAppViewer(target))) {
      void platformSystem(transport.client).openPath({ path });
      return;
    }
    const relative = target;
    // A file already open in the panel is focused, not opened twice.
    const existing = panelTabsStore.state[key]?.tabs.find(
      (tab) => tab.ref.startsWith("preview:") && tab.path === relative
    );
    const ref = existing?.ref ?? `preview:${crypto.randomUUID()}`;
    openTab(key, {
      ref,
      title: path.split("/").at(-1) ?? path,
      path: relative,
    });
    select(ref);
    return ref;
  };
  const deliverableOptions: SessionDeliverablesOptions = {
    workspaceRoot: root,
    onOpenFile: openFile,
    onOpenUrl: openUrl,
    onOpenExternal: (url) =>
      void platformSystem(transport.client).openExternal({ url }),
    onReveal: IS_ELECTRON
      ? (path) => void transport.client.system.showItemInFolder({ path })
      : undefined,
  };
  return (
    <>
      <PreviewRegistration
        conversationKey={key}
        files={transport.client.files}
        open={(path, url) => {
          // `present_deliverable` opens the panel unasked, so only what the
          // panel can show: a URL, or a workspace file with an in-app viewer.
          // Anything else never launches another app on its own.
          let ref: string | undefined;
          if (path && isUrl(path)) ref = openUrl(path);
          else if (path) {
            if (previewTargetPath(path, root) !== null && hasInAppViewer(path))
              ref = openFile(path);
          } else if (hasAgentBrowserTab(key)) {
            // The agent's own browser follows the agent; a second view
            // of the URL would not.
            select(AGENT_BROWSER_TAB);
            ref = AGENT_BROWSER_TAB;
          } else if (url) ref = openUrl(url);
          // "Shown" only once the tab's page actually drew.
          return ref == null ? false : awaitTabDraw(key, ref);
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
        renderMarkdown={(text) => (
          <TabMarkdown
            text={text}
            openExternal={(url) =>
              void platformSystem(transport.client).openExternal({ url })
            }
          />
        )}
        renderAgent={(id) => (
          <SessionAgents
            runtime={runtime}
            threadId={sessionId}
            selected={id}
            workspaceRoot={root}
            onOpenFile={openFile}
            onOpenDiff={openDiff}
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
            onOpenDiff={openDiff}
            slots={{
              composerNotice: (
                <>
                  <SessionKnownFiles sessionId={sessionId} />
                  <ComposerUpdateNotice />
                </>
              ),
              renderDeliverables: (items) =>
                sessionDeliverablesCard(items, deliverableOptions),
              decorateMessage: (message, context) => {
                if (message.role !== "assistant") return null;
                // A coalesced row is keyed by its host; the turn's carrier
                // may be any message folded into it, so use the last of them.
                const at = rowEndIndex(message, context);
                const files =
                  at < 0
                    ? null
                    : deliverablesAfter(
                        context.messages,
                        at,
                        context.runActive
                      );
                const after =
                  files == null
                    ? undefined
                    : sessionDeliverablesCard(files, deliverableOptions);
                if (context.runActive && at === context.messages.length - 1)
                  return after != null ? { after } : null;
                // Keyed on the stored host message, not the shown row: the
                // key counts stored parts, and the tool-only messages folded
                // in after it hold no text. Nothing spoken, nothing to rate.
                const stored = context.messages.find(
                  (row) => row.id === message.id
                );
                const segmentId =
                  stored == null ? null : feedbackSegmentId(stored);
                if (segmentId == null) return after != null ? { after } : null;
                return {
                  ...(after != null ? { after } : {}),
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
                <LiveChangesCard
                  session={session}
                  row={row}
                  finished={completed}
                  outcomes={outcomes}
                  root={root ?? ""}
                  review={() => select("changes")}
                />
              ),
              composerTasks: <LiveTasks session={session} plan={plan} />,
              composerContext: (
                <SessionContextTray
                  workspaceId={row.workspaceId}
                  sessionId={sessionId}
                  mode={row.mode}
                  busy={row.turn?.isBusy === true}
                  agentRunning={
                    row.status === "running" || row.status === "starting"
                  }
                />
              ),
            }}
            composer={{
              mode: "full",
              sharedElement: true,
              placeholder: t("chat.composer.mini"),
              attachmentsBase: root,
              attachmentContext: async () => ({
                workspaceId: row.workspaceId,
                sessionId: row.id,
              }),
              showModeChip: true,
              model: model.model,
              onResumeOnFreePool: model.onResumeOnFreePool,
              onNewChat: () =>
                void navigate({
                  to: "/sessions/new",
                  search: {
                    workspace: row.workspaceId,
                    draft: openStartDraft(undefined, row.workspaceId),
                  },
                  transition: "nav-lateral",
                }),
              onResumeOnModel: model.onResumeOnModel,
              onSwitchThisChat: model.onSwitchThisChat,
              availableModes: model.availableModes,
              defaultMode: row.mode ?? prefs.defaultMode,
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
                // The server owns `mode`: a db patch would be refused, so tell
                // the agent and let its state echo come back through the row.
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
