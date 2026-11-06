/**
 * The last few user/assistant turns of one agent session log (pi's jsonl).
 * Read tolerant: a malformed line is skipped, a missing file is an empty
 * history, because this feeds a tool answer, never a failure.
 */
import fs from "node:fs";

const MAX_BYTES = 256 * 1024;
const MAX_TEXT = 240;

export const readTranscriptTail = (
  file: string | null,
  turns: number,
  /** Rewrites or drops (null) a line before the preamble filter; for logs whose lines need reading. */
  read?: (role: "user" | "assistant", text: string) => string | null,
  /** Each line is cut to this many characters. */
  maxText = MAX_TEXT,
  /** Read from this byte on; absent, the last stretch of the file. */
  fromByte?: number
): Array<{ role: "user" | "assistant"; text: string }> => {
  if (file == null) return [];
  let raw: string;
  try {
    const size = fs.statSync(file).size;
    const fd = fs.openSync(file, "r");
    try {
      const start = Math.max(0, Math.min(size, fromByte ?? size - MAX_BYTES));
      const buffer = Buffer.alloc(size - start);
      fs.readSync(fd, buffer, 0, buffer.length, start);
      raw = buffer.toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return [];
  }

  const out: Array<{ role: "user" | "assistant"; text: string }> = [];
  for (const line of raw.split("\n")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const message = (parsed as { message?: unknown }).message;
    if (message == null || typeof message !== "object") continue;
    const role = (message as { role?: unknown }).role;
    if (role !== "user" && role !== "assistant") continue;
    const content = (message as { content?: unknown }).content;
    let text = "";
    if (typeof content === "string") text = content;
    else if (Array.isArray(content)) {
      text = content
        .filter(
          (block): block is { type: string; text: string } =>
            block != null &&
            typeof block === "object" &&
            (block as { type?: unknown }).type === "text" &&
            typeof (block as { text?: unknown }).text === "string"
        )
        .map((block) => block.text)
        .join(" ");
    }
    if (read != null) {
      const kept = read(role, text);
      if (kept == null) continue;
      text = kept;
    }
    // Preambles and system riders are the harness talking, not the chat.
    text = text.replace(/\s+/g, " ").trim();
    if (text.length === 0 || text.startsWith("[")) continue;
    out.push({
      role,
      text: text.length > maxText ? `${text.slice(0, maxText)}…` : text,
    });
  }
  return out.slice(-turns);
};
