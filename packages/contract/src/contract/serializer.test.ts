import { StandardRPCJsonSerializer } from "@orpc/client/standard";
import { describe, expect, it } from "vitest";

import { uint8ArraySerializer } from "./serializer";

const roundTrip = (value: unknown): unknown => {
  const serializer = new StandardRPCJsonSerializer({
    customJsonSerializers: [uint8ArraySerializer],
  });
  const [json, meta] = serializer.serialize(value);
  // Through a real JSON boundary, as the wire does.
  return serializer.deserialize(JSON.parse(JSON.stringify(json)), meta);
};

describe("the Uint8Array serializer (A.6)", () => {
  it("carries bytes as base64 and returns a plain Uint8Array", () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 255]);
    const out = roundTrip({ data: bytes, nested: [{ data: bytes }] }) as {
      data: Uint8Array;
      nested: [{ data: Uint8Array }];
    };

    expect(out.data).toBeInstanceOf(Uint8Array);
    expect(Array.from(out.data)).toEqual([0, 1, 2, 250, 255]);
    expect(Array.from(out.nested[0].data)).toEqual([0, 1, 2, 250, 255]);
  });

  it("takes a Buffer and gives back a Uint8Array, never a Buffer", () => {
    const out = roundTrip(Buffer.from("héllo", "utf8")) as Uint8Array;

    expect(Buffer.isBuffer(out)).toBe(false);
    expect(new TextDecoder().decode(out)).toBe("héllo");
  });

  it("keeps a view's own bytes, not its whole backing buffer", () => {
    const backing = new Uint8Array([9, 9, 1, 2, 3, 9]);
    const out = roundTrip(backing.subarray(2, 5)) as Uint8Array;

    expect(Array.from(out)).toEqual([1, 2, 3]);
  });

  it("round-trips an empty array and a large one", () => {
    expect(Array.from(roundTrip(new Uint8Array()) as Uint8Array)).toEqual([]);
    const large = new Uint8Array(200_000).map((_, i) => i % 256);
    expect(roundTrip(large)).toEqual(large);
  });

  it("refuses a payload that is not base64 text", () => {
    expect(() => uint8ArraySerializer.deserialize(42)).toThrow(TypeError);
  });
});
