import { createFileRoute, redirect } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import { ToolsetPage } from "#next/features/library";
import { TopBarSlot } from "#next/features/shell";
import { TOOLSETS_BY_ID } from "#shared/toolsets";

const ToolsetRoute = () => {
  const { t } = useTranslation();
  const { toolsetId } = Route.useParams();
  const toolset = TOOLSETS_BY_ID.get(toolsetId);
  const name = t(`capabilities.toolsets.${toolset?.labelKey ?? toolsetId}`);
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
    if (!TOOLSETS_BY_ID.has(params.toolsetId))
      throw redirect({ to: "/library/tools", replace: true });
  },
  component: ToolsetRoute,
});
