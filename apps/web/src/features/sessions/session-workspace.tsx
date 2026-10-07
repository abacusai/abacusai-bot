import type { SessionRow } from "@abacus-ai/contract/contract/rows";
import { sessionConversationKey } from "@abacus-ai/contract/conversation-scope";
import { useQuery } from "@tanstack/react-query";
import { useSearch } from "@tanstack/react-router";
import {
  lazy,
  Suspense,
  useEffect,
  useState,
  type ReactNode,
  type ComponentProps,
} from "react";
import { useTranslation } from "react-i18next";

import type { BrowserSurface } from "#renderer/components/browser-surface";
import { ConnectorRequestCard } from "#renderer/components/connector-request-card";
import type { TerminalAction } from "#renderer/components/terminal/keys";
import { useConnectorRequests } from "#renderer/lib/connector-requests";
import { whenIdle } from "#renderer/lib/idle";
import { useAppNavigate } from "#renderer/lib/navigation/use-app-navigate";
import { Button } from "#renderer/ui/button";

import { WorkspaceMissing } from "./context/workspace-missing";
import { useAgentLifecycle } from "./data/agent-start";
import {
  useWorkspace,
  useSessionsTransport,
  useCheckoutQueries,
  useCheckoutWatch,
  effectiveCheckoutIdentity,
} from "./data/queries";
import { openTab, updateTab } from "./dock/panel-tabs-store";
import { SessionDock, type SessionDockProps } from "./dock/session-dock";
const BrowserTab = lazy(() =>
  import("#platform/browser-tab").then((m) => ({ default: m.BrowserTab }))
);
const ChangesTab = lazy(() =>
  import("./changes/changes-tab").then((m) => ({ default: m.ChangesTab }))
);
const DeviceTab = lazy(() =>
  import("#platform/device-tab").then((m) => ({ default: m.DeviceTab }))
);
const loadTerminalTab = () => import("./terminal/terminal-tab");
const loadFilesTab = () => import("./files/files-tab");
const TerminalTab = lazy(() =>
  loadTerminalTab().then((m) => ({ default: m.TerminalTab }))
);
const FilesTab = lazy(() =>
  loadFilesTab().then((m) => ({ default: m.FilesTab }))
);
const SessionFilePreview = lazy(() =>
  loadFilesTab().then((m) => ({ default: m.SessionFilePreview }))
);
export const SessionWorkspace = ({
  row,
  chat,
  incarnation,
  renderAgent,
  renderSession,
  registerHotkeys,
  dispatch,
  presenter,
  blocked,
}: {
  row: SessionRow;
  chat: ReactNode;
  incarnation: string | null;
  renderAgent: (id: string | undefined) => ReactNode;
  renderSession: (id: string) => ReactNode;
  registerHotkeys: SessionDockProps["registerHotkeys"];
  dispatch: (id: TerminalAction) => void;
  presenter: ComponentProps<typeof BrowserSurface>["presenter"];
  blocked: (rect: DOMRect) => boolean;
}) => {
  const { t } = useTranslation();
  const transport = useSessionsTransport();
  const navigate = useAppNavigate();
  const workspace = useWorkspace(row.workspaceId);
  const checkout = { workspaceId: row.workspaceId, sessionId: row.id };
  const status = useQuery(
    useCheckoutQueries(checkout).checkoutStatus(checkout)
  );
  const root = status.data?.path ?? row.worktreePath ?? workspace?.path ?? "";
  const key = sessionConversationKey(row.workspaceId, row.id);
  const search = useSearch({ strict: false }) as { agent?: string };
  const requests = useConnectorRequests(transport, key);
  const [error, setError] = useState<unknown>(null);
  const controller = useAgentLifecycle(transport.client, row, setError);
  useEffect(() => {
    controller.observe(row, status.data?.exists === true, incarnation);
  }, [controller, row, status.data?.exists, incarnation]);
  useEffect(() => {
    if (status.data?.exists === false) controller.unavailable();
  }, [status.data?.exists, controller]);
  const checkoutIdentity = effectiveCheckoutIdentity(
    row.workspaceId,
    row,
    workspace?.path
  );
  useCheckoutWatch(transport, checkout, checkoutIdentity);
  // The two tabs a session opens most: their chunks load while idle, so
  // the first switch to one does not wait on the network.
  useEffect(
    () =>
      whenIdle(() => {
        void loadTerminalTab().catch(() => undefined);
        void loadFilesTab().catch(() => undefined);
      }),
    []
  );
  const select = (tab: string, extra: Record<string, unknown> = {}) =>
    void navigate({
      to: ".",
      search: (p: Record<string, unknown>) => ({ ...p, tab, ...extra }),
      replace: true,
      transition: "none",
    });
  const preview = (path: string) => {
    const ref = `preview:${crypto.randomUUID()}`;
    openTab(key, { ref, title: path.split("/").at(-1) ?? path, path });
    select(ref);
  };
  const local = (path: string, owner: string, visible = true) => (
    <BrowserTab
      key={`${owner}:${checkoutIdentity}`}
      row={row}
      id={`file-${row.id}-${owner}`}
      root={root}
      file={path}
      visible={visible}
      presenter={presenter}
      blocked={blocked}
    />
  );
  const openDiff = (path: string, scope: "staged" | "unstaged") =>
    void navigate({
      to: "/sessions/$sessionId/diff",
      params: { sessionId: row.id },
      search: (p: Record<string, unknown>) => ({
        ...p,
        path,
        scope,
        source: "git",
      }),
      // A pop-up over this pane, like the other masked sheets.
      transition: "none",
    });
  return (
    <div className="flex size-full min-h-0 flex-col">
      {status.data?.exists === false ? (
        <div role="alert" className="bg-muted flex items-center gap-2 p-3">
          <p>
            {t(
              status.data.kind === "worktree"
                ? "sessions.missing.worktree"
                : "sessions.missing.folder"
            )}
          </p>
          <Button onClick={() => void status.refetch()}>
            {t("sessions.common.retry")}
          </Button>
          {status.data.kind !== "worktree" ? (
            <WorkspaceMissing
              workspaceId={row.workspaceId}
              retry={() => void status.refetch()}
              removed={() =>
                void navigate({
                  to: "/sessions/new",
                  transition: "nav-lateral",
                })
              }
            />
          ) : null}
          {status.data.kind === "worktree" ? (
            <Button
              onClick={() =>
                void transport.client.git.worktrees
                  .setForSession({
                    workspaceId: row.workspaceId,
                    sessionId: row.id,
                    worktreeId: null,
                  })
                  .then(() => {
                    controller.retry({
                      ...row,
                      worktreeId: null,
                      worktreePath: null,
                    });
                    return status.refetch();
                  })
              }
            >
              {t("sessions.missing.primary")}
            </Button>
          ) : null}
        </div>
      ) : null}
      {error ? (
        <div role="alert" className="p-3">
          <p>{String(error)}</p>
          <Button onClick={() => controller.retry(row)}>
            {t("sessions.common.retry")}
          </Button>
        </div>
      ) : null}
      {requests.current ? (
        <ConnectorRequestCard
          request={requests.current}
          busy={requests.busy}
          error={requests.error}
          onConnect={requests.connect}
          onDecline={requests.decline}
          onStop={requests.stop}
        />
      ) : null}
      <div className="min-h-0 flex-1">
        <Suspense
          fallback={
            <div role="status" className="p-3">
              {t("common.loading")}
            </div>
          }
        >
          <SessionDock
            row={row}
            chat={chat}
            registerHotkeys={registerHotkeys}
            renderTab={(tab, visible, onClose) => {
              if (tab.ref.startsWith("terminal:"))
                return (
                  <TerminalTab
                    row={row}
                    id={tab.ref.slice(9)}
                    shell={tab.shell}
                    visible={visible}
                    onClose={onClose}
                    dispatch={dispatch}
                    onUrl={(url) => {
                      const ref = `browser:${crypto.randomUUID()}`;
                      openTab(key, { ref, title: url, url });
                      select(ref);
                    }}
                  />
                );
              if (tab.ref.startsWith("browser:"))
                return (
                  <BrowserTab
                    row={row}
                    id={tab.ref.slice(8)}
                    url={tab.url}
                    onState={({ url }) => updateTab(key, tab.ref, { url })}
                    visible={visible}
                    root={root}
                    presenter={presenter}
                    blocked={blocked}
                  />
                );
              if (tab.sessionId) return renderSession(tab.sessionId);
              if (tab.ref.startsWith("preview:"))
                return (
                  <SessionFilePreview
                    path={tab.path ?? ""}
                    root={root}
                    renderLocal={(path) => local(path, tab.ref, visible)}
                  />
                );
              if (tab.ref === "files")
                return (
                  <FilesTab
                    row={row}
                    root={root}
                    onPreview={preview}
                    renderLocal={(path) => local(path, tab.ref, visible)}
                  />
                );
              if (tab.ref === "changes")
                return <ChangesTab row={row} root={root} onDiff={openDiff} />;
              if (tab.ref === "agents") return renderAgent(search.agent);
              return <DeviceTab visible={visible} />;
            }}
          />
        </Suspense>
      </div>
    </div>
  );
};
