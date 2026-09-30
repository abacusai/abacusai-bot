/**
 * The parity tables of spec 00 A.2 as data: where every legacy
 * `window.api.agent.*` method, top-level `window.api.*` member and `IpcEvent`
 * went. The preload's parity test (A-T6) fails when a legacy key has no row or
 * a row names a procedure the contract lacks, and writes docs/rewrite/PARITY.md
 * from these tables.
 *
 * Kinds: Q query, M mutation, S event-iterator subscription, T served by a DB
 * table, R retired (not mounted on the router; its legacy handler stays until
 * the cut-over).
 */
import type { AgentApi, IpcEvent } from "../contracts";

export type LegacyKind = "Q" | "M" | "S" | "T" | "R";

export type LegacyDestination =
  | { kind: "Q" | "M" | "S" | "T"; procedure: string; note?: string }
  | { kind: "R"; reason: string };

const q = (procedure: string, note?: string): LegacyDestination => ({
  kind: "Q",
  procedure,
  ...(note == null ? {} : { note }),
});
const m = (procedure: string, note?: string): LegacyDestination => ({
  kind: "M",
  procedure,
  ...(note == null ? {} : { note }),
});
const s = (procedure: string, note?: string): LegacyDestination => ({
  kind: "S",
  procedure,
  ...(note == null ? {} : { note }),
});
const t = (procedure: string, note?: string): LegacyDestination => ({
  kind: "T",
  procedure,
  ...(note == null ? {} : { note }),
});
const r = (reason: string): LegacyDestination => ({ kind: "R", reason });

const NO_CALLER = "no renderer caller";

/** `window.api.agent.*` (preload/bridge.ts). */
export const LEGACY_BRIDGE_MAP: Record<keyof AgentApi, LegacyDestination> = {
  getMetadata: t(
    "db.workspaces.snapshot",
    "materialIconsBasePath → system.info; activeWorkspaceId → row isActive"
  ),
  getGitState: t("db.gitState.snapshot", "keyed by workspaceId"),
  listWorktrees: q("git.worktrees.list"),
  createWorktree: m("git.worktrees.create"),
  setSessionWorktree: m(
    "git.worktrees.setForSession",
    "echoes sessions update"
  ),
  materializeSessionWorktree: m(
    "git.worktrees.materialize",
    "echoes sessions update"
  ),
  getFileTreeRoot: q(
    "files.treeRoot",
    "invalidated by files.events tree-root-changed"
  ),
  listModels: q("models.list", "input { refresh?: boolean }"),
  getUsageSnapshot: q("account.usage"),
  getAbacusAccount: q("account.abacus"),
  getReferralSummary: q("referrals.summary"),
  listReferralGmailContacts: q("referrals.gmailContacts"),
  sendReferralEmailInvites: m("referrals.sendEmail"),
  listReferralWhatsappContacts: q("referrals.whatsappContacts"),
  sendReferralWhatsappInvites: m("referrals.sendWhatsapp"),
  submitTurnFeedback: m("agent.feedback"),
  getSettings: q("settings.get"),
  listPromptHistory: q("settings.promptHistory.list"),
  addPromptHistory: m("settings.promptHistory.add"),
  listStoredKeyProviders: q(
    "settings.keys.listProviders",
    "invalidated by settings.events credentials-changed"
  ),
  saveApiKey: m("settings.keys.save"),
  setDefaultModel: m("settings.setDefaultModel"),
  addWorkspace: m("workspaces.add", "echoes workspaces insert"),
  ensureSessionHomeWorkspace: m("workspaces.ensureSessionHome"),
  getSessionHomeWorkspacePath: q("workspaces.sessionHomePath"),
  switchWorkspace: m(
    "workspaces.switch",
    "legacy main-side active workspace; new routes carry workspaceId"
  ),
  initGit: r(NO_CALLER),
  getFileTreeChildren: q("files.treeChildren"),
  searchFiles: q("files.search"),
  getGitDiffForPath: r(`${NO_CALLER}; git.diff covers it`),
  getGitChangeStatsForPath: r(NO_CALLER),
  startTerminalSession: m("terminal.start"),
  writeTerminalInput: m("terminal.write", "fire-and-forget"),
  resizeTerminalSession: m("terminal.resize"),
  hideTerminalSession: m("terminal.hide"),
  promoteTerminalSessionScope: m("terminal.promoteScope"),
  getGitBranches: q("git.branches"),
  getGitCurrentBranch: q("git.currentBranch"),
  getPrInfo: q("git.prInfo"),
  getSessionTurnState: q(
    "sessions.turnState",
    "live phase also derivable from ai.subscribe; kept for rows not open"
  ),
  switchGitBranch: m("git.switchBranch", "echoes gitState"),
  createGitBranch: m("git.createBranch"),
  createAgentSession: t("db.sessions.insert"),
  listAgentSessions: t(
    "db.sessions.snapshot",
    "per-workspace list becomes a live query where workspaceId"
  ),
  listAllAgentSessions: t("db.sessions.snapshot"),
  listBots: t("db.bots.snapshot"),
  listBotChatPreviews: q(
    "bots.chatPreviews",
    "invalidated by bots.events previews-changed"
  ),
  listBotSenderChats: q("bots.senderChats"),
  createBot: t("db.bots.insert"),
  updateBot: t("db.bots.update"),
  deleteBot: t("db.bots.delete"),
  announceBotChange: m("bots.announceChange"),
  openBotChat: m(
    "bots.openChat",
    "echoes bots update (sessionId) and sessions insert"
  ),
  listRoutines: t("db.routines.snapshot"),
  listRoutineRuns: t("db.routineRuns.snapshot", "live query where routineId"),
  editRoutineByChat: m(
    "routines.editByChat",
    "long-running; resolves to the reply text"
  ),
  createRoutine: t("db.routines.insert"),
  updateRoutine: t("db.routines.update"),
  removeRoutine: t("db.routines.delete"),
  runRoutine: m("routines.run", "echoes routineRuns insert"),
  getLocalModelState: q("localModels.state"),
  installLocalModel: m("localModels.install"),
  cancelLocalModelInstall: m("localModels.cancelInstall"),
  removeLocalModel: m("localModels.remove"),
  startOpenRouterAuth: m(
    "auth.openRouter.start",
    "long-running; resolves to the outcome union"
  ),
  startAbacusAuth: m(
    "auth.abacus.start",
    "long-running; outcome union kept (cancelled)"
  ),
  listBrowserSignInProfiles: q("auth.abacus.browserProfiles"),
  cancelAbacusAuth: m("auth.abacus.cancel"),
  openAbacusAuthInBrowser: m("auth.abacus.openInBrowser"),
  cancelOpenRouterAuth: m("auth.openRouter.cancel"),
  signOutAbacus: m("auth.abacus.signOut", "echoes sessions reset (stash)"),
  listConnectorStatuses: q(
    "connectors.statuses",
    "invalidated by connectors.events status-changed"
  ),
  connectConnector: m("connectors.connect"),
  submitConnectorFields: m("connectors.submitFields"),
  cancelConnectorConnect: m("connectors.cancelConnect"),
  disconnectConnector: m("connectors.disconnect"),
  listSessionArtifacts: t("db.artifacts.snapshot"),
  removeAgentSession: t("db.sessions.delete"),
  startAgentSession: m(
    "agent.start",
    "spawns the child; the AG-UI stream arrives on ai.subscribe"
  ),
  stopAgentSession: m("agent.stop"),
  getAgentSessionState: q(
    "agent.state",
    "live updates via ai.subscribe STATE_* / CUSTOM session.state"
  ),
  sendAgentMessage: m(
    "ai.send",
    "AG-UI RunAgentInput (threadId/runId/parentRunId/resume/forwardedProps)"
  ),
  setAgentMode: m("agent.setMode", "also forwardedProps.mode on ai.send"),
  setAgentModel: m("agent.setModel"),
  stopAgentTurn: m(
    "ai.cancel",
    "ends the run with RUN_FINISHED{outcome:cancelled}"
  ),
  resetAgentConversation: m("agent.reset"),
  switchAgentConversation: m("agent.switchConversation"),
  respondAgentPermission: m(
    "agent.respondPermission",
    "old renderer only (no lineage); the new renderer answers with ai.respondPermission"
  ),
  listAgentSkills: q(
    "agent.skills",
    "skills-loaded arrives as CUSTOM skills.loaded"
  ),
  enqueueAgentMessage: m(
    "agent.queue.enqueue",
    "old renderer; the new renderer uses ai.queue.enqueue, state via CUSTOM queue.updated"
  ),
  dequeueAgentMessage: m("agent.queue.dequeue"),
  getAgentQueue: q("agent.queue.get"),
  clearAgentQueue: m("agent.queue.clear"),
  removeAgentQueueMessage: m(
    "agent.queue.remove",
    "by index, old renderer; ai.queue.remove takes incarnation + entry id"
  ),
  updateAgentQueueMessage: m(
    "agent.queue.update",
    "by index, old renderer; ai.queue.update takes incarnation + entry id"
  ),
  renameLocalFile: m("files.rename"),
  trashLocalFile: m("files.trash"),
  saveResolvedConflict: r(NO_CALLER),
  writeFile: r(`${NO_CALLER} ("Open in editor" only)`),
  stageFile: r(NO_CALLER),
  unstageFile: r(NO_CALLER),
  removeWorkspace: t("db.workspaces.delete"),
  updateWorkspaceLabel: t("db.workspaces.update"),
  checkWorkspacePath: q("workspaces.checkPath"),
  relocateWorkspace: m("workspaces.relocate", "echoes workspaces update"),
  updateAgentSessionLabel: t("db.sessions.update"),
  listBrowserProfiles: q("browser.profiles.list"),
  refreshBrowserProfiles: r(NO_CALLER),
  importBrowserProfile: m("browser.profiles.import"),
  clearImportedBrowserProfile: r(NO_CALLER),
  materializeBrowserRuntime: m("browser.runtime.materialize"),
  presentBrowserRuntime: m("browser.runtime.present"),
  navigateBrowserRuntime: m("browser.runtime.navigate"),
  captureBrowserRuntime: m("browser.runtime.capture"),
  hideBrowserRuntime: m("browser.runtime.hide"),
  closeBrowserRuntime: m("browser.runtime.close"),
  promoteBrowserRuntimeScope: m("browser.runtime.promoteScope"),
  disposeBrowserRuntimeScope: r(`${NO_CALLER} (main disposes on navigation)`),
  disposeBrowserRuntimeWorkspace: r(NO_CALLER),
  listMcpServers: q("mcp.list"),
  addMcpServer: m("mcp.add"),
  updateMcpServer: m("mcp.update"),
  removeMcpServer: m("mcp.remove"),
  setMcpServerDisabled: m("mcp.setDisabled"),
  importMcpServers: m("mcp.import"),
  refreshMcpServers: m("mcp.refresh"),
  restartMcpServer: m("mcp.restart"),
  mcpOAuthSignIn: m("mcp.oauthSignIn"),
  getMcpRuntimeServers: q("mcp.runtime.servers", "live via mcp.runtime.events"),
  getMcpServerLogs: q("mcp.runtime.logs"),
  setBrowserEngine: m("browser.setEngine"),
  connectChromeBrowser: m("browser.chrome.connect"),
  disconnectChromeBrowser: m("browser.chrome.disconnect"),
  setChromeExtensionToken: m("browser.chrome.setExtensionToken"),
  getMcpBrowserStatus: q("browser.status", "live via browser.events status"),
  setMcpBrowserEnabled: m("browser.setEnabled"),
  getToolsetStates: q("settings.toolsets.get"),
  getDefaultAgentMode: q("settings.defaultMode.get"),
  getSandboxSupport: q("settings.sandboxSupport"),
  setDefaultAgentMode: m("settings.defaultMode.set"),
  getNotificationSettings: q("settings.notifications.get"),
  setNotificationSettings: m("settings.notifications.set"),
  setToolsetEnabled: m("settings.toolsets.setEnabled"),
  getExecBackendState: q("settings.execBackend.get"),
  setExecBackend: m("settings.execBackend.set"),
  getTerminalShellState: q("terminal.shell.get"),
  setTerminalShell: m("terminal.shell.set"),
  respondConnector: m("connectors.respond"),
  listConnectorRequests: q("connectors.requests", "live via connectors.events"),
  listBrowserPermissionRequests: q(
    "browser.permissions.list",
    "live via browser.events"
  ),
  setBrowserApproval: m("browser.permissions.setApproval"),
  clearBrowserData: m("browser.clearData"),
  respondBrowserPermission: m("browser.permissions.respond"),
  setAgentSessionModel: t("db.sessions.update"),
  listMemories: t("db.memories.snapshot", "scope global"),
  getCustomInstructions: q("memory.customInstructions.get"),
  setCustomInstructions: m("memory.customInstructions.set"),
  forgetMemory: t("db.memories.delete"),
  forgetAllMemories: m("memory.forgetAll", "echoes memories deletes"),
  listBotMemories: t(
    "db.memories.snapshot",
    "scope bot; memory.bots keeps BotMemoryView (noteDays, empty bots)"
  ),
  forgetBotMemory: t("db.memories.delete"),
  clearBotMemory: m("memory.clearBot", "echoes memories deletes"),
  readTranscript: q(
    "ai.hydrate",
    "ChatHydrationResult + abacus snapshot, from the relay over the v2 thread files"
  ),
  writeTranscript: r(
    "main persists agui thread files from the AG-UI stream at each terminal; the legacy path dual-writes v2 until cut-over"
  ),
  getDeviceStatus: q("devices.status", "live via devices.events"),
  listLocalDevices: q("devices.list"),
  captureDeviceScreenshot: m("devices.screenshot"),
  bootLocalDevice: m("devices.boot"),
  createLocalDevice: m("devices.create"),
  refreshDeviceStatus: m("devices.refresh"),
  setDevicesEnabled: m("devices.setEnabled"),
  setDevicesApproval: m("devices.setApproval"),
  getDeviceProjectInfo: q("devices.projectInfo"),
  interactLocalDevice: m("devices.interact"),
  buildAndRunLocalDevice: m(
    "devices.buildAndRun",
    "progress via devices.events build-state"
  ),
  startDeviceStream: m("devices.stream.start"),
  stopDeviceStream: m("devices.stream.stop"),
  getSimulatorWindowSource: q("devices.simulatorWindowSource"),
  installMaestro: m("devices.installMaestro"),
  fetchWhisperFile: m(
    "voice.whisper.fetch",
    "renderer-next lib/voice/whisper; progress via voice.whisper.progress"
  ),
  isWhisperCached: r(NO_CALLER),
  requestMicrophoneAccess: m(
    "voice.requestMicrophone",
    "renderer-next lib/voice/use-dictation"
  ),
  streamDeviceTouch: m(
    "devices.stream.touch",
    "was ipcRenderer.send; call without await"
  ),
  streamDeviceKey: m(
    "devices.stream.key",
    "was ipcRenderer.send; call without await"
  ),
  openScreenRecordingSettings: m(
    "system.openPrivacyPane",
    'input { pane: "screen-recording" }'
  ),
  openAccessibilitySettings: m(
    "system.openPrivacyPane",
    'input { pane: "accessibility" }'
  ),
  getMessagingSnapshot: q(
    "messaging.snapshot",
    "invalidated by messaging.events updated"
  ),
  updateMessagingPlatform: m("messaging.updatePlatform"),
  decideMessagingPairing: m("messaging.decidePairing"),
  updateMessagingSettings: m("messaging.updateSettings"),
  showMessagingLogin: m("messaging.showLogin"),
  pairSharedChannel: m("messaging.pairShared"),
  unlinkSharedChannel: m("messaging.unlinkShared"),
  openSharedChannelLink: m("messaging.openSharedLink"),
  onDeviceStreamChunk: s(
    "devices.stream.chunks",
    "event iterator of DeviceStreamChunk (input { streamId })"
  ),
  onEvent: s(
    "(split)",
    "the catch-all channel is replaced by typed iterators: see the IpcEvent table"
  ),
};

/**
 * Top-level `window.api.*` (preload/index.ts). Nested members are keyed by
 * their dotted path, as the parity test enumerates them.
 */
export const LEGACY_TOP_LEVEL_MAP: Record<string, LegacyDestination> = {
  openFolderDialog: m("system.dialog.openFolder"),
  openFilesDialog: m(
    "system.dialog.openFiles",
    "data: Buffer → Uint8Array (custom serializer)"
  ),
  readClipboardImage: r(`${NO_CALLER}; composer paste uses the DOM clipboard`),
  fetchUrlAttachment: r(NO_CALLER),
  openExternal: m("system.openExternal", "same isSafeExternalUrl guard"),
  openFilePath: m("system.openPath", "same local-open-guard"),
  showItemInFolder: m("system.showItemInFolder"),
  getAppVersion: q("system.info", "appVersion"),
  showAboutPanel: m("window.showAbout"),
  isFullScreen: q("window.state", "{ fullScreen, focused, maximized }"),
  onFullScreenChange: s("window.events", '{ type: "state", state }'),
  getWindowChrome: q("window.chrome"),
  onWindowChromeChange: s("window.events", '{ type: "chrome", chrome }'),
  recreateMainWindow: r(
    "main-only plumbing for the Linux native-frame fallback (spec 00-window-chrome); the new renderer never asks for it"
  ),
  restartApp: m("system.restart"),
  getHomeDir: q("system.info", "homeDir"),
  hasGoogleChrome: q("browser.hasGoogleChrome"),
  setThemeSource: t(
    "db.prefs.update",
    "the prefs row's theme drives nativeTheme.themeSource in main"
  ),
  platform: q("system.info", "platform (was a sync preload value)"),
  reportFunnelStep: m("system.funnelStep", "fire-and-forget"),
  getAccountState: q("account.state"),
  skipAccountOnboarding: m(
    "account.skipOnboarding",
    "renderer-next features/onboarding/actions: persisted exit first"
  ),
  signOutAccount: m("account.signOut"),
  forgetAccount: m("account.forget"),
  savePastedTempFiles: m("files.savePastedTemp", "Uint8Array payloads"),
  saveLogs: m("system.logs.save"),
  appendLogs: m("system.logs.append", "fire-and-forget; batched client-side"),
  showNotification: m(
    "system.notify",
    "renderer-next lib/notify: kind + dedupeKey; main/notch/notifications"
  ),
  onNotificationClicked: s(
    "system.events",
    '{ type: "notification-clicked", metadata }'
  ),
  "power.getKeepAwake": r(NO_CALLER),
  "power.setKeepAwake": r(NO_CALLER),
  "power.setAgentBusy": r(
    "main derives busy from run state (AG-UI RUN_STARTED/RUN_FINISHED) instead of trusting a renderer edge"
  ),
  "update.check": m("update.check"),
  "update.install": m("update.install"),
  "update.getStatus": q("update.status"),
  "update.onStatusChange": s(
    "update.events",
    "UpdateStatus iterator; the first yield is the current status"
  ),
  "skills.listInstalled": q("skills.listInstalled"),
  "skills.searchMarketplace": q("skills.search"),
  "skills.install": m("skills.install"),
  "skills.remove": m("skills.remove"),
  "skills.openFile": m("skills.openFile"),
  "skills.importLocal": m("skills.importLocal"),
  "files.readImageAsDataUrl": q("files.readImageAsDataUrl"),
  "files.readFileAsText": q("files.readText"),
  "files.readPptx": q("files.readPptx"),
  versions: q("system.info", "versions"),
  "durableState.snapshot": q(
    "durableState.snapshot",
    "old renderer only; the new renderer uses db.prefs; the sync sendSync read stays in the legacy preload"
  ),
  "durableState.set": m("durableState.set", "old renderer only"),
  "durableState.remove": m(
    "durableState.set",
    "value: null (old renderer only)"
  ),
  "durableState.clear": m("durableState.clear", "old renderer only"),
  reportUiActivity: m(
    "window.activity",
    "fire-and-forget; feeds the swap deferral"
  ),
  signalRendererReady: m(
    "window.ready",
    "renderer-host also accepts this, per webContents, as the swap-ready signal"
  ),
  getPathForFile: {
    kind: "M",
    procedure: "(preload) window.abacusHost.getPathForFile",
    note: "needs webUtils in the preload; the only non-port preload export",
  },
};

export interface LegacyEventDestination {
  destination: string;
  note?: string;
}

/** Every `IpcEvent` variant (shared/contracts.ts). */
export const LEGACY_EVENT_MAP: Record<
  IpcEvent["type"],
  LegacyEventDestination
> = {
  "metadata-updated": { destination: "db.workspaces.changes (feed notify)" },
  "git-state-updated": { destination: "db.gitState.changes" },
  "file-tree-root-updated": {
    destination: 'files.events { type: "tree-root-changed" }',
    note: "the renderer invalidates files.treeRoot / treeChildren",
  },
  "terminal-output": {
    destination:
      "terminal.output({ conversationKey, terminalId, generation, fromOffset? })",
    note: "lossless-replayable; offset-addressed snapshot/data chunks",
  },
  "terminal-exited": {
    destination: 'terminal.output final yield { type: "exit" }, then return',
    note: "sticky: a late subscriber still receives it",
  },
  "terminal-state-updated": {
    destination: 'terminal.events({ conversationKey? }) { type: "state" }',
  },
  "local-cli-state-updated": {
    destination:
      "db.sessions update (agentStatus, status) + ai.subscribe CUSTOM abacus.session.state",
  },
  "local-cli-ndjson": {
    destination: "ai.subscribe (AG-UI)",
    note: "the NDJSON stream is not mounted on oRPC",
  },
  "local-cli-system-ready": {
    destination: "ai.subscribe CUSTOM abacus.session.ready",
  },
  "local-cli-skills-loaded": {
    destination: "ai.subscribe CUSTOM abacus.skills.loaded",
  },
  "local-cli-session-created": { destination: "db.sessions insert" },
  "local-cli-session-removed": {
    destination:
      "db.sessions delete (+ db.artifacts deletes, db.routineRuns delete)",
  },
  "local-cli-session-updated": { destination: "db.sessions update (label)" },
  "local-cli-session-conversation-id-updated": {
    destination: "db.sessions update (conversationId)",
  },
  "local-cli-session-model-updated": {
    destination: "db.sessions update (model)",
  },
  "session-turn-state-updated": {
    destination: "db.sessions update (turn)",
    note: "turn state becomes a column",
  },
  "session-artifacts-updated": { destination: "db.artifacts.changes" },
  "mcp-open-preview": {
    destination:
      'browser.events { type: "open-preview", url?, conversationKey? }',
  },
  "browser-runtime-materialized": {
    destination: 'browser.events { type: "runtime-materialized" }',
  },
  "preview-open": {
    destination:
      'files.events { type: "preview-open", path, conversationKey? }',
  },
  "mcp-cursor-move": {
    destination: 'browser.events { type: "cursor", action: "move", x, y }',
    note: "high rate; coalesced",
  },
  "mcp-cursor-click": {
    destination: 'browser.events { type: "cursor", action: "click" }',
  },
  "mcp-cursor-hide": {
    destination: 'browser.events { type: "cursor", action: "hide" }',
  },
  "browser-permission-request": {
    destination: 'browser.events { type: "permission-request" }',
  },
  "browser-permission-cleared": {
    destination: 'browser.events { type: "permission-cleared" }',
  },
  "connector-request": {
    destination: 'connectors.events { type: "request" }',
  },
  "connector-cleared": {
    destination: 'connectors.events { type: "cleared" }',
  },
  "connector-status-changed": {
    destination: 'connectors.events { type: "status-changed" }',
    note: "invalidates connectors.statuses",
  },
  "browser-status-updated": {
    destination: 'browser.events { type: "status", status }',
  },
  "browser-runtime-state-updated": {
    destination: 'browser.events { type: "runtime-state", state }',
  },
  "device-status-updated": {
    destination: 'devices.events { type: "status", status }',
  },
  "device-build-state": {
    destination: 'devices.events { type: "build-state", phase, error? }',
  },
  "mcp-runtime-servers": {
    destination: 'mcp.runtime.events({ sessionId? }) { type: "servers" }',
  },
  "mcp-runtime-status": {
    destination: 'mcp.runtime.events({ sessionId? }) { type: "status" }',
  },
  "mcp-runtime-log": {
    destination: 'mcp.runtime.events({ sessionId? }) { type: "log" }',
    note: "lossless history in mcp.runtime.logs",
  },
  "mcp-runtime-refresh-failed": {
    destination:
      'mcp.runtime.events({ sessionId? }) { type: "refresh-failed" }',
  },
  "mcp-runtime-restart-failed": {
    destination:
      'mcp.runtime.events({ sessionId? }) { type: "restart-failed" }',
  },
  "messaging-updated": {
    destination: 'messaging.events { type: "updated" }',
    note: "invalidates messaging.snapshot",
  },
  "bots-updated": {
    destination:
      'db.bots.changes (feed notify) and bots.events { type: "previews-changed" }',
    note: "the row diff may be empty (a transcript save changes no row), so previews get their own notice",
  },
  "cronjobs-updated": { destination: "db.routines.changes (feed notify)" },
  "messaging-user-message": {
    destination:
      'ai.subscribe: a relay turn is an AG-UI run with a role "user" TEXT_MESSAGE_*',
    note: "retired as a separate event once the emitter lands",
  },
  "messaging-agent-message": {
    destination: "ai.subscribe CUSTOM abacus.messaging.sent",
    note: "retired as a separate event once the emitter lands",
  },
  "credentials-changed": {
    destination:
      'settings.events { type: "credentials-changed", provider, configured? }',
    note: "the only destination; maps to settings.keys.listProviders, account.* and models.list",
  },
  "whisper-download-progress": {
    destination: "voice.whisper.progress iterator",
  },
  "sessions-reloaded": {
    destination: "db.sessions reset batch (+ routineRuns, artifacts)",
  },
  "local-model-progress": { destination: "localModels.progress iterator" },
};

/** Push channels that bypassed the `IpcEvent` catch-all. */
export const LEGACY_CHANNEL_MAP: Record<string, LegacyEventDestination> = {
  "update-status": {
    destination: "update.events",
    note: "the first yield is the current status",
  },
  "notification-clicked": {
    destination: 'system.events { type: "notification-clicked", metadata }',
  },
  "window:full-screen-changed": {
    destination: 'window.events { type: "state", state }',
    note: "only the window the port belongs to",
  },
  "window:chrome-changed": {
    destination: 'window.events { type: "chrome", chrome }',
    note: "legacy renderer hears it only in wco mode",
  },
  "agent:device-stream-chunk": {
    destination: "devices.stream.chunks({ streamId })",
    note: "binary through the Uint8Array serializer",
  },
};
