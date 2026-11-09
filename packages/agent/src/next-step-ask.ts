/**
 * The next step (contract next-step.ts), asked for out loud: told only in the
 * tool's description, models skipped it on most results. So when a turn ends
 * on finished work, one hidden note inside the same send asks for the question
 * and its buttons, as `PromisedWork` does for a promise.
 */
const SUGGEST_TASKS_TOOL = "suggest_tasks";

export const NEXT_STEP_TYPE = "abacusai-bot:next-step";

export const NEXT_STEP_PROMPT = [
  "[App note, not from the user; never mention it.] The work above is done, so",
  "end on what comes next. Write one short, specific question naming the",
  "likeliest next step, in the user's language, without restating the result.",
  `Then call ${SUGGEST_TASKS_TOOL} with after_result: true and one or two tasks that`,
  "answer it. If this work would be useful again on a schedule and a routine can",
  "do it with what is connected today (anything that changes over time: orders,",
  "mail, a live site, a topic), make the second task a routine: true task, in",
  "words naming when it runs; never one that needs a connection that is missing.",
  "In a reply to a message from a chat app, write the question only. If the work",
  "did not really succeed, ask only what would unblock it, with no tool call.",
].join(" ");

/** Tools that make something the user keeps. */
const RESULT_TOOLS: ReadonlySet<string> = new Set([
  "write",
  "edit",
  "serve",
  "present_deliverable",
  "document",
  "ppt",
  "design",
]);

interface RunMessage {
  role?: unknown;
  stopReason?: unknown;
  content?: unknown;
}

interface RunBlock {
  type?: string;
  text?: string;
  name?: string;
  arguments?: { tasks?: unknown };
}

const blocksOf = (message: RunMessage): RunBlock[] =>
  Array.isArray(message.content) ? message.content : [];

const toolCalls = (messages: readonly unknown[]): RunBlock[] =>
  (messages as readonly RunMessage[])
    .filter((message) => message.role === "assistant")
    .flatMap(blocksOf)
    .filter((block) => block.type === "toolCall");

/** The run made something, closed cleanly, and asks the user nothing yet. */
export function endedOnResult(messages: readonly unknown[]): boolean {
  const last = (messages as readonly RunMessage[])
    .filter((message) => message.role === "assistant")
    .at(-1);
  if (last?.stopReason !== "stop") return false;
  const blocks = blocksOf(last);
  if (blocks.some((block) => block.type === "toolCall")) return false;
  const reply = blocks
    .map((block) => (block.type === "text" ? (block.text ?? "") : ""))
    .join("")
    .trim();
  const calls = toolCalls(messages);
  return (
    reply.length > 0 &&
    !/[?？؟]$/.test(reply) &&
    calls.some((call) => RESULT_TOOLS.has(call.name ?? "")) &&
    !calls.some((call) => call.name === SUGGEST_TASKS_TOOL)
  );
}

/** On for this session: the app said so at spawn, and the user has not passed over three in a row. */
export const nextStepAskOn = (): boolean =>
  process.env.ABACUSAI_BOT_NEXT_STEP_ASK === "1";

/**
 * One ask per send, and none on the send right after an ask left unanswered:
 * a tapped task is the user going on, so its result gets the next one.
 */
export class NextStepAsk {
  private turn = 0;
  private askedTurn: number | null = null;
  private offered: readonly string[] = [];
  private tapped = false;
  private spent = false;

  /** A new send, with the user's words. */
  begin(text: string): void {
    this.turn += 1;
    this.spent = false;
    // The message carries the app's notes too.
    this.tapped = this.offered.some((task) => text.includes(task));
  }

  /** Whether this send may ask, spending the ask if so. */
  claim(): boolean {
    const followsAsk =
      this.askedTurn != null && this.turn === this.askedTurn + 1;
    if (this.spent || (followsAsk && !this.tapped)) return false;
    this.spent = true;
    this.askedTurn = this.turn;
    return true;
  }

  /** The tasks the run ended on: a later send in those words is a tap. */
  sawRun(messages: readonly unknown[]): void {
    const tasks = toolCalls(messages)
      .filter((call) => call.name === SUGGEST_TASKS_TOOL)
      .at(-1)?.arguments?.tasks;
    if (!Array.isArray(tasks)) return;
    this.offered = tasks.flatMap((task: { text?: unknown }) =>
      typeof task?.text === "string" ? [task.text.trim()] : []
    );
  }
}
