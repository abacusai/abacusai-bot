/**
 * The last thing said in a bot's chat, for the sidebar row. Read from the
 * transcript on disk rather than tracked in the bot record: a copy would be
 * wrong exactly when a turn was interrupted, which is when the row matters.
 */
import type { TranscriptService } from "../session/transcript-service";

export interface BotChatPreview {
  /** The last message, flattened to one line. Empty when there is none. */
  text: string;
  /** Null for a transcript written without timestamps. */
  at: number | null;
}

const MAX_PREVIEW = 200;

/**
 * The persisted `ConversationSegment`, declared here rather than imported so
 * main does not depend on the renderer's conversation model.
 */
interface TextSegment {
  type?: unknown;
  content?: unknown;
  at?: unknown;
}

/**
 * The last line of a message: the closing line is usually the question the
 * user has to answer, while the first is throat-clearing.
 */
const lastLine = (content: string): string => {
  const lines = content
    .split("\n")
    .map((line) => line.replace(/^[\s>*_#-]+/, "").trim())
    .filter((line) => line.length > 0);

  return lines[lines.length - 1] ?? "";
};

export const botChatPreview = (
  transcripts: TranscriptService,
  sessionId: string | null
): BotChatPreview | null => {
  if (sessionId == null) return null;

  const stored = transcripts.read(sessionId);
  if (stored == null) return null;

  for (let index = stored.segments.length - 1; index >= 0; index--) {
    const segment = stored.segments[index] as TextSegment;
    if (segment?.type !== "text") continue;

    const content = typeof segment.content === "string" ? segment.content : "";
    const text = lastLine(content);
    if (text.length === 0) continue;

    return {
      text: text.slice(0, MAX_PREVIEW),
      at: typeof segment.at === "number" ? segment.at : null,
    };
  }

  return null;
};
