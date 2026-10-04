import { useLiveQuery } from "@tanstack/react-db";
import { useQuery } from "@tanstack/react-query";
import { useMatchRoute } from "@tanstack/react-router";
/** Settings navigation and translated row search. */
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { NavList } from "#renderer/components/nav-list";
import { useCollections } from "#renderer/data/db";
import { useCapabilities } from "#renderer/lib/capabilities";
import type { SettingsPageId } from "#renderer/lib/navigation/areas";
import { settingsPageAvailable } from "#renderer/lib/navigation/available";
import { useAppContext } from "#renderer/lib/use-app-context";
import { Input } from "#renderer/ui/input";

import {
  searchSettings,
  SETTINGS_INDEX,
  type SettingEntry,
} from "./search-index";

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
  const capabilities = useCapabilities();
  const matchRoute = useMatchRoute();
  const [q, setQ] = useState("");
  const c = useCollections();
  const bots = useLiveQuery(c.bots).data ?? [];
  const memories = useLiveQuery(c.memories).data ?? [];
  const { system, transport } = useAppContext();
  const notes = useQuery({
    ...transport.orpc.memory.bots.queryOptions({ input: {} }),
    enabled: !!q.trim(),
  });
  const usage = useQuery({
    ...transport.orpc.account.usage.queryOptions({ input: {} }),
    enabled: !!q.trim(),
  });
  const entries: SettingEntry[] = [
    ...SETTINGS_INDEX.filter(
      (entry) => system.platform !== "darwin" || !entry.id.endsWith("@terminal")
    ),
    ...bots.flatMap((bot) => [
      {
        id: `sounds-bot-${bot.id}`,
        page: "notifications" as const,
        labelKey: "",
        label: `${bot.name} · ${t("phase5.settings.perBot")}`,
      },
      ...(memories.some((row) => row.botId === bot.id) ||
      notes.data?.some((item) => item.botId === bot.id && item.noteDays > 0)
        ? [
            {
              id: `memory-bot-${bot.id}`,
              page: "memory" as const,
              labelKey: "",
              label: `${bot.name} · ${t("phase5.rememberedByBots")}`,
            },
          ]
        : []),
    ]),
    ...memories
      .filter((row) => row.scope === "global")
      .map((row) => ({
        id: `memory-${row.id}`,
        page: "memory" as const,
        labelKey: "",
        label: row.entry,
      })),
    ...(usage.data?.models ?? []).map((model) => ({
      id: `usage-${model.id}`,
      page: "usage" as const,
      labelKey: "",
      label: model.modelId,
    })),
  ];
  const results = q.trim() ? searchSettings(q, t, entries) : null;
  return (
    <NavList.Root label={t("settings.sidebar.label")}>
      <NavList.Header title={t("settings.sidebar.label")} />
      <Input
        aria-label={t("phase5.searchSettings")}
        placeholder={t("phase5.searchSettings")}
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
        GROUPS.map((group) => ({
          ...group,
          pages: group.pages.filter((page) =>
            settingsPageAvailable(page, capabilities)
          ),
        }))
          .filter((group) => group.pages.length > 0)
          .map((group) => (
            <NavList.Group
              key={group.label}
              label={group.pages.length > 1 ? t(group.label) : ""}
            >
              {group.pages.map((page) => (
                <NavList.Item
                  key={page}
                  to={`/settings/${page}`}
                  active={
                    matchRoute({
                      to: `/settings/${page}`,
                      fuzzy: true,
                    } as never) !== false
                  }
                  title={t(`settings.pages.${page}`)}
                />
              ))}
            </NavList.Group>
          ))
      )}
      <NavList.Group label="">
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
export {
  AboutPage,
  CriticalUpdateDialog,
  useUpdatePillAction,
} from "./updates";
export { KeyboardPage } from "./keyboard";
export { SettingsSearch, ModelsSearch, AccountSearch } from "./search";
export { ChangelogPage } from "./changelog";
export { InviteDialog } from "./invite";
