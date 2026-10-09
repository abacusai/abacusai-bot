/**
 * The bounded run every sub-agent shares: a turn budget the model is told
 * about and warned against, and a closing report when the budget runs out.
 * A run cut off mid-exploration hands its parent a half answer, and the
 * parent redoes the work; a run told to wrap up keeps what it found.
 */
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

import { whenAborted } from "./subagent-abort.js";
import { type ChildToolForwarder, traceChildEvent } from "./subagent-events.js";

/** Turn ceiling and the two warnings before it. */
export interface TurnPolicy {
  max: number;
  wrapUp: number;
  finalWarning: number;
}

export const SUBAGENT_TURNS: TurnPolicy = {
  max: 100,
  wrapUp: 60,
  finalWarning: 85,
};

/**
 * Provider retries tolerated before giving up. Nobody is watching a sub-agent,
 * so pi's retries would burn the parent's call until the wall-clock stop.
 */
export const MAX_PROVIDER_RETRIES = 2;

/**
 * How long the tools-off closing turn may take. Carved out of a run's own
 * time limit, not added to it, so a run never outlasts its tool's timeout.
 */
export const CLOSING_TIMEOUT_MS = 90 * 1000;

// Each message says how many turns remain: "close to your limit" reads as
// "out of budget" to a small model, which then reports at once.
export const wrapUpMessage = (turnsLeft: number): string =>
  `You have about ${turnsLeft} turns left. Stop exploring now and write your final report ` +
  "from what you have already seen: the concrete values, and plainly what you could not finish.";
export const finalWarningMessage = (turnsLeft: number): string =>
  `${turnsLeft} turns left. Write the final report in your next message; do not start anything new.`;
export const budgetNote = (turns: number): string =>
  `(Budget: ${turns} tool turns for this run; you will be warned as it runs low.)`;
export const CLOSING_MESSAGE =
  "Your budget is spent and your tools are now off. Write your final report in this message: " +
  "what you found or made, with the concrete files, identifiers and values, and plainly what is unfinished.";

/** How the warnings are worded: what "wrapping up" means depends on the job. */
export interface BudgetVoice {
  wrapUp(turnsLeft: number): string;
  finalWarning(turnsLeft: number): string;
}

/** For a run whose product is its report: research, a browser job. */
export const REPORT_VOICE: BudgetVoice = {
  wrapUp: wrapUpMessage,
  finalWarning: finalWarningMessage,
};

/**
 * For a run whose product is a file. "Stop and report" would abandon a half-
 * built deck; what it must do is finish and print what it has, because an
 * unprinted draft is lost when the budget runs out.
 */
export const makerVoice = (finishTool: string): BudgetVoice => ({
  wrapUp: (turnsLeft) =>
    `You have about ${turnsLeft} turns left. Do not start new parts: finish the ones in ` +
    `progress, then call ${finishTool} so the file exists, and report what you made.`,
  finalWarning: (turnsLeft) =>
    `${turnsLeft} turns left. Call ${finishTool} now with what you have; a draft that ` +
    "is never rendered is lost when the budget runs out.",
});

export type BudgetStep =
  | { kind: "continue" }
  | { kind: "steer"; reason: "wrap-up" | "final"; text: string }
  | { kind: "exhausted" };

/** Counts model calls and says when to warn and when to stop. */
export class TurnBudget {
  #turns = 0;
  #wrappedUp = false;
  #finalWarned = false;

  constructor(
    readonly policy: TurnPolicy = SUBAGENT_TURNS,
    readonly voice: BudgetVoice = REPORT_VOICE
  ) {}

  get turns(): number {
    return this.#turns;
  }

  /** The line an opening prompt carries, so the warnings are expected. */
  note(): string {
    return budgetNote(this.policy.max);
  }

  /** One model call ended (`turn_end`). */
  endTurn(): BudgetStep {
    this.#turns += 1;
    if (this.#turns >= this.policy.max) return { kind: "exhausted" };
    if (!this.#finalWarned && this.#turns >= this.policy.finalWarning) {
      // The final warning supersedes a wrap-up not yet sent.
      this.#finalWarned = true;
      this.#wrappedUp = true;
      return {
        kind: "steer",
        reason: "final",
        text: this.voice.finalWarning(this.policy.max - this.#turns),
      };
    }
    if (!this.#wrappedUp && this.#turns >= this.policy.wrapUp)
      return this.wrapUp() ?? { kind: "continue" };
    return { kind: "continue" };
  }

  /** Ask for the report early (a run that has read too much); once per run. */
  wrapUp(): BudgetStep | null {
    if (this.#wrappedUp) return null;
    this.#wrappedUp = true;
    return {
      kind: "steer",
      reason: "wrap-up",
      text: this.voice.wrapUp(this.policy.max - this.#turns),
    };
  }
}

/** What a sub-agent session must offer to be run and closed out. */
export interface SubagentSession {
  subscribe(listener: (event: AgentSessionEvent) => void): () => void;
  prompt(text: string): Promise<void>;
  steer(text: string): Promise<void>;
  abort(): Promise<void>;
  clearQueue(): unknown;
  setActiveToolsByName(names: string[]): void;
}

/**
 * Stop the run and ask for its report with every tool off, so the only thing
 * the model can do is write. Exactly one model call: a model that still
 * reaches for a tool would otherwise loop on "tool not found". Returns that
 * report, or "" when none came.
 */
export async function closeOut(
  session: SubagentSession,
  signal?: AbortSignal,
  timeoutMs = CLOSING_TIMEOUT_MS
): Promise<string> {
  if (signal?.aborted || timeoutMs <= 0) return "";
  // abort() waits for idle; a queued warning would otherwise land after.
  await session.abort();
  session.clearQueue();
  session.setActiveToolsByName([]);

  let report = "";
  let ended!: () => void;
  const oneTurn = new Promise<void>((resolve) => {
    ended = resolve;
  });
  const unsubscribe = session.subscribe((event) => {
    const text = assistantText(event);
    if (text != null) report = text;
    if (event.type === "turn_end" || event.type === "agent_end") ended();
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const abort = whenAborted(signal, () => undefined);

  try {
    await Promise.race([
      oneTurn,
      session.prompt(CLOSING_MESSAGE).catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
      abort.aborted,
    ]);
  } finally {
    if (timer != null) clearTimeout(timer);
    abort.dispose();
    unsubscribe();
    // However the turn ended, nothing runs after it.
    await session.abort().catch(() => undefined);
  }

  return report;
}

export type SubagentStop =
  | "completed"
  | "error"
  | "provider-error"
  | "turn-limit"
  | "timeout"
  | "aborted";

export interface SubagentRunOptions {
  /** Trace tag for the child's events. */
  tag: string;
  forwardTools: ChildToolForwarder;
  /** The whole run, closing turn included: match the tool's own timeout. */
  timeoutMs: number;
  signal?: AbortSignal;
  policy?: TurnPolicy;
  voice?: BudgetVoice;
  /** Checked as each prompt ends: the job is done, so stop the run there. */
  isDone?: () => boolean;
}

export interface SubagentRunResult {
  stoppedBy: SubagentStop;
  turns: number;
  /** The last thing the model wrote; on a run out of budget, its closing report. */
  text: string;
  /** True when `text` is a closing report written after the budget ran out. */
  closedOut: boolean;
  providerError: string;
}

/**
 * Prompt a sub-agent and run it to an answer within its budget. Never throws
 * for the model's failures; the caller frames `stoppedBy` for its parent.
 */
export async function runSubagent(
  session: SubagentSession,
  prompt: string,
  options: SubagentRunOptions
): Promise<SubagentRunResult> {
  const budget = new TurnBudget(options.policy, options.voice);
  let lastText = "";
  let retries = 0;
  let providerError = "";
  // On an object: assignments happen in callbacks control-flow analysis
  // cannot see, so a local would be narrowed to its initial value.
  const outcome: { stoppedBy: SubagentStop } = { stoppedBy: "completed" };

  let finish!: () => void;
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const stop = (stoppedBy: SubagentStop): void => {
    outcome.stoppedBy = stoppedBy;
    unsubscribe();
    finish();
  };

  const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
    traceChildEvent(options.tag, event);

    // The child's tool calls, so its card shows the work.
    if (options.forwardTools(event)) return;

    // A provider failure is stamped on the assistant message; no update
    // fires for a call that fails outright.
    if (event.type === "message_end") {
      const message = (
        event as { message?: { stopReason?: unknown; errorMessage?: unknown } }
      ).message;
      if (
        message?.stopReason === "error" &&
        typeof message.errorMessage === "string"
      )
        providerError = message.errorMessage;
      // Kept per message, so a run cut off still hands back its last words.
      const text = assistantText(event);
      if (text != null) lastText = text;
    }

    // `turn_end` is one model call; `agent_end` fires once per prompt
    // however many tools run, so a ceiling there could never trip.
    if (event.type === "turn_end") {
      const step = budget.endTurn();
      if (step.kind === "exhausted") return stop("turn-limit");
      if (step.kind === "steer")
        void session.steer(step.text).catch(() => undefined);
    }

    if (event.type === "agent_end") {
      // A retry left alone repeats until the wall-clock stop.
      if ((event as { willRetry?: boolean }).willRetry === true) {
        retries += 1;
        if (retries > MAX_PROVIDER_RETRIES) stop("provider-error");
        return;
      }
      if (options.isDone?.() === true) return stop("completed");
    }

    if (event.type === "agent_settled") stop(outcome.stoppedBy);
  });

  // NOT awaited: `finished` carries the run's end out.
  void session.prompt(`${prompt}\n\n${budget.note()}`).catch((error) => {
    providerError = error instanceof Error ? error.message : String(error);
    stop("error");
  });

  const deadline = Date.now() + options.timeoutMs;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(
      () => {
        outcome.stoppedBy = "timeout";
        resolve();
      },
      // The closing turn's time is held back, never more than half the run.
      Math.max(options.timeoutMs - CLOSING_TIMEOUT_MS, options.timeoutMs / 2)
    );
  });
  // Removed in the finally: the signal outlives this call.
  const abort = whenAborted(options.signal, () => {
    outcome.stoppedBy = "aborted";
  });

  try {
    await Promise.race([finished, timeout, abort.aborted]);
  } finally {
    if (timer != null) clearTimeout(timer);
    abort.dispose();
    unsubscribe();
  }

  let closedOut = false;
  if (outcome.stoppedBy === "turn-limit" || outcome.stoppedBy === "timeout") {
    const report = await closeOut(
      session,
      options.signal,
      Math.min(CLOSING_TIMEOUT_MS, Math.max(0, deadline - Date.now()))
    );
    if (report.trim().length > 0) {
      lastText = report;
      closedOut = true;
    }
  }

  return {
    stoppedBy: outcome.stoppedBy,
    turns: budget.turns,
    text: lastText,
    closedOut,
    providerError,
  };
}

/** An assistant message's text at `message_end`, or null for anything else. */
function assistantText(event: AgentSessionEvent): string | null {
  if (event.type !== "message_end") return null;
  const message = (event as { message?: { role?: string; content?: unknown } })
    .message;
  if (message?.role !== "assistant") return null;
  const text = extractText(message.content);
  return text.trim().length > 0 ? text : null;
}

/** Message content is a string or a list of blocks, depending on the provider. */
export function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) =>
      block != null &&
      typeof block === "object" &&
      (block as { type?: unknown }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string"
        ? (block as { text: string }).text
        : ""
    )
    .join("");
}
