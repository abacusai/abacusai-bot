import {
  readCustomInstructions,
  writeCustomInstructions,
} from "@abacus-ai/agent/custom-instructions";
import { app, ipcMain } from "electron";

import type {
  BotChangeNotice,
  BotCreateInput,
  BotUpdateInput,
} from "#shared/bots";
import { IpcChannels } from "#shared/channels";
import type {
  AddMcpServerRequest,
  BrowserApproval,
  ClearBrowserDataRequest,
  GetMcpRuntimeServersRequest,
  GetMcpServerLogsRequest,
  ImportMcpServersRequest,
  ListMcpServersRequest,
  McpOAuthSignInRequest,
  RefreshMcpServersRequest,
  RestartMcpServerRequest,
  RespondBrowserPermissionRequest,
  RespondConnectorRequest,
  TranscriptSegment,
  MemoryTargetId,
  ForgetMemoryRequest,
  CaptureDeviceScreenshotRequest,
  NotificationSettings,
  BootLocalDeviceRequest,
  CreateLocalDeviceRequest,
  InteractLocalDeviceRequest,
  BuildAndRunLocalDeviceRequest,
  StartDeviceStreamRequest,
  GetSimulatorWindowSourceRequest,
  StreamDeviceTouchRequest,
  StreamDeviceKeyRequest,
  AgentPermissionResponseRequest,
  AgentQueueMessageRequest,
  AgentRemoveFromQueueRequest,
  AgentUpdateQueueMessageRequest,
  AgentSessionCommandRequest,
  AgentSetModeRequest,
  AgentSetModelRequest,
  AgentSwitchConversationRequest,
  RemoveMcpServerRequest,
  SendAgentMessageRequest,
  SetMcpServerDisabledRequest,
  StartAgentSessionRequest,
  StartTerminalSessionRequest,
  PromoteTerminalSessionScopeRequest,
  ResizeTerminalSessionRequest,
  TerminalRuntimeRequest,
  WriteTerminalInputRequest,
  UpdateMcpServerRequest,
  IpcEvent,
  CreateWorktreeRequest,
  ListWorktreesRequest,
  MaterializeSessionWorktreeRequest,
  SetSessionWorktreeRequest,
  WorkspaceGitContext,
  AbacusAccountInfo,
} from "#shared/contracts";
import {
  ABACUS_CONNECTORS_SERVER_NAME,
  abacusConnectorsMcpEntry,
} from "#shared/contracts";
import type { ConversationKey } from "#shared/conversation-scope";
import type { BackendId } from "#shared/exec-backends";
import type {
  MessagingPairingDecisionRequest,
  UpdateMessagingPlatformRequest,
  UpdateMessagingSettingsRequest,
  MessagingPlatformId,
} from "#shared/messaging";
import type { RoutineCreateInput, RoutineUpdateInput } from "#shared/routines";
import { PROVIDER_ENV_VARS } from "#shared/settings";

import { sessionDefaultWorkspace } from "./paths";
import {
  activateProfile,
  legacyProfileKeyFor,
  profileKeyFor,
} from "./profile-home";
import { sendToRenderer } from "./renderer-host";
import { ServiceHost } from "./service-host";
import {
  addPromptToHistory,
  readPromptHistory,
} from "./services/config/prompt-history";
import {
  readSettings,
  saveApiKey,
  setDefaultModel,
  storedKeyProviders,
} from "./services/config/settings";
import { signInToMcpServer } from "./services/mcp/mcp-oauth-service";
import {
  abacusCredentialRejected,
  clearAbacusCache,
  fetchAbacusAccount,
} from "./services/providers/abacus";
import {
  cancelAbacusAuth,
  startAbacusAuth,
} from "./services/providers/abacus-auth-service";
import {
  cancelConnectorConnect,
  disconnectAbacusConnector,
  listAbacusConnectors,
  startConnectorConnect,
} from "./services/providers/abacus-connector-service";
import { abacusRoutellmV1 } from "./services/providers/abacus-host";
import { signOut as clearLocalAccount } from "./services/providers/account-service";
import { listAvailableModels } from "./services/providers/models";
import { clearOpenRouterCache } from "./services/providers/openrouter";
import {
  cancelOpenRouterAuth,
  startOpenRouterAuth,
} from "./services/providers/openrouter-auth-service";
import { getUsageSnapshot } from "./services/providers/usage";
import { accountStashKey } from "./services/session/account-session-stash";

export const registerIpcHandlers = (serviceHost: ServiceHost): void => {
  const dispatchEvent = (event: IpcEvent): void => {
    sendToRenderer(IpcChannels.Event, event);
  };

  serviceHost.setEventDispatcher(dispatchEvent);

  /** The connector gateway MCP entry exists exactly while an Abacus key does. */
  const syncAbacusGateway = (key?: string): void => {
    if (key != null && key.trim().length > 0) {
      serviceHost.ensureMcpServer({
        mode: "code",
        name: ABACUS_CONNECTORS_SERVER_NAME,
        config: abacusConnectorsMcpEntry(`${abacusRoutellmV1()}/mcp`),
      });
    } else {
      serviceHost.removeMcpServer({
        mode: "code",
        name: ABACUS_CONNECTORS_SERVER_NAME,
      });
    }
  };

  /**
   * The one place a stored credential is announced. Every surface that stores
   * a key routes through here, so the stale catalog is dropped, the gateway
   * entry is reconciled and the renderer re-reads exactly once per save.
   */
  const credentialsChanged = (provider: string, key?: string): void => {
    if (provider === "openrouter") clearOpenRouterCache();
    if (provider === "abacus") clearAbacusCache();
    if (provider === "abacus") syncAbacusGateway(key);
    // Running sessions took their credentials from the environment as it was
    // when they spawned; without this the key only works in the next chat.
    serviceHost.refreshAgentProviders();
    dispatchEvent({
      type: "credentials-changed",
      provider,
      ...(key == null ? {} : { configured: key.trim().length > 0 }),
      emittedAt: new Date().toISOString(),
    });
  };

  // A profile relaunch bypasses the credential-save IPC; reconcile from disk.
  syncAbacusGateway(
    readSettings().apiKeys?.[PROVIDER_ENV_VARS.abacus] ?? undefined
  );

  /** Resolve a newly stored key past the short propagation delay after signup. */
  const identifyAbacusAccount = async (): Promise<AbacusAccountInfo | null> => {
    let account = await fetchAbacusAccount(true);
    for (let attempt = 0; account == null && attempt < 3; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1200));
      account = await fetchAbacusAccount(true);
    }
    return account;
  };

  /**
   * Make one Abacus credential authoritative, regardless of which UI supplied
   * it. This is the only path that may create an authenticated session.
   */
  const adoptAbacusCredential = async (
    rawKey: string
  ): Promise<{ ok: true } | { ok: false; error: "unidentified-account" }> => {
    const key = rawKey.trim();
    const previousKey =
      readSettings().apiKeys?.[PROVIDER_ENV_VARS.abacus]?.trim() ?? "";
    saveApiKey("abacus", key);
    // Clear the old account cache so validation cannot inherit the previous
    // user; nothing is announced until the key has an identity and a profile.
    clearAbacusCache();

    const account = await identifyAbacusAccount();
    const profileKey = account != null ? profileKeyFor(account) : null;
    if (account == null || profileKey == null) {
      // A failed switch must not sign the previous account out.
      saveApiKey("abacus", previousKey);
      credentialsChanged("abacus", previousKey);
      return { ok: false, error: "unidentified-account" };
    }

    const legacyKey = legacyProfileKeyFor(account);
    const aliases =
      legacyKey != null && legacyKey !== profileKey ? [legacyKey] : [];
    if (activateProfile(profileKey, key, aliases)) {
      // This process still owns the departing profile; leave the new key only
      // in its target profile and relaunch there. `quit`, not `exit`: the
      // before-quit handler disposes the terminal PTYs, and a live zigpty
      // reader thread aborts the process if Node's env is torn down under it.
      saveApiKey("abacus", "");
      clearLocalAccount();
      credentialsChanged("abacus", "");
      setTimeout(() => {
        app.relaunch();
        app.quit();
      }, 300);
      return { ok: true };
    }

    credentialsChanged("abacus", key);
    const restored = serviceHost.restoreSessionsForAccount(
      accountStashKey(account.email, key)
    );
    console.log(
      `[account] signed in as ${account.email ?? "?"}: restored ${restored} session(s)`
    );
    return { ok: true };
  };

  /** End the current account session without deleting its conversations. */
  const clearAbacusCredential = async (
    knownAccount?: AbacusAccountInfo | null
  ): Promise<{
    stashedSessions: number;
    settings: ReturnType<typeof readSettings>;
  }> => {
    const departingKey =
      readSettings().apiKeys?.[PROVIDER_ENV_VARS.abacus]?.trim() ?? "";
    const account =
      knownAccount === undefined ? await fetchAbacusAccount() : knownAccount;
    const stashedSessions =
      departingKey.length > 0
        ? serviceHost.stashSessionsForAccount(
            accountStashKey(account?.email, departingKey)
          )
        : 0;

    const settings = saveApiKey("abacus", "");
    clearLocalAccount();
    credentialsChanged("abacus", "");
    // The one event that takes every session down at once; without this line
    // the log showed five SIGTERMs and no reason.
    console.log(
      `[account] signed out${account?.email ? ` (${account.email})` : ""}: stashed ${stashedSessions} session(s)`
    );
    return { stashedSessions, settings };
  };

  ipcMain.handle(IpcChannels.GetMetadata, (_event, request) => {
    return serviceHost.getMetadata(request);
  });

  ipcMain.handle(IpcChannels.GetGitState, () => {
    return serviceHost.getGitState();
  });

  ipcMain.handle(
    IpcChannels.ListWorktrees,
    (_event, request: ListWorktreesRequest) =>
      serviceHost.listWorktrees(request.workspaceId)
  );

  ipcMain.handle(
    IpcChannels.CreateWorktree,
    (_event, request: CreateWorktreeRequest) =>
      serviceHost.createWorktree(request)
  );

  ipcMain.handle(
    IpcChannels.SetSessionWorktree,
    (_event, request: SetSessionWorktreeRequest) =>
      serviceHost.setSessionWorktree(request)
  );

  ipcMain.handle(
    IpcChannels.MaterializeSessionWorktree,
    (_event, request: MaterializeSessionWorktreeRequest) =>
      serviceHost.materializeSessionWorktree(request)
  );

  ipcMain.handle(IpcChannels.GetFileTreeRoot, () => {
    return serviceHost.getFileTreeRoot();
  });

  ipcMain.handle(IpcChannels.ListModels, (_event, refresh?: boolean) =>
    listAvailableModels(refresh === true)
  );
  /**
   * A key the platform has revoked is cleared here, since every signed-in
   * check reads the stored key. Only an outright refusal counts; a timeout or
   * a 500 keeps the session.
   */
  ipcMain.handle(
    IpcChannels.GetAbacusAccount,
    async (_event, refresh?: boolean) => {
      const account = await fetchAbacusAccount(refresh === true);
      if (account != null || !abacusCredentialRejected()) return account;

      const stored = readSettings().apiKeys?.[PROVIDER_ENV_VARS.abacus] ?? "";
      if (stored.trim().length === 0) return null;

      await clearAbacusCredential(account);

      return null;
    }
  );

  ipcMain.handle(IpcChannels.GetUsageSnapshot, () => getUsageSnapshot());

  ipcMain.handle(IpcChannels.GetSettings, () => readSettings());

  // The composer's up-arrow history, stored per profile.
  ipcMain.handle(IpcChannels.ListPromptHistory, (_event, scope: string) =>
    readPromptHistory(scope)
  );
  ipcMain.handle(
    IpcChannels.AddPromptHistory,
    (_event, scope: string, prompt: string) => addPromptToHistory(scope, prompt)
  );

  ipcMain.handle(IpcChannels.ListStoredKeyProviders, () =>
    storedKeyProviders()
  );

  ipcMain.handle(
    IpcChannels.SaveApiKey,
    async (_event, provider: string, key: string) => {
      if (provider === "abacus") {
        if (key.trim().length === 0)
          return (await clearAbacusCredential()).settings;

        const result = await adoptAbacusCredential(key);
        if (result.ok === false) throw new Error(result.error);
        return readSettings();
      }
      const settings = saveApiKey(provider, key);
      credentialsChanged(provider, key);
      return settings;
    }
  );

  ipcMain.handle(IpcChannels.SetDefaultModel, (_event, modelId: string) =>
    setDefaultModel(modelId)
  );

  ipcMain.handle(
    IpcChannels.AddWorkspace,
    (_event, workspacePath: string, isRemote?: boolean) => {
      return serviceHost.addWorkspace(workspacePath, isRemote);
    }
  );

  ipcMain.handle(IpcChannels.EnsureBotWorkspace, () => {
    return serviceHost.ensureDefaultWorkspace();
  });

  ipcMain.handle(IpcChannels.EnsureSessionHomeWorkspace, () => {
    return serviceHost.ensureSessionHomeWorkspace();
  });

  ipcMain.handle(IpcChannels.GetSessionHomeWorkspacePath, () => {
    return sessionDefaultWorkspace();
  });

  ipcMain.handle(IpcChannels.SwitchWorkspace, (_event, workspaceId: string) => {
    return serviceHost.switchWorkspace(workspaceId);
  });

  ipcMain.handle(IpcChannels.RemoveWorkspace, (_event, workspaceId: string) => {
    return serviceHost.removeWorkspace(workspaceId);
  });

  ipcMain.handle(
    IpcChannels.UpdateWorkspaceLabel,
    (_event, workspaceId: string, label: string) => {
      return serviceHost.updateWorkspaceLabel(workspaceId, label);
    }
  );

  ipcMain.handle(
    IpcChannels.CheckWorkspacePath,
    (_event, workspaceId: string) => {
      return serviceHost.checkWorkspacePath(workspaceId);
    }
  );

  ipcMain.handle(
    IpcChannels.RelocateWorkspace,
    (_event, workspaceId: string, newPath: string) => {
      return serviceHost.relocateWorkspace(workspaceId, newPath);
    }
  );

  ipcMain.handle(IpcChannels.InitGit, () => {
    return serviceHost.initGit();
  });

  ipcMain.handle(
    IpcChannels.GetFileTreeChildren,
    (_event, directoryPath: string) => {
      return serviceHost.getFileTreeChildren(directoryPath);
    }
  );

  ipcMain.handle(IpcChannels.SearchFiles, (_event, query: string) => {
    return serviceHost.searchFiles(query);
  });

  ipcMain.handle(
    IpcChannels.GetGitDiffForPath,
    (_event, filePath: string, scope?: "staged" | "unstaged") => {
      return serviceHost.getGitDiffForPath(filePath, scope);
    }
  );

  ipcMain.handle(
    IpcChannels.GetGitChangeStatsForPath,
    (_event, filePath: string, scope?: "staged" | "unstaged" | "all") => {
      return serviceHost.getGitChangeStatsForPath(filePath, scope);
    }
  );

  ipcMain.handle(
    IpcChannels.StartTerminalSession,
    (_event, request: StartTerminalSessionRequest) => {
      return serviceHost.startTerminalSession(request);
    }
  );

  ipcMain.handle(
    IpcChannels.WriteTerminalInput,
    (_event, request: WriteTerminalInputRequest) => {
      return serviceHost.writeTerminalInput(request);
    }
  );

  ipcMain.handle(
    IpcChannels.ResizeTerminalSession,
    (_event, request: ResizeTerminalSessionRequest) => {
      return serviceHost.resizeTerminalSession(request);
    }
  );

  ipcMain.handle(
    IpcChannels.HideTerminalSession,
    (_event, request: TerminalRuntimeRequest) => {
      return serviceHost.hideTerminalSession(request);
    }
  );

  ipcMain.handle(
    IpcChannels.PromoteTerminalSessionScope,
    (_event, request: PromoteTerminalSessionScopeRequest) => {
      return serviceHost.promoteTerminalSessionScope(request);
    }
  );

  ipcMain.handle(
    IpcChannels.GetGitBranches,
    (_event, context?: WorkspaceGitContext) => {
      return serviceHost.getGitBranches(context);
    }
  );

  ipcMain.handle(
    IpcChannels.GetGitCurrentBranch,
    (_event, context?: WorkspaceGitContext) => {
      return serviceHost.getGitCurrentBranch(context);
    }
  );

  ipcMain.handle(
    IpcChannels.GetPrInfo,
    (_event, context?: WorkspaceGitContext) => {
      return serviceHost.getPrInfo(context);
    }
  );

  ipcMain.handle(
    IpcChannels.GetSessionTurnState,
    (_event, workspaceId: string, sessionId: string) => {
      return serviceHost.getSessionTurnState(workspaceId, sessionId);
    }
  );

  ipcMain.handle(
    IpcChannels.SwitchGitBranch,
    (_event, branchName: string, context?: WorkspaceGitContext) => {
      return serviceHost.switchGitBranch(branchName, context);
    }
  );

  ipcMain.handle(
    IpcChannels.CreateGitBranch,
    (_event, branchName: string, context?: WorkspaceGitContext) => {
      return serviceHost.createGitBranch(branchName, context);
    }
  );

  ipcMain.handle(
    IpcChannels.CreateAgentSession,
    (_event, workspaceId: string) => {
      return serviceHost.createAgentSession(workspaceId);
    }
  );

  ipcMain.handle(
    IpcChannels.ListAgentSessions,
    (_event, workspaceId: string) => {
      return serviceHost.listAgentSessions(workspaceId);
    }
  );

  ipcMain.handle(IpcChannels.ListAllAgentSessions, () => {
    return serviceHost.listAllAgentSessions();
  });

  ipcMain.handle(IpcChannels.ListSessionArtifacts, () => {
    return serviceHost.listSessionArtifacts();
  });

  ipcMain.handle(IpcChannels.ListBots, () => {
    return serviceHost.listBots();
  });

  ipcMain.handle(IpcChannels.ListBotChatPreviews, () => {
    return serviceHost.listBotChatPreviews();
  });

  ipcMain.handle(IpcChannels.ListBotSenderChats, () => {
    return serviceHost.listBotSenderChats();
  });

  ipcMain.handle(IpcChannels.CreateBot, (_event, input: BotCreateInput) => {
    return serviceHost.createBot(input);
  });

  ipcMain.handle(
    IpcChannels.UpdateBot,
    (_event, id: string, changes: BotUpdateInput) => {
      return serviceHost.updateBot(id, changes);
    }
  );

  ipcMain.handle(IpcChannels.DeleteBot, (_event, id: string) => {
    serviceHost.deleteBot(id);
  });

  ipcMain.handle(
    IpcChannels.AnnounceBotChange,
    (_event, id: string, notice: BotChangeNotice) => {
      return serviceHost.announceBotChange(id, notice);
    }
  );

  ipcMain.handle(IpcChannels.OpenBotChat, (_event, botId: string) => {
    return serviceHost.openBotChat(botId);
  });

  ipcMain.handle(IpcChannels.ListRoutines, () => {
    return serviceHost.listRoutines();
  });

  ipcMain.handle(IpcChannels.ListRoutineRuns, (_event, routineId: string) => {
    return serviceHost.listRoutineRuns(routineId);
  });

  ipcMain.handle(
    IpcChannels.EditRoutineByChat,
    (_event, routineId: string, text: string) => {
      return serviceHost.editRoutineByChat(routineId, text);
    }
  );

  ipcMain.handle(
    IpcChannels.CreateRoutine,
    (_event, input: RoutineCreateInput) => {
      return serviceHost.createRoutine(input);
    }
  );

  ipcMain.handle(
    IpcChannels.UpdateRoutine,
    (_event, id: string, changes: RoutineUpdateInput) => {
      return serviceHost.updateRoutine(id, changes);
    }
  );

  ipcMain.handle(IpcChannels.RemoveRoutine, (_event, id: string) => {
    serviceHost.removeRoutine(id);
  });

  ipcMain.handle(
    IpcChannels.RunRoutine,
    async (_event, id: string, trigger?: "manual" | "create") => {
      await serviceHost.runRoutine(
        id,
        trigger === "create" ? "create" : "manual"
      );
    }
  );

  ipcMain.handle(IpcChannels.StartOpenRouterAuth, async () => {
    const result = await startOpenRouterAuth();
    if (result.ok !== true) {
      return {
        ok: false,
        error: result.error,
        ...(result.cancelled === true ? { cancelled: true } : {}),
      };
    }

    // Stored exactly like a pasted key: one code path however it arrived.
    saveApiKey("openrouter", result.key);
    credentialsChanged("openrouter");
    // The free-model list is only fetchable once a key exists.
    await listAvailableModels(true);
    return { ok: true };
  });

  ipcMain.handle(IpcChannels.StartAbacusAuth, async () => {
    const result = await startAbacusAuth();
    if (result.ok !== true) {
      return {
        ok: false,
        error: result.error,
        ...(result.cancelled === true ? { cancelled: true } : {}),
      };
    }

    const adopted = await adoptAbacusCredential(result.key);
    if (!adopted.ok) return adopted;

    // Warm the catalog for same-profile sign-ins. A profile switch relaunches,
    // and the new renderer reads it normally from the target profile.
    await listAvailableModels(true);
    return adopted;
  });

  ipcMain.handle(
    IpcChannels.SignOutAbacus,
    async (_event, options: { keepOtherApiKeys: boolean }) => {
      const { stashedSessions } = await clearAbacusCredential();

      const removedProviders: string[] = [];
      if (options?.keepOtherApiKeys !== true) {
        for (const provider of storedKeyProviders()) {
          if (provider === "abacus") continue;
          saveApiKey(provider, "");
          credentialsChanged(provider);
          removedProviders.push(provider);
        }
      }

      // One catalog refresh after all key changes.
      await listAvailableModels(true);
      return { stashedSessions, removedProviders };
    }
  );

  ipcMain.handle(IpcChannels.CancelAbacusAuth, () => {
    cancelAbacusAuth();
  });

  ipcMain.handle(IpcChannels.CancelOpenRouterAuth, () => {
    cancelOpenRouterAuth();
  });

  ipcMain.handle(IpcChannels.ListAbacusConnectors, () =>
    listAbacusConnectors()
  );

  ipcMain.handle(
    IpcChannels.ConnectAbacusConnector,
    async (_event, service: string) => {
      const result = await startConnectorConnect(service);
      if (result.ok) {
        // The MCP file is user-editable, so the url and headers under the
        // app's own name are rewritten rather than assumed.
        serviceHost.ensureMcpServer({
          mode: "code",
          name: ABACUS_CONNECTORS_SERVER_NAME,
          config: abacusConnectorsMcpEntry(`${abacusRoutellmV1()}/mcp`),
        });
      }
      return result;
    }
  );

  ipcMain.handle(IpcChannels.CancelAbacusConnector, () => {
    cancelConnectorConnect();
  });

  ipcMain.handle(
    IpcChannels.DisconnectAbacusConnector,
    (_event, service: string) => disconnectAbacusConnector(service)
  );

  ipcMain.handle(IpcChannels.GetMessagingSnapshot, () => {
    return serviceHost.getMessagingSnapshot();
  });

  ipcMain.handle(
    IpcChannels.UpdateMessagingPlatform,
    (_event, request: UpdateMessagingPlatformRequest) => {
      return serviceHost.updateMessagingPlatform(request);
    }
  );

  ipcMain.handle(
    IpcChannels.DecideMessagingPairing,
    (_event, request: MessagingPairingDecisionRequest) => {
      return serviceHost.decideMessagingPairing(request);
    }
  );

  ipcMain.handle(
    IpcChannels.UpdateMessagingSettings,
    (_event, request: UpdateMessagingSettingsRequest) => {
      return serviceHost.updateMessagingSettings(request);
    }
  );

  ipcMain.handle(
    IpcChannels.ShowMessagingLogin,
    (_event, platformId: MessagingPlatformId) => {
      serviceHost.showMessagingLogin(platformId);
    }
  );

  ipcMain.handle(
    IpcChannels.PairSharedChannel,
    (_event, platformId: MessagingPlatformId) => {
      return serviceHost.pairSharedChannel(platformId);
    }
  );

  ipcMain.handle(
    IpcChannels.UnlinkSharedChannel,
    (_event, platformId: MessagingPlatformId) => {
      return serviceHost.unlinkSharedChannel(platformId);
    }
  );

  ipcMain.handle(
    IpcChannels.OpenSharedChannelLink,
    (_event, platformId: MessagingPlatformId, target?: "install" | "dm") => {
      return serviceHost.openSharedChannelLink(platformId, target);
    }
  );

  ipcMain.handle(
    IpcChannels.RemoveAgentSession,
    (_event, workspaceId: string, sessionId: string) => {
      return serviceHost.removeAgentSession(workspaceId, sessionId);
    }
  );

  ipcMain.handle(
    IpcChannels.StartAgentSession,
    (_event, request: StartAgentSessionRequest) => {
      return serviceHost.startAgentSession(request);
    }
  );

  ipcMain.handle(
    IpcChannels.StopAgentSession,
    (_event, request: AgentSessionCommandRequest) => {
      return serviceHost.stopAgentSession(request);
    }
  );

  ipcMain.handle(
    IpcChannels.GetAgentSessionState,
    (_event, request: AgentSessionCommandRequest) => {
      return serviceHost.getAgentSessionState(request);
    }
  );

  ipcMain.handle(
    IpcChannels.SendAgentMessage,
    (_event, request: SendAgentMessageRequest) => {
      // false means the renderer has an on-screen echo to take back.
      return serviceHost.sendAgentMessage(request);
    }
  );

  ipcMain.handle(
    IpcChannels.SetAgentMode,
    (_event, request: AgentSetModeRequest) => {
      serviceHost.setAgentMode(request);
    }
  );

  ipcMain.handle(
    IpcChannels.SetAgentModel,
    (_event, request: AgentSetModelRequest) => {
      serviceHost.setAgentModel(request);
    }
  );

  ipcMain.handle(
    IpcChannels.StopAgentTurn,
    (_event, request: AgentSessionCommandRequest) => {
      serviceHost.stopAgentTurn(request);
    }
  );

  ipcMain.handle(
    IpcChannels.ResetAgentConversation,
    (_event, request: AgentSessionCommandRequest) => {
      serviceHost.resetAgentConversation(request);
    }
  );

  ipcMain.handle(
    IpcChannels.SwitchAgentConversation,
    (_event, request: AgentSwitchConversationRequest) => {
      serviceHost.switchAgentConversation(request);
    }
  );

  ipcMain.handle(
    IpcChannels.RespondAgentPermission,
    (_event, request: AgentPermissionResponseRequest) => {
      serviceHost.respondAgentPermission(request);
    }
  );

  ipcMain.handle(
    IpcChannels.ListAgentSkills,
    (_event, request: AgentSessionCommandRequest) => {
      serviceHost.listAgentSkills(request);
    }
  );

  ipcMain.handle(
    IpcChannels.EnqueueAgentMessage,
    (_event, request: AgentQueueMessageRequest) => {
      serviceHost.enqueueAgentMessage(request);
    }
  );

  ipcMain.handle(
    IpcChannels.DequeueAgentMessage,
    (_event, request: AgentSessionCommandRequest) => {
      serviceHost.dequeueAgentMessage(request);
    }
  );

  ipcMain.handle(
    IpcChannels.GetAgentQueue,
    (_event, request: AgentSessionCommandRequest) => {
      serviceHost.getAgentQueue(request);
    }
  );

  ipcMain.handle(
    IpcChannels.ClearAgentQueue,
    (_event, request: AgentSessionCommandRequest) => {
      serviceHost.clearAgentQueue(request);
    }
  );

  ipcMain.handle(
    IpcChannels.RemoveAgentQueueMessage,
    (_event, request: AgentRemoveFromQueueRequest) => {
      serviceHost.removeAgentQueueMessage(request);
    }
  );

  ipcMain.handle(
    IpcChannels.UpdateAgentQueueMessage,
    (_event, request: AgentUpdateQueueMessageRequest) => {
      serviceHost.updateAgentQueueMessage(request);
    }
  );

  ipcMain.handle(
    IpcChannels.RenameLocalFile,
    (_event, fromPath: string, toPath: string) => {
      return serviceHost.renameLocalFile(fromPath, toPath);
    }
  );

  ipcMain.handle(IpcChannels.TrashLocalFile, (_event, filePath: string) => {
    return serviceHost.trashLocalFile(filePath);
  });

  ipcMain.handle(
    IpcChannels.SaveResolvedConflict,
    (_event, filePath: string, content: string) => {
      return serviceHost.saveResolvedConflict(filePath, content);
    }
  );

  ipcMain.handle(
    IpcChannels.WriteFile,
    (_event, filePath: string, content: string) => {
      return serviceHost.writeFile(filePath, content);
    }
  );

  ipcMain.handle(IpcChannels.StageFile, (_event, filePath: string) => {
    return serviceHost.stageFile(filePath);
  });

  ipcMain.handle(IpcChannels.UnstageFile, (_event, filePath: string) => {
    return serviceHost.unstageFile(filePath);
  });

  ipcMain.handle(
    IpcChannels.UpdateAgentSessionLabel,
    (_event, workspaceId: string, sessionId: string, label: string) => {
      return serviceHost.updateAgentSessionLabel(workspaceId, sessionId, label);
    }
  );

  ipcMain.handle(IpcChannels.ListBrowserProfiles, () => {
    return serviceHost.listBrowserProfiles();
  });

  ipcMain.handle(IpcChannels.RefreshBrowserProfiles, () => {
    return serviceHost.refreshBrowserProfiles();
  });

  ipcMain.handle(
    IpcChannels.ImportBrowserProfile,
    (_event, profileId: string) => {
      return serviceHost.importBrowserProfile(profileId);
    }
  );

  ipcMain.handle(
    IpcChannels.ClearImportedBrowserProfile,
    (_event, profileId: string) => {
      return serviceHost.clearImportedBrowserProfile(profileId);
    }
  );

  ipcMain.handle(
    IpcChannels.ListMcpServers,
    (_event, request: ListMcpServersRequest) => {
      return serviceHost.listMcpServers(request);
    }
  );

  ipcMain.handle(
    IpcChannels.AddMcpServer,
    (_event, request: AddMcpServerRequest) => {
      return serviceHost.addMcpServer(request);
    }
  );

  ipcMain.handle(
    IpcChannels.UpdateMcpServer,
    (_event, request: UpdateMcpServerRequest) => {
      return serviceHost.updateMcpServer(request);
    }
  );

  ipcMain.handle(
    IpcChannels.RemoveMcpServer,
    (_event, request: RemoveMcpServerRequest) => {
      return serviceHost.removeMcpServer(request);
    }
  );

  ipcMain.handle(
    IpcChannels.SetMcpServerDisabled,
    (_event, request: SetMcpServerDisabledRequest) => {
      return serviceHost.setMcpServerDisabled(request);
    }
  );

  ipcMain.handle(
    IpcChannels.ImportMcpServers,
    (_event, request: ImportMcpServersRequest) => {
      return serviceHost.importMcpServers(request);
    }
  );

  ipcMain.handle(
    IpcChannels.RefreshMcpServers,
    (_event, request: RefreshMcpServersRequest) => {
      return serviceHost.refreshMcpServersForSession(request);
    }
  );

  ipcMain.handle(
    IpcChannels.McpOAuthSignIn,
    async (_event, request: McpOAuthSignInRequest) => {
      // The renderer names the server but never supplies the URL, so a
      // compromised page cannot point the flow at an attacker's endpoints.
      const server = serviceHost
        .listMcpServers({ mode: request.mode })
        .find((entry) => entry.id === request.name);

      if (server?.config.url == null) {
        return { success: false, error: "No such HTTP server is configured." };
      }

      if (server.config.oauth === false) {
        return { success: false, error: "OAuth is disabled for this server." };
      }

      const result = await signInToMcpServer(
        server.config.url,
        server.config.oauth != null ? { oauth: server.config.oauth } : {}
      );

      if (result.ok) {
        await serviceHost.notifyMcpSignedIn(request.mode);
        return { success: true };
      }

      return {
        success: false,
        error: result.error,
        ...(result.cancelled === true ? { cancelled: true } : {}),
      };
    }
  );

  ipcMain.handle(
    IpcChannels.RestartMcpServer,
    (_event, request: RestartMcpServerRequest) => {
      return serviceHost.restartMcpServerForSession(request);
    }
  );

  ipcMain.handle(
    IpcChannels.GetMcpRuntimeServers,
    (_event, request: GetMcpRuntimeServersRequest) => {
      return serviceHost.getMcpRuntimeServersForSession(request);
    }
  );

  ipcMain.handle(
    IpcChannels.GetMcpServerLogs,
    (_event, request: GetMcpServerLogsRequest) => {
      return serviceHost.getMcpServerLogsForSession(request);
    }
  );

  ipcMain.handle(IpcChannels.GetMcpBrowserStatus, () => {
    return serviceHost.getMcpBrowserStatus();
  });

  ipcMain.handle(
    IpcChannels.SetMcpBrowserEnabled,
    (_event, enabled: boolean) => {
      return serviceHost.setMcpBrowserEnabled(enabled);
    }
  );

  ipcMain.handle(IpcChannels.GetSandboxEnabled, () => {
    return serviceHost.getSandboxEnabled();
  });

  ipcMain.handle(IpcChannels.SetSandboxEnabled, (_event, enabled: boolean) => {
    return serviceHost.setSandboxEnabled(enabled);
  });

  ipcMain.handle(IpcChannels.GetXaiSearchEnabled, () => {
    return serviceHost.getXaiSearchEnabled();
  });

  ipcMain.handle(
    IpcChannels.SetXaiSearchEnabled,
    (_event, enabled: boolean) => {
      return serviceHost.setXaiSearchEnabled(enabled);
    }
  );

  ipcMain.handle(IpcChannels.GetNotificationSettings, () => {
    return serviceHost.getNotificationSettings();
  });

  ipcMain.handle(
    IpcChannels.SetNotificationSettings,
    (_event, next: NotificationSettings) => {
      return serviceHost.setNotificationSettings(next);
    }
  );

  ipcMain.handle(IpcChannels.GetToolsetStates, () => {
    return serviceHost.getToolsetStates();
  });

  ipcMain.handle(
    IpcChannels.SetToolsetEnabled,
    (_event, toolsetId: string, enabled: boolean) => {
      return serviceHost.setToolsetEnabled(toolsetId, enabled);
    }
  );

  ipcMain.handle(IpcChannels.GetExecBackendState, () => {
    return serviceHost.getExecBackendState();
  });

  ipcMain.handle(IpcChannels.SetExecBackend, (_event, backend: BackendId) => {
    return serviceHost.setExecBackend(backend);
  });

  ipcMain.handle(
    IpcChannels.RespondConnector,
    async (_event, request: RespondConnectorRequest) => {
      await serviceHost.respondConnector(request);
    }
  );

  ipcMain.handle(
    IpcChannels.ListConnectorRequests,
    (_event, conversationKey: ConversationKey) =>
      serviceHost.listConnectorRequests(conversationKey)
  );

  ipcMain.handle(
    IpcChannels.ListBrowserPermissionRequests,
    (_event, conversationKey: ConversationKey) =>
      serviceHost.listBrowserPermissionRequests(conversationKey)
  );

  ipcMain.handle(
    IpcChannels.SetBrowserApproval,
    (_event, approval: BrowserApproval) => {
      return serviceHost.setBrowserApproval(approval);
    }
  );

  ipcMain.handle(
    IpcChannels.ClearBrowserData,
    (_event, request?: ClearBrowserDataRequest) => {
      return serviceHost.clearBrowserData(request);
    }
  );

  ipcMain.handle(
    IpcChannels.RespondBrowserPermission,
    (_event, request: RespondBrowserPermissionRequest) => {
      return serviceHost.respondBrowserPermission(request);
    }
  );

  ipcMain.handle(
    IpcChannels.SetAgentSessionModel,
    (_event, workspaceId: string, sessionId: string, model: string) => {
      return serviceHost.setAgentSessionModel(workspaceId, sessionId, model);
    }
  );

  ipcMain.handle(IpcChannels.ListMemories, () => {
    return serviceHost.listMemories();
  });

  ipcMain.handle(
    IpcChannels.ForgetMemory,
    (_event, request: ForgetMemoryRequest) => {
      return serviceHost.forgetMemory(request);
    }
  );

  ipcMain.handle(
    IpcChannels.ForgetAllMemories,
    (_event, target: MemoryTargetId) => {
      return serviceHost.forgetAllMemories(target);
    }
  );

  ipcMain.handle(IpcChannels.ListBotMemories, () => {
    return serviceHost.listBotMemories();
  });

  ipcMain.handle(
    IpcChannels.ForgetBotMemory,
    (_event, request: { botId: string; index: number; entry: string }) => {
      return serviceHost.forgetBotMemory(request);
    }
  );

  ipcMain.handle(IpcChannels.ClearBotMemory, (_event, botId: string) => {
    return serviceHost.clearBotMemory(botId);
  });

  // Straight through to the agent package's store, shared with the terminal
  // client; the agent re-reads the file each turn, so no notification needed.
  ipcMain.handle(IpcChannels.GetCustomInstructions, () =>
    readCustomInstructions()
  );

  ipcMain.handle(IpcChannels.SetCustomInstructions, (_event, text: string) => {
    writeCustomInstructions(typeof text === "string" ? text : "");

    return readCustomInstructions();
  });

  ipcMain.handle(IpcChannels.ReadTranscript, (_event, sessionId: string) => {
    return serviceHost.readTranscript(sessionId);
  });

  ipcMain.handle(
    IpcChannels.WriteTranscript,
    (_event, sessionId: string, segments: TranscriptSegment[]) => {
      return serviceHost.writeTranscript(sessionId, segments);
    }
  );

  ipcMain.handle(IpcChannels.GetDeviceStatus, () => {
    return serviceHost.getDeviceStatus();
  });

  ipcMain.handle(IpcChannels.ListLocalDevices, () => {
    return serviceHost.listLocalDevices();
  });

  ipcMain.handle(
    IpcChannels.CaptureDeviceScreenshot,
    (_event, request: CaptureDeviceScreenshotRequest) => {
      return serviceHost.captureDeviceScreenshot(request);
    }
  );

  ipcMain.handle(
    IpcChannels.BootLocalDevice,
    (_event, request: BootLocalDeviceRequest) => {
      return serviceHost.bootLocalDevice(request);
    }
  );

  ipcMain.handle(
    IpcChannels.CreateLocalDevice,
    (_event, request: CreateLocalDeviceRequest) => {
      return serviceHost.createLocalDevice(request);
    }
  );

  ipcMain.handle(IpcChannels.RefreshDeviceStatus, () => {
    return serviceHost.refreshDeviceStatus();
  });

  ipcMain.handle(IpcChannels.SetDevicesEnabled, (_event, enabled: boolean) => {
    return serviceHost.setDevicesEnabled(enabled);
  });

  ipcMain.handle(
    IpcChannels.SetDevicesApproval,
    (_event, approval: BrowserApproval) => {
      return serviceHost.setDevicesApproval(approval);
    }
  );

  ipcMain.handle(IpcChannels.GetDeviceProjectInfo, () => {
    return serviceHost.getDeviceProjectInfo();
  });

  ipcMain.handle(
    IpcChannels.InteractLocalDevice,
    (_event, request: InteractLocalDeviceRequest) => {
      return serviceHost.interactLocalDevice(request);
    }
  );

  ipcMain.handle(
    IpcChannels.BuildAndRunLocalDevice,
    (_event, request: BuildAndRunLocalDeviceRequest) => {
      return serviceHost.buildAndRunLocalDevice(request);
    }
  );

  ipcMain.handle(
    IpcChannels.StartDeviceStream,
    (event, request: StartDeviceStreamRequest) => {
      return serviceHost.startDeviceStream(request, event.sender);
    }
  );

  ipcMain.handle(IpcChannels.StopDeviceStream, (_event, streamId?: number) => {
    return serviceHost.stopDeviceStream(streamId);
  });

  ipcMain.handle(
    IpcChannels.GetSimulatorWindowSource,
    (_event, request: GetSimulatorWindowSourceRequest) => {
      return serviceHost.getSimulatorWindowSource(request);
    }
  );

  ipcMain.handle(IpcChannels.InstallMaestro, () => {
    return serviceHost.installMaestro();
  });

  ipcMain.on(
    IpcChannels.StreamDeviceTouch,
    (_event, request: StreamDeviceTouchRequest) => {
      serviceHost.streamDeviceTouch(request);
    }
  );

  ipcMain.on(
    IpcChannels.StreamDeviceKey,
    (_event, request: StreamDeviceKeyRequest) => {
      serviceHost.streamDeviceKey(request);
    }
  );

  ipcMain.handle(IpcChannels.OpenScreenRecordingSettings, () => {
    return serviceHost.openScreenRecordingSettings();
  });

  ipcMain.handle(IpcChannels.OpenAccessibilitySettings, () => {
    return serviceHost.openAccessibilitySettings();
  });
};
