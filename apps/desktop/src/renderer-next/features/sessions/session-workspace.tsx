import { useQuery } from "@tanstack/react-query";
import { useSearch } from "@tanstack/react-router";
import {
  useEffect,
  useState,
  type ReactNode,
  type ComponentProps,
} from "react";
import { useTranslation } from "react-i18next";

import { BrowserSurface } from "#next/components/browser-surface";
import { ConnectorRequestCard } from "#next/components/connector-request-card";
import type { TerminalAction } from "#next/components/terminal/keys";
import { useConnectorRequests } from "#next/lib/connector-requests";
import { useAppNavigate } from "#next/lib/navigation/use-app-navigate";
import { Button } from "#next/ui/button";
import type { SessionRow } from "#shared/contract/rows";
import { sessionConversationKey } from "#shared/conversation-scope";

import { BrowserTab } from "./browser/browser-tab";
import { ChangesTab } from "./changes/changes-tab";
import { WorkspaceMissing } from "./context/workspace-missing";
import { useAgentLifecycle } from "./data/agent-start";
import {
  useWorkspace,
  useSessionsTransport,
  useCheckoutQueries,
  useCheckoutWatch,
  effectiveCheckoutIdentity,
} from "./data/queries";
import { DeviceTab } from "./device/device-tab";
import { openTab } from "./dock/panel-tabs-store";
import { SessionDock, type SessionDockProps } from "./dock/session-dock";
import { FilesTab, SessionFilePreview } from "./files/files-tab";
import { TerminalTab } from "./terminal/terminal-tab";
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
  const select = (tab: string, extra: Record<string, unknown> = {}) =>
    void navigate({
      to: ".",
      search: (p: Record<string, unknown>) => ({ ...p, tab, ...extra }),
      replace: true,
      transition: "none",
    } as never);
  const preview = (path: string) => {
    const ref = `preview:${crypto.randomUUID()}`;
    openTab(key, { ref, title: path.split("/").at(-1) ?? path, path });
    select(ref);
  };
  const local = (path: string, visible = true) => (
    <BrowserTab
      row={row}
      id={`file-${row.id}`}
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
      transition: "modal-open",
    } as never);
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
                  renderLocal={(path) => local(path, visible)}
                />
              );
            if (tab.ref === "files")
              return (
                <FilesTab
                  row={row}
                  root={root}
                  onPreview={preview}
                  renderLocal={(path) => local(path, visible)}
                />
              );
            if (tab.ref === "changes")
              return <ChangesTab row={row} root={root} onDiff={openDiff} />;
            if (tab.ref === "agents") return renderAgent(search.agent);
            return <DeviceTab visible={visible} />;
          }}
        />
      </div>
    </div>
  );
};
