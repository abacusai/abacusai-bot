import { createFileRoute, Outlet } from "@tanstack/react-router";

import { ignoreLoadError } from "#next/lib/navigation/loaders";

export const Route = createFileRoute("/_shell/(bots)/bots")({
  staticData: { area: "bots", sidebar: "bots" },
  loader: ({ context }) =>
    context.collections.bots.preload().catch(ignoreLoadError),
  component: Outlet,
});
