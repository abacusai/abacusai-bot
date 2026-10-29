/**
 * Request size: what goes to the model each call stays small enough to send.
 * Images are the one part of a transcript that grows without the context
 * window noticing: pi counts each as about 1,200 tokens, but a screenshot is
 * megabytes of base64, and a long build that looks at its work after every
 * change piles up enough of them that the request is refused for its size
 * long before the window fills. Every later call re-sends the same transcript,
 * so the chat can never answer again.
 *
 * So the images the model is shown are bounded. Past IMAGE_LIMIT (by count or
 * bytes) the oldest become a one-line placeholder until what is kept is down
 * to IMAGE_KEEP; the newest are always shown. Only the request changes: the
 * session keeps every image. Elided images stay elided, so the request's
 * prefix (and the provider's prompt cache) moves once per trim, not per call.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Past either measure the oldest images are elided... */
export const IMAGE_LIMIT = { count: 20, bytes: 12 * 1024 * 1024 };
/** ...until what is kept is within this. */
export const IMAGE_KEEP = { count: 10, bytes: 6 * 1024 * 1024 };

interface ImageBlock {
  type: "image";
  data?: unknown;
  mimeType?: unknown;
}

interface Message {
  role?: unknown;
  toolCallId?: unknown;
  timestamp?: unknown;
  content?: unknown;
}

const isImage = (block: unknown): block is ImageBlock =>
  (block as { type?: unknown } | null)?.type === "image";

const imageBytes = (block: ImageBlock): number =>
  typeof block.data === "string" ? block.data.length : 0;

/**
 * An image's identity across calls. pi hands the hook a fresh copy of the
 * messages every call, so the key is where the image sits, never the object.
 */
const imageKey = (message: Message, index: number): string =>
  `${typeof message.toolCallId === "string" ? message.toolCallId : `${String(message.role)}@${String(message.timestamp)}`}#${index}`;

export const elidedImageText = (block: ImageBlock): string =>
  `[An image (${typeof block.mimeType === "string" ? block.mimeType : "image"}, ` +
  `${Math.max(1, Math.round(imageBytes(block) / 1024))} KB) was here; it is no longer ` +
  `shown, to keep the conversation small enough to send. Open the file again if you ` +
  `need to see it.]`;

export default function (pi: ExtensionAPI) {
  const elided = new Set<string>();

  pi.on("context", (event) => {
    const messages = event.messages as unknown as Message[];
    const shown: Array<{ key: string; bytes: number }> = [];
    for (const message of messages) {
      if (!Array.isArray(message.content)) continue;
      message.content.forEach((block, index) => {
        if (!isImage(block)) return;
        const key = imageKey(message, index);
        if (!elided.has(key)) shown.push({ key, bytes: imageBytes(block) });
      });
    }

    let count = shown.length;
    let bytes = shown.reduce((sum, image) => sum + image.bytes, 0);
    if (count > IMAGE_LIMIT.count || bytes > IMAGE_LIMIT.bytes) {
      // Oldest first; the newest is never elided, whatever its size.
      for (const image of shown.slice(0, -1)) {
        if (count <= IMAGE_KEEP.count && bytes <= IMAGE_KEEP.bytes) break;
        elided.add(image.key);
        count -= 1;
        bytes -= image.bytes;
      }
    }
    if (elided.size === 0) return;

    let changed = false;
    const next = messages.map((message) => {
      if (!Array.isArray(message.content)) return message;
      let touched = false;
      const content = message.content.map((block, index) => {
        if (!isImage(block) || !elided.has(imageKey(message, index)))
          return block;
        touched = true;
        return { type: "text", text: elidedImageText(block) };
      });
      if (!touched) return message;
      changed = true;
      return { ...message, content };
    });
    if (!changed) return;
    return { messages: next as unknown as typeof event.messages };
  });
}
