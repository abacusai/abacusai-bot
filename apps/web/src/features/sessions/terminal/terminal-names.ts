import type { TerminalInUse } from "@abacus-ai/contract/terminal-shells";

import { terminalTabTitle } from "../dock/panel-tabs-store";

type Translate = (key: string, options?: Record<string, unknown>) => string;

/** A terminal by its tab's own name ("Terminal 2"), as the window shows it. */
export const terminalName = (terminal: TerminalInUse, t: Translate): string =>
  terminalTabTitle(terminal.conversationKey, terminal.terminalId) ??
  t("sessions.dock.terminal");

/** A chat's name past this many characters is cut, so a line holds it. */
const CHAT_CHARACTERS = 32;

/** "Terminal (sleep) in Fix the login page": the chat says which one it is. */
export const terminalInChat = (
  terminal: TerminalInUse,
  name: string,
  t: Translate,
  /** A list with room for it (a popover) keeps the chat's whole name. */
  whole = false
): string => {
  if (!terminal.chat) return name;
  const chat =
    !whole && terminal.chat.length > CHAT_CHARACTERS
      ? `${terminal.chat.slice(0, CHAT_CHARACTERS - 1).trimEnd()}…`
      : terminal.chat;
  return t("sessions.terminal.inChat", { terminal: name, chat });
};

/**
 * Terminals as a question names them: one entry per terminal (two shells
 * are never said as one), the first `shown`, then how many more terminals,
 * so the sentence stays within a line or two.
 */
export const terminalList = (
  terminals: readonly TerminalInUse[],
  t: Translate,
  describe: (terminal: TerminalInUse) => string,
  shown = 3
): string | null => {
  if (terminals.length === 0) return null;
  const list = terminals.slice(0, shown).map(describe).join(", ");
  const more = terminals.length - shown;
  return more > 0
    ? t("sessions.terminal.andMore", { list, count: more })
    : list;
};
