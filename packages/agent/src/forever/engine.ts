/**
 * The forever-chat engine: a deliberately small agent for one chat that never
 * ends, not the coding session. Built to survive indefinitely on a cheap model:
 * context overflow compacts and retries, hidden turns keep the profile's memory
 * before compaction and on its own cadence, and streamed <think> scaffolding and
 * malformed tool calls are tidied. Driven over the same NDJSON protocol as the
 * coding session. What the chat is (prompts, tools, memory) is a ForeverProfile.
 */
import {
  createAgentSession,
  DefaultResourceLoader,
  type AgentSession,
  type AgentSessionEvent,
  type ExtensionAPI,
  ModelRegistry,
  type ModelRuntime,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

import { sponsoredRunActive } from "../abacus-endpoint.js";
import { Allowances } from "../allowances.js";
import { PYTHON_SETUP_TIMEOUT_MS, setPythonProvisioner } from "../backends.js";
import { notifyConversationQueueCleared } from "../background-processes.js";
import { basePrompt } from "../base-prompt.js";
import { BotOutputSanitizer, tidyBotText } from "../bot/bot-output.js";
import {
  browserTaskEnabled,
  buildBrowserTaskTool,
} from "../browser-task-tool.js";
import type { BrowserTaskContext } from "../browser-task.js";
import {
  BROWSER_CHECKOUT_TOOL_NAME,
  withCheckoutToken,
} from "../checkout-run.js";
import { anchorCompactions } from "../compaction-anchor.js";
import {
  agentDir,
  applyStoredApiKeys,
  defaultModelFor,
  loadConfig,
  PROVIDER_API_KEY_ENV,
} from "../config.js";
import { hostConnectivity, hostIsGone } from "../connectivity.js";
import {
  fetchHold,
  setCurrentMode,
  setUnattendedPolicy,
} from "../current-mode.js";
import { EmptyReplies } from "../empty-reply.js";
import { tagEvent, type EventMeta } from "../event-meta.js";
import { TOOL_NAME_ALIASES } from "../excluded-tools.js";
import background from "../extensions/background.js";
import budgets, { budgetStopReason } from "../extensions/budgets.js";
import compactionPruner from "../extensions/compaction-pruner.js";
import spill from "../extensions/spill.js";
import toolCallRepair from "../extensions/tool-call-repair.js";
import toolTimeouts from "../extensions/tool-timeouts.js";
import { githubPrompt } from "../github-prompt.js";
import { refreshGithubToken } from "../github-token.js";
import { HostServiceClient } from "../host-services.js";
import type { InternalAgentEvent } from "../internal-events.js";
import {
  connectMcpServers,
  toolOriginOf,
  type ConnectedMcp,
} from "../mcp/index.js";
import { McpToolSync } from "../mcp/tool-sync.js";
import { buildMcpToolDefinitions, mcpToolCaller } from "../mcp/tools.js";
import { MidTaskInbox, type MidTaskMessage } from "../mid-task-inbox.js";
import { MODEL_PATH_RESOURCES } from "../model-path.js";
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
} from "../network-wait.js";
import { endedOnLeakedToolCall, networkVerdict } from "../openllm-failures.js";
import {
  OPENLLM_CONTINUATION_PROMPT,
  OPENLLM_CONTINUATION_TYPE,
  OpenLlmRouter,
} from "../openllm-router.js";
import { isOpenLlmReference, OPENLLM_ID } from "../openllm.js";
import { refreshOpenRouterLive } from "../openrouter-live.js";
import { OwnedTurn } from "../owned-turn.js";
import { isOwnerAudience } from "../owner-tools.js";
import { PendingSteers, type PendingSteer } from "../pending-steers.js";
import {
  gateToolCall,
  MODE_NAMES,
  parseMode,
  parseModeStrict,
  repairEscapedPaths,
} from "../permissions.js";
import { personaPrompt, readPersona } from "../persona.js";
import { scriptRuntimesPrompt, windowsShellPrompt } from "../posix-shell.js";
import {
  AgentMode,
  AgentStatus,
  type AgentEvent,
  type DesktopEvent,
  type PermissionDecision,
  type PermissionRequest,
  type ToolRequest,
  type TurnOutcome,
} from "../protocol.js";
import {
  createModelRuntime,
  registerAbacusProvider,
  registerCustomProviders,
  registerGeminiProvider,
  resolveModel,
  DEFAULT_MAX_OUTPUT_TOKENS,
} from "../providers.js";
import {
  replyLanguageMismatch,
  replyLanguageRepairPrompt,
  type ReplyLanguageMismatch,
} from "../reply-language.js";
import { mediaCheckFrom } from "../send-media-tool.js";
import { MEDIA_CHECK_TOOL_NAME } from "../send-media.js";
import { conversationSessionManager } from "../session-file.js";
import type { TurnHandle } from "../session.js";
import {
  capRetriesWhileRouting,
  endedOnProviderError,
  mcpPrompt,
  mcpRosterFingerprint,
  reserveContextHeadroom,
} from "../session.js";
import {
  MAX_STALL_RECOVERIES_PER_TURN,
  STALL_CONTINUATION_PROMPT,
  STALL_CONTINUATION_TYPE,
  StallWatch,
  modelStallMs,
} from "../stall-watch.js";
import { continueCutReply, streamCutStep } from "../stream-cut.js";
import { ToolCallStream } from "../tool-call-stream.js";
import { ToolHeartbeat } from "../tool-heartbeat.js";
import { mcpToolAllowed, type UnattendedPolicy } from "../tool-policy.js";
import { TOOLS_ARRIVED_TYPE, toolsArrivedPrompt } from "../tools-arrived.js";
import { setTrashMover, TRASH_TIMEOUT_MS } from "../trash.js";
import {
  EMPTY_REPLY_FAILURE,
  endedEmpty,
  isBusyCause,
  isContextTooLong,
  presentFailure,
  type TurnFailure,
} from "../turn-outcome.js";
import { turnUsage, type TurnUsage } from "../turn-usage.js";
import {
  accountReplyLanguagePrompt,
  learnUserLanguage,
} from "../user-language.js";
import webTools from "../web/tools.js";
import type { ForeverProfile, HiddenTurnPrompt } from "./profile.js";
import { TurnReply } from "./turn-reply.js";

export interface ForeverEngineOptions {
  cwd: string;
  model?: string;
  mode?: string;
  /** A held chat's reach (`--unattended-fd` at spawn); read only in the unattended mode. */
  unattended?: UnattendedPolicy;
  emit: (event: DesktopEvent) => void;
  /** Facts for the AG-UI emitter only; see SessionOptions.emitInternal. */
  emitInternal?: (event: InternalAgentEvent) => void;
}

interface PendingPermission {
  resolve: (decision: PermissionDecision) => void;
}

const CHARS_PER_TOKEN = 4;

/** The custom message carrying a profile's beforeTurn context. */
const FOREVER_CONTEXT_TYPE = "abacusai-bot:forever-turn-context";

const MALFORMED_TOOL_CALL_PATTERN = /malformed[ _]?(function|tool)[ _]?call/i;

const MAX_MALFORMED_CONTINUATIONS = 1;

function approvalTimeoutMs(): number {
  const raw = Number(process.env.ABACUSAI_BOT_APPROVAL_TIMEOUT_MS);

  if (Number.isFinite(raw) && raw === 0) return Number.POSITIVE_INFINITY;

  return Number.isFinite(raw) && raw > 0 ? raw : 15 * 60_000;
}

export class ForeverEngine {
  private readonly pendingSteers = new PendingSteers();
  /** While a browser run takes the user's messages, the only place they go. */
  private readonly midTask = new MidTaskInbox((message) =>
    this.noteMidTaskRead(message)
  );
  /** What the user-visible part of the current send answers. */
  private readonly reply = new TurnReply();
  /** True while the router is what the user picked. See currentModelReference. */
  private openLlmActive = false;
  /** The free pool: which model runs, and what happens when it fails. See openllm-router.ts. */
  private readonly router = new OpenLlmRouter();
  /** Whether the Abacus provider was registered with the sponsored-run marker. */
  private sponsoredAtRegistration = sponsoredRunActive();
  /**
   * Set at `agent_end` when the turn died on its provider and another pool
   * model takes it over; carried out by continuePastRecoverableFailures.
   */
  private pendingOpenLlmRotation: { failure: string; nextId: string } | null =
    null;
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
  /** Some of a cut reply arrived this turn, and is kept. */
  private cutStreamedThisTurn = false;
  /** A model call gone silent; see stall-watch.ts. */
  private readonly stallWatch = new StallWatch({
    turnRunning: () => this.turnRunning,
    toolsRunning: () => this.heartbeat.size,
    onStall: () => void this.onModelStall(),
  });
  private pendingStall: { modelId: string } | null = null;
  private stallRecoveriesThisTurn = 0;
  /** The turn already ended on the stall error; pi's aborted state is not a second one. */
  private stallFailureReported = false;
  /**
   * True from the end of the user's turn until this send returns: memory
   * upkeep runs, and a message steered now would be answered inside a hidden
   * turn. It stays in the host's queue instead, which runs it as its own turn.
   */
  private upkeep = false;
  private session: AgentSession | undefined;
  private sessionInit: Parameters<typeof createAgentSession>[0] | undefined;
  private modelRuntime: ModelRuntime | undefined;
  private registry: ModelRegistry | undefined;
  private resourceLoader: DefaultResourceLoader | undefined;
  private readonly config = loadConfig();
  private readonly maxOutputTokens: number =
    this.config.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
  private mode: AgentMode;
  /**
   * The live session's extension handle. Taken only when a session is built:
   * a loader reload re-runs the factories into a runtime the live session
   * never reads, and tools registered there reach no model.
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
    accepts: (tool) => this.acceptsMcpTool(tool),
    turnRunning: () => this.turnRunning,
  });
  private unsubscribe: (() => void) | undefined;

  /**
   * Whether the model sees an MCP tool: one the profile's policy allows, not
   * a raw browser tool (a `browser_task` sub-agent drives those), and not
   * one a profile tool of the same name shadows.
   */
  private acceptsMcpTool(tool: { name: string }): boolean {
    if (tool.name.startsWith("browser_")) return false;
    if (this.profile.replacesMcpTool(tool.name)) return false;
    const server = this.mcp.routes.get(tool.name)?.client.name;
    const builtin =
      server != null &&
      this.mcp.statuses.some(
        (status) => status.name === server && status.isBuiltin === true
      );
    return mcpToolAllowed(this.profile.mcpTools, { name: tool.name, builtin });
  }

  // Approval flow.
  private readonly pending = new Map<string, PendingPermission>();
  private permissionCounter = 0;
  /** What the user chose to always allow, for this process's lifetime. See allowances.ts. */
  private readonly allowances = new Allowances();

  // Streaming state.
  private readonly sanitizer = new BotOutputSanitizer();
  /** Raw (unsanitized) streamed text of the in-flight assistant message. */
  private rawStreamed = "";
  private currentMessageId: string | null = null;
  private messageCounter = 0;
  /** Streamed tool calls, for the AG-UI emitter only. */
  private readonly toolCallStream = new ToolCallStream(
    (name) => TOOL_NAME_ALIASES[name] ?? name
  );
  private readonly toolInputs = new Map<string, Record<string, unknown>>();
  /** The desktop's services; the bot uses only the Python setup. */
  private readonly hostServices = new HostServiceClient(
    (requestId, service, payload) =>
      this.options.emit({
        type: "host_service_request",
        requestId,
        service,
        payload,
      })
  );
  private readonly heartbeat = new ToolHeartbeat((event) =>
    this.options.emit(event)
  );

  // Turn recovery state.
  private interrupted = false;
  private malformedContinuations = 0;
  private contextCompactions = 0;
  private continuingPastMalformedToolCall = false;
  private pendingContextCompaction: string | null = null;
  /** A reply in the wrong language, to be asked for again (once per turn). */
  private pendingLanguageRepair: ReplyLanguageMismatch | null = null;
  private languageRepairsThisTurn = 0;
  /** The turn's recoveries from an empty reply (empty-reply.ts). */
  private readonly emptyReplies = new EmptyReplies();
  /** The same model is to be asked again, out of sight, for its answer. */
  private pendingEmptyAsk = false;
  /** Whether a user turn is in flight: a refresh landing now is mid-turn. */
  private turnRunning = false;
  /** The turn the running `send` owns; its end waits for the send's report. */
  private ownedTurn: OwnedTurn | null = null;
  /** Tools a change deferred under this turn adds; continued into once. */
  private pendingToolArrival: string[] | null = null;
  private toolArrivalsThisTurn = 0;

  // Memory machinery.
  /** The provider's usage for the turn's last request, set at agent_end. */
  private lastTurnUsage: TurnUsage | null = null;
  /** Rough transcript size in chars, updated at every agent_end. */
  private estimatedTranscriptChars = 0;
  /** One flush per compaction cycle; reset when a compaction happens. */
  private flushedSinceCompaction = false;
  /** True while a flush/consolidation turn runs: its output stays hidden. */
  private hiddenTurn = false;
  /** The hidden turn's last assistant text, for its accept hook. */
  private hiddenReply = "";
  /** What the current prompt's memory block was built from. */
  private promptMemoryFingerprint = "";
  private promptPersona = "";
  /** The MCP roster the prompt was last built against. */
  private promptMcpRoster = "";
  /** The reply-language block the prompt was built with. */
  private promptReplyLanguage: string | null = null;

  constructor(
    private readonly options: ForeverEngineOptions,
    private readonly profile: ForeverProfile
  ) {
    this.mode = parseMode(options.mode);
    // The sandbox reads the mode from here: a bot in YOLO runs unconfined,
    // as a chat in YOLO does.
    setCurrentMode(this.mode);
    setUnattendedPolicy(
      this.mode === AgentMode.Unattended ? (options.unattended ?? null) : null
    );
    // A bot's shell asks the desktop for the app's Python, as a chat's does.
    setPythonProvisioner(() =>
      this.hostServices.request("python_env", {}, PYTHON_SETUP_TIMEOUT_MS)
    );
    // And its deletes go to the trash the same way.
    setTrashMover(async (file) => {
      await this.hostServices.request(
        "trash_item",
        { path: file },
        TRASH_TIMEOUT_MS
      );
    });
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

    this.mcp = await connectMcpServers(process.env.ABACUSAI_BOT_MCP_CONFIG);
    this.mcp.onToolsAdded = () => this.mcpTools.changed();
    this.mcp.onStatusChange = () => this.emitMcpServers();

    const settingsManager = SettingsManager.create(this.options.cwd, dir);
    // On the router a failing model is rotated away from, not retried thrice.
    capRetriesWhileRouting(settingsManager, () => this.openLlmActive);

    // A fraction of the live window rather than pi's flat 16k.
    reserveContextHeadroom(
      settingsManager,
      () => this.session?.model?.contextWindow
    );

    // Frozen at session start on purpose: the bridge from the previous
    // session, not a live feed. Standing memory is re-read on prompt rebuilds.
    const sessionStartMemory = this.profile.memory.sessionStartPrompt();

    const resourceLoader = new DefaultResourceLoader({
      // Skill and AGENTS.md paths as the model should copy them.
      ...MODEL_PATH_RESOURCES,
      cwd: this.options.cwd,
      agentDir: dir,
      settingsManager,
      // Every prompt pi builds starts from ours; see base-prompt.ts. No
      // edit-tool extension here, so `edit` is pi's built-in.
      systemPromptOverride: () => basePrompt("builtin"),
      appendSystemPrompt: [
        ...this.profile.systemPrompt(),
        githubPrompt(),
        windowsShellPrompt(),
        scriptRuntimesPrompt(),
      ].filter((part): part is string => part != null),
      appendSystemPromptOverride: (base: string[]): string[] => {
        const persona = personaPrompt();
        const memory = this.profile.memory.standingPrompt();
        // Live on every rebuild: a connector added mid-conversation must show.
        const mcp = mcpPrompt(this.mcp.statuses);
        this.promptMcpRoster = mcpRosterFingerprint(this.mcp.statuses);
        // Same block as the desktop chat; the check at agent_end catches drift.
        const language = this.replyLanguagePrompt();
        this.promptReplyLanguage = language;

        return [
          ...(persona == null ? [] : [persona]),
          ...base,
          ...(mcp == null ? [] : [mcp]),
          ...(memory == null ? [] : [memory]),
          ...(sessionStartMemory == null ? [] : [sessionStartMemory]),
          // Last of all, so it outweighs a kickstart or routine written in English.
          ...(language == null ? [] : [language]),
        ];
      },
      extensionFactories: [
        {
          name: "abacusai-bot-bot-permissions",
          factory: this.permissionExtension,
        },
        {
          name: "abacusai-bot-tool-timeouts",
          factory: toolTimeouts as unknown as (pi: ExtensionAPI) => void,
        },
        {
          name: "abacusai-bot-spill",
          factory: spill as unknown as (pi: ExtensionAPI) => void,
        },
        {
          name: "abacusai-bot-compaction-pruner",
          factory: compactionPruner as unknown as (pi: ExtensionAPI) => void,
        },
        {
          name: "abacusai-bot-web",
          factory: webTools as unknown as (pi: ExtensionAPI) => void,
        },
        {
          name: "abacusai-bot-tool-call-repair",
          factory: toolCallRepair as unknown as (pi: ExtensionAPI) => void,
        },
        {
          name: "abacusai-bot-budgets",
          factory: budgets as unknown as (pi: ExtensionAPI) => void,
        },
        // Background bash: the finish notice, fetch_background_output and
        // kill_process the bot's bash tool promises.
        {
          name: "abacusai-bot-background",
          factory: background as unknown as (pi: ExtensionAPI) => void,
        },
        // Observes compaction so the flush budget renews per cycle.
        {
          name: "abacusai-bot-bot-context",
          factory: (pi: ExtensionAPI): void => {
            pi.on("session_before_compact", async (event) => {
              this.flushedSinceCompaction = false;
              const { messagesToSummarize, turnPrefixMessages } =
                event.preparation;
              await this.profile.beforeCompaction?.([
                ...messagesToSummarize,
                ...turnPrefixMessages,
              ]);
            });
          },
        },
      ],
    });

    await resourceLoader.reload();
    this.resourceLoader = resourceLoader;
    this.promptPersona = readPersona();
    this.promptMemoryFingerprint = this.profile.memory.fingerprint();

    const model = this.resolveStartModel(registry);

    // The profile's own tools replace same-named MCP ones. Raw browser tools
    // stay out: a bot gets one `browser_task`, a sub-agent walks pages.
    const isBrowserTool = (tool: { name: string }): boolean =>
      tool.name.startsWith("browser_");
    const mcpTools = buildMcpToolDefinitions(() => this.mcp).filter((tool) =>
      this.acceptsMcpTool(tool)
    );

    for (const tool of mcpTools) this.mcpTools.registered.add(tool.name);

    const hasBrowser = buildMcpToolDefinitions(() => this.mcp).some(
      isBrowserTool
    );
    // Asked before `send_media` says an image went; no browser, no answer.
    const mediaCheck = mediaCheckFrom(
      mcpToolCaller(() => this.mcp, MEDIA_CHECK_TOOL_NAME)
    );
    const browserContext: BrowserTaskContext | null =
      hasBrowser && browserTaskEnabled()
        ? {
            cwd: this.options.cwd,
            agentDir: dir,
            modelRuntime: this.modelRuntime,
            settingsManager,
            browserTools: () =>
              buildMcpToolDefinitions(() => this.mcp).filter(isBrowserTool),
            checkout:
              withCheckoutToken(
                mcpToolCaller(() => this.mcp, BROWSER_CHECKOUT_TOOL_NAME)
              ) ?? undefined,
            ...(model.model ? { model: model.model } : {}),
            mediaCheck,
            ...this.profile.browserTask,
            // A run that can answer the user owns their mid-task messages.
            ...(this.profile.browserTask?.progressTools != null
              ? { midTask: this.midTask }
              : {}),
          }
        : null;
    const browserTaskTools =
      browserContext != null
        ? [
            buildBrowserTaskTool(browserContext, (event) =>
              this.emitAgentEvent(event)
            ),
          ]
        : [];

    const customTools = [
      ...this.profile.tools(this.options.cwd, { mediaCheck }),
      ...browserTaskTools,
      ...mcpTools,
    ];

    // Picks the chat back up; undefined without a desktop session behind it.
    const sessionManager = conversationSessionManager(this.options.cwd);

    this.sessionInit = {
      cwd: this.options.cwd,
      agentDir: dir,
      modelRuntime: this.modelRuntime,
      resourceLoader,
      settingsManager,
      customTools: customTools as never,
      ...(sessionManager != null ? { sessionManager } : {}),
    };

    const created = await createAgentSession({
      ...this.sessionInit,
      ...(model.model ? { model: model.model } : {}),
    });

    this.session = created.session;
    this.pi = this.loadedPi;
    // A degenerate summary from a cheap model must not erase the history.
    anchorCompactions(this.session.sessionManager, {
      anchorRequest: this.profile.anchorCompaction !== false,
    });
    this.unsubscribe = this.session.subscribe((event) => this.onPiEvent(event));

    this.emitReady();

    if (model.error != null) {
      this.emitAgentEvent(
        {
          type: "error",
          error: { message: model.error, code: "model_unavailable" },
        },
        { origin: "startup" }
      );
    }

    // Bots have no skills; the desktop still expects the roster event.
    this.options.emit({ type: "skills_loaded", skills: [] });
    this.emitMcpServers();
  }

  /**
   * The model this chat starts on. `openllm/auto` resolves once: the bot loop
   * has no mid-turn rotation, and pi's retries cover transient failures.
   */
  private resolveStartModel(registry: ModelRegistry): {
    model?: ReturnType<typeof resolveModel>["model"];
    error?: string;
  } {
    const runtime = this.modelRuntime;

    if (runtime == null) return { error: "model runtime failed to start" };

    const requested =
      this.options.model ?? this.config.defaultModel ?? defaultModelFor();

    // The router is the choice; the model it lands on is a detail.
    this.openLlmActive = isOpenLlmReference(requested);

    const reference = this.openLlmActive
      ? this.router.pick(registry)?.id
      : requested;

    // A model the router did not pick is not the router's: reporting
    // openllm/auto over a fallback would label its failures as the pool's,
    // upgrade card and all.
    const fallBack = (model: ReturnType<typeof resolveModel>["model"]) => {
      if (this.openLlmActive && model != null) {
        this.openLlmActive = false;
        this.emitAgentEvent({
          type: "notification",
          severity: "warning",
          message: `The free pool has no model to run on right now; running on ${model.provider}/${model.id} instead.`,
        });
      }
      return model;
    };

    if (reference == null) {
      const fallback = fallBack(registry.getAvailable()[0]);

      return fallback != null
        ? { model: fallback }
        : {
            error: NO_MODEL_CONFIGURED,
          };
    }

    const resolved = resolveModel(runtime, reference, this.maxOutputTokens);
    const model =
      resolved.model != null && registry.hasConfiguredAuth(resolved.model)
        ? resolved.model
        : fallBack(registry.getAvailable()[0]);

    return model != null
      ? { model }
      : {
          error: resolved.error ?? NO_MODEL_CONFIGURED,
        };
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

  /** Emit the owned turn's held end with its outcome; see OwnedTurn. */
  private closeOwnedTurn(owned: OwnedTurn): void {
    if (this.ownedTurn === owned) this.ownedTurn = null;
    owned.close(this.interrupted);
  }

  private async sendTurn(
    text: string,
    turn: TurnHandle | undefined,
    slot: { owned?: OwnedTurn }
  ): Promise<void> {
    const session = this.requireSession();
    this.reply.begin(turn?.messageId);

    // A bot spawned while the account was signed out has no model. The key
    // may have arrived since; read it and pick a model before prompting, or
    // pi answers with its own /login hint and that reaches the user's phone.
    if (!(await this.ensureUsableModel())) {
      this.emitAgentEvent(
        {
          type: "error",
          error: { message: NO_MODEL_CONFIGURED, code: "model_unavailable" },
        },
        { origin: "turn" }
      );
      this.emitReply();
      turn?.settled?.();

      return;
    }

    await this.refreshStandingPrompt();
    await this.startTurnOnBestPoolModel();
    // The sponsored window closing (or opening) changes the headers the
    // Abacus provider was registered with; a run must not carry the marker
    // past its deadline, nor miss it.
    if (this.sponsoredAtRegistration !== sponsoredRunActive())
      await this.refreshProviderRegistrations();

    // A run pi started on its own while this turn was being prepared (a
    // finished background job's notice) ends first: pi refuses a prompt over
    // it. Nothing below waits on anything but microtasks before the prompt.
    await session.waitForIdle();

    this.interrupted = false;
    this.malformedContinuations = 0;
    this.contextCompactions = 0;
    this.pendingContextCompaction = null;
    // A rotation left over from a stopped turn must not fire here.
    this.pendingOpenLlmRotation = null;
    this.router.beginTurn();
    this.pendingNetworkFailure = null;
    this.pendingBusyWait = null;
    this.networkWait.reset();
    this.busyWait.reset();
    this.networkFailureReported = false;
    this.stallRecoveriesThisTurn = 0;
    this.pendingStall = null;
    this.stallFailureReported = false;
    this.pendingStreamCut = false;
    this.streamCutsThisTurn = 0;
    this.cutStreamedThisTurn = false;
    this.languageRepairsThisTurn = 0;
    this.pendingLanguageRepair = null;
    this.pendingEmptyAsk = false;
    this.emptyReplies.begin();
    this.mcpTools.atTurnStart();
    this.pendingToolArrival = null;
    this.toolArrivalsThisTurn = 0;
    this.turnRunning = true;
    const owned = new OwnedTurn();
    this.ownedTurn = owned;
    slot.owned = owned;

    this.emitAgentEvent({
      type: "status_changed",
      status: AgentStatus.Submitted,
    });

    // At the credit wall the turn waits for the user's choice: it never
    // runs on a weaker model they have not chosen.
    const wall =
      this.openLlmActive && this.registry != null
        ? this.router.wallStops(this.registry)
        : null;
    if (wall != null) {
      this.emitFailure(wall);
      this.finishTurn();
      this.closeOwnedTurn(owned);
      this.emitReply();
      turn?.settled?.();
      return;
    }

    try {
      // The cut-off card's Continue: the cut reply is picked up, never asked
      // anew, and the message it answers was read when it was sent.
      if (turn?.continueCut === true) await continueCutReply(session);
      else {
        this.profile.noteUserWords?.(text);
        // Only the user's own words name their language: not a sender's, not a routine's.
        if (isOwnerAudience() && this.profile.statesReplyLanguage !== true)
          void learnUserLanguage(
            text,
            (process.env.ABACUS_API_KEY ?? "").trim()
          );
        const context = await this.profile.beforeTurn(text);
        // Rides along with the user's message, not as a turn of its own.
        if (context.length > 0)
          await session.sendCustomMessage(
            {
              customType: FOREVER_CONTEXT_TYPE,
              content: context,
              display: false,
            },
            { deliverAs: "nextTurn" }
          );
        await session.prompt(text);
      }
      await this.continuePastRecoverableFailures();
      this.reportTurnFailure();
      this.closeOwnedTurn(owned);
      this.emitReply();
      // Steers pi has not delivered yet are still queued at the host.
      this.upkeep = true;
      this.dropSteers();
      // The user's reply is over; housekeeping below is not part of it.
      turn?.settled?.();
      await this.runMemoryMaintenance();
      await this.profile.afterTurn();
    } catch (error) {
      // A thrown provider error gets the same words as a reported turn
      // failure rather than the raw "429: {json}" envelope, and the turn ends
      // properly: a bot left "running" here answered nobody.
      const raw = describe(error);
      this.router.chain.failed(raw, this.session?.model?.provider);
      this.reportFailure();
      if (this.turnRunning) this.finishTurn();
      this.closeOwnedTurn(owned);
      this.emitReply();
      turn?.settled?.();
    } finally {
      this.upkeep = false;
    }
  }

  /**
   * On the router every turn starts on the pool's best model, not on the one
   * the last turn ended on: a model that failed sits out, a provider that
   * refused the account sits out with it, and a hidden housekeeping turn's
   * failure is honoured here without a rotation of its own.
   */
  private async startTurnOnBestPoolModel(): Promise<void> {
    const session = this.session;
    const runtime = this.modelRuntime;
    const registry = this.registry;
    if (
      !this.openLlmActive ||
      session == null ||
      runtime == null ||
      registry == null
    )
      return;
    const best = this.router.pick(registry);
    const current = session.model;
    if (
      best == null ||
      (current != null && best.id === `${current.provider}/${current.id}`)
    )
      return;
    const resolved = resolveModel(runtime, best.id, this.maxOutputTokens);
    if (resolved.model == null) return;
    try {
      await session.setModel(resolved.model);
    } catch {
      // The turn runs on the model the session has; a failure there rotates.
    }
  }

  /**
   * Housekeeping after the user's turn: the pre-compaction flush and the daily
   * consolidation, both hidden turns ending in NO_REPLY by instruction.
   */
  private async runMemoryMaintenance(): Promise<void> {
    const session = this.session;

    if (session == null || this.interrupted) return;

    const memory = this.profile.memory;
    const window = session.model?.contextWindow;
    const flushDue =
      !this.flushedSinceCompaction &&
      window != null &&
      window > 0 &&
      this.estimatedTranscriptChars >
        window * CHARS_PER_TOKEN * memory.flushAtWindowShare;

    if (flushDue) {
      // Only a flush that ran: a failed one is tried again next time, or
      // the next compaction summarises away facts never written down.
      this.flushedSinceCompaction = await this.runHiddenTurn(memory.flush());
    }

    if (this.interrupted) return;

    const consolidation = memory.claimConsolidation();

    if (consolidation != null) await this.runHiddenTurn(consolidation);
  }

  /** Whether the turn ran to a clean end. */
  private async runHiddenTurn({
    customType,
    content,
    accept,
  }: HiddenTurnPrompt): Promise<boolean> {
    const session = this.session;

    if (session == null) return false;

    this.hiddenTurn = true;
    this.hiddenReply = "";
    let ok = false;
    this.emitInternal({ type: "hidden_turn", phase: "start", customType });

    try {
      await session.sendCustomMessage(
        { customType, content, display: false },
        { triggerTurn: true }
      );
      const state = session.state as { errorMessage?: unknown } | undefined;
      ok = typeof state?.errorMessage !== "string" || state.errorMessage === "";
      if (ok && accept != null) ok = await accept(this.hiddenReply);
    } catch {
      // Housekeeping must never surface as a failed reply.
    } finally {
      this.hiddenTurn = false;
      this.emitInternal({ type: "hidden_turn", phase: "end", customType });
    }
    return ok;
  }

  /** The account's reply-language block, or null when the profile's own prompt states the rule. */
  private replyLanguagePrompt(): string | null {
    return this.profile.statesReplyLanguage === true
      ? null
      : accountReplyLanguagePrompt();
  }

  /**
   * Rebuild the standing prompt when the persona or memory files changed, so
   * the prompt cache is spent only when something real changed.
   */
  private async refreshStandingPrompt(): Promise<void> {
    const persona = readPersona();
    const fingerprint = this.profile.memory.fingerprint();
    const roster = mcpRosterFingerprint(this.mcp.statuses);
    const language = this.replyLanguagePrompt();

    if (
      persona === this.promptPersona &&
      fingerprint === this.promptMemoryFingerprint &&
      roster === this.promptMcpRoster &&
      language === this.promptReplyLanguage
    )
      return;

    this.promptPersona = persona;
    this.promptMemoryFingerprint = fingerprint;

    const loader = this.resourceLoader;

    if (loader == null || this.session == null) return;

    await loader.reload();
    this.session.setActiveToolsByName(this.session.getActiveToolNames());
  }

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

      if (this.pendingOpenLlmRotation != null) {
        await this.rotateOpenLlmModel();

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
        await this.askAfterEmptyReply();

        continue;
      }

      if (this.pendingLanguageRepair != null) {
        const mismatch = this.pendingLanguageRepair;
        this.pendingLanguageRepair = null;
        this.languageRepairsThisTurn += 1;

        await this.session?.sendCustomMessage(
          {
            customType: this.profile.continuations.languageRepairType,
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

        await this.session?.sendCustomMessage(
          { ...this.profile.continuations.malformedToolCall, display: false },
          { triggerTurn: true }
        );

        continue;
      }

      await this.compactAndRetry();
    }
  }

  /**
   * Whether the turn that just ended continues on another pool model, and
   * which. Decided at `agent_end`, where the idle event it suppresses would
   * be emitted; the router picks the candidate here so that promise is never
   * made for a fallback that does not exist.
   */
  private shouldRotateOpenLlm(messages: readonly unknown[]): {
    rotation: { failure: string; nextId: string } | null;
    busy: { failure: string } | null;
  } {
    const none = { rotation: null, busy: null };
    if (!this.openLlmActive || this.interrupted) return none;

    const failure =
      endedOnProviderError(messages) ?? endedOnLeakedToolCall(messages);
    const current = this.session?.model;

    if (failure == null) {
      // The model answered: proof it works, else its failure count only climbs.
      // An empty reply is no answer (EmptyReplies decides what follows it).
      if (current != null && !endedEmpty(messages))
        this.router.succeeded(`${current.provider}/${current.id}`);
      return none;
    }

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
    if (registry == null) return { rotation: null, busy: null };

    const next = this.router.failed(registry, failure, this.session?.model);
    if (next != null && "nextId" in next)
      return { rotation: { failure, nextId: next.nextId }, busy: null };

    const busy =
      isBusyCause(failure, this.session?.model?.provider) &&
      // The free lane waits for nobody: its failure is the wall's card.
      !this.router.onFreeLane(this.session?.model?.provider) &&
      this.busyWait.available &&
      !this.router.poolShut(registry);
    process.stderr.write(
      `[abacusai-bot-agent] bot pool not rotating after "${failure.slice(0, 80)}": no other candidate${busy ? "; waiting for the soonest" : ""}\n`
    );

    return { rotation: null, busy: busy ? { failure } : null };
  }

  /**
   * The call failed in a way that may be the network's. If it is, the turn
   * waits for the connection and picks up where it stopped; if the Abacus
   * API answers, it is a provider failure and goes the usual way.
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

    // The Abacus API answers, but this call's connection failed: a few quick
    // retries of the same call, never a rotation as if the model were busy.
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
   * soonest (bounded), then ask it again, before saying they are all busy.
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
   * Move the pool to its next model and run the turn on, with a custom
   * message for the same reasons as the malformed-call continuation. The
   * thread stays quiet about it: a bot is not supervised, and the model it
   * lands on is a detail of the router the user chose.
   */
  private async rotateOpenLlmModel(): Promise<void> {
    const rotation = this.pendingOpenLlmRotation;
    this.pendingOpenLlmRotation = null;

    const runtime = this.modelRuntime;
    const session = this.session;
    if (rotation == null || runtime == null || session == null) return;

    const failed = session.model;
    const resolved = resolveModel(
      runtime,
      rotation.nextId,
      this.maxOutputTokens
    );

    if (resolved.model == null) {
      // The candidate came off the live registry a moment ago; should not
      // happen. The idle event was withheld for this rotation, so end the turn.
      this.reportFailure();
      this.finishTurn();
      return;
    }

    await session.setModel(resolved.model);

    if (this.interrupted) {
      this.finishTurn();
      return;
    }

    this.emitAgentEvent({
      type: "model_changed",
      model: this.currentModelReference(),
    });
    await session.sendCustomMessage(
      {
        customType: OPENLLM_CONTINUATION_TYPE,
        // After a busy wait the same model may be asked again.
        content:
          `${failed?.provider}/${failed?.id}` === rotation.nextId
            ? BUSY_RETRY_PROMPT
            : OPENLLM_CONTINUATION_PROMPT,
        display: false,
      },
      { triggerTurn: true }
    );
  }

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
   * The call went quiet for the stall window and was aborted. On the router
   * the model sits out and the next one takes over, as for any failure; a
   * pinned model is asked once more, then the turn ends saying why.
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
      const failure = `no reply in ${Math.round(seconds)}s`;
      const next = this.router.failed(registry, failure, this.session?.model);
      if (next != null && "nextId" in next) {
        this.pendingOpenLlmRotation = { failure, nextId: next.nextId };
        return;
      }
    }

    if (this.stallRecoveriesThisTurn < MAX_STALL_RECOVERIES_PER_TURN) {
      this.stallRecoveriesThisTurn += 1;
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

  /** Same shape as the coding loop's recovery: compact once, retry once. */
  private async compactAndRetry(): Promise<void> {
    const failure = this.pendingContextCompaction;
    const session = this.session;

    this.pendingContextCompaction = null;

    if (failure == null || session == null) return;

    this.contextCompactions += 1;

    try {
      await session.compact();
    } catch {
      // Nothing older than the recency window to summarise. Another pool
      // model may have room for the transcript as it stands.
      const registry = this.registry;
      const next =
        this.openLlmActive && registry != null
          ? this.router.failed(registry, failure, session.model)
          : null;
      if (next != null && "nextId" in next) {
        this.pendingOpenLlmRotation = { failure, nextId: next.nextId };
        return;
      }
      if (!this.openLlmActive)
        this.router.chain.failed(failure, session.model?.provider);
      this.reportFailure();
      this.finishTurn();

      return;
    }

    this.flushedSinceCompaction = false;

    if (this.interrupted) {
      this.finishTurn();

      return;
    }

    await session.sendCustomMessage(
      { ...this.profile.continuations.compaction, display: false },
      { triggerTurn: true }
    );
  }

  private reportTurnFailure(): void {
    if (
      this.interrupted ||
      this.stallFailureReported ||
      this.networkFailureReported
    )
      return;

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
    // failure, never in silence.
    else if (this.ownedTurn?.endedEmpty === true)
      this.router.chain.failed(
        EMPTY_REPLY_FAILURE,
        this.session?.model?.provider
      );

    this.reportFailure();
  }

  /** The model answered with nothing: it is asked, out of sight, to answer. */
  private async askAfterEmptyReply(): Promise<void> {
    const model = this.session?.model;
    process.stderr.write(
      `[provider] ${model != null ? `${model.provider}/${model.id}` : "the model"} returned an empty reply; asking it to answer.\n`
    );
    await this.session?.sendCustomMessage(
      { ...this.profile.continuations.emptyReply, display: false },
      { triggerTurn: true }
    );
  }

  /**
   * The one error the turn's whole chain of calls comes to, when its last
   * call did not answer (turn-outcome.ts). The gateway words it for the
   * chat app; an empty reply after a failure is a failure, never silence.
   */
  private reportFailure(): void {
    const registry = this.registry;
    const failure = this.router.chain.failure(
      this.openLlmActive && registry != null && this.router.poolShut(registry)
    );
    if (failure != null) this.emitFailure(failure);
  }

  private emitFailure(failure: TurnFailure): void {
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
   * Whether pi has a run going, including one it started itself (a finished
   * background job's notice) that no `send` owns.
   */
  isRunning(): boolean {
    return this.session?.isStreaming === true;
  }

  /** Resolves once pi has no run going, after any run its settling started. */
  async whenIdle(): Promise<void> {
    await this.session?.waitForIdle();
  }

  /**
   * Mid-turn input. pi delivers it at the next step boundary; the text is
   * remembered so its arrival can be reported to the desktop.
   */
  async steer(text: string, messageId?: string): Promise<void> {
    // Steered into housekeeping it would be answered where no one reads.
    if (this.upkeep || this.hiddenTurn) return;
    this.profile.noteUserWords?.(text);
    if (this.midTask.live) {
      try {
        await this.midTask.deliver({
          text,
          ...(messageId != null && { messageId }),
        });
      } catch (error) {
        // Still in the host's queue, which runs it once this turn ends.
        process.stderr.write(
          `[abacusai-bot-agent] mid-task message not taken by the browser run: ${describe(error)}\n`
        );
      }
      return;
    }
    this.pendingSteers.add(text, messageId);
    await this.requireSession().steer(text);
  }

  /**
   * Forget undelivered steers. Called before a leftover message runs as its
   * own turn, so the model does not also see it as a steer.
   */
  dropSteers(): void {
    this.pendingSteers.clear();
    this.session?.clearQueue();
  }

  /** A user message pi just started is one of ours if the text matches. */
  private noteSteerLanded(message: unknown): void {
    if ((message as { role?: unknown } | undefined)?.role !== "user") return;
    const steer = this.pendingSteers.take(messageText(message));
    if (steer != null) this.noteSteered(steer);
  }

  /** The browser run's model read a mid-task message: it is this turn's, like a steer. */
  private noteMidTaskRead(message: MidTaskMessage): void {
    this.noteSteered({ text: message.text, messageId: message.messageId });
  }

  private noteSteered(steer: PendingSteer): void {
    this.reply.answers(steer.messageId);
    this.emitAgentEvent({
      type: "user_message_steered",
      content: steer.text,
      ...(steer.messageId != null && { messageId: steer.messageId }),
    });
  }

  /** The send's `turn_reply`, once, after any failure it reported. */
  private emitReply(): void {
    const event = this.reply.take();
    if (event != null) this.emitAgentEvent(event);
  }

  async stop(): Promise<void> {
    this.interrupted = true;
    // A turn waiting for the network or a busy pool ends now, not after the wait.
    this.networkWait.cancel();
    this.busyWait.cancel();
    this.reply.abandon();
    this.stallWatch.clear();
    this.rejectAllPending("Interrupted.");
    this.pendingSteers.clear();
    notifyConversationQueueCleared();
    this.session?.clearQueue();
    await this.session?.abort();
    this.session?.clearQueue();
    this.toolInputs.clear();
    this.heartbeat.clear();
  }

  setMode(raw: string): void {
    const next = parseModeStrict(raw);

    if (next == null) {
      this.emitAgentEvent({
        type: "notification",
        severity: "warning",
        message: `"${raw}" is not a mode. Use one of: ${MODE_NAMES.join(", ")}.`,
      });
      this.emitAgentEvent({
        type: "mode_changed",
        mode: this.mode,
        source: "bot",
      });

      return;
    }

    // A held chat (a stranger's) stays held; nothing moves a chat into it either.
    if (
      (this.mode === AgentMode.Unattended || next === AgentMode.Unattended) &&
      next !== this.mode
    ) {
      this.emitAgentEvent({
        type: "mode_changed",
        mode: this.mode,
        source: "bot",
      });
      return;
    }

    this.mode = next;
    // The sandbox reads the mode from here; without it a bot moved off YOLO
    // kept running commands unconfined.
    setCurrentMode(next);
    this.emitAgentEvent({ type: "mode_changed", mode: next, source: "bot" });
  }

  /**
   * The bot lane's half of the desktop's `refresh_providers`: re-read the
   * keys, then give a bot that started without a model the one it can now
   * run. Re-registering alone left such a bot answering "no API key" until
   * someone opened its chat and picked a model by hand.
   */
  async refreshProviders(): Promise<void> {
    await this.refreshProviderRegistrations();
    await this.ensureUsableModel({ refreshed: true });
  }

  /**
   * True when the session has a model it can call. Otherwise re-read the
   * stored keys once and resolve again, the way start did; false only when
   * there is still nothing to run on.
   */
  private async ensureUsableModel(
    options: { refreshed?: boolean } = {}
  ): Promise<boolean> {
    const session = this.session;
    const registry = this.registry;

    if (session == null || registry == null) return false;
    if (session.model != null && registry.hasConfiguredAuth(session.model))
      return true;
    if (!options.refreshed) await this.refreshProviderRegistrations();

    const resolved = this.resolveStartModel(registry);

    if (resolved.model == null) return false;

    await session.setModel(resolved.model);
    this.emitAgentEvent({
      type: "model_changed",
      model: this.currentModelReference(),
    });

    return true;
  }

  private async refreshProviderRegistrations(): Promise<void> {
    this.sponsoredAtRegistration = sponsoredRunActive();
    const registry = this.registry;
    const runtime = this.modelRuntime;

    if (registry == null || runtime == null) return;

    // Whatever sidelined a model or a whole provider may no longer hold:
    // the account's credits, plan or keys just changed under us.
    this.router.clearCooldowns();
    applyStoredApiKeys();
    void refreshGithubToken();

    for (const [provider, envVar] of Object.entries(PROVIDER_API_KEY_ENV)) {
      const key = (process.env[envVar] ?? "").trim();

      if (key.length === 0 || runtime.hasConfiguredAuth(provider)) continue;

      try {
        await runtime.setRuntimeApiKey(provider, key);
      } catch {
        // One provider pi refuses must not stop the rest.
      }
    }

    registerCustomProviders(registry, loadConfig());
    registerGeminiProvider(registry);
    await Promise.all([
      registerAbacusProvider(registry),
      refreshOpenRouterLive(),
    ]);
  }

  async setModel(reference: string): Promise<void> {
    const session = this.requireSession();
    const runtime = this.modelRuntime;
    const registry = this.registry;

    if (runtime == null || registry == null) return;

    const toRouter = isOpenLlmReference(reference);
    const concrete = toRouter ? this.router.pick(registry)?.id : reference;

    const resolved =
      concrete != null
        ? resolveModel(runtime, concrete, this.maxOutputTokens)
        : { model: undefined, error: "the free pool is empty" };

    if (resolved.model == null) {
      this.emitAgentEvent(
        {
          type: "error",
          error: {
            message: resolved.error ?? `Unknown model: ${reference}`,
            code: "model_unavailable",
          },
        },
        { origin: "command" }
      );

      return;
    }

    // Only once the switch has worked: set earlier, a failed switch leaves
    // the picker reporting one model while turns run on another, and pi
    // throws here for a model whose key is missing.
    try {
      await session.setModel(resolved.model);
    } catch (error) {
      this.emitAgentEvent(
        {
          type: "error",
          error: { message: describe(error), code: "model_unavailable" },
        },
        { origin: "command" }
      );
      return;
    }
    this.openLlmActive = toRouter;
    this.emitAgentEvent({
      type: "model_changed",
      model: this.currentModelReference(),
    });
  }

  /** Whether an answer for `permissionId` would release a waiter now. */
  hasPendingPermission(permissionId: string): boolean {
    return this.pending.has(permissionId);
  }

  respondPermission(permissionId: string, decision: PermissionDecision): void {
    const pending = this.pending.get(permissionId);

    if (!pending) return;

    this.pending.delete(permissionId);
    pending.resolve(decision);
  }

  async resetConversation(): Promise<void> {
    this.interrupted = true;
    this.networkWait.cancel();
    this.busyWait.cancel();
    this.rejectAllPending("Conversation reset.");
    this.pendingSteers.clear();
    this.session?.clearQueue();
    await this.session?.abort();
    this.session?.clearQueue();

    if (this.sessionInit != null) {
      const model = this.session?.model;

      this.unsubscribe?.();
      this.session?.dispose();

      // A reset is the one place the saved session must not come back; the
      // file is replaced so the next restart resumes from here.
      const sessionManager = conversationSessionManager(this.options.cwd, {
        fresh: true,
      });
      if (sessionManager != null)
        this.sessionInit.sessionManager = sessionManager;

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
      // A degenerate summary from a cheap model must not erase the history.
      anchorCompactions(this.session.sessionManager, {
        anchorRequest: this.profile.anchorCompaction !== false,
      });
      this.unsubscribe = this.session.subscribe((event) =>
        this.onPiEvent(event)
      );
      this.rawStreamed = "";
      this.sanitizer.reset();
      this.currentMessageId = null;
      this.toolInputs.clear();
      this.heartbeat.clear();
      this.estimatedTranscriptChars = 0;
      this.flushedSinceCompaction = false;
      this.emitReady();
    }

    this.emitAgentEvent({ type: "segments_cleared" });
    this.emitAgentEvent({ type: "status_changed", status: AgentStatus.Idle });
  }

  async refreshMcp(): Promise<void> {
    this.mcp.retire?.();
    for (const client of this.mcp.clients) client.close();

    this.mcp = await connectMcpServers(process.env.ABACUSAI_BOT_MCP_CONFIG);
    this.mcp.onToolsAdded = () => this.mcpTools.changed();
    this.mcp.onStatusChange = () => this.emitMcpServers();
    this.mcpTools.changed();
    this.emitMcpServers();
  }

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

  settleHostService(
    requestId: string,
    ok: boolean,
    result: unknown,
    error: string | undefined
  ): void {
    this.hostServices.settle(requestId, ok, result, error);
  }

  dispose(): void {
    this.hostServices.failAll("Interrupted.");
    this.mcp.retire?.();
    for (const client of this.mcp.clients) client.close();

    this.unsubscribe?.();
    this.session?.dispose();
    this.session = undefined;
  }

  // ------------------------------------------------------------- pi -> desktop

  private onPiEvent(event: AgentSessionEvent): void {
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
          this.rawStreamed = "";
          this.sanitizer.reset();
          this.currentMessageId = `msg-${++this.messageCounter}`;
          this.toolCallStream.reset();
          if (!this.hiddenTurn) {
            this.reply.messageStarted();
            const messageId = this.aguiMessageId(event.message);

            this.emitInternal({
              type: "message_open",
              key: this.currentMessageId,
              ...(messageId != null ? { messageId } : {}),
            });
          }
        }

        return;

      case "message_update": {
        const stream = event.assistantMessageEvent as {
          type: string;
          delta?: string;
        };

        if (stream.type.startsWith("toolcall_")) {
          const internals = this.toolCallStream.handle(stream);

          if (!this.hiddenTurn) {
            for (const internal of internals) this.emitInternal(internal);
          }

          return;
        }

        if (stream.type === "text_delta" && stream.delta) {
          this.rawStreamed += stream.delta;

          if (this.hiddenTurn) return;

          const { text, thinking } = this.sanitizer.push(stream.delta);

          if (text.length > 0) this.streamText(text);

          if (thinking.length > 0)
            this.emitAgentEvent({ type: "thinking_delta", content: thinking });
        } else if (stream.type === "thinking_delta" && stream.delta) {
          if (!this.hiddenTurn)
            this.emitAgentEvent({
              type: "thinking_delta",
              content: stream.delta,
            });
        } else if (stream.type === "thinking_end" && !this.hiddenTurn) {
          this.emitAgentEvent({ type: "thinking_complete" });
        }

        return;
      }

      case "message_end": {
        if (!this.hiddenTurn) this.profile.onMessage?.(event.message);
        if (!isAssistantMessage(event.message)) return;
        this.router.recordReply(event.message);

        const full = messageText(event.message);

        if (this.hiddenTurn && full.length > 0) this.hiddenReply = full;

        if (!this.hiddenTurn) {
          if (this.rawStreamed.length === 0 && full.length > 0) {
            // A non-streaming provider delivers the whole message here.
            const { text, thinking } = this.sanitizer.push(full);
            const tail = this.sanitizer.flush();
            const cleaned = tidyBotText(text + tail.text).trim();
            const reasoning = (thinking + tail.thinking).trim();

            if (reasoning.length > 0)
              this.emitAgentEvent({
                type: "thinking_delta",
                content: reasoning,
              });

            if (cleaned.length > 0) this.streamText(cleaned);
          } else if (full.startsWith(this.rawStreamed)) {
            // Streamed, with a remainder the stream never delivered.
            const { text, thinking } = this.sanitizer.push(
              full.slice(this.rawStreamed.length)
            );
            const tail = this.sanitizer.flush();
            const remainder = text + tail.text;
            const reasoning = thinking + tail.thinking;

            if (remainder.length > 0) this.streamText(remainder);

            if (reasoning.length > 0)
              this.emitAgentEvent({
                type: "thinking_delta",
                content: reasoning,
              });
          } else {
            // An extension replaced the message (tool-call repair); nothing
            // new is owed.
            this.sanitizer.reset();
          }
        }

        if (!this.hiddenTurn && this.currentMessageId != null) {
          const stopReason = (event.message as { stopReason?: unknown })
            .stopReason;

          this.emitInternal({
            type: "message_close",
            key: this.currentMessageId,
            ...(typeof stopReason === "string" ? { stopReason } : {}),
          });
        }

        if (!this.hiddenTurn) this.reply.messageEnded();
        this.rawStreamed = "";
        this.sanitizer.reset();
        this.currentMessageId = null;

        return;
      }

      case "tool_execution_start": {
        const tool = this.toToolRequest(
          event.toolCallId,
          event.toolName,
          event.args
        );

        this.toolInputs.set(event.toolCallId, tool.input);
        this.heartbeat.started(event.toolCallId);

        if (!this.hiddenTurn) {
          this.emitAgentEvent({
            type: "status_changed",
            status: AgentStatus.ExecutingTool,
          });
          this.emitAgentEvent({ type: "tool_execution_start", tool });
        }

        return;
      }

      case "tool_execution_update": {
        const partial = event.partialResult;

        if (
          !this.hiddenTurn &&
          typeof partial === "string" &&
          partial.length > 0
        ) {
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

        if (!this.hiddenTurn) {
          this.emitAgentEvent({
            type: "tool_execution_complete",
            tool,
            result: {
              id: event.toolCallId,
              content: resultText(event.result),
              rejected: event.isError,
            },
          });
        }

        return;
      }

      case "agent_end": {
        // agent_end carries only this run's messages; the default (unset)
        // keeps the bot's existing measurement.
        this.estimatedTranscriptChars = estimateChars(
          this.profile.memory.measureFlushOnFullTranscript === true
            ? (this.session?.messages ?? event.messages)
            : event.messages
        );
        this.lastTurnUsage = turnUsage(event.messages as never);

        // A call that answered ends any outage this turn was riding out.
        if (runMadeProgress(event.messages)) this.networkWait.reset();
        // The run that ends the turn is the last to set it.
        if (this.ownedTurn != null && !this.hiddenTurn)
          this.ownedTurn.endedEmpty = endedEmpty(event.messages);
        // The network's failure is checked (and waited out) before anything
        // reads it as the model's: no cooldown, no rotation, no compaction.
        // A hidden turn has nobody waiting, so it neither waits nor blames.
        let suspect =
          this.interrupted || event.willRetry
            ? null
            : networkSuspect(
                endedOnProviderError(event.messages),
                event.messages
              );
        // Google cut the reply off on a model the user picked: asked once
        // more out of sight, or the network's while the machine is offline.
        const cut =
          suspect != null ||
          this.interrupted ||
          event.willRetry ||
          this.hiddenTurn ||
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
            suspect = {
              failure: cut.failure,
              streamed: cut.streamed,
              confirmed: true,
            };
          this.pendingStreamCut = cut.kind === "ask";
        }
        if (this.pendingStreamCut) {
          this.continuingPastMalformedToolCall = false;
          this.pendingContextCompaction = null;
          this.pendingOpenLlmRotation = null;
          this.pendingBusyWait = null;
          this.pendingLanguageRepair = null;
          this.pendingToolArrival = null;

          return;
        }
        if (suspect != null && !this.hiddenTurn) {
          this.pendingNetworkFailure = suspect;
          this.continuingPastMalformedToolCall = false;
          this.pendingContextCompaction = null;
          this.pendingOpenLlmRotation = null;
          this.pendingBusyWait = null;
          this.pendingLanguageRepair = null;
          this.pendingToolArrival = null;

          return;
        }

        // A hidden housekeeping turn is not carried on: nobody is waiting on
        // it, and a continuation would run more hidden work. Its provider
        // failure still puts the model out, so the next turn starts elsewhere.
        if (this.hiddenTurn && suspect == null)
          this.shouldRotateOpenLlm(event.messages);
        this.continuingPastMalformedToolCall =
          !this.hiddenTurn &&
          this.shouldContinuePastMalformedToolCall(event.messages);
        this.pendingContextCompaction =
          this.hiddenTurn || this.continuingPastMalformedToolCall
            ? null
            : this.shouldCompactAndRetry(event.messages);
        // A malformed call is retried on the same model, not rotated, and an
        // outgrown transcript does not fit the next model either.
        const route =
          this.hiddenTurn ||
          this.continuingPastMalformedToolCall ||
          this.pendingContextCompaction != null
            ? { rotation: null, busy: null }
            : this.shouldRotateOpenLlm(event.messages);
        this.pendingOpenLlmRotation = route.rotation;
        this.pendingBusyWait = event.willRetry ? null : route.busy;
        // Only a turn that ended cleanly is judged on its language; a hidden
        // housekeeping turn has no reader.
        this.pendingLanguageRepair =
          this.hiddenTurn ||
          this.continuingPastMalformedToolCall ||
          this.pendingContextCompaction != null ||
          this.pendingOpenLlmRotation != null ||
          this.pendingBusyWait != null ||
          this.languageRepairsThisTurn > 0
            ? null
            : replyLanguageMismatch(event.messages);
        // Tools a change deferred under this turn adds: the turn continues
        // once with them, so the sender's request is finished rather than
        // declared impossible. Once per turn.
        const arrivals =
          this.hiddenTurn ||
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
        // than ending on silence (EmptyReplies). Only a send's own turn
        // (OwnedTurn) is asked: a hidden housekeeping turn has no reader.
        const emptyStep =
          !event.willRetry &&
          !this.hiddenTurn &&
          !this.interrupted &&
          this.ownedTurn?.endedEmpty === true &&
          !this.continuingPastMalformedToolCall &&
          this.pendingContextCompaction == null &&
          this.pendingOpenLlmRotation == null &&
          this.pendingBusyWait == null &&
          this.pendingLanguageRepair == null &&
          this.pendingToolArrival == null &&
          this.pendingStall == null
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
          this.pendingStall == null &&
          !this.pendingEmptyAsk
        ) {
          this.finishTurn();
        }

        return;
      }

      case "auto_retry_start":
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

  private shouldContinuePastMalformedToolCall(
    messages: readonly unknown[]
  ): boolean {
    if (
      this.interrupted ||
      this.malformedContinuations >= MAX_MALFORMED_CONTINUATIONS
    )
      return false;

    const failure = lastAssistantError(messages);

    return failure != null && MALFORMED_TOOL_CALL_PATTERN.test(failure);
  }

  private shouldCompactAndRetry(messages: readonly unknown[]): string | null {
    if (this.interrupted || this.contextCompactions > 0) return null;

    const failure = lastAssistantError(messages);

    if (failure == null || MALFORMED_TOOL_CALL_PATTERN.test(failure))
      return null;

    return isContextTooLong(failure) ? failure : null;
  }

  private finishTurn(): void {
    this.turnRunning = false;
    this.stallWatch.clear();
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
      this.emitAgentEvent({ type: "status_changed", status: AgentStatus.Idle });
    };
    // A send's turn ends after the send has said why (OwnedTurn); a hidden
    // turn or a run pi started on its own has no send to wait for.
    const owned = this.hiddenTurn ? null : this.ownedTurn;
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

  // ------------------------------------------------------------- approval flow

  private readonly permissionExtension = (pi: ExtensionAPI): void => {
    // Live only once a session is built on this load; see `pi`.
    this.loadedPi = pi;

    pi.on("tool_call", async (event, ctx) => {
      // Before the gate, so it judges the file the model meant.
      repairEscapedPaths(event.input as Record<string, unknown>, ctx.cwd);
      const tool = this.toToolRequest(
        event.toolCallId,
        event.toolName,
        event.input as Record<string, unknown>
      );

      if (!this.hiddenTurn) {
        this.emitInternal({
          type: "tool_call_start",
          toolCallId: event.toolCallId,
          toolName: tool.name,
          rawName: event.toolName,
          input: tool.input,
        });
      }

      const gate = gateToolCall(tool, {
        mode: this.mode,
        cwd: ctx.cwd,
        ...this.allowances.gateOptions({
          commands: this.config.allowedCommands,
          tools: [...this.profile.alwaysAllowedTools],
          readPaths: this.config.allowedReadPaths,
        }),
        ...(this.options.unattended != null
          ? {
              unattended: {
                policy: this.options.unattended,
                origin: (name: string) => toolOriginOf(this.mcp, name),
                held: fetchHold()?.held === true,
              },
            }
          : {}),
      });

      if (gate.kind === "allow") return;

      if (gate.kind === "refuse") {
        this.noteBlocked(event.toolCallId, "refused");

        return { block: true, reason: gate.reason };
      }

      if (
        !this.profile.canAskForApproval ||
        !process.stdout.writable ||
        process.stdout.destroyed
      ) {
        this.noteBlocked(event.toolCallId, "rejected");

        return {
          block: true,
          reason:
            `${tool.name} needs approval, but this session has no way to ask. ` +
            `Do only what runs without approval, or tell the user what you need them to allow.`,
        };
      }

      const permissionId = `perm-${++this.permissionCounter}`;

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
        const timer = Number.isFinite(budget)
          ? setTimeout(() => {
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

        timer?.unref?.();

        this.pending.set(permissionId, {
          resolve: (answer) => {
            if (timer) clearTimeout(timer);
            resolve(answer);
          },
        });
      });

      const verdict = this.applyDecision(decision, tool, gate.request);

      if (verdict?.block === true) {
        this.noteBlocked(event.toolCallId, "rejected");
      }

      return verdict;
    });
  };

  private applyDecision(
    decision: PermissionDecision,
    tool: ToolRequest,
    request: PermissionRequest
  ): { block: true; reason: string } | undefined {
    if (typeof decision === "string") {
      switch (decision) {
        case "accept":
        case "background":
          return undefined;

        case "allowYolo":
          this.mode = AgentMode.Yolo;
          setCurrentMode(this.mode);
          this.emitAgentEvent({
            type: "mode_changed",
            mode: this.mode,
            source: "bot",
          });

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

  private rejectAllPending(reason: string): void {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      this.emitAgentEvent({ type: "permission_cleared", permissionId: id });
      pending.resolve({ type: "reject_with_message", message: reason });
    }
  }

  // ------------------------------------------------------------------ helpers

  private emitReady(): void {
    if (!this.session) return;

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

  /**
   * What the picker should highlight: the router when the router was chosen,
   * not whichever model it resolved to today, or the picker snaps from one to
   * the other as if the bot's model changed. Same rule as session.ts.
   */
  private currentModelReference(): string {
    if (this.openLlmActive) return OPENLLM_ID;

    const model = this.session?.model;

    return model ? `${model.provider}/${model.id}` : "";
  }

  private toToolRequest(id: string, name: string, input: unknown): ToolRequest {
    const displayName = TOOL_NAME_ALIASES[name] ?? name;
    const args = (input ?? {}) as Record<string, unknown>;

    return {
      id,
      name: displayName,
      type: displayName,
      input: args,
      args,
    } as ToolRequest;
  }

  private messageId(): string {
    if (this.currentMessageId == null)
      this.currentMessageId = `msg-${++this.messageCounter}`;

    return this.currentMessageId;
  }

  /** The main session's words, streamed and kept as the turn's reply. */
  private streamText(content: string): void {
    this.reply.textStreamed(content);
    this.emitAgentEvent({
      type: "text_delta",
      content,
      messageId: this.messageId(),
    });
  }

  private emitAgentEvent(event: AgentEvent, meta?: EventMeta): void {
    if (event.type === "error" && meta?.origin === "turn") this.reply.fail();
    if (event.type === "error" && meta?.origin !== "startup")
      this.ownedTurn?.noteError(event.error);
    if (meta != null) tagEvent(event, meta);
    this.options.emit({ type: "event", event });
  }

  /** A fact for the AG-UI emitter only; never a legacy line. */
  private emitInternal(event: InternalAgentEvent): void {
    this.options.emitInternal?.(event);
  }

  private noteBlocked(toolCallId: string, cause: "rejected" | "refused"): void {
    if (!this.hiddenTurn) {
      this.emitInternal({ type: "tool_blocked", toolCallId, cause });
    }
  }

  /** See AbacusBotSession.aguiMessageId. */
  private aguiMessageId(message: unknown): string | undefined {
    const timestamp = (message as { timestamp?: unknown }).timestamp;
    const base = this.session?.sessionId ?? "session";

    return typeof timestamp === "number" ? `${base}:${timestamp}` : undefined;
  }

  private requireSession(): AgentSession {
    if (!this.session) throw new Error("Agent session is not started");

    return this.session;
  }
}

/** The last assistant message's error text, or null. */
function lastAssistantError(messages: readonly unknown[]): string | null {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];

    if (!isAssistantMessage(message)) continue;

    const failure = message as { stopReason?: unknown; errorMessage?: unknown };

    if (failure.stopReason !== "error") return null;

    return typeof failure.errorMessage === "string" &&
      failure.errorMessage.length > 0
      ? failure.errorMessage
      : "provider error";
  }

  return null;
}

/** Rough transcript weight; only ever compared against a fraction of a window. */
function estimateChars(messages: readonly unknown[]): number {
  try {
    return JSON.stringify(messages).length;
  } catch {
    return 0;
  }
}

/** Said in the chat, never sent to a phone as-is: the gateway rewords it. */
const NO_MODEL_CONFIGURED =
  "No model provider is configured. Add an API key in Settings.";

function isAssistantMessage(message: unknown): boolean {
  return (message as { role?: unknown } | undefined)?.role === "assistant";
}

function messageText(message: unknown): string {
  const content = (message as { content?: unknown } | undefined)?.content;

  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

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
  if (typeof result === "string") return result;

  if (result && typeof result === "object") {
    const content = (result as { content?: unknown }).content;

    if (typeof content === "string") return content;

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
