import {
  readCustomInstructions,
  writeCustomInstructions,
} from "@abacus-ai/agent/custom-instructions";
import type {
  IpcEvent,
  AbacusAccountInfo,
  AbacusAuthOutcome,
  AbacusSignOutResult,
  LocalModelInstallOutcome,
  OpenRouterAuthOutcome,
} from "@abacus-ai/contract/contracts";
import {
  ABACUS_CONNECTORS_SERVER_NAME,
  abacusConnectorsMcpEntry,
} from "@abacus-ai/contract/contracts";
import { PROVIDER_ENV_VARS } from "@abacus-ai/contract/settings";

import { sessionDefaultWorkspace } from "./paths";
import {
  activateProfile,
  legacyProfileKeyFor,
  profileKeyFor,
} from "./profile-home";
import { emitBusChannel, emitHostEvent } from "./rpc/emit";
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
import {
  abacusCredentialRejected,
  clearAbacusCache,
  fetchAbacusAccount,
} from "./services/providers/abacus";
import { abacusRoutellmV1 } from "./services/providers/abacus-host";
import {
  fetchReferralSummary,
  listReferralGmailContacts,
  sendReferralEmailInvites,
  sendReferralWhatsappInvites,
} from "./services/providers/abacus-referral-service";
import {
  adoptWebAccount,
  signOut as clearLocalAccount,
  skipOnboarding,
} from "./services/providers/account-service";
import { listAvailableModels } from "./services/providers/models";
import { clearOpenRouterCache } from "./services/providers/openrouter";
import { getUsageSnapshot } from "./services/providers/usage";
import { accountStashKey } from "./services/session/account-session-stash";

export interface HostPlatformOperations {
  startAbacusAuth: (
    intent: "signin" | "signup",
    profile?: string
  ) => Promise<any>;
  startOpenRouterAuth: () => Promise<any>;
  cancelAbacusAuth: () => void;
  openAbacusAuthInBrowser: () => void;
  listBrowserSignInProfiles: () => any;
  shouldAutoSignIn: () => Promise<boolean>;
  cancelOpenRouterAuth: () => void;
  cancelConnectorConnect: () => void;
  cancelAllConnectorConnects: () => void;
  clearSignInSession: () => Promise<void>;
  rememberSessionAccount: (email: string) => void;
  registerLoginItem: () => void;
  relaunch: () => void;
  requestMicrophoneAccess: () => Promise<any>;
  localModels: {
    state: () => any;
    install: (modelId: string) => Promise<LocalModelInstallOutcome>;
    cancelInstall: () => void;
    remove: (modelId: string) => void;
  };
}

/**
 * What the legacy IPC handlers do beyond forwarding to ServiceHost, as named
 * operations. The `ipcMain` handlers below and the oRPC procedures (main/rpc)
 * both call these, so neither path carries its own copy of the logic. The
 * module-level services the handlers call are listed too, so main/rpc reaches
 * them through here rather than importing them (and Electron) itself.
 */
export const createHostOperations = (
  serviceHost: ServiceHost,
  dispatchEvent: (event: IpcEvent) => void,
  platform: HostPlatformOperations
) => {
  const {
    startAbacusAuth,
    startOpenRouterAuth,
    cancelAbacusAuth,
    openAbacusAuthInBrowser,
    listBrowserSignInProfiles,
    shouldAutoSignIn,
    cancelOpenRouterAuth,
    cancelConnectorConnect,
    cancelAllConnectorConnects,
    clearSignInSession,
    rememberSessionAccount,
    registerLoginItem,
    requestMicrophoneAccess,
  } = platform;
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
    // The sync needs this key, and the lines worth reading are the sign-in
    // attempts that came before it; do not wait for the timer.
    if (provider === "abacus" && key != null && key.trim().length > 0)
      serviceHost.syncLogsNow();
    // Running sessions took their credentials from the environment as it was
    // when they spawned; without this the key only works in the next chat.
    serviceHost.refreshAgentProviders();
    dispatchEvent({
      type: "credentials-changed",
      provider,
      ...(key == null ? {} : { configured: key.trim().length > 0 }),
      emittedAt: new Date().toISOString(),
    });
    // A credential connector's status is exactly whether its key is stored.
    dispatchEvent({
      type: "connector-status-changed",
      emittedAt: new Date().toISOString(),
    });
  };

  let adoptionRevision = 0;
  let identificationTimer: ReturnType<typeof setTimeout> | undefined;
  const cancelIdentification = () => {
    adoptionRevision += 1;
    clearTimeout(identificationTimer);
    identificationTimer = undefined;
  };
  const storedAbacusKey = () =>
    readSettings().apiKeys?.[PROVIDER_ENV_VARS.abacus]?.trim() ?? "";

  // A web host has one owner and does not choose Electron profile directories.
  // Retry its optional account details without holding the sign-in RPC open.
  const scheduleIdentification = (
    key: string,
    revision: number,
    delay = 1200
  ) => {
    const current = () =>
      revision === adoptionRevision && storedAbacusKey() === key;
    identificationTimer = setTimeout(async () => {
      if (!current()) return;
      const account = await fetchAbacusAccount(true);
      if (!current()) return;
      if (abacusCredentialRejected()) {
        await clearAbacusCredential(account);
      } else if (account != null) {
        adoptWebAccount(account);
        credentialsChanged("abacus", key);
        serviceHost.restoreSessionsForAccount(
          accountStashKey(account.email, key)
        );
      } else {
        scheduleIdentification(key, revision, Math.min(delay * 2, 60_000));
      }
    }, delay);
    identificationTimer.unref?.();
  };

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
    rawKey: string,
    /** Where the key was minted; the app's own window keeps that account's session. */
    surface?: "in_app" | "browser" | "web"
  ): Promise<
    | { ok: true; accountDetailsPending?: boolean }
    | { ok: false; error: "unidentified-account" }
  > => {
    cancelIdentification();
    const revision = adoptionRevision;
    const key = rawKey.trim();
    const previousKey =
      readSettings().apiKeys?.[PROVIDER_ENV_VARS.abacus]?.trim() ?? "";
    saveApiKey("abacus", key);
    // Clear the old account cache so validation cannot inherit the previous
    // user. Electron still requires an identity to select an isolated profile.
    clearAbacusCache();

    const account =
      surface === "web"
        ? await fetchAbacusAccount(true)
        : await identifyAbacusAccount();
    if (revision !== adoptionRevision)
      return { ok: false, error: "unidentified-account" };
    if (surface === "web" && !abacusCredentialRejected()) {
      if (account == null) {
        clearLocalAccount();
        skipOnboarding();
        credentialsChanged("abacus", key);
        scheduleIdentification(key, revision);
        return { ok: true, accountDetailsPending: true };
      }
      // Web identity is optional; no desktop profile directory is selected.
      adoptWebAccount(account);
      credentialsChanged("abacus", key);
      serviceHost.restoreSessionsForAccount(
        accountStashKey(account.email, key)
      );
      registerLoginItem();
      return { ok: true, accountDetailsPending: false };
    }
    const profileKey = account != null ? profileKeyFor(account) : null;
    if (account == null || profileKey == null) {
      // A failed switch must not sign the previous account out.
      saveApiKey("abacus", previousKey);
      credentialsChanged("abacus", previousKey);
      return { ok: false, error: "unidentified-account" };
    }

    // The sign-in partition is this account's only when it signed in there;
    // a browser sign-in or a pasted key leaves whatever it held nobody's.
    if (surface === "in_app" && account.email != null)
      rememberSessionAccount(account.email);
    else await clearSignInSession();

    const legacyKey = legacyProfileKeyFor(account);
    const aliases =
      legacyKey != null && legacyKey !== profileKey ? [legacyKey] : [];
    if (surface !== "web" && activateProfile(profileKey, key, aliases)) {
      // This process still owns the departing profile; leave the new key only
      // in its target profile and relaunch there. `quit`, not `exit`: the
      // before-quit handler disposes the terminal PTYs, and a live pty reader
      // thread aborts the process if Node's env is torn down under it.
      saveApiKey("abacus", "");
      clearLocalAccount();
      credentialsChanged("abacus", "");
      setTimeout(() => {
        platform.relaunch();
      }, 300);
      return { ok: true };
    }

    if (surface === "web") adoptWebAccount(account);
    credentialsChanged("abacus", key);
    const restored = serviceHost.restoreSessionsForAccount(
      accountStashKey(account.email, key)
    );
    console.log(
      `[account] signed in as ${account.email ?? "?"}: restored ${restored} session(s)`
    );
    registerLoginItem();
    return { ok: true };
  };

  /** End the current account session without deleting its conversations. */
  const clearAbacusCredential = async (
    knownAccount?: AbacusAccountInfo | null
  ): Promise<{
    stashedSessions: number;
    settings: ReturnType<typeof readSettings>;
  }> => {
    cancelIdentification();
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

    // A hop or sign-in still out would attach to, or mint a key for, an
    // account that is leaving; the partition is nobody's from here.
    cancelAllConnectorConnects();
    if (serviceHost.platform !== "web-host") cancelAbacusAuth();
    await clearSignInSession();

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

  /**
   * A key the platform has revoked is cleared here, since every signed-in
   * check reads the stored key. Only an outright refusal counts; a timeout or
   * a 500 keeps the session.
   */
  const getAbacusAccount = async (
    refresh?: boolean
  ): Promise<AbacusAccountInfo | null> => {
    const account = await fetchAbacusAccount(refresh === true);
    if (account != null || !abacusCredentialRejected()) return account;

    const stored = readSettings().apiKeys?.[PROVIDER_ENV_VARS.abacus] ?? "";
    if (stored.trim().length === 0) return null;

    await clearAbacusCredential(account);

    return null;
  };

  const storeApiKey = async (
    provider: string,
    key: string
  ): Promise<ReturnType<typeof readSettings>> => {
    if (provider === "abacus") {
      if (key.trim().length === 0)
        return (await clearAbacusCredential()).settings;

      const result = await adoptAbacusCredential(
        key,
        serviceHost.platform === "web-host" ? "web" : undefined
      );
      if (result.ok === false) throw new Error(result.error);
      return readSettings();
    }
    const settings = saveApiKey(provider, key);
    credentialsChanged(provider, key);
    return settings;
  };

  const signInToOpenRouter = async (): Promise<OpenRouterAuthOutcome> => {
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
  };

  const signInToAbacus = async (
    intent: unknown,
    browserProfileId: unknown
  ): Promise<AbacusAuthOutcome> => {
    const result = await startAbacusAuth(
      intent === "signin" ? "signin" : "signup",
      // Only an id from the listing resolves to a profile; anything else is
      // a plain sign-in.
      typeof browserProfileId === "string" ? browserProfileId : undefined
    );
    if (result.ok !== true) {
      return {
        ok: false,
        error: result.error,
        ...(result.cancelled === true ? { cancelled: true } : {}),
      };
    }

    const adopted = await adoptAbacusCredential(result.key, result.surface);
    if (!adopted.ok) return adopted;

    // Warm the catalog for same-profile sign-ins. A profile switch relaunches,
    // and the new renderer reads it normally from the target profile.
    await listAvailableModels(true);
    return adopted;
  };

  const signOutAbacus = async (options: {
    keepOtherApiKeys: boolean;
  }): Promise<AbacusSignOutResult> => {
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
  };

  const runRoutine = async (
    id: string,
    trigger?: "manual" | "create"
  ): Promise<void> => {
    await serviceHost.runRoutine(
      id,
      trigger === "create" ? "create" : "manual"
    );
  };

  const setCustomInstructions = (text: unknown): string => {
    writeCustomInstructions(typeof text === "string" ? text : "");

    return readCustomInstructions();
  };

  return {
    webAuth: undefined as
      | undefined
      | {
          start: () => Promise<{ challenge: string }>;
          complete: (input: {
            code: string;
          }) => Promise<
            import("@abacus-ai/contract/account").WebAuthCompleteResult
          >;
        },
    credentialsChanged,
    syncAbacusGateway,
    getAbacusAccount,
    saveApiKey: storeApiKey,
    startOpenRouterAuth: signInToOpenRouter,
    startAbacusAuth: signInToAbacus,
    shouldAutoSignIn,
    signOutAbacus,
    runRoutine,
    /** Straight through to the agent package's store, shared with the terminal client. */
    getCustomInstructions: (): string => readCustomInstructions(),
    setCustomInstructions,
    // Late-bound, so nothing here is read until a caller asks for it.
    listModels: (refresh?: boolean) => listAvailableModels(refresh === true),
    getUsageSnapshot: () => getUsageSnapshot(),
    readSettings: () => readSettings(),
    readPromptHistory: (scope: string) => readPromptHistory(scope),
    addPromptToHistory: (scope: string, prompt: string) =>
      addPromptToHistory(scope, prompt),
    storedKeyProviders: () => storedKeyProviders(),
    setDefaultModel: (modelId: string) => setDefaultModel(modelId),
    sessionHomePath: () => sessionDefaultWorkspace(),
    cancelAbacusAuth: () => cancelAbacusAuth(),
    openAbacusAuthInBrowser: () => openAbacusAuthInBrowser(),
    listBrowserSignInProfiles: () => listBrowserSignInProfiles(),
    cancelOpenRouterAuth: () => cancelOpenRouterAuth(),
    cancelConnectorConnect: () => cancelConnectorConnect(),
    fetchReferralSummary: () => fetchReferralSummary(),
    listReferralGmailContacts: () => listReferralGmailContacts(),
    sendReferralEmailInvites: (emails: unknown, message: unknown) =>
      sendReferralEmailInvites(emails, message),
    listReferralWhatsappContacts: () =>
      serviceHost.listInviteContacts("whatsapp"),
    sendReferralWhatsappInvites: (chatIds: unknown, message: unknown) =>
      sendReferralWhatsappInvites(chatIds, message, (chatId, text) =>
        serviceHost.sendMessagingText("whatsapp", chatId, text)
      ),
    requestMicrophoneAccess: () => requestMicrophoneAccess(),
    adoptAbacusCredential,
    localModels: platform.localModels,
  };
};

export type HostOperations = ReturnType<typeof createHostOperations>;

export const wireHostEvents = (
  serviceHost: ServiceHost,
  platform: HostPlatformOperations,
  supplied?: HostOperations
): HostOperations => {
  // One function feeds both the legacy renderer and the oRPC event bus.
  serviceHost.setEventDispatcher(emitHostEvent);
  // Bus-only pushes (no legacy event), such as a retired terminal generation.
  serviceHost.setBusDispatcher(emitBusChannel);

  const ops =
    supplied ?? createHostOperations(serviceHost, emitHostEvent, platform);

  // The connector flow stores agent credentials through the same path a
  // pasted key takes, so the announcement above happens for those too.
  serviceHost.setCredentialSaver((provider, value) => {
    saveApiKey(provider, value);
    ops.credentialsChanged(provider, value);
  });

  // A profile relaunch bypasses the credential-save IPC; reconcile from disk.
  ops.syncAbacusGateway(
    readSettings().apiKeys?.[PROVIDER_ENV_VARS.abacus] ?? undefined
  );

  return ops;
};
