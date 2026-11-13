/**
 * Terminal output as a person sees it. A progress bar redraws its line with
 * carriage returns, so only each line's last state counts, and how far a
 * command has got is read off that last state. No imports: the renderer
 * shows the same thing the model is given.
 */

/**
 * Each line's final state. An unfinished last line keeps a pending return, so
 * collapsing as output arrives gives what collapsing it all at the end would.
 */
export const collapseProgress = (text: string): string => {
  if (!text.includes("\r")) return text;
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  return lines
    .map((line, index) => {
      if (!line.includes("\r")) return line;
      const segments = line.split("\r");
      const last = segments.at(-1) ?? "";
      if (last !== "") return last;
      const shown = segments.findLast((segment) => segment !== "") ?? "";
      return index === lines.length - 1 ? `${shown}\r` : shown;
    })
    .join("\n");
};

// oxlint-disable-next-line no-control-regex -- an escape sequence starts with ESC
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

/** The line a person reads last: collapsed, colourless, non-empty. */
export const lastLine = (text: string): string => {
  const lines = collapseProgress(text)
    .replace(ANSI, "")
    .split("\n")
    .map((line) => line.replace(/\r$/, "").trim());
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
