import fs from "fs";
import path from "path";

import { abacusBotHome } from "../../paths";

/**
 * The last twenty prompts, for the composer's up-arrow. Kept in
 * `~/.abacusai-bot/prompt-history.json` rather than localStorage: switching
 * accounts repoints that directory but leaves localStorage alone, so a
 * renderer-side history would offer the next account the previous one's.
 */
const HISTORY_FILE = "prompt-history.json";

export const PROMPT_HISTORY_LIMIT = 20;

const historyPath = (): string => path.join(abacusBotHome(), HISTORY_FILE);

/**
 * One list per scope, the session (a bot's chat is one too) the prompt was
 * sent from, so up-arrow in one chat does not walk through every other's.
 * Nothing here knows what a session is.
 */
type HistoryFile = { scopes?: Record<string, unknown>; prompts?: unknown };

const readFile = (): HistoryFile => {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(historyPath(), "utf8"));
    return parsed != null && typeof parsed === "object"
      ? (parsed as HistoryFile)
      : {};
  } catch {
    return {};
  }
};

const asPrompts = (value: unknown): string[] =>
  Array.isArray(value)
    ? value
        .filter((entry): entry is string => typeof entry === "string")
        .slice(0, PROMPT_HISTORY_LIMIT)
    : [];

/** Newest first. Empty when there is no history for the scope, or none at all. */
export const readPromptHistory = (scope: string): string[] =>
  asPrompts(readFile().scopes?.[scope]);

/**
 * Record a prompt, newest first, and return the list as it now stands.
 * Sending an old prompt again moves it to the front rather than duplicating
 * it; a run of identical entries is just further to press.
 */
export const addPromptToHistory = (scope: string, prompt: string): string[] => {
  const text = prompt.trim();
  if (text.length === 0) return readPromptHistory(scope);

  const file = readFile();
  const next = [
    text,
    ...asPrompts(file.scopes?.[scope]).filter((entry) => entry !== text),
  ].slice(0, PROMPT_HISTORY_LIMIT);

  try {
    // The flat `prompts` list (every scope's history at once) is dropped.
    fs.writeFileSync(
      historyPath(),
      `${JSON.stringify({ scopes: { ...file.scopes, [scope]: next } }, null, 2)}\n`,
      "utf8"
    );
  } catch {
    // A history that cannot be written does not grow; never fail the send.
  }

  return next;
};
