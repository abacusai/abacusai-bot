import { CUSTOM_JSON_SERIALIZERS } from "@abacus-ai/contract/contract/serializer";
import {
  StandardRPCJsonSerializer,
  StandardRPCSerializer,
} from "@orpc/client/standard";
import { expect, it } from "vitest";

import { rpcPayloadSize } from "#main/rpc/payload-size";

it.each([
  ["Uint8Array", (size: number) => new Uint8Array(size)],
  ["Buffer", (size: number) => Buffer.alloc(size)],
] as const)("measures %s at its base64 wire size", async (_name, bytes) => {
  const value = { data: bytes(300 * 1024) };
  const serializer = new StandardRPCSerializer(
    new StandardRPCJsonSerializer({
      customJsonSerializers: CUSTOM_JSON_SERIALIZERS,
    })
  );
  const size = await rpcPayloadSize(value, 900 * 1024);
  expect(size).toBe(
    Buffer.byteLength(JSON.stringify(serializer.serialize(value)))
  );
  expect(size).toBeLessThan(410 * 1024);
});
it("rejects huge binary before serialization and yields while scanning collections", async () => {
  expect(
    await rpcPayloadSize({ data: new Uint8Array(40 * 1024 * 1024) }, 900 * 1024)
  ).toBe(Infinity);
  let ticked = false;
  const timer = setImmediate(() => {
    ticked = true;
  });
  try {
    expect(
      await rpcPayloadSize(
        Array.from({ length: 400000 }, () => "abcd"),
        900 * 1024
      )
    ).toBe(Infinity);
    expect(ticked).toBe(true);
  } finally {
    clearImmediate(timer);
  }
});

it("bounds serializer metadata before expanding repeated long paths", async () => {
  const value = {
    ["x".repeat(100000)]: Array.from({ length: 1000 }, () => new Uint8Array()),
  };
  expect(await rpcPayloadSize(value, 900 * 1024)).toBe(Infinity);
});
