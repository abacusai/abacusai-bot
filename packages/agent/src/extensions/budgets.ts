/**
 * Ported from codingagent-lite (abacusai/codingagent-lite), MIT.
 *
 * Budgets: bound the three ways cheap models waste money and turns. Turn cap
 * (ABACUSAI_BOT_TURN_CAP, default 250): at 100 turns short of it the model is
 * told to wrap up and present what it has, at 50 short it is told again and
 * harder, past it the run is stopped with a message that says so.
 * Repetition: the third identical tool call in a run is blocked — the second,
 * for a connector call, which is billed. Connector calls: every fifth one,
 * the model is reminded what they cost and asked whether it already has
 * enough — no cap, a nudge. Temperature
 * (ABACUSAI_BOT_TEMPERATURE, default 0.3, "off" to disable) when unset.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { connectorToolMeta } from "../mcp/index.js";

/** How far short of the cap each warning lands. */
const WRAP_UP_MARGIN = 100;
const FINAL_MARGIN = 50;
const REPEAT_LIMIT = 3;
/** A connector call costs credits; the first identical one already answered. */
const CONNECTOR_REPEAT_LIMIT = 2;
const CONNECTOR_REMINDER_EVERY = 5;

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
  "read_output",
  "vision_analyze",
]);

function turnCap(): number {
  const raw = Number(process.env.ABACUSAI_BOT_TURN_CAP);
  return Math.floor(Number.isFinite(raw) && raw > 0 ? raw : 250);
}

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
  `${credits} credits. Make sure you are being efficient — do not redo searches ` +
  `or re-fetch what you already have — and check whether you can complete the task now with the ` +
  `information you already hold. If you can, finish; if not, make the fewest further calls that ` +
  `get you there.`;

/** What the user reads when the run is stopped. */
const stoppedMessage = (cap: number): string =>
  `This run made ${cap} model calls without finishing, so it was probably going in circles, and ` +
  `was stopped. Whatever it built is still in the workspace. To get it back on track, send a message ` +
  `that narrows the task: say exactly what you want next, or ask it to present what it has so far.`;

function temperatureSetting(): number | undefined {
  const raw = process.env.ABACUSAI_BOT_TEMPERATURE;
  if (raw === "off" || raw === "0off") return undefined;
  if (raw === undefined || raw === "") return 0.3;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : 0.3;
}

export default function (pi: ExtensionAPI) {
  let turns = 0;
  let connectorCalls = 0;
  const callCounts = new Map<string, number>();

  pi.on("agent_start", async () => {
    turns = 0;
    connectorCalls = 0;
    stoppedBecause = null;
    callCounts.clear();
  });

  pi.on("turn_start", async (_event, ctx) => {
    turns++;
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

    if (turns > cap) {
      stoppedBecause = stoppedMessage(cap);
      if (ctx.hasUI)
        ctx.ui.notify(
          `AbacusAIBot: turn budget (${cap}) exhausted — stopping this run`,
          "warning"
        );
      ctx.abort();
    }
  });

  pi.on("tool_call", async (event) => {
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
          `your context above — reuse it. Each call costs ${connector.credits} credits; an identical ` +
          `one returns the same answer. If you meant something different, change the arguments.`,
      };
    }
    if (count >= REPEAT_LIMIT) {
      return {
        block: true,
        reason:
          `You have already made this exact ${event.toolName} call ${count - 1} times in this run — ` +
          `repeating it returns the same result. Step back: state what you learned from the previous ` +
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
