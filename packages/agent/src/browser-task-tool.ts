import { Type } from "typebox";

import {
  hasPausedRun,
  NEEDS_USER_PATTERN,
  runBrowserTask,
  type BrowserTaskContext,
  type BrowserTaskResult,
} from "./browser-task.js";
/**
 * `browser_task`, as a pi tool: the parent's entire view of the browser. Kept
 * apart from `browser-task.ts` so the schema and result phrasing stay separate
 * from the mechanics of running the sub-session.
 */
import {
  APP_CHANNEL,
  browserHandoffDescription,
  browserStopNote,
} from "./channel.js";
import { pauseReport, resumeNote } from "./checkout-report.js";
import { CheckoutRun } from "./checkout-run.js";
import { currentMode, unattendedPolicy } from "./current-mode.js";
import { scopeEmit, tagEvent } from "./event-meta.js";
import { AgentMode, type AgentEvent } from "./protocol.js";
import { DeliveredMedia } from "./send-media-tool.js";
import {
  UNATTENDED_BROWSER_TOOLS,
  type UnattendedPolicy,
} from "./tool-policy.js";
import { ID_NUMBER_WITHHELD, redactIdNumbers } from "./traveler/id-numbers.js";

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
  "then call browser_task again for this task, one run at a time.";

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

/** A vault item id, as vault_items lists it. */
const LOGIN_ITEM_ID = /^[A-Za-z0-9_-]{1,128}$/;

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
    this.expire(now);
    if (this.starts.length >= this.limit) return false;
    this.starts.push(now);

    return true;
  }

  /** New runs the window allows right now. */
  left(now = Date.now()): number {
    this.expire(now);
    return Math.max(0, this.limit - this.starts.length);
  }

  private expire(now: number): void {
    while (this.starts.length > 0 && now - this.starts[0]! > this.windowMs) {
      this.starts.shift();
    }
  }
}

/**
 * The one task an unattended watch run may give the browser, built from what
 * the routine declared at creation and never from the model's words: open the
 * page, read it, report.
 */
function watchTask(policy: UnattendedPolicy & { watchUrl: string }): string {
  return [
    `Open ${policy.watchUrl} and read the page. Report what it says that bears on this:`,
    (policy.watchPrompt ?? "").trim() || "what the page shows now.",
    "",
    "Only read. Do not type, click, submit a form, follow a link, open another page,",
    "or change the address. If the page needs any of that, report what it shows as it is.",
  ].join("\n");
}

/** The tool's name, as a pi tool's `name` field. */
const toolName = (tool: unknown): string =>
  String((tool as { name?: unknown }).name ?? "");
/** A mid-run message as long as it may be quoted to the caller. */
const QUOTED_USER_CHARS = 300;

/**
 * Code-like secrets a user may type mid-run: a code after its label, or six
 * to eight digits alone (a one-time code). Four-digit runs stay: years,
 * times and flight numbers.
 */
const CODE_SHAPES: readonly RegExp[] = [
  /\b(otp|code|pin|passcode|password|pwd)(\s*(?:is|:|=|-)?\s*)[^\s,.;!?]+/gi,
  /(?<![\d+$₹£€.,])\b\d{6,8}\b(?![\d.,])/g,
];

/**
 * The user's mid-run words as they go into the caller's transcript: clipped,
 * with ID numbers and code-like strings withheld (they were typed for the
 * page, not for the transcript).
 */
export const quotedUserWords = (text: string): string => {
  let out = redactIdNumbers(text);
  out = out.replace(
    CODE_SHAPES[0]!,
    (_match, label: string, gap: string) =>
      `${label}${gap}${ID_NUMBER_WITHHELD}`
  );
  out = out.replace(CODE_SHAPES[1]!, ID_NUMBER_WITHHELD);
  return out.length > QUOTED_USER_CHARS
    ? `${out.slice(0, QUOTED_USER_CHARS)}…`
    : out;
};

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
  const channel = context.channel ?? APP_CHANNEL;
  // The session's checkout, held by the browser: a fresh run starts it over,
  // a resume asks it whether the user's approval is live.
  const checkout = new CheckoutRun(context.checkout ?? null);
  /** The details stop just reported, and the user's last message then. */
  let detailsAsked: { afterSeq: number } | null = null;
  const nothingPaused = (stage: string) => ({
    content: [
      {
        type: "text" as const,
        text:
          "Nothing is paused to continue: the last browser run finished, or waited too long for " +
          "the user and was let go. Start a new browser_task for what is left (without continue_from_last).",
      },
    ],
    details: { stoppedBy: "nothing-paused", checkoutStage: stage },
    isError: true,
  });

  return {
    name: "browser_task",
    label: "browser_task",
    description: [
      "Do something on a real website that needs a real browser.",
      "",
      "NOT the way to read the web. `web_search` finds pages and `web_fetch` reads one, and",
      "between them they answer most questions about anything public: documentation, an",
      'article, a repository, a reference page, "what is the current X". Both return text in',
      "seconds. A browser run takes minutes, holds a lock no other run can pass, and arrives at",
      "the same answer. Look something up that way first; come here when that is not enough.",
      "",
      "Hands the whole job to a sub-agent that has the browser: it navigates, fills forms,",
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
      "rendered nothing, that is the signal to come here, not a reason to give up.",
      "",
      "Describe the task the way you would to a person who cannot see this conversation: what",
      "to do, on which site, and what to report back. Name the specifics you need in",
      'report_fields (e.g. ["price", "departure time", "airline"]); a report that skips',
      "one is sent back for it.",
      "",
      "This session has one browser, so its tasks run one at a time: a second call while one",
      "is running is refused, not queued. Wait for the result and call again. When you want",
      "five lookups on one site, ask for all five in a single task and have it report a row",
      "for each.",
      "",
      "It cannot read files or run commands. It never types a password, card number, CVV or",
      "code itself, never solves a CAPTCHA, and never pays or books without the user's approval",
      "of that exact payment (payment_approval): the browser refuses a Pay click without one.",
      "At a step only the user can do it stops and says what it needs (traveler details, a",
      "login, a code, the payment approval, a CAPTCHA, a choice), with a screenshot where the",
      "page is the question; the result says what to do next.",
      browserHandoffDescription(channel),
      "",
      "When the user has a login saved in their vault (vault_items) for the site, pass its",
      "item_id as login_item_id: the sub-agent signs in with it without seeing the password,",
      "once the user allowed that sign-in (signin_approval; saving the login allows the first).",
      "When the user saves one or allows a sign-in while a run is paused for it, pass it with",
      "continue_from_last.",
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
      login_item_id: Type.Optional(
        Type.String({
          description:
            "The saved login (its vault item_id) the sub-agent signs in with on its site. Works with continue_from_last too.",
        })
      ),
      report_fields: Type.Optional(
        Type.Array(Type.String(), {
          description:
            'What the report must contain, as short names: ["price", "departure time", "URL"]. A report missing one is asked for it once.',
        })
      ),
    }),
    execute: async (toolCallId, params, signal) => {
      // Stop can land before the tool starts; a sub-session would outlive it.
      if (signal?.aborted) {
        return {
          content: [{ type: "text" as const, text: "Stopped." }],
          details: { stoppedBy: "aborted" },
          isError: true,
        };
      }

      // Unattended: the model's words never reach the browser. The run reads
      // the routine's declared page, with the read-only tools only.
      if (currentMode() === AgentMode.Unattended)
        return runWatch(toolCallId, signal);

      const task = typeof params.task === "string" ? params.task.trim() : "";
      const startUrl =
        typeof params.start_url === "string"
          ? params.start_url.trim()
          : undefined;
      const resume = params.continue_from_last === true;
      const loginItemId =
        typeof params.login_item_id === "string"
          ? params.login_item_id.trim()
          : "";
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
      if (loginItemId.length > 0 && !LOGIN_ITEM_ID.test(loginItemId)) {
        return {
          content: [
            {
              type: "text" as const,
              text: "login_item_id is a saved login's item_id, as vault_items lists it.",
            },
          ],
          details: {},
          isError: true,
        };
      }

      // Only a run that stopped for the user, and is still waiting, continues.
      if (resume && !hasPausedRun(context)) {
        await checkout.abandon();
        return nothingPaused(checkout.state.stage);
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

      // Held from here until the checkout has heard how the run ended: those
      // calls wait on the browser, and a second run must not slip in between.
      browserBusy.running = true;
      try {
        return await runHeld(
          toolCallId,
          task,
          startUrl,
          signal,
          reportFields,
          resume,
          loginItemId.length > 0 ? loginItemId : undefined
        );
      } finally {
        browserBusy.running = false;
      }
    },
  };

  async function runWatch(toolCallId: string, signal: AbortSignal | undefined) {
    const policy = unattendedPolicy();
    const watchUrl = policy?.watchUrl ?? null;
    if (policy == null || watchUrl == null)
      return {
        content: [
          {
            type: "text" as const,
            text: "This routine watches no page, so there is no browser run.",
          },
        ],
        details: { stoppedBy: "refused" },
        isError: true,
      };
    if (browserBusy.running)
      return {
        content: [{ type: "text" as const, text: BUSY_MESSAGE }],
        details: { stoppedBy: "busy", outcome: "busy" },
        isError: false,
      };
    const task = watchTask({ ...policy, watchUrl });
    const subtaskId = `browser-${Date.now()}-${++counter}`;
    emit(
      tagEvent(
        {
          type: "subtask_start",
          id: subtaskId,
          description: `Read ${watchUrl}`,
          kind: "browser",
        },
        { parentToolCallId: toolCallId }
      )
    );
    let status: "completed" | "failed" = "failed";
    browserBusy.running = true;
    try {
      const result = await runBrowserTask(
        {
          cwd: context.cwd,
          agentDir: context.agentDir,
          modelRuntime: context.modelRuntime,
          settingsManager: context.settingsManager,
          ...(context.model != null ? { model: context.model } : {}),
          browserTools: () =>
            context
              .browserTools()
              .filter((tool) =>
                UNATTENDED_BROWSER_TOOLS.includes(toolName(tool))
              ),
        },
        task,
        scopeEmit(emit, subtaskId),
        { startUrl: watchUrl, ...(signal != null ? { signal } : {}) }
      );
      const failed = failedStop(result.stoppedBy);
      status = failed ? "failed" : "completed";
      return {
        content: [{ type: "text" as const, text: result.text }],
        details: { stoppedBy: result.stoppedBy, turns: result.turns },
        isError: failed,
      };
    } finally {
      browserBusy.running = false;
      emit({ type: "subtask_end", id: subtaskId, status });
    }
  }

  async function runHeld(
    toolCallId: string,
    task: string,
    startUrl: string | undefined,
    signal: AbortSignal | undefined,
    reportFields: string[],
    resume: boolean,
    loginItemId: string | undefined
  ) {
    let note = "";
    if (resume) {
      // A details stop is answered by the user's very next message after it
      // was reported: that answer is what binds its site for saved travelers.
      const waiting = detailsAsked;
      detailsAsked = null;
      const answered =
        waiting != null &&
        (context.userWords?.() ?? []).some(
          (message) => message.seq === waiting.afterSeq + 1
        );
      const resumed = await checkout.resume({
        answered,
        ...(loginItemId != null ? { loginItemId } : {}),
      });
      if (resumed.ok === false) return nothingPaused(checkout.state.stage);
      note = resumeNote(checkout.state.stage, resumed.approved);
    } else await checkout.start(loginItemId != null ? { loginItemId } : {});

    // Bracketed even on failure, or the card spins forever.
    const subtaskId = `browser-${Date.now()}-${++counter}`;
    emit(
      tagEvent(
        {
          type: "subtask_start",
          id: subtaskId,
          description: task.length > 120 ? `${task.slice(0, 117)}…` : task,
          kind: "browser",
        },
        { parentToolCallId: toolCallId }
      )
    );
    // Everything the sub-agent does is tagged as its own (AG-UI only).
    const childEmit = scopeEmit(emit, subtaskId);

    const sentMedia = new DeliveredMedia();
    let result;
    // Failed until proven otherwise: a throw skips straight to `finally`.
    let status: "completed" | "failed" = "failed";
    let outcome: BrowserRunOutcome | undefined;
    try {
      result = await runBrowserTask(context, task, childEmit, {
        startUrl,
        signal,
        reportFields,
        resume,
        sentMedia,
        checkout,
        ...(note.length > 0 ? { resumeNote: note } : {}),
        ...(loginItemId != null ? { loginItemId } : {}),
      });
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

    if (result.stoppedBy === "needs-user") {
      // A "NEEDS USER:" line without browser_pause is the same stop, unstructured.
      if (result.pause == null)
        await checkout.hold(
          NEEDS_USER_PATTERN.exec(result.text)?.[1]?.trim() ?? ""
        );
    } else await checkout.finish(result.stoppedBy);
    const pause =
      result.stoppedBy === "needs-user" ? checkout.state.paused : null;
    detailsAsked =
      pause?.need === "details" && pause.site != null
        ? { afterSeq: context.userWords?.().at(-1)?.seq ?? 0 }
        : null;

    // A capped run's answer is partial; saying so makes the caller weigh it.
    const tail =
      result.stoppedBy === "needs-user"
        ? `\n\n${pause != null ? pauseReport(pause, checkout.state.stage, channel) : browserStopNote(channel)}`
        : result.stoppedBy === "turn-limit"
          ? "\n\n(The browser sub-agent hit its limit; anything above is partial.)"
          : result.stoppedBy === "timeout"
            ? "\n\n(The browser sub-agent ran out of time; anything above is partial.)"
            : "";
    // The user's words the run read and answered: the caller must know them too.
    const heard = (result.consumedMessageTexts ?? []).map(quotedUserWords);
    const heardNote =
      heard.length > 0
        ? `\n\n(While it worked, the user wrote: ${heard.map((text) => JSON.stringify(text)).join("; ")}. The run read ${heard.length > 1 ? "these" : "this"}.)`
        : "";
    // Said once it matters: the caller plans the rest of the task around it.
    const left = budget.left();
    const budgetNote =
      left <= 1
        ? `\n\n(${left === 1 ? "1 more new browser run" : "No more new browser runs"} can start until one of the last ${DISPATCH_LIMIT} is ${DISPATCH_WINDOW_MS / 60_000} minutes old; continuing this one does not count.)`
        : "";

    // What the run asked to send: the chat sends each id once, so the loop
    // sending it again adds nothing.
    const sent = sentMedia.list();
    const sentNote =
      sent.length > 0
        ? `\n\n(This run sent the user ${sent.join(", ")}. Do not send ${sent.length > 1 ? "them" : "it"} again.)`
        : "";

    return {
      content: [
        {
          type: "text" as const,
          text: `${result.text}${tail}${heardNote}${sentNote}${budgetNote}`,
        },
      ],
      details: {
        checkoutStage: checkout.state.stage,
        ...(pause != null && pause.need !== "user"
          ? { pause: { need: pause.need, mediaId: pause.mediaId } }
          : {}),
        turns: result.turns,
        executeCalls: result.executeCalls,
        steers: result.steers,
        stoppedBy: result.stoppedBy,
        ...(outcome != null ? { outcome } : {}),
        ...(result.consumedMessageIds != null
          ? { consumedMessageIds: result.consumedMessageIds }
          : {}),
      },
      isError: failed,
    };
  }
}
