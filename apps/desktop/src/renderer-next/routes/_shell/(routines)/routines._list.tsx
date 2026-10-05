import { createFileRoute, Outlet } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import { RoutinesListBody } from "#next/features/routines";
import { TopBarSlot } from "#next/features/shell";

/**
 * The routines page body stays mounted under the masked create sheet: the
 * sheet is this route's child, not the index's sibling (Codex r1 #18).
 */
const RoutinesListRoute = () => {
  const { t } = useTranslation();
  return (
    <>
      <TopBarSlot>
        <span className="text-sidebar-foreground truncate font-medium">
          {t("shell.rail.routines")}
        </span>
      </TopBarSlot>
      <RoutinesListBody />
      <Outlet />
    </>
  );
};

export const Route = createFileRoute("/_shell/(routines)/routines/_list")({
  component: RoutinesListRoute,
});
