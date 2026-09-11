/**
 * Lifecycle for the built-in MCP servers (browser, device, agent-tools).
 * Writing the runtime MCP config is also what starts the servers, so the
 * agent only ever sees ports that are listening.
 */
import type {
  BrowserApproval,
  IpcEvent,
  McpBrowserStatus,
  McpMode,
} from "#shared/contracts";

import type { BuiltinPermissionScope } from "./builtin-tool-permissions";
import type { McpAgentToolsServer } from "./mcp-agent-tools-server";
import type { McpBrowserServer } from "./mcp-browser-server";
import {
  BUILTIN_AGENT_TOOLS_NAME,
  BUILTIN_BROWSER_NAME,
  BUILTIN_DEVICE_NAME,
  type McpConfigService,
} from "./mcp-config-service";
import type { McpDeviceServer } from "./mcp-device-server";

type BuiltinMcpLifecycleDeps = {
  mcpConfigService: McpConfigService;
  browserServer: McpBrowserServer;
  deviceServer: McpDeviceServer;
  agentToolsServer: McpAgentToolsServer;
  emitEvent: (event: IpcEvent) => void;
  flushPermissions: (
    decision: "allow" | "deny",
    server: BuiltinPermissionScope
  ) => void;
};

export class BuiltinMcpLifecycle {
  private browserEnabled: boolean;

  constructor(private readonly deps: BuiltinMcpLifecycleDeps) {
    this.browserEnabled = !deps.mcpConfigService.isBuiltinBrowserDisabled();
  }

  isBrowserEnabled(): boolean {
    return this.browserEnabled;
  }

  getBrowserStatus(): McpBrowserStatus {
    return {
      running: this.deps.browserServer.isRunning(),
      port: this.deps.browserServer.getPort(),
      enabled: this.browserEnabled,
      approval:
        this.deps.mcpConfigService.readState().builtinBrowserApproval ??
        "always",
    };
  }

  async setBrowserEnabled(enabled: boolean): Promise<McpBrowserStatus> {
    this.browserEnabled = enabled;
    this.deps.mcpConfigService.setBuiltinBrowserDisabled(!enabled);
    if (enabled) {
      await this.startBrowserServer();
    } else {
      this.stopBrowserServer();
      // Deny in-flight prompts so awaiting executeTool calls do not hang.
      this.deps.flushPermissions("deny", "browser");
    }
    const status = this.getBrowserStatus();
    this.deps.emitEvent({
      type: "browser-status-updated",
      status,
      emittedAt: new Date().toISOString(),
    });
    return status;
  }

  async setBrowserApproval(
    approval: BrowserApproval
  ): Promise<McpBrowserStatus> {
    const state = this.deps.mcpConfigService.readState();
    state.builtinBrowserApproval = approval;
    this.deps.mcpConfigService.writeState(state);
    // Flipping to 'always' immediately resolves any pending prompts as allow.
    if (approval === "always") this.deps.flushPermissions("allow", "browser");
    const status = this.getBrowserStatus();
    this.deps.emitEvent({
      type: "browser-status-updated",
      status,
      emittedAt: new Date().toISOString(),
    });
    return status;
  }

  async getRuntimeMcpPathForSpawn(
    mode: McpMode,
    sessionId?: string
  ): Promise<string> {
    // Tagged with the session so a permission prompt can look up its mode.
    const tag = (url: string): string =>
      sessionId != null && sessionId !== ""
        ? `${url}?session=${encodeURIComponent(sessionId)}`
        : url;
    const builtins: Record<string, { url: string }> = {};
    if (mode === "code" && this.browserEnabled) {
      await this.startBrowserServer();
      const port = this.deps.browserServer.getPort();
      if (port != null) {
        builtins[BUILTIN_BROWSER_NAME] = {
          url: tag(`http://localhost:${port}/mcp`),
        };
      }
    }
    if (
      mode === "code" &&
      !this.deps.mcpConfigService.isBuiltinDevicesDisabled() &&
      this.deps.deviceServer.isToolchainAvailable()
    ) {
      try {
        if (!this.deps.deviceServer.isRunning())
          await this.deps.deviceServer.start();
        const port = this.deps.deviceServer.getPort();
        if (port != null) {
          builtins[BUILTIN_DEVICE_NAME] = {
            url: tag(`http://localhost:${port}/mcp`),
          };
        }
      } catch (err) {
        console.error("[mcp-device] failed to start server:", err);
      }
    }
    if (mode === "code" && this.deps.agentToolsServer.hasEnabledTools()) {
      try {
        if (!this.deps.agentToolsServer.isRunning())
          await this.deps.agentToolsServer.start();
        const port = this.deps.agentToolsServer.getPort();
        if (port != null) {
          builtins[BUILTIN_AGENT_TOOLS_NAME] = {
            url: tag(`http://localhost:${port}/mcp`),
          };
        }
      } catch (err) {
        console.error("[mcp-agent-tools] failed to start server:", err);
      }
    }
    return this.deps.mcpConfigService.writeRuntimeMcp(
      mode,
      builtins,
      sessionId
    );
  }

  getRuntimeAgentConfigPathForSpawn(mode: McpMode): string | null {
    return this.deps.mcpConfigService.writeRuntimeAgentConfig(mode);
  }

  async startBrowserServer(): Promise<void> {
    if (!this.browserEnabled || this.deps.browserServer.isRunning()) return;
    try {
      await this.deps.browserServer.start();
    } catch (err) {
      console.error("[mcp-browser] failed to start server:", err);
    }
  }

  stopBrowserServer(): void {
    this.deps.browserServer.stop();
  }
}
