/**
 * What the agent knows about a gateway tool: which connector it belongs to
 * and what a call costs. The registry is the source; a server that sends the
 * same facts in a tool's `_meta` overrides it, so pricing can move server-side
 * without a client release.
 */
import {
  GATEWAY_SERVER_NAME,
  platformConnectors,
  type PlatformConnector,
} from "./registry.js";

export interface ConnectorToolMeta {
  /** Registry id, e.g. "abacus-gmailuser". */
  connectorId: string;
  /** Platform service key, e.g. "gmailuser". */
  service: string;
  /** The tool's own name on the gateway, e.g. "Gmail_Tool". */
  tool: string;
  /** Credits one call costs the user. */
  credits: number;
}

const byTool = new Map<string, PlatformConnector>();
for (const connector of platformConnectors())
  for (const tool of connector.tools) byTool.set(tool, connector);

/** Shape of the `_meta` a server may attach to a tool in `tools/list`. */
interface ServerToolMeta {
  connector?: unknown;
  credits?: unknown;
}

/**
 * The metadata for a gateway tool, or null when the app does not take it —
 * which is what makes the registry an allowlist: a tool the platform serves
 * for an attached service still stays out of the model's hands unless some
 * entry names it.
 */
export const gatewayToolMeta = (
  toolName: string,
  serverMeta?: Record<string, unknown> | null
): ConnectorToolMeta | null => {
  const connector = byTool.get(toolName);
  if (connector == null) return null;
  const sent = (serverMeta ?? {}) as ServerToolMeta;
  const credits =
    typeof sent.credits === "number" && Number.isFinite(sent.credits)
      ? sent.credits
      : connector.credits;
  return {
    connectorId: connector.id,
    service: connector.service,
    tool: toolName,
    credits,
  };
};

/** The pi-side name of a gateway tool: the server's name, an underscore, the tool. */
export const gatewayToolName = (tool: string): string =>
  `${GATEWAY_SERVER_NAME}_${tool}`;

/**
 * Metadata by the pi-side name (`abacus-connectors_Gmail_Tool`), for code
 * that sees tool calls rather than server registrations. Null for anything
 * that is not a gateway tool the registry takes.
 */
export const connectorToolMetaByName = (
  piToolName: string
): ConnectorToolMeta | null => {
  const prefix = `${GATEWAY_SERVER_NAME}_`;
  if (!piToolName.startsWith(prefix)) return null;
  return gatewayToolMeta(piToolName.slice(prefix.length));
};
