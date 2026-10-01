import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import { MemoryPage } from "#next/features/settings";
import { TopBarSlot } from "#next/features/shell";

const MemorySettingsRoute = () => {
  const { t } = useTranslation();
  return (
    <>
      <TopBarSlot>
        <span className="text-sidebar-foreground truncate font-medium">
          {t("settings.sidebar.label")}
        </span>
      </TopBarSlot>
      <MemoryPage />
    </>
  );
};

export const Route = createFileRoute("/_shell/settings/memory")({
  component: MemorySettingsRoute,
});
