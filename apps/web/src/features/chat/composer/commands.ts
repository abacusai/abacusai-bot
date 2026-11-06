/**
 * The `/` commands every composer owns, for what only it can reach: its chips,
 * its transcript, its own menu. A surface adds the rest through `commands`.
 */
import type { TFunction } from "i18next";

import type { ComposerCommand } from "../kit/context";

export const composerCommands = (
  t: TFunction,
  actions: {
    newChat?(): void;
    chooseModel?(): void;
    plan?(): void | Promise<void>;
    chooseMode?(): void;
    copyLast(): void | Promise<void>;
    help(): void;
  }
): ComposerCommand[] => [
  ...(actions.newChat != null
    ? [
        {
          name: "new",
          aliases: ["clear"],
          description: t("chat.commands.new"),
          run: actions.newChat,
        },
      ]
    : []),
  ...(actions.chooseModel != null
    ? [
        {
          name: "model",
          description: t("chat.commands.model"),
          run: actions.chooseModel,
        },
      ]
    : []),
  ...(actions.plan != null
    ? [
        {
          name: "plan",
          description: t("chat.commands.plan"),
          run: actions.plan,
        },
      ]
    : []),
  ...(actions.chooseMode != null
    ? [
        {
          name: "permissions",
          aliases: ["sandbox"],
          description: t("chat.commands.permissions"),
          run: actions.chooseMode,
        },
      ]
    : []),
  {
    name: "copy",
    description: t("chat.commands.copy"),
    run: actions.copyLast,
  },
  { name: "help", description: t("chat.commands.help"), run: actions.help },
];
