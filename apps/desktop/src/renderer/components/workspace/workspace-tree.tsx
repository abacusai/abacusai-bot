import {
  ChevronRight,
  Plus,
  MoreVertical,
  Trash2,
  FolderOpen,
  FolderPlus,
  Pencil,
  Search,
  X,
  Pin,
  PinOff,
} from "lucide-react";
import {
  Fragment,
  memo,
  type JSX,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ComponentType,
} from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import type { WorkspaceListItem } from "#shared/contracts";

import { prefetchTranscript } from "../../conversation/persistence";
import {
  isPlaceholderSession,
  useRemoveSessionMutation,
  useUpdateSessionLabelMutation,
  type AgentSessionEntry,
} from "../../hooks/use-agent-session-mutations";
import { useBotOwnedSessionIds } from "../../hooks/use-bots";
import {
  useWorkspaceAgentSessionsQuery,
  useSessionTurnStateQuery,
} from "../../hooks/use-workspace-queries";
import {
  useWorkspaceMetadata,
  useWorkspaceWorkspaceActions,
} from "../../providers/workspace-state-provider";
import { useWorkspaceStore } from "../../stores/code-store";
import { getWorkspaceDisplayLabel } from "../../utils/workspace-state";
import { ShimmerText } from "../chat/shimmer-text";
import { Dialog } from "../common/dialog";
import {
  fuzzyMatch,
  groupSessionsByDay,
  highlightSegments,
  sessionAge,
  type SessionBucket,
} from "../layout/session-list-utils";
import {
  Button,
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
  Field,
  FieldLabel,
  Input,
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "../ui";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../ui/collapsible";
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
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from "../ui/sidebar";
import { useConversationActivator } from "./workspace-activation";

const EMPTY_SESSIONS: AgentSessionEntry[] = [];

type RowAction = {
  dataId?: string;
  id: string;
  icon: ComponentType<{ className?: string }>;
  label: string;
  onSelect: () => void;
  variant?: "default" | "destructive";
};

/**
 * The workspaces -> sessions tree that fills the sidebar. `onBeforeActivate`,
 * `compact` and `dataIdPrefix` exist for embedding it elsewhere.
 */
export const CodeWorkspaceTree = ({
  onBeforeActivate,
  compact = false,
  dataIdPrefix = "",
}: {
  onBeforeActivate?: () => boolean | void;
  compact?: boolean;
  dataIdPrefix?: string;
}): JSX.Element => {
  const { t } = useTranslation();
  const metadataQuery = useWorkspaceMetadata();
  const workspaces = metadataQuery.data?.workspaces ?? [];
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const {
    addLocalWorkspace,
    removeWorkspaceMutation,
    renameWorkspaceMutation,
  } = useWorkspaceWorkspaceActions(activeWorkspaceId);
  const removeWorkspace = removeWorkspaceMutation.mutateAsync;
  const renameWorkspace = renameWorkspaceMutation.mutateAsync;
  const workspaceAccordionExpanded = useWorkspaceStore(
    (state) => state.workspaceAccordionExpanded
  );
  const setWorkspaceAccordionExpanded = useWorkspaceStore(
    (state) => state.setWorkspaceAccordionExpanded
  );

  const [query, setQuery] = useState("");
  const isSearching = query.trim().length > 0;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  // Only a workspace can count its own sessions, so it reports up.
  const [matchCounts, setMatchCounts] = useState<Record<string, number>>({});
  const handleMatchCount = useCallback(
    (workspaceId: string, count: number) =>
      setMatchCounts((counts) =>
        counts[workspaceId] === count
          ? counts
          : { ...counts, [workspaceId]: count }
      ),
    []
  );
  const handleExpandedChange = useCallback(
    (workspaceId: string, expanded: boolean) => {
      setWorkspaceAccordionExpanded(workspaceId, expanded);
    },
    [setWorkspaceAccordionExpanded]
  );
  const handleRemoveWorkspace = useCallback(
    async (workspaceId: string) => {
      await removeWorkspace(workspaceId);
    },
    [removeWorkspace]
  );
  const handleRenameWorkspace = useCallback(
    async (workspaceId: string, label: string) => {
      await renameWorkspace({ workspaceId, label });
    },
    [renameWorkspace]
  );

  // Update Zustand first so the next render is on the new workspace, then ack.
  const activateSelection = useConversationActivator();
  const activateConversation = useCallback(
    (workspaceId: string, sessionId: string | null) =>
      activateSelection({ workspaceId, sessionId }),
    [activateSelection]
  );

  // Workspaces stay mounted with no hits; unmounting would strand the count.
  const totalMatches = workspaces.reduce(
    (sum, workspace) => sum + (matchCounts[workspace.id] ?? 0),
    0
  );

  if (workspaces.length === 0) {
    return (
      <Empty className={compact ? "flex-none" : "h-full"}>
        <EmptyHeader>
          <EmptyTitle>{t("workspace.noWorkspaces")}</EmptyTitle>
          <EmptyDescription>
            {t("workspace.noWorkspacesDescription")}
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button
            size="sm"
            data-id={`${dataIdPrefix}add-workspace-empty-state`}
            onClick={() => {
              onBeforeActivate?.();
              void addLocalWorkspace();
            }}
          >
            <Plus />
            {t("workspace.addWorkspace")}
          </Button>
        </EmptyContent>
      </Empty>
    );
  }

  return (
    <div className={`flex flex-col ${compact ? "" : "h-full"}`}>
      <div className="flex items-center gap-1 px-2 pt-2 pb-1.5">
        <InputGroup className="min-w-0 flex-1">
          <InputGroupAddon>
            <Search />
          </InputGroupAddon>
          <InputGroupInput
            type="text"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") setQuery("");
            }}
            placeholder={t("workspace.searchSessions")}
            aria-label={t("workspace.searchSessions")}
            data-id={`${dataIdPrefix}session-search-input`}
          />
          {isSearching && (
            <InputGroupAddon align="inline-end">
              <InputGroupButton
                size="icon-xs"
                onClick={() => setQuery("")}
                aria-label={t("workspace.clearSearch")}
                data-id={`${dataIdPrefix}session-search-clear`}
              >
                <X />
              </InputGroupButton>
            </InputGroupAddon>
          )}
        </InputGroup>
      </div>
      <SidebarGroup className="min-h-0 flex-1 pt-0">
        <SidebarGroupLabel>{t("workspace.workspaces")}</SidebarGroupLabel>
        <SidebarGroupAction
          data-id={`${dataIdPrefix}add-workspace-btn`}
          onClick={() => {
            onBeforeActivate?.();
            void addLocalWorkspace();
          }}
          aria-label={t("workspace.addWorkspace")}
          title={t("workspace.addWorkspace")}
        >
          <FolderPlus />
        </SidebarGroupAction>
        <SidebarGroupContent className="min-h-0 flex-1">
          <div
            className={
              compact
                ? "pb-2"
                : "scroll-fade-y h-full min-h-0 overflow-auto pb-2"
            }
          >
            <SidebarMenu>
              {workspaces.map((workspace) => (
                <WorkspaceItem
                  key={workspace.id}
                  workspace={workspace}
                  now={now}
                  query={query}
                  onMatchCount={handleMatchCount}
                  isActive={workspace.id === activeWorkspaceId}
                  expanded={
                    isSearching ||
                    workspaceAccordionExpanded[workspace.id] !== false
                  }
                  onExpandedChange={handleExpandedChange}
                  activateConversation={activateConversation}
                  onBeforeActivate={onBeforeActivate}
                  dataIdPrefix={dataIdPrefix}
                  onRemoveWorkspace={handleRemoveWorkspace}
                  onRenameWorkspace={handleRenameWorkspace}
                />
              ))}
            </SidebarMenu>

            {isSearching && totalMatches === 0 && (
              <p
                className="text-muted-foreground px-2 py-3 text-xs"
                data-id={`${dataIdPrefix}session-search-empty`}
              >
                {t("workspace.noSessionsMatch", { query: query.trim() })}
              </p>
            )}
          </div>
        </SidebarGroupContent>
      </SidebarGroup>
    </div>
  );
};

const WorkspaceItem = memo(function WorkspaceItem({
  workspace,
  now,
  query,
  onMatchCount,
  isActive,
  expanded,
  onExpandedChange,
  activateConversation,
  onRemoveWorkspace,
  onRenameWorkspace,
  onBeforeActivate,
  dataIdPrefix = "",
}: {
  workspace: WorkspaceListItem;
  now: number;
  query: string;
  onMatchCount: (workspaceId: string, count: number) => void;
  isActive: boolean;
  expanded: boolean;
  onExpandedChange: (workspaceId: string, expanded: boolean) => void;
  activateConversation: (
    workspaceId: string,
    sessionId: string | null
  ) => boolean;
  onRemoveWorkspace: (workspaceId: string) => Promise<void>;
  onRenameWorkspace: (workspaceId: string, label: string) => Promise<void>;
  onBeforeActivate?: () => boolean | void;
  dataIdPrefix?: string;
}): JSX.Element {
  const { t } = useTranslation();
  const trimmedQuery = query.trim();
  const isSearching = trimmedQuery.length > 0;
  const sessionsQuery = useWorkspaceAgentSessionsQuery(workspace.id, {
    enabled: expanded || isActive || isSearching,
  });
  // A bot's chats belong to the Bots view; deleting one here would break it.
  const botSessionIds = useBotOwnedSessionIds();
  const sessions = useMemo(() => {
    const raw = sessionsQuery.data ?? EMPTY_SESSIONS;
    if (botSessionIds.size === 0) return raw;
    return raw.filter((session) => !botSessionIds.has(session.id));
  }, [sessionsQuery.data, botSessionIds]);
  const activeSessionId = useWorkspaceStore(
    (state) => state.workspaceUiStates[workspace.id]?.activeSessionId ?? null
  );
  const removeSessionMutation = useRemoveSessionMutation(workspace.id);
  const updateSessionLabelMutation = useUpdateSessionLabelMutation();
  const setActiveSessionId = useWorkspaceStore(
    (state) => state.setActiveSessionId
  );
  const pinnedSessionIds = useWorkspaceStore((state) => state.pinnedSessionIds);
  const toggleSessionPinned = useWorkspaceStore(
    (state) => state.toggleSessionPinned
  );

  // Search drops the pinned/day structure for best-match order.
  const searchResults = useMemo(() => {
    if (!isSearching) return [];
    return sessions
      .map((session) => ({
        session,
        match: fuzzyMatch(trimmedQuery, session.label ?? ""),
      }))
      .filter((entry) => entry.match != null)
      .sort((a, b) => (b.match?.score ?? 0) - (a.match?.score ?? 0));
  }, [sessions, trimmedQuery, isSearching]);

  const pinnedSessions = useMemo(
    () => sessions.filter((session) => pinnedSessionIds.includes(session.id)),
    [sessions, pinnedSessionIds]
  );
  const dayGroups = useMemo(
    () =>
      groupSessionsByDay(
        sessions.filter((session) => !pinnedSessionIds.includes(session.id)),
        (session) => session.updatedAt ?? session.createdAt,
        now
      ),
    [sessions, pinnedSessionIds, now]
  );

  const matchCount = isSearching ? searchResults.length : sessions.length;
  useEffect(() => {
    onMatchCount(workspace.id, matchCount);
  }, [matchCount, onMatchCount, workspace.id]);

  const [deleteSessionTarget, setDeleteSessionTarget] = useState<{
    id: string;
    label: string;
  } | null>(null);
  const [deleteWorkspaceOpen, setDeleteWorkspaceOpen] = useState(false);
  const [deleteWorkspaceConfirmName, setDeleteWorkspaceConfirmName] =
    useState("");
  const [renameSessionTarget, setRenameSessionTarget] = useState<{
    id: string;
    label: string;
    conversationId: string | null;
  } | null>(null);
  const [renameSessionValue, setRenameSessionValue] = useState("");
  const [renameWorkspaceOpen, setRenameWorkspaceOpen] = useState(false);
  const [renameWorkspaceValue, setRenameWorkspaceValue] = useState("");

  const workspaceLabel = getWorkspaceDisplayLabel(workspace);
  // A tombstone: readable, nothing new starts here, next delete is permanent.
  const isDeleted = workspace.status === "deleted";

  // An embedder may refuse the activation before we mutate anything.
  const handleNewChat = (): void => {
    if (onBeforeActivate && onBeforeActivate() === false) return;
    activateConversation(workspace.id, null);
  };

  // Shift-click pins instead of opening, out of the way of the common click.
  const handleSessionClick = (
    sessionId: string,
    event: React.MouseEvent
  ): void => {
    if (event.shiftKey) {
      toggleSessionPinned(sessionId);
      return;
    }
    if (onBeforeActivate && onBeforeActivate() === false) return;
    activateConversation(workspace.id, sessionId);
  };

  const newChatAction: RowAction | null = isDeleted
    ? null
    : {
        id: "new-chat",
        icon: Plus,
        label: t("workspace.newChat"),
        onSelect: handleNewChat,
      };
  const workspaceActions: RowAction[] = [
    ...(workspace.path != null
      ? [
          {
            id: "reveal",
            icon: FolderOpen,
            label: t("workspace.revealInFinder"),
            onSelect: () => void window.api.showItemInFolder(workspace.path!),
          } satisfies RowAction,
        ]
      : []),
    {
      id: "rename",
      icon: Pencil,
      label: t("workspace.renameWorkspace"),
      dataId: `${dataIdPrefix}workspace-rename-${workspace.id}`,
      onSelect: () => {
        setRenameWorkspaceValue(workspaceLabel);
        setRenameWorkspaceOpen(true);
      },
    },
    {
      id: "delete",
      icon: Trash2,
      label: isDeleted
        ? t("workspace.deleteWorkspacePermanently")
        : t("workspace.deleteWorkspace"),
      onSelect: () => {
        setDeleteWorkspaceConfirmName("");
        setDeleteWorkspaceOpen(true);
      },
      variant: "destructive",
    },
  ];
  const workspaceContextActions =
    newChatAction == null
      ? workspaceActions
      : [newChatAction, ...workspaceActions];

  const renderSession = (
    session: AgentSessionEntry,
    options: { isPinned?: boolean; highlightPositions?: number[] } = {}
  ): JSX.Element => (
    <SessionItem
      key={session.id}
      session={session}
      workspaceId={workspace.id}
      isActive={activeSessionId === session.id && isActive}
      isPinned={options.isPinned}
      now={now}
      highlightPositions={options.highlightPositions}
      dataIdPrefix={dataIdPrefix}
      onSelect={(event) => handleSessionClick(session.id, event)}
      onTogglePin={() => toggleSessionPinned(session.id)}
      onDelete={() =>
        setDeleteSessionTarget({ id: session.id, label: session.label })
      }
      onRename={() => {
        setRenameSessionValue(session.label);
        setRenameSessionTarget({
          id: session.id,
          label: session.label,
          conversationId: session.conversationId ?? null,
        });
      }}
    />
  );

  return (
    <>
      <Collapsible
        open={expanded}
        onOpenChange={(nextExpanded) => {
          if (!isSearching) onExpandedChange(workspace.id, nextExpanded);
        }}
        className="group/collapsible"
        render={
          <SidebarMenuItem
            className={
              isSearching && searchResults.length === 0 ? "hidden" : undefined
            }
          />
        }
      >
        <ContextMenu>
          <ContextMenuTrigger
            render={
              <SidebarMenuButton
                render={<CollapsibleTrigger />}
                isActive={isActive}
                data-id={`${dataIdPrefix}workspace-accordion-${workspace.id}`}
                className="min-w-0 pe-14"
              />
            }
          >
            <ChevronRight className="transition-transform group-data-open/collapsible:rotate-90 rtl:group-data-open/collapsible:-rotate-90" />
            <span
              className={`truncate text-xs font-medium ${isDeleted ? "line-through opacity-60" : ""}`}
            >
              {workspaceLabel}
            </span>
            {isDeleted && (
              <span className="bg-muted text-muted-foreground shrink-0 rounded px-1 py-px text-[0.625rem] tracking-wide uppercase">
                {t("workspace.deletedWorkspaceBadge")}
              </span>
            )}
          </ContextMenuTrigger>
          <ContextMenuContent>
            {workspaceContextActions.map((action) => {
              const Icon = action.icon;
              return (
                <ContextMenuItem
                  key={action.id}
                  data-id={
                    action.dataId == null
                      ? undefined
                      : `${action.dataId}-context`
                  }
                  variant={action.variant}
                  onClick={action.onSelect}
                >
                  <Icon />
                  {action.label}
                </ContextMenuItem>
              );
            })}
          </ContextMenuContent>
        </ContextMenu>

        {newChatAction != null && (
          <SidebarMenuAction
            className="right-7"
            onClick={handleNewChat}
            data-id={`${dataIdPrefix}workspace-new-chat-${workspace.id}`}
            aria-label={t("workspace.newChat")}
            title={t("workspace.newChat")}
          >
            <Plus />
          </SidebarMenuAction>
        )}

        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <SidebarMenuAction
                showOnHover
                data-id={`${dataIdPrefix}workspace-menu-${workspace.id}`}
                aria-label={t("workspace.workspaceOptions")}
                title={t("workspace.workspaceOptions")}
                onClick={(event) => event.stopPropagation()}
              />
            }
          >
            <MoreVertical />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" sideOffset={4}>
            {workspaceActions.map((action) => {
              const Icon = action.icon;
              return (
                <DropdownMenuItem
                  key={action.id}
                  data-id={action.dataId}
                  variant={action.variant}
                  onClick={action.onSelect}
                >
                  <Icon />
                  {action.label}
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenu>

        <CollapsibleContent>
          <SidebarMenuSub className="mx-1 px-1">
            {sessionsQuery.isLoading ? (
              <li className="text-muted-foreground px-2 py-1 text-xs">...</li>
            ) : sessions.length === 0 ? (
              <li className="text-muted-foreground px-2 py-1 text-xs">
                {t("workspace.noChats")}
              </li>
            ) : isSearching ? (
              <>
                <SectionHeader label={t("workspace.results")} />
                {searchResults.map(({ session, match }) =>
                  renderSession(session, {
                    isPinned: pinnedSessionIds.includes(session.id),
                    highlightPositions: match?.positions,
                  })
                )}
              </>
            ) : (
              <>
                {pinnedSessions.length > 0 && (
                  <>
                    <SectionHeader label={t("workspace.pinnedSessions")} />
                    {pinnedSessions.map((session) =>
                      renderSession(session, { isPinned: true })
                    )}
                  </>
                )}

                {dayGroups.length === 0 ? (
                  <li className="text-muted-foreground px-2 py-1.5 text-xs">
                    {t("workspace.allPinned")}
                  </li>
                ) : (
                  dayGroups.map((group) => (
                    <Fragment key={group.id}>
                      <BucketHeader bucket={group.bucket} />
                      {group.sessions.map((session) => renderSession(session))}
                    </Fragment>
                  ))
                )}
              </>
            )}
          </SidebarMenuSub>
        </CollapsibleContent>
      </Collapsible>

      {/* Delete chat confirmation */}
      <Dialog
        isOpen={deleteSessionTarget != null}
        onClose={() => setDeleteSessionTarget(null)}
        icon={Trash2}
        iconColor="text-destructive"
        title={t("workspace.deleteChat")}
        description={t("workspace.deleteChatDescription")}
        data-id="delete-chat-dialog"
        buttons={[
          {
            label: t("workspace.cancel"),
            variant: "secondary",
            onClick: () => setDeleteSessionTarget(null),
          },
          {
            label: t("workspace.confirmDelete"),
            variant: "destructive",
            onClick: async () => {
              if (deleteSessionTarget == null) return true;
              const { id } = deleteSessionTarget;
              if (activeSessionId === id) {
                setActiveSessionId(workspace.id, null);
              }
              await new Promise<void>((resolve, reject) => {
                removeSessionMutation.mutate(id, {
                  onSuccess: () => {
                    toast.success(t("workspace.chatDeleted"), {
                      id: "session-delete",
                    });
                    resolve();
                  },
                  onError: (error) => {
                    reject(error);
                  },
                });
              });
              setDeleteSessionTarget(null);
              return true;
            },
          },
        ]}
      />

      {/* Delete workspace confirmation */}
      <Dialog
        isOpen={deleteWorkspaceOpen}
        onClose={() => setDeleteWorkspaceOpen(false)}
        icon={Trash2}
        iconColor="text-destructive"
        title={
          isDeleted
            ? t("workspace.deleteWorkspacePermanently")
            : t("workspace.deleteWorkspace")
        }
        description={
          isDeleted
            ? t("workspace.deleteWorkspacePermanentlyDescription", {
                name: workspaceLabel,
              })
            : t("workspace.deleteWorkspaceDescription", {
                name: workspaceLabel,
              })
        }
        data-id="delete-workspace-dialog"
        buttons={[
          {
            label: t("workspace.cancel"),
            variant: "secondary",
            onClick: () => setDeleteWorkspaceOpen(false),
          },
          {
            label: t("workspace.confirmDelete"),
            variant: "destructive",
            onClick: async () => {
              if (deleteWorkspaceConfirmName.trim() !== workspaceLabel) {
                return t("workspace.deleteWorkspaceNameMismatch");
              }
              await onRemoveWorkspace(workspace.id);
              toast.success(t("workspace.workspaceDeleted"), {
                id: "workspace-delete",
              });
              return true;
            },
          },
        ]}
      >
        <Field>
          <FieldLabel htmlFor={`delete-workspace-confirm-${workspace.id}`}>
            {t("workspace.deleteWorkspaceConfirmLabel")}
          </FieldLabel>
          <Input
            id={`delete-workspace-confirm-${workspace.id}`}
            type="text"
            value={deleteWorkspaceConfirmName}
            onChange={(e) => setDeleteWorkspaceConfirmName(e.target.value)}
            placeholder={t("workspace.deleteWorkspaceConfirmPlaceholder", {
              name: workspaceLabel,
            })}
            data-id="delete-workspace-confirm-input"
            autoFocus
          />
        </Field>
      </Dialog>

      {/* Rename chat */}
      <Dialog
        isOpen={renameSessionTarget != null}
        onClose={() => setRenameSessionTarget(null)}
        icon={Pencil}
        title={t("workspace.renameChat")}
        data-id="rename-chat-dialog"
        buttons={[
          {
            label: t("workspace.cancel"),
            variant: "secondary",
            onClick: () => setRenameSessionTarget(null),
          },
          {
            label: t("workspace.save"),
            variant: "default",
            onClick: async () => {
              const target = renameSessionTarget;
              if (target == null) return true;
              const trimmed = renameSessionValue.trim();
              if (trimmed.length === 0) return t("workspace.renameEmptyName");
              try {
                await updateSessionLabelMutation.mutateAsync({
                  workspaceId: workspace.id,
                  sessionId: target.id,
                  label: trimmed,
                });
              } catch {
                return t("workspace.renameError");
              }
              toast.success(t("workspace.chatRenamed"), {
                id: "session-rename",
              });
              setRenameSessionTarget(null);
              return true;
            },
          },
        ]}
      >
        <Field>
          <FieldLabel
            htmlFor={`rename-chat-${workspace.id}`}
            className="sr-only"
          >
            {t("workspace.renameChat")}
          </FieldLabel>
          <Input
            id={`rename-chat-${workspace.id}`}
            type="text"
            value={renameSessionValue}
            onChange={(e) => setRenameSessionValue(e.target.value)}
            placeholder={t("workspace.renameChatPlaceholder")}
            data-id="rename-chat-input"
            autoFocus
          />
        </Field>
      </Dialog>

      {/* Rename workspace */}
      <Dialog
        isOpen={renameWorkspaceOpen}
        onClose={() => setRenameWorkspaceOpen(false)}
        icon={Pencil}
        title={t("workspace.renameWorkspace")}
        data-id="rename-workspace-dialog"
        buttons={[
          {
            label: t("workspace.cancel"),
            variant: "secondary",
            onClick: () => setRenameWorkspaceOpen(false),
          },
          {
            label: t("workspace.save"),
            variant: "default",
            onClick: async () => {
              const trimmed = renameWorkspaceValue.trim();
              if (trimmed.length === 0) return t("workspace.renameEmptyName");
              try {
                await onRenameWorkspace(workspace.id, trimmed);
              } catch {
                return t("workspace.renameError");
              }
              toast.success(t("workspace.workspaceRenamed"), {
                id: "workspace-rename",
              });
              return true;
            },
          },
        ]}
      >
        <Field>
          <FieldLabel
            htmlFor={`rename-workspace-${workspace.id}`}
            className="sr-only"
          >
            {t("workspace.renameWorkspace")}
          </FieldLabel>
          <Input
            id={`rename-workspace-${workspace.id}`}
            type="text"
            value={renameWorkspaceValue}
            onChange={(e) => setRenameWorkspaceValue(e.target.value)}
            placeholder={t("workspace.renameWorkspacePlaceholder")}
            data-id="rename-workspace-input"
            autoFocus
          />
        </Field>
      </Dialog>
    </>
  );
});

/**
 * The all-caps section rule; more air above than below so it belongs to the
 * rows under it.
 */
const SectionHeader = ({ label }: { label: string }): JSX.Element => (
  <li className="text-muted-foreground px-2 pt-3 pb-1 text-xs font-semibold tracking-wide uppercase">
    {label}
  </li>
);

/** The date rule inside Sessions; today's chats get none. */
const BucketHeader = ({
  bucket,
}: {
  bucket: SessionBucket;
}): JSX.Element | null => {
  const { t, i18n } = useTranslation();

  if (bucket.kind === "today") return null;

  const label =
    bucket.kind === "yesterday"
      ? t("workspace.yesterday")
      : new Intl.DateTimeFormat(i18n.language, {
          month: "long",
          ...(bucket.sameYear ? {} : { year: "numeric" }),
        }).format(new Date(bucket.monthStart));

  return (
    <li className="flex items-center gap-2 px-2 pt-2.5 pb-1">
      <span className="text-muted-foreground text-xs tracking-wide uppercase">
        {label}
      </span>
      <span className="bg-sidebar-border h-px flex-1" />
    </li>
  );
};

/** "now" / "17m" / "16h" / "54d": the coarsest unit that still says something. */
const SessionAgeLabel = ({
  timestamp,
  now,
  className,
}: {
  timestamp: string | null | undefined;
  now: number;
  className?: string;
}): JSX.Element | null => {
  const { t } = useTranslation();
  const age = sessionAge(timestamp, now);
  if (age == null) return null;

  const label =
    age.unit === "now"
      ? t("workspace.ageNow")
      : age.unit === "minutes"
        ? t("workspace.ageMinutes", { count: age.count })
        : age.unit === "hours"
          ? t("workspace.ageHours", { count: age.count })
          : t("workspace.ageDays", { count: age.count });

  return (
    <span
      className={`text-muted-foreground text-xs tabular-nums ${className ?? ""}`}
    >
      {label}
    </span>
  );
};

const SessionItem = ({
  session,
  workspaceId,
  isActive,
  isPinned = false,
  now,
  highlightPositions,
  onSelect,
  onTogglePin,
  onDelete,
  onRename,
  dataIdPrefix = "",
}: {
  session: AgentSessionEntry;
  workspaceId: string;
  isActive: boolean;
  isPinned?: boolean;
  now: number;
  highlightPositions?: number[];
  onSelect: (event: React.MouseEvent) => void;
  onTogglePin: () => void;
  onDelete: () => void;
  onRename: () => void;
  dataIdPrefix?: string;
}): JSX.Element => {
  const { t } = useTranslation();
  const isSessionCompletedInBackground = useWorkspaceStore((state) =>
    state.isSessionCompletedInBackground(session.id)
  );
  // Single source of truth: read busy/phase from the shared turn-state query.
  const turnStateQuery = useSessionTurnStateQuery(workspaceId, session.id);
  const phase = turnStateQuery.data?.phase ?? "idle";

  const isStreaming = phase === "pending" || phase === "streaming";
  const isWaitingPermission = phase === "waiting_permission";
  const isCompletedBackground = isSessionCompletedInBackground && !isActive;
  const actions: RowAction[] = [
    {
      id: "pin",
      icon: isPinned ? PinOff : Pin,
      label: isPinned ? t("workspace.unpinChat") : t("workspace.pinChat"),
      dataId: `${dataIdPrefix}session-pin-${session.id}`,
      onSelect: onTogglePin,
    },
    {
      id: "rename",
      icon: Pencil,
      label: t("workspace.renameChat"),
      dataId: `${dataIdPrefix}session-rename-${session.id}`,
      onSelect: onRename,
    },
    {
      id: "delete",
      icon: Trash2,
      label: t("workspace.deleteChat"),
      onSelect: onDelete,
      variant: "destructive",
    },
  ];

  return (
    <SidebarMenuSubItem
      className={isPlaceholderSession(session) ? "w-full opacity-60" : "w-full"}
    >
      <div
        className={`group/session-row hover:bg-sidebar-accent/50 focus-within:bg-sidebar-accent/50 flex w-full min-w-0 items-center rounded-md ${isActive ? "bg-sidebar-accent text-sidebar-accent-foreground" : ""}`}
      >
        <ContextMenu>
          <ContextMenuTrigger
            render={
              <SidebarMenuSubButton
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={isPlaceholderSession(session)}
                  />
                }
                isActive={isActive}
                onClick={onSelect}
                onPointerEnter={() => prefetchTranscript(session.id)}
                onFocus={() => prefetchTranscript(session.id)}
                data-id={`${dataIdPrefix}session-item-${session.id}`}
                className="min-w-0 flex-1 bg-transparent pe-1 hover:bg-transparent data-active:bg-transparent"
              />
            }
          >
            <span className="flex size-3 shrink-0 items-center justify-center">
              {isStreaming && !isWaitingPermission ? (
                <span className="bg-primary size-1.5 animate-pulse rounded-full" />
              ) : isWaitingPermission ? (
                <span className="size-1.5 rounded-full bg-yellow-400" />
              ) : isCompletedBackground ? (
                <span className="size-1.5 rounded-full bg-green-400" />
              ) : null}
            </span>
            {isStreaming ? (
              <ShimmerText className="text-muted-foreground min-w-0 flex-1 truncate text-start">
                {session.label}
              </ShimmerText>
            ) : (
              <span className="min-w-0 flex-1 truncate text-start">
                {highlightPositions != null && highlightPositions.length > 0
                  ? highlightSegments(
                      session.label ?? "",
                      highlightPositions
                    ).map((segment, index) => (
                      <span
                        key={index}
                        className={
                          segment.matched
                            ? "text-primary font-semibold"
                            : undefined
                        }
                      >
                        {segment.text}
                      </span>
                    ))
                  : session.label}
              </span>
            )}
            {isPinned && (
              <Pin
                className="text-muted-foreground ms-auto size-3"
                aria-hidden
              />
            )}
          </ContextMenuTrigger>

          {!isPlaceholderSession(session) && (
            <ContextMenuContent>
              {actions.map((action) => {
                const Icon = action.icon;
                return (
                  <ContextMenuItem
                    key={action.id}
                    data-id={
                      action.dataId == null
                        ? undefined
                        : `${action.dataId}-context`
                    }
                    variant={action.variant}
                    onClick={action.onSelect}
                  >
                    <Icon />
                    {action.label}
                  </ContextMenuItem>
                );
              })}
            </ContextMenuContent>
          )}
        </ContextMenu>

        <div className="grid size-6 shrink-0 place-items-center [&>*]:col-start-1 [&>*]:row-start-1">
          <SessionAgeLabel
            timestamp={session.updatedAt ?? session.createdAt}
            now={now}
            className="pointer-events-none transition-opacity group-focus-within/session-row:opacity-0 group-hover/session-row:opacity-0"
          />
          {!isPlaceholderSession(session) && (
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    className="relative z-10 opacity-0 transition-opacity group-focus-within/session-row:opacity-100 group-hover/session-row:opacity-100 focus:opacity-100 data-popup-open:opacity-100"
                    data-id={`${dataIdPrefix}session-menu-${session.id}`}
                    aria-label={t("workspace.sessionOptions")}
                    onClick={(event) => {
                      event.stopPropagation();
                    }}
                  />
                }
              >
                <MoreVertical />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" sideOffset={4}>
                {actions.map((action) => {
                  const Icon = action.icon;
                  return (
                    <DropdownMenuItem
                      key={action.id}
                      data-id={action.dataId}
                      variant={action.variant}
                      onClick={action.onSelect}
                    >
                      <Icon />
                      {action.label}
                    </DropdownMenuItem>
                  );
                })}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>
    </SidebarMenuSubItem>
  );
};
