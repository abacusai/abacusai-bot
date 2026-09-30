/**
 * Tool result normalisation (spec 02 §5.4a), pure. Widgets never read
 * `part.output` or `result.content` directly: live results (the agent's
 * `ToolResultContent`, agent spec §3.3.6) and migrated history (transport
 * C.3: legacy `ToolResult.output` and `ToolResultData`) both become one
 * shape. The origin is decided from the call alone, so it holds before any
 * result exists.
 */
import type { ToolCallPart, ToolResultPart } from "@tanstack/ai-client";

import { expandToolResultData } from "#shared/transcript/v1-to-ui-messages";

import type { ToolDisplayData } from "../../store/thread-store";

export type ToolStatus =
  | "running"
  | "needs-you"
  | "done"
  | "failed"
  | "refused"
  | "stopped";

export interface NormalizedTool {
  status: ToolStatus;
  text: string;
  error?: string;
  formatted?: string;
  diff?: {
    original?: string;
    final?: string;
    unified?: string;
    additions?: number;
    deletions?: number;
    isNewFile?: boolean;
  };
  terminal?: {
    command?: string;
    output: string;
    exitCode?: number;
    timedOut?: boolean;
    background?: boolean;
  };
  read?: { content: string; startLine?: number; lineCount: number; filePath?: string };
  source: "live" | "migrated";
}

export interface LiveToolState {
  output?: string;
  display?: ToolDisplayData;
}

export interface NormalizeContext {
  /** A pending permission descriptor joins this call (§6.2). */
  needsYou?: boolean;
  /** The call's run is still active. */
  runActive: boolean;
}

type Loose = Record<string, unknown>;

const asRecord = (value: unknown): Loose | undefined =>
  value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as Loose)
    : undefined;

const str = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;
const num = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

export const isMigrated = (call: ToolCallPart): boolean =>
  typeof asRecord(
    asRecord((call as { metadata?: unknown }).metadata)?.abacus
  )?.segmentId === "string";

const resultText = (result: ToolResultPart | undefined): string => {
  if (result == null) return "";
  if (typeof result.content === "string") return result.content;
  return result.content
    .map((part) => ((part as { type: string }).type === "text" ? ((part as { content?: string }).content ?? "") : ""))
    .join("");
};

const parseJson = (text: string): Loose | undefined => {
  try {
    return asRecord(JSON.parse(text));
  } catch {
    return undefined;
  }
};

/** The call's input: final once `input-complete`, else the partial parse. */
export const toolInput = (
  call: ToolCallPart,
  parsePartial: (text: string) => unknown
): Loose => {
  const input = asRecord(call.input);
  if (input != null) return input;
  if (call.arguments === "") return {};
  return asRecord(parsePartial(call.arguments)) ?? {};
};

const statusOf = (
  call: ToolCallPart,
  result: ToolResultPart | undefined,
  outputRecord: Loose | undefined,
  context: NormalizeContext
): ToolStatus => {
  if (context.needsYou === true && result == null) return "needs-you";
  if (result == null) {
    const settled = call.state === "complete" || call.state === "error";
    if (!settled && context.runActive) return "running";
    if (call.state === "complete" && outputRecord != null)
      return outputRecord.rejected === true ? "failed" : "done";
    return context.runActive ? "running" : "stopped";
  }
  if (result.state === "error" || (result.state as string) === "output-error") {
    if (result.outcome === "denied") return "refused";
    if (result.outcome === "cancelled" || outputRecord?.unfinished === true)
      return "stopped";
    return "failed";
  }
  return "done";
};

const liveDiff = (display: ToolDisplayData | undefined): NormalizedTool["diff"] =>
  display == null ||
  (display.originalContent == null &&
    display.newContent == null &&
    display.finalContent == null)
    ? undefined
    : {
        ...(display.originalContent != null ? { original: display.originalContent } : {}),
        ...((display.newContent ?? display.finalContent) != null
          ? { final: display.newContent ?? display.finalContent }
          : {}),
        ...(display.additions != null ? { additions: display.additions } : {}),
        ...(display.deletions != null ? { deletions: display.deletions } : {}),
        ...(display.isNewFile != null ? { isNewFile: display.isNewFile } : {}),
      };

const normalizeLive = (
  call: ToolCallPart,
  result: ToolResultPart | undefined,
  live: LiveToolState,
  input: Loose,
  context: NormalizeContext
): NormalizedTool => {
  const output =
    asRecord(call.output) ?? (result != null ? parseJson(resultText(result)) : undefined);
  const display = {
    ...live.display,
    ...(asRecord(output?.display) as ToolDisplayData | undefined),
  } as ToolDisplayData;
  const status = statusOf(call, result, output, context);
  const terminalOutput =
    str(asRecord(output?.terminal)?.output) ?? live.output ?? undefined;
  const command = str(input.command);
  const text = str(output?.text) ?? (result != null && output == null ? resultText(result) : "");
  const diff = liveDiff(Object.keys(display).length > 0 ? display : undefined);
  const lineCount = num(display.lineCount);
  return {
    status,
    text,
    ...(str(output?.error) != null ? { error: str(output?.error)! } : result?.error != null ? { error: result.error } : {}),
    ...(str(output?.formatted) != null ? { formatted: str(output?.formatted)! } : {}),
    ...(diff != null ? { diff } : {}),
    ...(terminalOutput != null || command != null
      ? { terminal: { ...(command != null ? { command } : {}), output: terminalOutput ?? "" } }
      : {}),
    ...(lineCount != null
      ? {
          read: {
            content: text,
            lineCount,
            ...(num(input.offset) != null ? { startLine: num(input.offset)! } : {}),
            ...(str(input.path ?? input.file_path) != null
              ? { filePath: str(input.path ?? input.file_path)! }
              : {}),
          },
        }
      : {}),
    source: "live",
  };
};

const normalizeMigrated = (
  call: ToolCallPart,
  result: ToolResultPart | undefined,
  input: Loose,
  context: NormalizeContext
): NormalizedTool => {
  // C.3 r1 fixes: migrated calls carry no `input`/`output`; the legacy
  // `ToolResultData` is read through `expandToolResultData`.
  const text = typeof call.output === "string" ? call.output : resultText(result);
  const data = result == null ? undefined : expandToolResultData(result);
  const status = statusOf(call, result, undefined, { ...context, runActive: false });
  const base: NormalizedTool = {
    status: result == null ? "stopped" : status,
    text,
    ...(result?.error != null ? { error: result.error } : {}),
    source: "migrated",
  };
  switch (data?.type) {
    case "read":
      return {
        ...base,
        read: {
          content: str(data.content) ?? text,
          lineCount: num(data.lineCount) ?? (str(data.content) ?? text).split("\n").length,
          ...(num(data.startLine) != null ? { startLine: num(data.startLine)! } : {}),
          ...(str(data.filePath ?? input.path) != null ? { filePath: str(data.filePath ?? input.path)! } : {}),
        },
      };
    case "file_mutation":
      return {
        ...base,
        diff: {
          ...(str(data.originalContent) != null ? { original: str(data.originalContent)! } : {}),
          ...(str(data.finalContent) != null ? { final: str(data.finalContent)! } : {}),
          ...(str(data.diff) != null ? { unified: str(data.diff)! } : {}),
          ...(num(data.additions) != null ? { additions: num(data.additions)! } : {}),
          ...(num(data.deletions) != null ? { deletions: num(data.deletions)! } : {}),
          ...(typeof data.isNewFile === "boolean" ? { isNewFile: data.isNewFile } : {}),
        },
      };
    case "bash":
      return {
        ...base,
        terminal: {
          output: str(data.output) ?? text,
          ...(str(data.command ?? input.command) != null ? { command: str(data.command ?? input.command)! } : {}),
          ...(num(data.exitCode) != null ? { exitCode: num(data.exitCode)! } : {}),
          ...(typeof data.timedOut === "boolean" ? { timedOut: data.timedOut } : {}),
          ...(typeof data.background === "boolean" ? { background: data.background } : {}),
        },
      };
    default:
      return base;
  }
};

export const normalizeTool = (
  call: ToolCallPart,
  result: ToolResultPart | undefined,
  live: LiveToolState,
  context: NormalizeContext,
  parsePartial: (text: string) => unknown = () => undefined
): NormalizedTool => {
  const input = toolInput(call, parsePartial);
  return isMigrated(call)
    ? normalizeMigrated(call, result, input, context)
    : normalizeLive(call, result, live, input, context);
};

/** Added and removed line counts of a naive line diff (the meta column). */
export const countChanges = (
  original: string | undefined,
  final: string | undefined
): { additions: number; deletions: number } => {
  const a = original == null || original === "" ? [] : original.split("\n");
  const b = final == null || final === "" ? [] : final.split("\n");
  const lines = diffLines(a, b);
  return {
    additions: lines.filter((line) => line.kind === "add").length,
    deletions: lines.filter((line) => line.kind === "del").length,
  };
};

export interface DiffLine {
  kind: "add" | "del" | "same";
  text: string;
}

/** A line diff by longest common subsequence, bounded for huge inputs. */
export const diffLines = (a: readonly string[], b: readonly string[]): DiffLine[] => {
  if (a.length * b.length > 4_000_000)
    return [
      ...a.map((text): DiffLine => ({ kind: "del", text })),
      ...b.map((text): DiffLine => ({ kind: "add", text })),
    ];
  const rows = a.length + 1;
  const cols = b.length + 1;
  const table = new Uint32Array(rows * cols);
  for (let i = a.length - 1; i >= 0; i -= 1)
    for (let j = b.length - 1; j >= 0; j -= 1)
      table[i * cols + j] =
        a[i] === b[j]
          ? table[(i + 1) * cols + j + 1]! + 1
          : Math.max(table[(i + 1) * cols + j]!, table[i * cols + j + 1]!);
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: "same", text: a[i]! });
      i += 1;
      j += 1;
    } else if (table[(i + 1) * cols + j]! >= table[i * cols + j + 1]!) {
      out.push({ kind: "del", text: a[i]! });
      i += 1;
    } else {
      out.push({ kind: "add", text: b[j]! });
      j += 1;
    }
  }
  while (i < a.length) out.push({ kind: "del", text: a[i++]! });
  while (j < b.length) out.push({ kind: "add", text: b[j++]! });
  return out;
};

/** A unified diff's lines (`diffContent`, legacy `ToolResultData.diff`). */
export const parseUnified = (unified: string): DiffLine[] =>
  unified
    .split("\n")
    .filter((line) => !/^(---|\+\+\+|@@|diff |index )/.test(line))
    .map((line): DiffLine =>
      line.startsWith("+")
        ? { kind: "add", text: line.slice(1) }
        : line.startsWith("-")
          ? { kind: "del", text: line.slice(1) }
          : { kind: "same", text: line.startsWith(" ") ? line.slice(1) : line }
    );
