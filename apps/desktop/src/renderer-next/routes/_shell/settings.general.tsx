import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import { SettingsPageEmpty } from "#next/features/settings";
import { TopBarSlot } from "#next/features/shell";

const GeneralSettingsRoute = () => {
  const { t } = useTranslation();
  return (
    <>
      <TopBarSlot>
        <span className="text-sidebar-foreground truncate font-medium">
          {t("settings.pages.general")}
        </span>
      </TopBarSlot>
      <SettingsPageEmpty page="general" />
    </>
  );
};

export const Route = createFileRoute("/_shell/settings/general")({
  component: GeneralSettingsRoute,
});
