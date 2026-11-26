import type { TerminalInUse } from "@abacus-ai/contract/terminal-shells";

import { terminalTabTitle } from "../dock/panel-tabs-store";

type Translate = (key: string, options?: Record<string, unknown>) => string;

/** At most this many names; the rest are counted. */
const SHOWN = 3;

/** A terminal by its tab's own name ("Terminal 2"), as the window shows it. */
export const terminalName = (terminal: TerminalInUse, t: Translate): string =>
  terminalTabTitle(terminal.conversationKey, terminal.terminalId) ??
  t("sessions.dock.terminal");

/**
 * Terminals as a question names them: each name once, the first three, then
 * how many more, so the sentence stays a line or two.
 */
export const terminalList = (
  terminals: readonly TerminalInUse[],
  t: Translate,
  describe: (terminal: TerminalInUse) => string
): string | null => {
  const names = [...new Set(terminals.map(describe))];
  if (names.length === 0) return null;
  const list = names.slice(0, SHOWN).join(", ");
  const more = names.length - SHOWN;
  return more > 0
    ? t("sessions.terminal.andMore", { list, count: more })
    : list;
};
