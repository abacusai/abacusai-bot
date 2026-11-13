/**
 * The approval gate for the built-in browser and device MCP servers: per-tool
 * prompts, "this run only" grants, and the pending-prompt bookkeeping that
 * lets a settings flip resolve everything still waiting.
 */
import { AgentMode } from "@abacus-ai/contract/agent-types";
import type {
  BrowserPermissionRequest,
  IpcEvent,
  RespondBrowserPermissionRequest,
} from "@abacus-ai/contract/contracts";
import type { ConversationKey } from "@abacus-ai/contract/conversation-scope";

import type { SiteDecision } from "../browser/connected-sites";
import type { McpConfigService } from "./mcp-config-service";

/** How long a site ask waits for an answer in the app before it counts as a no. */
const SITE_ASK_TIMEOUT_MS = 5 * 60_000;

export type BuiltinPermissionScope = "browser" | "device";

type BuiltinToolPermissionsDeps = {
  mcpConfigService: McpConfigService;
  emitEvent: (event: IpcEvent) => void;
  getSessionMode: (sessionId: string) => AgentMode | null;
  /** A run nobody is watching: nothing is asked, and the servers hold it themselves. */
  isUnattended?: (sessionId: string) => boolean;
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
      /** A site ask: answered with the user's exact choice, never by a settings flip. */
      site?: (decision: SiteDecision) => void;
    }
  >();

  constructor(private readonly deps: BuiltinToolPermissionsDeps) {}

  /** For a pane that just mounted. */
  listPending(conversationKey?: ConversationKey): BrowserPermissionRequest[] {
    // No key: every conversation's (a subscriber that watches them all).
    return [...this.pendingBrowserPermissions.values()]
      .filter(
        (entry) =>
          conversationKey == null ||
          entry.request.conversationKey === conversationKey
      )
      .map((entry) => entry.request);
  }

  async respond(request: RespondBrowserPermissionRequest): Promise<void> {
    const pending = this.pendingBrowserPermissions.get(request.requestId);
    if (pending == null) return;
    // Only the conversation the prompt was put in may answer it.
    if (pending.request.conversationKey !== request.conversationKey) return;
    this.pendingBrowserPermissions.delete(request.requestId);
    if (pending.site != null) {
      pending.site(request.decision);
      this.cleared(request.requestId);
      return;
    }
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
      // Nobody to ask. The browser server holds such a run to its one page;
      // a device is never driven by one.
      if (this.deps.isUnattended?.(sessionId) === true)
        return server === "browser" ? "allow" : "deny";
      const mode = this.deps.getSessionMode(sessionId);
      if (mode === AgentMode.Yolo || mode === AgentMode.Auto) return "allow";
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

  /**
   * "May this chat use your sign-in on <site>?" (a connected site whose rule
   * is ask first). Asked even when browsing never asks and in a mode where
   * nothing asks: the per-site rule is the user's. Nobody to ask (a routine, a chat-app turn the user does not
   * answer in the app within `timeoutMs`) is a no.
   */
  async askSite(
    site: string,
    summary: string,
    sessionId: string,
    timeoutMs = SITE_ASK_TIMEOUT_MS
  ): Promise<SiteDecision> {
    // Not even a mode where nothing asks answers it (bots run in one by
    // default): "ask first" is the user's rule for this site, not a tool prompt.
    if (this.deps.isUnattended?.(sessionId) === true) return "deny";
    const conversationKey = this.deps.conversationKeyForSession(sessionId);
    if (conversationKey == null) return "deny";
    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const request: BrowserPermissionRequest = {
      requestId,
      tool: "browser_site",
      summary,
      server: "browser",
      conversationKey,
      site,
    };
    return new Promise<SiteDecision>((resolve) => {
      const timer = setTimeout(() => {
        if (!this.pendingBrowserPermissions.delete(requestId)) return;
        this.cleared(requestId);
        resolve("deny");
      }, timeoutMs);
      const done = (decision: SiteDecision): void => {
        clearTimeout(timer);
        resolve(decision);
      };
      this.pendingBrowserPermissions.set(requestId, {
        resolve: (decision) => done(decision),
        server: "browser",
        request,
        site: done,
      });
      this.deps.emitEvent({
        type: "browser-permission-request",
        request,
        emittedAt: new Date().toISOString(),
      });
    });
  }

  private cleared(requestId: string): void {
    this.deps.emitEvent({
      type: "browser-permission-cleared",
      requestId,
      emittedAt: new Date().toISOString(),
    });
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
      // A site ask is the user's per-site rule: a browsing setting turned
      // to "never ask" does not answer it.
      if (pending.site != null && decision === "allow") continue;
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
