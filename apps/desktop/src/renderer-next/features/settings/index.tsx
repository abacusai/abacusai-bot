import { useMatchRoute } from "@tanstack/react-router";
/** Settings navigation and translated row search. */
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { NavList } from "#next/components/nav-list";
import type { SettingsPageId } from "#next/lib/navigation/areas";
import { Input } from "#next/ui/input";

import { searchSettings } from "./search-index";

export type SettingsPage = SettingsPageId;

const GROUPS: Array<{ label: string; pages: SettingsPage[] }> = [
  {
    label: "settings.sidebar.personal",
    pages: [
      "general",
      "appearance",
      "notifications",
      "memory",
      "usage",
      "account",
    ],
  },
  { label: "settings.sidebar.models", pages: ["models"] },
  {
    label: "settings.sidebar.environment",
    pages: ["environment", "browser", "devices"],
  },
  { label: "settings.sidebar.app", pages: ["language", "keyboard", "about"] },
];

export const SettingsSidebar = () => {
  const { t } = useTranslation();
  const matchRoute = useMatchRoute();
  const [q, setQ] = useState("");
  const results = q.trim() ? searchSettings(q, t) : null;
  return (
    <NavList.Root label={t("settings.sidebar.label")}>
      <NavList.Header title={t("settings.sidebar.label")} />
      <Input
        aria-label={t("phase5.searchSettings")}
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      {results ? (
        <NavList.Rows>
          {results.map((entry) => (
            <NavList.Item
              key={entry.id}
              to={`/settings/${entry.page}`}
              search={{ focus: entry.id }}
              title={entry.label ?? t(entry.labelKey)}
            />
          ))}
          {results.length === 0 && (
            <p className="p-3 text-xs">{t("phase5.noSettings")}</p>
          )}
        </NavList.Rows>
      ) : (
        GROUPS.map((group) => (
          <NavList.Group key={group.label} label={t(group.label)}>
            {group.pages.map((page) => (
              <NavList.Item
                key={page}
                to={`/settings/${page}`}
                active={
                  matchRoute({ to: `/settings/${page}` } as never) !== false
                }
                title={t(`settings.pages.${page}`)}
              />
            ))}
          </NavList.Group>
        ))
      )}
      <NavList.Group label={t("settings.sidebar.capabilities")}>
        <NavList.Item
          to="/library/connectors"
          transition="settings-out"
          title={t("settings.sidebar.openLibrary")}
        />
      </NavList.Group>
    </NavList.Root>
  );
};

export {
  GeneralPage,
  AppearanceTheme,
  LanguagePage,
  MemoryPage,
  NotificationsPage,
} from "./personal";
export { ModelsPage } from "./models";
export { AccountPage, UsagePage } from "./account-usage";
export { EnvironmentPage, BrowserPage, DevicesPage } from "./environment";
export { AboutPage, CriticalUpdateDialog } from "./updates";
export { KeymapEditor as KeyboardPage } from "#next/components/keymap-editor";
export { SettingsSearch, ModelsSearch, AccountSearch } from "./search";
export { ChangelogPage } from "./changelog";
export { InviteDialog } from "./invite";
