import type {
  CompactionEntry,
  SessionEntry,
  SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";

/**
 * Compaction must never lose the original request, and a summarizer that
 * returns nothing usable must not wipe the history. Every summary is prefixed
 * with the first user message verbatim; a degenerate summary is replaced by a
 * mechanical digest of the compacted entries with tool results truncated.
 */

export const ANCHOR_START = "<!-- original-request -->";
export const ANCHOR_END = "<!-- /original-request -->";

/** The request is kept whole up to this; beyond it, head and tail. */
const ANCHOR_MAX_CHARS = 4_000;
const ANCHOR_HEAD_CHARS = 3_000;
const ANCHOR_TAIL_CHARS = 800;

/** A summary with fewer real characters than this said nothing. */
const MIN_SUMMARY_CHARS = 120;

/** Per-entry and total budget of the mechanical digest. */
const DIGEST_USER_CHARS = 600;
const DIGEST_ASSISTANT_CHARS = 400;
const DIGEST_TOOL_CALL_CHARS = 200;
const DIGEST_TOOL_RESULT_CHARS = 300;
const DIGEST_MAX_CHARS = 24_000;

const clip = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max)}…`;

const textOf = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .filter(
      (block): block is { type: "text"; text: string } =>
        typeof block === "object" &&
        block !== null &&
        (block as { type?: unknown }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string"
    )
    .map((block) => block.text)
    .join("\n");
};

const isMessageEntry = (entry: SessionEntry): entry is SessionMessageEntry =>
  entry.type === "message";

/** The first user message on the branch, or null when there is none. */
export function originalRequest(entries: SessionEntry[]): string | null {
  for (const entry of entries) {
    if (!isMessageEntry(entry) || entry.message.role !== "user") continue;
    const text = textOf(entry.message.content).trim();
    if (text.length === 0) continue;
    if (text.length <= ANCHOR_MAX_CHARS) return text;

    return (
      `${text.slice(0, ANCHOR_HEAD_CHARS)}\n\n` +
      `[… ${text.length - ANCHOR_HEAD_CHARS - ANCHOR_TAIL_CHARS} chars omitted …]\n\n` +
      text.slice(-ANCHOR_TAIL_CHARS)
    );
  }

  return null;
}

const ANCHOR_BLOCK_RE = new RegExp(
  `${ANCHOR_START}[\\s\\S]*?${ANCHOR_END}\\s*`,
  "g"
);

/** The summary without any anchor block a previous compaction put there. */
export const stripAnchor = (summary: string): string =>
  summary.replace(ANCHOR_BLOCK_RE, "").trim();

/** Headings with nothing under them, rules and blank lines do not count. */
export function isDegenerateSummary(summary: string): boolean {
  const real = stripAnchor(summary)
    .split("\n")
    .map((line) => line.replace(/^[\s#*\-_>=|`~]+|[\s#*\-_>=|`~]+$/g, ""))
    .filter((line) => line.length > 0)
    .join(" ");

  return real.length < MIN_SUMMARY_CHARS;
}

/**
 * The compacted stretch of history, entry by entry, with everything cut
 * short. No model in the loop, so nothing can come back empty.
 */
export function mechanicalDigest(
  entries: SessionEntry[],
  firstKeptEntryId: string
): string {
  let lastCompaction: CompactionEntry | null = null;
  let start = 0;
  for (const [index, entry] of entries.entries()) {
    if (entry.type === "compaction") {
      lastCompaction = entry;
      start = index + 1;
    }
  }
  const end = entries.findIndex((entry) => entry.id === firstKeptEntryId);
  const compacted = entries.slice(start, end === -1 ? undefined : end);

  const lines: string[] = [];
  for (const entry of compacted) {
    if (!isMessageEntry(entry)) continue;
    const message = entry.message as {
      role: string;
      content: unknown;
      toolName?: string;
      isError?: boolean;
    };
    if (message.role === "user") {
      lines.push(`User: ${clip(textOf(message.content), DIGEST_USER_CHARS)}`);
    } else if (message.role === "assistant") {
      const text = textOf(message.content);
      if (text.trim().length > 0)
        lines.push(`Assistant: ${clip(text, DIGEST_ASSISTANT_CHARS)}`);
      if (Array.isArray(message.content))
        for (const block of message.content as {
          type?: string;
          name?: string;
          arguments?: unknown;
        }[])
          if (block.type === "toolCall")
            lines.push(
              `→ ${block.name ?? "tool"}(${clip(JSON.stringify(block.arguments ?? {}), DIGEST_TOOL_CALL_CHARS)})`
            );
    } else if (message.role === "toolResult") {
      const label = message.isError === true ? "error" : "result";
      lines.push(
        `← ${message.toolName ?? "tool"} ${label}: ${clip(textOf(message.content).replace(/\s+/g, " "), DIGEST_TOOL_RESULT_CHARS)}`
      );
    }
  }

  // Newest entries matter most, so the budget is spent from the end.
  let digest = "";
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const next = `${lines[i]}\n${digest}`;
    if (next.length > DIGEST_MAX_CHARS) {
      digest = `[… ${i + 1} earlier entries omitted …]\n${digest}`;
      break;
    }
    digest = next;
  }

  const previous =
    lastCompaction == null ? "" : stripAnchor(lastCompaction.summary);

  return (
    "The summarizer returned nothing usable, so this is a mechanical record " +
    "of the compacted history. Tool results are truncated; re-run a tool " +
    "only if its result is needed again.\n\n" +
    (previous.length > 0 ? `## Earlier summary\n${previous}\n\n` : "") +
    `## Compacted history\n${digest.trim()}`
  );
}

/** The summary as it is stored: anchored, and never empty. */
export function anchoredSummary(
  entries: SessionEntry[],
  summary: string,
  firstKeptEntryId: string
): string {
  const body = isDegenerateSummary(summary)
    ? mechanicalDigest(entries, firstKeptEntryId)
    : stripAnchor(summary);
  const request = originalRequest(entries);
  if (request == null) return body;

  return (
    `${ANCHOR_START}\n## Original request (verbatim, keep working on this)\n` +
    `${request}\n${ANCHOR_END}\n\n${body}`
  );
}

/** The slice of a session manager the anchor wraps. */
export interface CompactionSink {
  getBranch: () => SessionEntry[];
  appendCompaction: (
    summary: string,
    firstKeptEntryId: string,
    ...rest: never[]
  ) => string;
}

/** Route every stored summary through anchoredSummary. */
export function anchorCompactions<T extends CompactionSink>(manager: T): T {
  const append = manager.appendCompaction.bind(manager) as (
    ...args: unknown[]
  ) => string;
  (manager as CompactionSink).appendCompaction = ((
    summary: string,
    firstKeptEntryId: string,
    ...rest: unknown[]
  ) =>
    append(
      anchoredSummary(manager.getBranch(), summary, firstKeptEntryId),
      firstKeptEntryId,
      ...rest
    )) as T["appendCompaction"];

  return manager;
}
