/**
 * The tools this process registers itself, as one table.
 *
 * Each entry names the tool the model will call and says when it is built:
 * a feature flag, or "only when no MCP server already serves that name".
 * The table exists so the roster can be read without running a session:
 * roster.test.ts checks every name here against the Capabilities registry
 * and the gate's pinned decisions, which is what makes forgetting one of
 * those loud rather than silent. `background` once shipped able to run a
 * shell command in plan mode because nothing looked at the whole roster.
 */
import {
  createBashToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLocalBashOperations,
  createLsToolDefinition,
  type ModelRuntime,
  type SettingsManager,
} from "@earendil-works/pi-coding-agent";

import { withBackgroundOption } from "./background-bash.js";
import { buildBotTimeTool } from "./bot/bot-time-tool.js";
import {
  browserTaskEnabled,
  buildBrowserTaskTool,
} from "./browser-task-tool.js";
import { skillDirs, skillDirsByScope } from "./config.js";
import { buildDeckTool, deckToolEnabled } from "./deck-tool.js";
import { buildDelegateTool, delegationEnabled } from "./delegate-tool.js";
import { buildDesignTool, designToolEnabled } from "./design-tool.js";
import { buildDocumentTool, documentToolEnabled } from "./document-tool.js";
import { buildExitPlanTool } from "./exit-plan-tool.js";
import type { HostServiceClient } from "./host-services.js";
import type { ConnectedMcp } from "./mcp/index.js";
import { buildMcpToolDefinitions } from "./mcp/tools.js";
import { buildMemoryTool } from "./memory-tool.js";
import { buildPresentDeliverableTool } from "./present-deliverable-tool.js";
import type { AgentEvent, AgentMode } from "./protocol.js";
import { buildServeTool } from "./serve-tool.js";
import {
  buildSessionSearchTool,
  sessionSearchEnabled,
} from "./session-search-tool.js";
import { buildSkillAddTool, skillAddEnabled } from "./skill-add-tool.js";
import { buildTodoTool } from "./todo-tool.js";

/** What a session hands the table; everything a builder may need. */
export interface RosterContext {
  cwd: string;
  agentDir: string;
  modelRuntime: ModelRuntime;
  /** Sub-agents' own manager, left at the configured retry budget. */
  subAgentSettingsManager: SettingsManager;
  /**
   * The session's model, read when a sub-agent is spawned rather than when
   * the table is built: a pick or a pool hop after start must reach the
   * sub-agents, or a document is written by a model the user left. `unknown`
   * here, as in the sub-agent contexts: naming the provider type in an
   * exported signature drags the provider catalogue into the package's
   * declaration build.
   */
  model: () => unknown;
  /** The browser sub-agent's model, which may be stronger than the chat's. */
  browserModel: () => unknown;
  /** Null for a front end without host services (the CLI). */
  hostServices: HostServiceClient | null;
  /** The tools the user switched off in Capabilities. */
  excluded: readonly string[];
  operations: ReturnType<typeof createLocalBashOperations>;
  /** A getter: a refresh swaps the MCP state, and a captured one is stale. */
  mcp: () => ConnectedMcp;
  /**
   * Names already served to the model by MCP or a component, so a tool of
   * the same name is not registered twice.
   */
  provided: ReadonlySet<string>;
  mode: () => AgentMode;
  sessionId: () => string | undefined;
  emit: (event: AgentEvent) => void;
  /** Awaited by `skill_add` before it answers, so the new skill is live. */
  reloadSkills: () => Promise<void> | void;
}

/** Whatever pi accepts as a custom tool; the builders return several shapes. */
export type RosterTool = { name: string };

export interface RosterEntry {
  /** The wire name, for the coverage tests. */
  name: string;
  /** Built only when this says so; absent means always. */
  when?: (ctx: RosterContext) => boolean;
  /**
   * Skipped when something else already serves this name. The desktop serves
   * `todo` over MCP and the CLI has no MCP server; adding it only when
   * nothing provides it keeps the Capabilities toggle the single answer to
   * whether it is on.
   */
  unlessProvided?: boolean;
  build: (ctx: RosterContext) => RosterTool;
}

/**
 * Whether this session registers its own `bash` (which carries `background`)
 * over pi's built-in; a custom tool of the same name replaces it. Skipped only
 * when the user switched `bash` off. It must NOT also be named in
 * `excludeTools`: pi applies that to custom tools too, leaving no shell.
 */
export function replacesBash(excluded: readonly string[]): boolean {
  return !excluded.includes("bash");
}

const isBrowserTool = (tool: { name: string }): boolean =>
  tool.name.startsWith("browser_");

const browserTools = (ctx: RosterContext): RosterTool[] =>
  buildMcpToolDefinitions(ctx.mcp).filter(isBrowserTool);

/** Whether the browser tools go to a sub-agent behind one `browser_task`. */
const browserTaskWanted = (ctx: RosterContext): boolean =>
  browserTools(ctx).length > 0 && browserTaskEnabled();

/**
 * A sub-agent's options, with `model` a live read of the session's: the task
 * reads `context.model` as it spawns, so a switch between build and spawn
 * lands. Spreading the result would freeze it; merge with `withLiveModel`.
 */
export const subAgentOptions = <Extra extends object>(
  ctx: Pick<
    RosterContext,
    "cwd" | "agentDir" | "modelRuntime" | "subAgentSettingsManager" | "model"
  >,
  extra?: Extra
): {
  cwd: string;
  agentDir: string;
  modelRuntime: ModelRuntime;
  settingsManager: SettingsManager;
  skillPaths: string[];
  readonly model?: never;
} & Extra =>
  withLiveModel(
    {
      cwd: ctx.cwd,
      agentDir: ctx.agentDir,
      modelRuntime: ctx.modelRuntime,
      settingsManager: ctx.subAgentSettingsManager,
      skillPaths: skillDirs(ctx.cwd),
      ...(extra ?? ({} as Extra)),
    },
    ctx.model
  );

/** `options` with a `model` getter that asks `read` each time. */
const withLiveModel = <T extends object>(
  options: T,
  read: () => unknown
): T & { readonly model?: never } =>
  Object.defineProperty(options, "model", {
    enumerable: true,
    get: () => read(),
  }) as T & { readonly model?: never };

/**
 * Tools that are deliberately not switchable, so their absence from the
 * Capabilities registry is correct.
 *
 * `exit_plan_mode` is a mode's only exit, and must not depend on which
 * toolsets are on. `current_time` is a clock, not a capability.
 */
export const NOT_SWITCHABLE: readonly string[] = [
  "exit_plan_mode",
  "current_time",
];

/**
 * The tools before the MCP passthrough, in registration order: the ones that
 * need nothing but this process.
 */
export const OWN_TOOLS: readonly RosterEntry[] = [
  // A `date` shell round trip is one the model rarely bothers with.
  { name: "current_time", build: () => buildBotTimeTool() },
  // Always registered: the one way out of plan mode must not depend on
  // which toolsets are switched on.
  { name: "exit_plan_mode", build: (ctx) => buildExitPlanTool(ctx.mode) },
  // `createAgentSession` registers only pi's coding set, not its read-only
  // search tools; without these, plan mode could investigate with nothing
  // but `read`. Custom tools, so `excludeTools` covers them like the rest.
  { name: "grep", build: (ctx) => createGrepToolDefinition(ctx.cwd) },
  { name: "find", build: (ctx) => createFindToolDefinition(ctx.cwd) },
  { name: "ls", build: (ctx) => createLsToolDefinition(ctx.cwd) },
  // Here rather than on the desktop's tool server: the CLI has no such
  // server and no other way to add a skill.
  {
    name: "skill_add",
    when: () => skillAddEnabled(),
    build: (ctx) =>
      buildSkillAddTool({
        skillDirs: () => skillDirsByScope(ctx.cwd),
        onInstalled: () => ctx.reloadSkills(),
      }),
  },
  // Recall over past conversations; it reads files, not app state, so the
  // CLI can have it too.
  {
    name: "session_search",
    when: () => sessionSearchEnabled(),
    build: (ctx) => buildSessionSearchTool(ctx.sessionId),
  },
  { name: "todo", unlessProvided: true, build: () => buildTodoTool() },
  { name: "memory", unlessProvided: true, build: () => buildMemoryTool() },
  // The tool every handover instruction names; the CLI must have one too.
  {
    name: "present_deliverable",
    unlessProvided: true,
    build: (ctx) => buildPresentDeliverableTool(() => ctx.cwd),
  },
  // The other half of that workflow: a page is only a deliverable once
  // something is serving it, and `bash` cannot hold a server open.
  {
    name: "serve",
    unlessProvided: true,
    build: (ctx) => buildServeTool(() => ctx.cwd),
  },
];

/** The tools after the MCP passthrough: sub-agents and the shell. */
export const SUB_AGENT_TOOLS: readonly RosterEntry[] = [
  // Background runs go through the same operations as the foreground ones,
  // so `background: true` cannot become a way around the sandbox.
  {
    name: "bash",
    when: (ctx) => replacesBash(ctx.excluded),
    build: (ctx) =>
      withBackgroundOption(
        createBashToolDefinition(ctx.cwd, {
          operations: ctx.operations,
        }) as never,
        ctx.cwd,
        ctx.operations
      ),
  },
  // Delegation lives here, not in the desktop's tool server: a sub-agent
  // needs the model runtime and resource loader, which only exist here.
  {
    name: "delegate_task",
    when: () => delegationEnabled(),
    build: (ctx) => buildDelegateTool(subAgentOptions(ctx), ctx.emit),
  },
  // Browser tools go to a sub-agent (browser-task.ts) and the parent gets one
  // `browser_task` tool: a page walk is dozens of element trees the main
  // transcript would carry forever, and driving a real site needs a prompt
  // about nothing else.
  {
    name: "browser_task",
    when: browserTaskWanted,
    build: (ctx) =>
      buildBrowserTaskTool(
        withLiveModel(
          {
            cwd: ctx.cwd,
            agentDir: ctx.agentDir,
            modelRuntime: ctx.modelRuntime,
            settingsManager: ctx.subAgentSettingsManager,
            // Resolved per run so a reconnect reaches the sub-agent too.
            browserTools: () => browserTools(ctx),
          },
          ctx.browserModel
        ),
        ctx.emit
      ),
  },
  // The document component, here for the same reason as delegation; only
  // its printing stays on the desktop as a host service (document-task.ts).
  {
    name: "document",
    when: (ctx) => ctx.hostServices != null && documentToolEnabled(),
    build: (ctx) =>
      buildDocumentTool(
        subAgentOptions(ctx, { hostServices: ctx.hostServices! }),
        ctx.emit
      ),
  },
  // The design component, on the same split (design-task.ts).
  {
    name: "design",
    when: (ctx) => ctx.hostServices != null && designToolEnabled(),
    build: (ctx) =>
      buildDesignTool(
        subAgentOptions(ctx, { hostServices: ctx.hostServices! }),
        ctx.emit
      ),
  },
  // The deck component: template markup never crosses into this process, so
  // slides are filled by slot (deck-task.ts).
  {
    name: "ppt",
    when: (ctx) => ctx.hostServices != null && deckToolEnabled(),
    build: (ctx) =>
      buildDeckTool(
        subAgentOptions(ctx, { hostServices: ctx.hostServices! }),
        ctx.emit
      ),
  },
];

/** Every name this process can register, whatever the flags say. */
export const ROSTER_TOOL_NAMES: readonly string[] = [
  ...OWN_TOOLS,
  ...SUB_AGENT_TOOLS,
].map((entry) => entry.name);

export interface BuiltRoster {
  /** In registration order, MCP passthrough included. */
  tools: RosterTool[];
  /** The MCP tools registered as-is, so a refresh does not add them twice. */
  mcpToolNames: string[];
  /** Whether the browser tools went behind `browser_task`. */
  browserTaskRegistered: boolean;
}

const wanted = (entry: RosterEntry, ctx: RosterContext): boolean =>
  (entry.when?.(ctx) ?? true) &&
  !(entry.unlessProvided === true && ctx.provided.has(entry.name));

/**
 * Build the roster for one session. Order is registration order: the
 * process's own tools, then every MCP tool passed through as-is (browser
 * tools too, when no `browser_task` fronts them), then the shell and the
 * sub-agents.
 */
export function buildRoster(
  ctx: RosterContext,
  isSuperseded: (tool: { name: string }) => boolean
): BuiltRoster {
  const mcpTools = buildMcpToolDefinitions(ctx.mcp);
  const otherMcpTools = mcpTools.filter(
    (tool) => !isBrowserTool(tool) && !isSuperseded(tool)
  );
  const browserTaskRegistered = browserTaskWanted(ctx);
  // With `browser_task` switched off the raw tools come back.
  const passthroughBrowserTools = browserTaskRegistered
    ? []
    : mcpTools.filter(isBrowserTool);
  const passthrough = [...otherMcpTools, ...passthroughBrowserTools];

  const tools: RosterTool[] = [
    ...OWN_TOOLS.filter((entry) => wanted(entry, ctx)).map((entry) =>
      entry.build(ctx)
    ),
    ...passthrough,
    ...SUB_AGENT_TOOLS.filter((entry) => wanted(entry, ctx)).map((entry) =>
      entry.build(ctx)
    ),
  ];

  return {
    tools,
    mcpToolNames: passthrough.map((tool) => tool.name),
    browserTaskRegistered,
  };
}
