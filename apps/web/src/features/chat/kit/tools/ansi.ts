/**
 * ANSI SGR output as styled text runs, pure. Output becomes plain data (text +
 * a style object) that React renders as text nodes, so no HTML is ever built
 * from terminal bytes. Non-colour escape sequences are dropped.
 */
import { screenText } from "@abacus-ai/agent/terminal-progress";
import type { CSSProperties } from "react";

export interface AnsiRun {
  text: string;
  style?: CSSProperties;
}

// Mid-tone colours that read on both the light and the dark inset surface.
const BASE: readonly string[] = [
  "#6b6f76",
  "#e5484d",
  "#2f9e5b",
  "#c58b00",
  "#3b82f6",
  "#c04bd0",
  "#0e9bb5",
  "#a0a4ab",
];
const BRIGHT: readonly string[] = [
  "#8a8f98",
  "#ff6369",
  "#3dd68c",
  "#e6b422",
  "#6ea8fe",
  "#d97ee6",
  "#3cc9e0",
  "#d4d6da",
];

const xterm = (index: number): string | undefined => {
  if (index < 0 || index > 255) return undefined;
  if (index < 8) return BASE[index];
  if (index < 16) return BRIGHT[index - 8];
  if (index >= 232) {
    const v = 8 + (index - 232) * 10;
    return `rgb(${v},${v},${v})`;
  }
  const n = index - 16;
  const f = (x: number) => (x === 0 ? 0 : 55 + x * 40);
  return `rgb(${f(Math.floor(n / 36))},${f(Math.floor(n / 6) % 6)},${f(n % 6)})`;
};

const channel = (value: number | undefined): number | undefined =>
  value != null && value >= 0 && value <= 255 ? value : undefined;

interface State {
  color?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
}

const toStyle = (state: State): CSSProperties | undefined => {
  const style: CSSProperties = {};
  if (state.color != null) style.color = state.color;
  if (state.bold) style.fontWeight = 700;
  if (state.italic) style.fontStyle = "italic";
  if (state.underline) style.textDecoration = "underline";
  return Object.keys(style).length === 0 ? undefined : style;
};

const applySgr = (state: State, params: readonly number[]): State => {
  const next = { ...state };
  for (let k = 0; k < params.length; k += 1) {
    const code = params[k]!;
    if (code === 0) {
      delete next.color;
      next.bold = next.italic = next.underline = false;
    } else if (code === 1) next.bold = true;
    else if (code === 3) next.italic = true;
    else if (code === 4) next.underline = true;
    else if (code === 22) next.bold = false;
    else if (code === 23) next.italic = false;
    else if (code === 24) next.underline = false;
    else if (code === 39) delete next.color;
    else if (code >= 30 && code <= 37) next.color = BASE[code - 30];
    else if (code >= 90 && code <= 97) next.color = BRIGHT[code - 90];
    else if (code === 38) {
      if (params[k + 1] === 5) {
        const color = xterm(params[k + 2] ?? -1);
        if (color != null) next.color = color;
        k += 2;
      } else if (params[k + 1] === 2) {
        const r = channel(params[k + 2]);
        const g = channel(params[k + 3]);
        const b = channel(params[k + 4]);
        if (r != null && g != null && b != null)
          next.color = `rgb(${r},${g},${b})`;
        k += 4;
      }
    }
  }
  return next;
};

const ESCAPE =
  // oxlint-disable-next-line no-control-regex
  /\u001b(?:\[([0-?]*)([ -/]*)([@-~])|\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|[@-_])/g;

export const parseAnsi = (input: string): AnsiRun[] => {
  const text = screenText(input);
  const runs: AnsiRun[] = [];
  let state: State = {};
  let last = 0;
  const push = (slice: string) => {
    if (slice === "") return;
    const style = toStyle(state);
    runs.push(style == null ? { text: slice } : { text: slice, style });
  };
  for (const match of text.matchAll(ESCAPE)) {
    push(text.slice(last, match.index));
    last = match.index + match[0].length;
    if (match[3] === "m" && match[1] != null) {
      state = applySgr(
        state,
        match[1]
          .split(/[;:]/)
          .map((part) => (part === "" ? 0 : Number(part)))
          .map((n) => (Number.isFinite(n) ? n : 0))
      );
    }
  }
  push(text.slice(last));
  return runs;
};

/** Plain text with every escape sequence removed. */
export const stripAnsi = (input: string): string =>
  parseAnsi(input)
    .map((run) => run.text)
    .join("");

export const TAIL_LINES = 300;

/** The last `limit` lines and how many earlier ones were left out. */
export const tailLines = (
  text: string,
  limit = TAIL_LINES
): { text: string; hidden: number } => {
  const lines = text.replace(/\n+$/, "").split("\n");
  return lines.length <= limit
    ? { text: text.replace(/\n+$/, ""), hidden: 0 }
    : {
        text: lines.slice(-limit).join("\n"),
        hidden: lines.length - limit,
      };
};
