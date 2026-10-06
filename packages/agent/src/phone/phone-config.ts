/**
 * Where the phone loop keeps its state: ABACUSAI_BOT_PHONE_DIR, set for a
 * user's lifelong WhatsApp conversation. Loops, logs, notes, pages and the raw
 * archive live under it; "About you" is the app's shared user memory instead.
 */
import fs from "fs";
import path from "path";

import { writeFileAtomicSync } from "../atomic-file.js";

export const DAY_MS = 24 * 60 * 60_000;

/** The phone loop's home, or null when this session is not the phone loop. */
export function phoneDir(): string | null {
  const dir = (process.env.ABACUSAI_BOT_PHONE_DIR ?? "").trim();

  return dir.length > 0 ? dir : null;
}

export function isPhoneSession(): boolean {
  return phoneDir() != null;
}

/** `YYYY-MM-DD` in local time: the user's day, not UTC's. */
export function localDay(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");

  return `${y}-${m}-${d}`;
}

export const phonePaths = (dir: string) => ({
  loops: path.join(dir, "open-loops.json"),
  logDir: path.join(dir, "log"),
  log: (day: string) => path.join(dir, "log", `${day}.md`),
  summary: path.join(dir, "summary.md"),
  /** The next story, written by a flush and promoted at compaction. */
  nextSummary: path.join(dir, "summary.next.md"),
  notesDir: path.join(dir, "notes"),
  note: (slug: string) => path.join(dir, "notes", `${slug}.md`),
  pages: path.join(dir, "pages.json"),
  archiveDir: path.join(dir, "archive"),
  archive: (month: string) => path.join(dir, "archive", `${month}.jsonl`),
  state: path.join(dir, "state.json"),
});

export interface PhoneLoopState {
  /** When the daily consolidation last ran. */
  lastConsolidatedAt?: number;
}

export function readJson<T>(file: string, fallback: T): T {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));

    return parsed != null && typeof parsed === "object"
      ? (parsed as T)
      : fallback;
  } catch {
    return fallback;
  }
}

export function writeJson(file: string, value: unknown): void {
  writeFileAtomicSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

export const readPhoneState = (dir: string): PhoneLoopState =>
  readJson<PhoneLoopState>(phonePaths(dir).state, {});

export const writePhoneState = (dir: string, state: PhoneLoopState): void =>
  writeJson(phonePaths(dir).state, state);
