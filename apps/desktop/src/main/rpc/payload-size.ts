import { setImmediate } from "node:timers/promises";

import { CUSTOM_JSON_SERIALIZERS } from "@abacus-ai/contract/contract/serializer";
import {
  StandardRPCJsonSerializer,
  StandardRPCSerializer,
} from "@orpc/client/standard";

import { openHostFile } from "../services/workspace/host-path";
import { payloadTooLarge } from "./errors";

const serializer = new StandardRPCSerializer(
  new StandardRPCJsonSerializer({
    customJsonSerializers: CUSTOM_JSON_SERIALIZERS,
  })
);

/** Bound work before invoking the synchronous wire serializer. This walk is
 * only an early rejection guard; accepted values are measured from the real
 * serializer output below, including all metadata. Large binary
 * values are counted without allocating base64 or enumerating their bytes.
 * Huge collections yield between batches, and never reach the serializer. */
export const rpcPayloadSize = async (
  value: unknown,
  limit: number
): Promise<number> => {
  let minimum = 0;
  let visited = 0;
  const walk = function* (
    item: unknown,
    depth = 0,
    pathSize = 0,
    undefinedArrayElement = false
  ): Generator<number> {
    if (depth > 64) {
      yield Infinity;
      return;
    }
    if (Number.isNaN(item) || (item === undefined && undefinedArrayElement)) {
      // oRPC emits null plus [type, ...path] for these array/scalar cases.
      yield 4 + pathSize + 4;
      return;
    }
    if (item instanceof Uint8Array) {
      yield 4 * Math.ceil(item.byteLength / 3) + 8 + pathSize;
      return;
    }
    if (typeof item === "string") {
      yield item.length + 2;
      return;
    }
    if (item instanceof Date) {
      yield (Number.isNaN(item.getTime()) ? 4 : 26) + pathSize + 6;
      return;
    }
    if (
      item instanceof URL ||
      item instanceof RegExp ||
      typeof item === "bigint"
    ) {
      yield String(item).length + 8 + pathSize;
      return;
    }
    if (item instanceof Blob) {
      yield item.size;
      return;
    }
    if (item instanceof Map || item instanceof Set || Array.isArray(item)) {
      yield 2;
      if (item instanceof Map || item instanceof Set) yield pathSize + 6;
      let index = 0;
      for (const child of item) {
        if (index > 0) yield 1;
        const childIndex = index++;
        yield* walk(
          child,
          depth + 1,
          pathSize + String(childIndex).length + 1,
          item instanceof Set ||
            (Array.isArray(item) && Object.hasOwn(item, childIndex))
        );
      }
    } else if (item && typeof item === "object") {
      yield 2;
      let first = true;
      for (const key in item) {
        yield key.length + 3 + (first ? 0 : 1);
        first = false;
        yield* walk(
          (item as Record<string, unknown>)[key],
          depth + 1,
          pathSize + Buffer.byteLength(JSON.stringify(key)) + 1
        );
      }
    } else {
      yield 1;
    }
  };
  for (const bytes of walk(value)) {
    minimum += bytes;
    if (minimum > limit) return Infinity;
    if (++visited % 1024 === 0) await setImmediate();
  }
  // Includes the same custom base64 encoding and metadata as the RPC link.
  return Buffer.byteLength(JSON.stringify(serializer.serialize(value)));
};

const FILE_READERS = new Set([
  "files.readText",
  "files.readImageAsDataUrl",
  "files.readPptx",
]);
// Reserve space below the 1 MiB frame for oRPC framing and metadata.
const REPLY_LIMIT = 900 * 1024;

/**
 * Web-host replies and iterator events stay below the socket's frame cap. An
 * oversized one is the defined PAYLOAD_TOO_LARGE with an HTTP alternative;
 * file readers are refused from the file size before anything is read.
 */
export const boundWebHostReply = async <R extends { output: unknown }>(
  procedure: string,
  input: unknown,
  next: () => R | PromiseLike<R>
): Promise<R> => {
  const file = input as
    | { hostRoot?: string; filePath?: string; maxBytes?: number }
    | undefined;
  const tooLarge = () =>
    payloadTooLarge(
      file?.hostRoot && file.filePath
        ? `/files?${new URLSearchParams({ hostRoot: file.hostRoot, path: file.filePath })}`
        : "/files?hostRoot=<workspace>&path=<export-file>"
    );
  if (FILE_READERS.has(procedure) && file?.hostRoot && file.filePath) {
    const opened = await openHostFile(file.filePath, file.hostRoot);
    if (opened.ok) {
      const size =
        procedure === "files.readText"
          ? Math.min(opened.stat.size, file.maxBytes ?? 524288)
          : opened.stat.size;
      const cap =
        procedure === "files.readImageAsDataUrl" ? 675 * 1024 : REPLY_LIMIT;
      if (size > cap) throw tooLarge();
    }
  }
  const result = await next();
  const check = async (value: unknown) => {
    if ((await rpcPayloadSize(value, REPLY_LIMIT)) > REPLY_LIMIT)
      throw tooLarge();
    return value;
  };
  const output = result.output;
  if (output && typeof output === "object" && Symbol.asyncIterator in output) {
    const inner = output as AsyncIterable<unknown>;
    return {
      ...result,
      output: (async function* () {
        for await (const value of inner) yield await check(value);
      })(),
    };
  }
  await check(output);
  return result;
};
