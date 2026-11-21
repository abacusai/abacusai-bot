/**
 * The end of each chat terminal's output, kept on disk across an app restart
 * so a terminal that comes back (its tab is revived with a fresh shell)
 * shows what was there above the new prompt. Written once, at quit; read
 * once, at start.
 */
import { readFileSync, rmSync, writeFileSync } from "node:fs";

export type SavedScrollback = {
  key: string;
  terminalId: string;
  data: string;
};

/** Per terminal: enough to scroll back through, small enough to write at quit. */
const MAX_CHARS = 200_000;
/** Older than this, a restored screen is more confusing than useful. */
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const tail = (data: string): string => {
  if (data.length <= MAX_CHARS) return data;
  const cut = data.slice(-MAX_CHARS);
  // From a line start, so no half escape sequence or half line leads.
  const line = cut.indexOf("\n");
  return line < 0 ? cut : cut.slice(line + 1);
};

export const saveScrollback = (
  file: string,
  entries: readonly SavedScrollback[]
): void => {
  const kept = entries
    .filter((entry) => entry.data.length > 0)
    .map((entry) => ({ ...entry, data: tail(entry.data) }));
  try {
    if (kept.length === 0) rmSync(file, { force: true });
    else
      writeFileSync(
        file,
        JSON.stringify({ savedAt: Date.now(), entries: kept }),
        { mode: 0o600 }
      );
  } catch {
    // Not kept: the terminals still come back, with empty screens.
  }
};

/** What was saved, keyed by `scrollbackKey`; nothing when absent or stale. */
export const loadScrollback = (
  file: string,
  now = Date.now()
): Map<string, SavedScrollback> => {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as {
      savedAt?: unknown;
      entries?: unknown;
    };
    if (
      typeof raw.savedAt !== "number" ||
      now - raw.savedAt > MAX_AGE_MS ||
      !Array.isArray(raw.entries)
    )
      return new Map();
    return new Map(
      (raw.entries as SavedScrollback[])
        .filter(
          (entry) =>
            typeof entry?.key === "string" &&
            typeof entry.terminalId === "string" &&
            typeof entry.data === "string"
        )
        .map((entry) => [scrollbackKey(entry.key, entry.terminalId), entry])
    );
  } catch {
    return new Map();
  }
};

export const scrollbackKey = (key: string, terminalId: string): string =>
  JSON.stringify([key, terminalId]);

const ENTER_FULL_SCREEN = "\x1b[?1049h";
const LEAVE_FULL_SCREEN = "\x1b[?1049l";

/**
 * Saved output as it is shown again: without the screen of a full-screen
 * program still up at quit (vim, htop), whose drawing means nothing on a
 * new shell, then colours reset and a dim rule above the new prompt.
 */
export const restoredOutput = (data: string): string => {
  const entered = data.lastIndexOf(ENTER_FULL_SCREEN);
  const shown =
    entered > data.lastIndexOf(LEAVE_FULL_SCREEN)
      ? data.slice(0, entered)
      : data;
  return `${shown}\x1b[0m\r\n\x1b[2m${"─".repeat(24)}\x1b[0m\r\n`;
};
