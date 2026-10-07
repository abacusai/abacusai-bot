/**
 * How a connector gets connected and disconnected, by kind, in one place.
 * Every surface with a Connect button (the Connectors page, onboarding, the
 * card the agent raises in a chat) calls this rather than knowing what a
 * platform connect page, a credential store or an MCP install is. The renderer's only
 * job is to collect fields when the kind needs them (registry `connectUi`).
 */
import {
  connectorById,
  connectUi,
  HOME_PLACEHOLDER,
  type McpConnector,
} from "@abacus-ai/connectors/registry";
import type {
  ConnectorConnectOptions,
  ConnectorOutcome,
  McpServerEntry,
} from "@abacus-ai/contract/contracts";

/**
 * How a server's sign-in went: done (desktop), the provider's page to send the
 * browser to (web host), no sign-in asked for, or why not.
 */
export type McpSignIn =
  | { kind: "signed-in" }
  | { kind: "redirect"; location: string }
  | { kind: "open" }
  | { kind: "failed"; error?: string; cancelled?: boolean };

export interface FlowSources {
  /** The platform's connect page URL and its inverse, by service key. */
  platform: {
    connect: (
      service: string,
      options?: ConnectorConnectOptions
    ) => ConnectorOutcome;
    disconnect: (service: string) => Promise<ConnectorOutcome>;
    /** Follows a connector whose page was handed out until it connects. */
    watch: (connectorId: string) => void;
  };
  mcp: {
    /** The entry installed under `name`, if any. */
    entry: (name: string) => McpServerEntry | undefined;
    /** Add the server, or replace its entry with the user's new fields. */
    add: (
      name: string,
      entry: McpServerEntry
    ) => { success: boolean; error?: string };
    remove: (name: string) => { success: boolean; error?: string };
    /** The server's own browser sign-in: the desktop's loopback, or the web host's redirect. */
    signIn: (name: string) => Promise<McpSignIn>;
    /** The web host's connect route for `name`, absolute; null on the desktop. */
    connectUrl: (name: string) => string | null;
    /** Follows a connector whose sign-in was handed out until it connects. */
    watch: (connectorId: string) => void;
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

/**
 * Connecting one MCP server, by its registry id or the user's own server name:
 * done, a provider page to send the browser to (web host), or why not.
 */
export type McpConnectResult =
  | { kind: "connected"; label: string }
  | { kind: "sign-in"; label: string; location: string }
  | { kind: "failed"; label: string; error: string; cancelled?: boolean }
  | { kind: "missing" };

/** Whether this entry signs in with OAuth: an http server that does not opt out. */
const signsIn = (
  connector: McpConnector | undefined,
  entry: McpServerEntry
): boolean =>
  entry.url != null &&
  entry.oauth !== false &&
  // A registry server says how it authenticates; the user's own may challenge.
  (connector == null ||
    connector.auth === "oauth" ||
    connector.auth === "oauth-client");

/** The registry's MCP connector by this id, if it is one. */
const mcpConnector = (name: string): McpConnector | undefined => {
  const found = connectorById(name);
  return found?.kind === "mcp" ? found : undefined;
};

/** A failure for the caller in the app's words; the reason goes to the log. */
const failedConnect = (
  label: string,
  message: string,
  detail: string | undefined
): Extract<McpConnectResult, { kind: "failed" }> => {
  if (detail != null) console.warn(`[connectors] ${label}: ${detail}`);
  return { kind: "failed", label, error: message };
};

export class ConnectorFlowService {
  constructor(private readonly sources: FlowSources) {}

  /** Connect a connector whose flow takes no fields. */
  async connect(
    connectorId: string,
    options?: ConnectorConnectOptions
  ): Promise<ConnectorOutcome> {
    const connector = connectorById(connectorId);
    if (connector == null) return unknown(connectorId);
    const ui = connectUi(connector);
    if (ui === "fields")
      return failure(`${connector.name} needs its fields first.`);
    if (ui === "pairing")
      return failure(`${connector.name} is paired from its own dialog.`);
    if (connector.kind === "platform") {
      // The caller opens the page; completion arrives through the watch.
      const outcome = this.sources.platform.connect(connector.service, options);
      if (outcome.ok) this.sources.platform.watch(connector.id);
      return outcome;
    }
    if (connector.kind === "mcp") {
      // Web host: the browser opens the host's route, which runs connectMcp.
      const url = this.sources.mcp.connectUrl(connector.id);
      if (url != null) return { ok: true, url };
      return outcomeOf(await this.connectMcp(connector.id), connector.id);
    }
    return failure(`${connector.name} cannot be connected this way.`);
  }

  /** Connect a connector whose flow asked for fields, with what the user typed. */
  async submitFields(
    connectorId: string,
    values: Record<string, string>
  ): Promise<ConnectorOutcome> {
    const connector = connectorById(connectorId);
    if (connector == null) return unknown(connectorId);
    if (connector.kind !== "mcp")
      return failure(`${connector.name} takes no fields.`);
    const added = this.sources.mcp.add(
      connector.id,
      mcpEntryFor(connector, values, this.sources.homeDir())
    );
    if (!added.success)
      return failure(added.error ?? `Could not add ${connector.name}.`);
    return outcomeOf(await this.connectMcp(connector.id), connector.id);
  }

  /**
   * The one install-and-sign-in for an MCP server: installs a registry
   * connector that is absent (never touching an entry already there), then
   * signs in when the entry needs it. Added stays added on a failed sign-in:
   * the server itself is fine, and its card offers Sign in.
   */
  async connectMcp(name: string): Promise<McpConnectResult> {
    const connector = mcpConnector(name);
    if (this.mcpLabel(name) == null) return { kind: "missing" };
    let entry = this.sources.mcp.entry(name);
    if (entry == null) {
      if (connector == null) return { kind: "missing" };
      if (connectUi(connector) === "fields")
        return {
          kind: "failed",
          label: connector.name,
          error: `${connector.name} needs its fields first.`,
        };
      entry = mcpEntryFor(connector, {}, this.sources.homeDir());
      const added = this.sources.mcp.add(name, entry);
      if (!added.success)
        return failedConnect(
          connector.name,
          `Could not add ${connector.name}.`,
          added.error
        );
    }
    const label = connector?.name ?? name;
    // An OAuth server without its sign-in 401s on first use, so the sign-in
    // is part of connecting.
    if (!signsIn(connector, entry)) return { kind: "connected", label };
    const signIn = await this.sources.mcp.signIn(name);
    switch (signIn.kind) {
      case "signed-in":
      case "open":
        return { kind: "connected", label };
      case "redirect":
        // Hosted: completion arrives through the callback and the watch.
        if (connector != null) this.sources.mcp.watch(connector.id);
        return { kind: "sign-in", label, location: signIn.location };
      case "failed":
        return {
          ...failedConnect(
            label,
            `${label} sign-in did not finish.`,
            signIn.error
          ),
          ...(signIn.cancelled === true ? { cancelled: true } : {}),
        };
    }
  }

  /** What an MCP server connectable by this name is called; null when there is none. */
  mcpLabel(name: string): string | null {
    const found = connectorById(name);
    if (found != null) return found.kind === "mcp" ? found.name : null;
    return this.sources.mcp.entry(name) != null ? name : null;
  }

  async disconnect(connectorId: string): Promise<ConnectorOutcome> {
    const connector = connectorById(connectorId);
    if (connector == null) return unknown(connectorId);
    switch (connector.kind) {
      case "platform":
        return this.sources.platform.disconnect(connector.service);
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
}

const outcomeOf = (
  result: McpConnectResult,
  connectorId: string
): ConnectorOutcome => {
  switch (result.kind) {
    case "connected":
      return { ok: true };
    case "sign-in":
      return { ok: true, url: result.location };
    case "failed":
      return {
        ok: false,
        error: result.error,
        ...(result.cancelled === true ? { cancelled: true } : {}),
      };
    case "missing":
      return unknown(connectorId);
  }
};
