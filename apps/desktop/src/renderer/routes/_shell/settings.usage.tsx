import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import { UsagePage } from "#renderer/features/settings/account-usage";
import { TopBarSlot } from "#renderer/features/shell/top-bar-slots";

const UsageSettingsRoute = () => {
  const { t } = useTranslation();
  return (
    <>
      <TopBarSlot>
        <span className="text-sidebar-foreground truncate font-medium">
          {t("settings.pages.usage")}
        </span>
      </TopBarSlot>
      <UsagePage />
    </>
  );
};

export const Route = createFileRoute("/_shell/settings/usage")({
  component: UsageSettingsRoute,
});
