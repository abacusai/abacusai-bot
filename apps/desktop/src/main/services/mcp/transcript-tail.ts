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
  turns: number
): Array<{ role: "user" | "assistant"; text: string }> => {
  if (file == null) return [];
  let raw: string;
  try {
    const size = fs.statSync(file).size;
    const fd = fs.openSync(file, "r");
    try {
      const start = Math.max(0, size - MAX_BYTES);
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
    // Preambles and system riders are the harness talking, not the chat.
    text = text.replace(/\s+/g, " ").trim();
    if (text.length === 0 || text.startsWith("[")) continue;
    out.push({
      role,
      text: text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text,
    });
  }
  return out.slice(-turns);
};
