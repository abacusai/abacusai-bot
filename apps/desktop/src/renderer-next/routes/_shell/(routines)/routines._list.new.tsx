import { createFileRoute } from "@tanstack/react-router";

import { RoutineCreateSheet } from "#next/features/routines";

/** Masked sheet over the list: the URL shows /routines. */
export const Route = createFileRoute("/_shell/(routines)/routines/_list/new")({
  component: RoutineCreateSheet,
});
