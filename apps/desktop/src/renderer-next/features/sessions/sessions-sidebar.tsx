import { useLiveQuery } from "@tanstack/react-db";
import { useParams } from "@tanstack/react-router";
import { useSelector } from "@tanstack/react-store";
import { Folder, Plus } from "lucide-react";
/**
 * The Sessions sidebar (spec 01 §7.3, canvas `SessionsSidebar`): sessions
 * that are not a bot's chat, a routine run or a routine editor, grouped by
 * their workspace (routine and bot folders excluded), pinned ones first, each
 * group newest first, groups collapsible (prefs.workspaceExpanded).
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { NavList } from "#next/components/nav-list";
import { useDb } from "#next/data/db";
import { useCollections } from "#next/data/db";
import { isListedSession, isListedWorkspace } from "#next/data/db/filters";
import { usePrefs, useUpdatePrefs } from "#next/data/db/prefs";
import { useCollectionStatus } from "#next/data/db/status";
import { usePendingConnectorAsks } from "#next/lib/connector-requests";
import { AppLink } from "#next/lib/navigation/app-link";
import { useAppNavigate } from "#next/lib/navigation/use-app-navigate";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from "#next/ui/alert-dialog";
import { Button } from "#next/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "#next/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
} from "#next/ui/dropdown-menu";
import { Input } from "#next/ui/input";
import type { SessionRow, WorkspaceRow } from "#shared/contract";
import { sessionConversationKey } from "#shared/conversation-scope";

import { sessionAttention } from "./data/attention";
import { useSessionsTransport } from "./data/queries";
import { renameSession, deleteSession } from "./data/session-actions";
import { sessionsUnreadStore } from "./data/unread-store";

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
  const prefs = usePrefs();
  const updatePrefs = useUpdatePrefs();
  const { data: sessions } = useLiveQuery(collections.sessions);
  const { data: workspaces } = useLiveQuery(collections.workspaces);
  const sessionsStatus = useCollectionStatus(collections.sessions);
  const workspacesStatus = useCollectionStatus(collections.workspaces);
  const asks = usePendingConnectorAsks(useSessionsTransport());
  const [query, setQuery] = useState("");
  const params = useParams({ strict: false }) as { sessionId?: string };
  const { pinned, groups } = groupSessions(
    (sessions ?? []).filter((s) =>
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
    />
  );

  return (
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
      ) : pinned.length === 0 && groups.length === 0 ? (
        <p className="text-muted-foreground px-2 pt-2 text-xs">
          {t("sessions.sidebar.empty")}
        </p>
      ) : (
        <div className="flex flex-col">
          {pinned.length > 0 && (
            <NavList.Group label={t("sessions.sidebar.pinned")}>
              {pinned.map((session) => row(session, false))}
            </NavList.Group>
          )}
          {groups.map(({ workspace, sessions: rows }) => (
            <NavList.Group
              key={workspace.id}
              label={workspace.label}
              icon={<Folder className="size-3.5 shrink-0" />}
              meta={workspace.description || undefined}
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
            </NavList.Group>
          ))}
        </div>
      )}
    </NavList.Root>
  );
};

const SessionSidebarRow = ({
  session,
  indent,
  active,
  asks,
}: {
  session: SessionRow;
  indent: boolean;
  active: boolean;
  asks: number;
}) => {
  const { t } = useTranslation();
  const db = useDb();
  const prefs = usePrefs();
  const navigate = useAppNavigate();
  const transport = useSessionsTransport();
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
  return (
    <div className="group relative flex items-center">
      <NavList.Item
        to="/sessions/$sessionId"
        params={{ sessionId: session.id }}
        active={active}
        title={session.label || t("sessions.untitled")}
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
            <DropdownMenuItem
              onClick={() => {
                setLabel(session.label);
                setRename(true);
              }}
            >
              {t("sessions.sidebar.rename")}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={pin}>
              {t(
                prefs.pinned.sessionIds.includes(session.id)
                  ? "sessions.sidebar.unpin"
                  : "sessions.sidebar.pin"
              )}
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => void navigator.clipboard.writeText(session.id)}
            >
              {t("sessions.sidebar.copyId")}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setRemove(true)}>
              {t("sessions.sidebar.delete")}
            </DropdownMenuItem>
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
            <AlertDialogTitle>{t("sessions.sidebar.delete")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("sessions.sidebar.deleteBody")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("sessions.common.cancel")}</AlertDialogCancel>
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
    </div>
  );
};
