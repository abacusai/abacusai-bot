/**
 * User-facing MCP server administration: the CRUD behind the management UI,
 * config import from other agents, and telling live sessions to reload.
 */
import fs from "fs";
import os from "os";
import path from "path";

import type { DesktopCommand } from "#shared/agent-types";
import type {
  AddMcpServerRequest,
  ImportMcpServersRequest,
  ImportMcpServersResult,
  ListMcpServersRequest,
  McpMode,
  McpRuntimeRequestResult,
  McpServerEntry,
  McpServerInfo,
  RefreshMcpServersRequest,
  RemoveMcpServerRequest,
  RestartMcpServerRequest,
  SetMcpServerDisabledRequest,
  UpdateMcpServerRequest,
} from "#shared/contracts";

import { abacusBotHome } from "../../paths";
import { credentialFor } from "../config/settings";
import { abacusRoutellmV1 } from "../providers/abacus-host";
import { environmentNoticeService } from "../providers/environment-notice-service";
import { BUILTIN_BROWSER_NAME, McpConfigService } from "./mcp-config-service";

type McpAdminDeps = {
  mcpConfigService: McpConfigService;
  /**
   * Rewrite the runtime MCP file. Each spawn's ABACUSAI_BOT_MCP_CONFIG points
   * at its own mcp-<mode>-<sessionId>.json, so a rewrite meant to reach a
   * running session must carry its id; the session-less file only serves
   * future spawns.
   */
  rewriteRuntimeConfig: (mode: McpMode, sessionId?: string) => Promise<string>;
  listLiveSessions: () => Array<{ workspaceId: string; sessionId: string }>;
  sendCommand: (
    workspaceId: string,
    sessionId: string,
    command: DesktopCommand
  ) => boolean;
  broadcastCommand: (command: DesktopCommand) => number;
  /** The browser toggle lives in state.json, not in any mcp file. */
  setBuiltinBrowserEnabled: (enabled: boolean) => Promise<unknown>;
};

export class McpAdminService {
  constructor(private readonly deps: McpAdminDeps) {}

  /** User-managed entries only; the built-in browser has its own panel. */
  listMcpServers(request: ListMcpServersRequest): McpServerInfo[] {
    return this.deps.mcpConfigService.listUserServers(request.mode);
  }

  addMcpServer(request: AddMcpServerRequest): {
    success: boolean;
    error?: string;
  } {
    const result = wrapMcpResult(() => {
      const existing = this.deps.mcpConfigService.readUserMcp(request.mode)
        .mcpServers[request.name];
      if (existing != null)
        return {
          success: false,
          error: "A server with this name already exists.",
        };
      this.deps.mcpConfigService.addUserServer(
        request.mode,
        request.name,
        request.config
      );
      return { success: true };
    });
    if (result.success) void this.notifyMcpRuntimeOfChange(request.mode);
    return result;
  }

  /**
   * Add a server the app owns, or restore it if the name is taken: the file
   * is user-editable, so the entry may not be the one the app wrote. Its url
   * and headers are overwritten; anything else (a disabled flag) is kept.
   */
  ensureMcpServer(request: AddMcpServerRequest): {
    success: boolean;
    error?: string;
  } {
    const added = this.addMcpServer(request);
    if (added.success) return added;

    return this.updateMcpServer({
      mode: request.mode,
      name: request.name,
      config: request.config,
    });
  }

  updateMcpServer(request: UpdateMcpServerRequest): {
    success: boolean;
    error?: string;
  } {
    const result = wrapMcpResult(() => {
      const updated = this.deps.mcpConfigService.updateUserServer(
        request.mode,
        request.name,
        request.config
      );
      return updated
        ? { success: true }
        : { success: false, error: "Server not found." };
    });
    if (result.success) void this.notifyMcpRuntimeOfChange(request.mode);
    return result;
  }

  removeMcpServer(request: RemoveMcpServerRequest): {
    success: boolean;
    error?: string;
  } {
    if (request.name === BUILTIN_BROWSER_NAME) {
      return {
        success: false,
        error:
          "Cannot remove the built-in browser MCP server. Disable it instead.",
      };
    }
    const result = wrapMcpResult(() => {
      const removed = this.deps.mcpConfigService.removeUserServer(
        request.mode,
        request.name
      );
      return removed
        ? { success: true }
        : { success: false, error: "Server not found." };
    });
    if (result.success) void this.notifyMcpRuntimeOfChange(request.mode);
    return result;
  }

  setMcpServerDisabled(request: SetMcpServerDisabledRequest): {
    success: boolean;
    error?: string;
  } {
    const result = wrapMcpResult(() => {
      if (request.name === BUILTIN_BROWSER_NAME) {
        void this.deps.setBuiltinBrowserEnabled(!request.disabled);
        return { success: true };
      }
      const updated = this.deps.mcpConfigService.setUserServerDisabled(
        request.mode,
        request.name,
        request.disabled
      );
      return updated
        ? { success: true }
        : { success: false, error: "Server not found." };
    });
    if (result.success && request.name !== BUILTIN_BROWSER_NAME) {
      void this.notifyMcpRuntimeOfChange(request.mode);
    }
    return result;
  }

  /** After a disk-level change: rewrite the runtime files, tell sessions. */
  private async notifyMcpRuntimeOfChange(mode: McpMode): Promise<void> {
    if (mode !== "code") return;
    try {
      // Each live session watches its own file, and a reload against a stale
      // one is a no-op, so every file is rewritten before the broadcast.
      await this.deps.rewriteRuntimeConfig(mode);
      for (const session of this.deps.listLiveSessions()) {
        await this.deps.rewriteRuntimeConfig(mode, session.sessionId);
      }
    } catch (err) {
      console.error("[mcp] failed to rewrite runtime config:", err);
    }
    this.deps.broadcastCommand({ type: "mcp_refresh" });
    // The CLI does not always re-emit a snapshot for newly-added entries.
    this.deps.broadcastCommand({ type: "mcp_list_servers" });
  }

  async importMcpServers(
    request: ImportMcpServersRequest
  ): Promise<ImportMcpServersResult> {
    try {
      let json: string | null = null;
      if (request.source === "deepagent") {
        // Not a file on disk: fetched from the platform, with secret values
        // reduced to presence flags. The desktop runs these servers itself.
        const incoming = await fetchDeepagentMcpServers();
        if (incoming == null) {
          return {
            success: false,
            error:
              "Could not fetch your DeepAgent MCP servers. Sign in to Abacus.AI first.",
          };
        }
        delete incoming[BUILTIN_BROWSER_NAME];
        if (Object.keys(incoming).length === 0) {
          return {
            success: false,
            error: "Your DeepAgent account has no importable MCP servers.",
          };
        }
        const { imported, skipped } =
          this.deps.mcpConfigService.mergeUserServers(request.mode, incoming);
        if (imported.length > 0)
          void this.notifyMcpRuntimeOfChange(request.mode);
        return { success: true, imported: imported.length, skipped };
      }
      if (request.source === "json") {
        if (request.json == null || request.json.trim() === "") {
          return { success: false, error: "No JSON content was provided." };
        }
        json = request.json;
      } else if (request.source === "file") {
        const { dialog } = await import("electron");
        const result = await dialog.showOpenDialog({
          title: "Import MCP servers",
          properties: ["openFile"],
          filters: [{ name: "JSON", extensions: ["json"] }],
        });
        if (result.canceled || result.filePaths.length === 0) {
          return { success: false };
        }
        json = readImportFile(result.filePaths[0]);
      } else {
        const sourcePath = this.resolveImportSourcePath(request.source);
        if (sourcePath == null) {
          return {
            success: false,
            error: "This import source is not supported.",
          };
        }
        json = readImportFile(sourcePath);
      }
      const parsed = McpConfigService.parseForeignMcpJson(json);
      if (parsed.kind === "invalid") {
        return {
          success: false,
          error:
            "The configuration is not valid or does not contain any MCP server entries.",
        };
      }
      if (parsed.kind === "single") {
        return { success: true, singleEntry: parsed.entry };
      }
      // Strip the built-in browser name: a shared mcp.json can carry a stale
      // self-registered entry.
      const incoming = { ...parsed.servers };
      delete incoming[BUILTIN_BROWSER_NAME];
      if (Object.keys(incoming).length === 0) {
        return {
          success: false,
          error: "No importable MCP servers were found in the configuration.",
        };
      }
      const { imported, skipped } = this.deps.mcpConfigService.mergeUserServers(
        request.mode,
        incoming
      );
      if (imported.length > 0) void this.notifyMcpRuntimeOfChange(request.mode);
      return { success: true, imported: imported.length, skipped };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private resolveImportSourcePath(
    source: "cursor" | "claude" | "abacusai-bot"
  ): string | null {
    const home = os.homedir();
    switch (source) {
      case "cursor":
        return path.join(home, ".cursor", "mcp.json");
      case "claude":
        return path.join(home, ".claude.json");
      case "abacusai-bot":
        return path.join(abacusBotHome(), "mcp.json");
      default:
        return null;
    }
  }

  /** Manual refresh from the dialog, for one running session. */
  async refreshMcpServersForSession(
    request: RefreshMcpServersRequest
  ): Promise<McpRuntimeRequestResult> {
    // This session's own file, since that is the path its environment carries.
    try {
      await this.deps.rewriteRuntimeConfig("code", request.sessionId);
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
    const ok = this.deps.sendCommand(request.workspaceId, request.sessionId, {
      type: "mcp_refresh",
    });
    // The CLI's refresh does not always re-emit `mcp_servers` for new entries.
    if (ok) {
      this.deps.sendCommand(request.workspaceId, request.sessionId, {
        type: "mcp_list_servers",
      });
    }
    return ok
      ? { success: true }
      : { success: false, error: "CLI session is not running." };
  }

  /**
   * For reachability changes with no config change, which nothing on the
   * ordinary path would announce. Both halves matter: the note is words the
   * model reads; only the refresh re-runs `tools/list` and puts a withheld
   * tool back in front of it.
   */
  async notifyToolAvailabilityChanged(mode: McpMode): Promise<void> {
    environmentNoticeService.markChanged();
    await this.notifyMcpRuntimeOfChange(mode);
  }

  /** Signing in writes no config, so nothing else would reconnect the server. */
  async notifyMcpSignedIn(mode: McpMode): Promise<void> {
    await this.notifyToolAvailabilityChanged(mode);
  }

  restartMcpServerForSession(
    request: RestartMcpServerRequest
  ): McpRuntimeRequestResult {
    const ok = this.deps.sendCommand(request.workspaceId, request.sessionId, {
      type: "mcp_restart_server",
      serverId: request.serverId,
    });
    return ok
      ? { success: true }
      : { success: false, error: "CLI session is not running." };
  }
}

function wrapMcpResult(fn: () => { success: boolean; error?: string }): {
  success: boolean;
  error?: string;
} {
  try {
    return fn();
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * DeepAgent MCP server configs as installable entries, or null with no Abacus
 * credential. The endpoint reduces secret values to presence flags, so
 * headers are omitted and flagged env names arrive empty for the panel.
 */
const fetchDeepagentMcpServers = async (): Promise<Record<
  string,
  McpServerEntry
> | null> => {
  const key = credentialFor("ABACUS_API_KEY");
  if (key.length === 0) return null;

  const response = await fetch(
    `${abacusRoutellmV1()}/abacusaibot_mcp_configs`,
    {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(15_000),
    }
  );
  if (!response.ok)
    throw new Error(`The platform answered ${response.status}.`);

  const body = (await response.json()) as {
    servers?: Array<{
      name?: string;
      config?: {
        url?: string;
        command?: string;
        args?: string[];
        env?: Record<string, unknown>;
      };
    }>;
  };

  const entries: Record<string, McpServerEntry> = {};
  for (const server of body.servers ?? []) {
    const name = (server.name ?? "").trim();
    const config = server.config ?? {};
    if (name.length === 0) continue;
    if (typeof config.url === "string" && config.url.length > 0) {
      entries[name] = { url: config.url };
    } else if (
      typeof config.command === "string" &&
      config.command.length > 0
    ) {
      const env: Record<string, string> = {};
      for (const envName of Object.keys(config.env ?? {})) env[envName] = "";
      entries[name] = {
        command: config.command,
        ...(Array.isArray(config.args) ? { args: config.args } : {}),
        ...(Object.keys(env).length > 0 ? { env } : {}),
      };
    }
  }
  return entries;
};

/**
 * Capped at 50MB: ~/.claude.json can grow large. Throws on read failure; the
 * caller turns that into the user-facing error.
 */
const IMPORT_FILE_MAX_BYTES = 50 * 1024 * 1024;
function readImportFile(filePath: string): string {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch (err: unknown) {
    const code = (err as { code?: string }).code;
    if (code === "ENOENT") throw new Error("Configuration file not found.");
    throw err;
  }
  if (stat.size > IMPORT_FILE_MAX_BYTES) {
    throw new Error(
      `The file is too large to import (${Math.round(stat.size / 1024 / 1024)}MB — max 50MB).`
    );
  }
  return fs.readFileSync(filePath, "utf-8");
}
