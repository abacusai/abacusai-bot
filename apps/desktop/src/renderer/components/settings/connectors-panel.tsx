import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ExternalLink,
  Key,
  LoaderCircle,
  LogIn,
  Plug,
  Search,
  Settings2,
  Trash2,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import type { McpServerEntry, McpServerInfo } from "#shared/contracts";
import {
  SHARED_BOT_PLATFORM_OF,
  type MessagingPlatformId,
} from "#shared/messaging";

import {
  type AgentKeyConnector,
  HOME_PLACEHOLDER,
  CONNECTORS,
  type AbacusConnector,
  type McpServerConnector,
  type MessagingConnector,
  type ConnectorDefinition,
} from "../../connectors";
import {
  abacusConnectorsQueryOptions,
  type AbacusConnectorState,
} from "../../hooks/use-connected-connectors";
import { useMcpRuntime } from "../../hooks/use-mcp-runtime";
import { useWorkspaceMetadataQuery } from "../../hooks/use-workspace-queries";
import { signInToAbacus } from "../../lib/abacus-sign-in";
import { settingsQueryKeys } from "../../lib/settings-query-keys";
import { useWorkspaceStore } from "../../stores/code-store";
import {
  FocusedPage,
  FocusedPageBody,
  FocusedPageToolbar,
} from "../layout/focused-page";
import {
  Button,
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
  Spinner,
} from "../ui";
import { Badge } from "../ui/badge";
import { useAgentKeySaver } from "./agent-key";
import { ConnectorLogo } from "./connector-logo";
import { CredentialPrompt } from "./credential-prompt";
import {
  MessagingConnectorDialog,
  MessagingSettingsDialog,
  MessagingStateBadge,
  sharedLinkPending,
  isMessagingPlatformInstalled,
  useMessaging,
} from "./messaging-connectors";

/**
 * Connectors — the catalog, and what is installed from it.
 *
 * Adding one writes the same MCP config the MCP panel writes, under the
 * connector's id; "installed" means the id is in the server list. Credentials
 * are asked for before anything is written.
 */

// Connectors install into the coding agent's MCP config, the same mode the MCP tab
// manages.
const MODE = "code" as const;
/** How long the card waits on the browser hop before giving the user back the button. */
const CONNECT_WATCHDOG_MS = 3 * 60 * 1000;

const EMPTY_PROVIDER_IDS = new Set<string>();

export const ConnectorsPanel = (): JSX.Element => {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [query, setQuery] = useState("");

  const installedQuery = useQuery({
    queryKey: settingsQueryKeys.connectors.installed,
    staleTime: 60_000,
    queryFn: async () => {
      const servers = (await window.api?.agent?.listMcpServers?.({
        mode: MODE,
      })) as McpServerInfo[] | undefined;
      return new Set((servers ?? []).map((server) => server.id));
    },
  });
  const connectorsQuery = useQuery(abacusConnectorsQueryOptions);
  // Agent-key cards are "installed" when the credential is stored; no MCP entry.
  const storedKeysQuery = useQuery({
    queryKey: settingsQueryKeys.connectors.storedKeys,
    staleTime: 60_000,
    queryFn: async () =>
      new Set((await window.api?.agent?.listStoredKeyProviders?.()) ?? []),
  });
  const storedKeys = storedKeysQuery.data ?? EMPTY_PROVIDER_IDS;
  const installed = installedQuery.data ?? EMPTY_PROVIDER_IDS;
  const abacusConnected = connectorsQuery.data?.connected ?? EMPTY_PROVIDER_IDS;
  const abacusAvailable = connectorsQuery.data?.available ?? null;
  const [busy, setBusy] = useState<string | null>(null);
  // The connector browser hop is single-flight in the main process; this is
  // which service holds the slot. Other cards stay clickable: a click elsewhere
  // cancels the hop in flight, a click on the running card is a fresh attempt.
  const [connectingService, setConnectingService] = useState<string | null>(
    null
  );
  // The same, readable from inside a click handler without a stale closure.
  const connectingServiceRef = useRef<string | null>(null);
  // The card of a connect that came back failed, so it can say so in place
  // rather than only in a toast that is gone by the time the user looks.
  const [connectError, setConnectError] = useState<{
    id: string;
    message: string;
  } | null>(null);
  // Which MCP server a sign-in is in flight for.
  const [signingIn, setSigningIn] = useState<string | null>(null);
  const [credentialFor, setCredentialFor] = useState<
    AgentKeyConnector | McpServerConnector | null
  >(null);

  // The messaging platforms: their live state, and which dialogs are open.
  const messaging = useMessaging();
  const [messagingDialog, setMessagingDialog] =
    useState<MessagingPlatformId | null>(null);
  const [messagingSettingsOpen, setMessagingSettingsOpen] = useState(false);
  const workspacesQuery = useWorkspaceMetadataQuery();

  // Clear the spinner only if it is still ours: a cancelled connect resolves
  // after the next one has already claimed `busy`.
  const clearBusy = useCallback((id: string) => {
    setBusy((current) => (current === id ? null : current));
  }, []);

  // Leaving the panel abandons any connect still in flight. Without this the
  // loopback listener holds its port and sits out the full five-minute window
  // for a flow the user has walked away from.
  useEffect(() => {
    return () => {
      void window.api?.agent?.cancelAbacusConnector?.();
    };
  }, []);

  // Reconnect the running agent to the servers as they are now. Its MCP
  // clients connect once at session start with the credentials of that moment,
  // so an edit to the file alone changes nothing the agent can see.
  const activeWorkspaceId = useWorkspaceStore(
    (state) => state.activeWorkspaceId
  );
  const getActiveSessionId = useWorkspaceStore(
    (state) => state.getActiveSessionId
  );

  // What the running agent says about each MCP server, so a card whose server
  // is waiting on a sign-in does not read as connected.
  const runtimeSessionId =
    activeWorkspaceId != null ? getActiveSessionId(activeWorkspaceId) : null;
  const { servers: runtimeServers, refresh: refreshRuntime } = useMcpRuntime({
    workspaceId: activeWorkspaceId,
    sessionId: runtimeSessionId,
    enabled: runtimeSessionId != null,
  });

  const reconnectRunningAgent = useCallback(async () => {
    if (activeWorkspaceId == null) return;
    const sessionId = getActiveSessionId(activeWorkspaceId);
    if (sessionId == null) return;
    // No session running is the ordinary case, not a failure: the next one
    // starts from the file, which is already correct.
    await window.api?.agent?.refreshMcpServers?.({
      workspaceId: activeWorkspaceId,
      sessionId,
    });
  }, [activeWorkspaceId, getActiveSessionId]);

  const refreshInstalled = useCallback(async () => {
    await queryClient.invalidateQueries({
      queryKey: settingsQueryKeys.connectors.installed,
    });
  }, [queryClient]);

  const refreshConnectors = useCallback(async () => {
    await queryClient.invalidateQueries({
      queryKey: settingsQueryKeys.connectors.connectors,
    });
  }, [queryClient]);

  const storeAgentKey = useAgentKeySaver();
  const saveAgentKey = useCallback(
    async (connector: AgentKeyConnector, value: string) => {
      setBusy(connector.id);
      try {
        await storeAgentKey(connector, value);
      } finally {
        setBusy(null);
      }
    },
    [storeAgentKey]
  );

  // Takes the server variant, not any connector: `connector.entry` is what gets
  // installed, and only that variant is guaranteed to have one.
  const add = useCallback(
    async (
      connector: McpServerConnector,
      credentials: Record<string, string>
    ) => {
      setBusy(connector.id);
      const previousInstalled = queryClient.getQueryData<Set<string>>(
        settingsQueryKeys.connectors.installed
      );
      let added = false;
      try {
        const entry: McpServerEntry = { ...connector.entry };

        if (entry.args?.includes(HOME_PLACEHOLDER) === true) {
          const home = await window.api?.getHomeDir?.();
          entry.args = entry.args.map((arg) =>
            arg === HOME_PLACEHOLDER ? (home ?? ".") : arg
          );
        }

        if (connector.token != null && credentials.token != null) {
          entry.headers = {
            ...entry.headers,
            [connector.token.header]:
              `${connector.token.scheme} ${credentials.token}`.trim(),
          };
        }

        if (connector.env != null && connector.env.length > 0) {
          entry.env = { ...entry.env };
          for (const name of connector.env)
            entry.env[name] = credentials[name] ?? "";
        }

        // The client the sign-in authorizes with, for providers that will not
        // register one for us; the main process reads it back from the entry.
        if (connector.auth === "oauth-client") {
          const clientId = (credentials.clientId ?? "").trim();
          const clientSecret = (credentials.clientSecret ?? "").trim();

          entry.oauth = {
            ...(clientId.length > 0 ? { clientId } : {}),
            ...(clientSecret.length > 0 ? { clientSecret } : {}),
          };
        }

        queryClient.setQueryData<Set<string>>(
          settingsQueryKeys.connectors.installed,
          (current = new Set()) => new Set(current).add(connector.id)
        );
        const result = await window.api?.agent?.addMcpServer?.({
          mode: MODE,
          name: connector.id,
          config: entry,
        });

        if (result?.success !== true) {
          toast.error(
            result?.error ?? t("connectors.addFailed", { name: connector.name })
          );
          return;
        }

        added = true;
        await refreshInstalled();
        await reconnectRunningAgent();

        // Added either way: the server itself is fine, its first browser call
        // is what fails, and a warning now beats a stack trace in a chat later.
        if (connector.requires === "google-chrome") {
          const present = await window.api?.hasGoogleChrome?.();
          if (present === false)
            toast.warning(
              t("connectors.chromeMissing", { name: connector.name }),
              { duration: 15_000 }
            );
        }

        // An OAuth connector without its sign-in 401s on first use, so roll
        // straight into the browser flow.
        if (connector.auth === "oauth" || connector.auth === "oauth-client") {
          toast.info(t("connectors.signingIn", { name: connector.name }));
          const signIn = await window.api.agent.mcpOAuthSignIn({
            mode: MODE,
            name: connector.id,
          });

          if (signIn.success) {
            // The token lands only once the browser flow finishes, so the
            // reconnect above ran without it.
            await reconnectRunningAgent();
            toast.success(t("connectors.signedIn", { name: connector.name }));
          } else if (signIn.cancelled !== true) {
            toast.error(
              t("connectors.signInFailed", {
                name: connector.name,
                error: signIn.error ?? "",
              })
            );
          }
        } else {
          toast.success(t("connectors.added", { name: connector.name }));
        }
      } finally {
        if (!added) {
          queryClient.setQueryData(
            settingsQueryKeys.connectors.installed,
            previousInstalled ?? new Set()
          );
        }
        clearBusy(connector.id);
      }
    },
    [clearBusy, queryClient, refreshInstalled, reconnectRunningAgent, t]
  );

  // Attach an Abacus connector: sign in first if the app holds no key (free
  // signup happens inside that same browser hop), then the connect hop, then
  // re-read state — the platform, not the loopback ping, is the source of truth.
  const connectAbacus = useCallback(
    async (connector: AbacusConnector) => {
      const service = connector.abacusService;
      // A second click on an adding card is a retry; a click on another card
      // cancels this one and says so.
      const holder = connectingServiceRef.current;
      if (holder != null) {
        await window.api?.agent?.cancelAbacusConnector?.();
        if (holder !== service) {
          const other = CONNECTORS.find(
            (entry) => entry.auth === "abacus" && entry.abacusService === holder
          );
          toast.info(
            t("connectors.abacusConnectCancelled", {
              name: other?.name ?? holder,
            })
          );
        }
      }
      setBusy(connector.id);
      setConnectingService(service);
      connectingServiceRef.current = service;
      setConnectError((current) =>
        current?.id === connector.id ? null : current
      );
      let connected = false;
      try {
        let snapshot = await window.api?.agent?.listAbacusConnectors?.();
        if (snapshot?.ok !== true && snapshot?.error === "not-signed-in") {
          toast.info(t("connectors.abacusSigningIn"));
          const auth = await signInToAbacus();
          if (auth.ok !== true) {
            if (auth.cancelled !== true)
              toast.error(t("connectors.abacusSignInFailed"));
            return;
          }
          snapshot = await window.api?.agent?.listAbacusConnectors?.();
        }
        toast.info(t("connectors.abacusConnecting", { name: connector.name }));
        // The main process waits twenty minutes for the browser; the card
        // gives up sooner so a hung flow does not leave it "adding" for good.
        const result = await Promise.race([
          window.api.agent.connectAbacusConnector(service),
          new Promise<{ ok: false; error: string; timedOut: true }>((resolve) =>
            setTimeout(
              () => resolve({ ok: false, error: "timed out", timedOut: true }),
              CONNECT_WATCHDOG_MS
            )
          ),
        ]);
        if (result.ok !== true) {
          const timedOut = "timedOut" in result;
          if (timedOut) void window.api?.agent?.cancelAbacusConnector?.();
          // Cancelled by the next click is not this card's failure to report.
          const cancelled = !timedOut && result.cancelled === true;
          if (!cancelled) {
            setConnectError({
              id: connector.id,
              message: t("connectors.abacusConnectFailed", {
                name: connector.name,
              }),
            });
          }
          return;
        }
        connected = true;
        await refreshConnectors();
        await refreshInstalled();
        await reconnectRunningAgent();
        toast.success(
          t("connectors.abacusConnected", { name: connector.name })
        );
      } finally {
        // The platform is the source of truth either way.
        if (!connected) void refreshConnectors();
        // Release the slot only if it is still ours; another connect may have
        // taken over.
        if (connectingServiceRef.current === service)
          connectingServiceRef.current = null;
        setConnectingService((current) =>
          current === service ? null : current
        );
        clearBusy(connector.id);
      }
    },
    [clearBusy, refreshConnectors, refreshInstalled, reconnectRunningAgent, t]
  );

  const disconnectAbacus = useCallback(
    async (connector: AbacusConnector) => {
      const service = connector.abacusService;
      setBusy(connector.id);
      const previousConnectors = queryClient.getQueryData<AbacusConnectorState>(
        settingsQueryKeys.connectors.connectors
      );
      let disconnected = false;
      queryClient.setQueryData<AbacusConnectorState>(
        settingsQueryKeys.connectors.connectors,
        (current = { connected: new Set(), available: null }) => {
          const connected = new Set(current.connected);
          connected.delete(service);
          return { ...current, connected };
        }
      );
      try {
        const result =
          await window.api.agent.disconnectAbacusConnector(service);
        if (result.ok !== true) {
          toast.error(
            t("connectors.abacusDisconnectFailed", { name: connector.name })
          );
          return;
        }
        disconnected = true;
        await refreshConnectors();
        await reconnectRunningAgent();
        toast.success(
          t("connectors.abacusDisconnected", { name: connector.name })
        );
      } finally {
        if (!disconnected) {
          queryClient.setQueryData(
            settingsQueryKeys.connectors.connectors,
            previousConnectors ?? { connected: new Set(), available: null }
          );
        }
        clearBusy(connector.id);
      }
    },
    [clearBusy, queryClient, refreshConnectors, reconnectRunningAgent, t]
  );

  const remove = useCallback(
    async (connector: McpServerConnector) => {
      setBusy(connector.id);
      const previousInstalled = queryClient.getQueryData<Set<string>>(
        settingsQueryKeys.connectors.installed
      );
      let removed = false;
      queryClient.setQueryData<Set<string>>(
        settingsQueryKeys.connectors.installed,
        (current = new Set()) => {
          const next = new Set(current);
          next.delete(connector.id);
          return next;
        }
      );
      try {
        const result = await window.api?.agent?.removeMcpServer?.({
          mode: MODE,
          name: connector.id,
        });
        if (result?.success !== true) {
          toast.error(
            result?.error ??
              t("connectors.removeFailed", { name: connector.name })
          );
          return;
        }
        removed = true;
        toast.success(t("connectors.removed", { name: connector.name }));
        await refreshInstalled();
        await reconnectRunningAgent();
      } finally {
        if (!removed) {
          queryClient.setQueryData(
            settingsQueryKeys.connectors.installed,
            previousInstalled ?? new Set()
          );
        }
        clearBusy(connector.id);
      }
    },
    [clearBusy, queryClient, refreshInstalled, reconnectRunningAgent, t]
  );

  // WhatsApp enables straight away (that starts the bridge and produces the
  // QR); token platforms wait for credentials. Either way the dialog opens.
  const connectMessaging = (connector: MessagingConnector): void => {
    const platform = messaging.snapshot?.platforms.find(
      (entry) => entry.id === connector.messagingPlatform
    );
    if (
      platform != null &&
      (platform.id === "whatsapp" ||
        platform.id === "telegram" ||
        platform.id === "discord" ||
        platform.id === "abacus_discord" ||
        platform.id === "abacus_telegram" ||
        platform.configured)
    )
      void messaging.connectPlatform(connector.messagingPlatform);
    setMessagingDialog(connector.messagingPlatform);
  };

  // Disabling a card also takes down a shared-bot lane that lives inside it.
  const removeMessaging = async (
    platform: MessagingPlatformId
  ): Promise<void> => {
    await messaging.updatePlatform({ platformId: platform, enabled: false });
    const shared = SHARED_BOT_PLATFORM_OF[platform];
    if (shared != null)
      await messaging.updatePlatform({ platformId: shared, enabled: false });
  };

  // Sign in to an installed MCP server the running agent says is waiting on one.
  const signInMcp = useCallback(
    async (connector: McpServerConnector) => {
      setSigningIn(connector.id);
      try {
        const result = await window.api.agent.mcpOAuthSignIn({
          mode: MODE,
          name: connector.id,
        });
        if (result.success) {
          toast.success(t("connectors.signedIn", { name: connector.name }));
          await refreshRuntime();
          await reconnectRunningAgent();
        } else if (result.cancelled !== true) {
          setConnectError({
            id: connector.id,
            message: t("connectors.mcpSignInFailed", {
              error: result.error ?? "",
            }),
          });
        }
      } finally {
        setSigningIn((current) => (current === connector.id ? null : current));
      }
    },
    [refreshRuntime, reconnectRunningAgent, t]
  );

  const onAddClick = (connector: ConnectorDefinition): void => {
    if (connector.auth === "messaging") {
      connectMessaging(connector);
      return;
    }
    if (connector.auth === "abacus") {
      void connectAbacus(connector);
      return;
    }
    // A connector saved without its credential fails silently on first use.
    if (
      connector.auth === "token" ||
      connector.auth === "key" ||
      connector.auth === "agent-key" ||
      connector.auth === "oauth-client"
    ) {
      setCredentialFor(connector);
      return;
    }
    void add(connector, {});
  };

  const isConnectorInstalled = useCallback(
    (connector: ConnectorDefinition): boolean =>
      connector.auth === "messaging"
        ? isMessagingPlatformInstalled(
            messaging.snapshot,
            connector.messagingPlatform
          )
        : connector.auth === "abacus"
          ? abacusConnected.has(connector.abacusService)
          : connector.auth === "agent-key"
            ? storedKeys.has(connector.credentialProvider)
            : installed.has(connector.id),
    [abacusConnected, installed, messaging.snapshot, storedKeys]
  );

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    // An Abacus card whose service the org disables (or that isn't GA for it)
    // would connect to nothing; hide it once we know. No snapshot = show all.
    const offered = CONNECTORS.filter(
      (p) =>
        p.auth !== "abacus" ||
        abacusAvailable == null ||
        abacusAvailable.has(p.abacusService)
    );
    if (needle.length === 0) return offered;
    return offered.filter(
      (p) =>
        p.name.toLowerCase().includes(needle) ||
        p.description.toLowerCase().includes(needle) ||
        p.id.includes(needle)
    );
  }, [query, abacusAvailable]);

  // Messaging is always its own section: hopping between installed and not on
  // every reconnect would read as the page reshuffling itself.
  const messagingItems = useMemo(
    () =>
      visible.filter(
        (connector): connector is MessagingConnector =>
          connector.auth === "messaging"
      ),
    [visible]
  );
  const sections = useMemo(() => {
    const rest = visible.filter((connector) => connector.auth !== "messaging");
    return [
      {
        id: "installed" as const,
        items: rest.filter(isConnectorInstalled),
      },
      {
        id: "notInstalled" as const,
        items: rest.filter((connector) => !isConnectorInstalled(connector)),
      },
    ];
  }, [visible, isConnectorInstalled]);

  return (
    <FocusedPage data-id="connectors-panel">
      <FocusedPageToolbar>
        <InputGroup className="w-full @xl:max-w-md">
          <InputGroupAddon>
            <Search />
          </InputGroupAddon>
          <InputGroupInput
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("connectors.search")}
            data-id="connectors-search"
          />
        </InputGroup>
      </FocusedPageToolbar>

      <FocusedPageBody>
        {visible.length === 0 ? (
          <Empty className="h-full" data-id="connectors-empty">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Plug />
              </EmptyMedia>
              <EmptyDescription>{t("connectors.noMatches")}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <>
            {messagingItems.length > 0 && (
              <section className="mb-6" data-id="connectors-section-messaging">
                <div className="mb-2 flex items-center gap-2">
                  <p className="text-muted-foreground text-xs font-medium">
                    {t("sidebarNav.messaging")}
                  </p>
                  <Badge variant="secondary">{messagingItems.length}</Badge>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="text-muted-foreground ml-auto"
                    onClick={() => setMessagingSettingsOpen(true)}
                    aria-label={t("messaging.settings.gatewayEnabled")}
                    data-id="connectors-messaging-settings"
                  >
                    <Settings2 />
                  </Button>
                </div>
                <div className="grid grid-cols-1 gap-2 @3xl:grid-cols-2">
                  {messagingItems.map((connector) => {
                    const platform = messaging.snapshot?.platforms.find(
                      (entry) => entry.id === connector.messagingPlatform
                    );
                    const platformInstalled = isConnectorInstalled(connector);
                    // A broken link offers Connect straight away, with the
                    // error badge saying why.
                    const needsRelink =
                      platformInstalled &&
                      (platform?.state === "error" ||
                        platform?.state === "needs_login" ||
                        platform?.state === "rate_limited");
                    // Signed in, bot not linked: same treatment, Connect
                    // reopens the dialog at the outstanding step.
                    const linkPending = sharedLinkPending(
                      messaging.snapshot,
                      connector.messagingPlatform
                    );
                    return (
                      <ConnectorCard
                        key={connector.id}
                        connector={connector}
                        isInstalled={
                          platformInstalled && !needsRelink && !linkPending
                        }
                        isBusy={false}
                        statusBadge={
                          platform != null && platformInstalled ? (
                            <>
                              <MessagingStateBadge
                                state={
                                  linkPending ? "needs_link" : platform.state
                                }
                              />
                              {platform.pendingCount > 0 && (
                                <Badge
                                  variant="secondary"
                                  title={t("messaging.pendingRequests", {
                                    count: platform.pendingCount,
                                  })}
                                >
                                  {platform.pendingCount}
                                </Badge>
                              )}
                            </>
                          ) : null
                        }
                        onManage={
                          platformInstalled
                            ? () =>
                                setMessagingDialog(connector.messagingPlatform)
                            : undefined
                        }
                        onAdd={() => onAddClick(connector)}
                        onRemove={() =>
                          void removeMessaging(connector.messagingPlatform)
                        }
                      />
                    );
                  })}
                </div>
              </section>
            )}
            {sections.map(({ id, items }) => (
              <section
                key={id}
                className="mb-6"
                data-id={`connectors-section-${id}`}
              >
                <div className="mb-2 flex items-center gap-2">
                  <p className="text-muted-foreground text-xs font-medium">
                    {id === "installed"
                      ? t("skills.installed")
                      : t("connectors.notInstalled")}
                  </p>
                  <Badge variant="secondary">{items.length}</Badge>
                </div>
                {items.length === 0 ? (
                  <p className="text-muted-foreground rounded-md border border-dashed px-3 py-6 text-center text-xs">
                    {id === "installed"
                      ? t("connectors.noneInstalled")
                      : t("connectors.noMatches")}
                  </p>
                ) : (
                  <div className="grid grid-cols-1 gap-2 @3xl:grid-cols-2">
                    {items.map((connector) => (
                      <ConnectorCard
                        key={connector.id}
                        connector={connector}
                        isInstalled={isConnectorInstalled(connector)}
                        isBusy={busy === connector.id}
                        isAdding={
                          connector.auth === "abacus" &&
                          connectingService === connector.abacusService
                        }
                        needsSignIn={
                          connector.auth === "oauth" &&
                          runtimeServers.get(connector.id)?.status ===
                            "auth-required"
                        }
                        isSigningIn={signingIn === connector.id}
                        onSignIn={
                          connector.auth === "oauth"
                            ? () => void signInMcp(connector)
                            : undefined
                        }
                        error={
                          connectError?.id === connector.id
                            ? connectError.message
                            : null
                        }
                        onAdd={() => onAddClick(connector)}
                        onRemove={() =>
                          void (connector.auth === "abacus"
                            ? disconnectAbacus(connector)
                            : connector.auth === "agent-key"
                              ? saveAgentKey(connector, "")
                              : remove(connector))
                        }
                      />
                    ))}
                  </div>
                )}
              </section>
            ))}
          </>
        )}
      </FocusedPageBody>

      {credentialFor != null && (
        <CredentialPrompt
          connector={credentialFor}
          onCancel={() => setCredentialFor(null)}
          onSubmit={(values) => {
            const connector = credentialFor;
            setCredentialFor(null);
            if (connector.auth === "agent-key") {
              void saveAgentKey(
                connector,
                values[connector.env?.[0] ?? ""] ?? ""
              );
              return;
            }
            void add(connector, values);
          }}
        />
      )}

      {messagingDialog != null && (
        <MessagingConnectorDialog
          platformId={messagingDialog}
          messaging={messaging}
          onClose={() => setMessagingDialog(null)}
        />
      )}

      {messagingSettingsOpen && (
        <MessagingSettingsDialog
          messaging={messaging}
          workspaces={workspacesQuery.data?.workspaces ?? []}
          onClose={() => setMessagingSettingsOpen(false)}
        />
      )}
    </FocusedPage>
  );
};

const ConnectorCard = ({
  connector,
  isInstalled,
  isBusy,
  isAdding = false,
  needsSignIn = false,
  isSigningIn = false,
  onSignIn,
  error = null,
  statusBadge,
  onManage,
  onAdd,
  onRemove,
}: {
  connector: ConnectorDefinition;
  isInstalled: boolean;
  isBusy: boolean;
  /** Browser hop running: stays a clickable "Adding…" button, not Remove. */
  isAdding?: boolean;
  /** Installed, but the running agent is waiting on a sign-in for it. */
  needsSignIn?: boolean;
  isSigningIn?: boolean;
  onSignIn?: (() => void) | undefined;
  error?: string | null;
  statusBadge?: ReactNode;
  /** Opens the card's manage dialog — pairing, credentials, the QR. */
  onManage?: (() => void) | undefined;
  onAdd: () => void;
  onRemove: () => void;
}): JSX.Element => {
  const { t } = useTranslation();

  return (
    <Item
      variant="outline"
      className="bg-sidebar/40 items-start"
      data-id={`connector-card-${connector.id}`}
    >
      <ItemMedia variant="icon" className="bg-muted size-8 rounded-md">
        <ConnectorLogo connector={connector} />
      </ItemMedia>
      <ItemContent>
        <ItemTitle>
          {connector.name}
          {/* Messaging cards wear their live state instead of an auth badge —
              "Connected" says more than naming the pairing mechanism would. */}
          {connector.auth !== "none" && connector.auth !== "messaging" && (
            <Badge
              variant="secondary"
              title={t(`connectors.auth.${connector.auth}`)}
            >
              <Key />
              {t(`connectors.auth.${connector.auth}`)}
            </Badge>
          )}
          {statusBadge}
        </ItemTitle>
        <ItemDescription>{connector.description}</ItemDescription>
        {error != null && (
          <p
            className="text-destructive mt-1 text-xs"
            data-id={`connector-error-${connector.id}`}
          >
            {error}
          </p>
        )}
      </ItemContent>
      <ItemActions>
        {onManage != null && (
          <Button
            variant="ghost"
            size="icon"
            onClick={onManage}
            title={t("messaging.openSetupGuide")}
            data-id={`connector-manage-${connector.id}`}
          >
            <Settings2 />
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon"
          onClick={() => void window.api?.openExternal?.(connector.docsUrl)}
          title={t("connectors.docs")}
          data-id={`connector-docs-${connector.id}`}
        >
          <ExternalLink />
        </Button>
        {isInstalled && needsSignIn && onSignIn != null && (
          <Button
            size="sm"
            onClick={onSignIn}
            disabled={isSigningIn}
            data-id={`connector-signin-${connector.id}`}
          >
            {isSigningIn ? (
              <LoaderCircle className="animate-spin" />
            ) : (
              <LogIn />
            )}
            {isSigningIn
              ? t("connectors.signingInAction")
              : t("connectors.signInAction")}
          </Button>
        )}
        {isInstalled ? (
          <Button
            variant="secondary"
            size="sm"
            onClick={onRemove}
            disabled={isBusy}
            data-id={`connector-remove-${connector.id}`}
          >
            {isBusy ? <LoaderCircle className="animate-spin" /> : <Trash2 />}
            {t("connectors.remove")}
          </Button>
        ) : (
          <Button
            size="sm"
            onClick={onAdd}
            disabled={isBusy && !isAdding}
            data-id={`connector-add-${connector.id}`}
          >
            {isBusy && <Spinner fontSize={10} />}
            {isAdding
              ? t("connectors.adding")
              : connector.auth === "messaging"
                ? t("connectors.connectAction")
                : t("connectors.add")}
          </Button>
        )}
      </ItemActions>
    </Item>
  );
};
