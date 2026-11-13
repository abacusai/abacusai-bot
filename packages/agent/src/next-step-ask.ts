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
  "If the work uses placeholder or sample content, that step is putting the",
  "user's own in (their name, projects, real data).",
  `Then call ${SUGGEST_TASKS_TOOL} with after_result: true and one or two tasks that`,
  "answer it. If this work would be useful again on a schedule and a routine can",
  "do it with what is connected today (anything that changes over time: orders,",
  "mail, job ads, prices, a live site, a topic, a project's tests, its pull",
  "requests' reviews, a build), make the second task a routine: true task, in",
  "words naming when it runs; never one that needs a connection that is missing.",
  "In a reply to a message from a chat app, write the question only. If the work",
  "did not really succeed, ask only what would unblock it, with no tool call.",
].join(" ");

/**
 * The same ask when the reply already ends on its own question about what
 * comes next: only the buttons that answer it, so the question is tappable.
 */
const NEXT_STEP_BUTTONS_PROMPT = [
  "[App note, not from the user; never mention it.] Your reply ends on a question",
  "about what to do next. If one or two pieces of work you could start right away",
  `answer it, call ${SUGGEST_TASKS_TOOL} with after_result: true and those tasks, in the`,
  "user's language, and write nothing else. If it asks for something only the user",
  "can give (their name, a file, a choice you cannot guess), make no call and write",
  "nothing. In a reply to a message from a chat app, make no call and write nothing.",
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

/**
 * The note a run that made something and closed cleanly ends on: the full ask
 * when its reply asks nothing, the buttons alone when it ends on a question,
 * or null (no result, an unclean close, or a next step already offered).
 */
export function nextStepNote(messages: readonly unknown[]): string | null {
  const last = (messages as readonly RunMessage[])
    .filter((message) => message.role === "assistant")
    .at(-1);
  if (last?.stopReason !== "stop") return null;
  const blocks = blocksOf(last);
  if (blocks.some((block) => block.type === "toolCall")) return null;
  const reply = blocks
    .map((block) => (block.type === "text" ? (block.text ?? "") : ""))
    .join("")
    .trim();
  const calls = toolCalls(messages);
  if (
    reply.length === 0 ||
    !calls.some((call) => RESULT_TOOLS.has(call.name ?? "")) ||
    calls.some((call) => call.name === SUGGEST_TASKS_TOOL)
  )
    return null;
  return /[?？؟]$/.test(reply) ? NEXT_STEP_BUTTONS_PROMPT : NEXT_STEP_PROMPT;
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

  /** The note the last successful claim sends. */
  note: string = NEXT_STEP_PROMPT;

  /** Whether the run `messages` ends on a next step in this send, spending the ask if so. */
  claim(messages: readonly unknown[]): boolean {
    const note = nextStepNote(messages);
    if (note == null) return false;
    const followsAsk =
      this.askedTurn != null && this.turn === this.askedTurn + 1;
    if (this.spent || (followsAsk && !this.tapped)) return false;
    this.spent = true;
    this.askedTurn = this.turn;
    this.note = note;
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
