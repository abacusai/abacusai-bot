/**
 * A first look before a long build. A new user's first big ask used to run for
 * half an hour or more and end in a long report, sometimes on the wrong thing,
 * and they left without writing again. So in their first days (the app says so
 * at spawn), the chat's first big ask carries one hidden note: build the
 * smallest piece they can see, show it, and ask one question about the
 * direction. The answer that follows carries on to the full build.
 *
 * Whether a message is a big ask is the model's call: the note says what is
 * not one, and a run that made nothing leaves it for the next message.
 */
import {
  calledTools,
  RESULT_TOOLS,
  SUGGEST_TASKS_TOOL,
} from "./next-step-ask.js";

/** Marks the note in the session log as the app's rather than the user's. */
export const FIRST_LOOK_TYPE = "abacusai-bot:first-look";

export const FIRST_LOOK_PROMPT = [
  "[App note, not from the user; never mention it.] This user is new here. If",
  "the user's message asks for work that will plainly take more than a few",
  "minutes or many files or steps (a game feature, a website, a set of",
  "printable pages, a list of leads), do not build it all in this turn.",
  "First make the smallest version they can see, within a few minutes, from",
  "what they gave you (their files, their project, their words): a running",
  "preview or a screenshot, the first page, the first rows. Show it, say in one",
  "or two lines what it shows and what comes next with a rough time, and ask",
  `one question about the direction. Then call ${SUGGEST_TASKS_TOOL}, without after_result,`,
  "with two or three short answers in the user's language (going on as it is,",
  "one likely change), and end the turn. If the request is unclear in a way a first look",
  "cannot settle, ask that one question instead and build nothing yet. If the",
  "message is a question, a quick task, or anything a few minutes cover, ignore",
  "this note and answer as usual.",
].join(" ");

/** On the answer to a first look: no second check before the full build. */
export const FIRST_LOOK_GO_ON_PROMPT = [
  "[App note, not from the user; never mention it.] If your last reply was a",
  "first look and the user's message answers it, build the rest now with what",
  "they said, in this turn, without stopping to check the direction again.",
].join(" ");

/** On for this session: the app said so at spawn (a new user's own chat). */
export const firstLookOn = (): boolean =>
  process.env.ABACUSAI_BOT_FIRST_LOOK === "1";

/**
 * The note for each send of a chat, at most one first look per chat. The
 * chat's first result spends it, with or without a first look; a first look
 * is a result whose send carried the note and ended on tasks to tap.
 */
export class FirstLook {
  private spent = false;
  private carried = false;
  private made = false;
  private offered = false;
  private looked = false;

  /** A resumed chat that already made something has had its first look. */
  seed(history: readonly unknown[]): void {
    if (calledTools(history).some((name) => RESULT_TOOLS.has(name)))
      this.spent = true;
  }

  /** A new send with the user's own words ("" for the app's): the note it carries, if any. */
  begin(words: string): string | null {
    this.carried = false;
    this.made = false;
    this.offered = false;
    // A turn the app started (a connection came up) is not the answer.
    if (words.trim().length === 0) return null;
    const answered = this.looked;
    this.looked = false;
    if (answered) return FIRST_LOOK_GO_ON_PROMPT;
    if (this.spent) return null;
    this.carried = true;
    return FIRST_LOOK_PROMPT;
  }

  /** Each run of the send, as it ends. */
  sawRun(messages: readonly unknown[]): void {
    const names = calledTools(messages);
    this.made ||= names.some((name) => RESULT_TOOLS.has(name));
    this.offered ||= names.includes(SUGGEST_TASKS_TOOL);
    if (this.made) this.spent = true;
    if (this.carried) this.looked = this.made && this.offered;
  }

  /** The send ended on a first look: the user's answer is what goes on, not a promise to judge. */
  waitsOnAnswer(): boolean {
    return this.carried && this.looked;
  }
}
