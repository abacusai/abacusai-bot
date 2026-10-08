/**
 * MCP servers, connected and exposed to the agent as tools. Reads the config
 * the desktop names in `ABACUSAI_BOT_MCP_CONFIG` (built-ins plus user servers),
 * connects, and turns each remote tool into a pi tool. A user server's `search`
 * becomes `myserver_search`; built-ins keep their own names. A server that
 * fails to connect is reported and skipped, never allowed to stop the agent.
 */
import * as fs from "node:fs";

import { GATEWAY_SERVER_NAME } from "@abacus-ai/connectors/registry";
import {
  connectorToolMetaByName,
  gatewayToolMeta,
  type ConnectorToolMeta,
} from "@abacus-ai/connectors/tool-meta";

import { DEFAULT_ABACUS_V1, sponsoredRunHeaders } from "../abacus-endpoint.js";
import { abacusBotDir, desktopMcpConfigPath } from "../config.js";
import {
  UNATTENDED_EXCLUDED_TOOLS,
  UNATTENDED_TOOLS,
  type ToolOrigin,
} from "../tool-policy.js";
import { authHeadersForServer } from "./auth.js";
import {
  McpClient,
  McpHttpError,
  type McpToolInfo,
  type McpTransport,
} from "./client.js";

export interface McpServerConfig {
  url?: string;
  headers?: Record<string, string>;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** OAuth options for http servers; `false` opts a server out entirely. */
  oauth?: { clientId?: string; clientSecret?: string; scope?: string } | false;
  disabled?: boolean;
  isBuiltin?: boolean;
}

export interface McpServerStatus {
  id: string;
  name: string;
  transport: string;
  status: "connected" | "error" | "disconnected" | "auth-required";
  error?: string;
  toolCount: number;
  /** A server the app hosts itself, rather than one the user added. */
  isBuiltin?: boolean;
}

export interface ConnectedMcp {
  clients: McpClient[];
  statuses: McpServerStatus[];
  /** pi tool name -> the client and remote tool name it maps to. */
  routes: Map<string, { client: McpClient; toolName: string }>;
  /** Reconnect one server with a refreshed token; null when it still cannot. */
  reconnect?: (name: string) => Promise<McpClient | null>;
  /** Fired after reconnect() changes a status, so the roster is re-emitted. */
  onStatusChange?: () => void;
  /** Fired when a server that failed at startup comes up, with its tools now in `tools`. */
  onToolsAdded?: () => void;
  /** Stop retrying failed servers; called before this set is replaced or the session ends. */
  retire?: () => void;
  tools: Array<{
    name: string;
    description: string;
    schema: Record<string, unknown>;
  }>;
}

/**
 * The only env vars a header placeholder may name: each is a secret any
 * config entry can put on the wire.
 */
export const HEADER_ENV_ALLOWLIST: ReadonlySet<string> = new Set([
  "ABACUS_API_KEY",
]);

/**
 * The one host an expanded credential may be sent to, re-checked (https, an
 * `abacus.ai` host) so a bogus `ABACUSAI_BOT_ABACUS_V1` cannot widen the rule.
 */
export const credentialHeaderHost = (
  env: NodeJS.ProcessEnv = process.env
): string | null => {
  const raw = (env.ABACUSAI_BOT_ABACUS_V1 ?? "").trim() || DEFAULT_ABACUS_V1;

  try {
    const url = new URL(raw);
    const host = url.hostname.toLowerCase();

    if (url.protocol !== "https:") return null;
    if (host !== "abacus.ai" && !host.endsWith(".abacus.ai")) return null;

    return host;
  } catch {
    return null;
  }
};

/** Whether `url` is the exact host an expanded credential may travel to. */
const isCredentialHost = (
  url: string | undefined,
  env: NodeJS.ProcessEnv
): boolean => {
  const trusted = credentialHeaderHost(env);
  if (url == null || trusted == null) return false;

  try {
    const parsed = new URL(url);

    // Whole-hostname equality: `routellm.abacus.ai.example.com` must not pass.
    return (
      parsed.protocol === "https:" && parsed.hostname.toLowerCase() === trusted
    );
  } catch {
    return false;
  }
};

export interface ExpandedHeaders {
  headers: Record<string, string> | undefined;
  /** A header carries a credential read from the environment. */
  credentialExpanded: boolean;
}

/**
 * Expand `${ENV_VAR}` placeholders in header values, only for an allowlisted
 * variable on an entry addressing the Abacus host over https. A placeholder
 * failing either rule, or empty, drops its header: literal `${...}` would turn
 * a clean 401 into a malformed-credential error.
 */
export const expandHeaderEnvPlaceholders = (
  headers: Record<string, string> | undefined,
  url?: string,
  env: NodeJS.ProcessEnv = process.env
): ExpandedHeaders => {
  if (headers == null) return { headers, credentialExpanded: false };

  const trustedHost = isCredentialHost(url, env);
  const expanded: Record<string, string> = {};
  let credentialExpanded = false;

  for (const [name, value] of Object.entries(headers)) {
    let dropped = false;
    let expandedHere = false;
    const result = value.replace(
      /\$\{([A-Z][A-Z0-9_]*)\}/g,
      (_match, envName: string) => {
        if (!trustedHost || !HEADER_ENV_ALLOWLIST.has(envName)) {
          dropped = true;
          return "";
        }

        const envValue = (env[envName] ?? "").trim();
        if (envValue.length === 0) dropped = true;
        else expandedHere = true;

        return envValue;
      }
    );

    if (dropped) continue;

    expanded[name] = result;
    if (expandedHere) credentialExpanded = true;
  }
  // The sponsored-run marker rides only where the credential itself went.
  if (credentialExpanded) Object.assign(expanded, sponsoredRunHeaders(env));

  return { headers: expanded, credentialExpanded };
};

/**
 * The name the model sees. Third-party servers get a prefix so two `search`
 * tools stay distinct; built-ins do not, because component hand-off text, the
 * toolset registry and the UI all name them bare.
 */
const qualify = (
  serverName: string,
  tool: McpToolInfo,
  isBuiltin: boolean
): string =>
  isBuiltin || tool.name.startsWith(`${serverName}_`)
    ? tool.name
    : `${serverName}_${tool.name}`;

/**
 * Servers only the desktop can host (loopback URL, per-boot token). Must match
 * RESERVED_BUILTIN_NAMES in the desktop's services/mcp/mcp-config-service.ts.
 */
const DESKTOP_ONLY_SERVERS = ["browser", "device", "agent-tools"];

/**
 * Tools a desktop server serves for this agent's own runtime, not for a
 * model: the browser's `browser_checkout`, which `browser_task` drives.
 * Routed, so the runtime can call them; never listed among a model's tools.
 */
export const HOST_INTERNAL_TOOLS: ReadonlySet<string> = new Set([
  "browser_checkout",
]);

/** A server the app itself hosts: marked so, and under one of its reserved names. */
const isAppServer = (name: string, config: McpServerConfig): boolean =>
  config.isBuiltin === true && DESKTOP_ONLY_SERVERS.includes(name);

/** Where a routed tool comes from, by the app's reserved names, not what a config entry claims. */
export const toolOriginOf = (mcp: ConnectedMcp, name: string): ToolOrigin => {
  const route = mcp.routes.get(name);
  if (route == null) return "builtin";
  const server = route.client.name;
  if (server === GATEWAY_SERVER_NAME) return "connector";
  return DESKTOP_ONLY_SERVERS.includes(server) &&
    mcp.statuses.some(
      (status) => status.id === server && status.isBuiltin === true
    )
    ? "builtin"
    : "user";
};

const withoutDesktopOnlyServers = (
  servers: Record<string, McpServerConfig>
): Record<string, McpServerConfig> =>
  Object.fromEntries(
    Object.entries(servers).filter(
      ([name]) => !DESKTOP_ONLY_SERVERS.includes(name)
    )
  );

type ConfigRead =
  | { kind: "ok"; servers: Record<string, McpServerConfig> }
  | { kind: "unreadable"; error: string };

const readConfig = (path: string): ConfigRead => {
  try {
    const parsed = JSON.parse(fs.readFileSync(path, "utf8")) as {
      mcpServers?: Record<string, McpServerConfig>;
    };

    return { kind: "ok", servers: parsed.mcpServers ?? {} };
  } catch (error) {
    return {
      kind: "unreadable",
      error: error instanceof Error ? error.message : String(error),
    };
  }
};

/**
 * No servers at all, said out loud: every built-in arrives through this
 * config, and silence looks like an agent declining its tools rather than one
 * that never had them. On stderr, since stdout is the protocol.
 */
const noServers = (error: string, expected = false): ConnectedMcp => {
  // `expected` is a run never given a config (development, tests), where no
  // servers is normal; ABACUSAI_BOT_AGENT_DEBUG=1 still prints it.
  if (!expected || process.env.ABACUSAI_BOT_AGENT_DEBUG === "1") {
    process.stderr.write(`[mcp] ${error}\n`);
  }

  return { clients: [], statuses: [], routes: new Map(), tools: [] };
};

/**
 * Metadata for the gateway tools registered this process, by every name they
 * answer to. Filled as servers connect; a tool the registry does not name is
 * never registered, so it is never here either.
 */
const registeredToolMeta = new Map<string, ConnectorToolMeta>();

/**
 * What the agent knows about a connector tool by its pi-side name, or null
 * for any other tool. Registered metadata first (it may carry the server's
 * own price); the registry answers for a name seen before any server did.
 */
export const connectorToolMeta = (toolName: string): ConnectorToolMeta | null =>
  registeredToolMeta.get(toolName) ?? connectorToolMetaByName(toolName);

/**
 * Waits before retrying a server that failed for a network reason. The startup
 * ones are short because the session waits on them; past them the server keeps
 * trying in the background, every five minutes in the end, and its tools join the
 * session when it comes up. A laptop waking or changing Wi-Fi drops the first
 * request, and one miss used to cost the chat that server's tools for good.
 */
const STARTUP_RETRY_DELAYS_MS = [1_000, 3_000];
const RECOVERY_DELAYS_MS = [15_000, 30_000, 60_000, 120_000];
const RECOVERY_REPEAT_MS = 300_000;

/**
 * The connector gateway can refuse a key minted moments ago that it accepts a
 * few seconds later: seen on the first chat after signing in. Its refusal
 * gets a few background tries over the first minute, then stands, so a key
 * that is really refused is not retried for the life of the session.
 */
const KEY_REFUSED_RETRY_DELAYS_MS = [5_000, 15_000, 30_000];

/**
 * A failure worth retrying: no answer from the network (undici's "fetch
 * failed") or a gateway saying it is briefly unavailable. A timeout, a sign-in
 * or a refusal would fail the same way again.
 */
const isTransientConnectError = (error: unknown): boolean =>
  error instanceof McpHttpError
    ? [429, 502, 503, 504].includes(error.status)
    : error instanceof TypeError && error.message === "fetch failed";

const sleep = (ms: number, options: { unref?: boolean } = {}): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    // A background retry must never be what keeps the process alive.
    if (options.unref === true) timer.unref?.();
  });

export async function connectMcpServers(
  configPath: string | undefined
): Promise<ConnectedMcp> {
  // Without a named file, fall back to the app's own server list so an agent
  // started outside the app still sees the connectors added there.
  const fromDesktopConfig = configPath == null || configPath.length === 0;
  const resolvedPath = fromDesktopConfig ? desktopMcpConfigPath() : configPath;

  if (resolvedPath == null) {
    return noServers(
      "ABACUSAI_BOT_MCP_CONFIG is not set and the app has no server list at " +
        `${abacusBotDir()}, so this agent has no MCP servers: no browser tools, ` +
        "no device tools, and none of the agent-tools built-ins.",
      true
    );
  }

  const config = readConfig(resolvedPath);

  if (config.kind === "unreadable") {
    return noServers(
      `Could not read the server list at ${resolvedPath} (${config.error}), so this agent has no ` +
        "MCP servers: no browser tools, no device tools, and none of the agent-tools built-ins."
    );
  }

  // The app's list may still carry a built-in whose loopback URL nothing is
  // serving; skipped rather than reported as a broken install.
  const servers = fromDesktopConfig
    ? withoutDesktopOnlyServers(config.servers)
    : config.servers;
  const result: ConnectedMcp = {
    clients: [],
    statuses: [],
    routes: new Map(),
    tools: [],
  };

  // One connect attempt, shared by the startup fan-out and reconnect().
  const connectOne = async (
    name: string,
    config: McpServerConfig,
    options: { forceRefresh?: boolean } = {}
  ): Promise<{
    client: McpClient | null;
    status: McpServerStatus;
    transient?: boolean;
    keyRefused?: boolean;
  }> => {
    const builtin = config.isBuiltin === true ? { isBuiltin: true } : {};

    if (config.disabled === true) {
      return {
        client: null,
        status: {
          id: name,
          name,
          transport: "disabled",
          status: "disconnected",
          toolCount: 0,
          ...builtin,
        },
      };
    }

    const transportKind = config.url != null ? "http" : "stdio";
    // Held outside the try so a failed connect can close it; nulled once the
    // client owns it so a later throw cannot close a live connection.
    let transport: McpTransport | null = null;
    let sentKey = false;

    try {
      // A stored OAuth token rides along on http servers unless the config
      // carries its own Authorization header or `oauth: false`.
      const expansion = expandHeaderEnvPlaceholders(config.headers, config.url);
      sentKey = expansion.credentialExpanded;
      let headers = expansion.headers;
      if (
        config.url != null &&
        config.oauth !== false &&
        headers?.Authorization == null
      ) {
        const auth = await authHeadersForServer(config.url, options);
        if (Object.keys(auth).length > 0) headers = { ...headers, ...auth };
      }

      transport =
        config.url != null
          ? McpClient.httpTransport(config.url, headers, {
              refuseRedirects: expansion.credentialExpanded,
            })
          : McpClient.stdioTransport(
              config.command ?? "",
              config.args ?? [],
              config.env ?? {}
            );

      const client = await McpClient.connect(name, transport);

      transport = null;

      return {
        client,
        status: {
          id: name,
          name,
          transport: transportKind,
          status: "connected",
          toolCount: client.tools.length,
          ...builtin,
        },
      };
    } catch (error) {
      // A stdio server's child must not outlive a failed connect.
      try {
        transport?.close();
      } catch {
        /* already gone */
      }

      // A 401 is a server waiting for a sign-in; its own status lets the
      // desktop offer one.
      const authRequired =
        error instanceof McpHttpError && error.status === 401;

      return {
        client: null,
        transient: isTransientConnectError(error),
        keyRefused:
          name === GATEWAY_SERVER_NAME &&
          sentKey &&
          error instanceof McpHttpError &&
          (error.status === 401 || error.status === 403),
        status: {
          id: name,
          name,
          transport: transportKind,
          status: authRequired ? "auth-required" : "error",
          error: authRequired
            ? "This server requires a sign-in."
            : error instanceof Error
              ? error.message
              : String(error),
          toolCount: 0,
          ...builtin,
        },
      };
    }
  };

  // Both spellings route; only the qualified name is advertised. `advertise`
  // is false on a reconnect, since pi's tool list is fixed for the session.
  const register = (
    name: string,
    config: McpServerConfig,
    client: McpClient,
    advertise: boolean
  ): void => {
    result.clients.push(client);

    for (const tool of client.tools) {
      // The registry is the allowlist for the gateway: a tool the account
      // has attached but no entry names (GitHub's, say, where a token on its own
      // card does that job) is not offered.
      const meta =
        name === GATEWAY_SERVER_NAME
          ? gatewayToolMeta(tool.name, tool._meta)
          : null;
      if (name === GATEWAY_SERVER_NAME && meta == null) continue;
      const qualified = qualify(name, tool, isAppServer(name, config));

      result.routes.set(qualified, { client, toolName: tool.name });
      const alternate =
        qualified === tool.name ? `${name}_${tool.name}` : tool.name;
      // A server the user added never answers to a built-in tool's bare name
      // (`read`, `todo`): that call is the app's own tool's.
      const shadows =
        alternate === tool.name &&
        (Object.hasOwn(UNATTENDED_TOOLS, alternate) ||
          Object.hasOwn(UNATTENDED_EXCLUDED_TOOLS, alternate));
      if (!shadows && !result.routes.has(alternate))
        result.routes.set(alternate, { client, toolName: tool.name });
      if (meta != null) {
        registeredToolMeta.set(qualified, meta);
        registeredToolMeta.set(alternate, meta);
      }

      // A host's internal tool is routed but never offered to a model.
      if (advertise && !HOST_INTERNAL_TOOLS.has(tool.name))
        result.tools.push({
          name: qualified,
          description: tool.description ?? `${tool.name} (via ${name})`,
          schema: tool.inputSchema ?? { type: "object", properties: {} },
        });
    }
  };

  const connectWithRetries = async (
    name: string,
    config: McpServerConfig
  ): ReturnType<typeof connectOne> => {
    let outcome = await connectOne(name, config);
    for (const delay of STARTUP_RETRY_DELAYS_MS) {
      if (outcome.transient !== true) break;
      await sleep(delay);
      outcome = await connectOne(name, config);
    }

    return outcome;
  };

  const stillDown: Array<[string, McpServerConfig, "network" | "key"]> = [];
  await Promise.all(
    Object.entries(servers).map(async ([name, config]) => {
      const outcome = await connectWithRetries(name, config);
      result.statuses.push(outcome.status);
      if (outcome.client != null) register(name, config, outcome.client, true);
      else if (outcome.transient === true)
        stillDown.push([name, config, "network"]);
      else if (outcome.keyRefused === true)
        stillDown.push([name, config, "key"]);
    })
  );

  // Two tool calls that 401 together share one reconnect.
  const inFlight = new Map<string, Promise<McpClient | null>>();
  result.reconnect = (name: string): Promise<McpClient | null> => {
    const config = servers[name];
    if (config == null || config.disabled === true)
      return Promise.resolve(null);

    const pending = inFlight.get(name);
    if (pending != null) return pending;

    const attempt = (async (): Promise<McpClient | null> => {
      const outcome = await connectOne(name, config, { forceRefresh: true });

      const previous = result.clients.find((client) => client.name === name);
      if (previous != null) {
        result.clients = result.clients.filter((client) => client !== previous);
        for (const [key, route] of result.routes)
          if (route.client === previous) result.routes.delete(key);
        try {
          previous.close();
        } catch {
          /* already gone */
        }
      }

      const index = result.statuses.findIndex((status) => status.id === name);
      if (index >= 0) result.statuses[index] = outcome.status;
      else result.statuses.push(outcome.status);

      if (outcome.client != null) register(name, config, outcome.client, false);
      result.onStatusChange?.();

      return outcome.client;
    })().finally(() => inFlight.delete(name));

    inFlight.set(name, attempt);

    return attempt;
  };

  let retired = false;
  result.retire = (): void => {
    retired = true;
  };

  // A server the network kept down keeps trying; one whose new key was
  // refused tries a few times over the first minute. Its tools are advertised
  // when it comes up, since the session never had them.
  const recover = async (
    name: string,
    config: McpServerConfig,
    why: "network" | "key"
  ): Promise<void> => {
    for (let attempt = 0; ; attempt++) {
      const delay =
        why === "key"
          ? KEY_REFUSED_RETRY_DELAYS_MS[attempt]
          : (RECOVERY_DELAYS_MS[attempt] ?? RECOVERY_REPEAT_MS);
      if (delay == null) return;
      await sleep(delay, { unref: true });
      if (retired) return;

      const outcome = await connectOne(name, config);

      if (retired) {
        outcome.client?.close();
        return;
      }
      if (
        outcome.client == null &&
        (outcome.transient === true ||
          (why === "key" && outcome.keyRefused === true))
      )
        continue;

      const index = result.statuses.findIndex((status) => status.id === name);
      if (index >= 0) result.statuses[index] = outcome.status;
      if (outcome.client != null) {
        register(name, config, outcome.client, true);
        result.onToolsAdded?.();
      }
      result.onStatusChange?.();

      return;
    }
  };
  for (const [name, config, why] of stillDown) void recover(name, config, why);

  return result;
}
