/**
 * Reasoning a model leaks into its text as `<think>…</think>`. Providers that
 * report reasoning in its own field never reach this; it is the fallback for
 * models that write the block inline. A block counts only before any visible
 * text, where models emit it: the same tag mid-reply or in code is the reply.
 * A streaming state machine, because the UI renders deltas as they arrive.
 * No imports: the renderer and the chat-app lanes use it too.
 */

const OPEN_TAGS = ["<think>", "<thinking>", "<reasoning>"] as const;
const CLOSE_TAGS: Record<string, string> = {
  "<think>": "</think>",
  "<thinking>": "</thinking>",
  "<reasoning>": "</reasoning>",
};

export interface ReasoningSplit {
  text: string;
  thinking: string;
}

export class ReasoningSplitter {
  /** Before any visible text, inside a leading block, or past both. */
  private phase: "lead" | "block" | "text" = "lead";
  /** Unemitted input: leading whitespace, or what may start a tag. */
  private held = "";
  /** The open block's tag as written and its reasoning so far, kept to undo it. */
  private openTag = "";
  private block = "";
  private closing = "";
  private sawBlock = false;

  push(delta: string): ReasoningSplit {
    let buffer = this.held + delta;
    let text = "";
    let thinking = "";

    this.held = "";

    for (;;) {
      if (this.phase === "text") {
        text += buffer;
        break;
      }

      if (this.phase === "lead") {
        const rest = buffer.trimStart();
        const lowered = rest.toLowerCase();
        const tag = OPEN_TAGS.find((each) => lowered.startsWith(each));

        if (tag != null) {
          this.phase = "block";
          this.openTag = rest.slice(0, tag.length);
          this.closing = CLOSE_TAGS[tag] ?? "";
          this.block = "";
          buffer = rest.slice(tag.length);
          continue;
        }

        if (OPEN_TAGS.some((each) => each.startsWith(lowered))) {
          this.held = buffer;
          break;
        }

        // Whitespace that only separated a block from the reply is dropped.
        this.phase = "text";
        text += this.sawBlock ? rest : buffer;
        break;
      }

      const index = buffer.toLowerCase().indexOf(this.closing);

      if (index < 0) {
        const keep = holdback(buffer, this.closing.length - 1);
        const reasoning = buffer.slice(0, buffer.length - keep);

        thinking += reasoning;
        this.block += reasoning;
        this.held = buffer.slice(buffer.length - keep);
        break;
      }

      thinking += buffer.slice(0, index);
      buffer = buffer.slice(index + this.closing.length);
      this.phase = "lead";
      this.sawBlock = true;
    }

    return { text, thinking };
  }

  /**
   * End of message. A leading block never closed was not reasoning after all
   * (or was cut off): it comes back as text rather than eat the whole reply.
   */
  flush(): ReasoningSplit {
    const out: ReasoningSplit =
      this.phase === "block"
        ? { text: this.openTag + this.block + this.held, thinking: "" }
        : {
            text: this.sawBlock ? this.held.trimStart() : this.held,
            thinking: "",
          };

    this.reset();
    return out;
  }

  /** Fresh message, fresh state: an unclosed tag must not leak across. */
  reset(): void {
    this.phase = "lead";
    this.held = "";
    this.openTag = "";
    this.block = "";
    this.closing = "";
    this.sawBlock = false;
  }
}

/** A finished message split into its leading reasoning and its reply. */
export function splitReasoning(message: string): ReasoningSplit {
  const splitter = new ReasoningSplitter();
  const head = splitter.push(message);
  const tail = splitter.flush();

  return { text: head.text + tail.text, thinking: head.thinking };
}

/** How much of the tail might be the start of the close tag. */
function holdback(buffer: string, max: number): number {
  const from = Math.max(0, buffer.length - max);
  const at = buffer.indexOf("<", from);

  return at < 0 ? 0 : buffer.length - at;
}
