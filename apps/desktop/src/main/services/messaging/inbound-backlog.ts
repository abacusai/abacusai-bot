import type { MessagingPlatformId } from "@abacus-ai/contract/messaging";

import type { BacklogChat } from "./connector";

/**
 * What arrived while a lane was not watching (the app closed, the computer
 * asleep), answered on the next connect. Each lane keeps a watermark: when it
 * was last seen up, and the message ids it already handed over, so a catch-up
 * and the live path never both deliver one message.
 */

/** Catch-up answers only what is this recent; older traffic gets one notice. */
export const BACKLOG_WINDOW_MS = 6 * 60 * 60_000;
/** At most this many chats are answered per catch-up. */
export const BACKLOG_MAX_CHATS = 10;
/** How often a connected lane stamps that it is watching. */
export const SEEN_HEARTBEAT_MS = 60_000;
/** Message ids remembered per lane. */
const SEEN_IDS_KEPT = 500;

interface LaneSeen {
  seenUntil: number;
  ids: string[];
}

type StoredSeen = Partial<Record<MessagingPlatformId, LaneSeen>>;

export class InboundWatermark {
  private readonly lanes: StoredSeen;

  constructor(
    private readonly store: {
      read: () => unknown;
      write: (state: StoredSeen) => void;
    }
  ) {
    this.lanes = readSeen(store.read());
  }

  /** When the lane was last seen up; null before its first connect. */
  seenUntil(platform: MessagingPlatformId): number | null {
    return this.lanes[platform]?.seenUntil ?? null;
  }

  /** Whether the lane already handed this message over. */
  has(platform: MessagingPlatformId, id: string): boolean {
    return this.lanes[platform]?.ids.includes(id) === true;
  }

  /** The lane is up and watching as of `at`. */
  stamp(platform: MessagingPlatformId, at: number): void {
    const lane = this.lane(platform);
    lane.seenUntil = Math.max(lane.seenUntil, at);
    this.save();
  }

  /** These ids were handed over; false for one already known. */
  remember(platform: MessagingPlatformId, id: string): boolean {
    const lane = this.lane(platform);
    if (lane.ids.includes(id)) return false;
    lane.ids.push(id);
    if (lane.ids.length > SEEN_IDS_KEPT)
      lane.ids.splice(0, lane.ids.length - SEEN_IDS_KEPT);
    this.save();
    return true;
  }

  private lane(platform: MessagingPlatformId): LaneSeen {
    return (this.lanes[platform] ??= { seenUntil: 0, ids: [] });
  }

  private save(): void {
    try {
      this.store.write(this.lanes);
    } catch (error) {
      console.error("[messaging] could not keep what the lanes saw:", error);
    }
  }
}

const readSeen = (raw: unknown): StoredSeen => {
  const out: StoredSeen = {};
  if (raw == null || typeof raw !== "object") return out;
  for (const [platform, value] of Object.entries(raw)) {
    const lane = value as Partial<LaneSeen> | null;
    if (typeof lane?.seenUntil !== "number") continue;
    out[platform as MessagingPlatformId] = {
      seenUntil: lane.seenUntil,
      ids: Array.isArray(lane.ids)
        ? lane.ids.filter((id): id is string => typeof id === "string")
        : [],
    };
  }
  return out;
};

/** One chat to answer: its messages since the lane last watched, oldest first. */
export interface CatchUpTurn {
  chat: BacklogChat;
  messages: BacklogChat["messages"];
}

/**
 * Which chats a catch-up answers and how many it only reports. Answered:
 * inside the window, not already handed over, not answered from the phone
 * (newest message the user's own, or a later send in the log), at most
 * `maxChats`. Reported: anything older than the window, past the cap, or
 * never opened.
 */
export const planCatchUp = (input: {
  chats: readonly BacklogChat[];
  now: number;
  known: (id: string) => boolean;
  /** The newest message the app sent to the chat, by the log; null for none. */
  lastSentAt: (chatId: string) => number | null;
  /** Text that already came in on the chat since `since`, by the log. */
  loggedIn: (chatId: string, text: string) => boolean;
  windowMs?: number;
  maxChats?: number;
}): { turns: CatchUpTurn[]; missed: number } => {
  const windowStart = input.now - (input.windowMs ?? BACKLOG_WINDOW_MS);
  const maxChats = input.maxChats ?? BACKLOG_MAX_CHATS;
  const turns: CatchUpTurn[] = [];
  let missed = 0;
  for (const chat of input.chats) {
    if (chat.unread === true) {
      missed += 1;
      continue;
    }
    if (chat.answered) continue;
    const fresh = chat.messages.filter(
      (message) =>
        !input.known(message.id) && !input.loggedIn(chat.chatId, message.text)
    );
    const newest = fresh.at(-1);
    if (newest == null) continue;
    const sent = input.lastSentAt(chat.chatId);
    if (sent != null && sent >= newest.at) continue;
    const recent = fresh.filter((message) => message.at > windowStart);
    if (recent.length === 0 || turns.length >= maxChats) {
      missed += 1;
      continue;
    }
    turns.push({ chat, messages: recent });
  }
  return { turns, missed };
};

/** The late messages as one turn, with a note for the agent of when they came. */
export const foldLate = (
  messages: CatchUpTurn["messages"],
  now: number
): string => {
  const clock = (at: number): string => new Date(at).toTimeString().slice(0, 5);
  const first = messages[0]!.at;
  return [
    `[Arrived at ${clock(first)} while this computer was off or asleep; it is ${clock(now)} now. Answer knowing it is late.]`,
    ...messages.map((message) => message.text),
  ].join("\n");
};
