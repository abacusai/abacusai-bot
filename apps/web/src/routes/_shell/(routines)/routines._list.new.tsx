import { createFileRoute } from "@tanstack/react-router";
import * as v from "valibot";

import { RoutineCreateDialog } from "#renderer/features/routines/form";
import { optionalField } from "#renderer/lib/navigation/search";
import { ROUTINE_TEMPLATES } from "#renderer/lib/routines/templates";
export const Route = createFileRoute("/_shell/(routines)/routines/_list/new")({
  validateSearch: v.object({
    template: optionalField(v.picklist(ROUTINE_TEMPLATES.map((x) => x.id))),
  }),
  loader: async ({ context }) => {
    await Promise.all([
      context.db.collections.routines.preload(),
      context.db.collections.workspaces.preload(),
    ]);
  },
  component: RoutineCreateDialog,
});
