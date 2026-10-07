/**
 * One answer to "is this connector connected?", for every kind, keyed by
 * registry id. Each kind has exactly one source of truth: the platform's
 * listing, the stored credentials, the messaging gateway's live state, the
 * MCP config. This is the only place those are read for that question.
 * The renderer, the environment notice and `connect_connector` all consume
 * the same statuses, so no surface computes "installed" on its own.
 */
import { CONNECTORS, type Connector } from "@abacus-ai/connectors/registry";
import type {
  ConnectorStatus,
  ConnectorStatuses,
  McpServerInfo,
} from "@abacus-ai/contract/contracts";
import {
  isMessagingPlatformConnected,
  isMessagingPlatformInstalled,
  type MessagingSnapshot,
} from "@abacus-ai/contract/messaging";

import type { McpTokenState } from "../mcp/mcp-oauth-service";

export interface StatusInputs {
  /**
   * The platform's listing, already narrowed to the registry, or null when
   * it could not be read: signed out, or the platform unreachable.
   */
  platform: {
    available: ReadonlySet<string>;
    connected: ReadonlySet<string>;
    accounts: Readonly<Record<string, string>>;
    /** Why there is no listing, when there is none. */
    reason?: string;
  } | null;
  /** Credential providers with a key stored, or exported in the shell. */
  messaging: MessagingSnapshot | null;
  mcpServers: readonly McpServerInfo[];
  /** Each installed server's sign-in, by server id; absent when unlisted. */
  mcpTokens: ReadonlyMap<string, McpTokenState>;
}

const statusOf = (
  connector: Connector,
  inputs: StatusInputs
): ConnectorStatus => {
  switch (connector.kind) {
    case "platform": {
      const platform = inputs.platform;
      if (platform == null || platform.reason != null)
        return {
          state: "unavailable",
          reason: platform?.reason ?? "unavailable",
        };
      if (platform.connected.has(connector.service)) {
        const account = platform.accounts[connector.service];
        return {
          state: "connected",
          ...(account != null && account.length > 0 ? { account } : {}),
        };
      }
      // Not in the account's catalog: the org disabled it, or it is not GA
      // for them. A card that connects to nothing is worse than none.
      return platform.available.has(connector.service)
        ? { state: "available" }
        : { state: "unavailable", reason: "not-offered" };
    }
    case "messaging":
      if (isMessagingPlatformConnected(inputs.messaging, connector.platform))
        return { state: "connected" };
      // Enabled and configured but not live: a broken link, or a shared-bot
      // lane still to be linked. Attached, in other words, but not usable.
      return isMessagingPlatformInstalled(inputs.messaging, connector.platform)
        ? { state: "pending", reason: "not-live" }
        : { state: "available" };
    case "mcp": {
      const server = inputs.mcpServers.find((item) => item.id === connector.id);
      if (server == null) return { state: "available" };
      const token = inputs.mcpTokens.get(server.id) ?? "absent";
      // An OAuth server needs a valid token; any other, just not a refused one.
      const signsIn =
        (connector.auth === "oauth" || connector.auth === "oauth-client") &&
        server.config.oauth !== false &&
        server.config.url != null;
      return (signsIn ? token === "valid" : token !== "expired")
        ? { state: "connected" }
        : { state: "pending", reason: "sign-in-required" };
    }
  }
};

/** Pure: the statuses for these inputs. Exported for tests. */
export const buildConnectorStatuses = (
  inputs: StatusInputs,
  registry: readonly Connector[] = CONNECTORS
): ConnectorStatuses =>
  Object.fromEntries(
    registry.map((connector) => [connector.id, statusOf(connector, inputs)])
  );

/** Ids of the connectors in a given state, in registry order. */
export const connectorsInState = (
  statuses: ConnectorStatuses,
  state: ConnectorStatus["state"],
  registry: readonly Connector[] = CONNECTORS
): Connector[] =>
  registry.filter((connector) => statuses[connector.id]?.state === state);

export interface StatusSources {
  /** `fresh` skips any cache, for a caller that must see a change now. */
  platform: (options?: {
    fresh?: boolean;
  }) => Promise<StatusInputs["platform"]>;
  messaging: () => MessagingSnapshot | null;
  mcpServers: () => readonly McpServerInfo[];
  mcpTokens: () => ReadonlyMap<string, McpTokenState>;
}

/**
 * The statuses as they are now, from live sources on every call: the
 * platform listing is a network read, the rest are in memory. Callers that
 * need the change stream listen for the `connector-status-changed` event the
 * host emits after anything that can move a status.
 */
export class ConnectorStatusService {
  constructor(private readonly sources: StatusSources) {}

  async list(options: { fresh?: boolean } = {}): Promise<ConnectorStatuses> {
    let platform: StatusInputs["platform"] = null;
    try {
      platform = await this.sources.platform(options);
    } catch (error) {
      console.error("[connectors] platform listing failed:", error);
    }
    return buildConnectorStatuses({
      platform,
      messaging: this.sources.messaging(),
      mcpServers: this.sources.mcpServers(),
      mcpTokens: this.sources.mcpTokens(),
    });
  }
}
