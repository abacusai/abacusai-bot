/**
 * What debug sync uploads for a session (spec 03 §24.12): the v1 transcript's
 * segments as before, then, for a thread main persists as AG-UI
 * (`source.kind: "agui"`, which has no v1 transcript), its UIMessages. Each
 * message part is one log entry keyed by the stable message id (part 0) or
 * `<id>#<part index>`, so the same append-only per-session sync state holds
 * both and `sequenceOf(sessionId, messageId)` answers for a live message.
 *
 * Messages migrated from v1 (they carry `metadata.abacus.segments`) are not
 * uploaded again: their segments are the v1 transcript's, already keyed by
 * segment id, which is what feedback names for them
 * (`metadata.abacus.segmentId`).
 *
 * Pure: no Electron or fs, like `debug-sync.core`.
 */
import type { StoredTranscript } from "../session/transcript-service";

/** The entry type of an AG-UI message part in the upload log. */
export const AGUI_ENTRY_TYPE = "ui-message-part";

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

/** The key an AG-UI part is uploaded under. */
export const aguiEntryKey = (messageId: string, partIndex: number): string =>
  partIndex === 0 ? messageId : `${messageId}#${partIndex}`;

/** One entry per part of every live (non-migrated) message, in order. */
export const aguiSyncEntries = (
  messages: readonly unknown[]
): Array<Record<string, unknown>> =>
  messages.flatMap((raw) => {
    const message = raw as MessageLike;
    if (typeof message.id !== "string" || message.id.length === 0) return [];
    if (fromV1(message) || !Array.isArray(message.parts)) return [];
    const createdAt = messageCreatedAt(message);
    return message.parts.map((part, partIndex) => ({
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
    thread?.source.kind === "agui" ? aguiSyncEntries(thread.messages) : [];
  if (v1 == null && agui.length === 0) return null;
  if (agui.length === 0) return v1;
  return {
    version: 1,
    sessionId,
    updatedAt: thread?.updatedAt ?? v1?.updatedAt ?? "",
    segments: [...(v1?.segments ?? []), ...agui],
  };
};
