/**
 * `Uint8Array` (and so Node's `Buffer`, a subclass) across the RPC JSON
 * serializer, which has no built-in for it (spec 00 A.6). Registered on both
 * the handler and the link; base64 on the wire and a plain `Uint8Array` on the
 * other side, because the renderer has no `Buffer`.
 */
import type { StandardRPCCustomJsonSerializer } from "@orpc/client/standard";

interface NodeBufferLike {
  from(
    data: ArrayBufferLike,
    offset: number,
    length: number
  ): { toString(encoding: "base64"): string };
  from(data: string, encoding: "base64"): Uint8Array;
}

/** Node's Buffer when there is one: an order of magnitude faster than btoa. */
const nodeBuffer = (): NodeBufferLike | undefined =>
  (globalThis as { Buffer?: NodeBufferLike }).Buffer;

const BASE64_CHUNK = 0x8000;

const toBase64 = (bytes: Uint8Array): string => {
  const buffer = nodeBuffer();
  if (buffer != null)
    return buffer
      .from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      .toString("base64");

  let binary = "";
  for (let index = 0; index < bytes.length; index += BASE64_CHUNK) {
    binary += String.fromCharCode(
      ...bytes.subarray(index, index + BASE64_CHUNK)
    );
  }
  return btoa(binary);
};

const fromBase64 = (encoded: string): Uint8Array => {
  const buffer = nodeBuffer();
  if (buffer != null) {
    const decoded = buffer.from(encoded, "base64");
    // A plain Uint8Array over the same bytes, never a Buffer, so both sides
    // see the same type.
    return new Uint8Array(
      decoded.buffer,
      decoded.byteOffset,
      decoded.byteLength
    );
  }

  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1)
    bytes[index] = binary.charCodeAt(index);
  return bytes;
};

/** Custom type ids start at 100, clear of oRPC's built-ins (0..7). */
export const UINT8ARRAY_SERIALIZER_TYPE = 100;

export const uint8ArraySerializer: StandardRPCCustomJsonSerializer = {
  type: UINT8ARRAY_SERIALIZER_TYPE,
  condition: (data) => data instanceof Uint8Array,
  serialize: (data: Uint8Array) => toBase64(data),
  deserialize: (serialized: unknown) => {
    if (typeof serialized !== "string")
      throw new TypeError("a Uint8Array arrives as a base64 string");
    return fromBase64(serialized);
  },
};

/** What both RPCHandler and RPCLink pass as `customJsonSerializers`. */
export const CUSTOM_JSON_SERIALIZERS: StandardRPCCustomJsonSerializer[] = [
  uint8ArraySerializer,
];
