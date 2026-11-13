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
 *
 * Past a budget, the largest servers the user added wait behind
 * `tool_search` (tool-search.ts): registered, but switched on only once the
 * model searches for them. That is the one change made under a running turn,
 * and it only adds tools the model asked for. Loaded tools stay loaded; a
 * resumed chat loads again the ones its history called, so it carries the
 * tool list it had before.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { type ConnectedMcp, toolOriginOf } from "./index.js";
import {
  buildToolSearchTool,
  deferredTools,
  type SearchableTool,
  TOOL_SEARCH_NAME,
  toolSearchDescription,
} from "./tool-search.js";
import { buildMcpToolDefinitions, syncActiveMcpTools } from "./tools.js";

interface McpToolSyncDeps {
  pi: () => ExtensionAPI | undefined;
  /** pi's session: which registered tools are active. */
  session: () =>
    | {
        getActiveToolNames(): string[];
        setActiveToolsByName(toolNames: string[]): void;
        /** The chat so far: deferred tools it already called load again. */
        readonly messages?: readonly unknown[];
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
  /** Tools that wait behind tool_search, as of the last apply. */
  private deferred: SearchableTool[] = [];
  /** Deferred tools the model loaded (or the chat had called); never unloaded. */
  private readonly loaded = new Set<string>();
  /** tool_search's description as registered, to re-register only on change. */
  private searchDescription: string | null = null;

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
    const listed = this.listed();
    const hidden = this.hiddenOf(listed);
    const arrived = listed
      .map((tool) => tool.name)
      .filter((name) => !this.registered.has(name));
    const visible = arrived.filter((name) => !hidden.has(name));
    // Deferred arrivals are named in tool_search's list, not as callable.
    return visible.length < arrived.length
      ? [...new Set([...visible, TOOL_SEARCH_NAME])]
      : visible;
  }

  /** Between two runs of one turn (its continuation): the deferred change applies. */
  applyDeferred(): void {
    this.stale = false;
    this.apply();
  }

  /**
   * A new pi session (at start, or a reset) has only the tools it was built
   * with: what was registered since and is missing there is registered
   * again, and what waits behind tool_search is taken off its list.
   */
  rebind(present: ReadonlySet<string>): void {
    for (const name of this.registered)
      if (!present.has(name)) this.registered.delete(name);
    this.stale = false;
    this.apply();
  }

  private apply(): void {
    const pi = this.deps.pi();
    if (pi == null) return;
    const all = buildMcpToolDefinitions(this.deps.mcp);
    for (const tool of all) {
      if (this.registered.has(tool.name) || !this.deps.accepts(tool)) continue;
      this.registered.add(tool.name);
      try {
        pi.registerTool(tool as never);
      } catch {
        // One server's bad schema must not break the refresh for the rest.
        this.registered.delete(tool.name);
      }
    }
    const listed = this.listed();
    const deferredNames = deferredTools(listed);
    this.deferred = listed.filter((tool) => deferredNames.has(tool.name));
    this.loadCalledBefore();
    this.registerSearch(pi);
    this.syncActive(all);
  }

  /** The tools this engine would offer now, with where each comes from. */
  private listed(): SearchableTool[] {
    const mcp = this.deps.mcp();
    return buildMcpToolDefinitions(this.deps.mcp)
      .filter((tool) => this.deps.accepts(tool))
      .flatMap((tool) => {
        const source = mcp.tools.find((entry) => entry.name === tool.name);
        if (source == null) return [];
        return [
          {
            name: tool.name,
            description: source.description,
            schema: source.schema,
            server: mcp.routes.get(tool.name)?.client.name ?? "",
            deferrable: toolOriginOf(mcp, tool.name) === "user",
          },
        ];
      });
  }

  /** Deferred and not loaded: registered, but not offered. */
  private hiddenOf(listed: readonly SearchableTool[]): Set<string> {
    const hidden = new Set<string>();
    for (const name of deferredTools(listed))
      if (!this.loaded.has(name)) hidden.add(name);
    return hidden;
  }

  /** A deferred tool the chat already called loads again (a resumed chat). */
  private loadCalledBefore(): void {
    if (this.deferred.length === 0) return;
    const names = new Set(this.deferred.map((tool) => tool.name));
    for (const message of this.deps.session()?.messages ?? []) {
      const { role, content } = message as {
        role?: string;
        content?: unknown;
      };
      if (role !== "assistant" || !Array.isArray(content)) continue;
      for (const block of content as Array<{ type?: string; name?: string }>)
        if (
          block.type === "toolCall" &&
          block.name != null &&
          names.has(block.name)
        )
          this.loaded.add(block.name);
    }
  }

  /** tool_search, registered once anything is deferred and re-registered when its list changes. */
  private registerSearch(pi: ExtensionAPI): void {
    if (this.deferred.length === 0) return;
    const description = toolSearchDescription(this.deferred);
    if (
      description === this.searchDescription &&
      this.registered.has(TOOL_SEARCH_NAME)
    )
      return;
    try {
      pi.registerTool(
        buildToolSearchTool(
          {
            deferred: () => this.deferred,
            isLoaded: (name) => this.loaded.has(name),
            load: (names) => this.load(names),
          },
          description
        ) as never
      );
      this.registered.add(TOOL_SEARCH_NAME);
      this.searchDescription = description;
    } catch {
      // Without it the deferred tools are simply offered, as before.
      this.registered.delete(TOOL_SEARCH_NAME);
      this.searchDescription = null;
      this.deferred = [];
    }
  }

  /** Found by tool_search: switched on from the model's next request. */
  private load(names: readonly string[]): void {
    if (names.length === 0) return;
    for (const name of names) this.loaded.add(name);
    this.syncActive(buildMcpToolDefinitions(this.deps.mcp));
  }

  /**
   * Offer what the servers list now, less what waits behind tool_search, and
   * tool_search itself while anything is deferred. Loaded tools only ever
   * join, so the list a provider caches settles.
   */
  private syncActive(all: ReturnType<typeof buildMcpToolDefinitions>): void {
    const session = this.deps.session();
    if (session == null) return;
    const hidden = new Set(
      this.deferred
        .map((tool) => tool.name)
        .filter((name) => !this.loaded.has(name))
    );
    const offered = new Set(
      all.map((tool) => tool.name).filter((name) => !hidden.has(name))
    );
    if (this.deferred.length > 0 && this.registered.has(TOOL_SEARCH_NAME))
      offered.add(TOOL_SEARCH_NAME);
    syncActiveMcpTools(session, this.registered, offered);
  }
}
