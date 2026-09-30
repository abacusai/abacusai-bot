/**
 * AG-UI id conventions (spec §3.3.7). Legacy ids on the compat stream are
 * never touched; these are the ids the renderer sees.
 */
import { randomUUID } from "node:crypto";

/** A fresh process incarnation: minted once at start, carried in every lineage. */
export const newIncarnation = (): string => randomUUID();

/** A run the host starts on its own (legacy send, drains, runAfterStop, dequeue). */
export const serverRunId = (): string => `srv-${randomUUID()}`;

export const userMessageId = (runId: string): string => `${runId}:user`;

export const steerMessageId = (n: number): string => `steer-${n}`;

export const resultMessageId = (toolCallId: string): string =>
  `${toolCallId}:result`;

export const reasoningMessageId = (messageId: string, n: number): string =>
  `${messageId}:think:${n}`;

/** A child's tool call, unique across parallel children that reuse provider ids. */
export const childToolCallId = (
  subagentRunId: string,
  legacyId: string
): string => `${subagentRunId}:${legacyId}`;

/** A child's final text, or a browser child's web-N message. */
export const childMessageId = (
  subagentRunId: string,
  legacyMessageId: string | undefined
): string => `${subagentRunId}:${legacyMessageId ?? "final"}`;

/** Bookkeeping key for a tool call: `(subagentRunId ?? "", toolCallId)`. */
export const toolKey = (
  subagentRunId: string | undefined,
  toolCallId: string
): string => `${subagentRunId ?? ""}\u0000${toolCallId}`;
