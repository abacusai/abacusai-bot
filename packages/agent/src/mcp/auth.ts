/**
 * MCP OAuth tokens, headless half. The desktop runs the interactive sign-in
 * and writes `~/.abacusai-bot/mcp-auth.json`; this module attaches the stored
 * token at connect time and refreshes it when expired. A failed refresh is not
 * handled here: the connect 401s and the server is reported as needing sign-in.
 * The file format is shared with the desktop (mcp-oauth-service.ts) and must
 * stay in step; this package cannot import from the app's source tree.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { writeFileAtomicSync } from "../atomic-file.js";
import { abacusBotDir } from "../config.js";

/** Refresh this long before nominal expiry, so a token never dies mid-request. */
const EXPIRY_SKEW_MS = 60_000;

const REFRESH_TIMEOUT_MS = 20_000;

export interface McpTokenRecord {
  tokenEndpoint: string;
  clientId: string;
  clientSecret?: string;
  accessToken: string;
  refreshToken?: string;
  /** ms since epoch. Absent means the server declared no expiry. */
  expiresAt?: number;
  scope?: string;
}

export interface McpAuthFile {
  /** Keyed by the MCP server URL — tokens belong to the resource, not the config name. */
  servers?: Record<string, McpTokenRecord>;
  /**
   * Dynamic-registration results keyed by issuer; the desktop reuses a client
   * only while `redirectUri` still matches. Never written here, only carried
   * through so a refresh cannot drop it.
   */
  clients?: Record<
    string,
    { clientId: string; clientSecret?: string; redirectUri?: string }
  >;
}

export function mcpAuthPath(): string {
  return path.join(abacusBotDir(), "mcp-auth.json");
}

export function readMcpAuth(): McpAuthFile {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(mcpAuthPath(), "utf8"));

    return parsed != null && typeof parsed === "object"
      ? (parsed as McpAuthFile)
      : {};
  } catch {
    return {};
  }
}

export function writeMcpAuth(file: McpAuthFile): void {
  // A truncated token file costs every stored sign-in, since `readMcpAuth`
  // cannot tell corrupt from absent. `restrict` because these are credentials:
  // the file is never world-readable, not even briefly.
  writeFileAtomicSync(mcpAuthPath(), `${JSON.stringify(file, null, 2)}\n`, {
    restrict: true,
  });
}

const isExpired = (record: McpTokenRecord): boolean =>
  record.expiresAt != null && Date.now() > record.expiresAt - EXPIRY_SKEW_MS;

/**
 * Exchange a refresh token for a fresh access token. Null means "sign in
 * again"; the stale record stays so the sign-in flow can still see the issuer.
 */
async function refresh(record: McpTokenRecord): Promise<McpTokenRecord | null> {
  if (record.refreshToken == null) return null;

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: record.refreshToken,
    client_id: record.clientId,
  });

  if (record.clientSecret != null)
    body.set("client_secret", record.clientSecret);

  try {
    const response = await fetch(record.tokenEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: body.toString(),
      signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
    });

    if (!response.ok) return null;

    const token = (await response.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      scope?: string;
    };

    if (
      typeof token.access_token !== "string" ||
      token.access_token.length === 0
    )
      return null;

    return {
      ...record,
      accessToken: token.access_token,
      // Providers may rotate the refresh token; a response without one means
      // the old one is still good.
      ...(typeof token.refresh_token === "string"
        ? { refreshToken: token.refresh_token }
        : {}),
      ...(typeof token.expires_in === "number"
        ? { expiresAt: Date.now() + token.expires_in * 1000 }
        : { expiresAt: undefined }),
      ...(typeof token.scope === "string" ? { scope: token.scope } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * The Authorization header for a server, or nothing. Every unhappy case (no
 * token, refresh refused, endpoint unreachable) returns nothing: the connect
 * goes out unauthenticated, 401s, and surfaces as a visible "sign in".
 */
export async function authHeadersForServer(
  url: string,
  // forceRefresh: the server just rejected the stored token, so its declared
  // expiry is not to be trusted.
  options: { forceRefresh?: boolean } = {}
): Promise<Record<string, string>> {
  const file = readMcpAuth();
  const record = file.servers?.[url];

  if (record == null) return {};

  if (!isExpired(record) && options.forceRefresh !== true) {
    return { Authorization: `Bearer ${record.accessToken}` };
  }

  const renewed = await refresh(record);

  if (renewed == null) return {};

  writeMcpAuth({
    ...file,
    servers: { ...file.servers, [url]: renewed },
  });

  return { Authorization: `Bearer ${renewed.accessToken}` };
}
