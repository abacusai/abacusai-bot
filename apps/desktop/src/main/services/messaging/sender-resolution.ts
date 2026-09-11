/**
 * Turn "reply to Alex" into an actual sender. Pure so the matching rules are
 * testable without a gateway. Exact matches beat substring matches, and an
 * ambiguous name is reported rather than guessed: approving the wrong person
 * hands them an auto-replying account.
 */
import type { MessagingPlatformId } from "#shared/messaging";

export interface SenderCandidate {
  platform: MessagingPlatformId;
  /** What inbound gating compares against — the sender's id, not the chat's. */
  userId: string;
  chatId: string;
  name: string;
}

export type SenderResolution =
  | { kind: "match"; candidate: SenderCandidate }
  | { kind: "none" }
  | { kind: "ambiguous"; candidates: SenderCandidate[] };

const MAX_AMBIGUOUS_LISTED = 6;

export const resolveSender = (
  rows: SenderCandidate[],
  query: string
): SenderResolution => {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return { kind: "none" };

  // One row per sender; later rows win, so callers put the pairing store last:
  // its userId came from a real inbound message, which beats an address book.
  const bySender = new Map<string, SenderCandidate>();
  for (const row of rows) bySender.set(`${row.platform}:${row.userId}`, row);
  const all = [...bySender.values()];

  const exact = all.filter(
    (row) =>
      row.name.toLowerCase() === q ||
      row.userId.toLowerCase() === q ||
      row.chatId.toLowerCase() === q
  );
  const picked =
    exact.length > 0
      ? exact
      : all.filter((row) => row.name.toLowerCase().includes(q));

  if (picked.length === 0) return { kind: "none" };
  if (picked.length === 1) return { kind: "match", candidate: picked[0] };

  return {
    kind: "ambiguous",
    candidates: picked.slice(0, MAX_AMBIGUOUS_LISTED),
  };
};
