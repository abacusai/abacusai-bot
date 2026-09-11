/**
 * The approval gate for the built-in browser and device MCP servers: per-tool
 * prompts, "this run only" grants, and the pending-prompt bookkeeping that
 * lets a settings flip resolve everything still waiting.
 */
import { AgentMode } from "#shared/agent-types";
import type {
  BrowserPermissionRequest,
  IpcEvent,
  RespondBrowserPermissionRequest,
} from "#shared/contracts";
import type { ConversationKey } from "#shared/conversation-scope";

import type { McpConfigService } from "./mcp-config-service";

export type BuiltinPermissionScope = "browser" | "device";

type BuiltinToolPermissionsDeps = {
  mcpConfigService: McpConfigService;
  emitEvent: (event: IpcEvent) => void;
  getSessionMode: (sessionId: string) => AgentMode | null;
  setBrowserApprovalAlways: () => Promise<unknown>;
  /** Null for an unknown session; a prompt that cannot be placed is refused. */
  conversationKeyForSession: (sessionId: string) => ConversationKey | null;
};

export class BuiltinToolPermissions {
  /** This run only; deliberately never on disk. */
  private readonly sessionApprovedServers = new Set<BuiltinPermissionScope>();
  private readonly pendingBrowserPermissions = new Map<
    string,
    {
      resolve: (decision: "allow" | "deny") => void;
      server: BuiltinPermissionScope;
      request: BrowserPermissionRequest;
    }
  >();

  constructor(private readonly deps: BuiltinToolPermissionsDeps) {}

  /** For a pane that just mounted. */
  listPending(conversationKey: ConversationKey): BrowserPermissionRequest[] {
    return [...this.pendingBrowserPermissions.values()]
      .filter((entry) => entry.request.conversationKey === conversationKey)
      .map((entry) => entry.request);
  }

  async respond(request: RespondBrowserPermissionRequest): Promise<void> {
    const pending = this.pendingBrowserPermissions.get(request.requestId);
    if (pending == null) return;
    // Only the conversation the prompt was put in may answer it.
    if (pending.request.conversationKey !== request.conversationKey) return;
    this.pendingBrowserPermissions.delete(request.requestId);
    if (request.decision === "session") {
      this.approveForSession(pending.server);
      pending.resolve("allow");

      return;
    }
    if (request.decision === "always") {
      if (pending.server === "device") {
        const state = this.deps.mcpConfigService.readState();
        state.builtinDevicesApproval = "always";
        this.deps.mcpConfigService.writeState(state);
        this.flushPending("allow", "device");
      } else {
        await this.deps.setBrowserApprovalAlways();
      }
      pending.resolve("allow");
    } else {
      pending.resolve(request.decision);
    }
    this.deps.emitEvent({
      type: "browser-permission-cleared",
      requestId: request.requestId,
      emittedAt: new Date().toISOString(),
    });
  }

  async request(
    server: BuiltinPermissionScope,
    tool: string,
    summary: string,
    sessionId?: string
  ): Promise<"allow" | "deny"> {
    // Bypass means bypass: these servers prompt from the desktop process,
    // which must honour the mode the agent's own permission layer honours.
    if (sessionId != null) {
      const mode = this.deps.getSessionMode(sessionId);
      if (mode === AgentMode.Yolo) return "allow";
    }
    const state = this.deps.mcpConfigService.readState();
    // Browsing defaults to never-ask (a prompt per page is unusable; Browser
    // Settings can opt back in). Device control keeps 'ask': a phone tap is a
    // bigger deal than a page load.
    const approval =
      server === "device"
        ? (state.builtinDevicesApproval ?? "ask")
        : (state.builtinBrowserApproval ?? "always");
    if (approval === "always") return "allow";

    // This-run-only sits between a prompt per call and a permanent grant on
    // disk, and is forgotten when the app closes.
    if (this.sessionApprovedServers.has(server)) return "allow";
    // A prompt with no conversation to appear in is denied outright, and the
    // tool result says why.
    const conversationKey =
      sessionId == null ? null : this.deps.conversationKeyForSession(sessionId);
    if (conversationKey == null) return "deny";
    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const request: BrowserPermissionRequest = {
      requestId,
      tool,
      summary,
      server,
      conversationKey,
    };
    const decision = await new Promise<"allow" | "deny">((resolve) => {
      this.pendingBrowserPermissions.set(requestId, {
        resolve,
        server,
        request,
      });
      this.deps.emitEvent({
        type: "browser-permission-request",
        request,
        emittedAt: new Date().toISOString(),
      });
    });
    return decision;
  }

  /** For the rest of this app run. Never persisted. */
  approveForSession(server: BuiltinPermissionScope): void {
    this.sessionApprovedServers.add(server);
    this.flushPending("allow", server);
  }

  flushPending(
    decision: "allow" | "deny",
    server?: BuiltinPermissionScope
  ): void {
    for (const [requestId, pending] of this.pendingBrowserPermissions) {
      if (server != null && pending.server !== server) continue;
      pending.resolve(decision);
      this.pendingBrowserPermissions.delete(requestId);
      this.deps.emitEvent({
        type: "browser-permission-cleared",
        requestId,
        emittedAt: new Date().toISOString(),
      });
    }
  }
}
