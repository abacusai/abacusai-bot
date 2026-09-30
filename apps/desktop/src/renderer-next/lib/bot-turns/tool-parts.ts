/**
 * Tool calls of a UIMessage, read the same way for live parts (the agent's
 * `ToolResultContent` JSON as the result's content, or `call.output`) and
 * migrated ones (transport C.3: `arguments` only, the legacy output as the
 * result's content, `metadata.abacus.{data,rejection}`). Pure.
 */
import type { UIMessage } from "@tanstack/ai-client";

type Loose = Record<string, unknown>;

interface CallPart {
  type: "tool-call";
  id: string;
  name: string;
  arguments: string;
  input?: unknown;
  state: string;
  output?: unknown;
}

interface ResultPart {
  type: "tool-result";
  toolCallId: string;
  content: string | Array<{ type: string; content?: string }>;
  state: string;
  outcome?: string;
  metadata?: Record<string, unknown>;
}

export interface MessageTool {
  name: string;
  input: Loose;
  /** The result's text (a live JSON envelope unwrapped to its `text`). */
  text: string;
  /** The raw result content, before unwrapping. */
  raw: string;
  /** Settled: a complete, not denied or rejected, result. */
  settled: boolean;
  /** Migrated `ToolResultData`, when stored. */
  data: Loose | undefined;
}

const asRecord = (value: unknown): Loose | undefined =>
  value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as Loose)
    : undefined;

export const parseJsonRecord = (text: string): Loose | undefined => {
  try {
    return asRecord(JSON.parse(text));
  } catch {
    return undefined;
  }
};

const contentText = (result: ResultPart): string =>
  typeof result.content === "string"
    ? result.content
    : result.content
        .map((part) => (part.type === "text" ? (part.content ?? "") : ""))
        .join("");

const inputOf = (call: CallPart): Loose => {
  const input = asRecord(call.input);
  if (input != null) return input;
  return (call.arguments === "" ? {} : parseJsonRecord(call.arguments)) ?? {};
};

const abacusOf = (part: { metadata?: unknown }): Loose =>
  asRecord(asRecord(part.metadata)?.abacus) ?? {};

/** Every tool call of `message`, joined with its result part when present. */
export const messageTools = (message: UIMessage): MessageTool[] => {
  const results = new Map<string, ResultPart>();
  for (const part of message.parts)
    if (part.type === "tool-result")
      results.set(
        (part as unknown as ResultPart).toolCallId,
        part as unknown as ResultPart
      );
  const tools: MessageTool[] = [];
  for (const part of message.parts) {
    if (part.type !== "tool-call") continue;
    const call = part as unknown as CallPart;
    const result = results.get(call.id);
    const output = asRecord(call.output);
    const raw =
      result != null
        ? contentText(result)
        : typeof call.output === "string"
          ? call.output
          : output != null
            ? JSON.stringify(output)
            : "";
    const envelope = result != null ? parseJsonRecord(raw) : output;
    const text =
      typeof envelope?.text === "string" ? (envelope.text as string) : raw;
    const rejected =
      envelope?.rejected === true ||
      (result != null && abacusOf(result).rejection != null) ||
      result?.outcome === "denied" ||
      result?.outcome === "cancelled";
    const settled =
      result != null
        ? result.state === "complete" && !rejected
        : call.state === "complete" && output != null && !rejected;
    tools.push({
      name: call.name,
      input: inputOf(call),
      text,
      raw,
      settled,
      data: result == null ? undefined : asRecord(abacusOf(result).data),
    });
  }
  return tools;
};
