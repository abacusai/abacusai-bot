import { createFileRoute } from "@tanstack/react-router";

import { RoutineCreateDialog } from "#next/features/routines";
export const Route = createFileRoute("/_shell/(routines)/routines/_list/new")({
  loader: async ({ context }) => {
    await Promise.all([
      context.db.collections.routines.preload(),
      context.db.collections.workspaces.preload(),
    ]);
  },
  component: RoutineCreateDialog,
});
