import { createFileRoute, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/_shell/(routines)/routines")({
  staticData: { area: "routines", sidebar: "routines" },
  loader: ({ context }) => context.collections.routines.preload(),
  component: Outlet,
});
