/**
 * The spend governor: the one owner of "how much may this turn spend". Both
 * agent loops register it where every model call passes (turn_start, the
 * provider request, compaction), and read the policy in spend-policy.ts.
 *
 * - Limits per kind (calls, time, credits), all closed out the same way: the
 *   model is told, unseen, to hand over and write its closing message; every
 *   other tool is refused; a few calls later the run is stopped. Each close-out
 *   shows the user one line naming the limit.
 * - Credits are metered from what each Abacus request billed (abacus-credits),
 *   sub-agents and memory upkeep included, into the user's turn.
 * - Near the end of the credits (reserve) the model hears the balance and how
 *   far it goes, and keeps working in small steps. It is never told to refuse.
 * - Context: a ceiling by who pays, checked before each request through pi's
 *   own compaction threshold; one costly request summarizes before the next;
 *   a summary too big for the model runs on one whose window fits.
 * - After a refusal for size: the fit ladder (fitStep) decides compact, move
 *   or card; the loops carry it out.
 */
import {
  compact,
  estimateTokens,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import type {
  ModelRegistry,
  ModelRuntime,
} from "@earendil-works/pi-coding-agent";

import { onBilledCredits } from "../abacus-credits.js";
import {
  hostCreditBalance,
  lowCreditBase,
  refreshCreditBalanceIfStale,
} from "../credit-balance.js";
import { creditWallActive } from "../credit-wall.js";
import type { OpenLlmRouter } from "../openllm-router.js";
import { listModels, resolveModel } from "../providers.js";
import {
  CONTEXT_CAP_FLOOR,
  COSTLY_REQUEST_SHARE,
  contextCap,
  MEMORY_CREDITS,
  reserveStarts,
  SPEND_LIMITS,
  type SpendKind,
  type SpendLane,
  statedTokenLimit,
  turnsBucket,
  turnsLeft,
  unaskedCredits,
} from "../spend-policy.js";

/** How far short of the call cap each warning lands. */
const WRAP_UP_MARGIN = 100;
const FINAL_MARGIN = 50;
/** Model calls a closing run gets to write its closing message. */
const CLOSE_OUT_TURNS = 2;
const PRESENT_TOOL = "present_deliverable";
/** What a closing run may still call: handing over what exists, never new work. */
const HANDOVER_TOOLS = [PRESENT_TOOL, "send_media"];

/** Why the governor stopped the current run, or null. Cleared as the next run starts. */
let stoppedBecause: string | null = null;

/** The loops read this to say why a run ended rather than blaming the provider. */
export const spendStopReason = (): string | null => stoppedBecause;

/** The limit a close-out names to the user: which one, and its size. */
export type SpendLimitHit =
  | { cause: "calls"; amount: number }
  | { cause: "time"; amount: number }
  | { cause: "budget"; amount: number };

/** The slice of a pi model the governor reads. */
export interface GovernedModel {
  provider: string;
  id: string;
  contextWindow?: number;
}

/** A model the summary can run on instead, and the stream that reaches it (metered like any request). */
export interface Summarizer {
  model: GovernedModel;
  streamFn: (model: never, context: never, options?: never) => unknown;
}

export interface SpendGovernorOptions {
  /** Who is waiting on the work; see SpendKind. */
  kind: SpendKind;
  /** Who pays for a request on this model. */
  laneOf: (model: GovernedModel | undefined) => SpendLane;
  /** Reserve began: the chat shows how much is left (credit-thresholds' notice). */
  onCreditsLow?: (left: number) => void;
  /** Reserve ended (an upgrade, a top-up, a new month): the chat takes its notice back. */
  onCreditsRestored?: () => void;
  /** A close-out began: the chat shows which limit, in one line. */
  onCloseOut?: (hit: SpendLimitHit) => void;
  /** The history was summarized. */
  onCompacted?: () => void;
  /** A model whose window holds `tokens`, for a summary the current one cannot hold, paid as `lane` pays. */
  summarizer?: (
    tokens: number,
    lane: SpendLane,
    current: GovernedModel | undefined,
    preferCurrent?: boolean
  ) => Promise<Summarizer | null>;
}

/** After a refusal for size: what the loop does next. */
export type FitStep =
  | { kind: "compact" }
  | { kind: "move"; need: number; oneTurnFits: boolean };

/** What the fit ladder needs from a loop to carry its steps out. */
export interface FitHost {
  session: {
    model: GovernedModel | undefined;
    messages: readonly unknown[];
    systemPrompt: string;
    agent: { state: { tools?: readonly unknown[] } };
    compact(): Promise<unknown>;
    sendCustomMessage(
      message: { customType: string; content: string; display: boolean },
      options: { triggerTurn: boolean }
    ): Promise<void>;
  };
  /** The loop's hidden "go on" after a summary. */
  continuation: { customType: string; content: string };
  interrupted(): boolean;
  finishTurn(): void;
  /**
   * Compaction cannot get the turn under this model's limit: move to a model
   * that holds `need` (the pool's next, or RouteLLM), else end on the card.
   */
  beyondCompaction(need: { need: number; oneTurnFits: boolean }): void;
}

/** Rough tokens for text: four characters each, as pi estimates. */
const tokensOfText = (text: string): number => Math.ceil(text.length / 4);

const modelKey = (model: GovernedModel | undefined): string =>
  model == null ? "" : `${model.provider}/${model.id}`;

const isTool = (name: string, tool: string): boolean =>
  name === tool || name.endsWith(`_${tool}`);
const isHandoverTool = (name: string): boolean =>
  HANDOVER_TOOLS.some((tool) => isTool(name, tool));

const median = (values: readonly number[]): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2;
};

const callCap = (kind: SpendKind): number => {
  const raw = Number(process.env.ABACUSAI_BOT_TURN_CAP);
  return Math.floor(
    Number.isFinite(raw) && raw > 0 ? raw : (SPEND_LIMITS[kind].calls ?? 250)
  );
};

const timeCapMs = (kind: SpendKind): number => {
  const raw = Number(process.env.ABACUSAI_BOT_RUN_CAP_MS);
  return Number.isFinite(raw) && raw > 0
    ? raw
    : (SPEND_LIMITS[kind].timeMs ?? 60 * 60_000);
};

const closeOutPrompt = (why: string): string =>
  `${why} Stop working now: no more building, fixing or exploring, those tool calls will be refused. ` +
  `If you made files the user has not been handed yet, hand them over first with ${PRESENT_TOOL}, ` +
  `unfinished or not. Then write your closing message to the user, in their language: what is done ` +
  `and where it is, what is left, and that they can send a message to carry on from here.`;

const closeOutReason = (hit: SpendLimitHit): string => {
  switch (hit.cause) {
    case "calls":
      return `This run has reached its limit of ${hit.amount} model calls.`;
    case "time":
      return `This run has been working for ${hit.amount} minutes, its limit.`;
    case "budget":
      return `This run has used its credit budget of ${hit.amount} credits.`;
  }
};

/** What the user reads when a run that hit a limit did not close out. */
const stoppedMessage = (hit: SpendLimitHit): string => {
  switch (hit.cause) {
    case "calls":
      return (
        `This run made ${hit.amount} model calls without finishing, so it was probably going in circles, and ` +
        `was stopped. Whatever it built is still in the workspace. To get it back on track, send a message ` +
        `that narrows the task: say exactly what you want next, or ask it to present what it has so far.`
      );
    case "time":
      return (
        `This run worked for ${hit.amount} minutes without finishing and was stopped. Whatever it built is ` +
        `still in the workspace. Send a message to carry on from here, or ask it to present what it has.`
      );
    case "budget":
      return `Stopped at its credit budget (${hit.amount} credits).`;
  }
};

const wrapUpPrompt = (turns: number, cap: number): string =>
  `Budget check: this run has made ${turns} of ${cap} model calls and has been going a long time. ` +
  `Wrap up now. First present whatever deliverables exist so far with present_deliverable, even if ` +
  `unfinished. Then look at what you have been doing: if the last several steps repeat an approach ` +
  `that is not working, stop, state what you learned, and change approach or ask the user. Do not ` +
  `start new explorations.`;

const finalPrompt = (turns: number, cap: number): string =>
  `Final warning: ${turns} of ${cap} model calls used. The run is stopped at ${cap}, mid-step, with ` +
  `no chance to finish. Present what exists now with present_deliverable, then write your closing ` +
  `message: what is done, where it is, and what is left. No more building, fixing or exploring.`;

/**
 * The reserve fact. It states the balance and how far it goes, and asks for
 * small steps with each deliverable handed over as it exists. It never says
 * to refuse or stop: models read "do not start new work" as "decline".
 */
export const reservePrompt = (left: number, turns: number | null): string =>
  `Credit note: the user's Abacus.AI account has ${left} credits left` +
  (turns != null
    ? `, about ${turns} ${turns === 1 ? "turn" : "turns"} at this chat's current rate. `
    : ". ") +
  `Do what the user asks, in small steps, and hand over each deliverable with ${PRESENT_TOOL} as soon ` +
  `as it exists, so nothing is lost if the credits run out. If the request clearly needs more than ` +
  `${left} credits, say so first, in the user's language, and offer the smallest version that fits.`;

/** The reserve note's own message type, and the one that ends it. */
const RESERVE_TYPE = "abacusai-bot-credits-reserve";
const RESERVE_ENDED_TYPE = "abacusai-bot-credits-reserve-ended";

/**
 * The note that ends a reserve: the balance rose (a new plan, a top-up, a new
 * month). Without it the model keeps the old balance from its history and
 * tells a paying user their credits will not stretch.
 */
export const reserveEndedPrompt = (left: number): string =>
  `Credit note update: the user's Abacus.AI account now has ${left} credits. The earlier credit ` +
  `note no longer applies: do the work at the scope the request needs, and do not raise credits ` +
  `as a limit again unless a new credit note says so.`;

/**
 * Whether the chat's history ends on a reserve note no later note ended: a
 * note from an earlier run of the app stays in the history the model reads.
 */
export const reserveNoteStands = (
  entries: ReadonlyArray<{ type?: unknown; customType?: unknown }>
): boolean => {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]!;
    if (entry.type !== "custom_message") continue;
    if (entry.customType === RESERVE_ENDED_TYPE) return false;
    if (entry.customType === RESERVE_TYPE) return true;
  }
  return false;
};

/*
 * The lines the chat shows. The app shows its own translation, keyed by the
 * action; the English is for a client that does not know it.
 */
export const CREDITS_LOW_ACTION = "credits-low";
export const creditsLowNotice = (left: number): string =>
  `${left} credits left. The agent keeps going and hands over each piece as it's ready.`;

export const SPEND_LIMIT_ACTION = "spend-limit";
export const spendLimitNotice = (hit: SpendLimitHit): string => {
  switch (hit.cause) {
    case "budget":
      return `Stopped at its credit budget (${hit.amount} credits).`;
    case "calls":
      return `This task reached its limit of ${hit.amount} steps, so it's wrapping up. Send a message to keep going.`;
    case "time":
      return `This task has worked for ${hit.amount} minutes, its limit, so it's wrapping up. Send a message to keep going.`;
  }
};

export const COMPACTED_ACTION = "compacted";
export const COMPACTED_NOTICE =
  "Summarized older messages to keep this chat fast and cheap.";

/** A model that spends Abacus credits: the platform marks the ones that bill nothing. */
export const billedAbacus = (model: unknown): boolean => {
  const choice = model as { provider?: string; free?: boolean } | undefined;
  return choice?.provider === "abacus" && choice.free !== true;
};

/** A model nobody pays for: on this computer, or marked free by its provider. */
export const paysNothing = (model: unknown): boolean => {
  const choice = model as { provider?: string; free?: boolean } | undefined;
  return choice?.provider === "local" || choice?.free === true;
};

/** Who pays for a request on `model`; `routed` while the free pool picks it. */
export const laneOfModel = (
  model: GovernedModel | undefined,
  routed: boolean
): SpendLane => {
  if (model == null) return "own-key";
  if (model.provider === "local") return "local";
  if (model.provider === "abacus")
    return billedAbacus(model) ? "abacus-billed" : "abacus-free";
  return routed ? "pool" : "own-key";
};

type SummaryChoice = {
  id: string;
  provider: string;
  free: boolean;
  inputCost: number;
  contextWindow: number;
};

/** The model a too-big summary runs on, by who pays; see summarizerFrom. */
export const summaryModelFor = <T extends SummaryChoice>(
  choices: readonly T[],
  {
    tokens,
    lane,
    current,
    freeProviders,
    credits,
  }: {
    tokens: number;
    lane: SpendLane;
    current: GovernedModel | undefined;
    freeProviders: readonly string[];
    credits: boolean;
  }
): T | undefined => {
  const fits = choices.filter((model) => model.contextWindow * 0.8 > tokens);
  const free = new Set(freeProviders);
  const allowed =
    lane === "own-key" || lane === "local"
      ? fits.filter((model) => model.provider === current?.provider)
      : lane === "pool"
        ? fits.filter(
            (model) =>
              model.free ||
              (free.has(model.provider) && model.provider !== "abacus")
          )
        : lane === "abacus-free" || !credits
          ? fits.filter((model) => model.provider === "abacus" && model.free)
          : fits.filter((model) => model.provider === "abacus");
  return [...allowed].sort(
    (a, b) =>
      Number(b.free) - Number(a.free) ||
      a.inputCost - b.inputCost ||
      a.contextWindow - b.contextWindow
  )[0];
};

/**
 * A model whose window holds a summary of `tokens`, paid for by whoever pays
 * for the chat, never more than it has to cost:
 * - own key or a local model: the same provider's models only (the user's own
 *   key), never Abacus credits behind their back;
 * - the free lane: free models only;
 * - Abacus: a free Abacus model first, else the cheapest that fits, never the
 *   priciest by window. Its requests go through the runtime, metered like any.
 * With `preferCurrent`, the running model itself when it holds `tokens`: the
 * rule a compaction follows, for a summary that is not one (a hand-off).
 * Null leaves the summary on the running model.
 */
export const summarizerFrom =
  (
    registry: () => ModelRegistry | undefined,
    runtime: () => ModelRuntime | undefined,
    router: () => OpenLlmRouter,
    maxOutputTokens: number
  ) =>
  async (
    tokens: number,
    lane: SpendLane,
    current: GovernedModel | undefined,
    preferCurrent = false
  ): Promise<Summarizer | null> => {
    const models = registry();
    const run = runtime();
    if (models == null || run == null) return null;
    const own =
      preferCurrent &&
      current != null &&
      (current.contextWindow ?? 0) * 0.8 > tokens
        ? listModels(models).find(
            (model) => model.id === `${current.provider}/${current.id}`
          )
        : undefined;
    const choice =
      own ??
      summaryModelFor(listModels(models), {
        tokens,
        lane,
        current,
        freeProviders: router().freeLaneProviders(models),
        credits:
          !creditWallActive() && (hostCreditBalance()?.remaining ?? 1) > 0,
      });
    if (choice == null) return null;
    const resolved = resolveModel(run, choice.id, maxOutputTokens);
    if (resolved.model == null) return null;
    return {
      model: resolved.model,
      streamFn: ((model, context, options) =>
        run.streamSimple(
          model as never,
          context as never,
          options as never
        )) as Summarizer["streamFn"],
    };
  };

/** Models a fit card may name: billed Abacus ones only while credits are left. */
export const fitChoices = (registry: ModelRegistry) => {
  const out = creditWallActive() || hostCreditBalance()?.remaining === 0;
  return listModels(registry).filter(
    (choice) => !out || choice.provider !== "abacus" || choice.free
  );
};

/** What a summary never shrinks: the system prompt and the tools a request carries. */
export interface GovernedSession {
  model: GovernedModel | undefined;
  systemPrompt: string;
  messages: readonly unknown[];
  agent: { state: { tools?: readonly unknown[] } };
}

/** The settings slice pi's compaction threshold reads; see governContext. */
interface CompactionHolder {
  getCompactionSettings: () => {
    enabled: boolean;
    reserveTokens: number;
    keepRecentTokens: number;
  };
}

export class SpendGovernor {
  private readonly options: SpendGovernorOptions;
  /** The kind now running: the base kind, or memory upkeep / an unasked follow-up. */
  private kind: SpendKind;
  private turns = 0;
  private turnStartedAt = Date.now();
  private closingTurns: number | null = null;
  private closingHit: SpendLimitHit | null = null;
  /** Abacus credits billed in the user's turn so far, and in this pi run. */
  private turnCredits = 0;
  /** Billed turns this session, for the reserve's "turns left". */
  private readonly turnCosts: number[] = [];
  /** A follow-up nobody asked for: its call and credit allowance, and what it used. */
  private unasked: {
    calls: number;
    used: number;
    credits: number;
    creditsAt: number;
    reached: boolean;
  } | null = null;
  private inReserve = false;
  /** Whether this run has looked for a reserve note an earlier run left. */
  private historyChecked = false;
  private reserveBucket = -2;
  /** Provider-stated limits, per model, for this session. */
  private readonly learned = new Map<string, number>();
  /** The last request's context, from the provider's usage. */
  private lastContextTokens = 0;
  /** One request billed past the costly share: summarize before the next. */
  private compactSoon = false;
  /** This turn's cost-triggered summary is spent: one per user turn. */
  private costCompactedThisTurn = false;
  /**
   * The session's own billed requests (context tokens, credits): whether the
   * price follows the context at all. A flat price gains nothing from a summary.
   */
  private readonly priced: Array<{ tokens: number; credits: number }> = [];
  /** Memory upkeep's credits this turn: counted in the turn, not in its typical cost. */
  private memoryCredits = 0;
  /** A summary was made and the chat has not said so yet. */
  private compactedUntold = false;
  /** The fit ladder is compacting after a refusal: not news to the user. */
  private recovering = false;
  /** This turn's recovery compaction is spent. */
  private recoveryCompacted = false;
  /** What the last refusal for size needs from a model; null when none this turn. */
  private need: { need: number; oneTurnFits: boolean } | null = null;
  private model: GovernedModel | undefined;
  /** The governed session and pi's compaction settings, once governContext ran. */
  private governed: {
    session: () => GovernedSession | undefined;
    settings: () => { keepRecentTokens: number };
  } | null = null;
  private readonly unsubscribe: () => void;

  constructor(options: SpendGovernorOptions) {
    this.options = options;
    this.kind = options.kind;
    this.unsubscribe = onBilledCredits((credits) => this.meter(credits));
  }

  /** Stop metering: the session is gone. */
  dispose(): void {
    this.unsubscribe();
  }

  /**
   * A summary was made (the loop's `compaction_end` with a result). Not pi's
   * `session_compact`: the summary anchor rewrites the entry pi looks it up by,
   * so that event never fires here.
   */
  noteCompacted(reason?: string): void {
    if (this.compactSoon) this.costCompactedThisTurn = true;
    this.compactSoon = false;
    this.lastContextTokens = 0;
    this.recoveryCompacted = true;
    // Only a summary the ceiling chose is said, as the next request starts (a
    // preflight one has no run yet). Recovery from a refusal stays housekeeping.
    if (!this.recovering && reason !== "overflow") this.compactedUntold = true;
  }

  /** Whether the run is closing out: other nudges hold their tongue. */
  closing(): boolean {
    return this.closingTurns != null;
  }

  /** Billed credits so far in the user's turn. */
  creditsThisTurn(): number {
    return this.turnCredits;
  }

  /** A follow-up nobody asked for starts: its own, tighter limits. */
  beginUnasked(calls: number): void {
    this.unasked = {
      calls,
      used: 0,
      credits: unaskedCredits(this.turnCredits),
      creditsAt: this.turnCredits,
      reached: false,
    };
  }

  /** The follow-up ended; true when it was stopped at its limit. */
  endUnasked(): boolean {
    const reached = this.unasked?.reached === true;
    this.unasked = null;
    return reached;
  }

  /** Hidden memory upkeep runs under its own kind; false when it should be skipped. */
  beginMemory(): boolean {
    if (this.inReserve) return false;
    this.kind = "memory";
    this.memoryStart = { at: Date.now(), credits: this.turnCredits };
    return true;
  }

  endMemory(): void {
    this.kind = this.options.kind;
    this.memoryStart = null;
    // A close-out the upkeep met is its own; the user's next turn starts clean.
    this.closingTurns = null;
    this.closingHit = null;
  }

  /** Where the current memory upkeep started, for its own limits. */
  private memoryStart: { at: number; credits: number } | null = null;

  private lane(): SpendLane {
    return this.options.laneOf(this.model);
  }

  /**
   * The model a hand-off summary of `tokens` runs on, as a compaction picks
   * it: the chat's own model when the history fits it (a chat offered a top
   * model runs on a low-cost one), else the one a too-big compaction would
   * use, paid for as this chat is. Null leaves it unwritten.
   */
  handoffSummarizer(
    tokens: number,
    current: GovernedModel | undefined
  ): Promise<Summarizer | null> {
    this.model = current ?? this.model;
    return (
      this.options.summarizer?.(tokens, this.lane(), this.model, true) ??
      Promise.resolve(null)
    );
  }

  private planCredits(): number | null {
    const balance = hostCreditBalance();
    return balance == null ? null : lowCreditBase(balance);
  }

  /** One Abacus request ended, with what it billed. */
  private meter(credits: number): void {
    this.turnCredits += credits;
    if (this.kind === "memory") this.memoryCredits += credits;
  }

  /**
   * One of this session's own requests ended (not a sub-agent's, not memory
   * upkeep's): the cost trigger reads it. It fires once per turn, and only
   * once the session has seen its price follow the context it sends.
   */
  private noteOwnRequest(tokens: number, credits: number): void {
    if (tokens <= 0) return;
    this.priced.push({ tokens, credits });
    if (this.priced.length > 8) this.priced.shift();
    const plan = this.planCredits();
    if (
      plan == null ||
      this.costCompactedThisTurn ||
      credits <= plan * COSTLY_REQUEST_SHARE ||
      !this.priceFollowsContext()
    )
      return;
    this.compactSoon = true;
  }

  /** Two requests of clearly different size whose prices moved with it. */
  private priceFollowsContext(): boolean {
    const sorted = [...this.priced].sort((a, b) => a.tokens - b.tokens);
    const small = sorted[0];
    const large = sorted.at(-1);
    if (small == null || large == null || small.credits <= 0) return false;
    const grew = large.tokens / small.tokens;
    if (grew < 1.25) return false;
    return large.credits / small.credits >= 1 + (grew - 1) * 0.5;
  }

  /**
   * The context ceiling for the model now running: the policy's cap by who
   * pays, a provider-stated limit, and, after a costly request, the history
   * summarized before the next one.
   */
  contextCapFor(window: number): number {
    const kept = this.keptTokens();
    const cap = contextCap({
      window,
      lane: this.lane(),
      kind: this.options.kind,
      learned: this.learned.get(modelKey(this.model)) ?? null,
      kept,
    });
    if (!this.compactSoon || this.lastContextTokens <= 0) return cap;
    return Math.min(
      cap,
      Math.max(kept + CONTEXT_CAP_FLOOR, Math.floor(this.lastContextTokens / 2))
    );
  }

  /**
   * Tokens a summary leaves: the system prompt and the tools, which it never
   * shrinks, and the recent turns pi keeps, in the provider's own count. 0
   * before governContext ran.
   */
  private keptTokens(): number {
    if (this.governed == null) return 0;
    const session = this.governed.session();
    const estimated =
      (session == null ? 0 : fixedTokens(session)) +
      this.governed.settings().keepRecentTokens;
    return Math.round(estimated * (session == null ? 1 : tokenScale(session)));
  }

  /**
   * pi compacts before a request whose estimated size passes its threshold
   * (window minus reserveTokens), and after a run on the real usage. Setting
   * the reserve from the governor's cap makes that the pre-flight check for
   * every chat, by who pays. Read at call time: the model changes mid-session.
   */
  governContext(
    manager: CompactionHolder,
    current: () => GovernedSession | undefined
  ): void {
    const configured = manager.getCompactionSettings.bind(manager);
    this.governed = { session: current, settings: configured };
    manager.getCompactionSettings = () => {
      const settings = configured();
      const model = current()?.model;
      this.model = model ?? this.model;
      const window = model?.contextWindow;
      if (window == null || window <= 0) return settings;
      return {
        ...settings,
        reserveTokens: Math.max(
          settings.reserveTokens,
          window - this.contextCapFor(window)
        ),
      };
    };
  }

  /**
   * Before a run's first request, which pi's own pre-turn check does not
   * see: the history plus the new message over the ceiling is summarized
   * before it goes out.
   */
  async preflight(
    session: {
      model: GovernedModel | undefined;
      messages: readonly unknown[];
      compact(): Promise<unknown>;
    },
    text: string
  ): Promise<"stopped" | void> {
    const window = session.model?.contextWindow;
    if (window == null || window <= 0 || session.messages.length === 0) return;
    this.model = session.model;
    const outgoing =
      Math.max(this.lastContextTokens, historyTokens(session.messages)) +
      tokensOfText(text);
    if (outgoing <= this.contextCapFor(window)) return;
    try {
      await session.compact();
    } catch (error) {
      // Stop during the summary ends the turn; nothing old enough to
      // summarize lets the request go, and a refusal climbs the fit ladder.
      if (/cancel|abort/i.test(String(error))) return "stopped";
    }
  }

  /**
   * After a refusal for size. The limit it states is kept for this model. One
   * compaction per turn, when one turn fits the limit at all; otherwise a move
   * to a model that fits. `oneTurn` is the system prompt, tools and last message.
   */
  fitStep(
    failure: string,
    model: GovernedModel | undefined,
    oneTurn: number,
    history: number
  ): FitStep {
    const stated = statedTokenLimit(failure);
    if (stated != null) this.learned.set(modelKey(model), stated);
    const window = model?.contextWindow ?? 0;
    const limit =
      this.learned.get(modelKey(model)) ??
      (window > 0 ? Math.floor(window * 0.8) : Number.POSITIVE_INFINITY);
    const oneTurnFits = oneTurn < limit;
    if (oneTurnFits && !this.recoveryCompacted) {
      this.recoveryCompacted = true;
      return { kind: "compact" };
    }
    this.need = {
      need: oneTurnFits ? Math.min(history, limit) : oneTurn,
      oneTurnFits,
    };
    return { kind: "move", ...this.need };
  }

  /** Whether `choice` holds what the last refusal for size needs (else the whole history). */
  holdsNeed(
    choice: { contextWindow: number } | null | undefined,
    messages: readonly unknown[]
  ): boolean {
    const need = this.need?.need ?? historyTokens(messages);
    return choice != null && choice.contextWindow * 0.8 >= need;
  }

  /**
   * The card's way on after a refusal for size: whether one turn fits the
   * limit at all, and the roomiest other model that holds the chat, by name.
   */
  fitCard(
    choices: ReadonlyArray<{
      id: string;
      label: string;
      contextWindow: number;
    }>,
    current: GovernedModel | undefined,
    messages: readonly unknown[]
  ): { oneTurnFits: boolean; model?: { model: string; label: string } } {
    const currentId = modelKey(current);
    const roomy = choices
      .filter(
        (choice) => choice.id !== currentId && this.holdsNeed(choice, messages)
      )
      .sort((a, b) => b.contextWindow - a.contextWindow)[0];
    return {
      oneTurnFits: this.need?.oneTurnFits ?? true,
      ...(roomy != null && { model: { model: roomy.id, label: roomy.label } }),
    };
  }

  /**
   * The provider refused the request for its size: one step of the ladder,
   * carried out on the loop. Compact once (with a summarizer that fits, see
   * session_before_compact) and go on, or hand the move to the loop.
   */
  async recover(failure: string, host: FitHost): Promise<void> {
    const session = host.session;
    const step = this.fitStep(
      failure,
      session.model,
      oneTurnTokens(session),
      historyTokens(session.messages)
    );
    if (step.kind === "move") {
      host.beyondCompaction(step);
      return;
    }
    this.recovering = true;
    try {
      await session.compact();
    } catch {
      // Nothing older than the recency window to summarize.
      this.need = { need: historyTokens(session.messages), oneTurnFits: true };
      host.beyondCompaction(this.need);
      return;
    } finally {
      this.recovering = false;
    }
    // Stop can land during the (slow) summary; going on would make Stop not stop.
    if (host.interrupted()) {
      host.finishTurn();
      return;
    }
    await session.sendCustomMessage(
      { ...host.continuation, display: false },
      { triggerTurn: true }
    );
  }

  /** The limit this model stated this session, if any. */
  learnedLimit(model: GovernedModel | undefined): number | null {
    return this.learned.get(modelKey(model)) ?? null;
  }

  /** Begin the close-out for `hit`: hidden instruction, visible line. */
  private startCloseOut(pi: ExtensionAPI, hit: SpendLimitHit): void {
    this.closingTurns = 0;
    this.closingHit = hit;
    pi.sendMessage(
      {
        customType: "abacusai-bot-close-out",
        content: closeOutPrompt(closeOutReason(hit)),
        display: false,
      },
      { deliverAs: "steer" }
    );
    // Memory upkeep and a follow-up nobody asked for close out unseen, as before.
    if (this.kind !== "memory" && this.unasked == null)
      this.options.onCloseOut?.(hit);
  }

  /**
   * The credit limit this turn has, if any: memory upkeep's alone. A chat the
   * user is in runs until it is done or the credits run out (the credit wall),
   * and a routine run finishes because the user set it going.
   */
  private creditLimit(): SpendLimitHit | null {
    if (this.kind !== "memory" || this.lane() !== "abacus-billed") return null;
    if (hostCreditBalance() == null) return null;
    return this.turnCredits - (this.memoryStart?.credits ?? 0) >= MEMORY_CREDITS
      ? { cause: "budget", amount: MEMORY_CREDITS }
      : null;
  }

  /**
   * Reserve: attended chats on billed credits only. Telling a routine run
   * nobody watches to economize skips its job.
   */
  private reserve(
    pi: ExtensionAPI,
    history: () => ReadonlyArray<{ type?: unknown; customType?: unknown }>
  ): void {
    if (this.kind !== "attended" && this.kind !== "phone") return;
    if (process.env.ABACUSAI_BOT_NOBODY_PRESENT === "1") return;
    if (this.lane() !== "abacus-billed") return;
    const balance = hostCreditBalance();
    if (balance == null) return;
    // A note an earlier run left counts as this run's own reserve.
    if (!this.historyChecked) {
      this.historyChecked = true;
      if (reserveNoteStands(history())) this.inReserve = true;
    }
    const typical = median(this.turnCosts);
    const plan = lowCreditBase(balance);
    if (!reserveStarts(balance.remaining, plan, typical)) {
      if (this.inReserve) {
        pi.sendMessage(
          {
            customType: RESERVE_ENDED_TYPE,
            content: reserveEndedPrompt(Math.floor(balance.remaining)),
            display: false,
          },
          { deliverAs: "steer" }
        );
        this.options.onCreditsRestored?.();
      }
      this.inReserve = false;
      this.reserveBucket = -2;
      return;
    }
    const left = Math.max(0, Math.floor(balance.remaining));
    const turns = turnsLeft(left, typical);
    const bucket = turnsBucket(turns);
    const entering = !this.inReserve;
    this.inReserve = true;
    // Again only when the estimate changes bucket, so the cache moves rarely.
    if (!entering && bucket === this.reserveBucket) return;
    this.reserveBucket = bucket;
    pi.sendMessage(
      {
        customType: RESERVE_TYPE,
        content: reservePrompt(left, turns),
        display: false,
      },
      { deliverAs: "steer" }
    );
    // The free plan's reserve is the model's alone; a paid plan also sees the notice.
    if (entering && balance.paid === true) this.options.onCreditsLow?.(left);
  }

  /** The pi extension: limits, close-out, reserve and the summarizer that fits. */
  readonly extension = (pi: ExtensionAPI): void => {
    // A prompt sent while idle starts the user's turn; one sent mid-run joins it.
    pi.on("input", (event) => {
      if ((event as { streamingBehavior?: unknown }).streamingBehavior != null)
        return;
      const own = this.turnCredits - this.memoryCredits;
      if (own > 0) this.turnCosts.push(own);
      this.turnCredits = 0;
      this.memoryCredits = 0;
      this.costCompactedThisTurn = false;
      this.turnStartedAt = Date.now();
      this.closingTurns = null;
      this.closingHit = null;
      this.recoveryCompacted = false;
      this.need = null;
    });

    pi.on("agent_start", () => {
      this.turns = 0;
      stoppedBecause = null;
    });

    pi.on("message_end", (event) => {
      const message = event.message as {
        role?: string;
        stopReason?: string;
        abacusCredits?: number;
        usage?: {
          input?: number;
          cacheRead?: number;
          cacheWrite?: number;
        };
      };
      if (message.role !== "assistant" || message.stopReason === "error")
        return;
      const usage = message.usage;
      const context =
        (usage?.input ?? 0) +
        (usage?.cacheRead ?? 0) +
        (usage?.cacheWrite ?? 0);
      if (context > 0) this.lastContextTokens = context;
      // Memory upkeep's requests are not the chat's: they never trigger a summary.
      if (this.kind !== "memory" && typeof message.abacusCredits === "number")
        this.noteOwnRequest(context, message.abacusCredits);
    });

    pi.on("turn_end", (_event, ctx) => {
      if (billedAbacus(ctx.model)) refreshCreditBalanceIfStale();
    });

    pi.on("turn_start", (_event, ctx) => {
      this.model = (ctx.model as GovernedModel | undefined) ?? this.model;
      this.turns++;
      if (this.compactedUntold) {
        this.compactedUntold = false;
        this.options.onCompacted?.();
      }
      this.reserve(pi, () => ctx.sessionManager.getBranch());

      const cap = callCap(this.kind);
      const wrapUpAt = Math.max(1, cap - WRAP_UP_MARGIN);
      const finalAt = Math.max(1, cap - FINAL_MARGIN);
      const steer = (content: string): void => {
        pi.sendMessage(
          { customType: "calite-budget", content, display: true },
          { deliverAs: "steer" }
        );
      };
      if (this.turns === finalAt) steer(finalPrompt(this.turns, cap));
      else if (this.turns === wrapUpAt) steer(wrapUpPrompt(this.turns, cap));

      // Closing out: a few calls to say what was done, then the stop.
      if (this.closingTurns != null) {
        this.closingTurns += 1;
        if (this.closingTurns > CLOSE_OUT_TURNS && this.closingHit != null) {
          stoppedBecause = stoppedMessage(this.closingHit);
          if (ctx.hasUI)
            ctx.ui.notify(
              "AbacusAI Bot: the run did not close out; stopping it",
              "warning"
            );
          ctx.abort();
        }
        return;
      }

      const unasked = this.unasked;
      if (unasked != null) {
        unasked.used += 1;
        unasked.reached =
          unasked.used >= unasked.calls ||
          this.turnCredits - unasked.creditsAt >= unasked.credits;
      }
      const elapsed = Date.now() - (this.memoryStart?.at ?? this.turnStartedAt);
      const hit: SpendLimitHit | null =
        this.turns > cap
          ? { cause: "calls", amount: cap }
          : unasked?.reached === true
            ? { cause: "calls", amount: unasked.calls }
            : elapsed >= timeCapMs(this.kind)
              ? {
                  cause: "time",
                  amount: Math.round(timeCapMs(this.kind) / 60_000),
                }
              : this.creditLimit();
      if (hit != null) this.startCloseOut(pi, hit);
    });

    pi.on("tool_call", (event) => {
      if (this.closingTurns == null || isHandoverTool(event.toolName)) return;
      return {
        block: true,
        reason:
          "The run is closing: no more work. Hand over any files the user has not been given with " +
          `${PRESENT_TOOL}, then write your closing message to the user now: what is done and where ` +
          "it is, what is left, and that they can send a message to carry on.",
      };
    });

    // A history the running model cannot hold is summarized on one that can.
    pi.on("session_before_compact", async (event) => {
      const summarizer = this.options.summarizer;
      if (summarizer == null) return;
      const messages = event.preparation.messagesToSummarize as Parameters<
        typeof estimateTokens
      >[0][];
      const tokens = messages.reduce(
        (sum, message) => sum + estimateTokens(message),
        0
      );
      const window = this.model?.contextWindow ?? 0;
      const limit =
        this.learned.get(modelKey(this.model)) ?? Math.floor(window * 0.8);
      if (window <= 0 || tokens < limit) return;
      const choice = await summarizer(tokens, this.lane(), this.model);
      if (choice == null) return;
      process.stderr.write(
        `[spend] summarizing ${tokens} tokens on ${modelKey(choice.model)}: ${modelKey(this.model)} holds ${limit}\n`
      );
      const compaction = await compact(
        event.preparation,
        choice.model as never,
        undefined,
        undefined,
        event.customInstructions,
        event.signal,
        undefined,
        choice.streamFn as never
      );
      return { compaction };
    });
  };
}

/** Tool lists measured so far: pi keeps one array until the tools change. */
const toolTokens = new WeakMap<readonly unknown[], number>();

/** Rough tokens of what every request carries: the system prompt and the tools. */
export const fixedTokens = (session: {
  systemPrompt: string;
  agent: { state: { tools?: readonly unknown[] } };
}): number => {
  const tools = session.agent.state.tools ?? [];
  let measured = toolTokens.get(tools);
  if (measured == null) {
    measured = tools.length === 0 ? 0 : tokensOfText(JSON.stringify(tools));
    toolTokens.set(tools, measured);
  }
  return tokensOfText(session.systemPrompt) + measured;
};

/** Scales measured so far, by the request (assistant message) they were measured on. */
const scales = new WeakMap<object, number>();

/**
 * The provider's tokens per estimated token, from the last request that
 * reported its size: estimates run four characters a token, and tool
 * schemas run nearer three. Never below 1 (an estimate never shrinks), at
 * most 2; 1 before any request reported.
 */
export const tokenScale = (session: {
  systemPrompt: string;
  messages: readonly unknown[];
  agent: { state: { tools?: readonly unknown[] } };
}): number => {
  for (let index = session.messages.length - 1; index >= 0; index--) {
    const message = session.messages[index] as {
      role?: string;
      usage?: { input?: number; cacheRead?: number; cacheWrite?: number };
    };
    if (message.role !== "assistant" || message.usage == null) continue;
    const sent =
      (message.usage.input ?? 0) +
      (message.usage.cacheRead ?? 0) +
      (message.usage.cacheWrite ?? 0);
    if (sent <= 0) continue;
    const known = scales.get(message);
    if (known != null) return known;
    const estimated =
      fixedTokens(session) + historyTokens(session.messages.slice(0, index));
    const scale =
      estimated > 0 ? Math.min(2, Math.max(1, sent / estimated)) : 1;
    scales.set(message, scale);
    return scale;
  }
  return 1;
};

/** Rough tokens of what one turn carries at least: the prompt, the tools and the last message. */
export const oneTurnTokens = (session: {
  systemPrompt: string;
  messages: readonly unknown[];
  agent: { state: { tools?: readonly unknown[] } };
}): number => {
  const last = [...session.messages]
    .reverse()
    .find((message) => (message as { role?: string }).role === "user");
  return (
    fixedTokens(session) + (last == null ? 0 : estimateTokens(last as never))
  );
};

/** Rough tokens of the whole history as it would be sent. */
export const historyTokens = (messages: readonly unknown[]): number =>
  messages.reduce<number>(
    (sum, message) => sum + estimateTokens(message as never),
    0
  );
