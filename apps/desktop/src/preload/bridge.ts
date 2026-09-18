import { IpcRenderer, IpcRendererEvent } from "electron";

import type {
  BotChangeNotice,
  Bot,
  BotChatHandle,
  BotCreateInput,
  BotUpdateInput,
} from "#shared/bots";
import { IpcChannels } from "#shared/channels";
import type {
  BotChatPreview,
  BotSenderChat,
  AbacusAccountInfo,
  ReferralSummary,
  ReferralGmailContact,
  ReferralWhatsappContact,
  ReferralInviteOutcome,
  AbacusAuthOutcome,
  AbacusSignOutResult,
  ConnectorOutcome,
  ConnectorStatuses,
  OpenRouterAuthOutcome,
  UsageSnapshot,
  AddMcpServerRequest,
  ExecBackendState,
  ConnectorRequest,
  RespondConnectorRequest,
  AddWorkspaceResult,
  AgentSessionListItem,
  SessionArtifact,
  WorkspacePathStatus,
  RelocateWorkspaceResult,
  BrowserApproval,
  BrowserRuntimeLease,
  BrowserRuntimeCapture,
  BrowserRuntimeState,
  HideBrowserRuntimeRequest,
  MaterializeBrowserRuntimeRequest,
  NavigateBrowserRuntimeRequest,
  PresentBrowserRuntimeRequest,
  PromoteBrowserRuntimeScopeRequest,
  NotificationSettings,
  BrowserProfileInfo,
  ClearBrowserDataRequest,
  ClearBrowserDataResult,
  GetMcpRuntimeServersRequest,
  GetMcpServerLogsRequest,
  ImportMcpServersRequest,
  ImportMcpServersResult,
  ListMcpServersRequest,
  McpOAuthSignInRequest,
  McpOAuthSignInResult,
  AgentMcpLogEntry,
  AgentMcpServer,
  McpRuntimeRequestResult,
  RefreshMcpServersRequest,
  RemoveMcpServerRequest,
  BrowserPermissionRequest,
  RespondBrowserPermissionRequest,
  TranscriptSegment,
  TurnFeedbackInput,
  TurnFeedbackOutcome,
  MemorySnapshot,
  MemoryTargetId,
  BotMemoryView,
  ForgetBotMemoryRequest,
  ForgetMemoryRequest,
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
  DeviceStreamChunk,
  GetSimulatorWindowSourceRequest,
  GetSimulatorWindowSourceResult,
  InstallMaestroResult,
  StreamDeviceTouchRequest,
  StreamDeviceKeyRequest,
  RestartMcpServerRequest,
  ImportBrowserProfileResult,
  FileTreeNode,
  FileTreeRootSnapshot,
  CreateGitBranchResult,
  GitChangeStatsScope,
  GitChangeStatsSnapshot,
  GitDiffScope,
  GetGitBranchesResult,
  GetGitCurrentBranchResult,
  PrInfo,
  McpBrowserStatus,
  DefaultAgentMode,
  SandboxSupport,
  McpServerInfo,
  SessionTurnStateSnapshot,
  SetMcpServerDisabledRequest,
  GitStateSnapshot,
  InitGitResult,
  AgentQueueMessageRequest,
  AgentRemoveFromQueueRequest,
  RoutineRunItem,
  AgentUpdateQueueMessageRequest,
  AgentSessionCommandRequest,
  AgentSessionSnapshot,
  AgentSetModeRequest,
  AgentSetModelRequest,
  AgentSwitchConversationRequest,
  AgentPermissionResponseRequest,
  AgentApi,
  IpcEvent,
  WorkspaceMetadataRequest,
  WorkspaceMetadataSnapshot,
  RenameLocalFileResult,
  TrashLocalFileResult,
  SaveResolvedConflictResult,
  UpdateMcpServerRequest,
  WriteFileResult,
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
  CreateWorktreeRequest,
  CreateWorktreeResult,
  ListWorktreesRequest,
  ListWorktreesResult,
  MaterializeSessionWorktreeRequest,
  MaterializeSessionWorktreeResult,
  SetSessionWorktreeRequest,
  SetSessionWorktreeResult,
  WorkspaceGitContext,
} from "#shared/contracts";
import type { ConversationKey } from "#shared/conversation-scope";
import type { BackendId } from "#shared/exec-backends";
import type {
  MessagingPairingDecisionRequest,
  MessagingPlatformId,
  MessagingSnapshot,
  UpdateMessagingPlatformRequest,
  UpdateMessagingSettingsRequest,
} from "#shared/messaging";
import type { ModelAvailability } from "#shared/models";
import type {
  Routine,
  RoutineCreateInput,
  RoutineListItem,
  RoutineUpdateInput,
} from "#shared/routines";
import type { AbacusBotSettings } from "#shared/settings";
import type {
  TerminalShellId,
  TerminalShellState,
} from "#shared/terminal-shells";

export const createBridge = (ipcRenderer: IpcRenderer): AgentApi => {
  return {
    getMetadata: (request?: WorkspaceMetadataRequest) =>
      ipcRenderer.invoke(
        IpcChannels.GetMetadata,
        request
      ) as Promise<WorkspaceMetadataSnapshot>,
    getGitState: () =>
      ipcRenderer.invoke(IpcChannels.GetGitState) as Promise<GitStateSnapshot>,
    listWorktrees: (request: ListWorktreesRequest) =>
      ipcRenderer.invoke(
        IpcChannels.ListWorktrees,
        request
      ) as Promise<ListWorktreesResult>,
    createWorktree: (request: CreateWorktreeRequest) =>
      ipcRenderer.invoke(
        IpcChannels.CreateWorktree,
        request
      ) as Promise<CreateWorktreeResult>,
    setSessionWorktree: (request: SetSessionWorktreeRequest) =>
      ipcRenderer.invoke(
        IpcChannels.SetSessionWorktree,
        request
      ) as Promise<SetSessionWorktreeResult>,
    materializeSessionWorktree: (request: MaterializeSessionWorktreeRequest) =>
      ipcRenderer.invoke(
        IpcChannels.MaterializeSessionWorktree,
        request
      ) as Promise<MaterializeSessionWorktreeResult>,
    getFileTreeRoot: () =>
      ipcRenderer.invoke(
        IpcChannels.GetFileTreeRoot
      ) as Promise<FileTreeRootSnapshot>,
    listModels: (refresh?: boolean) =>
      ipcRenderer.invoke(IpcChannels.ListModels, refresh) as Promise<
        ModelAvailability[]
      >,
    getUsageSnapshot: () =>
      ipcRenderer.invoke(
        IpcChannels.GetUsageSnapshot
      ) as Promise<UsageSnapshot>,
    getAbacusAccount: (refresh?: boolean) =>
      ipcRenderer.invoke(
        IpcChannels.GetAbacusAccount,
        refresh
      ) as Promise<AbacusAccountInfo | null>,
    getReferralSummary: () =>
      ipcRenderer.invoke(
        IpcChannels.GetReferralSummary
      ) as Promise<ReferralSummary | null>,
    listReferralGmailContacts: () =>
      ipcRenderer.invoke(IpcChannels.ListReferralGmailContacts) as Promise<
        ReferralGmailContact[]
      >,
    sendReferralEmailInvites: (emails: string[], message: string) =>
      ipcRenderer.invoke(
        IpcChannels.SendReferralEmailInvites,
        emails,
        message
      ) as Promise<ReferralInviteOutcome>,
    listReferralWhatsappContacts: () =>
      ipcRenderer.invoke(IpcChannels.ListReferralWhatsappContacts) as Promise<
        ReferralWhatsappContact[]
      >,
    sendReferralWhatsappInvites: (chatIds: string[], message: string) =>
      ipcRenderer.invoke(
        IpcChannels.SendReferralWhatsappInvites,
        chatIds,
        message
      ) as Promise<ReferralInviteOutcome>,
    submitTurnFeedback: (feedback: TurnFeedbackInput) =>
      ipcRenderer.invoke(
        IpcChannels.SubmitTurnFeedback,
        feedback
      ) as Promise<TurnFeedbackOutcome>,
    getSettings: () =>
      ipcRenderer.invoke(IpcChannels.GetSettings) as Promise<AbacusBotSettings>,
    listPromptHistory: (scope: string) =>
      ipcRenderer.invoke(IpcChannels.ListPromptHistory, scope) as Promise<
        string[]
      >,
    addPromptHistory: (scope: string, prompt: string) =>
      ipcRenderer.invoke(
        IpcChannels.AddPromptHistory,
        scope,
        prompt
      ) as Promise<string[]>,
    listStoredKeyProviders: () =>
      ipcRenderer.invoke(IpcChannels.ListStoredKeyProviders) as Promise<
        string[]
      >,
    saveApiKey: (provider: string, key: string) =>
      ipcRenderer.invoke(
        IpcChannels.SaveApiKey,
        provider,
        key
      ) as Promise<AbacusBotSettings>,
    setDefaultModel: (modelId: string) =>
      ipcRenderer.invoke(
        IpcChannels.SetDefaultModel,
        modelId
      ) as Promise<AbacusBotSettings>,
    addWorkspace: (path, isRemote) =>
      ipcRenderer.invoke(
        IpcChannels.AddWorkspace,
        path,
        isRemote
      ) as Promise<AddWorkspaceResult>,
    ensureBotWorkspace: () =>
      ipcRenderer.invoke(IpcChannels.EnsureBotWorkspace) as Promise<
        string | null
      >,
    ensureSessionHomeWorkspace: () =>
      ipcRenderer.invoke(IpcChannels.EnsureSessionHomeWorkspace) as Promise<
        string | null
      >,
    getSessionHomeWorkspacePath: () =>
      ipcRenderer.invoke(
        IpcChannels.GetSessionHomeWorkspacePath
      ) as Promise<string>,
    switchWorkspace: (workspaceId) =>
      ipcRenderer.invoke(
        IpcChannels.SwitchWorkspace,
        workspaceId
      ) as Promise<SwitchWorkspaceResult>,
    initGit: () =>
      ipcRenderer.invoke(IpcChannels.InitGit) as Promise<InitGitResult>,
    getFileTreeChildren: (directoryPath) =>
      ipcRenderer.invoke(
        IpcChannels.GetFileTreeChildren,
        directoryPath
      ) as Promise<FileTreeNode[]>,
    searchFiles: (query) =>
      ipcRenderer.invoke(IpcChannels.SearchFiles, query) as Promise<{
        items: Array<{
          relativePath: string;
          fileName: string;
          kind: "file" | "directory";
        }>;
      }>,
    getGitDiffForPath: (filePath, scope?: GitDiffScope) =>
      ipcRenderer.invoke(
        IpcChannels.GetGitDiffForPath,
        filePath,
        scope
      ) as Promise<string>,
    getGitChangeStatsForPath: (filePath, scope?: GitChangeStatsScope) =>
      ipcRenderer.invoke(
        IpcChannels.GetGitChangeStatsForPath,
        filePath,
        scope
      ) as Promise<GitChangeStatsSnapshot>,
    startTerminalSession: (request: StartTerminalSessionRequest) =>
      ipcRenderer.invoke(
        IpcChannels.StartTerminalSession,
        request
      ) as Promise<StartTerminalSessionResult>,
    writeTerminalInput: (request: WriteTerminalInputRequest) =>
      ipcRenderer.invoke(
        IpcChannels.WriteTerminalInput,
        request
      ) as Promise<boolean>,
    resizeTerminalSession: (request: ResizeTerminalSessionRequest) =>
      ipcRenderer.invoke(
        IpcChannels.ResizeTerminalSession,
        request
      ) as Promise<boolean>,
    hideTerminalSession: (request: TerminalRuntimeRequest) =>
      ipcRenderer.invoke(
        IpcChannels.HideTerminalSession,
        request
      ) as Promise<boolean>,
    promoteTerminalSessionScope: (
      request: PromoteTerminalSessionScopeRequest
    ) =>
      ipcRenderer.invoke(
        IpcChannels.PromoteTerminalSessionScope,
        request
      ) as Promise<TerminalSessionSnapshot | null>,
    getGitBranches: (context?: WorkspaceGitContext) =>
      ipcRenderer.invoke(
        IpcChannels.GetGitBranches,
        context
      ) as Promise<GetGitBranchesResult>,
    getGitCurrentBranch: (context?: WorkspaceGitContext) =>
      ipcRenderer.invoke(
        IpcChannels.GetGitCurrentBranch,
        context
      ) as Promise<GetGitCurrentBranchResult>,
    getPrInfo: (context?: WorkspaceGitContext) =>
      ipcRenderer.invoke(
        IpcChannels.GetPrInfo,
        context
      ) as Promise<PrInfo | null>,
    getSessionTurnState: (workspaceId: string, sessionId: string) =>
      ipcRenderer.invoke(
        IpcChannels.GetSessionTurnState,
        workspaceId,
        sessionId
      ) as Promise<SessionTurnStateSnapshot>,
    switchGitBranch: (branchName: string, context?: WorkspaceGitContext) =>
      ipcRenderer.invoke(
        IpcChannels.SwitchGitBranch,
        branchName,
        context
      ) as Promise<SwitchGitBranchResult>,
    createGitBranch: (branchName: string, context?: WorkspaceGitContext) =>
      ipcRenderer.invoke(
        IpcChannels.CreateGitBranch,
        branchName,
        context
      ) as Promise<CreateGitBranchResult>,
    createAgentSession: (workspaceId: string) =>
      ipcRenderer.invoke(
        IpcChannels.CreateAgentSession,
        workspaceId
      ) as Promise<AgentSessionListItem>,
    listAgentSessions: (workspaceId: string) =>
      ipcRenderer.invoke(IpcChannels.ListAgentSessions, workspaceId) as Promise<
        AgentSessionListItem[]
      >,
    listAllAgentSessions: () =>
      ipcRenderer.invoke(IpcChannels.ListAllAgentSessions) as Promise<
        AgentSessionListItem[]
      >,
    listBots: () => ipcRenderer.invoke(IpcChannels.ListBots) as Promise<Bot[]>,
    listBotChatPreviews: () =>
      ipcRenderer.invoke(IpcChannels.ListBotChatPreviews) as Promise<
        Record<string, BotChatPreview>
      >,
    listBotSenderChats: () =>
      ipcRenderer.invoke(IpcChannels.ListBotSenderChats) as Promise<
        BotSenderChat[]
      >,
    createBot: (input: BotCreateInput) =>
      ipcRenderer.invoke(IpcChannels.CreateBot, input) as Promise<Bot>,
    updateBot: (id: string, changes: BotUpdateInput) =>
      ipcRenderer.invoke(IpcChannels.UpdateBot, id, changes) as Promise<Bot>,
    deleteBot: (id: string) =>
      ipcRenderer.invoke(IpcChannels.DeleteBot, id) as Promise<void>,
    announceBotChange: (id: string, notice: BotChangeNotice) =>
      ipcRenderer.invoke(
        IpcChannels.AnnounceBotChange,
        id,
        notice
      ) as Promise<void>,
    openBotChat: (botId: string) =>
      ipcRenderer.invoke(
        IpcChannels.OpenBotChat,
        botId
      ) as Promise<BotChatHandle>,
    listRoutines: () =>
      ipcRenderer.invoke(IpcChannels.ListRoutines) as Promise<
        RoutineListItem[]
      >,
    listRoutineRuns: (routineId: string) =>
      ipcRenderer.invoke(IpcChannels.ListRoutineRuns, routineId) as Promise<
        RoutineRunItem[]
      >,
    editRoutineByChat: (routineId: string, text: string) =>
      ipcRenderer.invoke(
        IpcChannels.EditRoutineByChat,
        routineId,
        text
      ) as Promise<string>,
    createRoutine: (input: RoutineCreateInput) =>
      ipcRenderer.invoke(IpcChannels.CreateRoutine, input) as Promise<Routine>,
    updateRoutine: (id: string, changes: RoutineUpdateInput) =>
      ipcRenderer.invoke(
        IpcChannels.UpdateRoutine,
        id,
        changes
      ) as Promise<Routine>,
    removeRoutine: (id: string) =>
      ipcRenderer.invoke(IpcChannels.RemoveRoutine, id) as Promise<void>,
    runRoutine: (id: string, trigger?: "manual" | "create") =>
      ipcRenderer.invoke(IpcChannels.RunRoutine, id, trigger) as Promise<void>,
    startOpenRouterAuth: () =>
      ipcRenderer.invoke(
        IpcChannels.StartOpenRouterAuth
      ) as Promise<OpenRouterAuthOutcome>,
    startAbacusAuth: () =>
      ipcRenderer.invoke(
        IpcChannels.StartAbacusAuth
      ) as Promise<AbacusAuthOutcome>,
    cancelAbacusAuth: () =>
      ipcRenderer.invoke(IpcChannels.CancelAbacusAuth) as Promise<void>,
    cancelOpenRouterAuth: () =>
      ipcRenderer.invoke(IpcChannels.CancelOpenRouterAuth) as Promise<void>,
    signOutAbacus: (options: { keepOtherApiKeys: boolean }) =>
      ipcRenderer.invoke(
        IpcChannels.SignOutAbacus,
        options
      ) as Promise<AbacusSignOutResult>,
    listConnectorStatuses: () =>
      ipcRenderer.invoke(
        IpcChannels.ListConnectorStatuses
      ) as Promise<ConnectorStatuses>,
    connectConnector: (connectorId: string) =>
      ipcRenderer.invoke(
        IpcChannels.ConnectConnector,
        connectorId
      ) as Promise<ConnectorOutcome>,
    submitConnectorFields: (
      connectorId: string,
      values: Record<string, string>
    ) =>
      ipcRenderer.invoke(
        IpcChannels.SubmitConnectorFields,
        connectorId,
        values
      ) as Promise<ConnectorOutcome>,
    cancelConnectorConnect: () =>
      ipcRenderer.invoke(IpcChannels.CancelConnectorConnect) as Promise<void>,
    disconnectConnector: (connectorId: string) =>
      ipcRenderer.invoke(
        IpcChannels.DisconnectConnector,
        connectorId
      ) as Promise<ConnectorOutcome>,
    listSessionArtifacts: () =>
      ipcRenderer.invoke(IpcChannels.ListSessionArtifacts) as Promise<
        SessionArtifact[]
      >,
    removeAgentSession: (workspaceId: string, sessionId: string) =>
      ipcRenderer.invoke(
        IpcChannels.RemoveAgentSession,
        workspaceId,
        sessionId
      ) as Promise<boolean>,
    startAgentSession: (request: StartAgentSessionRequest) =>
      ipcRenderer.invoke(
        IpcChannels.StartAgentSession,
        request
      ) as Promise<StartAgentSessionResult>,
    stopAgentSession: (request: AgentSessionCommandRequest) =>
      ipcRenderer.invoke(
        IpcChannels.StopAgentSession,
        request
      ) as Promise<StopAgentSessionResult>,
    getAgentSessionState: (request: AgentSessionCommandRequest) =>
      ipcRenderer.invoke(
        IpcChannels.GetAgentSessionState,
        request
      ) as Promise<AgentSessionSnapshot>,
    sendAgentMessage: (request: SendAgentMessageRequest) =>
      ipcRenderer.invoke(
        IpcChannels.SendAgentMessage,
        request
      ) as Promise<boolean>,
    setAgentMode: (request: AgentSetModeRequest) =>
      ipcRenderer.invoke(IpcChannels.SetAgentMode, request) as Promise<void>,
    setAgentModel: (request: AgentSetModelRequest) =>
      ipcRenderer.invoke(IpcChannels.SetAgentModel, request) as Promise<void>,
    stopAgentTurn: (request: AgentSessionCommandRequest) =>
      ipcRenderer.invoke(IpcChannels.StopAgentTurn, request) as Promise<void>,
    resetAgentConversation: (request: AgentSessionCommandRequest) =>
      ipcRenderer.invoke(
        IpcChannels.ResetAgentConversation,
        request
      ) as Promise<void>,
    switchAgentConversation: (request: AgentSwitchConversationRequest) =>
      ipcRenderer.invoke(
        IpcChannels.SwitchAgentConversation,
        request
      ) as Promise<void>,
    respondAgentPermission: (request: AgentPermissionResponseRequest) =>
      ipcRenderer.invoke(
        IpcChannels.RespondAgentPermission,
        request
      ) as Promise<void>,
    listAgentSkills: (request: AgentSessionCommandRequest) =>
      ipcRenderer.invoke(IpcChannels.ListAgentSkills, request) as Promise<void>,
    enqueueAgentMessage: (request: AgentQueueMessageRequest) =>
      ipcRenderer.invoke(
        IpcChannels.EnqueueAgentMessage,
        request
      ) as Promise<void>,
    dequeueAgentMessage: (request: AgentSessionCommandRequest) =>
      ipcRenderer.invoke(
        IpcChannels.DequeueAgentMessage,
        request
      ) as Promise<void>,
    getAgentQueue: (request: AgentSessionCommandRequest) =>
      ipcRenderer.invoke(IpcChannels.GetAgentQueue, request) as Promise<void>,
    clearAgentQueue: (request: AgentSessionCommandRequest) =>
      ipcRenderer.invoke(IpcChannels.ClearAgentQueue, request) as Promise<void>,
    removeAgentQueueMessage: (request: AgentRemoveFromQueueRequest) =>
      ipcRenderer.invoke(
        IpcChannels.RemoveAgentQueueMessage,
        request
      ) as Promise<void>,
    updateAgentQueueMessage: (request: AgentUpdateQueueMessageRequest) =>
      ipcRenderer.invoke(
        IpcChannels.UpdateAgentQueueMessage,
        request
      ) as Promise<void>,
    renameLocalFile: (fromPath, toPath) =>
      ipcRenderer.invoke(
        IpcChannels.RenameLocalFile,
        fromPath,
        toPath
      ) as Promise<RenameLocalFileResult>,
    trashLocalFile: (filePath) =>
      ipcRenderer.invoke(
        IpcChannels.TrashLocalFile,
        filePath
      ) as Promise<TrashLocalFileResult>,
    saveResolvedConflict: (filePath, content) =>
      ipcRenderer.invoke(
        IpcChannels.SaveResolvedConflict,
        filePath,
        content
      ) as Promise<SaveResolvedConflictResult>,
    writeFile: (filePath, content) =>
      ipcRenderer.invoke(
        IpcChannels.WriteFile,
        filePath,
        content
      ) as Promise<WriteFileResult>,
    stageFile: (filePath) =>
      ipcRenderer.invoke(IpcChannels.StageFile, filePath) as Promise<{
        success: boolean;
        error?: string;
      }>,
    unstageFile: (filePath) =>
      ipcRenderer.invoke(IpcChannels.UnstageFile, filePath) as Promise<{
        success: boolean;
        error?: string;
      }>,
    removeWorkspace: (workspaceId) =>
      ipcRenderer.invoke(IpcChannels.RemoveWorkspace, workspaceId) as Promise<{
        success: boolean;
        error?: string;
      }>,
    updateWorkspaceLabel: (workspaceId, label) =>
      ipcRenderer.invoke(
        IpcChannels.UpdateWorkspaceLabel,
        workspaceId,
        label
      ) as Promise<{
        success: boolean;
        error?: string;
      }>,
    checkWorkspacePath: (workspaceId) =>
      ipcRenderer.invoke(
        IpcChannels.CheckWorkspacePath,
        workspaceId
      ) as Promise<WorkspacePathStatus>,
    relocateWorkspace: (workspaceId, newPath) =>
      ipcRenderer.invoke(
        IpcChannels.RelocateWorkspace,
        workspaceId,
        newPath
      ) as Promise<RelocateWorkspaceResult>,
    updateAgentSessionLabel: (workspaceId, sessionId, label) =>
      ipcRenderer.invoke(
        IpcChannels.UpdateAgentSessionLabel,
        workspaceId,
        sessionId,
        label
      ) as Promise<boolean>,
    listBrowserProfiles: () =>
      ipcRenderer.invoke(IpcChannels.ListBrowserProfiles) as Promise<
        BrowserProfileInfo[]
      >,
    refreshBrowserProfiles: () =>
      ipcRenderer.invoke(IpcChannels.RefreshBrowserProfiles) as Promise<
        BrowserProfileInfo[]
      >,
    importBrowserProfile: (profileId: string) =>
      ipcRenderer.invoke(
        IpcChannels.ImportBrowserProfile,
        profileId
      ) as Promise<ImportBrowserProfileResult>,
    clearImportedBrowserProfile: (profileId: string) =>
      ipcRenderer.invoke(
        IpcChannels.ClearImportedBrowserProfile,
        profileId
      ) as Promise<{
        success: boolean;
        error?: string;
      }>,
    materializeBrowserRuntime: (request: MaterializeBrowserRuntimeRequest) =>
      ipcRenderer.invoke(
        IpcChannels.MaterializeBrowserRuntime,
        request
      ) as Promise<BrowserRuntimeState>,
    presentBrowserRuntime: (request: PresentBrowserRuntimeRequest) =>
      ipcRenderer.invoke(
        IpcChannels.PresentBrowserRuntime,
        request
      ) as Promise<BrowserRuntimeState>,
    navigateBrowserRuntime: (request: NavigateBrowserRuntimeRequest) =>
      ipcRenderer.invoke(
        IpcChannels.NavigateBrowserRuntime,
        request
      ) as Promise<BrowserRuntimeState>,
    captureBrowserRuntime: (lease: BrowserRuntimeLease) =>
      ipcRenderer.invoke(
        IpcChannels.CaptureBrowserRuntime,
        lease
      ) as Promise<BrowserRuntimeCapture>,
    hideBrowserRuntime: (request: HideBrowserRuntimeRequest) =>
      ipcRenderer.invoke(
        IpcChannels.HideBrowserRuntime,
        request
      ) as Promise<void>,
    closeBrowserRuntime: (lease: BrowserRuntimeLease) =>
      ipcRenderer.invoke(
        IpcChannels.CloseBrowserRuntime,
        lease
      ) as Promise<void>,
    promoteBrowserRuntimeScope: (request: PromoteBrowserRuntimeScopeRequest) =>
      ipcRenderer.invoke(
        IpcChannels.PromoteBrowserRuntimeScope,
        request
      ) as Promise<BrowserRuntimeLease[]>,
    disposeBrowserRuntimeScope: (conversationKey: ConversationKey) =>
      ipcRenderer.invoke(
        IpcChannels.DisposeBrowserRuntimeScope,
        conversationKey
      ) as Promise<void>,
    disposeBrowserRuntimeWorkspace: (workspaceId: string) =>
      ipcRenderer.invoke(
        IpcChannels.DisposeBrowserRuntimeWorkspace,
        workspaceId
      ) as Promise<void>,
    listMcpServers: (request: ListMcpServersRequest) =>
      ipcRenderer.invoke(IpcChannels.ListMcpServers, request) as Promise<
        McpServerInfo[]
      >,
    addMcpServer: (request: AddMcpServerRequest) =>
      ipcRenderer.invoke(IpcChannels.AddMcpServer, request) as Promise<{
        success: boolean;
        error?: string;
      }>,
    updateMcpServer: (request: UpdateMcpServerRequest) =>
      ipcRenderer.invoke(IpcChannels.UpdateMcpServer, request) as Promise<{
        success: boolean;
        error?: string;
      }>,
    removeMcpServer: (request: RemoveMcpServerRequest) =>
      ipcRenderer.invoke(IpcChannels.RemoveMcpServer, request) as Promise<{
        success: boolean;
        error?: string;
      }>,
    setMcpServerDisabled: (request: SetMcpServerDisabledRequest) =>
      ipcRenderer.invoke(IpcChannels.SetMcpServerDisabled, request) as Promise<{
        success: boolean;
        error?: string;
      }>,
    importMcpServers: (request: ImportMcpServersRequest) =>
      ipcRenderer.invoke(
        IpcChannels.ImportMcpServers,
        request
      ) as Promise<ImportMcpServersResult>,
    refreshMcpServers: (request: RefreshMcpServersRequest) =>
      ipcRenderer.invoke(
        IpcChannels.RefreshMcpServers,
        request
      ) as Promise<McpRuntimeRequestResult>,
    restartMcpServer: (request: RestartMcpServerRequest) =>
      ipcRenderer.invoke(
        IpcChannels.RestartMcpServer,
        request
      ) as Promise<McpRuntimeRequestResult>,
    mcpOAuthSignIn: (request: McpOAuthSignInRequest) =>
      ipcRenderer.invoke(
        IpcChannels.McpOAuthSignIn,
        request
      ) as Promise<McpOAuthSignInResult>,
    getMcpRuntimeServers: (request: GetMcpRuntimeServersRequest) =>
      ipcRenderer.invoke(IpcChannels.GetMcpRuntimeServers, request) as Promise<
        AgentMcpServer[]
      >,
    getMcpServerLogs: (request: GetMcpServerLogsRequest) =>
      ipcRenderer.invoke(IpcChannels.GetMcpServerLogs, request) as Promise<
        AgentMcpLogEntry[]
      >,
    getMcpBrowserStatus: () =>
      ipcRenderer.invoke(
        IpcChannels.GetMcpBrowserStatus
      ) as Promise<McpBrowserStatus>,
    setMcpBrowserEnabled: (enabled: boolean) =>
      ipcRenderer.invoke(
        IpcChannels.SetMcpBrowserEnabled,
        enabled
      ) as Promise<McpBrowserStatus>,
    getToolsetStates: () =>
      ipcRenderer.invoke(IpcChannels.GetToolsetStates) as Promise<
        Record<string, boolean>
      >,
    getDefaultAgentMode: () =>
      ipcRenderer.invoke(
        IpcChannels.GetDefaultAgentMode
      ) as Promise<DefaultAgentMode>,
    getSandboxSupport: () =>
      ipcRenderer.invoke(
        IpcChannels.GetSandboxSupport
      ) as Promise<SandboxSupport>,
    setDefaultAgentMode: (mode: DefaultAgentMode) =>
      ipcRenderer.invoke(
        IpcChannels.SetDefaultAgentMode,
        mode
      ) as Promise<DefaultAgentMode>,
    getNotificationSettings: () =>
      ipcRenderer.invoke(
        IpcChannels.GetNotificationSettings
      ) as Promise<NotificationSettings>,
    setNotificationSettings: (next: NotificationSettings) =>
      ipcRenderer.invoke(
        IpcChannels.SetNotificationSettings,
        next
      ) as Promise<NotificationSettings>,
    setToolsetEnabled: (toolsetId: string, enabled: boolean) =>
      ipcRenderer.invoke(
        IpcChannels.SetToolsetEnabled,
        toolsetId,
        enabled
      ) as Promise<Record<string, boolean>>,
    getExecBackendState: () =>
      ipcRenderer.invoke(
        IpcChannels.GetExecBackendState
      ) as Promise<ExecBackendState>,
    setExecBackend: (backend: BackendId) =>
      ipcRenderer.invoke(
        IpcChannels.SetExecBackend,
        backend
      ) as Promise<ExecBackendState>,
    getTerminalShellState: () =>
      ipcRenderer.invoke(
        IpcChannels.GetTerminalShellState
      ) as Promise<TerminalShellState>,
    setTerminalShell: (shell: TerminalShellId) =>
      ipcRenderer.invoke(
        IpcChannels.SetTerminalShell,
        shell
      ) as Promise<TerminalShellState>,
    respondConnector: (request: RespondConnectorRequest) =>
      ipcRenderer.invoke(
        IpcChannels.RespondConnector,
        request
      ) as Promise<void>,
    listConnectorRequests: (conversationKey: ConversationKey) =>
      ipcRenderer.invoke(
        IpcChannels.ListConnectorRequests,
        conversationKey
      ) as Promise<ConnectorRequest[]>,
    listBrowserPermissionRequests: (conversationKey: ConversationKey) =>
      ipcRenderer.invoke(
        IpcChannels.ListBrowserPermissionRequests,
        conversationKey
      ) as Promise<BrowserPermissionRequest[]>,
    setBrowserApproval: (approval: BrowserApproval) =>
      ipcRenderer.invoke(
        IpcChannels.SetBrowserApproval,
        approval
      ) as Promise<McpBrowserStatus>,
    clearBrowserData: (request?: ClearBrowserDataRequest) =>
      ipcRenderer.invoke(
        IpcChannels.ClearBrowserData,
        request
      ) as Promise<ClearBrowserDataResult>,
    respondBrowserPermission: (request: RespondBrowserPermissionRequest) =>
      ipcRenderer.invoke(
        IpcChannels.RespondBrowserPermission,
        request
      ) as Promise<void>,
    setAgentSessionModel: (
      workspaceId: string,
      sessionId: string,
      model: string
    ) =>
      ipcRenderer.invoke(
        IpcChannels.SetAgentSessionModel,
        workspaceId,
        sessionId,
        model
      ) as Promise<boolean>,
    listMemories: () =>
      ipcRenderer.invoke(IpcChannels.ListMemories) as Promise<MemorySnapshot>,
    getCustomInstructions: () =>
      ipcRenderer.invoke(IpcChannels.GetCustomInstructions) as Promise<string>,
    setCustomInstructions: (text: string) =>
      ipcRenderer.invoke(
        IpcChannels.SetCustomInstructions,
        text
      ) as Promise<string>,
    forgetMemory: (request: ForgetMemoryRequest) =>
      ipcRenderer.invoke(
        IpcChannels.ForgetMemory,
        request
      ) as Promise<MemorySnapshot>,
    forgetAllMemories: (target: MemoryTargetId) =>
      ipcRenderer.invoke(
        IpcChannels.ForgetAllMemories,
        target
      ) as Promise<MemorySnapshot>,
    listBotMemories: () =>
      ipcRenderer.invoke(IpcChannels.ListBotMemories) as Promise<
        BotMemoryView[]
      >,
    forgetBotMemory: (request: ForgetBotMemoryRequest) =>
      ipcRenderer.invoke(IpcChannels.ForgetBotMemory, request) as Promise<
        BotMemoryView[]
      >,
    clearBotMemory: (botId: string) =>
      ipcRenderer.invoke(IpcChannels.ClearBotMemory, botId) as Promise<
        BotMemoryView[]
      >,
    readTranscript: (sessionId: string) =>
      ipcRenderer.invoke(IpcChannels.ReadTranscript, sessionId) as Promise<
        TranscriptSegment[]
      >,
    writeTranscript: (sessionId: string, segments: TranscriptSegment[]) =>
      ipcRenderer.invoke(
        IpcChannels.WriteTranscript,
        sessionId,
        segments
      ) as Promise<void>,
    getDeviceStatus: () =>
      ipcRenderer.invoke(IpcChannels.GetDeviceStatus) as Promise<DeviceStatus>,
    listLocalDevices: () =>
      ipcRenderer.invoke(IpcChannels.ListLocalDevices) as Promise<
        LocalDeviceInfo[]
      >,
    captureDeviceScreenshot: (request: CaptureDeviceScreenshotRequest) =>
      ipcRenderer.invoke(
        IpcChannels.CaptureDeviceScreenshot,
        request
      ) as Promise<CaptureDeviceScreenshotResult>,
    bootLocalDevice: (request: BootLocalDeviceRequest) =>
      ipcRenderer.invoke(
        IpcChannels.BootLocalDevice,
        request
      ) as Promise<BootLocalDeviceResult>,
    createLocalDevice: (request: CreateLocalDeviceRequest) =>
      ipcRenderer.invoke(
        IpcChannels.CreateLocalDevice,
        request
      ) as Promise<CreateLocalDeviceResult>,
    refreshDeviceStatus: () =>
      ipcRenderer.invoke(
        IpcChannels.RefreshDeviceStatus
      ) as Promise<DeviceStatus>,
    setDevicesEnabled: (enabled: boolean) =>
      ipcRenderer.invoke(
        IpcChannels.SetDevicesEnabled,
        enabled
      ) as Promise<DeviceStatus>,
    setDevicesApproval: (approval: BrowserApproval) =>
      ipcRenderer.invoke(
        IpcChannels.SetDevicesApproval,
        approval
      ) as Promise<DeviceStatus>,
    getDeviceProjectInfo: () =>
      ipcRenderer.invoke(
        IpcChannels.GetDeviceProjectInfo
      ) as Promise<DeviceProjectInfo>,
    interactLocalDevice: (request: InteractLocalDeviceRequest) =>
      ipcRenderer.invoke(
        IpcChannels.InteractLocalDevice,
        request
      ) as Promise<InteractLocalDeviceResult>,
    buildAndRunLocalDevice: (request: BuildAndRunLocalDeviceRequest) =>
      ipcRenderer.invoke(
        IpcChannels.BuildAndRunLocalDevice,
        request
      ) as Promise<BuildAndRunLocalDeviceResult>,
    startDeviceStream: (request: StartDeviceStreamRequest) =>
      ipcRenderer.invoke(
        IpcChannels.StartDeviceStream,
        request
      ) as Promise<StartDeviceStreamResult>,
    stopDeviceStream: (streamId?: number) =>
      ipcRenderer.invoke(
        IpcChannels.StopDeviceStream,
        streamId
      ) as Promise<void>,
    getSimulatorWindowSource: (request: GetSimulatorWindowSourceRequest) =>
      ipcRenderer.invoke(
        IpcChannels.GetSimulatorWindowSource,
        request
      ) as Promise<GetSimulatorWindowSourceResult>,
    installMaestro: () =>
      ipcRenderer.invoke(
        IpcChannels.InstallMaestro
      ) as Promise<InstallMaestroResult>,
    streamDeviceTouch: (request: StreamDeviceTouchRequest) =>
      ipcRenderer.send(IpcChannels.StreamDeviceTouch, request),
    streamDeviceKey: (request: StreamDeviceKeyRequest) =>
      ipcRenderer.send(IpcChannels.StreamDeviceKey, request),
    openScreenRecordingSettings: () =>
      ipcRenderer.invoke(
        IpcChannels.OpenScreenRecordingSettings
      ) as Promise<void>,
    openAccessibilitySettings: () =>
      ipcRenderer.invoke(
        IpcChannels.OpenAccessibilitySettings
      ) as Promise<void>,
    getMessagingSnapshot: () =>
      ipcRenderer.invoke(
        IpcChannels.GetMessagingSnapshot
      ) as Promise<MessagingSnapshot>,
    updateMessagingPlatform: (request: UpdateMessagingPlatformRequest) =>
      ipcRenderer.invoke(
        IpcChannels.UpdateMessagingPlatform,
        request
      ) as Promise<MessagingSnapshot>,
    decideMessagingPairing: (request: MessagingPairingDecisionRequest) =>
      ipcRenderer.invoke(
        IpcChannels.DecideMessagingPairing,
        request
      ) as Promise<MessagingSnapshot>,
    updateMessagingSettings: (request: UpdateMessagingSettingsRequest) =>
      ipcRenderer.invoke(
        IpcChannels.UpdateMessagingSettings,
        request
      ) as Promise<MessagingSnapshot>,
    showMessagingLogin: (platformId: MessagingPlatformId) =>
      ipcRenderer.invoke(
        IpcChannels.ShowMessagingLogin,
        platformId
      ) as Promise<void>,
    pairSharedChannel: (platformId: MessagingPlatformId) =>
      ipcRenderer.invoke(
        IpcChannels.PairSharedChannel,
        platformId
      ) as Promise<MessagingSnapshot>,
    unlinkSharedChannel: (platformId: MessagingPlatformId) =>
      ipcRenderer.invoke(
        IpcChannels.UnlinkSharedChannel,
        platformId
      ) as Promise<MessagingSnapshot>,
    openSharedChannelLink: (
      platformId: MessagingPlatformId,
      target?: "install" | "dm"
    ) =>
      ipcRenderer.invoke(
        IpcChannels.OpenSharedChannelLink,
        platformId,
        target
      ) as Promise<void>,
    onDeviceStreamChunk: (callback) => {
      const handler = (_event: IpcRendererEvent, chunk: DeviceStreamChunk) =>
        callback(chunk);
      ipcRenderer.on("agent:device-stream-chunk", handler);
      return () =>
        ipcRenderer.removeListener("agent:device-stream-chunk", handler);
    },
    onEvent: (callback) => {
      // Node's default cap is 10 and this one channel legitimately has more
      // subscribers than that (each is a mounted component that unsubscribes on
      // unmount), so the leak warning here is a false positive. Raised once,
      // where the channel is owned, rather than per-subscriber.
      if (ipcRenderer.getMaxListeners() < 64) ipcRenderer.setMaxListeners(64);
      const handler = (_event: IpcRendererEvent, payload: IpcEvent) =>
        callback(payload);
      ipcRenderer.on(IpcChannels.Event, handler);
      return () => ipcRenderer.removeListener(IpcChannels.Event, handler);
    },
  };
};
