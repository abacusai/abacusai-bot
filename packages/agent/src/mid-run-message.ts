/**
 * A message the user sends while a run works (a steer) is answered at once.
 * The request that carries it also carries a note, unseen by the user, to
 * reply to it in one line before the next tool call; without it a cheap model
 * folds the message in silently or misses it, and a user who asked "is it
 * nearly done?" or changed the request sees nothing and presses Stop.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const MID_RUN_MESSAGE_NOTE =
  "The user wrote the message above while you were working. Before your next tool call, reply to it in one " +
  "short line in their language: answer a question (where the work stands, how long is left), or say how you " +
  "take a change in, now or right after the step you are on. Then carry on with the work, changed if they asked.";

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

/** The engine's mid-run messages awaiting the model's first answer to them. */
export class MidRunMessages {
  private readonly waiting = new Set<string>();
  /** Those already sent to the model with the note: done once it replies. */
  private readonly shown = new Set<string>();

  /** A message the user sent mid-run; never an answer to the model's own question. */
  note(text: string): void {
    this.waiting.add(text);
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
        content: [{ type: "text", text: MID_RUN_MESSAGE_NOTE }],
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
