/**
 * Settings, phase 1 (canvas `SettingsInPlace`): the settings sidebar takes
 * over the sidebar slot; every page is an empty state except Appearance,
 * whose theme control is real (the theme gate needs it).
 */
import { useMatchRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import { EmptyState } from "#next/components/empty-state";
import { NavList } from "#next/components/nav-list";
import { usePrefs, useUpdatePrefs } from "#next/data/collections/prefs";
import type { SettingsPageId } from "#next/lib/navigation/areas";
import type { ThemePref } from "#next/lib/theme";
import { ToggleGroup, ToggleGroupItem } from "#next/ui/toggle-group";

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
  { label: "settings.sidebar.app", pages: ["models", "environment", "about"] },
];

export const SettingsSidebar = () => {
  const { t } = useTranslation();
  const matchRoute = useMatchRoute();
  return (
    <NavList.Root label={t("settings.sidebar.label")}>
      <NavList.Header title={t("settings.sidebar.label")} />
      {GROUPS.map((group) => (
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
      ))}
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

export const SettingsPageEmpty = ({ page }: { page: SettingsPage }) => {
  const { t } = useTranslation();
  return (
    <EmptyState
      icon="settings"
      title={t(`settings.pages.${page}`)}
      description={t("settings.emptyDescription")}
    />
  );
};

const THEMES: ThemePref[] = ["system", "light", "dark"];

/** The one interactive setting in phase 1: writes `prefs.theme`. */
export const AppearanceTheme = () => {
  const { t } = useTranslation();
  const prefs = usePrefs();
  const updatePrefs = useUpdatePrefs();
  return (
    <section className="flex w-full max-w-md flex-col gap-3 p-8">
      <h1 className="text-base font-semibold">
        {t("settings.pages.appearance")}
      </h1>
      <div className="flex items-center justify-between gap-4">
        <div className="flex flex-col gap-0.5">
          <span id="theme-label" className="text-sm font-medium">
            {t("settings.theme.label")}
          </span>
          <span className="text-muted-foreground text-xs">
            {t("settings.theme.description")}
          </span>
        </div>
        <ToggleGroup
          aria-labelledby="theme-label"
          value={[prefs.theme]}
          onValueChange={(value: unknown[]) => {
            const next = value[0] as ThemePref | undefined;
            if (next == null || next === prefs.theme) return;
            void updatePrefs((draft) => {
              draft.theme = next;
            }).catch(() => undefined);
          }}
          variant="outline"
          size="sm"
        >
          {THEMES.map((theme) => (
            <ToggleGroupItem
              key={theme}
              value={theme}
              data-testid={`theme-${theme}`}
            >
              {t(`theme.${theme}`)}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>
    </section>
  );
};
