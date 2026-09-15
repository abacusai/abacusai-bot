import fs from "node:fs";
import os from "node:os";
/**
 * Composition root for the desktop services: constructs them, wires their
 * callbacks and routes handler requests. Substantive behavior lives in
 * `services/`.
 */
import path from "path";

import {
  MINIMUM_WINDOWS_BUILD,
  sandboxBackendFor,
} from "@abacus-ai/agent/sandbox-support";
import { app } from "electron";

import { AgentMode, AgentStatus, type DesktopEvent } from "#shared/agent-types";
import type {
  BotChangeNotice,
  Bot,
  BotChatHandle,
  BotCreateInput,
  BotUpdateInput,
} from "#shared/bots";
import type {
  TranscriptSegment,
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
  McpBrowserStatus,
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
} from "#shared/contracts";
import type {
  BotChatPreview,
  BotSenderChat,
  NotificationSettings,
} from "#shared/contracts";
import type {
  ConnectorRequest,
  SessionOwner,
  RespondConnectorRequest,
} from "#shared/contracts";
import {
  sessionConversationKey,
  type ConversationKey,
} from "#shared/conversation-scope";
import type { BackendId, BackendStatus } from "#shared/exec-backends";
import {
  describePlatformForAgent,
  reportableLivePlatforms,
  SHARED_BOT_ACCOUNT_SERVICES,
  type MessagingPairingDecisionRequest,
  type MessagingPlatformId,
  type MessagingSnapshot,
  type UpdateMessagingPlatformRequest,
  type UpdateMessagingSettingsRequest,
} from "#shared/messaging";
import { detectRememberRequest } from "#shared/remember";
import type {
  Routine,
  RoutineCreateInput,
  RoutineListItem,
  RoutineUpdateInput,
} from "#shared/routines";
import { isToolsetEnabled, TOOLSETS, TOOLSETS_BY_ID } from "#shared/toolsets";

import {
  abacusBotHome,
  botDefaultWorkspace,
  sessionDefaultWorkspace,
} from "./paths";
import { ConnectorGate } from "./services/agent-tools/connector-gate";
import { CronScheduler } from "./services/agent-tools/cron-scheduler";
import {
  createJob,
  getJob,
  listJobs,
  nextRun,
  recordRun,
  removeJob,
  updateJob,
  type CronTrigger,
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
  hasRunInFlight,
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
} from "./services/agent-tools/routine-runs-store";
import { stopAllServed } from "./services/agent-tools/static-server";
import { WebhookRelay } from "./services/agent-tools/webhook-relay";
import { WebhookService } from "./services/agent-tools/webhook-service";
import { botChatPreview } from "./services/bots/bot-chat-preview";
import {
  clearBotMemory,
  forgetBotMemoryEntry,
  listBotMemories,
} from "./services/bots/bot-memory-store";
import { BotService } from "./services/bots/bot-service";
import {
  getBot,
  listSenderSessionEntries,
  recordBotSession,
  recordSenderSession,
  removeSenderSession,
} from "./services/bots/bot-store";
import { BrowserProfilesService } from "./services/browser/browser-profiles-service";
import type { BrowserTargetSource } from "./services/browser/browser-target";
import type { ElectronBrowserRuntime } from "./services/browser/electron-browser-runtime";
import {
  buildAgentAuthEnv,
  buildAgentConfigEnv,
} from "./services/config/agent-env";
import {
  readExecBackend,
  readToolsetPreferences,
  readSandboxEnabled,
  setSandboxEnabled,
  readXaiSearchPreference,
  setXaiSearchEnabled,
  readNotificationSettings,
  setNotificationSettings,
  setExecBackend,
  setToolsetEnabled,
  readSettings,
} from "./services/config/settings";
import { DebugSyncService } from "./services/debug-sync/debug-sync-service";
import {
  DiagnosticsSyncService,
  type McpRuntimeSummary,
} from "./services/debug-sync/diagnostics-sync-service";
import { LogSyncService } from "./services/debug-sync/log-sync-service";
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
} from "./services/providers/abacus-connector-service";
import {
  environmentNoticeService,
  messageWithEnvironmentNotice,
} from "./services/providers/environment-notice-service";
import {
  backendStatuses,
  clearBackendProbeCache,
  resolveBackend,
} from "./services/providers/exec-backend-service";
import {
  cachedRecommendedModelId,
  recommendedModelId,
} from "./services/providers/models";
import { AgentSessionManagerService } from "./services/session/agent-session-manager-service";
import { ArtifactResolverService } from "./services/session/artifact-resolver-service";
import { AgentCommunicationService } from "./services/session/cli-communication-service";
import { AgentManagerService } from "./services/session/cli-manager-service";
import { deliverMessage } from "./services/session/message-delivery";
import { SessionArtifactsService } from "./services/session/session-artifacts-service";
import {
  INACTIVITY_TIMEOUT_MINUTES,
  SessionTurnStateService,
} from "./services/session/session-turn-state-service";
import { TranscriptService } from "./services/session/transcript-service";
import {
  FileSearchService,
  type FileSearchResult,
} from "./services/workspace/file-search-service";
import { FileTreeService } from "./services/workspace/file-tree-service";
import { GitService } from "./services/workspace/git-service";
import { resolveSessionWorkspacePath } from "./services/workspace/session-workspace-context";
import { SkillsService } from "./services/workspace/skills-service";
import { TerminalSessionService } from "./services/workspace/terminal-session-service";
import { WorkspaceRuntimeService } from "./services/workspace/workspace-runtime-service";
import { WorkspaceService } from "./services/workspace/workspace-service";

type EventDispatcher = (event: IpcEvent) => void;

/** Assistant prose, as opposed to tool cards, status and errors. */
const isAgentText = (payload: DesktopEvent): boolean =>
  payload.type === "event" &&
  (payload.event.type === "text_delta" ||
    payload.event.type === "thinking_delta" ||
    payload.event.type === "thinking_complete");

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
      'them there — replying IS messaging them, so when they say "send ' +
      'me X" or "message me on Discord", just answer with X; never ' +
      "say you cannot reach them and never ask which chat is theirs. " +
      "They can ask you for anything you can do — questions, tasks with " +
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
      'them there — replying IS messaging them, so when they say "send ' +
      'me X" or "message me", just answer with X; never say you ' +
      "cannot reach them and never ask which chat is theirs. They can " +
      "ask you for anything you can do — questions, tasks with your " +
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
      'them there — replying IS messaging them, so when they say "send ' +
      'me X" or "message me", just answer with X; never say you ' +
      "cannot reach them and never ask which chat is theirs. They can " +
      "ask you for anything you can do — questions, tasks with your " +
      "tools, code, documents, schedules, messages to other people. Be " +
      "a helpful, concise assistant and keep replies chat-sized.",
  },
};

/**
 * Early-compaction threshold for routine sessions: every fire replays the chat
 * so far, so an uncapped routine's per-fire cost grows forever.
 */
const ROUTINE_CONTEXT_CAP_TOKENS = 50_000;

export class ServiceHost {
  private initializedAt: string | null = null;
  private startedAt: string | null = null;
  private eventDispatcher: EventDispatcher | null = null;

  readonly mcpConfigService = new McpConfigService();
  private readonly transcriptService = new TranscriptService();
  private readonly debugSyncService = new DebugSyncService({
    readTranscript: (sessionId) => this.transcriptService.read(sessionId),
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
  readonly skillsService = new SkillsService();
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
      list: async () => {
        const snapshot = await listAbacusConnectors();
        return {
          available: snapshot.available.map((item) => ({
            service: item.service,
            name: item.name,
          })),
          connected: Object.keys(snapshot.connected),
          accounts: { ...snapshot.accounts },
        };
      },
      request: (input) => this.connectorGate.ask(input),
      disconnect: async (service) => {
        const result = await disconnectAbacusConnector(service);
        if (result.ok === true) return null;
        const reason = result.error;
        return reason.length > 0 ? reason : "Could not disconnect.";
      },
    },
    workspaceId: () => this.workspaceService.getActiveWorkspace()?.id ?? null,
    runCronJob: (jobId, trigger) => this.runRoutine(jobId, trigger ?? "manual"),
    botIdForSession: (sessionId) => this.botService.botIdForSession(sessionId),
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
  private readonly builtinMcpLifecycle = new BuiltinMcpLifecycle({
    mcpConfigService: this.mcpConfigService,
    browserServer: this.mcpBrowserServer,
    deviceServer: this.mcpDeviceServer,
    agentToolsServer: this.mcpAgentToolsServer,
    emitEvent: (event) => this.emitEvent(event),
    flushPermissions: (decision, server) =>
      this.builtinToolPermissions.flushPending(decision, server),
  });
  private readonly cronScheduler = new CronScheduler((jobId, trigger) =>
    this.runRoutine(jobId, trigger)
  );
  private readonly webhookService = new WebhookService(
    (jobId, trigger, payload) => this.runRoutine(jobId, trigger, payload)
  );
  private readonly webhookRelay = new WebhookRelay(
    (jobId, trigger, payload) => this.runRoutine(jobId, trigger, payload),
    () =>
      this.emitEvent({
        type: "cronjobs-updated",
        emittedAt: new Date().toISOString(),
      })
  );
  private readonly connectorGate = new ConnectorGate(
    (event) => this.emitEvent(event),
    async (service) => {
      const snapshot = await listAbacusConnectors();
      return snapshot.ok ? (snapshot.accounts[service] ?? null) : null;
    }
  );
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
  private readonly fileTreeService = new FileTreeService();
  private readonly fileSearchService = new FileSearchService();
  private readonly gitService = new GitService();

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
    sendMessage: (workspaceId, sessionId, message) => {
      void this.sendAgentMessage({ workspaceId, sessionId, message });
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
    sendMessage: (workspaceId, sessionId, message) => {
      void this.sendAgentMessage({ workspaceId, sessionId, message });
    },
    removeSession: (workspaceId, sessionId) => {
      this.removeAgentSession(workspaceId, sessionId);
    },
    updateSessionModel: (workspaceId, sessionId, model) => {
      this.setAgentSessionModel(workspaceId, sessionId, model);
    },
    // A bot with no model of its own runs on the user's pick, else the tier
    // default the last catalog read established.
    defaultModel: () =>
      readSettings().defaultModel ?? cachedRecommendedModelId(),
    onBotRemoved: (botId) => {
      // Its routines stay (the user can delete those themselves); only the
      // provenance is cleared.
      for (const job of listJobs()) {
        if (job.botId === botId) updateJob(job.id, { botId: null });
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
      this.agentSessionManagerService.updateFromCliState(state);
      this.emitEvent({
        type: "local-cli-state-updated",
        workspaceId,
        sessionId,
        state,
        emittedAt: new Date().toISOString(),
      });
    },
    emitNdjson: (workspaceId, sessionId, payload) => {
      // Recorded before the filter: a stopped session is exactly one whose
      // log somebody is about to want.
      if (payload.type === "ready" && payload.agentSessionId != null) {
        this.agentSessionManagerService.recordAgentSession(
          sessionId,
          payload.agentSessionId,
          payload.agentSessionFile ?? null
        );
      }
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
        if (
          !isAgentText(payload) ||
          !this.messagingGatewayService.relayingSession(sessionId)
        )
          this.emitEvent({
            type: "local-cli-ndjson",
            workspaceId,
            sessionId,
            payload,
            emittedAt: new Date().toISOString(),
          });
        // Same filtered stream, so a post-Stop tail cannot file cancelled work.
        this.sessionArtifactsService.recordFromNdjson(
          workspaceId,
          sessionId,
          payload
        );
        // Same reason: the remote user must not receive a cancelled tail.
        this.messagingGatewayService.handleAgentEvent(sessionId, payload);
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
        this.agentCommunicationService.respondPermission({
          workspaceId,
          sessionId,
          permissionId: communicationUpdate.autoAllowDecision.permissionId,
          decision: communicationUpdate.autoAllowDecision.decision,
        });
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
        this.emitEvent({
          type: "local-cli-ndjson",
          workspaceId,
          sessionId,
          payload: {
            type: "event",
            event: {
              type: "error",
              error: { message: "Something went wrong." },
            },
          },
          emittedAt: new Date().toISOString(),
        });
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
    },
    emitMcpRuntimeStatus: (workspaceId, sessionId, event) => {
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
    runHostService: async (service, payload) => {
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
    },
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

  /** True while a user-requested agent turn is still in flight. */
  hasActiveAgentTurn(): boolean {
    return this.sessionTurnStateService.hasBusyTurn();
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
      // Actually stop it, or the slow tool's events would still be forwarded
      // when it finally lands and the session would go busy again.
      this.stopAgentTurn({ workspaceId, sessionId });
      this.emitEvent({
        type: "local-cli-ndjson",
        workspaceId,
        sessionId,
        payload: {
          type: "event",
          event: {
            type: "error",
            error: {
              message:
                `Agent timed out: nothing came back for ${INACTIVITY_TIMEOUT_MINUTES} minutes${doing}. ` +
                `The turn was stopped — send a message to pick it back up.`,
            },
          },
        },
        emittedAt: new Date().toISOString(),
      });
    }
  );

  private readonly workspaceRuntimeService = new WorkspaceRuntimeService({
    workspaceService: this.workspaceService,
    gitService: this.gitService,
    fileTreeService: this.fileTreeService,
    emitEvent: (event) => this.emitEvent(event),
  });

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
    this.transcriptService.setOnPersist((sessionId) => {
      this.debugSyncService.enqueue(sessionId);
      // A bot's sidebar row shows the last thing said in its chat.
      if (this.botService.botIdForSession(sessionId) != null)
        this.emitEvent({
          type: "bots-updated",
          emittedAt: new Date().toISOString(),
        });
    });
    this.debugSyncService.sweepOnStartup();
    this.logSyncService.start();
    this.diagnosticsSyncService.start();
    this.workspaceRuntimeService.ensureWorkspaceWatchers();
    this.workspaceRuntimeService.scheduleRefresh(0);
    void this.builtinMcpLifecycle.startBrowserServer();
    // Failures are per-connector and reported through the pane.
    void this.messagingGatewayService
      .syncConnectors()
      .catch((error: unknown) => {
        console.error("[messaging] failed to start connectors:", error);
      });
  }

  stop(): void {
    this.startedAt = null;
    this.workspaceRuntimeService.stop();
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
    this.mcpDeviceServer.stop();
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
    void this.messagingGatewayService.dispose();
    this.workspaceRuntimeService.reset();
    return agentsStopped;
  }

  setEventDispatcher(dispatcher: EventDispatcher): void {
    this.eventDispatcher = dispatcher;
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
    newPath: string
  ): Promise<RelocateWorkspaceResult> {
    const result = await this.workspaceService.relocateWorkspace(
      workspaceId,
      newPath
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
      return { success: false, error: "Workspace not found." };
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
      return { success: false, error: "Workspace not found." };
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
    owner: SessionOwner | null = null
  ): AgentSessionListItem {
    if (this.isWorkspaceDeleted(workspaceId)) {
      throw new Error(
        "Workspace was deleted; new chats cannot be started in it."
      );
    }
    const session = this.agentSessionManagerService.create(
      workspaceId,
      routineId,
      owner
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

  getMessagingSnapshot(): MessagingSnapshot {
    return this.messagingGatewayService.getSnapshot();
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
  ): Promise<void> {
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
      const preview = botChatPreview(this.transcriptService, bot.sessionId);
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

  createBot(input: BotCreateInput): Bot {
    return this.botService.create(input);
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
    const bot = this.botService.list().find((entry) => entry.id === id);
    if (bot?.channel != null) {
      const app =
        bot.channel === "discord"
          ? "Discord"
          : bot.channel === "whatsapp"
            ? "WhatsApp"
            : "Telegram";
      throw new Error(
        `This bot mirrors your ${app} chat and can't be ${verb}.`
      );
    }
  }

  openBotChat(botId: string): Promise<BotChatHandle> {
    return this.botService.openChat(botId);
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
    if (!result.ok) throw new Error(result.message);
  }

  /** A running session keeps the snapshot in its prompt until it restarts. */
  async forgetMemory(request: ForgetMemoryRequest): Promise<MemorySnapshot> {
    this.failIfNotDone(
      await forgetEntryAt(request.target, request.index, request.entry)
    );
    return listMemories();
  }

  listBotMemories(): ReturnType<typeof listBotMemories> {
    return listBotMemories();
  }

  forgetBotMemory(request: {
    botId: string;
    index: number;
    entry: string;
  }): ReturnType<typeof listBotMemories> {
    forgetBotMemoryEntry(request.botId, request.index, request.entry);
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

  writeTranscript(sessionId: string, segments: TranscriptSegment[]): void {
    this.transcriptService.write(sessionId, segments);
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
    // neither, the plan tier's default — not the agent's own fallback, which
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
    const withModel = model != null ? { ...request, model } : request;

    // The new agent sees the environment as it stands; nothing owed until then.
    environmentNoticeService.markSessionStarted(request.sessionId);

    return this.agentManagerService.startSession(withModel);
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
      return message === request.message ? request : { ...request, message };
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
   * The attached account connectors: the service to ask for and who it is
   * attached as. A network call; on failure it costs the note its connector
   * line, not the whole note.
   */
  private async describeAccountConnectors(): Promise<string[]> {
    try {
      const snapshot = await listAbacusConnectors();
      if (!snapshot.ok) return [];
      const nameOf = new Map(
        snapshot.available.map((item) => [item.service, item.name])
      );
      // The shared Abacus bots are already reported under messaging; listed
      // here too they would read as the user's own Telegram.
      return Object.keys(snapshot.connected)
        .filter((service) => !SHARED_BOT_ACCOUNT_SERVICES.has(service))
        .map((service) => {
          const account = snapshot.accounts[service];
          return `${nameOf.get(service) ?? service} (${service})${
            account != null && account.length > 0 ? `, as ${account}` : ""
          }`;
        });
    } catch (err) {
      console.error("[environment-notice] failed to list connectors:", err);
      return [];
    }
  }

  setAgentMode(request: AgentSetModeRequest): void {
    this.agentCommunicationService.setMode(request);
  }

  setAgentModel(request: AgentSetModelRequest): void {
    this.agentCommunicationService.setModel(request);
  }

  stopAgentTurn(request: AgentSessionCommandRequest): void {
    // Idle, and in-flight CLI events suppressed until the next send.
    this.sessionTurnStateService.markStopped(
      request.workspaceId,
      request.sessionId
    );
    // A Connect card is the turn, suspended inside its tool call: stopping
    // must take it down and let the call go. This conversation's only.
    const stopped = this.conversationKeyForSession(request.sessionId);
    if (stopped != null)
      this.connectorGate.release(
        stopped,
        "The user stopped this turn before answering. Do not ask again unless they bring it up."
      );
    this.agentCommunicationService.stopTurn(request);
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
    request: SetSessionWorktreeRequest
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
          }
    );
    return attached
      ? {
          success: true,
          session: this.agentSessionManagerService.get(request.sessionId)!,
        }
      : { success: false, error: "Unable to attach worktree to session." };
  }

  async materializeSessionWorktree(
    request: MaterializeSessionWorktreeRequest
  ): Promise<MaterializeSessionWorktreeResult> {
    const created = await this.createWorktree(request);
    if (!created.success || created.worktree == null) return created;

    const attached = await this.setSessionWorktree({
      workspaceId: request.workspaceId,
      sessionId: request.sessionId,
      worktreeId: created.worktree.id,
    });
    if (!attached.success || attached.session == null) {
      const workspacePath = this.localWorkspacePath(request.workspaceId);
      if (workspacePath != null) {
        await this.gitService.removeManagedWorktree(
          workspacePath,
          this.managedWorktreeRoot(request.workspaceId),
          created.worktree.path
        );
      }
      return {
        success: false,
        error: attached.error ?? "Unable to attach the new worktree.",
      };
    }
    return {
      success: true,
      worktree: created.worktree,
      session: attached.session,
    };
  }

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

  importMcpServers(
    request: ImportMcpServersRequest
  ): Promise<ImportMcpServersResult> {
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
    return this.deviceMirrorService.buildAndRunLocalDevice(request);
  }

  startDeviceStream(
    request: StartDeviceStreamRequest,
    sender: Electron.WebContents,
    opts?: { keepStreamId?: number | null; isRestart?: boolean }
  ): Promise<StartDeviceStreamResult> {
    return this.deviceMirrorService.startDeviceStream(request, sender, opts);
  }

  stopDeviceStream(streamId?: number): void {
    this.deviceMirrorService.stopDeviceStream(streamId);
  }

  getSimulatorWindowSource(
    request: GetSimulatorWindowSourceRequest
  ): Promise<GetSimulatorWindowSourceResult> {
    return getSimulatorWindowSource(request);
  }

  openScreenRecordingSettings(): Promise<void> {
    return openScreenRecordingSettings();
  }

  openAccessibilitySettings(): Promise<void> {
    return openAccessibilitySettings();
  }

  streamDeviceTouch(request: StreamDeviceTouchRequest): void {
    this.deviceMirrorService.streamDeviceTouch(request);
  }

  streamDeviceKey(request: StreamDeviceKeyRequest): void {
    this.deviceMirrorService.streamDeviceKey(request);
  }

  async installMaestro(): Promise<InstallMaestroResult> {
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

  async clearBrowserData(
    _request?: ClearBrowserDataRequest
  ): Promise<ClearBrowserDataResult> {
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

  listConnectorRequests(conversationKey: ConversationKey): ConnectorRequest[] {
    return this.connectorGate.listPending(conversationKey);
  }

  listBrowserPermissionRequests(
    conversationKey: ConversationKey
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

  /** A run's end off its event stream: an error fails it, idle completes it. */
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
    this.agentSessionManagerService.setRunOutcome(sessionId, outcome);
    // Once: an error's trailing idle must not overwrite the failure.
    const session = this.agentSessionManagerService.get(sessionId);
    const text = this.routineRunText.get(sessionId);
    if (session?.routineId == null || text == null) return;
    this.routineRunText.delete(sessionId);
    recordRoutineRun(session.routineId, {
      sessionId,
      startedAt: session.createdAt,
      endedAt: new Date().toISOString(),
      outcome,
      reply: text.join("").trim(),
    });
    if (outcome === "failed") this.pauseIfFailingRepeatedly(session.routineId);
  }

  /** A routine that keeps failing pauses itself rather than failing forever. */
  private pauseIfFailingRepeatedly(routineId: string): void {
    const job = getJob(routineId);
    if (job == null || !job.enabled) return;
    if (!shouldPauseAfter(this.listRoutineRuns(routineId))) return;
    updateJob(routineId, { enabled: false });
    recordRun(
      routineId,
      `paused after ${ROUTINE_FAILURES_BEFORE_PAUSE} failed runs in a row`
    );
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
        recordRoutineRun(job.id, {
          sessionId: run.sessionId,
          startedAt: run.startedAt,
          endedAt: new Date(now).toISOString(),
          outcome: "failed",
          reply: text.join("").trim(),
        });
        recordRun(job.id, "failed: the run was stopped after 30 minutes");
        this.pauseIfFailingRepeatedly(job.id);
      }
    }
  }

  /** Read at fire time: an edited persona applies, a deleted bot drops out. */
  private withBotVoice(botId: string | null, prompt: string): string {
    const bot = botId == null ? null : getBot(botId);
    if (bot == null) return prompt;
    const voice = [
      `You are ${bot.name}, running a routine you set up for the user.`,
      bot.persona.length > 0 ? `Your voice, every message: ${bot.persona}` : "",
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
        reject(new Error("The routine did not answer in time."));
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
    if (job == null) throw new Error("This routine is gone.");
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
      mode: AgentMode.Yolo,
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

  createRoutine(input: RoutineCreateInput): Routine {
    const job = createJob(input);
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

  removeRoutine(id: string): void {
    removeJob(id);
    removeRoutineDir(id);
    // Its runs go with it; nothing else lists them.
    for (const run of this.agentSessionManagerService.listByRoutine(id)) {
      this.removeAgentSession(run.workspaceId, run.id);
    }
    this.emitEvent({
      type: "cronjobs-updated",
      emittedAt: new Date().toISOString(),
    });
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
  ): Promise<void> {
    const job = getJob(jobId);
    if (job == null) return;

    // One run at a time, or a five-minute routine whose runs take eight stacks.
    if (hasRunInFlight(this.listRoutineRuns(jobId))) {
      recordRun(jobId, "skipped: the previous run is still going", trigger);
      this.emitEvent({
        type: "cronjobs-updated",
        emittedAt: new Date().toISOString(),
      });
      return;
    }

    const workspaces = this.workspaceService.getWorkspaces();
    // A routine made against a real project runs there; every other runs in
    // its own folder. The app's home folders are not a project anyone chose.
    const named = workspaces.find(
      (entry) => entry.id === job.workspaceId && entry.status !== "deleted"
    );
    const project =
      named != null &&
      named.kind !== "auto" &&
      named.kind !== "routine" &&
      named.kind !== "bot"
        ? named.id
        : null;
    const target = project ?? (await this.ensureRoutineWorkspace(job.id));

    const prompt = this.withBotVoice(
      job.botId,
      buildRoutineFirePrompt(job, trigger, payload, {
        dir: routineDir(job.id),
        runs: countRoutineRuns(job.id),
        lastRun: readLastRoutineRun(job.id),
        isWorkingDirectory: project == null,
        workspaces: workspaces
          .filter(
            (entry) => entry.status !== "deleted" && entry.kind !== "routine"
          )
          .map((entry) => entry.path),
      })
    );

    if (target == null) {
      recordRun(jobId, "no workspace to run in", trigger);
      this.emitEvent({
        type: "cronjobs-updated",
        emittedAt: new Date().toISOString(),
      });
      return;
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
      mode: AgentMode.Yolo,
    });

    if (!started.success) {
      this.agentSessionManagerService.setRunOutcome(session.id, "failed");
      recordRun(
        jobId,
        `session failed to start: ${started.error ?? "unknown"}`,
        trigger
      );
      this.emitEvent({
        type: "cronjobs-updated",
        emittedAt: new Date().toISOString(),
      });
      return;
    }

    // Seeded now so a run that never says a word still gets its file.
    this.routineRunText.set(session.id, []);
    this.sendAgentMessage({
      workspaceId: target,
      sessionId: session.id,
      message: prompt,
    });
    recordRun(jobId, `started session ${session.id}`, trigger);
    this.emitEvent({
      type: "cronjobs-updated",
      emittedAt: new Date().toISOString(),
    });
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
      // A run may use its own folder without the containment gate asking.
      ...this.routineFolderEnvForSession(sessionId),
    };
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

    const paths = [
      routineDir(routineId),
      ...this.workspaceService
        .getWorkspaces()
        .filter((entry) => entry.status !== "deleted")
        .map((entry) => entry.path),
    ];

    return {
      ABACUSAI_BOT_ALLOWED_PATHS: [...new Set(paths)].join(path.delimiter),
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

  getNotificationSettings(): NotificationSettings {
    return readNotificationSettings();
  }

  setNotificationSettings(next: NotificationSettings): NotificationSettings {
    return setNotificationSettings(next);
  }

  getSandboxEnabled(): boolean {
    return readSandboxEnabled();
  }

  /** What the Settings page says when the toggle is on but nothing confines. */
  getSandboxSupport(): SandboxSupport {
    return {
      backend: sandboxBackendFor(process.platform, os.release()),
      minimumWindowsBuild: MINIMUM_WINDOWS_BUILD,
    };
  }

  /** Read back, not echoed: "on" over a failed write misstates confinement. */
  setSandboxEnabled(enabled: boolean): boolean {
    setSandboxEnabled(enabled);

    return readSandboxEnabled();
  }

  /**
   * The stored preference, not the resolved one: an `XAI_API_KEY` in the
   * environment also turns routing on, and that switch cannot be moved.
   */
  getXaiSearchEnabled(): boolean {
    return readXaiSearchPreference();
  }

  /** Read back rather than echoed, same reason as the sandbox above. */
  setXaiSearchEnabled(enabled: boolean): boolean {
    setXaiSearchEnabled(enabled);

    return readXaiSearchPreference();
  }

  setExecBackend(backend: BackendId): {
    selected: BackendId;
    effective: BackendId;
    statuses: BackendStatus[];
  } {
    // The user may have just installed Docker in order to pick it.
    clearBackendProbeCache();
    setExecBackend(backend);

    return this.getExecBackendState();
  }

  listBrowserProfiles(): ReturnType<BrowserProfilesService["listProfiles"]> {
    return this.browserProfilesService.listProfiles();
  }

  refreshBrowserProfiles(): ReturnType<
    BrowserProfilesService["refreshProfiles"]
  > {
    return this.browserProfilesService.refreshProfiles();
  }

  importBrowserProfile(
    profileId: string
  ): ReturnType<BrowserProfilesService["importProfile"]> {
    return this.browserProfilesService.importProfile(profileId);
  }

  clearImportedBrowserProfile(
    profileId: string
  ): ReturnType<BrowserProfilesService["clearImportedProfile"]> {
    return this.browserProfilesService.clearImportedProfile(profileId);
  }
}
