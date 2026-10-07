import { Command } from "lucide-react";
import { useTranslation } from "react-i18next";

import { NavList } from "#renderer/components/nav-list";
import { dispatchHotkeyAction } from "#renderer/lib/hotkeys";

/** Discoverable beside sidebar search and creation, using the existing action. */
export const CommandPaletteAction = () => {
  const { t } = useTranslation();
  return (
    <NavList.Action
      label={t("shell.command.title")}
      aria-haspopup="dialog"
      onClick={() => dispatchHotkeyAction("command-menu")}
    >
      <Command />
    </NavList.Action>
  );
};
