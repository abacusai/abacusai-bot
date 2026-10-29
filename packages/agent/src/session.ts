import * as path from "node:path";

import { GATEWAY_SERVER_NAME } from "@abacus-ai/connectors/registry";
import {
  createAgentSession,
  DefaultResourceLoader,
  type AgentSession,
  type AgentSessionEvent,
  type ExtensionAPI,
  type InlineExtension,
  ModelRegistry,
  type ModelRuntime,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

import { sponsoredRunActive } from "./abacus-endpoint.js";
import { Allowances } from "./allowances.js";
import { allowedPathsFromEnv } from "./allowed-paths.js";
import {
  agentShellOperations,
  PYTHON_SETUP_TIMEOUT_MS,
  setPythonProvisioner,
} from "./backends.js";
import { notifyConversationQueueCleared } from "./background-processes.js";
import { basePrompt } from "./base-prompt.js";
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
import { hostConnectivity, hostIsGone } from "./connectivity.js";
import { setCreditRefresher } from "./credit-balance.js";
import { creditWallActive, freeLaneChosen } from "./credit-wall.js";
import { setCurrentMode, setUnattendedPolicy } from "./current-mode.js";
import {
  customInstructionsPrompt,
  readCustomInstructions,
} from "./custom-instructions.js";
import { deckToolEnabled } from "./deck-tool.js";
import { designToolEnabled } from "./design-tool.js";
import { documentToolEnabled } from "./document-tool.js";
import { EmptyReplies } from "./empty-reply.js";
import { tagEvent, type EventMeta } from "./event-meta.js";
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
import requestSize from "./extensions/request-size.js";
import spill from "./extensions/spill.js";
import syntaxCheck from "./extensions/syntax-check.js";
import testRunner from "./extensions/test-runner.js";
import toolCallRepair from "./extensions/tool-call-repair.js";
import toolTimeouts from "./extensions/tool-timeouts.js";
import verifyLoop from "./extensions/verify-loop.js";
import { githubPrompt } from "./github-prompt.js";
import { refreshGithubToken } from "./github-token.js";
import { HostServiceClient } from "./host-services.js";
import type { InternalAgentEvent } from "./internal-events.js";
import {
  connectMcpServers,
  type ConnectedMcp,
  type McpServerStatus,
} from "./mcp/index.js";
import { McpToolSync } from "./mcp/tool-sync.js";
import { buildMcpToolDefinitions } from "./mcp/tools.js";
import {
  memorySnapshot as readMemorySnapshot,
  rememberSnapshot,
} from "./memory-store.js";
import { MODEL_PATH_RESOURCES } from "./model-path.js";
import {
  BUSY_RETRY_PROMPT,
  BusyWait,
  BUSY_WAIT_ROUNDS,
  NetworkWait,
  failedCallStreamed,
  networkContinuation,
  networkEvidence,
  networkSuspect,
  connectionRetryBudgetMs,
  networkWaitBudgetMs,
  runMadeProgress,
  type NetworkSuspect,
} from "./network-wait.js";
import { endedOnLeakedToolCall, networkVerdict } from "./openllm-failures.js";
import {
  OPENLLM_CONTINUATION_PROMPT,
  OPENLLM_CONTINUATION_TYPE,
  OpenLlmRouter,
} from "./openllm-router.js";
import { OPENLLM_ID, failureStatus, isOpenLlmReference } from "./openllm.js";
import { refreshOpenRouterLive } from "./openrouter-live.js";
import { OwnedTurn } from "./owned-turn.js";
import { PendingSteers } from "./pending-steers.js";
import {
  gateToolCall,
  MODE_NAMES,
  parseMode,
  parseModeStrict,
  repairEscapedPaths,
} from "./permissions.js";
import { personaPrompt, readPersona } from "./persona.js";
import { scriptRuntimesPrompt, windowsShellPrompt } from "./posix-shell.js";
import {
  AgentMode,
  AgentStatus,
  type AgentEvent,
  type DesktopEvent,
  type PermissionDecision,
  type PermissionRequest,
  type SkillMetadata,
  type ToolRequest,
  type TurnOutcome,
} from "./protocol.js";
import {
  createModelRuntime,
  registerAbacusProvider,
  registerCustomProviders,
  registerGeminiProvider,
  resolveModel,
  DEFAULT_MAX_OUTPUT_TOKENS,
} from "./providers.js";
import {
  replyLanguageMismatch,
  replyLanguageRepairPrompt,
  type ReplyLanguageMismatch,
} from "./reply-language.js";
import { buildRoster } from "./roster.js";
import {
  allowHostForSession,
  backendName,
  canonicalize,
  ensureRuntime,
  networkConfinable,
  resolveSecretPaths,
  SandboxApprovals,
  sandboxEnforcement,
  setHostDecider,
  type Denial,
  type DenialDecision,
} from "./sandbox/index.js";
import { serviceRoutingPrompt } from "./service-routing-prompt.js";
import { conversationSessionManager } from "./session-file.js";
import {
  MAX_STALL_RECOVERIES_PER_TURN,
  STALL_CONTINUATION_PROMPT,
  STALL_CONTINUATION_TYPE,
  StallWatch,
  modelStallMs,
} from "./stall-watch.js";
import { continueCutReply, isStreamCut, streamCutStep } from "./stream-cut.js";
import { readTodos } from "./todo-store.js";
import { ToolCallStream } from "./tool-call-stream.js";
import { ToolHeartbeat } from "./tool-heartbeat.js";
import { type ToolOrigin, type UnattendedPolicy } from "./tool-policy.js";
import { TOOLS_ARRIVED_TYPE, toolsArrivedPrompt } from "./tools-arrived.js";
import { setTrashMover, TRASH_TIMEOUT_MS } from "./trash.js";
import {
  EMPTY_REPLY_FAILURE,
  OPENLLM_POOL_EMPTY_MESSAGE,
  OPENLLM_POOL_SHUT_MESSAGE,
  REQUEST_TOO_LARGE_PATTERN,
  endedEmpty,
  isBusyCause,
  isAuthFailure,
  isContextTooLong,
  presentFailure,
  providerFailureSummary,
  readableProviderError,
  type TurnFailure,
} from "./turn-outcome.js";
import { turnUsage, type TurnUsage } from "./turn-usage.js";
import {
  accountReplyLanguagePrompt,
  learnUserLanguage,
} from "./user-language.js";
import { webHostPrompt } from "./web-host-prompt.js";
import { desktopXSearchAvailable, searchAvailable } from "./web/search.js";
import webTools from "./web/tools.js";
import { isInsideDirectory } from "./workspace-path.js";

/** The answers that mean "and keep allowing this for the session". */
function isAlwaysDecision(decision: PermissionDecision): boolean {
  const answer = typeof decision === "string" ? decision : decision.type;

  return (
    answer === "allowAlways" ||
    answer === "allow_always_with_rule" ||
    answer === "allow_always_with_rules"
  );
}

export interface SessionOptions {
  cwd: string;
  model?: string;
  mode?: string;
  /**
   * An unattended run's declared reach (`--unattended` at spawn). Read only
   * when the mode is Unattended; without it that mode refuses every tool.
   */
  unattended?: UnattendedPolicy;
  /**
   * Whether a host is attached to answer `host_service_request`. Without one,
   * the tools that need it are never registered: an unanswered
   * request leaves nothing on the event loop and the process exits silently.
   */
  hostServices?: boolean;
  emit: (event: DesktopEvent) => void;
  /**
   * Facts for the AG-UI emitter that never reach the NDJSON wire (message
   * boundaries, streamed tool calls, gate blocks, plan snapshots). Absent
   * under `--wire ndjson` and in the CLI.
   */
  emitInternal?: (event: InternalAgentEvent) => void;
}

/** What a host passes with a turn: told once the user-visible turn is over. */
export interface TurnHandle {
  settled?: () => void;
  /** The sender's id for the message this turn answers. */
  messageId?: string;
  /** Pick the reply Google cut off back up instead of sending the text again. */
  continueCut?: boolean;
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
  // The desktop passes the snapshot it read at spawn; without one the agent
  // reads the same store itself.
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
      ? "Use the `memory` tool to add, correct, or drop any of it. Entries here were true when written: verify anything that names a file, flag, or command before relying on it."
      : "Entries here were true when written: verify anything that names a file, flag, or command before relying on it. You cannot change them in this session.",
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
    "The chat displays a markdown image when its source is a file on disk: an absolute path, a",
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
    "Plan mode is read-only, and it refuses every shell command, not just the ones that change",
    "something. `bash` and `run_tests` are refused in Plan mode even for `ls`, `git log`, `grep` or",
    "a build you only want to read the output of. Do not spend turns discovering this one command",
    "at a time.",
    "",
    "Investigate with the tools that stay available instead: `read`, `batch_file_read`, `grep`,",
    "`find`/`glob` and `ls` cover everything a shell would have been used to look at. When the plan",
    "is ready and the user wants it done, call `exit_plan_mode`: that is how the mode changes.",
  ].join("\n");
}

/**
 * The roster as the prompt describes it, for telling whether the prompt is
 * stale: a server added, gone, or its first tool arrived. Counts are left
 * out, as in the prompt: a server growing a tool must not cost a reload and
 * the prompt cache.
 */
export function mcpRosterFingerprint(
  statuses: readonly McpServerStatus[]
): string {
  return statuses
    .filter((status) => status.isBuiltin !== true)
    .map(
      (status) =>
        `${status.name}:${status.status}:${status.toolCount > 0 ? "tools" : "none"}`
    )
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
      .map((status) => `\`${status.name}\` (tools named \`${status.name}_*\`)`)
      .join(", ");

    lines.push(
      `You are connected to these services right now, through MCP: ${described}. Their tools are`,
      "yours to call like any other. When you are asked whether you have access to one of them,",
      "this list is the answer: do not say you lack an integration that is named here."
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
    "produced something ends by linking it, and when the answer is short enough to read in the",
    "message, put it there too. Reporting that the work happened, with no link and no content, is a",
    "dead end: the user can neither see what you wrote nor find where it went.",
  ];

  if (presentTool != null) {
    lines.push(
      "",
      `Then call \`${presentTool}\` with the same files, most important first. From a component, from`,
      "`write` or from `bash`, it does not matter. The link makes them clickable; this opens the first one",
      "in the preview pane and files them all under Artifacts, where they can be found again after the",
      "conversation has moved on. List the deliverables, not the scratch files."
    );
  }

  return lines.join("\n");
}

/**
 * The server's `x_search`, when this process's own version should answer
 * instead. The server's runs on the platform's X API, which reads X itself,
 * so where an Abacus key exists it is the better tool and this process stands
 * down; the desktop signals that, since this process cannot read the app's
 * settings.
 */
export function isSupersededWebTool(tool: { name: string }): boolean {
  // Server-qualified names only; this process's own `x_search` must stay.
  if (!/^.+_x_search$/.test(tool.name)) return false;

  return !desktopXSearchAvailable() && searchAvailable();
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
 *
 * Something the user will use is not one of them: `design` draws pictures of
 * screens, so an app, a prototype or a dashboard is code the agent writes and
 * serves.
 */
export function componentsPrompt(
  availableTools: ReadonlySet<string>
): string | null {
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
        "Making documents, decks and designs:",
        "",
        `These tools each hand the whole job to a specialised component: ${present
          .map(([name, what]) => `\`${name}\` (${what})`)
          .join(", ")}. Each returns a finished, verified artifact.`,
        "",
        "When the user asks for a presentation, deck, PPT, PDF, report, memo, mockup,",
        "wireframe or screen design, call the matching tool. Do NOT build these by hand: no",
        "python-pptx, no reportlab, no hand-written HTML decks, and do not use a skill for",
        "them even if one is listed. Your job is the context argument: put everything the",
        "artifact should contain into it, then hand the result over (see below).",
        "",
        "Hand-building is the fallback only when the tool itself is unavailable or fails,",
        "and say so when you do it.",
      ].join("\n")
    );
  }

  const serve = qualifiedName(availableTools, "serve");
  const design = qualifiedName(availableTools, "design");

  if (serve != null) {
    const rule = [
      "An app, prototype, dashboard, game, tool or website, anything the user will click,",
      `type into or use, is code: write it, run it with \`${serve}\` and hand over the URL.`,
    ];
    if (design != null) {
      rule.push(
        `\`${design}\` is only for when the user asks to see screens, a mockup or a`,
        "wireframe: it draws static pictures that cannot be used."
      );
    }
    sections.push(["Making apps:", "", ...rule].join("\n"));
  }

  return sections.length > 0 ? sections.join("\n\n") : null;
}

/**
 * How long an approval request waits before it is rejected: long enough for a
 * user who stepped away, short enough that an unattended session is not parked
 * forever. ABACUSAI_BOT_APPROVAL_TIMEOUT_MS overrides it; 0 waits forever.
 */
export function approvalTimeoutMs(): number {
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

/** The servers the app itself hosts; see DESKTOP_ONLY_SERVERS in mcp/index.ts. */
const APP_SERVERS: ReadonlySet<string> = new Set([
  "browser",
  "device",
  "agent-tools",
]);

export class AbacusBotSession {
  private readonly pendingSteers = new PendingSteers();
  private session: AgentSession | undefined;
  /** Construction options for the inner pi session, minus the model; see resetConversation. */
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
  /**
   * What the user chose to always allow, for this process's lifetime. Reads
   * and writes outside the workspace are seeded with what the host
   * pre-allowed (a routine's own folder). See allowances.ts.
   */
  private readonly allowances = new Allowances({
    readPaths: allowedPathsFromEnv(),
    writePaths: allowedPathsFromEnv(),
  });
  /** What the user let commands do beyond the sandbox, once or for the session. */
  private readonly sandboxApprovals = new SandboxApprovals();
  private permissionCounter = 0;
  /**
   * The live session's extension handle, for audit lines and MCP tools.
   * Undefined until a session is built, so every use is optional. Taken only
   * when a session is built: a loader reload (prompt rebuilds, skills) re-runs
   * the factories into a runtime the live session never reads.
   */
  private pi: ExtensionAPI | undefined;
  /** The handle from the newest extension load. */
  private loadedPi: ExtensionAPI | undefined;
  private mcp: ConnectedMcp = {
    clients: [],
    statuses: [],
    routes: new Map(),
    tools: [],
  };
  /** Which MCP tools the model sees; see McpToolSync. */
  private readonly mcpTools = new McpToolSync({
    pi: () => this.pi,
    session: () => this.session,
    mcp: () => this.mcp,
    accepts: (tool) =>
      !excludedTools().includes(tool.name) &&
      // Browser tools belong to the sub-agent, which reads them live.
      !(tool.name.startsWith("browser_") && this.browserTaskRegistered) &&
      !isSupersededWebTool(tool),
    turnRunning: () => this.turnRunning,
  });
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
  /** Streamed tool calls, for the AG-UI emitter only. */
  private readonly toolCallStream = new ToolCallStream(
    (name) => TOOL_NAME_ALIASES[name] ?? name
  );
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
  /** Provider calls that failed and were retried this turn; see reportFailedCall. */
  private retriedCalls = 0;
  /** The turn in flight was stopped by the user; see reportTurnFailure. */
  private interrupted = false;
  /** Continuations spent on a malformed tool call this turn. */
  private malformedContinuations = 0;
  /** The provider's usage for the turn's last request, set at `agent_end`. */
  private lastTurnUsage: TurnUsage | null = null;
  /** The context failure to compact around, with the turn it ended, set at `agent_end`. */
  private pendingContextCompaction: {
    failure: string;
    messages: readonly unknown[];
  } | null = null;
  /** Compactions spent recovering this turn. One is the limit; see compactAndRetry. */
  private contextCompactions = 0;
  /** Set at `agent_end` when the turn is to be continued rather than ended. */
  private continuingPastMalformedToolCall = false;
  /** Whether a user turn is in flight: a refresh landing now is mid-turn. */
  private turnRunning = false;
  /** The turn the running `send` owns; its end waits for the send's report. */
  private ownedTurn: OwnedTurn | null = null;
  /**
   * A model call that has gone silent. Nothing in the stack ends a stalled
   * stream before the desktop's ten-minute watchdog: a response the server
   * had finished and billed sat undelivered for fourteen minutes, then was
   * reported as a hang. Armed while a model call is expected to be producing
   * output, never while a tool runs (tools have their own limits).
   */
  private readonly stallWatch = new StallWatch({
    turnRunning: () => this.turnRunning,
    toolsRunning: () => this.heartbeat.size,
    onStall: () => void this.onModelStall(),
  });
  private pendingStall: { modelId: string } | null = null;
  private stallRecoveriesThisTurn = 0;
  /** The turn already ended on the stall error; pi's aborted state is not a second one. */
  private stallFailureReported = false;
  /** Tools a change deferred under this turn adds; continued into once. */
  private pendingToolArrival: string[] | null = null;
  private toolArrivalsThisTurn = 0;
  /** True while the session runs OpenLLM; see openllm.ts. */
  private openLlmActive = false;
  /** The free pool: which model runs, and what happens when it fails. See openllm-router.ts. */
  private readonly router = new OpenLlmRouter();
  /** Set at `agent_end` when the call failed in a way that may be the network's. */
  private pendingNetworkFailure: NetworkSuspect | null = null;
  /** Set at `agent_end` when every pool model is busy and a wait is left this turn. */
  private pendingBusyWait: { failure: string } | null = null;
  private readonly networkWait = new NetworkWait();
  private readonly busyWait = new BusyWait();
  /** The turn already ended on "couldn't reach Abacus"; pi's error is not a second one. */
  private networkFailureReported = false;
  /** Google cut the reply off: it is picked up once, out of sight (stream-cut.ts). */
  private pendingStreamCut = false;
  private streamCutsThisTurn = 0;
  /** Some of a cut reply arrived this turn, and is kept on screen. */
  private cutStreamedThisTurn = false;
  /** Whether the Abacus provider was registered with the sponsored-run marker. */
  private sponsoredAtRegistration = sponsoredRunActive();
  /**
   * Set at `agent_end` when the reply came back in the wrong script and the
   * turn continues with a repair. Once per turn; a second miss ends the turn.
   */
  private pendingLanguageRepair: ReplyLanguageMismatch | null = null;
  private languageRepairsThisTurn = 0;
  /** The turn's recoveries from an empty reply (empty-reply.ts). */
  private readonly emptyReplies = new EmptyReplies();
  /** The same model is to be asked again, out of sight, for its answer. */
  private pendingEmptyAsk = false;
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
  /** The reply-language block the prompt was built with. */
  private promptUserLanguage = "";
  private promptPersona = "";
  /** The MCP roster the prompt was last built against. */
  private promptMcpRoster = "";

  constructor(private readonly options: SessionOptions) {
    this.mode = parseMode(options.mode);
    setCurrentMode(this.mode);
    setUnattendedPolicy(
      this.mode === AgentMode.Unattended ? (options.unattended ?? null) : null
    );
  }

  async start(): Promise<void> {
    const dir = agentDir();
    this.modelRuntime = await createModelRuntime(dir);
    const registry = new ModelRegistry(this.modelRuntime);
    this.registry = registry;
    registerCustomProviders(registry, this.config);
    registerGeminiProvider(registry);
    await Promise.all([
      registerAbacusProvider(registry),
      refreshOpenRouterLive(),
    ]);

    // MCP servers first: pi takes the custom tool list up front.
    this.mcp = await connectMcpServers(process.env.ABACUSAI_BOT_MCP_CONFIG);
    this.mcp.onStatusChange = () => this.emitMcpServers();
    this.mcp.onToolsAdded = () => this.mcpTools.changed();

    const hostServices = this.options.hostServices !== false;
    // The budgets extension asks for a fresh balance while billed credits run.
    setCreditRefresher(
      hostServices
        ? () => this.hostServices.request("credit_balance", {})
        : null
    );
    // The desktop moves what the agent deletes to the trash.
    setTrashMover(
      hostServices
        ? async (file) => {
            await this.hostServices.request(
              "trash_item",
              { path: file },
              TRASH_TIMEOUT_MS
            );
          }
        : null
    );
    // The desktop owns the app's Python; a shell command that needs it asks.
    setPythonProvisioner(
      hostServices
        ? () =>
            this.hostServices.request("python_env", {}, PYTHON_SETUP_TIMEOUT_MS)
        : null
    );
    const toolNames = new Set([
      ...componentToolNames(hostServices),
      ...this.mcp.tools.map((tool) => tool.name),
    ]);
    // A run nobody watches gets none of the user's private context: a page it
    // reads could ask for it back. Its routine's own prompt still arrives.
    const unattended = this.mode === AgentMode.Unattended;
    const userProfile = unattended ? undefined : userProfilePrompt();
    const memory = unattended
      ? null
      : memoryPrompt(qualifiedName(toolNames, "memory") != null);
    const settingsManager = SettingsManager.create(this.options.cwd, dir);
    // Only the gate, so `edit` is pi's built-in and batch_* are absent.
    const noExtensions = process.env.ABACUSAI_BOT_NO_EXTENSIONS === "1";
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
      // Skill and AGENTS.md paths as the model should copy them.
      ...MODEL_PATH_RESOURCES,
      cwd: this.options.cwd,
      agentDir: dir,
      settingsManager,
      // Nor the folder's AGENTS.md and skills, which are the user's own text.
      additionalSkillPaths: unattended ? [] : skillDirs(this.options.cwd),
      ...(unattended ? { noSkills: true, noContextFiles: true } : {}),
      // Every prompt pi builds starts from ours; see base-prompt.ts.
      systemPromptOverride: () => basePrompt(noExtensions ? "builtin" : "ours"),
      // What the model cannot work out for itself about this app.
      appendSystemPrompt: [
        userProfile,
        memory,
        // Timezone before anything that shows a time: connectors return UTC.
        timezonePrompt(),
        webHostPrompt(),
        // Both prompts name tools, so both read the same roster.
        displayPrompt(),
        // Null everywhere the tool is a real bash.
        windowsShellPrompt(),
        scriptRuntimesPrompt(),
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
        // After who the agent is (the base prompt): a bot's own persona, then what it knows.
        const persona = personaPrompt();
        const instructions = unattended ? null : customInstructionsPrompt();
        const remember = unattended ? null : rememberPrompt();
        // The check at agent_end catches language drift; this prevents it.
        const language = accountReplyLanguagePrompt();
        this.promptUserLanguage = language;

        // Live statuses, so a connector added mid-chat updates the line.
        const mcp = mcpPrompt(this.mcp.statuses);
        this.promptMcpRoster = mcpRosterFingerprint(this.mcp.statuses);

        return [
          ...(persona == null ? [] : [persona]),
          ...base,
          ...(mcp == null ? [] : [mcp]),
          ...(remember == null ? [] : [remember]),
          ...(instructions == null ? [] : [instructions]),
          // Last of all, so it outweighs a template or routine written in English.
          language,
        ];
      },
      // The permission gate runs before the guardrails: a call the user will
      // reject must not be rewritten first. ABACUSAI_BOT_NO_EXTENSIONS=1 loads
      // only the gate, the first step when a turn misbehaves.
      extensionFactories: (noExtensions
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
              name: "abacusai-bot-request-size",
              factory: requestSize as unknown as (pi: ExtensionAPI) => void,
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
      ? this.router.pick(registry)
      : undefined;
    const resolved =
      routerChoice != null
        ? resolveModel(this.modelRuntime, routerChoice.id, this.maxOutputTokens)
        : requested != null && !isOpenLlmReference(requested)
          ? resolveModel(this.modelRuntime, requested, this.maxOutputTokens)
          : {
              model: undefined,
              error: isOpenLlmReference(requested)
                ? "the free pool is empty; add an OpenRouter, Google AI Studio, or Abacus.AI key"
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
        // the first model that can takes the turn: a session that opens on
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

    await this.prepareSandboxRuntime();

    // The browser sub-agent may run on a stronger model than the chat.
    const browserModelRef = (
      process.env.ABACUSAI_BOT_BROWSER_MODEL ??
      this.config.browserModel ??
      ""
    ).trim();
    const browserModelOverride =
      browserModelRef.length > 0
        ? resolveModel(this.modelRuntime, browserModelRef, this.maxOutputTokens)
            .model
        : undefined;

    // The roster is a table (roster.ts) so it can be read without a session.
    const roster = buildRoster(
      {
        cwd: this.options.cwd,
        agentDir: dir,
        modelRuntime: this.modelRuntime,
        subAgentSettingsManager,
        // Read at spawn: the chat's model moves with a pick or a pool hop, and
        // a sub-agent runs on the one the user is on then, not at start.
        model: () => this.session?.model ?? model,
        browserModel: () =>
          browserModelOverride ?? this.session?.model ?? model,
        hostServices: hostServices ? this.hostServices : null,
        excluded,
        // Background runs go through the same operations as the foreground
        // ones, so `background: true` cannot become a way around the sandbox.
        operations: agentShellOperations(this.sandboxApprovals),
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
      this.mcpTools.registered.add(name);
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
    this.pi = this.loadedPi;
    // The opening mode, so the log is a complete account rather than deltas.
    this.applyMode(this.mode, "startup");
    anchorCompactions(this.session.sessionManager);
    this.unsubscribe = this.session.subscribe((event) => this.onPiEvent(event));

    this.emitReady();

    if (model != null && this.openLlmActive) {
      // Noted, not announced: the desktop starts a session whenever an old
      // chat is reopened. The routing episode belongs to the turn; `send` opens it.
      this.openLlmModelId = `${model.provider}/${model.id}`;
    }

    if (startupError != null) {
      this.emitAgentEvent(
        {
          type: "error",
          error: { message: startupError, code: "model_unavailable" },
        },
        { origin: "startup" }
      );
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

  /** Reconnect every server: the desktop's "refresh" action. */
  async refreshMcp(): Promise<void> {
    this.mcp.retire?.();
    for (const client of this.mcp.clients) {
      client.close();
    }

    this.mcp = await connectMcpServers(process.env.ABACUSAI_BOT_MCP_CONFIG);
    this.mcp.onStatusChange = () => this.emitMcpServers();
    this.mcp.onToolsAdded = () => this.mcpTools.changed();
    this.mcpTools.changed();
    this.emitMcpServers();
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
    this.mcp.retire?.();
    for (const client of this.mcp.clients) {
      client.close();
    }

    this.unsubscribe?.();
    this.session?.dispose();
    this.session = undefined;
  }

  // ---------------------------------------------------------------- commands

  async send(text: string, turn?: TurnHandle): Promise<void> {
    const slot: { owned?: OwnedTurn } = {};
    try {
      await this.sendTurn(text, turn, slot);
    } finally {
      // Whatever path the send left by, its turn closes, and only once.
      if (slot.owned != null) this.closeOwnedTurn(slot.owned);
    }
  }

  private async sendTurn(
    text: string,
    turn: TurnHandle | undefined,
    slot: { owned?: OwnedTurn }
  ): Promise<void> {
    const session = this.requireSession();

    // The last turn died on credits or credentials. Whatever the user did
    // about it (a key, a top-up, an upgrade) is on disk or on the account
    // by now, and this is the first moment we can act on it.
    if (this.providersStale) {
      this.providersStale = false;
      await this.refreshProviderRegistrations();
    }

    // Edited instructions apply to this turn, not the next session.
    await this.refreshCustomInstructions();
    // Only the user's own words name their language; a routine's prompt does not.
    if (this.mode !== AgentMode.Unattended)
      void learnUserLanguage(text, (process.env.ABACUS_API_KEY ?? "").trim());
    // The sponsored window closing (or opening) changes the headers the
    // Abacus provider was registered with; a run must not carry the marker
    // past its deadline, nor miss it.
    if (this.sponsoredAtRegistration !== sponsoredRunActive())
      await this.refreshProviderRegistrations();

    // A run pi started on its own while this turn was being prepared (a
    // finished background job's notice) ends first: pi refuses a prompt over
    // it. Nothing is awaited between here and the prompt.
    await session.waitForIdle();

    // Per turn: the same provider failing next turn is news again.
    this.retriedCalls = 0;
    this.interrupted = false;
    this.malformedContinuations = 0;
    this.contextCompactions = 0;
    this.pendingContextCompaction = null;
    this.router.beginTurn();
    this.pendingNetworkFailure = null;
    this.pendingBusyWait = null;
    this.networkWait.reset();
    this.busyWait.reset();
    this.networkFailureReported = false;
    this.languageRepairsThisTurn = 0;
    this.pendingLanguageRepair = null;
    this.emptyReplies.begin();
    this.pendingEmptyAsk = false;
    this.mcpTools.atTurnStart();
    this.pendingToolArrival = null;
    this.toolArrivalsThisTurn = 0;
    this.stallRecoveriesThisTurn = 0;
    this.pendingStall = null;
    this.stallFailureReported = false;
    this.pendingStreamCut = false;
    this.streamCutsThisTurn = 0;
    this.cutStreamedThisTurn = false;
    this.turnRunning = true;
    const owned = new OwnedTurn();
    this.ownedTurn = owned;
    slot.owned = owned;
    // A rotation left over from a stopped turn must not fire here.
    this.pendingOpenLlmRotation = null;
    // A new message is a new answer; last turn's decline does not carry over.
    this.planDeclinedThisTurn = false;

    // At the credit wall the turn waits for the user's choice: it never
    // starts on a weaker model they have not chosen.
    if (await this.stopAtCreditWall()) {
      this.closeOwnedTurn(owned);
      turn?.settled?.();
      return;
    }

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
      // The cut-off card's Continue: the cut reply is picked up, never asked anew.
      if (turn?.continueCut === true) await continueCutReply(session);
      else await session.prompt(text);
      await this.continuePastRecoverableFailures();
      this.reportTurnFailure();
      this.closeOwnedTurn(owned);
      turn?.settled?.();
    } catch (error) {
      // A thrown provider error gets the same words as a reported turn
      // failure rather than the raw "429: {json}" envelope.
      const raw = describe(error);
      this.router.chain.failed(raw, this.session?.model?.provider);
      this.reportFailure();
      // A throw before pi's agent_end left the turn running: end it, or the
      // session stays busy with nothing left to say so.
      if (this.turnRunning) this.finishTurn();
      this.closeOwnedTurn(owned);
      turn?.settled?.();
    }
  }

  /** Emit the owned turn's held end with its outcome; see OwnedTurn. */
  private closeOwnedTurn(owned: OwnedTurn): void {
    if (this.ownedTurn === owned) this.ownedTurn = null;
    owned.close(this.interrupted);
  }

  /**
   * Surface a turn that failed without throwing: `prompt()` resolves normally
   * and records the failure on the state, so otherwise the agent goes busy
   * then idle with no reply and no reason. A user-requested abort lands the
   * same way and is skipped, or every Stop would paint a terminal error.
   */
  private reportTurnFailure(): void {
    if (
      this.interrupted ||
      this.stallFailureReported ||
      this.networkFailureReported
    ) {
      return;
    }

    // The budget extension aborted the run; pi records that as an error with
    // "This operation was aborted" for text, which reads as a provider fault.
    const budgetStop = budgetStopReason();
    if (budgetStop != null) {
      this.emitAgentEvent(
        {
          type: "error",
          error: { message: budgetStop, code: "turn_failed" },
        },
        { origin: "turn" }
      );
      return;
    }

    // The failure pi recorded is this turn's last call; a pinned model's is
    // its only one. On the pool the router recorded it already.
    const message = (
      this.session?.state as { errorMessage?: unknown } | undefined
    )?.errorMessage;
    if (
      !this.openLlmActive &&
      typeof message === "string" &&
      message.length > 0
    )
      this.router.chain.failed(message, this.session?.model?.provider);
    // Still nothing after the recoveries: the turn ends on the empty-reply
    // card, never in silence.
    else if (this.ownedTurn?.endedEmpty === true)
      this.router.chain.failed(
        EMPTY_REPLY_FAILURE,
        this.session?.model?.provider
      );

    this.reportFailure();
  }

  /**
   * End the turn's story: when its last call did not answer, the one error
   * the whole chain of calls comes to (turn-outcome.ts). A turn whose last
   * call answered reports nothing, and an empty reply after a failure is a
   * failure, never a silent end.
   */
  private reportFailure(): void {
    const failure = this.router.chain.failure(
      this.openLlmActive && this.isPoolShut()
    );
    if (failure == null) return;
    this.emitFailure(failure);
  }

  private emitFailure(failure: TurnFailure): void {
    // Credits, billing or credentials: whatever the user does about them (a
    // key, a top-up, an upgrade, a payment) is re-read before the next turn.
    if (
      failure.cause === "credits_exhausted" ||
      failure.cause === "credits_expired" ||
      failure.cause === "payment_required" ||
      failure.cause === "phone_verification" ||
      failure.cause === "key_invalid" ||
      isAuthFailure(failure.raw)
    )
      this.providersStale = true;
    const registry = this.registry;
    this.emitAgentEvent(
      {
        type: "error",
        error: presentFailure(failure, {
          ...(registry != null
            ? this.router.failureContext(
                registry,
                this.openLlmActive,
                this.session?.model
              )
            : {
                routed: this.openLlmActive,
                freeLaneProviders: [],
                onFreeLane: false,
                abacusFreeModels: [],
                abacus: null,
              }),
          ...(failure.cause === "stream_cut" &&
            !this.openLlmActive && {
              streamed: this.cutStreamedThisTurn,
              cutoffsBefore: this.router.noteStreamCutCard(),
            }),
        }),
      },
      { origin: "turn" }
    );
  }

  /**
   * At the credit wall, before the free lane is chosen, a turn on the pool
   * runs on Abacus or not at all: it moves back to Abacus when Abacus is
   * there to ask, and otherwise ends at once on the wall's card.
   */
  private async stopAtCreditWall(): Promise<boolean> {
    const registry = this.registry;
    const runtime = this.modelRuntime;
    const session = this.session;
    if (
      !this.openLlmActive ||
      registry == null ||
      session == null ||
      !creditWallActive() ||
      freeLaneChosen()
    )
      return false;
    const stop = this.router.wallStops(registry);
    if (stop != null) {
      this.emitAgentEvent({
        type: "status_changed",
        status: AgentStatus.Submitted,
      });
      this.emitFailure(stop);
      this.finishTurn();
      return true;
    }
    const best = this.router.pick(registry);
    const current = session.model;
    if (
      best == null ||
      runtime == null ||
      current == null ||
      best.provider === current.provider
    )
      return false;
    // Only a move back to Abacus: the free lane's own order is the router's.
    if (best.provider !== "abacus") return false;
    const resolved = resolveModel(runtime, best.id, this.maxOutputTokens);
    if (resolved.model == null) return false;
    await session.setModel(resolved.model);
    this.openLlmModelId = best.id;
    return false;
  }

  /** Whether every model the router could run is in a class the account refused. */
  private isPoolShut(): boolean {
    const registry = this.registry;

    return registry != null && this.router.poolShut(registry);
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
      this.pendingStall != null ||
      this.pendingNetworkFailure != null ||
      this.pendingStreamCut ||
      this.pendingBusyWait != null ||
      this.pendingEmptyAsk
    ) {
      // Stop cancels the continuation, but the withheld idle event still has
      // to go out or the session stays busy forever.
      if (this.interrupted) {
        this.pendingEmptyAsk = false;
        this.pendingStreamCut = false;
        this.pendingNetworkFailure = null;
        this.pendingBusyWait = null;
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

      if (this.pendingNetworkFailure != null) {
        const suspect = this.pendingNetworkFailure;
        this.pendingNetworkFailure = null;
        await this.recoverFromNetworkFailure(suspect);

        continue;
      }

      if (this.pendingStreamCut) {
        this.pendingStreamCut = false;
        this.streamCutsThisTurn += 1;
        // Logged, not shown: the chat carries the answer, not the retry.
        process.stderr.write(
          `[provider] ${this.session?.model?.id ?? "the model"} cut the reply off; picking it up once.\n`
        );
        if (this.session != null) await continueCutReply(this.session);

        continue;
      }

      if (this.pendingBusyWait != null) {
        const busy = this.pendingBusyWait;
        this.pendingBusyWait = null;
        await this.waitForBusyPool(busy.failure);

        continue;
      }

      if (this.pendingToolArrival != null) {
        const arrived = this.pendingToolArrival;
        this.pendingToolArrival = null;
        this.toolArrivalsThisTurn += 1;
        // Between the turn's runs: the deferred tools register before the
        // continuation's run starts, never under one.
        this.mcpTools.applyDeferred();

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

      if (this.pendingEmptyAsk) {
        this.pendingEmptyAsk = false;

        await this.session?.sendCustomMessage(
          {
            customType: EMPTY_REPLY_TYPE,
            content: EMPTY_REPLY_PROMPT,
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
            "The model answered in the wrong language. Asking it to answer again in yours.",
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

    // Silence while the network is down is the network's, not the model's.
    const connectivity = hostConnectivity();
    if (connectivity === "offline" || connectivity === "degraded") {
      this.pendingNetworkFailure = {
        failure: `no reply in ${Math.round(seconds)}s`,
        streamed: failedCallStreamed(this.session?.messages ?? []),
        confirmed: true,
      };

      return;
    }

    if (this.openLlmActive && registry != null) {
      // No "." in this: the routing log line keeps the first sentence only.
      const failure = `no reply in ${Math.round(seconds)}s`;
      const next = this.router.failed(registry, failure, this.session?.model);

      if (next != null && "nextId" in next) {
        this.pendingOpenLlmRotation = { failure, nextId: next.nextId };

        return;
      }
    }

    if (this.stallRecoveriesThisTurn < MAX_STALL_RECOVERIES_PER_TURN) {
      this.stallRecoveriesThisTurn += 1;
      // Logged, not shown: the chat carries the answer, not the retry.
      process.stderr.write(
        `[provider] ${modelId} stopped answering after ${seconds}s. Asking it again.\n`
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
    this.emitAgentEvent(
      {
        type: "error",
        error: {
          message: `The model stopped answering (no output for ${seconds}s). Try again, or switch to a different model.`,
          code: "turn_failed",
          actions: [{ type: "switch-model" }],
        },
      },
      { origin: "turn" }
    );
    this.finishTurn();
  }

  /** Which pi events mean a model call is (still) being waited on. */
  private async onModelStall(): Promise<void> {
    if (!this.turnRunning || this.interrupted || !this.stallWatch.take())
      return;

    const model = this.session?.model;
    const modelId = model ? `${model.provider}/${model.id}` : "the model";

    this.pendingStall = { modelId };
    process.stderr.write(
      `[abacusai-bot-agent] ${modelId} produced nothing for ${modelStallMs() / 1000}s; aborting the call\n`
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
      this.pendingOpenLlmRotation = this.shouldRotateOpenLlm(
        pending.messages
      ).rotation;

      if (this.pendingOpenLlmRotation != null) return;

      // On the pool the router recorded the failure as it looked for room.
      if (!this.openLlmActive)
        this.router.chain.failed(
          pending.failure,
          this.session?.model?.provider
        );
      this.reportFailure();
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

    return isContextTooLong(failure) ? { failure, messages } : null;
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

    // The router already put the failed model out when it named the next.
    const failed = session.model;
    const failedId = failed ? `${failed.provider}/${failed.id}` : undefined;

    const resolved = resolveModel(
      runtime,
      rotation.nextId,
      this.maxOutputTokens
    );

    if (resolved.model == null) {
      // Should not happen: the candidate came off the live registry moments
      // ago. The idle event was withheld for this rotation, so end the turn.
      this.closeRoutingLine(
        `Routing failed (${compactProviderError(rotation.failure)}): no model left in the pool.`,
        "warning"
      );
      this.reportFailure();
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
      `${failedId ?? "the model"} failed (${compactProviderError(rotation.failure)}), routing to ${rotation.nextId}…`,
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
        // After a busy wait the same model may be asked again.
        content:
          failedId === rotation.nextId
            ? BUSY_RETRY_PROMPT
            : OPENLLM_CONTINUATION_PROMPT,
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
  private shouldRotateOpenLlm(messages: readonly unknown[]): {
    rotation: { failure: string; nextId: string } | null;
    busy: { failure: string } | null;
  } {
    const none = { rotation: null, busy: null };
    if (!this.openLlmActive || this.interrupted) return none;

    const failure =
      endedOnProviderError(messages) ?? endedOnLeakedToolCall(messages);

    if (failure == null) return none;

    return this.routeAfterFailure(failure);
  }

  /**
   * The pool's answer to a provider failure: the next model, or, when every
   * model is busy and the turn has a wait left, a wait for the soonest one.
   */
  private routeAfterFailure(failure: string): {
    rotation: { failure: string; nextId: string } | null;
    busy: { failure: string } | null;
  } {
    const registry = this.registry;
    const current = this.session?.model;
    const currentId = current ? `${current.provider}/${current.id}` : undefined;
    const next =
      registry != null ? this.router.failed(registry, failure, current) : null;

    if (next != null && "nextId" in next)
      return { rotation: { failure, nextId: next.nextId }, busy: null };

    const busy =
      isBusyCause(failure, current?.provider) &&
      // The free lane waits for nobody: its failure is the wall's card.
      !this.router.onFreeLane(current?.provider) &&
      this.busyWait.available &&
      !this.isPoolShut();
    process.stderr.write(
      `[abacusai-bot-agent] pool not rotating after "${failure.slice(0, 80)}": no other candidate (current ${currentId ?? "?"})${busy ? "; waiting for the soonest" : ""}\n`
    );

    return { rotation: null, busy: busy ? { failure } : null };
  }

  /**
   * The call failed in a way that may be the network's. If it is, the turn
   * waits for the connection and picks up where it stopped. If the Abacus
   * API answers, the same call is still a dropped connection, not a busy
   * model: it is asked again a few times, never rotated away from, and the
   * turn ends on the connection card when it keeps failing.
   */
  private async recoverFromNetworkFailure(
    suspect: NetworkSuspect
  ): Promise<void> {
    const evidence = suspect.confirmed
      ? null
      : await networkEvidence(suspect.failure);
    const network =
      evidence == null ||
      networkVerdict(suspect.failure, evidence) === "network";

    if (this.interrupted) {
      this.finishTurn();
      return;
    }

    const budgetMs = network
      ? networkWaitBudgetMs()
      : connectionRetryBudgetMs();
    const outcome = await this.networkWait.next(
      budgetMs,
      (attempt, delayMs) => {
        process.stderr.write(
          `[abacusai-bot-agent] network unavailable ("${suspect.failure.slice(0, 80)}"); waiting ${delayMs}ms (attempt ${attempt}, budget ${budgetMs}ms)\n`
        );
        this.emitAgentEvent({
          type: "retry",
          attempt,
          maxAttempts: 0,
          delayMs,
          isNetworkError: true,
          waitingForConnection: true,
        });
      }
    );

    // The host went away mid-wait: the turn ends as stopped, not failed.
    if (hostIsGone()) this.interrupted = true;
    if (outcome === "cancelled" || this.interrupted) {
      this.finishTurn();
      return;
    }

    if (outcome === "gave-up") {
      this.networkFailureReported = true;
      if (this.openLlmRouting)
        this.closeRoutingLine("Routing stopped: no network.", "warning");
      this.emitFailure({
        cause: "connection",
        provider: this.session?.model?.provider,
        raw: suspect.failure,
      });
      this.finishTurn();
      return;
    }

    const session = this.session;
    if (session == null) {
      this.finishTurn();
      return;
    }
    await networkContinuation(session, suspect.streamed);
  }

  /**
   * Every pool model is cooling down after saying it is busy: wait for the
   * soonest (bounded), then ask it again, before telling the user.
   */
  private async waitForBusyPool(failure: string): Promise<void> {
    const registry = this.registry;
    const soonest =
      registry != null ? this.router.soonestReady(registry) : null;

    if (soonest == null || this.interrupted) {
      this.finishTurn();
      return;
    }

    this.emitAgentEvent({
      type: "retry",
      attempt: this.busyWait.rounds + 1,
      maxAttempts: BUSY_WAIT_ROUNDS,
      delayMs: this.busyWait.delayFor(soonest.readyInMs),
      isNetworkError: false,
    });

    const waited = await this.busyWait.wait(soonest.readyInMs);
    // The host went away mid-wait: the turn ends as stopped, not failed.
    if (hostIsGone()) this.interrupted = true;

    if (!waited || this.interrupted) {
      this.finishTurn();
      return;
    }

    this.pendingOpenLlmRotation = { failure, nextId: soonest.nextId };
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
    // The model answering, not the line's guess at it: Abacus answering is
    // what lifts the credit wall.
    const model = this.session?.model;
    const answered = model != null ? `${model.provider}/${model.id}` : target;
    if (answered != null) this.router.succeeded(answered);
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
    if (isContextTooLong(text)) {
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
      `[provider] ${providerFailureSummary(text, this.session?.model?.provider)}; retrying (attempt ${this.retriedCalls + 1}).\n`
    );
  }

  /**
   * Close out a turn: fail any open subtask brackets, drop per-turn state, go
   * idle. A component whose tool_execution_end never came would otherwise spin
   * in the Agents pane forever, so it closes as a failure, not a checkmark.
   */
  private finishTurn(): void {
    this.turnRunning = false;
    this.stallWatch.clear();
    for (const subtaskId of this.componentSubtasks.values()) {
      this.emitAgentEvent(
        {
          type: "subtask_end",
          id: subtaskId,
          status: "failed",
        },
        { unfinished: true }
      );
    }

    this.componentSubtasks.clear();
    this.toolInputs.clear();
    this.heartbeat.clear();
    const usage =
      this.lastTurnUsage != null &&
      this.openLlmActive &&
      this.router.onFreeLane(this.session?.model?.provider)
        ? {
            ...this.lastTurnUsage,
            lane: "free" as const,
            ...(this.session?.model?.provider != null
              ? { provider: this.session.model.provider }
              : {}),
          }
        : this.lastTurnUsage;
    this.lastTurnUsage = null;
    const end = (outcome?: TurnOutcome): void => {
      this.emitAgentEvent({
        type: "turn_complete",
        ...(outcome != null ? { outcome } : {}),
        ...(usage != null ? { usage } : {}),
      });
      this.emitAgentEvent({
        type: "status_changed",
        status: AgentStatus.Idle,
      });
    };
    // A send's turn ends after the send has said why (OwnedTurn); a run pi
    // started on its own has no send to wait for.
    const owned = this.ownedTurn;
    if (!this.interrupted && owned?.hold(end) === true) return;
    // A stopped turn ends now: nothing is left to report, and a Stop or a
    // reset must not see the old turn's end arrive after it.
    if (this.interrupted && owned != null) {
      owned.hold(end);
      this.closeOwnedTurn(owned);
      return;
    }
    end();
  }

  /**
   * Whether pi has a run going, including one it started itself (a finished
   * background job's notice, a test-suite follow-up) that no `send` owns.
   */
  isRunning(): boolean {
    return this.session?.isStreaming === true;
  }

  /** Resolves once pi has no run going, after any run its settling started. */
  async whenIdle(): Promise<void> {
    await this.session?.waitForIdle();
  }

  /**
   * Mid-turn input. pi keeps its own steering queue; the text is remembered
   * here so its arrival (a user message_start) can be reported to the desktop.
   */
  async steer(text: string, messageId?: string): Promise<void> {
    this.pendingSteers.add(text, messageId);
    await this.requireSession().steer(text);
  }

  /**
   * Forget every undelivered steer, so a leftover message the host runs as
   * its own turn is not also injected as a steer and seen twice.
   */
  dropSteers(): void {
    this.pendingSteers.clear();
    this.session?.clearQueue();
  }

  /** A user message pi just started is one of ours if the text matches. */
  private noteSteerLanded(message: unknown): void {
    if ((message as { role?: unknown } | undefined)?.role !== "user") return;
    const steer = this.pendingSteers.take(messageText(message));
    if (steer == null) return;
    this.emitAgentEvent({
      type: "user_message_steered",
      content: steer.text,
      ...(steer.messageId != null ? { messageId: steer.messageId } : {}),
    });
  }

  async stop(): Promise<void> {
    // The turn about to end was stopped, not failed; see reportTurnFailure.
    this.interrupted = true;
    // A turn waiting for the network or a busy pool ends now, not after the wait.
    this.networkWait.cancel();
    this.busyWait.cancel();

    // An unanswered approval would keep the tool hook parked forever.
    this.rejectAllPending("Interrupted.");

    // Same for a host service still working: its promise would hold the turn
    // open until its own timeout minutes later.
    this.hostServices.failAll("Interrupted.");

    // Anything in pi's queues (a steer, an extension's `triggerTurn` follow-up)
    // is delivered as soon as the agent goes idle and starts another turn, so
    // Stop would not stop.
    this.pendingSteers.clear();
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
    // Unattended is a spawn-time mode: a run never leaves it, and nothing
    // switches a session into it without the policy it was spawned with.
    if (
      source !== "startup" &&
      (this.mode === AgentMode.Unattended || next === AgentMode.Unattended) &&
      next !== this.mode
    ) {
      this.emitAgentEvent({ type: "mode_changed", mode: this.mode, source });
      return;
    }
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
      this.emitAgentEvent(
        {
          type: "error",
          error: {
            message: `Could not switch to ${reference}: ${
              error instanceof Error ? error.message : String(error)
            }`,
            code: "model_unavailable",
          },
        },
        { origin: "turn" }
      );
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
      this.emitAgentEvent(
        {
          type: "error",
          error: {
            message: resolved.error ?? `Unknown model: ${reference}`,
            code: "model_unavailable",
          },
        },
        { origin: "turn" }
      );

      return;
    }

    // Running a different model than the one just chosen is never the answer:
    // a turn on the model they were trying to get away from reads as the pick
    // having done nothing. Say which key is missing and keep the current model.
    if (this.registry?.hasConfiguredAuth(resolved.model) === false) {
      this.emitAgentEvent(
        {
          type: "error",
          error: {
            message: missingKeyMessage(reference, resolved.model.provider),
            code: "model_unavailable",
          },
        },
        { origin: "turn" }
      );

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

    const choice = this.router.pick(registry);
    const resolved =
      choice != null
        ? resolveModel(runtime, choice.id, this.maxOutputTokens)
        : undefined;

    if (resolved?.model == null) {
      // At the credit wall the card that offers the choice.
      const wall = this.router.wallStops(registry);
      if (wall != null) {
        // Chosen, and held at the wall: the next turn stops on its card.
        this.openLlmActive = true;
        this.emitFailure(wall);
        return;
      }
      // The picker is the way out: its free-plan rows connect the sources. A
      // pool that has sources but every one used up says so, and the card
      // offers what is still to connect.
      const shut = this.isPoolShut();
      this.emitAgentEvent(
        {
          type: "error",
          error: {
            message: shut
              ? OPENLLM_POOL_SHUT_MESSAGE
              : OPENLLM_POOL_EMPTY_MESSAGE,
            code: "model_unavailable",
            actions: shut
              ? [{ type: "free-pool-out" }]
              : [{ type: "switch-model" }],
          },
        },
        { origin: "turn" }
      );

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
    this.sponsoredAtRegistration = sponsoredRunActive();
    const registry = this.registry;

    if (!registry) {
      return;
    }

    // Keys the desktop saved after this process started are on disk only:
    // `applyStoredApiKeys` runs once at startup, and pi's built-in providers
    // took their credentials from the environment as it was then. Re-read the
    // file, then hand pi each key it owns: the same re-read on every call
    // that makes registerGeminiProvider pick a Gemini key up.
    applyStoredApiKeys();
    void refreshGithubToken();
    await this.applyRuntimeApiKeys();
    registerCustomProviders(registry, loadConfig());
    registerGeminiProvider(registry);
    await Promise.all([
      registerAbacusProvider(registry),
      refreshOpenRouterLive(),
    ]);
    // Whatever sidelined a model or a whole provider may no longer hold: the
    // account's credits, plan or keys just changed under us.
    this.router.clearCooldowns();
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

  /** Whether an answer for `permissionId` would release a waiter now. */
  hasPendingPermission(permissionId: string): boolean {
    return this.pending.has(permissionId);
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
    this.networkWait.cancel();
    this.busyWait.cancel();
    this.rejectAllPending("Conversation reset.");
    // As in `stop`: a queued message must not land in the fresh conversation.
    this.pendingSteers.clear();
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
      this.pi = this.loadedPi;
      // A fresh session has only the tools it was built with.
      this.mcpTools.rebind(
        new Set(this.session.getAllTools().map((tool) => tool.name))
      );
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

    this.stallWatch.note(event.type);

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
          this.toolCallStream.reset();
          const messageId = this.aguiMessageId(event.message);

          this.emitInternal({
            type: "message_open",
            key: this.currentMessageId,
            ...(messageId != null ? { messageId } : {}),
          });
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
        this.router.recordReply(event.message);

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

        if (this.currentMessageId != null) {
          const stopReason = (event.message as { stopReason?: unknown })
            .stopReason;

          this.emitInternal({
            type: "message_close",
            key: this.currentMessageId,
            ...(typeof stopReason === "string" ? { stopReason } : {}),
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
          this.emitAgentEvent(
            {
              type: "subtask_start",
              id: subtaskId,
              description,
              kind: "component",
            },
            { parentToolCallId: event.toolCallId }
          );
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

        const planSet =
          event.toolName === "todo" &&
          event.isError !== true &&
          this.toolInputs.get(event.toolCallId)?.action === "set";

        this.toolInputs.delete(event.toolCallId);
        this.heartbeat.ended(event.toolCallId);
        this.rememberCreated(tool, event.isError === true);
        this.emitAgentEvent({
          type: "tool_execution_complete",
          tool,
          result: {
            id: event.toolCallId,
            content: resultText(event.result),
            rejected: event.isError,
          },
        });

        if (planSet) {
          this.emitInternal({
            type: "plan_changed",
            todos: readTodos().map((item) => ({ ...item })),
          });
        }

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

        // A call that answered ends any outage this turn was riding out.
        if (runMadeProgress(event.messages)) this.networkWait.reset();
        // The run that ends the turn is the last to set it.
        if (this.ownedTurn != null)
          this.ownedTurn.endedEmpty = endedEmpty(event.messages);
        // The network's failure is checked (and waited out) before anything
        // reads it as the model's: no cooldown, no rotation, no compaction.
        this.pendingNetworkFailure =
          this.interrupted || event.willRetry
            ? null
            : networkSuspect(
                endedOnProviderError(event.messages),
                event.messages
              );
        // Google cut the reply off on a model the user picked: asked once
        // more out of sight, or the network's while the machine is offline.
        const cut =
          this.pendingNetworkFailure != null ||
          this.interrupted ||
          event.willRetry ||
          this.openLlmActive
            ? null
            : streamCutStep(
                endedOnProviderError(event.messages),
                this.session?.model?.provider,
                event.messages,
                this.streamCutsThisTurn
              );
        if (cut != null) {
          this.cutStreamedThisTurn ||= cut.streamed;
          if (cut.kind === "network")
            this.pendingNetworkFailure = {
              failure: cut.failure,
              streamed: cut.streamed,
              confirmed: true,
            };
          this.pendingStreamCut = cut.kind === "ask";
        }
        if (this.pendingNetworkFailure != null || this.pendingStreamCut) {
          this.lastTurnUsage = turnUsage(event.messages as never);
          this.continuingPastMalformedToolCall = false;
          this.pendingContextCompaction = null;
          this.pendingOpenLlmRotation = null;
          this.pendingBusyWait = null;
          this.pendingLanguageRepair = null;
          this.pendingToolArrival = null;

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
        const route =
          this.continuingPastMalformedToolCall ||
          this.pendingContextCompaction != null
            ? { rotation: null, busy: null }
            : this.shouldRotateOpenLlm(event.messages);
        this.pendingOpenLlmRotation = route.rotation;
        this.pendingBusyWait = event.willRetry ? null : route.busy;
        // Only a turn that ended cleanly is judged on its language.
        this.pendingLanguageRepair =
          this.continuingPastMalformedToolCall ||
          this.pendingContextCompaction != null ||
          this.pendingOpenLlmRotation != null ||
          this.pendingBusyWait != null ||
          this.languageRepairsThisTurn > 0
            ? null
            : replyLanguageMismatch(event.messages);
        // Tools a change deferred under this turn adds: the turn continues
        // once with them, so the request is finished rather than declared
        // impossible. Once per turn.
        const arrivals =
          this.continuingPastMalformedToolCall ||
          this.pendingContextCompaction != null ||
          this.pendingOpenLlmRotation != null ||
          this.pendingBusyWait != null ||
          this.pendingLanguageRepair != null ||
          this.toolArrivalsThisTurn > 0
            ? []
            : this.mcpTools.pendingArrivals();
        this.pendingToolArrival = arrivals.length > 0 ? arrivals : null;
        // Nothing at all, with no other way on: the turn tries again rather
        // than ending on silence (EmptyReplies).
        const emptyStep =
          !event.willRetry &&
          !this.interrupted &&
          this.ownedTurn?.endedEmpty === true &&
          !this.continuingPastMalformedToolCall &&
          this.pendingContextCompaction == null &&
          this.pendingOpenLlmRotation == null &&
          this.pendingBusyWait == null &&
          this.pendingLanguageRepair == null &&
          this.pendingToolArrival == null
            ? this.emptyReplies.next(
                this.openLlmActive,
                this.router.chain.hadFailure
              )
            : null;
        if (emptyStep === "rotate")
          this.pendingOpenLlmRotation =
            this.routeAfterFailure(EMPTY_REPLY_FAILURE).rotation;
        // With no other model to move to, the same one is asked.
        this.pendingEmptyAsk =
          emptyStep != null && this.pendingOpenLlmRotation == null;
        if (
          !event.willRetry &&
          !this.continuingPastMalformedToolCall &&
          this.pendingContextCompaction == null &&
          this.pendingOpenLlmRotation == null &&
          this.pendingBusyWait == null &&
          this.pendingLanguageRepair == null &&
          this.pendingToolArrival == null &&
          !this.pendingEmptyAsk
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
        // Google cutting the reply off is asked again out of sight.
        if (isStreamCut(event.errorMessage, this.session?.model?.provider))
          return;
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
    if (streamEvent.type.startsWith("toolcall_")) {
      for (const internal of this.toolCallStream.handle(streamEvent)) {
        this.emitInternal(internal);
      }

      return;
    }

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
    // to take the handle; it becomes live only when a session is built on it.
    this.loadedPi = pi;

    pi.on("tool_call", async (event, ctx) => {
      // Before the gate, so it judges the file the model meant.
      repairEscapedPaths(event.input as Record<string, unknown>, ctx.cwd);
      const tool = this.toToolRequest(
        event.toolCallId,
        event.toolName,
        event.input as Record<string, unknown>
      );

      this.emitInternal({
        type: "tool_call_start",
        toolCallId: event.toolCallId,
        toolName: tool.name,
        rawName: event.toolName,
        input: tool.input,
      });

      const gate = gateToolCall(tool, {
        mode: this.mode,
        cwd: ctx.cwd,
        ...this.allowances.gateOptions({
          commands: this.config.allowedCommands,
          readPaths: this.config.allowedReadPaths,
        }),
        promptableCredentialPaths: this.promptableCredentialPaths(ctx.cwd),
        allowedCredentialPaths: this.sandboxApprovals.reads.sessionPaths,
        ...(this.options.unattended != null
          ? {
              unattended: {
                policy: this.options.unattended,
                origin: (name: string) => this.toolOrigin(name),
              },
            }
          : {}),
      });

      if (gate.kind === "allow") return;

      // Asked and answered; the same card again talks over the user.
      if (tool.name === EXIT_PLAN_TOOL_NAME && this.planDeclinedThisTurn) {
        this.noteBlocked(event.toolCallId, "refused");

        return {
          block: true,
          reason:
            "You already asked to start this turn and the user declined. Reply to them and wait " +
            "for what they say next. Do not ask again.",
        };
      }

      if (gate.kind === "refuse") {
        this.noteBlocked(event.toolCallId, "refused");

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
        this.noteBlocked(event.toolCallId, "rejected");

        return {
          block: true,
          reason:
            `${tool.name} needs approval, but this session has no way to ask: ` +
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

      const decision = await this.awaitDecision(permissionId);

      this.recordApproval(pi, {
        stage: "decided",
        permissionId,
        toolName: event.toolName,
        outcome: typeof decision === "string" ? decision : decision.type,
      });

      const verdict = this.applyDecision(decision, tool, gate.request);

      if (verdict?.block === true) {
        this.noteBlocked(event.toolCallId, "rejected");
      }

      return verdict;
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
  /** The user's answer to a card, or a rejection once the budget runs out. */
  private awaitDecision(permissionId: string): Promise<PermissionDecision> {
    return new Promise<PermissionDecision>((resolve) => {
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
                `Do not retry the same call. Say what you need approved and stop.`,
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
  }

  /**
   * Start the sandbox runtime's proxies and route their questions to the
   * user. A failure is not fatal here: the first confined command reports it.
   */
  private async prepareSandboxRuntime(): Promise<void> {
    if (sandboxEnforcement() === "off" || backendName() === null) return;
    if (!networkConfinable()) return;

    setHostDecider((host, port) => this.askNetworkHost(host, port));
    this.sandboxApprovals.askDenials = (command, refused, note) =>
      this.askDenials(command, refused, note);
    await ensureRuntime();
  }

  /**
   * A file the write tool made outside the workspace is the session's own:
   * a later command may change or remove it without a card (intent.ts).
   */
  private rememberCreated(tool: ToolRequest, failed: boolean): void {
    if (failed || tool.name !== "write") return;
    const requested = tool.input.path;
    if (typeof requested !== "string" || requested.length === 0) return;
    const resolved = canonicalize(path.resolve(this.options.cwd, requested));
    if (isInsideDirectory(resolved, this.options.cwd)) return;
    this.sandboxApprovals.created.add(resolved);
  }

  /**
   * The sandbox refused what a command tried. The card lists it; "allow"
   * lets the command run once more with those, "always" keeps them for the
   * session. Null means the command stays refused.
   */
  private async askDenials(
    command: string,
    refused: Denial[],
    note: string | null
  ): Promise<DenialDecision | null> {
    if (!this.canReachUser()) return null;

    const permissionId = `perm-${++this.permissionCounter}`;
    const input = { command, denials: refused };
    const request: PermissionRequest = {
      type: "sandbox_denied",
      tool: {
        id: permissionId,
        name: "sandbox",
        type: "tool",
        input,
        args: input,
      },
      displayName: "Allow what the sandbox refused",
      command,
      denials: refused,
      ...(note != null ? { note } : {}),
    };

    if (this.pi != null) {
      this.recordApproval(this.pi, {
        stage: "asked",
        permissionId,
        toolName: "sandbox",
        detail: refused.map((denial) => denial.kind).join(","),
      });
    }
    this.options.emit({ type: "permission_needed", permissionId, request });
    this.emitAgentEvent({
      type: "status_changed",
      status: AgentStatus.WaitingForToolPermission,
    });

    const decision = await this.awaitDecision(permissionId);
    this.emitAgentEvent({
      type: "status_changed",
      status: AgentStatus.ExecutingTool,
    });

    const answer = typeof decision === "string" ? decision : decision.type;
    if (this.pi != null) {
      this.recordApproval(this.pi, {
        stage: "decided",
        permissionId,
        toolName: "sandbox",
        outcome: answer,
      });
    }

    if (isAlwaysDecision(decision) || answer === "allowYolo")
      return { once: refused, session: refused };
    if (
      answer === "accept" ||
      answer === "accept_with_message" ||
      answer === "background"
    )
      return { once: refused, session: [] };

    return null;
  }

  /**
   * A confined command reached for a host nobody listed. The connection is
   * held while the card is up; "always" lists the host for the session.
   */
  private async askNetworkHost(host: string, port: number): Promise<boolean> {
    if (!this.canReachUser()) return false;

    const permissionId = `perm-${++this.permissionCounter}`;
    const input = { host, port };
    const request: PermissionRequest = {
      type: "network_host",
      tool: {
        id: permissionId,
        name: "network",
        type: "tool",
        input,
        args: input,
      },
      displayName: "Reach a host",
      host,
      port,
    };

    if (this.pi != null) {
      this.recordApproval(this.pi, {
        stage: "asked",
        permissionId,
        toolName: "network",
        detail: `${host}:${port}`,
      });
    }
    this.options.emit({ type: "permission_needed", permissionId, request });
    this.emitAgentEvent({
      type: "status_changed",
      status: AgentStatus.WaitingForToolPermission,
    });

    const decision = await this.awaitDecision(permissionId);
    // The command that asked is still running.
    this.emitAgentEvent({
      type: "status_changed",
      status: AgentStatus.ExecutingTool,
    });

    const answer = typeof decision === "string" ? decision : decision.type;
    if (this.pi != null) {
      this.recordApproval(this.pi, {
        stage: "decided",
        permissionId,
        toolName: "network",
        outcome: answer,
      });
    }

    if (isAlwaysDecision(decision) || answer === "allowYolo") {
      allowHostForSession(host);

      return true;
    }

    return (
      answer === "accept" ||
      answer === "accept_with_message" ||
      answer === "background"
    );
  }

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
            "Do not ask again this turn. Reply to them and wait.",
        };
    }
  }

  private applyDecision(
    decision: PermissionDecision,
    tool: ToolRequest,
    request: PermissionRequest
  ): { block: true; reason: string } | undefined {
    const verdict = this.applyDecisionToAllowances(decision, tool, request);

    // An accepted shell card that named hidden stores unhides them: for this
    // command, and for the session when the answer was "always".
    if (
      verdict === undefined &&
      request.type === "run_terminal" &&
      request.credentialPaths != null
    ) {
      const command = String(tool.input.command ?? "");
      this.sandboxApprovals.reads.approveOnce(command, request.credentialPaths);
      if (isAlwaysDecision(decision))
        this.sandboxApprovals.reads.approveForSession(request.credentialPaths);
    }

    return verdict;
  }

  private applyDecisionToAllowances(
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
          this.allowances.remember(tool, request);

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
        this.allowances.allowCommandRules([decision.rule]);

        return undefined;

      case "allow_always_with_rules":
        this.allowances.allowCommandRules(decision.rules);

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
   * The hidden stores a command may ask to read, when the sandbox is on. Empty
   * otherwise, so no card mentions a store nothing is hiding.
   */
  private promptableCredentialPaths(cwd: string): string[] {
    if (sandboxEnforcement() === "off" || backendName() === null) return [];

    return resolveSecretPaths({ workspaceRoot: cwd }).promptable;
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

  /**
   * Where a tool the model called comes from: a server the user added, the
   * account's connectors, or the agent and the app's own servers. A name an
   * MCP server routes is that server's, whatever else shares the name.
   */
  private toolOrigin(name: string): ToolOrigin {
    const route = this.mcp.routes.get(name);
    if (route == null) return "builtin";
    const server = route.client.name;
    if (server === GATEWAY_SERVER_NAME) return "connector";
    // By the app's reserved names, not by what a config entry claims.
    return APP_SERVERS.has(server) &&
      this.mcp.statuses.some(
        (status) => status.id === server && status.isBuiltin === true
      )
      ? "builtin"
      : "user";
  }

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

  /** A fact for the AG-UI emitter only; never a legacy line. */
  private emitInternal(event: InternalAgentEvent): void {
    this.options.emitInternal?.(event);
  }

  /** The gate blocked `toolCallId`; the AG-UI result says why. */
  private noteBlocked(toolCallId: string, cause: "rejected" | "refused"): void {
    this.emitInternal({ type: "tool_blocked", toolCallId, cause });
  }

  /**
   * An assistant message's AG-UI id: the pi session id plus the message's own
   * timestamp, which pi persists, so it is stable across a reload. Without a
   * timestamp there is nothing stable here (`msg-N` restarts per process), so
   * the emitter builds an incarnation-scoped id instead.
   */
  private aguiMessageId(message: unknown): string | undefined {
    const timestamp = (message as { timestamp?: unknown }).timestamp;
    const base = this.session?.sessionId ?? "session";

    return typeof timestamp === "number" ? `${base}:${timestamp}` : undefined;
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
    const language = accountReplyLanguagePrompt();

    if (
      current === this.promptInstructions &&
      persona === this.promptPersona &&
      roster === this.promptMcpRoster &&
      language === this.promptUserLanguage
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

  private emitAgentEvent(event: AgentEvent, meta?: EventMeta): void {
    if (meta != null) tagEvent(event, meta);
    if (event.type === "error" && meta?.origin !== "startup")
      this.ownedTurn?.noteError(event.error);
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
 * a first-time user can act on. Plain text, so it reads the same anywhere.
 */
const NO_MODEL_CONFIGURED =
  "No model provider is configured. Set an API key (ABACUS_API_KEY, ANTHROPIC_API_KEY, " +
  "OPENAI_API_KEY, OPENROUTER_API_KEY, DEEPSEEK_API_KEY or GEMINI_API_KEY) or add one in Settings.";

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

/** Marks the continuation in the session log as ours rather than the user's. */
const MALFORMED_CONTINUATION_TYPE = "abacusai-bot:malformed-tool-call";

/** Marks a wrong-language repair in the session log as ours. */
const LANGUAGE_REPAIR_TYPE = "abacusai-bot:reply-language";

/** One more ask after a response with no text and no tool call. */
const EMPTY_REPLY_TYPE = "abacusai-bot:empty-reply";

const EMPTY_REPLY_PROMPT =
  "Your last response was empty: no text and no tool call. Continue the task: either call a tool or state your final answer in plain text. If work was done, say what came of it.";

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
  "The conversation was too long for your context window, so the history above was summarized to fit. Continue the task from it. Do not restart it or repeat work that already completed.";

/** Marks an OpenLLM model switch in the session log as ours. */
/**
 * How long a model call may go without a byte before it is given up on. The
 * server's own first-token limit is well under this, so silence this long is
 * a connection that will never finish, not a slow model.
 */

/** Read per arming, so a test can shorten the window after the import. */

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
  const status = failureStatus(raw);

  if (status != null) return status;

  const first = readableProviderError(raw).split(/[.\n]/)[0]?.trim() ?? "";

  if (first.length === 0) return "provider error";

  return first.length > 60 ? `${first.slice(0, 60)}…` : first;
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
