import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  mkdir,
} from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import { expect, it } from "vitest";

import { streamUpload, uploadPath } from "./uploads";
it("preserves Unicode folders and atomically replaces retried uploads", async () => {
  const root = await mkdtemp(join(tmpdir(), "upload-test-"));
  try {
    const send = (data: string) =>
      streamUpload(
        Readable.from([Buffer.from(data)]) as IncomingMessage,
        root,
        "batch-1",
        "Résumé/nested/a file.txt"
      );
    const path = await send("first");
    await send("retry");
    expect(await readFile(path, "utf8")).toBe("retry");
    expect(
      await readdir(join(root, ".abacusai-bot/temp/batch-1/Résumé/nested"))
    ).toEqual(["a file.txt"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it.each([
  "../escape",
  "/absolute",
  "x/../escape",
  "x//bad",
  "x\\bad",
  "x/\0bad",
  ".",
  "x/.",
])("rejects unsafe upload path %s", (path) => {
  expect(() => uploadPath("batch-1", path)).toThrow("invalid-upload-path");
});
it("refuses escaping symlink parents before creating children", async () => {
  const root = await mkdtemp(join(tmpdir(), "upload-test-"));
  const outside = await mkdtemp(join(tmpdir(), "upload-outside-"));
  try {
    await mkdir(join(root, ".abacusai-bot"));
    await symlink(outside, join(root, ".abacusai-bot/temp"));
    await expect(
      streamUpload(
        Readable.from([Buffer.from("data")]) as IncomingMessage,
        root,
        "batch-1",
        "nested/file.txt"
      )
    ).rejects.toThrow("outside-root");
    expect(await readdir(outside)).toEqual([]);
  } finally {
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(outside, { recursive: true, force: true }),
    ]);
  }
});
it("removes partial files when the source is cancelled", async () => {
  const root = await mkdtemp(join(tmpdir(), "upload-test-"));
  try {
    const source = Readable.from(
      (async function* () {
        yield Buffer.from("partial");
        throw new Error("cancelled");
      })()
    );
    await expect(
      streamUpload(source as IncomingMessage, root, "batch-1", "file.txt")
    ).rejects.toThrow("cancelled");
    expect(await readdir(join(root, ".abacusai-bot/temp/batch-1"))).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
