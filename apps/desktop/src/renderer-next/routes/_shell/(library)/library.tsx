import { createFileRoute, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/_shell/(library)/library")({
  staticData: { area: "library", sidebar: "library" },
  component: Outlet,
});
