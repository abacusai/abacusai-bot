import { fakePi } from "@abacus-ai/test-support/fake-pi";
/**
 * The images a request carries are bounded, oldest first, and only in the
 * request: the session's own messages keep every image. Elided images stay
 * elided, so the request's prefix changes once per trim, not on every call.
 */
import { describe, expect, it } from "vitest";

import requestSize, { IMAGE_KEEP, IMAGE_LIMIT } from "./request-size.js";

type Block = { type: string; text?: string; data?: string; mimeType?: string };
type Message = {
  role: string;
  toolCallId?: string;
  timestamp?: number;
  content: Block[] | string;
};

const shot = (id: number, bytes = 1_000): Message => ({
  role: "toolResult",
  toolCallId: `call-${id}`,
  content: [
    { type: "text", text: `Read image file [image/png]` },
    { type: "image", data: "x".repeat(bytes), mimeType: "image/png" },
  ],
});

const guarded = () => {
  const pi = fakePi();
  requestSize(pi.api as never);
  return async (messages: Message[]): Promise<Message[]> => {
    // pi hands the hook a copy every call, as here.
    const result = (await pi.fire("context", {
      messages: structuredClone(messages),
    })) as { messages?: Message[] } | undefined;
    return result?.messages ?? messages;
  };
};

const images = (messages: Message[]): number =>
  messages.flatMap((message) =>
    Array.isArray(message.content)
      ? message.content.filter((block) => block.type === "image")
      : []
  ).length;

const placeholders = (messages: Message[]): number =>
  messages.flatMap((message) =>
    Array.isArray(message.content)
      ? message.content.filter((block) =>
          (block.text ?? "").includes("it is no longer shown")
        )
      : []
  ).length;

describe("the images a request carries", () => {
  it("leaves a request within the limit untouched", async () => {
    const send = guarded();
    const messages = Array.from({ length: IMAGE_LIMIT.count }, (_, i) =>
      shot(i)
    );

    expect(await send(messages)).toBe(messages);
  });

  it("past the count limit, elides the oldest down to the kept number, newest kept", async () => {
    const send = guarded();
    const messages = Array.from({ length: IMAGE_LIMIT.count + 1 }, (_, i) =>
      shot(i)
    );

    const sent = await send(messages);

    expect(images(sent)).toBe(IMAGE_KEEP.count);
    expect(placeholders(sent)).toBe(IMAGE_LIMIT.count + 1 - IMAGE_KEEP.count);
    expect(JSON.stringify(sent.at(-1))).toContain('"type":"image"');
    expect(JSON.stringify(sent[0])).toContain("it is no longer shown");
    // The text beside an image stays.
    expect(JSON.stringify(sent[0])).toContain("Read image file");
  });

  it("past the byte limit, elides by size, even with few images", async () => {
    const send = guarded();
    const big = Math.ceil(IMAGE_LIMIT.bytes / 3);
    const messages = [shot(1, big), shot(2, big), shot(3, big), shot(4, big)];

    const sent = await send(messages);

    expect(images(sent)).toBe(Math.floor(IMAGE_KEEP.bytes / big));
    expect(JSON.stringify(sent.at(-1))).toContain('"type":"image"');
  });

  it("never elides the newest image, however big", async () => {
    const send = guarded();

    const sent = await send([shot(1, IMAGE_LIMIT.bytes + 1)]);

    expect(images(sent)).toBe(1);
  });

  it("keeps what it elided elided, so the prefix moves once per trim", async () => {
    const send = guarded();
    const messages = Array.from({ length: IMAGE_LIMIT.count + 1 }, (_, i) =>
      shot(i)
    );
    const first = await send(messages);

    // One more screenshot: under the limit again, nothing older comes back
    // and nothing else is elided.
    const second = await send([...messages, shot(99)]);

    expect(JSON.stringify(second.slice(0, messages.length))).toBe(
      JSON.stringify(first)
    );
    expect(images(second)).toBe(IMAGE_KEEP.count + 1);
  });

  it("never touches the session's own messages", async () => {
    const pi = fakePi();
    requestSize(pi.api as never);
    const messages = Array.from({ length: IMAGE_LIMIT.count + 1 }, (_, i) =>
      shot(i)
    );
    const before = JSON.stringify(messages);

    await pi.fire("context", { messages });

    expect(JSON.stringify(messages)).toBe(before);
  });
});
