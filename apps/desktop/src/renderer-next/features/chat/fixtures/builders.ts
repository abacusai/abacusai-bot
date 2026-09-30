/**
 * AG-UI event builders for scenarios the agent goldens do not cover
 * (spec 02 §11.1): the same shapes the agent's emitter writes
 * (`packages/agent/src/agui/emit.ts`), so R2-T29 can hold them to the
 * emitted vocabulary. Also used by tests.
 */
import type { StreamChunk } from "@tanstack/ai";

import type { PermissionDescriptor, PermissionRequest } from "@abacus-ai/agent";

type Loose = Record<string, unknown>;

const chunk = (event: Loose): StreamChunk => event as unknown as StreamChunk;

export const runStarted = (
  runId: string,
  options: { serverInitiated?: boolean; timestamp?: number } = {}
): StreamChunk =>
  chunk({
    type: "RUN_STARTED",
    threadId: "t-1",
    runId,
    ...(options.timestamp != null ? { timestamp: options.timestamp } : {}),
    ...(options.serverInitiated === true
      ? { metadata: { abacus: { serverInitiated: true } } }
      : {}),
  });

export const text = (
  messageId: string,
  role: "user" | "assistant",
  content: string,
  extra: Loose = {}
): StreamChunk[] => [
  chunk({ type: "TEXT_MESSAGE_START", messageId, role, ...extra }),
  ...(content === ""
    ? []
    : [chunk({ type: "TEXT_MESSAGE_CONTENT", messageId, delta: content, ...extra })]),
  chunk({ type: "TEXT_MESSAGE_END", messageId, ...extra }),
];

export const textStart = (messageId: string, role: "user" | "assistant" = "assistant"): StreamChunk =>
  chunk({ type: "TEXT_MESSAGE_START", messageId, role });
export const textDelta = (messageId: string, delta: string): StreamChunk =>
  chunk({ type: "TEXT_MESSAGE_CONTENT", messageId, delta });
export const textEnd = (messageId: string): StreamChunk =>
  chunk({ type: "TEXT_MESSAGE_END", messageId });

export const reasoning = (messageId: string, content: string): StreamChunk[] => [
  chunk({ type: "REASONING_START", messageId }),
  chunk({ type: "REASONING_MESSAGE_START", messageId, role: "reasoning" }),
  chunk({ type: "REASONING_MESSAGE_CONTENT", messageId, delta: content }),
  chunk({ type: "REASONING_MESSAGE_END", messageId }),
  chunk({ type: "REASONING_END", messageId }),
];

export const toolStart = (
  toolCallId: string,
  name: string,
  parentMessageId: string,
  extra: Loose = {}
): StreamChunk =>
  chunk({
    type: "TOOL_CALL_START",
    toolCallId,
    toolCallName: name,
    parentMessageId,
    metadata: { abacus: { rawName: name } },
    ...extra,
  });

export const toolArgs = (toolCallId: string, delta: string, extra: Loose = {}): StreamChunk =>
  chunk({ type: "TOOL_CALL_ARGS", toolCallId, delta, ...extra });

export const toolEnd = (toolCallId: string, input: Loose, extra: Loose = {}): StreamChunk =>
  chunk({ type: "TOOL_CALL_END", toolCallId, metadata: { tanstack: { input } }, ...extra });

/** START + one ARGS + END for a call with this input. */
export const toolCall = (
  toolCallId: string,
  name: string,
  parentMessageId: string,
  input: Loose,
  extra: Loose = {}
): StreamChunk[] => [
  toolStart(toolCallId, name, parentMessageId, extra),
  toolArgs(toolCallId, JSON.stringify(input), extra),
  toolEnd(toolCallId, input, extra),
];

export interface ResultContent {
  text: string;
  rejected?: boolean;
  error?: string;
  display?: Loose;
  terminal?: { output: string };
  formatted?: string;
  unfinished?: true;
}

export const toolResult = (
  toolCallId: string,
  content: ResultContent,
  options: { outcome?: "denied" | "cancelled"; subagentRunId?: string } = {}
): StreamChunk =>
  chunk({
    type: "TOOL_CALL_RESULT",
    messageId: `${toolCallId}:result`,
    toolCallId,
    role: "tool",
    content: JSON.stringify({ rejected: false, ...content }),
    ...(content.rejected === true || options.outcome != null
      ? {
          metadata: {
            tanstack: {
              state: "output-error",
              ...(options.outcome != null ? { toolResultOutcome: options.outcome } : {}),
            },
          },
        }
      : {}),
    ...(options.subagentRunId != null ? { subagentRunId: options.subagentRunId } : {}),
  });

export const custom = (name: string, value: unknown, extra: Loose = {}): StreamChunk =>
  chunk({ type: "CUSTOM", name, value, ...extra });

export const runFinished = (
  runId: string,
  outcome: "success" | "cancelled" = "success",
  extra: Loose = {}
): StreamChunk =>
  chunk({
    type: "RUN_FINISHED",
    threadId: "t-1",
    runId,
    outcome: { type: outcome },
    usage: [
      {
        model: "fake-1",
        inputTokens: 12_300,
        cachedInputTokens: 8100,
        cacheWriteInputTokens: 0,
        outputTokens: 1200,
        totalTokens: 13_500,
      },
    ],
    ...extra,
  });

export const runError = (
  runId: string,
  error: { message: string; code?: string; detail?: string; actions?: Loose[] }
): StreamChunk =>
  chunk({
    type: "RUN_ERROR",
    message: error.message,
    code: error.code ?? "turn_failed",
    metadata: {
      tanstack: { threadId: "t-1", runId },
      abacus: { error },
    },
  });

export const stateSnapshot = (state: Loose): StreamChunk =>
  chunk({ type: "STATE_SNAPSHOT", snapshot: state });

export const subagentStarted = (
  subagentRunId: string,
  name: string,
  description: string,
  parentToolCallId: string,
  parentMessageId: string
): StreamChunk =>
  chunk({
    type: "SUBAGENT_STARTED",
    subagentRunId,
    name,
    description,
    parentToolCallId,
    parentMessageId,
  });

export const subagentFinished = (subagentRunId: string, result: string): StreamChunk =>
  chunk({ type: "SUBAGENT_FINISHED", subagentRunId, result, outcome: { type: "success" } });

export const subagentError = (subagentRunId: string, message: string): StreamChunk =>
  chunk({ type: "SUBAGENT_ERROR", subagentRunId, code: "limit", message });

export const sessionReady = (incarnation = "inc-1", mode = "DEFAULT"): StreamChunk[] => [
  custom("session.ready", { model: "fake/fake-1", mode, incarnation }),
  stateSnapshot({ mode, modeSource: "startup", model: "fake/fake-1", incarnation }),
];

let permissionCounter = 0;

/** A `PermissionDescriptor` as the agent builds it (agent spec §3.5). */
export const descriptor = (
  request: PermissionRequest,
  options: {
    id?: string;
    toolCallId?: string;
    subagentRunId?: string;
    runId?: string;
    incarnation?: string;
    allowed?: string[];
    turnSeq?: number;
  } = {}
): PermissionDescriptor => {
  const id = options.id ?? `perm-${++permissionCounter}`;
  return {
    id,
    reason: request.type === "ask_user_question" ? "abacus:question" : "abacus:permission",
    message: (request as { displayName?: string }).displayName ?? request.type,
    ...(options.toolCallId != null ? { toolCallId: options.toolCallId } : {}),
    ...(options.subagentRunId != null ? { subagentRunId: options.subagentRunId } : {}),
    metadata: {
      abacus: {
        lineage: {
          threadId: "t-1",
          incarnation: options.incarnation ?? "inc-1",
          turnSeq: options.turnSeq ?? 1,
          ...(options.runId != null ? { runId: options.runId } : {}),
          permissionId: id,
        },
        kind: request.type,
        request,
        attachedBy: options.toolCallId != null ? "gate" : "none",
        allowed: (options.allowed ?? [
          "accept",
          "reject",
          "allowAlways",
          "allowYolo",
          "accept_with_message",
          "reject_with_message",
        ]) as PermissionDescriptor["metadata"]["abacus"]["allowed"],
      },
    },
  } as PermissionDescriptor;
};

export const permissionEvents = (
  items: PermissionDescriptor[],
  requested?: PermissionDescriptor,
  incarnation = "inc-1"
): StreamChunk[] => [
  ...(requested != null ? [custom("permission.requested", requested)] : []),
  custom("permission.pending", { incarnation, items }),
];
