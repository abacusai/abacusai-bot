import crypto from "crypto";
import fs from "fs";
import path from "path";

import { writeFileAtomicSync } from "@abacus-ai/agent/atomic-file";

import type { McpMode, McpServerEntry, McpServerInfo } from "#shared/contracts";

import { abacusBotHome } from "../../paths";
import { environmentNoticeService } from "../providers/environment-notice-service";

export type { McpMode, McpServerEntry, McpServerInfo };

export type ParsedMcpJson =
  | { kind: "multi"; servers: Record<string, McpServerEntry> }
  | { kind: "single"; entry: McpServerEntry }
  | { kind: "invalid" };

export interface McpConfig {
  mcpServers: Record<string, McpServerEntry>;
}

type BrowserApproval = "ask" | "always";

export interface DesktopState {
  builtinBrowserDisabled?: boolean;
  /** Permission policy for the built-in browser MCP tools. Default 'ask'. */
  builtinBrowserApproval?: BrowserApproval;
  builtinDevicesDisabled?: boolean;
  /** Permission policy for the built-in device (simulator/emulator) MCP tools. Default 'ask'. */
  builtinDevicesApproval?: BrowserApproval;
}

/** Names that cannot be used as object keys without changing the object itself. */
const UNSAFE_SERVER_NAMES = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Drop header values carrying a `${...}` placeholder. Our config uses one to
 * pull a credential from the environment; in an imported entry it can only be
 * an attempt to send one of our secrets to the entry's URL.
 */
const withoutPlaceholderHeaders = (entry: McpServerEntry): McpServerEntry => {
  const headers = entry.headers;
  if (headers == null || typeof headers !== "object") return entry;

  const kept = Object.fromEntries(
    Object.entries(headers).filter(
      ([, value]) => !(typeof value === "string" && /\$\{[^}]*\}/.test(value))
    )
  );

  return Object.keys(kept).length === Object.keys(headers).length
    ? entry
    : { ...entry, headers: kept };
};

export const BUILTIN_BROWSER_NAME = "browser";
export const BUILTIN_DEVICE_NAME = "device";
export const BUILTIN_AGENT_TOOLS_NAME = "agent-tools";
const RESERVED_BUILTIN_NAMES = [
  BUILTIN_BROWSER_NAME,
  BUILTIN_DEVICE_NAME,
  BUILTIN_AGENT_TOOLS_NAME,
];

/**
 * Per-boot bearer tokens for the built-in local MCP servers. They listen on
 * loopback with no authentication of their own, so without this `tools/call`
 * is reachable by anything on the machine, a cross-origin POST included.
 * `buildRuntimeConfig` hands the token to the agent as an Authorization header.
 */
const builtinServerTokens = new Map<string, string>();

export const localMcpServerToken = (serverName: string): string => {
  let token = builtinServerTokens.get(serverName);
  if (token == null) {
    token = crypto.randomBytes(32).toString("hex");
    builtinServerTokens.set(serverName, token);
  }
  return token;
};

// All AbacusAIBot state lives under one folder.
export const DESKTOP_DIR = abacusBotHome();
const RUNTIME_DIR = path.join(DESKTOP_DIR, "runtime");
const STATE_PATH = path.join(DESKTOP_DIR, "state.json");

const userMcpPath = (mode: McpMode): string =>
  path.join(DESKTOP_DIR, `mcp-${mode}.json`);
const userAgentConfigPath = (mode: McpMode): string =>
  path.join(DESKTOP_DIR, `agent-config-${mode}.json`);
// Per-session when a session id is given, so two sessions starting at once
// cannot clobber each other's server URLs.
const runtimeMcpPath = (mode: McpMode, sessionId?: string): string =>
  path.join(
    RUNTIME_DIR,
    sessionId != null && sessionId !== ""
      ? `mcp-${mode}-${sessionId.replace(/[^\w.-]/g, "_")}.json`
      : `mcp-${mode}.json`
  );
const runtimeAgentConfigPath = (mode: McpMode): string =>
  path.join(RUNTIME_DIR, `agent-config-${mode}.json`);

/**
 * Write JSON that only this user can read. These files carry secrets: the
 * builtin servers' bearer tokens and whatever a connector needs (PATs, OAuth
 * secrets, keys in `env`). Connector start/stop rewrites every live session's
 * config with identical bytes, hence `skipIfUnchanged`.
 */
const writeJsonAtomic = (filePath: string, data: unknown): void => {
  writeFileAtomicSync(filePath, JSON.stringify(data, null, 2), {
    restrict: true,
    skipIfUnchanged: true,
  });
};

const readJson = <T>(filePath: string, fallback: T): T => {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    return parsed as T;
  } catch {
    return fallback;
  }
};

export class McpConfigService {
  readUserMcp(mode: McpMode): McpConfig {
    const parsed = readJson<McpConfig | null>(userMcpPath(mode), null);
    if (parsed?.mcpServers != null && typeof parsed.mcpServers === "object") {
      return parsed;
    }
    return { mcpServers: {} };
  }

  writeUserMcp(mode: McpMode, config: McpConfig): void {
    writeJsonAtomic(userMcpPath(mode), config);
    // Every add, edit, removal, import and toggle lands here, so this is what
    // tells a conversation in progress that its MCP servers changed.
    environmentNoticeService.markChanged();
  }

  /** Returns null when no agent-config file exists or it's not a JSON object. */
  readUserAgentConfig(mode: McpMode): Record<string, unknown> | null {
    const parsed = readJson<Record<string, unknown> | null>(
      userAgentConfigPath(mode),
      null
    );
    return parsed != null && typeof parsed === "object" ? parsed : null;
  }

  writeUserAgentConfig(mode: McpMode, config: Record<string, unknown>): void {
    writeJsonAtomic(userAgentConfigPath(mode), config);
  }

  hasUserAgentConfig(mode: McpMode): boolean {
    return fs.existsSync(userAgentConfigPath(mode));
  }

  readState(): DesktopState {
    return readJson<DesktopState>(STATE_PATH, {});
  }

  writeState(state: DesktopState): void {
    writeJsonAtomic(STATE_PATH, state);
  }

  isBuiltinBrowserDisabled(): boolean {
    return this.readState().builtinBrowserDisabled === true;
  }

  setBuiltinBrowserDisabled(disabled: boolean): void {
    const state = this.readState();
    state.builtinBrowserDisabled = disabled;
    this.writeState(state);
  }

  isBuiltinDevicesDisabled(): boolean {
    return this.readState().builtinDevicesDisabled === true;
  }

  listUserServers(mode: McpMode): McpServerInfo[] {
    const config = this.readUserMcp(mode);
    return Object.entries(config.mcpServers).map(([name, entry]) => ({
      id: name,
      name,
      config: entry,
      isBuiltin: false,
    }));
  }

  addUserServer(mode: McpMode, name: string, entry: McpServerEntry): void {
    if (RESERVED_BUILTIN_NAMES.includes(name)) {
      throw new Error(
        `Cannot add a user server with the reserved name "${name}"`
      );
    }
    const config = this.readUserMcp(mode);
    config.mcpServers[name] = entry;
    this.writeUserMcp(mode, config);
  }

  removeUserServer(mode: McpMode, name: string): boolean {
    const config = this.readUserMcp(mode);
    if (!(name in config.mcpServers)) return false;
    delete config.mcpServers[name];
    this.writeUserMcp(mode, config);
    return true;
  }

  updateUserServer(
    mode: McpMode,
    name: string,
    entry: Partial<McpServerEntry>
  ): boolean {
    const config = this.readUserMcp(mode);
    if (!(name in config.mcpServers)) return false;
    config.mcpServers[name] = { ...config.mcpServers[name], ...entry };
    this.writeUserMcp(mode, config);
    return true;
  }

  setUserServerDisabled(
    mode: McpMode,
    name: string,
    disabled: boolean
  ): boolean {
    const config = this.readUserMcp(mode);
    if (!(name in config.mcpServers)) return false;
    if (disabled) {
      config.mcpServers[name].disabled = true;
    } else {
      delete config.mcpServers[name].disabled;
    }
    this.writeUserMcp(mode, config);
    return true;
  }

  /** Merges a foreign mcpServers object into the user file; first-seen wins. */
  mergeUserServers(
    mode: McpMode,
    incoming: Record<string, McpServerEntry>
  ): { imported: string[]; skipped: string[] } {
    const current = this.readUserMcp(mode);
    const imported: string[] = [];
    const skipped: string[] = [];
    for (const [name, entry] of Object.entries(incoming)) {
      if (name === "" || entry == null) continue;
      if (
        RESERVED_BUILTIN_NAMES.includes(name) ||
        current.mcpServers[name] != null
      ) {
        skipped.push(name);
        continue;
      }
      current.mcpServers[name] = entry;
      imported.push(name);
    }
    if (imported.length > 0) this.writeUserMcp(mode, current);
    return { imported, skipped };
  }

  /**
   * Parses a foreign MCP JSON string: `multi` under a wrapper key
   * (`mcpServers`, `mcp`, `servers`), `single` for a bare entry with
   * `command` or `url`, `invalid` otherwise.
   */
  static parseForeignMcpJson(json: string): ParsedMcpJson {
    try {
      const parsed = JSON.parse(json) as unknown;
      if (
        parsed == null ||
        typeof parsed !== "object" ||
        Array.isArray(parsed)
      ) {
        return { kind: "invalid" };
      }
      const obj = parsed as Record<string, unknown>;

      // Try recognised multi-server wrapper keys in priority order
      for (const key of ["mcpServers", "mcp", "servers"]) {
        const candidate = obj[key];
        if (
          candidate != null &&
          typeof candidate === "object" &&
          !Array.isArray(candidate)
        ) {
          const raw = candidate as Record<string, unknown>;
          const servers: Record<string, McpServerEntry> = {};
          for (const [name, entry] of Object.entries(raw)) {
            // Assigning `__proto__` replaces the prototype instead of adding
            // a key; imported config is untrusted and none of these is a
            // plausible server name.
            if (UNSAFE_SERVER_NAMES.has(name)) continue;
            if (
              name !== "" &&
              entry != null &&
              typeof entry === "object" &&
              !Array.isArray(entry)
            ) {
              servers[name] = withoutPlaceholderHeaders(
                entry as McpServerEntry
              );
            }
          }
          if (Object.keys(servers).length > 0) {
            return { kind: "multi", servers };
          }
        }
      }

      // Single-server: bare entry with a command (STDIO) or url (HTTP)
      if (typeof obj.command === "string" || typeof obj.url === "string") {
        return {
          kind: "single",
          entry: withoutPlaceholderHeaders(obj as McpServerEntry),
        };
      }

      return { kind: "invalid" };
    } catch {
      return { kind: "invalid" };
    }
  }

  /** Path of the runtime mcp file (ABACUSAI_BOT_ADDITIONAL_MCP_CONFIG). */
  writeRuntimeMcp(
    mode: McpMode,
    builtins: Record<string, McpServerEntry> = {},
    sessionId?: string
  ): string {
    const merged = this.buildRuntimeConfig(mode, builtins);
    const filePath = runtimeMcpPath(mode, sessionId);
    writeJsonAtomic(filePath, merged);
    return filePath;
  }

  /** Path of the runtime agent-config file (ABACUSAI_BOT_ADDITIONAL_CONFIG), or null when none. */
  writeRuntimeAgentConfig(mode: McpMode): string | null {
    const cfg = this.readUserAgentConfig(mode);
    if (cfg == null) return null;
    const filePath = runtimeAgentConfigPath(mode);
    writeJsonAtomic(filePath, cfg);
    return filePath;
  }

  /** Merges user entries with `builtins` in the agent's MCP config shape. */
  private buildRuntimeConfig(
    mode: McpMode,
    builtins: Record<string, McpServerEntry>
  ): McpConfig {
    const user = this.readUserMcp(mode);
    const markedBuiltins: Record<string, McpServerEntry> = {};
    for (const [name, entry] of Object.entries(builtins)) {
      markedBuiltins[name] = {
        ...entry,
        isBuiltin: true,
        // The per-boot token the builtin server requires on /mcp. Setting
        // Authorization also stops the agent's OAuth lookup for these URLs.
        headers: {
          ...entry.headers,
          Authorization: `Bearer ${localMcpServerToken(name)}`,
        },
      };
    }
    // Reserved names cannot be overridden by user entries: a user server named
    // "browser" would otherwise silently replace the builtin in the spread.
    const userServers: Record<string, McpServerEntry> = {};
    for (const [name, entry] of Object.entries(user.mcpServers)) {
      if (RESERVED_BUILTIN_NAMES.includes(name)) continue;
      userServers[name] = entry;
    }
    return { mcpServers: { ...userServers, ...markedBuiltins } };
  }
}
