/**
 * Ported from codingagent-lite (abacusai/codingagent-lite), MIT.
 *
 * Nudges that keep cheap models from wasting turns. What a run may spend
 * (calls, time, credits) and its close-out are the spend governor's
 * (spend-governor.ts); these only steer.
 * Repetition: the third identical tool call against the same state is blocked
 * (the second, for a connector call, which is billed); a successful write,
 * command, connector change or user server's change in between makes the
 * next one a new look.
 * Connector calls: every fifth one, the model is reminded what they cost and
 * asked whether it already has enough. There is no cap, only a nudge. Show your work: a run that has written
 * files but presented nothing is told, unseen by the user, to present what it
 * has after 10 minutes of working time, and again after 20; time
 * spent waiting on an approval is not working time. Progress updates: with
 * someone in the chat, a run the user has heard nothing from for a while
 * (DESKTOP_CADENCE, or the longer MESSAGING_CADENCE in a chat app) is told, unseen, to write one short line on where it
 * stands; a chat in a messaging app (BudgetOptions.checkIns) sends it with
 * its progress tool. Temperature (ABACUSAI_BOT_TEMPERATURE, default 0.3, "off"
 * to disable) when unset.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { BOT_TIME_TOOL_NAME } from "../bot/bot-time-tool.js";
import { closesReply, hasWords } from "../forever/reply-end.js";
import { connectorToolMeta, userMcpToolChangesState } from "../mcp/index.js";
import { isOwnerAudience } from "../owner-tools.js";
import { WRITE_TOOLS } from "../permissions.js";
import { RunNotes } from "../repeated-notes.js";
import { toToolKind } from "../tool-display.js";
import { ownEntry, UNATTENDED_CONNECTOR_READS } from "../tool-policy.js";

const REPEAT_LIMIT = 3;
/** A connector call costs credits; the first identical one already answered. */
const CONNECTOR_REPEAT_LIMIT = 2;
const CONNECTOR_REMINDER_EVERY = 5;
/** Working time before a run that built something but showed nothing is told to show it. */
const PRESENT_NUDGE_MS = 10 * 60_000;
const PRESENT_AGAIN_MS = 20 * 60_000;
const PRESENT_TOOL = "present_deliverable";
/**
 * When the model is asked for a line, by working time the user has heard
 * nothing (`afterMs`, or `afterCalls` tool calls once `minMs` went by), with
 * a shorter `first` wait before a turn's first line (null for none), spaced
 * `spacingMs` apart and at most `maxPerTurn` a turn.
 */
interface UpdateCadence {
  afterMs: number;
  afterCalls: number;
  minMs: number;
  first: { afterMs: number; afterCalls: number; minMs: number } | null;
  spacingMs: number;
  maxPerTurn: number;
}

/**
 * The app's own chat window. Most people who press Stop on a working run have
 * seen nothing new for a minute or more, so a line comes after about one, and
 * before a turn's first line after 30 seconds.
 */
const DESKTOP_CADENCE: UpdateCadence = {
  afterMs: 75_000,
  afterCalls: 12,
  minMs: 45_000,
  first: { afterMs: 30_000, afterCalls: 6, minMs: 15_000 },
  spacingMs: 90_000,
  maxPerTurn: 8,
};

/**
 * A chat in a messaging app (checkIns): each line is a push to the person's
 * phone and an extra model call, so the wait stays long.
 */
const MESSAGING_CADENCE: UpdateCadence = {
  afterMs: 3 * 60_000,
  afterCalls: 15,
  minMs: 90_000,
  first: null,
  spacingMs: 4 * 60_000,
  maxPerTurn: 5,
};

/** Two in a row unanswered end a turn's reminders. */
const UPDATE_MAX_IGNORED = 2;

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
  "fetch_background_output",
  BOT_TIME_TOOL_NAME,
  "read_whatsapp_messages",
  "read_telegram_messages",
  "read_discord_messages",
  "read_chat_messages",
  "vision_analyze",
]);

/** Tools whose answer comes from the web: nothing done here changes it. */
const READS_THE_WEB = new Set(["web_fetch", "web_search"]);

/**
 * Whether a call may change what a repeat would see: a file write or a
 * command, a connector call that is not a reviewed read, or a call to a
 * server the user added that the server does not mark read-only (Roblox
 * Studio's playtest and script edits change the place the next look sees).
 */
function changesState(
  toolName: string,
  input: unknown,
  connector: ReturnType<typeof connectorToolMeta>
): boolean {
  if (connector != null) {
    const action = String((input as { action?: unknown })?.action ?? "");
    return !(
      ownEntry(UNATTENDED_CONNECTOR_READS, connector.tool) ?? []
    ).includes(action);
  }
  const userTool = userMcpToolChangesState(toolName);
  if (userTool != null) return userTool;
  const kind = toToolKind(toolName);
  return (
    WRITE_TOOLS.has(toolName) ||
    kind === "edit" ||
    kind === "delete" ||
    kind === "move" ||
    kind === "execute"
  );
}

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
 * The user has heard nothing for a while: one line on where things stand.
 * A messaging chat hears only its progress tool (`tools[0]`) and files, never
 * a preview; elsewhere the model's own words reach the user.
 */
const updatePrompt = (
  minutes: number,
  tools: readonly string[],
  first = false
): string => {
  const silence = first
    ? "The user has seen nothing from you since their message, and the work is taking a while."
    : `The user has heard nothing from you for ${minutes} ${minutes === 1 ? "minute" : "minutes"} of work.`;
  const what = "what you found so far and what you are trying next";
  // Not "give the final answer if ready": asked often, a cheap model reads
  // it as leave to wrap up unfinished work.
  const done = "Then carry on with the work.";
  return tools.length > 0
    ? `${silence} Before your next step, send them one short line in their language with ${tools[0]}: ` +
        `${what}, and any files made so far, finished or not, with ${PRESENT_TOOL}. ${done}`
    : `${silence} In this message, before your next tool call, write one short line in their language: ` +
        `${what}. ${done}`;
};

/**
 * A turn nobody is in the chat for (a routine's run, a bot answering a bot):
 * there is no one to wrap up for, and a run told to wrap up skips its job.
 */
const nobodyPresent = (): boolean =>
  process.env.ABACUSAI_BOT_NOBODY_PRESENT === "1";

/** The tool that hands work over, under its own name or a server's prefix. */
const isPresentTool = (name: string): boolean =>
  name === PRESENT_TOOL || name.endsWith(`_${PRESENT_TOOL}`);

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
   * where the work stands (the progress line first). Its progress reminders
   * name them, only they count as the user hearing something, and the
   * show-your-work preview nudge is off.
   */
  checkIns?: { tools: readonly string[] };
  /** The spend governor is closing the run out: no progress reminder then. */
  closing?: () => boolean;
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
  const cadence = checkInTools.length > 0 ? MESSAGING_CADENCE : DESKTOP_CADENCE;
  const closing = options.closing ?? (() => false);
  let turns = 0;
  let connectorCalls = 0;
  // Each call's count, and the state it last ran against. A successful call
  // that may change state moves the state on, so a repeat after it is a new
  // look; its own effect counts as the state its repeat meets.
  const callCounts = new Map<string, { count: number; state: number }>();
  let state = 0;
  const pendingCalls = new Map<string, { key: string; changes: boolean }>();
  // Working time: the model generating or a tool running. A call held for
  // approval sits between the two, so the wait is not counted.
  let workedMs = 0;
  let activeSince: number | null = null;
  let generating = false;
  const runningTools = new Set<string>();
  let wroteFile = false;
  let presented = false;
  let presentNudges = 0;
  // Progress updates: working time and tool calls since the user last heard
  // something, and this user turn's reminders (count, unanswered in a row).
  let workedAtHeard = 0;
  let callsUnheard = 0;
  let lastReminderAt: number | null = null;
  let reminders = 0;
  let unanswered = 0;
  // Whether the user has heard anything since their message started this turn.
  let heardThisTurn = false;
  let showWorkTurn = -1;
  // A note that only restates an earlier one is not shown, so it is not heard.
  const notes = new RunNotes();
  const track = (change: () => void): void => {
    const now = Date.now();
    if (activeSince != null) workedMs += now - activeSince;
    change();
    activeSince = generating || runningTools.size > 0 ? now : null;
  };
  const hear = (): void => {
    heardThisTurn = true;
    workedAtHeard = workedMs;
    callsUnheard = 0;
    unanswered = 0;
  };
  /** The show-your-work mark due now (10 or 20 minutes), or null. */
  const showWorkDue = (): number | null => {
    if (checkInTools.length > 0 || !wroteFile || presented) return null;
    if (workedMs >= PRESENT_AGAIN_MS && presentNudges < 2) return 2;
    if (workedMs >= PRESENT_NUDGE_MS && presentNudges < 1) return 1;
    return null;
  };
  const showWorkText = (mark: number): string =>
    presentNudgePrompt(
      (mark === 2 ? PRESENT_AGAIN_MS : PRESENT_NUDGE_MS) / 60_000
    );

  // A prompt sent while idle starts the user's turn; one sent mid-run joins it.
  pi.on("input", (event) => {
    if ((event as { streamingBehavior?: unknown }).streamingBehavior != null)
      return;
    reminders = 0;
    unanswered = 0;
    heardThisTurn = false;
  });

  pi.on("agent_start", async () => {
    turns = 0;
    connectorCalls = 0;
    callCounts.clear();
    pendingCalls.clear();
    workedMs = 0;
    activeSince = null;
    generating = false;
    runningTools.clear();
    wroteFile = false;
    presented = false;
    presentNudges = 0;
    workedAtHeard = 0;
    callsUnheard = 0;
    lastReminderAt = null;
    showWorkTurn = -1;
    notes.reset();
  });

  pi.on("message_end", (event) => {
    if ((event.message as { role?: string }).role !== "assistant") return;
    track(() => {
      generating = false;
    });
    const message = event.message as Parameters<typeof hasWords>[0];
    const text = message.content
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("");
    const note = message.content.some((block) => block.type === "toolCall");
    const hidden = note && notes.hides(text);
    if (note) notes.add(text);
    // On the desktop the model's own words reach the user; a messaging chat
    // hears only what its progress tools send.
    if (checkInTools.length === 0 && !hidden && hasWords(message)) hear();
  });

  pi.on("tool_execution_start", (event) => {
    track(() => runningTools.add(event.toolCallId));
  });

  pi.on("tool_execution_end", (event) => {
    track(() => runningTools.delete(event.toolCallId));
    const pending = pendingCalls.get(event.toolCallId);
    pendingCalls.delete(event.toolCallId);
    callsUnheard++;
    if (event.isError) return;
    if (pending?.changes) {
      state++;
      const counted = callCounts.get(pending.key);
      if (counted != null) counted.state = state;
    }
    if (WRITE_TOOLS.has(event.toolName)) wroteFile = true;
    if (isPresentTool(event.toolName)) presented = true;
    if (
      isPresentTool(event.toolName) ||
      checkInTools.some((tool) => isTool(event.toolName, tool))
    )
      hear();
  });

  /** Asks for one short line when the user has heard nothing for a while. */
  const remindIfDue = (): void => {
    const unheard = workedMs - workedAtHeard;
    const first =
      cadence.first != null && !heardThisTurn && reminders === 0
        ? cadence.first
        : null;
    const wait = first ?? cadence;
    const due =
      unheard >= wait.afterMs ||
      (callsUnheard >= wait.afterCalls && unheard >= wait.minMs);
    if (
      !due ||
      reminders >= cadence.maxPerTurn ||
      unanswered >= UPDATE_MAX_IGNORED ||
      (lastReminderAt != null && workedMs - lastReminderAt < cadence.spacingMs)
    )
      return;
    // A show-work nudge queued this turn goes in the same request: one steer.
    if (showWorkTurn === turns) return;
    reminders++;
    unanswered++;
    lastReminderAt = workedMs;
    const minutes = Math.max(1, Math.floor(unheard / 60_000));
    let content = updatePrompt(minutes, checkInTools, first != null);
    const mark = showWorkDue();
    if (mark != null) {
      presentNudges = mark;
      content += `\n\n${showWorkText(mark)}`;
    }
    pi.sendMessage(
      { customType: "abacusai-bot-progress-update", content, display: false },
      { deliverAs: "steer" }
    );
  };

  pi.on("turn_end", (event) => {
    // After a round of tools the run usually goes on, so a steer queued here
    // lands at the tail of the next request. A batch of reply-closing tools
    // can end the run instead; a steer then would reopen the finished reply.
    // Only the user's own chat is told: a contact never hears progress.
    const results = (event as { toolResults?: Array<{ toolName?: string }> })
      .toolResults;
    if (
      results != null &&
      results.length > 0 &&
      !results.every((result) => closesReply(result.toolName ?? "")) &&
      !closing() &&
      !nobodyPresent() &&
      (checkInTools.length > 0 || isOwnerAudience())
    )
      remindIfDue();
  });

  pi.on("turn_start", async () => {
    turns++;
    track(() => {
      generating = true;
    });
    // Hidden from the user: the preview appearing is what they see.
    const mark = showWorkDue();
    if (mark != null) {
      presentNudges = mark;
      showWorkTurn = turns;
      pi.sendMessage(
        {
          customType: "abacusai-bot-show-work",
          content: showWorkText(mark),
          display: false,
        },
        { deliverAs: "steer" }
      );
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
    const previous = callCounts.get(key);
    const count =
      previous != null &&
      (previous.state === state || READS_THE_WEB.has(event.toolName))
        ? previous.count + 1
        : 1;
    callCounts.set(key, { count, state });
    pendingCalls.set(event.toolCallId, {
      key,
      changes: changesState(event.toolName, event.input, connector),
    });
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
          `result and try a different approach.` +
          (count > REPEAT_LIMIT
            ? " If no other approach is left, stop and tell the user what you tried and what is still unknown."
            : ""),
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
