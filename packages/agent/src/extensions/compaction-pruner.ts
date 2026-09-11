/**
 * Tool-result pruning at compaction time: before the summarizer reads the
 * history, oversized tool results become a one-line placeholder naming the
 * tool and size. Short results, truncated errors, spill ids and images stay.
 * `preparation.fileOps` is computed before this runs, so the record of what
 * changed on disk does not depend on the text dropped here.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Tool results longer than this are replaced. Shorter ones ride along free. */
const PRUNE_OVER_CHARS = 2_000;

/** How much of a failing result to keep. Errors are worth their tokens. */
const ERROR_KEEP_CHARS = 1_200;

/** Matches the saved-output id the spill extension puts in its notice. */
const SPILL_ID_RE = /\b(out-\d+)\b/;

interface TextBlock {
  type: "text";
  text: string;
}

function isTextBlock(block: unknown): block is TextBlock {
  return (
    typeof block === "object" &&
    block !== null &&
    (block as { type?: unknown }).type === "text" &&
    typeof (block as { text?: unknown }).text === "string"
  );
}

export default function (pi: ExtensionAPI) {
  pi.on("session_before_compact", async (event) => {
    const messages = event.preparation.messagesToSummarize;
    if (!Array.isArray(messages) || messages.length === 0) return;

    let prunedCount = 0;

    const pruned = messages.map((message) => {
      const candidate = message as {
        role?: unknown;
        content?: unknown;
        toolName?: unknown;
        isError?: unknown;
      };
      if (candidate.role !== "toolResult" || !Array.isArray(candidate.content))
        return message;

      const toolName =
        typeof candidate.toolName === "string" ? candidate.toolName : "tool";
      const isError = candidate.isError === true;

      let touched = false;
      const content = candidate.content.map((block) => {
        if (!isTextBlock(block) || block.text.length <= PRUNE_OVER_CHARS)
          return block;

        touched = true;
        const originalLength = block.text.length;
        const spillId = SPILL_ID_RE.exec(block.text)?.[1];
        const pointer = spillId ? ` Full output saved as ${spillId}.` : "";

        if (isError) {
          return {
            ...block,
            text:
              `${block.text.slice(0, ERROR_KEEP_CHARS)}\n\n` +
              `[${toolName} error, ${originalLength - ERROR_KEEP_CHARS} further chars pruned from history.${pointer}]`,
          };
        }

        return {
          ...block,
          text: `[${toolName} output, ${originalLength} chars, pruned from history.${pointer}]`,
        };
      });

      if (!touched) return message;
      prunedCount++;
      // A new object: the originals are the session's own entries.
      return { ...message, content };
    });

    if (prunedCount === 0) return;

    event.preparation.messagesToSummarize = pruned;
    // No compaction result returned: pi still summarizes and picks the cut.
  });
}
