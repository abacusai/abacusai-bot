import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import { McpPage, McpSearch } from "#renderer/features/library";
import { TopBarSlot } from "#renderer/features/shell";

const McpRoute = () => {
  const { t } = useTranslation();
  return (
    <>
      <TopBarSlot>
        <span className="text-sidebar-foreground truncate font-medium">
          {t("library.pages.mcp")}
        </span>
      </TopBarSlot>
      <McpPage />
    </>
  );
};

export const Route = createFileRoute("/_shell/(library)/library/mcp")({
  validateSearch: McpSearch,
  component: McpRoute,
});
