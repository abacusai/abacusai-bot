/**
 * The bot loop: a deliberately small agent for a bot's forever chat, not the
 * coding session. Built to survive indefinitely on a cheap model: context
 * overflow compacts and retries, a hidden flush turn writes durable facts to
 * daily notes before compaction, a daily consolidation curates them into
 * MEMORY.md, and streamed <think> scaffolding and malformed tool calls are
 * tidied. Driven over the same NDJSON protocol as the coding session.
 */
import {
  createAgentSession,
  createBashToolDefinition,
  createLocalBashOperations,
  DefaultResourceLoader,
  type AgentSession,
  type AgentSessionEvent,
  type ExtensionAPI,
  ModelRegistry,
  type ModelRuntime,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

import { backendOperations } from "../backends.js";
import { withBackgroundOption } from "../background-bash.js";
import {
  browserTaskEnabled,
  buildBrowserTaskTool,
} from "../browser-task-tool.js";
import {
  agentDir,
  applyStoredApiKeys,
  defaultModelFor,
  loadConfig,
  PROVIDER_API_KEY_ENV,
} from "../config.js";
import { TOOL_NAME_ALIASES } from "../excluded-tools.js";
import budgets from "../extensions/budgets.js";
import compactionPruner from "../extensions/compaction-pruner.js";
import spill from "../extensions/spill.js";
import toolCallRepair from "../extensions/tool-call-repair.js";
import toolTimeouts from "../extensions/tool-timeouts.js";
import { githubPrompt } from "../github-prompt.js";
import { connectMcpServers, type ConnectedMcp } from "../mcp/index.js";
import { buildMcpToolDefinitions } from "../mcp/tools.js";
import { fileCooldownStore } from "../openllm-cooldowns.js";
import {
  isOpenLlmReference,
  isOutOfCredits,
  openLlmCandidates,
  OPENLLM_ID,
  OpenLlmRotation,
} from "../openllm.js";
import {
  gateToolCall,
  MODE_NAMES,
  parseMode,
  parseModeStrict,
  shellSegments,
} from "../permissions.js";
import { identityPrompt, personaPrompt, readPersona } from "../persona.js";
import { windowsShellPrompt } from "../posix-shell.js";
import {
  AgentMode,
  AgentStatus,
  type AgentEvent,
  type DesktopEvent,
  type PermissionDecision,
  type PermissionRequest,
  type ToolRequest,
} from "../protocol.js";
import {
  createModelRuntime,
  listModels,
  registerAbacusProvider,
  registerCustomProviders,
  registerGeminiProvider,
  resolveModel,
  DEFAULT_MAX_OUTPUT_TOKENS,
} from "../providers.js";
import {
  REPLY_LANGUAGE_PROMPT,
  replyLanguageMismatch,
  replyLanguageRepairPrompt,
  type ReplyLanguageMismatch,
} from "../reply-language.js";
import { conversationSessionManager } from "../session-file.js";
import {
  mcpPrompt,
  mcpRosterFingerprint,
  reserveContextHeadroom,
} from "../session.js";
import { ToolHeartbeat } from "../tool-heartbeat.js";
import { TOOLS_ARRIVED_TYPE, toolsArrivedPrompt } from "../tools-arrived.js";
import { turnUsage, type TurnUsage } from "../turn-usage.js";
import webTools from "../web/tools.js";
import { botDir, readBotState, writeBotState } from "./bot-config.js";
import { BOT_MEMORY_TOOL_NAME, buildBotMemoryTool } from "./bot-memory-tool.js";
import {
  coreMemoryPrompt,
  hasDailyNotes,
  memoryFingerprint,
  recentNotesPrompt,
} from "./bot-memory.js";
import { BotOutputSanitizer, tidyBotText } from "./bot-output.js";
import {
  BOT_COMPACTION_CONTINUATION_PROMPT,
  BOT_COMPACTION_CONTINUATION_TYPE,
  BOT_LANGUAGE_REPAIR_TYPE,
  BOT_MALFORMED_CONTINUATION_PROMPT,
  BOT_MALFORMED_CONTINUATION_TYPE,
  botOperatingPrompt,
  CONSOLIDATE_CUSTOM_TYPE,
  consolidatePrompt,
  FLUSH_CUSTOM_TYPE,
  flushPrompt,
} from "./bot-prompts.js";
import { BOT_TIME_TOOL_NAME, buildBotTimeTool } from "./bot-time-tool.js";

export interface BotSessionOptions {
  cwd: string;
  model?: string;
  mode?: string;
  emit: (event: DesktopEvent) => void;
}

interface PendingPermission {
  resolve: (decision: PermissionDecision) => void;
}

/**
 * Flush when the estimated transcript passes this share of the window, ahead
 * of the 20% compaction reserve so notes are on disk before the summary.
 */
const FLUSH_AT_WINDOW_SHARE = 0.55;
const CHARS_PER_TOKEN = 4;

/** How often the consolidation pass runs, at most. */
const CONSOLIDATE_EVERY_MS = 24 * 60 * 60_000;

/** Same failure vocabulary as the coding loop; kept locally on purpose. */
const CONTEXT_LENGTH_PATTERN =
  /context length|context window|maximum input token limit|input is longer than|maximum context length|too many tokens/;
const MALFORMED_TOOL_CALL_PATTERN = /malformed[ _]?(function|tool)[ _]?call/i;

const MAX_MALFORMED_CONTINUATIONS = 1;

function approvalTimeoutMs(): number {
  const raw = Number(process.env.ABACUSAI_BOT_APPROVAL_TIMEOUT_MS);

  if (Number.isFinite(raw) && raw === 0) return Number.POSITIVE_INFINITY;

  return Number.isFinite(raw) && raw > 0 ? raw : 15 * 60_000;
}

/**
 * The bot's `bash`, over the same operations as the coding session's: the
 * bundled shell on Windows and the sandbox elsewhere. A custom tool of this
 * name replaces pi's built-in, whose own shell lookup finds nothing on a
 * Windows machine without Git Bash.
 */
export function botBashTool(
  cwd: string,
  operations = backendOperations() ?? createLocalBashOperations()
): ReturnType<typeof createBashToolDefinition> {
  return withBackgroundOption(
    createBashToolDefinition(cwd, { operations }) as never,
    cwd,
    operations
  );
}

export class BotSession {
  /** Steers handed to pi that have not reached the model yet, oldest first. */
  private readonly pendingSteers: string[] = [];
  /** True while the router is what the user picked — see currentModelReference. */
  private openLlmActive = false;
  private session: AgentSession | undefined;
  private sessionInit: Parameters<typeof createAgentSession>[0] | undefined;
  private modelRuntime: ModelRuntime | undefined;
  private registry: ModelRegistry | undefined;
  private resourceLoader: DefaultResourceLoader | undefined;
  private readonly config = loadConfig();
  private readonly maxOutputTokens: number =
    this.config.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
  private readonly home: string;
  private mode: AgentMode;
  private pi: ExtensionAPI | undefined;
  private mcp: ConnectedMcp = {
    clients: [],
    statuses: [],
    routes: new Map(),
    tools: [],
  };
  private readonly registeredMcpTools = new Set<string>();
  private unsubscribe: (() => void) | undefined;

  // Approval flow.
  private readonly pending = new Map<string, PendingPermission>();
  private permissionCounter = 0;
  private readonly sessionAllowedCommands: string[] = [];
  private readonly sessionAllowedTools = new Set<string>();

  // Streaming state.
  private readonly sanitizer = new BotOutputSanitizer();
  /** Raw (unsanitized) streamed text of the in-flight assistant message. */
  private rawStreamed = "";
  private currentMessageId: string | null = null;
  private messageCounter = 0;
  private readonly toolInputs = new Map<string, Record<string, unknown>>();
  private readonly heartbeat = new ToolHeartbeat((event) =>
    this.options.emit(event)
  );

  // Turn recovery state.
  private interrupted = false;
  private malformedContinuations = 0;
  private contextCompactions = 0;
  private continuingPastMalformedToolCall = false;
  private pendingContextCompaction: string | null = null;
  /** A reply in the wrong language, to be asked for again — once per turn. */
  private pendingLanguageRepair: ReplyLanguageMismatch | null = null;
  private languageRepairsThisTurn = 0;
  /** Whether a user turn is in flight — a refresh landing now is mid-turn. */
  private turnRunning = false;
  /** MCP tools registered while this turn ran; pi offers them next turn. */
  private toolsArrivedThisTurn: string[] = [];
  private pendingToolArrival: string[] | null = null;
  private toolArrivalsThisTurn = 0;

  // Memory machinery.
  /** The provider's usage for the turn's last request — set at agent_end. */
  private lastTurnUsage: TurnUsage | null = null;
  /** Rough transcript size in chars, updated at every agent_end. */
  private estimatedTranscriptChars = 0;
  /** One flush per compaction cycle; reset when a compaction happens. */
  private flushedSinceCompaction = false;
  /** True while a flush/consolidation turn runs — its output stays hidden. */
  private hiddenTurn = false;
  /** What the current prompt's memory block was built from. */
  private promptMemoryFingerprint = "";
  private promptPersona = "";
  /** The MCP roster the prompt was last built against. */
  private promptMcpRoster = "";

  constructor(private readonly options: BotSessionOptions) {
    const dir = botDir();

    if (dir == null)
      throw new Error("BotSession requires ABACUSAI_BOT_BOT_DIR.");

    this.home = dir;
    this.mode = parseMode(options.mode);
  }

  async start(): Promise<void> {
    const dir = agentDir();

    this.modelRuntime = await createModelRuntime(dir);
    const registry = new ModelRegistry(this.modelRuntime);

    this.registry = registry;
    registerCustomProviders(registry, this.config);
    registerGeminiProvider(registry);
    await registerAbacusProvider(registry);

    this.mcp = await connectMcpServers(process.env.ABACUSAI_BOT_MCP_CONFIG);

    const settingsManager = SettingsManager.create(this.options.cwd, dir);

    // A fraction of the live window rather than pi's flat 16k.
    reserveContextHeadroom(
      settingsManager,
      () => this.session?.model?.contextWindow
    );

    // Frozen at session start on purpose: the bridge from the previous
    // session, not a live feed. Core memory is re-read on prompt rebuilds.
    const recentNotes = recentNotesPrompt(this.home);

    const resourceLoader = new DefaultResourceLoader({
      cwd: this.options.cwd,
      agentDir: dir,
      settingsManager,
      appendSystemPrompt: [
        botOperatingPrompt(),
        // Same guard as the desktop chat, on a worse surface.
        REPLY_LANGUAGE_PROMPT,
        githubPrompt(),
        windowsShellPrompt(),
      ].filter((part): part is string => part != null),
      appendSystemPromptOverride: (base: string[]): string[] => {
        const persona = personaPrompt();
        const core = coreMemoryPrompt(this.home);
        // Live on every rebuild: a connector added mid-conversation must show.
        const mcp = mcpPrompt(this.mcp.statuses);
        this.promptMcpRoster = mcpRosterFingerprint(this.mcp.statuses);

        return [
          identityPrompt(),
          ...(persona == null ? [] : [persona]),
          ...base,
          ...(mcp == null ? [] : [mcp]),
          ...(core == null ? [] : [core]),
          ...(recentNotes == null ? [] : [recentNotes]),
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
        // Observes compaction so the flush budget renews per cycle.
        {
          name: "abacusai-bot-bot-context",
          factory: (pi: ExtensionAPI): void => {
            pi.on("session_before_compact", async () => {
              this.flushedSinceCompaction = false;
            });
          },
        },
      ],
    });

    await resourceLoader.reload();
    this.resourceLoader = resourceLoader;
    this.promptPersona = readPersona();
    this.promptMemoryFingerprint = memoryFingerprint(this.home);

    const model = this.resolveStartModel(registry);

    // The bot's own memory tool replaces the desktop's global one. Raw browser
    // tools stay out: a bot gets one `browser_task`, a sub-agent walks pages.
    const isBrowserTool = (tool: { name: string }): boolean =>
      tool.name.startsWith("browser_");
    const mcpTools = buildMcpToolDefinitions(() => this.mcp).filter(
      (tool) =>
        !isBrowserTool(tool) &&
        tool.name !== BOT_MEMORY_TOOL_NAME &&
        !tool.name.endsWith(`_${BOT_MEMORY_TOOL_NAME}`) &&
        tool.name !== BOT_TIME_TOOL_NAME
    );

    for (const tool of mcpTools) this.registeredMcpTools.add(tool.name);

    const hasBrowser = buildMcpToolDefinitions(() => this.mcp).some(
      isBrowserTool
    );
    const browserTaskTools =
      hasBrowser && browserTaskEnabled()
        ? [
            buildBrowserTaskTool(
              {
                cwd: this.options.cwd,
                agentDir: dir,
                modelRuntime: this.modelRuntime,
                settingsManager,
                browserTools: () =>
                  buildMcpToolDefinitions(() => this.mcp).filter(isBrowserTool),
                ...(model.model ? { model: model.model } : {}),
              },
              (event) => this.emitAgentEvent(event)
            ),
          ]
        : [];

    const customTools = [
      buildBotMemoryTool(this.home),
      buildBotTimeTool(),
      botBashTool(this.options.cwd),
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
    this.unsubscribe = this.session.subscribe((event) => this.onPiEvent(event));

    this.emitReady();

    if (model.error != null) {
      this.emitAgentEvent({
        type: "error",
        error: { message: model.error, code: "model_unavailable" },
      });
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
      ? new OpenLlmRotation(Date.now, fileCooldownStore()).pick(
          openLlmCandidates(listModels(registry))
        )?.id
      : requested;

    if (reference == null) {
      const fallback = registry.getAvailable()[0];

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
        : registry.getAvailable()[0];

    return model != null
      ? { model }
      : {
          error: resolved.error ?? NO_MODEL_CONFIGURED,
        };
  }

  // ---------------------------------------------------------------- commands

  async send(text: string): Promise<void> {
    const session = this.requireSession();

    // A bot spawned while the account was signed out has no model. The key
    // may have arrived since; read it and pick a model before prompting, or
    // pi answers with its own /login hint and that reaches the user's phone.
    if (!(await this.ensureUsableModel())) {
      this.emitAgentEvent({
        type: "error",
        error: { message: NO_MODEL_CONFIGURED, code: "model_unavailable" },
      });

      return;
    }

    await this.refreshStandingPrompt();

    this.interrupted = false;
    this.malformedContinuations = 0;
    this.contextCompactions = 0;
    this.pendingContextCompaction = null;
    this.languageRepairsThisTurn = 0;
    this.pendingLanguageRepair = null;
    this.toolsArrivedThisTurn = [];
    this.pendingToolArrival = null;
    this.toolArrivalsThisTurn = 0;
    this.turnRunning = true;

    this.emitAgentEvent({
      type: "status_changed",
      status: AgentStatus.Submitted,
    });

    try {
      await session.prompt(text);
      await this.continuePastRecoverableFailures();
      this.reportTurnFailure();
      await this.runMemoryMaintenance();
    } catch (error) {
      this.emitAgentEvent({
        type: "error",
        error: {
          message: describe(error),
          ...this.upgradeActionsFor(describe(error)),
        },
      });
    }
  }

  /**
   * Housekeeping after the user's turn: the pre-compaction flush and the daily
   * consolidation, both hidden turns ending in NO_REPLY by instruction.
   */
  private async runMemoryMaintenance(): Promise<void> {
    const session = this.session;

    if (session == null || this.interrupted) return;

    const window = session.model?.contextWindow;
    const flushDue =
      !this.flushedSinceCompaction &&
      window != null &&
      window > 0 &&
      this.estimatedTranscriptChars >
        window * CHARS_PER_TOKEN * FLUSH_AT_WINDOW_SHARE;

    if (flushDue) {
      this.flushedSinceCompaction = true;
      await this.runHiddenTurn(FLUSH_CUSTOM_TYPE, flushPrompt());
    }

    if (this.interrupted) return;

    const state = readBotState(this.home);
    const consolidateDue =
      hasDailyNotes(this.home) &&
      Date.now() - (state.lastConsolidatedAt ?? 0) > CONSOLIDATE_EVERY_MS;

    if (consolidateDue) {
      // Stamped before the turn so an erroring consolidation does not retry
      // on every message all day.
      writeBotState(this.home, { ...state, lastConsolidatedAt: Date.now() });
      await this.runHiddenTurn(CONSOLIDATE_CUSTOM_TYPE, consolidatePrompt());
    }
  }

  private async runHiddenTurn(
    customType: string,
    content: string
  ): Promise<void> {
    const session = this.session;

    if (session == null) return;

    this.hiddenTurn = true;

    try {
      await session.sendCustomMessage(
        { customType, content, display: false },
        { triggerTurn: true }
      );
    } catch {
      // Housekeeping must never surface as a failed reply.
    } finally {
      this.hiddenTurn = false;
    }
  }

  /**
   * Rebuild the standing prompt when the persona or memory files changed, so
   * the prompt cache is spent only when something real changed.
   */
  private async refreshStandingPrompt(): Promise<void> {
    const persona = readPersona();
    const fingerprint = memoryFingerprint(this.home);
    const roster = mcpRosterFingerprint(this.mcp.statuses);

    if (
      persona === this.promptPersona &&
      fingerprint === this.promptMemoryFingerprint &&
      roster === this.promptMcpRoster
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
      this.pendingLanguageRepair != null ||
      this.pendingToolArrival != null
    ) {
      if (this.interrupted) {
        this.continuingPastMalformedToolCall = false;
        this.pendingContextCompaction = null;
        this.pendingLanguageRepair = null;
        this.pendingToolArrival = null;
        this.finishTurn();

        return;
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

        await this.session?.sendCustomMessage(
          {
            customType: BOT_LANGUAGE_REPAIR_TYPE,
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
          {
            customType: BOT_MALFORMED_CONTINUATION_TYPE,
            content: BOT_MALFORMED_CONTINUATION_PROMPT,
            display: false,
          },
          { triggerTurn: true }
        );

        continue;
      }

      await this.compactAndRetry();
    }
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
      this.emitAgentEvent({
        type: "error",
        error: {
          message:
            "This conversation is too long for the model. Start a new chat, or switch to a model with a larger context.",
          code: "turn_failed",
        },
      });
      this.finishTurn();

      return;
    }

    this.flushedSinceCompaction = false;

    if (this.interrupted) {
      this.finishTurn();

      return;
    }

    await session.sendCustomMessage(
      {
        customType: BOT_COMPACTION_CONTINUATION_TYPE,
        content: BOT_COMPACTION_CONTINUATION_PROMPT,
        display: false,
      },
      { triggerTurn: true }
    );
  }

  private reportTurnFailure(): void {
    if (this.interrupted) return;

    const message = (
      this.session?.state as { errorMessage?: unknown } | undefined
    )?.errorMessage;

    if (typeof message !== "string" || message.length === 0) return;

    this.emitAgentEvent({
      type: "error",
      error: {
        message: compactFailure(message),
        code: "turn_failed",
        ...this.upgradeActionsFor(message),
      },
    });
  }

  /**
   * Mid-turn input. pi delivers it at the next step boundary; the text is
   * remembered so its arrival can be reported to the desktop.
   */
  async steer(text: string): Promise<void> {
    this.pendingSteers.push(text);
    await this.requireSession().steer(text);
  }

  /**
   * Forget undelivered steers. Called before a leftover message runs as its
   * own turn, so the model does not also see it as a steer.
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
    this.interrupted = true;
    this.rejectAllPending("Interrupted.");
    this.pendingSteers.length = 0;
    this.session?.clearQueue();
    await this.session?.abort();
    this.session?.clearQueue();
    this.toolInputs.clear();
    this.heartbeat.clear();
  }

  /**
   * Included credits ran out on an Abacus-served turn: the app renders the
   * upgrade card, not a red line.
   */
  private upgradeActionsFor(
    raw: string
  ):
    | { actions: Array<{ type: string; link: string }> }
    | Record<string, never> {
    const provider = this.session?.model?.provider;
    const abacusServed = provider === "abacus" || this.openLlmActive;
    if (!abacusServed || !isOutOfCredits(raw)) return {};
    return {
      actions: [
        {
          type: "upgrade-abacus",
          link: "https://apps.abacus.ai/chatllm/choose-plan/",
        },
      ],
    };
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

    this.mode = next;
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
    const registry = this.registry;
    const runtime = this.modelRuntime;

    if (registry == null || runtime == null) return;

    applyStoredApiKeys();

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
    await registerAbacusProvider(registry);
  }

  async setModel(reference: string): Promise<void> {
    const session = this.requireSession();
    const runtime = this.modelRuntime;
    const registry = this.registry;

    if (runtime == null || registry == null) return;

    const toRouter = isOpenLlmReference(reference);
    const concrete = toRouter
      ? new OpenLlmRotation(Date.now, fileCooldownStore()).pick(
          openLlmCandidates(listModels(registry))
        )?.id
      : reference;

    const resolved =
      concrete != null
        ? resolveModel(runtime, concrete, this.maxOutputTokens)
        : { model: undefined, error: "the free pool is empty" };

    if (resolved.model == null) {
      this.emitAgentEvent({
        type: "error",
        error: {
          message: resolved.error ?? `Unknown model: ${reference}`,
          code: "model_unavailable",
        },
      });

      return;
    }

    // Only once the switch has resolved: set earlier, a failed switch leaves
    // the picker reporting one model while turns run on another.
    this.openLlmActive = toRouter;
    await session.setModel(resolved.model);
    this.emitAgentEvent({
      type: "model_changed",
      model: this.currentModelReference(),
    });
  }

  respondPermission(permissionId: string, decision: PermissionDecision): void {
    const pending = this.pending.get(permissionId);

    if (!pending) return;

    this.pending.delete(permissionId);
    pending.resolve(decision);
  }

  async resetConversation(): Promise<void> {
    this.interrupted = true;
    this.rejectAllPending("Conversation reset.");
    this.pendingSteers.length = 0;
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
    for (const client of this.mcp.clients) client.close();

    this.mcp = await connectMcpServers(process.env.ABACUSAI_BOT_MCP_CONFIG);

    const pi = this.pi;

    if (pi != null) {
      for (const tool of buildMcpToolDefinitions(() => this.mcp)) {
        if (this.registeredMcpTools.has(tool.name)) continue;
        if (tool.name.startsWith("browser_")) continue;
        if (
          tool.name === BOT_MEMORY_TOOL_NAME ||
          tool.name.endsWith(`_${BOT_MEMORY_TOOL_NAME}`)
        )
          continue;
        // A same-named MCP tool would shadow the one the prompt teaches.
        if (tool.name === BOT_TIME_TOOL_NAME) continue;

        this.registeredMcpTools.add(tool.name);

        try {
          pi.registerTool(tool as never);
          // Registered mid-turn: pi offers it from the next turn on, so the
          // turn is continued once it ends, naming what arrived.
          if (this.turnRunning) this.toolsArrivedThisTurn.push(tool.name);
        } catch {
          this.registeredMcpTools.delete(tool.name);
        }
      }
    }

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
    _requestId: string,
    _ok: boolean,
    _result: unknown,
    _error: string | undefined
  ): void {
    // The bot loop registers no host-service-backed tools.
  }

  dispose(): void {
    for (const client of this.mcp.clients) client.close();

    this.unsubscribe?.();
    this.session?.dispose();
    this.session = undefined;
  }

  // ------------------------------------------------------------- pi -> desktop

  private onPiEvent(event: AgentSessionEvent): void {
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
        }

        return;

      case "message_update": {
        const stream = event.assistantMessageEvent as {
          type: string;
          delta?: string;
        };

        if (stream.type === "text_delta" && stream.delta) {
          this.rawStreamed += stream.delta;

          if (this.hiddenTurn) return;

          const { text, thinking } = this.sanitizer.push(stream.delta);

          if (text.length > 0) {
            this.emitAgentEvent({
              type: "text_delta",
              content: text,
              messageId: this.messageId(),
            });
          }

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
        if (!isAssistantMessage(event.message)) return;

        const full = messageText(event.message);

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

            if (cleaned.length > 0) {
              this.emitAgentEvent({
                type: "text_delta",
                content: cleaned,
                messageId: this.messageId(),
              });
            }
          } else if (full.startsWith(this.rawStreamed)) {
            // Streamed, with a remainder the stream never delivered.
            const { text, thinking } = this.sanitizer.push(
              full.slice(this.rawStreamed.length)
            );
            const tail = this.sanitizer.flush();
            const remainder = text + tail.text;
            const reasoning = thinking + tail.thinking;

            if (remainder.length > 0) {
              this.emitAgentEvent({
                type: "text_delta",
                content: remainder,
                messageId: this.messageId(),
              });
            }

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
        this.estimatedTranscriptChars = estimateChars(event.messages);
        this.lastTurnUsage = turnUsage(event.messages as never);

        this.continuingPastMalformedToolCall =
          this.shouldContinuePastMalformedToolCall(event.messages);
        this.pendingContextCompaction = this.continuingPastMalformedToolCall
          ? null
          : this.shouldCompactAndRetry(event.messages);
        // Only a turn that ended cleanly is judged on its language; a hidden
        // housekeeping turn has no reader.
        this.pendingLanguageRepair =
          this.hiddenTurn ||
          this.continuingPastMalformedToolCall ||
          this.pendingContextCompaction != null ||
          this.languageRepairsThisTurn > 0
            ? null
            : replyLanguageMismatch(event.messages);
        // Tools that arrived while this turn ran are offered from the next
        // turn on; continue into it so the sender's request is finished with
        // them rather than declared impossible. Once per turn.
        this.pendingToolArrival =
          this.hiddenTurn ||
          this.continuingPastMalformedToolCall ||
          this.pendingContextCompaction != null ||
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
          this.pendingLanguageRepair == null &&
          this.pendingToolArrival == null
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

    return CONTEXT_LENGTH_PATTERN.test(failure.toLowerCase()) ? failure : null;
  }

  private finishTurn(): void {
    this.turnRunning = false;
    this.toolInputs.clear();
    this.heartbeat.clear();
    this.emitAgentEvent({
      type: "turn_complete",
      ...(this.lastTurnUsage != null ? { usage: this.lastTurnUsage } : {}),
    });
    this.lastTurnUsage = null;
    this.emitAgentEvent({ type: "status_changed", status: AgentStatus.Idle });
  }

  // ------------------------------------------------------------- approval flow

  private readonly permissionExtension = (pi: ExtensionAPI): void => {
    this.pi = pi;

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
        allowedReadPaths: this.config.allowedReadPaths ?? [],
        allowedWritePaths: [],
        allowedOrigins: [],
      });

      if (gate.kind === "allow") return;

      if (gate.kind === "refuse") return { block: true, reason: gate.reason };

      if (!process.stdout.writable || process.stdout.destroyed) {
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
                  `Do not retry the same call — say what you need approved and stop.`,
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

      return this.applyDecision(decision, tool, gate.request);
    });
  };

  private applyDecision(
    decision: PermissionDecision,
    tool: ToolRequest,
    _request: PermissionRequest
  ): { block: true; reason: string } | undefined {
    if (typeof decision === "string") {
      switch (decision) {
        case "accept":
        case "background":
          return undefined;

        case "allowYolo":
          this.mode = AgentMode.Yolo;
          this.emitAgentEvent({
            type: "mode_changed",
            mode: this.mode,
            source: "bot",
          });

          return undefined;

        case "allowAlways":
          this.rememberAllowance(tool);

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

  private rememberAllowance(tool: ToolRequest): void {
    if (tool.name !== "bash") {
      this.sessionAllowedTools.add(tool.name);

      return;
    }

    for (const segment of shellSegments(String(tool.input.command ?? ""))) {
      const head = segment
        .split(/\s+/)
        .find((word) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word));

      if (head != null && !this.sessionAllowedCommands.includes(head))
        this.sessionAllowedCommands.push(head);
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

  private emitAgentEvent(event: AgentEvent): void {
    this.options.emit({ type: "event", event });
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

/** First sentence of a provider failure — bots never dump provider prose. */
function compactFailure(raw: string): string {
  const first = raw.split(/[.\n]/)[0]?.trim() ?? "";

  if (first.length === 0) return "The model provider had a problem.";

  return first.length > 200 ? `${first.slice(0, 200)}…` : first;
}

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
