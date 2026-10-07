/**
 * The one owner of which MCP tools the model sees, for both engines (the
 * desktop session and the bot loop).
 *
 * pi fixes a run's tool list when the run starts, and cannot unregister a
 * tool. So the tools are brought to what the servers list now only between
 * runs: new ones registered, and one its server no longer lists (a connector
 * disconnected or revoked) deactivated, or activated again if it returns. A
 * change that lands while a turn runs (a refresh main gave up waiting on, a
 * server recovering late) is never applied under it: it waits for the next
 * turn start, or, when it adds tools, for one continuation the engine runs
 * at the turn's end, so the user's request is finished with them.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { ConnectedMcp } from "./index.js";
import { buildMcpToolDefinitions, syncActiveMcpTools } from "./tools.js";

interface McpToolSyncDeps {
  pi: () => ExtensionAPI | undefined;
  /** pi's session: which registered tools are active. */
  session: () =>
    | {
        getActiveToolNames(): string[];
        setActiveToolsByName(toolNames: string[]): void;
      }
    | undefined;
  mcp: () => ConnectedMcp;
  /** Whether this engine takes a tool at all (browser tools, overrides). */
  accepts: (tool: { name: string }) => boolean;
  turnRunning: () => boolean;
}

export class McpToolSync {
  /** MCP tools registered with pi, at start or since. */
  readonly registered = new Set<string>();
  /** The servers changed while a turn ran; not applied yet. */
  private stale = false;

  constructor(private readonly deps: McpToolSyncDeps) {}

  /** The servers changed (a refresh, a server up late): applied now, or deferred. */
  changed(): void {
    if (this.deps.turnRunning()) {
      this.stale = true;
      return;
    }
    this.apply();
  }

  /** At a turn's start: a change deferred while the last one ran applies now. */
  atTurnStart(): void {
    if (!this.stale) return;
    this.stale = false;
    this.apply();
  }

  /**
   * At a turn's end: the tools a deferred change would add, which warrant a
   * continuation; none when nothing is deferred or it only removes.
   */
  pendingArrivals(): string[] {
    if (!this.stale) return [];
    return buildMcpToolDefinitions(this.deps.mcp)
      .filter((tool) => this.deps.accepts(tool))
      .map((tool) => tool.name)
      .filter((name) => !this.registered.has(name));
  }

  /** Between two runs of one turn (its continuation): the deferred change applies. */
  applyDeferred(): void {
    this.stale = false;
    this.apply();
  }

  private apply(): void {
    const pi = this.deps.pi();
    if (pi == null) return;
    const listed = buildMcpToolDefinitions(this.deps.mcp);
    for (const tool of listed) {
      if (this.registered.has(tool.name) || !this.deps.accepts(tool)) continue;
      this.registered.add(tool.name);
      try {
        pi.registerTool(tool as never);
      } catch {
        // One server's bad schema must not break the refresh for the rest.
        this.registered.delete(tool.name);
      }
    }
    const session = this.deps.session();
    if (session != null)
      syncActiveMcpTools(
        session,
        this.registered,
        new Set(listed.map((tool) => tool.name))
      );
  }
}
