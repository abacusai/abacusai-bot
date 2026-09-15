import { GATEWAY_SERVER_NAME } from "@abacus-ai/connectors/registry";

import type { AgentMode, AgentStatus, SkillMetadata } from "./agent-types";
import type {
  BotChangeNotice,
  Bot,
  BotChatHandle,
  BotCreateInput,
  BotUpdateInput,
} from "./bots";
import type {
  ConversationKey,
  ConversationRef,
  DraftConversationRef,
  SessionConversationRef,
} from "./conversation-scope";
import type { BackendId, BackendStatus } from "./exec-backends";
import type {
  MessagingPairingDecisionRequest,
  MessagingPlatformId,
  MessagingSnapshot,
  UpdateMessagingPlatformRequest,
  UpdateMessagingSettingsRequest,
} from "./messaging";
import type { ModelAvailability } from "./models";
import type {
  Routine,
  RoutineCreateInput,
  RoutineListItem,
  RoutineUpdateInput,
} from "./routines";
import type { AbacusBotSettings } from "./settings";

// 'deleted' is a tombstone: the workspace was removed by the user but its
// sessions are kept readable. It can't run an agent or accept new sessions.
type WorkspaceItemStatus = "active" | "idle" | "wip" | "deleted";
type UtilityTabId = "explorer" | "terminal" | "agents";
type AgentRunStatus = "queued" | "running" | "completed" | "error" | "idle";

// Reported rather than swallowed: a click that produces nothing visible looks
// like a broken app. `reason` is a code the renderer translates.
export type OpenFilePathResult =
  | { outcome: "opened" }
  /** Shown in the file manager instead, because opening it would run it. */
  | { outcome: "revealed" }
  | { outcome: "refused"; reason: "invalid" | "missing" | "outside" };

export interface WorkspaceListItem {
  id: string;
  label: string;
  description: string;
  status: WorkspaceItemStatus;
  path?: string;
  isRemote?: boolean;
  /** "auto": the app's folder for chats with no project; "routine": one routine's folder, kept out of pickers. */
  kind?: "auto" | "routine" | "bot";
}

export interface FileTreeNode {
  id: string;
  name: string;
  absolutePath: string;
  relativePath: string;
  kind: "file" | "directory";
  hasChildren: boolean;
  gitStatus?: string;
  gitDirtyState?: "dirty";
  children?: FileTreeNode[];
}

export type GitDiffScope = "staged" | "unstaged";
export type GitChangeStatsScope = GitDiffScope | "all";

export interface GitChangeItem {
  path: string;
  status: string;
  stagedStatus?: string | null;
  unstagedStatus?: string | null;
  additions?: number | null;
  deletions?: number | null;
}

/** A checkout reported by `git worktree list`, scoped to one workspace repo. */
export interface WorktreeListItem {
  /** Stable opaque id derived from the canonical checkout path. */
  id: string;
  name: string;
  path: string;
  branch: string | null;
  isCurrent: boolean;
  isManaged: boolean;
}

export type WorktreeDraftEnvironment =
  | { kind: "current" }
  | { kind: "existing"; worktreeId: string }
  | { kind: "new"; baseRef: string; name?: string };

export interface ListWorktreesRequest {
  workspaceId: string;
}

export interface ListWorktreesResult {
  success: boolean;
  worktrees: WorktreeListItem[];
  error?: string;
}

export interface CreateWorktreeRequest {
  workspaceId: string;
  baseRef: string;
  name?: string;
}

export interface CreateWorktreeResult {
  success: boolean;
  worktree?: WorktreeListItem;
  error?: string;
}

export interface SetSessionWorktreeRequest {
  workspaceId: string;
  sessionId: string;
  worktreeId: string | null;
}

export interface SetSessionWorktreeResult {
  success: boolean;
  session?: AgentSessionListItem;
  error?: string;
}

/** Creates and attaches a worktree as one operation before the first send. */
export interface MaterializeSessionWorktreeRequest extends CreateWorktreeRequest {
  sessionId: string;
}

export interface MaterializeSessionWorktreeResult {
  success: boolean;
  worktree?: WorktreeListItem;
  session?: AgentSessionListItem;
  error?: string;
}

export interface AgentRunSnapshot {
  id: string;
  label: string;
  status: AgentRunStatus;
  progressLabel: string;
  detail: string;
  children?: AgentRunSnapshot[];
}

export interface WorkspaceState {
  workspaces: WorkspaceListItem[];
  activeWorkspaceId: string | null;
  worktrees: WorkspaceListItem[];
  sessions: WorkspaceListItem[];
  chats: WorkspaceListItem[];
  utilityTabs: UtilityTabId[];
  agentRuns: AgentRunSnapshot[];
  fileTree: FileTreeNode[];
  gitChanges: GitChangeItem[];
  gitDiffHunks: string[];
  gitAvailable: boolean;
  gitStatusMessage: string;
  materialIconsBasePath: string | null;
  lastUpdatedAt: string;
}

export interface WorkspaceMetadataSnapshot {
  workspaces: WorkspaceListItem[];
  activeWorkspaceId: string | null;
  materialIconsBasePath: string | null;
  lastUpdatedAt: string;
}

export interface GitStateSnapshot {
  gitChanges: GitChangeItem[];
  gitChangeSections?: GitChangeSectionsSnapshot;
  gitAvailable: boolean;
  gitStatusMessage: string;
  lastUpdatedAt: string;
}

export interface GitChangeStatsSnapshot {
  additions: number | null;
  deletions: number | null;
}

export interface GitChangeSectionsSnapshot {
  staged: GitChangeItem[];
  unstaged: GitChangeItem[];
  merged: GitChangeItem[];
}

export interface FileTreeRootSnapshot {
  fileTree: FileTreeNode[];
  lastUpdatedAt: string;
}

type TerminalSessionStatus = "stopped" | "starting" | "running";

export interface TerminalSessionSnapshot {
  terminalId: string;
  conversationKey: ConversationKey;
  conversation: ConversationRef;
  generation: number;
  workspaceId: string;
  status: TerminalSessionStatus;
  visible: boolean;
  cols: number;
  rows: number;
  exitedAt?: string | null;
  exitCode?: number | null;
}

export interface StartTerminalSessionRequest {
  /** Stable identity for one terminal tab within the conversation. */
  terminalId?: string;
  conversationKey: ConversationKey;
  conversation: ConversationRef;
  /** Null attaches to the current generation or creates the first one. */
  generation: number | null;
  cols: number;
  rows: number;
}

export interface StartTerminalSessionResult {
  success: boolean;
  error?: string;
  created: boolean;
  state: TerminalSessionSnapshot;
  initialOutput: string;
}

export interface TerminalRuntimeRequest {
  terminalId?: string;
  conversationKey: ConversationKey;
  generation: number;
  /** Dispose the PTY instead of merely marking its tab hidden. */
  close?: boolean;
}

export interface WriteTerminalInputRequest extends TerminalRuntimeRequest {
  data: string;
}

export interface ResizeTerminalSessionRequest extends TerminalRuntimeRequest {
  cols: number;
  rows: number;
}

export interface PromoteTerminalSessionScopeRequest {
  draftConversationKey: ConversationKey;
  draftConversation: DraftConversationRef;
  sessionConversationKey: ConversationKey;
  sessionConversation: SessionConversationRef;
}

export interface StopTerminalSessionResult {
  success: boolean;
  error?: string;
}

export type AgentSessionStatus =
  | "stopped"
  | "starting"
  | "running"
  | "stopping"
  | "error";

/** Whether a session's shell commands run under the kernel sandbox. */
export interface SandboxStatus {
  active: boolean;
  /** Why not, in a sentence, when `active` is false. */
  reason: string | null;
}

export interface AgentSessionSnapshot {
  workspaceId: string;
  sessionId: string;
  status: AgentSessionStatus;
  pid: number | null;
  startedAt: string | null;
  stoppedAt: string | null;
  exitCode: number | null;
  error: string | null;
  model: string | null;
  mode: AgentMode | null;
  agentStatus: AgentStatus;
  /** Unknown until the agent reports it at startup. */
  sandbox?: SandboxStatus | null;
}

/** The last message in a bot's chat, as its sidebar row shows it. */
export interface BotChatPreview {
  text: string;
  at: number | null;
}

/** A bot's auto-reply conversation with one remote sender. */
export interface BotSenderChat {
  botId: string;
  workspaceId: string;
  sessionId: string;
  platform: string;
  senderName: string;
  /** The reply target; a group's id for a group. */
  chatId: string | null;
  /** Set only for a one-to-one chat. */
  userId: string | null;
  /** Null when no grant is on file. */
  autoReply: "approved" | "paused" | null;
}

export type RoutineRunOutcome = "running" | "completed" | "failed";

/** One fire of a routine: the session it ran in and how it went. */
export interface RoutineRunItem {
  sessionId: string;
  workspaceId: string;
  startedAt: string;
  updatedAt: string;
  outcome: RoutineRunOutcome;
  trigger: string | null;
}

/** A bot conversation's parentage, stamped on the session at mint. */
export interface SessionOwner {
  kind: "bot";
  botId: string;
  role: "forever" | "sender" | "routine";
  /** The find-or-reuse key (sender/routine id), null for forever. */
  key: string | null;
  platform?: string | null;
  senderName?: string | null;
}

export interface AgentSessionListItem {
  id: string;
  workspaceId: string;
  label: string;
  conversationId: string | null;
  createdAt: string;
  updatedAt: string;
  status: AgentSessionStatus;
  agentStatus: AgentStatus;
  model: string | null;
  mode: AgentMode | null;
  worktreeId: string | null;
  worktreePath: string | null;
  worktreeBranch: string | null;
  /** Set when a routine fire minted this session; such sessions are read-only. */
  routineId: string | null;
  /** Routine runs only: "running" until the turn ends. */
  runOutcome: RoutineRunOutcome | null;
  /** Routine runs only: what fired it. */
  runTrigger: string | null;
  /** The routine this session edits, when it is the editor turn behind a routine page. Hidden from lists. */
  editorFor: string | null;
  /** Derived from `owner` (plus legacy stamps); hides the session from the Sessions tree. */
  botOwned: boolean;
  /**
   * Written atomically at mint, so a registry row lost to a race cannot
   * orphan a conversation: the session itself says whose it is.
   */
  owner: SessionOwner | null;
}

export interface StartAgentSessionRequest {
  workspaceId: string;
  sessionId: string;
  startupTimeoutMs?: number;
  /** Passed as --model at spawn, avoiding the set_model race. */
  model?: string | null;
  /** Applied right after 'ready', avoiding the set_mode race. */
  mode?: AgentMode | null;
}

export interface WorkspacePathStatus {
  workspaceId: string;
  path: string | null;
  /** False only when the folder is provably gone or no longer a directory. */
  exists: boolean;
}

export interface RelocateWorkspaceResult {
  success: boolean;
  error?: string;
}

/** Session `error` prefix when the workspace folder is gone: `<marker>:<absPath>`. */
export const WORKSPACE_MISSING_ERROR = "WORKSPACE_FOLDER_MISSING";

export interface StartAgentSessionResult {
  success: boolean;
  created: boolean;
  state: AgentSessionSnapshot;
  error?: string;
}

export interface StopAgentSessionResult {
  success: boolean;
  state: AgentSessionSnapshot;
  error?: string;
}

export interface SendAgentMessageRequest {
  workspaceId: string;
  sessionId: string;
  message: string;
  attachments?: Array<{
    id: string;
    name: string;
    mimeType: string;
    size: number;
  }>;
  docIds?: string[];
  conversationId?: string;
  activeSkills?: string[];
}

export interface AgentSessionCommandRequest {
  workspaceId: string;
  sessionId: string;
}

export interface AgentSetModeRequest extends AgentSessionCommandRequest {
  mode: AgentMode;
}

export interface AgentSetModelRequest extends AgentSessionCommandRequest {
  model: string;
}

export interface AgentPermissionResponseRequest extends AgentSessionCommandRequest {
  permissionId: string;
  decision: unknown;
}

export interface AgentSwitchConversationRequest extends AgentSessionCommandRequest {
  conversationId: string;
}

export interface AgentQueueMessageRequest extends AgentSessionCommandRequest {
  message: string;
  hidden?: boolean;
}

export interface AgentRemoveFromQueueRequest extends AgentSessionCommandRequest {
  index: number;
}

export interface AgentUpdateQueueMessageRequest extends AgentSessionCommandRequest {
  index: number;
  message: string;
}

export type SessionTurnPhase =
  | "idle"
  | "pending"
  | "streaming"
  | "waiting_permission"
  | "error";

export interface SessionTurnStateSnapshot {
  sessionId: string;
  workspaceId: string;
  phase: SessionTurnPhase;
  isBusy: boolean;
  updatedAt: string;
}

// Something a session produced or reached, never merely read: forty opened
// files would bury the three it wrote.
export type SessionArtifactKind = "file" | "image" | "link";

export interface SessionArtifact {
  /** `${sessionId}::${location}`, one row per location per session. */
  id: string;
  workspaceId: string;
  sessionId: string;
  kind: SessionArtifactKind;
  /** Basename for a file, host + path for a link. */
  title: string;
  /** Absolute path on disk, or the URL. */
  location: string;
  toolName: string;
  createdAt: string;
  updatedAt: string;
}

interface IpcEventBase {
  emittedAt: string;
}

export type IpcEvent =
  | ({ type: "metadata-updated" } & IpcEventBase)
  | ({ type: "git-state-updated" } & IpcEventBase)
  | ({ type: "file-tree-root-updated" } & IpcEventBase)
  | ({
      type: "terminal-output";
      terminalId: string;
      conversationKey: ConversationKey;
      conversation: ConversationRef;
      generation: number;
      workspaceId: string;
      data: string;
    } & IpcEventBase)
  | ({
      type: "terminal-exited";
      terminalId: string;
      conversationKey: ConversationKey;
      conversation: ConversationRef;
      generation: number;
      workspaceId: string;
      exitCode: number | null;
      signal: number | null;
    } & IpcEventBase)
  | ({
      type: "terminal-state-updated";
      conversationKey: ConversationKey;
      conversation: ConversationRef;
      generation: number;
      workspaceId: string;
      state: TerminalSessionSnapshot;
    } & IpcEventBase)
  | ({
      type: "local-cli-state-updated";
      workspaceId: string;
      sessionId: string;
      state: AgentSessionSnapshot;
    } & IpcEventBase)
  // The agent stream, verbatim; main performs no translation. `unknown` because
  // the renderer narrows it against the vendored agent types, and the legacy
  // `DesktopEvent` union would mistype it.
  | ({
      type: "local-cli-ndjson";
      workspaceId: string;
      sessionId: string;
      payload: unknown;
    } & IpcEventBase)
  | ({
      type: "local-cli-system-ready";
      workspaceId: string;
      sessionId: string;
    } & IpcEventBase)
  | ({
      type: "local-cli-skills-loaded";
      workspaceId: string;
      sessionId: string;
      skills: SkillMetadata[];
    } & IpcEventBase)
  | ({
      type: "local-cli-session-created";
      workspaceId: string;
      sessionId: string;
      session: AgentSessionListItem;
    } & IpcEventBase)
  | ({
      type: "local-cli-session-removed";
      workspaceId: string;
      sessionId: string;
    } & IpcEventBase)
  | ({
      type: "local-cli-session-updated";
      workspaceId: string;
      sessionId: string;
      label: string;
    } & IpcEventBase)
  | ({
      type: "local-cli-session-conversation-id-updated";
      workspaceId: string;
      sessionId: string;
      conversationId: string | null;
    } & IpcEventBase)
  | ({
      type: "local-cli-session-model-updated";
      workspaceId: string;
      sessionId: string;
      model: string;
    } & IpcEventBase)
  | ({
      type: "session-turn-state-updated";
      workspaceId: string;
      sessionId: string;
      state: SessionTurnStateSnapshot;
    } & IpcEventBase)
  | ({ type: "session-artifacts-updated" } & IpcEventBase)
  | ({
      type: "mcp-open-preview";
      url?: string;
      /** Absent for a caller with no session. */
      conversationKey?: ConversationKey;
    } & IpcEventBase)
  | ({
      type: "browser-runtime-materialized";
      conversationKey: ConversationKey;
      resourceId: string;
      url: string;
    } & IpcEventBase)
  | ({
      type: "preview-open";
      path: string;
      /** The conversation that presented it; the item lands in that pane only. */
      conversationKey?: ConversationKey;
    } & IpcEventBase)
  | ({ type: "mcp-cursor-move"; x: number; y: number } & IpcEventBase)
  | ({ type: "mcp-cursor-click" } & IpcEventBase)
  | ({ type: "mcp-cursor-hide" } & IpcEventBase)
  | ({
      type: "browser-permission-request";
      request: BrowserPermissionRequest;
    } & IpcEventBase)
  | ({ type: "connector-request"; request: ConnectorRequest } & IpcEventBase)
  | ({ type: "connector-cleared"; requestId: string } & IpcEventBase)
  // Something changed a connector's status (connected, disconnected, a key
  // stored); the renderer re-reads the statuses once.
  | ({ type: "connector-status-changed" } & IpcEventBase)
  | ({
      type: "browser-permission-cleared";
      requestId: string;
    } & IpcEventBase)
  | ({
      type: "browser-status-updated";
      status: McpBrowserStatus;
    } & IpcEventBase)
  | ({
      type: "browser-runtime-state-updated";
      state: BrowserRuntimeState;
    } & IpcEventBase)
  | ({
      type: "device-status-updated";
      status: DeviceStatus;
    } & IpcEventBase)
  | ({
      type: "device-build-state";
      phase: DeviceBuildPhase;
      error?: string;
    } & IpcEventBase)
  | ({
      type: "mcp-runtime-servers";
      workspaceId: string;
      sessionId: string;
      servers: AgentMcpServer[];
    } & IpcEventBase)
  | ({
      type: "mcp-runtime-status";
      workspaceId: string;
      sessionId: string;
      serverId: string;
      status: AgentMcpStatus;
      error?: string;
      authUrl?: string;
      pid?: number;
      ts: string;
    } & IpcEventBase)
  | ({
      type: "mcp-runtime-log";
      workspaceId: string;
      sessionId: string;
      entry: AgentMcpLogEntry;
    } & IpcEventBase)
  | ({
      type: "mcp-runtime-refresh-failed";
      workspaceId: string;
      sessionId: string;
      error: string;
      ts: string;
    } & IpcEventBase)
  | ({
      type: "mcp-runtime-restart-failed";
      workspaceId: string;
      sessionId: string;
      serverId: string;
      error: string;
      ts: string;
    } & IpcEventBase)
  // Coarse on purpose: the pane refetches its whole snapshot; none are hot paths.
  | ({ type: "messaging-updated" } & IpcEventBase)
  | ({ type: "bots-updated" } & IpcEventBase)
  | ({ type: "cronjobs-updated" } & IpcEventBase)
  // The composer echoes the user's own messages; a turn driven from main has
  // nothing to render it, so this is that echo.
  | ({
      type: "messaging-user-message";
      workspaceId: string;
      sessionId: string;
      content: string;
    } & IpcEventBase)
  // The words a messaging turn actually sent. The turn's own text is withheld
  // from a bot transcript, so this is what stands in its place.
  | ({
      type: "messaging-agent-message";
      workspaceId: string;
      sessionId: string;
      content: string;
    } & IpcEventBase)
  // A credential was stored or removed by any surface. Onboarding overlays an
  // already-mounted app, so credential-derived state must re-read on this.
  | ({
      type: "credentials-changed";
      provider: string;
      /** Present when main knows whether the provider now has a credential. */
      configured?: boolean;
    } & IpcEventBase)
  // A sign-out stashed every session or a sign-in restored a stash; no
  // per-session event can say so.
  | ({ type: "sessions-reloaded" } & IpcEventBase);

/** The key itself never leaves main. */
export type OpenRouterAuthOutcome =
  | { ok: true }
  | { ok: false; error: string; cancelled?: boolean };
/** Same contract: the key never leaves main. */
export type AbacusAuthOutcome =
  | { ok: true }
  | { ok: false; error: string; cancelled?: boolean };

/** Sessions are stashed, never deleted. */
export interface AbacusSignOutResult {
  stashedSessions: number;
  /** Non-Abacus providers whose keys were deleted (empty when kept). */
  removedProviders: string[];
}

export interface AbacusConnectorInfo {
  /** Platform service key, lowercase, e.g. "gmailuser", "slack". */
  service: string;
  name: string;
}

export interface AbacusConnectorsSnapshot {
  ok: boolean;
  /** "not-signed-in" | "unavailable" | free text; set only when ok is false. */
  error?: string;
  available: AbacusConnectorInfo[];
  /** service key -> platform connector id (needed to disconnect). */
  connected: Record<string, string>;
  /**
   * service key -> "Gmail - ada@example.com": who the connector is connected
   * as, and the only place the account's own address appears.
   */
  accounts: Record<string, string>;
}

export type AbacusConnectorOutcome =
  | { ok: true }
  | { ok: false; error: string; cancelled?: boolean };

/** Same contract for every connector kind. */
export type ConnectorOutcome = AbacusConnectorOutcome;

/**
 * Where a registry connector stands on this machine. `pending` is attached
 * but not usable yet — a messaging platform awaiting its link, an MCP server
 * awaiting its sign-in. `unavailable` cannot be connected from here at all
 * (signed out of Abacus, or the account does not offer the service).
 */
export type ConnectorState =
  | "connected"
  | "available"
  | "unavailable"
  | "pending";

export interface ConnectorStatus {
  state: ConnectorState;
  /** Who it is connected as, when the platform says ("Gmail - ada@example.com"). */
  account?: string;
  /** Why it is unavailable or pending, for the card and the model. */
  reason?: string;
}

/** Keyed by registry connector id. */
export type ConnectorStatuses = Record<string, ConnectorStatus>;

// The one MCP entry behind every platform connector card. The Bearer header is an
// env placeholder expanded at connect time, so the key is never persisted.
export const ABACUS_CONNECTORS_SERVER_NAME = GATEWAY_SERVER_NAME;

export const abacusConnectorsMcpEntry = (mcpUrl: string): McpServerEntry => ({
  url: mcpUrl,
  headers: { Authorization: "Bearer ${ABACUS_API_KEY}" },
  oauth: false,
});
export interface RenameLocalFileResult {
  success: boolean;
  error?: string;
}

export interface TrashLocalFileResult {
  success: boolean;
  error?: string;
}

export interface SaveResolvedConflictResult {
  success: boolean;
  error?: string;
}

export interface WriteFileResult {
  success: boolean;
  error?: string;
}

/** MCP configs are namespaced by mode; AbacusAIBot only has the one. */
export type McpMode = "code";

export interface McpOAuthEntry {
  /** Pre-registered client id for providers without dynamic registration; omit to attempt DCR. */
  clientId?: string;
  clientSecret?: string;
  /** Space-separated OAuth scopes. */
  scope?: string;
}

// Fixed, not OS-assigned: providers without dynamic registration need the exact
// redirect URI registered in their console, and the app's own DCR clients are
// only reusable while the URI still matches. Shared because main binds it and
// the connector panel shows it.
export const MCP_OAUTH_CALLBACK_PORT = 33418;

export const mcpOAuthRedirectUri = (): string =>
  `http://127.0.0.1:${MCP_OAUTH_CALLBACK_PORT}/callback`;

// Matches the shape parsed by the agent's `parseMcpConfigFile`. STDIO entries
// use command/args/env; HTTP entries use url/headers.
export interface McpServerEntry {
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
  /** OAuth options for http/sse servers. `false` disables OAuth entirely. */
  oauth?: McpOAuthEntry | false;
  disabled?: boolean;
  autoApprove?: string[];
  /** The CLI orders this server's tools before user-added ones. */
  isBuiltin?: boolean;
}

export interface McpServerInfo {
  /** The dict key in `mcp.json`; also the CLI's runtime server id, so events join on it. */
  id: string;
  name: string;
  config: McpServerEntry;
  isBuiltin: boolean;
}

export type BrowserApproval = "ask" | "always";

export interface McpBrowserStatus {
  running: boolean;
  port: number | null;
  enabled: boolean;
  approval: BrowserApproval;
}

/** Which kernel sandbox this machine has; null means commands run unconfined. */
export interface SandboxSupport {
  backend: "sandbox-runtime" | "mxc" | null;
  /** The Windows build the sandbox needs, for the message on an older one. */
  minimumWindowsBuild: number;
}

/** A local simulator, emulator or device; mirrors main's DeviceInfo. */
export interface LocalDeviceInfo {
  platform: "ios" | "android";
  /** simctl UDID or adb serial (for a not-yet-running AVD, the AVD name). */
  id: string;
  name: string;
  state: "booted" | "shutdown" | "unknown";
  os?: string;
  physical?: boolean;
}

export interface DeviceStatus {
  /** Any mobile toolchain detected on the host. */
  available: boolean;
  ios: boolean;
  android: boolean;
  /** Maestro binary present (enables iOS snapshot + text-input fallback). */
  maestro: boolean;
  /** Native sim-input helper present — iOS taps/swipes without Maestro. */
  iosNativeInput: boolean;
  enabled: boolean;
  approval: BrowserApproval;
}

export interface CaptureDeviceScreenshotRequest {
  platform: "ios" | "android";
  deviceId?: string;
}

export interface CaptureDeviceScreenshotResult {
  dataUrl?: string;
  error?: string;
}

/** Mobile platforms the active workspace targets (from its file layout). */
export interface DeviceProjectInfo {
  ios: boolean;
  android: boolean;
  framework: "flutter" | "react-native" | "native" | null;
}

export interface InteractLocalDeviceRequest {
  platform: "ios" | "android";
  deviceId?: string;
  action: "tap" | "long_press" | "swipe" | "scroll" | "type" | "press_key";
  x?: number;
  y?: number;
  text?: string;
  key?: string;
  direction?: "up" | "down" | "left" | "right";
  amount?: number;
}

export interface InteractLocalDeviceResult {
  success: boolean;
  message?: string;
  error?: string;
}

/** Low-latency touch from the mirror panel; bypasses device re-resolution. */
export interface StreamDeviceTouchRequest {
  platform: "ios" | "android";
  deviceId: string;
  phase: "down" | "move" | "up" | "tap";
  /** Normalized 0..1, top-left origin. */
  x: number;
  y: number;
  /** Android needs device pixels. */
  deviceWidth?: number;
  deviceHeight?: number;
}

export interface StreamDeviceKeyRequest {
  platform: "ios" | "android";
  deviceId: string;
  /** KeyboardEvent.code: the physical key. */
  code: string;
  /** KeyboardEvent.key: the resolved character, used for Android text. */
  key: string;
  shift?: boolean;
  ctrl?: boolean;
  alt?: boolean;
  meta?: boolean;
}

export interface BuildAndRunLocalDeviceRequest {
  platform: "ios" | "android";
  deviceId?: string;
}

export interface BuildAndRunLocalDeviceResult {
  success: boolean;
  appId?: string;
  error?: string;
}

export type DeviceBuildPhase =
  | "booting"
  | "building"
  | "installing"
  | "launching"
  | "done"
  | "error";

export interface StartDeviceStreamRequest {
  /** adb serial or simulator UDID. */
  deviceId: string;
  /** Defaults to 'android' (H.264); 'ios' uses the framebuffer MJPEG helper. */
  platform?: "android" | "ios";
}

export interface StartDeviceStreamResult {
  success: boolean;
  streamId?: number;
  error?: string;
}

export interface DeviceStreamChunk {
  streamId: number;
  data: Uint8Array;
  /** H.264 keyframe flag; always true for MJPEG. */
  isKey: boolean;
  /** Absent means 'h264'. */
  format?: "h264" | "mjpeg";
}

export interface GetSimulatorWindowSourceRequest {
  /** Matched against window titles, e.g. "iPhone 17 Pro Max". */
  deviceName?: string;
}

export interface GetSimulatorWindowSourceResult {
  sourceId?: string;
  error?: string;
  /** macOS Screen Recording; window capture needs 'granted'. */
  screenPermission?:
    | "granted"
    | "denied"
    | "restricted"
    | "not-determined"
    | "unknown";
}

export interface BootLocalDeviceRequest {
  platform: "ios" | "android";
  deviceId?: string;
  /** iOS: foreground the Simulator window instead of opening in the background. */
  focus?: boolean;
}

export interface InstallMaestroResult {
  success: boolean;
  error?: string;
  status: DeviceStatus;
}

export interface BootLocalDeviceResult {
  success: boolean;
  device?: LocalDeviceInfo;
  error?: string;
}

export interface CreateLocalDeviceRequest {
  platform: "ios" | "android";
}

export interface CreateLocalDeviceResult {
  success: boolean;
  device?: LocalDeviceInfo;
  /** On failure this is user-facing setup guidance, not a stack trace. */
  error?: string;
}

/** Both on unless the user says otherwise. */
export interface NotificationSettings {
  /** An OS notification when a turn ends or a tool needs approval. */
  enabled: boolean;
  sound: boolean;
}

/** Per-tool permission request from a built-in MCP server. */
export interface BrowserPermissionRequest {
  requestId: string;
  tool: string;
  /** Human-friendly, e.g. "Navigate to https://...". */
  summary: string;
  /** Absent means the built-in browser. */
  server?: "browser" | "device";
  /** The prompt shows in this conversation and nowhere else. */
  conversationKey: ConversationKey;
}

// Structurally a `ConversationSegment`, kept opaque so the IPC layer has no
// opinion about the renderer's segment shapes.
export type TranscriptSegment = Record<string, unknown>;

/** What the user asked to keep, the agent's notes, what it knows of the person. */
export type MemoryTargetId = "memory" | "user" | "remember";

export type MemorySnapshot = Record<MemoryTargetId, string[]>;

export interface ForgetMemoryRequest {
  target: MemoryTargetId;
  index: number;
  /** The entry as it was on screen, so a stale click cannot delete its successor. */
  entry: string;
}

// Bots and sessions do not share memory, hence separate sections on the page.
export interface BotMemoryView {
  botId: string;
  name: string;
  entries: string[];
  noteDays: number;
}

export interface ForgetBotMemoryRequest {
  botId: string;
  index: number;
  /** The entry as it was on screen, same contract as ForgetMemoryRequest. */
  entry: string;
}

/** `session`: approved for the rest of this app run, forgotten on quit. */
export type BrowserPermissionDecision = "allow" | "deny" | "session" | "always";

// A connector the agent needs and cannot reach, offered as a button. The turn
// is suspended until the user connects it or says no.
export interface ConnectorRequest {
  requestId: string;
  /** Registry connector id, e.g. "abacus-slack", "github", "messaging-whatsapp". */
  connectorId: string;
  /** Button text, e.g. "Slack". */
  label: string;
  /** Why the agent needs it, in its own words. */
  reason?: string;
  /**
   * Where the button appears. Never null: a caller with no conversation is
   * refused, since a card shown "wherever the user is" lands in the wrong chat.
   */
  conversationKey: ConversationKey;
}

export interface RespondConnectorRequest {
  requestId: string;
  /** Must be the conversation the ask was filed under. */
  conversationKey: ConversationKey;
  outcome: "connected" | "declined" | "failed";
  error?: string;
}

export interface RespondBrowserPermissionRequest {
  requestId: string;
  /** Must be the conversation the ask was filed under. */
  conversationKey: ConversationKey;
  decision: BrowserPermissionDecision;
}

export interface ClearBrowserDataRequest {
  /** Optional partition; if omitted, clears the default preview partition. */
  partition?: string;
}

export interface ClearBrowserDataResult {
  success: boolean;
  error?: string;
}

export interface ListMcpServersRequest {
  mode: McpMode;
}

export interface AddMcpServerRequest {
  mode: McpMode;
  name: string;
  config: McpServerEntry;
}

export interface UpdateMcpServerRequest {
  mode: McpMode;
  name: string;
  config: Partial<McpServerEntry>;
}

export interface McpOAuthSignInRequest {
  mode: McpMode;
  /** The server's id in mcp.json. */
  name: string;
}

export interface McpOAuthSignInResult {
  success: boolean;
  error?: string;
  /** The user closed the browser flow; not a failure to report loudly. */
  cancelled?: boolean;
}

export interface RemoveMcpServerRequest {
  mode: McpMode;
  name: string;
}

export interface SetMcpServerDisabledRequest {
  mode: McpMode;
  name: string;
  disabled: boolean;
}

type McpImportSource =
  | "cursor"
  | "claude"
  | "abacusai-bot"
  | "deepagent"
  | "file"
  | "json";

export interface ImportMcpServersRequest {
  mode: McpMode;
  source: McpImportSource;
  /** Required when source is 'json'. */
  json?: string;
}

// Live status inside one CLI session; `McpServerInfo` is only what is on disk.
export type AgentMcpStatus =
  | "connecting"
  | "connected"
  | "error"
  | "auth-required"
  | "disconnected";

type AgentMcpLogLevel =
  | "raw"
  | "debug"
  | "info"
  | "notice"
  | "warning"
  | "error"
  | "critical"
  | "alert"
  | "emergency";

export interface AgentMcpServer {
  id: string;
  name: string;
  transport: string;
  status: AgentMcpStatus;
  error?: string;
  authUrl?: string;
  pid?: number;
  connectedAt?: string;
  updatedAt?: string;
  toolCount: number;
}

export interface AgentMcpLogEntry {
  serverId: string;
  source: "notification" | "stderr" | "transport";
  level: AgentMcpLogLevel;
  logger?: string;
  line: string;
  ts: string;
}

export interface RefreshMcpServersRequest {
  workspaceId: string;
  sessionId: string;
}

export interface RestartMcpServerRequest {
  workspaceId: string;
  sessionId: string;
  serverId: string;
}

export interface GetMcpRuntimeServersRequest {
  workspaceId: string;
  sessionId: string;
}

export interface GetMcpServerLogsRequest {
  workspaceId: string;
  sessionId: string;
  serverId: string;
}

export interface McpRuntimeRequestResult {
  /** True when the command was queued for the live CLI process. */
  success: boolean;
  /** Populated when the live CLI process is not running. */
  error?: string;
}

export interface ImportMcpServersResult {
  success: boolean;
  error?: string;
  imported?: number;
  skipped?: string[];
  /** Present when the source contained a single bare server entry (no wrapper key). Frontend should open the add-form pre-filled. */
  singleEntry?: McpServerEntry;
}

export interface AddWorkspaceResult {
  success: boolean;
  error?: string;
  workspaceId?: string;
}

export interface SwitchWorkspaceResult {
  success: boolean;
  error?: string;
}

export interface InitGitResult {
  success: boolean;
  error?: string;
}

interface GitBranchSummary {
  name: string;
  isCurrent: boolean;
}

export interface GetGitBranchesResult {
  success: boolean;
  branches: GitBranchSummary[];
  currentBranch: string | null;
  error?: string;
}

/** Explicit repository context for conversation-scoped Git operations. */
export interface WorkspaceGitContext {
  workspaceId: string;
  sessionId?: string;
}

export interface SwitchGitBranchResult {
  success: boolean;
  currentBranch: string | null;
  error?: string;
}

export interface GetGitCurrentBranchResult {
  success: boolean;
  currentBranch: string | null;
  error?: string;
}

// The PR indicator and the CI / diff / approval breakdown its tooltip renders.
export type PrReviewState =
  | "approved"
  | "pending"
  | "changes_requested"
  | "draft"
  | "merged"
  | "closed";

export type PrCiStatus = "success" | "failure" | "pending";

export interface PrCheck {
  name: string;
  status: PrCiStatus;
  url: string | null;
}

export interface PrInfo {
  number: number;
  url: string;
  title: string;
  reviewState: PrReviewState;
  additions: number;
  deletions: number;
  ciStatus: PrCiStatus | null;
  checks: PrCheck[];
  approvedCount: number;
  changesRequestedCount: number;
  reviewRequestedCount: number;
}

export interface CreateGitBranchResult {
  success: boolean;
  currentBranch: string | null;
  error?: string;
}

export interface WorkspaceMetadataRequest {
  workspace?: string;
}

export interface BrowserProfileInfo {
  id: string;
  browserName: string;
  browserKey: string;
  profileName: string;
  profileDir: string;
  profileDataPath: string;
  avatarIcon?: string;
}

export interface BrowserRuntimeLease {
  conversationKey: ConversationKey;
  resourceId: string;
  generation: number;
}

export interface BrowserRuntimeBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BrowserRuntimeState {
  lease: BrowserRuntimeLease;
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  focused: boolean;
  crashed: boolean;
  error?: string;
  devToolsOpen: boolean;
  zoomFactor: number;
}

export interface BrowserRuntimeCapture {
  dataUrl: string;
}

export interface MaterializeBrowserRuntimeRequest {
  conversationKey: ConversationKey;
  resourceId: string;
  /** An imported browser profile id. Main derives its private partition name. */
  profileId?: string;
  url?: string;
}

export interface PresentBrowserRuntimeRequest {
  lease: BrowserRuntimeLease;
  /** Identifies the renderer surface that currently owns native presentation. */
  presentationId: string;
  bounds: BrowserRuntimeBounds;
  url?: string;
}

export interface HideBrowserRuntimeRequest {
  lease: BrowserRuntimeLease;
  presentationId: string;
}

export type BrowserRuntimeNavigation =
  | { action: "url"; url: string }
  | {
      action:
        | "back"
        | "forward"
        | "reload"
        | "hard-reload"
        | "stop"
        | "focus"
        | "open-devtools"
        | "zoom-in"
        | "zoom-out"
        | "zoom-reset"
        | "clear-site-data";
    };

export interface NavigateBrowserRuntimeRequest {
  lease: BrowserRuntimeLease;
  navigation: BrowserRuntimeNavigation;
}

export interface PromoteBrowserRuntimeScopeRequest {
  draftConversationKey: ConversationKey;
  sessionConversationKey: ConversationKey;
}

export interface ImportBrowserProfileResult {
  success: boolean;
  partition: string;
  cookiesImported?: number;
  error?: string;
}

// Usage. Mirrors the shapes `@abacus-ai/agent/usage` produces; the renderer
// only imports from #shared. Sourced from local session logs, nothing leaves
// the machine.

/** One window's worth of totals: a day, a model, or the whole span. */
export interface UsageTotals {
  /** Assistant turns, including the ones that failed. */
  requests: number;
  /** Turns that ended in a provider error. */
  errors: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Dollars actually billed; free and unpriced rows contribute nothing. */
  cost: number;
}

/** `unknown`: tokens moved at no recorded price; "$0" would misreport as free. */
export type UsageBilling = "billed" | "free" | "unknown";

export interface ModelUsageStats extends UsageTotals {
  /** Canonical `provider/model-id`. */
  id: string;
  provider: string;
  modelId: string;
  /** Member of OpenLLM's pool, judged by name. */
  pool: boolean;
  billing: UsageBilling;
  today: UsageTotals;
  /** Epoch ms of the most recent turn. */
  lastUsed: number;
}

export interface UsageDay {
  /** Local calendar date, `YYYY-MM-DD`. */
  date: string;
  requests: number;
  errors: number;
  tokens: number;
  cost: number;
}

/** The one number the local logs cannot carry. */
export interface OpenRouterKeyStatus {
  /** Dollars of credit spent on this key, lifetime. */
  usage: number;
  /** Null for none. */
  limit: number | null;
  isFreeTier: boolean;
}

/** From GET /v1/account. */
export interface AbacusAccountInfo {
  /** Stable identity, preferred over mutable email. */
  user_id: string | null;
  /** One user in two organizations has two profiles. */
  organization_id: string | null;
  name: string | null;
  email: string | null;
  /** Fetched by the main process and safe for the renderer. */
  picture: string | null;
  organization: string | null;
  org_user_count: number | null;
  /** Display plan: "Free", "Basic", "Pro", "Max", "Enterprise", … */
  plan: string | null;
  subscription_tier: string | null;
  credits_used: number | null;
  credits_granted: number | null;
}

export interface UsageSnapshot {
  generatedAt: number;
  /** The window the totals cover, today inclusive. */
  days: number;
  totals: UsageTotals;
  today: UsageTotals;
  /** Largest spender first. */
  models: ModelUsageStats[];
  /** Oldest first; days with no use are absent. */
  daily: UsageDay[];
  /** Some row moved tokens at an unknown price, so `totals.cost` is a floor. */
  unpriced: boolean;
  openrouter: OpenRouterKeyStatus | null;
}

export interface AgentApi {
  getMetadata: (
    request?: WorkspaceMetadataRequest
  ) => Promise<WorkspaceMetadataSnapshot>;
  getGitState: () => Promise<GitStateSnapshot>;
  listWorktrees: (
    request: ListWorktreesRequest
  ) => Promise<ListWorktreesResult>;
  createWorktree: (
    request: CreateWorktreeRequest
  ) => Promise<CreateWorktreeResult>;
  setSessionWorktree: (
    request: SetSessionWorktreeRequest
  ) => Promise<SetSessionWorktreeResult>;
  materializeSessionWorktree: (
    request: MaterializeSessionWorktreeRequest
  ) => Promise<MaterializeSessionWorktreeResult>;
  getFileTreeRoot: () => Promise<FileTreeRootSnapshot>;
  addWorkspace: (
    path: string,
    isRemote?: boolean
  ) => Promise<AddWorkspaceResult>;
  /** The one folder bots work in, found or made. Null only when it could not be made. */
  ensureBotWorkspace: () => Promise<string | null>;
  /** The "Auto workspace", added and selected on first ask. Null only when it could not be made. */
  ensureSessionHomeWorkspace: () => Promise<string | null>;
  /** Where the auto workspace lives, made or not. */
  getSessionHomeWorkspacePath: () => Promise<string>;
  listModels: (refresh?: boolean) => Promise<ModelAvailability[]>;
  getUsageSnapshot: () => Promise<UsageSnapshot>;
  /** Null when signed out. */
  getAbacusAccount: (refresh?: boolean) => Promise<AbacusAccountInfo | null>;
  getSettings: () => Promise<AbacusBotSettings>;
  /** Up-arrow history for one composer (a session, or a workspace's new-session box), newest first. */
  listPromptHistory: (scope: string) => Promise<string[]>;
  /** Returns the history as it now stands. */
  addPromptHistory: (scope: string, prompt: string) => Promise<string[]>;
  /** Ids only, never the keys: `getSettings` would hand the renderer every secret. */
  listStoredKeyProviders: () => Promise<string[]>;
  saveApiKey: (provider: string, key: string) => Promise<AbacusBotSettings>;
  setDefaultModel: (modelId: string) => Promise<AbacusBotSettings>;
  switchWorkspace: (workspaceId: string) => Promise<SwitchWorkspaceResult>;
  initGit: () => Promise<InitGitResult>;
  getFileTreeChildren: (directoryPath: string) => Promise<FileTreeNode[]>;
  getGitDiffForPath: (
    filePath: string,
    scope?: GitDiffScope
  ) => Promise<string>;
  getGitChangeStatsForPath: (
    filePath: string,
    scope?: GitChangeStatsScope
  ) => Promise<GitChangeStatsSnapshot>;
  searchFiles: (query: string) => Promise<{
    items: Array<{
      relativePath: string;
      fileName: string;
      kind: "file" | "directory";
    }>;
  }>;
  startTerminalSession: (
    request: StartTerminalSessionRequest
  ) => Promise<StartTerminalSessionResult>;
  writeTerminalInput: (request: WriteTerminalInputRequest) => Promise<boolean>;
  resizeTerminalSession: (
    request: ResizeTerminalSessionRequest
  ) => Promise<boolean>;
  hideTerminalSession: (request: TerminalRuntimeRequest) => Promise<boolean>;
  promoteTerminalSessionScope: (
    request: PromoteTerminalSessionScopeRequest
  ) => Promise<TerminalSessionSnapshot | null>;
  getGitBranches: (
    context?: WorkspaceGitContext
  ) => Promise<GetGitBranchesResult>;
  getGitCurrentBranch: (
    context?: WorkspaceGitContext
  ) => Promise<GetGitCurrentBranchResult>;
  getPrInfo: (context?: WorkspaceGitContext) => Promise<PrInfo | null>;
  getSessionTurnState: (
    workspaceId: string,
    sessionId: string
  ) => Promise<SessionTurnStateSnapshot>;
  switchGitBranch: (
    branchName: string,
    context?: WorkspaceGitContext
  ) => Promise<SwitchGitBranchResult>;
  createGitBranch: (
    branchName: string,
    context?: WorkspaceGitContext
  ) => Promise<CreateGitBranchResult>;
  createAgentSession: (workspaceId: string) => Promise<AgentSessionListItem>;
  listAgentSessions: (workspaceId: string) => Promise<AgentSessionListItem[]>;
  listAllAgentSessions: () => Promise<AgentSessionListItem[]>;
  listBots: () => Promise<Bot[]>;
  /** Keyed by bot id. */
  listBotChatPreviews: () => Promise<Record<string, BotChatPreview>>;
  listBotSenderChats: () => Promise<BotSenderChat[]>;
  createBot: (input: BotCreateInput) => Promise<Bot>;
  updateBot: (id: string, changes: BotUpdateInput) => Promise<Bot>;
  deleteBot: (id: string) => Promise<void>;
  /** The bot acknowledges the change in its chat once. */
  announceBotChange: (id: string, notice: BotChangeNotice) => Promise<void>;
  openBotChat: (botId: string) => Promise<BotChatHandle>;
  listRoutines: () => Promise<RoutineListItem[]>;
  listRoutineRuns: (routineId: string) => Promise<RoutineRunItem[]>;
  /** Plain-words edit; resolves to the routine's reply. */
  editRoutineByChat: (routineId: string, text: string) => Promise<string>;
  createRoutine: (input: RoutineCreateInput) => Promise<Routine>;
  updateRoutine: (id: string, changes: RoutineUpdateInput) => Promise<Routine>;
  removeRoutine: (id: string) => Promise<void>;
  /** `create` marks the run as the test run after setup. */
  runRoutine: (id: string, trigger?: "manual" | "create") => Promise<void>;
  /** Browser sign-in; resolves when the user finishes, cancels, or it times out. */
  startOpenRouterAuth: () => Promise<OpenRouterAuthOutcome>;
  /** Browser sign-in or sign-up; resolves when the user finishes, cancels, or it times out. */
  startAbacusAuth: () => Promise<AbacusAuthOutcome>;
  /**
   * Stash this account's sessions, delete the Abacus key and its connector
   * gateway, and every other stored key too unless `keepOtherApiKeys`.
   */
  signOutAbacus: (options: {
    keepOtherApiKeys: boolean;
  }) => Promise<AbacusSignOutResult>;
  cancelAbacusAuth: () => Promise<void>;
  cancelOpenRouterAuth: () => Promise<void>;
  /** Every registry connector's state on this machine, keyed by connector id. */
  listConnectorStatuses: () => Promise<ConnectorStatuses>;
  /**
   * Connect a connector whose flow takes no fields — a browser hop or a plain
   * install. Resolves when the platform confirms, the user cancels, or it
   * times out.
   */
  connectConnector: (connectorId: string) => Promise<ConnectorOutcome>;
  /** Connect a connector whose flow asked for fields, with what the user typed. */
  submitConnectorFields: (
    connectorId: string,
    values: Record<string, string>
  ) => Promise<ConnectorOutcome>;
  cancelConnectorConnect: () => Promise<void>;
  disconnectConnector: (connectorId: string) => Promise<ConnectorOutcome>;
  listSessionArtifacts: () => Promise<SessionArtifact[]>;
  removeAgentSession: (
    workspaceId: string,
    sessionId: string
  ) => Promise<boolean>;
  startAgentSession: (
    request: StartAgentSessionRequest
  ) => Promise<StartAgentSessionResult>;
  stopAgentSession: (
    request: AgentSessionCommandRequest
  ) => Promise<StopAgentSessionResult>;
  getAgentSessionState: (
    request: AgentSessionCommandRequest
  ) => Promise<AgentSessionSnapshot>;
  /** False when undeliverable even after a session restart. */
  sendAgentMessage: (request: SendAgentMessageRequest) => Promise<boolean>;
  setAgentMode: (request: AgentSetModeRequest) => Promise<void>;
  setAgentModel: (request: AgentSetModelRequest) => Promise<void>;
  stopAgentTurn: (request: AgentSessionCommandRequest) => Promise<void>;
  resetAgentConversation: (
    request: AgentSessionCommandRequest
  ) => Promise<void>;
  switchAgentConversation: (
    request: AgentSwitchConversationRequest
  ) => Promise<void>;
  respondAgentPermission: (
    request: AgentPermissionResponseRequest
  ) => Promise<void>;
  listAgentSkills: (request: AgentSessionCommandRequest) => Promise<void>;
  enqueueAgentMessage: (request: AgentQueueMessageRequest) => Promise<void>;
  dequeueAgentMessage: (request: AgentSessionCommandRequest) => Promise<void>;
  getAgentQueue: (request: AgentSessionCommandRequest) => Promise<void>;
  clearAgentQueue: (request: AgentSessionCommandRequest) => Promise<void>;
  removeAgentQueueMessage: (
    request: AgentRemoveFromQueueRequest
  ) => Promise<void>;
  updateAgentQueueMessage: (
    request: AgentUpdateQueueMessageRequest
  ) => Promise<void>;
  renameLocalFile: (
    fromPath: string,
    toPath: string
  ) => Promise<RenameLocalFileResult>;
  trashLocalFile: (filePath: string) => Promise<TrashLocalFileResult>;
  saveResolvedConflict: (
    filePath: string,
    content: string
  ) => Promise<SaveResolvedConflictResult>;
  writeFile: (filePath: string, content: string) => Promise<WriteFileResult>;
  stageFile: (
    filePath: string
  ) => Promise<{ success: boolean; error?: string }>;
  unstageFile: (
    filePath: string
  ) => Promise<{ success: boolean; error?: string }>;
  removeWorkspace: (
    workspaceId: string
  ) => Promise<{ success: boolean; error?: string }>;
  updateWorkspaceLabel: (
    workspaceId: string,
    label: string
  ) => Promise<{ success: boolean; error?: string }>;
  checkWorkspacePath: (workspaceId: string) => Promise<WorkspacePathStatus>;
  relocateWorkspace: (
    workspaceId: string,
    newPath: string
  ) => Promise<RelocateWorkspaceResult>;
  updateAgentSessionLabel: (
    workspaceId: string,
    sessionId: string,
    label: string
  ) => Promise<boolean>;
  listBrowserProfiles: () => Promise<BrowserProfileInfo[]>;
  refreshBrowserProfiles: () => Promise<BrowserProfileInfo[]>;
  importBrowserProfile: (
    profileId: string
  ) => Promise<ImportBrowserProfileResult>;
  clearImportedBrowserProfile: (
    profileId: string
  ) => Promise<{ success: boolean; error?: string }>;
  materializeBrowserRuntime: (
    request: MaterializeBrowserRuntimeRequest
  ) => Promise<BrowserRuntimeState>;
  presentBrowserRuntime: (
    request: PresentBrowserRuntimeRequest
  ) => Promise<BrowserRuntimeState>;
  navigateBrowserRuntime: (
    request: NavigateBrowserRuntimeRequest
  ) => Promise<BrowserRuntimeState>;
  captureBrowserRuntime: (
    lease: BrowserRuntimeLease
  ) => Promise<BrowserRuntimeCapture>;
  hideBrowserRuntime: (request: HideBrowserRuntimeRequest) => Promise<void>;
  closeBrowserRuntime: (lease: BrowserRuntimeLease) => Promise<void>;
  promoteBrowserRuntimeScope: (
    request: PromoteBrowserRuntimeScopeRequest
  ) => Promise<BrowserRuntimeLease[]>;
  disposeBrowserRuntimeScope: (
    conversationKey: ConversationKey
  ) => Promise<void>;
  disposeBrowserRuntimeWorkspace: (workspaceId: string) => Promise<void>;
  listMcpServers: (request: ListMcpServersRequest) => Promise<McpServerInfo[]>;
  addMcpServer: (
    request: AddMcpServerRequest
  ) => Promise<{ success: boolean; error?: string }>;
  updateMcpServer: (
    request: UpdateMcpServerRequest
  ) => Promise<{ success: boolean; error?: string }>;
  removeMcpServer: (
    request: RemoveMcpServerRequest
  ) => Promise<{ success: boolean; error?: string }>;
  setMcpServerDisabled: (
    request: SetMcpServerDisabledRequest
  ) => Promise<{ success: boolean; error?: string }>;
  importMcpServers: (
    request: ImportMcpServersRequest
  ) => Promise<ImportMcpServersResult>;
  refreshMcpServers: (
    request: RefreshMcpServersRequest
  ) => Promise<McpRuntimeRequestResult>;
  restartMcpServer: (
    request: RestartMcpServerRequest
  ) => Promise<McpRuntimeRequestResult>;
  /** Run the browser OAuth sign-in for an MCP server; resolves when tokens are stored. */
  mcpOAuthSignIn: (
    request: McpOAuthSignInRequest
  ) => Promise<McpOAuthSignInResult>;
  getMcpRuntimeServers: (
    request: GetMcpRuntimeServersRequest
  ) => Promise<AgentMcpServer[]>;
  getMcpServerLogs: (
    request: GetMcpServerLogsRequest
  ) => Promise<AgentMcpLogEntry[]>;
  getMcpBrowserStatus: () => Promise<McpBrowserStatus>;
  setMcpBrowserEnabled: (enabled: boolean) => Promise<McpBrowserStatus>;
  /** Whether shell commands run confined by the OS sandbox. Off by default. */
  getSandboxEnabled: () => Promise<boolean>;
  /** Which kernel sandbox this machine has, if any. */
  getSandboxSupport: () => Promise<SandboxSupport>;
  getNotificationSettings: () => Promise<NotificationSettings>;
  setNotificationSettings: (
    next: NotificationSettings
  ) => Promise<NotificationSettings>;
  /** Resolves to the stored state; takes effect next session. */
  setSandboxEnabled: (enabled: boolean) => Promise<boolean>;
  /** Off by default: holding an xAI model key should not decide where a search goes. */
  getXaiSearchEnabled: () => Promise<boolean>;
  /** Resolves to the stored state; applies next session. */
  setXaiSearchEnabled: (enabled: boolean) => Promise<boolean>;
  /** Keyed by toolset id. */
  getToolsetStates: () => Promise<Record<string, boolean>>;
  /** Resolves to the full state map so the panel stays consistent. */
  setToolsetEnabled: (
    toolsetId: string,
    enabled: boolean
  ) => Promise<Record<string, boolean>>;
  getExecBackendState: () => Promise<ExecBackendState>;
  setExecBackend: (backend: BackendId) => Promise<ExecBackendState>;
  /** The agent is blocked inside its tool call until this. */
  respondConnector: (request: RespondConnectorRequest) => Promise<void>;
  /** Asks still waiting, re-served to a remounting card. */
  listConnectorRequests: (
    conversationKey: ConversationKey
  ) => Promise<ConnectorRequest[]>;
  listBrowserPermissionRequests: (
    conversationKey: ConversationKey
  ) => Promise<BrowserPermissionRequest[]>;
  setBrowserApproval: (approval: BrowserApproval) => Promise<McpBrowserStatus>;
  clearBrowserData: (
    request?: ClearBrowserDataRequest
  ) => Promise<ClearBrowserDataResult>;
  respondBrowserPermission: (
    request: RespondBrowserPermissionRequest
  ) => Promise<void>;
  /** Pinned so reopening the session does not move it. */
  setAgentSessionModel: (
    workspaceId: string,
    sessionId: string,
    model: string
  ) => Promise<boolean>;
  listMemories: () => Promise<MemorySnapshot>;
  /** Standing instructions appended to every system prompt; the user's words, never the agent's. */
  getCustomInstructions: () => Promise<string>;
  /** Returns what is now stored, so the box re-renders from disk. */
  setCustomInstructions: (text: string) => Promise<string>;
  forgetMemory: (request: ForgetMemoryRequest) => Promise<MemorySnapshot>;
  forgetAllMemories: (target: MemoryTargetId) => Promise<MemorySnapshot>;
  listBotMemories: () => Promise<BotMemoryView[]>;
  forgetBotMemory: (
    request: ForgetBotMemoryRequest
  ) => Promise<BotMemoryView[]>;
  clearBotMemory: (botId: string) => Promise<BotMemoryView[]>;
  readTranscript: (sessionId: string) => Promise<TranscriptSegment[]>;
  writeTranscript: (
    sessionId: string,
    segments: TranscriptSegment[]
  ) => Promise<void>;
  getDeviceStatus: () => Promise<DeviceStatus>;
  listLocalDevices: () => Promise<LocalDeviceInfo[]>;
  captureDeviceScreenshot: (
    request: CaptureDeviceScreenshotRequest
  ) => Promise<CaptureDeviceScreenshotResult>;
  bootLocalDevice: (
    request: BootLocalDeviceRequest
  ) => Promise<BootLocalDeviceResult>;
  createLocalDevice: (
    request: CreateLocalDeviceRequest
  ) => Promise<CreateLocalDeviceResult>;
  refreshDeviceStatus: () => Promise<DeviceStatus>;
  setDevicesEnabled: (enabled: boolean) => Promise<DeviceStatus>;
  setDevicesApproval: (approval: BrowserApproval) => Promise<DeviceStatus>;
  getDeviceProjectInfo: () => Promise<DeviceProjectInfo>;
  interactLocalDevice: (
    request: InteractLocalDeviceRequest
  ) => Promise<InteractLocalDeviceResult>;
  buildAndRunLocalDevice: (
    request: BuildAndRunLocalDeviceRequest
  ) => Promise<BuildAndRunLocalDeviceResult>;
  streamDeviceTouch: (request: StreamDeviceTouchRequest) => void;
  streamDeviceKey: (request: StreamDeviceKeyRequest) => void;
  openScreenRecordingSettings: () => Promise<void>;
  openAccessibilitySettings: () => Promise<void>;
  startDeviceStream: (
    request: StartDeviceStreamRequest
  ) => Promise<StartDeviceStreamResult>;
  /** A stale streamId is ignored so a superseded player cannot kill the live stream. */
  stopDeviceStream: (streamId?: number) => Promise<void>;
  getSimulatorWindowSource: (
    request: GetSimulatorWindowSourceRequest
  ) => Promise<GetSimulatorWindowSourceResult>;
  getMessagingSnapshot: () => Promise<MessagingSnapshot>;
  updateMessagingPlatform: (
    request: UpdateMessagingPlatformRequest
  ) => Promise<MessagingSnapshot>;
  decideMessagingPairing: (
    request: MessagingPairingDecisionRequest
  ) => Promise<MessagingSnapshot>;
  updateMessagingSettings: (
    request: UpdateMessagingSettingsRequest
  ) => Promise<MessagingSnapshot>;
  /** Reopen the platform's own web login window. */
  showMessagingLogin: (platformId: MessagingPlatformId) => Promise<void>;
  /** Mint a pairing code for a shared-bot platform. */
  pairSharedChannel: (
    platformId: MessagingPlatformId
  ) => Promise<MessagingSnapshot>;
  unlinkSharedChannel: (
    platformId: MessagingPlatformId
  ) => Promise<MessagingSnapshot>;
  /** In the app's own window, never the OS: a discord.com link would open the Discord app and never come back. */
  openSharedChannelLink: (
    platformId: MessagingPlatformId,
    target?: "install" | "dm"
  ) => Promise<void>;
  installMaestro: () => Promise<InstallMaestroResult>;
  onDeviceStreamChunk: (
    callback: (chunk: DeviceStreamChunk) => void
  ) => () => void;
  onEvent: (callback: (event: IpcEvent) => void) => () => void;
}

/** Chosen vs. actually in effect, and why the others are not. */
export interface ExecBackendState {
  selected: BackendId;
  effective: BackendId;
  statuses: BackendStatus[];
}
