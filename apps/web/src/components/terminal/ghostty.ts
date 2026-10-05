import { Ghostty, Terminal, FitAddon, type GhosttyCell } from "ghostty-web";
import wasmUrl from "ghostty-web/ghostty-vt.wasm?url";

import { STOCK_ANSI } from "#renderer/lib/look";
import { LOOK_EVENT } from "#renderer/lib/theme";
let ready: Promise<Ghostty> | null = null;
export const ghosttyReady = (): Promise<Ghostty> =>
  (ready ??= Ghostty.load(wasmUrl).catch((error) => {
    ready = null;
    throw error;
  }));
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
    theme[name] = read(`--term-${i}`, STOCK_ANSI[i]!);
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
    dispose: () => document.removeEventListener(LOOK_EVENT, onLook),
  };
};
