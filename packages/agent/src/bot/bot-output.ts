/**
 * Making cheap-model output presentable as it streams. Bots run on cheap
 * models, some of which leak `<think>…</think>` reasoning or role prefixes
 * into visible text. A streaming state machine rather than a regex over the
 * final text, because the UI renders deltas live and would show the block
 * before a regex could run. Reasoning is rerouted to the thinking channel.
 */

const OPEN_TAGS = ["<think>", "<thinking>", "<reasoning>"] as const;
const CLOSE_TAGS: Record<string, string> = {
  "<think>": "</think>",
  "<thinking>": "</thinking>",
  "<reasoning>": "</reasoning>",
};

/** Longest tag we might be holding back a prefix of. */
const MAX_TAG = Math.max(
  ...OPEN_TAGS.map((tag) => tag.length),
  ...Object.values(CLOSE_TAGS).map((tag) => tag.length)
);

export interface SanitizedDelta {
  text: string;
  thinking: string;
}

export class BotOutputSanitizer {
  /** Unemitted tail that might be the start of a tag. */
  private held = "";
  /** The close tag we are looking for, or null outside a reasoning span. */
  private closing: string | null = null;

  push(delta: string): SanitizedDelta {
    let buffer = this.held + delta;
    this.held = "";

    let text = "";
    let thinking = "";

    for (;;) {
      if (this.closing == null) {
        const found = this.findTag(buffer, OPEN_TAGS);

        if (found == null) {
          const keep = this.holdbackLength(buffer);

          text += buffer.slice(0, buffer.length - keep);
          this.held = buffer.slice(buffer.length - keep);
          break;
        }

        text += buffer.slice(0, found.index);
        buffer = buffer.slice(found.index + found.tag.length);
        this.closing = CLOSE_TAGS[found.tag] ?? null;
      } else {
        const close = this.closing;
        const index = buffer.toLowerCase().indexOf(close);

        if (index < 0) {
          const keep = this.holdbackLength(buffer);

          thinking += buffer.slice(0, buffer.length - keep);
          this.held = buffer.slice(buffer.length - keep);
          break;
        }

        thinking += buffer.slice(0, index);
        buffer = buffer.slice(index + close.length);
        this.closing = null;
      }
    }

    return { text, thinking };
  }

  /** End of message: whatever is held is real text (or trailing reasoning). */
  flush(): SanitizedDelta {
    const held = this.held;

    this.held = "";

    if (held.length === 0) return { text: "", thinking: "" };

    return this.closing != null
      ? { text: "", thinking: held }
      : { text: held, thinking: "" };
  }

  /** Fresh message, fresh state: an unclosed tag must not leak across. */
  reset(): void {
    this.held = "";
    this.closing = null;
  }

  private findTag(
    buffer: string,
    tags: readonly string[]
  ): { index: number; tag: string } | null {
    const lowered = buffer.toLowerCase();
    let best: { index: number; tag: string } | null = null;

    for (const tag of tags) {
      const index = lowered.indexOf(tag);

      if (index >= 0 && (best == null || index < best.index))
        best = { index, tag };
    }

    return best;
  }

  private holdbackLength(buffer: string): number {
    const max = Math.min(MAX_TAG - 1, buffer.length);

    for (let keep = max; keep > 0; keep--) {
      const tail = buffer.slice(buffer.length - keep).toLowerCase();

      if (tail.startsWith("<")) return keep;
    }

    return 0;
  }
}

/** Final pass on a complete message: collapse padding, drop a leaked role label. */
export function tidyBotText(text: string): string {
  return text
    .replace(/^\s*(assistant|ai)\s*:\s*/i, "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+$/gm, "");
}
