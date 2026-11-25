import { Ghostty, Terminal, FitAddon, type GhosttyCell } from "ghostty-web";

import { STOCK_ANSI } from "#renderer/lib/look";
import { LOOK_EVENT } from "#renderer/lib/theme";

// ghostty-web 0.4.0's wasm with an upstream Ghostty fix (ghostty-vt/README.md).
import wasmUrl from "./ghostty-vt/ghostty-vt.wasm?url";
// A WASM instance per screen (a few MB, freed with it): Ghostty expects new
// pages zeroed, and a shared instance hands a new screen a closed one's
// memory.
export const ghosttyReady = (): Promise<Ghostty> => Ghostty.load(wasmUrl);
/** Empty the terminal onto fresh memory, for the same reason. */
export const resetTerminal = async (terminal: Terminal): Promise<void> => {
  const ghostty = await ghosttyReady();
  (terminal as unknown as { ghostty: Ghostty }).ghostty = ghostty;
  terminal.reset();
};
export { Terminal, FitAddon };
/** Adapter for the installed 0.4.0; same-size resize deliberately does not paint. */
export const repaint = (terminal: Terminal): void => {
  const internals = terminal as unknown as {
    wasmTerm: Parameters<NonNullable<Terminal["renderer"]>["render"]>[0];
    getViewportY(): number;
  };
  if (
    !terminal.renderer ||
    !internals.wasmTerm ||
    typeof internals.getViewportY !== "function"
  ) {
    if (import.meta.env.DEV)
      throw new Error("ghostty-web 0.4.0 repaint shape changed");
    return;
  }
  terminal.renderer.render(
    internals.wasmTerm,
    true,
    internals.getViewportY(),
    terminal
  );
};

const ANSI_KEYS = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
];
const ANSI_NAMES = [
  ...ANSI_KEYS,
  ...ANSI_KEYS.map((name) => `bright${name[0]!.toUpperCase()}${name.slice(1)}`),
];

export type TerminalTheme = Record<string, string> & {
  background: string;
  foreground: string;
  cursor: string;
};

/**
 * The terminal's colours from the look's tokens (lib/look.ts): fg/bg, the
 * cursor, the selection (`--term-selection`, with the foreground on it) and
 * each ANSI colour (`--term-0…15`), Ghostty's own where a token is unset.
 * Ghostty accepts hex/rgb; CSS tokens may be oklch, so each is resolved by
 * the browser through a canvas.
 */
export const terminalTheme = (): TerminalTheme => {
  const css = getComputedStyle(document.documentElement);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext("2d");
  const dark = document.documentElement.classList.contains("dark");
  const read = (key: string, fallback: string) => {
    if (!ctx) return fallback;
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = fallback;
    ctx.fillRect(0, 0, 1, 1);
    ctx.fillStyle = css.getPropertyValue(key).trim() || fallback;
    ctx.fillRect(0, 0, 1, 1);
    return (
      "#" +
      [...ctx.getImageData(0, 0, 1, 1).data]
        .slice(0, 3)
        .map((value) => value.toString(16).padStart(2, "0"))
        .join("")
    );
  };
  const foreground = read("--foreground", dark ? "#fafafa" : "#0a0a0a");
  const background = read("--background", dark ? "#0a0a0a" : "#ffffff");
  const theme: TerminalTheme = { background, foreground, cursor: foreground };
  if (css.getPropertyValue("--term-selection").trim()) {
    theme.selectionBackground = read("--term-selection", foreground);
    theme.selectionForeground = foreground;
  }
  ANSI_NAMES.forEach((name, i) => {
    theme[name] = read(`--term-${i}`, STOCK_ANSI[dark ? "dark" : "light"][i]!);
  });
  return theme;
};

/** The code font (Appearance) and one px over the code size, as before. */
export const terminalFont = (): { fontFamily: string; fontSize: number } => {
  const css = getComputedStyle(document.documentElement);
  const mono =
    css.getPropertyValue("--chat-font-mono").trim() ||
    '"JetBrains Mono Variable", monospace';
  return {
    fontFamily: mono.replace(/,/, ', "Symbols Nerd Font Mono",'),
    fontSize:
      (Number.parseInt(css.getPropertyValue("--code-font-size"), 10) || 12) + 1,
  };
};

/** Bound the WASM copy and preserve UTF-8 across writes, including retained tails. */
export const writeTerminalData = async (
  terminal: Pick<Terminal, "write">,
  data: string,
  signal?: AbortSignal
): Promise<void> => {
  if (!data) return;
  const bytes = new TextEncoder().encode(data);
  if (bytes.length <= 4096) {
    terminal.write(data);
    return;
  }
  for (let offset = 0; offset < bytes.length; offset += 4096) {
    signal?.throwIfAborted();
    terminal.write(bytes.subarray(offset, offset + 4096));
    if (offset % 32768 === 28672)
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
};

/**
 * Copied text as it was printed: no space for a wide character's spacer
 * cell, no line break at a soft wrap. A row on screen says whether it
 * continues the one above; a scrollback row followed by another is taken as
 * wrapped when filled to its last column. Selecting does not write the
 * clipboard (copying is Copy, or Ctrl/⌘+Shift+C); a triple click selects
 * the row.
 */
export const fixSelectionText = (terminal: Terminal): void => {
  type Cell = { codepoint: number; width: number; grapheme_len: number };
  const internals = terminal as unknown as {
    selectionManager?: {
      selectionStart: { col: number; absoluteRow: number } | null;
      selectionEnd: { col: number; absoluteRow: number } | null;
      getSelection(): string;
      copyToClipboard?(text: string): Promise<void>;
      pixelToCell?(x: number, y: number): { col: number; row: number };
      viewportRowToAbsolute?(row: number): number;
      requestRender?(): void;
    };
    wasmTerm?: {
      getScrollbackLength(): number;
      getScrollbackLine(row: number): Cell[] | null;
      getLine(row: number): Cell[] | null;
      getScrollbackGraphemeString(row: number, col: number): string;
      getGraphemeString(row: number, col: number): string;
      isRowWrapped(row: number): boolean;
    };
  };
  const manager = internals.selectionManager;
  if (!manager || typeof manager.getSelection !== "function") return;
  if (manager.copyToClipboard) manager.copyToClipboard = async () => {};
  terminal.element?.addEventListener("click", (event) => {
    if (
      event.detail !== 3 ||
      !manager.pixelToCell ||
      !manager.viewportRowToAbsolute ||
      !(event.target instanceof HTMLCanvasElement)
    )
      return;
    const cell = manager.pixelToCell(event.offsetX, event.offsetY);
    const row = manager.viewportRowToAbsolute(cell.row);
    manager.selectionStart = { col: 0, absoluteRow: row };
    manager.selectionEnd = { col: terminal.cols - 1, absoluteRow: row };
    manager.requestRender?.();
  });
  manager.getSelection = () => {
    const wasm = internals.wasmTerm;
    if (!wasm || !manager.selectionStart || !manager.selectionEnd) return "";
    let { col: fromCol, absoluteRow: from } = manager.selectionStart;
    let { col: toCol, absoluteRow: to } = manager.selectionEnd;
    if (from > to || (from === to && fromCol > toCol))
      [fromCol, toCol, from, to] = [toCol, fromCol, to, from];
    const scrollback = wasm.getScrollbackLength();
    let text = "";
    for (let row = from; row <= to; row++) {
      const inScrollback = row < scrollback;
      const cells = inScrollback
        ? wasm.getScrollbackLine(row)
        : wasm.getLine(row - scrollback);
      if (!cells) continue;
      const last = row === to ? toCol : cells.length - 1;
      let line = "";
      for (let col = row === from ? fromCol : 0; col <= last; col++) {
        const cell = cells[col];
        // The second half of a wide character: nothing of its own.
        if (col > 0 && cells[col - 1]?.width === 2) continue;
        if (!cell || cell.codepoint === 0) line += " ";
        else if (cell.grapheme_len > 0)
          line += inScrollback
            ? wasm.getScrollbackGraphemeString(row, col)
            : wasm.getGraphemeString(row - scrollback, col);
        else line += String.fromCodePoint(cell.codepoint);
      }
      // Ghostty marks the row that continues a wrap, so ask the next one;
      // two scrollback rows have no mark: a full row counts as wrapped.
      const next = row + 1;
      const wrapped =
        row < to &&
        (next >= scrollback
          ? wasm.isRowWrapped(next - scrollback)
          : (cells.at(-1)?.codepoint ?? 0) !== 0);
      text += wrapped ? line : line.trimEnd();
      if (row < to && !wrapped) text += "\n";
    }
    return text;
  };
};

/**
 * Sentinel colours for Ghostty's own palette: ANSI 0–15, then the default
 * foreground and background. 0.4 resolves default and indexed colours into
 * cell RGB as it writes, so the WASM terminal is given these instead of the
 * theme; every cell drawn with one of them is then painted with the current
 * theme's colour for that role. Provenance survives any number of theme
 * changes (A→B→A restores A), two roles that share an RGB in a theme stay
 * apart, and truecolour output is untouched unless it is exactly one of
 * these 18 values (`#0103fe`…`#0114fe`).
 */
const SENTINEL_R = 1;
const SENTINEL_B = 254;
const SENTINEL_G0 = 3;
const sentinel = (role: number) =>
  (SENTINEL_R << 16) | ((SENTINEL_G0 + role) << 8) | SENTINEL_B;
const FG_ROLE = 16;
/** ghostty-web's CellFlags.INVERSE. */
const INVERSE = 16;
const BG_ROLE = 17;
const roleOf = (r: number, g: number, b: number): number =>
  r === SENTINEL_R &&
  b === SENTINEL_B &&
  g >= SENTINEL_G0 &&
  g <= SENTINEL_G0 + BG_ROLE
    ? g - SENTINEL_G0
    : -1;

type Rgb = [number, number, number];
const rgb = (hex: string): Rgb =>
  [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16)) as Rgb;
const roleColours = (theme: TerminalTheme): Rgb[] =>
  [
    ...ANSI_NAMES.map((name) => theme[name]!),
    theme.foreground,
    theme.background,
  ].map(rgb);

/**
 * Themes a terminal for its life: gives the WASM terminal the sentinels
 * (before `open`, which builds its config), paints sentinel cells with the
 * current theme, and follows LOOK_EVENT. A font change refits columns and
 * rows through `refit` (which also resizes the PTY). Returns the current
 * theme reader and the disposer.
 */
export const installTerminalTheme = (
  terminal: Terminal,
  open: () => void,
  refit: () => void
): { theme(): TerminalTheme; dispose(): void } => {
  const internals = terminal as unknown as {
    buildWasmConfig?: () => unknown;
    options: { scrollback?: number };
  };
  if (typeof internals.buildWasmConfig !== "function")
    throw new Error("ghostty-web 0.4.0 config adapter shape changed");
  internals.buildWasmConfig = () => ({
    scrollbackLimit: internals.options.scrollback ?? 10_000,
    fgColor: sentinel(FG_ROLE),
    bgColor: sentinel(BG_ROLE),
    cursorColor: sentinel(FG_ROLE),
    palette: Array.from({ length: 16 }, (_, i) => sentinel(i)),
  });
  open();
  const renderer = terminal.renderer as unknown as {
    renderLine(cells: GhosttyCell[], y: number, cols: number): void;
    setTheme(theme: TerminalTheme): void;
  };
  if (typeof renderer?.renderLine !== "function")
    throw new Error("ghostty-web 0.4.0 theme adapter shape changed");
  let current = terminalTheme();
  let colours = roleColours(current);
  let key = JSON.stringify([current, terminalFont()]);
  renderer.setTheme(current);
  const renderLine = renderer.renderLine.bind(renderer);
  renderer.renderLine = (cells, y, cols) => {
    let out: GhosttyCell[] | null = null;
    for (let i = 0; i < cells.length; i++) {
      const cell = cells[i]!;
      const fg = roleOf(cell.fg_r, cell.fg_g, cell.fg_b);
      const bg = roleOf(cell.bg_r, cell.bg_g, cell.bg_b);
      if (fg < 0 && bg < 0) continue;
      out ??= cells.slice();
      const f = fg < 0 ? null : colours[fg]!;
      // The default background is the line's own (the renderer skips
      // 0,0,0), except where inverse video paints text with it.
      const b =
        bg < 0
          ? null
          : bg === BG_ROLE && !(cell.flags & INVERSE)
            ? ([0, 0, 0] as Rgb)
            : colours[bg]!;
      out[i] = {
        ...cell,
        ...(f ? { fg_r: f[0], fg_g: f[1], fg_b: f[2] } : {}),
        ...(b ? { bg_r: b[0], bg_g: b[1], bg_b: b[2] } : {}),
      };
    }
    renderLine(out ?? cells, y, cols);
  };
  // Without the focus (the chat box has the keys) the cursor is a steady
  // outline, so the terminal still shows where typing would go.
  const cursor = renderer as unknown as {
    renderCursor?(x: number, y: number): void;
    startCursorBlink?(): void;
    stopCursorBlink?(): void;
    ctx?: CanvasRenderingContext2D;
    metrics?: { width: number; height: number };
    theme?: { cursor?: string };
  };
  let focused = false;
  const solidCursor = cursor.renderCursor?.bind(renderer);
  if (solidCursor)
    cursor.renderCursor = (x, y) => {
      const { ctx, metrics, theme } = cursor;
      // Asked each time: a focused terminal hidden or removed (a tab
      // switch, a kill) gets no focusout.
      const hasKeys =
        terminal.element?.contains(document.activeElement) ?? focused;
      if (hasKeys || !ctx || !metrics) return solidCursor(x, y);
      ctx.strokeStyle = theme?.cursor ?? "currentColor";
      ctx.lineWidth = 1;
      ctx.strokeRect(
        x * metrics.width + 0.5,
        y * metrics.height + 0.5,
        metrics.width - 1,
        metrics.height - 1
      );
    };
  const onFocus = (next: boolean) => () => {
    focused = next;
    cursor.stopCursorBlink?.();
    if (next && terminal.options.cursorBlink) cursor.startCursorBlink?.();
    repaint(terminal);
  };
  const onFocusIn = onFocus(true);
  const onFocusOut = onFocus(false);
  terminal.element?.addEventListener("focusin", onFocusIn);
  terminal.element?.addEventListener("focusout", onFocusOut);
  cursor.stopCursorBlink?.();
  const onLook = () => {
    const theme = terminalTheme();
    const font = terminalFont();
    const next = JSON.stringify([theme, font]);
    if (next === key) return;
    key = next;
    current = theme;
    colours = roleColours(theme);
    renderer.setTheme(theme);
    if (
      terminal.options.fontFamily !== font.fontFamily ||
      terminal.options.fontSize !== font.fontSize
    ) {
      terminal.options.fontFamily = font.fontFamily;
      terminal.options.fontSize = font.fontSize;
      refit();
    }
    repaint(terminal);
  };
  document.addEventListener(LOOK_EVENT, onLook);
  return {
    theme: () => current,
    dispose: () => {
      document.removeEventListener(LOOK_EVENT, onLook);
      terminal.element?.removeEventListener("focusin", onFocusIn);
      terminal.element?.removeEventListener("focusout", onFocusOut);
    },
  };
};
