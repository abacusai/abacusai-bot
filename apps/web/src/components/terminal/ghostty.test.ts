import type { GhosttyCell, Terminal } from "ghostty-web";
import { describe, expect, it, vi } from "vitest";

import { LOOK_EVENT } from "#renderer/lib/theme";

import {
  installTerminalTheme,
  terminalFont,
  terminalTheme,
  writeTerminalData,
} from "./ghostty";
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
    getImageData: () => {
      const n = Number.parseInt(context.fillStyle.slice(1), 16);
      return {
        data: colors[context.fillStyle] ?? [
          n >> 16,
          (n >> 8) & 255,
          n & 255,
          255,
        ],
      };
    },
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
      expect(terminalTheme()).toMatchObject({
        background: dark ? "#000000" : "#ffffff",
        foreground: dark ? "#ffffff" : "#000000",
        cursor: dark ? "#ffffff" : "#000000",
      });
    }
  } finally {
    getContext.mockRestore();
  }
});

it("takes the selection and the 16 ANSI colours from a theme's --term-* tokens", () => {
  const context = {
    fillStyle: "",
    clearRect: vi.fn(),
    fillRect: vi.fn(),
    getImageData: () => {
      const n = Number.parseInt(context.fillStyle.slice(1), 16);
      return { data: [n >> 16, (n >> 8) & 255, n & 255, 255] };
    },
  };
  const getContext = vi
    .spyOn(HTMLCanvasElement.prototype, "getContext")
    .mockReturnValue(context as never);
  const style = document.documentElement.style;
  try {
    style.setProperty("--background", "#101010");
    style.setProperty("--foreground", "#eeeeee");
    // Unset tokens: Ghostty's own palette, its own selection.
    expect(terminalTheme().red).toBe("#cd3131");
    expect(terminalTheme().selectionBackground).toBeUndefined();
    for (let i = 0; i < 16; i++)
      style.setProperty(
        `--term-${i}`,
        `#0000${i.toString(16).padStart(2, "0")}`
      );
    style.setProperty("--term-selection", "#334455");
    expect(terminalTheme()).toMatchObject({
      background: "#101010",
      selectionBackground: "#334455",
      selectionForeground: "#eeeeee",
      black: "#000000",
      red: "#000001",
      white: "#000007",
      brightBlack: "#000008",
      brightWhite: "#00000f",
    });
  } finally {
    getContext.mockRestore();
    document.documentElement.removeAttribute("style");
  }
});

it("follows the code font and runs one px over the code size", () => {
  const style = document.documentElement.style;
  expect(terminalFont()).toEqual({
    fontFamily:
      '"JetBrains Mono Variable", "Symbols Nerd Font Mono", monospace',
    fontSize: 13,
  });
  style.setProperty("--chat-font-mono", '"Menlo", monospace');
  style.setProperty("--code-font-size", "14px");
  try {
    expect(terminalFont()).toEqual({
      fontFamily: '"Menlo", "Symbols Nerd Font Mono", monospace',
      fontSize: 15,
    });
  } finally {
    document.documentElement.removeAttribute("style");
  }
});

describe("installTerminalTheme", () => {
  const hexContext = () => {
    const context = {
      fillStyle: "",
      clearRect: vi.fn(),
      fillRect: vi.fn(),
      getImageData: () => {
        const n = Number.parseInt(context.fillStyle.slice(1), 16);
        return { data: [n >> 16, (n >> 8) & 255, n & 255, 255] };
      },
    };
    return vi
      .spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockReturnValue(context as never);
  };
  const style = () => document.documentElement.style;
  /** A theme: fg, bg and ANSI 0–15 as `#rrggbb`. */
  const setTheme = (fg: string, bg: string, ansi: (i: number) => string) => {
    style().setProperty("--foreground", fg);
    style().setProperty("--background", bg);
    for (let i = 0; i < 16; i++) style().setProperty(`--term-${i}`, ansi(i));
    document.dispatchEvent(new Event(LOOK_EVENT));
  };
  const cell = (fg: number, bg: number, flags = 0): GhosttyCell => ({
    codepoint: 65,
    fg_r: fg >> 16,
    fg_g: (fg >> 8) & 255,
    fg_b: fg & 255,
    bg_r: bg >> 16,
    bg_g: (bg >> 8) & 255,
    bg_b: bg & 255,
    flags,
    width: 1,
    hyperlink_id: 0,
    grapheme_len: 0,
  });
  const hex = (c: GhosttyCell, side: "fg" | "bg") =>
    "#" +
    [c[`${side}_r`], c[`${side}_g`], c[`${side}_b`]]
      .map((v) => v.toString(16).padStart(2, "0"))
      .join("");

  const fakeTerminal = () => {
    const painted: GhosttyCell[][] = [];
    const renderer = {
      renderLine: (cells: GhosttyCell[]) => {
        painted.push(cells);
      },
      setTheme: vi.fn(),
      render: vi.fn(),
    };
    const terminal = {
      options: { scrollback: 500, ...terminalFont() } as Record<
        string,
        unknown
      >,
      buildWasmConfig: () => undefined,
      renderer: undefined as unknown,
      wasmTerm: {},
      getViewportY: () => 0,
    };
    return { terminal, renderer, painted };
  };

  it("hands the WASM sentinels and paints them with the current theme, round trips included", () => {
    const getContext = hexContext();
    const { terminal, renderer, painted } = fakeTerminal();
    try {
      // Theme A: the foreground and ANSI black share an RGB (a light theme).
      setTheme("#1d2a22", "#f6faf6", (i) =>
        i === 0 ? "#1d2a22" : `#a0000${i.toString(16)}`
      );
      const refit = vi.fn();
      const { dispose } = installTerminalTheme(
        terminal as unknown as Terminal,
        () => {
          terminal.renderer = renderer;
        },
        refit
      );
      const config = (
        terminal as unknown as { buildWasmConfig(): Record<string, unknown> }
      ).buildWasmConfig() as {
        fgColor: number;
        bgColor: number;
        palette: number[];
        scrollbackLimit: number;
      };
      expect(config.scrollbackLimit).toBe(500);
      expect(
        new Set([config.fgColor, config.bgColor, ...config.palette]).size
      ).toBe(18);
      const line = [
        cell(config.fgColor, config.bgColor), // default text
        cell(config.palette[0]!, config.bgColor), // ANSI black text
        cell(config.palette[1]!, config.palette[4]!), // red on blue
        cell(0x1d2a22, 0x000000), // truecolour equal to A's foreground
        cell(config.fgColor, config.bgColor, 16), // inverse default
      ];
      const draw = () => {
        (
          renderer.renderLine as (
            c: GhosttyCell[],
            y: number,
            n: number
          ) => void
        )(line, 0, 5);
        return painted.at(-1)!;
      };
      let out = draw();
      expect(out.map((c) => hex(c, "fg"))).toEqual([
        "#1d2a22",
        "#1d2a22",
        "#a00001",
        "#1d2a22",
        "#1d2a22",
      ]);
      expect(hex(out[0]!, "bg")).toBe("#000000"); // the line's own background
      expect(hex(out[2]!, "bg")).toBe("#a00004");
      expect(hex(out[4]!, "bg")).toBe("#f6faf6"); // inverse: drawn as text
      // Theme B: text and ANSI black part ways; truecolour stays put.
      setTheme("#d9e8dd", "#121a15", (i) => `#b0000${i.toString(16)}`);
      out = draw();
      expect(out.map((c) => hex(c, "fg"))).toEqual([
        "#d9e8dd",
        "#b00000",
        "#b00001",
        "#1d2a22",
        "#d9e8dd",
      ]);
      expect(renderer.setTheme).toHaveBeenCalledTimes(2);
      // Back to A: every role is A's again.
      setTheme("#1d2a22", "#f6faf6", (i) =>
        i === 0 ? "#1d2a22" : `#a0000${i.toString(16)}`
      );
      expect(draw().map((c) => hex(c, "fg"))).toEqual([
        "#1d2a22",
        "#1d2a22",
        "#a00001",
        "#1d2a22",
        "#1d2a22",
      ]);
      // An unrelated style write repaints nothing.
      const calls = renderer.setTheme.mock.calls.length;
      document.dispatchEvent(new Event(LOOK_EVENT));
      expect(renderer.setTheme).toHaveBeenCalledTimes(calls);
      expect(refit).not.toHaveBeenCalled();
      // A code-font change refits columns and rows (and the PTY).
      style().setProperty("--code-font-size", "15px");
      document.dispatchEvent(new Event(LOOK_EVENT));
      expect(terminal.options.fontSize).toBe(16);
      expect(refit).toHaveBeenCalledTimes(1);
      dispose();
      style().setProperty("--code-font-size", "11px");
      document.dispatchEvent(new Event(LOOK_EVENT));
      expect(refit).toHaveBeenCalledTimes(1);
    } finally {
      getContext.mockRestore();
      document.documentElement.removeAttribute("style");
    }
  });
});
