import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import { AboutPage } from "#next/features/settings";
import { TopBarSlot } from "#next/features/shell";

const AboutSettingsRoute = () => {
  const { t } = useTranslation();
  return (
    <>
      <TopBarSlot>
        <span className="text-sidebar-foreground truncate font-medium">
          {t("settings.sidebar.label")}
        </span>
      </TopBarSlot>
      <AboutPage />
    </>
  );
};

export const Route = createFileRoute("/_shell/settings/about")({
  component: AboutSettingsRoute,
});
