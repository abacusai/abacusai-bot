/**
 * Where a bot keeps its private state: ABACUSAI_BOT_BOT_DIR, set by the
 * desktop for a bot's forever chat. Persona, memory and loop state all live
 * under it; nothing is shared with ordinary sessions or the global stores.
 */
import fs from "fs";
import path from "path";

/** The bot's home, or null when this session is not a bot's chat. */
export function botDir(): string | null {
  const dir = (process.env.ABACUSAI_BOT_BOT_DIR ?? "").trim();

  return dir.length > 0 ? dir : null;
}

/** Whether this process should run the bot loop instead of the coding one. */
export function isBotSession(): boolean {
  return botDir() != null;
}

export function botMemoryFile(dir: string): string {
  return path.join(dir, "MEMORY.md");
}

export function botDailyNotesDir(dir: string): string {
  return path.join(dir, "memory");
}

/** `memory/YYYY-MM-DD.md`, in local time — the bot's day, not UTC's. */
export function botDailyNoteFile(dir: string, date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");

  return path.join(botDailyNotesDir(dir), `${y}-${m}-${d}.md`);
}

export function botStateFile(dir: string): string {
  return path.join(dir, "state.json");
}

export interface BotLoopState {
  /** When the daily notes were last consolidated into MEMORY.md. */
  lastConsolidatedAt?: number;
}

export function readBotState(dir: string): BotLoopState {
  try {
    const parsed: unknown = JSON.parse(
      fs.readFileSync(botStateFile(dir), "utf8")
    );

    return parsed != null && typeof parsed === "object"
      ? (parsed as BotLoopState)
      : {};
  } catch {
    return {};
  }
}

export function writeBotState(dir: string, state: BotLoopState): void {
  fs.mkdirSync(dir, { recursive: true });
  const file = botStateFile(dir);
  const temp = `${file}.tmp`;

  fs.writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  fs.renameSync(temp, file);
}
