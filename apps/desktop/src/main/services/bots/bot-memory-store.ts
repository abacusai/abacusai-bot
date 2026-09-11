/**
 * The Memory page's view over a bot's memory: the curated core in
 * `bots/<id>/MEMORY.md` (one `- ` line per entry) plus a count of daily notes,
 * which are only removed with the bot. The bot loop owns the writes. Format
 * duplicated from packages/agent/src/bot/bot-memory.ts; keep the two in step.
 */
import fs from "fs";
import path from "path";

import { botDir, listBots } from "./bot-store";

export interface BotMemoryView {
  botId: string;
  name: string;
  entries: string[];
  /** How many daily-note files the bot has accumulated. */
  noteDays: number;
}

const memoryFile = (id: string): string => path.join(botDir(id), "MEMORY.md");

const readEntries = (id: string): string[] => {
  try {
    return fs
      .readFileSync(memoryFile(id), "utf8")
      .split("\n")
      .map((line) => /^- (.+)$/.exec(line.trim())?.[1]?.trim() ?? null)
      .filter((entry): entry is string => entry != null && entry.length > 0);
  } catch {
    return [];
  }
};

const writeEntries = (id: string, entries: string[]): void => {
  const file = memoryFile(id);

  fs.mkdirSync(path.dirname(file), { recursive: true });

  const temp = `${file}.tmp`;
  const body =
    entries.length > 0
      ? `${entries.map((entry) => `- ${entry}`).join("\n")}\n`
      : "";

  fs.writeFileSync(temp, body, "utf8");
  fs.renameSync(temp, file);
};

const noteDays = (id: string): number => {
  try {
    return fs
      .readdirSync(path.join(botDir(id), "memory"))
      .filter((name) => /^\d{4}-\d{2}-\d{2}\.md$/.test(name)).length;
  } catch {
    return 0;
  }
};

/** Every bot's memory, in bot-list order, including bots that know nothing. */
export const listBotMemories = (): BotMemoryView[] =>
  listBots().map((bot) => ({
    botId: bot.id,
    name: bot.name,
    entries: readEntries(bot.id),
    noteDays: noteDays(bot.id),
  }));

/**
 * `expected` is checked so a list the bot changed underneath cannot lose the
 * wrong line.
 */
export const forgetBotMemoryEntry = (
  botId: string,
  index: number,
  expected: string
): void => {
  const entries = readEntries(botId);

  if (index < 0 || index >= entries.length || entries[index] !== expected)
    throw new Error("That entry changed on disk; the list has been refreshed.");

  writeEntries(
    botId,
    entries.filter((_, i) => i !== index)
  );
};

export const clearBotMemory = (botId: string): void => {
  writeEntries(botId, []);
};
