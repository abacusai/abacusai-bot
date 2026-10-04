import { setImmediate } from "node:timers/promises";

import { CUSTOM_JSON_SERIALIZERS } from "@abacus-ai/contract/contract/serializer";
import {
  StandardRPCJsonSerializer,
  StandardRPCSerializer,
} from "@orpc/client/standard";

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
