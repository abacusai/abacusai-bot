import { createFileRoute } from "@tanstack/react-router";

/** The body is the parent's (`_list`). */
export const Route = createFileRoute("/_shell/(routines)/routines/_list/")({
  component: () => null,
});
