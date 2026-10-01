import { expect, it, vi } from "vitest";

import { writeTerminalData } from "./ghostty";
it("bounds WASM copies without corrupting UTF-8 at the chunk boundary", async () => {
  const data = "a".repeat(32766) + "🦋" + "b".repeat(65536);
  const write = vi.fn();
  await writeTerminalData({ write } as never, data);
  const chunks = write.mock.calls.map(([chunk]) => chunk as Uint8Array);
  expect(chunks.every((chunk) => chunk.length <= 4096)).toBe(true);
  const bytes = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  expect(new TextDecoder().decode(bytes)).toBe(data);
});

it("does not send an empty reconnect snapshot into the WASM allocator", async () => {
  const write = vi.fn();
  await writeTerminalData({ write } as never, "");
  expect(write).not.toHaveBeenCalled();
});
