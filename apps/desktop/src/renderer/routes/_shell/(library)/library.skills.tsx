import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import { SkillsPage, SkillsSearch } from "#renderer/features/library";
import { TopBarSlot } from "#renderer/features/shell";

const SkillsRoute = () => {
  const { t } = useTranslation();
  return (
    <>
      <TopBarSlot>
        <span className="text-sidebar-foreground truncate font-medium">
          {t("library.pages.skills")}
        </span>
      </TopBarSlot>
      <SkillsPage />
    </>
  );
};

export const Route = createFileRoute("/_shell/(library)/library/skills")({
  validateSearch: SkillsSearch,
  component: SkillsRoute,
});
