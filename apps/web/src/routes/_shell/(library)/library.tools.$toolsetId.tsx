import { TOOLSETS_BY_ID } from "@abacus-ai/contract/toolsets";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import { ToolsetPage } from "#renderer/features/library/skills-tools";
import { TopBarSlot } from "#renderer/features/shell/top-bar-slots";
import { IS_ELECTRON } from "#renderer/lib/platform";

const ToolsetRoute = () => {
  const { t } = useTranslation();
  const { toolsetId } = Route.useParams();
  const toolset = TOOLSETS_BY_ID.get(toolsetId);
  const name = toolset
    ? t(`capabilities.toolsets.${toolset.labelKey}.label`)
    : t("library.pages.tools");
  return (
    <>
      <TopBarSlot>
        <span className="text-sidebar-foreground truncate font-medium">
          {name}
        </span>
      </TopBarSlot>
      <ToolsetPage toolsetName={toolsetId} />
    </>
  );
};

export const Route = createFileRoute(
  "/_shell/(library)/library/tools/$toolsetId"
)({
  beforeLoad: ({ params }) => {
    if (
      !TOOLSETS_BY_ID.has(params.toolsetId) ||
      (!IS_ELECTRON && ["device", "messaging"].includes(params.toolsetId))
    )
      throw redirect({ to: "/library/tools", replace: true });
  },
  component: ToolsetRoute,
});
