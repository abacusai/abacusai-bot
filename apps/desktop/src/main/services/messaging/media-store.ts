/**
 * Media the app produced for a chat, held in memory under a handle the model
 * passes to `send_media`. The one way an image reaches a chat: whatever goes
 * in was made by the app for that purpose (a screenshot through
 * `captureMasked`, so with secret fields hidden), never a file named by path.
 *
 * Each item belongs to the session that made it, and resolves only for that
 * session: a handle seen by another session sends nothing. A browser
 * sub-agent calls the browser tools as its parent session, so its
 * screenshots are its parent's. Never written anywhere, gone after
 * `MEDIA_TTL_MS`, and bounded in total so a long run cannot hoard.
 */
import { randomBytes } from "node:crypto";

import {
  checkedImage,
  isMediaId,
  type MediaMimeType,
  type ResolvedMedia,
} from "@abacus-ai/agent/send-media";

export const MEDIA_TTL_MS = 30 * 60_000;
/** Everything held at once; the oldest goes first past it. */
export const MEDIA_STORE_MAX_BYTES = 64 * 1024 * 1024;

interface Held {
  sessionId: string;
  data: Buffer;
  mimeType: MediaMimeType;
  expiresAt: number;
}

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
    const image = checkedImage(data);
    if (image.ok === false) return { reason: image.reason };
    this.prune();
    for (const oldest of this.items.keys()) {
      if (this.bytes + data.length <= MEDIA_STORE_MAX_BYTES) break;
      this.drop(oldest);
    }
    const id = `media-${randomBytes(12).toString("hex")}`;
    this.items.set(id, {
      sessionId,
      data,
      mimeType: image.mimeType,
      expiresAt: this.now() + MEDIA_TTL_MS,
    });
    this.bytes += data.length;
    return { id };
  }

  /** The bytes behind a media id, for the session that holds it and no other. */
  resolve(ref: string, sessionId: string): ResolvedMedia {
    if (!isMediaId(ref)) return UNKNOWN;
    this.prune();
    const held = this.items.get(ref);
    // Another session's id reads exactly like an unknown one.
    if (held == null || held.sessionId !== sessionId) return UNKNOWN;
    return { ok: true, data: held.data, mimeType: held.mimeType };
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
    this.bytes -= held.data.length;
  }
}
