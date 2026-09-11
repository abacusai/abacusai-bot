import type { JSX } from "react";

import type { Bot } from "#shared/bots";

import { NewBotDialog } from "./new-bot-dialog";

/**
 * Edit a bot: the create form, with the bot's own values in it and "Save"
 * on the button. One form for both, so an edit shows exactly what create
 * asked for — check-ins included, which the old edit dialog left out.
 */
export const BotDialog = ({
  isOpen,
  bot,
  onClose,
}: {
  isOpen: boolean;
  /** The bot being edited. Null only while the dialog is closed. */
  bot: Bot | null;
  onClose: () => void;
}): JSX.Element => (
  <NewBotDialog
    isOpen={isOpen && bot != null}
    bot={bot}
    onClose={onClose}
    onCreated={onClose}
  />
);
