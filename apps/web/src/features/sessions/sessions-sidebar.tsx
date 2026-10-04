import { useLiveQuery } from "@tanstack/react-db";
import { useQuery } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { useSelector } from "@tanstack/react-store";
import { Folder, Plus } from "lucide-react";
/**
 * The Sessions sidebar (spec 01 §7.3, canvas `SessionsSidebar`): sessions
 * that are not a bot's chat, a routine run or a routine editor, grouped by
 * their workspace (routine and bot folders excluded), pinned ones first, each
 * group newest first, groups collapsible (prefs.workspaceExpanded).
 */
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { NavList } from "#renderer/components/nav-list";
import { useDb } from "#renderer/data/db";
import { useCollections } from "#renderer/data/db";
import { isListedSession, isListedWorkspace } from "#renderer/data/db/filters";
import { usePrefs, useUpdatePrefs } from "#renderer/data/db/prefs";
import { useCollectionStatus } from "#renderer/data/db/status";
import { usePendingConnectorAsks } from "#renderer/lib/connector-requests";
import { formatChatStamp } from "#renderer/lib/format/chat-stamp";
import { AppLink } from "#renderer/lib/navigation/app-link";
import { useAppNavigate } from "#renderer/lib/navigation/use-app-navigate";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from "#renderer/ui/alert-dialog";
import { Button } from "#renderer/ui/button";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
} from "#renderer/ui/context-menu";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "#renderer/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
} from "#renderer/ui/dropdown-menu";
import { Input } from "#renderer/ui/input";
import type { SessionRow, WorkspaceRow } from "@abacus-ai/contract/contract";
import { sessionConversationKey } from "@abacus-ai/contract/conversation-scope";

import { WorkspaceMissing } from "./context/workspace-missing";
import { sessionAttention } from "./data/attention";
import { useSessionsTransport } from "./data/queries";
import { renameSession, deleteSession } from "./data/session-actions";
import { sessionsUnreadStore, markSessionUnread } from "./data/unread-store";
import { openTab } from "./dock/panel-tabs-store";
import { newStartDraft, startDraftStore } from "./start/start-session";

export interface SessionGroups {
  pinned: SessionRow[];
  groups: Array<{ workspace: WorkspaceRow; sessions: SessionRow[] }>;
}

const newestFirst = (a: SessionRow, b: SessionRow): number =>
  Date.parse(b.updatedAt) - Date.parse(a.updatedAt);

export const groupSessions = (
  sessions: readonly SessionRow[],
  workspaces: readonly WorkspaceRow[],
  pinnedIds: readonly string[]
): SessionGroups => {
  const listedWorkspaces = workspaces.filter(isListedWorkspace);
  const ids = new Set(listedWorkspaces.map((workspace) => workspace.id));
  const listed = sessions.filter(
    (session) => isListedSession(session) && ids.has(session.workspaceId)
  );
  const pinned = pinnedIds
    .map((id) => listed.find((session) => session.id === id))
    .filter((session): session is SessionRow => session != null);
  const rest = listed.filter((session) => !pinnedIds.includes(session.id));
  return {
    pinned,
    groups: listedWorkspaces
      .map((workspace) => ({
        workspace,
        sessions: rest
          .filter((session) => session.workspaceId === workspace.id)
          .toSorted(newestFirst),
      }))
      .filter((group) => group.sessions.length > 0),
  };
};

export const SessionsSidebar = () => {
  const { t } = useTranslation();
  const collections = useCollections();
  const transport = useSessionsTransport();
  const navigate = useAppNavigate();
  const [dropError, setDropError] = useState<string | null>(null);
  const prefs = usePrefs();
  const updatePrefs = useUpdatePrefs();
  const { data: sessions } = useLiveQuery(collections.sessions);
  const { data: workspaces } = useLiveQuery(collections.workspaces);
  const sessionsStatus = useCollectionStatus(collections.sessions);
  const workspacesStatus = useCollectionStatus(collections.workspaces);
  const asks = usePendingConnectorAsks(useSessionsTransport());
  const [query, setQuery] = useState("");
  const params = useParams({ strict: false }) as { sessionId?: string };
  const needs = (sessions ?? []).filter(
    (s) =>
      isListedSession(s) &&
      sessionAttention(
        s,
        false,
        asks[sessionConversationKey(s.workspaceId, s.id)] ?? 0
      ).kind === "needs-you" &&
      s.label.toLowerCase().includes(query.toLowerCase())
  );
  const needsIds = new Set(needs.map((s) => s.id));
  const { pinned, groups } = groupSessions(
    (sessions ?? []).filter(
      (s) =>
        !needsIds.has(s.id) &&
        s.label.toLowerCase().includes(query.toLowerCase())
    ),
    workspaces ?? [],
    prefs.pinned.sessionIds
  );
  const status =
    sessionsStatus === "error" || workspacesStatus === "error"
      ? "error"
      : sessionsStatus === "ready" && workspacesStatus === "ready"
        ? "ready"
        : "loading";

  const row = (session: SessionRow, indent: boolean) => (
    <SessionSidebarRow
      key={session.id}
      session={session}
      indent={indent}
      active={params.sessionId === session.id}
      asks={asks[sessionConversationKey(session.workspaceId, session.id)] ?? 0}
      query={query}
      workspaceLabel={
        workspaces?.find((w) => w.id === session.workspaceId)?.label ?? ""
      }
    />
  );

  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) e.preventDefault();
      }}
      onDrop={(e) => {
        if (!e.dataTransfer.files.length) return;
        e.preventDefault();
        const path = transport.host.getPathForFile?.(e.dataTransfer.files[0]!);
        if (!path) return;
        void transport.client.workspaces
          .add({ path })
          .then(async (result) => {
            if (!result.workspaceId)
              throw new Error(t("shell.sidebar.loadError"));
            await collections.workspaces.utils.resync();
            await navigate({
              to: "/sessions/new",
              search: { workspace: result.workspaceId },
              transition: "nav-forward",
            });
          })
          .catch((error) => setDropError(String(error)));
      }}
    >
      <NavList.Root label={t("sessions.sidebar.label")}>
        <NavList.Header title={t("sessions.sidebar.label")}>
          <NavList.Action
            label={t("sessions.sidebar.new")}
            render={<AppLink to="/sessions/new" transition="nav-lateral" />}
          >
            <Plus />
          </NavList.Action>
        </NavList.Header>
        <Input
          className="mb-2"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label={t("sessions.sidebar.search")}
          placeholder={t("sessions.sidebar.search")}
        />
        {dropError ? <p role="alert">{dropError}</p> : null}
        {status === "error" ? (
          <NavList.Error
            message={t("shell.sidebar.loadError")}
            retryLabel={t("shell.sidebar.retry")}
            onRetry={() => {
              void collections.sessions.utils.resync();
              void collections.workspaces.utils.resync();
            }}
          />
        ) : status === "loading" ? (
          <NavList.Skeleton />
        ) : pinned.length === 0 && groups.length === 0 && needs.length === 0 ? (
          <p className="text-muted-foreground px-2 pt-2 text-xs">
            {t("sessions.sidebar.empty")}
            <span className="mt-1 block">
              {t("sessions.sidebar.emptyDescription", {
                key:
                  document.documentElement.dataset.platform === "darwin"
                    ? "⌘N"
                    : "Ctrl+N",
              })}
            </span>
          </p>
        ) : (
          <div className="flex flex-col">
            {needs.length ? (
              <NavList.Group label={t("sessions.attention.needs-you")}>
                {needs.map((s) => row(s, false))}
              </NavList.Group>
            ) : null}
            {pinned.length > 0 && (
              <NavList.Group label={t("sessions.sidebar.pinned")}>
                {pinned.map((session) => row(session, false))}
              </NavList.Group>
            )}
            {groups.map(({ workspace, sessions: rows }) => (
              <WorkspaceGroup
                workspace={workspace}
                key={workspace.id}
                label={workspace.label}
                icon={<Folder className="size-3.5 shrink-0" />}
                meta={rows.length}
                open={prefs.workspaceExpanded[workspace.id] ?? true}
                onOpenChange={(open) =>
                  void updatePrefs({
                    // One leaf (a record): the others' state travels as is.
                    workspaceExpanded: {
                      ...prefs.workspaceExpanded,
                      [workspace.id]: open,
                    },
                  }).catch(() => undefined)
                }
              >
                {rows.map((session) => row(session, true))}
              </WorkspaceGroup>
            ))}
          </div>
        )}
      </NavList.Root>
    </div>
  );
};

const SessionSidebarRow = ({
  session,
  indent,
  active,
  asks,
  query,
  workspaceLabel,
}: {
  session: SessionRow;
  indent: boolean;
  active: boolean;
  asks: number;
  query: string;
  workspaceLabel: string;
}) => {
  const { t } = useTranslation();
  const db = useDb();
  const prefs = usePrefs();
  const navigate = useAppNavigate();
  const currentId = (useParams({ strict: false }) as { sessionId?: string })
    .sessionId;
  const transport = useSessionsTransport();
  const [now] = useState(() => Date.now());
  const unread = useSelector(sessionsUnreadStore, (s) => s.has(session.id));
  const attention = sessionAttention(session, unread, asks);
  const [rename, setRename] = useState(false);
  const [label, setLabel] = useState(session.label);
  const [remove, setRemove] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pin = () =>
    void db.updatePrefs({
      pinned: {
        ...prefs.pinned,
        sessionIds: prefs.pinned.sessionIds.includes(session.id)
          ? prefs.pinned.sessionIds.filter((id) => id !== session.id)
          : [...prefs.pinned.sessionIds, session.id],
      },
    });
  const actions = [
    {
      id: "rename",
      label: t("sessions.sidebar.rename"),
      run: () => {
        setLabel(session.label);
        setRename(true);
      },
    },
    {
      id: "pin",
      label: t(
        prefs.pinned.sessionIds.includes(session.id)
          ? "sessions.sidebar.unpin"
          : "sessions.sidebar.pin"
      ),
      run: pin,
    },
    {
      id: "unread",
      label: t("sessions.sidebar.markUnread"),
      run: () => markSessionUnread(session.id),
    },
    {
      id: "beside",
      label: t("sessions.sidebar.openBeside"),
      run: () => {
        const current = currentId
          ? db.collections.sessions.get(currentId)
          : undefined;
        if (!current) {
          void navigate({
            to: "/sessions/$sessionId",
            params: { sessionId: session.id },
            transition: "nav-lateral",
          });
          return;
        }
        const ref = `preview:session-${session.id}`;
        openTab(sessionConversationKey(current.workspaceId, current.id), {
          ref,
          title: session.label,
          sessionId: session.id,
        });
        void navigate({
          search: (p: Record<string, unknown>) => ({
            ...p,
            tab: ref,
            view: "split",
          }),
          transition: "none",
        } as never);
      },
    },
    {
      id: "worktree",
      label: t("sessions.sidebar.newWorktree"),
      run: () => {
        void transport.client.git
          .currentBranch({
            workspaceId: session.workspaceId,
            sessionId: session.id,
          })
          .then((branch) => {
            if (!branch.currentBranch)
              throw new Error(t("sessions.tray.noBranch"));
            startDraftStore.setState(() => ({
              ...newStartDraft(),
              workspaceId: session.workspaceId,
              worktree: { kind: "new", baseRef: branch.currentBranch! },
            }));
            return navigate({
              to: "/sessions/new",
              search: { workspace: session.workspaceId },
              transition: "nav-forward",
            });
          })
          .catch((e) => setError(String(e)));
      },
    },
    {
      id: "copy",
      label: t("sessions.sidebar.copyId"),
      run: () => void navigator.clipboard.writeText(session.id),
    },
    {
      id: "delete",
      label: t("sessions.sidebar.delete"),
      run: () => setRemove(true),
    },
  ];
  return (
    <ContextMenu>
      <ContextMenuTrigger
        render={<div className="group relative flex items-center" />}
      >
        <NavList.Item
          to="/sessions/$sessionId"
          params={{ sessionId: session.id }}
          active={active}
          title={
            <span className="flex min-w-0 flex-col">
              <span className="truncate">
                <SessionSearchLabel
                  label={session.label || t("sessions.untitled")}
                  query={query}
                />
              </span>
              {query ? (
                <span className="text-foreground/75 text-[10px] font-normal">
                  {workspaceLabel} · {session.worktreeBranch ?? ""}
                </span>
              ) : null}
            </span>
          }
          meta={formatChatStamp(
            Date.parse(session.updatedAt),
            now,
            navigator.language,
            t("workspace.yesterday")
          )}
          hint={`${session.label} · ${session.worktreeBranch ?? session.workspaceId}`}
          indent={indent}
          className="min-w-0 flex-1 pr-8"
          trailing={
            attention.kind !== "idle" ? (
              <span
                role="img"
                aria-label={t(`sessions.attention.${attention.kind}`)}
                className={
                  attention.kind === "needs-you"
                    ? "text-amber-600"
                    : "text-muted-foreground"
                }
              >
                ●
              </span>
            ) : null
          }
        />
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                size="icon-sm"
                variant="ghost"
                className="absolute right-0"
                aria-label={t("sessions.sidebar.actions", {
                  name: session.label,
                })}
              />
            }
          >
            ⋯
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuGroup>
              {actions.map((action) => (
                <DropdownMenuItem key={action.id} onClick={action.run}>
                  {action.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        <Dialog open={rename} onOpenChange={setRename}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t("sessions.sidebar.rename")}</DialogTitle>
            </DialogHeader>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void renameSession(db, session.id, label)
                  .then(() => setRename(false))
                  .catch((e) => setError(String(e)));
              }}
            >
              <Input
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                aria-label={t("sessions.sidebar.name")}
              />
              <Button type="submit" disabled={!label.trim()}>
                {t("sessions.common.save")}
              </Button>
              {error ? <p role="alert">{error}</p> : null}
            </form>
          </DialogContent>
        </Dialog>
        <AlertDialog open={remove} onOpenChange={setRemove}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {t("sessions.sidebar.delete")}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {t("sessions.sidebar.deleteBody")}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>
                {t("sessions.common.cancel")}
              </AlertDialogCancel>
              <AlertDialogAction
                onClick={() =>
                  void deleteSession(db, transport.client, session, () => {
                    if (active)
                      void navigate({
                        to: "/sessions/new",
                        search: { workspace: session.workspaceId },
                        replace: true,
                        transition: "nav-lateral",
                      });
                  }).catch((e) => setError(String(e)))
                }
              >
                {t("sessions.sidebar.delete")}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
        {error ? (
          <p role="alert" className="text-destructive text-xs">
            {error}
          </p>
        ) : null}
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuGroup>
          {actions.map((action) => (
            <ContextMenuItem key={action.id} onClick={action.run}>
              {action.label}
            </ContextMenuItem>
          ))}
        </ContextMenuGroup>
      </ContextMenuContent>
    </ContextMenu>
  );
};

const SessionSearchLabel = ({
  label,
  query,
}: {
  label: string;
  query: string;
}) => {
  const offset = query
    ? label.toLocaleLowerCase().indexOf(query.toLocaleLowerCase())
    : -1;
  return offset < 0 ? (
    label
  ) : (
    <>
      {label.slice(0, offset)}
      <mark className="bg-accent text-accent-foreground">
        {label.slice(offset, offset + query.length)}
      </mark>
      {label.slice(offset + query.length)}
    </>
  );
};
const WorkspaceGroup = ({
  workspace,
  children,
  ...group
}: {
  workspace: WorkspaceRow;
  children: ReactNode;
} & Omit<React.ComponentProps<typeof NavList.Group>, "children">) => {
  const { t } = useTranslation();
  const db = useDb();
  const transport = useSessionsTransport();
  const navigate = useAppNavigate();
  const branch = useQuery(
    transport.orpc.git.currentBranch.queryOptions({
      input: { workspaceId: workspace.id },
    })
  );
  const path = useQuery(
    transport.orpc.workspaces.checkPath.queryOptions({
      input: { workspaceId: workspace.id },
    })
  );
  const [rename, setRename] = useState(false);
  const [recover, setRecover] = useState(false);
  const [label, setLabel] = useState(workspace.label);
  const [error, setError] = useState<string | null>(null);
  const actions = [
    {
      label: t("sessions.sidebar.new"),
      run: () =>
        void navigate({
          to: "/sessions/new",
          search: { workspace: workspace.id },
        }),
    },
    {
      label: t("workspace.renameWorkspace"),
      run: () => {
        setLabel(workspace.label);
        setRename(true);
      },
    },
    {
      label: t("sessions.files.copyPath"),
      run: () => void navigator.clipboard.writeText(workspace.path ?? ""),
    },
    { label: t("sessions.missing.choose"), run: () => setRecover(true) },
    {
      label: t("sessions.missing.deleteWorkspace"),
      run: () => setRecover(true),
    },
  ];
  return (
    <div className="relative">
      <ContextMenu>
        <ContextMenuTrigger render={<div />}>
          <NavList.Group
            {...group}
            label={`${workspace.label}${branch.data?.currentBranch ? " · " + branch.data.currentBranch : ""}${path.data?.exists === false ? " · " + t("sessions.missing.folder") : ""}`}
            meta={<span className="pr-7">{group.meta}</span>}
          >
            {children}
          </NavList.Group>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuGroup>
            {actions.map((action) => (
              <ContextMenuItem key={action.label} onClick={action.run}>
                {action.label}
              </ContextMenuItem>
            ))}
          </ContextMenuGroup>
        </ContextMenuContent>
      </ContextMenu>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              className="absolute top-0 right-0"
              size="icon-sm"
              variant="ghost"
              aria-label={t("workspace.workspaceOptions")}
            />
          }
        >
          ⋯
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuGroup>
            {actions.map((action) => (
              <DropdownMenuItem key={action.label} onClick={action.run}>
                {action.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog open={rename} onOpenChange={setRename}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("workspace.renameWorkspace")}</DialogTitle>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void db.collections.workspaces
                .update(workspace.id, (d) => {
                  d.label = label.trim();
                })
                .isPersisted.promise.then(() => setRename(false))
                .catch((e) => setError(String(e)));
            }}
          >
            <Input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              aria-label={t("bots.form.name")}
            />
            <Button type="submit" disabled={!label.trim()}>
              {t("sessions.common.save")}
            </Button>
            {error ? <p role="alert">{error}</p> : null}
          </form>
        </DialogContent>
      </Dialog>
      <Dialog open={recover} onOpenChange={setRecover}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{workspace.label}</DialogTitle>
          </DialogHeader>
          <WorkspaceMissing
            workspaceId={workspace.id}
            retry={() => {
              void path.refetch();
              setRecover(false);
            }}
            removed={() => {
              setRecover(false);
              void navigate({ to: "/sessions/new" });
            }}
          />
        </DialogContent>
      </Dialog>
    </div>
  );
};
