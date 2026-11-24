/**
 * What debug sync uploads for a session (spec 03 §24.12): the v1 transcript's
 * segments as before, then, for a thread main persists as AG-UI
 * (`source.kind: "agui"`, which has no v1 transcript), its UIMessages. Each
 * message part is one log entry keyed by the stable message id (part 0) or
 * `<id>#<part index>`, so the same append-only per-session sync state holds
 * both and `sequenceOf` answers for the part a rating names
 * (`feedbackSegmentId`).
 *
 * The upload log is append-only, so a part goes up once and is never
 * replaced. While a run is open its last assistant part may still be growing
 * (a reply mid-stream, a tool call whose input is still arriving), so it is
 * held back until the run ends; uploading it then would keep the cut copy.
 *
 * Messages migrated from v1 (they carry `metadata.abacus.segments`) are not
 * uploaded again: their segments are the v1 transcript's, already keyed by
 * segment id, which is what feedback names for them (a text part's
 * `metadata.abacus.segmentId`).
 *
 * Pure: no Electron or fs, like `debug-sync.core`.
 */
import { aguiEntryKey } from "@abacus-ai/contract/transcript/feedback-target";

import type { StoredTranscript } from "../session/transcript-service";

/** The entry type of an AG-UI message part in the upload log. */
export const AGUI_ENTRY_TYPE = "ui-message-part";

/** The entry type of a turn's ending in the upload log. */
export const TURN_OUTCOME_ENTRY_TYPE = "turn-outcome";

interface TurnRecordLike {
  turnId: string;
  kind: string;
  cause?: string;
  startedAt: number;
  endedAt: number;
}

/**
 * One entry per closed turn. Neither the v1 segments nor the AG-UI message
 * parts carry how a turn ended (an error card, a timeout, a turn that said
 * nothing), so without these the upload cannot tell a failed turn from one
 * that answered.
 */
export const outcomeSyncEntries = (
  records: readonly TurnRecordLike[]
): Array<Record<string, unknown>> =>
  records.map((record) => ({
    id: `${TURN_OUTCOME_ENTRY_TYPE}:${record.turnId}`,
    type: TURN_OUTCOME_ENTRY_TYPE,
    kind: record.kind,
    ...(record.cause != null ? { cause: record.cause } : {}),
    startedAt: record.startedAt,
    at: record.endedAt,
  }));

interface MessageLike {
  id?: unknown;
  role?: unknown;
  parts?: unknown;
  createdAt?: unknown;
  metadata?: unknown;
}

interface ThreadLike {
  updatedAt?: string;
  source: { kind: string };
  messages: readonly unknown[];
}

const record = (value: unknown): Record<string, unknown> =>
  value != null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};

/** A message the v1 → v2 mapper produced (its segments came from v1). */
const fromV1 = (message: MessageLike): boolean =>
  Array.isArray(record(record(message.metadata).abacus).segments);

/** A message's creation time in epoch ms, from wherever it was recorded. */
export const messageCreatedAt = (message: unknown): number | null => {
  const typed = record(message);
  const candidates = [
    record(record(typed.metadata).tanstack).createdAt,
    typed.createdAt,
  ];
  for (const value of candidates) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (value instanceof Date) return value.getTime();
    if (typeof value === "string") {
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
};

/**
 * One entry per part of every live (non-migrated) message, in order. With
 * `runOpen`, the last part of a closing assistant message is left out: it may
 * still be streaming.
 */
export const aguiSyncEntries = (
  messages: readonly unknown[],
  runOpen = false
): Array<Record<string, unknown>> =>
  messages.flatMap((raw, index) => {
    const message = raw as MessageLike;
    if (typeof message.id !== "string" || message.id.length === 0) return [];
    if (fromV1(message) || !Array.isArray(message.parts)) return [];
    const createdAt = messageCreatedAt(message);
    const growing =
      runOpen && index === messages.length - 1 && message.role === "assistant";
    const parts = growing ? message.parts.slice(0, -1) : message.parts;
    return parts.map((part, partIndex) => ({
      id: aguiEntryKey(message.id as string, partIndex),
      type: AGUI_ENTRY_TYPE,
      messageId: message.id,
      role: message.role,
      partIndex,
      part,
      ...(createdAt != null && { createdAt }),
    }));
  });

/**
 * The session's upload log in the shape `debug-sync.core` reads: the v1
 * segments, then the AG-UI thread's live message parts. Null when neither
 * holds anything.
 */
export const syncLogFor = (
  sessionId: string,
  sources: {
    readV1(sessionId: string): StoredTranscript | null;
    readThread(sessionId: string): ThreadLike | null;
    readOutcomes?(sessionId: string): readonly TurnRecordLike[];
    /** Whether the thread has a run open now; its streaming tail waits. */
    runOpen?(sessionId: string): boolean;
  }
): StoredTranscript | null => {
  const v1 = sources.readV1(sessionId);
  let thread: ThreadLike | null = null;
  try {
    thread = sources.readThread(sessionId);
  } catch {
    thread = null;
  }
  const agui =
    thread?.source.kind === "agui"
      ? aguiSyncEntries(thread.messages, sources.runOpen?.(sessionId) === true)
      : [];
  if (v1 == null && agui.length === 0) return null;
  const outcomes = outcomeSyncEntries(sources.readOutcomes?.(sessionId) ?? []);
  if (agui.length === 0 && outcomes.length === 0) return v1;
  return {
    version: 1,
    sessionId,
    updatedAt: thread?.updatedAt ?? v1?.updatedAt ?? "",
    segments: [...(v1?.segments ?? []), ...agui, ...outcomes],
  };
};
