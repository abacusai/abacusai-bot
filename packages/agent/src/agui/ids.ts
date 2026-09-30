/**
 * AG-UI id conventions (spec §3.3.7). Legacy ids on the compat stream are
 * never touched; these are the ids the renderer sees.
 */
import { randomUUID } from "node:crypto";

/**
 * The `#` reservation (desktop spec 00 C.3; `apps/desktop/src/shared/
 * transcript/native-ids.ts`, whose encoding this must equal): the desktop's
 * v1 mapper derives ids with `#` (`id#2`, `segment#result`), so no id this
 * emitter puts into a thread may contain one. An id without `#` or `%` (every
 * id this process and pi produce today) is unchanged; anything else is
 * percent-encoded into a disjoint namespace. Applied once, where an id from
 * outside (a client run id, a provider tool call id, pi's message id) first
 * becomes an AG-UI id.
 */
export const nativeId = (id: string): string =>
  !id.includes("#") && !id.includes("%")
    ? id
    : id.replaceAll("%", "%25").replaceAll("#", "%23");

/** A fresh process incarnation: minted once at start, carried in every lineage. */
export const newIncarnation = (): string => randomUUID();

/** A run the host starts on its own (legacy send, drains, runAfterStop, dequeue). */
export const serverRunId = (): string => `srv-${randomUUID()}`;

export const userMessageId = (runId: string): string =>
  `${nativeId(runId)}:user`;

/**
 * A steered user message. Scoped by incarnation: the counter restarts in
 * every process, while main keeps one transcript per thread across respawns,
 * and a bare `steer-1` would overwrite the previous process's `steer-1`.
 */
export const steerMessageId = (incarnation: string, n: number): string =>
  `steer-${incarnation}-${n}`;

export const resultMessageId = (toolCallId: string): string =>
  `${toolCallId}:result`;

export const reasoningMessageId = (messageId: string, n: number): string =>
  `${messageId}:think:${n}`;

/** A child's tool call, unique across parallel children that reuse provider ids. */
export const childToolCallId = (
  subagentRunId: string,
  legacyId: string
): string => `${nativeId(subagentRunId)}:${nativeId(legacyId)}`;

/** A child's final text, or a browser child's web-N message. */
export const childMessageId = (
  subagentRunId: string,
  legacyMessageId: string | undefined
): string =>
  `${nativeId(subagentRunId)}:${nativeId(legacyMessageId ?? "final")}`;

/** Bookkeeping key for a tool call: `(subagentRunId ?? "", toolCallId)`. */
export const toolKey = (
  subagentRunId: string | undefined,
  toolCallId: string
): string => `${subagentRunId ?? ""}\u0000${toolCallId}`;
