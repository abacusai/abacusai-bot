import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import { RoutinePage } from "#next/features/routines";
import { TopBarSlot } from "#next/features/shell";
import { RoutineSearch } from "#next/lib/navigation/search";

const RoutineRoute = () => {
  const { t } = useTranslation();
  return (
    <>
      <TopBarSlot>
        <span className="text-sidebar-foreground truncate font-medium">
          {t("shell.rail.routines")}
        </span>
      </TopBarSlot>
      <RoutinePage />
    </>
  );
};

export const Route = createFileRoute("/_shell/(routines)/routines/$routineId")({
  validateSearch: RoutineSearch,
  component: RoutineRoute,
});
