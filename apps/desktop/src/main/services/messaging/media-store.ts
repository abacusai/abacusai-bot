/**
 * Media the app produced for a chat (a screenshot, for now), held in memory
 * under a handle the model passes to `send_media`: never written anywhere,
 * gone after `MEDIA_TTL_MS`, and bounded in total so a long run cannot hoard.
 */
import { randomBytes } from "node:crypto";

import {
  checkedImage,
  isMediaId,
  readImageFile,
  type ResolvedMedia,
} from "@abacus-ai/agent/send-media";

export const MEDIA_TTL_MS = 30 * 60_000;
/** Everything held at once; the oldest goes first past it. */
export const MEDIA_STORE_MAX_BYTES = 64 * 1024 * 1024;

interface Held {
  data: Buffer;
  mimeType: "image/jpeg" | "image/png";
  expiresAt: number;
}

export class MediaStore {
  private readonly items = new Map<string, Held>();
  private bytes = 0;

  constructor(private readonly now: () => number = Date.now) {}

  /** A handle for the image, or the reason it cannot be held (too large, not an image). */
  put(data: Buffer): { id: string } | { reason: string } {
    const image = checkedImage(data);
    if (image.ok === false) return { reason: image.reason };
    this.prune();
    for (const oldest of this.items.keys()) {
      if (this.bytes + data.length <= MEDIA_STORE_MAX_BYTES) break;
      this.drop(oldest);
    }
    const id = `media-${randomBytes(12).toString("hex")}`;
    this.items.set(id, {
      data,
      mimeType: image.mimeType,
      expiresAt: this.now() + MEDIA_TTL_MS,
    });
    this.bytes += data.length;
    return { id };
  }

  /** A media id from here, or an image file's absolute path, as bytes to send. */
  resolve(ref: string): ResolvedMedia {
    if (!isMediaId(ref)) return readImageFile(ref);
    this.prune();
    const held = this.items.get(ref);
    return held == null
      ? {
          ok: false,
          reason: "That media id is unknown or expired; take a new one.",
        }
      : { ok: true, data: held.data, mimeType: held.mimeType };
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
