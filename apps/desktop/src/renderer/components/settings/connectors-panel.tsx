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
  useState,
  type JSX,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import {
  SHARED_BOT_PLATFORM_OF,
  type MessagingPlatformId,
} from "#shared/messaging";

import {
  CONNECTORS,
  connectUi,
  type ConnectorDefinition,
  type MessagingConnector,
} from "../../connectors";
import {
  isConnected,
  statusOf,
  useConnectorStatuses,
} from "../../hooks/use-connector-statuses";
import { useMcpRuntime } from "../../hooks/use-mcp-runtime";
import { useWorkspaceMetadataQuery } from "../../hooks/use-workspace-queries";
import { useWorkspaceStore } from "../../stores/code-store";
import { useConnectFlow } from "../connectors/connect-flow";
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
import { ConnectorLogo } from "./connector-logo";
import {
  MessagingConnectorDialog,
  MessagingSettingsDialog,
  MessagingStateBadge,
  sharedLinkPending,
  useMessaging,
} from "./messaging-connectors";

/**
 * Connectors — the registry, and what is connected from it.
 *
 * Every card is a registry entry; its status comes from main's one table and
 * connecting runs the one flow per kind (connect-flow.tsx). This panel knows
 * nothing about what a platform hop or an MCP install is — it renders cards
 * and reports outcomes.
 */

/** How long the card waits on the browser hop before giving the user back the button. */
const CONNECT_WATCHDOG_MS = 3 * 60 * 1000;

// The connectors install into the coding agent's MCP config, the same mode
// the MCP tab manages.
const MODE = "code" as const;

export const ConnectorsPanel = (): JSX.Element => {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const { statuses, loaded, refresh } = useConnectorStatuses();
  const flow = useConnectFlow();
  const [busy, setBusy] = useState<string | null>(null);
  // The browser hop is single-flight in the main process; this is which
  // connector holds the slot. Other cards stay clickable: a click elsewhere
  // cancels the hop in flight, a click on the running card is a fresh attempt.
  const [connecting, setConnecting] = useState<string | null>(null);
  // The card of a connect that came back failed, so it can say so in place
  // rather than only in a toast that is gone by the time the user looks.
  const [connectError, setConnectError] = useState<{
    id: string;
    message: string;
  } | null>(null);
  // Which MCP server a sign-in is in flight for.
  const [signingIn, setSigningIn] = useState<string | null>(null);

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
  // loopback listener holds its port and sits out the full window for a flow
  // the user has walked away from.
  useEffect(() => () => flow.cancel(), [flow]);

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

  const connect = useCallback(
    async (connector: ConnectorDefinition) => {
      const hop = connectUi(connector) === "browser-hop";
      // A second click on an adding card is a retry; a click on another card
      // cancels this one and says so.
      if (hop && connecting != null) {
        flow.cancel();
        if (connecting !== connector.id) {
          const other = CONNECTORS.find((entry) => entry.id === connecting);
          toast.info(
            t("connectors.abacusConnectCancelled", {
              name: other?.name ?? connecting,
            })
          );
        }
      }
      setBusy(connector.id);
      if (hop) setConnecting(connector.id);
      setConnectError((current) =>
        current?.id === connector.id ? null : current
      );
      let connected = false;
      try {
        if (hop)
          toast.info(
            t("connectors.abacusConnecting", { name: connector.name })
          );
        // The main process waits twenty minutes for the browser; the card
        // gives up sooner so a hung flow does not leave it "adding" for good.
        const result = await (hop
          ? Promise.race([
              flow.start(connector),
              new Promise<{ ok: false; error: string; timedOut: true }>(
                (resolve) =>
                  setTimeout(
                    () =>
                      resolve({
                        ok: false,
                        error: "timed out",
                        timedOut: true,
                      }),
                    CONNECT_WATCHDOG_MS
                  )
              ),
            ])
          : flow.start(connector));
        if (result.ok !== true) {
          const timedOut = "timedOut" in result;
          if (timedOut) flow.cancel();
          // Cancelled by the next click is not this card's failure to report.
          const cancelled = !timedOut && result.cancelled === true;
          if (!cancelled) {
            setConnectError({
              id: connector.id,
              message:
                connector.kind === "mcp" && result.error != null
                  ? t("connectors.signInFailed", {
                      name: connector.name,
                      error: result.error,
                    })
                  : t("connectors.abacusConnectFailed", {
                      name: connector.name,
                    }),
            });
          }
          return;
        }
        connected = true;
        await refresh();
        await reconnectRunningAgent();
        // Added either way: the server itself is fine, its first browser
        // call is what fails, and a warning now beats a stack trace later.
        if (
          connector.kind === "mcp" &&
          connector.requires === "google-chrome"
        ) {
          const present = await window.api?.hasGoogleChrome?.();
          if (present === false)
            toast.warning(
              t("connectors.chromeMissing", { name: connector.name }),
              { duration: 15_000 }
            );
        }
        toast.success(
          connector.kind === "platform"
            ? t("connectors.abacusConnected", { name: connector.name })
            : t("connectors.added", { name: connector.name })
        );
      } finally {
        // The status table is the source of truth either way.
        if (!connected) void refresh();
        setConnecting((current) => (current === connector.id ? null : current));
        clearBusy(connector.id);
      }
    },
    [clearBusy, connecting, flow, reconnectRunningAgent, refresh, t]
  );

  const disconnect = useCallback(
    async (connector: ConnectorDefinition) => {
      setBusy(connector.id);
      try {
        const result = await window.api.agent.disconnectConnector(connector.id);
        if (result.ok !== true) {
          toast.error(
            connector.kind === "platform"
              ? t("connectors.abacusDisconnectFailed", { name: connector.name })
              : t("connectors.removeFailed", { name: connector.name })
          );
          return;
        }
        await refresh();
        await reconnectRunningAgent();
        toast.success(
          connector.kind === "platform"
            ? t("connectors.abacusDisconnected", { name: connector.name })
            : t("connectors.removed", { name: connector.name })
        );
      } finally {
        clearBusy(connector.id);
      }
    },
    [clearBusy, reconnectRunningAgent, refresh, t]
  );

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
    async (connector: ConnectorDefinition) => {
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

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    // A platform card the account cannot offer would connect to nothing;
    // hide it once we know. No statuses yet = show all.
    const offered = CONNECTORS.filter(
      (connector) =>
        !loaded || statusOf(statuses, connector.id).reason !== "not-offered"
    );
    if (needle.length === 0) return offered;
    return offered.filter(
      (connector) =>
        connector.name.toLowerCase().includes(needle) ||
        connector.description.toLowerCase().includes(needle) ||
        connector.id.includes(needle)
    );
  }, [query, statuses, loaded]);

  // Messaging is always its own section: hopping between connected and not on
  // every reconnect would read as the page reshuffling itself.
  const messagingItems = useMemo(
    () =>
      visible.filter(
        (connector): connector is MessagingConnector =>
          connector.kind === "messaging"
      ),
    [visible]
  );
  const sections = useMemo(() => {
    const rest = visible.filter((connector) => connector.kind !== "messaging");
    return [
      {
        id: "installed" as const,
        items: rest.filter((connector) => isConnected(statuses, connector.id)),
      },
      {
        id: "notInstalled" as const,
        items: rest.filter((connector) => !isConnected(statuses, connector.id)),
      },
    ];
  }, [visible, statuses]);

  return (
    <FocusedPage data-id="connectors-panel">
      {flow.dialogs}
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
                      (entry) => entry.id === connector.platform
                    );
                    const status = statusOf(statuses, connector.id);
                    // Attached but not live — a broken link, or a shared-bot
                    // lane still to be linked — offers Connect straight away,
                    // with the badge saying why.
                    const attached =
                      status.state === "connected" ||
                      status.state === "pending";
                    const linkPending = sharedLinkPending(
                      messaging.snapshot,
                      connector.platform
                    );
                    return (
                      <ConnectorCard
                        key={connector.id}
                        connector={connector}
                        isInstalled={status.state === "connected"}
                        isBusy={false}
                        statusBadge={
                          platform != null && attached ? (
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
                          attached
                            ? () => setMessagingDialog(connector.platform)
                            : undefined
                        }
                        onAdd={() => void connect(connector)}
                        onRemove={() =>
                          void removeMessaging(connector.platform)
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
                        isInstalled={isConnected(statuses, connector.id)}
                        isBusy={busy === connector.id}
                        isAdding={connecting === connector.id}
                        needsSignIn={
                          connector.kind === "mcp" &&
                          connector.auth === "oauth" &&
                          runtimeServers.get(connector.id)?.status ===
                            "auth-required"
                        }
                        isSigningIn={signingIn === connector.id}
                        onSignIn={
                          connector.kind === "mcp" && connector.auth === "oauth"
                            ? () => void signInMcp(connector)
                            : undefined
                        }
                        error={
                          connectError?.id === connector.id
                            ? connectError.message
                            : null
                        }
                        onAdd={() => void connect(connector)}
                        onRemove={() => void disconnect(connector)}
                      />
                    ))}
                  </div>
                )}
              </section>
            ))}
          </>
        )}
      </FocusedPageBody>

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

/** What the auth badge on a card says, by kind. */
const authLabelKey = (connector: ConnectorDefinition): string | null => {
  switch (connector.kind) {
    case "platform":
      return "connectors.auth.abacus";
    case "credential":
      return "connectors.auth.token";
    case "messaging":
      // Messaging cards wear their live state instead of an auth badge —
      // "Connected" says more than naming the pairing mechanism would.
      return null;
    case "mcp":
      return connector.auth === "none"
        ? null
        : `connectors.auth.${connector.auth}`;
  }
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
  const authKey = authLabelKey(connector);

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
          {authKey != null && (
            <Badge variant="secondary" title={t(authKey)}>
              <Key />
              {t(authKey)}
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
              : connector.kind === "messaging"
                ? t("connectors.connectAction")
                : t("connectors.add")}
          </Button>
        )}
      </ItemActions>
    </Item>
  );
};
