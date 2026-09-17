/**
 * `browser_task`, as a pi tool: the parent's entire view of the browser. Kept
 * apart from `browser-task.ts` so the schema and result phrasing stay separate
 * from the mechanics of running the sub-session.
 */
import { Type } from "typebox";

import {
  runBrowserTask,
  type BrowserTaskContext,
  type BrowserTaskResult,
} from "./browser-task.js";
import type { AgentEvent } from "./protocol.js";

/** Whether the desktop switched this on: absent from the exclusion list. */
export function browserTaskEnabled(): boolean {
  const excluded = (process.env.ABACUSAI_BOT_EXCLUDED_TOOLS ?? "")
    .split(",")
    .map((name) => name.trim());

  return !excluded.includes("browser_task");
}

/**
 * One browser sub-agent at a time: two driving the same view would type into
 * one page and report each other's screen. A second call while one runs is
 * refused, not queued: a queued run sits as an outstanding tool call for
 * minutes with nothing to show, and the parent has nothing to do with the
 * first result until it has both. Refused, it comes back at once and the
 * parent calls again when the first returns.
 */
const browserBusy = { running: false };

const BUSY_MESSAGE =
  "A browser run is already in progress and this session has one browser. Wait for its result, " +
  "then call browser_task again for this task — one run at a time.";

interface PiToolDefinitionLike {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal?: AbortSignal
  ) => Promise<{
    content: Array<{ type: "text"; text: string }>;
    details: unknown;
    isError?: boolean;
  }>;
}

/**
 * Runs one parent session may start in a window before it is told to stop and
 * ask. A parent that keeps re-dispatching the same site (three runs on one
 * question, each re-reading a 40k context per turn) is the most expensive
 * thing this tool can do, and it never improves the answer.
 */
export const DISPATCH_LIMIT = 3;
export const DISPATCH_WINDOW_MS = 15 * 60 * 1000;

/** Sliding window of run starts; pure, for tests. */
export class DispatchBudget {
  private readonly starts: number[] = [];

  constructor(
    private readonly limit = DISPATCH_LIMIT,
    private readonly windowMs = DISPATCH_WINDOW_MS
  ) {}

  /** Records a run at `now` unless the window is full; @returns whether it may run. */
  take(now = Date.now()): boolean {
    while (this.starts.length > 0 && now - this.starts[0]! > this.windowMs) {
      this.starts.shift();
    }
    if (this.starts.length >= this.limit) return false;
    this.starts.push(now);

    return true;
  }
}

/** The card's one-word verdict for a run that did not simply finish. */
export type BrowserRunOutcome = "needs-user" | "limit" | "budget";

export const runOutcome = (
  stoppedBy: BrowserTaskResult["stoppedBy"]
): BrowserRunOutcome | undefined =>
  stoppedBy === "needs-user"
    ? "needs-user"
    : stoppedBy === "turn-limit" || stoppedBy === "timeout"
      ? "limit"
      : undefined;

/** The stops that mean the run produced nothing usable. */
const failedStop = (stoppedBy: BrowserTaskResult["stoppedBy"]): boolean =>
  stoppedBy === "error" ||
  stoppedBy === "provider-error" ||
  stoppedBy === "aborted";

/**
 * @param emit  Publishes agent events; the run is bracketed for the Agents
 * pane.
 */
export function buildBrowserTaskTool(
  context: BrowserTaskContext,
  emit: (event: AgentEvent) => void
): PiToolDefinitionLike {
  let counter = 0;
  const budget = new DispatchBudget();

  return {
    name: "browser_task",
    label: "browser_task",
    description: [
      "Do something on a real website that needs a real browser.",
      "",
      "NOT the way to read the web. `web_search` finds pages and `web_fetch` reads one, and",
      "between them they answer most questions about anything public — documentation, an",
      'article, a repository, a reference page, "what is the current X". Both return text in',
      "seconds. A browser run takes minutes, holds a lock no other run can pass, and arrives at",
      "the same answer. Look something up that way first; come here when that is not enough.",
      "",
      "Hands the whole job to a sub-agent that has the browser — it navigates, fills forms,",
      "clicks through, waits for results, and reports what it found. You get its conclusion,",
      "not the twenty snapshots it took to get there.",
      "",
      "One site, one goal per run. A sub-agent has a fixed turn budget and no memory of this",
      'conversation, so "compare prices on two sites and get flight numbers and links" is',
      "three runs, not one: give each run a single site and exactly what to report. When a",
      "run comes back partial, use what it found; sending it back to the same site for the",
      "rest costs as much again and rarely adds more. You may start a few runs per",
      "conversation before being told to stop and ask the user.",
      "",
      "Use it when the page will not give up its content to a fetch: a web app the user is",
      "signed in to, a multi-step form, a flow that needs clicking through, results that only",
      "appear after interaction, a page whose content is drawn by scripts, or a running app you",
      "need to see rendered.",
      "",
      "If a fetch returned a login wall, a consent screen, an empty shell or a page that clearly",
      "rendered nothing, that is the signal to come here — not a reason to give up.",
      "",
      "Describe the task the way you would to a person who cannot see this conversation: what",
      "to do, on which site, and what to report back. Name the specifics you need in",
      'report_fields (e.g. ["price", "departure time", "airline"]) — a report that skips',
      "one is sent back for it.",
      "",
      "This session has one browser, so its tasks run one at a time: a second call while one",
      "is running is refused, not queued — wait for the result and call again. When you want",
      "five lookups on one site, ask for all five in a single task and have it report a row",
      "for each.",
      "",
      "It cannot read files or run commands, and it will stop rather than pay for anything,",
      "book anything, enter card or ID details, or fill a CAPTCHA. When it stops for that, its",
      'report ends with "NEEDS USER:" and what they must do. Tell the user to open the Browser',
      "pane in this chat and do that step; when they say it is done, call this tool again with",
      "continue_from_last: true and their message as the task — the same sub-agent carries on",
      "from the same page with everything it already found.",
    ].join("\n"),
    parameters: Type.Object({
      task: Type.String({
        description:
          "The complete, self-contained task, including what to report back. The sub-agent sees none of this conversation.",
      }),
      start_url: Type.Optional(
        Type.String({
          description:
            "Where to begin, when you already know the page. Skip it and the sub-agent works it out.",
        })
      ),
      continue_from_last: Type.Optional(
        Type.Boolean({
          description:
            "Resume the run that stopped for the user, on the same page with its history. task is then what the user said once done.",
        })
      ),
      report_fields: Type.Optional(
        Type.Array(Type.String(), {
          description:
            'What the report must contain, as short names: ["price", "departure time", "URL"]. A report missing one is asked for it once.',
        })
      ),
    }),
    execute: async (_toolCallId, params, signal) => {
      // Stop can land before the tool starts; a sub-session would outlive it.
      if (signal?.aborted) {
        return {
          content: [{ type: "text" as const, text: "Stopped." }],
          details: { stoppedBy: "aborted" },
          isError: true,
        };
      }

      const task = typeof params.task === "string" ? params.task.trim() : "";
      const startUrl =
        typeof params.start_url === "string"
          ? params.start_url.trim()
          : undefined;
      const resume = params.continue_from_last === true;
      const reportFields = Array.isArray(params.report_fields)
        ? params.report_fields.filter(
            (field): field is string =>
              typeof field === "string" && field.trim().length > 0
          )
        : [];

      if (task.length === 0) {
        return {
          content: [
            { type: "text" as const, text: "A task description is required." },
          ],
          details: {},
          isError: true,
        };
      }

      if (browserBusy.running) {
        return {
          content: [{ type: "text" as const, text: BUSY_MESSAGE }],
          details: { stoppedBy: "busy", outcome: "busy" },
          isError: false,
        };
      }

      // A resumed run is the same run continuing, not a new dispatch.
      if (!resume && !budget.take()) {
        return {
          content: [
            {
              type: "text" as const,
              text:
                `Browser budget used: ${DISPATCH_LIMIT} runs in the last ${DISPATCH_WINDOW_MS / 60_000} minutes. ` +
                "Answer from what those runs reported, and ask the user before browsing further.",
            },
          ],
          details: { stoppedBy: "budget", outcome: "budget" },
          isError: false,
        };
      }

      // Bracketed even on failure, or the card spins forever.
      const subtaskId = `browser-${Date.now()}-${++counter}`;
      emit({
        type: "subtask_start",
        id: subtaskId,
        description: task.length > 120 ? `${task.slice(0, 117)}…` : task,
        kind: "browser",
      });

      let result;
      // Failed until proven otherwise: a throw skips straight to `finally`.
      let status: "completed" | "failed" = "failed";
      let outcome: BrowserRunOutcome | undefined;
      try {
        browserBusy.running = true;
        try {
          result = await runBrowserTask(context, task, emit, {
            startUrl,
            signal,
            reportFields,
            resume,
          });
        } finally {
          browserBusy.running = false;
        }
        // The card's verdict is the tool result's: a run stopped by the user or
        // at its cap still handed back what it found, and is not a failure.
        status = failedStop(result.stoppedBy) ? "failed" : "completed";
        outcome = runOutcome(result.stoppedBy);
        // Not re-emitted: the last message already streamed into the card.
      } finally {
        emit({
          type: "subtask_end",
          id: subtaskId,
          status,
          ...(outcome != null ? { outcome } : {}),
        });
      }

      const failed = failedStop(result.stoppedBy);

      // A capped run's answer is partial; saying so makes the caller weigh it.
      const note =
        result.stoppedBy === "needs-user"
          ? "\n\n(The browser is left on that page. Tell the user to open the Browser pane in this chat, " +
            "do the step above, and reply here. Then call browser_task with continue_from_last: true and " +
            "their reply as the task; the same sub-agent continues with everything it has found.)"
          : result.stoppedBy === "turn-limit"
            ? "\n\n(The browser sub-agent hit its limit — this is what it had, and may be incomplete.)"
            : result.stoppedBy === "timeout"
              ? "\n\n(The browser sub-agent ran out of time — this is what it had, and may be incomplete.)"
              : "";

      return {
        content: [{ type: "text" as const, text: `${result.text}${note}` }],
        details: {
          turns: result.turns,
          executeCalls: result.executeCalls,
          steers: result.steers,
          stoppedBy: result.stoppedBy,
          ...(outcome != null ? { outcome } : {}),
        },
        isError: failed,
      };
    },
  };
}
