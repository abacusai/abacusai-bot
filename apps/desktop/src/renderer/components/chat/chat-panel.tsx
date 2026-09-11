import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { AnimatePresence, motion } from "framer-motion";
import {
  Check,
  ChevronDown,
  FileText,
  Folder,
  FolderPlus,
  GitPullRequest,
  Globe,
  Plane,
  Laptop,
  Palette,
  Search,
  Sparkles,
  Table,
  type LucideIcon,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type JSX,
  type SetStateAction,
} from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { useShallow } from "zustand/react/shallow";

import { AgentMode, AgentStatus } from "#shared/agent-types";
import type {
  AgentSessionListItem,
  WorktreeDraftEnvironment,
  WorktreeListItem,
  WorkspaceListItem,
} from "#shared/contracts";
import { WORKSPACE_MISSING_ERROR } from "#shared/contracts";
import { DEFAULT_MODEL_ID } from "#shared/models";
import { detectRememberRequest } from "#shared/remember";

import {
  scopeSegments,
  useConversation,
  useConversationActivity,
  usePermission,
  useQueuedMessages,
  useSegments,
  useSubtasks,
  useTodos,
} from "../../conversation";
import { segmentTimes } from "../../conversation/persistence";
import { workspaceConversationStore } from "../../conversation/store";
import {
  useSubtaskScope,
  useSubtaskScopeStore,
} from "../../conversation/subtask-scope-store";
import { workspaceConversationTransport } from "../../conversation/transport";
import {
  type AgentSessionEntry,
  isPlaceholderSession,
  useStartCliSessionMutation,
  useSendMessageMutation,
  isUndeliverableMessage,
  useStopTurnMutation,
  useSetCliModelMutation,
  useSetCliModeMutation,
  useCreateSessionMutation,
  useUpdateSessionLabelMutation,
  useRemoveSessionMutation,
} from "../../hooks/use-agent-session-mutations";
import {
  useBotsQuery,
  useOpenBotChatMutation,
  useBotSenderChatsQuery,
} from "../../hooks/use-bots";
import {
  useAgentSessionStateQuery,
  useWorkspaceAgentSessionsQuery,
  useSessionTurnStateQuery,
  useWorkspacePathStatusQuery,
} from "../../hooks/use-workspace-queries";
import {
  usePrepareSessionWorktreeMutation,
  useSetSessionWorktreeMutation,
  useWorktreesQuery,
} from "../../hooks/use-worktrees";
import {
  composerDraftForKeyChange,
  writeComposerDraft,
} from "../../lib/composer-draft";
import { workspaceQueryKeys } from "../../lib/query-keys";
import { isAppInternalWorkspace } from "../../lib/workspace-utils";
import {
  useWorkspaceActiveWorkspaceId,
  useWorkspaceMetadata,
} from "../../providers/workspace-state-provider";
import { useAgentSessionStore } from "../../stores/agent-session-store";
import { useWorkspaceStore } from "../../stores/code-store";
import { conversationScopeActions } from "../../stores/right-panel-react";
import {
  draftConversationKey,
  draftConversationRef,
  sessionConversationKey,
  sessionConversationRef,
} from "../../stores/right-panel-store";
import {
  useSessionSkills,
  useSessionSkillsStore,
} from "../../stores/session-skills-store";
import {
  MODEL_PICK_TIMEOUT_MS,
  modelPickHonoured,
  modelUnavailableErrorOf,
  resolveModelForSession,
  sessionModelFor,
} from "../../utils/model-selection";
import { detectActiveSkills } from "../../utils/skill-utils";
import { BotsHome } from "../bots/bots-home";
import { HomeUpdateBanner } from "../common/home-update-banner";
import { Button } from "../ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "../ui/input-group";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerProvider,
  MessageScrollerViewport,
  useMessageScroller,
} from "../ui/message-scroller";
import { useConversationActivator } from "../workspace/workspace-activation";
import { WorkspaceMissingDialog } from "../workspace/workspace-missing-dialog";
import { ChatMessageList, UserMessageBubble } from "./agent-message";
import { BotMessageList } from "./bot-message-list";
import type { WorkspaceOutgoingAttachment } from "./chat-composer";
import { ChatComposer } from "./chat-composer";
import type { PendingPermissionInfo } from "./chat-composer";
import { resolveDroppedOsFiles } from "./chat-composer";
import { ComposerUpdateStrip } from "./composer-update-strip";
import { createPreparedComposerSession } from "./composer-worktree";
import { ConnectorRequestCard } from "./connector-request-card";
import { Greeting } from "./greeting";
import { PendingSteers } from "./pending-steers";
import { buildChatItems, getAgentStatusLabel } from "./render-utils";
import { SESSION_STARTERS } from "./session-starters";
import { SubtaskScopeHeader } from "./subtask-card";
import { ThinkingLoader } from "./thinking-loader";

// Stable empty array — prevents new [] literals from invalidating effect deps
// on every render when agentSessionsQuery.data is undefined.
const EMPTY_SESSIONS: AgentSessionListItem[] = [];
const EMPTY_WORKSPACES: WorkspaceListItem[] = [];
const EMPTY_WORKTREES: WorktreeListItem[] = [];
const CURRENT_WORKTREE_ENVIRONMENT: WorktreeDraftEnvironment = {
  kind: "current",
};

// Auto-start retry governor. A CLI that dies at exec re-arms the auto-start
// effect the instant its status falls back to stopped/error, so without a cap
// and backoff the only throttle is the child's death latency (~10ms).
const MAX_CLI_START_ATTEMPTS = 5;
const CLI_START_BACKOFF_BASE_MS = 500;
const CLI_START_BACKOFF_MAX_MS = 8000;

// ─── Scroll to bottom button ──────────────────────────────────────────────────

// Exposes the scroller's typed imperative action to the send path.
const ScrollToBottomBridge = ({
  scrollRef,
}: {
  scrollRef: React.MutableRefObject<(() => void) | null>;
}): null => {
  const { scrollToEnd } = useMessageScroller();
  scrollRef.current = () => {
    scrollToEnd({ behavior: "smooth" });
  };
  return null;
};

const ScrollToBottomButton = (): JSX.Element => {
  const { t } = useTranslation();
  return (
    <MessageScrollerButton
      direction="end"
      data-id="local-code-scroll-to-bottom"
      aria-label={t("workspace.chat.scrollToBottom")}
    />
  );
};

// ─── Permission extraction ────────────────────────────────────────────────────

function toPendingPermission(
  prompt: ReturnType<typeof usePermission>["prompt"],
  workspaceId: string | null,
  sessionId: string | null
): PendingPermissionInfo | null {
  if (prompt == null || workspaceId == null || sessionId == null) return null;
  return {
    // The composer answers through the conversation transport, which owns the
    // toolCallId -> CLI permissionId join, so the tool id is the handle here.
    permissionId: prompt.request.tool.id,
    toolName: prompt.request.tool.name,
    toolInput: prompt.request.tool.args,
    request: prompt.request,
    workspaceId,
    sessionId,
  };
}

// ─── ProjectSwitcher ──────────────────────────────────────────────────────────

/** A `workspace:` composer key is a new-session box; `session:` keys are open chats. */
const getBasename = (path: string): string => {
  const parts = path.split(/[/\\]/);
  return parts[parts.length - 1] || path;
};

/** The picker's name for a workspace: the folder's, or "Auto workspace" for the app-made one. */
export const workspaceDisplayName = (
  workspace: WorkspaceListItem,
  t: (key: string) => string
): string =>
  workspace.kind === "auto"
    ? t("workspace.autoWorkspace")
    : workspace.path
      ? getBasename(workspace.path)
      : workspace.label;

const ProjectSwitcher = ({
  workspaces,
  activeWorkspaceId,
  onSwitchWorkspace,
  onAddWorkspace,
}: {
  workspaces: WorkspaceListItem[];
  activeWorkspaceId: string | null;
  onSwitchWorkspace: (id: string) => void;
  onAddWorkspace: () => void;
}): JSX.Element => {
  const { t } = useTranslation();
  const [search, setSearch] = useState("");

  const active = workspaces.find((w) => w.id === activeWorkspaceId);
  const displayName =
    active != null
      ? workspaceDisplayName(active, t)
      : t("workspace.welcome.selectWorkspace");

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return q.length === 0
      ? workspaces
      : workspaces.filter(
          (w) =>
            w.label.toLowerCase().includes(q) ||
            (w.path ?? "").toLowerCase().includes(q)
        );
  }, [workspaces, search]);

  return (
    <DropdownMenu
      onOpenChange={(open) => {
        if (!open) setSearch("");
      }}
    >
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            className="text-secondary-foreground h-auto text-base"
            data-id="local-code-workspace-switcher-btn"
          />
        }
      >
        <Folder className="text-muted-foreground size-3.5" />
        <span className="font-medium">{displayName}</span>
        <ChevronDown className="size-3 opacity-70" />
      </DropdownMenuTrigger>

      <DropdownMenuContent align="center" sideOffset={10} className="w-70 p-0">
        <div className="border-b p-2">
          <InputGroup>
            <InputGroupAddon>
              <Search />
            </InputGroupAddon>
            <InputGroupInput
              autoFocus
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t("workspace.welcome.searchWorkspaces")}
              onKeyDown={(event) => event.stopPropagation()}
            />
          </InputGroup>
        </div>
        <div className="max-h-52 overflow-y-auto p-1">
          {filtered.length === 0 ? (
            <div className="text-muted-foreground px-3 py-3 text-center text-xs">
              {t("workspace.welcome.noWorkspacesFound")}
            </div>
          ) : (
            filtered.map((workspace) => {
              const isActive = workspace.id === activeWorkspaceId;
              const name = workspaceDisplayName(workspace, t);
              return (
                <DropdownMenuItem
                  key={workspace.id}
                  data-id={`local-code-workspace-item-${name}`}
                  onClick={() => onSwitchWorkspace(workspace.id)}
                  className={isActive ? "bg-accent text-foreground" : undefined}
                >
                  <Folder
                    className={
                      isActive ? "text-primary" : "text-muted-foreground"
                    }
                  />
                  <span className="min-w-0 flex-1 truncate">{name}</span>
                  {isActive && <Check className="text-primary" />}
                </DropdownMenuItem>
              );
            })
          )}
        </div>
        <DropdownMenuSeparator className="mx-0" />
        <div className="p-1 pt-0">
          <DropdownMenuItem
            data-id="local-code-add-workspace-btn"
            onClick={onAddWorkspace}
          >
            <FolderPlus className="text-muted-foreground" />
            <span>{t("workspace.welcome.addWorkspace")}</span>
          </DropdownMenuItem>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

// ─── Welcome screen ───────────────────────────────────────────────────────────

/** One per starter, in the order the cards read. */
const STARTER_ICON: Record<string, LucideIcon> = {
  "review-pull-requests": GitPullRequest,
  "design-a-pdf": FileText,
  "build-an-app": Globe,
  "process-a-spreadsheet": Table,
  "restyle-a-repo": Palette,
  "find-flights": Plane,
};

const WelcomeScreen = ({
  workspaces,
  activeWorkspaceId,
  onSwitchWorkspace,
  onAddWorkspace,
  onUsePrompt,
}: {
  workspaces: WorkspaceListItem[];
  activeWorkspaceId: string | null;
  onSwitchWorkspace: (id: string) => void;
  onAddWorkspace: () => void;
  /** Put a starter's prompt in the composer, for the user to edit and send. */
  onUsePrompt: (prompt: string) => void;
}): JSX.Element => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const autoWorkspacePath = useQuery({
    queryKey: ["session-home-workspace-path"],
    queryFn: () => window.api.agent.getSessionHomeWorkspacePath(),
    staleTime: Infinity,
  }).data;
  // Which + was pressed. Both land here — nothing active, nothing said — so
  // the pane cannot tell a new bot from a new session without being told.
  const newPaneIntent = useWorkspaceStore((state) => state.newPaneIntent);

  const onOpenBot = (botId: string): void => {
    void navigate({ to: "/bots/$botId", params: { botId } });
  };

  return (
    <motion.div
      key="welcome"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      transition={{ duration: 0.35, ease: [0.4, 0, 0.2, 1] }}
      data-id="local-code-welcome"
      // Keyed off the same thing the branch below is, not off whether a
      // workspace is selected: the session screen can show with one selected.
      className={`@container flex min-w-0 flex-1 flex-col items-center ${newPaneIntent === "session" ? "justify-center gap-4 px-4 sm:gap-8 sm:px-6" : ""}`}
    >
      {newPaneIntent === "session" ? (
        <>
          <div className="flex w-full min-w-0 flex-col items-center gap-4">
            <div className="bg-sidebar border-border text-primary flex h-14 w-14 items-center justify-center rounded-2xl border">
              <Laptop className="size-6" />
            </div>
            <Greeting />
          </div>

          {/* The picker says what it is. A sentence above it telling the user
              to pick a workspace was a caption for a control that already
              reads as one, on the emptiest screen in the app. */}
          <div className="flex flex-col items-center gap-1.5">
            <ProjectSwitcher
              workspaces={workspaces.filter(
                (workspace) => !isAppInternalWorkspace(workspace)
              )}
              activeWorkspaceId={activeWorkspaceId}
              onSwitchWorkspace={onSwitchWorkspace}
              onAddWorkspace={onAddWorkspace}
            />
            {/* With nothing picked a send lands in the app's own auto
                workspace, which the picker does not list — so its path is
                said here, in advance. */}
            {activeWorkspaceId == null && autoWorkspacePath != null && (
              <p
                className="text-muted-foreground max-w-md truncate text-center text-xs"
                data-id="local-code-workspace-hint"
                title={autoWorkspacePath}
              >
                {t("workspace.welcome.defaultWorkspace", {
                  path: autoWorkspacePath,
                })}
              </p>
            )}
          </div>

          {/* Openers. A card fills the composer rather than sending: the
              prompt is a draft to edit — the file, the screen, the app it
              talks about are still only in the user's head. */}
          <div
            className="grid w-full max-w-3xl grid-cols-[repeat(auto-fit,minmax(13rem,1fr))] gap-3"
            data-id="session-starters"
          >
            {SESSION_STARTERS.map((starter) => {
              const Icon = STARTER_ICON[starter.id] ?? Sparkles;
              return (
                <button
                  key={starter.id}
                  type="button"
                  data-id={`session-starter-${starter.id}`}
                  onClick={() => onUsePrompt(starter.prompt)}
                  className="border-border bg-card hover:border-primary/40 flex h-full flex-col items-start rounded-2xl border p-3.5 text-left transition-colors"
                >
                  <span className="flex w-full items-center gap-2.5">
                    <span className="bg-muted text-primary flex size-9 shrink-0 items-center justify-center rounded-lg">
                      <Icon className="size-5" aria-hidden="true" />
                    </span>
                    <span className="text-foreground min-w-0 text-sm leading-tight font-semibold">
                      {t(`workspace.welcome.starters.${starter.id}.name`)}
                    </span>
                  </span>
                  <span className="text-muted-foreground mt-2.5 line-clamp-3 text-xs leading-snug">
                    {t(`workspace.welcome.starters.${starter.id}.description`)}
                  </span>
                </button>
              );
            })}
          </div>
        </>
      ) : (
        // The bot maker fills the pane on its own — no heading, no composer:
        // the first thing this app asks for is a bot, not a prompt.
        <>
          <HomeUpdateBanner />
          <BotsHome onCreated={(bot) => onOpenBot(bot.id)} />
        </>
      )}
    </motion.div>
  );
};

// ─── Chat panel ───────────────────────────────────────────────────────────────

export const ChatPanel = (): JSX.Element => {
  const { t } = useTranslation();
  const activeWorkspaceId = useWorkspaceActiveWorkspaceId();
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const scrollToBottomRef = useRef<(() => void) | null>(null);
  const [inputValue, setInputValueState] = useState("");
  // Bumped when a failed turn offers a different model: the composer's
  // picker shakes, the same way it does when a send has no model.
  const [modelAttention, setModelAttention] = useState(0);
  const handleSwitchModel = useCallback(
    () => setModelAttention((value) => value + 1),
    []
  );

  const metadata = useWorkspaceMetadata();

  const pendingNewSessionByWorkspace = useAgentSessionStore(
    (s) => s.pendingNewSessionByWorkspace
  );

  // Transcript state comes straight from the conversation store, which the
  // NDJSON bridge feeds with the CLI's raw event stream.
  const allSegments = useSegments();
  const subtasks = useSubtasks();
  const todos = useTodos();
  const conversation = useConversation();
  const queuedMessages = useQueuedMessages();
  const { prompt: permissionPrompt } = usePermission();
  const activity = useConversationActivity();

  const {
    setActiveSessionId,
    setSelectedMode,
    setWorkspaceModelId,
    setSelectedModelId,
    activateWorkspaceSession,
    reconcileSessionsForWorkspace,
  } = useWorkspaceStore(
    useShallow((s) => ({
      setActiveSessionId: s.setActiveSessionId,
      setSelectedMode: s.setSelectedMode,
      setWorkspaceModelId: s.setWorkspaceModelId,
      setSelectedModelId: s.setSelectedModelId,
      activateWorkspaceSession: s.activateWorkspaceSession,
      reconcileSessionsForWorkspace: s.reconcileSessionsForWorkspace,
    }))
  );

  const {
    workspaceUiStates,
    workspaceSelectedModelIds,
    globalSelectedModelId,
    globalSelectedMode,
  } = useWorkspaceStore(
    useShallow((s) => ({
      workspaceUiStates: s.workspaceUiStates,
      workspaceSelectedModelIds: s.workspaceSelectedModelIds,
      globalSelectedModelId: s.selectedModelId,
      globalSelectedMode: s.globalSelectedMode,
    }))
  );

  const agentSessionsQuery = useWorkspaceAgentSessionsQuery(activeWorkspaceId);
  const workspaceSessions = agentSessionsQuery.data ?? EMPTY_SESSIONS;

  // Keep the sessionId → workspaceId ledger in sync with the session list:
  // setActiveSessionId validates against it, so a just-listed session must be
  // registered before any handler can make it active.
  const prevSessionIdsRef = useRef<string>("");
  useEffect(() => {
    if (activeWorkspaceId == null) return;
    // Placeholder data is the previous workspace's list — never reconcile it.
    if (agentSessionsQuery.isPlaceholderData) return;
    const sessionIds = workspaceSessions
      .filter((s) => !isPlaceholderSession(s) && typeof s.id === "string")
      .map((s) => s.id);
    // Skip when the id-set hasn't changed (label-only updates trigger a new
    // workspaceSessions ref but not a ledger-relevant change).
    const fingerprint = `${activeWorkspaceId}:${sessionIds.join(",")}`;
    if (prevSessionIdsRef.current === fingerprint) return;
    prevSessionIdsRef.current = fingerprint;
    reconcileSessionsForWorkspace(activeWorkspaceId, sessionIds);
  }, [
    activeWorkspaceId,
    workspaceSessions,
    agentSessionsQuery.isPlaceholderData,
    reconcileSessionsForWorkspace,
  ]);

  const activeSessionId =
    (activeWorkspaceId != null
      ? workspaceUiStates[activeWorkspaceId]?.activeSessionId
      : null) ?? null;
  const activeSession =
    workspaceSessions.find((s) => s.id === activeSessionId) ?? null;
  const draftWorkspaceId = activeSessionId == null ? activeWorkspaceId : null;

  // Bots-first composer identity: with no session open the most recent bot
  // stands selected; with no bots at all the composer's job is to create one.
  const botsQuery = useBotsQuery();
  const openBotChatMutation = useOpenBotChatMutation();
  const activateSelection = useConversationActivator();
  const bots = useMemo(() => botsQuery.data ?? [], [botsQuery.data]);
  // Which + was pressed: read before its first use, which is composerBot just
  // below — its other use is 1200 lines further down.
  const paneIntent = useWorkspaceStore((state) => state.newPaneIntent);
  const composerBot = useMemo(() => {
    if (activeSessionId != null)
      return bots.find((bot) => bot.sessionId === activeSessionId) ?? null;
    // A new session is nobody's bot: falling back to the most recent one would
    // send the message to that bot rather than start a session.
    if (paneIntent === "session") return null;
    if (bots.length === 0) return null;
    return [...bots].sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null;
  }, [activeSessionId, bots, paneIntent]);
  const composerPlaceholder =
    composerBot != null
      ? t("workspace.messageBot", { name: composerBot.name })
      : activeSessionId == null
        ? // A session was asked for, not a bot: telling the user to create one
          // names the wrong thing, and the send here starts the session.
          paneIntent === "session"
          ? t("workspace.startSessionToSend")
          : t("workspace.createBotToSend")
        : undefined;

  // The composer's identity: the open session (a bot's chat is a session), or
  // the workspace's new-session box. Draft and up-arrow history hang off it, so
  // text typed for one chat never shows up in another.
  const composerKey =
    activeSessionId != null
      ? `session:${activeSessionId}`
      : draftWorkspaceId != null
        ? `workspace:${draftWorkspaceId}`
        : null;

  const previousComposerKeyRef = useRef<string | null>(null);
  // The live text, for the transition below. Storage is not enough on its own:
  // until a folder is picked the box has no key, so a ref is the only copy of
  // what was typed.
  const inputValueRef = useRef("");
  inputValueRef.current = inputValue;
  useEffect(() => {
    const previousKey = previousComposerKeyRef.current;
    previousComposerKeyRef.current = composerKey;
    const { value, writes } = composerDraftForKeyChange({
      previousKey,
      nextKey: composerKey,
      current: inputValueRef.current,
    });
    for (const [key, text] of writes) writeComposerDraft(key, text);
    setInputValueState(value);
  }, [composerKey]);

  const setInputValue = useCallback(
    (next: SetStateAction<string>): void => {
      setInputValueState((current) => {
        const value = typeof next === "function" ? next(current) : next;
        if (composerKey != null) {
          writeComposerDraft(composerKey, value);
        }
        return value;
      });
    },
    [composerKey]
  );
  const conversationId = activeSession?.conversationId ?? null;
  const worktreesQuery = useWorktreesQuery(activeWorkspaceId);
  const worktrees = worktreesQuery.data ?? EMPTY_WORKTREES;
  const [draftWorktreeEnvironments, setDraftWorktreeEnvironments] = useState<
    Record<string, WorktreeDraftEnvironment>
  >({});
  const draftWorktreeEnvironmentsRef = useRef(draftWorktreeEnvironments);
  const setDraftWorktreeEnvironment = useCallback(
    (workspaceId: string, environment: WorktreeDraftEnvironment): void => {
      setDraftWorktreeEnvironments((current) => {
        const next = { ...current, [workspaceId]: environment };
        draftWorktreeEnvironmentsRef.current = next;
        return next;
      });
    },
    []
  );
  const draftWorktreeEnvironment =
    activeWorkspaceId == null
      ? CURRENT_WORKTREE_ENVIRONMENT
      : (draftWorktreeEnvironments[activeWorkspaceId] ??
        CURRENT_WORKTREE_ENVIRONMENT);
  const selectedWorktreeEnvironment: WorktreeDraftEnvironment =
    activeSessionId == null
      ? draftWorktreeEnvironment
      : activeSession?.worktreeId != null
        ? { kind: "existing", worktreeId: activeSession.worktreeId }
        : CURRENT_WORKTREE_ENVIRONMENT;
  const selectedWorktreeId =
    selectedWorktreeEnvironment.kind === "existing"
      ? selectedWorktreeEnvironment.worktreeId
      : null;
  // Which thread the transcript is showing: null = the main agent, otherwise a
  // sub-agent's own scoped view. Shared with the Agents tab.
  const subtaskScope = useSubtaskScope(activeSessionId);
  const setScope = useSubtaskScopeStore((s) => s.setScope);
  const setSubtaskScope = useCallback(
    (id: string | null) => {
      if (activeSessionId != null) setScope(activeSessionId, id);
    },
    [activeSessionId, setScope]
  );
  // Live skills for the active session, fed to the composer's slash picker.
  const composerSkills = useSessionSkills(activeSessionId);
  const skillsRefreshNonce = useSessionSkillsStore((s) => s.refreshNonce);
  const hasConversation = allSegments.length > 0;

  // Needed by the history loader to resolve `@.abacusai-bot/temp/...` image
  // mentions to absolute paths so thumbnails restore.
  const activeWorkspaceRoot =
    metadata.data?.workspaces?.find((w) => w.id === activeWorkspaceId)?.path ??
    null;

  // Seed the slash-command picker from skills on disk, independent of any
  // running CLI, so `/` works before the per-session `skills_loaded` arrives.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await window.api.skills?.listInstalled?.({
          workspacePath: activeWorkspaceRoot ?? undefined,
        });
        if (cancelled || res?.skills == null) return;
        useSessionSkillsStore.getState().setBaselineSkills(
          res.skills.map((s) => ({
            id: s.id,
            name: s.name,
            description: s.description,
            location: s.path,
          }))
        );
      } catch {
        /* keep whatever the picker already has */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeWorkspaceRoot, skillsRefreshNonce]);

  // The model the user last chose, so the picker can restore it on launch.
  const storedDefaultModel = useQuery({
    queryKey: workspaceQueryKeys.appSettings,
    queryFn: async () => window.api.agent.getSettings(),
    staleTime: 60_000,
  }).data?.defaultModel;

  // AbacusAIBot's own catalog (main process), not a cloud account's model list.
  const modelsQuery = useQuery({
    queryKey: workspaceQueryKeys.modelBots,
    queryFn: async () => window.api.agent.listModels(),
    staleTime: 60_000,
  });

  const sessionStateQuery = useAgentSessionStateQuery(
    activeWorkspaceId,
    activeSessionId
  );

  // Only models with a usable key: a session pinned to one whose key has since
  // gone should fall through rather than fail on its first token.
  const runnableModelIds = useMemo(
    () =>
      (modelsQuery.data ?? [])
        .filter((model) => model.configured)
        .map((model) => model.id),
    [modelsQuery.data]
  );

  // A chat keeps the model it ran on; the workspace and global picks only say
  // what a NEW chat starts from. Live CLI state first, then the stored record.
  // The dropdown pick is held, keyed by session, until this session runs it.
  const [pendingModelPick, setPendingModelPick] = useState<{
    sessionId: string;
    model: string;
  } | null>(null);
  const userPick =
    pendingModelPick != null && pendingModelPick.sessionId === activeSessionId
      ? pendingModelPick.model
      : null;

  const selectedModelValue = resolveModelForSession({
    userPick,
    sessionModel: sessionModelFor({
      activeSessionId,
      liveModel: sessionStateQuery.data?.model,
      storedModel: activeSession?.model,
    }),
    workspaceModel:
      activeWorkspaceId != null
        ? workspaceSelectedModelIds[activeWorkspaceId]
        : null,
    globalModel: globalSelectedModelId,
    runnableModelIds,
  });
  /**
   * A bot's chat runs at full permissions and does not offer the picker: bots
   * run unattended, and a permission prompt nobody answers is a bot that
   * quietly stopped. Sessions keep every mode and default to Ask.
   */
  const senderChats = useBotSenderChatsQuery().data ?? [];
  // The forever chat of a shared-channel bot: read-only, the conversation
  // happens in the chat app itself.
  const channelBotChat =
    activeSessionId != null
      ? (bots.find(
          (bot) => bot.sessionId === activeSessionId && bot.channel != null
        ) ?? null)
      : null;
  /** An auto-reply conversation: the bot's line to one remote sender. */
  const senderChatForSession = useMemo(
    () =>
      activeSessionId == null
        ? null
        : (senderChats.find((chat) => chat.sessionId === activeSessionId) ??
          null),
    [activeSessionId, senderChats]
  );
  const botOwningSession = useMemo(
    () =>
      activeSessionId == null
        ? null
        : (bots.find((bot) => bot.sessionId === activeSessionId) ??
          (senderChatForSession != null
            ? (bots.find((bot) => bot.id === senderChatForSession.botId) ??
              null)
            : null)),
    [activeSessionId, bots, senderChatForSession]
  );
  const isBotChat = botOwningSession != null;
  /**
   * Where the bot's live question sits in the thread, if it has one. The card
   * reports it; placing it is the list's job. Null puts it at the end.
   */
  const isSenderChat = senderChatForSession != null;
  /** A routine fire's session: a report, not a conversation to reply into. */
  const isRoutineRun = activeSession?.routineId != null;
  // A bot is always full access and never reads or writes the session mode.
  // Every session shares one sticky mode, so the welcome screen's picker shows
  // what the send spawns with.
  const selectedModeValue = isBotChat ? AgentMode.Yolo : globalSelectedMode;

  // Pick a model when none is chosen or the stored one is not offered (an old
  // id, a removed key). Never one whose key is missing: it fails on the first
  // token.
  useEffect(() => {
    const models = modelsQuery.data;
    if (!models || models.length === 0) return;

    const runnable = models.filter((m) => m.configured);
    const current = models.find((m) => m.id === selectedModelValue);
    if (current?.configured) return;

    if (runnable.length === 0) {
      // No credentials yet: a stale pick would make the composer claim a model
      // it cannot run.
      if (selectedModelValue.length > 0) {
        if (activeWorkspaceId != null)
          setWorkspaceModelId(activeWorkspaceId, "");
        else setSelectedModelId("");
      }

      return;
    }

    // Preference order: the user's last pick (~/.abacusai-bot/config.json,
    // which is what makes it sticky across restarts), then the catalog's
    // plan-tier recommendation, then the default, then anything runnable.
    const stored = storedDefaultModel;
    const next =
      (stored != null ? runnable.find((m) => m.id === stored) : undefined) ??
      runnable.find((m) => m.recommended === true) ??
      runnable.find((m) => m.id === DEFAULT_MODEL_ID) ??
      runnable[0];
    if (!next) return;

    if (activeWorkspaceId != null)
      setWorkspaceModelId(activeWorkspaceId, next.id);
    else setSelectedModelId(next.id);
  }, [
    activeWorkspaceId,
    modelsQuery.data,
    storedDefaultModel,
    selectedModelValue,
    setWorkspaceModelId,
    setSelectedModelId,
  ]);

  // Clear stale activeSessionId that no longer exists (e.g. after deleted session or old localStorage)
  useEffect(() => {
    if (activeWorkspaceId == null || activeSessionId == null) return;
    // Placeholder data is the previous workspace's list — not an answer here.
    if (agentSessionsQuery.isLoading || agentSessionsQuery.isPlaceholderData)
      return;
    const realSessions = workspaceSessions.filter(
      (s) => !isPlaceholderSession(s)
    );
    const exists = realSessions.some((s) => s.id === activeSessionId);
    if (!exists && realSessions.length > 0) {
      setActiveSessionId(activeWorkspaceId, null);
    }
  }, [
    activeWorkspaceId,
    activeSessionId,
    workspaceSessions,
    agentSessionsQuery.isLoading,
    agentSessionsQuery.isPlaceholderData,
    setActiveSessionId,
  ]);

  const createSessionMutation = useCreateSessionMutation();
  const startMutation = useStartCliSessionMutation();
  const setModelMutation = useSetCliModelMutation();
  const setModeMutation = useSetCliModeMutation();
  const sendMutation = useSendMessageMutation();
  const stopMutation = useStopTurnMutation();
  const updateLabelMutation = useUpdateSessionLabelMutation();
  const removeSessionMutation = useRemoveSessionMutation(activeWorkspaceId);
  const setSessionWorktreeMutation = useSetSessionWorktreeMutation();
  const prepareSessionWorktreeMutation = usePrepareSessionWorktreeMutation();
  const handleSelectWorktreeEnvironment = useCallback(
    (environment: WorktreeDraftEnvironment): void => {
      if (activeWorkspaceId == null) return;
      if (activeSessionId == null) {
        setDraftWorktreeEnvironment(activeWorkspaceId, environment);
        return;
      }
      if (environment.kind === "new") return;
      setSessionWorktreeMutation.mutate(
        {
          workspaceId: activeWorkspaceId,
          sessionId: activeSessionId,
          worktreeId:
            environment.kind === "existing" ? environment.worktreeId : null,
        },
        {
          onError: (error) => toast.error(error.message),
        }
      );
    },
    [
      activeSessionId,
      activeWorkspaceId,
      setDraftWorktreeEnvironment,
      setSessionWorktreeMutation,
    ]
  );

  // Sentinel `null` so the first run fires; initialising to the current value
  // would make the diff guard trivially true on mount.
  const prevModelRef = useRef<string | null>(null);
  const prevModeRef = useRef<string | null>(null);
  const titledSessionsRef = useRef<Set<string>>(new Set());

  // Tracks which (sessionId, CLI-start) combos have already received switch_conversation
  // so we fire it exactly once per CLI spawn. Keyed as `${sessionId}:${cliStartedAt}`.
  const switchedConvoRef = useRef<Set<string>>(new Set());

  // Consecutive failed auto-starts for the active session (see MAX_CLI_START_ATTEMPTS).
  const startAttemptsRef = useRef<{
    sessionId: string | null;
    attempts: number;
  }>({
    sessionId: null,
    attempts: 0,
  });
  // Session id whose auto-start has exhausted its retries — blocks the effect
  // until the user explicitly retries (toast action) or switches session.
  const [startGaveUpSessionId, setStartGaveUpSessionId] = useState<
    string | null
  >(null);

  // `workspaceMissingDismissedId` remembers a dismissal so the dialog doesn't
  // re-pop on every focus refetch.
  const workspacePathStatusQuery =
    useWorkspacePathStatusQuery(activeWorkspaceId);
  const [workspaceMissingDismissedId, setWorkspaceMissingDismissedId] =
    useState<string | null>(null);
  const workspacePathMissing = workspacePathStatusQuery.data?.exists === false;
  // Tombstoned workspaces are read-only anyway — a missing folder is expected
  // there, not something to fix, so the relocate/remove dialog stays away.
  const missingWorkspace =
    workspacePathMissing && activeWorkspaceId != null
      ? (metadata.data?.workspaces?.find(
          (w) => w.id === activeWorkspaceId && w.status !== "deleted"
        ) ?? null)
      : null;

  // Reset sync refs when the active session changes so the new session pushes
  // its mode/model on the first reach (e.g. after creating a session via "New").
  useEffect(() => {
    prevModelRef.current = null;
    prevModeRef.current = null;
    startAttemptsRef.current = { sessionId: activeSessionId, attempts: 0 };
    setStartGaveUpSessionId(null);
    setSubtaskScope(null);
  }, [activeSessionId, setSubtaskScope]);

  // Auto-start session when needed. Stable refs from the mutation: useMutation
  // returns a new object each render, which would fire this constantly.
  const startSessionMutate = startMutation.mutate;
  const isStartingSession = startMutation.isPending;
  useEffect(() => {
    if (activeWorkspaceId == null || activeSessionId == null) return;
    const status = sessionStateQuery.data?.status;
    // Only 'running' resets the failure counter: 'starting' is optimistic and
    // can collapse back to error within milliseconds.
    if (status === "running") {
      if (startAttemptsRef.current.attempts !== 0) {
        startAttemptsRef.current = { sessionId: activeSessionId, attempts: 0 };
      }
      return;
    }
    if (status === "starting") return;
    if (isStartingSession) return;
    if (startGaveUpSessionId === activeSessionId) return;

    // Folder gone: retrying can never fix it, so give up on the first hit and
    // let the dialog take over.
    if (
      (sessionStateQuery.data?.error ?? "").startsWith(
        WORKSPACE_MISSING_ERROR
      ) ||
      workspacePathMissing
    ) {
      setStartGaveUpSessionId(activeSessionId);
      return;
    }

    const ref = startAttemptsRef.current;
    if (ref.sessionId !== activeSessionId) {
      ref.sessionId = activeSessionId;
      ref.attempts = 0;
    }

    // Exhausted: stop forking and surface a clear, recoverable error.
    if (ref.attempts >= MAX_CLI_START_ATTEMPTS) {
      setStartGaveUpSessionId(activeSessionId);
      toast.error(t("workspace.cliStartFailed"), {
        id: `local-code-cli-start-failed-${activeSessionId}`,
        action: {
          label: t("workspace.cliStartRetry"),
          onClick: () => {
            startAttemptsRef.current = {
              sessionId: activeSessionId,
              attempts: 0,
            };
            setStartGaveUpSessionId(null);
          },
        },
      });
      return;
    }

    // Backs off 0.5s→1s→2s→4s (capped); the cleanup clears a pending retry so a
    // status transition can't leave a stale timer queued.
    const delay =
      ref.attempts === 0
        ? 0
        : Math.min(
            CLI_START_BACKOFF_BASE_MS * 2 ** (ref.attempts - 1),
            CLI_START_BACKOFF_MAX_MS
          );
    const timer = setTimeout(() => {
      startAttemptsRef.current.attempts += 1;
      startSessionMutate({
        workspaceId: activeWorkspaceId,
        sessionId: activeSessionId,
        model: selectedModelValue,
        mode: selectedModeValue,
      });
    }, delay);
    return () => clearTimeout(timer);
  }, [
    activeSessionId,
    activeWorkspaceId,
    sessionStateQuery.data?.status,
    sessionStateQuery.data?.error,
    workspacePathMissing,
    isStartingSession,
    startSessionMutate,
    startGaveUpSessionId,
    selectedModelValue,
    selectedModeValue,
    t,
  ]);

  // Push model/mode to the CLI only AFTER it's running. Sending earlier
  // races the CLI spawn (stdin not yet wired) and the command silently drops.
  const cliStatus = sessionStateQuery.data?.status;
  const isCliRunning = cliStatus === "running";

  // Let go once the session is genuinely on it. Live state only: the stored
  // record is written by the picker itself, so it would release the pick
  // before the agent had switched. See modelPickHonoured.
  useEffect(() => {
    if (pendingModelPick == null) return;
    if (
      modelPickHonoured(pendingModelPick.model, sessionStateQuery.data?.model)
    )
      setPendingModelPick(null);
  }, [pendingModelPick, sessionStateQuery.data?.model]);

  // The half where the agent neither confirms nor refuses: time-box the pick so
  // the picker cannot keep showing a model the chat is not running. Only while
  // the agent is running; a stopped session holds its pick until it starts.
  useEffect(() => {
    if (pendingModelPick == null || !isCliRunning) return;
    const held = pendingModelPick;
    const timer = setTimeout(() => {
      setPendingModelPick((pick) => (pick === held ? null : pick));
      toast.error(t("workspace.modelSwitchFailed"), {
        id: `local-code-model-pick-timeout-${held.sessionId}`,
      });
    }, MODEL_PICK_TIMEOUT_MS);

    return () => clearTimeout(timer);
  }, [pendingModelPick, isCliRunning, t]);

  // The refusal half: a pick the agent cannot run comes back as an error coded
  // model_unavailable, never as model_changed, so the honour check alone would
  // hold the pick forever. Let it go and say what happened.
  useEffect(() => {
    return window.api.agent.onEvent((event) => {
      if (event.type !== "local-cli-ndjson") return;
      const refusal = modelUnavailableErrorOf(event.payload);
      if (refusal == null) return;
      setPendingModelPick((pick) =>
        pick != null && pick.sessionId === event.sessionId ? null : pick
      );
      if (event.sessionId === activeSessionId) {
        toast.error(t("workspace.modelSwitchFailed"), {
          id: `local-code-model-unavailable-${event.sessionId}`,
          ...(refusal.length > 0 ? { description: refusal } : {}),
        });
      }
    });
  }, [activeSessionId, t]);

  useEffect(() => {
    if (
      activeWorkspaceId == null ||
      activeSessionId == null ||
      selectedModelValue.length === 0
    )
      return;
    if (!isCliRunning) return;
    // Say nothing until this session's own model is known: before its list
    // arrives it resolves to the workspace default, and pushing that would
    // move a running chat onto it.
    if (agentSessionsQuery.isLoading || sessionStateQuery.isLoading) return;
    const runningModel = sessionStateQuery.data?.model;
    if (runningModel != null && runningModel === selectedModelValue) return;
    if (prevModelRef.current === selectedModelValue) return;
    prevModelRef.current = selectedModelValue;
    setModelMutation.mutate({
      workspaceId: activeWorkspaceId,
      sessionId: activeSessionId,
      model: selectedModelValue,
    });
  }, [
    activeSessionId,
    activeWorkspaceId,
    selectedModelValue,
    setModelMutation,
    isCliRunning,
    agentSessionsQuery.isLoading,
    sessionStateQuery.isLoading,
    sessionStateQuery.data?.model,
  ]);

  useEffect(() => {
    if (activeWorkspaceId == null || activeSessionId == null) return;
    if (!isCliRunning) return;
    if (prevModeRef.current === selectedModeValue) return;
    prevModeRef.current = selectedModeValue;
    setModeMutation.mutate({
      workspaceId: activeWorkspaceId,
      sessionId: activeSessionId,
      mode: selectedModeValue,
    });
  }, [
    activeSessionId,
    activeWorkspaceId,
    selectedModeValue,
    setModeMutation,
    isCliRunning,
  ]);

  /**
   * Name a session from its opening message: the first non-empty line, trimmed
   * to something that fits the sidebar. Runs once per session.
   */
  const generateTitleAsync = (
    workspaceId: string,
    sessionId: string,
    message: string
  ): void => {
    if (titledSessionsRef.current.has(sessionId)) return;
    titledSessionsRef.current.add(sessionId);

    const firstLine =
      message
        .split("\n")
        .find((line) => line.trim().length > 0)
        ?.trim() ?? "";
    if (firstLine.length === 0) return;
    const title =
      firstLine.length > 60
        ? `${firstLine.slice(0, 57).trimEnd()}…`
        : firstLine;
    updateLabelMutation.mutate({ workspaceId, sessionId, label: title });
  };

  const sendInFlightRef = useRef(false);
  const sendMessageUnlocked = async (
    attachments: WorkspaceOutgoingAttachment[] = [],
    messageOverride?: string
  ): Promise<void> => {
    const messageText = messageOverride ?? inputValue.trim();
    if (messageText.length === 0 && attachments.length === 0) return;

    // Say so when the send is also a "remember this". Main does the writing
    // with the same detector; this only decides whether to say anything.
    if (detectRememberRequest(messageText) != null)
      toast.success(t("memory.rememberedToast"), { id: "memory-remembered" });

    // Bots-first, but only when a bot was asked for: with no session open the
    // send goes into the selected bot's forever chat, activated here so the
    // staging below sees it. A session's send must skip this or land in a bot.
    if (paneIntent !== "session") {
      const pre = useWorkspaceStore.getState();
      const preWorkspaceId = pre.activeWorkspaceId;
      const preSessionId =
        preWorkspaceId != null
          ? (pre.workspaceUiStates[preWorkspaceId]?.activeSessionId ?? null)
          : null;
      if (preSessionId == null) {
        if (composerBot == null) {
          // The maker is already what this pane shows with no bot chat open,
          // so there is nothing to pop: the user is looking at the thing that
          // makes one.
          return;
        }
        try {
          const handle = await openBotChatMutation.mutateAsync(composerBot.id);
          activateSelection({
            workspaceId: handle.workspaceId,
            sessionId: handle.sessionId,
          });
        } catch {
          toast.error(t("bots.openError"), { id: "bot-open" });
          return;
        }
      }
    }

    // Snapshot workspace + session at click time from the Zustand store:
    // closing over render-cycle props would let a workspace switch in flight
    // redirect the send.
    const storeSnapshot = useWorkspaceStore.getState();
    let workspaceId = storeSnapshot.activeWorkspaceId;
    if (workspaceId == null) {
      // No project picked: the chat runs in the app's own session folder,
      // made and selected here rather than asked for — see sessionDefaultWorkspace.
      const autoWorkspaceId =
        await window.api.agent.ensureSessionHomeWorkspace();
      if (autoWorkspaceId == null) {
        toast.warning(t("workspace.selectWorkspaceToSend"), {
          id: "local-code-no-workspace",
        });
        return;
      }
      activateWorkspaceSession(autoWorkspaceId, null);
      void window.api.agent.switchWorkspace(autoWorkspaceId);
      invalidateWorkspaceCaches();
      workspaceId = autoWorkspaceId;
    }
    const initialSessionId =
      storeSnapshot.workspaceUiStates[workspaceId]?.activeSessionId ?? null;

    // Checked before anything is staged: a send into a deleted folder otherwise
    // dies deep inside the CLI spawn. Seeding the cache also pops the dialog.
    const pathStatus = await window.api.agent.checkWorkspacePath(workspaceId);
    if (!pathStatus.exists) {
      queryClient.setQueryData(
        workspaceQueryKeys.workspacePathStatus(workspaceId),
        pathStatus
      );
      setWorkspaceMissingDismissedId(null);
      toast.warning(
        t("workspace.workspaceMissing.sendBlocked", {
          path: pathStatus.path ?? "",
        }),
        {
          id: `workspace-missing-${workspaceId}`,
        }
      );
      return;
    }

    // Against the SAME workspace: the outer-scope `conversationId` follows the
    // current render and could already point at a different one.
    const sessionsForWorkspace =
      queryClient.getQueryData<AgentSessionListItem[]>(
        workspaceQueryKeys.agentSessions(workspaceId)
      ) ?? [];
    const initialConversationId =
      initialSessionId != null
        ? (sessionsForWorkspace.find((s) => s.id === initialSessionId)
            ?.conversationId ?? null)
        : null;

    // Required for the per-workspace temp dir,
    // <workspaceRoot>/.abacusai-bot/temp/.
    const metadataSnapshot = queryClient.getQueryData<{
      workspaces?: WorkspaceListItem[];
    }>(workspaceQueryKeys.metadata);
    const workspaceRoot =
      metadataSnapshot?.workspaces?.find((w) => w.id === workspaceId)?.path ??
      null;

    let userMessage = messageText;
    if (messageOverride == null) {
      setInputValue("");
      if (inputRef.current != null) inputRef.current.style.height = "auto";
    }

    const store = useAgentSessionStore.getState();
    const wasNewSession = initialSessionId == null;
    const requestedWorktreeEnvironment =
      draftWorktreeEnvironmentsRef.current[workspaceId] ??
      CURRENT_WORKTREE_ENVIRONMENT;

    // Attachments become @-mentions; pasted bytes are saved to the temp dir
    // first. Done BEFORE staging the optimistic bubble, which derives its
    // thumbnails from those @-mentions and needs the files on disk.
    const fileRefs: string[] = [];
    const pastedAttachments = attachments.filter((att) => att.path == null);
    for (const att of attachments) {
      if (att.path != null) fileRefs.push(`@${att.path}`);
    }
    if (pastedAttachments.length > 0) {
      if (workspaceRoot == null) {
        toast.error(t("workspace.attach.noWorkspacePath"));
        return;
      }
      const filesToSave: Array<{ name: string; data: Uint8Array }> = [];
      const attachmentMeta: Array<{
        att: (typeof attachments)[number];
        safeName: string;
      }> = [];
      for (const att of pastedAttachments) {
        const dot = att.fileName.lastIndexOf(".");
        const ext =
          dot > 0
            ? att.fileName.slice(dot + 1)
            : att.mimeType.startsWith("image/")
              ? att.mimeType.split("/")[1] || "png"
              : "bin";
        const safeName = `${att.id}.${ext}`;
        filesToSave.push({ name: safeName, data: att.data });
        attachmentMeta.push({ att, safeName });
      }
      let saveRes: Awaited<ReturnType<typeof window.api.savePastedTempFiles>>;
      try {
        saveRes = await window.api.savePastedTempFiles(
          workspaceRoot,
          filesToSave
        );
      } catch (err) {
        toast.error(
          t("workspace.attach.saveFailed", {
            error:
              err instanceof Error
                ? err.message
                : t("workspace.attach.unknownError"),
          })
        );
        return;
      }
      if (
        saveRes?.success !== true ||
        saveRes.dir == null ||
        saveRes.paths == null
      ) {
        toast.error(
          t("workspace.attach.saveFailed", {
            error: saveRes?.error ?? t("workspace.attach.unknownError"),
          })
        );
        return;
      }
      for (let i = 0; i < attachmentMeta.length; i++) {
        const absPath = saveRes.paths[i];
        if (absPath == null) continue;
        // Absolute paths in @-mentions — agent resolves via filesystem.
        fileRefs.push(`@${absPath}`);
      }
    }
    if (fileRefs.length > 0) {
      userMessage =
        userMessage.length > 0
          ? `${userMessage}\n\n${fileRefs.join("\n")}`
          : fileRefs.join("\n");
    }

    // Synchronously stage the optimistic UI BEFORE any awaits so the welcome
    // screen disappears on the next paint, even if createAgentSession is slow.
    if (wasNewSession) {
      // Pending-new-session bubble doesn't carry images yet (we'll apply
      // them to the real session segment once createSession resolves).
      store.setPendingNewSession(workspaceId, {
        message: userMessage,
        segmentId: crypto.randomUUID(),
      });
      // New-chat mode stays on until the new session is active: it alone holds
      // off the auto-select effect, which would otherwise pull the view into
      // the most recently updated chat mid-send.
    } else if (!isAgentBusy) {
      // Insert the user segment immediately so the bubble precedes the send
      // round-trip. Not while a turn is running: the message steers that turn
      // and the host echoes it where it landed.
      workspaceConversationTransport.echoUserMessage(
        initialSessionId,
        userMessage
      );
    }

    // Bring the new bubble into view if the user had scrolled up. Defer until
    // after the React commit so the new content is in the DOM.
    requestAnimationFrame(() => {
      scrollToBottomRef.current?.();
    });

    try {
      let sessionIdToUse = initialSessionId;
      const conversationIdToUse = initialConversationId;
      if (sessionIdToUse == null) {
        const prepared = await createPreparedComposerSession({
          workspaceId,
          environment: requestedWorktreeEnvironment,
          createSession: (id) => createSessionMutation.mutateAsync(id),
          prepareSession: (params) =>
            prepareSessionWorktreeMutation.mutateAsync(params),
        });
        const newSession = prepared.session;
        sessionIdToUse = newSession.id;
        // Register in the workspace-ownership ledger BEFORE setActiveSessionId
        // (the latter validates against the ledger and would reject otherwise).
        useWorkspaceStore
          .getState()
          .registerSessionWorkspace(newSession.id, workspaceId);
        const draftScope = draftConversationKey(workspaceId);
        const sessionScope = sessionConversationKey(workspaceId, newSession.id);
        await window.api.agent.promoteBrowserRuntimeScope({
          draftConversationKey: draftScope,
          sessionConversationKey: sessionScope,
        });
        await window.api.agent.promoteTerminalSessionScope({
          draftConversationKey: draftScope,
          draftConversation: draftConversationRef(workspaceId),
          sessionConversationKey: sessionScope,
          sessionConversation: sessionConversationRef(
            workspaceId,
            newSession.id
          ),
        });
        // A new chat already owns conversation-scoped surfaces before its
        // first session exists. Move that state before activating the saved
        // session so the shell never observes an empty intermediate scope.
        conversationScopeActions.promoteDraft(draftScope, sessionScope);
        setActiveSessionId(workspaceId, newSession.id);
        // Move the placeholder message + image attachments into the real session runtime.
        workspaceConversationTransport.registerSession(
          newSession.id,
          workspaceId
        );
        workspaceConversationTransport.echoUserMessage(
          newSession.id,
          userMessage
        );
        useAgentSessionStore.getState().setPendingNewSession(workspaceId, null);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      // Before the first send on a resumed session, switch_conversation
      // hydrates the CLI's conversation mapping, or it sends a None
      // deployment_conversation_id and every retry fails. Once per CLI spawn.

      if (conversationIdToUse != null) {
        const cliStartedAtNow = sessionStateQuery.data?.startedAt ?? null;
        if (cliStartedAtNow != null) {
          const switchKey = `${sessionIdToUse}:${cliStartedAtNow}`;
          if (!switchedConvoRef.current.has(switchKey)) {
            switchedConvoRef.current.add(switchKey);
            await window.api.agent.switchAgentConversation({
              workspaceId,
              sessionId: sessionIdToUse,
              conversationId: conversationIdToUse,
            });
          }
        }
      }

      // Detect a leading /skill command and forward it as an active skill
      // (the inline `/id` text also stays in the message for the CLI to parse).
      const sessionSkills =
        useSessionSkillsStore.getState().skillsBySession[sessionIdToUse] ?? [];
      const detectedSkills = detectActiveSkills(messageText, sessionSkills);

      // Analytics: message_sent (code mode)

      // sendMutation.onMutate flips the cached turn-state to "pending" — the
      // single source of truth driving the busy UI everywhere.
      await sendMutation.mutateAsync({
        workspaceId,
        sessionId: sessionIdToUse,
        message: userMessage,
        ...(conversationIdToUse != null
          ? { conversationId: conversationIdToUse }
          : {}),
        ...(detectedSkills.length > 0 ? { activeSkills: detectedSkills } : {}),
      });

      if (wasNewSession) {
        generateTitleAsync(workspaceId, sessionIdToUse, userMessage);
        setDraftWorktreeEnvironment(workspaceId, CURRENT_WORKTREE_ENVIRONMENT);
      }
    } catch (error) {
      if (isUndeliverableMessage(error)) {
        // Nothing received it: take the echo back and hand the message to the
        // composer so it can be sent again once the session is up.
        const echoedIn =
          useWorkspaceStore.getState().workspaceUiStates[workspaceId]
            ?.activeSessionId ?? null;
        if (echoedIn != null)
          workspaceConversationTransport.retractUserMessage(echoedIn);
        setInputValue(userMessage);
        toast.error(t("workspace.sendUndeliverable"), {
          id: `send-undeliverable-${workspaceId}`,
        });
      } else {
        const errorMessage =
          error instanceof Error ? error.message : "Failed to send message";
        if (wasNewSession) setInputValue(userMessage);
        toast.error(errorMessage);
      }
      // Clear the welcome→conversation placeholder; the mutation's onError
      // already rolled back the cached turn state.
      useAgentSessionStore.getState().setPendingNewSession(workspaceId, null);
    }
  };

  const sendMessage = async (
    attachments: WorkspaceOutgoingAttachment[] = [],
    messageOverride?: string
  ): Promise<void> => {
    if (sendInFlightRef.current) return;
    sendInFlightRef.current = true;
    try {
      await sendMessageUnlocked(attachments, messageOverride);
    } finally {
      sendInFlightRef.current = false;
    }
  };

  const stopTurn = useCallback((): void => {
    if (activeWorkspaceId == null) return;

    // (a) Send then Stop before createAgentSession finished: no session yet,
    //     so pop the pending message back into the input, return to welcome.
    const pending =
      useAgentSessionStore.getState().pendingNewSessionByWorkspace[
        activeWorkspaceId
      ];
    if (pending != null && activeSessionId == null) {
      setInputValue(pending.message);
      useAgentSessionStore
        .getState()
        .setPendingNewSession(activeWorkspaceId, null);
      return;
    }

    if (activeSessionId == null) return;

    // Messages still on their way to the model are not lost with the turn:
    // the host runs them as the next turn once the abort lands. Only the
    // reply in flight is being stopped.

    // (b) Existing session: an unanswered user message pops back into the
    //     input; a session left empty is deleted so the sidebar keeps no row.
    const segs = workspaceConversationStore.getSegments(activeSessionId);
    const lastSeg = segs[segs.length - 1];
    if (
      lastSeg != null &&
      lastSeg.type === "text" &&
      lastSeg.source === "user"
    ) {
      setInputValue(lastSeg.content);
      workspaceConversationTransport.retractUserMessage(activeSessionId);
      const remaining = workspaceConversationStore.getSegments(activeSessionId);
      if (remaining.length === 0) {
        // Empty session: return to welcome and remove it entirely.
        const sessionIdToRemove = activeSessionId;
        setActiveSessionId(activeWorkspaceId, null);
        removeSessionMutation.mutate(sessionIdToRemove);
        return;
      }
    }

    // onMutate flips the cached turn-state to "idle" synchronously; main then
    // suppresses in-flight CLI events for this session until the next send.
    stopMutation.mutate({
      workspaceId: activeWorkspaceId,
      sessionId: activeSessionId,
    });
  }, [
    activeWorkspaceId,
    activeSessionId,
    stopMutation,
    setActiveSessionId,
    setInputValue,
    removeSessionMutation,
  ]);

  // Update Zustand SYNCHRONOUSLY first so the next render reflects the new
  // workspace, then ack to main; no fire-and-forget IPC racing visible state.
  const invalidateWorkspaceCaches = useCallback((): void => {
    void queryClient.invalidateQueries({
      queryKey: workspaceQueryKeys.metadata,
    });
    void queryClient.invalidateQueries({
      queryKey: workspaceQueryKeys.gitStateRoot,
    });
    void queryClient.invalidateQueries({
      queryKey: workspaceQueryKeys.fileTreeRootRoot,
    });
    void queryClient.invalidateQueries({
      queryKey: workspaceQueryKeys.gitBranchesRoot,
    });
    void queryClient.invalidateQueries({
      queryKey: workspaceQueryKeys.gitCurrentBranchRoot,
    });
  }, [queryClient]);

  const handleSwitchWorkspace = useCallback(
    (workspaceId: string): void => {
      activateWorkspaceSession(workspaceId, null);
      void window.api.agent.switchWorkspace(workspaceId);
      invalidateWorkspaceCaches();
    },
    [activateWorkspaceSession, invalidateWorkspaceCaches]
  );

  // A starter card is a draft, not a send: the thing the prompt talks about is
  // still only in the user's head.
  const useStarterPrompt = useCallback(
    (prompt: string): void => {
      setInputValue(prompt);
      requestAnimationFrame(() => {
        const el = inputRef.current;
        if (el == null) return;
        el.focus();
        el.setSelectionRange(prompt.length, prompt.length);
      });
    },
    [setInputValue]
  );

  const handleAddWorkspace = useCallback(async (): Promise<void> => {
    const path = await window.api.openFolderDialog();
    if (path == null || path.trim().length === 0) return;
    const result = await window.api.agent.addWorkspace(path, false);
    if (!result.success) {
      toast.error(result.error ?? "Unable to add workspace.");
      return;
    }
    const newWorkspaceId = result.workspaceId;
    if (newWorkspaceId == null) {
      invalidateWorkspaceCaches();
      return;
    }
    // Synchronous renderer-side switch + clean slate for the new workspace
    // before any further interaction is possible.
    activateWorkspaceSession(newWorkspaceId, null);
    void window.api.agent.switchWorkspace(newWorkspaceId);
    invalidateWorkspaceCaches();
  }, [invalidateWorkspaceCaches, activateWorkspaceSession]);

  // Derived state — busy/loading is read from the single source of truth (TQ cache).
  const turnStateQuery = useSessionTurnStateQuery(
    activeWorkspaceId,
    activeSessionId
  );
  // The staged send belongs to the chat being created, which has no session id
  // yet, so it is only this view's message while no session is active; read
  // workspace-wide it would paint into whichever chat is on screen.
  const pendingNewSession =
    activeWorkspaceId != null && activeSessionId == null
      ? (pendingNewSessionByWorkspace[activeWorkspaceId] ?? null)
      : null;
  // An open permission prompt IS the waiting state: `permission_needed` arrives
  // with no `status_changed`, so the raw status sits at `executing-tool` while
  // the CLI blocks. Deriving it here keeps every consumer consistent.
  const agentStatus =
    permissionPrompt != null
      ? AgentStatus.WaitingForToolPermission
      : (conversation.status as AgentStatus);
  const isStreaming = agentStatus === AgentStatus.Streaming;
  // Gate on activeSessionId: the query keeps placeholderData after the session
  // id clears, and a stale "busy" must not leak through.
  const sessionIsBusy =
    activeSessionId != null && (turnStateQuery.data?.isBusy ?? false);
  const isAgentBusy = sessionIsBusy || pendingNewSession != null;
  // The loader follows the thread on screen: inside a sub-agent only its own
  // run counts; on the main thread a running sub-agent's card has its own
  // spinner, and a second one would claim work the main agent isn't doing.

  const runningSubtask = useMemo(
    () => subtasks.find((s) => s.status === "running"),
    [subtasks]
  );
  const scopeIsActive =
    subtaskScope != null
      ? runningSubtask?.id === subtaskScope
      : runningSubtask == null;
  const isScopeBusy = isAgentBusy && scopeIsActive;
  // The CLI's spinner title is the most specific signal; the coarse status
  // label stands in between spinners.
  const statusLabel =
    activity.spinnerTitle ?? getAgentStatusLabel(agentStatus, isAgentBusy);
  const isCreatingSession = createSessionMutation.isPending;
  const workspaces = metadata.data?.workspaces ?? EMPTY_WORKSPACES;
  // Recorded here rather than in the picker: a workspace is just as often
  // reached by opening one of its chats from the sidebar.
  useEffect(() => {
    if (activeWorkspaceId == null) return;
    const active = workspaces.find((w) => w.id === activeWorkspaceId);
    if (
      active == null ||
      active.status === "deleted" ||
      isAppInternalWorkspace(active)
    )
      return;
    useWorkspaceStore.getState().setLastPickedWorkspaceId(activeWorkspaceId);
  }, [activeWorkspaceId, workspaces]);
  // A tombstoned workspace is read-only: its old chats open, but nothing may
  // be sent or started in it until it's re-added.
  const activeWorkspaceDeleted =
    workspaces.find((w) => w.id === activeWorkspaceId)?.status === "deleted";
  // Composer-side gate, minus the "non-empty input" check so an image-only send
  // goes through. A missing workspace is NOT one of these: the composer answers
  // it with a folder-picker popover, which needs a live button. Deleted counts.
  const canSend =
    !activeWorkspaceDeleted &&
    !sendMutation.isPending &&
    !isCreatingSession &&
    !prepareSessionWorktreeMutation.isPending &&
    !setSessionWorktreeMutation.isPending &&
    agentStatus !== AgentStatus.WaitingForToolPermission;

  const workspaceRoot = useMemo(() => {
    if (activeSession?.worktreePath != null) {
      return activeSession.worktreePath;
    }
    if (selectedWorktreeId != null) {
      const selectedPath = worktrees.find(
        (worktree) => worktree.id === selectedWorktreeId
      )?.path;
      if (selectedPath != null) return selectedPath;
    }
    return (
      workspaces.find((workspace) => workspace.id === activeWorkspaceId)
        ?.path ?? null
    );
  }, [
    activeSession?.worktreePath,
    activeWorkspaceId,
    selectedWorktreeId,
    workspaces,
    worktrees,
  ]);
  const homeDirRef = useRef<string | null>(null);
  useEffect(() => {
    void window.api.getHomeDir().then((h) => {
      homeDirRef.current = h;
    });
  }, []);

  const shortenPath = useCallback(
    (absPath: string): string => {
      const candidates: string[] = [absPath];
      if (workspaceRoot != null) {
        const root = workspaceRoot.replace(/[\\/]+$/, "");
        if (absPath.startsWith(root + "/") || absPath.startsWith(root + "\\")) {
          candidates.push(absPath.slice(root.length + 1));
        }
      }
      const home = homeDirRef.current?.replace(/[\\/]+$/, "");
      if (
        home != null &&
        (absPath.startsWith(home + "/") || absPath.startsWith(home + "\\"))
      ) {
        candidates.push("~/" + absPath.slice(home.length + 1));
      }
      return candidates.reduce((a, b) => (a.length <= b.length ? a : b));
    },
    [workspaceRoot]
  );

  // Scope the transcript to the thread being viewed: the main agent hides
  // sub-agent work behind its card, a sub-agent view shows only its own work.
  const scopedSegments = useMemo(
    () => scopeSegments(allSegments, subtaskScope),
    [allSegments, subtaskScope]
  );
  const chatItems = useMemo(
    () => buildChatItems(scopedSegments, subtasks),
    [scopedSegments, subtasks]
  );
  const activeSubtask = useMemo(
    () =>
      subtaskScope == null
        ? undefined
        : subtasks.find((s) => s.id === subtaskScope),
    [subtaskScope, subtasks]
  );

  // currentTurnId is the last agent turn only when it's also the last item:
  // after a followup the pending loader belongs AFTER the user bubble, not on
  // the previous agent turn.
  const currentTurnId = useMemo(() => {
    if (chatItems.length === 0) return undefined;
    const last = chatItems[chatItems.length - 1];
    return last.kind === "agent" ? last.id : undefined;
  }, [chatItems]);
  const latestUserTurnId = useMemo(() => {
    for (let index = chatItems.length - 1; index >= 0; index -= 1) {
      const item = chatItems[index];
      if (item?.kind === "user") return item.id;
    }
    return null;
  }, [chatItems]);

  const handleRetry = (): void => {
    void sendMessage([], t("workspace.retryMessage"));
  };

  // Pending permission for composer
  const pendingPermission = useMemo(
    () =>
      toPendingPermission(permissionPrompt, activeWorkspaceId, activeSessionId),
    [permissionPrompt, activeWorkspaceId, activeSessionId]
  );

  // Switching to a more permissive mode settles whatever is already queued:
  // `set_mode` only governs permissions the CLI has yet to ask for, so the
  // prompt that made the user switch would otherwise stay up.
  const autoResolvedPermissionRef = useRef<string | null>(null);
  useEffect(() => {
    if (permissionPrompt == null || activeSessionId == null) return;
    const toolCallId = permissionPrompt.request.tool.id;
    if (autoResolvedPermissionRef.current === toolCallId) return;

    const requestType = permissionPrompt.request.type;
    const isEdit =
      requestType === "edit_file" ||
      requestType === "write_file" ||
      requestType === "edit_outside_directory" ||
      requestType === "write_outside_directory";

    const decision =
      selectedModeValue === AgentMode.Yolo
        ? ("allowYolo" as const)
        : selectedModeValue === AgentMode.AcceptEdits && isEdit
          ? ("accept" as const)
          : null;
    if (decision == null) return;

    autoResolvedPermissionRef.current = toolCallId;
    void workspaceConversationTransport.respondToPermission(
      activeSessionId,
      toolCallId,
      decision
    );
  }, [permissionPrompt, selectedModeValue, activeSessionId]);

  const hasContent =
    chatItems.length > 0 || isAgentBusy || pendingNewSession != null;
  // The bot maker owns the whole pane, no composer and no workspace wait: main
  // resolves the workspace when the chat opens. A new session keeps its
  // composer; asking for a workspace and a prompt are the same screen.
  const showsBotMaker = !hasContent && paneIntent === "bot";
  // Transcripts live only in memory for now: nothing to re-fetch on open.
  const isExistingSessionLoading = false;
  // Session exists and has been used before (has a conversationId) but history failed to load
  const isHistoryLoadFailed = false;

  // Panel-level drop zone handles path-mentions only; image attachments go
  // through the composer's own drop zone, which owns the attachment state.
  const handlePanelDrop = useCallback(
    (e: DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      const paths: string[] = [];
      for (const { absPath } of resolveDroppedOsFiles(e.dataTransfer)) {
        paths.push(shortenPath(absPath));
      }
      if (paths.length === 0 || inputRef.current == null) return;
      const el = inputRef.current;
      const start = el.selectionStart ?? inputValue.length;
      const end = el.selectionEnd ?? inputValue.length;
      const prefix =
        start > 0 &&
        inputValue[start - 1] !== " " &&
        inputValue[start - 1] !== "\n"
          ? " "
          : "";
      const suffix =
        end < inputValue.length && inputValue[end] !== " " ? " " : "";
      const mention = paths.map((p) => `@${p}`).join(" ");
      setInputValue(
        inputValue.slice(0, start) +
          prefix +
          mention +
          suffix +
          inputValue.slice(end)
      );
      requestAnimationFrame(() => {
        const cur = start + prefix.length + mention.length + suffix.length;
        el.selectionStart = el.selectionEnd = cur;
        el.focus();
      });
    },
    [inputRef, inputValue, setInputValue, shortenPath]
  );

  return (
    <div
      className="bg-background relative flex h-full min-h-0 flex-col"
      data-id="local-code-chat-panel"
    >
      {/* Message / welcome area — also a drop zone for path-mentions */}
      <MessageScrollerProvider
        key={activeSessionId ?? "new-session"}
        autoScroll
        // A transcript opens at its newest message; the welcome pane at its
        // top, or the bot maker's name box lands off screen.
        defaultScrollPosition={activeSessionId == null ? "start" : "end"}
      >
        <MessageScroller className="min-h-0 flex-1">
          <MessageScrollerViewport
            aria-label={t("workspace.chat.conversation")}
            onDrop={handlePanelDrop}
            onDragOver={(event) => event.preventDefault()}
          >
            <MessageScrollerContent className="min-h-full gap-0">
              <AnimatePresence mode="wait">
                {isExistingSessionLoading ? (
                  <motion.div
                    key="loading"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.15 }}
                    className="mx-auto flex w-full flex-1 flex-col gap-4 px-5 pt-6 pb-6"
                  >
                    {[0.9, 0.7, 0.85, 0.6].map((width, i) => (
                      <div key={i} className="flex flex-col gap-2">
                        <div
                          className="bg-muted h-3 animate-pulse rounded-full"
                          style={{ width: `${width * 100}%` }}
                        />
                        {i % 2 === 0 && (
                          <div
                            className="bg-muted h-3 animate-pulse rounded-full"
                            style={{ width: `${(width - 0.15) * 100}%` }}
                          />
                        )}
                      </div>
                    ))}
                  </motion.div>
                ) : isHistoryLoadFailed ? (
                  <motion.div
                    key="history-error"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.2 }}
                    className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center"
                  >
                    <p className="text-secondary-foreground text-sm">
                      {t("workspace.chat.historyLoadFailed")}
                    </p>
                    <p className="text-muted-foreground text-xs">
                      {t("workspace.chat.continueBelow")}
                    </p>
                  </motion.div>
                ) : !hasContent ? (
                  <WelcomeScreen
                    key="welcome"
                    onUsePrompt={useStarterPrompt}
                    workspaces={workspaces}
                    activeWorkspaceId={activeWorkspaceId}
                    onSwitchWorkspace={handleSwitchWorkspace}
                    onAddWorkspace={() => void handleAddWorkspace()}
                  />
                ) : chatItems.length === 0 && pendingNewSession != null ? (
                  <motion.div
                    key="pending-new-session"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ duration: 0.15 }}
                    className="mx-auto flex w-full flex-col gap-4 px-5 pt-4 pb-6"
                  >
                    <UserMessageBubble content={pendingNewSession.message} />
                    <ThinkingLoader isVisible={true} />
                  </motion.div>
                ) : (
                  // Keyed by session: segment ids are only unique within a chat, so
                  // a shared key reconciles another chat's message into this one.
                  <motion.div
                    key={`messages:${activeSessionId ?? "none"}`}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ duration: 0.2 }}
                    className="mx-auto flex w-full flex-col gap-4 px-5 pt-4 pb-6"
                  >
                    {subtaskScope != null && (
                      <SubtaskScopeHeader
                        summary={activeSubtask}
                        onBack={() => setSubtaskScope(null)}
                      />
                    )}
                    {/* A bot's chat is a thread, not a work log — see
                        bot-message-list.tsx — and so is a routine's run:
                        what it said, not the tools it used to say it.
                        Sessions keep the full transcript: there you are
                        supervising the agent. */}
                    {isBotChat || isRoutineRun ? (
                      /* The bot's question, in the thread and at the point it
                         was asked. Handed to the list rather than dropped after
                         it, or anything the bot said next renders above it. */
                      <BotMessageList
                        chatItems={chatItems}
                        times={
                          activeSessionId == null
                            ? undefined
                            : segmentTimes(activeSessionId)
                        }
                        isWorking={isScopeBusy}
                        onOpenSubtask={setSubtaskScope}
                        onSwitchModel={handleSwitchModel}
                      />
                    ) : (
                      <ChatMessageList
                        chatItems={chatItems}
                        isPending={isScopeBusy}
                        currentTurnId={currentTurnId}
                        agentStatus={agentStatus}
                        onRetry={isAgentBusy ? undefined : handleRetry}
                        onSwitchModel={handleSwitchModel}
                        creditsTotal={conversation.credits}
                        onOpenSubtask={setSubtaskScope}
                        statusLabel={statusLabel}
                        conversationId={conversationId}
                      />
                    )}
                  </motion.div>
                )}
              </AnimatePresence>
            </MessageScrollerContent>
          </MessageScrollerViewport>
          <ScrollToBottomBridge scrollRef={scrollToBottomRef} />
          <ScrollToBottomButton />
        </MessageScroller>
      </MessageScrollerProvider>

      {/* A tombstoned workspace: say why the composer won't send, and name the
          way back (re-adding the folder revives the workspace). */}
      {activeWorkspaceDeleted && (
        <div className="border-border bg-muted text-muted-foreground mx-4 mb-2 rounded-md border px-3 py-2 text-xs">
          {t("workspace.deletedWorkspaceReadOnly")}
        </div>
      )}
      {/* A connector the agent needs and cannot reach. It belongs with the
          conversation, not in a corner: the agent's turn is suspended inside
          the tool call, and this button is what it is waiting on. The card
          shows only the asks filed under the conversation on screen. */}
      <ConnectorRequestCard />

      {/* The update — downloading, failed, or ready — right above where the
          user is already typing, so no session and no sidebar state hides it.
          The bot maker shows it as a banner at the top of the pane instead. */}
      {!showsBotMaker && <ComposerUpdateStrip />}

      {/* A channel bot's chat happens in Discord/Telegram/WhatsApp: everything
          here is a mirror of that conversation, so there is nothing to type.
          The user messages the Abacus AI bot in the chat app — or, on
          WhatsApp, themselves — and both sides land in this transcript. */}
      {channelBotChat != null && !showsBotMaker && !isSenderChat && (
        <div className="border-border bg-muted text-muted-foreground mx-4 mb-3 rounded-md border px-3 py-2 text-xs">
          {channelBotChat.channel === "whatsapp"
            ? t("bots.channelChatReadOnlyWhatsapp")
            : t("bots.channelChatReadOnly", {
                app: t(`messaging.platforms.${channelBotChat.channel}`),
              })}
        </div>
      )}

      {/* An auto-reply conversation is the bot's line to one person: every
          word in it is delivered to that sender as the user, so there is no
          composer — a message typed here would be answered TO the sender.
          The user watches, and steers the bot from the bot's own chat. */}
      {isSenderChat && !showsBotMaker && (
        <div className="border-border bg-muted text-muted-foreground mx-4 mb-3 rounded-md border px-3 py-2 text-xs">
          {t("bots.senderChatReadOnly", {
            bot: botOwningSession?.name ?? "",
            sender: senderChatForSession.senderName,
          })}
        </div>
      )}
      {isRoutineRun && !showsBotMaker && !isSenderChat && (
        <div
          className="border-border bg-muted text-muted-foreground mx-4 mb-3 rounded-md border px-3 py-2 text-xs"
          data-id="routine-run-banner"
        >
          {t("routines.runReadOnly")}
        </div>
      )}
      {/* Composer — absent under the bot maker, which owns the whole pane,
          and in auto-reply conversations and routine runs, which are
          read-only. */}
      {showsBotMaker ||
      isSenderChat ||
      isRoutineRun ||
      channelBotChat != null ? null : (
        <PendingSteers
          entries={queuedMessages}
          onEdit={(id, text) => void conversation.updateQueuedMessage(id, text)}
          onRemove={(id) => void conversation.removeQueuedMessage(id)}
        />
      )}
      {showsBotMaker ||
      isSenderChat ||
      isRoutineRun ||
      channelBotChat != null ? null : (
        <ChatComposer
          modelAttention={modelAttention}
          historyScope={composerKey ?? "none"}
          onAddWorkspace={() => void handleAddWorkspace()}
          onModelsRefreshed={() => void modelsQuery.refetch()}
          inputRef={inputRef}
          inputValue={inputValue}
          onInputValueChange={setInputValue}
          skills={composerSkills}
          onSend={sendMessage}
          onStop={stopTurn}
          placeholder={composerPlaceholder}
          isSendLoading={isAgentBusy}
          isStreaming={isStreaming}
          canSend={canSend}
          models={modelsQuery.data}
          selectedModelValue={selectedModelValue}
          onSelectModel={(workspaceId, modelId) => {
            if (workspaceId != null && workspaceId.length > 0) {
              setWorkspaceModelId(workspaceId, modelId);
            } else {
              setSelectedModelId(modelId);
            }
            // Push to a running agent here rather than via the sync effect,
            // which only fires when the resolved model changes.
            if (activeSessionId != null) {
              setPendingModelPick({
                sessionId: activeSessionId,
                model: modelId,
              });
              if (activeWorkspaceId != null && isCliRunning) {
                setModelMutation.mutate({
                  workspaceId: activeWorkspaceId,
                  sessionId: activeSessionId,
                  model: modelId,
                });
              }
            }
            // Pin it to the chat it was chosen in, so this session keeps it when
            // the composer moves on. A running agent hears about it through
            // set_model; this is what a stopped one is reopened with.
            if (activeWorkspaceId != null && activeSessionId != null) {
              void window.api.agent
                .setAgentSessionModel(
                  activeWorkspaceId,
                  activeSessionId,
                  modelId
                )
                .then(() => {
                  queryClient.setQueryData(
                    workspaceQueryKeys.agentSessions(activeWorkspaceId),
                    (previous: AgentSessionEntry[] | undefined) =>
                      previous?.map((session) =>
                        session.id === activeSessionId
                          ? { ...session, model: modelId }
                          : session
                      ) ?? []
                  );
                })
                .catch(() => {
                  // The pick still reached the running agent and the workspace
                  // default; only its durability across a restart is lost.
                });
            }
            // Also persisted to ~/.abacusai-bot/config.json: the renderer store
            // alone would not reach a freshly spawned agent.
            void window.api.agent.setDefaultModel(modelId);
          }}
          selectedModeValue={selectedModeValue}
          canSelectMode={!isBotChat}
          // One box everywhere: two composers in one app read as two apps.
          compact
          // Never from a bot's chat: sessions share one sticky mode, so a
          // single write here would make every future session full access.

          onSelectMode={(mode) => {
            if (!isBotChat) setSelectedMode(mode);
          }}
          onModeChange={(mode) => {
            if (!isBotChat) setSelectedMode(mode);
          }}
          activeWorkspaceId={activeWorkspaceId}
          worktrees={worktrees}
          activeWorktreeId={activeSession?.worktreeId ?? null}
          worktreeEnvironment={selectedWorktreeEnvironment}
          worktreeMutationPending={
            setSessionWorktreeMutation.isPending ||
            prepareSessionWorktreeMutation.isPending
          }
          worktreeMutationError={
            setSessionWorktreeMutation.error ??
            prepareSessionWorktreeMutation.error ??
            worktreesQuery.error
          }
          onSelectWorktreeEnvironment={handleSelectWorktreeEnvironment}
          hasConversation={hasConversation}
          workspaceRoot={workspaceRoot}
          agentStatus={agentStatus}
          pendingPermission={pendingPermission}
          todos={
            activity.isProcessing && subtaskScope == null ? todos : undefined
          }
          tasksTurnId={latestUserTurnId}
        />
      )}

      {missingWorkspace != null && activeWorkspaceId != null && (
        <WorkspaceMissingDialog
          isOpen={workspaceMissingDismissedId !== activeWorkspaceId}
          onClose={() => setWorkspaceMissingDismissedId(activeWorkspaceId)}
          workspaceId={activeWorkspaceId}
          workspaceLabel={missingWorkspace.label}
          workspacePath={
            workspacePathStatusQuery.data?.path ?? missingWorkspace.path ?? ""
          }
        />
      )}
    </div>
  );
};
