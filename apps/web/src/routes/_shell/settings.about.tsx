import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import { AboutPage } from "#renderer/features/settings/updates";
import { TopBarSlot } from "#renderer/features/shell/top-bar-slots";

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
  component: AboutSettingsRoute,
});
