import { createFileRoute } from "@tanstack/react-router";

import { RoutineEditDialog } from "#renderer/features/routines/form";
export const Route = createFileRoute(
  "/_shell/(routines)/routines/$routineId/edit"
)({
  component: EditRoutineRoute,
});

function EditRoutineRoute() {
  const { routineId } = Route.useParams();
  return <RoutineEditDialog routineId={routineId} />;
}
