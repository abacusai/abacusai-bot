import { useNavigate } from "@tanstack/react-router";
import {
  Bot as BotIcon,
  MoreVertical,
  Pin,
  PinOff,
  Plus,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useState, type JSX } from "react";
import { useTranslation } from "react-i18next";

import { useBotOwnedSessionIds } from "../../hooks/use-bots";
import { useAllAgentSessionsQuery } from "../../hooks/use-workspace-queries";
import { useSidebarConversationRoute } from "../../lib/sidebar-conversation-route";
import { useWorkspaceStore } from "../../stores/code-store";
import { useSidebarAccordion } from "../../stores/sidebar-accordion-store";
import { Dialog } from "../common/dialog";
import {
  groupSessionsForSidebar,
  RECENT_ROWS_WITHOUT_HEADER,
  type SidebarDateBucket,
} from "../layout/session-list-utils";
import {
  SIDEBAR_SCROLLER_ATTR,
  useScrollIntoSection,
} from "../layout/sidebar-scroll";
import { SidebarSectionLabel } from "../layout/sidebar-section-label";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "../ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import {
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
} from "../ui/sidebar";
import { useConversationActivator } from "./workspace-activation";

/**
 * Past sessions, as the sidebar's second section: newest-first across every
 * workspace, dated like the DeepAgent web app (no header for the freshest
 * rows, then Yesterday, N days ago, dates). A row is its title and nothing
 * else; you pick a chat by what it was about, not by its folder.
 */
export const SessionsTree = (): JSX.Element => {
  const { t } = useTranslation();
  const sessionsQuery = useAllAgentSessionsQuery();
  // A bot's chats belong to the Bots section, not here as well.
  const botSessionIds = useBotOwnedSessionIds();
  const activateSelection = useConversationActivator();
  const activeRoute = useSidebarConversationRoute();
  const navigate = useNavigate();
  const setNewPaneIntent = useWorkspaceStore((state) => state.setNewPaneIntent);
  const isOpen = useSidebarAccordion(
    (state) => state.openSection === "sessions"
  );
  const toggleSection = useSidebarAccordion((state) => state.toggleSection);
  const [pinnedOpen, setPinnedOpen] = useState(true);
  // Day buckets move at midnight; re-derive once a minute.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  const pinnedSessionIds = useWorkspaceStore((state) => state.pinnedSessionIds);
  const toggleSessionPinned = useWorkspaceStore(
    (state) => state.toggleSessionPinned
  );
  const [deleteTarget, setDeleteTarget] = useState<{
    id: string;
    workspaceId: string;
    label: string;
  } | null>(null);

  const sessions = useMemo(
    () =>
      (sessionsQuery.data ?? [])
        .filter(
          // The session's own botOwned stamp also hides it, so a registry
          // accident cannot surface a bot's chat here. Routine runs are listed
          // under Routines, never here as chats to continue.
          (session) =>
            !botSessionIds.has(session.id) &&
            !session.botOwned &&
            session.routineId == null &&
            session.editorFor == null
        )
        .sort(
          (a, b) =>
            new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
        ),
    [botSessionIds, sessionsQuery.data]
  );

  /**
   * Clearing the active session puts the welcome pane back; the intent stops
   * that pane asking for a bot's name.
   */
  const startNewSession = (): void => {
    setNewPaneIntent("session");
    void navigate({ to: "/sessions/new" });
    // No inherited workspace: the ambient one may be a bot-home the user never
    // picked, so a new session asks.
    useWorkspaceStore.getState().deselectWorkspace();
  };

  // Pinned first; an id whose session is gone falls away on the next unpin.
  const pinnedSessions = sessions.filter((session) =>
    pinnedSessionIds.includes(session.id)
  );
  const restSessions = sessions.filter(
    (session) => !pinnedSessionIds.includes(session.id)
  );
  const groups = useMemo(
    () =>
      groupSessionsForSidebar(
        restSessions,
        (session) => session.updatedAt,
        now
      ),
    // restSessions is derived per render; the inputs are what matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sessions, pinnedSessionIds, now]
  );
  const bucketLabel = (bucket: SidebarDateBucket): string => {
    switch (bucket.kind) {
      case "today":
        return t("sessions.today");
      case "yesterday":
        return t("sessions.yesterday");
      case "daysAgo":
        return t("sessions.daysAgo", { count: bucket.count });
      case "date":
        return new Date(bucket.at).toLocaleDateString(undefined, {
          month: "short",
          day: "numeric",
          ...(bucket.sameYear ? {} : { year: "numeric" }),
        });
    }
  };

  const renderSession = (session: (typeof sessions)[number]): JSX.Element => (
    <SessionRow
      key={session.id}
      id={session.id}
      label={session.label}
      isActive={
        activeRoute?.kind === "session" && activeRoute.id === session.id
      }
      isPinned={pinnedSessionIds.includes(session.id)}
      onTogglePin={() => toggleSessionPinned(session.id)}
      onOpen={() =>
        activateSelection({
          workspaceId: session.workspaceId,
          sessionId: session.id,
        })
      }
      onDelete={() =>
        setDeleteTarget({
          id: session.id,
          workspaceId: session.workspaceId,
          label: session.label,
        })
      }
    />
  );

  // The first ten rows never get a header, so the top reads as the list.
  let rowsBefore = 0;

  return (
    <SidebarGroup
      className={
        isOpen ? "flex min-h-0 flex-initial flex-col" : "min-h-0 shrink-0"
      }
    >
      <SidebarSectionLabel
        label={t("sessions.title")}
        count={sessions.length}
        isOpen={isOpen}
        onToggle={() => toggleSection("sessions")}
        dataId="sessions-section"
        action={
          <SidebarGroupAction
            data-id="new-session-btn"
            onClick={startNewSession}
            aria-label={t("sessions.newSession")}
            title={t("sessions.newSession")}
          >
            <Plus />
          </SidebarGroupAction>
        }
      />
      {isOpen && (
        <SidebarGroupContent
          className="scrollbar-autohide min-h-0 flex-1 overflow-y-auto overscroll-contain"
          data-id="sessions-scroller"
          {...{ [SIDEBAR_SCROLLER_ATTR]: "" }}
        >
          <div className="pb-1">
            {sessions.length === 0 ? null : (
              <SidebarMenu>
                {pinnedSessions.length > 0 && (
                  <>
                    <SidebarSectionLabel
                      label={t("sessions.pinned")}
                      count={pinnedSessions.length}
                      isOpen={pinnedOpen}
                      onToggle={() => setPinnedOpen((open) => !open)}
                      dataId="sessions-pinned"
                    />
                    {pinnedOpen && pinnedSessions.map(renderSession)}
                  </>
                )}
                {groups.map((group) => {
                  const withHeader = rowsBefore >= RECENT_ROWS_WITHOUT_HEADER;
                  rowsBefore += group.sessions.length;
                  return (
                    <li key={group.id} className="contents">
                      {withHeader && (
                        <div
                          className="text-muted-foreground/70 truncate px-2 pt-2 pb-0.5 text-[0.625rem] font-medium tracking-wide uppercase"
                          data-id={`sessions-date-${group.id}`}
                        >
                          {bucketLabel(group.bucket)}
                        </div>
                      )}
                      {group.sessions.map(renderSession)}
                    </li>
                  );
                })}
              </SidebarMenu>
            )}
          </div>
        </SidebarGroupContent>
      )}

      <Dialog
        isOpen={deleteTarget != null}
        onClose={() => setDeleteTarget(null)}
        icon={Trash2}
        title={t("sessions.deleteTitle")}
        data-id="delete-session-dialog"
        buttons={[
          {
            label: t("common.cancel"),
            variant: "secondary",
            onClick: () => setDeleteTarget(null),
          },
          {
            label: t("sessions.delete"),
            variant: "destructive",
            onClick: async () => {
              const target = deleteTarget;
              if (target == null) return true;
              try {
                // Not useRemoveSessionMutation, which binds one workspace at
                // hook level; this list is flat, so the workspace comes off the row.
                await window.api.agent.stopAgentSession({
                  workspaceId: target.workspaceId,
                  sessionId: target.id,
                });
                await window.api.agent.removeAgentSession(
                  target.workspaceId,
                  target.id
                );
                await sessionsQuery.refetch();
              } catch {
                return t("sessions.deleteError");
              }
              setDeleteTarget(null);
              return true;
            },
          },
        ]}
      >
        <p className="text-muted-foreground text-sm">
          {t("sessions.deleteBody", { label: deleteTarget?.label ?? "" })}
        </p>
      </Dialog>
    </SidebarGroup>
  );
};

const SessionRow = ({
  id,
  label,
  isActive,
  isPinned,
  onOpen,
  onDelete,
  onTogglePin,
}: {
  id: string;
  label: string;
  isActive: boolean;
  isPinned: boolean;
  onOpen: () => void;
  onDelete: () => void;
  onTogglePin: () => void;
}): JSX.Element => {
  const { t } = useTranslation();
  const hasUnread = useWorkspaceStore((state) =>
    state.isSessionCompletedInBackground(id)
  );
  const rowRef = useScrollIntoSection<HTMLLIElement>(isActive);
  return (
    <SidebarMenuItem ref={rowRef}>
      <ContextMenu>
        <ContextMenuTrigger
          render={
            <SidebarMenuButton
              onClick={onOpen}
              isActive={isActive}
              data-id={`session-item-${id}`}
              className="h-auto py-1.5"
            />
          }
        >
          <BotIcon className="text-muted-foreground shrink-0" />
          {/* Elided to fit the rail; the whole of it on hover. */}
          <span title={label} className="min-w-0 flex-1 truncate text-start">
            {label}
          </span>
          {isPinned && (
            <Pin
              className="text-muted-foreground size-3 shrink-0"
              aria-hidden
            />
          )}
          {hasUnread && (
            <span className="size-1.5 shrink-0 rounded-full bg-green-400" />
          )}
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onClick={onTogglePin} data-id={`session-pin-${id}`}>
            {isPinned ? <PinOff /> : <Pin />}
            {isPinned ? t("sessions.unpin") : t("sessions.pin")}
          </ContextMenuItem>
          <ContextMenuItem
            variant="destructive"
            onClick={onDelete}
            data-id={`session-delete-${id}`}
          >
            <Trash2 />
            {t("sessions.delete")}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      {/* The same two actions, on a control the user can see. A context menu
          is not an affordance — nothing on the row said they were there. */}
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <SidebarMenuAction
              showOnHover
              data-id={`session-menu-${id}`}
              aria-label={t("sessions.sessionOptions")}
              title={t("sessions.sessionOptions")}
              onClick={(event) => event.stopPropagation()}
            />
          }
        >
          <MoreVertical />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" sideOffset={4}>
          <DropdownMenuItem
            onClick={onTogglePin}
            data-id={`session-menu-pin-${id}`}
          >
            {isPinned ? <PinOff /> : <Pin />}
            {isPinned ? t("sessions.unpin") : t("sessions.pin")}
          </DropdownMenuItem>
          <DropdownMenuItem
            variant="destructive"
            onClick={onDelete}
            data-id={`session-menu-delete-${id}`}
          >
            <Trash2 />
            {t("sessions.delete")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </SidebarMenuItem>
  );
};
