/**
 * ⌘K (spec 01 §7.9): registry `CommandDialog` over areas, settings pages,
 * bots and sessions from the collections, and "Toggle theme".
 */
import { useLiveQuery } from "@tanstack/react-db";
import { useStore } from "@tanstack/react-store";
import { useTranslation } from "react-i18next";

import { useCollections } from "#renderer/data/db";
import { isListedSession } from "#renderer/data/db/filters";
import { usePrefs, useUpdatePrefs } from "#renderer/data/db/prefs";
import { useCapabilities } from "#renderer/lib/capabilities";
import type { NavType } from "#renderer/lib/motion";
import {
  AREA_HOME,
  RAIL_AREAS,
  SETTINGS_PAGES,
} from "#renderer/lib/navigation/areas";
import {
  railAreaAvailable,
  settingsPageAvailable,
} from "#renderer/lib/navigation/available";
import { useAppNavigate } from "#renderer/lib/navigation/use-app-navigate";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "#renderer/ui/command";

import { setCommandOpen, shellStore } from "./shell-store";

/**
 * The dialog is always mounted; its lists (and their live queries) only
 * while it is open, so the lazy `bots` table does not start syncing on every
 * launch and route (Claude impl r1 #21).
 */
export const CommandMenu = () => {
  const { t } = useTranslation();
  const open = useStore(shellStore, (state) => state.commandOpen);
  return (
    <CommandDialog
      open={open}
      onOpenChange={setCommandOpen}
      title={t("shell.command.title")}
      description={t("shell.command.placeholder")}
    >
      {open && <CommandMenuBody />}
    </CommandDialog>
  );
};

const CommandMenuBody = () => {
  const { t } = useTranslation();
  const capabilities = useCapabilities();
  const collections = useCollections();
  const prefs = usePrefs();
  const updatePrefs = useUpdatePrefs();
  const navigate = useAppNavigate();
  const { data: bots } = useLiveQuery(collections.bots);
  const { data: sessions } = useLiveQuery(collections.sessions);

  const go = (href: string, transition: NavType = "nav-lateral"): void => {
    setCommandOpen(false);
    void navigate({ href, transition } as never);
  };

  return (
    <Command>
      <CommandInput placeholder={t("shell.command.placeholder")} />
      <CommandList>
        <CommandEmpty>{t("shell.command.empty")}</CommandEmpty>
        <CommandGroup heading={t("shell.command.groups.areas")}>
          {RAIL_AREAS.filter((area) =>
            railAreaAvailable(area, capabilities)
          ).map((area) => (
            <CommandItem key={area} onSelect={() => go(AREA_HOME[area])}>
              {t(`shell.rail.${area}`)}
            </CommandItem>
          ))}
        </CommandGroup>
        <CommandGroup heading={t("shell.command.groups.settings")}>
          {SETTINGS_PAGES.filter((page) =>
            settingsPageAvailable(page, capabilities)
          ).map((page) => (
            <CommandItem
              key={page}
              onSelect={() => go(`/settings/${page}`, "settings-in")}
            >
              {t(`settings.pages.${page}`)}
            </CommandItem>
          ))}
        </CommandGroup>
        {(bots ?? []).length > 0 && (
          <CommandGroup heading={t("shell.command.groups.bots")}>
            {(bots ?? []).map((bot) => (
              <CommandItem
                key={bot.id}
                value={`bot ${bot.name}`}
                onSelect={() => go(`/bots/${encodeURIComponent(bot.id)}`)}
              >
                {bot.name}
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        {(sessions ?? []).filter(isListedSession).length > 0 && (
          <CommandGroup heading={t("shell.command.groups.sessions")}>
            {(sessions ?? []).filter(isListedSession).map((session) => (
              <CommandItem
                key={session.id}
                value={`session ${session.label}`}
                onSelect={() =>
                  go(`/sessions/${encodeURIComponent(session.id)}`)
                }
              >
                {session.label}
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        <CommandGroup heading={t("shell.command.groups.actions")}>
          <CommandItem
            onSelect={() => {
              setCommandOpen(false);
              void updatePrefs({
                theme:
                  prefs.theme === "dark"
                    ? "light"
                    : prefs.theme === "light"
                      ? "system"
                      : "dark",
              }).catch(() => undefined);
            }}
          >
            {t("shell.command.toggleTheme")}
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </Command>
  );
};
