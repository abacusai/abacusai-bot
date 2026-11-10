/**
 * The cards under a thread's latest reply (the deliverable offer, the retry
 * offer, the success pitch, the deploy steps). Each claims the space, keyed
 * by the reply it sits under, while it shows. The rating line is the quietest
 * thing there: it shows only while nothing is claimed, and never under the
 * reply right after one that had a card.
 */
import { useEffect, useSyncExternalStore } from "react";

/** One thread's cards, replaced whole on every change. */
export interface TailCards {
  /** A card shows under one of the thread's replies now. */
  claimed: boolean;
  /** Replies that had a card, most recent last. */
  had: readonly string[];
}

const EMPTY: TailCards = { claimed: false, had: [] };
const KEPT_REPLIES = 20;
/** Per thread: how many claims each reply holds now. */
const counts = new Map<string, Map<string, number>>();
const snapshots = new Map<string, TailCards>();
const listeners = new Set<() => void>();

const publish = (threadId: string, had: readonly string[]): void => {
  snapshots.set(threadId, {
    claimed: (counts.get(threadId)?.size ?? 0) > 0,
    had,
  });
  for (const listener of listeners) listener();
};

const claim = (threadId: string, replyId: string): (() => void) => {
  const held = counts.get(threadId) ?? new Map<string, number>();
  counts.set(threadId, held);
  held.set(replyId, (held.get(replyId) ?? 0) + 1);
  const had = snapshots.get(threadId)?.had ?? [];
  publish(
    threadId,
    [...had.filter((id) => id !== replyId), replyId].slice(-KEPT_REPLIES)
  );
  return () => {
    const left = (held.get(replyId) ?? 1) - 1;
    if (left > 0) held.set(replyId, left);
    else held.delete(replyId);
    publish(threadId, snapshots.get(threadId)?.had ?? []);
  };
};

/** While `replyId` is set, a card shows under that reply of `threadId`. */
export const useTailCardClaim = (
  threadId: string,
  replyId: string | null
): void => {
  useEffect(
    () => (replyId == null ? undefined : claim(threadId, replyId)),
    [threadId, replyId]
  );
};

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** `threadId`'s cards: whether one shows now, and which replies had one. */
export const useTailCards = (threadId: string): TailCards => {
  const read = (): TailCards => snapshots.get(threadId) ?? EMPTY;
  return useSyncExternalStore(subscribe, read, read);
};
