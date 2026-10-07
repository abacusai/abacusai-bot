/**
 * What `send_media` accepts: a media id and nothing else, read through the
 * same check the app makes before anything leaves the computer.
 */
import { describe, expect, it } from "vitest";

import { buildSendMediaTool } from "./send-media-tool.js";
import { checkedImage, MEDIA_MAX_BYTES, parseSendMedia } from "./send-media.js";

const ID = "media-0123456789abcdef0123";
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);

const send = async (params: Record<string, unknown>) => {
  const result = await buildSendMediaTool().execute("call-1", params);
  return { text: result.content[0]!.text, isError: result.isError === true };
};

describe("send_media", () => {
  it("takes a media id, now or with the answer", async () => {
    expect(await send({ media: ID, caption: "Here" })).toEqual({
      text: "Sent.",
      isError: false,
    });
    expect(await send({ media: ID, when: "with_answer" })).toEqual({
      text: "It goes with your answer.",
      isError: false,
    });
  });

  it("refuses a path, however it is written, and anything that is not a media id", async () => {
    for (const media of [
      "/home/user/.abacusai-bot/temp/screenshot-1.jpg",
      "./page.png",
      "media-../../etc/passwd",
      "",
    ]) {
      const result = await send({ media });
      expect(result.isError).toBe(true);
      expect(result.text).toContain("media id");
    }
  });

  it("refuses a long caption and an unknown when, the same way the app reads them", async () => {
    const long = { media: ID, caption: "x".repeat(501) };
    expect((await send(long)).isError).toBe(true);
    expect(parseSendMedia(long).ok).toBe(false);
    const later = { media: ID, when: "later" };
    expect((await send(later)).isError).toBe(true);
    expect(parseSendMedia(later).ok).toBe(false);
  });

  it("holds only JPEG or PNG bytes, up to 5 MB", () => {
    expect(checkedImage(JPEG)).toMatchObject({
      ok: true,
      mimeType: "image/jpeg",
    });
    expect(checkedImage(Buffer.from("user: me\npass: hunter2"))).toEqual({
      ok: false,
      reason: "The data is not a JPEG or PNG image.",
    });
    expect(
      checkedImage(Buffer.concat([JPEG, Buffer.alloc(MEDIA_MAX_BYTES)]))
    ).toEqual({ ok: false, reason: "The image is larger than 5 MB." });
  });
});
