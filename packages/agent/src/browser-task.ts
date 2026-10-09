/**
 * Running a whole browser job in a sub-agent of its own: browser tools, a
 * prompt about nothing but driving a browser, no way to touch the working tree.
 * Built for small models: the run is nudged to report before it runs out of
 * turns or context, and a report missing requested fields gets one nudge.
 */
import fs from "fs";
import path from "path";

import {
  createAgentSession,
  DefaultResourceLoader,
  type AgentSessionEvent,
  type ModelRuntime,
  type SettingsManager,
} from "@earendil-works/pi-coding-agent";

import type { ChannelCapabilities } from "./channel.js";
import {
  BROWSER_PAUSE_TOOL_NAME,
  type CheckoutPause,
  type CheckoutRun,
  type CheckoutState,
  type HostCheckoutCall,
  readCheckoutState,
} from "./checkout-run.js";
import { abacusBotDir } from "./config.js";
import { excludedTools, vaultEnabled } from "./excluded-tools.js";
import type { MidTaskInbox, MidTaskRun } from "./mid-task-inbox.js";
import type { AgentEvent } from "./protocol.js";
import { DeliveredMedia, type MediaCheck } from "./send-media-tool.js";
import { isMediaId } from "./send-media.js";
import { whenAborted } from "./subagent-abort.js";
import { forwardChildToolEvents, traceChildEvent } from "./subagent-events.js";

const MAX_PROVIDER_RETRIES = 2;

// Bounds, because a run holds a browser view. Wrap-up points come first: a run
// told to report keeps its findings, a run cut off loses them. Each point says
// how many turns remain: "close to your limit" reads as "out of budget" to a
// small model, which then reports early (or, on a resumed run, at once).
export const MAX_TURNS = 100;
export const WRAP_UP_TURN = 60;
export const FINAL_WARNING_TURN = 85;
/** Tool output read so far; past this the run is told to conclude. */
export const WRAP_UP_RESULT_CHARS = 350_000;
/**
 * Navigations to the same host in a row with no interaction before the run is
 * told it is going in circles (a login wall otherwise becomes twenty searches).
 */
export const REPEAT_HOST_LIMIT = 8;
const TIMEOUT_MS = 12 * 60 * 1000;
/**
 * `browser_execute` calls in a row before the run is told to use the page
 * tools. Hand-written scraping is where a small model spends a whole run:
 * one query per turn, retyped after every page change.
 */
export const EXECUTE_STREAK_LIMIT = 6;

export const wrapUpMessage = (turnsLeft: number): string =>
  `You have about ${turnsLeft} turns left. Stop exploring now and write your final report ` +
  "from what you have already seen: the concrete values, and plainly what you could not finish.";
export const finalWarningMessage = (turnsLeft: number): string =>
  `${turnsLeft} turns left. Write the final report in your next message; do not start anything new.`;
const EXECUTE_STREAK_MESSAGE =
  "You are scraping the page by hand, one browser_execute at a time. Use the page tools " +
  'instead: browser_snapshot extract with a selector for rows of data, snapshot find:"..." ' +
  "for an element, and browser_interact by ref to act. They cost one call where the script " +
  "costs six.";
/** The saved login a run was handed, said where the run reads its task. */
export const loginNote = (itemId: string): string =>
  `Saved login: vault item ${itemId}. When you reach the sign-in form on its site, call browser_vault_fill ` +
  `with item_id "${itemId}" and field "login": the browser finds the username and password fields and types ` +
  "them. Never type them any other way.";
/** A resumed run gets its budget back; said outright, or the old wrap-up stands. */
export const budgetNote = (turns: number): string =>
  `(Budget: ${turns} tool turns for this run; you will be warned as it runs low.)`;
const REPEATING_MESSAGE =
  "You have loaded the same site many times in a row without acting on a page. More of the " +
  "same search will not change the answer. If a sign-in wall or missing page is in the way, " +
  "say so. Report now what you have found, concretely, and what you could not get.";

/** A sub-agent with `bash` curls the site when a page frustrates it. */
const EXCLUDED_TOOLS = [
  "write",
  "edit",
  "bash",
  "read",
  "find",
  "grep",
  "ls",
  "todo",
  "delegate_task",
];

/**
 * Short on purpose: site advice arrives from `browser_navigate` on load.
 * `vault` is whether saved logins and approved payments can be filled here.
 */
const browserSystemPrompt = (vault: boolean): string =>
  [
    "You are a browser sub-agent with one task on a real website. The browser tools are the",
    "only tools you have: no files, no shell, nobody to ask. Finish in the browser and report.",
    "",
    "How to work:",
    "1. browser_navigate goto with the most specific URL you can build. Search sites take the",
    "   query in the URL; try that before driving a form. The result lists the page's",
    "   clickable elements as @eN refs.",
    "2. Act with browser_interact using a ref. Every action reports what changed and lists new",
    "   elements with their refs, so you usually do not need another snapshot.",
    '3. browser_snapshot action:"snapshot" with find:"..." when you need an element that was not',
    '   listed; action:"extract" with a selector when you want rows of data (prices, times,',
    "   names): it returns them as rows in one call. Refs stay valid while the element is on",
    "   the page; if one goes stale the action refreshes it for you once.",
    "4. browser_execute is the last resort, for what the tools above cannot reach (shadow",
    "   roots, frames). Reading rows or clicking with a script means step 3 or 2 was skipped.",
    "",
    "You have a turn budget and are told as it runs low. Plan for it: one specific URL, the",
    "site's own filters, extract for the data, then report. Do not re-read a page you already",
    "have the values from.",
    "",
    "Rules that save the most trouble:",
    "- City, airport, product and address boxes are autocompletes: use interact pick, never fill.",
    "  Check the field really shows the value afterwards.",
    "- If the result mentions something on top of the page, interact dismiss first.",
    "- Results load after the page says it has loaded: interact wait with text or url_pattern.",
    "  Do not repeat a click because nothing happened yet; the same call twice books twice.",
    "- Three failed tries at one element means the approach is wrong: screenshot, read where",
    "  you actually are, and change approach.",
    ...(vault
      ? [
          "- Never type a password, card number, CVV, card expiry, name on card or one-time code",
          "  yourself (never guess one), and never solve a CAPTCHA. When you are given a saved login and reach a sign-in form on its site, call",
          '  browser_vault_fill field:"login" with its item_id: the browser finds and fills the',
          "  username and password and names the button to click. If it says the password is still",
          "  pending, go to the next step and call it again. If it refuses, stop with",
          '  browser_pause need:"login": the browser reports its reason, so never guess one.',
          "- Paying: only after the user approved this payment; the browser checks the approval and",
          "  the total itself and refuses everything else. Without an approval, go on to the page with",
          '  the card form and stop there with browser_pause need:"payment" and total_ref (the element',
          "  showing the order total). Once approved: fill the card number, expiry (card_exp, or",
          "  card_exp_month and card_exp_year), the name on card if asked and the CVV only if the page",
          "  asks, each once with browser_vault_fill, then click Pay once. Never pick a card the site saved, UPI",
          '  or a wallet app, and leave "save this card" unchecked. Scripts do not run during a checkout.',
        ]
      : [
          "- Never type a password, card number, CVV, card expiry, name on card or one-time code",
          "  yourself (never guess one), and never solve a CAPTCHA. At a sign-in form, stop with",
          '  browser_pause need:"login".',
          "- Paying: never; the browser refuses a Pay click. Go on to the page with the card form and",
          '  stop there with browser_pause need:"payment" and total_ref (the element showing the order',
          "  total). Scripts do not run during a checkout.",
        ]),
    "- Traveler details the task gives you, fill in; never invent one. A passport number is never",
    "  in your task: when it names a saved traveler (t1), type it with browser_traveler_fill. Any",
    '  detail the form needs that the task does not give: browser_pause need:"details".',
    ...(vault
      ? [
          "- At a step only the user can do (their details, a sign-in with no saved login, a code, the",
          "  payment approval, a CAPTCHA, a choice the task did not make), call browser_pause alone with",
        ]
      : [
          "- At a step only the user can do (their details, a sign-in, a code, the payment, a CAPTCHA,",
          "  a choice the task did not make), call browser_pause alone with",
        ]),
    "  what it needs. It ends your run, the page stays as it is, and you are resumed on it once",
    "  they have done it. Without browser_pause, end your report with a line starting",
    '  "NEEDS USER:" that says exactly what they should do. A finished or partial report gets',
    "  neither.",
    "- After a payment, report the confirmation: the booking reference or order number and the",
    "  total.",
    "",
    "Your final message is the entire answer the caller receives. Give the concrete values:",
    "numbers, names, URLs, dates. When the task names fields to report, end with a FOUND:",
    "block that lists each field with its value or 'not found'. Say plainly what you could",
    "not do and why. An honest partial answer beats a confident guess.",
  ].join("\n");

/** The sub-agent's standing prompt where the vault is (the hosted bot). */
export const BROWSER_SYSTEM_PROMPT = browserSystemPrompt(true);

/** For a run that can reach the user mid-task (the phone's `send_progress`). */
const PROGRESS_PROMPT = [
  "",
  "You can message the user while you work with `send_progress`: a short line at each real",
  "milestone and an early finding as soon as you have one, never more than about 90 seconds",
  "apart, in the language the task names. A message from the user mid-run arrives marked",
  "[user mid-task]: answer a question with `send_progress`, and fold a change into the task.",
].join("\n");

/** For a run whose chat takes images (the phone's `send_media`). */
const MEDIA_PROMPT = [
  'To show the user the page, take browser_snapshot action:"screenshot" and send its media id',
  "with `send_media` and a short caption when they ask to see it. A browser_pause for a",
  "payment, a CAPTCHA or a choice takes its own screenshot for the user. After a payment,",
  "send a screenshot of the confirmation page.",
].join("\n");

/** A run's failure, for the agent's log; the model is told only that it failed. */
const logRunFailure = (what: string, detail: string): void => {
  process.stderr.write(
    `[abacusai-bot-agent] browser task: ${what}${detail.length > 0 ? `: ${detail.slice(0, 500)}` : ""}\n`
  );
};

export interface BrowserTaskContext {
  cwd: string;
  agentDir: string;
  modelRuntime: ModelRuntime;
  settingsManager: SettingsManager;
  model?: unknown;
  /** The browser MCP tools, read at run time so a reconnected server is seen. */
  browserTools: () => unknown[];
  /**
   * Tools that reach the user mid-run (the phone's `send_progress`); `sent` is
   * the run's media ledger, `held` asks the app whether it holds a media id.
   */
  progressTools?: (sent: DeliveredMedia, held?: MediaCheck) => unknown[];
  /** Whether the app holds a media id for this session. */
  mediaCheck?: MediaCheck;
  /** With it, the user's mid-task messages go to the run alone while it is live. */
  midTask?: MidTaskInbox;
  /** What the user's chat can do; an app chat with its Browser pane when absent. */
  channel?: ChannelCapabilities;
  /** The browser's `browser_checkout`, which holds the session's checkout. */
  checkout?: HostCheckoutCall;
  /** The user's own recent messages, numbered: a details stop's answer is the next one. */
  userWords?: () => ReadonlyArray<{ seq: number; text: string }>;
}

/** The sub-agent's system prompt for a run with `context`. */
export function browserSubAgentPrompt(
  context: Pick<BrowserTaskContext, "progressTools" | "channel">
): string {
  const base = vaultEnabled()
    ? BROWSER_SYSTEM_PROMPT
    : browserSystemPrompt(false);
  if (context.progressTools == null) return base;
  return (
    `${base}\n${PROGRESS_PROMPT}` +
    (context.channel?.media === true ? `\n${MEDIA_PROMPT}` : "")
  );
}

export interface BrowserTaskOptions {
  startUrl?: string;
  signal?: AbortSignal;
  /** Things the report must mention; a report missing any gets one nudge. */
  reportFields?: string[];
  /** Continue the run that stopped for the user; `task` is then their reply. */
  resume?: boolean;
  /** The media this run asks to send; its caller names them to the loop. */
  sentMedia?: DeliveredMedia;
  /** The screenshots the run took; its caller names those it did not send. */
  takenMedia?: DeliveredMedia;
  /** The checkout this run moves; with it the run can stop with `browser_pause`. */
  checkout?: CheckoutRun;
  /** Said to a resumed run about where its checkout stands. */
  resumeNote?: string;
  /** The saved login (vault item id) the run signs in with. */
  loginItemId?: string;
}

export interface BrowserTaskResult {
  text: string;
  /** Ids of the user's mid-task messages the run's model read; it answered them. */
  consumedMessageIds?: string[];
  /** What those messages said, in order. */
  consumedMessageTexts?: string[];
  turns: number;
  /** `browser_execute` calls; a high share means the page tools were skipped. */
  executeCalls: number;
  /** Nudges the run was given, in order: "wrap-up", "final", "repeating", "execute". */
  steers: string[];
  /** The `browser_pause` the run stopped at; its stop is "needs-user". */
  pause?: CheckoutPause;
  stoppedBy:
    | "completed"
    | "needs-user"
    | "turn-limit"
    | "timeout"
    | "error"
    | "provider-error"
    | "aborted";
}

/** A run stopped at a step only the user can do says so on its last line. */
export const NEEDS_USER_PATTERN = /^\s*\**\s*NEEDS USER:\**\s*(.*)$/im;
/**
 * The line with nothing after it. Models write "NEEDS USER: none" to say they
 * were not blocked; read as a stop, that sends the user to the browser to do
 * nothing and parks the run.
 */
const NOTHING_NEEDED =
  /^[\s*_]*(?:none|nothing|nil|n\/a|no(?:ne)?\s+(?:action|step|input|further|hand-?over)|-|—)?(?:[\s*_.,;:!—-]|$)/i;

export function needsUser(report: string): boolean {
  const match = NEEDS_USER_PATTERN.exec(report);
  if (match == null) return false;
  const rest = (match[1] ?? "").trim();
  if (rest.length === 0) return false;

  const head = NOTHING_NEEDED.exec(rest);

  return head == null || head[0].trim().length === 0;
}

interface PausedRun {
  session: { prompt: (text: string) => Promise<void>; dispose: () => void };
  /** The session's batch gate; its tools were wrapped with it. */
  gate: BatchGate;
  pausedAt: number;
}

/** How long a paused run waits for the user before it is let go. */
const PAUSED_RUN_TTL_MS = 45 * 60 * 1000;

/**
 * Runs waiting on the user, one per parent session; the sub-agent keeps its
 * transcript and page so "done, continue" picks up where it stopped.
 */
const pausedRuns = new WeakMap<BrowserTaskContext, PausedRun>();

/** Whether a run is waiting on the user for this context, and still in time. */
export function hasPausedRun(context: BrowserTaskContext): boolean {
  const paused = pausedRuns.get(context);
  return paused != null && Date.now() - paused.pausedAt <= PAUSED_RUN_TTL_MS;
}

function takePausedRun(context: BrowserTaskContext): PausedRun | null {
  const paused = pausedRuns.get(context);
  if (paused == null) return null;
  pausedRuns.delete(context);
  if (Date.now() - paused.pausedAt > PAUSED_RUN_TTL_MS) {
    paused.session.dispose();
    return null;
  }
  return paused;
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .filter(
      (part): part is { type: string; text: string } =>
        part != null &&
        typeof part === "object" &&
        (part as { type?: unknown }).type === "text"
    )
    .map((part) => part.text)
    .join("");
}

/** Counts uninterrupted navigations to one host; pure, for tests. */
export class RepeatTracker {
  private host: string | null = null;
  private streak = 0;

  constructor(private readonly limit = REPEAT_HOST_LIMIT) {}

  /** @returns true exactly when the streak first reaches the limit. */
  observe(toolName: string, args: unknown): boolean {
    if (toolName === "browser_interact") {
      const action = (args as { action?: unknown } | undefined)?.action;
      // Waiting and scrolling are not progress; anything else is.
      if (action !== "wait" && action !== "scroll") {
        this.host = null;
        this.streak = 0;
      }

      return false;
    }
    if (toolName !== "browser_navigate") return false;

    const url = (args as { url?: unknown } | undefined)?.url;
    let host: string;
    try {
      host = typeof url === "string" ? new URL(url).hostname : "(history)";
    } catch {
      host = String(url);
    }
    this.streak = host === this.host ? this.streak + 1 : 1;
    this.host = host;

    return this.streak === this.limit;
  }
}

/** Counts `browser_execute` calls with no other tool between; pure, for tests. */
export class ExecuteStreakTracker {
  private streak = 0;
  total = 0;

  constructor(private readonly limit = EXECUTE_STREAK_LIMIT) {}

  /** @returns true exactly when the streak reaches the limit. */
  observe(toolName: string): boolean {
    if (toolName !== "browser_execute") {
      this.streak = 0;

      return false;
    }
    this.total += 1;
    this.streak += 1;

    return this.streak === this.limit;
  }
}

/**
 * Field names that ask for nothing in particular; nudging over them is waste.
 */
const GENERIC_FIELDS = new Set([
  "status",
  "result",
  "results",
  "summary",
  "details",
  "detail",
  "info",
  "information",
  "output",
  "report",
  "answer",
  "response",
  "data",
  "findings",
  "notes",
  "content",
]);

/** Fields the report never mentions, by a case-insensitive word match. */
export function missingReportFields(
  report: string,
  fields: readonly string[]
): string[] {
  const haystack = report.toLowerCase();

  return fields.filter((field) => {
    const needle = field.trim().toLowerCase();
    if (needle.length === 0 || GENERIC_FIELDS.has(needle)) return false;
    if (haystack.includes(needle)) return false;
    // "departure time" is covered by a report that says "departs" or "time".
    const words = needle.split(/[\s_-]+/).filter((word) => word.length > 3);

    return !words.some((word) => haystack.includes(word.slice(0, 5)));
  });
}

/**
 * Whether image results should reach this model; stripping them keeps a
 * screenshot's base64 out of the transcript for a model that cannot use it.
 */
function acceptsImages(model: unknown): boolean {
  const input = (model as { input?: unknown } | undefined)?.input;

  return !Array.isArray(input) || input.includes("image");
}

interface ToolLike {
  execute?: (...args: unknown[]) => Promise<{ content?: unknown[] }>;
}

function withoutImages(tools: unknown[]): unknown[] {
  return tools.map((tool) => {
    const original = (tool as ToolLike).execute;
    if (typeof original !== "function") return tool;

    return {
      ...(tool as object),
      execute: async (...args: unknown[]) => {
        const result = await original.apply(tool, args);
        if (!Array.isArray(result?.content)) return result;

        return {
          ...result,
          content: result.content.filter(
            (block) => (block as { type?: unknown })?.type !== "image"
          ),
        };
      },
    };
  });
}

/** A per-run trace on disk, when `ABACUSAI_BOT_BROWSER_TRACE` is set. */
class RunTrace {
  private readonly file: string | null;

  constructor(task: string) {
    const setting = (process.env.ABACUSAI_BOT_BROWSER_TRACE ?? "").trim();
    if (setting.length === 0 || setting === "0") {
      this.file = null;

      return;
    }
    const dir =
      setting === "1"
        ? path.join(abacusBotDir(), "logs", "browser-runs")
        : setting;
    try {
      fs.mkdirSync(dir, { recursive: true });
      this.file = path.join(
        dir,
        `${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`
      );
      this.write({ type: "task", task });
    } catch {
      this.file = null;
    }
  }

  write(entry: Record<string, unknown>): void {
    if (this.file == null) return;
    try {
      fs.appendFileSync(
        this.file,
        `${JSON.stringify({ t: new Date().toISOString(), ...entry })}\n`
      );
    } catch {
      // A trace that cannot be written is not worth failing the run over.
    }
  }

  event(event: AgentSessionEvent): void {
    if (this.file == null) return;
    const type = (event as { type?: string }).type;
    if (type === "tool_execution_start") {
      const started = event as unknown as { toolName: string; args?: unknown };
      this.write({ type, tool: started.toolName, args: started.args });
    } else if (type === "tool_execution_end") {
      const ended = event as unknown as {
        toolName: string;
        isError?: boolean;
        result?: unknown;
      };
      this.write({
        type,
        tool: ended.toolName,
        isError: ended.isError,
        result: resultChars(ended.result).slice(0, 4000),
      });
    }
  }
}

/** Keep in step with the browser's screenshot result (`media id: …`). */
const SCREENSHOT_MEDIA_ID = /\bmedia id: (media-[0-9a-f]+)/g;

/** The media ids a browser tool result holds for a screenshot it took. */
export function screenshotMediaIds(text: string): string[] {
  return [...text.matchAll(SCREENSHOT_MEDIA_ID)]
    .map((match) => match[1]!)
    .filter(isMediaId);
}

function resultChars(result: unknown): string {
  if (typeof result === "string") return result;
  const content = (result as { content?: unknown } | null)?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .map((block) =>
      block != null && typeof block === "object" && "text" in block
        ? String((block as { text: unknown }).text)
        : ""
    )
    .join("");
}

/**
 * One sub-agent session's hold on `browser_pause`. A pause ends the run, so
 * it acts alone: when the model calls it beside other tools, those are
 * refused before they run (the batch is known at the assistant message's
 * end, before any of its tools runs), and once it paused nothing else runs.
 */
export interface BatchGate {
  /** Tool calls of the current batch refused because a pause is in it. */
  blocked: Set<string>;
  /** The browser's checkout state once the run paused; null while it works. */
  pause: CheckoutState | null;
}

export const PAUSE_BATCH_REFUSAL =
  "Not run: browser_pause ends the run, so nothing else runs beside or after it.";

/** Marks the calls a pause shares its batch with, from the assistant message that holds them. */
export function noteBatch(gate: BatchGate, message: unknown): void {
  const content = (message as { role?: unknown; content?: unknown } | null)
    ?.content;
  if (
    (message as { role?: unknown } | null)?.role !== "assistant" ||
    !Array.isArray(content)
  )
    return;
  const calls = content.filter(
    (block): block is { type: "toolCall"; id: string; name: string } =>
      block != null &&
      typeof block === "object" &&
      (block as { type?: unknown }).type === "toolCall" &&
      typeof (block as { id?: unknown }).id === "string"
  );
  if (!calls.some((call) => call.name === BROWSER_PAUSE_TOOL_NAME)) return;
  for (const call of calls)
    if (call.name !== BROWSER_PAUSE_TOOL_NAME) gate.blocked.add(call.id);
}

/** The tools, each refusing what the gate refuses; a pause's result ends the batch. */
export function gateTools(tools: unknown[], gate: BatchGate): unknown[] {
  return tools.map((tool) => {
    const original = (tool as ToolLike).execute;
    if (typeof original !== "function") return tool;
    const name = (tool as { name?: unknown }).name;
    return {
      ...(tool as object),
      execute: async (...args: unknown[]) => {
        const callId = typeof args[0] === "string" ? args[0] : "";
        if (gate.pause != null || gate.blocked.has(callId))
          return {
            content: [{ type: "text", text: PAUSE_BATCH_REFUSAL }],
            details: {},
            isError: true,
            terminate: true,
          };
        const result = (await original.apply(tool, args)) as {
          isError?: boolean;
        } & Record<string, unknown>;
        if (name !== BROWSER_PAUSE_TOOL_NAME || result?.isError === true)
          return result;
        gate.pause = readCheckoutState(resultChars(result)) ?? {
          stage: "search",
          paused: null,
        };
        return { ...result, terminate: true };
      },
    };
  });
}

/**
 * Run one browser task and return what the sub-agent concluded. Never throws:
 * a failure is reported to the parent as text so it can adapt.
 */
export async function runBrowserTask(
  context: BrowserTaskContext,
  task: string,
  emit: (event: AgentEvent) => void,
  options: BrowserTaskOptions = {}
): Promise<BrowserTaskResult> {
  const {
    startUrl,
    signal,
    reportFields = [],
    resume = false,
    checkout,
    resumeNote = "",
    loginItemId,
  } = options;
  const forwardTools = forwardChildToolEvents("web", emit);
  const trace = new RunTrace(task);
  let turns = 0;
  let lastText = "";
  let retries = 0;
  let providerError = "";
  let readChars = 0;
  let wrappedUp = false;
  let finalWarned = false;
  let warnedRepeating = false;
  const repeats = new RepeatTracker();
  const executes = new ExecuteStreakTracker();
  const steers: string[] = [];
  let midTask: MidTaskRun | null = null;
  const outcome: { stoppedBy: BrowserTaskResult["stoppedBy"] } = {
    stoppedBy: "completed",
  };

  // A fresh run replaces whatever was waiting; a resumed run takes it over.
  const paused = takePausedRun(context);
  if (!resume && paused != null) paused.session.dispose();
  const resumed = resume ? paused : null;
  let keepAlive = false;

  try {
    let session: PausedRun["session"] & {
      subscribe: (listener: (event: AgentSessionEvent) => void) => () => void;
      steer: (text: string) => Promise<void>;
      clearQueue: () => void;
    };
    let gate: BatchGate;

    if (resumed != null) {
      session = resumed.session as typeof session;
      gate = resumed.gate;
      gate.pause = null;
      gate.blocked.clear();
    } else {
      gate = { blocked: new Set(), pause: null };
      const resourceLoader = new DefaultResourceLoader({
        cwd: context.cwd,
        agentDir: context.agentDir,
        settingsManager: context.settingsManager,
        appendSystemPrompt: [browserSubAgentPrompt(context)],
        // No extensions: the permission gate would prompt a user not watching.
        extensionFactories: [],
      });

      await resourceLoader.reload();

      const tools = gateTools(
        [
          ...context.browserTools(),
          ...(context.progressTools?.(
            options.sentMedia ?? new DeliveredMedia(),
            context.mediaCheck
          ) ?? []),
        ],
        gate
      );
      const created = await createAgentSession({
        cwd: context.cwd,
        agentDir: context.agentDir,
        modelRuntime: context.modelRuntime,
        resourceLoader,
        settingsManager: context.settingsManager,
        customTools: (acceptsImages(context.model)
          ? tools
          : withoutImages(tools)) as never,
        // Exactly the tools handed to it, by name: nothing pi or a setting
        // would enable besides. The user's Capabilities choices apply too.
        tools: (tools as Array<{ name?: unknown }>)
          .map((tool) => String(tool.name ?? ""))
          .filter((name) => name.length > 0),
        excludeTools: [...EXCLUDED_TOOLS, ...excludedTools()],
        ...(context.model != null ? { model: context.model as never } : {}),
      });

      session = created.session as unknown as typeof session;
    }

    const steer = (kind: string, text: string): void => {
      steers.push(kind);
      trace.write({ type: "nudge", reason: kind, turns });
      void session.steer(text).catch(() => undefined);
    };
    midTask = context.midTask?.open((text) => session.steer(text)) ?? null;

    try {
      // One subscription for the whole run, re-armed because the report nudge
      // is a second prompt on the same session.
      let settle: (() => void) | null = null;
      const nextSettled = (): Promise<void> =>
        new Promise<void>((resolve) => {
          settle = resolve;
        });
      const finish = (): void => {
        const current = settle;
        settle = null;
        current?.();
      };

      // The sub-agent's words stream into the browser card; each child message
      // gets its own id for a new bubble.
      let childMessage = 0;

      const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
        traceChildEvent("web", event);
        trace.event(event);

        if (event.type === "message_end")
          noteBatch(gate, (event as { message?: unknown }).message);
        if (event.type === "message_start") {
          childMessage += 1;
          const started = (
            event as { message?: { role?: string; content?: unknown } }
          ).message;
          if (started?.role === "user")
            midTask?.noteUserMessage(extractText(started.content));
        }
        if (event.type === "message_update") {
          const stream = (
            event as {
              assistantMessageEvent?: { type?: string; delta?: string };
            }
          ).assistantMessageEvent;
          if (stream?.type === "text_delta" && stream.delta) {
            emit({
              type: "text_delta",
              content: stream.delta,
              messageId: `web-${childMessage}`,
            } as AgentEvent);
          }
        }

        if (event.type === "tool_execution_end") {
          const text = resultChars(
            (event as unknown as { result?: unknown }).result
          );
          readChars += text.length;
          for (const id of screenshotMediaIds(text))
            options.takenMedia?.add(id);
        }

        if (event.type === "tool_execution_start") {
          const started = event as unknown as {
            toolName: string;
            args?: unknown;
          };
          if (
            !warnedRepeating &&
            repeats.observe(started.toolName, started.args)
          ) {
            warnedRepeating = true;
            steer("repeating", REPEATING_MESSAGE);
          }
          if (executes.observe(started.toolName)) {
            steer("execute", EXECUTE_STREAK_MESSAGE);
          }
        }

        // Dozens of calls the main transcript must not carry; the card shows
        // them.
        if (forwardTools(event)) {
          if (
            !wrappedUp &&
            event.type === "tool_execution_end" &&
            readChars >= WRAP_UP_RESULT_CHARS
          ) {
            wrappedUp = true;
            steer("wrap-up", wrapUpMessage(MAX_TURNS - turns));
          }

          return;
        }

        // A hard provider failure is stamped on the message; no update fires.
        if (event.type === "message_end") {
          const message = (
            event as {
              message?: {
                role?: string;
                content?: unknown;
                stopReason?: unknown;
                errorMessage?: unknown;
              };
            }
          ).message;

          if (
            message?.stopReason === "error" &&
            typeof message.errorMessage === "string"
          ) {
            providerError = message.errorMessage;
          }
          // Kept as each message ends, so a run cut off by its time limit
          // still hands back the last thing it wrote.
          if (message?.role === "assistant") {
            const text = extractText(message.content);
            if (text.trim().length > 0) lastText = text;
          }
        }

        // `turn_end` is one model call, which is what the ceiling counts.
        if (event.type === "turn_end") {
          turns += 1;

          if (!wrappedUp && turns >= WRAP_UP_TURN) {
            wrappedUp = true;
            steer("wrap-up", wrapUpMessage(MAX_TURNS - turns));
          }
          if (!finalWarned && turns >= FINAL_WARNING_TURN) {
            finalWarned = true;
            steer("final", finalWarningMessage(MAX_TURNS - turns));
          }

          if (turns >= MAX_TURNS) {
            outcome.stoppedBy = "turn-limit";
            unsubscribe();
            finish();

            return;
          }
        }

        if (event.type === "agent_end") {
          if ((event as { willRetry?: boolean }).willRetry === true) {
            retries += 1;

            if (retries > MAX_PROVIDER_RETRIES) {
              outcome.stoppedBy = "provider-error";
              unsubscribe();
              finish();
            }

            return;
          }

          const messages =
            (
              event as {
                messages?: Array<{ role?: string; content?: unknown }>;
              }
            ).messages ?? [];

          for (const message of messages) {
            if (message.role !== "assistant") continue;

            const text = extractText(message.content);

            if (text.trim().length > 0) lastText = text;
          }
        }

        if (event.type === "agent_settled") finish();
      });

      const login = loginItemId != null ? `${loginNote(loginItemId)}\n\n` : "";
      const opening =
        resumed != null
          ? "The user has done their part in the browser and says: " +
            `"${task}"\n\nThe page is as you left it. Take a snapshot to see where it is now, then continue ` +
            "from where you stopped and finish the task. Do not start over.\n\n" +
            (resumeNote.length > 0 ? `${resumeNote}\n\n` : "") +
            login +
            `Your turn budget has been reset: any earlier note that you were near your limit no longer applies. ${budgetNote(MAX_TURNS)}`
          : resume
            ? `${task}\n\n(There was no earlier browser run to continue, so this starts fresh.)\n\n${login}${budgetNote(MAX_TURNS)}`
            : startUrl != null && startUrl.trim().length > 0
              ? `Start at ${startUrl.trim()}\n\n${task}\n\n${login}${budgetNote(MAX_TURNS)}`
              : `${task}\n\n${login}${budgetNote(MAX_TURNS)}`;

      let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<void>((resolve) => {
        timeoutTimer = setTimeout(() => {
          outcome.stoppedBy = "timeout";
          resolve();
        }, TIMEOUT_MS);
      });
      const abort = whenAborted(signal, () => {
        outcome.stoppedBy = "aborted";
      });

      const prompt = async (text: string): Promise<void> => {
        const settled = nextSettled();
        // The .catch is load-bearing: an un-awaited rejection kills the
        // process.
        void session.prompt(text).catch((error) => {
          outcome.stoppedBy = "error";
          providerError =
            error instanceof Error ? error.message : String(error);
          finish();
        });
        await Promise.race([settled, timeout, abort.aborted]);
      };

      try {
        await prompt(opening);

        // A `browser_pause` is the run's stop, whatever it wrote after.
        if (gate.pause != null && outcome.stoppedBy === "completed") {
          checkout?.note(gate.pause);
          outcome.stoppedBy = "needs-user";
          keepAlive = true;
        } else if (outcome.stoppedBy === "completed" && needsUser(lastText)) {
          outcome.stoppedBy = "needs-user";
          keepAlive = true;
        }

        // One nudge for a report that skipped what the caller asked for.
        if (outcome.stoppedBy === "completed" && reportFields.length > 0) {
          const missing = missingReportFields(lastText, reportFields);
          if (missing.length > 0) {
            trace.write({ type: "nudge", missing });
            await prompt(
              `Your report does not mention: ${missing.join(", ")}. Add them from what you saw ` +
                "on the page (take one more look if you must), or say explicitly that you could not find each one."
            );
          }
        }
      } finally {
        if (timeoutTimer != null) clearTimeout(timeoutTimer);
        abort.dispose();
        unsubscribe();
      }
    } finally {
      if (midTask != null) {
        context.midTask?.close(midTask);
        // A paused run must not read them on resume: the host runs them itself.
        session.clearQueue();
      }
      // A capped run can be mid-tool; a stranded child looks cut short.
      forwardTools.settle();
      if (keepAlive) {
        // Waiting on the user: the transcript and the page stay put.
        pausedRuns.set(context, { session, gate, pausedAt: Date.now() });
      } else {
        // Releases the browser for whoever is queued behind this run.
        session.dispose();
      }
    }

    trace.write({
      type: "outcome",
      stoppedBy: outcome.stoppedBy,
      turns,
      readChars,
      executeCalls: executes.total,
      steers,
      report: lastText.slice(0, 8000),
      providerError,
    });
    const tally = {
      turns,
      executeCalls: executes.total,
      steers,
      ...(midTask != null && midTask.consumedIds().length > 0
        ? { consumedMessageIds: midTask.consumedIds() }
        : {}),
      ...(midTask != null && midTask.consumedTexts().length > 0
        ? { consumedMessageTexts: midTask.consumedTexts() }
        : {}),
    };

    if (outcome.stoppedBy === "error") {
      logRunFailure("the sub-agent's prompt failed", providerError);
      return {
        // The cause goes to the log; the caller gets no raw error text.
        text:
          turns === 0
            ? "The browser task failed before the sub-agent could start working."
            : "The browser task failed partway through, before the sub-agent could report.",
        ...tally,
        stoppedBy: "error",
      };
    }

    if (outcome.stoppedBy === "aborted") {
      return {
        text: "The browser task was stopped before it finished.",
        ...tally,
        stoppedBy: "aborted",
      };
    }

    if (outcome.stoppedBy === "provider-error") {
      logRunFailure("the sub-agent's model failed", providerError);
      return {
        text: "The browser sub-agent could not reach its model, so it stopped. Trying again later may work.",
        ...tally,
        stoppedBy: "provider-error",
      };
    }

    const pause =
      outcome.stoppedBy === "needs-user" ? (gate.pause?.paused ?? null) : null;
    if (pause != null)
      return {
        text: lastText.trim().length > 0 ? lastText : pause.summary,
        ...tally,
        stoppedBy: "needs-user",
        pause,
      };

    return {
      text:
        lastText.trim().length > 0
          ? lastText
          : outcome.stoppedBy === "completed"
            ? "The browser sub-agent finished without reporting anything."
            : "The browser sub-agent stopped before it wrote anything.",
      ...tally,
      stoppedBy: outcome.stoppedBy,
    };
  } catch (error) {
    trace.write({
      type: "outcome",
      stoppedBy: "error",
      error: error instanceof Error ? error.message : String(error),
    });
    logRunFailure(
      "the run threw",
      error instanceof Error ? error.message : String(error)
    );

    return {
      text: "The browser task failed unexpectedly before it could report.",
      turns,
      executeCalls: 0,
      steers: [],
      stoppedBy: "error",
    };
  }
}
