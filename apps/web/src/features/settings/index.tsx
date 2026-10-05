import { useLiveQuery } from "@tanstack/react-db";
import { useQuery } from "@tanstack/react-query";
import { useMatchRoute } from "@tanstack/react-router";
/** Settings navigation and translated row search. */
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { NavList } from "#renderer/components/nav-list";
import { useCollections } from "#renderer/data/db";
import type { SettingsPageId } from "#renderer/lib/navigation/areas";
import { IS_ELECTRON, uiPlatform } from "#renderer/lib/platform";
import { useAppContext, useSystem } from "#renderer/lib/use-app-context";
import { Input } from "#renderer/ui/input";

import type { SettingEntry } from "./search-index";

/** The search index, fetched the first time the search box is focused. */
type SearchIndex = typeof import("./search-index");
const loadSearchIndex = (): Promise<SearchIndex> => import("./search-index");

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
    pages: IS_ELECTRON
      ? ["environment", "browser", "devices"]
      : ["environment"],
  },
  {
    label: "settings.sidebar.app",
    pages: IS_ELECTRON
      ? ["language", "keyboard", "about"]
      : ["language", "keyboard"],
  },
];

export const SettingsSidebar = () => {
  const { t } = useTranslation();
  const matchRoute = useMatchRoute();
  const [q, setQ] = useState("");
  const [index, setIndex] = useState<SearchIndex | null>(null);
  const loadIndex = () => {
    if (index == null)
      void loadSearchIndex()
        .then((module) => setIndex(() => module))
        .catch(() => undefined);
  };
  const c = useCollections();
  const bots = useLiveQuery(c.bots).data ?? [];
  const memories = useLiveQuery(c.memories).data ?? [];
  const { transport } = useAppContext();
  const system = useSystem();
  const notes = useQuery({
    ...transport.orpc.memory.bots.queryOptions({ input: {} }),
    enabled: !!q.trim(),
  });
  const usage = useQuery({
    ...transport.orpc.account.usage.queryOptions({ input: {} }),
    enabled: !!q.trim(),
  });
  const searching = q.trim() !== "" && index != null;
  const entries: SettingEntry[] = !searching
    ? []
    : [
        ...index.settingsIndexFor(IS_ELECTRON, uiPlatform(system.platform)),
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
  const results = searching ? index.searchSettings(q, t, entries) : null;
  return (
    <NavList.Root label={t("settings.sidebar.label")}>
      <NavList.Header title={t("settings.sidebar.label")} />
      <Input
        aria-label={t("phase5.searchSettings")}
        placeholder={t("phase5.searchSettings")}
        value={q}
        onFocus={loadIndex}
        onChange={(e) => {
          loadIndex();
          setQ(e.target.value);
        }}
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
