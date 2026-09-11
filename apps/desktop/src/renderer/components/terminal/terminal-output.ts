/**
 * Turning a finished bash call into something the transcript can show: the
 * ANSI translation writes raw HTML into the page, and the result parser
 * decides whether the user sees their command's output at all.
 */

export interface BashResult {
  output: string;
  exitCode: number | null;
  durationMs: number | null;
}

// Standard 16 ANSI colors tuned for dark terminal backgrounds
const ANSI_FG: Record<number, string> = {
  30: "#636363",
  31: "#ff5555",
  32: "#50fa7b",
  33: "#f1fa8c",
  34: "#6272a4",
  35: "#ff79c6",
  36: "#8be9fd",
  37: "#d4d4d4",
  90: "#808080",
  91: "#ff6e6e",
  92: "#69ff94",
  93: "#ffffa5",
  94: "#d6acff",
  95: "#ff92df",
  96: "#a4ffff",
  97: "#ffffff",
};

// Xterm 256-color palette: the main 16, the grey ramp, and the colour cube.
function xterm256ToRgb(idx: number): string {
  if (idx < 16) {
    const c = ANSI_FG[idx < 8 ? idx + 30 : idx + 82] ?? "#808080";
    return c;
  }
  if (idx >= 232) {
    const v = 8 + (idx - 232) * 10;
    return `rgb(${v},${v},${v})`;
  }
  const n = idx - 16;
  const b = n % 6,
    g = Math.floor(n / 6) % 6,
    r = Math.floor(n / 36);
  const f = (x: number) => (x === 0 ? 0 : 55 + x * 40);
  return `rgb(${f(r)},${f(g)},${f(b)})`;
}

export function ansiToHtml(text: string): string {
  let out = "";
  let openSpans = 0;
  let i = 0;

  while (i < text.length) {
    if (text[i] === "\x1b" && text[i + 1] === "[") {
      // Collect CSI sequence up to the final byte
      let j = i + 2;
      while (
        j < text.length &&
        !(text.charCodeAt(j) >= 0x40 && text.charCodeAt(j) <= 0x7e)
      )
        j++;
      const finalByte = text[j];
      if (finalByte === "m") {
        const params = text
          .slice(i + 2, j)
          .split(";")
          .map((s) => (s === "" ? 0 : Number(s)));
        const styles: string[] = [];
        let k = 0;
        while (k < params.length) {
          const code = params[k]!;
          if (code === 0) {
            if (openSpans > 0) {
              out += "</span>".repeat(openSpans);
              openSpans = 0;
            }
          } else if (code === 1) {
            styles.push("font-weight:bold");
          } else if (code === 3) {
            styles.push("font-style:italic");
          } else if (code === 4) {
            styles.push("text-decoration:underline");
          } else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) {
            const c = ANSI_FG[code];
            if (c) styles.push(`color:${c}`);
          } else if (code === 38) {
            const mode = params[k + 1];
            if (mode === 5 && params[k + 2] !== undefined) {
              styles.push(`color:${xterm256ToRgb(params[k + 2]!)}`);
              k += 2;
            } else if (mode === 2 && params[k + 4] !== undefined) {
              styles.push(
                `color:rgb(${params[k + 2]},${params[k + 3]},${params[k + 4]})`
              );
              k += 4;
            }
          }
          k++;
        }
        if (styles.length > 0) {
          out += `<span style="${styles.join(";")}">`;
          openSpans++;
        }
      }
      // Skip other CSI sequences (cursor movement etc.) silently
      i = j + 1;
    } else {
      const ch = text[i]!;
      if (ch === "&") out += "&amp;";
      else if (ch === "<") out += "&lt;";
      else if (ch === ">") out += "&gt;";
      else if (ch === "\r") {
        i++;
        continue;
      } // strip bare CR
      else out += ch;
      i++;
    }
  }
  if (openSpans > 0) out += "</span>".repeat(openSpans);
  return out;
}

/**
 * Split a bash result into output and, when present, its metadata. A command
 * whose output happens to be JSON (`cat package.json`, `curl`, `jq`) must not
 * be taken for an envelope, so one has to be an object carrying at least one
 * of the fields we came for.
 */
export function parseBashResult(raw: string): BashResult {
  try {
    const parsed: unknown = JSON.parse(raw);

    if (isBashEnvelope(parsed)) {
      return {
        output: typeof parsed.output === "string" ? parsed.output : "",
        exitCode: typeof parsed.exitCode === "number" ? parsed.exitCode : null,
        durationMs:
          typeof parsed.duration === "number" ? parsed.duration : null,
      };
    }
  } catch {
    // Not JSON at all: the common case.
  }

  return { output: raw, exitCode: null, durationMs: null };
}

interface BashEnvelope {
  output?: unknown;
  exitCode?: unknown;
  duration?: unknown;
}

function isBashEnvelope(value: unknown): value is BashEnvelope {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;

  const { output, exitCode, duration } = value as BashEnvelope;

  return (
    typeof output === "string" ||
    typeof exitCode === "number" ||
    typeof duration === "number"
  );
}

/**
 * The end of a command's output, not the start: the failing assertion, the
 * stack trace and the `Command exited with code N` line are all at the
 * bottom, and pi keeps the same tail when it truncates for the model.
 */
export function tailLines(
  output: string,
  max: number
): { shown: string; hidden: number } {
  const lines = output.split("\n");

  if (lines.length <= max) return { shown: output, hidden: 0 };

  return { shown: lines.slice(-max).join("\n"), hidden: lines.length - max };
}

export function formatDurationMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
}
