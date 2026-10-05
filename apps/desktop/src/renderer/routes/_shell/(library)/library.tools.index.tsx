import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import { ToolsPage } from "#renderer/features/library/skills-tools";
import { TopBarSlot } from "#renderer/features/shell/top-bar-slots";

const ToolsRoute = () => {
  const { t } = useTranslation();
  return (
    <>
      <TopBarSlot>
        <span className="text-sidebar-foreground truncate font-medium">
          {t("library.pages.tools")}
        </span>
      </TopBarSlot>
      <ToolsPage />
    </>
  );
};

export const Route = createFileRoute("/_shell/(library)/library/tools/")({
  component: ToolsRoute,
});
