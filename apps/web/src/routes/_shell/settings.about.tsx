import { createFileRoute, notFound } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import { AboutPage } from "#platform/about";
import { TopBarSlot } from "#renderer/features/shell/top-bar-slots";
import { IS_ELECTRON } from "#renderer/lib/platform";

const AboutSettingsRoute = () => {
  const { t } = useTranslation();
  return (
    <>
      <TopBarSlot>
        <span className="text-sidebar-foreground truncate font-medium">
          {t("settings.pages.about")}
        </span>
      </TopBarSlot>
      <AboutPage />
    </>
  );
};

export const Route = createFileRoute("/_shell/settings/about")({
  beforeLoad: () => {
    if (!IS_ELECTRON) throw notFound();
  },
  component: AboutSettingsRoute,
});
