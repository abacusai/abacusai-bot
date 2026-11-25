/**
 * ConPTY (Windows) after a resize. Its buffer is only the screen (no
 * scrollback): it reflows those rows top-down, keeps their top, and moves
 * down only as far as the cursor needs. It sends nothing for a resize, so
 * our screen must end up where its buffer is. Ghostty bottom-anchors
 * instead (it pulls rows down from the scrollback).
 */
export interface ScreenRow {
  /**
   * Each printed character's width (2 for wide ones), up to the last one
   * printed; on the cursor's row, up to the cursor too.
   */
  widths: number[];
  /** Continues the row above (a soft wrap). */
  wrapped: boolean;
}

/** Rows a line of these widths takes at `cols`; a wide one never splits. */
const wrap = (widths: readonly number[], cols: number) => {
  let row = 0;
  let col = 0;
  for (const w of widths) {
    if (col + w > cols) {
      row++;
      col = 0;
    }
    col += w;
  }
  return row;
};

/**
 * The cursor's row in ConPTY's buffer once it is `cols` × `rows`, from the
 * screen rows down to the cursor's and how many characters precede it on
 * its line.
 */
export const conptyCursorRow = (
  screen: readonly ScreenRow[],
  cursorChars: number,
  cols: number,
  rows: number
): number => {
  let row = 0;
  let line: number[] = [];
  screen.forEach((r, y) => {
    if (y > 0 && !r.wrapped) {
      row += wrap(line, cols) + 1;
      line = [];
    }
    line.push(...r.widths);
  });
  // Within its own line: the row of the character after the cursor's
  // position (or the end of the line, with the cursor waiting past it).
  row += wrap(line.slice(0, cursorChars), cols);
  return Math.min(row, rows - 1);
};

/**
 * Bytes that move our screen onto ConPTY's when Ghostty left the cursor
 * lower: line feeds at the bottom row push the rows it pulled down back into
 * the scrollback (order kept, nothing lost or doubled), then the cursor goes
 * back to its column on ConPTY's row.
 */
export const alignToConpty = (
  rows: number,
  cursor: { x: number; y: number },
  expectedRow: number
): string => {
  const below = cursor.y - expectedRow;
  if (below <= 0) return "";
  return `\x1b[${rows};1H${"\n".repeat(below)}\x1b[${expectedRow + 1};${cursor.x + 1}H`;
};

/** Where the cursor sits after `widths` are written from column 0 at `cols`. */
const place = (widths: readonly number[], cols: number) => {
  let row = 0;
  let col = 0;
  for (const w of widths) {
    if (col + w > cols) {
      row++;
      col = 0;
    }
    col += w;
  }
  return { row, col };
};

/**
 * Bytes that rewrite the cursor's own line the way ConPTY wrapped it, as
 * Ghostty does not reflow the line holding the cursor. The line is written
 * again from the row ConPTY has it on and wraps at `cols` like ConPTY's (a
 * wide character never splits); the cursor goes to ConPTY's column. Empty
 * when it would not fit.
 */
export const rewrapCursorLine = (
  line: readonly { text: string; width: number }[],
  cursorChars: number,
  expectedRow: number,
  cols: number,
  rows: number
): string => {
  const widths = line.map((cell) => cell.width);
  const cursor = place(widths.slice(0, cursorChars), cols);
  const start = expectedRow - cursor.row;
  const end = start + place(widths, cols).row;
  if (line.length === 0 || start < 0 || end > rows - 1) return "";
  return `\x1b[${start + 1};1H\x1b[0m\x1b[J${line.map((cell) => cell.text).join("")}\x1b[${expectedRow + 1};${Math.min(cursor.col, cols - 1) + 1}H`;
};
