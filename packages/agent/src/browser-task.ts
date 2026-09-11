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

import { abacusBotDir } from "./config.js";
import { excludedTools } from "./excluded-tools.js";
import type { AgentEvent } from "./protocol.js";
import { whenAborted } from "./subagent-abort.js";
import { forwardChildToolEvents, traceChildEvent } from "./subagent-events.js";

const MAX_PROVIDER_RETRIES = 2;

// Bounds, because a run holds a browser view. Wrap-up points come first: a run
// told to report keeps its findings, a run cut off loses them.
export const MAX_TURNS = 100;
export const WRAP_UP_TURN = 60;
/** Tool output read so far; past this the run is told to conclude. */
export const WRAP_UP_RESULT_CHARS = 350_000;
/**
 * Navigations to the same host in a row with no interaction before the run is
 * told it is going in circles (a login wall otherwise becomes twenty searches).
 */
export const REPEAT_HOST_LIMIT = 8;
const TIMEOUT_MS = 12 * 60 * 1000;

const WRAP_UP_MESSAGE =
  "You are close to your limit. Stop exploring now and write your final report from what " +
  "you have already seen: the concrete values, and plainly what you could not finish.";
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

/** Short on purpose: site advice arrives from `browser_navigate` on load. */
const BROWSER_SYSTEM_PROMPT = [
  "You are a browser sub-agent with one task on a real website. The browser tools are the",
  "only tools you have: no files, no shell, nobody to ask. Finish in the browser and report.",
  "",
  "How to work:",
  "1. browser_navigate goto with the most specific URL you can build. Search sites take the",
  "   query in the URL; try that before driving a form. The result lists the page's",
  "   clickable elements as @eN refs.",
  "2. Act with browser_interact using a ref. Every action reports what changed and lists new",
  "   elements with their refs, so you usually do not need another snapshot.",
  '3. browser_snapshot find:"..." when you need an element that was not listed; extract with',
  "   a selector when you want rows of data. Refs stay valid while the element is on the page.",
  "",
  "Rules that save the most trouble:",
  "- City, airport, product and address boxes are autocompletes: use interact pick, never fill.",
  "  Check the field really shows the value afterwards.",
  "- If the result mentions something on top of the page, interact dismiss first.",
  "- Results load after the page says it has loaded: interact wait with text or url_pattern.",
  "  Do not repeat a click because nothing happened yet; the same call twice books twice.",
  "- Three failed tries at one element means the approach is wrong: screenshot, read where",
  "  you actually are, and change approach.",
  "- Never enter passwords, card numbers or ID details, complete a payment or booking, or",
  "  solve a CAPTCHA. When you reach a step only the user can do, stop there, leave the page",
  '  as it is, and end your report with a line starting "NEEDS USER:" that says exactly what',
  '  they should do in the browser ("sign in to LinkedIn", "enter the card details and press',
  '  Pay"). You will be resumed on the same page once they have done it.',
  "",
  "Your final message is the entire answer the caller receives. Give the concrete values:",
  "numbers, names, URLs, dates. Say plainly what you could not do and why. An honest partial",
  "answer beats a confident guess.",
].join("\n");

export interface BrowserTaskContext {
  cwd: string;
  agentDir: string;
  modelRuntime: ModelRuntime;
  settingsManager: SettingsManager;
  model?: unknown;
  /** The browser MCP tools, read at run time so a reconnected server is seen. */
  browserTools: () => unknown[];
}

export interface BrowserTaskOptions {
  startUrl?: string;
  signal?: AbortSignal;
  /** Things the report must mention; a report missing any gets one nudge. */
  reportFields?: string[];
  /** Continue the run that stopped for the user; `task` is then their reply. */
  resume?: boolean;
}

export interface BrowserTaskResult {
  text: string;
  turns: number;
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
export const NEEDS_USER_PATTERN = /^\s*\**\s*NEEDS USER:/im;

export function needsUser(report: string): boolean {
  return NEEDS_USER_PATTERN.test(report);
}

interface PausedRun {
  session: { prompt: (text: string) => Promise<void>; dispose: () => void };
  pausedAt: number;
}

/** How long a paused run waits for the user before it is let go. */
const PAUSED_RUN_TTL_MS = 45 * 60 * 1000;

/**
 * Runs waiting on the user, one per parent session; the sub-agent keeps its
 * transcript and page so "done, continue" picks up where it stopped.
 */
const pausedRuns = new WeakMap<BrowserTaskContext, PausedRun>();

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
 * Run one browser task and return what the sub-agent concluded. Never throws:
 * a failure is reported to the parent as text so it can adapt.
 */
export async function runBrowserTask(
  context: BrowserTaskContext,
  task: string,
  emit: (event: AgentEvent) => void,
  options: BrowserTaskOptions = {}
): Promise<BrowserTaskResult> {
  const { startUrl, signal, reportFields = [], resume = false } = options;
  const forwardTools = forwardChildToolEvents("web", emit);
  const trace = new RunTrace(task);
  let turns = 0;
  let lastText = "";
  let retries = 0;
  let providerError = "";
  let readChars = 0;
  let wrappedUp = false;
  let warnedRepeating = false;
  const repeats = new RepeatTracker();
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
    };

    if (resumed != null) {
      session = resumed.session as typeof session;
    } else {
      const resourceLoader = new DefaultResourceLoader({
        cwd: context.cwd,
        agentDir: context.agentDir,
        settingsManager: context.settingsManager,
        appendSystemPrompt: [BROWSER_SYSTEM_PROMPT],
        // No extensions: the permission gate would prompt a user not watching.
        extensionFactories: [],
      });

      await resourceLoader.reload();

      const tools = context.browserTools();
      const created = await createAgentSession({
        cwd: context.cwd,
        agentDir: context.agentDir,
        modelRuntime: context.modelRuntime,
        resourceLoader,
        settingsManager: context.settingsManager,
        customTools: (acceptsImages(context.model)
          ? tools
          : withoutImages(tools)) as never,
        // The user's Capabilities choices apply here too.
        excludeTools: [...EXCLUDED_TOOLS, ...excludedTools()],
        ...(context.model != null ? { model: context.model as never } : {}),
      });

      session = created.session as unknown as typeof session;
    }

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

        if (event.type === "message_start") childMessage += 1;
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
          readChars += resultChars(
            (event as unknown as { result?: unknown }).result
          ).length;
        }

        if (event.type === "tool_execution_start" && !warnedRepeating) {
          const started = event as unknown as {
            toolName: string;
            args?: unknown;
          };
          if (repeats.observe(started.toolName, started.args)) {
            warnedRepeating = true;
            trace.write({ type: "nudge", reason: "repeating" });
            void session.steer(REPEATING_MESSAGE).catch(() => undefined);
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
            void session.steer(WRAP_UP_MESSAGE).catch(() => undefined);
          }

          return;
        }

        // A hard provider failure is stamped on the message; no update fires.
        if (event.type === "message_end") {
          const message = (
            event as {
              message?: { stopReason?: unknown; errorMessage?: unknown };
            }
          ).message;

          if (
            message?.stopReason === "error" &&
            typeof message.errorMessage === "string"
          ) {
            providerError = message.errorMessage;
          }
        }

        // `turn_end` is one model call, which is what the ceiling counts.
        if (event.type === "turn_end") {
          turns += 1;

          if (!wrappedUp && turns >= WRAP_UP_TURN) {
            wrappedUp = true;
            void session.steer(WRAP_UP_MESSAGE).catch(() => undefined);
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

      const opening =
        resumed != null
          ? "The user has done their part in the browser and says: " +
            `"${task}"\n\nThe page is as you left it. Take a snapshot to see where it is now, then continue ` +
            "from where you stopped and finish the task. Do not start over."
          : resume
            ? `${task}\n\n(There was no earlier browser run to continue, so this starts fresh.)`
            : startUrl != null && startUrl.trim().length > 0
              ? `Start at ${startUrl.trim()}\n\n${task}`
              : task;

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

        if (outcome.stoppedBy === "completed" && needsUser(lastText)) {
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
                "on the page — take one more look if you must — or say explicitly that you could not find each one."
            );
          }
        }
      } finally {
        if (timeoutTimer != null) clearTimeout(timeoutTimer);
        abort.dispose();
        unsubscribe();
      }
    } finally {
      // A capped run can be mid-tool; a stranded child looks cut short.
      forwardTools.settle();
      if (keepAlive) {
        // Waiting on the user: the transcript and the page stay put.
        pausedRuns.set(context, { session, pausedAt: Date.now() });
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
      report: lastText.slice(0, 8000),
      providerError,
    });

    if (outcome.stoppedBy === "error") {
      return {
        text: `The browser task failed: ${providerError.length > 0 ? providerError : "the sub-agent prompt failed"}`,
        turns,
        stoppedBy: "error",
      };
    }

    if (outcome.stoppedBy === "aborted") {
      return {
        text: "The browser task was stopped before it finished.",
        turns,
        stoppedBy: "aborted",
      };
    }

    if (outcome.stoppedBy === "provider-error") {
      return {
        text:
          providerError.length > 0
            ? `The browser sub-agent could not reach the model: ${providerError}`
            : "The browser sub-agent could not reach the model.",
        turns,
        stoppedBy: "provider-error",
      };
    }

    return {
      text:
        lastText.trim().length > 0
          ? lastText
          : "The browser sub-agent finished without reporting anything.",
      turns,
      stoppedBy: outcome.stoppedBy,
    };
  } catch (error) {
    trace.write({
      type: "outcome",
      stoppedBy: "error",
      error: error instanceof Error ? error.message : String(error),
    });

    return {
      text: `The browser task failed: ${error instanceof Error ? error.message : String(error)}`,
      turns,
      stoppedBy: "error",
    };
  }
}
