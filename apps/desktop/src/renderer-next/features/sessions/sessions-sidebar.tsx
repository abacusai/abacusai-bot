/**
 * The Sessions sidebar (spec 01 §7.3, canvas `SessionsSidebar`): sessions
 * that are not a bot's chat, a routine run or a routine editor, grouped by
 * their workspace (routine and bot folders excluded), pinned ones first, each
 * group newest first, groups collapsible (prefs.workspaceExpanded).
 */
import { useLiveQuery } from "@tanstack/react-db";
import { useParams } from "@tanstack/react-router";
import { Folder, Plus } from "lucide-react";
import { useTranslation } from "react-i18next";

import { NavList } from "#next/components/nav-list";
import { useCollections } from "#next/data/db";
import { isListedSession, isListedWorkspace } from "#next/data/db/filters";
import { usePrefs, useUpdatePrefs } from "#next/data/db/prefs";
import { useCollectionStatus } from "#next/data/db/status";
import { AppLink } from "#next/lib/navigation/app-link";
import type { SessionRow, WorkspaceRow } from "#shared/contract";

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

const StatusDot = ({ busy }: { busy: boolean }) =>
  busy ? (
    <span
      aria-hidden="true"
      className="size-1.5 shrink-0 rounded-full bg-emerald-400"
    />
  ) : null;

export const SessionsSidebar = () => {
  const { t } = useTranslation();
  const collections = useCollections();
  const prefs = usePrefs();
  const updatePrefs = useUpdatePrefs();
  const { data: sessions } = useLiveQuery(collections.sessions);
  const { data: workspaces } = useLiveQuery(collections.workspaces);
  const sessionsStatus = useCollectionStatus(collections.sessions);
  const workspacesStatus = useCollectionStatus(collections.workspaces);
  const params = useParams({ strict: false }) as { sessionId?: string };
  const { pinned, groups } = groupSessions(
    sessions ?? [],
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
    <NavList.Item
      key={session.id}
      to="/sessions/$sessionId"
      params={{ sessionId: session.id }}
      active={params.sessionId === session.id}
      title={session.label}
      indent={indent}
      trailing={<StatusDot busy={session.turn?.isBusy === true} />}
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
