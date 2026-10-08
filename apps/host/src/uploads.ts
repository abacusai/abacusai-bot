import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, realpath, rename, rm } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { dirname, join, relative, sep } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import { UPLOAD_LIMITS } from "@abacus-ai/contract/contract/files";

export const uploadPath = (batch: string, name: string): string => {
  const parts = name.split("/");
  if (
    !/^[a-zA-Z0-9-]{1,80}$/.test(batch) ||
    !name ||
    parts.length > 32 ||
    parts.some(
      (part) =>
        !part ||
        part === "." ||
        part === ".." ||
        part.includes("\\") ||
        [...part].some((character) => character.charCodeAt(0) < 32)
    )
  )
    throw new Error("invalid-upload-path");
  return join(batch, ...parts);
};

export const streamUpload = async (
  request: IncomingMessage,
  workspace: string,
  batch: string,
  name: string
): Promise<string> => {
  const path = uploadPath(batch, name);
  const root = await realpath(workspace);
  const target = join(root, ".abacusai-bot", "temp", path);
  let parent = root;
  for (const component of relative(root, dirname(target)).split(sep)) {
    const next = join(parent, component);
    await mkdir(next).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
    parent = await realpath(next);
    const inside = relative(root, parent);
    if (
      inside === ".." ||
      inside.startsWith(`..${sep}`) ||
      inside.startsWith(sep)
    )
      throw new Error("outside-root");
  }
  const temporary = join(parent, `.upload-${randomUUID()}`);
  let size = 0;
  try {
    await pipeline(
      request,
      new Transform({
        transform(chunk, _encoding, callback) {
          size += chunk.length;
          callback(
            size > UPLOAD_LIMITS.fileBytes ? new Error("too-large") : null,
            chunk
          );
        },
      }),
      createWriteStream(temporary, { flags: "wx", mode: 0o600 })
    );
    const destination = join(parent, name.split("/").at(-1)!);
    await rename(temporary, destination);
    return destination;
  } finally {
    await rm(temporary, { force: true });
  }
};
