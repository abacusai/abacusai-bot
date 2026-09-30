import { createFileRoute, Outlet } from "@tanstack/react-router";

import { ignoreLoadError } from "#next/lib/navigation/loaders";

export const Route = createFileRoute("/_shell/(routines)/routines")({
  staticData: { area: "routines", sidebar: "routines" },
  loader: ({ context }) =>
    context.collections.routines.preload().catch(ignoreLoadError),
  component: Outlet,
});
