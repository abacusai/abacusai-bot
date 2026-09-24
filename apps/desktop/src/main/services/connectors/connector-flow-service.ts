/**
 * How a connector gets connected and disconnected, by kind, in one place.
 * Every surface with a Connect button — the Connectors page, onboarding, the
 * card the agent raises in a chat — calls this rather than knowing what a
 * platform hop, a credential store or an MCP install is. The renderer's only
 * job is to collect fields when the kind needs them (registry `connectUi`).
 */
import {
  connectorById,
  connectUi,
  HOME_PLACEHOLDER,
  type Connector,
  type McpConnector,
} from "@abacus-ai/connectors/registry";

import type { ConnectorOutcome, McpServerEntry } from "#shared/contracts";

export interface FlowSources {
  /** The platform's browser hop and its inverse, by service key. */
  platform: {
    connect: (service: string) => Promise<ConnectorOutcome>;
    disconnect: (service: string) => Promise<ConnectorOutcome>;
    /** Rewrites the gateway MCP entry after a connect: the file is user-editable. */
    ensureGateway: () => void;
    /** A service just attached; whatever follows from that (fire and forget). */
    onConnected?: (connectorId: string) => void;
  };
  /**
   * Store (or clear, with "") an agent credential by provider id. Announcing
   * it — the gateway, running agents, the renderer — is the caller's.
   */
  credential: { save: (provider: string, value: string) => void };
  mcp: {
    add: (
      name: string,
      entry: McpServerEntry
    ) => { success: boolean; error?: string };
    remove: (name: string) => { success: boolean; error?: string };
    /** The server's own browser sign-in, for `oauth` and `oauth-client` entries. */
    signIn: (
      name: string
    ) => Promise<{ success: boolean; error?: string; cancelled?: boolean }>;
  };
  homeDir: () => string;
}

const failure = (error: string): ConnectorOutcome => ({ ok: false, error });

const unknown = (id: string): ConnectorOutcome =>
  failure(`There is no connector "${id}".`);

/**
 * The MCP entry a server connector installs as, with the user's fields in
 * their places: a token in its header, keys in the environment, an OAuth
 * client on the entry, `{{HOME}}` expanded.
 */
export const mcpEntryFor = (
  connector: McpConnector,
  values: Record<string, string>,
  homeDir: string
): McpServerEntry => {
  const entry: McpServerEntry = { ...connector.entry };
  if (entry.args?.includes(HOME_PLACEHOLDER) === true)
    entry.args = entry.args.map((arg) =>
      arg === HOME_PLACEHOLDER ? homeDir : arg
    );
  if (connector.token != null && values.token != null)
    entry.headers = {
      ...entry.headers,
      [connector.token.header]:
        `${connector.token.scheme} ${values.token}`.trim(),
    };
  if (connector.env != null && connector.env.length > 0) {
    entry.env = { ...entry.env };
    for (const name of connector.env) entry.env[name] = values[name] ?? "";
  }
  // The client the sign-in authorizes with, for providers that will not
  // register one for us; the OAuth service reads it back from the entry.
  if (connector.auth === "oauth-client") {
    const clientId = (values.clientId ?? "").trim();
    const clientSecret = (values.clientSecret ?? "").trim();
    entry.oauth = {
      ...(clientId.length > 0 ? { clientId } : {}),
      ...(clientSecret.length > 0 ? { clientSecret } : {}),
    };
  }
  return entry;
};

export class ConnectorFlowService {
  constructor(private readonly sources: FlowSources) {}

  /** Connect a connector whose flow takes no fields. */
  async connect(connectorId: string): Promise<ConnectorOutcome> {
    const connector = connectorById(connectorId);
    if (connector == null) return unknown(connectorId);
    const ui = connectUi(connector);
    if (ui === "fields")
      return failure(`${connector.name} needs its fields first.`);
    if (ui === "pairing")
      return failure(`${connector.name} is paired from its own dialog.`);
    if (connector.kind === "platform") {
      const outcome = await this.sources.platform.connect(connector.service);
      if (outcome.ok) {
        this.sources.platform.ensureGateway();
        this.sources.platform.onConnected?.(connectorId);
      }
      return outcome;
    }
    if (connector.kind === "mcp") return this.installMcp(connector, {});
    return failure(`${connector.name} cannot be connected this way.`);
  }

  /** Connect a connector whose flow asked for fields, with what the user typed. */
  async submitFields(
    connectorId: string,
    values: Record<string, string>
  ): Promise<ConnectorOutcome> {
    const connector = connectorById(connectorId);
    if (connector == null) return unknown(connectorId);
    if (connector.kind === "credential") {
      const value = (values[connector.envVar] ?? "").trim();
      if (value.length === 0)
        return failure(`${connector.name} needs its token.`);
      this.sources.credential.save(connector.provider, value);
      return { ok: true };
    }
    if (connector.kind === "mcp") return this.installMcp(connector, values);
    return failure(`${connector.name} takes no fields.`);
  }

  async disconnect(connectorId: string): Promise<ConnectorOutcome> {
    const connector = connectorById(connectorId);
    if (connector == null) return unknown(connectorId);
    switch (connector.kind) {
      case "platform":
        return this.sources.platform.disconnect(connector.service);
      case "credential":
        this.sources.credential.save(connector.provider, "");
        return { ok: true };
      case "mcp": {
        const result = this.sources.mcp.remove(connector.id);
        return result.success
          ? { ok: true }
          : failure(result.error ?? `Could not remove ${connector.name}.`);
      }
      case "messaging":
        // The gateway owns a platform's lifecycle; its card and the
        // messaging tools switch it off.
        return failure(
          `${connector.name} is disconnected from its own card in Connectors.`
        );
    }
  }

  private async installMcp(
    connector: McpConnector,
    values: Record<string, string>
  ): Promise<ConnectorOutcome> {
    const added = this.sources.mcp.add(
      connector.id,
      mcpEntryFor(connector, values, this.sources.homeDir())
    );
    if (!added.success)
      return failure(added.error ?? `Could not add ${connector.name}.`);
    // An OAuth server without its sign-in 401s on first use, so the sign-in
    // is part of connecting. Added stays added on a failed sign-in: the
    // server itself is fine, and the card offers Sign in.
    if (connector.auth === "oauth" || connector.auth === "oauth-client") {
      const signIn = await this.sources.mcp.signIn(connector.id);
      if (!signIn.success)
        return {
          ok: false,
          error: signIn.error ?? `${connector.name} sign-in did not finish.`,
          ...(signIn.cancelled === true ? { cancelled: true } : {}),
        };
    }
    return { ok: true };
  }
}

/** Whether the kind's flow needs the renderer to collect fields first. */
export const needsFields = (connector: Connector): boolean =>
  connectUi(connector) === "fields";
