/**
 * Ported from codingagent-lite (abacusai/codingagent-lite), MIT.
 *
 * Budgets: bound the three ways cheap models waste money and turns. Turn cap
 * (ABACUSAI_BOT_TURN_CAP, default 250 model calls a run) and time
 * (ABACUSAI_BOT_RUN_CAP_MS, default 60 minutes from the user's message): at
 * 100 calls short of the cap the model is told to wrap up and present what it
 * has, at 50 short it is told again and harder. At either limit the turn
 * closes out instead of being cut mid-step: the model is
 * told, unseen, to stop working, hand over what exists and write its closing
 * message; every tool call but the hand-over (present_deliverable, send_media)
 * is refused from then on, and only if it still has not finished a few calls
 * later is the run stopped with a message that says so.
 * Repetition: the third identical tool call in a run is blocked (the second,
 * for a connector call, which is billed). Connector calls: every fifth one,
 * the model is reminded what they cost and asked whether it already has
 * enough. There is no cap, only a nudge. Show your work: a run that has written
 * files but presented nothing is told, unseen by the user, to present what it
 * has after 10 minutes of working time, and again after 20; time
 * spent waiting on an approval is not working time. A chat whose user waits
 * in a messaging app (BudgetOptions.checkIns) checks in at the same marks
 * instead: whenever the user has heard nothing since the last one, built
 * files or not, the model is told to send what it has so far. Credits: a session on
 * billed Abacus credits with under a tenth left is told once, unseen, to wrap
 * up and hand over. Temperature (ABACUSAI_BOT_TEMPERATURE, default 0.3, "off"
 * to disable) when unset.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
  hostCreditBalance,
  refreshCreditBalanceIfStale,
  type CreditBalance,
} from "../credit-balance.js";
import { connectorToolMeta } from "../mcp/index.js";
import { WRITE_TOOLS } from "../permissions.js";

/** How far short of the cap each warning lands. */
const WRAP_UP_MARGIN = 100;
const FINAL_MARGIN = 50;
const REPEAT_LIMIT = 3;
/** A connector call costs credits; the first identical one already answered. */
const CONNECTOR_REPEAT_LIMIT = 2;
const CONNECTOR_REMINDER_EVERY = 5;
/** Working time before a run that built something but showed nothing is told to show it. */
const PRESENT_NUDGE_MS = 10 * 60_000;
const PRESENT_AGAIN_MS = 20 * 60_000;
const PRESENT_TOOL = "present_deliverable";
/** The share of granted credits below which a billed run is told to wrap up. */
const CREDITS_LOW_SHARE = 0.1;
/** Model calls a closing run gets to write its closing message. */
const CLOSE_OUT_TURNS = 2;

/** Why the budget stopped the current run, or null. Cleared as the next run starts. */
let stoppedBecause: string | null = null;

/** The session reads this to say why a run ended rather than blaming the provider. */
export const budgetStopReason = (): string | null => stoppedBecause;

/**
 * Tools that sample state which changes on its own. Repeating a screenshot
 * after a tap is the whole job, so the repeat guard's "same input, same
 * result" refusal would be false; a loop of them is bounded by the turn cap.
 */
const RESAMPLES_LIVE_STATE = new Set([
  "device_screenshot",
  "device_snapshot",
  "device_logs",
  "device_list",
  "browser_snapshot",
  "browser_execute",
  "browser_interact",
  "browser_tabs",
  "read_output",
  "vision_analyze",
]);

function turnCap(): number {
  const raw = Number(process.env.ABACUSAI_BOT_TURN_CAP);
  return Math.floor(Number.isFinite(raw) && raw > 0 ? raw : 250);
}

/**
 * How long one run may go before it closes out. A healthy build or install
 * runs for tens of minutes and is left to finish; past an hour the run hands
 * over what it has rather than going on unattended.
 */
function runCapMs(): number {
  const raw = Number(process.env.ABACUSAI_BOT_RUN_CAP_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 60 * 60_000;
}

const closeOutPrompt = (why: string): string =>
  `${why} Stop working now: no more building, fixing or exploring, those tool calls will be refused. ` +
  `If you made files the user has not been handed yet, hand them over first with ${PRESENT_TOOL}, ` +
  `unfinished or not. Then write your closing message to the user, in their language: what is done ` +
  `and where it is, what is left, and that they can send a message to carry on from here.`;

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

const connectorPrompt = (calls: number, credits: number): string =>
  `Cost check: this run has made ${calls} connector calls, and each one costs ` +
  `${credits} credits. Make sure you are being efficient: do not redo searches ` +
  `or re-fetch what you already have, and check whether you can complete the task now with the ` +
  `information you already hold. If you can, finish; if not, make the fewest further calls that ` +
  `get you there.`;

const presentNudgePrompt = (minutes: number): string =>
  `Show your work: you have been working for over ${minutes} minutes and the user has not seen anything ` +
  `yet. Present what exists now with ${PRESENT_TOOL}, which opens it in the preview. If nothing ` +
  `is presentable yet (only scripts, assets or notes), build the simplest working version first, ` +
  `with CSS or placeholder images instead of generated art, and present that. You can keep ` +
  `improving it afterwards.`;

/**
 * The same marks for a chat whose user waits in a messaging app: what they
 * hear is a progress line or a file in the chat, never a preview.
 */
const checkInPrompt = (minutes: number, tools: readonly string[]): string =>
  `Check in: you have been working for over ${minutes} minutes and the user, waiting in the chat, has not ` +
  `heard from you in that time. Send them what you have so far now, in their language: a short progress ` +
  `line with ${tools[0]} saying what is done and what comes next, and any files made so far, finished or ` +
  `not, with ${PRESENT_TOOL}. Then carry on.`;

const creditsLowPrompt = (balance: CreditBalance): string =>
  `Credit check: the user's Abacus.AI account has ${Math.max(0, Math.floor(balance.remaining))} of ` +
  `${balance.granted} credits left, and the run stops mid-step when they run out. Wrap up now: ` +
  `finish the smallest useful version of what you are building, hand over every deliverable with ` +
  `${PRESENT_TOOL}, then tell the user, in their own language, what is done and what is left. Do not ` +
  `start new work.`;

/** A model that spends Abacus credits: the platform marks the ones that bill nothing. */
const billedAbacus = (model: unknown): boolean => {
  const choice = model as { provider?: string; free?: boolean } | undefined;
  return choice?.provider === "abacus" && choice.free !== true;
};

/** The tool that hands work over, under its own name or a server's prefix. */
const isPresentTool = (name: string): boolean =>
  name === PRESENT_TOOL || name.endsWith(`_${PRESENT_TOOL}`);

/** What a closing run may still call: handing over what exists, never new work. */
const HANDOVER_TOOLS = [PRESENT_TOOL, "send_media"];
const isHandoverTool = (name: string): boolean =>
  HANDOVER_TOOLS.some((tool) => name === tool || name.endsWith(`_${tool}`));

/** What the user reads when the run is stopped. */
const stoppedMessage = (cap: number): string =>
  `This run made ${cap} model calls without finishing, so it was probably going in circles, and ` +
  `was stopped. Whatever it built is still in the workspace. To get it back on track, send a message ` +
  `that narrows the task: say exactly what you want next, or ask it to present what it has so far.`;

/** What the user reads when a run that hit its time limit did not close out. */
const timeStoppedMessage = (minutes: number): string =>
  `This run worked for ${minutes} minutes without finishing and was stopped. Whatever it built is ` +
  `still in the workspace. Send a message to carry on from here, or ask it to present what it has.`;

function temperatureSetting(): number | undefined {
  const raw = process.env.ABACUSAI_BOT_TEMPERATURE;
  if (raw === "off" || raw === "0off") return undefined;
  if (raw === undefined || raw === "") return 0.3;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : 0.3;
}

export interface BudgetOptions {
  /**
   * A chat whose user waits in a messaging app: the tools that tell them
   * where the work stands (the progress line first). With them, the
   * show-your-work marks are check-ins: the model is told to send what it
   * has whenever the user has heard nothing since the last mark.
   */
  checkIns?: { tools: readonly string[] };
}

/** The tool under its own name or a server's prefix. */
const isTool = (name: string, tool: string): boolean =>
  name === tool || name.endsWith(`_${tool}`);

export const createBudgets =
  (options: BudgetOptions = {}) =>
  (pi: ExtensionAPI): void =>
    budgets(pi, options);

export default function budgets(
  pi: ExtensionAPI,
  options: BudgetOptions = {}
): void {
  const checkInTools = options.checkIns?.tools ?? [];
  /** The user heard from the run since the last mark (a progress line, a file). */
  let heard = false;
  let turns = 0;
  let connectorCalls = 0;
  const callCounts = new Map<string, number>();
  // Working time: the model generating or a tool running. A call held for
  // approval sits between the two, so the wait is not counted.
  let workedMs = 0;
  let activeSince: number | null = null;
  let generating = false;
  const runningTools = new Set<string>();
  let wroteFile = false;
  let presented = false;
  let presentNudges = 0;
  // Once per session: a top-up between runs does not earn a second warning.
  let creditsNudged = false;
  // A turn past its cap or its time: told to close out, then given a few
  // calls. Both belong to the user's turn, not to one pi run: a hidden
  // continuation (a stall's re-ask, an empty reply's ask) starts a run of its
  // own, and must neither restart the hour nor lift a close-out under way.
  let turnStartedAt = Date.now();
  let closingTurns: number | null = null;
  let closingStop: string | null = null;
  const refreshCredits = (ctx: { model?: unknown } | undefined): void => {
    if (billedAbacus(ctx?.model)) refreshCreditBalanceIfStale();
  };
  const track = (change: () => void): void => {
    const now = Date.now();
    if (activeSince != null) workedMs += now - activeSince;
    change();
    activeSince = generating || runningTools.size > 0 ? now : null;
  };

  // A prompt sent while idle starts the user's turn; one sent mid-run joins it.
  pi.on("input", (event) => {
    if ((event as { streamingBehavior?: unknown }).streamingBehavior != null)
      return;
    turnStartedAt = Date.now();
    closingTurns = null;
    closingStop = null;
  });

  pi.on("agent_start", async () => {
    turns = 0;
    connectorCalls = 0;
    stoppedBecause = null;
    callCounts.clear();
    workedMs = 0;
    activeSince = null;
    generating = false;
    runningTools.clear();
    wroteFile = false;
    presented = false;
    presentNudges = 0;
    heard = false;
  });

  pi.on("message_end", (event) => {
    if ((event.message as { role?: string }).role !== "assistant") return;
    track(() => {
      generating = false;
    });
  });

  pi.on("tool_execution_start", (event) => {
    track(() => runningTools.add(event.toolCallId));
  });

  pi.on("tool_execution_end", (event, ctx) => {
    track(() => runningTools.delete(event.toolCallId));
    refreshCredits(ctx);
    if (event.isError) return;
    if (WRITE_TOOLS.has(event.toolName)) wroteFile = true;
    if (isPresentTool(event.toolName)) presented = true;
    if (
      isPresentTool(event.toolName) ||
      checkInTools.some((tool) => isTool(event.toolName, tool))
    )
      heard = true;
  });

  pi.on("turn_end", (_event, ctx) => {
    refreshCredits(ctx);
  });

  pi.on("turn_start", async (_event, ctx) => {
    turns++;
    track(() => {
      generating = true;
    });
    const balance = hostCreditBalance();
    if (
      !creditsNudged &&
      billedAbacus(ctx.model) &&
      balance != null &&
      balance.remaining < balance.granted * CREDITS_LOW_SHARE
    ) {
      creditsNudged = true;
      // Hidden: what the user reads is the model's own wrap-up.
      pi.sendMessage(
        {
          customType: "abacusai-bot-credits-low",
          content: creditsLowPrompt(balance),
          display: false,
        },
        { deliverAs: "steer" }
      );
    }
    // Hidden from the user: the preview appearing is what they see.
    const showWork = (content: string): void => {
      pi.sendMessage(
        { customType: "abacusai-bot-show-work", content, display: false },
        { deliverAs: "steer" }
      );
    };
    if (checkInTools.length > 0) {
      // Each mark once; a check-in only when the user heard nothing since the last.
      const mark =
        workedMs >= PRESENT_AGAIN_MS ? 2 : workedMs >= PRESENT_NUDGE_MS ? 1 : 0;
      if (mark > presentNudges) {
        presentNudges = mark;
        if (!heard)
          showWork(
            checkInPrompt(
              (mark === 2 ? PRESENT_AGAIN_MS : PRESENT_NUDGE_MS) / 60_000,
              checkInTools
            )
          );
        heard = false;
      }
    } else if (wroteFile && !presented) {
      if (workedMs >= PRESENT_AGAIN_MS && presentNudges < 2) {
        presentNudges = 2;
        showWork(presentNudgePrompt(PRESENT_AGAIN_MS / 60_000));
      } else if (workedMs >= PRESENT_NUDGE_MS && presentNudges < 1) {
        presentNudges = 1;
        showWork(presentNudgePrompt(PRESENT_NUDGE_MS / 60_000));
      }
    }
    const cap = turnCap();
    // Each warning fires on its own turn; a cap small enough to fold them
    // onto one turn gets the harder of the two.
    const wrapUpAt = Math.max(1, cap - WRAP_UP_MARGIN);
    const finalAt = Math.max(1, cap - FINAL_MARGIN);
    const steer = (content: string): void => {
      pi.sendMessage(
        { customType: "calite-budget", content, display: true },
        { deliverAs: "steer" }
      );
    };
    if (turns === finalAt) steer(finalPrompt(turns, cap));
    else if (turns === wrapUpAt) steer(wrapUpPrompt(turns, cap));

    // Closing out: a few calls to say what was done, then the stop.
    if (closingTurns != null) {
      closingTurns += 1;
      if (closingTurns > CLOSE_OUT_TURNS) {
        stoppedBecause = closingStop;
        if (ctx.hasUI)
          ctx.ui.notify(
            "AbacusAI Bot: the run did not close out; stopping it",
            "warning"
          );
        ctx.abort();
      }
      return;
    }

    const elapsed = Date.now() - turnStartedAt;
    const overCap = turns > cap;
    if (overCap || elapsed >= runCapMs()) {
      const minutes = Math.round(runCapMs() / 60_000);
      closingTurns = 0;
      closingStop = overCap ? stoppedMessage(cap) : timeStoppedMessage(minutes);
      // Hidden: what the user reads is the model's own closing message.
      pi.sendMessage(
        {
          customType: "abacusai-bot-close-out",
          content: closeOutPrompt(
            overCap
              ? `This run has reached its limit of ${cap} model calls.`
              : `This run has been working for ${minutes} minutes, its limit.`
          ),
          display: false,
        },
        { deliverAs: "steer" }
      );
    }
  });

  pi.on("tool_call", async (event) => {
    // A closing run hands over what exists and writes its closing message;
    // it does not start more work.
    if (closingTurns != null && !isHandoverTool(event.toolName))
      return {
        block: true,
        reason:
          "The run is closing: no more work. Hand over any files the user has not been given with " +
          `${PRESENT_TOOL}, then write your closing message to the user now: what is done and where ` +
          "it is, what is left, and that they can send a message to carry on.",
      };
    let inputKey: string;
    try {
      inputKey = JSON.stringify(event.input);
    } catch {
      return;
    }
    if (RESAMPLES_LIVE_STATE.has(event.toolName)) return;

    const connector = connectorToolMeta(event.toolName);
    if (connector != null) {
      connectorCalls++;
      if (connectorCalls % CONNECTOR_REMINDER_EVERY === 0)
        pi.sendMessage(
          {
            customType: "calite-budget",
            content: connectorPrompt(connectorCalls, connector.credits),
            display: true,
          },
          { deliverAs: "steer" }
        );
    }

    const key = `${event.toolName}:${inputKey}`;
    const count = (callCounts.get(key) ?? 0) + 1;
    callCounts.set(key, count);
    if (connector != null && count >= CONNECTOR_REPEAT_LIMIT) {
      return {
        block: true,
        reason:
          `You already made this exact ${event.toolName} call in this run, and its result is in ` +
          `your context above. Reuse it. Each call costs ${connector.credits} credits; an identical ` +
          `one returns the same answer. If you meant something different, change the arguments.`,
      };
    }
    if (count >= REPEAT_LIMIT) {
      return {
        block: true,
        reason:
          `You have already made this exact ${event.toolName} call ${count - 1} times in this run. ` +
          `Repeating it returns the same result. Step back: state what you learned from the previous ` +
          `result and try a different approach.`,
      };
    }
  });

  pi.on("before_provider_request", (event) => {
    const temp = temperatureSetting();
    if (temp === undefined) return;
    const payload = event.payload;
    if (!payload || typeof payload !== "object") return;
    const p = payload as Record<string, unknown>;
    // Don't fight explicit settings or reasoning modes (some APIs reject
    // custom temperature when extended thinking is enabled).
    if (p.temperature !== undefined) return;
    if (
      p.thinking !== undefined ||
      p.reasoning_effort !== undefined ||
      p.reasoning !== undefined
    )
      return;
    // Reasoning models reject non-default temperature outright (OpenAI o-series
    // and gpt-5, DeepSeek reasoner, R1 variants) even when the payload carries
    // no reasoning parameter, so skip them by model id.
    const modelId = typeof p.model === "string" ? p.model : "";
    if (
      /(^|[/-])o[0-9]+([:-]|$)|gpt-5|reasoner|thinking|(^|[/-])r1([:-]|$)/i.test(
        modelId
      )
    )
      return;
    return { ...p, temperature: temp };
  });
}
