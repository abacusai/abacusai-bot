import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import { BotsNewPage } from "#next/features/bots";
import { TopBarSlot } from "#next/features/shell";

const BotsNewRoute = () => {
  const { t } = useTranslation();
  return (
    <>
      <TopBarSlot>
        <span className="text-sidebar-foreground truncate font-medium">
          {t("bots.page.newTitle")}
        </span>
      </TopBarSlot>
      <BotsNewPage />
    </>
  );
};

export const Route = createFileRoute("/_shell/(bots)/bots/new")({
  component: BotsNewRoute,
});
