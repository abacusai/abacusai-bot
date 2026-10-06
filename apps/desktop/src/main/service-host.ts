import fs from "node:fs";
/**
 * Composition root for the desktop services: constructs them, wires their
 * callbacks and routes handler requests. Substantive behavior lives in
 * `services/`.
 */
import os from "node:os";
import path from "path";

import { connectorById } from "@abacus-ai/connectors/registry";
import {
  AgentStatus,
  type AgentMode,
  type DesktopEvent,
} from "@abacus-ai/contract/agent-types";
import type {
  BotChangeNotice,
  Bot,
  BotChatHandle,
  BotCreateInput,
  BotUpdateInput,
} from "@abacus-ai/contract/bots";
import { ConflictError } from "@abacus-ai/contract/conflict";
import {
  checkoutKey,
  type GitDiffResult,
} from "@abacus-ai/contract/contract/checkout";
import type { GitStateRow } from "@abacus-ai/contract/contract/rows";
import type {
  ConnectorConnectOptions,
  TranscriptSegment,
  TurnFeedbackInput,
  TurnFeedbackOutcome,
  MemorySnapshot,
  MemoryTargetId,
  ForgetMemoryRequest,
  AddMcpServerRequest,
  AddWorkspaceResult,
  RelocateWorkspaceResult,
  WorkspacePathStatus,
  AgentSessionListItem,
  SessionArtifact,
  BrowserApproval,
  BrowserEngine,
  ClearBrowserDataRequest,
  ClearBrowserDataResult,
  GetMcpRuntimeServersRequest,
  GetMcpServerLogsRequest,
  BrowserPermissionRequest,
  RespondBrowserPermissionRequest,
  ImportMcpServersRequest,
  ImportMcpServersResult,
  CreateGitBranchResult,
  FileTreeRootSnapshot,
  GetGitBranchesResult,
  GetGitCurrentBranchResult,
  PrInfo,
  ListMcpServersRequest,
  AgentMcpLogEntry,
  AgentMcpServer,
  AgentMcpStatus,
  McpBrowserStatus,
  DefaultAgentMode,
  SandboxSupport,
  DeviceStatus,
  LocalDeviceInfo,
  CaptureDeviceScreenshotRequest,
  CaptureDeviceScreenshotResult,
  BootLocalDeviceRequest,
  CreateLocalDeviceRequest,
  CreateLocalDeviceResult,
  BootLocalDeviceResult,
  DeviceProjectInfo,
  InteractLocalDeviceRequest,
  InteractLocalDeviceResult,
  BuildAndRunLocalDeviceRequest,
  BuildAndRunLocalDeviceResult,
  StartDeviceStreamRequest,
  StartDeviceStreamResult,
  GetSimulatorWindowSourceRequest,
  GetSimulatorWindowSourceResult,
  InstallMaestroResult,
  StreamDeviceTouchRequest,
  StreamDeviceKeyRequest,
  McpMode,
  McpRuntimeRequestResult,
  McpServerInfo,
  RefreshMcpServersRequest,
  RestartMcpServerRequest,
  RemoveMcpServerRequest,
  SessionTurnStateSnapshot,
  SetMcpServerDisabledRequest,
  GitChangeStatsScope,
  GitChangeStatsSnapshot,
  GitDiffScope,
  GitStateSnapshot,
  InitGitResult,
  AgentPermissionResponseRequest,
  AgentQueueMessageRequest,
  AgentRemoveFromQueueRequest,
  RoutineRunItem,
  AgentUpdateQueueMessageRequest,
  AgentSessionCommandRequest,
  AgentSessionSnapshot,
  AgentSetModeRequest,
  AgentSetModelRequest,
  AgentSwitchConversationRequest,
  IpcEvent,
  WorkspaceMetadataRequest,
  WorkspaceMetadataSnapshot,
  WorkspaceState,
  SendAgentMessageRequest,
  StartAgentSessionRequest,
  StartAgentSessionResult,
  StartTerminalSessionRequest,
  StartTerminalSessionResult,
  PromoteTerminalSessionScopeRequest,
  ResizeTerminalSessionRequest,
  TerminalRuntimeRequest,
  TerminalSessionSnapshot,
  WriteTerminalInputRequest,
  StopAgentSessionResult,
  SwitchGitBranchResult,
  SwitchWorkspaceResult,
  UpdateMcpServerRequest,
  CreateWorktreeRequest,
  CreateWorktreeResult,
  ListWorktreesResult,
  MaterializeSessionWorktreeRequest,
  MaterializeSessionWorktreeResult,
  SetSessionWorktreeRequest,
  SetSessionWorktreeResult,
  WorkspaceGitContext,
} from "@abacus-ai/contract/contracts";
import type {
  BotChatPreview,
  BotSenderChat,
  NotificationSettings,
} from "@abacus-ai/contract/contracts";
import {
  ABACUS_CONNECTORS_SERVER_NAME,
  abacusConnectorsMcpEntry,
} from "@abacus-ai/contract/contracts";
import type {
  ConnectorRequest,
  ConnectorOutcome,
  ConnectorStatuses,
  McpOAuthSignInRequest,
  SessionOwner,
  RespondConnectorRequest,
} from "@abacus-ai/contract/contracts";
import {
  conversationRefFromKey,
  sessionConversationKey,
  type ConversationKey,
} from "@abacus-ai/contract/conversation-scope";
import type {
  BackendId,
  BackendStatus,
} from "@abacus-ai/contract/exec-backends";
import {
  describePlatformForAgent,
  reportableLivePlatforms,
  type MessagingPairingDecisionRequest,
  type MessagingPlatformId,
  type MessagingSnapshot,
  type UpdateMessagingPlatformRequest,
  type UpdateMessagingSettingsRequest,
} from "@abacus-ai/contract/messaging";
import {
  EntityNotFoundError,
  WORKSPACE_NOT_FOUND,
} from "@abacus-ai/contract/not-found";
import { detectRememberRequest } from "@abacus-ai/contract/remember";
import type {
  Routine,
  RoutineCreateInput,
  RoutineListItem,
  RoutineUpdateInput,
} from "@abacus-ai/contract/routines";
import type {
  TerminalShellId,
  TerminalShellState,
} from "@abacus-ai/contract/terminal-shells";
import { TimeoutError } from "@abacus-ai/contract/timeout-error";
import {
  isToolsetEnabled,
  TOOLSETS,
  TOOLSETS_BY_ID,
} from "@abacus-ai/contract/toolsets";
import { app } from "electron";

import {
  abacusBotHome,
  botDefaultWorkspace,
  sessionDefaultWorkspace,
} from "./paths";
import {
  assertHostCapability,
  type HostPlatform,
} from "./platform/capabilities";
import type { BusChannel, BusChannels } from "./rpc/event-bus";
import { ConnectorGate } from "./services/agent-tools/connector-gate";
import { CronScheduler } from "./services/agent-tools/cron-scheduler";
import {
  createJob,
  getJob,
  listJobs,
  nextRun,
  onCronStoreWrite,
  attemptOfSession,
  onRoutineRunStarted,
  recordRun,
  type RoutineRunStarted,
  removeJob,
  updateJob,
  type CronJob,
  type CronTrigger,
  type RoutineRunStart,
} from "./services/agent-tools/cron-store";
import {
  deckSlots,
  deckTemplates,
  renderDeck,
  type DeckSlotsRequest,
  type RenderDeckRequest,
} from "./services/agent-tools/deck-agent";
import {
  designCatalog,
  renderDesign,
  type RenderDesignRequest,
} from "./services/agent-tools/design-agent";
import {
  applyMemoryAction,
  forgetAll,
  forgetEntryAt,
  listMemories,
  type MemoryResult,
} from "./services/agent-tools/memory-store";
import {
  documentTemplates,
  renderDocument,
  type RenderDocumentRequest,
} from "./services/agent-tools/pdf-agent";
import {
  ROUTINE_RESULTS,
  started as startedResult,
} from "./services/agent-tools/routine-attempts";
import {
  hasRunInFlight,
  ranOutOfAbacusCredits,
  ROUTINE_FAILURES_BEFORE_PAUSE,
  shouldPauseAfter,
  stuckRuns,
} from "./services/agent-tools/routine-guards";
import { buildRoutineFirePrompt } from "./services/agent-tools/routine-prompt";
import {
  countRoutineRuns,
  readLastRoutineRun,
  recordRoutineRun,
  removeRoutineDir,
  routineDir,
  routineDirInWorkspace,
} from "./services/agent-tools/routine-runs-store";
import { stopAllServed } from "./services/agent-tools/static-server";
import { WebhookRelay } from "./services/agent-tools/webhook-relay";
import { WebhookService } from "./services/agent-tools/webhook-service";
import { AguiRelayService } from "./services/agui/relay-service";
import { botChatPreview } from "./services/bots/bot-chat-preview";
import {
  clearBotMemory,
  forgetBotMemoryEntry,
  listBotMemories,
  readBotMemoryText,
} from "./services/bots/bot-memory-store";
import { BotService } from "./services/bots/bot-service";
import {
  assertNotChannelBot,
  getBot,
  listSenderSessionEntries,
  onBotStoreWrite,
  recordBotSession,
  recordSenderSession,
  removeSenderSession,
} from "./services/bots/bot-store";
import { effectiveBotModel } from "./services/bots/effective-model";
import { BrowserProfilesService } from "./services/browser/browser-profiles-service";
import type { BrowserTargetSource } from "./services/browser/browser-target";
import { ChromeBrowserService } from "./services/browser/chrome/chrome-browser-service";
import type { ElectronBrowserRuntime } from "./services/browser/electron-browser-runtime";
import {
  buildAgentAuthEnv,
  buildAgentConfigEnv,
} from "./services/config/agent-env";
import {
  readExecBackend,
  readTerminalShell,
  setTerminalShell,
  readToolsetPreferences,
  readDefaultAgentMode,
  setDefaultAgentMode,
  readNotificationSettings,
  setNotificationSettings,
  setExecBackend,
  setToolsetEnabled,
  readSettings,
  storedKeyProviders,
} from "./services/config/settings";
import { ConnectorFlowService } from "./services/connectors/connector-flow-service";
import { ConnectorStatusService } from "./services/connectors/connector-status-service";
import { DebugSyncService } from "./services/debug-sync/debug-sync-service";
import {
  DiagnosticsSyncService,
  type McpRuntimeSummary,
} from "./services/debug-sync/diagnostics-sync-service";
import { FeedbackService } from "./services/debug-sync/feedback-service";
import { LogSyncService } from "./services/debug-sync/log-sync-service";
import { syncLogFor } from "./services/debug-sync/sync-log";
import { DeviceMirrorService } from "./services/device/device-mirror-service";
import { DeviceService } from "./services/device/device-service";
import {
  getSimulatorWindowSource,
  openAccessibilitySettings,
  openScreenRecordingSettings,
} from "./services/device/simulator-window";
import {
  tailStderr,
  type AgentSessionDiagnostics,
} from "./services/diagnostics/log-dump";
import { BuiltinMcpLifecycle } from "./services/mcp/builtin-mcp-lifecycle";
import {
  BuiltinToolPermissions,
  type BuiltinPermissionScope,
} from "./services/mcp/builtin-tool-permissions";
import { McpAdminService } from "./services/mcp/mcp-admin-service";
import { McpAgentToolsServer } from "./services/mcp/mcp-agent-tools-server";
import { McpBrowserServer } from "./services/mcp/mcp-browser-server";
import { McpConfigService } from "./services/mcp/mcp-config-service";
import { McpDeviceServer } from "./services/mcp/mcp-device-server";
import { signInToMcpServer } from "./services/mcp/mcp-oauth-service";
import {
  listPairing,
  readGatewaySettings,
  saveGatewaySettings,
} from "./services/messaging/messaging-config-service";
import {
  MessagingGatewayService,
  type SelfLanePlatform,
} from "./services/messaging/messaging-gateway-service";
import {
  cancelConnectorConnect,
  disconnectAbacusConnector,
  listAbacusConnectors,
  startConnectorConnect,
} from "./services/providers/abacus-connector-service";
import { abacusRoutellmV1 } from "./services/providers/abacus-host";
import {
  environmentNoticeService,
  messageWithEnvironmentNotice,
  tagEnvironmentNotice,
} from "./services/providers/environment-notice-service";
import {
  backendStatuses,
  clearBackendProbeCache,
  resolveBackend,
} from "./services/providers/exec-backend-service";
import {
  cachedRecommendedModelId,
  listAvailableModels,
  recommendedModelId,
} from "./services/providers/models";
import { SandboxProbeService } from "./services/sandbox/sandbox-probe-service";
import { agentTurnBusy } from "./services/session/agent-busy";
import { AgentSessionManagerService } from "./services/session/agent-session-manager-service";
import { ArtifactResolverService } from "./services/session/artifact-resolver-service";
import { AgentCommunicationService } from "./services/session/cli-communication-service";
import { AgentManagerService } from "./services/session/cli-manager-service";
import { deliverMessage } from "./services/session/message-delivery";
import { ModelSwitchWaiters } from "./services/session/model-switch";
import { SessionArtifactsService } from "./services/session/session-artifacts-service";
import {
  INACTIVITY_TIMEOUT_MINUTES,
  SessionTurnStateService,
} from "./services/session/session-turn-state-service";
import { ThreadStore } from "./services/session/thread-store";
import { TranscriptService } from "./services/session/transcript-service";
import { WhisperModelService } from "./services/voice/whisper-model-service";
import { CheckoutService } from "./services/workspace/checkout-service";
import {
  FileSearchService,
  type FileSearchResult,
} from "./services/workspace/file-search-service";
import { FileTreeService } from "./services/workspace/file-tree-service";
import { GitService } from "./services/workspace/git-service";
import { resolveSessionWorkspacePath } from "./services/workspace/session-workspace-context";
import { SkillsService } from "./services/workspace/skills-service";
import { TerminalSessionService } from "./services/workspace/terminal-session-service";
import {
  effectiveTerminalShell,
  terminalShellStatuses,
} from "./services/workspace/terminal-shells";
import { WorkspaceRuntimeService } from "./services/workspace/workspace-runtime-service";
import { WorkspaceService } from "./services/workspace/workspace-service";
import { WorktreeMaterializer } from "./services/workspace/worktree-materialize";

type EventDispatcher = (event: IpcEvent) => void;

/** The oRPC bus's own channels: pushes the legacy renderer never had. */
type BusDispatcher = <C extends BusChannel>(
  channel: C,
  payload: BusChannels[C]
) => void;

/** The bot each self lane gets on first link, one per platform. */
const SELF_LANE_BOTS: Record<
  SelfLanePlatform,
  {
    name: string;
    channel: "telegram" | "discord" | "whatsapp";
    aliases: string[];
    description: string;
  }
> = {
  abacus_discord: {
    name: "Discord AbacusAI Bot <-> You",
    channel: "discord",
    aliases: ["AbacusAI Bot on Discord <-> You"],
    description:
      "You are the user's personal assistant living in their Discord DM " +
      "with the Abacus AI bot. Every message they send to that DM comes " +
      "to you, and every reply you write is delivered straight back to " +
      'them there. Replying IS messaging them, so when they say "send ' +
      'me X" or "message me on Discord", just answer with X; never ' +
      "say you cannot reach them and never ask which chat is theirs. " +
      "They can ask you for anything you can do: questions, tasks with " +
      "your tools, code, documents, schedules, messages to other " +
      "people. Be a helpful, concise assistant and keep replies " +
      "chat-sized (Discord caps a message at 2000 characters).",
  },
  // The "Message yourself" chat is the WhatsApp self lane.
  whatsapp: {
    name: "WhatsApp AbacusAI Bot <-> You",
    channel: "whatsapp",
    aliases: [],
    description:
      "You are the user's personal assistant living in their WhatsApp " +
      '"Message yourself" chat. Every message they send to that chat comes ' +
      "to you, and every reply you write is delivered straight back to " +
      'them there. Replying IS messaging them, so when they say "send ' +
      'me X" or "message me", just answer with X; never say you ' +
      "cannot reach them and never ask which chat is theirs. They can " +
      "ask you for anything you can do: questions, tasks with your " +
      "tools, code, documents, schedules, messages to other people. Be " +
      "a helpful, concise assistant and keep replies chat-sized.",
  },
  abacus_telegram: {
    name: "Telegram AbacusAI Bot <-> You",
    channel: "telegram",
    // The retired own-account Telegram bootstrap's names, adopted in place:
    // one Telegram, one conversation, and the user's history stays with it.
    aliases: ["AbacusAI Bot <-> You", "AbacusAI Bot on Telegram <-> You"],
    description:
      "You are the user's personal assistant living in their Telegram chat " +
      "with the Abacus AI bot. Every message they send to that chat comes " +
      "to you, and every reply you write is delivered straight back to " +
      'them there. Replying IS messaging them, so when they say "send ' +
      'me X" or "message me", just answer with X; never say you ' +
      "cannot reach them and never ask which chat is theirs. They can " +
      "ask you for anything you can do: questions, tasks with your " +
      "tools, code, documents, schedules, messages to other people. Be " +
      "a helpful, concise assistant and keep replies chat-sized.",
  },
};

/**
 * Early-compaction threshold for routine sessions: every fire replays the chat
 * so far, so an uncapped routine's per-fire cost grows forever. Wide enough
 * that a run of connector reads finishes between compactions.
 */
const ROUTINE_CONTEXT_CAP_TOKENS = 80_000;

export class ServiceHost {
  constructor(readonly platform: HostPlatform = "electron") {}
  private initializedAt: string | null = null;
  private startedAt: string | null = null;
  private eventDispatcher: EventDispatcher | null = null;
  private busDispatcher: BusDispatcher | null = null;

  readonly mcpConfigService = new McpConfigService();
  /** The v2 thread files (spec 00 C.3); `ai.hydrate` reads them. */
  readonly threadStore = new ThreadStore();
  /**
   * Main's AG-UI relay (agent spec §5.2): the renderer's `ai.*` procedures,
   * and the wire each session's agent is spawned with: `--wire agui` for
   * every spawn in the new-renderer build, `--wire ndjson` in the legacy
   * build until the new renderer asks for a thread (`unconditional AG-UI`).
   */
  readonly aguiRelay: AguiRelayService = new AguiRelayService({
    files: this.threadStore,
    host: {
      workspaceOf: (threadId) => {
        const workspaceId =
          this.agentSessionManagerService.get(threadId)?.workspaceId ?? null;
        return workspaceId == null || this.isWorkspaceDeleted(workspaceId)
          ? null
          : workspaceId;
      },
      runtime: (threadId) => this.agentManagerService.getRuntimeInfo(threadId),
      start: async (threadId) => {
        // A bot session starts on its bot's effective model (spec 03
        // §24.10 b); errors leave the stored pin.
        await this.botService.pinSession(threadId).catch((error: unknown) => {
          console.warn(`[bots] pinning ${threadId} failed: ${String(error)}`);
        });
        const session = this.agentSessionManagerService.get(threadId);
        if (session == null) return false;
        const result = await this.startAgentSession({
          workspaceId: session.workspaceId,
          sessionId: threadId,
          // The session's own model and mode, as sendAgentMessage restarts it.
          ...(session.model != null ? { model: session.model } : {}),
          ...(session.mode != null ? { mode: session.mode } : {}),
        });
        // A first send can start an idle session without renderer warm-up.
        // Put restoration on the same command pipe before the admitted run.
        if (result.success && session.conversationId)
          this.switchAgentConversation({
            workspaceId: session.workspaceId,
            sessionId: threadId,
            conversationId: session.conversationId,
          });
        return result.success;
      },
      send: (threadId, command) =>
        this.agentManagerService.sendCommandToSession(threadId, command),
      markSent: (threadId) => {
        const runtime = this.agentManagerService.getRuntimeInfo(threadId);
        if (runtime != null)
          this.sessionTurnStateService.markSent(runtime.workspaceId, threadId);
      },
      markStopped: (threadId) => {
        const runtime = this.agentManagerService.getRuntimeInfo(threadId);
        if (runtime != null)
          this.markTurnStopped(runtime.workspaceId, threadId);
      },
      ownerOf: (threadId) => {
        const session = this.agentSessionManagerService.get(threadId);
        return {
          owner: session?.owner ?? null,
          routineId: session?.routineId ?? null,
        };
      },
      beforeRun: (threadId) => this.applyEffectiveBotModel(threadId),
    },
  });
  private readonly transcriptService = new TranscriptService({
    threads: this.threadStore,
  });
  private readonly debugSyncService = new DebugSyncService({
    // v1 segments plus an AG-UI thread's message parts (spec 03 §24.12 a).
    readTranscript: (sessionId) =>
      syncLogFor(sessionId, {
        readV1: (id) => this.transcriptService.read(id),
        readThread: (id) => this.threadStore.readAguiFile(id),
      }),
    clientVersion: app.getVersion(),
  });
  private readonly feedbackService = new FeedbackService({
    debugSync: this.debugSyncService,
    clientVersion: app.getVersion(),
  });
  private readonly logSyncService = new LogSyncService();
  private readonly diagnosticsSyncService = new DiagnosticsSyncService({
    // ids only; s.config holds MCP auth
    mcpServers: () =>
      this.mcpConfigService.listUserServers("code").map((s) => ({
        id: s.id,
        isBuiltin: s.isBuiltin,
        disabled: s.config.disabled ?? false,
      })),
    // Latest outcome per server id; "connecting" skipped and the error capped
    // so a flapping server does not churn snapshots.
    mcpRuntime: () => {
      const latest = new Map<
        string,
        { at: string; summary: McpRuntimeSummary }
      >();
      for (const runtime of this.agentManagerService.getRuntimeDiagnostics()) {
        for (const server of runtime.mcpServers.values()) {
          if (server.status === "connecting") continue;
          const at = server.updatedAt ?? server.connectedAt ?? "";
          const seen = latest.get(server.id);
          if (seen != null && seen.at > at) continue;
          latest.set(server.id, {
            at,
            summary: {
              id: server.id,
              status: server.status,
              toolCount: server.toolCount,
              ...(server.error != null
                ? { error: server.error.slice(0, 200) }
                : {}),
            },
          });
        }
      }
      return [...latest.values()]
        .map((entry) => entry.summary)
        .sort((a, b) => a.id.localeCompare(b.id));
    },
    connectors: () =>
      this.messagingGatewayService.getSnapshot().platforms.map((p) => ({
        name: p.id,
        state: p.state,
        isConnected: p.state === "connected",
      })),
  });
  readonly skillsService = new SkillsService(() => this.platform);
  private readonly mcpBrowserServer = new McpBrowserServer({
    requestPermission: (tool, summary, sessionId) =>
      this.requestBrowserToolPermission(tool, summary, sessionId),
    target: () => this.browserTargetSource(),
    conversationKeyForSession: (sessionId) =>
      this.conversationKeyForSession(sessionId),
  });

  /**
   * The pane a session's output belongs in. A bot's sender and routine chats
   * never appear in the sidebar, so theirs is the bot's visible thread.
   */
  private conversationKeyForSession(sessionId: string): ConversationKey | null {
    const session = this.agentSessionManagerService.get(sessionId);
    if (session == null) return null;
    const owner = session.owner;
    if (owner != null && owner.role !== "forever") {
      const forever = this.botService
        .list()
        .find((bot) => bot.id === owner.botId)?.sessionId;
      const thread =
        forever == null ? null : this.agentSessionManagerService.get(forever);
      if (thread != null)
        return sessionConversationKey(thread.workspaceId, thread.id);
    }
    return sessionConversationKey(session.workspaceId, session.id);
  }

  private browserRuntime: ElectronBrowserRuntime | null = null;

  attachBrowserRuntime(runtime: ElectronBrowserRuntime): void {
    this.browserRuntime = runtime;
  }

  /** A session with no browser open gets a hidden one; the renderer is told. */
  private browserTargetSource(): BrowserTargetSource | null {
    if (this.platform === "web-host") return null;
    // The user's Chrome, when chosen: its tabs stand in for the app's views,
    // and the first browser call opens the allow page if it is not connected.
    if (this.builtinMcpLifecycle.getBrowserEngine() === "chrome")
      return this.chromeBrowser.targetSource();
    const runtime = this.browserRuntime;
    if (runtime == null) return null;

    return {
      candidates: () => runtime.agentViews(),
      webContents: (id) => runtime.webContentsById(id),
      materialize: async (sessionId, url) => {
        const session = this.agentSessionManagerService.get(sessionId);
        if (session == null) return null;
        const created = await runtime.materializeForSession(
          session.workspaceId,
          sessionId,
          url
        );
        this.emitEvent({
          type: "browser-runtime-materialized",
          conversationKey: created.conversationKey,
          resourceId: created.resourceId,
          url,
          emittedAt: new Date().toISOString(),
        });
        return created.id;
      },
    };
  }
  private readonly deviceService = new DeviceService();
  readonly whisperModelService = new WhisperModelService({
    emitEvent: (event) => this.emitEvent(event),
  });
  private readonly deviceMirrorService = new DeviceMirrorService(
    this.deviceService,
    {
      emitEvent: (event) => this.emitEvent(event),
      resolveWorkspacePath: () => {
        const workspace = this.workspaceService.getActiveWorkspace();
        return workspace?.isRemote === true ? null : (workspace?.path ?? null);
      },
    }
  );
  private readonly mcpDeviceServer = new McpDeviceServer({
    deviceService: this.deviceService,
    requestPermission: (tool, summary, sessionId) =>
      this.builtinToolPermissions.request("device", tool, summary, sessionId),
    resolveWorkspacePath: () => {
      const workspace = this.workspaceService.getActiveWorkspace();
      return workspace?.isRemote === true ? null : (workspace?.path ?? null);
    },
  });
  /**
   * One server for the small in-process toolsets. Reads the enabled set per
   * request, so toggles take effect without a new session.
   */
  private readonly mcpAgentToolsServer = new McpAgentToolsServer({
    skillsService: this.skillsService,
    enabledToolsets: () => {
      const states = this.getToolsetStates();
      return new Set(Object.keys(states).filter((id) => states[id]));
    },
    workspacePath: () => {
      const workspace = this.workspaceService.getActiveWorkspace();
      return workspace?.isRemote === true ? null : (workspace?.path ?? null);
    },
    connectors: {
      list: () => this.listConnectorStatuses(),
      request: (input) => this.connectorGate.ask(input),
      disconnect: async (connectorId) => {
        const result = await this.disconnectConnector(connectorId);
        if (result.ok === true) return null;
        return result.error.length > 0 ? result.error : "Could not disconnect.";
      },
    },
    workspaceId: () => this.workspaceService.getActiveWorkspace()?.id ?? null,
    runCronJob: (jobId, trigger) => this.runRoutine(jobId, trigger ?? "manual"),
    // A routine's run is its bot's work too: a routine made from inside one
    // belongs to the bot, and `list` shows the bot its own.
    botIdForSession: (sessionId) =>
      this.botService.botIdForSession(sessionId) ??
      (() => {
        const routineId =
          this.agentSessionManagerService.get(sessionId)?.routineId ?? null;
        return routineId != null ? (getJob(routineId)?.botId ?? null) : null;
      })(),
    conversationKeyForSession: (sessionId) =>
      this.conversationKeyForSession(sessionId),
    routineEditorFor: (sessionId) =>
      this.agentSessionManagerService.get(sessionId)?.editorFor ?? null,
    ownActivity: (botId) => {
      const owned = this.agentSessionManagerService.listOwnedBy(botId);
      // The forever chat may predate owner stamps; the record pointer names it.
      const forever = this.botService
        .list()
        .find((bot) => bot.id === botId)?.sessionId;
      const rows = owned.map((session) => ({
        sessionId: session.id,
        label: session.label,
        role: session.owner?.role ?? ("sender" as const),
      }));
      if (forever != null && !owned.some((session) => session.id === forever)) {
        const item = this.agentSessionManagerService.get(forever);
        if (item != null)
          rows.push({
            sessionId: forever,
            label: item.label,
            role: "forever" as const,
          });
      }
      return rows.map((row) => ({
        ...row,
        file:
          this.agentSessionManagerService.getDiagnosticInfo(row.sessionId)
            ?.agentSessionFile ?? null,
      }));
    },
    onCronChanged: () => {
      this.emitEvent({
        type: "cronjobs-updated",
        emittedAt: new Date().toISOString(),
      });
    },
    // Deferred through arrows: the gateway field initializes after this one.
    messaging: {
      runningPlatforms: () => this.messagingGatewayService.runningPlatforms(),
      disablePlatform: async (id) => {
        await this.messagingGatewayService.updatePlatform({
          platformId: id,
          enabled: false,
        });
      },
      listChats: (query, platform) =>
        this.messagingGatewayService.listKnownChats(query, platform),
      listChatsDetailed: (query, platform) =>
        this.messagingGatewayService.listKnownChatsDetailed(query, platform),
      livePlatforms: () => this.messagingGatewayService.livePlatforms(),
      selfChats: () => this.messagingGatewayService.selfChats(),
      startingPlatforms: () => this.messagingGatewayService.startingPlatforms(),
      awaitReady: (platform) =>
        this.messagingGatewayService.awaitReady(platform),
      send: (platform, chatId, text) =>
        this.messagingGatewayService.sendToChat(platform, chatId, text),
      sendFile: (platform, chatId, filePath, caption) =>
        this.messagingGatewayService.sendFileToChat(
          platform,
          chatId,
          filePath,
          caption
        ),
      readMessages: (filter) =>
        this.messagingGatewayService.readMessages(filter),
      unreadChats: (platform) =>
        this.messagingGatewayService.unreadChats(platform),
      autoReply: {
        status: () => this.messagingGatewayService.autoReplyStatus(),
        enable: (botId) => this.messagingGatewayService.enableAutoReply(botId),
        disable: () => this.messagingGatewayService.disableAutoReply(),
        senderCandidates: (platform) =>
          this.messagingGatewayService.senderCandidates(platform),
        allowSender: (candidate) =>
          this.messagingGatewayService.allowSender(candidate),
        removeSender: (candidate) =>
          this.messagingGatewayService.removeSender(candidate),
      },
    },
  });
  /** The user's own Chrome, driven through the Playwright Extension. */
  private readonly chromeBrowser = new ChromeBrowserService({
    token: () => this.mcpConfigService.readState().chromeExtensionToken,
    onStatusChanged: () =>
      this.emitEvent({
        type: "browser-status-updated",
        status: this.builtinMcpLifecycle.getBrowserStatus(),
        emittedAt: new Date().toISOString(),
      }),
  });
  private readonly builtinMcpLifecycle = new BuiltinMcpLifecycle({
    platform: () => this.platform,
    mcpConfigService: this.mcpConfigService,
    browserServer: this.mcpBrowserServer,
    chromeBrowser: this.chromeBrowser,
    deviceServer: this.mcpDeviceServer,
    agentToolsServer: this.mcpAgentToolsServer,
    emitEvent: (event) => this.emitEvent(event),
    flushPermissions: (decision, server) =>
      this.builtinToolPermissions.flushPending(decision, server),
  });
  private readonly cronScheduler = new CronScheduler(async (jobId, trigger) => {
    await this.runRoutine(jobId, trigger);
  });
  private readonly webhookService = new WebhookService(
    async (jobId, trigger, payload) => {
      await this.runRoutine(jobId, trigger, payload);
    }
  );
  private readonly webhookRelay = new WebhookRelay(
    async (jobId, trigger, payload) => {
      await this.runRoutine(jobId, trigger, payload);
    },
    () =>
      this.emitEvent({
        type: "cronjobs-updated",
        emittedAt: new Date().toISOString(),
      })
  );
  private readonly connectorGate = new ConnectorGate(
    (event) => this.emitEvent(event),
    async (connectorId) =>
      (await this.listConnectorStatuses())[connectorId]?.account ?? null
  );

  /**
   * One answer to "is it connected?" per registry connector. The platform's
   * listing is read live (narrowed to the registry as it enters the app);
   * credentials, the messaging gateway and the MCP config are in memory.
   */
  readonly connectorStatuses = new ConnectorStatusService({
    platform: async () => {
      const snapshot = await listAbacusConnectors();
      if (!snapshot.ok)
        return {
          available: new Set<string>(),
          connected: new Set<string>(),
          accounts: {},
          reason: snapshot.error ?? "unavailable",
        };
      return {
        available: new Set(snapshot.available.map((item) => item.service)),
        connected: new Set(Object.keys(snapshot.connected)),
        accounts: snapshot.accounts,
      };
    },
    storedProviders: () => new Set(storedKeyProviders()),
    messaging: () => this.messagingGatewayService.getSnapshot(),
    mcpServers: () => this.mcpConfigService.listUserServers("code"),
    mcpAuthRequired: () => {
      const waiting = new Set<string>();
      for (const runtime of this.agentManagerService.getRuntimeDiagnostics())
        for (const server of runtime.mcpServers.values())
          if (server.status === "auth-required") waiting.add(server.id);
      return waiting;
    },
  });

  /**
   * Stores an agent credential and announces it (the gateway, running agents,
   * the renderer). Set by the IPC layer, which owns that announcement.
   */
  private credentialSaver: ((provider: string, value: string) => void) | null =
    null;

  setCredentialSaver(save: (provider: string, value: string) => void): void {
    this.credentialSaver = save;
  }

  /** How each kind connects and disconnects. The one implementation every Connect button uses. */
  readonly connectorFlow = new ConnectorFlowService({
    platform: {
      connect: (service, options) =>
        startConnectorConnect(service, options, this.platform),
      disconnect: disconnectAbacusConnector,
      // The MCP file is user-editable, so the url and headers under the
      // app's own name are rewritten rather than assumed.
      ensureGateway: () =>
        this.ensureMcpServer({
          mode: "code",
          name: ABACUS_CONNECTORS_SERVER_NAME,
          config: abacusConnectorsMcpEntry(`${abacusRoutellmV1()}/mcp`),
        }),
    },
    credential: {
      save: (provider, value) => {
        if (this.credentialSaver == null)
          throw new Error(
            "credentials cannot be stored before the IPC layer is up"
          );
        this.credentialSaver(provider, value);
      },
    },
    mcp: {
      // Restore rather than refuse when the name is taken: the earlier Add
      // wrote the entry, and this click is the user trying the sign-in again.
      add: (name, entry) =>
        this.ensureMcpServer({ mode: "code", name, config: entry }),
      remove: (name) => this.removeMcpServer({ mode: "code", name }),
      signIn: (name) => this.mcpOAuthSignIn({ mode: "code", name }),
    },
    homeDir: () => os.homedir(),
  });

  listConnectorStatuses(): Promise<ConnectorStatuses> {
    return this.connectorStatuses.list();
  }

  /** Something moved a connector's status; the renderer re-reads once. */
  private connectorStatusChanged(): void {
    this.emitEvent({
      type: "connector-status-changed",
      emittedAt: new Date().toISOString(),
    });
  }

  private connectorStatusTimer: NodeJS.Timeout | null = null;

  /**
   * The same, coalesced: a session reconnecting re-reports every server in a
   * burst, and each re-read costs a platform listing.
   */
  private connectorStatusChangedSoon(): void {
    if (this.connectorStatusTimer != null) return;
    this.connectorStatusTimer = setTimeout(() => {
      this.connectorStatusTimer = null;
      this.connectorStatusChanged();
    }, 300);
    this.connectorStatusTimer.unref?.();
  }

  /**
   * An MCP connector reads as connected only once no running agent is
   * waiting on its sign-in, so a session's server flipping into or out of
   * `auth-required` moves a status the renderer has to re-read. Without
   * this a just-signed-in card sat under "Not installed" until something
   * unrelated refreshed the table.
   */
  private mcpRuntimeMovedConnectorStatus(
    servers: ReadonlyArray<{ id: string; status: AgentMcpStatus }>
  ): void {
    const moved = servers.some(
      (server) =>
        connectorById(server.id)?.kind === "mcp" &&
        server.status !== "connecting"
    );
    if (moved) this.connectorStatusChangedSoon();
  }

  async connectConnector(
    connectorId: string,
    options?: ConnectorConnectOptions
  ): Promise<ConnectorOutcome> {
    const outcome = await this.connectorFlow.connect(connectorId, options);
    this.connectorStatusChanged();
    return outcome;
  }

  async submitConnectorFields(
    connectorId: string,
    values: Record<string, string>
  ): Promise<ConnectorOutcome> {
    const outcome = await this.connectorFlow.submitFields(connectorId, values);
    this.connectorStatusChanged();
    return outcome;
  }

  async disconnectConnector(connectorId: string): Promise<ConnectorOutcome> {
    const outcome = await this.connectorFlow.disconnect(connectorId);
    this.connectorStatusChanged();
    return outcome;
  }

  /**
   * The server's own browser sign-in for an installed OAuth MCP server. The
   * caller names the server but never supplies the URL, so a compromised
   * page cannot point the flow at an attacker's endpoints.
   */
  async mcpOAuthSignIn(
    request: McpOAuthSignInRequest
  ): Promise<{ success: boolean; error?: string; cancelled?: boolean }> {
    assertHostCapability(this.platform, "mcp.oauthSignIn");
    const server = this.listMcpServers({ mode: request.mode }).find(
      (entry) => entry.id === request.name
    );
    if (server?.config.url == null)
      return { success: false, error: "No such HTTP server is configured." };
    if (server.config.oauth === false)
      return { success: false, error: "OAuth is disabled for this server." };
    const result = await signInToMcpServer(
      server.config.url,
      server.config.oauth != null ? { oauth: server.config.oauth } : {}
    );
    if (result.ok) {
      await this.notifyMcpSignedIn(request.mode);
      return { success: true };
    }
    return {
      success: false,
      ...(result.error != null ? { error: result.error } : {}),
      ...(result.cancelled === true ? { cancelled: true } : {}),
    };
  }
  private readonly builtinToolPermissions = new BuiltinToolPermissions({
    mcpConfigService: this.mcpConfigService,
    emitEvent: (event) => this.emitEvent(event),
    getSessionMode: (sessionId) =>
      this.agentManagerService.getSessionMode(sessionId),
    setBrowserApprovalAlways: () => this.setBrowserApproval("always"),
    conversationKeyForSession: (sessionId) =>
      this.conversationKeyForSession(sessionId),
  });
  private readonly workspaceService = new WorkspaceService();
  private readonly browserProfilesService = new BrowserProfilesService();
  private readonly artifactResolverService = new ArtifactResolverService();

  private readonly sandboxProbeService = new SandboxProbeService(() =>
    this.artifactResolverService.resolveBundledCliPath()
  );
  private readonly fileTreeService = new FileTreeService();
  private readonly fileSearchService = new FileSearchService();
  private readonly gitService = new GitService();

  /**
   * Checkout-aware file and git operations (spec 04 §26.4): the procedures
   * with a `checkout` call these; the ones without keep the legacy active
   * workspace methods below.
   */
  readonly checkouts = new CheckoutService({
    workspace: (workspaceId) =>
      this.workspaceService
        .getWorkspaces()
        .find((entry) => entry.id === workspaceId) ?? null,
    session: (sessionId) => this.agentSessionManagerService.get(sessionId),
    git: this.gitService,
    files: new FileTreeService(),
    search: (root, query) => this.fileSearchService.search(root, query),
    trash: async (absolutePath) => {
      const { shell } = await import("electron");
      await shell.trashItem(absolutePath);
    },
  });

  /**
   * The folders a conversation may preview local files from (spec 04
   * §12.8): its checkout (the session's worktree when it has one) and the
   * folders of its workspace's recorded file artifacts. Derived here, never
   * from the renderer: `materializeFile`'s `hostRoot` must lie inside one.
   */
  localPreviewRoots(key: ConversationKey): string[] {
    const ref = conversationRefFromKey(key);
    if (ref == null) return [];
    const roots: string[] = [];
    try {
      roots.push(
        this.checkouts.resolve({
          workspaceId: ref.workspaceId,
          ...(ref.kind === "session" && { sessionId: ref.sessionId }),
        }).path
      );
    } catch {
      // No local checkout: artifact folders only.
    }
    for (const artifact of this.sessionArtifactsService.list())
      if (artifact.workspaceId === ref.workspaceId && artifact.kind !== "link")
        roots.push(path.dirname(artifact.location));
    return [...new Set(roots)];
  }

  /** The active workspace's primary checkout key (legacy tree events). */
  activeCheckoutKey(): string | null {
    const active = this.workspaceService.getActiveWorkspaceId();
    return active == null ? null : checkoutKey(active, null);
  }

  /** `git.diff` without a checkout: the legacy active workspace, typed. */
  async getActiveGitDiff(
    filePath: string,
    scope: GitDiffScope = "unstaged"
  ): Promise<GitDiffResult> {
    const workspace = this.workspaceService.getActiveWorkspace();
    if (workspace?.path == null || workspace.isRemote) return { kind: "none" };
    return this.checkouts.diff({ workspaceId: workspace.id }, filePath, scope);
  }

  /** Re-reads the active workspace's state (a `gitState` echo). */
  refreshGitState(): Promise<void> {
    return this.workspaceRuntimeService.refreshAndEmit();
  }

  #fingerprintReaders = 0;
  /** The gitState table's readers want fingerprints (spec 04 §26.4 b). */
  wantGitFingerprints(): () => void {
    this.#fingerprintReaders += 1;
    this.workspaceRuntimeService.setFingerprints(true);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#fingerprintReaders -= 1;
      if (this.#fingerprintReaders === 0)
        this.workspaceRuntimeService.setFingerprints(false);
    };
  }

  checkoutRows(): GitStateRow[] {
    return this.checkouts.rows();
  }

  onCheckoutRowsChanged(listener: () => void): () => void {
    return this.checkouts.onRowsChanged(listener);
  }

  private managedWorktreeRoot(workspaceId: string): string {
    return path.join(abacusBotHome(), "worktrees", workspaceId);
  }
  private readonly terminalSessionService = new TerminalSessionService({
    resolveWorkspacePath: (workspaceId, sessionId) =>
      this.resolveWorkspaceContextPath({
        workspaceId,
        ...(sessionId != null ? { sessionId } : {}),
      }),
    emitTerminalOutput: (event) => {
      this.emitEvent({
        type: "terminal-output",
        ...event,
        workspaceId: event.conversation.workspaceId,
        emittedAt: new Date().toISOString(),
      });
    },
    emitTerminalExit: (event) => {
      this.emitEvent({
        type: "terminal-exited",
        ...event,
        workspaceId: event.conversation.workspaceId,
        emittedAt: new Date().toISOString(),
      });
    },
    emitTerminalRetired: (event) => {
      this.busDispatcher?.("terminal-retired", event);
    },
    emitTerminalState: (state) => {
      this.emitEvent({
        type: "terminal-state-updated",
        conversationKey: state.conversationKey,
        conversation: state.conversation,
        generation: state.generation,
        workspaceId: state.workspaceId,
        state,
        emittedAt: new Date().toISOString(),
      });
    },
  });
  private readonly agentSessionManagerService =
    new AgentSessionManagerService();
  /** Given callbacks, not this host, so it cannot reach further than needed. */
  private readonly messagingGatewayService = new MessagingGatewayService({
    platform: () => this.platform,
    resolveWorkspaceId: () => {
      const workspaces = this.workspaceService.getWorkspaces();
      const configured = readGatewaySettings().workspaceId;
      // A configured id whose folder was removed must not strand every
      // inbound message.
      if (
        configured != null &&
        workspaces.some((entry) => entry.id === configured)
      )
        return configured;
      return this.workspaceService.getActiveWorkspace()?.id ?? null;
    },
    createAgentSession: (workspaceId) => this.createAgentSession(workspaceId),
    createAutoReplyBot: (platform) => {
      try {
        const { name, channel, aliases, description } =
          SELF_LANE_BOTS[platform];
        // Idempotent by current or earlier name, so a relink adopts the bot
        // instead of minting a twin. The channel stamp hides the composer.
        const existing = this.botService
          .list()
          .find((bot) => bot.name === name || aliases.includes(bot.name));
        if (existing != null) {
          if (existing.channel !== channel || existing.name !== name)
            this.botService.update(existing.id, { name, channel });
          return existing.id;
        }
        const bot = this.botService.create({ name, description, channel });
        void this.botService.openChat(bot.id).catch((err: unknown) => {
          console.error("[bots] auto-reply bot failed to open its chat:", err);
        });
        return bot.id;
      } catch (err) {
        console.error("[bots] auto-reply bot creation failed:", err);
        return null;
      }
    },
    updateSessionLabel: (workspaceId, sessionId, label) => {
      this.updateAgentSessionLabel(workspaceId, sessionId, label);
    },
    startSession: (workspaceId, sessionId, mode) =>
      this.startAgentSession({ workspaceId, sessionId, mode }),
    sendMessage: (workspaceId, sessionId, message, userText) => {
      void this.sendAgentMessage({ workspaceId, sessionId, message, userText });
    },
    emitUserMessage: (workspaceId, sessionId, content) => {
      this.emitEvent({
        type: "messaging-user-message",
        workspaceId,
        sessionId,
        content,
        emittedAt: new Date().toISOString(),
      });
    },
    emitAgentMessage: (workspaceId, sessionId, content) => {
      this.emitEvent({
        type: "messaging-agent-message",
        workspaceId,
        sessionId,
        content,
        emittedAt: new Date().toISOString(),
      });
    },
    emitChanged: () => {
      this.emitEvent({
        type: "messaging-updated",
        emittedAt: new Date().toISOString(),
      });
    },
    onToolAvailabilityChanged: () => {
      // So a platform linked mid-chat surfaces its tools without a new chat.
      this.mcpAgentToolsServer.notifyToolListChanged();
      // Not awaited: this must not hold up the platform starting.
      void this.mcpAdminService
        .notifyToolAvailabilityChanged("code")
        .catch((error: unknown) => {
          console.error(
            "[messaging] could not refresh the agent's tools:",
            error
          );
        });
    },
    // Deferred through the arrow: botService initializes after this field.
    openBotChat: (botId) => this.botService.openChat(botId),
    openBotSenderChat: (botId, platform, chatId, senderName) =>
      this.botService.openSenderChat(botId, platform, chatId, senderName),
    forgetSenderChats: (platform, chatId) => {
      // By owner stamp (which survives a lost registry row) and registry row.
      const suffix = `|${platform}:${chatId}`;
      for (const session of this.agentSessionManagerService.listAll()) {
        const owner = session.owner;
        if (owner?.role !== "sender" || !owner.key?.endsWith(suffix)) continue;
        this.removeAgentSession(session.workspaceId, session.id);
      }
      for (const [key] of listSenderSessionEntries()) {
        if (key.endsWith(suffix)) removeSenderSession(key);
      }
    },
  });
  /** Callbacks rather than a host reference, as for the gateway above. */
  private readonly botService = new BotService({
    resolveDefaultWorkspaceId: () => this.ensureDefaultWorkspace(),
    isWorkspaceUsable: (workspaceId) =>
      this.workspaceService
        .getWorkspaces()
        .some(
          (entry) => entry.id === workspaceId && entry.status !== "deleted"
        ),
    sessionExists: (workspaceId, sessionId) =>
      this.agentSessionManagerService.get(sessionId)?.workspaceId ===
      workspaceId,
    createSession: (workspaceId, owner) =>
      this.createAgentSession(workspaceId, null, owner),
    findOwnedSession: (botId, role, key) => {
      const found = this.agentSessionManagerService.findOwned(botId, role, key);
      return found == null
        ? null
        : { workspaceId: found.workspaceId, sessionId: found.id };
    },
    updateSessionLabel: (workspaceId, sessionId, label) => {
      this.updateAgentSessionLabel(workspaceId, sessionId, label);
    },
    startSession: (workspaceId, sessionId) =>
      this.startAgentSession({ workspaceId, sessionId }),
    sendMessage: (workspaceId, sessionId, message, userText) => {
      void this.sendAgentMessage({ workspaceId, sessionId, message, userText });
    },
    removeSession: (workspaceId, sessionId) => {
      this.removeAgentSession(workspaceId, sessionId);
    },
    updateSessionModel: (workspaceId, sessionId, model) => {
      this.setAgentSessionModel(workspaceId, sessionId, model);
      // A running agent takes it now; a stopped one starts on it.
      const runtime = this.agentManagerService.getRuntimeInfo(sessionId);
      if (runtime != null && runtime.status === "running")
        this.setAgentModel({ workspaceId, sessionId, model });
    },
    // One resolver for display and execution (spec 03 §13.2): the bot's
    // own model when configured, else the stored default when configured,
    // else the tier's recommendation, else the fallback.
    effectiveModel: (requested, pinned) =>
      effectiveBotModel(
        requested,
        {
          readDefault: () => readSettings().defaultModel,
          listCatalog: () => listAvailableModels(),
          cachedRecommended: () => cachedRecommendedModelId(),
        },
        pinned
      ),
    sessionInfo: (sessionId) => {
      const session = this.agentSessionManagerService.get(sessionId);
      return session == null
        ? null
        : {
            workspaceId: session.workspaceId,
            owner: session.owner ?? null,
            model: session.model ?? null,
          };
    },
    onBotRemoved: (botId) => {
      // Its routines stay, paused: they were the bot's work, and without it
      // they would keep firing, spending credits, in nobody's voice. The
      // user resumes or deletes them from the Routines panel.
      for (const job of listJobs()) {
        if (job.botId === botId) {
          updateJob(job.id, { botId: null, enabled: false });
          recordRun(job.id, "paused: its bot was deleted");
        }
      }
      this.emitEvent({
        type: "cronjobs-updated",
        emittedAt: new Date().toISOString(),
      });
      // Inbound routing pointed at it goes too, or allowed senders fall
      // through to per-sender sessions the user never chose.
      const settings = readGatewaySettings();
      if (settings.botId === botId) {
        saveGatewaySettings({ botId: null, respondToInbound: false });
        this.emitEvent({
          type: "messaging-updated",
          emittedAt: new Date().toISOString(),
        });
      }
    },
    emitChanged: () => {
      this.emitEvent({
        type: "bots-updated",
        emittedAt: new Date().toISOString(),
      });
    },
  });
  private readonly sessionArtifactsService = new SessionArtifactsService({
    resolveWorkspacePath: (workspaceId) => {
      const workspace = this.workspaceService
        .getWorkspaces()
        .find((entry) => entry.id === workspaceId);
      if (workspace?.isRemote || workspace?.path == null) {
        return null;
      }
      return workspace.path;
    },
    isWorkspaceRemote: (workspaceId) =>
      this.workspaceService
        .getWorkspaces()
        .find((entry) => entry.id === workspaceId)?.isRemote === true,
    onChanged: () => {
      this.emitEvent({
        type: "session-artifacts-updated",
        emittedAt: new Date().toISOString(),
      });
    },
  });
  private readonly agentManagerService = new AgentManagerService({
    resolveWorkspacePath: (workspaceId, sessionId) => {
      const session = this.agentSessionManagerService.get(sessionId);
      if (
        session?.workspaceId === workspaceId &&
        session.worktreePath != null
      ) {
        return session.worktreePath;
      }
      const workspace = this.workspaceService
        .getWorkspaces()
        .find((entry) => entry.id === workspaceId);
      if (workspace?.isRemote || workspace?.path == null) {
        return null;
      }
      return workspace.path;
    },
    resolveArtifact: () => this.artifactResolverService.resolveBundledCliPath(),
    resolveAuthEnv: () => buildAgentAuthEnv(),
    resolveAdditionalConfigEnv: async (sessionId: string) =>
      this.buildAdditionalConfigEnv("code", sessionId),
    emitStateUpdated: (workspaceId, sessionId, state) => {
      if (state.status === "starting" || state.pid == null)
        this.modelSwitches.invalidate(sessionId);
      this.agentSessionManagerService.updateFromCliState(state);
      this.emitEvent({
        type: "local-cli-state-updated",
        workspaceId,
        sessionId,
        state,
        emittedAt: new Date().toISOString(),
      });
    },
    emitAgui: (_workspaceId, sessionId, event, origin) => {
      this.aguiRelay.ingest(sessionId, event, origin);
    },
    emitAguiExit: (_workspaceId, sessionId, exit) => {
      this.aguiRelay.runtimeExited(sessionId, exit);
    },
    emitNdjson: (workspaceId, sessionId, payload, origin) => {
      // An agui runtime serves only the new renderer (spec 00-agent-agui
      // §2.1): its compat lines feed main's taps below, never the old
      // renderer's `local-cli-ndjson` stream.
      // Recorded before the filter: a stopped session is exactly one whose
      // log somebody is about to want.
      if (payload.type === "ready" && payload.agentSessionId != null) {
        this.agentSessionManagerService.recordAgentSession(
          sessionId,
          payload.agentSessionId,
          payload.agentSessionFile ?? null
        );
      }
      // `agent.setModel`'s answer, whatever the turn filter decides below.
      this.modelSwitches.feed(sessionId, payload);
      // Post-Stop sessions drop everything but terminal events, so a stale
      // tail cannot leak into the renderer.
      const passedFilter = this.sessionTurnStateService.filterDesktopEvent(
        workspaceId,
        sessionId,
        payload
      );
      if (passedFilter) {
        // A relayed turn's own words are notes around a <reply> tag, addressed
        // to nobody; the gateway echoes what it actually sent instead.

        // Same filtered stream, so a post-Stop tail cannot file cancelled work.
        this.sessionArtifactsService.recordFromNdjson(
          workspaceId,
          sessionId,
          payload
        );
        // Same reason: the remote user must not receive a cancelled tail.
        this.messagingGatewayService.handleAgentEvent(sessionId, payload);
        for (const listener of this.agentEventListeners)
          listener(sessionId, payload);
        this.settleRoutineRun(sessionId, payload);
        this.feedTurnWaiter(sessionId, payload);
      } else if (payload.type === "permission_needed") {
        // A post-Stop permission request must not reach handleDesktopEvent:
        // it would flip the snapshot to waiting and could auto-accept a
        // browser tool for a cancelled turn. Plain events fall through so
        // their status/mode/model patches keep the snapshot in sync.
        return;
      }
      const communicationUpdate =
        this.agentCommunicationService.handleDesktopEvent(payload);
      if (communicationUpdate.autoAllowDecision != null) {
        if (origin != null) {
          // Bound to the runtime that asked: a replacement process that now
          // owns the session id never receives another process's answer.
          this.agentManagerService.sendCommandToRuntime(
            origin,
            workspaceId,
            sessionId,
            {
              type: "permission_response",
              permissionId: communicationUpdate.autoAllowDecision.permissionId,
              decision: communicationUpdate.autoAllowDecision.decision,
            }
          );
        }
      }
      if (communicationUpdate.statePatch != null) {
        const mergedState = this.agentManagerService.applyStatePatch(
          workspaceId,
          sessionId,
          communicationUpdate.statePatch
        );
        this.agentSessionManagerService.updateFromCliState(mergedState);
        this.emitEvent({
          type: "local-cli-state-updated",
          workspaceId,
          sessionId,
          state: mergedState,
          emittedAt: new Date().toISOString(),
        });
      }
      if (communicationUpdate.skillsLoaded != null) {
        this.emitEvent({
          type: "local-cli-skills-loaded",
          workspaceId,
          sessionId,
          skills: communicationUpdate.skillsLoaded,
          emittedAt: new Date().toISOString(),
        });
      }
    },
    emitSystemReady: (workspaceId, sessionId) => {
      this.emitEvent({
        type: "local-cli-system-ready",
        workspaceId,
        sessionId,
        emittedAt: new Date().toISOString(),
      });
    },
    emitSessionClosed: (workspaceId, sessionId) => {
      const wasBusy = this.sessionTurnStateService.get(
        workspaceId,
        sessionId
      ).isBusy;
      this.sessionTurnStateService.markStopped(workspaceId, sessionId);
      if (wasBusy) {
        // A turn that dies mid-ask leaves the card with nothing behind it.
        const ended =
          "The session ended before the question was answered. Do not ask again unless the user brings it up.";
        const conversation = this.conversationKeyForSession(sessionId);
        if (conversation != null)
          this.connectorGate.release(conversation, ended);
      }
    },
    emitMcpRuntimeServers: (workspaceId, sessionId, servers) => {
      this.emitEvent({
        type: "mcp-runtime-servers",
        workspaceId,
        sessionId,
        servers,
        emittedAt: new Date().toISOString(),
      });
      this.mcpRuntimeMovedConnectorStatus(servers);
    },
    emitMcpRuntimeStatus: (workspaceId, sessionId, event) => {
      this.mcpRuntimeMovedConnectorStatus([
        { id: event.serverId, status: event.status },
      ]);
      this.emitEvent({
        type: "mcp-runtime-status",
        workspaceId,
        sessionId,
        serverId: event.serverId,
        status: event.status,
        ts: event.ts,
        ...(event.error != null ? { error: event.error } : {}),
        ...(event.authUrl != null ? { authUrl: event.authUrl } : {}),
        ...(event.pid != null ? { pid: event.pid } : {}),
        emittedAt: new Date().toISOString(),
      });
    },
    emitMcpRuntimeLog: (workspaceId, sessionId, entry) => {
      this.emitEvent({
        type: "mcp-runtime-log",
        workspaceId,
        sessionId,
        entry,
        emittedAt: new Date().toISOString(),
      });
    },
    emitMcpRuntimeError: (workspaceId, sessionId, event) => {
      if (event.kind === "refresh") {
        this.emitEvent({
          type: "mcp-runtime-refresh-failed",
          workspaceId,
          sessionId,
          error: event.error,
          ts: event.ts,
          emittedAt: new Date().toISOString(),
        });
      } else {
        this.emitEvent({
          type: "mcp-runtime-restart-failed",
          workspaceId,
          sessionId,
          serverId: event.serverId,
          error: event.error,
          ts: event.ts,
          emittedAt: new Date().toISOString(),
        });
      }
    },
    // Work that needs Electron, exposed to the agent as named services rather
    // than a whole MCP server. See packages/agent/src/host-services.ts.
    runHostService: (service, payload) =>
      this.runAgentHostService(service, payload),
  });
  private readonly agentCommunicationService = new AgentCommunicationService(
    (workspaceId, sessionId, command) => {
      return this.agentManagerService.sendCommand(
        workspaceId,
        sessionId,
        command
      );
    }
  );
  private readonly mcpAdminService = new McpAdminService({
    mcpConfigService: this.mcpConfigService,
    rewriteRuntimeConfig: (mode, sessionId) =>
      this.getRuntimeMcpPathForSpawn(mode, sessionId),
    listLiveSessions: () =>
      this.agentManagerService
        .getRuntimeDiagnostics()
        .filter((runtime) => runtime.live)
        .map(({ workspaceId, sessionId }) => ({ workspaceId, sessionId })),
    sendCommand: (workspaceId, sessionId, command) =>
      this.agentManagerService.sendCommand(workspaceId, sessionId, command),
    broadcastCommand: (command) =>
      this.agentManagerService.broadcastCommand(command),
    setBuiltinBrowserEnabled: (enabled) => this.setMcpBrowserEnabled(enabled),
  });

  /**
   * Tell every running agent to re-read stored keys and provider catalogs. A
   * key saved now belongs to the chat already open, not only the next one.
   */
  refreshAgentProviders(): number {
    return this.agentManagerService.broadcastCommand({
      type: "refresh_providers",
    });
  }

  /** Ship the debug logs now rather than on the next timed sweep. */
  syncLogsNow(): void {
    this.logSyncService.syncNow();
  }

  /**
   * True while an agent turn is in flight: an agui runtime's from the
   * relay's run state (authoritative, never raced by compat; spec 07 review
   * r1 #10), an ndjson runtime's from main's turn state.
   */
  hasActiveAgentTurn(): boolean {
    return agentTurnBusy({
      relay: this.aguiRelay,
      turnState: this.sessionTurnStateService,
      wireOf: (sessionId) =>
        this.agentManagerService.getRuntimeInfo(sessionId)?.wire ?? null,
    });
  }

  /** True while any terminal PTY (user shell or preview server) is alive. */
  hasLiveTerminalSessions(): boolean {
    return this.terminalSessionService.hasLiveSessions();
  }

  /** Every agent process this run, as the log dump wants it. */
  collectAgentDiagnostics(): AgentSessionDiagnostics[] {
    return this.agentManagerService.getRuntimeDiagnostics().map((runtime) => {
      const info = this.agentSessionManagerService.getDiagnosticInfo(
        runtime.sessionId
      );
      return {
        sessionId: runtime.sessionId,
        workspaceId: runtime.workspaceId,
        label: info?.label ?? null,
        state: runtime.state,
        agentSessionId: info?.agentSessionId ?? null,
        agentSessionFile: info?.agentSessionFile ?? null,
        stderrTail: tailStderr(runtime.stderr),
        mcpServers: runtime.mcpServers,
        mcpLogs: runtime.mcpLogs,
        command: runtime.command,
        live: runtime.live,
      };
    });
  }

  private readonly sessionTurnStateService = new SessionTurnStateService(
    (snapshot) => {
      this.emitEvent({
        type: "session-turn-state-updated",
        workspaceId: snapshot.workspaceId,
        sessionId: snapshot.sessionId,
        state: snapshot,
        emittedAt: new Date().toISOString(),
      });
    },
    (workspaceId, sessionId, lastActivity) => {
      // Name what it was doing: a tool that hangs before it starts never
      // emitted a card for the transcript to keep.
      const doing =
        lastActivity != null ? ` while running ${lastActivity}` : "";
      // The renderer's run ends with main's own terminal, ahead of the
      // cancelled one the agent writes for the stop (first terminal wins).
      this.aguiRelay.failActiveRun(
        sessionId,
        "inactivity_timeout",
        `Agent timed out: nothing came back for ${INACTIVITY_TIMEOUT_MINUTES} minutes${doing}.`
      );
      // Actually stop it, or the slow tool's events would still be forwarded
      // when it finally lands and the session would go busy again.
      this.stopAgentTurn({ workspaceId, sessionId });
    }
  );

  private readonly workspaceRuntimeService = new WorkspaceRuntimeService({
    workspaceService: this.workspaceService,
    gitService: this.gitService,
    fileTreeService: this.fileTreeService,
    emitEvent: (event) => this.emitEvent(event),
  });

  async runAgentHostService(
    service: string,
    payload: unknown
  ): Promise<unknown> {
    if (service.startsWith("render_"))
      assertHostCapability(this.platform, service);
    switch (service) {
      case "render_document":
        return await renderDocument(payload as RenderDocumentRequest);
      case "document_templates":
        return await documentTemplates();
      case "design_catalog":
        return await designCatalog();
      case "render_design":
        return await renderDesign(payload as RenderDesignRequest);
      case "deck_templates":
        return await deckTemplates();
      case "deck_slots":
        return await deckSlots(payload as DeckSlotsRequest);
      case "render_deck":
        return await renderDeck(payload as RenderDeckRequest);
      default:
        throw new Error(`Unknown host service: ${String(service)}`);
    }
  }

  initialize(): void {
    if (this.initializedAt != null) {
      return;
    }

    this.initializedAt = new Date().toISOString();
    this.workspaceService.initialize();
    const workspaceIds = this.workspaceService.getWorkspaces().map((w) => w.id);
    this.agentSessionManagerService.initialize(workspaceIds);
    this.adoptLegacyBotSessions();
    this.reconcileBotChatWorkspaces();
    this.sessionArtifactsService.initialize(workspaceIds);
  }

  start(): void {
    if (this.startedAt != null) {
      return;
    }

    this.startedAt = new Date().toISOString();
    // Signed-out sessions have no key and are skipped inside the service.
    const persisted = (sessionId: string): void => {
      this.debugSyncService.enqueue(sessionId);
      // A bot's sidebar row shows the last thing said in its chat.
      if (this.botService.botIdForSession(sessionId) != null)
        this.emitEvent({
          type: "bots-updated",
          emittedAt: new Date().toISOString(),
        });
    };
    // The relay's AG-UI threads have no v1 save (spec 03 §24.12 c).
    this.threadStore.onAguiPersist(persisted);
    this.logSyncService.start();
    this.diagnosticsSyncService.start();
    this.workspaceRuntimeService.ensureWorkspaceWatchers();
    this.workspaceRuntimeService.scheduleRefresh(0);
    if (this.platform === "electron")
      void this.builtinMcpLifecycle.startBrowserServer();
    // Failures are per-connector and reported through the pane.
    void this.messagingGatewayService
      .syncConnectors()
      .catch((error: unknown) => {
        console.error("[messaging] failed to start connectors:", error);
      });
  }

  /** Startup catch-up starts after the main renderer is interactive. */
  startBackgroundSync(): void {
    this.debugSyncService.sweepOnStartup();
  }

  stop(): void {
    this.startedAt = null;
    this.workspaceRuntimeService.stop();
    this.logSyncService.stop();
    this.diagnosticsSyncService.stop();
    this.debugSyncService.stop();
  }

  hasDevicesBootedByUs(): boolean {
    return this.deviceService.hasDevicesBootedByUs();
  }

  async shutdownDevicesBootedByUs(): Promise<void> {
    await this.deviceService.shutdownBootedByUs();
  }

  /** Resolves once every agent child has exited; the quit path awaits it. */
  dispose(): Promise<void> {
    this.stop();
    this.builtinMcpLifecycle.stopBrowserServer();
    this.chromeBrowser.dispose();
    this.mcpDeviceServer.stop();
    this.mcpAgentToolsServer.stop();
    this.deviceMirrorService.dispose();
    this.initializedAt = null;
    this.workspaceService.dispose();
    this.terminalSessionService.dispose();
    stopAllServed();
    // A pending connector hop holds a port and a timeout that outlive the window.
    cancelConnectorConnect();
    this.sessionArtifactsService.dispose();
    const agentsStopped = this.agentManagerService.dispose();
    this.fileSearchService.dispose();
    const messagingStopped = this.messagingGatewayService.dispose();
    this.workspaceRuntimeService.reset();
    return Promise.all([agentsStopped, messagingStopped]).then(() => {});
  }

  setEventDispatcher(dispatcher: EventDispatcher): void {
    this.eventDispatcher = dispatcher;
  }

  setBusDispatcher(dispatcher: BusDispatcher): void {
    this.busDispatcher = dispatcher;
  }

  async addWorkspace(
    workspacePath: string,
    isRemote = false
  ): Promise<AddWorkspaceResult> {
    const result = await this.workspaceService.addWorkspace(
      workspacePath,
      isRemote
    );
    if (!result.success) {
      return result;
    }

    this.workspaceRuntimeService.ensureWorkspaceWatchers();
    await this.workspaceRuntimeService.refreshAndEmit();
    return result;
  }

  checkWorkspacePath(workspaceId: string): Promise<WorkspacePathStatus> {
    return this.workspaceService.checkWorkspacePath(workspaceId);
  }

  async relocateWorkspace(
    workspaceId: string,
    newPath: string,
    /** `restore` clears a tombstone (the RPC procedure; spec 04 §26.4 d). */
    options: { restore?: boolean } = {}
  ): Promise<RelocateWorkspaceResult> {
    const result = await this.workspaceService.relocateWorkspace(
      workspaceId,
      newPath,
      options
    );
    if (!result.success) {
      return result;
    }

    // Live CLIs hold the old cwd; the next send respawns in the new folder.
    for (const session of this.agentSessionManagerService.list(workspaceId)) {
      this.agentManagerService.stopSession(workspaceId, session.id);
    }
    this.workspaceRuntimeService.ensureWorkspaceWatchers();
    await this.workspaceRuntimeService.refreshAndEmit();
    return result;
  }

  /**
   * Sign-out: stop every live CLI and move the session records into the
   * account's stash. Nothing is deleted; the UI just has nothing to show.
   */
  stashSessionsForAccount(accountKey: string): number {
    for (const workspace of this.workspaceService.getWorkspaces()) {
      for (const session of this.agentSessionManagerService.list(
        workspace.id
      )) {
        this.agentManagerService.stopSession(workspace.id, session.id);
      }
    }
    const stashed = this.agentSessionManagerService.stashAll(accountKey);
    if (stashed > 0) {
      this.emitEvent({
        type: "sessions-reloaded",
        emittedAt: new Date().toISOString(),
      });
    }
    return stashed;
  }

  /** Sign-in support: bring the account's stashed sessions back into view. */
  restoreSessionsForAccount(accountKey: string): number {
    const restored = this.agentSessionManagerService.restoreFromStash(
      accountKey,
      this.workspaceService.getWorkspaces().map((workspace) => workspace.id)
    );
    if (restored > 0) {
      this.emitEvent({
        type: "sessions-reloaded",
        emittedAt: new Date().toISOString(),
      });
    }
    return restored;
  }

  /**
   * Two-stage: the first delete tombstones the workspace (sessions stay
   * readable); deleting the tombstone erases sessions and artifacts for good.
   */
  async removeWorkspace(
    workspaceId: string
  ): Promise<{ success: boolean; error?: string }> {
    const workspace = this.workspaceService
      .getWorkspaces()
      .find((w) => w.id === workspaceId);
    if (workspace == null) {
      return { success: false, error: WORKSPACE_NOT_FOUND };
    }

    if (workspace.status !== "deleted") {
      for (const session of this.agentSessionManagerService.list(workspaceId)) {
        this.agentManagerService.stopSession(workspaceId, session.id);
      }
      this.workspaceService.markDeleted(workspaceId);
      this.workspaceRuntimeService.ensureWorkspaceWatchers();
      await this.workspaceRuntimeService.refreshAndEmit();
      return { success: true };
    }

    const sessionIds =
      this.agentSessionManagerService.removeAllForWorkspace(workspaceId);
    for (const sessionId of sessionIds) {
      this.agentManagerService.stopSession(workspaceId, sessionId);
      this.sessionTurnStateService.clearSession(sessionId);
      environmentNoticeService.forgetSession(sessionId);
      // A remote conversation bound to it would otherwise be answered by nothing.
      this.messagingGatewayService.forgetSession(sessionId);
      this.transcriptService.remove(sessionId);
      this.aguiRelay.forgetThread(sessionId);
      this.emitEvent({
        type: "local-cli-session-removed",
        workspaceId,
        sessionId,
        emittedAt: new Date().toISOString(),
      });
    }
    this.workspaceService.removeWorkspace(workspaceId);
    this.sessionArtifactsService.removeForWorkspace(workspaceId);
    this.workspaceRuntimeService.ensureWorkspaceWatchers();
    await this.workspaceRuntimeService.refreshAndEmit();
    return { success: true };
  }

  async updateWorkspaceLabel(
    workspaceId: string,
    label: string
  ): Promise<{ success: boolean; error?: string }> {
    const updated = this.workspaceService.updateLabel(workspaceId, label);
    if (!updated) {
      return { success: false, error: WORKSPACE_NOT_FOUND };
    }
    await this.workspaceRuntimeService.refreshAndEmit();
    return { success: true };
  }

  async switchWorkspace(workspaceId: string): Promise<SwitchWorkspaceResult> {
    const result = this.workspaceService.switchWorkspace(workspaceId);
    if (!result.success) {
      return result;
    }

    this.workspaceRuntimeService.noteWorkspaceSwitched(workspaceId);
    this.workspaceRuntimeService.ensureWorkspaceWatchers();
    this.workspaceRuntimeService.scheduleRefresh(0);
    return result;
  }

  async initGit(): Promise<InitGitResult> {
    const workspace = this.workspaceService.getActiveWorkspace();
    if (workspace?.path == null || workspace.isRemote) {
      return { success: false, error: "No local workspace selected." };
    }

    const result = await this.gitService.initRepository(workspace.path);
    if (!result.success) {
      return result;
    }

    await this.workspaceRuntimeService.refreshAndEmit();
    return { success: true };
  }

  async getFileTreeChildren(
    directoryPath: string
  ): Promise<WorkspaceState["fileTree"]> {
    const workspace = this.workspaceService.getActiveWorkspace();
    if (workspace?.path == null || workspace.isRemote) {
      return [];
    }

    const absDirectoryPath = path.resolve(workspace.path, directoryPath);
    return this.fileTreeService.buildDirectoryChildren(
      workspace.path,
      absDirectoryPath,
      this.workspaceRuntimeService.getSnapshot().gitChanges
    );
  }

  async searchFiles(query: string): Promise<FileSearchResult> {
    const workspace = this.workspaceService.getActiveWorkspace();
    if (workspace?.path == null || workspace.isRemote) {
      return { items: [] };
    }
    return this.fileSearchService.search(workspace.path, query);
  }

  async getGitDiffForPath(
    filePath: string,
    scope: GitDiffScope = "unstaged"
  ): Promise<string> {
    const workspace = this.workspaceService.getActiveWorkspace();
    if (workspace?.path == null || workspace.isRemote) {
      return "";
    }

    return this.gitService.buildUnifiedDiffForPath(
      workspace.path,
      filePath,
      scope
    );
  }

  async getGitChangeStatsForPath(
    filePath: string,
    scope: GitChangeStatsScope = "all"
  ): Promise<GitChangeStatsSnapshot> {
    const workspace = this.workspaceService.getActiveWorkspace();
    if (workspace?.path == null || workspace.isRemote) {
      return { additions: null, deletions: null };
    }

    return this.gitService.readChangeStatsForPath(
      workspace.path,
      filePath,
      scope
    );
  }

  async renameLocalFile(
    fromPath: string,
    toPath: string
  ): Promise<{ success: boolean; error?: string }> {
    const workspace = this.workspaceService.getActiveWorkspace();
    if (workspace?.path == null || workspace.isRemote)
      return { success: false, error: "No active workspace" };
    return this.fileTreeService.renameFile(workspace.path, fromPath, toPath);
  }

  async trashLocalFile(
    filePath: string
  ): Promise<{ success: boolean; error?: string }> {
    const workspace = this.workspaceService.getActiveWorkspace();
    if (workspace?.path == null || workspace.isRemote)
      return { success: false, error: "No active workspace" };
    return this.fileTreeService.trashFile(workspace.path, filePath);
  }

  async saveResolvedConflict(
    filePath: string,
    content: string
  ): Promise<{ success: boolean; error?: string }> {
    const workspace = this.workspaceService.getActiveWorkspace();
    if (workspace?.path == null || workspace.isRemote)
      return { success: false, error: "No active workspace" };
    return this.fileTreeService.saveResolvedConflict(
      workspace.path,
      filePath,
      content
    );
  }

  async writeFile(
    filePath: string,
    content: string
  ): Promise<{ success: boolean; error?: string }> {
    const workspace = this.workspaceService.getActiveWorkspace();
    if (workspace?.path == null || workspace.isRemote)
      return { success: false, error: "No active workspace" };
    return this.fileTreeService.writeFile(workspace.path, filePath, content);
  }

  async stageFile(
    filePath: string
  ): Promise<{ success: boolean; error?: string }> {
    const workspace = this.workspaceService.getActiveWorkspace();
    if (workspace?.path == null || workspace.isRemote)
      return { success: false, error: "No active workspace" };
    return this.gitService.stageFile(workspace.path, filePath);
  }

  async unstageFile(
    filePath: string
  ): Promise<{ success: boolean; error?: string }> {
    const workspace = this.workspaceService.getActiveWorkspace();
    if (workspace?.path == null || workspace.isRemote)
      return { success: false, error: "No active workspace" };
    return this.gitService.unstageFile(workspace.path, filePath);
  }

  startTerminalSession(
    request: StartTerminalSessionRequest
  ): Promise<StartTerminalSessionResult> {
    return this.terminalSessionService.startSession(request);
  }

  writeTerminalInput(request: WriteTerminalInputRequest): boolean {
    return this.terminalSessionService.writeInput(request);
  }

  resizeTerminalSession(request: ResizeTerminalSessionRequest): boolean {
    return this.terminalSessionService.resizeSession(request);
  }

  hideTerminalSession(request: TerminalRuntimeRequest): boolean {
    return this.terminalSessionService.hideSession(request);
  }

  /** Running terminals' states, for `terminal.events`' opening snapshot. */
  listTerminalStates(key?: ConversationKey): TerminalSessionSnapshot[] {
    return this.terminalSessionService.listStates(key);
  }

  /** A terminal's output from an offset, and its exit once it exited. */
  terminalOutputState(
    request: Parameters<TerminalSessionService["outputState"]>[0]
  ): ReturnType<TerminalSessionService["outputState"]> {
    return this.terminalSessionService.outputState(request);
  }

  promoteTerminalSessionScope(
    request: PromoteTerminalSessionScopeRequest
  ): Promise<TerminalSessionSnapshot | null> {
    return this.terminalSessionService.promoteDraftToSession(request);
  }

  /**
   * Remember the model a chat is on, so reopening it does not move it. The
   * running agent is told separately (setAgentModel).
   */
  setAgentSessionModel(
    workspaceId: string,
    sessionId: string,
    model: string
  ): boolean {
    const updated = this.agentSessionManagerService.updateModel(
      sessionId,
      model
    );
    if (updated) {
      this.emitEvent({
        type: "local-cli-session-model-updated",
        workspaceId,
        sessionId,
        model,
        emittedAt: new Date().toISOString(),
      });
    }
    return updated;
  }

  updateAgentSessionLabel(
    workspaceId: string,
    sessionId: string,
    label: string
  ): boolean {
    const updated = this.agentSessionManagerService.updateLabel(
      workspaceId,
      sessionId,
      label
    );
    if (updated) {
      this.emitEvent({
        type: "local-cli-session-updated",
        workspaceId,
        sessionId,
        label,
        emittedAt: new Date().toISOString(),
      });
    }
    return updated;
  }

  // Backstop for every entry point: a tombstoned workspace is read-only.
  private isWorkspaceDeleted(workspaceId: string): boolean {
    return (
      this.workspaceService.getWorkspaces().find((w) => w.id === workspaceId)
        ?.status === "deleted"
    );
  }

  createAgentSession(
    workspaceId: string,
    routineId: string | null = null,
    owner: SessionOwner | null = null,
    /** The caller's own id (an optimistic insert); a taken one is `ConflictError`. */
    id?: string,
    /** `db.sessions.insert`'s model and mode, persisted at creation. */
    initial: { model?: string | null; mode?: AgentMode | null } = {}
  ): AgentSessionListItem {
    if (this.isWorkspaceDeleted(workspaceId)) {
      throw new Error(
        "Workspace was deleted; new chats cannot be started in it."
      );
    }
    const session = this.agentSessionManagerService.create(
      workspaceId,
      routineId,
      owner,
      null,
      id,
      initial
    );
    this.emitEvent({
      type: "local-cli-session-created",
      workspaceId,
      sessionId: session.id,
      session,
      emittedAt: new Date().toISOString(),
    });
    return session;
  }

  listAgentSessions(workspaceId: string): AgentSessionListItem[] {
    return this.agentSessionManagerService.list(workspaceId);
  }

  listAllAgentSessions(): AgentSessionListItem[] {
    return this.agentSessionManagerService.listAll();
  }

  /** Every session's cached turn state, for the sessions table's join. */
  listSessionTurnStates(): SessionTurnStateSnapshot[] {
    return this.sessionTurnStateService.list();
  }

  /** The DB tables' direct hooks (spec 00 B.2): writes that emit no event. */
  onSessionsChanged(listener: () => void): () => void {
    return this.agentSessionManagerService.onChanged(listener);
  }

  onWorkspacesChanged(listener: () => void): () => void {
    return this.workspaceService.onChanged(listener);
  }

  onBotsWritten(listener: () => void): () => void {
    return onBotStoreWrite(listener);
  }

  /** A `started` attempt was recorded (`routines.events`, spec 05 §31.5 j). */
  onRoutineRunStarted(
    listener: (event: RoutineRunStarted) => void
  ): () => void {
    return onRoutineRunStarted(listener);
  }

  onRoutinesWritten(listener: () => void): () => void {
    return onCronStoreWrite(listener);
  }

  /** Where memories and bots live; the memory watchers' root. */
  botHome(): string {
    return abacusBotHome();
  }

  getMessagingSnapshot(): MessagingSnapshot {
    return this.messagingGatewayService.getSnapshot();
  }

  listInviteContacts(
    platformId: MessagingPlatformId
  ): Array<{ chatId: string; name: string }> {
    return this.messagingGatewayService.listInviteContacts(platformId);
  }

  sendMessagingText(
    platformId: MessagingPlatformId,
    chatId: string,
    text: string
  ): Promise<void> {
    return this.messagingGatewayService.sendToChat(platformId, chatId, text);
  }

  updateMessagingPlatform(
    request: UpdateMessagingPlatformRequest
  ): Promise<MessagingSnapshot> {
    return this.messagingGatewayService.updatePlatform(request);
  }

  decideMessagingPairing(
    request: MessagingPairingDecisionRequest
  ): Promise<MessagingSnapshot> {
    return this.messagingGatewayService.decidePairing(request);
  }

  updateMessagingSettings(
    request: UpdateMessagingSettingsRequest
  ): Promise<MessagingSnapshot> {
    return this.messagingGatewayService.updateSettings(request);
  }

  pairSharedChannel(
    platformId: MessagingPlatformId
  ): Promise<MessagingSnapshot> {
    return this.messagingGatewayService.pairSharedChannel(platformId);
  }

  unlinkSharedChannel(
    platformId: MessagingPlatformId
  ): Promise<MessagingSnapshot> {
    return this.messagingGatewayService.unlinkSharedChannel(platformId);
  }

  openSharedChannelLink(
    platformId: MessagingPlatformId,
    target?: "install" | "dm"
  ): Promise<void | string> {
    return this.messagingGatewayService.openSharedChannelLink(
      platformId,
      target
    );
  }

  showMessagingLogin(platformId: MessagingPlatformId): void {
    this.messagingGatewayService.showMessagingLogin(platformId);
  }

  listSessionArtifacts(): SessionArtifact[] {
    return this.sessionArtifactsService.list();
  }

  listBots(): Bot[] {
    return this.botService.list();
  }

  /**
   * Bring bot chats back to the bot folder. When the registry loses the
   * folder's entry (two instances writing one home suffices), the folder is
   * minted a new id and every session under the old one orphans. Re-homing
   * keeps the conversations, since transcripts are keyed by session id; a bot
   * holding two forever chats keeps the earlier one.
   */
  private reconcileBotChatWorkspaces(): void {
    const botHome = this.workspaceService
      .getWorkspaces()
      .find(
        (entry) =>
          entry.status !== "deleted" && entry.path === botDefaultWorkspace()
      );
    if (botHome == null) return;

    let rehomed = 0;
    for (const orphan of this.agentSessionManagerService.ownedOrphans()) {
      if (this.agentSessionManagerService.rehome(orphan.id, botHome.id))
        rehomed += 1;
    }

    // A stale workspace in the sender registry mints a duplicate the same way.
    for (const [key, row] of listSenderSessionEntries()) {
      if (row.workspaceId === botHome.id) continue;
      const moved = this.agentSessionManagerService.get(row.sessionId);
      if (moved?.workspaceId !== botHome.id) continue;
      recordSenderSession(key, { ...row, workspaceId: botHome.id });
    }

    // The earliest forever chat carries the history; duplicates stay listed.
    let repointed = 0;
    for (const bot of this.botService.list()) {
      const forever = this.agentSessionManagerService
        .listOwnedBy(bot.id)
        .filter((session) => session.owner?.role === "forever")
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      const original = forever[0];
      if (original == null) continue;
      if (
        bot.sessionId === original.id &&
        bot.workspaceId === original.workspaceId
      )
        continue;
      recordBotSession(bot.id, original.workspaceId, original.id);
      repointed += 1;
    }

    if (rehomed > 0 || repointed > 0) {
      console.log(
        `[bots] recovered bot chats after a workspace change: ${rehomed} re-homed, ${repointed} re-pointed`
      );
      this.emitEvent({
        type: "bots-updated",
        emittedAt: new Date().toISOString(),
      });
    }
  }

  /** The last line said in each bot's chat; bots with none said are absent. */
  listBotChatPreviews(): Record<string, BotChatPreview> {
    const previews: Record<string, BotChatPreview> = {};

    for (const bot of this.botService.list()) {
      const preview = botChatPreview(
        this.transcriptService,
        bot.sessionId,
        this.threadStore
      );
      if (preview != null) previews[bot.id] = preview;
    }

    return previews;
  }

  /**
   * Backfill owner stamps from the legacy registries onto bot conversations
   * minted before owners existed. Idempotent: adoptOwner refuses a session
   * that already has one.
   */
  private adoptLegacyBotSessions(): void {
    for (const bot of this.botService.list()) {
      if (bot.sessionId != null)
        this.agentSessionManagerService.adoptOwner(bot.sessionId, {
          kind: "bot",
          botId: bot.id,
          role: "forever",
          key: null,
        });
    }
    // The channels registry file has no reader left.
    try {
      fs.rmSync(path.join(abacusBotHome(), "channels.json"), { force: true });
    } catch {
      // Nothing depends on this.
    }
    for (const [key, row] of listSenderSessionEntries()) {
      // Channel rows are dropped: as plain senders they would surface everywhere.
      if (row.platform === "channel") {
        removeSenderSession(key);
        continue;
      }
      this.agentSessionManagerService.adoptOwner(row.sessionId, {
        kind: "bot",
        botId: row.botId,
        role: row.platform === "routine" ? "routine" : "sender",
        key,
        platform: row.platform,
        senderName: row.senderName,
      });
    }
  }

  /** Auto-reply conversations, for the Bots pane to nest under their bots. */
  listBotSenderChats(): BotSenderChat[] {
    // Off the owner stamps, not the registry: the session records are the
    // source of truth for parentage.
    const pairing = listPairing();
    return this.agentSessionManagerService
      .listAll()
      .filter(
        (session) =>
          session.owner?.kind === "bot" && session.owner.role === "sender"
      )
      .map((session) => {
        const owner = session.owner!;
        const chatId = owner.key ?? null;
        const grant =
          chatId == null
            ? null
            : (pairing.find(
                (row) =>
                  row.platform === owner.platform && row.chatId === chatId
              ) ?? null);
        return {
          botId: owner.botId,
          workspaceId: session.workspaceId,
          sessionId: session.id,
          platform: owner.platform ?? "",
          senderName: owner.senderName ?? "",
          chatId,
          userId: grant?.userId ?? null,
          autoReply:
            grant?.status === "approved" || grant?.status === "paused"
              ? grant.status
              : null,
        };
      });
  }

  createBot(input: BotCreateInput, id?: string): Bot {
    return this.botService.create(input, id);
  }

  updateBot(id: string, changes: BotUpdateInput): Bot {
    this.assertNotChannelBot(id, "edited");
    return this.botService.update(id, changes);
  }

  announceBotChange(id: string, notice: BotChangeNotice): Promise<void> {
    return this.botService.announceChange(id, notice);
  }

  deleteBot(id: string): void {
    this.assertNotChannelBot(id, "deleted");
    this.botService.delete(id);
  }

  /**
   * Channel bots are minted and retired by the link itself. Guarded on the IPC
   * surface, not in BotService, which the link machinery edits through.
   */
  private assertNotChannelBot(id: string, verb: string): void {
    assertNotChannelBot(id, verb);
  }

  openBotChat(botId: string): Promise<BotChatHandle> {
    return this.botService.openChat(botId);
  }

  /**
   * Before an admission on a running agent (the relay's `beforeRun`): a bot
   * session whose model differs from its bot's effective one takes it now
   * (spec 03 §24.10 c). Non-bot sessions are untouched.
   */
  async applyEffectiveBotModel(sessionId: string): Promise<void> {
    await this.botService.pinSession(sessionId);
  }

  removeAgentSession(workspaceId: string, sessionId: string): boolean {
    const removed = this.agentSessionManagerService.remove(
      workspaceId,
      sessionId
    );
    if (removed) {
      this.sessionArtifactsService.removeForSession(sessionId);
      this.sessionTurnStateService.clearSession(sessionId);
      environmentNoticeService.forgetSession(sessionId);
      // A remote conversation bound to it would otherwise be answered by nothing.
      this.messagingGatewayService.forgetSession(sessionId);
      this.transcriptService.remove(sessionId);
      this.aguiRelay.forgetThread(sessionId);
      this.agentManagerService.stopSession(workspaceId, sessionId);
      this.emitEvent({
        type: "local-cli-session-removed",
        workspaceId,
        sessionId,
        emittedAt: new Date().toISOString(),
      });
    }
    return removed;
  }

  /**
   * The folder bots and the first-run tour fall back to, made on first ask. A
   * folder of the app's own, not the user's home: an empty folder under the
   * app's home grants the agent nothing that was not already the app's.
   */
  async ensureDefaultWorkspace(): Promise<string | null> {
    // Stamped, like the other two: without a kind it read as a project the
    // user had opened, and turned up in pickers offering somewhere to work.
    return this.ensureHomeWorkspace(botDefaultWorkspace(), "bot");
  }

  /** What a chat runs in when no project was picked ("Auto workspace"). */
  async ensureSessionHomeWorkspace(): Promise<string | null> {
    return this.ensureHomeWorkspace(sessionDefaultWorkspace(), "auto");
  }

  /**
   * A routine's own folder as a workspace, so its notes and output do not land
   * in someone's repository. Kind "routine" keeps it out of the pickers.
   */
  async ensureRoutineWorkspace(routineId: string): Promise<string | null> {
    return this.ensureHomeWorkspace(routineDir(routineId), "routine");
  }

  /**
   * The project a routine was set up for, or null: a real workspace, not one
   * of the app's own home folders, which are not a project anyone chose.
   */
  private routineProject(job: CronJob): { id: string; path: string } | null {
    const named = this.workspaceService
      .getWorkspaces()
      .find(
        (entry) => entry.id === job.workspaceId && entry.status !== "deleted"
      );
    return named != null &&
      named.kind !== "auto" &&
      named.kind !== "routine" &&
      named.kind !== "bot"
      ? { id: named.id, path: named.path }
      : null;
  }

  /** Where a routine keeps its records: inside its project, else its own folder. */
  private routineHome(job: CronJob): string {
    const project = this.routineProject(job);
    return project != null
      ? routineDirInWorkspace(project.path, job.id)
      : routineDir(job.id);
  }

  private async ensureHomeWorkspace(
    dir: string,
    kind?: "auto" | "routine" | "bot"
  ): Promise<string | null> {
    const existing = this.workspaceService
      .getWorkspaces()
      .find((entry) => entry.status !== "deleted" && entry.path === dir);
    if (existing != null && (kind == null || existing.kind === kind))
      return existing.id;

    try {
      await fs.promises.mkdir(dir, { recursive: true });
      const added = await this.workspaceService.addWorkspace(dir, false, kind);
      return added.workspaceId ?? null;
    } catch (error) {
      console.error("Failed to open the default workspace", error);
      return null;
    }
  }

  /**
   * Failures are swallowed: this rides along with sending a message, and a
   * locked store must not be the reason the message does not go.
   */
  private async rememberIfAsked(message: string): Promise<void> {
    const fact = detectRememberRequest(message);
    if (fact == null) return;

    try {
      await applyMemoryAction("remember", "add", { content: fact });
    } catch (error) {
      console.error("Failed to store what the user asked to remember", error);
    }
  }

  listMemories(): MemorySnapshot {
    return listMemories();
  }

  /**
   * Raised, not swallowed: a snapshot of an unchanged store looks exactly like
   * a successful delete, and the user would believe the entries were gone.
   */
  private failIfNotDone(result: MemoryResult): void {
    if (!result.ok) throw new ConflictError(result.message);
  }

  /** A running session keeps the snapshot in its prompt until it restarts. */
  async forgetMemory(
    request: ForgetMemoryRequest,
    occurrences?: number
  ): Promise<MemorySnapshot> {
    this.failIfNotDone(
      await forgetEntryAt(
        request.target,
        request.index,
        request.entry,
        occurrences
      )
    );
    return listMemories();
  }

  listBotMemories(): ReturnType<typeof listBotMemories> {
    return listBotMemories();
  }

  forgetBotMemory(
    request: {
      botId: string;
      index: number;
      entry: string;
    },
    occurrences?: number
  ): ReturnType<typeof listBotMemories> {
    forgetBotMemoryEntry(
      request.botId,
      request.index,
      request.entry,
      occurrences
    );
    return listBotMemories();
  }

  clearBotMemory(botId: string): ReturnType<typeof listBotMemories> {
    clearBotMemory(botId);
    return listBotMemories();
  }

  async forgetAllMemories(target: MemoryTargetId): Promise<MemorySnapshot> {
    this.failIfNotDone(await forgetAll(target));
    return listMemories();
  }

  /** The persisted transcript for a session, or `[]` when there is none yet. */
  readTranscript(sessionId: string): TranscriptSegment[] {
    return (this.transcriptService.read(sessionId)?.segments ??
      []) as TranscriptSegment[];
  }

  submitTurnFeedback(
    feedback: TurnFeedbackInput
  ): Promise<TurnFeedbackOutcome> {
    return this.feedbackService.submit(feedback);
  }

  async startAgentSession(
    request: StartAgentSessionRequest
  ): Promise<StartAgentSessionResult> {
    if (this.isWorkspaceDeleted(request.workspaceId)) {
      return {
        success: false,
        created: false,
        state: this.agentManagerService.getSessionState(
          request.workspaceId,
          request.sessionId
        ),
        error: "Workspace was deleted; its chats are read-only.",
      };
    }
    // The chat's remembered model beats the composer's: the renderer starts a
    // session before its list has loaded, and the agent would then report the
    // wrong model back over the record that should have chosen it. With
    // neither, the plan tier's default. Not the agent's own fallback, which
    // is the free pool whatever the tier.
    const remembered = this.agentSessionManagerService.get(
      request.sessionId
    )?.model;
    const model =
      remembered != null && remembered.length > 0
        ? remembered
        : request.model != null && request.model.length > 0
          ? request.model
          : await recommendedModelId();
    // A start with no mode is main's own (a bot's chat brought back to
    // deliver a notice, say): it runs in the mode the Profile page chose.
    const withModel = {
      ...request,
      ...(model != null ? { model } : {}),
      ...(request.mode == null ? { mode: readDefaultAgentMode() } : {}),
    };

    // The new agent sees the environment as it stands; nothing owed until then.
    environmentNoticeService.markSessionStarted(request.sessionId);

    return this.agentManagerService.startSessionReady(withModel);
  }

  stopAgentSession(
    request: AgentSessionCommandRequest
  ): StopAgentSessionResult {
    return this.agentManagerService.stopSession(
      request.workspaceId,
      request.sessionId
    );
  }

  getAgentSessionState(
    request: AgentSessionCommandRequest
  ): AgentSessionSnapshot {
    return this.agentManagerService.getSessionState(
      request.workspaceId,
      request.sessionId
    );
  }

  /** False only when undeliverable; the caller must then take its echo back. */
  async sendAgentMessage(request: SendAgentMessageRequest): Promise<boolean> {
    if (this.isWorkspaceDeleted(request.workspaceId)) {
      return false;
    }
    // "Remember I like blue" is caught here, the one place every message
    // passes through, rather than left to the model's whim. The message still
    // goes through untouched.
    void this.rememberIfAsked(request.message);

    // Synchronously, so a refetch sees the busy state immediately.
    this.sessionTurnStateService.markSent(
      request.workspaceId,
      request.sessionId
    );

    // A session whose CLI died is restarted rather than swallowing the message.
    const session = this.agentSessionManagerService.get(request.sessionId);
    const delivered = await this.withEnvironmentNotice(request);
    const outcome = await deliverMessage({
      send: () => this.agentCommunicationService.sendMessage(delivered),
      start: async () => {
        const result = await this.startAgentSession({
          workspaceId: request.workspaceId,
          sessionId: request.sessionId,
          // The session's own model and mode, not the defaults.
          ...(session?.model != null ? { model: session.model } : {}),
          ...(session?.mode != null ? { mode: session.mode } : {}),
        });
        return result.success;
      },
      isRunning: () =>
        this.agentManagerService.getSessionState(
          request.workspaceId,
          request.sessionId
        ).status === "running",
      delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    });

    if (outcome === "undeliverable") {
      this.sessionTurnStateService.markStopped(
        request.workspaceId,
        request.sessionId
      );
      return false;
    }
    if (delivered !== request)
      environmentNoticeService.markAnnounced(request.sessionId);
    return true;
  }

  /**
   * Adds the "your connectors changed" note when this conversation has not
   * been told yet. In the message, not the system prompt: rewriting the prompt
   * would discard the cache for the whole chat.
   */
  private async withEnvironmentNotice(
    request: SendAgentMessageRequest
  ): Promise<SendAgentMessageRequest> {
    if (!environmentNoticeService.isPending(request.sessionId)) return request;
    try {
      const message = messageWithEnvironmentNotice(
        environmentNoticeService,
        request.sessionId,
        request.message,
        await this.describeEnvironment(request.workspaceId)
      );
      return tagEnvironmentNotice(request, message);
    } catch (err) {
      // A note is a nicety; it must never cost the user their message.
      console.error(
        "[environment-notice] failed to describe the environment:",
        err
      );
      return request;
    }
  }

  /** What this workspace currently has connected, for the note above. */
  private async describeEnvironment(workspaceId: string): Promise<{
    connectors: string[];
    accountConnectors: string[];
    mcpServers: string[];
    skills: string[];
  }> {
    const workspace = this.workspaceService
      .getWorkspaces()
      .find((entry) => entry.id === workspaceId);
    const workspacePath =
      workspace?.isRemote === true ? null : (workspace?.path ?? null);
    const { skills } = await this.skillsService.listInstalled(
      workspacePath != null ? { workspacePath } : {}
    );
    return {
      // Probed now, not read off the last poll or the configured set: an
      // unlinked WhatsApp is still "enabled", and the conversation will act on
      // this note for its whole turn.
      connectors: reportableLivePlatforms(
        await this.messagingGatewayService.probeLivePlatforms()
      ).map(describePlatformForAgent),
      accountConnectors: await this.describeAccountConnectors(),
      // Disabled servers are left out: the note is what the model can reach.
      mcpServers: this.mcpConfigService
        .listUserServers("code")
        .filter((server) => server.config.disabled !== true)
        .map((server) => server.name),
      skills: skills.map((skill) => skill.name),
    };
  }

  /**
   * The connectors attached right now, other than the chat apps (those are
   * reported under messaging): the id to ask for and who it is attached as.
   * The platform listing is a network call; on failure it costs the note its
   * connector line, not the whole note.
   */
  private async describeAccountConnectors(): Promise<string[]> {
    try {
      const statuses = await this.listConnectorStatuses();
      return Object.entries(statuses)
        .filter(([, status]) => status.state === "connected")
        .flatMap(([id, status]) => {
          const connector = connectorById(id);
          if (connector == null || connector.kind === "messaging") return [];
          const account = status.account;
          return [
            `${connector.name} (${id})${
              account != null && account.length > 0 ? `, as ${account}` : ""
            }`,
          ];
        });
    } catch (err) {
      console.error("[environment-notice] failed to list connectors:", err);
      return [];
    }
  }

  setAgentMode(request: AgentSetModeRequest): void {
    this.agentCommunicationService.setMode(request);
  }

  /**
   * Fire-and-forget, as the legacy IPC has always been; it still joins the
   * session's switch queue so its answer is not taken for a checked one's
   * (`ModelSwitchWaiters`).
   */
  setAgentModel(request: AgentSetModelRequest): void {
    this.modelSwitches.post(request.sessionId, request.model, () =>
      this.agentCommunicationService.setModel(request)
    );
  }

  private readonly modelSwitches = new ModelSwitchWaiters();

  /**
   * `agent.setModel` (spec 04 §26.4 d): the same command, then the agent's
   * answer. Rejects with `ModelUnavailableError` when the agent refuses; no
   * running agent, or no answer in time, resolves.
   */
  setAgentModelChecked(request: AgentSetModelRequest): Promise<void> {
    return this.modelSwitches.wait(request.sessionId, request.model, () =>
      this.agentCommunicationService.setModel(request)
    );
  }

  stopAgentTurn(request: AgentSessionCommandRequest): void {
    this.markTurnStopped(request.workspaceId, request.sessionId);
    this.agentCommunicationService.stopTurn(request);
  }

  /** Main's side of a Stop, for `stopAgentTurn` and the relay's `ai.cancel`. */
  private markTurnStopped(workspaceId: string, sessionId: string): void {
    // Idle, and in-flight CLI events suppressed until the next send.
    this.sessionTurnStateService.markStopped(workspaceId, sessionId);
    // A Connect card is the turn, suspended inside its tool call: stopping
    // must take it down and let the call go. This conversation's only.
    const stopped = this.conversationKeyForSession(sessionId);
    if (stopped != null)
      this.connectorGate.release(
        stopped,
        "The user stopped this turn before answering. Do not ask again unless they bring it up."
      );
  }

  getSessionTurnState(
    workspaceId: string,
    sessionId: string
  ): SessionTurnStateSnapshot {
    return this.sessionTurnStateService.get(workspaceId, sessionId);
  }

  resetAgentConversation(request: AgentSessionCommandRequest): void {
    this.agentCommunicationService.resetConversation(request);
    // Transcript writes refuse an empty segment list, so without this the
    // pre-clear transcript would rehydrate on the next restart.
    this.transcriptService.remove(request.sessionId);
    this.aguiRelay.clearThread(request.sessionId);
  }

  switchAgentConversation(request: AgentSwitchConversationRequest): void {
    this.agentCommunicationService.switchConversation(request);
  }

  respondAgentPermission(request: AgentPermissionResponseRequest): void {
    this.agentCommunicationService.respondPermission(request);
  }

  listAgentSkills(request: AgentSessionCommandRequest): void {
    this.agentCommunicationService.listSkills(request);
  }

  enqueueAgentMessage(request: AgentQueueMessageRequest): void {
    this.agentCommunicationService.enqueue(request);
  }

  dequeueAgentMessage(request: AgentSessionCommandRequest): void {
    this.agentCommunicationService.dequeue(request);
  }

  getAgentQueue(request: AgentSessionCommandRequest): void {
    this.agentCommunicationService.getQueue(request);
  }

  clearAgentQueue(request: AgentSessionCommandRequest): void {
    this.agentCommunicationService.clearQueue(request);
  }

  removeAgentQueueMessage(request: AgentRemoveFromQueueRequest): void {
    this.agentCommunicationService.removeQueueItem(request);
  }

  updateAgentQueueMessage(request: AgentUpdateQueueMessageRequest): void {
    this.agentCommunicationService.updateQueueItem(request);
  }

  async getGitBranches(
    context?: WorkspaceGitContext
  ): Promise<GetGitBranchesResult> {
    const workspacePath = this.resolveWorkspaceContextPath(context);
    if (workspacePath == null) {
      return {
        success: false,
        branches: [],
        currentBranch: null,
        error: "No local workspace selected.",
      };
    }

    return this.gitService.listBranches(workspacePath);
  }

  hostUploadFolder(workspaceId: string, sessionId: string): string | null {
    const session = this.agentSessionManagerService.get(sessionId);
    if (!session || session.workspaceId !== workspaceId) return null;
    return this.resolveWorkspaceContextPath({ workspaceId, sessionId });
  }

  private localWorkspacePath(workspaceId: string): string | null {
    const workspace = this.workspaceService
      .getWorkspaces()
      .find((entry) => entry.id === workspaceId);
    return workspace?.isRemote === false && workspace.path != null
      ? workspace.path
      : null;
  }

  private resolveWorkspaceContextPath(
    context?: WorkspaceGitContext
  ): string | null {
    if (context == null) {
      const workspace = this.workspaceService.getActiveWorkspace();
      return workspace?.isRemote === false && workspace.path != null
        ? workspace.path
        : null;
    }
    return resolveSessionWorkspacePath(
      context,
      this.localWorkspacePath(context.workspaceId),
      (sessionId) => this.agentSessionManagerService.get(sessionId)
    );
  }

  async listWorktrees(workspaceId: string): Promise<ListWorktreesResult> {
    const workspacePath = this.localWorkspacePath(workspaceId);
    if (workspacePath == null) {
      return {
        success: false,
        worktrees: [],
        error: "Local workspace not found.",
      };
    }
    return this.gitService.listWorktrees(
      workspacePath,
      this.managedWorktreeRoot(workspaceId)
    );
  }

  async createWorktree(
    request: CreateWorktreeRequest
  ): Promise<CreateWorktreeResult> {
    const workspacePath = this.localWorkspacePath(request.workspaceId);
    if (workspacePath == null) {
      return { success: false, error: "Local workspace not found." };
    }
    return this.gitService.createWorktree(
      workspacePath,
      this.managedWorktreeRoot(request.workspaceId),
      request.baseRef,
      request.name
    );
  }

  async setSessionWorktree(
    request: SetSessionWorktreeRequest & {
      /** A materialize's id, recorded with the attach (spec 04 §26.4 g). */
      operationId?: string;
    }
  ): Promise<SetSessionWorktreeResult> {
    const session = this.agentSessionManagerService.get(request.sessionId);
    if (session == null || session.workspaceId !== request.workspaceId) {
      return { success: false, error: "Session not found in this workspace." };
    }
    const runtime = this.agentManagerService.getSessionState(
      request.workspaceId,
      request.sessionId
    );
    if (runtime.status === "running" || runtime.status === "starting") {
      return {
        success: false,
        error: "Stop the running session before switching worktrees.",
      };
    }

    if (request.worktreeId == null) {
      this.agentSessionManagerService.updateWorktree(
        request.workspaceId,
        request.sessionId,
        null
      );
      return {
        success: true,
        session: this.agentSessionManagerService.get(request.sessionId)!,
      };
    }

    const listed = await this.listWorktrees(request.workspaceId);
    const worktree = listed.worktrees.find(
      (entry) => entry.id === request.worktreeId
    );
    if (!listed.success || worktree == null) {
      return { success: false, error: listed.error ?? "Worktree not found." };
    }
    const attached = this.agentSessionManagerService.updateWorktree(
      request.workspaceId,
      request.sessionId,
      worktree.isCurrent
        ? null
        : {
            id: worktree.id,
            path: worktree.path,
            branch: worktree.branch,
          },
      request.operationId == null
        ? undefined
        : { operationId: request.operationId, worktree }
    );
    return attached
      ? {
          success: true,
          session: this.agentSessionManagerService.get(request.sessionId)!,
        }
      : { success: false, error: "Unable to attach worktree to session." };
  }

  /** Idempotent per `(sessionId, operationId)` when given one (§26.4 g). */
  materializeSessionWorktree(
    request: MaterializeSessionWorktreeRequest
  ): Promise<MaterializeSessionWorktreeResult> {
    return this.worktreeMaterializer.materialize(request);
  }

  private readonly worktreeMaterializer = new WorktreeMaterializer({
    session: (sessionId) => this.agentSessionManagerService.get(sessionId),
    recorded: (sessionId) =>
      this.agentSessionManagerService.worktreeOperation(sessionId),
    create: (request) => this.createWorktree(request),
    attach: (request) => this.setSessionWorktree(request),
    remove: async (workspaceId, worktreePath) => {
      const workspacePath = this.localWorkspacePath(workspaceId);
      if (workspacePath == null) return;
      await this.gitService.removeManagedWorktree(
        workspacePath,
        this.managedWorktreeRoot(workspaceId),
        worktreePath
      );
    },
  });

  async getGitCurrentBranch(
    context?: WorkspaceGitContext
  ): Promise<GetGitCurrentBranchResult> {
    const workspacePath = this.resolveWorkspaceContextPath(context);
    if (workspacePath == null) {
      return {
        success: false,
        currentBranch: null,
        error: "No local workspace selected.",
      };
    }

    return this.gitService.getCurrentBranch(workspacePath);
  }

  async getPrInfo(context?: WorkspaceGitContext): Promise<PrInfo | null> {
    const workspacePath = this.resolveWorkspaceContextPath(context);
    return workspacePath == null
      ? null
      : this.gitService.getPrInfo(workspacePath);
  }

  async switchGitBranch(
    branchName: string,
    context?: WorkspaceGitContext
  ): Promise<SwitchGitBranchResult> {
    const workspacePath = this.resolveWorkspaceContextPath(context);
    if (workspacePath == null) {
      return {
        success: false,
        currentBranch: null,
        error: "No local workspace selected.",
      };
    }

    const result = await this.gitService.switchBranch(
      workspacePath,
      branchName
    );
    if (!result.success) {
      return result;
    }

    await this.workspaceRuntimeService.refreshAndEmit();
    return result;
  }

  async createGitBranch(
    branchName: string,
    context?: WorkspaceGitContext
  ): Promise<CreateGitBranchResult> {
    const workspacePath = this.resolveWorkspaceContextPath(context);
    if (workspacePath == null) {
      return {
        success: false,
        currentBranch: null,
        error: "No local workspace selected.",
      };
    }

    const result = await this.gitService.createBranch(
      workspacePath,
      branchName
    );
    if (!result.success) {
      return result;
    }

    await this.workspaceRuntimeService.refreshAndEmit();
    return result;
  }

  listMcpServers(request: ListMcpServersRequest): McpServerInfo[] {
    return this.mcpAdminService.listMcpServers(request);
  }

  addMcpServer(request: AddMcpServerRequest): {
    success: boolean;
    error?: string;
  } {
    return this.mcpAdminService.addMcpServer(request);
  }

  ensureMcpServer(request: AddMcpServerRequest): {
    success: boolean;
    error?: string;
  } {
    return this.mcpAdminService.ensureMcpServer(request);
  }

  updateMcpServer(request: UpdateMcpServerRequest): {
    success: boolean;
    error?: string;
  } {
    return this.mcpAdminService.updateMcpServer(request);
  }

  removeMcpServer(request: RemoveMcpServerRequest): {
    success: boolean;
    error?: string;
  } {
    return this.mcpAdminService.removeMcpServer(request);
  }

  setMcpServerDisabled(request: SetMcpServerDisabledRequest): {
    success: boolean;
    error?: string;
  } {
    return this.mcpAdminService.setMcpServerDisabled(request);
  }

  async importMcpServers(
    request: ImportMcpServersRequest
  ): Promise<ImportMcpServersResult> {
    assertHostCapability(this.platform, "mcp.import", request);
    return this.mcpAdminService.importMcpServers(request);
  }

  refreshMcpServersForSession(
    request: RefreshMcpServersRequest
  ): Promise<McpRuntimeRequestResult> {
    return this.mcpAdminService.refreshMcpServersForSession(request);
  }

  notifyMcpSignedIn(mode: McpMode): Promise<void> {
    return this.mcpAdminService.notifyMcpSignedIn(mode);
  }

  restartMcpServerForSession(
    request: RestartMcpServerRequest
  ): McpRuntimeRequestResult {
    return this.mcpAdminService.restartMcpServerForSession(request);
  }

  /** Cached; does not block on I/O. */
  getMcpRuntimeServersForSession(
    request: GetMcpRuntimeServersRequest
  ): AgentMcpServer[] {
    return this.agentManagerService.getMcpServers(
      request.workspaceId,
      request.sessionId
    );
  }

  getMcpServerLogsForSession(
    request: GetMcpServerLogsRequest
  ): AgentMcpLogEntry[] {
    return this.agentManagerService.getMcpServerLogs(
      request.workspaceId,
      request.sessionId,
      request.serverId
    );
  }

  getDeviceStatus(): DeviceStatus {
    assertHostCapability(this.platform, "devices");
    const toolchain = this.deviceService.getToolchain();
    return {
      available: toolchain.ios || toolchain.android,
      ios: toolchain.ios,
      android: toolchain.android,
      maestro: this.deviceService.getMaestroPath() != null,
      iosNativeInput: this.deviceService.hasNativeIosInput(),
      enabled: !this.mcpConfigService.isBuiltinDevicesDisabled(),
      approval:
        this.mcpConfigService.readState().builtinDevicesApproval ?? "ask",
    };
  }

  async listLocalDevices(): Promise<LocalDeviceInfo[]> {
    assertHostCapability(this.platform, "devices");
    try {
      return await this.deviceService.listDevices();
    } catch (err) {
      console.error("[device] listDevices failed:", err);
      return [];
    }
  }

  async captureDeviceScreenshot(
    request: CaptureDeviceScreenshotRequest
  ): Promise<CaptureDeviceScreenshotResult> {
    assertHostCapability(this.platform, "devices");
    try {
      const buffer = await this.deviceService.screenshotBuffer(
        request.platform,
        request.deviceId
      );
      return { dataUrl: `data:image/png;base64,${buffer.toString("base64")}` };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }

  async bootLocalDevice(
    request: BootLocalDeviceRequest
  ): Promise<BootLocalDeviceResult> {
    assertHostCapability(this.platform, "devices");
    try {
      const device = await this.deviceService.boot(
        request.platform,
        request.deviceId,
        {
          focus: request.focus,
        }
      );
      return { success: true, device };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /** The user may have just installed Xcode or Android Studio. */
  refreshDeviceStatus(): DeviceStatus {
    assertHostCapability(this.platform, "devices");
    this.deviceService.refreshToolchain();
    const status = this.getDeviceStatus();
    this.emitEvent({
      type: "device-status-updated",
      status,
      emittedAt: new Date().toISOString(),
    });
    return status;
  }

  async createLocalDevice(
    request: CreateLocalDeviceRequest
  ): Promise<CreateLocalDeviceResult> {
    assertHostCapability(this.platform, "devices");
    try {
      const device = await this.deviceService.createDevice(request.platform);
      return { success: true, device };
    } catch (err) {
      // Written as setup instructions; passed through verbatim.
      const error = err instanceof Error ? err.message : String(err);
      console.warn(
        `[device] create ${request.platform} device failed: ${error}`
      );
      return { success: false, error };
    }
  }

  /**
   * The browser and device groups answer from their MCP servers' own enable
   * flags, not stored preferences: two sources of truth for one switch is how
   * a panel shows "on" for something that is off.
   */
  getToolsetStates(): Record<string, boolean> {
    const preferences = readToolsetPreferences();
    const states: Record<string, boolean> = {};

    for (const toolset of TOOLSETS) {
      states[toolset.id] = toolset.alwaysOn
        ? true
        : toolset.delivery === "mcp-browser"
          ? this.builtinMcpLifecycle.isBrowserEnabled()
          : toolset.delivery === "mcp-device"
            ? !this.mcpConfigService.isBuiltinDevicesDisabled()
            : isToolsetEnabled(toolset.id, preferences);
    }

    return states;
  }

  /**
   * Built-in groups take effect at the next spawn (pi is handed its tool list
   * at session creation); MCP-backed groups immediately.
   */
  async setToolsetEnabled(
    toolsetId: string,
    enabled: boolean
  ): Promise<Record<string, boolean>> {
    const toolset = TOOLSETS_BY_ID.get(toolsetId);

    // Planned groups have nothing behind them to turn on.
    if (toolset == null || toolset.status !== "ready")
      return this.getToolsetStates();

    // An always-on group has no switch to honor.
    if (toolset.alwaysOn) return this.getToolsetStates();

    setToolsetEnabled(toolsetId, enabled);

    if (toolset.delivery === "mcp-browser") {
      await this.setMcpBrowserEnabled(enabled);
    } else if (toolset.delivery === "mcp-device") {
      this.setDevicesEnabled(enabled);
    }

    return this.getToolsetStates();
  }

  setDevicesEnabled(enabled: boolean): DeviceStatus {
    assertHostCapability(this.platform, "devices");
    const state = this.mcpConfigService.readState();
    state.builtinDevicesDisabled = !enabled;
    this.mcpConfigService.writeState(state);
    if (!enabled) {
      // The builtin entry leaves the runtime MCP config at the next spawn.
      this.mcpDeviceServer.stop();
      this.builtinToolPermissions.flushPending("deny", "device");
    }
    const status = this.getDeviceStatus();
    this.emitEvent({
      type: "device-status-updated",
      status,
      emittedAt: new Date().toISOString(),
    });
    return status;
  }

  setDevicesApproval(approval: BrowserApproval): DeviceStatus {
    assertHostCapability(this.platform, "devices");
    const state = this.mcpConfigService.readState();
    state.builtinDevicesApproval = approval;
    this.mcpConfigService.writeState(state);
    if (approval === "always")
      this.builtinToolPermissions.flushPending("allow", "device");
    const status = this.getDeviceStatus();
    this.emitEvent({
      type: "device-status-updated",
      status,
      emittedAt: new Date().toISOString(),
    });
    return status;
  }

  getDeviceProjectInfo(): DeviceProjectInfo {
    assertHostCapability(this.platform, "devices");
    const workspace = this.workspaceService.getActiveWorkspace();
    if (workspace?.path == null || workspace.isRemote === true) {
      return { ios: false, android: false, framework: null };
    }
    try {
      return this.deviceService.detectProjectPlatforms(workspace.path);
    } catch {
      return { ios: false, android: false, framework: null };
    }
  }

  /** From the mirror panel: no permission prompt, the user is the approver. */
  async interactLocalDevice(
    request: InteractLocalDeviceRequest
  ): Promise<InteractLocalDeviceResult> {
    assertHostCapability(this.platform, "devices");
    try {
      const message = await this.deviceService.interact(request.platform, {
        action: request.action,
        x: request.x,
        y: request.y,
        text: request.text,
        key: request.key,
        direction: request.direction,
        amount: request.amount,
        deviceId: request.deviceId,
      });
      return { success: true, message };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  buildAndRunLocalDevice(
    request: BuildAndRunLocalDeviceRequest
  ): Promise<BuildAndRunLocalDeviceResult> {
    assertHostCapability(this.platform, "devices");
    return this.deviceMirrorService.buildAndRunLocalDevice(request);
  }

  startDeviceStream(
    request: StartDeviceStreamRequest,
    sender: Electron.WebContents,
    opts?: { keepStreamId?: number | null; isRestart?: boolean }
  ): Promise<StartDeviceStreamResult> {
    assertHostCapability(this.platform, "devices");
    return this.deviceMirrorService.startDeviceStream(request, sender, opts);
  }

  stopDeviceStream(streamId?: number): void {
    assertHostCapability(this.platform, "devices");
    this.deviceMirrorService.stopDeviceStream(streamId);
  }

  getSimulatorWindowSource(
    request: GetSimulatorWindowSourceRequest
  ): Promise<GetSimulatorWindowSourceResult> {
    return getSimulatorWindowSource(request);
  }

  openScreenRecordingSettings(): Promise<void> {
    assertHostCapability(this.platform, "system.openPrivacyPane");
    return openScreenRecordingSettings();
  }

  openAccessibilitySettings(): Promise<void> {
    assertHostCapability(this.platform, "system.openPrivacyPane");
    return openAccessibilitySettings();
  }

  streamDeviceTouch(request: StreamDeviceTouchRequest): void {
    assertHostCapability(this.platform, "devices");
    this.deviceMirrorService.streamDeviceTouch(request);
  }

  streamDeviceKey(request: StreamDeviceKeyRequest): void {
    assertHostCapability(this.platform, "devices");
    this.deviceMirrorService.streamDeviceKey(request);
  }

  async installMaestro(): Promise<InstallMaestroResult> {
    assertHostCapability(this.platform, "devices");
    const result = await this.deviceService.installMaestro();
    const status = this.getDeviceStatus();
    this.emitEvent({
      type: "device-status-updated",
      status,
      emittedAt: new Date().toISOString(),
    });
    return { ...result, status };
  }

  getMcpBrowserStatus(): McpBrowserStatus {
    return this.builtinMcpLifecycle.getBrowserStatus();
  }

  setMcpBrowserEnabled(enabled: boolean): Promise<McpBrowserStatus> {
    return this.builtinMcpLifecycle.setBrowserEnabled(enabled);
  }

  setBrowserApproval(approval: BrowserApproval): Promise<McpBrowserStatus> {
    return this.builtinMcpLifecycle.setBrowserApproval(approval);
  }

  setBrowserEngine(engine: BrowserEngine): Promise<McpBrowserStatus> {
    return this.builtinMcpLifecycle.setBrowserEngine(engine);
  }

  connectChromeBrowser(): Promise<McpBrowserStatus> {
    return this.builtinMcpLifecycle.connectChrome();
  }

  disconnectChromeBrowser(): Promise<McpBrowserStatus> {
    return this.builtinMcpLifecycle.disconnectChrome();
  }

  setChromeExtensionToken(token: string): Promise<McpBrowserStatus> {
    return this.builtinMcpLifecycle.setChromeExtensionToken(token);
  }

  async clearBrowserData(
    _request?: ClearBrowserDataRequest
  ): Promise<ClearBrowserDataResult> {
    assertHostCapability(this.platform, "browser.clearData");
    try {
      const { session } = await import("electron");
      // Profile-import partitions belong to the browser-profiles flow.
      await session.fromPartition("persist:agent-browser").clearStorageData();
      return { success: true };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  respondBrowserPermission(
    request: RespondBrowserPermissionRequest
  ): Promise<void> {
    return this.builtinToolPermissions.respond(request);
  }

  private requestBrowserToolPermission(
    tool: string,
    summary: string,
    sessionId?: string
  ): Promise<"allow" | "deny"> {
    if (!this.builtinMcpLifecycle.isBrowserEnabled())
      return Promise.resolve("deny");
    return this.builtinToolPermissions.request(
      "browser",
      tool,
      summary,
      sessionId
    );
  }

  /** One conversation's pending asks, or every conversation's with no key. */
  listConnectorRequests(conversationKey?: ConversationKey): ConnectorRequest[] {
    return this.connectorGate.listPending(conversationKey);
  }

  /** One conversation's pending asks, or every conversation's with no key. */
  listBrowserPermissionRequests(
    conversationKey?: ConversationKey
  ): BrowserPermissionRequest[] {
    return this.builtinToolPermissions.listPending(conversationKey);
  }

  async respondConnector(request: RespondConnectorRequest): Promise<void> {
    await this.connectorGate.respond(request);
  }

  startCronScheduler(): void {
    this.cronScheduler.everyMinute(() => this.reapStuckRoutineRuns());
    this.cronScheduler.start();
    void this.webhookService.start().catch((err: unknown) => {
      console.error("[webhooks] failed to start listener:", err);
    });
    // The relay gives the same hooks a public URL.
    this.webhookRelay.start();
  }

  stopCronScheduler(): void {
    this.cronScheduler.stop();
    this.webhookService.stop();
    this.webhookRelay.stop();
  }

  /** What each running routine session has said so far, for its run file. */
  private readonly routineRunText = new Map<string, string[]>();

  /** Starts that deletion must let finish before collecting run sessions. */
  private readonly routineRunStarts = new Map<
    string,
    Set<Promise<RoutineRunStart>>
  >();

  /**
   * A run's end off its event stream: an error fails it, idle completes it.
   * The agent reports a failed turn after its idle, so a run filed as
   * completed can still fail; it is filed again when it does.
   */
  private settleRoutineRun(sessionId: string, payload: DesktopEvent): void {
    if (payload.type !== "event") return;
    if (!this.agentSessionManagerService.isRoutineSession(sessionId)) return;
    const event = payload.event;
    if (event.type === "text_delta") {
      const text = this.routineRunText.get(sessionId) ?? [];
      text.push(event.content);
      this.routineRunText.set(sessionId, text);
      return;
    }
    const outcome =
      event.type === "error"
        ? "failed"
        : event.type === "status_changed" && event.status === AgentStatus.Idle
          ? "completed"
          : null;
    if (outcome == null) return;
    // An error's trailing idle must not overwrite the failure.
    if (!this.agentSessionManagerService.setRunOutcome(sessionId, outcome))
      return;
    const session = this.agentSessionManagerService.get(sessionId);
    const text = this.routineRunText.get(sessionId);
    if (session?.routineId == null || text == null) return;
    const finishedJob = getJob(session.routineId);
    if (finishedJob == null) return;
    recordRoutineRun(this.routineHome(finishedJob), {
      sessionId,
      startedAt: session.createdAt,
      endedAt: new Date().toISOString(),
      outcome,
      reply: text.join("").trim(),
    });
    if (event.type !== "error") return;
    // No credits fails every fire the same way until the user tops up.
    if (ranOutOfAbacusCredits(event.error))
      this.pauseRoutine(session.routineId, "paused: out of Abacus.AI credits");
    else this.pauseIfFailingRepeatedly(session.routineId);
  }

  /** A routine that keeps failing pauses itself rather than failing forever. */
  private pauseIfFailingRepeatedly(routineId: string): void {
    // Failures before the user last resumed it are the old streak.
    const resumedAt = getJob(routineId)?.resumedAt ?? 0;
    const runs = this.listRoutineRuns(routineId).filter(
      (run) => new Date(run.startedAt).getTime() > resumedAt
    );
    if (!shouldPauseAfter(runs)) return;
    this.pauseRoutine(
      routineId,
      `paused after ${ROUTINE_FAILURES_BEFORE_PAUSE} failed runs in a row`
    );
  }

  private pauseRoutine(routineId: string, reason: string): void {
    const job = getJob(routineId);
    if (job == null || !job.enabled) return;
    updateJob(routineId, { enabled: false });
    // Administrative history (spec 05 §31.5 f): no session, no attempt.
    recordRun(routineId, reason, "schedule", { kind: "paused" });
    this.emitEvent({
      type: "cronjobs-updated",
      emittedAt: new Date().toISOString(),
    });
  }

  /** A run still "running" after half an hour hung and blocks later fires. */
  reapStuckRoutineRuns(now: number = Date.now()): void {
    for (const job of listJobs()) {
      for (const run of stuckRuns(this.listRoutineRuns(job.id), now)) {
        this.stopAgentTurn({
          workspaceId: run.workspaceId,
          sessionId: run.sessionId,
        });
        this.agentSessionManagerService.setRunOutcome(run.sessionId, "failed");
        const text = this.routineRunText.get(run.sessionId) ?? [];
        this.routineRunText.delete(run.sessionId);
        recordRoutineRun(this.routineHome(job), {
          sessionId: run.sessionId,
          startedAt: run.startedAt,
          endedAt: new Date(now).toISOString(),
          outcome: "failed",
          reply: text.join("").trim(),
        });
        // A follow-up of the attempt that started this session.
        recordRun(job.id, ROUTINE_RESULTS.timedOut, "schedule", {
          kind: "timed-out",
          sessionId: run.sessionId,
          attemptId: attemptOfSession(job.id, run.sessionId)?.id ?? null,
        });
        this.pauseIfFailingRepeatedly(job.id);
      }
    }
  }

  /**
   * Read at fire time: an edited persona applies, a deleted bot drops out,
   * and what the bot has been told to remember comes along. A run is the
   * bot's work; without its memory it drafted for the very people the user
   * had told it to leave alone.
   */
  private withBotVoice(botId: string | null, prompt: string): string {
    const bot = botId == null ? null : getBot(botId);
    if (bot == null) return prompt;
    const memory = readBotMemoryText(bot.id);
    const voice = [
      `You are ${bot.name}, running a routine you set up for the user.`,
      bot.persona.length > 0 ? `Your voice, every message: ${bot.persona}` : "",
      memory.length > 0
        ? `What you remember about the user and this work:\n${memory}`
        : "",
    ]
      .filter((line) => line.length > 0)
      .join("\n");
    return `${voice}\n\n${prompt}`;
  }

  /** Callers (the routine editor) waiting for a turn's text as a value. */
  private readonly turnWaiters = new Map<
    string,
    {
      text: string[];
      resolve: (text: string) => void;
      reject: (e: Error) => void;
    }
  >();

  private feedTurnWaiter(sessionId: string, payload: DesktopEvent): void {
    const waiter = this.turnWaiters.get(sessionId);
    if (waiter == null || payload.type !== "event") return;
    const event = payload.event;
    if (event.type === "text_delta") {
      waiter.text.push(event.content);
    } else if (event.type === "error") {
      this.turnWaiters.delete(sessionId);
      waiter.reject(new Error(event.error?.message ?? "The turn failed."));
    } else if (
      event.type === "status_changed" &&
      event.status === AgentStatus.Idle
    ) {
      this.turnWaiters.delete(sessionId);
      waiter.resolve(waiter.text.join("").trim());
    }
  }

  private waitForTurn(sessionId: string, timeoutMs: number): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.turnWaiters.delete(sessionId);
        reject(
          new TimeoutError("The routine did not answer in time.", timeoutMs)
        );
      }, timeoutMs);
      this.turnWaiters.set(sessionId, {
        text: [],
        resolve: (text) => {
          clearTimeout(timer);
          resolve(text);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
    });
  }

  /**
   * "Every morning at 9 instead": a short turn in a session holding only the
   * cron tool applies the change and answers in a line.
   */
  async editRoutineByChat(routineId: string, text: string): Promise<string> {
    const job = getJob(routineId);
    if (job == null)
      throw new EntityNotFoundError(
        "routine",
        routineId,
        "This routine is gone."
      );
    const workspaces = this.workspaceService.getWorkspaces();
    const workspaceId =
      job.workspaceId != null &&
      workspaces.some(
        (entry) => entry.id === job.workspaceId && entry.status !== "deleted"
      )
        ? job.workspaceId
        : (this.workspaceService.getActiveWorkspace()?.id ?? null);
    if (workspaceId == null) throw new Error("No workspace to run in.");

    const editor = this.agentSessionManagerService.editorFor(
      routineId,
      workspaceId
    );
    // Unattended: it must not stall on an approval the composer cannot show.
    const started = await this.startAgentSession({
      workspaceId,
      sessionId: editor.id,
      mode: readDefaultAgentMode(),
    });
    if (!started.success)
      throw new Error(started.error ?? "The editor could not start.");

    const schedule =
      job.schedule ??
      (job.runAt != null
        ? `once at ${new Date(job.runAt).toLocaleString()}`
        : "manual");
    const prompt = [
      `You are the editor for the routine "${job.name}" (id ${job.id}).`,
      "The user is telling you how it should change. Apply the change with",
      `the cronjob tool on exactly this routine (id ${job.id}): action`,
      '"update" for the schedule (five-field cron, local time), prompt or',
      'name; "pause" or "resume"; "run" to fire it now. Do not touch any',
      "other routine and do not do the routine's own task yourself.",
      "Then answer in one short line saying what is now the case, in the",
      "user's words, no preamble. If the request is not about this routine,",
      "say so in one line and change nothing.",
      "",
      `Current schedule: ${schedule}`,
      `Enabled: ${job.enabled ? "yes" : "no"}`,
      `Instructions: ${job.prompt}`,
      "",
      `The user says: ${text}`,
    ].join("\n");

    const answer = this.waitForTurn(editor.id, 90_000);
    const delivered = await this.sendAgentMessage({
      workspaceId,
      sessionId: editor.id,
      message: prompt,
      userText: {
        operator: {
          kind: "routine-editor",
          visibleFrom: prompt.length - text.length,
        },
      },
    });
    if (!delivered) {
      this.turnWaiters.delete(editor.id);
      throw new Error("The editor did not take the message.");
    }
    const reply = await answer;
    this.emitEvent({
      type: "cronjobs-updated",
      emittedAt: new Date().toISOString(),
    });
    return reply;
  }

  /** Every fire of a routine that got a session, newest first. */
  listRoutineRuns(routineId: string): RoutineRunItem[] {
    return this.agentSessionManagerService
      .listByRoutine(routineId)
      .map((session) => ({
        sessionId: session.id,
        workspaceId: session.workspaceId,
        startedAt: session.createdAt,
        updatedAt: session.updatedAt,
        outcome: session.runOutcome ?? "completed",
        trigger: session.runTrigger,
      }));
  }

  /** History only: run-row joins must not compute cron schedules. */
  listRoutineHistories(): Array<Pick<Routine, "id" | "runs">> {
    return listJobs().map(({ id, runs }) => ({ id, runs }));
  }

  /** The routine list, enriched with what the UI shows per row. */
  listRoutines(): RoutineListItem[] {
    const port = this.webhookService.port();

    return listJobs().map((job) => ({
      ...job,
      nextRunAt: (() => {
        if (!job.enabled) return null;
        if (job.runAt != null) return job.runAt;
        if (job.schedule == null) return null;
        try {
          return nextRun(job.schedule)?.getTime() ?? null;
        } catch {
          return null;
        }
      })(),
      // The public relay URL once registered, loopback as fallback.
      webhookUrl:
        this.webhookRelay.publicUrlFor(job.webhookToken) ??
        (job.webhookToken != null && port != null
          ? `http://127.0.0.1:${port}/hooks/${job.webhookToken}`
          : null),
      webhookPublicPending:
        job.webhookToken != null &&
        job.enabled &&
        this.webhookRelay.publicUrlFor(job.webhookToken) == null &&
        this.webhookRelay.canRegister(),
      botName:
        job.botId != null
          ? (this.botService.list().find((bot) => bot.id === job.botId)?.name ??
            null)
          : null,
    }));
  }

  createRoutine(input: RoutineCreateInput, id?: string): Routine {
    const job = createJob(input, id);
    this.emitEvent({
      type: "cronjobs-updated",
      emittedAt: new Date().toISOString(),
    });
    // The public URL should exist moments after Create, not on the next tick.
    if (job.webhookToken != null) this.webhookRelay.refreshNow();
    return job;
  }

  updateRoutine(id: string, changes: RoutineUpdateInput): Routine {
    const job = updateJob(id, changes);
    this.emitEvent({
      type: "cronjobs-updated",
      emittedAt: new Date().toISOString(),
    });
    if (job.webhookToken != null) this.webhookRelay.refreshNow();
    return job;
  }

  async removeRoutine(id: string): Promise<void> {
    const job = getJob(id);
    removeJob(id);
    try {
      await Promise.allSettled(this.routineRunStarts.get(id) ?? []);
      const runs = this.agentSessionManagerService.listByRoutine(id);
      // A run without a project uses the routine folder as its cwd. Windows
      // refuses to remove it until the agent process has closed.
      await Promise.all(
        runs.map((run) =>
          this.agentManagerService.stopSessionAndWait(run.workspaceId, run.id)
        )
      );
      for (const run of runs) {
        this.routineRunText.delete(run.id);
        this.removeAgentSession(run.workspaceId, run.id);
      }

      // Both homes: the records moved if the routine was given a project later.
      await removeRoutineDir(routineDir(id));
      if (job != null) {
        const home = this.routineHome(job);
        if (home !== routineDir(id)) await removeRoutineDir(home);
      }
    } finally {
      // The job was removed even if file cleanup failed; refresh the list.
      this.emitEvent({
        type: "cronjobs-updated",
        emittedAt: new Date().toISOString(),
      });
    }
  }

  /**
   * Fire a routine. Every fire is a fresh session with the routine's prompt,
   * stamped with the routine so it lists as one of its runs. A bot's routine
   * runs the same way with the bot's voice folded into the prompt.
   */
  async runRoutine(
    jobId: string,
    trigger: CronTrigger,
    payload: string | null = null
  ): Promise<RoutineRunStart> {
    const start = this.startRoutineRun(jobId, trigger, payload);
    const pending =
      this.routineRunStarts.get(jobId) ?? new Set<Promise<RoutineRunStart>>();
    pending.add(start);
    this.routineRunStarts.set(jobId, pending);
    try {
      return await start;
    } finally {
      pending.delete(start);
      if (pending.size === 0) this.routineRunStarts.delete(jobId);
    }
  }

  private async startRoutineRun(
    jobId: string,
    trigger: CronTrigger,
    payload: string | null
  ): Promise<RoutineRunStart> {
    const job = getJob(jobId);
    if (job == null) return "skipped";
    // Signed out, with no other key: every run would fail and pause the
    // routine, three at a time, in silence.
    if (
      !Object.values(readSettings().apiKeys ?? {}).some(
        (key) => (key ?? "").trim().length > 0
      )
    ) {
      recordRun(jobId, "skipped: signed out", trigger);
      this.emitEvent({
        type: "cronjobs-updated",
        emittedAt: new Date().toISOString(),
      });
      return "skipped";
    }

    // One run at a time, or a five-minute routine whose runs take eight stacks.
    if (hasRunInFlight(this.listRoutineRuns(jobId))) {
      recordRun(jobId, ROUTINE_RESULTS.skipped, trigger, { kind: "skipped" });
      this.emitEvent({
        type: "cronjobs-updated",
        emittedAt: new Date().toISOString(),
      });
      return "skipped";
    }

    const workspaces = this.workspaceService.getWorkspaces();
    // A routine made against a real project runs there, records included;
    // every other runs in its own folder.
    const project = this.routineProject(job);
    const target = project?.id ?? (await this.ensureRoutineWorkspace(job.id));
    // A deletion may have happened while the routine workspace was opening.
    if (getJob(jobId) == null) return "skipped";
    const home = this.routineHome(job);

    const prompt = this.withBotVoice(
      job.botId,
      buildRoutineFirePrompt(job, trigger, payload, {
        dir: home,
        // The project when there is one; the run's cwd is that folder and its
        // records sit inside it. Otherwise the routine's own folder is both.
        workingDirectory: project?.path ?? routineDir(job.id),
        runs: countRoutineRuns(home),
        lastRun: readLastRoutineRun(home),
        workspaces: workspaces
          .filter(
            (entry) => entry.status !== "deleted" && entry.kind !== "routine"
          )
          .map((entry) => entry.path),
      })
    );

    if (target == null) {
      recordRun(jobId, ROUTINE_RESULTS.noWorkspace, trigger, {
        kind: "no-workspace",
      });
      this.emitEvent({
        type: "cronjobs-updated",
        emittedAt: new Date().toISOString(),
      });
      return "failed";
    }

    // Stamped so it lists as a run and the renderer shows it read-only.
    const session = this.agentSessionManagerService.create(
      target,
      job.id,
      null,
      trigger
    );
    this.emitEvent({
      type: "local-cli-session-created",
      workspaceId: target,
      sessionId: session.id,
      session,
      emittedAt: new Date().toISOString(),
    });
    this.updateAgentSessionLabel(target, session.id, `Routine: ${job.name}`);

    // Nobody is at the keyboard: a tool waiting for approval would wait
    // until the reaper fails the run.
    const started = await this.startAgentSession({
      workspaceId: target,
      sessionId: session.id,
      mode: readDefaultAgentMode(),
    });

    // Deletion stops the session while startup is in flight.
    if (getJob(jobId) == null) return "skipped";

    if (!started.success) {
      this.agentSessionManagerService.setRunOutcome(session.id, "failed");
      recordRun(
        jobId,
        `${ROUTINE_RESULTS.startFailedPrefix}${started.error ?? "unknown"}`,
        trigger,
        { kind: "start-failed", sessionId: session.id }
      );
      this.emitEvent({
        type: "cronjobs-updated",
        emittedAt: new Date().toISOString(),
      });
      this.pauseIfFailingRepeatedly(jobId);
      return "failed";
    }

    // Earlier runs' text is kept until now, for a failure that lands late.
    for (const run of this.listRoutineRuns(jobId))
      this.routineRunText.delete(run.sessionId);
    // Seeded now so a run that never says a word still gets its file.
    this.routineRunText.set(session.id, []);
    this.sendAgentMessage({
      workspaceId: target,
      sessionId: session.id,
      message: prompt,
      userText: { routineFire: true },
    });
    recordRun(jobId, startedResult(session.id), trigger, {
      kind: "started",
      sessionId: session.id,
    });
    this.emitEvent({
      type: "cronjobs-updated",
      emittedAt: new Date().toISOString(),
    });

    return "started";
  }

  approveBuiltinForSession(server: BuiltinPermissionScope): void {
    this.builtinToolPermissions.approveForSession(server);
  }

  getRuntimeMcpPathForSpawn(
    mode: McpMode,
    sessionId?: string
  ): Promise<string> {
    return this.builtinMcpLifecycle.getRuntimeMcpPathForSpawn(mode, sessionId);
  }

  getRuntimeAgentConfigPathForSpawn(mode: McpMode): string | null {
    return this.builtinMcpLifecycle.getRuntimeAgentConfigPathForSpawn(mode);
  }

  getMetadata(_request?: WorkspaceMetadataRequest): WorkspaceMetadataSnapshot {
    return {
      workspaces: this.workspaceService.getWorkspaces(),
      activeWorkspaceId: this.workspaceService.getActiveWorkspaceId(),
      materialIconsBasePath: null,
      lastUpdatedAt: new Date().toISOString(),
    };
  }

  getGitState(): GitStateSnapshot {
    return this.workspaceRuntimeService.getGitState();
  }

  /** The local path `getGitState` was computed for (the gitState table). */
  gitStateWorkspacePath(): string | null {
    return this.workspaceRuntimeService.getSnapshot().workspacePath;
  }

  getFileTreeRoot(): FileTreeRootSnapshot {
    return this.workspaceRuntimeService.getFileTreeRoot();
  }

  private emitEvent(event: IpcEvent): void {
    this.eventDispatcher?.(event);
  }

  async buildAdditionalConfigEnv(
    mode: McpMode,
    sessionId?: string
  ): Promise<Record<string, string>> {
    let runtimeMcpPath: string | null = null;
    try {
      // Writing the runtime MCP file also starts the built-in servers, which
      // must be listening before the agent connects.
      runtimeMcpPath = await this.getRuntimeMcpPathForSpawn(mode, sessionId);
    } catch (err) {
      console.error("[mcp] failed to write runtime mcp config:", err);
    }
    return {
      ...buildAgentConfigEnv(runtimeMcpPath),
      // A bot's chat carries the bot's identity; this process owns the registry.
      ...(sessionId != null
        ? this.botService.personaEnvForSession(sessionId)
        : {}),
      // Routine chats compact early; see ROUTINE_CONTEXT_CAP_TOKENS.
      ...(sessionId != null &&
      this.agentSessionManagerService.isRoutineSession(sessionId)
        ? {
            ABACUSAI_BOT_CONTEXT_CAP_TOKENS: String(ROUTINE_CONTEXT_CAP_TOKENS),
          }
        : {}),
      ...(sessionId != null ? this.laneEnv.get(sessionId) : undefined),
      // A run may use its own folder without the containment gate asking.
      ...this.routineFolderEnvForSession(sessionId),
      ...this.sponsoredRunEnvForRoutineSession(sessionId),
    };
  }

  /** A routine run is its bot's work: while the bot's runs are sponsored, so is the run. */
  private sponsoredRunEnvForRoutineSession(
    sessionId: string | undefined
  ): Record<string, string> {
    if (sessionId == null) return {};
    const routineId =
      this.agentSessionManagerService.get(sessionId)?.routineId ?? null;
    const botId = routineId != null ? (getJob(routineId)?.botId ?? null) : null;
    return botId == null ? {} : this.botService.sponsoredRunEnvForBot(botId);
  }

  /**
   * What a run may reach outside its working directory: its own folder and
   * every workspace. A run already has full permissions; this stops the model
   * believing it is fenced in and declining to write its notes.
   */
  private routineFolderEnvForSession(
    sessionId: string | undefined
  ): Record<string, string> {
    if (sessionId == null) return {};
    const routineId =
      this.agentSessionManagerService.get(sessionId)?.routineId ?? null;
    if (routineId == null) return {};

    const job = getJob(routineId);
    const paths = [
      job != null ? this.routineHome(job) : routineDir(routineId),
      ...this.workspaceService
        .getWorkspaces()
        .filter((entry) => entry.status !== "deleted")
        .map((entry) => entry.path),
    ];

    return {
      ABACUSAI_BOT_ALLOWED_PATHS: [...new Set(paths)].join(path.delimiter),
    };
  }

  /** Agent env for the sessions host lanes keep, by session id. */
  private readonly laneEnv = new Map<string, Record<string, string>>();
  private readonly agentEventListeners = new Set<
    (sessionId: string, payload: DesktopEvent) => void
  >();

  /**
   * The session a host lane (the hosted phone loop) keeps for good, in the
   * bot workspace, spawned with `env` on top of the usual.
   */
  async openLaneSession(
    lane: string,
    env: Record<string, string>,
    mode: AgentMode
  ): Promise<{ workspaceId: string; sessionId: string }> {
    const workspaceId = await this.ensureDefaultWorkspace();
    if (workspaceId == null) throw new Error("No workspace for the lane.");
    const session = this.agentSessionManagerService.laneSession(
      lane,
      workspaceId,
      mode
    );
    this.laneEnv.set(session.id, env);
    return { workspaceId: session.workspaceId, sessionId: session.id };
  }

  /** Every session's agent events, past the post-Stop filter. */
  onAgentEvent(
    listener: (sessionId: string, payload: DesktopEvent) => void
  ): () => void {
    this.agentEventListeners.add(listener);
    return () => {
      this.agentEventListeners.delete(listener);
    };
  }

  /** Backend roster with live readiness, for the Terminal & Processes pane. */
  getExecBackendState(): {
    selected: BackendId;
    effective: BackendId;
    statuses: BackendStatus[];
  } {
    const stored = readExecBackend() ?? "local";

    return {
      selected: stored,
      // Differs from selected when the chosen backend stopped being usable.
      effective: resolveBackend(stored),
      statuses: backendStatuses(),
    };
  }

  /** The shell roster for the settings pane and the terminal panel's `+` menu. */
  getTerminalShellState(): TerminalShellState {
    const selected = readTerminalShell();

    return {
      selected,
      effective: effectiveTerminalShell(selected),
      statuses: terminalShellStatuses(),
    };
  }

  /**
   * Store a pick. Called by the settings row and by the `+` menu alike: the
   * shell someone opened last is the one an automatically opened terminal
   * should come back with.
   */
  setTerminalShell(shell: TerminalShellId): TerminalShellState {
    const previous = readTerminalShell();
    setTerminalShell(shell);
    const state = this.getTerminalShellState();
    if (state.selected !== previous) {
      this.emitEvent({
        type: "exec-backend",
        backend: readExecBackend() ?? "local",
        emittedAt: new Date().toISOString(),
      });
    }
    return state;
  }

  getNotificationSettings(): NotificationSettings {
    return readNotificationSettings();
  }

  setNotificationSettings(next: NotificationSettings): NotificationSettings {
    return setNotificationSettings(next);
  }

  getDefaultAgentMode(): DefaultAgentMode {
    return readDefaultAgentMode();
  }

  /** Whether Auto is worth offering here: probed once, by the agent. */
  getSandboxSupport(): Promise<SandboxSupport> {
    return this.sandboxProbeService.support();
  }

  /** Read back, not echoed: a failed write must not show as the new mode. */
  setDefaultAgentMode(mode: DefaultAgentMode): DefaultAgentMode {
    setDefaultAgentMode(mode);

    return readDefaultAgentMode();
  }

  setExecBackend(backend: BackendId): {
    selected: BackendId;
    effective: BackendId;
    statuses: BackendStatus[];
  } {
    // The user may have just installed Docker in order to pick it.
    clearBackendProbeCache();
    const previous = readExecBackend() ?? "local";
    setExecBackend(backend);
    const state = this.getExecBackendState();
    if (state.selected !== previous) {
      this.emitEvent({
        type: "exec-backend",
        backend: state.selected,
        emittedAt: new Date().toISOString(),
      });
    }
    return state;
  }

  listBrowserProfiles(): ReturnType<BrowserProfilesService["listProfiles"]> {
    assertHostCapability(this.platform, "browser.profiles");
    return this.browserProfilesService.listProfiles();
  }

  refreshBrowserProfiles(): ReturnType<
    BrowserProfilesService["refreshProfiles"]
  > {
    assertHostCapability(this.platform, "browser.profiles");
    return this.browserProfilesService.refreshProfiles();
  }

  importBrowserProfile(
    profileId: string
  ): ReturnType<BrowserProfilesService["importProfile"]> {
    assertHostCapability(this.platform, "browser.profiles");
    return this.browserProfilesService.importProfile(profileId);
  }

  clearImportedBrowserProfile(
    profileId: string
  ): ReturnType<BrowserProfilesService["clearImportedProfile"]> {
    assertHostCapability(this.platform, "browser.profiles");
    return this.browserProfilesService.clearImportedProfile(profileId);
  }
}
