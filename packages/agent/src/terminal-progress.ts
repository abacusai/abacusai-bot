/**
 * Terminal output as a person sees it. A progress bar redraws its line with
 * carriage returns, so only each line's last state counts, and how far a
 * command has got is read off that last state. No imports: the renderer
 * shows the same thing the model is given.
 */

/**
 * Each line's final state. A draw a return ended is finished, so the last one
 * replaces the line; the last line's draw may still be being written (a
 * program can write one redraw in pieces), so it is kept after the draw it
 * replaces, as `previous\rcurrent`, for screenText to show over it. A pending
 * return stays too, so collapsing as output arrives gives what collapsing it
 * all at the end would.
 */
export const collapseProgress = (text: string): string => {
  if (!text.includes("\r")) return text;
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  return lines
    .map((line, index) => {
      if (!line.includes("\r")) return line;
      const segments = line.split("\r");
      const last = segments.at(-1) ?? "";
      const done = segments.slice(0, -1).findLast((segment) => segment !== "");
      if (index < lines.length - 1) return last !== "" ? last : (done ?? "");
      if (last === "") return `${done ?? ""}\r`;
      return done == null ? last : `${done}\r${last}`;
    })
    .join("\n");
};

const ESCAPE =
  // oxlint-disable-next-line no-control-regex -- an escape sequence starts with ESC
  /\u001b(?:\[[0-9;:?<=>!]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|[@-_])/g;
// oxlint-disable-next-line no-control-regex -- erase in line: to its end (K, 0K) or all of it (2K)
const ERASE_LINE = /^\u001b\[([02]?)K$/;

/** A line as screen cells: each character with the escapes before it, then any trailing escapes. */
const cellsOf = (line: string): { cells: string[]; trailing: string } => {
  const cells: string[] = [];
  let pending = "";
  let at = 0;
  for (const match of line.matchAll(ESCAPE)) {
    for (const char of line.slice(at, match.index)) {
      cells.push(pending + char);
      pending = "";
    }
    pending += match[0];
    at = match.index + match[0].length;
  }
  for (const char of line.slice(at)) {
    cells.push(pending + char);
    pending = "";
  }
  return { cells, trailing: pending };
};

/**
 * A draw written over the line it returned to, as a terminal shows it: a
 * return moves the cursor to the start without erasing, so the old line shows
 * past the new draw's end until an erase-in-line clears it.
 */
const drawOver = (under: string, draw: string): string => {
  const old = cellsOf(under);
  const cells = [...old.cells];
  let cursor = 0;
  let pending = "";
  let at = 0;
  const write = (chunk: string) => {
    for (const char of chunk) {
      cells[cursor] = pending + char;
      pending = "";
      cursor += 1;
    }
  };
  for (const match of draw.matchAll(ESCAPE)) {
    write(draw.slice(at, match.index));
    at = match.index + match[0].length;
    const erase = ERASE_LINE.exec(match[0]);
    if (erase == null) pending += match[0];
    else if (erase[1] === "2") cells.fill(" ", 0, cursor).length = cursor;
    else cells.length = cursor;
  }
  write(draw.slice(at));
  const tail = cells.length > cursor ? old.trailing : "";
  return cells.map((cell) => cell ?? " ").join("") + pending + tail;
};

/**
 * Output as a person sees it on a terminal: each redrawn line at its last
 * state, a draw still being written shown over the draw before it, and no
 * pending return.
 */
export const screenText = (text: string): string => {
  const collapsed = collapseProgress(text);
  const end = collapsed.lastIndexOf("\n") + 1;
  const last = collapsed.slice(end).replace(/\r$/, "");
  const split = last.lastIndexOf("\r");
  return (
    collapsed.slice(0, end) +
    (split < 0 ? last : drawOver(last.slice(0, split), last.slice(split + 1)))
  );
};

/**
 * A running tool's output so far, from pi's partial result: bash reports
 * `{ content: [{ type: "text", text }] }`, the whole output each time.
 */
export const partialOutputText = (partial: unknown): string => {
  if (typeof partial === "string") return partial;
  const content = (partial as { content?: unknown } | null)?.content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part: { type?: unknown; text?: unknown }) =>
      part?.type === "text" && typeof part.text === "string" ? part.text : ""
    )
    .join("");
};

/** The line a person reads last: collapsed, colourless, non-empty. */
export const lastLine = (text: string): string => {
  const lines = screenText(text)
    .replace(ESCAPE, "")
    .split("\n")
    .map((line) => line.trim());
  return lines.findLast((line) => line !== "") ?? "";
};

const UNITS: Record<string, number> = {
  b: 1,
  k: 1e3,
  kb: 1e3,
  kib: 1024,
  m: 1e6,
  mb: 1e6,
  mib: 1024 ** 2,
  g: 1e9,
  gb: 1e9,
  gib: 1024 ** 3,
  t: 1e12,
  tb: 1e12,
  tib: 1024 ** 4,
};

const bytes = (amount: string, unit: string | undefined): number | null => {
  const scale = UNITS[(unit ?? "b").toLowerCase()];
  const value = Number(amount.replace(",", "."));
  return scale == null || !Number.isFinite(value) ? null : value * scale;
};

const percent = (value: number): number | null =>
  value >= 0 && value <= 100 ? Math.round(value) : null;

/**
 * How far along a running command says it is, 0 to 100, from its last line:
 * a percentage ("45%", "Receiving objects:  45%"), an amount of a total
 * ("801 MB / 1.7 GB", "4.5/10.0 MB"), or curl's meter row. Null when the
 * line says neither.
 */
export const progressOf = (text: string): number | null => {
  const line = lastLine(text);
  if (line === "") return null;

  const percents = [...line.matchAll(/(\d{1,3}(?:[.,]\d+)?)\s?%/g)]
    .map((match) => percent(Number(match[1]!.replace(",", "."))))
    .filter((value): value is number => value != null);
  if (percents.length > 0) return percents.at(-1)!;

  const amount =
    /(\d+(?:[.,]\d+)?)\s*([KMGT]i?B|[KMGT]|B)?\s*(?:\/|of)\s*(\d+(?:[.,]\d+)?)\s*([KMGT]i?B|[KMGT]|B)\b/i.exec(
      line
    );
  if (amount != null) {
    const done = bytes(amount[1]!, amount[2] ?? amount[4]);
    const total = bytes(amount[3]!, amount[4]);
    if (done != null && total != null && total > 0 && done <= total)
      return percent((done / total) * 100);
  }

  // curl's meter row: % Total % Received % Xferd Dload Upload, then times.
  const meter =
    /^(\d{1,3})\s+\S+\s+(\d{1,3})\s+\S+\s+\d{1,3}\s+\S+\s+\S+\s+\S+\s+(?:--|\d)/.exec(
      line
    );
  if (meter != null) return percent(Number(meter[2]));

  return null;
};
