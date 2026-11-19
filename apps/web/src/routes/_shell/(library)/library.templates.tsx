import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import { TopBarSlot } from "#renderer/features/shell/top-bar-slots";
import { TemplatesPage } from "#renderer/features/templates";

const TemplatesRoute = () => {
  const { t } = useTranslation();
  return (
    <>
      <TopBarSlot>
        <span className="text-sidebar-foreground truncate font-medium">
          {t("library.pages.templates")}
        </span>
      </TopBarSlot>
      <TemplatesPage />
    </>
  );
};

export const Route = createFileRoute("/_shell/(library)/library/templates")({
  component: TemplatesRoute,
});
