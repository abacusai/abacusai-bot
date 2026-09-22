export const workspaceQueryKeys = {
  all: ["local-code"] as const,
  metadata: ["local-code", "metadata"] as const,
  activeWorkspaceId: ["local-code", "active-workspace-id"] as const,
  /** The one folder bots work in; settled in advance, not asked for. */
  botWorkspaceId: ["local-code", "bot-workspace-id"] as const,
  workspaceSnapshot: (workspaceId: string) =>
    ["local-code", "workspace-snapshot", workspaceId] as const,

  workspacePathStatusRoot: ["local-code", "workspace-path-status"] as const,
  workspacePathStatus: (workspaceId: string) =>
    ["local-code", "workspace-path-status", workspaceId] as const,

  agentRunsRoot: ["local-code", "agent-runs"] as const,
  agentRuns: () => ["local-code", "agent-runs"] as const,

  worktreesRoot: ["local-code", "worktrees"] as const,
  worktrees: (workspaceId: string) =>
    ["local-code", "worktrees", workspaceId] as const,

  gitStateRoot: ["local-code", "workspace-git-state"] as const,
  gitState: (workspaceId: string) =>
    ["local-code", "workspace-git-state", workspaceId] as const,

  fileTreeRootRoot: ["local-code", "workspace-file-tree-root"] as const,
  fileTreeRoot: (workspaceId: string) =>
    ["local-code", "workspace-file-tree-root", workspaceId] as const,

  fileTreeChildrenRoot: ["local-code", "workspace-file-tree-children"] as const,
  fileTreeChildren: (workspaceId: string) =>
    ["local-code", "workspace-file-tree-children", workspaceId] as const,
  fileTreeDirectoryChildren: (workspaceId: string, directoryId: string) =>
    [
      "local-code",
      "workspace-file-tree-children",
      workspaceId,
      directoryId,
    ] as const,

  gitDiffRoot: ["local-code", "workspace-git-diff"] as const,
  gitDiffFile: (workspaceId: string, filePath: string) =>
    ["local-code", "workspace-git-diff", workspaceId, filePath] as const,
  gitDiff: (
    workspaceId: string,
    filePath: string,
    scope: "staged" | "unstaged" = "unstaged"
  ) =>
    ["local-code", "workspace-git-diff", workspaceId, filePath, scope] as const,

  gitChangeStatsRoot: ["local-code", "workspace-git-change-stats"] as const,
  gitChangeStatsFile: (workspaceId: string, filePath: string) =>
    [
      "local-code",
      "workspace-git-change-stats",
      workspaceId,
      filePath,
    ] as const,
  gitChangeStats: (
    workspaceId: string,
    filePath: string,
    scope: "staged" | "unstaged" | "all" = "all"
  ) =>
    [
      "local-code",
      "workspace-git-change-stats",
      workspaceId,
      filePath,
      scope,
    ] as const,

  fileMetadataRoot: ["local-code", "workspace-file-metadata"] as const,
  fileMetadata: (workspaceId: string, filePath: string) =>
    ["local-code", "workspace-file-metadata", workspaceId, filePath] as const,

  fileMentionSearch: (workspaceId: string, query: string) =>
    ["local-code", "file-mention-search", workspaceId, query] as const,

  conflictFileContents: (workspacePath: string, filePath: string) =>
    ["local-code", "conflict-file-contents", workspacePath, filePath] as const,

  gitBranchesRoot: ["local-code", "git-branches"] as const,
  gitBranches: (workspaceId?: string, sessionId?: string) =>
    workspaceId && sessionId
      ? (["local-code", "git-branches", workspaceId, sessionId] as const)
      : workspaceId
        ? (["local-code", "git-branches", workspaceId] as const)
        : (["local-code", "git-branches"] as const),

  gitCurrentBranchRoot: ["local-code", "git-current-branch"] as const,
  gitCurrentBranch: (workspaceId?: string, sessionId?: string) =>
    workspaceId && sessionId
      ? (["local-code", "git-current-branch", workspaceId, sessionId] as const)
      : workspaceId
        ? (["local-code", "git-current-branch", workspaceId] as const)
        : (["local-code", "git-current-branch"] as const),

  prInfoRoot: ["local-code", "pr-info"] as const,
  prInfo: (workspaceId?: string, sessionId?: string) =>
    workspaceId && sessionId
      ? (["local-code", "pr-info", workspaceId, sessionId] as const)
      : workspaceId
        ? (["local-code", "pr-info", workspaceId] as const)
        : (["local-code", "pr-info"] as const),

  modelBots: ["local-code", "model-bots"] as const,
  appSettings: ["local-code", "app-settings"] as const,

  deviceStatus: ["local-code", "device-status"] as const,
  // Keyed by workspace: what the project builds for (iOS / Android) is a
  // property of the active workspace, so switching workspaces must refetch.
  deviceProjectInfo: (workspaceId?: string) =>
    workspaceId != null
      ? (["local-code", "device-project-info", workspaceId] as const)
      : (["local-code", "device-project-info"] as const),
  localDevicesRoot: ["local-code", "local-devices"] as const,
  deviceScreenshot: (platform: string, deviceId: string) =>
    ["local-code", "device-screenshot", platform, deviceId] as const,

  agentSessionsRoot: ["local-code", "agent-sessions"] as const,
  agentSessions: (workspaceId: string) =>
    ["local-code", "agent-sessions", workspaceId] as const,
  allAgentSessions: ["local-code", "all-agent-sessions"] as const,
  bots: ["local-code", "bots"] as const,
  botChatPreviews: ["local-code", "bots", "chat-previews"] as const,
  botSenderChats: ["local-code", "bots", "sender-chats"] as const,
  routines: ["local-code", "routines"] as const,
  routineRuns: (routineId: string) =>
    ["local-code", "routines", "runs", routineId] as const,

  sessionArtifacts: ["local-code", "session-artifacts"] as const,
  memories: ["local-code", "memories"] as const,
  customInstructions: ["local-code", "custom-instructions"] as const,
  usageSnapshot: ["local-code", "usage-snapshot"] as const,
  abacusAccount: ["local-code", "abacus-account"] as const,
  referralSummary: ["local-code", "referral-summary"] as const,

  cliSessionStateRoot: ["local-code", "cli-session-state"] as const,
  cliSessionState: (workspaceId: string, sessionId: string) =>
    ["local-code", "cli-session-state", workspaceId, sessionId] as const,

  sessionHistoryRoot: ["local-code", "session-history"] as const,
  sessionHistory: (conversationId: string) =>
    ["local-code", "session-history", conversationId] as const,

  sessionTurnStateRoot: ["local-code", "session-turn-state"] as const,
  sessionTurnState: (sessionId: string) =>
    ["local-code", "session-turn-state", sessionId] as const,

  browserProfiles: ["local-code", "browser-profiles"] as const,
  previewHtmlSource: (filePath: string, version = 0) =>
    ["local-code", "preview-html-source", filePath, version] as const,
  previewImage: (filePath: string, version = 0) =>
    ["local-code", "preview-image", filePath, version] as const,
  previewPptx: (filePath: string, version = 0) =>
    ["local-code", "preview-pptx", filePath, version] as const,
};

export const LOCAL_CODE_QUERY_STALE_TIMES = {
  metadata: 5_000,
  agentRuns: 0, // invalidation-driven
  worktrees: 30_000, // git-dependent, moderate cache
  gitState: 10_000,
  fileTreeRoot: 15_000,
  fileTreeDirectoryChildren: 60_000,
  gitDiff: 30_000,
  gitChangeStats: 30_000,
  fileMetadata: 30_000,
  gitBranches: 30_000,
  gitCurrentBranch: 5_000,
  prInfo: 60_000, // matches the CLI's PR poll interval
  cliSessionState: 0, // invalidation-driven
  sessionTurnState: 0, // invalidation-driven (event from main)
} as const;
