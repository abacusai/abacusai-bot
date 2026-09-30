/**
 * ⌘K (spec 01 §7.9): registry `CommandDialog` over areas, settings pages,
 * bots and sessions from the collections, and "Toggle theme".
 */
import { useLiveQuery } from "@tanstack/react-db";
import { useStore } from "@tanstack/react-store";
import { useTranslation } from "react-i18next";

import { useCollections } from "#next/data/collections";
import { isListedSession } from "#next/data/collections/filters";
import { usePrefs, useUpdatePrefs } from "#next/data/collections/prefs";
import type { NavType } from "#next/lib/motion";
import {
  AREA_HOME,
  RAIL_AREAS,
  SETTINGS_PAGES,
} from "#next/lib/navigation/areas";
import { useAppNavigate } from "#next/lib/navigation/use-app-navigate";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "#next/ui/command";

import { setCommandOpen, shellStore } from "./shell-store";

export const CommandMenu = () => {
  const { t } = useTranslation();
  const open = useStore(shellStore, (state) => state.commandOpen);
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
    <CommandDialog
      open={open}
      onOpenChange={setCommandOpen}
      title={t("shell.command.title")}
      description={t("shell.command.placeholder")}
    >
      <Command>
        <CommandInput placeholder={t("shell.command.placeholder")} />
        <CommandList>
          <CommandEmpty>{t("shell.command.empty")}</CommandEmpty>
          <CommandGroup heading={t("shell.command.groups.areas")}>
            {RAIL_AREAS.map((area) => (
              <CommandItem key={area} onSelect={() => go(AREA_HOME[area])}>
                {t(`shell.rail.${area}`)}
              </CommandItem>
            ))}
          </CommandGroup>
          <CommandGroup heading={t("shell.command.groups.settings")}>
            {SETTINGS_PAGES.map((page) => (
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
                void updatePrefs((draft) => {
                  draft.theme =
                    prefs.theme === "dark"
                      ? "light"
                      : prefs.theme === "light"
                        ? "system"
                        : "dark";
                }).catch(() => undefined);
              }}
            >
              {t("shell.command.toggleTheme")}
            </CommandItem>
          </CommandGroup>
        </CommandList>
      </Command>
    </CommandDialog>
  );
};
