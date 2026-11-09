/**
 * A turn that ends on a promise. Cheap models close a reply with "Reading them
 * now." or "Devam ediyorum." and make no tool call, so the run ends and nothing
 * happens until the user nudges it. One policy for both loops (session.ts,
 * forever/engine.ts): the model is told once, out of sight, to do it now.
 *
 * Whether a reply is narration mid-task or a finished answer is a question of
 * meaning, in any language, so one small model call judges it once the reply
 * has gone out (a chat app gets it as `turn_answer`). Any failure, or a Stop,
 * reads as "not a promise": no nudge, as before.
 */

import { abacusV1BaseUrl } from "./abacus-endpoint.js";
import { liveBackgroundJobCount } from "./background-processes.js";
import { creditWallActive } from "./credit-wall.js";
import { budgetStopReason } from "./extensions/budgets.js";
import { isOwnerAudience } from "./owner-tools.js";
import { AgentMode } from "./protocol.js";
import { ownWords } from "./user-text.js";

/** Extra calls a turn may spend on a promise. Reset only by a new user send. */
export const PROMISED_WORK_RECOVERIES = 1;

/** Marks the continuation in the session log as ours rather than the user's. */
export const PROMISED_WORK_TYPE = "abacusai-bot:promised-work";

export const PROMISED_WORK_PROMPT =
  "This message comes from the app, not the user. Your last message said you would carry on, but it " +
  "called no tool, so nothing ran and the turn was about to end. Do that work now, starting with a " +
  "tool call. Do not repeat what you said or apologize. If it needs something only the user can " +
  "give, or there is nothing left to do, say that plainly in one or two sentences, in the user's " +
  "language. If your message asked the user something or gave them steps to do, that is your " +
  "answer: say in one short line that you are waiting for them.";

/** The cheap model the free plan runs on; pinned, as the judge's error rates were measured on it. */
export const TURN_END_JUDGE_MODEL = "deepseek-ai/DeepSeek-V4.1-Flash";
const JUDGE_TIMEOUT_MS = 3_000;
const JUDGE_ASK_CHARS = 400;
const JUDGE_REPLY_CHARS = 1_500;

/** How a reply with no tool call ended: going on now, promising something later, or anything else. */
export type TurnEnding = "now" | "later" | "other";

export interface TurnEnd {
  /** The user's message this turn answers. */
  ask: string;
  /** The run's last message, as text. */
  reply: string;
  /** The run called a tool before it, so it is mid-task. */
  ranTools: boolean;
}

/** The prompt fences the reply in these; the reply's own copies are dropped. */
const unfenced = (text: string): string => text.replace(/<<<|>>>/g, "");

/** The judge's answer counts only as a lone letter: "Answer: B" or "A finished…" is no answer. */
const LONE_LETTER = /^\W*([ABC])\W*$/i;

const judgePrompt = ({ ask, reply, ranTools }: TurnEnd): string =>
  [
    "An assistant's turn just ended. Its last message is below. It made no tool call, so nothing more runs until the user writes again.",
    'Answer A if the message ends by saying it is doing, or about to do, more work right now ("Now I\'ll fix the tests.", "Continuing with the docs.", "Let me check the logs:", a list of remaining steps it says it is starting), and asks nothing of the user.',
    'Answer C if instead it promises to do something itself later or when something happens ("I\'ll report back when it finishes", "I\'ll check again tomorrow"), with nothing needed from the user.',
    "Answer B for anything else: a finished answer or report, a question or an offer to the user, waiting for the user's go-ahead, or a refusal.",
    "Answer with one letter only.",
    "",
    `The user asked: ${unfenced(ownWords(ask)).trim().slice(0, JUDGE_ASK_CHARS)}`,
    "",
    `The assistant ${ranTools ? "used" : "did not use"} tools this turn. Its last message (end):`,
    "<<<",
    unfenced(reply).slice(-JUDGE_REPLY_CHARS),
    ">>>",
  ].join("\n");

/**
 * How a turn ended, from one small model call on the user's key. Never throws:
 * no key, a timeout, `signal` aborting, an error or an answer it cannot read
 * is "other".
 */
export async function judgeTurnEnd(
  turn: TurnEnd,
  apiKey: string = (process.env.ABACUS_API_KEY ?? "").trim(),
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal
): Promise<TurnEnding> {
  if (apiKey.length === 0 || turn.reply.trim().length === 0) return "other";
  if (signal?.aborted === true) return "other";
  try {
    const response = await fetchImpl(`${abacusV1BaseUrl()}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: TURN_END_JUDGE_MODEL,
        messages: [{ role: "user", content: judgePrompt(turn) }],
        max_tokens: 5,
        temperature: 0,
      }),
      signal:
        signal == null
          ? AbortSignal.timeout(JUDGE_TIMEOUT_MS)
          : AbortSignal.any([AbortSignal.timeout(JUDGE_TIMEOUT_MS), signal]),
    });
    if (!response.ok) return "other";
    const body = (await response.json()) as {
      choices?: Array<{ message?: { content?: unknown } }>;
    };
    const answer = body.choices?.[0]?.message?.content;
    const letter =
      typeof answer === "string"
        ? (LONE_LETTER.exec(answer)?.[1]?.toUpperCase() ?? "")
        : "";
    return letter === "A" ? "now" : letter === "C" ? "later" : "other";
  } catch {
    return "other";
  }
}

interface RunMessage {
  role?: unknown;
  stopReason?: unknown;
  content?: unknown;
}

/** Cards the user answers: work has not begun, whatever words follow them. */
const OFFER_TOOLS: ReadonlySet<string> = new Set([
  "suggest_tasks",
  "connect_connector",
]);

const blocksOf = (
  message: RunMessage
): { type?: string; text?: string; name?: string }[] =>
  Array.isArray(message.content) ? message.content : [];

/**
 * The run's ending for the judge, or null when there is nothing to judge. A
 * reply cut off, stopped or failed has its own handling, and a tool call in
 * the message means the work is under way. A closing code block is output.
 */
export function turnEndOf(
  messages: readonly unknown[],
  ask: string
): TurnEnd | null {
  const said = (messages as readonly RunMessage[]).filter(
    (message) => message.role === "assistant"
  );
  const last = said.at(-1);
  if (last?.stopReason !== "stop") return null;
  const blocks = blocksOf(last);
  if (blocks.some((block) => block.type === "toolCall")) return null;
  const reply = blocks
    .map((block) => (block.type === "text" ? (block.text ?? "") : ""))
    .join("")
    .replace(/<\/?reply>/gi, "")
    .trim();
  if (reply.length === 0 || reply.endsWith("```")) return null;
  const ranTools = said.some((message) =>
    blocksOf(message).some(
      (block) => block.type === "toolCall" && !OFFER_TOOLS.has(block.name ?? "")
    )
  );
  return { ask, reply, ranTools };
}

/**
 * Whether anyone is waiting on this run to go on. Only the user's own chats
 * (a routine's closing summary is its last word; a contact's "I'll check" is
 * an answer) and only where the model may act. A run closing out on a budget,
 * or at the credit wall, is meant to stop. A job still running in the
 * background wakes the run itself when it settles.
 */
export const mayAskForPromisedWork = (mode: AgentMode): boolean =>
  isOwnerAudience() &&
  mode !== AgentMode.PlanMode &&
  mode !== AgentMode.Unattended &&
  budgetStopReason() == null &&
  !creditWallActive() &&
  liveBackgroundJobCount() === 0;

/**
 * The ask, spent per user send (nothing but `begin` gives it back), and the
 * judging of the run that may spend it.
 */
export class PromisedWork {
  private spent = 0;
  private ask = "";
  private judging: Promise<TurnEnding> | null = null;
  private abort: AbortController | null = null;

  /** A new turn, answering `ask`. */
  begin(ask = ""): void {
    this.spent = 0;
    this.ask = ask;
    this.drop();
  }

  /** Starts judging a run's ending; false when there is none to judge or the ask is spent. */
  judge(messages: readonly unknown[]): boolean {
    if (this.spent >= PROMISED_WORK_RECOVERIES) return false;
    const turn = turnEndOf(messages, this.ask);
    if (turn == null) return false;
    this.abort = new AbortController();
    this.judging = judgeTurnEnd(turn, undefined, undefined, this.abort.signal);
    return true;
  }

  /** The verdict on the run being judged; "now" spends the ask. */
  async verdict(): Promise<TurnEnding> {
    const judging = this.judging;
    this.judging = null;
    // The controller stays until the verdict is in, so a Stop meanwhile cuts the call.
    const ending = judging == null ? "other" : await judging;
    this.abort = null;
    if (ending === "later")
      // Logged, not steered: a later promise needs its own structural test first.
      console.error("[promised-work] reply promised later work; not steered");
    if (ending !== "now" || this.spent >= PROMISED_WORK_RECOVERIES)
      return ending === "now" ? "other" : ending;
    this.spent += 1;
    return "now";
  }

  /** Stop: the call is cut off, so a pending verdict settles at once as "other". */
  drop(): void {
    this.abort?.abort();
    this.abort = null;
    this.judging = null;
  }
}
