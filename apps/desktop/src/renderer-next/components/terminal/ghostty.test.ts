import { expect, it, vi } from "vitest";

import { terminalTheme, writeTerminalData } from "./ghostty";
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

it("resolves light and dark oklch tokens to Ghostty-supported RGB hex", () => {
  const colors: Record<string, number[]> = {
    "oklch(1 0 0)": [255, 255, 255, 255],
    "oklch(0 0 0)": [0, 0, 0, 255],
  };
  const context = {
    fillStyle: "",
    clearRect: vi.fn(),
    fillRect: vi.fn(),
    getImageData: () => ({ data: colors[context.fillStyle] }),
  };
  const getContext = vi
    .spyOn(HTMLCanvasElement.prototype, "getContext")
    .mockReturnValue(context as never);
  try {
    for (const dark of [false, true]) {
      document.documentElement.classList.toggle("dark", dark);
      document.documentElement.style.setProperty(
        "--background",
        dark ? "oklch(0 0 0)" : "oklch(1 0 0)"
      );
      document.documentElement.style.setProperty(
        "--foreground",
        dark ? "oklch(1 0 0)" : "oklch(0 0 0)"
      );
      expect(terminalTheme()).toEqual({
        background: dark ? "#000000" : "#ffffff",
        foreground: dark ? "#ffffff" : "#000000",
        cursor: dark ? "#ffffff" : "#000000",
      });
    }
  } finally {
    getContext.mockRestore();
  }
});
