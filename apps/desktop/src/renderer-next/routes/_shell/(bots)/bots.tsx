import { createFileRoute, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/_shell/(bots)/bots")({
  staticData: { area: "bots", sidebar: "bots" },
  loader: ({ context }) => context.collections.bots.preload(),
  component: Outlet,
});
