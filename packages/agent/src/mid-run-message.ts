/**
 * A message the user sends while a run works (a steer) is answered at once.
 * The request that carries it also carries a note, unseen by the user, to
 * reply to it in one line before the next tool call; without it a cheap model
 * folds the message in silently or misses it, and a user who asked how far it
 * has got, or changed the request, sees nothing and presses Stop.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * The note. `tool` is the chat's progress tool where a line written mid-run
 * reaches the user only through one (a chat app's send_progress).
 */
export const midRunMessageNote = (tool?: string): string =>
  "The user wrote the message above while you were working. Before your next tool call, reply to it in one " +
  `short line${tool != null ? ` with ${tool}` : ""}, in the language that message is written in: answer a question ` +
  "(where the work stands, how long is left), or say how you take a change in, now or right after the step " +
  "you are on. If they ask you to stop or cancel, do not carry on: say in that line that you stopped, and " +
  "make no more tool calls. Otherwise the work goes on: write that line and your next tool call together in " +
  "this one message, changed if they asked, and do not end your turn on the line alone.";

type Message = { role?: string; content?: unknown };

const textOf = (message: Message): string =>
  typeof message.content === "string"
    ? message.content
    : Array.isArray(message.content)
      ? message.content
          .map((block: { type?: string; text?: string }) =>
            block.type === "text" ? (block.text ?? "") : ""
          )
          .join("")
      : "";

export interface MidRunMessagesOptions {
  /** The chat's progress tools, first one first; none on the desktop's own chat. */
  progressTools?: () => readonly string[] | undefined;
  /**
   * Whether a line written mid-run reaches no one: a bot's chat with a remote
   * sender, which hears only the turn's reply. No note is added there.
   */
  unheard?: () => boolean;
}

/** The engine's mid-run messages awaiting the model's first answer to them. */
export class MidRunMessages {
  private readonly waiting = new Set<string>();
  /** Those already sent to the model with the note: done once it replies. */
  private readonly shown = new Set<string>();

  constructor(private readonly options: MidRunMessagesOptions = {}) {}

  /** A message the user sent mid-run; never an answer to the model's own question. */
  note(text: string): void {
    if (this.options.unheard?.() === true) return;
    this.waiting.add(text);
  }

  /**
   * Nothing is waiting any more: the steers were dropped (the message runs as
   * its own turn instead) or a new turn of the user's starts.
   */
  clear(): void {
    this.waiting.clear();
    this.shown.clear();
  }

  readonly extension = (pi: ExtensionAPI): void => {
    pi.on("context", (event) => {
      const messages = event.messages as unknown as Message[];
      const last = messages.at(-1);
      const text = last?.role === "user" ? textOf(last) : null;
      if (text == null || !this.waiting.has(text)) return;
      this.shown.add(text);
      const note = {
        role: "user",
        content: [
          {
            type: "text",
            text: midRunMessageNote(this.options.progressTools?.()?.[0]),
          },
        ],
        timestamp: Date.now(),
      };
      return {
        messages: [...messages, note] as unknown as typeof event.messages,
      };
    });
    // Seen once the model has replied to a request that carried it; one
    // steered while that reply was being written waits for the next.
    pi.on("message_end", (event) => {
      if ((event.message as Message).role !== "assistant") return;
      for (const text of this.shown) this.waiting.delete(text);
      this.shown.clear();
    });
  };
}
