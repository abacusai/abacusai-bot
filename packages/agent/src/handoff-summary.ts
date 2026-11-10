/**
 * The hand-off summary: what a new chat on another model needs to carry on
 * from this one, so it does not re-read this chat's whole history on every
 * call. pi's branch summary (newest entries first, within the summarizer's
 * window; the files read and changed listed from the tool calls) runs on the
 * model a too-big compaction would use. The session is only read, never
 * written. The summary never sees tool output, so the latest failing tool
 * result is quoted word for word after it.
 */
import {
  estimateTokens,
  generateBranchSummary,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";

import {
  isDegenerateSummary,
  mechanicalDigest,
  textOf,
} from "./compaction-anchor.js";
import type { Summarizer } from "./extensions/spend-governor.js";

export const HANDOFF_FOCUS =
  "This summary opens a new chat that continues this work on another model. " +
  "Name every file that was read or changed by its exact path. Under Blocked, " +
  "list each approach that was tried and did not work, and why it failed. " +
  "End with the last thing the user asked for.";

/** Most of a window a summary may be asked to read: the oldest entries go first. */
const HANDOFF_MAX_TOKENS = 100_000;
/** How much of the last failing tool result is quoted. */
const LAST_ERROR_CHARS = 1_200;
/** The user turns searched back for a failing tool result. */
const LAST_ERROR_TURNS = 2;

/** pi's opening line for a branch summary, which speaks of returning to a branch. */
const BRANCH_PREAMBLE_RE =
  /^The user explored a different conversation branch[^\n]*\nSummary of that exploration:\n\n/;
/** Where pi's file lists start. */
const FILE_LISTS_RE = /\n\n<(?:read|modified)-files>/;

/**
 * The newest failing tool result in the last two user turns (the one the
 * user answered and the one before it), word for word up to a cap.
 */
export const lastToolError = (
  entries: readonly SessionEntry[]
): { tool: string; text: string } | null => {
  let turns = 0;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    if (entry.type !== "message") continue;
    const message = entry.message as {
      role: string;
      content: unknown;
      isError?: boolean;
      toolName?: string;
    };
    if (message.role === "user" && (turns += 1) > LAST_ERROR_TURNS) return null;
    if (message.role !== "toolResult" || message.isError !== true) continue;
    const text = textOf(message.content).trim();
    if (text === "") continue;
    return {
      tool: message.toolName ?? "tool",
      text:
        text.length <= LAST_ERROR_CHARS
          ? text
          : `${text.slice(0, LAST_ERROR_CHARS)}\n[… ${text.length - LAST_ERROR_CHARS} more characters]`,
    };
  }
  return null;
};

/**
 * The summary of `entries` (the session's current branch), or null when no
 * model may write it for this chat's payer.
 */
export const handoffSummary = async (
  entries: SessionEntry[],
  summarizerFor: (tokens: number) => Promise<Summarizer | null>,
  signal?: AbortSignal
): Promise<string | null> => {
  const tokens = entries.reduce(
    (sum, entry) =>
      entry.type === "message" ? sum + estimateTokens(entry.message) : sum,
    0
  );
  const choice = await summarizerFor(Math.min(tokens, HANDOFF_MAX_TOKENS));
  if (choice == null) return null;
  const result = await generateBranchSummary(entries, {
    model: choice.model as never,
    streamFn: choice.streamFn as never,
    signal: signal ?? new AbortController().signal,
    customInstructions: HANDOFF_FOCUS,
  });
  if (result.summary == null || result.error != null || result.aborted)
    throw new Error(result.error ?? "The summary was stopped.");
  const summary = result.summary.replace(BRANCH_PREAMBLE_RE, "");
  const lists = summary.search(FILE_LISTS_RE);
  const prose = lists < 0 ? summary : summary.slice(0, lists);
  const files = lists < 0 ? "" : summary.slice(lists);
  // A summarizer that wrote nothing usable leaves the record of the history.
  const body = isDegenerateSummary(prose)
    ? mechanicalDigest(entries, "")
    : prose.trim();
  const error = lastToolError(entries);
  return (
    body +
    files +
    (error == null
      ? ""
      : `\n\n## Last error (${error.tool}, verbatim)\n\`\`\`\n${error.text}\n\`\`\``)
  );
};
