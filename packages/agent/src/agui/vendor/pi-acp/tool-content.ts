/**
 * Vendored from pi-acp (MIT, Copyright (c) 2025 Victor Software House; see
 * ./LICENSE), src/acp/translate/tool-content.ts:57-300 at commit
 * 0ef24b24c97ac81a5e87a17d8fd74ef97fb34d8b.
 *
 * Changes: zod schemas replaced by plain structural checks (no runtime
 * dependency, browser-safe); `formatToolContent` returns one markdown string
 * instead of ACP `ToolCallContent[]`; lsp/tmux cases dropped.
 */

export interface BashOutput {
  output: string;
  exitCode: number | undefined;
}

type Rec = Record<string, unknown>;

const isRec = (value: unknown): value is Rec =>
  value !== null && typeof value === "object";

const strOf = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

const numOf = (value: unknown): number | undefined =>
  typeof value === "number" ? value : undefined;

function textBlocks(content: unknown): string[] {
  if (!Array.isArray(content)) return [];

  return content
    .filter(
      (block): block is { type: "text"; text: string } =>
        isRec(block) && block.type === "text" && typeof block.text === "string"
    )
    .map((block) => block.text);
}

/** stdout/stderr and exit code from a pi bash result. */
export function extractBashOutput(result: unknown): BashOutput {
  if (!isRec(result)) return { output: "", exitCode: undefined };

  const d = isRec(result.details) ? result.details : undefined;
  const exitCode =
    numOf(d?.exitCode) ?? numOf(result.exitCode) ?? numOf(d?.code) ?? numOf(result.code);

  if (result.content !== undefined) {
    const texts = textBlocks(result.content);
    if (texts.length > 0) return { output: texts.join(""), exitCode };
  }

  const stdout =
    strOf(d?.stdout) ?? strOf(result.stdout) ?? strOf(d?.output) ?? strOf(result.output);
  const stderr = strOf(d?.stderr) ?? strOf(result.stderr);
  const parts: string[] = [];
  if (stdout !== undefined && stdout.trim() !== "") parts.push(stdout);
  if (stderr !== undefined && stderr.trim() !== "") parts.push(stderr);

  return { output: parts.join("\n"), exitCode };
}

/** Text content of a pi tool result (generic). */
export function extractTextContent(result: unknown): string {
  if (!isRec(result)) return typeof result === "string" ? result : "";

  const texts = textBlocks(result.content);
  if (texts.length > 0) return texts.join("");

  try {
    return JSON.stringify(result, null, 2);
  } catch {
    return String(result);
  }
}

function longestBacktickRun(text: string): number {
  let max = 0;
  let current = 0;
  for (const ch of text) {
    if (ch === "`") {
      current++;
      if (current > max) max = current;
    } else {
      current = 0;
    }
  }
  return max;
}

/** Wrap text in a backtick fence longer than any run inside it. */
export function markdownEscape(text: string): string {
  if (text === "") return "";

  const fence = "`".repeat(Math.max(3, longestBacktickRun(text) + 1));
  const body = text.endsWith("\n") ? text.slice(0, -1) : text;
  return `${fence}\n${body}\n${fence}`;
}

/**
 * Markdown for a tool result, by tool name: console fences for bash, escaped
 * text for read, nothing for edit/write (the diff shows it), fenced text for
 * errors, plain text otherwise.
 */
export function formatToolContent(
  toolName: string,
  result: unknown,
  isError: boolean
): string {
  if (isError) {
    const text = extractTextContent(result);
    return text === "" ? "" : `\`\`\`\n${text}\n\`\`\``;
  }

  switch (toolName) {
    case "bash": {
      const { output, exitCode } = extractBashOutput(result);
      const parts: string[] = [];
      if (output !== "") parts.push(`\`\`\`console\n${output}\n\`\`\``);
      if (exitCode !== undefined && exitCode !== 0) parts.push(`exit code: ${exitCode}`);
      return parts.join("\n\n");
    }
    case "read": {
      const texts = isRec(result) ? textBlocks(result.content) : [];
      if (texts.length > 0) return texts.map(markdownEscape).join("\n");
      return markdownEscape(extractTextContent(result));
    }
    case "edit":
    case "write":
      return "";
    default:
      return extractTextContent(result);
  }
}

/** Streaming bash output in a console fence (each update is the full buffer). */
export function wrapStreamingBashOutput(text: string): string {
  return text === "" ? "" : `\`\`\`console\n${text}\n\`\`\``;
}
