/**
 * Mouse and focus reporting — the half of the protocol ghostty-web asks about
 * but never answers.
 *
 * The library knows when a program has switched tracking on (`hasMouseTracking`,
 * `getMode`) and yet emits no mouse sequence anywhere: there is not one `CSI <`
 * in its bundle. Its wheel handler papers over the gap by sending cursor keys
 * on the alternate screen, which is the 1990s fallback for terminals that
 * cannot report a wheel at all — so `less` scrolled by moving its cursor,
 * `htop` and `lazygit` ignored the pointer, and tmux could not pick a pane.
 *
 * So this sends the real thing, and only what was asked for:
 *
 *   1000 click tracking      press and release
 *   1002 button tracking     the above, plus motion while a button is down
 *   1003 any-event tracking  the above, plus motion with none down
 *   1006 SGR encoding        `CSI < b ; col ; row M`, else the X10 form
 *   1004 focus events        `CSI I` and `CSI O`
 *
 * Shift is the override every terminal has: hold it and the pointer selects
 * text as usual, whatever the program asked for.
 */
import type { Terminal as GhosttyTerminal } from "ghostty-web";

/** DEC private modes a program sets to ask for any of this. */
const MODE = {
  clickTracking: 1000,
  buttonTracking: 1002,
  anyMotion: 1003,
  focusEvents: 1004,
  sgrEncoding: 1006,
} as const;

/** Button numbers past the three real ones. */
const MOTION = 32;
const WHEEL_UP = 64;
const WHEEL_DOWN = 65;
const WHEEL_LEFT = 66;
const WHEEL_RIGHT = 67;
/** X10 has no button on release, only "something was let go". */
const X10_RELEASE = 3;
/** One byte per coordinate, offset by 32, so this is as far as it reaches. */
const X10_LIMIT = 223;

const modeEnabled = (term: GhosttyTerminal, mode: number): boolean =>
  term.wasmTerm?.getMode(mode, false) ?? false;

const isTracking = (term: GhosttyTerminal): boolean =>
  term.wasmTerm?.hasMouseTracking() ?? false;

const modifierBits = (event: MouseEvent): number =>
  (event.shiftKey ? 4 : 0) | (event.altKey ? 8 : 0) | (event.ctrlKey ? 16 : 0);

/** Buttons beyond the first three are not reportable here. */
const buttonOf = (event: MouseEvent): number =>
  event.button === 1 ? 1 : event.button === 2 ? 2 : 0;

const clamp = (value: number, max: number): number =>
  value < 1 ? 1 : value > max ? max : value;

/** Which cell the pointer is over, 1-based, as the protocol counts. */
const cellAt = (
  term: GhosttyTerminal,
  canvas: HTMLCanvasElement | null,
  event: MouseEvent
): { col: number; row: number } | null => {
  const metrics = term.renderer?.getMetrics();
  if (metrics == null || canvas == null) return null;
  if (metrics.width === 0 || metrics.height === 0) return null;

  const rect = canvas.getBoundingClientRect();

  return {
    col: clamp(
      Math.floor((event.clientX - rect.left) / metrics.width) + 1,
      term.cols
    ),
    row: clamp(
      Math.floor((event.clientY - rect.top) / metrics.height) + 1,
      term.rows
    ),
  };
};

/**
 * SGR when the program asked for it, X10 otherwise. X10 cannot express a
 * coordinate past 223 or say which button was released; a program that wants
 * either asks for 1006, and one that did not gets nothing rather than a lie.
 */
export const encodeMouse = (
  sgr: boolean,
  button: number,
  col: number,
  row: number,
  released: boolean
): string | null => {
  if (sgr) return `[<${button};${col};${row}${released ? "m" : "M"}`;
  if (col > X10_LIMIT || row > X10_LIMIT) return null;
  // The button bits go, the modifier and motion bits stay.
  const code = released ? (button & ~3) | X10_RELEASE : button;

  return `[M${String.fromCharCode(code + 32, col + 32, row + 32)}`;
};

/** How many lines this wheel event is worth, whatever units it came in. */
const wheelLines = (delta: number, deltaMode: number, cell: number): number => {
  if (deltaMode === WheelEvent.DOM_DELTA_LINE) return delta;
  if (deltaMode === WheelEvent.DOM_DELTA_PAGE) return delta * 3;

  return delta / (cell > 0 ? cell : 20);
};

/**
 * Report the pointer to whatever is running, for as long as it wants it.
 * Returns the undo.
 */
export const installMouseReporting = (
  term: GhosttyTerminal,
  element: HTMLElement
): (() => void) => {
  /** Which button is down, or -1. Motion is reported differently for each. */
  let held = -1;
  /** The last cell reported, so a drag sends one report per cell, not per pixel. */
  let lastCell = "";
  /** Trackpad deltas are fractions of a line; they add up to one eventually. */
  let pendingRows = 0;
  let pendingColumns = 0;
  /** Created once by `open()`; looked up again only if it ever goes away. */
  let canvas: HTMLCanvasElement | null = null;
  const grid = (): HTMLCanvasElement | null => {
    if (canvas?.isConnected !== true) canvas = element.querySelector("canvas");

    return canvas;
  };

  const send = (sequence: string | null): void => {
    // `true`: as user input, so it reaches the PTY rather than the screen.
    if (sequence != null) term.input(sequence, true);
  };

  const encode = (
    button: number,
    col: number,
    row: number,
    released: boolean
  ): string | null =>
    encodeMouse(
      modeEnabled(term, MODE.sgrEncoding),
      button,
      col,
      row,
      released
    );

  const wantsMotion = (): boolean =>
    modeEnabled(term, MODE.anyMotion) ||
    (modeEnabled(term, MODE.buttonTracking) && held >= 0);

  /** True when the event was reported and must not also select text. */
  const report = (event: MouseEvent, kind: "down" | "up" | "move"): boolean => {
    if (!isTracking(term) || event.shiftKey) return false;
    // Asked before the cell is measured: under click-only tracking this is
    // every mousemove, and measuring one forces a layout.
    if (kind === "move" && !wantsMotion()) return false;
    // The pointer says what it can do here. The library sets an I-beam for
    // text that can be selected and a hand over a link; while a program owns
    // the mouse, dragging selects nothing, so it is an arrow. Ours sticks
    // because the library's own mousemove never runs while we claim it.
    element.style.cursor = "default";
    const at = cellAt(term, grid(), event);
    if (at == null) return false;

    if (kind === "move") {
      const cell = `${at.col},${at.row}`;
      if (cell === lastCell) return true;
      lastCell = cell;
      send(
        encode(
          (held >= 0 ? held : 3) | MOTION | modifierBits(event),
          at.col,
          at.row,
          false
        )
      );

      return true;
    }

    const button = buttonOf(event);
    held = kind === "down" ? button : -1;
    lastCell = "";
    send(encode(button | modifierBits(event), at.col, at.row, kind === "up"));

    return true;
  };

  const claim = (event: MouseEvent, kind: "down" | "up" | "move"): void => {
    if (!report(event, kind)) return;
    event.preventDefault();
    // The library's own selection listeners sit on the canvas below this one.
    event.stopImmediatePropagation();
  };

  const onMouseDown = (event: MouseEvent): void => claim(event, "down");
  const onMouseMove = (event: MouseEvent): void => claim(event, "move");
  const onMouseUp = (event: MouseEvent): void => {
    if (held < 0) return;
    claim(event, "up");
  };
  /**
   * Runs after the library's own mousemove, which sets an I-beam for
   * selectable text and a hand over a link. While a program owns the mouse,
   * dragging selects nothing, so an arrow is the honest pointer — and this
   * has to be the later listener to survive theirs, for the modes where we do
   * not claim the event outright.
   */
  const onMouseMoveCursor = (event: MouseEvent): void => {
    if (isTracking(term) && !event.shiftKey) element.style.cursor = "default";
  };

  const onContextMenu = (event: MouseEvent): void => {
    // Right-click belongs to the program while it is tracking.
    if (isTracking(term) && !event.shiftKey) event.preventDefault();
  };

  const onFocusIn = (): void => {
    if (modeEnabled(term, MODE.focusEvents)) send("[I");
  };
  const onFocusOut = (): void => {
    if (modeEnabled(term, MODE.focusEvents)) send("[O");
  };

  term.attachCustomWheelEventHandler((event) => {
    // Not tracking: the library scrolls its own viewport, which is right.
    if (!isTracking(term) || event.shiftKey) return false;
    const at = cellAt(term, grid(), event);
    if (at == null) return false;
    const metrics = term.renderer?.getMetrics();

    pendingRows += wheelLines(
      event.deltaY,
      event.deltaMode,
      metrics?.height ?? 0
    );
    pendingColumns += wheelLines(
      event.deltaX,
      event.deltaMode,
      metrics?.width ?? 0
    );

    const rows = Math.trunc(pendingRows);
    const columns = Math.trunc(pendingColumns);
    pendingRows -= rows;
    pendingColumns -= columns;

    const modifiers = modifierBits(event);
    // Capped: a flung trackpad should not put a hundred events into a pipe.
    for (let step = 0; step < Math.min(Math.abs(rows), 10); step += 1) {
      send(
        encode(
          (rows < 0 ? WHEEL_UP : WHEEL_DOWN) | modifiers,
          at.col,
          at.row,
          false
        )
      );
    }
    for (let step = 0; step < Math.min(Math.abs(columns), 10); step += 1) {
      send(
        encode(
          (columns < 0 ? WHEEL_LEFT : WHEEL_RIGHT) | modifiers,
          at.col,
          at.row,
          false
        )
      );
    }

    return true;
  });

  element.addEventListener("mousedown", onMouseDown, { capture: true });
  element.addEventListener("mousemove", onMouseMove, { capture: true });
  element.addEventListener("mousemove", onMouseMoveCursor);
  element.addEventListener("contextmenu", onContextMenu);
  element.addEventListener("focusin", onFocusIn);
  element.addEventListener("focusout", onFocusOut);
  // On the document: a drag that ends outside the grid still ended.
  document.addEventListener("mouseup", onMouseUp, { capture: true });

  return () => {
    term.attachCustomWheelEventHandler(undefined);
    element.removeEventListener("mousedown", onMouseDown, { capture: true });
    element.removeEventListener("mousemove", onMouseMove, { capture: true });
    element.removeEventListener("mousemove", onMouseMoveCursor);
    element.removeEventListener("contextmenu", onContextMenu);
    element.removeEventListener("focusin", onFocusIn);
    element.removeEventListener("focusout", onFocusOut);
    document.removeEventListener("mouseup", onMouseUp, { capture: true });
  };
};
