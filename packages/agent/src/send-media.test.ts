/**
 * Media for the chat: what `send_media` accepts, checked by the bytes, and
 * the same check the app makes before anything leaves the computer.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { buildSendMediaTool } from "./send-media-tool.js";
import { MEDIA_MAX_BYTES, readImageFile } from "./send-media.js";

const dir = mkdtempSync(path.join(os.tmpdir(), "send-media-"));
const file = (name: string, data: Buffer): string => {
  const full = path.join(dir, name);
  writeFileSync(full, data);
  return full;
};
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const send = async (params: Record<string, unknown>) => {
  const result = await buildSendMediaTool().execute("call-1", params);
  return { text: result.content[0]!.text, isError: result.isError === true };
};

describe("send_media", () => {
  it("takes a media id, or the path of a JPEG or PNG", async () => {
    expect(
      await send({ media: "media-0123456789abcdef0123", caption: "Here" })
    ).toEqual({ text: "Sent.", isError: false });
    expect(await send({ media: file("page.png", PNG) })).toEqual({
      text: "Sent.",
      isError: false,
    });
    expect(
      await send({ media: file("page.jpg", JPEG), when: "with_answer" })
    ).toEqual({ text: "It goes with your answer.", isError: false });
  });

  it("refuses what is not an image by its bytes, whatever its name", async () => {
    const secret = file(
      "passwords.jpg",
      Buffer.from("user: me\npass: hunter2")
    );
    const result = await send({ media: secret });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("not a JPEG or PNG");
    expect(result.text).not.toContain("hunter2");
  });

  it("refuses a relative path, a missing file, an oversized image and a bad when", async () => {
    expect((await send({ media: "page.png" })).isError).toBe(true);
    expect((await send({ media: path.join(dir, "gone.png") })).isError).toBe(
      true
    );
    const big = file(
      "big.jpg",
      Buffer.concat([JPEG, Buffer.alloc(MEDIA_MAX_BYTES)])
    );
    expect(readImageFile(big)).toEqual({
      ok: false,
      reason: "The image is larger than 5 MB.",
    });
    expect(
      (await send({ media: "media-0123456789abcdef0123", when: "later" }))
        .isError
    ).toBe(true);
  });
});
