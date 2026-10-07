/**
 * Media for a chat, held in memory under a handle the model passes to
 * `send_media`. The one way an image or file reaches a chat: what goes in is
 * a screenshot through `captureMasked` (secret fields hidden), or a file the
 * model handed over with `present_deliverable`; `send_media` itself never
 * takes a path.
 *
 * Each item belongs to the session that made it, and resolves only for that
 * session: a handle seen by another session sends nothing. A browser
 * sub-agent calls the browser tools as its parent session, so its
 * screenshots are its parent's. Never written anywhere, gone after
 * `MEDIA_TTL_MS`, and bounded in total so a long run cannot hoard.
 */
import { randomBytes } from "node:crypto";

import {
  checkedDocument,
  checkedImage,
  checkedImageFile,
  isMediaId,
  type ResolvedMedia,
} from "@abacus-ai/agent/send-media";

export const MEDIA_TTL_MS = 30 * 60_000;
/** Everything held at once; the oldest goes first past it. */
export const MEDIA_STORE_MAX_BYTES = 64 * 1024 * 1024;
/** What may wait to go with one answer, per session; refused past it. */
export const MEDIA_PINNED_MAX_BYTES = 48 * 1024 * 1024;

interface Held {
  sessionId: string;
  media: Extract<ResolvedMedia, { ok: true }>;
  expiresAt: number;
  /** Waiting to go with an answer: never evicted for room, only by age. */
  pinned: boolean;
}

const IMAGE_NAME = /\.(png|jpe?g|webp)$/i;

const UNKNOWN: ResolvedMedia = {
  ok: false,
  reason: "That media id is unknown or expired; take a new one.",
};

export class MediaStore {
  private readonly items = new Map<string, Held>();
  private bytes = 0;

  constructor(private readonly now: () => number = Date.now) {}

  /** A handle for the image, held for `sessionId`, or why it cannot be held. */
  put(sessionId: string, data: Buffer): { id: string } | { reason: string } {
    return this.hold(sessionId, checkedImage(data));
  }

  /**
   * A file as an image when it is one, else as a document under its name;
   * pinned, since it goes with the answer, until `unpin`.
   */
  putFile(
    sessionId: string,
    data: Buffer,
    filename: string
  ): { id: string } | { reason: string } {
    const image = checkedImageFile(data);
    // An image file that cannot go as one says why, not "not a document".
    return this.hold(
      sessionId,
      image.ok || IMAGE_NAME.test(filename)
        ? image
        : checkedDocument(data, filename),
      true
    );
  }

  private hold(
    sessionId: string,
    media: ResolvedMedia,
    pinned = false
  ): { id: string } | { reason: string } {
    if (media.ok === false) return { reason: media.reason };
    const size = media.data.length;
    this.prune();
    if (pinned && this.pinnedBytes(sessionId) + size > MEDIA_PINNED_MAX_BYTES)
      return {
        reason:
          "more than 48 MB would go with this answer; send fewer or smaller files.",
      };
    for (const [id, held] of this.items) {
      if (this.bytes + size <= MEDIA_STORE_MAX_BYTES) break;
      if (!held.pinned) this.drop(id);
    }
    if (this.bytes + size > MEDIA_STORE_MAX_BYTES)
      return {
        reason: "too much is waiting to be sent right now; try again shortly.",
      };
    const id = `media-${randomBytes(12).toString("hex")}`;
    this.items.set(id, {
      sessionId,
      media,
      expiresAt: this.now() + MEDIA_TTL_MS,
      pinned,
    });
    this.bytes += size;
    return { id };
  }

  /** Holds `ref` against eviction until it is sent; the session's own only. */
  pin(ref: string, sessionId: string): void {
    const held = this.items.get(ref);
    if (held?.sessionId === sessionId) held.pinned = true;
  }

  /** The answer went (or was dropped): `ref` may be evicted again. */
  unpin(ref: string, sessionId: string): void {
    const held = this.items.get(ref);
    if (held?.sessionId === sessionId) held.pinned = false;
  }

  private pinnedBytes(sessionId: string): number {
    let total = 0;
    for (const held of this.items.values())
      if (held.pinned && held.sessionId === sessionId)
        total += held.media.data.length;
    return total;
  }

  /** The bytes behind a media id, for the session that holds it and no other. */
  resolve(ref: string, sessionId: string): ResolvedMedia {
    if (!isMediaId(ref)) return UNKNOWN;
    this.prune();
    const held = this.items.get(ref);
    // Another session's id reads exactly like an unknown one.
    if (held == null || held.sessionId !== sessionId) return UNKNOWN;
    return held.media;
  }

  private prune(): void {
    const now = this.now();
    for (const [id, held] of this.items)
      if (held.expiresAt <= now) this.drop(id);
  }

  private drop(id: string): void {
    const held = this.items.get(id);
    if (held == null) return;
    this.items.delete(id);
    this.bytes -= held.media.data.length;
  }
}
