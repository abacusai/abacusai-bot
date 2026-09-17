import {
  createAgentSession,
  createLocalBashOperations,
  DefaultResourceLoader,
  type AgentSession,
  type AgentSessionEvent,
  type ExtensionAPI,
  type InlineExtension,
  ModelRegistry,
  type ModelRuntime,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

import { allowedPathsFromEnv } from "./allowed-paths.js";
import { backendOperations } from "./backends.js";
import { notifyConversationQueueCleared } from "./background-processes.js";
/**
 * The bridge: one pi `AgentSession`, presented as the desktop's event stream.
 * The only place that knows both vocabularies. Approval is a promise awaited
 * inside pi's async `tool_call` hook, so the loop is genuinely suspended while
 * the user decides; edit diffs are computed from the on-disk "before".
 */
import { timezonePrompt } from "./bot/bot-time-tool.js";
import { anchorCompactions } from "./compaction-anchor.js";
import {
  agentDir,
  applyStoredApiKeys,
  defaultModelFor,
  loadConfig,
  PROVIDER_API_KEY_ENV,
  skillDirs,
  userProfilePrompt,
  type AbacusBotConfig,
} from "./config.js";
import { setCurrentMode } from "./current-mode.js";
import {
  customInstructionsPrompt,
  readCustomInstructions,
} from "./custom-instructions.js";
import { deckToolEnabled } from "./deck-tool.js";
import { designToolEnabled } from "./design-tool.js";
import { documentToolEnabled } from "./document-tool.js";
import { excludedTools, TOOL_NAME_ALIASES } from "./excluded-tools.js";
import { EXIT_PLAN_TOOL_NAME } from "./exit-plan-tool.js";
import astTools from "./extensions/ast-tools.js";
import background from "./extensions/background.js";
import batchReadTool from "./extensions/batch-read-tool.js";
import budgets, { budgetStopReason } from "./extensions/budgets.js";
import compactionPruner from "./extensions/compaction-pruner.js";
import editTool from "./extensions/edit-tool.js";
import emailFormat from "./extensions/email-format.js";
import guardrails from "./extensions/guardrails.js";
import knowledge from "./extensions/knowledge.js";
import orientation from "./extensions/orientation.js";
import outputRepair from "./extensions/output-repair.js";
import spill from "./extensions/spill.js";
import syntaxCheck from "./extensions/syntax-check.js";
import testRunner from "./extensions/test-runner.js";
import toolCallRepair from "./extensions/tool-call-repair.js";
import toolTimeouts from "./extensions/tool-timeouts.js";
import verifyLoop from "./extensions/verify-loop.js";
import { githubPrompt } from "./github-prompt.js";
import { HostServiceClient } from "./host-services.js";
import {
  connectMcpServers,
  type ConnectedMcp,
  type McpServerStatus,
} from "./mcp/index.js";
import { buildMcpToolDefinitions } from "./mcp/tools.js";
import {
  memorySnapshot as readMemorySnapshot,
  rememberSnapshot,
} from "./memory-store.js";
import { fileCooldownStore } from "./openllm-cooldowns.js";
import {
  OPENLLM_ID,
  OpenLlmRotation,
  accountWideFailure,
  isOutOfCredits,
  openLlmCandidates,
  isOpenLlmReference,
  MAX_OPENLLM_ROTATIONS_PER_TURN,
} from "./openllm.js";
import {
  gateToolCall,
  MODE_NAMES,
  parseMode,
  parseModeStrict,
  shellSegments,
} from "./permissions.js";
import { personaPrompt, readPersona } from "./persona.js";
import { windowsShellPrompt } from "./posix-shell.js";
import {
  AgentMode,
  AgentStatus,
  type AgentEvent,
  type DesktopEvent,
  type PermissionDecision,
  type PermissionRequest,
  type SkillMetadata,
  type ToolRequest,
} from "./protocol.js";
import {
  createModelRuntime,
  listModels,
  registerAbacusProvider,
  registerCustomProviders,
  registerGeminiProvider,
  resolveModel,
  DEFAULT_MAX_OUTPUT_TOKENS,
} from "./providers.js";
import {
  REPLY_LANGUAGE_PROMPT,
  replyLanguageMismatch,
  replyLanguageRepairPrompt,
  type ReplyLanguageMismatch,
} from "./reply-language.js";
import { buildRoster } from "./roster.js";
import { serviceRoutingPrompt } from "./service-routing-prompt.js";
import { conversationSessionManager } from "./session-file.js";
import { ToolHeartbeat } from "./tool-heartbeat.js";
import { TOOLS_ARRIVED_TYPE, toolsArrivedPrompt } from "./tools-arrived.js";
import { turnUsage, type TurnUsage } from "./turn-usage.js";
import { searchAvailable, xaiSearchAvailable } from "./web/search.js";
import webTools from "./web/tools.js";

export interface SessionOptions {
  cwd: string;
  model?: string;
  mode?: string;
  /**
   * Whether a host is attached to answer `host_service_request`. The CLI has
   * none, so the tools that need one are never registered: an unanswered
   * request leaves nothing on the event loop and the process exits silently.
   */
  hostServices?: boolean;
  emit: (event: DesktopEvent) => void;
}

interface PendingPermission {
  resolve: (decision: PermissionDecision) => void;
}

/**
 * What the agent already remembers, as a system-prompt block. The snapshot is
 * frozen at spawn: folding mid-session writes into the prompt would change
 * the cached prefix for every remaining turn. The tool's own response shows
 * the live state; the prompt catches up next session.
 */
function memoryPrompt(hasMemoryTool: boolean): string | null {
  // The desktop passes the snapshot it read at spawn; the CLI has no main
  // process and reads the same store itself.
  const snapshot = (
    (process.env.ABACUSAI_BOT_MEMORY_SNAPSHOT ?? "").trim() ||
    readMemorySnapshot() ||
    ""
  ).trim();

  if (snapshot.length === 0) return null;

  return [
    "What you already know, carried over from earlier sessions:",
    "",
    snapshot,
    "",
    // Naming a tool that is not registered teaches failing calls.
    hasMemoryTool
      ? "Use the `memory` tool to add, correct, or drop any of it. Entries here were true when written — verify anything that names a file, flag, or command before relying on it."
      : "Entries here were true when written — verify anything that names a file, flag, or command before relying on it. You cannot change them in this session.",
  ].join("\n");
}

/**
 * What the user asked to be remembered, as a system-prompt block. Read per
 * turn, not frozen at spawn: "remember I like blue" means the very next
 * answer. Stated as standing fact, since this is what the user said rather
 * than what the agent wrote down for itself.
 */
function rememberPrompt(): string | null {
  const snapshot = rememberSnapshot();
  if (snapshot == null) return null;

  return [
    "The user asked you to remember the following. Treat it as standing fact",
    "about them and their preferences, and follow it without being reminded:",
    "",
    snapshot,
  ].join("\n");
}

/**
 * How to put a picture in front of the user. The renderer's CSP admits only
 * `data:` and `blob:`, so a remote image URL is a dead link; no model knows
 * that about this app, so it is stated in every prompt.
 */
function displayPrompt(): string {
  return [
    "Showing images:",
    "",
    "The chat displays a markdown image when its source is a file on disk — an absolute path, a",
    "path relative to the workspace, or a file:// URL. It cannot display a remote URL, so download",
    "the image first (curl, or a generation tool) and show the local file. Never offer a link to an",
    "image on someone else's site in place of showing the picture.",
  ].join("\n");
}

/**
 * What Plan mode refuses (every shell command, since shell text cannot be
 * classified), said before the model finds out by being refused. Written as
 * the rule, not this session's mode: the system prompt is the cached prefix
 * of every request and may not vary turn to turn. Only when `bash` is present.
 */
export function planModePrompt(
  availableTools: ReadonlySet<string>
): string | null {
  if (qualifiedName(availableTools, "bash") == null) return null;

  return [
    "Plan mode:",
    "",
    "Plan mode is read-only, and it refuses every shell command — not just the ones that change",
    "something. `bash` and `run_tests` are refused in Plan mode even for `ls`, `git log`, `grep` or",
    "a build you only want to read the output of. Do not spend turns discovering this one command",
    "at a time.",
    "",
    "Investigate with the tools that stay available instead: `read`, `batch_file_read`, `grep`,",
    "`find`/`glob` and `ls` cover everything a shell would have been used to look at. When the plan",
    "is ready and the user wants it done, call `exit_plan_mode` — that is how the mode changes.",
  ].join("\n");
}

/**
 * The roster as the prompt describes it, for telling whether the prompt is
 * stale: a server added, gone, or grown a tool since it was built.
 */
export function mcpRosterFingerprint(
  statuses: readonly McpServerStatus[]
): string {
  return statuses
    .filter((status) => status.isBuiltin !== true)
    .map((status) => `${status.name}:${status.status}:${status.toolCount}`)
    .sort()
    .join("|");
}

/**
 * The MCP servers this session actually has, said out loud. A tool list says
 * a call is possible, not that the service the user asked about by name is
 * behind it; servers that failed are named too, with why, so the model does
 * not report the integration as missing. Built-ins are left out. Computed once
 * at session start, since the system prompt is the cached prefix of every
 * request; the desktop announces later connections on the next message.
 */
export function mcpPrompt(statuses: readonly McpServerStatus[]): string | null {
  const userServers = statuses.filter((status) => status.isBuiltin !== true);
  // A connected server with no tools reads as "no integration here", and a
  // tool that arrives a minute later is then disbelieved.
  const connected = userServers.filter(
    (status) => status.status === "connected" && status.toolCount > 0
  );
  // A server the user switched off is not a fact worth prompt space: they know.
  const failed = userServers.filter(
    (status) => status.status === "error" || status.status === "auth-required"
  );

  if (connected.length === 0 && failed.length === 0) return null;

  const lines = ["Connected services:", ""];

  if (connected.length > 0) {
    const described = connected
      .map(
        (status) =>
          `\`${status.name}\` (${status.toolCount} tool${status.toolCount === 1 ? "" : "s"}, named \`${status.name}_*\`)`
      )
      .join(", ");

    lines.push(
      `You are connected to these services right now, through MCP: ${described}. Their tools are`,
      "yours to call like any other. When you are asked whether you have access to one of them,",
      "this list is the answer — do not say you lack an integration that is named here."
    );
  }

  if (failed.length > 0) {
    const described = failed
      .map(
        (status) =>
          `\`${status.name}\` (${status.status === "auth-required" ? "needs a sign-in in the app" : (status.error ?? "failed to connect")})`
      )
      .join(", ");

    if (connected.length > 0) lines.push("");
    lines.push(
      `These are configured but not usable: ${described}. Say so plainly if the user asks for one,`,
      "rather than reporting work you could not do."
    );
  }

  return lines.join("\n");
}

/**
 * A tool's name as the model must call it: MCP tools arrive server-prefixed
 * while this process's own are bare, and a prompt naming the wrong one
 * teaches failing calls.
 */
function qualifiedName(
  availableTools: ReadonlySet<string>,
  base: string
): string | undefined {
  for (const name of availableTools) {
    if (name === base || name.endsWith(`_${base}`)) return name;
  }

  return undefined;
}

/**
 * How a turn ends when it produced something. Two mechanisms, not
 * alternatives: a markdown link to a path is what the chat renders clickable,
 * `present_deliverable` is what opens the preview pane and files under
 * Artifacts. The link half needs no tool and is stated unconditionally.
 */
function handoverPrompt(presentTool: string | undefined): string {
  const lines = [
    "Handing over what you made:",
    "",
    "A file you produced is only reachable if you name it. The chat turns a markdown link whose",
    "target is a path on disk (or a file:// URL) into one the user can click to open, so a turn that",
    "produced something ends by linking it — and when the answer is short enough to read in the",
    "message, put it there too. Reporting that the work happened, with no link and no content, is a",
    "dead end: the user can neither see what you wrote nor find where it went.",
  ];

  if (presentTool != null) {
    lines.push(
      "",
      `Then call \`${presentTool}\` with the same files, most important first — from a component, from`,
      "`write`, from `bash`, it does not matter. The link makes them clickable; this opens the first one",
      "in the preview pane and files them all under Artifacts, where they can be found again after the",
      "conversation has moved on. List the deliverables, not the scratch files."
    );
  }

  return lines.join("\n");
}

/**
 * The server's `x_search`, when this process's own version should answer
 * instead. The server's runs on xAI's Live Search, which reads X itself, so
 * where an xAI key exists it is the better tool and this process stands down;
 * the desktop signals that, since this process cannot read the app's settings.
 */
export function isSupersededWebTool(tool: { name: string }): boolean {
  // Server-qualified names only; this process's own `x_search` must stay.
  if (!/^.+_x_search$/.test(tool.name)) return false;

  return !xaiSearchAvailable() && searchAvailable();
}

/**
 * The components this process will register, by the name the model calls.
 * The prompt is assembled before the tool list, so both sides ask the same
 * `*Enabled` predicates.
 */
function componentToolNames(hostServices: boolean): string[] {
  if (!hostServices) return [];

  return [
    ...(documentToolEnabled() ? ["document"] : []),
    ...(deckToolEnabled() ? ["ppt"] : []),
    ...(designToolEnabled() ? ["design"] : []),
  ];
}

/**
 * The document components, and the rule that they are not optional. Without
 * this the agent treats them as one option among many and hand-assembles a
 * deck from a skill, which is the slow path the components replace. `pdf` is
 * deliberately absent: it reprints, and cannot author.
 */
function componentsPrompt(availableTools: ReadonlySet<string>): string | null {
  const components: Array<[string, string]> = [
    ["document", "documents, printed as PDFs"],
    ["ppt", "slide decks"],
    ["design", "mockups and wireframes"],
  ];
  const present = components
    .map(([base, what]): [string | undefined, string] => [
      qualifiedName(availableTools, base),
      what,
    ])
    .filter((entry): entry is [string, string] => entry[0] != null);

  // A prompt naming a tool the model cannot call teaches failing calls.
  const sections: string[] = [];

  if (present.length > 0) {
    sections.push(
      [
        "Making documents, decks, apps and designs:",
        "",
        `These tools each hand the whole job to a specialised component: ${present
          .map(([name, what]) => `\`${name}\` (${what})`)
          .join(", ")}. Each returns a finished, verified artifact.`,
        "",
        "When the user asks for a presentation, deck, PPT, PDF, report, memo, app, dashboard,",
        "mockup, wireframe or design, call the matching tool. Do NOT build these by hand — no",
        "python-pptx, no reportlab, no hand-written HTML decks — and do not use a skill for",
        "them even if one is listed. Your job is the context argument: put everything the",
        "artifact should contain into it, then hand the result over (see below).",
        "",
        "Hand-building is the fallback only when the tool itself is unavailable or fails,",
        "and say so when you do it.",
      ].join("\n")
    );
  }

  return sections.length > 0 ? sections.join("\n\n") : null;
}

/**
 * How long an approval request waits before it is rejected: long enough for a
 * user who stepped away, short enough that an unattended session is not parked
 * forever. ABACUSAI_BOT_APPROVAL_TIMEOUT_MS overrides it; 0 waits forever.
 */
function approvalTimeoutMs(): number {
  const raw = Number(process.env.ABACUSAI_BOT_APPROVAL_TIMEOUT_MS);

  if (Number.isFinite(raw) && raw === 0) {
    return Number.POSITIVE_INFINITY;
  }

  return Number.isFinite(raw) && raw > 0 ? raw : 15 * 60_000;
}

/** The slice of a settings manager the retry cap reads and replaces. */
interface RetryBudgetHolder {
  getRetrySettings: () => { maxRetries: number };
}

/**
 * Cap same-model retries at one while OpenLLM routes this session: the pool's
 * answer to a failing provider is a different model, and further backoff only
 * delays the rotation. Read at call time so toggling the router mid-session
 * moves the budget with it. Sub-agents run a concrete model with no fallback
 * and need their own uncapped manager.
 */
export function capRetriesWhileRouting(
  manager: RetryBudgetHolder,
  routing: () => boolean
): void {
  const configuredRetrySettings = manager.getRetrySettings.bind(manager);

  manager.getRetrySettings = () => {
    const configured = configuredRetrySettings();

    return routing()
      ? { ...configured, maxRetries: Math.min(configured.maxRetries, 1) }
      : configured;
  };
}

/** The slice of a settings manager the compaction threshold reads and replaces. */
interface CompactionBudgetHolder {
  getCompactionSettings: () => {
    enabled: boolean;
    reserveTokens: number;
    keepRecentTokens: number;
  };
}

/**
 * The share of a context window kept free, so compaction runs before the
 * provider refuses. pi's flat 16k is 50% of a 32k window and nothing at all
 * on a million-token one, where a single tool result overshoots because the
 * check runs on the *previous* turn's usage.
 */
const CONTEXT_HEADROOM = 0.2;

/**
 * An absolute context budget for this session, or null. Routine fires replay
 * their whole conversation every run, so the desktop caps them via this env
 * var; usage past the cap triggers pi's ordinary compaction. Floored at 20k,
 * below which the session would thrash compactions instead of working.
 */
const contextCapTokens = (): number | null => {
  const raw = process.env.ABACUSAI_BOT_CONTEXT_CAP_TOKENS;
  if (raw == null || raw.length === 0) return null;
  const cap = Number(raw);
  return Number.isFinite(cap) && cap >= 20_000 ? Math.floor(cap) : null;
};

/**
 * Compact at a fraction of the window, not a fixed distance from its end.
 * Read at call time because OpenLLM changes the model mid-session; pi's
 * configured reserve stays a floor.
 */
export function reserveContextHeadroom(
  manager: CompactionBudgetHolder,
  contextWindow: () => number | undefined
): void {
  const configured = manager.getCompactionSettings.bind(manager);

  manager.getCompactionSettings = () => {
    const settings = configured();
    const window = contextWindow();

    if (window == null || window <= 0) return settings;

    const cap = contextCapTokens();

    return {
      ...settings,
      reserveTokens: Math.max(
        settings.reserveTokens,
        Math.ceil(window * CONTEXT_HEADROOM),
        cap != null ? window - cap : 0
      ),
    };
  };
}

export class AbacusBotSession {
  /** Steers handed to pi that have not reached the model yet, oldest first. */
  private readonly pendingSteers: string[] = [];
  private session: AgentSession | undefined;
  /** Construction options for the inner pi session, minus the model — see resetConversation. */
  private sessionInit: Parameters<typeof createAgentSession>[0] | undefined;
  private modelRuntime: ModelRuntime | undefined;
  /**
   * A turn died for want of credits or credentials, so the next one re-reads
   * them first: topping up or upgrading happens on the website, where nothing
   * local changes and no event fires.
   */
  private providersStale = false;
  private registry: ModelRegistry | undefined;
  private config: AbacusBotConfig = loadConfig();
  /** The output budget every request is held under; see DEFAULT_MAX_OUTPUT_TOKENS. */
  private readonly maxOutputTokens: number =
    this.config.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
  private mode: AgentMode;
  private readonly pending = new Map<string, PendingPermission>();
  /** Commands the user chose to always allow, for this process's lifetime. */
  private readonly sessionAllowedCommands: string[] = [];
  /** Non-bash tools the user chose to always allow, for this process's lifetime. */
  private readonly sessionAllowedTools = new Set<string>();
  /** Origins the user chose to always allow web_fetch for, this session. */
  private readonly sessionAllowedOrigins: string[] = [];
  /** Directories outside the workspace the user allowed reads from, this session. */
  private readonly sessionAllowedReadPaths: string[] = allowedPathsFromEnv();
  /**
   * Directories outside the workspace the user allowed writes to, this
   * session. Seeded with what the host pre-allowed (a routine's own folder).
   */
  private readonly sessionAllowedWritePaths: string[] = allowedPathsFromEnv();
  private permissionCounter = 0;
  /**
   * Extension handle for audit lines. Undefined until the permission gate is
   * built, so every use is optional: an audit line must not break startup.
   */
  private pi: ExtensionAPI | undefined;
  private mcp: ConnectedMcp = {
    clients: [],
    statuses: [],
    routes: new Map(),
    tools: [],
  };
  /** MCP tool names pi already has, so `refreshMcp` registers only what is new. */
  private readonly registeredMcpTools = new Set<string>();
  /**
   * Services only the desktop can perform. Long-lived: tools rebuilt on reset
   * would otherwise each capture a client with its own pending map.
   */
  private readonly hostServices = new HostServiceClient(
    (requestId, service, payload) => {
      this.options.emit({
        type: "host_service_request",
        requestId,
        service,
        payload,
      });
    }
  );
  /** Assistant text already emitted as deltas for the in-flight message. */
  private streamedText = "";
  /**
   * Wire id of the assistant message streaming now, sent on every text_delta:
   * a turn with tool calls produces several messages, and without the boundary
   * they glue into one segment with thinking blocks landing after it.
   */
  private currentMessageId: string | null = null;
  private messageCounter = 0;
  /**
   * Component runs currently presented as sub-agents, keyed by the tool call
   * that started them. See componentSubtaskDescription.
   */
  private readonly componentSubtasks = new Map<string, string>();
  /**
   * Arguments of each running tool call, keyed by call id: pi's
   * `tool_execution_end` carries only the result, and the desktop's artifact
   * extractor reads the output path off the settled call.
   */
  private readonly toolInputs = new Map<string, Record<string, unknown>>();
  /** Liveness while a tool runs, or the desktop's watchdog ends the turn. */
  private readonly heartbeat = new ToolHeartbeat((event) =>
    this.options.emit(event)
  );
  /** Provider calls that failed and were retried this turn — see reportFailedCall. */
  private retriedCalls = 0;
  /** The turn in flight was stopped by the user — see reportTurnFailure. */
  private interrupted = false;
  /** Continuations spent on a malformed tool call this turn. */
  private malformedContinuations = 0;
  /** The provider's usage for the turn's last request — set at `agent_end`. */
  private lastTurnUsage: TurnUsage | null = null;
  /** The context failure to compact around, with the turn it ended — set at `agent_end`. */
  private pendingContextCompaction: {
    failure: string;
    messages: readonly unknown[];
  } | null = null;
  /** Compactions spent recovering this turn. One is the limit — see compactAndRetry. */
  private contextCompactions = 0;
  /** Set at `agent_end` when the turn is to be continued rather than ended. */
  private continuingPastMalformedToolCall = false;
  /** Whether a user turn is in flight — a refresh landing now is mid-turn. */
  private turnRunning = false;
  /**
   * A model call that has gone silent. Nothing in the stack ends a stalled
   * stream before the desktop's ten-minute watchdog: a response the server
   * had finished and billed sat undelivered for fourteen minutes, then was
   * reported as a hang. Armed while a model call is expected to be producing
   * output, never while a tool runs (tools have their own limits).
   */
  private stallTimer: NodeJS.Timeout | null = null;
  private awaitingModel = false;
  private pendingStall: { modelId: string } | null = null;
  private stallRecoveriesThisTurn = 0;
  /** The turn already ended on the stall error; pi's aborted state is not a second one. */
  private stallFailureReported = false;
  /** MCP tools registered while this turn ran; pi offers them next turn. */
  private toolsArrivedThisTurn: string[] = [];
  /** The arrivals a continuation is about to name, once per turn. */
  private pendingToolArrival: string[] | null = null;
  private toolArrivalsThisTurn = 0;
  /** True while the session runs OpenLLM — see openllm.ts. */
  private openLlmActive = false;
  /**
   * Which free models failed recently. File-backed so cooldowns outlive this
   * process; every chat is its own process.
   */
  private readonly openLlmRotation = new OpenLlmRotation(
    Date.now,
    fileCooldownStore()
  );
  /** Model switches spent on provider failures this turn. */
  private openLlmRotationsThisTurn = 0;
  /**
   * Set at `agent_end` when the reply came back in the wrong script and the
   * turn continues with a repair. Once per turn; a second miss ends the turn.
   */
  private pendingLanguageRepair: ReplyLanguageMismatch | null = null;
  private languageRepairsThisTurn = 0;
  /**
   * Set at `agent_end` when the turn died on a provider error the router can
   * route around: the error text, and the free model to move to. Like the
   * malformed-call flag, its presence is what suppresses the idle event.
   */
  private pendingOpenLlmRotation: { failure: string; nextId: string } | null =
    null;
  /**
   * A routing episode is open from the first attempt until a model answers
   * or the pool runs out. While open, provider failures are the router's to
   * narrate and reportFailedCall stays quiet.
   */
  private openLlmRouting = false;
  /** The model the open routing episode is currently trying. */
  private openLlmRoutingTarget: string | null = null;
  /**
   * The pool model OpenLLM is on, so the routing episode can open when a turn
   * starts rather than when the session does.
   */
  private openLlmModelId: string | null = null;
  private unsubscribe: (() => void) | undefined;
  /** Kept so `skill_add` can re-scan skills mid-session. */
  private resourceLoader: DefaultResourceLoader | undefined;
  /** The instructions the current prompt was built with; compared per turn. */
  private promptInstructions = "";
  private promptPersona = "";
  /** The MCP roster the prompt was last built against. */
  private promptMcpRoster = "";

  constructor(private readonly options: SessionOptions) {
    this.mode = parseMode(options.mode);
    setCurrentMode(this.mode);
  }

  async start(): Promise<void> {
    const dir = agentDir();
    this.modelRuntime = await createModelRuntime(dir);
    const registry = new ModelRegistry(this.modelRuntime);
    this.registry = registry;
    registerCustomProviders(registry, this.config);
    registerGeminiProvider(registry);
    await registerAbacusProvider(registry);

    // MCP servers first: pi takes the custom tool list up front.
    this.mcp = await connectMcpServers(process.env.ABACUSAI_BOT_MCP_CONFIG);
    this.mcp.onStatusChange = () => this.emitMcpServers();

    const hostServices = this.options.hostServices !== false;
    const toolNames = new Set([
      ...componentToolNames(hostServices),
      ...this.mcp.tools.map((tool) => tool.name),
    ]);
    const userProfile = userProfilePrompt();
    const memory = memoryPrompt(qualifiedName(toolNames, "memory") != null);
    const settingsManager = SettingsManager.create(this.options.cwd, dir);
    // Sub-agents get their own manager, left at the configured retry budget.
    const subAgentSettingsManager = SettingsManager.create(
      this.options.cwd,
      dir
    );

    capRetriesWhileRouting(settingsManager, () => this.openLlmActive);
    // Sub-agents keep pi's flat reserve: one concrete model, short transcript.
    reserveContextHeadroom(
      settingsManager,
      () => this.session?.model?.contextWindow
    );
    const resourceLoader = new DefaultResourceLoader({
      cwd: this.options.cwd,
      agentDir: dir,
      settingsManager,
      additionalSkillPaths: skillDirs(this.options.cwd),
      // What the model cannot work out for itself about this app, appended to
      // pi's own prompt rather than replacing it.
      appendSystemPrompt: [
        userProfile,
        memory,
        // Timezone before anything that shows a time: connectors return UTC.
        timezonePrompt(),
        // The check at agent_end catches language drift; this prevents it.
        REPLY_LANGUAGE_PROMPT,
        // Both prompts name tools, so both read the same roster.
        displayPrompt(),
        // Null everywhere the tool is a real bash.
        windowsShellPrompt(),
        planModePrompt(toolNames),
        githubPrompt(),
        serviceRoutingPrompt(),
        componentsPrompt(toolNames),
        handoverPrompt(qualifiedName(toolNames, "present_deliverable")),
      ].filter((part): part is string => part != null),
      // Blocks that must be re-read on every loader load rather than frozen at
      // start: this hook runs on each reload, and `base` is the array above,
      // so the user's own instructions stay last.
      appendSystemPromptOverride: (base: string[]): string[] => {
        // The bot's identity comes first: who the agent is before what it knows.
        const persona = personaPrompt();
        const instructions = customInstructionsPrompt();
        const remember = rememberPrompt();

        // Live statuses, so a connector added mid-chat updates the line.
        const mcp = mcpPrompt(this.mcp.statuses);
        this.promptMcpRoster = mcpRosterFingerprint(this.mcp.statuses);

        return [
          ...(persona == null ? [] : [persona]),
          ...base,
          ...(mcp == null ? [] : [mcp]),
          ...(remember == null ? [] : [remember]),
          ...(instructions == null ? [] : [instructions]),
        ];
      },
      // The permission gate runs before the guardrails: a call the user will
      // reject must not be rewritten first. ABACUSAI_BOT_NO_EXTENSIONS=1 loads
      // only the gate, the first step when a turn misbehaves.
      extensionFactories: (process.env.ABACUSAI_BOT_NO_EXTENSIONS === "1"
        ? [
            {
              name: "abacusai-bot-permissions",
              factory: this.permissionExtension,
            },
          ]
        : [
            {
              name: "abacusai-bot-permissions",
              factory: this.permissionExtension,
            },
            // After the gate: handlers run in registration order, and it only
            // touches the timeout argument, so the approval card stays accurate.
            {
              name: "abacusai-bot-tool-timeouts",
              factory: toolTimeouts as unknown as (pi: ExtensionAPI) => void,
            },
            {
              name: "abacusai-bot-guardrails",
              factory: guardrails as unknown as (pi: ExtensionAPI) => void,
            },
            // Spill runs before the extensions that read tool output, so they see
            // the bounded text rather than the full dump.
            {
              name: "abacusai-bot-spill",
              factory: spill as unknown as (pi: ExtensionAPI) => void,
            },
            {
              name: "abacusai-bot-background",
              factory: background as unknown as (pi: ExtensionAPI) => void,
            },
            {
              name: "abacusai-bot-email-format",
              factory: emailFormat as unknown as (pi: ExtensionAPI) => void,
            },
            {
              name: "abacusai-bot-compaction-pruner",
              factory: compactionPruner as unknown as (
                pi: ExtensionAPI
              ) => void,
            },
            {
              name: "abacusai-bot-web",
              factory: webTools as unknown as (pi: ExtensionAPI) => void,
            },
            {
              name: "abacusai-bot-ast-tools",
              factory: astTools as unknown as (pi: ExtensionAPI) => void,
            },
            {
              name: "abacusai-bot-edit-tool",
              factory: editTool as unknown as (pi: ExtensionAPI) => void,
            },
            {
              name: "abacusai-bot-batch-read-tool",
              factory: batchReadTool as unknown as (pi: ExtensionAPI) => void,
            },
            {
              name: "abacusai-bot-test-runner",
              factory: testRunner as unknown as (pi: ExtensionAPI) => void,
            },
            {
              name: "abacusai-bot-knowledge",
              factory: knowledge as unknown as (pi: ExtensionAPI) => void,
            },
            {
              name: "abacusai-bot-syntax-check",
              factory: syntaxCheck as unknown as (pi: ExtensionAPI) => void,
            },
            // Before output-repair: a text tool call this recovers into a real
            // one leaves nothing for the nudge to complain about.
            {
              name: "abacusai-bot-tool-call-repair",
              factory: toolCallRepair as unknown as (pi: ExtensionAPI) => void,
            },
            {
              name: "abacusai-bot-output-repair",
              factory: outputRepair as unknown as (pi: ExtensionAPI) => void,
            },
            {
              name: "abacusai-bot-orientation",
              factory: orientation as unknown as (pi: ExtensionAPI) => void,
            },
            {
              name: "abacusai-bot-verify-loop",
              factory: verifyLoop as unknown as (pi: ExtensionAPI) => void,
            },
            {
              name: "abacusai-bot-budgets",
              factory: budgets as unknown as (pi: ExtensionAPI) => void,
            },
          ]) satisfies InlineExtension[],
    });
    await resourceLoader.reload();
    this.resourceLoader = resourceLoader;
    // What the prompt was built with, so the next turn can detect an edit.
    this.promptInstructions = readCustomInstructions();
    this.promptPersona = readPersona();

    // null when no provider is configured: naming a model would point the user
    // at a provider they cannot use.
    const requested =
      this.options.model ?? this.config.defaultModel ?? defaultModelFor();
    // OpenLLM's id is virtual and pi's fuzzy-matching resolver must never see
    // it; an empty pool falls through to the unavailable path with that reason.
    const routerChoice = isOpenLlmReference(requested)
      ? this.openLlmRotation.pick(openLlmCandidates(listModels(registry)))
      : undefined;
    const resolved =
      routerChoice != null
        ? resolveModel(this.modelRuntime, routerChoice.id, this.maxOutputTokens)
        : requested != null && !isOpenLlmReference(requested)
          ? resolveModel(this.modelRuntime, requested, this.maxOutputTokens)
          : {
              model: undefined,
              error: isOpenLlmReference(requested)
                ? "the free pool is empty — add an OpenRouter, Google AI Studio, or Abacus.AI key"
                : undefined,
              warning: undefined,
            };

    this.openLlmActive = routerChoice != null && resolved.model != null;

    // A model without credentials is unavailable too; pick the first configured
    // one rather than leave `model` undefined. Messages wait until after
    // `ready`, or they land in a conversation the desktop has not created yet.
    let model =
      resolved.model != null && registry.hasConfiguredAuth(resolved.model)
        ? resolved.model
        : undefined;
    let startupError: string | undefined;
    /** A fallback is a working session, so it is a warning, not an error. */
    let startupNotice: string | undefined;

    if (model == null) {
      this.openLlmActive = false;
      const fallback = registry.getAvailable()[0];

      if (fallback != null) {
        // The requested model cannot run (no key, or an empty free pool), so
        // the first model that can takes the turn — a session that opens on
        // something beats one that will not open. Announced, never silent: a
        // turn answered by a model nobody chose is the whole confusion here.
        model = fallback;
        startupNotice = `${requested} is not usable (${
          resolved.model != null
            ? "no key configured"
            : (resolved.error ?? "unavailable")
        }), so this session is running ${fallback.provider}/${fallback.id}.`;
      } else {
        // No model at all: saying which key to set beats a resolution failure
        // the user cannot act on.
        startupError = NO_MODEL_CONFIGURED;
      }
    }

    // A switched-off toolset is withheld, not hidden: the model never sees it.
    const excluded = excludedTools();

    // The browser sub-agent may run on a stronger model than the chat.
    const browserModelRef = (
      process.env.ABACUSAI_BOT_BROWSER_MODEL ??
      this.config.browserModel ??
      ""
    ).trim();
    const browserModel =
      browserModelRef.length > 0
        ? (resolveModel(
            this.modelRuntime,
            browserModelRef,
            this.maxOutputTokens
          ).model ?? model)
        : model;

    // The roster is a table (roster.ts) so it can be read without a session.
    const roster = buildRoster(
      {
        cwd: this.options.cwd,
        agentDir: dir,
        modelRuntime: this.modelRuntime,
        subAgentSettingsManager,
        model,
        browserModel,
        hostServices: hostServices ? this.hostServices : null,
        excluded,
        // Background runs go through the same operations as the foreground
        // ones, so `background: true` cannot become a way around the sandbox.
        operations: backendOperations() ?? createLocalBashOperations(),
        // A getter: refreshMcp swaps `this.mcp`, and captured routes would
        // call closed clients forever.
        mcp: () => this.mcp,
        provided: toolNames,
        mode: () => this.mode,
        sessionId: () => this.session?.sessionId,
        emit: (event) => this.emitAgentEvent(event),
        reloadSkills: () => this.reloadSkills(),
      },
      isSupersededWebTool
    );
    for (const name of roster.mcpToolNames) {
      this.registeredMcpTools.add(name);
    }
    this.browserTaskRegistered = roster.browserTaskRegistered;
    const customTools = roster.tools;

    // Resumes the chat where the last process left it; undefined keeps pi's
    // default.
    const sessionManager = conversationSessionManager(this.options.cwd);

    // Kept so resetConversation can rebuild an identical (but blank) session.
    this.sessionInit = {
      cwd: this.options.cwd,
      agentDir: dir,
      modelRuntime: this.modelRuntime,
      resourceLoader,
      settingsManager,
      ...(customTools.length > 0 ? { customTools: customTools as never } : {}),
      ...(excluded.length > 0 ? { excludeTools: excluded } : {}),
      ...(sessionManager != null ? { sessionManager } : {}),
    };

    const created = await createAgentSession({
      ...this.sessionInit,
      ...(model ? { model } : {}),
    });

    this.session = created.session;
    anchorCompactions(this.session.sessionManager);
    this.unsubscribe = this.session.subscribe((event) => this.onPiEvent(event));

    this.emitReady();

    if (model != null && this.openLlmActive) {
      // Noted, not announced: the desktop starts a session whenever an old
      // chat is reopened. The routing episode belongs to the turn; `send` opens it.
      this.openLlmModelId = `${model.provider}/${model.id}`;
    }

    if (startupError != null) {
      this.emitAgentEvent({
        type: "error",
        error: { message: startupError, code: "model_unavailable" },
      });
    }

    if (startupNotice != null) {
      this.emitAgentEvent({
        type: "notification",
        severity: "warning",
        message: startupNotice,
      });
    }

    this.emitSkills(resourceLoader);
    this.emitMcpServers();
  }

  private emitReady(): void {
    if (!this.session) {
      return;
    }

    this.options.emit({
      type: "ready",
      model: this.currentModelReference(),
      mode: this.mode,
      agentSessionId: this.session.sessionId,
      ...(this.session.sessionFile != null
        ? { agentSessionFile: this.session.sessionFile }
        : {}),
    });
  }

  /** Current MCP roster, for the desktop's server list. */
  emitMcpServers(): void {
    this.options.emit({
      type: "mcp_servers",
      servers: this.mcp.statuses.map((status) => ({
        id: status.id,
        name: status.name,
        transport: status.transport,
        status: status.status,
        toolCount: status.toolCount,
        ...(status.error ? { error: status.error } : {}),
      })),
    });
  }

  /** Reconnect every server — the desktop's "refresh" action. */
  async refreshMcp(): Promise<void> {
    for (const client of this.mcp.clients) {
      client.close();
    }

    this.mcp = await connectMcpServers(process.env.ABACUSAI_BOT_MCP_CONFIG);
    this.mcp.onStatusChange = () => this.emitMcpServers();
    this.registerNewMcpTools();
    this.emitMcpServers();
  }

  /**
   * Give pi the tools a refresh turned up. Startup tools survive a reconnect
   * through their route getter, but pi takes its custom tool list once, so a
   * server added later is otherwise "connected" with nothing callable.
   * Additive: a tool whose server has gone answers "not connected", which
   * beats a name that silently vanishes.
   */
  private registerNewMcpTools(): void {
    const pi = this.pi;

    if (pi == null) return;

    const excluded = excludedTools();

    for (const tool of buildMcpToolDefinitions(() => this.mcp)) {
      if (this.registeredMcpTools.has(tool.name)) continue;
      if (excluded.includes(tool.name)) continue;
      // Browser tools belong to the sub-agent, which reads them live.
      if (tool.name.startsWith("browser_") && this.browserTaskRegistered)
        continue;
      if (isSupersededWebTool(tool)) continue;

      this.registeredMcpTools.add(tool.name);

      try {
        pi.registerTool(tool as never);
        // Registered mid-turn: pi offers it from the next turn on, so the
        // turn is continued once it ends, naming what arrived.
        if (this.turnRunning) this.toolsArrivedThisTurn.push(tool.name);
      } catch {
        // One server's bad schema must not break the refresh for the rest.
        this.registeredMcpTools.delete(tool.name);
      }
    }
  }

  /** Whether the browser sub-agent owns the browser tools this session. */
  private browserTaskRegistered = false;

  /** The browser tools as the sub-agent would receive them right now. */
  browserToolsForTest(): unknown[] {
    return buildMcpToolDefinitions(() => this.mcp).filter((tool) =>
      tool.name.startsWith("browser_")
    );
  }

  dispose(): void {
    for (const client of this.mcp.clients) {
      client.close();
    }

    this.unsubscribe?.();
    this.session?.dispose();
    this.session = undefined;
  }

  // ---------------------------------------------------------------- commands

  async send(text: string): Promise<void> {
    const session = this.requireSession();

    // The last turn died on credits or credentials. Whatever the user did
    // about it — a key, a top-up, an upgrade — is on disk or on the account
    // by now, and this is the first moment we can act on it.
    if (this.providersStale) {
      this.providersStale = false;
      await this.refreshProviderRegistrations();
    }

    // Edited instructions apply to this turn, not the next session.
    await this.refreshCustomInstructions();

    // Per turn: the same provider failing next turn is news again.
    this.retriedCalls = 0;
    this.interrupted = false;
    this.malformedContinuations = 0;
    this.contextCompactions = 0;
    this.pendingContextCompaction = null;
    this.openLlmRotationsThisTurn = 0;
    this.languageRepairsThisTurn = 0;
    this.pendingLanguageRepair = null;
    this.toolsArrivedThisTurn = [];
    this.pendingToolArrival = null;
    this.toolArrivalsThisTurn = 0;
    this.stallRecoveriesThisTurn = 0;
    this.pendingStall = null;
    this.stallFailureReported = false;
    this.turnRunning = true;
    // A rotation left over from a stopped turn must not fire here.
    this.pendingOpenLlmRotation = null;
    // A new message is a new answer; last turn's decline does not carry over.
    this.planDeclinedThisTurn = false;

    // Where this turn is routed, said as it starts, unless a line is open.
    if (this.openLlmActive && !this.openLlmRouting) {
      const model = this.session?.model;
      this.openRoutingLine(
        this.openLlmModelId ??
          (model != null ? `${model.provider}/${model.id}` : OPENLLM_ID)
      );
    }

    this.emitAgentEvent({
      type: "status_changed",
      status: AgentStatus.Submitted,
    });

    try {
      await session.prompt(text);
      await this.continuePastRecoverableFailures();
      this.reportTurnFailure();
    } catch (error) {
      // A thrown provider error gets the same words as a reported turn
      // failure rather than the raw "429: {json}" envelope.
      const raw = describe(error);
      const provider = isProviderFailure(raw);
      this.emitAgentEvent({
        type: "error",
        error: {
          message: provider ? terminalProviderMessage(raw) : raw,
          ...(provider ? providerDetail(raw) : {}),
          ...this.errorActionsFor(raw),
        },
      });
    }
  }

  /**
   * Surface a turn that failed without throwing: `prompt()` resolves normally
   * and records the failure on the state, so otherwise the agent goes busy
   * then idle with no reply and no reason. A user-requested abort lands the
   * same way and is skipped, or every Stop would paint a terminal error.
   */
  private reportTurnFailure(): void {
    if (this.interrupted || this.stallFailureReported) {
      return;
    }

    // The budget extension aborted the run; pi records that as an error with
    // "This operation was aborted" for text, which reads as a provider fault.
    const budgetStop = budgetStopReason();
    if (budgetStop != null) {
      this.emitAgentEvent({
        type: "error",
        error: { message: budgetStop, code: "turn_failed" },
      });
      return;
    }

    const message = (
      this.session?.state as { errorMessage?: unknown } | undefined
    )?.errorMessage;

    if (typeof message !== "string" || message.length === 0) {
      return;
    }

    this.emitAgentEvent({
      type: "error",
      error: {
        message: terminalProviderMessage(message),
        code: "turn_failed",
        ...providerDetail(message),
        ...this.errorActionsFor(message),
      },
    });
  }

  /**
   * The one error the app can fix for the user: Abacus credits ran out, which
   * renders as the upgrade card. Abacus-served turns only; an OpenRouter user
   * out of credits would be sold the wrong thing.
   */
  private upgradeActionsFor(
    raw: string
  ):
    | { actions: Array<{ type: string; link: string }> }
    | Record<string, never> {
    const provider = this.session?.model?.provider;
    const abacusServed = provider === "abacus" || this.openLlmActive;
    if (isOutOfCredits(raw) || isAuthFailure(raw)) this.providersStale = true;
    if (!abacusServed || !isOutOfCredits(raw)) return {};
    return {
      actions: [{ type: "upgrade-abacus", link: ABACUS_PLAN_URL }],
    };
  }

  /**
   * What the app can offer about a failed turn: the upgrade card when out of
   * credits, a model switch when a pinned model timed out or is overloaded.
   */
  private errorActionsFor(
    raw: string
  ):
    | { actions: Array<{ type: string; link?: string }> }
    | Record<string, never> {
    const actions: Array<{ type: string; link?: string }> = [
      ...(this.upgradeActionsFor(raw).actions ?? []),
    ];
    if (
      !this.openLlmActive &&
      isProviderFailure(raw) &&
      !isOutOfCredits(raw) &&
      classifyProviderFailure(raw).remedy.includes("switch")
    ) {
      actions.push({ type: "switch-model" });
    }
    return actions.length > 0 ? { actions } : {};
  }

  /**
   * Run the turn on past a recoverable failure. The continuation is a custom
   * message, not a second `prompt()`: pi replays it as user text without
   * another copy of the question in the history, and none of it reaches the
   * transcript. `agent_end` has already withheld the idle event, so the
   * continuation does not read as two turns.
   */
  private async continuePastRecoverableFailures(): Promise<void> {
    while (
      this.continuingPastMalformedToolCall ||
      this.pendingContextCompaction != null ||
      this.pendingOpenLlmRotation != null ||
      this.pendingLanguageRepair != null ||
      this.pendingToolArrival != null ||
      this.pendingStall != null
    ) {
      // Stop cancels the continuation, but the withheld idle event still has
      // to go out or the session stays busy forever.
      if (this.interrupted) {
        this.continuingPastMalformedToolCall = false;
        this.pendingContextCompaction = null;
        this.pendingOpenLlmRotation = null;
        this.pendingLanguageRepair = null;
        this.pendingToolArrival = null;
        this.pendingStall = null;
        this.finishTurn();

        return;
      }

      if (this.pendingStall != null) {
        const stalled = this.pendingStall.modelId;
        this.pendingStall = null;
        await this.recoverFromStall(stalled);

        continue;
      }

      if (this.pendingToolArrival != null) {
        const arrived = this.pendingToolArrival;
        this.pendingToolArrival = null;
        this.toolArrivalsThisTurn += 1;

        await this.session?.sendCustomMessage(
          {
            customType: TOOLS_ARRIVED_TYPE,
            content: toolsArrivedPrompt(arrived),
            display: false,
          },
          { triggerTurn: true }
        );

        continue;
      }

      if (this.pendingLanguageRepair != null) {
        const mismatch = this.pendingLanguageRepair;
        this.pendingLanguageRepair = null;
        this.languageRepairsThisTurn += 1;

        this.emitAgentEvent({
          type: "notification",
          severity: "warning",
          message:
            "The model answered in the wrong language — asking it to answer again in yours.",
        });

        await this.session?.sendCustomMessage(
          {
            customType: LANGUAGE_REPAIR_TYPE,
            content: replyLanguageRepairPrompt(mismatch),
            display: false,
          },
          { triggerTurn: true }
        );

        continue;
      }

      if (this.continuingPastMalformedToolCall) {
        this.continuingPastMalformedToolCall = false;
        this.malformedContinuations += 1;

        // A notification, not an `error`: the desktop finalizes on an error.
        this.emitAgentEvent({
          type: "notification",
          severity: "warning",
          message:
            "The model returned a malformed tool call, and the agent is retrying that step.",
        });

        await this.session?.sendCustomMessage(
          {
            customType: MALFORMED_CONTINUATION_TYPE,
            content: MALFORMED_CONTINUATION_PROMPT,
            display: false,
          },
          { triggerTurn: true }
        );

        continue;
      }

      if (this.pendingContextCompaction != null) {
        await this.compactAndRetry();

        continue;
      }

      await this.rotateOpenLlmModel();
    }
  }

  /**
   * The call went quiet for the stall window and was aborted. On the router the
   * model sits out and the next one takes over, as for any failure; a pinned
   * model is asked once more, then the turn ends saying why.
   */
  private async recoverFromStall(modelId: string): Promise<void> {
    const seconds = modelStallMs() / 1000;
    const registry = this.registry;

    if (this.openLlmActive && registry != null) {
      this.openLlmRotation.markFailed(modelId);
      const next = this.openLlmRotation.pick(
        openLlmCandidates(listModels(registry)),
        new Set([modelId])
      );

      if (next != null) {
        this.pendingOpenLlmRotation = {
          // No "." in this: the routing log line keeps the first sentence only.
          failure: `no reply in ${Math.round(seconds)}s`,
          nextId: next.id,
        };

        return;
      }
    }

    if (this.stallRecoveriesThisTurn < MAX_STALL_RECOVERIES_PER_TURN) {
      this.stallRecoveriesThisTurn += 1;
      // Logged, not shown: the chat carries the answer, not the retry.
      process.stderr.write(
        `[provider] ${modelId} stopped answering after ${seconds}s — asking it again.\n`
      );
      await this.session?.sendCustomMessage(
        {
          customType: STALL_CONTINUATION_TYPE,
          content: STALL_CONTINUATION_PROMPT,
          display: false,
        },
        { triggerTurn: true }
      );

      return;
    }

    this.stallFailureReported = true;
    this.emitAgentEvent({
      type: "error",
      error: {
        message: `The model stopped answering (no output for ${seconds}s). Try again, or switch to a different model.`,
        code: "turn_failed",
        actions: [{ type: "switch-model" }],
      },
    });
    this.finishTurn();
  }

  /** Which pi events mean a model call is (still) being waited on. */
  private noteModelActivity(type: string): void {
    switch (type) {
      case "agent_start":
      case "message_start":
      case "tool_execution_end":
        this.awaitingModel = true;
        this.armStallTimer();

        return;
      case "message_end":
      case "tool_execution_start":
      case "agent_end":
        this.awaitingModel = false;
        this.clearStallTimer();

        return;
      default:
        // A delta of any kind is proof of life.
        if (this.awaitingModel) this.armStallTimer();
    }
  }

  private armStallTimer(): void {
    this.clearStallTimer();

    if (!this.turnRunning) return;

    this.stallTimer = setTimeout(() => {
      this.stallTimer = null;
      void this.onModelStall();
    }, modelStallMs());
  }

  private clearStallTimer(): void {
    if (this.stallTimer != null) clearTimeout(this.stallTimer);
    this.stallTimer = null;
  }

  private async onModelStall(): Promise<void> {
    if (!this.turnRunning || this.interrupted || !this.awaitingModel) return;

    const model = this.session?.model;
    const modelId = model ? `${model.provider}/${model.id}` : "the model";

    this.awaitingModel = false;
    this.pendingStall = { modelId };
    process.stderr.write(
      `[abacusai-bot-agent] ${modelId} produced nothing for ${modelStallMs() / 1000}s — aborting the call\n`
    );
    // Not Stop: `interrupted` stays false so the continuation can run.
    await this.session?.abort();
  }

  /**
   * Shorten the history the provider just refused and run the turn again: the
   * refusal is the only authority on the real limit, since pi's threshold uses
   * a guessed window and the *previous* turn's usage. Same model (the
   * transcript failed, not the provider), one attempt per turn, and silent.
   */
  private async compactAndRetry(): Promise<void> {
    const pending = this.pendingContextCompaction;
    const session = this.session;

    this.pendingContextCompaction = null;

    if (pending == null || session == null) return;

    this.contextCompactions += 1;

    try {
      await session.compact();
    } catch {
      // Nothing older than the recency window to summarize. Another pool
      // model may have room for the transcript as it stands, so try that
      // before anything reaches the user.
      this.pendingOpenLlmRotation = this.shouldRotateOpenLlm(pending.messages);

      if (this.pendingOpenLlmRotation != null) return;

      this.emitAgentEvent({
        type: "error",
        error: {
          message: terminalProviderMessage(pending.failure),
          code: "turn_failed",
        },
      });
      this.finishTurn();

      return;
    }

    // Stop can land during the (slow) summary; continuing would make Stop
    // not stop.
    if (this.interrupted) {
      this.finishTurn();

      return;
    }

    await session.sendCustomMessage(
      {
        customType: COMPACTION_CONTINUATION_TYPE,
        content: COMPACTION_CONTINUATION_PROMPT,
        display: false,
      },
      { triggerTurn: true }
    );
  }

  /**
   * The failure to compact around, or null. Decided at `agent_end` because
   * the idle event a continuation must suppress is emitted from that handler.
   */
  private shouldCompactAndRetry(
    messages: readonly unknown[]
  ): { failure: string; messages: readonly unknown[] } | null {
    if (this.interrupted || this.contextCompactions > 0) return null;

    const failure = endedOnProviderError(messages);

    if (failure == null) return null;

    return CONTEXT_LENGTH_PATTERN.test(failure.toLowerCase())
      ? { failure, messages }
      : null;
  }

  /**
   * Move OpenLLM to its next model and run the turn on. The decision was made
   * at `agent_end` (shouldRotateOpenLlm); this carries it out with a custom
   * message, for the same reasons as the malformed-call continuation.
   */
  private async rotateOpenLlmModel(): Promise<void> {
    const rotation = this.pendingOpenLlmRotation;

    this.pendingOpenLlmRotation = null;

    const runtime = this.modelRuntime;
    const session = this.session;

    if (rotation == null || runtime == null || session == null) return;

    const failed = session.model;
    const failedId = failed ? `${failed.provider}/${failed.id}` : undefined;

    if (failedId != null) this.openLlmRotation.markFailed(failedId);
    this.openLlmRotationsThisTurn += 1;

    const resolved = resolveModel(
      runtime,
      rotation.nextId,
      this.maxOutputTokens
    );

    if (resolved.model == null) {
      // Should not happen: the candidate came off the live registry moments
      // ago. The idle event was withheld for this rotation, so end the turn.
      this.closeRoutingLine(
        `Routing failed (${compactProviderError(rotation.failure)}) — no model left in the pool.`,
        "warning"
      );
      this.emitAgentEvent({
        type: "error",
        error: {
          message: terminalProviderMessage(
            rotation.failure,
            "No other free model was left to try."
          ),
          code: "turn_failed",
        },
      });
      this.finishTurn();

      return;
    }

    await session.setModel(resolved.model);

    // Stop can land while setModel is in flight; end the turn rather than
    // continue, since agent_end withheld the idle event for this rotation.
    if (this.interrupted) {
      this.finishTurn();

      return;
    }

    this.emitRoutingLine(
      `${failedId ?? "the model"} failed (${compactProviderError(rotation.failure)}) — routing to ${rotation.nextId}…`,
      "warning"
    );
    this.openLlmRoutingTarget = rotation.nextId;
    this.emitAgentEvent({
      type: "model_changed",
      model: this.currentModelReference(),
    });

    await session.sendCustomMessage(
      {
        customType: OPENLLM_CONTINUATION_TYPE,
        content: OPENLLM_CONTINUATION_PROMPT,
        display: false,
      },
      { triggerTurn: true }
    );
  }

  /**
   * Whether the turn that just ended continues on another free model, and
   * which. Decided at `agent_end`, where the idle event it suppresses is
   * emitted; the candidate is picked here so that promise is never made for a
   * fallback that does not exist.
   */
  private shouldRotateOpenLlm(
    messages: readonly unknown[]
  ): { failure: string; nextId: string } | null {
    if (
      !this.openLlmActive ||
      this.interrupted ||
      this.openLlmRotationsThisTurn >= MAX_OPENLLM_ROTATIONS_PER_TURN
    ) {
      if (this.openLlmActive && !this.interrupted) {
        process.stderr.write(
          `[abacusai-bot-agent] pool not rotating: ${this.openLlmRotationsThisTurn} rotations already this turn\n`
        );
      }

      return null;
    }

    const failure = endedOnProviderError(messages);

    if (failure == null) return null;

    const registry = this.registry;
    const current = this.session?.model;
    const currentId = current ? `${current.provider}/${current.id}` : undefined;
    // Before picking: an account-wide failure is not this model's, and a
    // sibling sharing the allowance would fail the same way.
    const scope = accountWideFailure(failure, current?.provider);

    if (scope != null) this.openLlmRotation.markScopeFailed(scope);

    const next =
      registry != null
        ? this.openLlmRotation.pick(
            openLlmCandidates(listModels(registry)),
            currentId != null ? new Set([currentId]) : undefined
          )
        : undefined;

    if (next == null) {
      process.stderr.write(
        `[abacusai-bot-agent] pool not rotating after "${failure.slice(0, 80)}": no other candidate (current ${currentId ?? "?"})\n`
      );
    }

    return next != null ? { failure, nextId: next.id } : null;
  }

  /**
   * Whether the turn died on a mangled tool call with budget left to retry.
   * Read off `agent_end`'s messages: the decision is needed as the turn ends.
   */
  private shouldContinuePastMalformedToolCall(
    messages: readonly unknown[]
  ): boolean {
    if (
      this.interrupted ||
      this.malformedContinuations >= MAX_MALFORMED_CONTINUATIONS
    ) {
      return false;
    }

    return endedOnMalformedToolCall(messages);
  }

  /**
   * Start the routing episode on the model about to be tried. Open until the
   * model proves it is answering (`settleRoutingLine`) or the pool runs out
   * (`closeRoutingLine`).
   */
  private openRoutingLine(modelId: string): void {
    this.openLlmRoutingTarget = modelId;
    this.openLlmModelId = modelId;
    this.emitRoutingLine(`Routing to ${modelId}…`, "info");
  }

  /** Record a routing step, opening an episode if none is. */
  private emitRoutingLine(message: string, severity: "info" | "warning"): void {
    this.openLlmRouting = true;
    // Which model the pool picked, and which one failed, is the router's
    // business: the user chose "openllm/auto" so as not to think about it.
    // The step goes to the log, never the chat.
    process.stderr.write(`[openllm] ${severity}: ${message}\n`);
  }

  /**
   * The model is answering, so the line becomes the record of where the turn
   * ran. Called on the first token or tool call rather than at turn end.
   */
  private settleRoutingLine(): void {
    if (!this.openLlmRouting) return;
    const target = this.openLlmRoutingTarget;

    // Proof this model works; otherwise its failure count only ever climbs.
    if (target != null) this.openLlmRotation.markSucceeded(target);
    this.emitRoutingLine(
      target == null ? "Routed." : `Routed to ${target}.`,
      "info"
    );
    this.openLlmRouting = false;
    this.openLlmRoutingTarget = null;
  }

  /** End the line on a failure: the pool is out of models to try. */
  private closeRoutingLine(
    message: string,
    severity: "info" | "warning"
  ): void {
    this.emitRoutingLine(message, severity);
    this.openLlmRouting = false;
    this.openLlmRoutingTarget = null;
  }

  /**
   * Log a provider call that failed even though the turn went on: a retried
   * call otherwise leaves no trace but a silent pause. The chat shows the
   * turn's outcome, not its retries; the provider's text stays in the session
   * file.
   */
  private reportFailedCall(message: unknown): void {
    const failed = message as { stopReason?: unknown; errorMessage?: unknown };

    if (failed?.stopReason !== "error") {
      return;
    }

    // A run the budget stopped is not being retried; reportTurnFailure says why.
    if (budgetStopReason() != null) {
      return;
    }

    const text =
      typeof failed.errorMessage === "string" ? failed.errorMessage.trim() : "";

    if (text.length === 0) {
      return;
    }

    // OpenLLM narrates its own failures during a routing episode.
    if (this.openLlmRouting) {
      return;
    }

    // An outgrown window is compacted silently (compactAndRetry); if even a
    // summary will not fit, the turn ends on an error that says what to do.
    if (CONTEXT_LENGTH_PATTERN.test(text.toLowerCase())) {
      return;
    }

    // A request over a tier's size cap fails the same way every time; the
    // terminal message says what to do, and "retrying" would be a false hope.
    if (
      /^\s*413\b/.test(text) ||
      REQUEST_TOO_LARGE_PATTERN.test(text.toLowerCase())
    ) {
      return;
    }

    this.retriedCalls += 1;
    process.stderr.write(
      `[provider] ${providerFailureSummary(text)} — retrying (attempt ${this.retriedCalls + 1}).\n`
    );
  }

  /**
   * Close out a turn: fail any open subtask brackets, drop per-turn state, go
   * idle. A component whose tool_execution_end never came would otherwise spin
   * in the Agents pane forever, so it closes as a failure, not a checkmark.
   */
  private finishTurn(): void {
    this.turnRunning = false;
    this.clearStallTimer();
    this.awaitingModel = false;
    for (const subtaskId of this.componentSubtasks.values()) {
      this.emitAgentEvent({
        type: "subtask_end",
        id: subtaskId,
        status: "failed",
      });
    }

    this.componentSubtasks.clear();
    this.toolInputs.clear();
    this.heartbeat.clear();
    this.emitAgentEvent({
      type: "turn_complete",
      ...(this.lastTurnUsage != null ? { usage: this.lastTurnUsage } : {}),
    });
    this.lastTurnUsage = null;
    this.emitAgentEvent({
      type: "status_changed",
      status: AgentStatus.Idle,
    });
  }

  /**
   * Mid-turn input. pi keeps its own steering queue; the text is remembered
   * here so its arrival (a user message_start) can be reported to the desktop.
   */
  async steer(text: string): Promise<void> {
    this.pendingSteers.push(text);
    await this.requireSession().steer(text);
  }

  /**
   * Forget every undelivered steer, so a leftover message the host runs as
   * its own turn is not also injected as a steer and seen twice.
   */
  dropSteers(): void {
    this.pendingSteers.length = 0;
    this.session?.clearQueue();
  }

  /** A user message pi just started is one of ours if the text matches. */
  private noteSteerLanded(message: unknown): void {
    if ((message as { role?: unknown } | undefined)?.role !== "user") return;
    const text = messageText(message);
    const index = this.pendingSteers.indexOf(text);
    if (index === -1) return;
    this.pendingSteers.splice(index, 1);
    this.emitAgentEvent({ type: "user_message_steered", content: text });
  }

  async stop(): Promise<void> {
    // The turn about to end was stopped, not failed; see reportTurnFailure.
    this.interrupted = true;

    // An unanswered approval would keep the tool hook parked forever.
    this.rejectAllPending("Interrupted.");

    // Same for a host service still working: its promise would hold the turn
    // open until its own timeout minutes later.
    this.hostServices.failAll("Interrupted.");

    // Anything in pi's queues (a steer, an extension's `triggerTurn` follow-up)
    // is delivered as soon as the agent goes idle and starts another turn, so
    // Stop would not stop.
    this.pendingSteers.length = 0;
    this.session?.clearQueue();
    await this.session?.abort();
    // Again after the abort: the settle hooks can queue too.
    this.session?.clearQueue();
    // A background job's "it finished" was in there too; have it said again.
    notifyConversationQueueCleared();
    // Nothing is still running, so no pending call's arguments are wanted.
    this.toolInputs.clear();
    this.heartbeat.clear();
  }

  setMode(raw: string): void {
    const next = parseModeStrict(raw);

    // An unknown name stays put rather than silently landing on Normal, the
    // mode that asks least.
    if (next == null) {
      this.emitAgentEvent({
        type: "notification",
        severity: "warning",
        message: `"${raw}" is not a mode. Use one of: ${MODE_NAMES.join(", ")}. Staying in ${this.mode.toLowerCase()}.`,
      });
      this.emitAgentEvent({
        type: "mode_changed",
        mode: this.mode,
        source: "user",
      });

      return;
    }

    this.applyMode(next, "user");
  }

  /**
   * THE write path for the permission mode. The mode decides what the agent
   * may do without asking, so every switch is also a log entry: "when did
   * this become Yolo, and who did it" must be answerable. Custom entries are
   * excluded from the model's context, so this costs no tokens.
   */
  private applyMode(
    next: AgentMode,
    source: "startup" | "user" | "approval"
  ): void {
    const previous = this.mode;
    this.mode = next;
    setCurrentMode(next);

    // A no-op switch is not history; startup is recorded either way.
    if (previous !== next || source === "startup") {
      try {
        this.pi?.appendEntry("abacusai-bot-mode", {
          from: previous,
          to: next,
          source,
          at: Date.now(),
        });
      } catch {
        // The mode change itself must not fail over its own audit line.
      }
    }

    this.emitAgentEvent({ type: "mode_changed", mode: next, source });
  }

  /**
   * Re-read keys and catalogs mid-session. The desktop sends this when the
   * stored credentials change, so a key added now works in the chat already
   * open rather than only in the next one.
   */
  async refreshProviders(): Promise<void> {
    await this.refreshProviderRegistrations();
  }

  async setModel(reference: string): Promise<void> {
    try {
      await this.applyModel(reference);
    } catch (error) {
      // The desktop keys on `model_unavailable` to release the pick the picker
      // is holding; a throw without that code leaves it held in silence.
      this.emitAgentEvent({
        type: "error",
        error: {
          message: `Could not switch to ${reference}: ${
            error instanceof Error ? error.message : String(error)
          }`,
          code: "model_unavailable",
        },
      });
    }
  }

  private async applyModel(reference: string): Promise<void> {
    const session = this.requireSession();

    if (!this.modelRuntime) {
      return;
    }

    if (isOpenLlmReference(reference)) {
      await this.activateOpenLlm(session);

      return;
    }

    // Picking a concrete model is leaving the router, not steering it.
    this.openLlmActive = false;

    let resolved = resolveModel(
      this.modelRuntime,
      reference,
      this.maxOutputTokens
    );

    if (!resolved.model) {
      // The registrations are a snapshot from start(); the desktop's picker
      // re-reads config.json and the Abacus catalog live, so a model it just
      // offered can be unknown here. Refresh and try once more.
      await this.refreshProviderRegistrations();
      resolved = resolveModel(
        this.modelRuntime,
        reference,
        this.maxOutputTokens
      );
    }

    // A key added since this process started is on disk but not yet in the
    // runtime, so "no credentials" is worth one refresh before it is an answer.
    if (
      resolved.model != null &&
      this.registry?.hasConfiguredAuth(resolved.model) === false
    ) {
      await this.refreshProviderRegistrations();
      resolved = resolveModel(
        this.modelRuntime,
        reference,
        this.maxOutputTokens
      );
    }

    if (!resolved.model) {
      this.emitAgentEvent({
        type: "error",
        error: {
          message: resolved.error ?? `Unknown model: ${reference}`,
          code: "model_unavailable",
        },
      });

      return;
    }

    // Running a different model than the one just chosen is never the answer:
    // a turn on the model they were trying to get away from reads as the pick
    // having done nothing. Say which key is missing and keep the current model.
    if (this.registry?.hasConfiguredAuth(resolved.model) === false) {
      this.emitAgentEvent({
        type: "error",
        error: {
          message: missingKeyMessage(reference, resolved.model.provider),
          code: "model_unavailable",
        },
      });

      return;
    }

    await session.setModel(resolved.model);
    this.emitAgentEvent({
      type: "model_changed",
      model: this.currentModelReference(),
    });
  }

  /**
   * Put the session on OpenLLM: run on the best free model right now, while
   * `currentModelReference` keeps reporting the router's id so the picker
   * highlights what the user actually chose.
   */
  private async activateOpenLlm(session: AgentSession): Promise<void> {
    const runtime = this.modelRuntime;
    const registry = this.registry;

    if (runtime == null || registry == null) return;

    const choice = this.openLlmRotation.pick(
      openLlmCandidates(listModels(registry))
    );
    const resolved =
      choice != null
        ? resolveModel(runtime, choice.id, this.maxOutputTokens)
        : undefined;

    if (resolved?.model == null) {
      this.emitAgentEvent({
        type: "error",
        error: {
          message:
            "OpenLLM needs at least one source — add an OpenRouter, Google AI Studio, or Abacus.AI key in Settings.",
          code: "model_unavailable",
        },
      });

      return;
    }

    this.openLlmActive = true;
    await session.setModel(resolved.model);
    this.openRoutingLine(choice?.id ?? resolved.model.id);
    this.emitAgentEvent({
      type: "model_changed",
      model: this.currentModelReference(),
    });
  }

  /**
   * Re-register every provider whose definition can change under a running
   * process. Safe to repeat. The config is re-read into a local, not into
   * `this.config`: that also feeds the permission allowlists, which a file
   * edit must not widen mid-session as a side effect of picking a model.
   */
  private async refreshProviderRegistrations(): Promise<void> {
    const registry = this.registry;

    if (!registry) {
      return;
    }

    // Keys the desktop saved after this process started are on disk only:
    // `applyStoredApiKeys` runs once at startup, and pi's built-in providers
    // took their credentials from the environment as it was then. Re-read the
    // file, then hand pi each key it owns — the same re-read on every call
    // that makes registerGeminiProvider pick a Gemini key up.
    applyStoredApiKeys();
    await this.applyRuntimeApiKeys();
    registerCustomProviders(registry, loadConfig());
    registerGeminiProvider(registry);
    await registerAbacusProvider(registry);
    // Whatever sidelined a model or a whole provider may no longer hold: the
    // account's credits, plan or keys just changed under us.
    this.openLlmRotation.clearCooldowns();
  }

  /** Stored keys into the live runtime, for the providers pi owns. */
  private async applyRuntimeApiKeys(): Promise<void> {
    const runtime = this.modelRuntime;

    if (runtime == null) {
      return;
    }

    for (const [provider, envVar] of Object.entries(PROVIDER_API_KEY_ENV)) {
      const key = (process.env[envVar] ?? "").trim();

      if (key.length === 0 || runtime.hasConfiguredAuth(provider)) continue;

      try {
        await runtime.setRuntimeApiKey(provider, key);
      } catch (error) {
        // One provider pi does not know (or refuses) must not stop the rest.
        process.stderr.write(
          `[abacusai-bot-agent] could not apply the ${provider} key: ${
            error instanceof Error ? error.message : String(error)
          }\n`
        );
      }
    }
  }

  respondPermission(permissionId: string, decision: PermissionDecision): void {
    const pending = this.pending.get(permissionId);

    if (!pending) {
      return;
    }

    this.pending.delete(permissionId);
    pending.resolve(decision);
  }

  /** Start a fresh conversation, discarding the transcript but keeping the process. */
  async resetConversation(): Promise<void> {
    this.interrupted = true;
    this.rejectAllPending("Conversation reset.");
    // As in `stop`: a queued message must not land in the fresh conversation.
    this.pendingSteers.length = 0;
    this.session?.clearQueue();
    await this.session?.abort();
    this.session?.clearQueue();

    // Aborting leaves pi's transcript intact and billed on the next prompt;
    // the only clean slate pi offers is a new AgentSession.
    if (this.sessionInit != null) {
      const model = this.session?.model;
      this.unsubscribe?.();
      this.session?.dispose();

      // The saved session must not come back on a reset; the file is replaced
      // so the next restart resumes from here.
      const fresh = conversationSessionManager(this.options.cwd, {
        fresh: true,
      });
      if (fresh != null) this.sessionInit.sessionManager = fresh;

      const created = await createAgentSession({
        ...this.sessionInit,
        ...(model ? { model } : {}),
      });

      this.session = created.session;
      anchorCompactions(this.session.sessionManager);
      this.unsubscribe = this.session.subscribe((event) =>
        this.onPiEvent(event)
      );
      this.streamedText = "";
      this.currentMessageId = null;
      this.componentSubtasks.clear();
      this.toolInputs.clear();
      this.heartbeat.clear();
      // The desktop keys the conversation on the session ids from `ready`.
      this.emitReady();
    }

    this.emitAgentEvent({ type: "segments_cleared" });
    this.emitAgentEvent({ type: "status_changed", status: AgentStatus.Idle });
  }

  // ------------------------------------------------------------- pi -> desktop

  private onPiEvent(event: AgentSessionEvent): void {
    // Every pi event on stderr, for turns with no visible output. stdout is
    // the protocol.
    if (process.env.ABACUSAI_BOT_AGENT_DEBUG === "1") {
      process.stderr.write(`[pi] ${event.type}\n`);
    }

    this.noteModelActivity(event.type);

    switch (event.type) {
      case "agent_start":
        this.emitAgentEvent({
          type: "status_changed",
          status: AgentStatus.Streaming,
        });

        return;

      case "message_start":
        this.noteSteerLanded(event.message);
        if (isAssistantMessage(event.message)) {
          this.streamedText = "";
          this.currentMessageId = `msg-${++this.messageCounter}`;
        }

        return;

      case "message_update": {
        this.onStreamEvent(event.assistantMessageEvent);

        return;
      }

      case "message_end": {
        // Some providers deliver the message whole here with no deltas, so the
        // *remainder* past the streamed text is emitted: nothing for a streamed
        // message, everything for an unstreamed one. Fires for EVERY message.
        if (!isAssistantMessage(event.message)) {
          return;
        }

        this.reportFailedCall(event.message);

        const full = messageText(event.message);
        // A final text that does not extend the deltas means an extension
        // replaced the message (tool-call-repair); re-emitting would duplicate
        // the prose already shown.
        const remainder = full.startsWith(this.streamedText)
          ? full.slice(this.streamedText.length)
          : "";

        if (remainder.length > 0) {
          this.emitAgentEvent({
            type: "text_delta",
            content: remainder,
            messageId: this.messageId(),
          });
        }

        this.streamedText = "";
        // The next delta belongs to a new message even if its start is missed.
        this.currentMessageId = null;

        return;
      }

      case "tool_execution_start": {
        const tool = this.toToolRequest(
          event.toolCallId,
          event.toolName,
          event.args
        );

        // A component run is a sub-agent in everything but transport, so it is
        // bracketed for the Agents pane rather than a silent minute-long stall.
        const description = componentSubtaskDescription(
          event.toolName,
          tool.input
        );

        if (description != null) {
          const subtaskId = `component-${event.toolCallId}`;

          this.componentSubtasks.set(event.toolCallId, subtaskId);
          this.emitAgentEvent({
            type: "subtask_start",
            id: subtaskId,
            description,
            kind: "component",
          });
        }

        this.toolInputs.set(event.toolCallId, tool.input);
        this.heartbeat.started(event.toolCallId);

        // A tool call is as much proof the provider answered as a token is.
        this.settleRoutingLine();
        this.emitAgentEvent({
          type: "status_changed",
          status: AgentStatus.ExecutingTool,
        });
        this.emitAgentEvent({ type: "tool_execution_start", tool });

        return;
      }

      case "tool_execution_update": {
        // Long-running bash streams its output; the tool card shows it live.
        const partial = event.partialResult;

        if (typeof partial === "string" && partial.length > 0) {
          this.emitAgentEvent({
            type: "tool_output_update",
            toolCallId: event.toolCallId,
            output: partial,
          });
        }

        return;
      }

      case "tool_execution_end": {
        const tool = this.toToolRequest(
          event.toolCallId,
          event.toolName,
          this.toolInputs.get(event.toolCallId) ?? {}
        );

        this.toolInputs.delete(event.toolCallId);
        this.heartbeat.ended(event.toolCallId);
        this.emitAgentEvent({
          type: "tool_execution_complete",
          tool,
          result: {
            id: event.toolCallId,
            content: resultText(event.result),
            rejected: event.isError,
          },
        });

        // After the result, so the finished card is attributed to the bracket.
        const subtaskId = this.componentSubtasks.get(event.toolCallId);

        if (subtaskId != null) {
          this.componentSubtasks.delete(event.toolCallId);
          this.emitAgentEvent({
            type: "subtask_end",
            id: subtaskId,
            status: event.isError === true ? "failed" : "completed",
          });
        }

        return;
      }

      case "agent_end": {
        // The end of a call this session aborted for going silent; the loop
        // in `send` decides what runs next, and the idle event waits for it.
        if (this.pendingStall != null) {
          this.lastTurnUsage = turnUsage(event.messages as never);

          return;
        }

        // Decided here: a continuation must suppress the idle event emitted below.
        this.continuingPastMalformedToolCall =
          this.shouldContinuePastMalformedToolCall(event.messages);
        this.lastTurnUsage = turnUsage(event.messages as never);
        // A malformed call is retried on the same model, not rotated. Compaction
        // comes before rotation too: an outgrown transcript does not fit the
        // next model either, and the pool is not ordered by context window.
        this.pendingContextCompaction = this.continuingPastMalformedToolCall
          ? null
          : this.shouldCompactAndRetry(event.messages);
        this.pendingOpenLlmRotation =
          this.continuingPastMalformedToolCall ||
          this.pendingContextCompaction != null
            ? null
            : this.shouldRotateOpenLlm(event.messages);
        // Only a turn that ended cleanly is judged on its language.
        this.pendingLanguageRepair =
          this.continuingPastMalformedToolCall ||
          this.pendingContextCompaction != null ||
          this.pendingOpenLlmRotation != null ||
          this.languageRepairsThisTurn > 0
            ? null
            : replyLanguageMismatch(event.messages);
        // Tools that arrived while this turn ran are offered from the next
        // turn on; continue into it so the user's request is finished with
        // them rather than declared impossible. Once per turn.
        this.pendingToolArrival =
          this.continuingPastMalformedToolCall ||
          this.pendingContextCompaction != null ||
          this.pendingOpenLlmRotation != null ||
          this.pendingLanguageRepair != null ||
          this.toolArrivalsThisTurn > 0 ||
          this.toolsArrivedThisTurn.length === 0
            ? null
            : [...new Set(this.toolsArrivedThisTurn)];
        this.toolsArrivedThisTurn = [];

        if (
          !event.willRetry &&
          !this.continuingPastMalformedToolCall &&
          this.pendingContextCompaction == null &&
          this.pendingOpenLlmRotation == null &&
          this.pendingLanguageRepair == null &&
          this.pendingToolArrival == null
        ) {
          this.finishTurn();
        }

        return;
      }

      case "auto_retry_start":
        // On the router the cap in capRetriesWhileRouting should leave one
        // attempt; a session in the field showed three and never rotated.
        // Enough on stderr (synced with the logs) to settle that next time.
        if (this.openLlmActive) {
          const current = this.session?.model;
          process.stderr.write(
            `[abacusai-bot-agent] pool retry ${event.attempt}/${event.maxAttempts} on ${current ? `${current.provider}/${current.id}` : "?"} (routing=${this.openLlmActive}): ${event.errorMessage.slice(0, 120)}\n`
          );
        }
        this.emitAgentEvent({
          type: "retry",
          attempt: event.attempt,
          maxAttempts: event.maxAttempts,
          delayMs: event.delayMs,
          isNetworkError: /network|fetch|ECONN|timeout/i.test(
            event.errorMessage
          ),
        });

        return;

      default:
        return;
    }
  }

  private onStreamEvent(streamEvent: { type: string; delta?: string }): void {
    switch (streamEvent.type) {
      case "text_delta":
        if (streamEvent.delta) {
          this.settleRoutingLine();
          this.streamedText += streamEvent.delta;
          this.emitAgentEvent({
            type: "text_delta",
            content: streamEvent.delta,
            messageId: this.messageId(),
          });
        }

        return;

      case "thinking_delta":
        if (streamEvent.delta) {
          this.settleRoutingLine();
          this.emitAgentEvent({
            type: "thinking_delta",
            content: streamEvent.delta,
          });
        }

        return;

      case "thinking_end":
        this.emitAgentEvent({ type: "thinking_complete" });

        return;

      default:
        return;
    }
  }

  // ------------------------------------------------------------- approval flow

  /**
   * The approval gate, as a pi extension. A promise returned from `tool_call`
   * suspends the call until it settles, which is what makes a blocking prompt
   * possible and also what parks the turn when nobody is attached to answer,
   * so an unanswered request expires as a rejection.
   */
  private readonly permissionExtension = (pi: ExtensionAPI): void => {
    // The gate is loaded in every configuration, so it is the only safe place
    // to take the audit handle.
    this.pi = pi;
    // The opening mode, so the log is a complete account rather than deltas.
    this.applyMode(this.mode, "startup");

    pi.on("tool_call", async (event, ctx) => {
      const tool = this.toToolRequest(
        event.toolCallId,
        event.toolName,
        event.input as Record<string, unknown>
      );

      const gate = gateToolCall(tool, {
        mode: this.mode,
        cwd: ctx.cwd,
        allowedCommands: [
          ...(this.config.allowedCommands ?? []),
          ...this.sessionAllowedCommands,
        ],
        allowedTools: [...this.sessionAllowedTools],
        allowedReadPaths: [
          ...(this.config.allowedReadPaths ?? []),
          ...this.sessionAllowedReadPaths,
        ],
        allowedWritePaths: [...this.sessionAllowedWritePaths],
        allowedOrigins: [...this.sessionAllowedOrigins],
      });

      if (gate.kind === "allow") {
        return;
      }

      // Asked and answered; the same card again talks over the user.
      if (tool.name === EXIT_PLAN_TOOL_NAME && this.planDeclinedThisTurn) {
        return {
          block: true,
          reason:
            "You already asked to start this turn and the user declined. Reply to them and wait " +
            "for what they say next — do not ask again.",
        };
      }

      if (gate.kind === "refuse") {
        return { block: true, reason: gate.reason };
      }

      const permissionId = `perm-${++this.permissionCounter}`;

      // Before/after content up front, so the card shows the diff at once.
      if (gate.request.type === "edit_file") {
        this.emitAgentEvent({
          type: "tool_display_data",
          toolCallId: event.toolCallId,
          data: {
            originalContent: gate.request.originalContent,
            newContent: gate.request.newContent,
          },
        });
      }

      // If the answer channel is already gone, reject now rather than wait out
      // the timeout for an answer that cannot arrive.
      if (!this.canReachUser()) {
        this.recordApproval(pi, {
          stage: "decided",
          permissionId,
          toolName: event.toolName,
          outcome: "rejected",
          detail: "no-answerer",
        });

        return {
          block: true,
          reason:
            `${tool.name} needs approval, but this session has no way to ask — ` +
            `the app is not attached. Do only what runs without approval, or tell ` +
            `the user what you need them to allow.`,
        };
      }

      this.recordApproval(pi, {
        stage: "asked",
        permissionId,
        toolName: event.toolName,
        detail: gate.request.type,
      });

      this.options.emit({
        type: "permission_needed",
        permissionId,
        request: gate.request,
      });
      this.emitAgentEvent({
        type: "status_changed",
        status: AgentStatus.WaitingForToolPermission,
      });

      const decision = await new Promise<PermissionDecision>((resolve) => {
        const budget = approvalTimeoutMs();
        // Infinity is the opt-out and must not reach setTimeout, which treats
        // an out-of-range delay as 1ms.
        const timer = Number.isFinite(budget)
          ? setTimeout(() => {
              // Drop it first, so a late answer racing the expiry finds nothing.
              this.pending.delete(permissionId);
              this.emitAgentEvent({ type: "permission_cleared", permissionId });
              resolve({
                type: "reject_with_message",
                message:
                  `No answer after ${Math.round(budget / 60_000)} minutes, so this was not approved. ` +
                  `Do not retry the same call — say what you need approved and stop.`,
              });
            }, budget)
          : undefined;
        // A pending approval should never be the reason the process survives.
        timer?.unref?.();

        this.pending.set(permissionId, {
          resolve: (answer) => {
            if (timer) clearTimeout(timer);
            resolve(answer);
          },
        });
      });

      this.recordApproval(pi, {
        stage: "decided",
        permissionId,
        toolName: event.toolName,
        outcome: typeof decision === "string" ? decision : decision.type,
      });

      return this.applyDecision(decision, tool, gate.request);
    });
  };

  /** Whether an approval can still reach a person: stdout IS the protocol. */
  private canReachUser(): boolean {
    return !process.stdout.destroyed && process.stdout.writable;
  }

  /**
   * One audit line per approval, in the pi session rather than the desktop
   * protocol: a durable record, excluded from the model's context. Every ask
   * gets a matching decision, including the ones no human made.
   */
  private recordApproval(
    pi: ExtensionAPI,
    record: {
      stage: "asked" | "decided";
      permissionId: string;
      toolName: string;
      outcome?: string;
      detail?: string;
    }
  ): void {
    try {
      pi.appendEntry("abacusai-bot-approval", {
        ...record,
        mode: this.mode,
        at: Date.now(),
      });
    } catch {
      // An unwritable audit line must not take the tool call with it.
    }
  }

  /**
   * Set when the user declines to start this turn. One question per turn:
   * after that the refusal comes back without another card.
   */
  private planDeclinedThisTurn = false;

  /**
   * What the answer to "implement this plan?" means. The three yeses map onto
   * modes: approve-each-edit is Normal, accept-all is AcceptEdits, everything
   * is Yolo. No keeps planning, hence a block rather than the generic rejection.
   */
  private applyPlanDecision(
    decision: PermissionDecision
  ): { block: true; reason: string } | undefined {
    const answer = typeof decision === "string" ? decision : decision.type;

    switch (answer) {
      case "accept":
      case "accept_with_message":
        this.applyMode(AgentMode.Normal, "approval");

        return undefined;

      case "allowAlways":
        this.applyMode(AgentMode.AcceptEdits, "approval");

        return undefined;

      case "allowYolo":
        this.applyMode(AgentMode.Yolo, "approval");

        return undefined;

      default:
        this.planDeclinedThisTurn = true;

        return {
          block: true,
          reason:
            "The user is not ready to start. Stay in plan mode: refine the plan or ask what they want changed. " +
            "Do not ask again this turn — reply to them and wait.",
        };
    }
  }

  private applyDecision(
    decision: PermissionDecision,
    tool: ToolRequest,
    request: PermissionRequest
  ): { block: true; reason: string } | undefined {
    // Leaving plan mode is a different question: here "always" means accept
    // every edit from now on, not "never ask about this tool again".
    if (tool.name === EXIT_PLAN_TOOL_NAME) {
      return this.applyPlanDecision(decision);
    }

    if (typeof decision === "string") {
      switch (decision) {
        case "accept":
        case "background":
          return undefined;

        case "allowYolo":
          this.applyMode(AgentMode.Yolo, "approval");

          return undefined;

        case "allowAlways":
          this.rememberAllowance(tool, request);

          return undefined;

        default:
          return { block: true, reason: "The user rejected this tool call." };
      }
    }

    switch (decision.type) {
      case "accept_with_message":
        // Approved, but with a correction the model needs before it acts again.
        void this.steer(decision.message).catch(() => undefined);

        return undefined;

      case "reject_with_message":
        return {
          block: true,
          reason: `The user rejected this tool call: ${decision.message}`,
        };

      case "allow_always_with_rule":
        this.sessionAllowedCommands.push(decision.rule);

        return undefined;

      case "allow_always_with_rules":
        this.sessionAllowedCommands.push(...decision.rules);

        return undefined;

      case "question_answers":
        void this.steer(JSON.stringify(decision.answers)).catch(
          () => undefined
        );

        return undefined;

      default:
        return { block: true, reason: "The user rejected this tool call." };
    }
  }

  /**
   * "Always allow" is scoped to what was actually approved: the command's
   * first word for a shell call (`npm test` must not approve `npm publish`),
   * the origin for a fetch, the tool as a whole for file tools.
   */
  private rememberAllowance(
    tool: ToolRequest,
    request: PermissionRequest
  ): void {
    // Scoped to the directory the card named; the tool-level fallback below
    // would grant `write` everywhere.
    switch (request.type) {
      case "read_outside_directory":
        addPath(this.sessionAllowedReadPaths, request.deducedDirectory);

        return;

      case "write_outside_directory":
      case "edit_outside_directory":
      case "notebook_edit_outside_directory":
        addPath(this.sessionAllowedWritePaths, request.deducedDirectory);

        return;

      default:
        break;
    }

    if (tool.name === "web_fetch") {
      try {
        const origin = new URL(String(tool.input.url ?? "")).origin;
        if (!this.sessionAllowedOrigins.includes(origin))
          this.sessionAllowedOrigins.push(origin);
      } catch {
        // Unparseable never reached the network; nothing to remember.
      }

      return;
    }

    if (tool.name !== "bash") {
      this.sessionAllowedTools.add(tool.name);

      return;
    }

    // Every segment of `cd repo && git pull`, or the `git` half asks again.
    for (const segment of shellSegments(String(tool.input.command ?? ""))) {
      // Skip leading VAR=val tokens so `FOO=1 npm test` remembers `npm`.
      const head = segment
        .split(/\s+/)
        .find((word) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word));

      if (head != null && !this.sessionAllowedCommands.includes(head)) {
        this.sessionAllowedCommands.push(head);
      }
    }
  }

  private rejectAllPending(reason: string): void {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      // Nobody answered these either, so the cards have to come down with them.
      this.emitAgentEvent({ type: "permission_cleared", permissionId: id });
      pending.resolve({ type: "reject_with_message", message: reason });
    }
  }

  // ------------------------------------------------------------------ helpers

  private toToolRequest(id: string, name: string, input: unknown): ToolRequest {
    const displayName = TOOL_NAME_ALIASES[name] ?? name;
    const args = (input ?? {}) as Record<string, unknown>;

    // BOTH keys on purpose: the shared type calls the field `input`, but the
    // renderer's permission prompt reads `tool.args`.
    return {
      id,
      name: displayName,
      type: displayName,
      input: args,
      args,
    } as ToolRequest;
  }

  /** The streaming message's id, assigned lazily for a delta with no start. */
  private messageId(): string {
    if (this.currentMessageId == null) {
      this.currentMessageId = `msg-${++this.messageCounter}`;
    }

    return this.currentMessageId;
  }

  private currentModelReference(): string {
    // The router is the user's choice; reporting the concrete model would snap
    // the picker off the router entry the moment it was selected.
    if (this.openLlmActive) return OPENLLM_ID;

    const model = this.session?.model;

    return model ? `${model.provider}/${model.id}` : "";
  }

  /** Re-scan the skill directories and republish the list, after `skill_add`. */
  private async reloadSkills(): Promise<void> {
    const loader = this.resourceLoader;
    if (loader == null) return;

    await loader.reload();
    // pi bakes the skill list into the prompt and rebuilds it only when the
    // tool set changes; setting the active tools to what they already are is
    // the supported way to force that. It lands on the next turn.
    this.session?.setActiveToolsByName(this.session.getActiveToolNames());
    this.emitSkills(loader);
  }

  /**
   * Rebuild the prompt if the user's standing instructions have changed. Run
   * every turn, cheap when nothing changed. An edit pays the conversation's
   * prompt cache, which is why memory is frozen at start; instructions are the
   * case where paying is right, since the user is waiting to see the change.
   * The reload re-reads the file and setActiveToolsByName forces pi's rebuild.
   */
  private async refreshCustomInstructions(): Promise<void> {
    const current = readCustomInstructions();
    // The bot persona and the MCP roster ride the same rebuild.
    const persona = readPersona();
    const roster = mcpRosterFingerprint(this.mcp.statuses);

    if (
      current === this.promptInstructions &&
      persona === this.promptPersona &&
      roster === this.promptMcpRoster
    )
      return;

    const loader = this.resourceLoader;

    this.promptInstructions = current;
    this.promptPersona = persona;

    if (loader == null || this.session == null) return;

    await loader.reload();
    this.session.setActiveToolsByName(this.session.getActiveToolNames());
  }

  private emitSkills(resourceLoader: DefaultResourceLoader): void {
    const skills: SkillMetadata[] = resourceLoader
      .getSkills()
      .skills.map((skill) => ({
        id: skill.name,
        name: skill.name,
        description: skill.description,
        location: skill.filePath,
      }));

    this.options.emit({ type: "skills_loaded", skills });
  }

  private emitAgentEvent(event: AgentEvent): void {
    this.options.emit({ type: "event", event });
  }

  /** The desktop's answer to a `host_service_request`. */
  settleHostService(
    requestId: string,
    ok: boolean,
    result: unknown,
    error: string | undefined
  ): void {
    this.hostServices.settle(requestId, ok, result, error);
  }

  private requireSession(): AgentSession {
    if (!this.session) {
      throw new Error("Agent session is not started");
    }

    return this.session;
  }
}

/**
 * What to say when there is no model at all: the key to set is the only part
 * a first-time user can act on. Plain text, since the CLI prints it too.
 */
const NO_MODEL_CONFIGURED =
  "No model provider is configured. Set an API key — ABACUS_API_KEY, ANTHROPIC_API_KEY, " +
  "OPENAI_API_KEY, OPENROUTER_API_KEY, DEEPSEEK_API_KEY or GEMINI_API_KEY — or add one in Settings.";

/** What to say when one model's key is missing but others are configured. */
const missingKeyMessage = (reference: string, provider: string): string => {
  const envVar = PROVIDER_API_KEY_ENV[provider];

  return envVar != null
    ? `${reference} needs a ${provider} API key. Add it in Settings (${envVar}), or pick a model you already have a key for.`
    : `${reference} has no credentials configured. Add a key for ${provider} in Settings, or pick a model you already have a key for.`;
};

/**
 * Provider finish reasons that mean the model mangled its own tool call.
 * Gemini's `MALFORMED_FUNCTION_CALL` is an ordinary event, and pi treats it
 * as a non-retryable error; the same history sent again usually produces a
 * well-formed call, so it is worth one continuation.
 */
const MALFORMED_TOOL_CALL_PATTERN = /malformed[ _]?(function|tool)[ _]?call/i;

/** Continuations spent on a malformed tool call, per user turn. */
const MAX_MALFORMED_CONTINUATIONS = 1;

/**
 * A provider saying the request did not fit. These all arrive as a plain 400,
 * so the sentence is the only identifier. Matched against lowercased text by
 * both the user-facing message and the compact-and-retry decision.
 */
const CONTEXT_LENGTH_PATTERN =
  /context length|context window|maximum input token limit|input is longer than|maximum context length|too many tokens/;

/**
 * A provider refusing the request for its size against a tier limit rather
 * than the model's window: a 413, or the sentence Groq puts on one. Retrying
 * sends the same bytes again, so it is not narrated as a retry.
 */
const REQUEST_TOO_LARGE_PATTERN =
  /request too large|request entity too large|payload too large|reduce your message size/;

/** Marks the continuation in the session log as ours rather than the user's. */
const MALFORMED_CONTINUATION_TYPE = "abacusai-bot:malformed-tool-call";

/** Marks a wrong-language repair in the session log as ours. */
const LANGUAGE_REPAIR_TYPE = "abacusai-bot:reply-language";

/**
 * What the model is told when its botched call is dropped: a bare "continue"
 * leaves it liable to assume the tool ran.
 */
const MALFORMED_CONTINUATION_PROMPT =
  "Your last tool call was malformed and was dropped before it ran. Nothing was executed. Reissue it correctly, or answer directly if no tool is needed.";

/** Marks a compact-and-retry in the session log as ours. */
const COMPACTION_CONTINUATION_TYPE = "abacusai-bot:context-compaction";

/**
 * What the model is told when the turn is retried on a compacted transcript;
 * an unexplained gap reads as work undone.
 */
const COMPACTION_CONTINUATION_PROMPT =
  "The conversation was too long for your context window, so the history above was summarized to fit. Continue the task from it — do not restart it or repeat work that already completed.";

/** Marks an OpenLLM model switch in the session log as ours. */
/**
 * How long a model call may go without a byte before it is given up on. The
 * server's own first-token limit is well under this, so silence this long is
 * a connection that will never finish, not a slow model.
 */
const MODEL_STALL_MS = 120_000;

/** Read per arming, so a test can shorten the window after the import. */
const modelStallMs = (): number =>
  Number(process.env.ABACUSAI_BOT_MODEL_STALL_MS) || MODEL_STALL_MS;
const MAX_STALL_RECOVERIES_PER_TURN = 1;
const STALL_CONTINUATION_TYPE = "abacusai-bot:stall-recovery";
const STALL_CONTINUATION_PROMPT =
  "The previous provider call produced no output and was abandoned. Continue the task from the transcript above — do not restart it or repeat work that already completed.";

const OPENLLM_CONTINUATION_TYPE = "abacusai-bot:openllm-rotation";

/**
 * What the replacement model is told when it takes over a failed turn; a
 * bare "continue" invites a restart.
 */
const OPENLLM_CONTINUATION_PROMPT =
  "The previous model's provider call failed, and you have taken over this conversation on a different model. Continue the task from the transcript above — do not restart it or repeat work that already completed.";

/**
 * Whether a finished turn's last word from the model was a mangled tool call.
 * Only the *last* assistant message counts: an earlier one the model
 * recovered from is not a failure, and continuing past it would re-run work.
 */
export function endedOnMalformedToolCall(
  messages: readonly unknown[]
): boolean {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];

    if (!isAssistantMessage(message)) continue;

    const failure = message as { stopReason?: unknown; errorMessage?: unknown };

    return (
      failure.stopReason === "error" &&
      typeof failure.errorMessage === "string" &&
      MALFORMED_TOOL_CALL_PATTERN.test(failure.errorMessage)
    );
  }

  return false;
}

/**
 * The provider error a finished turn died on, or null. What OpenLLM rotates
 * on, so deliberately broad: 429, upstream 5xx and "model not found" are all
 * answered by a different model. A malformed tool call is the model's own
 * output and gets a same-model retry instead.
 */
export function endedOnProviderError(
  messages: readonly unknown[]
): string | null {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];

    if (!isAssistantMessage(message)) continue;

    const failure = message as { stopReason?: unknown; errorMessage?: unknown };

    if (failure.stopReason !== "error") return null;
    if (
      typeof failure.errorMessage === "string" &&
      MALFORMED_TOOL_CALL_PATTERN.test(failure.errorMessage)
    ) {
      return null;
    }

    return typeof failure.errorMessage === "string" &&
      failure.errorMessage.length > 0
      ? failure.errorMessage
      : "provider error";
  }

  return null;
}

/**
 * A provider failure in as few characters as the routing line can carry. The
 * status code says it all for the failures the pool hits (429, 402, 503);
 * prose providers get their first clause.
 */
function compactProviderError(raw: string): string {
  const status = raw.match(/^\s*(\d{3})\b/)?.[1];

  if (status != null) return status;

  const first = readableProviderError(raw).split(/[.\n]/)[0]?.trim() ?? "";

  if (first.length === 0) return "provider error";

  return first.length > 60 ? `${first.slice(0, 60)}…` : first;
}

/**
 * A provider failure in the words a user can act on: the category and nothing
 * else, since the provider's text is written for whoever holds the key. The
 * unrecognized case stays vague rather than falling back to the raw text.
 */
function providerFailureSummary(raw: string): string {
  return classifyProviderFailure(raw).summary;
}

const ABACUS_PLAN_URL = "https://apps.abacus.ai/chatllm/choose-plan/";

/** The provider rejected the credential, rather than the account's balance. */
function isAuthFailure(raw: string): boolean {
  const status = raw.match(/^\s*(\d{3})\b/)?.[1];

  return (
    status === "401" ||
    status === "403" ||
    /no api key|invalid api key|unauthorized|authentication/i.test(raw)
  );
}

/** A provider error, by its shape: an HTTP status code up front. */
export function isProviderFailure(raw: string): boolean {
  return /^\s*\d{3}\b/.test(raw);
}

/**
 * The same failure when the turn is actually over: the whole answer the user
 * gets, so it carries the status code (what makes a support conversation
 * possible) and the one thing they can do about it.
 */
/**
 * The provider's own sentence, when the app's reading of it does not already
 * carry it. "The model provider had a problem (400)" is the message a support
 * report arrives with, and on its own there is nothing to diagnose: whether
 * the request was too long, malformed, or refused for a reason nobody has
 * seen yet is in the text the provider sent, which is otherwise discarded.
 */
export function providerDetail(raw: string): { detail?: string } {
  const readable = readableProviderError(raw).trim();
  const message = terminalProviderMessage(raw);

  return readable.length === 0 || message.includes(readable)
    ? {}
    : { detail: readable };
}

export function terminalProviderMessage(raw: string, context?: string): string {
  const { summary, remedy } = classifyProviderFailure(raw);
  const status = raw.match(/^\s*(\d{3})\b/)?.[1];

  return [`${summary}${status == null ? "" : ` (${status})`}.`, context, remedy]
    .filter((part) => part != null)
    .join(" ");
}

export function classifyProviderFailure(raw: string): {
  summary: string;
  remedy: string;
} {
  const status = Number(raw.match(/^\s*(\d{3})\b/)?.[1] ?? Number.NaN);
  const text = raw.toLowerCase();

  // Before the rate-limit branch: an out-of-credits account answers 429 too,
  // and "try again in a moment" is exactly the wrong advice for it.
  if (isOutOfCredits(raw)) {
    return {
      summary: "You're out of credits",
      remedy: `Upgrade your plan at ${ABACUS_PLAN_URL}, or switch to a model with its own key.`,
    };
  }

  // Before the rate-limit branch too: Groq's free tier answers a request over
  // its per-minute token cap with a 413 whose sentence mentions "tokens per
  // minute", and no amount of waiting makes the same request smaller.
  if (status === 413 || REQUEST_TOO_LARGE_PATTERN.test(text)) {
    return {
      summary: "This request is too large for the model's limit",
      remedy:
        "Start a new chat, switch to a model with a higher limit, or raise the limit with the provider.",
    };
  }

  if (status === 429 || /rate.?limit|too many requests/.test(text)) {
    return {
      summary: "The model provider is rate-limited",
      remedy: "Try again in a moment, or switch to a different model.",
    };
  }

  // These arrive as a 400 with the reason only in the prose. Behind the rate
  // limit, since a 429 means the rate limit whatever else the sentence says.
  if (
    /does not support tool|support tool calling|tool use is not supported|does not support function calling/.test(
      text
    )
  ) {
    return {
      summary: "This model can't use tools",
      remedy: "Switch to a model that supports tool calling.",
    };
  }

  if (CONTEXT_LENGTH_PATTERN.test(text)) {
    return {
      summary: "This conversation is too long for the model",
      remedy: "Start a new chat, or switch to a model with a larger context.",
    };
  }

  if (status === 402 || /credit|quota|billing|insufficient/.test(text)) {
    return {
      summary: "The model provider is out of quota",
      remedy: "Add credits with the provider, or switch to a different model.",
    };
  }

  if (status === 401 || status === 403 || /api key|unauthorized/.test(text)) {
    return {
      summary: "The model provider rejected the key",
      remedy: "Check the key in Settings → API keys.",
    };
  }

  if (/timed out|timeout|econnreset|network/.test(text)) {
    return {
      summary: "The model provider did not respond",
      remedy: "Try again in a moment, or switch to a different model.",
    };
  }

  if (status >= 500 || /overloaded|unavailable/.test(text)) {
    return {
      summary: "The model provider is temporarily unavailable",
      remedy: "Try again in a moment, or switch to a different model.",
    };
  }

  return {
    summary: "The model provider had a problem",
    remedy: "Try again, or switch to a different model.",
  };
}

/**
 * The sentence a provider error is actually trying to say, pulled out of the
 * JSON envelope of rate-limit headers that buries it. Anything that does not
 * parse is returned as-is (capped): a parser that threw away what it could
 * not read would hide the errors nobody has seen yet.
 */
function readableProviderError(raw: string): string {
  const cap = (text: string): string =>
    text.length > 300 ? `${text.slice(0, 300)}…` : text;
  // "429: {json}" — the status is worth keeping, the envelope is not.
  const match = raw.match(/^\s*(\d{3})\s*:\s*(\{[\s\S]*\})\s*$/);

  if (match?.[1] == null || match[2] == null) {
    return cap(raw);
  }

  try {
    const body = JSON.parse(match[2]) as {
      message?: unknown;
      metadata?: { raw?: unknown; remedy_hint?: unknown };
    };
    const message = typeof body.message === "string" ? body.message : "";
    const detail =
      typeof body.metadata?.raw === "string"
        ? body.metadata.raw
        : typeof body.metadata?.remedy_hint === "string"
          ? body.metadata.remedy_hint
          : "";

    if (message.length === 0 && detail.length === 0) {
      return cap(raw);
    }

    return cap(
      [`${match[1]}:`, message, detail]
        .filter((part) => part.length > 0)
        .join(" ")
    );
  } catch {
    return cap(raw);
  }
}

/**
 * The sub-agent description for a component tool call, or null. The
 * pdf/ppt/app/design tools hand the work to another model for a minute or
 * more, which belongs in the Agents pane; names arrive MCP-prefixed, so
 * matching is by suffix. Only build actions qualify: `pdf read` is a quick
 * lookup, and `deck_export_pdf` (a `_pdf` suffix collision) takes no action.
 */
function componentSubtaskDescription(
  toolName: string,
  args: Record<string, unknown>
): string | null {
  const is = (base: string): boolean =>
    toolName === base || toolName.endsWith(`_${base}`);
  const action = typeof args.action === "string" ? args.action : "create";

  const kind = is("ppt")
    ? "deck"
    : is("design")
      ? "design"
      : is("pdf") && action === "create" && typeof args.context === "string"
        ? "document"
        : is("app") && action === "create"
          ? "app"
          : null;

  if (kind == null) {
    return null;
  }

  const context =
    typeof args.context === "string"
      ? args.context.replace(/\s+/g, " ").trim()
      : "";
  const brief = context.length > 96 ? `${context.slice(0, 93)}…` : context;

  return brief.length > 0
    ? `Building a ${kind}: ${brief}`
    : `Building a ${kind}`;
}

/** Remember a directory once, ignoring an empty one. */
function addPath(store: string[], directory: string): void {
  if (directory.length > 0 && !store.includes(directory)) store.push(directory);
}

function isAssistantMessage(message: unknown): boolean {
  return (message as { role?: unknown } | undefined)?.role === "assistant";
}

/** Concatenate the text blocks of an assistant message, ignoring tool calls. */
function messageText(message: unknown): string {
  const content = (message as { content?: unknown } | undefined)?.content;

  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .filter(
      (block) =>
        block &&
        typeof block === "object" &&
        (block as { type?: string }).type === "text"
    )
    .map((block) => String((block as { text?: unknown }).text ?? ""))
    .join("");
}

function resultText(result: unknown): string {
  if (typeof result === "string") {
    return result;
  }

  if (result && typeof result === "object") {
    const content = (result as { content?: unknown }).content;

    if (typeof content === "string") {
      return content;
    }

    if (Array.isArray(content)) {
      return content
        .map((block) =>
          block && typeof block === "object" && "text" in block
            ? String((block as { text: unknown }).text)
            : ""
        )
        .join("");
    }
  }

  return "";
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
