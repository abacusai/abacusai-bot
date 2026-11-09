import type { MessagingPlatformId } from "@abacus-ai/contract/messaging";

import { UndeliverableChatError } from "./connector";

/** The lines a turn the app closed under owes its chat (outcome.channel.*). */
export type OwedLine = "appClosed" | "contactNeutral" | "contactAppClosed";

/** One chat message still owed: it failed every immediate attempt, or was owed from a start. */
export interface OwedMessage {
  /** The message's own id: owed once, sent once, whatever the retries. */
  id: string;
  platform: MessagingPlatformId;
  chatId: string;
  text: string;
  replyContext?: Record<string, string>;
  /** Who it was for, for the notice if it never goes. */
  userName: string | null;
  /** Meant for the user's own chat on the platform, found when it is sent. */
  toSelf?: boolean;
  /**
   * A line worded when it is sent, in place of `text`: one owed from a start,
   * before any words are loaded, reads in the language of the moment it goes.
   */
  say?: OwedLine;
  firstFailedAt: number;
  /** Later attempts made; the immediate ones are not counted. */
  tries: number;
  /** Not tried before this moment (quiet hours); waiting is not a try. */
  notBefore?: number;
  /** Dropped unsent after this moment, with no notice: it would land stale. */
  expiresAt?: number;
  /** A later message with the same key drops this one unsent. */
  replaces?: string;
}

/** What the outbox file holds. */
interface StoredOutbox {
  pending: OwedMessage[];
  /** Ids that went (or were given up on): owing one again is a no-op. */
  done: string[];
  /** The finished ids that never went (dropped, expired, replaced, given up). */
  dropped?: string[];
}

export interface ChatOutboxOptions {
  now: () => number;
  read: () => unknown;
  write: (state: StoredOutbox) => void;
  /** One attempt; true once the platform took it. */
  send: (message: OwedMessage) => Promise<boolean>;
  /**
   * The platform is down until a link comes back (re-scan, reload): an
   * attempt now can only fail, so none is made or counted.
   */
  waitingOnLink?: (platform: MessagingPlatformId) => boolean;
  /** The last attempt failed too: tell the user it never went. */
  giveUp: (message: OwedMessage) => Promise<void>;
}

/**
 * Waits between later attempts, after the immediate ones failed. A message
 * is also tried whenever its platform connects, and after a restart. Past
 * the last wait, or a day old, it is given up on. While its platform waits
 * on a link, only the day counts.
 */
export const OUTBOX_RETRY_MS = [5 * 60_000, 30 * 60_000];
const OUTBOX_MAX_AGE_MS = 24 * 60 * 60_000;
/** Ids of finished messages remembered, so a replay owes none of them again. */
const DONE_KEPT = 500;

/**
 * Chat messages still owed, kept on disk until the platform takes them.
 *
 * Each message has an id: owing an id already pending or already finished
 * does nothing, and one pass runs at a time, so a message is never sent
 * twice by the outbox however its retries, reconnects and restarts overlap.
 */
export class ChatOutbox {
  private readonly pending: OwedMessage[];
  private readonly done: string[];
  private readonly dropped: string[];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private flushing: Promise<void> | null = null;
  /** A pass was asked for while one ran: run another once it ends. */
  private again = false;

  constructor(private readonly options: ChatOutboxOptions) {
    const stored = readStored(options.read());
    this.pending = stored.pending;
    this.done = stored.done;
    this.dropped = stored.dropped ?? [];
  }

  get size(): number {
    return this.pending.length;
  }

  /** Whether anything is owed on the platform. */
  owes(platform: MessagingPlatformId): boolean {
    return this.pending.some((message) => message.platform === platform);
  }

  /**
   * Keep a message to send later, first tried after `delayMs`. False when its
   * id is already owed or already finished.
   */
  owe(message: Omit<OwedMessage, "tries">, delayMs: number): boolean {
    if (this.known(message.id)) return false;
    if (message.replaces != null)
      for (const older of this.pending.filter(
        (entry) => entry.replaces === message.replaces
      ))
        this.finish(older, "dropped");
    this.pending.push({ ...message, tries: 0 });
    this.save();
    this.schedule(delayMs);
    return true;
  }

  /** The message went, or was given up on or dropped. */
  isDone(id: string): boolean {
    return this.done.includes(id);
  }

  /** Where the message `id` stands: still owed, sent, or finished unsent. */
  statusOf(id: string): "queued" | "sent" | "dropped" | null {
    if (this.pending.some((message) => message.id === id)) return "queued";
    if (this.dropped.includes(id)) return "dropped";
    return this.done.includes(id) ? "sent" : null;
  }

  /** Try everything owed after `delayMs` (0: now). */
  schedule(delayMs: number): void {
    if (this.timer != null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, delayMs);
    this.timer.unref?.();
  }

  dispose(): void {
    if (this.timer != null) clearTimeout(this.timer);
    this.timer = null;
  }

  /** One pass over everything owed; what still fails waits longer. */
  flush(): Promise<void> {
    if (this.flushing != null) {
      this.again = true;
      return this.flushing;
    }
    this.flushing = this.pass().finally(() => {
      this.flushing = null;
      if (this.again) {
        this.again = false;
        void this.flush();
      }
    });
    return this.flushing;
  }

  private async pass(): Promise<void> {
    // A copy: messages that go, or are given up on, leave as the pass runs.
    for (const message of this.pending.slice()) {
      const now = this.options.now();
      if (message.expiresAt != null && now > message.expiresAt) {
        this.finish(message, "dropped");
        continue;
      }
      if (message.notBefore != null && now < message.notBefore) continue;
      // Tried when the link is back; the gateway flushes on every connect.
      if (
        this.options.waitingOnLink?.(message.platform) === true &&
        this.options.now() - message.firstFailedAt <= OUTBOX_MAX_AGE_MS
      )
        continue;
      let sent = false;
      try {
        sent = await this.options.send(message);
      } catch (error) {
        // Final, and nobody to tell: dropped. This is also how a message an
        // older build kept for such a chat leaves, on the first pass after a
        // start, before it can reach the wire.
        if (error instanceof UndeliverableChatError) {
          console.error(
            `[messaging] ${message.platform} owed message dropped: ${error.message}`
          );
          this.finish(message, "dropped");
          continue;
        }
        console.error(
          `[messaging] ${message.platform} retry of an undelivered message failed:`,
          error
        );
      }
      if (sent) {
        this.finish(message);
        continue;
      }
      message.tries += 1;
      if (
        message.tries >= OUTBOX_RETRY_MS.length ||
        this.options.now() - message.firstFailedAt > OUTBOX_MAX_AGE_MS
      ) {
        this.finish(message, "dropped");
        await this.options.giveUp(message);
      }
    }
    this.save();
    if (this.pending.length === 0) return;
    const now = this.options.now();
    this.schedule(
      Math.min(
        ...this.pending.map((message) =>
          message.notBefore != null && message.notBefore > now
            ? message.notBefore - now
            : (OUTBOX_RETRY_MS[
                Math.min(message.tries, OUTBOX_RETRY_MS.length - 1)
              ] ?? 0)
        )
      )
    );
  }

  private known(id: string): boolean {
    return (
      this.done.includes(id) ||
      this.pending.some((message) => message.id === id)
    );
  }

  private finish(message: OwedMessage, how: "sent" | "dropped" = "sent"): void {
    const at = this.pending.indexOf(message);
    if (at >= 0) this.pending.splice(at, 1);
    this.done.push(message.id);
    if (this.done.length > DONE_KEPT)
      this.done.splice(0, this.done.length - DONE_KEPT);
    if (how === "dropped") this.dropped.push(message.id);
    // Only ids still remembered as finished.
    while (this.dropped.length > 0 && !this.done.includes(this.dropped[0]!))
      this.dropped.shift();
    this.save();
  }

  private save(): void {
    try {
      this.options.write({
        pending: this.pending,
        done: this.done,
        dropped: this.dropped,
      });
    } catch (error) {
      console.error("[messaging] could not persist the outbox:", error);
    }
  }
}

const readStored = (raw: unknown): StoredOutbox => {
  const value = raw as Partial<StoredOutbox> | null;
  const pending = Array.isArray(value?.pending) ? value.pending : [];
  const done = Array.isArray(value?.done) ? value.done : [];
  const dropped = Array.isArray(value?.dropped) ? value.dropped : [];
  return {
    pending: pending.filter(
      (message): message is OwedMessage =>
        typeof message?.id === "string" && typeof message.chatId === "string"
    ),
    done: done.filter((id): id is string => typeof id === "string"),
    dropped: dropped.filter((id): id is string => typeof id === "string"),
  };
};
